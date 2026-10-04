// merge.ts — `fleet merge <repo> …` (bin/merge.ts), as the queue, the bot,
// the skills and the docs call it:
//
//   <repo> <id>            a story into its epic — the queue calls this
//   <repo> <id> --land     a story whose base IS the integration branch, onto
//                          it — a human's word (/merge from the phone)
//   <repo> --epic <name>   an epic into the integration branch — a human's
//
// Written as a list of refusals and then the part that earns the autonomy:
// the merge happens in a throwaway worktree at origin's tip and the suite,
// the build and the lint run against the MERGED result; nothing is pushed
// until that is green. When the queue merges a story into an epic that has
// not moved, the merged tree is the tree its last round checked GREEN with
// the same commands, and that check stands for this one (L-39). In pr mode the branch is pushed and PR_CMD opens the
// request; nothing is merged here.
//
// Pinned, each by a test: the story's state comes from status.ts
// in-process; .runs/ is created before the merge log, so a checkout without
// .runs/ merges (case 125b); the `merged:` record touches the frontmatter
// only; a seed file that cannot be copied is a die, as in the launcher; a
// story with no review or no verdict line is refused in words. No fleet lock
// here: the bot holds it around this command.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { baselineCommands, baselineGreen, baselineLine, runMergeBaseline, type BaselineCommands } from './lib/baseline.ts';
import type { RepoConfig } from './lib/config.ts';
import { Die } from './lib/die.ts';
import { recordMergedSha } from './lib/frontmatter.ts';
import { readLastRound, type LastRound } from './lib/review.ts';
import {
  add, branchExists, branchForce, commit, currentBranch, fetch, isAncestor, mergeAbort, mergeFfOnly, mergeNoFf, porcelain, pushFollowingUpstream,
  pushRef, refExists, revParse, stagedIsEmpty, treeOf, worktreeAdd, worktreeCheckedOutBranches, worktreeRemoveForce,
} from './lib/git.ts';
import { log, out, warn } from './lib/log.ts';
import { runBashTo, runSync } from './lib/proc.ts';
import { procsInWorktree as liveProcs } from './lib/procs.ts';
import { DASH, statusOf, type StoryRow } from './status.ts';

export const USAGE = 'usage: fleet merge <repo> <id> [--land] | <repo> --epic <epic/name>';

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();
const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
/** What `$(…)` leaves: every trailing newline gone. */
const capture = (s: string): string => s.replace(/\n+$/, '');
const short = (sha: string): string => sha.slice(0, 8);

// ── the pure parts ───────────────────────────────────────────────────────────

export interface MergeArgs {
  mode: 'story' | 'epic';
  id: string;
  land: boolean;
}

/** The flags after the repo name. */
export function parseArgs(argv: readonly string[], baseBranch: string): MergeArgs {
  let mode: MergeArgs['mode'] = 'story';
  let id = '';
  let land = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--land') land = true;
    else if (a === '--epic') {
      mode = 'epic';
      id = argv[i + 1] ?? '';
      if (id === '') throw new Die(USAGE);
      i++;
    } else if (a.startsWith('-')) throw new Die(`unknown option ${a} — ${USAGE}`);
    else {
      if (id !== '') throw new Die(USAGE);
      id = a;
    }
  }
  if (mode === 'epic') {
    // The one thing this must never do is point the same machinery at main.
    if (!id.startsWith('epic/')) throw new Die(`--epic takes an epic/... branch, not '${id}'`);
    if (land) throw new Die(`--epic already lands on ${baseBranch}; --land is for a story`);
  } else if (id === '') throw new Die(USAGE);
  return { mode, id, land };
}

/** `${ID//\//-}`: the id as a file-name stem — `epic/x` is `epic-x`. */
export const logIdOf = (id: string): string => id.replaceAll('/', '-');

export interface RefusalContext {
  id: string;
  land: boolean;
  baseBranch: string;
  repoName: string;
}

export type Refusal = { kind: 'die'; message: string } | { kind: 'already' } | { kind: 'go' };

/** The story-mode refusals, in that order, from the row
 *  status.ts computed. `already` is the exit-0 "nothing to do". */
export function refusal(r: StoryRow, c: RefusalContext): Refusal {
  const die = (message: string): Refusal => ({ kind: 'die', message });
  if (r.status !== 'done') return die(`${c.id} is ${r.status}, not done — nothing to merge`);
  if (r.verdict !== 'PASS') {
    if (r.verdict === DASH) return die(`${c.id} has no .review/${c.id}.md — nothing computed a PASS`);
    if (r.verdict === '') return die(`${c.id}'s review has no verdict line — nothing computed a PASS`);
    return die(`${c.id} computed ${r.verdict}, not PASS — the machine vetoed it`);
  }
  if (r.live) return die(`${c.id} has something running in its worktree`);
  if (r.branch === DASH) return die(`${c.id} has no branch`);
  // A human's --land on a story that lives on an epic gets the command that
  // works, merged into its epic already or not — before "already merged"
  // could answer instead.
  const onIntegration = r.base === 'main' || r.base === 'master' || r.base === c.baseBranch;
  if (c.land && !onIntegration) return die(`${c.id} lives on ${r.base}, not on ${c.baseBranch} — land its epic: fleet merge ${c.repoName} --epic ${r.base}`);
  if (r.merged) return { kind: 'already' };
  // The queue calls this on every computed PASS. It must never land anything
  // on the integration branch: that is a human's decision, and --land is how
  // a human says it. main and master stay refused whatever the flag.
  if (r.base === 'main' || r.base === 'master') return die(`${c.id} is based on ${r.base} — main is never merged here, --land or not`);
  if (r.base === c.baseBranch && !c.land) {
    return die(`${c.id} is based on ${r.base} — the integration branch is merged by a human: fleet merge ${c.repoName} ${c.id} --land, or /merge ${c.repoName} ${c.id}`);
  }
  return { kind: 'go' };
}

export interface ReuseInput {
  /** readLastRound of the story's review; undefined when it names no round. */
  last: LastRound | undefined;
  /** That round's baseline/commands.json, as text; undefined when absent. */
  recorded: string | undefined;
  /** What this merge would run. */
  now: BaselineCommands;
  mergedTree: string;
  /** The tree of last.head; '' when this repository does not have it. */
  reviewedTree: string;
}

export type Reuse = { reuse: true; round: string; head: string } | { reuse: false; why: string };

/** Whether a round's baseline already checked the merged tree (L-39). The
 *  post-merge baseline earns the autonomy by checking what two stories that
 *  each passed alone do together; when the base has not moved, the merge
 *  holds exactly the tree the round checked, and the same commands on the
 *  same tree have nothing new to say. Every other answer runs it: a RED or
 *  missing colour, an e2e run the round did not make, a round from before
 *  commands were recorded, a changed command or bound, a head this
 *  repository lacks, a different tree. Seed files are not compared: they are
 *  the checkout's, read at review and at merge alike. */
export function reviewedBaseline(i: ReuseInput): Reuse {
  const no = (why: string): Reuse => ({ reuse: false, why });
  if (i.last === undefined) return no('the review names no round with a head and a baseline');
  const { round, head, baseline } = i.last;
  const want = `test GREEN | build GREEN | lint GREEN${i.now.e2e === null ? '' : ' | e2e GREEN'}`;
  if (baseline !== want) return no(`round ${round}'s baseline was ${baseline}`);
  if (i.recorded === undefined) return no(`round ${round} recorded no commands`);
  let then: unknown;
  try {
    then = JSON.parse(i.recorded);
  } catch {
    return no(`the commands changed since round ${round} (its record is not JSON)`);
  }
  if (JSON.stringify(then) !== JSON.stringify(i.now)) return no(`the commands changed since round ${round}`);
  if (i.reviewedTree === '') return no(`round ${round}'s head ${short(head)} is not in this repository`);
  if (i.reviewedTree !== i.mergedTree) return no(`the merged tree is not the tree round ${round} checked — the base moved`);
  return { reuse: true, round, head };
}

/** The untracked files a fresh worktree does not inherit, copied when the
 *  checkout has them, skipped when not. A copy that fails is a die — pinned. */
export function seedMergeWorktree(root: string, mwt: string, seedFiles: readonly string[]): void {
  for (const f of seedFiles) {
    if (!isFile(`${root}/${f}`)) continue;
    try {
      copyFileSync(`${root}/${f}`, `${mwt}/${f}`);
    } catch (e) {
      throw new Die(`cannot copy seed file ${f} into ${mwt}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ── the program ──────────────────────────────────────────────────────────────

export interface MergeOptions {
  /** After the repo name. */
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** The bin's exit hook: the throwaway worktree is removed on a signal too. */
  onExit: (fn: () => void) => void;
  procsInWorktree?: (path: string) => string[];
}

export function merge(cfg: RepoConfig, o: MergeOptions): number {
  const root = cfg.root;
  const pushStatus = o.env['PUSH_STATUS'] || '1';
  const procs = o.procsInWorktree ?? liveProcs;
  const a = parseArgs(o.argv, cfg.baseBranch);
  if (a.mode === 'story' && !isFile(`${root}/.stories/${a.id}.md`)) throw new Die(`no such story: .stories/${a.id}.md`);
  const logId = logIdOf(a.id);
  const mwt = `${root}/../merge-${logId}`;
  const cleanup = (): void => {
    if (isDir(mwt)) worktreeRemoveForce(root, mwt);
  };
  o.onExit(cleanup);
  try {
    return run();
  } finally {
    cleanup();
  }

  function run(): number {
    const { id } = a;
    let branch: string;
    let base: string;
    let mergeRef: string;

    /** Only the queue's own merge, a story into its epic, may reuse its
     *  round's baseline (L-39). An epic, and a story a human lands with
     *  --land, reach the integration branch, and get the whole check. */
    function reuseOfReview(): Reuse {
      if (a.mode === 'epic') return { reuse: false, why: 'an epic is checked whole when a human lands it' };
      if (a.land) return { reuse: false, why: `--land reaches ${cfg.baseBranch}, which gets the whole check` };
      const reviewFile = `${root}/.review/${id}.md`;
      const last = isFile(reviewFile) ? readLastRound(readFileSync(reviewFile, 'utf8')) : undefined;
      const commandsFile = last === undefined ? '' : `${root}/.review/${id}/round-${last.round}/baseline/commands.json`;
      return reviewedBaseline({
        last,
        recorded: last !== undefined && isFile(commandsFile) ? readFileSync(commandsFile, 'utf8') : undefined,
        now: baselineCommands(cfg),
        mergedTree: treeOf(mwt, 'HEAD'),
        reviewedTree: last === undefined ? '' : treeOf(root, last.head),
      });
    }

    // ── refusals ─────────────────────────────────────────────────────────────
    if (a.mode === 'epic') {
      branch = id;
      base = cfg.baseBranch;
      mergeRef = `origin/${branch}`;
      if (fetch(root, 'origin') !== 0) throw new Die('fetch failed');
      if (!refExists(root, `origin/${branch}`)) throw new Die(`origin has no ${branch}`);
      if (isAncestor(root, `origin/${branch}`, `origin/${base}`)) {
        log(`${branch} is already in ${base}`);
        return 0;
      }
    } else {
      // status.ts is the single reader of story state; duplicating its
      // frontmatter parsing here is how the two would drift.
      const st = statusOf(cfg, { one: id }, { procsInWorktree: procs });
      if (st.stories.length !== 1) throw new Die(`status did not report exactly one story for ${id}`);
      const row = st.stories[0]!;
      const r = refusal(row, { id, land: a.land, baseBranch: cfg.baseBranch, repoName: cfg.name });
      if (r.kind === 'die') throw new Die(r.message);
      if (r.kind === 'already') {
        log(`${id} is already merged into ${row.base}`);
        return 0;
      }
      branch = row.branch;
      base = row.base;
      mergeRef = branch;
      if (fetch(root, 'origin') !== 0) throw new Die('fetch failed');
      if (!refExists(root, `origin/${base}`)) throw new Die(`origin has no ${base}`);
    }

    // ── pr mode: the host merges ─────────────────────────────────────────────
    if (cfg.mergeMode === 'pr') {
      if (pushStatus !== '1') throw new Die(`MERGE_MODE=pr pushes the branch; PUSH_STATUS=${pushStatus} forbids it`);
      if (a.mode === 'story' && pushRef(root, branch, branch) !== 0) throw new Die(`push of ${branch} failed`);
      const prCmd = cfg.prCmd ?? '';
      log(`${branch} → ${base}: opening a request with: ${prCmd} ${branch}`);
      // `eval "$PR_CMD" '"$BRANCH"'` in the target checkout: the command is a
      // bash line with the branch appended as one word; its stdout is the
      // reply, its stderr passes through.
      const r = runSync('bash', ['-c', `${prCmd} "$1"`, '_', branch], {
        cwd: root,
        env: { ...o.env, PR_SOURCE: branch, PR_TARGET: base },
        stderr: 'inherit',
      });
      const text = capture(r.stdout);
      if (r.status !== 0) throw new Die(`PR_CMD failed:\n${text}`);
      out(`${text}\n`);
      log(`nothing merged here — the request is merged on the host and lands in origin/${base}`);
      return 0;
    }

    // ── the merge, in a throwaway worktree at origin's tip ───────────────────
    cleanup();
    // Detached at origin's tip: naming the branch fails outright when it is
    // checked out somewhere, and the integration branch always is. A local
    // branch ahead of origin would be dropped when moved over the result.
    if (branchExists(root, base) && !isAncestor(root, base, `origin/${base}`)) {
      throw new Die(`local ${base} has commits origin does not — push or reset it first, or they would be merged over`);
    }
    if (worktreeAdd(root, mwt, { detach: `origin/${base}` }) !== 0) throw new Die('worktree add failed');
    const before = revParse(mwt, 'HEAD');
    log(`merging ${branch} into ${base} (at ${short(before)})`);
    mkdirSync(`${root}/.runs`, { recursive: true });
    if (mergeNoFf(mwt, mergeRef, `merge(${id}): ${branch} into ${base}`, `${root}/.runs/${logId}-merge.log`) !== 0) {
      mergeAbort(mwt);
      throw new Die(`${branch} does not merge cleanly into ${base} — a human has to resolve it`);
    }

    // ── the baseline that earns this ─────────────────────────────────────────
    const reuse = reuseOfReview();
    if (reuse.reuse) {
      log(`post-merge baseline: SKIPPED — the merged tree is the tree round ${reuse.round} checked GREEN at ${short(reuse.head)}, with the same commands`);
    } else {
      log(`post-merge baseline: running — ${reuse.why}`);
      seedMergeWorktree(root, mwt, cfg.seedFiles);
      log('installing deps in the merge worktree');
      if (runBashTo(cfg.installCmd, { cwd: mwt, logFile: `${root}/.runs/${logId}-merge-install.log` }) !== 0) {
        throw new Die(`install failed in the merge worktree — see .runs/${logId}-merge-install.log`);
      }
      const b = runMergeBaseline({
        wt: mwt,
        rawJson: `${root}/.runs/${logId}-merge-baseline.json`,
        testLog: `${root}/.runs/${logId}-merge-test.log`,
        buildLog: `${root}/.runs/${logId}-merge-build.log`,
        lintLog: `${root}/.runs/${logId}-merge-lint.log`,
        e2eLog: `${root}/.runs/${logId}-merge-e2e.log`,
        vitestCmd: cfg.vitestCmd,
        buildCmd: cfg.buildCmd,
        lintCmd: cfg.lintCmd,
        ...(cfg.e2eCmd !== undefined ? { e2eCmd: cfg.e2eCmd } : {}),
        ...(cfg.e2eTimeoutSec !== undefined ? { e2eTimeoutSec: cfg.e2eTimeoutSec } : {}),
      });
      log(`post-merge baseline: ${baselineLine(b)}`);
      if (!baselineGreen(b)) {
        // Nothing was pushed, so there is nothing to undo: the merge exists only
        // in a worktree the cleanup is about to delete.
        throw new Die(`post-merge baseline is red (${baselineLine(b)}) — ${base} is untouched, logs in .runs/${logId}-merge-*`);
      }
    }

    // ── publish ──────────────────────────────────────────────────────────────
    const mergeSha = revParse(mwt, 'HEAD');
    if (pushStatus === '1' && pushRef(mwt, 'HEAD', base) !== 0) throw new Die(`push of ${base} failed — the merge is local only`);
    // Move the local branch to what was just published. When this checkout
    // itself is on it — the integration branch always is — and clean, it is
    // fast-forwarded, so the record below lands on top of the merge and its
    // push goes (24 Sep: the record on a stale base was refused, and the
    // human's `git pull --ff-only` failed; case 120c). Someone standing on it
    // elsewhere, or a dirty tree, is told rather than left a stale ref.
    if (branchExists(root, base)) {
      if (currentBranch(root) === base && porcelain(root) === '' && mergeFfOnly(root, mergeSha) === 0) {
        log(`local ${base} is checked out and clean — fast-forwarded to ${short(mergeSha)}`);
      } else if (worktreeCheckedOutBranches(root).includes(`refs/heads/${base}`)) {
        warn(`local ${base} is checked out — run: git pull --ff-only`);
      } else if (branchForce(root, base, mergeSha) !== 0) warn(`could not move local ${base} to ${short(mergeSha)}`);
    }
    log(`${base} is now ${short(mergeSha)}`);

    if (a.mode === 'epic') {
      log(`${id} merged into ${base} — nothing recorded: an epic is not a story, and this was a human's call`);
      return 0;
    }

    // The sha goes in the story so a revert can be asked for by id. Recorded
    // on the integration branch, where all fleet state lives.
    recordMergedSha(`${root}/.stories/${id}.md`, mergeSha);
    add(root, `.stories/${id}.md`);
    if (stagedIsEmpty(root)) warn('nothing to record — the story file did not change');
    else {
      if (commit(root, `story(${id}): merged into ${base} at ${short(mergeSha)}`) !== 0) throw new Die('could not record the merge in the story');
      if (pushStatus === '1') {
        // The checkout's branch can be behind origin's — an epic landed while
        // a dirty tree kept it from following — and a record refused for
        // that follows origin (L-36).
        const p = pushFollowingUpstream(root);
        if (!p.pushed) warn(`push failed — the record is local only (${p.why})`);
        else if (p.merged !== '') log(`the record's push was refused — ${p.merged} merged in, and pushed`);
      }
    }

    // The builder's worktree has done its job: its commits are in the base,
    // and `fleet revert` works from the recorded sha. The branch stays.
    // Liveness is checked again: a merge takes minutes.
    const wt = `${root}/../wt-${id}`;
    if (isDir(wt)) {
      if (procs(wt).length > 0) warn(`something is running in ${wt} — left in place; remove it with: git worktree remove --force ${wt}`);
      else if (worktreeRemoveForce(root, wt) === 0) log(`worktree removed: ${wt} (branch story/${id} kept)`);
      else warn(`could not remove ${wt} — git worktree remove --force ${wt}`);
    }

    log(`${id} merged into ${base} — revert with: fleet revert ${cfg.name} ${id}`);
    return 0;
  }
}
