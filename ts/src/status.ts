// What the fleet is doing and what it decided — a walk over .stories/,
// .review/, .blocked/, the worktrees and git, as one pure function of the
// checkout. Read-only: safe while a launcher works, safe from a phone over
// ssh. No fetch.
//
// The landing state is derived on every run, never stored — the story's
// frontmatter `status:` is authoritative and is left alone:
//   draft ready in_progress blocked needs_human   as in the frontmatter
//   declined         a human decided against it, by hand, in the frontmatter —
//                    kept for its evidence, never queued; hidden from the
//                    bot view like landed/done (status-views.ts renderBot)
//   awaiting merge   done, computed PASS, not merged — a human's decision
//   on epic          done, merged into an epic that is not in the integration branch
//   landed           done, merged, and its base is in the integration branch
//   done             done and none of the above (a FAIL nobody merged)
//
// The verdict is the COMPUTED one (`verdict:` line 3 of .review/<id>.md),
// not the reviewer's — prompts/README.md, "The verdict contract".
//
// Merged INTO WHAT: a story belongs to its epic, not to the integration
// branch. story/011 merged into epic/ui-polish reaches develop only when
// that epic does; checking against BASE_BRANCH reported it unmerged
// forever. And origin's branch is the truth about what has landed when this
// checkout knows it: `fleet merge` publishes by pushing, which moves
// origin/<branch> at once, while a checked-out local branch lags.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { RepoConfig } from './lib/config.ts';
import { records, storyField } from './lib/frontmatter.ts';
import { isAncestor, reachable, refExists, refShas } from './lib/git.ts';
import { procsInWorktree as liveProcs } from './lib/procs.ts';
import { readReview } from './lib/review.ts';

/** The placeholder for an absent value — also the sentinel merge.ts
 *  compares `branch` against. */
export const DASH = '—';

export interface StoryRow {
  id: string;
  title: string;
  status: string;
  landing: string;
  /** The frontmatter's text, or DASH; the JSON view turns digits into a number. */
  round: string;
  /** Field 2 of `verdict:`; '' when the review has no such line; DASH when
   *  there is no review file at all. */
  verdict: string;
  base: string;
  /** `story/<id>`, or DASH when no such local branch exists. */
  branch: string;
  merged: boolean;
  ahead: number;
  worktree: boolean;
  live: boolean;
  blocked: boolean;
  reasons: string;
  /** RUNNING or worktree; BLOCKED: see …; the reasons — in that order. */
  notes: string[];
}

export interface EpicRow {
  name: string;
  total: number;
  merged: number;
  ahead: number;
  /** false when neither origin nor this checkout has the branch — a story
   *  names an epic that `fleet new-epic` has not made yet (24 Sep). */
  exists?: boolean;
}

export interface Detail {
  /** `### Machine` and the last block's lines; `### Machine` alone when the
   *  review has no block. */
  block: string;
  /** The names in .review/<id>/, when that directory exists. */
  evidence?: string[];
}

export interface Status {
  epics: EpicRow[];
  stories: StoryRow[];
  detail?: Detail;
}

export interface StatusOptions {
  /** One story id: only its row, and the detail. */
  one?: string;
}

export interface StatusDeps {
  procsInWorktree: (path: string) => string[];
}

/** `sort` under C.UTF-8 and `ls`: by code point, never by UTF-16 unit or locale. */
export function byCodePoint(a: string, b: string): number {
  const A = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const B = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const d = (A[i] ?? 0) - (B[i] ?? 0);
    if (d !== 0) return d;
  }
  return A.length - B.length;
}

/** The ids of .stories/*.md in `ls | sort` order — the filenames are
 *  sorted, `.md` still on (900-b.md < 900.md < 9000.md) — minus TEMPLATE. */
export function storyIds(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(`${root}/.stories`);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.md') && !n.startsWith('.'))
    .sort(byCodePoint)
    .map((n) => n.slice(0, -3))
    .filter((id) => id !== 'TEMPLATE');
}

/** The one choice of "next ready story", shared by a bare
 *  `fleet launch <repo>` and the queue's drain. TEMPLATE.md is skipped: on
 *  a repo whose TEMPLATE.md carries `status: ready` (a real state, not a
 *  hypothetical one — khaita's TEMPLATE.md does) a bare launch would
 *  otherwise try to build the template itself (case 128). */
export function nextReady(root: string): string {
  return storyIds(root).find((id) => storyField(root, id, 'status') === 'ready') ?? '';
}

/** Line 3 of the story's review — the launcher's word for how it ended —
 *  or undefined when there is no review. */
function reviewVerdict(root: string, id: string): string | undefined {
  try {
    return readReview(readFileSync(`${root}/.review/${id}.md`, 'utf8')).verdict;
  } catch {
    return undefined;
  }
}

/** Why the queue must start nothing now, '' when it may. A story whose
 *  review its provider refused waits at needs_human for a human to choose
 *  (/wait or /fallback); after /wait it is ready with a not_before, and the
 *  human chose to wait for it — everything behind it holds too, since the
 *  next story would meet the same refusal (L-32). A not_before that is not a
 *  time holds nothing: a typo must not stop the fleet. */
export function queueHold(root: string, now: Date): string {
  for (const id of storyIds(root)) {
    const status = storyField(root, id, 'status');
    if (status === 'needs_human' && reviewVerdict(root, id) === 'UNAVAILABLE') return `paused: ${id} waits for /wait or /fallback`;
    if (status === 'ready') {
      const nb = storyField(root, id, 'not_before');
      const t = nb === '' ? NaN : Date.parse(nb);
      if (!Number.isNaN(t) && t > now.getTime()) return `holding for ${id} until ${nb}`;
    }
  }
  return '';
}

/** The story to run next: one that resumes at its refused review goes
 *  first — the queue waited for it — then nextReady's order. The queue and
 *  a bare launch both choose through this (L-30). */
export function nextToRun(root: string): string {
  return storyIds(root).find((id) => storyField(root, id, 'status') === 'ready' && reviewVerdict(root, id) === 'UNAVAILABLE') ?? nextReady(root);
}

/** `ls -1 <dir>`: no dotfiles, code-point order; undefined when not a directory. */
export function listDir(dir: string): string[] | undefined {
  try {
    if (!statSync(dir).isDirectory()) return undefined;
    return readdirSync(dir).filter((n) => !n.startsWith('.')).sort(byCodePoint);
  } catch {
    return undefined;
  }
}

/** The story's first heading, minus a "Story NNN:" prefix that would repeat
 *  the ID column. '' when there is none. */
export function titleOf(text: string): string {
  for (const line of records(text)) {
    if (!line.startsWith('# ')) continue;
    return line.replace(/^# +/, '').replace(/^[Ss]tory +[0-9]+[ \t\n\v\f\r]*[:—-]+[ \t\n\v\f\r]*/, '');
  }
  return '';
}

export interface LandingInput {
  status: string;
  merged: boolean;
  verdict: string;
  branch: string;
  base: string;
  baseBranch: string;
  /** Is the story's base (its epic) itself in the integration branch? Asked
   *  only when it matters; the caller may answer with one git call. */
  intoInBase: () => boolean;
}

/** Whether a story's question is still open: it says `blocked` and its
 *  question file is there. The file alone marks nothing — /answer appends to
 *  .blocked/<id>.md and keeps it (suite case 139), so an answered story that
 *  went on to PASS showed BLOCKED on its epic (khaita 081, 5 Oct). */
export function questionOpen(status: string, hasFile: boolean): boolean {
  return status === 'blocked' && hasFile;
}

/** A story with no branch and no record has nothing that
 *  could be merged, so it is not awaiting one. */
export function landingOf(i: LandingInput): string {
  if (i.status !== 'done') return i.status;
  if (i.merged) return i.base === i.baseBranch || i.intoInBase() ? 'landed' : 'on epic';
  if (i.verdict === 'PASS' && i.branch !== DASH) return 'awaiting merge';
  return 'done';
}

/** Whether the epic block counts a story as merged: exactly when the table
 *  says on epic or landed. Git alone cannot say it: a story that has just
 *  started has a branch cut at its epic's tip with no commit of its own, an
 *  ancestor of the epic, and was counted merged until the builder's first
 *  commit (qr-desktop-scanner 005 and 007, 22 Oct; suite case 80c). */
export function countsMerged(status: string, merged: boolean): boolean {
  return status === 'done' && merged;
}

/** The git questions statusOf asks, each with the answer git gives. */
export interface GitView {
  /** As `rev-parse --verify`: does the name resolve. */
  refExists: (name: string) => boolean;
  /** A local branch, only. */
  branchExists: (name: string) => boolean;
  /** As `merge-base --is-ancestor <a> <b>`. */
  isAncestor: (a: string, b: string) => boolean;
  /** As `rev-list --count <base>..<ref>`: 0 when git cannot read either. */
  aheadOf: (base: string, ref: string) => number;
}

export interface GitReaders {
  refShas: typeof refShas;
  reachable: typeof reachable;
  refExists: typeof refExists;
  isAncestor: typeof isAncestor;
}

/** One statusOf call's git: the refs from one `for-each-ref`, and each
 *  branch's history from one `rev-list`, the first time it is asked. A name
 *  resolves by git's own order (gitrevisions: refs/<n>, refs/tags/<n>,
 *  refs/heads/<n>, refs/remotes/<n>, refs/remotes/<n>/HEAD); a full sha is
 *  itself; anything else — an epic not on origin, a short sha written by
 *  hand — asks git, once for each name. Before, each story cost four or
 *  more git calls: khaita's 133 stories made 926 and took about 9 s
 *  (27 Oct; suite case 183). */
export function gitView(root: string, git: GitReaders = { refShas, reachable, refExists, isAncestor }): GitView {
  const refs = git.refShas(root);
  const histories = new Map<string, Set<string>>();
  const asked = new Map<string, boolean>();
  const resolve = (name: string): string | undefined => {
    if (/^[0-9a-f]{40}$/.test(name)) return name;
    for (const r of [`refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`]) {
      const sha = refs.get(r);
      if (sha !== undefined) return sha;
    }
    return undefined;
  };
  const history = (ref: string): Set<string> => {
    let h = histories.get(ref);
    if (h === undefined) {
      h = git.reachable(root, ref);
      histories.set(ref, h);
    }
    return h;
  };
  return {
    refExists: (name) => {
      if (resolve(name) !== undefined) return true;
      let e = asked.get(name);
      if (e === undefined) {
        e = git.refExists(root, name);
        asked.set(name, e);
      }
      return e;
    },
    branchExists: (name) => refs.has(`refs/heads/${name}`),
    isAncestor: (a, b) => {
      const sha = resolve(a);
      return sha === undefined ? git.isAncestor(root, a, b) : history(b).has(sha);
    },
    aheadOf: (base, ref) => {
      const b = history(base);
      const r = history(ref);
      if (b.size === 0) return 0;
      let n = 0;
      for (const c of r) if (!b.has(c)) n++;
      return n;
    },
  };
}

/** What git says about a story's branch against `into`: the branch name (or
 *  DASH), whether it is merged there, and how far ahead it is if not. A branch
 *  deleted after its merge leaves only the `merged:` sha `fleet merge`
 *  recorded; that sha in `into` is the same fact. */
function mergeState(git: GitView, root: string, id: string, into: string): { branch: string; merged: boolean; ahead: number } {
  let branch = `story/${id}`;
  let merged = false;
  let ahead = 0;
  if (git.branchExists(branch)) {
    if (git.isAncestor(branch, into)) merged = true;
    else ahead = git.aheadOf(into, branch);
  } else {
    branch = DASH;
  }
  const mergedSha = storyField(root, id, 'merged');
  if (!merged && mergedSha !== '' && git.isAncestor(mergedSha, into)) merged = true;
  return { branch, merged, ahead };
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export function statusOf(cfg: RepoConfig, opts: StatusOptions = {}, deps: StatusDeps = { procsInWorktree: liveProcs }): Status {
  const root = cfg.root;
  const git = gitView(root);
  const refOf = (branch: string): string => (git.refExists(`origin/${branch}`) ? `origin/${branch}` : branch);
  // The epic block and the table ask the same story the same question.
  const merges = new Map<string, ReturnType<typeof mergeState>>();
  const mergeOf = (id: string, into: string): ReturnType<typeof mergeState> => {
    const key = `${id} ${into}`;
    let m = merges.get(key);
    if (m === undefined) {
      m = mergeState(git, root, id, into);
      merges.set(key, m);
    }
    return m;
  };
  const baseRef = refOf(cfg.baseBranch);
  const ids = storyIds(root);

  // The epic block: counts with the table's own rule (mergeState, then
  // countsMerged), so the two cannot disagree. Every story, whatever `one`
  // says.
  const total = new Map<string, number>();
  const mergedCount = new Map<string, number>();
  for (const id of ids) {
    const e = storyField(root, id, 'base');
    if (e === '' || e === cfg.baseBranch) continue;
    const status = storyField(root, id, 'status');
    if (status === 'declined') continue;
    total.set(e, (total.get(e) ?? 0) + 1);
    if (countsMerged(status, mergeOf(id, refOf(e)).merged)) {
      mergedCount.set(e, (mergedCount.get(e) ?? 0) + 1);
    }
  }
  const epics: EpicRow[] = [...total.keys()].sort(byCodePoint).map((name) => ({
    name,
    total: total.get(name) ?? 0,
    merged: mergedCount.get(name) ?? 0,
    ahead: git.aheadOf(baseRef, refOf(name)),
    exists: git.refExists(`origin/${name}`) || git.branchExists(name),
  }));

  const stories: StoryRow[] = [];
  let detail: Detail | undefined;
  for (const id of ids) {
    if (opts.one !== undefined && id !== opts.one) continue;
    const title = titleOf(readText(`${root}/.stories/${id}.md`) ?? '') || DASH;
    const status = storyField(root, id, 'status') || DASH;
    const round = storyField(root, id, 'round') || DASH;

    const reviewText = readText(`${root}/.review/${id}.md`);
    const review = reviewText === undefined ? undefined : readReview(reviewText);
    const verdict = review === undefined ? DASH : (review.verdict ?? '');
    const reasons = review?.reasons ?? '';

    const notes: string[] = [];
    // The literal "$REPO_ROOT/../wt-$id", the path the launcher makes: the
    // kernel resolves `..` through a symlinked root; path.join would not.
    const wt = `${root}/../wt-${id}`;
    let worktree = false;
    let live = false;
    if (existsSync(wt) && statSync(wt).isDirectory()) {
      worktree = true;
      live = deps.procsInWorktree(wt).length > 0;
      notes.push(live ? 'RUNNING' : 'worktree');
    }

    const base = storyField(root, id, 'base') || cfg.baseBranch;
    const into = refOf(base);
    const { branch, merged, ahead } = mergeOf(id, into);

    const landing = landingOf({
      status, merged, verdict, branch, base, baseBranch: cfg.baseBranch,
      intoInBase: () => git.isAncestor(into, baseRef),
    });
    const blocked = questionOpen(status, existsSync(`${root}/.blocked/${id}.md`));
    if (blocked) notes.push(`BLOCKED: see .blocked/${id}.md`);
    if (reasons !== '') notes.push(reasons);

    stories.push({ id, title, status, landing, round, verdict, base, branch, merged, ahead, worktree, live, blocked, reasons, notes });

    if (opts.one !== undefined && review !== undefined) {
      const evidence = listDir(`${root}/.review/${id}`);
      detail = { block: review.machineBlock ?? '### Machine', ...(evidence !== undefined ? { evidence } : {}) };
    }
  }
  return { epics, stories, ...(detail !== undefined ? { detail } : {}) };
}
