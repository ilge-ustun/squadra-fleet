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
import { branchExists, isAncestor, refExists, revListCount } from './lib/git.ts';
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

/** A story with no branch and no record has nothing that
 *  could be merged, so it is not awaiting one. */
export function landingOf(i: LandingInput): string {
  if (i.status !== 'done') return i.status;
  if (i.merged) return i.base === i.baseBranch || i.intoInBase() ? 'landed' : 'on epic';
  if (i.verdict === 'PASS' && i.branch !== DASH) return 'awaiting merge';
  return 'done';
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
  const refOf = (branch: string): string => (refExists(root, `origin/${branch}`) ? `origin/${branch}` : branch);
  const baseRef = refOf(cfg.baseBranch);
  const ids = storyIds(root);

  // The epic block: counts from the same walk the table makes, so the two
  // cannot disagree. Every story, whatever `one` says.
  const total = new Map<string, number>();
  const mergedCount = new Map<string, number>();
  for (const id of ids) {
    const e = storyField(root, id, 'base');
    if (e === '' || e === cfg.baseBranch) continue;
    total.set(e, (total.get(e) ?? 0) + 1);
    if (branchExists(root, `story/${id}`) && isAncestor(root, `story/${id}`, refOf(e))) {
      mergedCount.set(e, (mergedCount.get(e) ?? 0) + 1);
    }
  }
  const epics: EpicRow[] = [...total.keys()].sort(byCodePoint).map((name) => ({
    name,
    total: total.get(name) ?? 0,
    merged: mergedCount.get(name) ?? 0,
    ahead: revListCount(root, `${baseRef}..${refOf(name)}`),
    exists: refExists(root, `origin/${name}`) || branchExists(root, name),
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

    let branch = `story/${id}`;
    const base = storyField(root, id, 'base') || cfg.baseBranch;
    const into = refOf(base);
    let merged = false;
    let ahead = 0;
    if (branchExists(root, branch)) {
      if (isAncestor(root, branch, into)) merged = true;
      else ahead = revListCount(root, `${into}..${branch}`);
    } else {
      branch = DASH;
    }
    // A branch deleted after its merge leaves only the `merged:` sha
    // `fleet merge` recorded; that sha in the base is the same fact.
    const mergedSha = storyField(root, id, 'merged');
    if (!merged && mergedSha !== '' && isAncestor(root, mergedSha, into)) merged = true;

    const landing = landingOf({
      status, merged, verdict, branch, base, baseBranch: cfg.baseBranch,
      intoInBase: () => isAncestor(root, into, baseRef),
    });
    const blocked = existsSync(`${root}/.blocked/${id}.md`);
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
