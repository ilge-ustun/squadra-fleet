// run-queue.ts — `fleet run-queue`: drain every `ready` story of a repo in
// turn, until the queue is empty. This is the piece that makes the fleet a
// fleet: until it existed a human launched each story, watched it, and
// launched the next one.
//
// A stopped story does not stop the queue — that has been the design since
// phase 4b. needs_human, blocked and a harness die all end that story
// and the next one starts. Two guards against looping forever: --max N (a
// hard ceiling, default 20) and the same-story-twice check — a story that
// comes back `ready` without reaching a terminal state means something is
// wrong with the story or the harness, not with that round.
//
// The launcher decides; the queue merges. A hand-run `fleet launch` never
// changes a branch (launch.ts never calls merge.ts) — that separation is
// what keeps a debugging session from landing something. AUTO_MERGE=0 turns
// the merge off without turning the fleet off.
//
// Each story runs as a child process (`fleet launch <repo> <id>`, then, on a
// computed PASS, `fleet merge <repo> <id>`) with stdio fully inherited — not
// called in-process. That process boundary isolates one story's crash or Die
// from the rest of the drain, the same reason --all re-execs this command
// once per repo rather than looping over loaded configs in one process.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Die } from './lib/die.ts';
import { storyField } from './lib/frontmatter.ts';
import { fetchQuiet, gitDir, mergeAbort, mergeNoEditQuiet, upstreamBranch } from './lib/git.ts';
import { EXIT_AGENT_REFUSED, readKnobs, splitCommand } from './launch.ts';
import { EXIT_LAUNCH_BUSY, launchLockHolder } from './lib/lock.ts';
import { log, out, warn } from './lib/log.ts';
import { formatIsoSeconds } from './lib/machine-block.ts';
import { runInherit } from './lib/proc.ts';
import { readReview } from './lib/review.ts';
import type { RepoConfig } from './lib/config.ts';
import { nextToRun, queueHold } from './status.ts';

export const USAGE = 'usage: fleet run-queue <repo>|--all [--max N]';

const DIM = '\x1b[2m';
const RST = '\x1b[0m';
/** log()/warn() prefix every line `[queue] `. Not inherited by the child
 *  processes it launches (each is a fresh `fleet launch`/`fleet merge`
 *  invocation), so only the queue's own lines carry it. */
const TAG = { tag: 'queue' } as const;

/** `--max N` only as the first thing after the repo name; anything else
 *  leaves MAX from the environment (default 20). */
export function readMax(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  if (argv[0] === '--max') {
    const n = argv[1];
    if (n === undefined) throw new Die('--max needs a number');
    return Number(n);
  }
  return Number(env['MAX'] ?? '20');
}

export interface RanLine {
  id: string;
  status: string;
  verdict: string;
  rc: number;
}

/** `"$id ${status:-?} ${verdict:-—} exit=$rc"`. */
export function formatRanLine(r: RanLine): string {
  return `${r.id} ${r.status || '?'} ${r.verdict || '—'} exit=${r.rc}`;
}

/** What the drain says when another launch holds the repo, from the launch
 *  lock's `<pid> <what>` line. */
export function busyLine(holder: string): string {
  const [pid = '', ...what] = holder.split(' ');
  return `a launch is already running (pid ${pid || '?'}, ${what.join(' ') || 'unknown'}) — leaving the queue to the next drain`;
}

/** Never fails the drain — no upstream, a merge/rebase already in progress,
 *  a failed fetch or a merge conflict are all warnings, and pre-run HEAD
 *  stays an ancestor of any new HEAD. */
export function refreshFromOrigin(root: string): void {
  const upstream = upstreamBranch(root);
  if (upstream === '') {
    warn('refresh failed: no upstream configured, continuing on local state', TAG);
    return;
  }
  const gd = gitDir(root);
  const rebaseMerge = `${gd}/rebase-merge`;
  if (existsSync(`${gd}/MERGE_HEAD`) || (existsSync(rebaseMerge) && statSync(rebaseMerge).isDirectory())) {
    warn('refresh skipped: a merge/rebase is already in progress, continuing on local state', TAG);
    return;
  }
  if (fetchQuiet(root, 'origin') !== 0) {
    warn('refresh failed: fetch from origin failed, continuing on local state', TAG);
    return;
  }
  if (mergeNoEditQuiet(root, upstream) !== 0) {
    mergeAbort(root);
    warn(`refresh failed: merge conflict with ${upstream}, continuing on local state`, TAG);
    return;
  }
  log(`refreshed from ${upstream}`, TAG);
}

/** `"$FLEET_REGISTRY_DIR"/*.env`, sorted the way a shell
 *  glob is: the walk order --all uses. */
export function registeredRepos(fleetHome: string, env: NodeJS.ProcessEnv): string[] {
  const dir = env['FLEET_REGISTRY_DIR'] ?? `${fleetHome}/repos`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.env') && !n.startsWith('.'))
    .sort()
    .map((n) => n.slice(0, -'.env'.length));
}

export interface RunAllOptions {
  fleetHome: string;
  /** After --all: `[]`, `['--max', 'N']`. */
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}

/** --all: a fresh `fleet run-queue <name> "$@"` per registered repo, so no
 *  configuration, counter or die crosses from one repo to the next, and
 *  --max stays a per-repo ceiling. Each child's own exit status is not
 *  checked. */
export function runAll(o: RunAllOptions): number {
  const dir = o.env['FLEET_REGISTRY_DIR'] ?? `${o.fleetHome}/repos`;
  const repos = registeredRepos(o.fleetHome, o.env);
  if (repos.length === 0) throw new Die(`no repos registered in ${dir}`);
  for (const name of repos) {
    log(`repo: ${name}`, TAG);
    runInherit('bash', [`${o.fleetHome}/fleet`, 'run-queue', name, ...o.argv]);
  }
  return 0;
}

export interface RunQueueOptions {
  fleetHome: string;
  /** After the repo name: `[]`, `['--max', 'N']`. */
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}

export function runQueue(cfg: RepoConfig, o: RunQueueOptions): number {
  const root = cfg.root;
  const knobs = readKnobs(o.env, o.fleetHome);
  const notify = (msg: string): void => {
    const [cmd, ...args] = splitCommand(knobs.notifyCmd);
    if (cmd === undefined) return;
    spawnSync(cmd, [...args, msg], { stdio: 'ignore' });
  };
  const max = readMax(o.argv, o.env);
  const autoMerge = o.env['AUTO_MERGE'] ?? '1';

  // A crash leaves a story at `in_progress` with nothing running. Any scan
  // for `ready` misses it, so the queue would report itself empty while a
  // stranded story sat there forever. Reap first — launch.ts owns that logic
  // and checks both of a story's trees before declaring anything an orphan.
  // One exit ends the drain here: 75, another launch holds the repo — a hand
  // launch, say — and the repo is left to the next drain, before the refresh
  // merges into the checkout that launcher commits to (L-31). Any other
  // failure (a live orphan's die) does not stop the drain.
  log('reaping orphans from any interrupted run', TAG);
  if (runInherit('bash', [`${o.fleetHome}/fleet`, 'launch', cfg.name, '--reap']) === EXIT_LAUNCH_BUSY) {
    log(busyLine(launchLockHolder(root)), TAG);
    return 0;
  }

  log('refreshing from origin before scan', TAG);
  refreshFromOrigin(root);

  const started = formatIsoSeconds(new Date());
  const ran: RanLine[] = [];
  let prev = '';
  let n = 0;
  /** Why the drain started nothing, when it did not: the summary says so
   *  rather than "nothing was ready". */
  let stopped = '';

  while (n < max) {
    // A refused review pauses the queue until a human chooses, then holds it
    // until the story's not_before (L-32). Nothing is sent: the launcher
    // told the human once, when the story stopped.
    const hold = queueHold(root, new Date());
    if (hold !== '') {
      log(hold, TAG);
      stopped = hold;
      break;
    }
    const id = nextToRun(root);
    if (id === '') {
      log('queue empty', TAG);
      break;
    }
    if (id === prev) {
      warn(`${id} is ready again without having finished — stopping rather than looping`, TAG);
      warn(`read .review/${id}.md and .stories/${id}.md before re-running`, TAG);
      break;
    }
    prev = id;
    n += 1;

    log(`story ${id} (${n} of at most ${max})`, TAG);
    const rc = runInherit('bash', [`${o.fleetHome}/fleet`, 'launch', cfg.name, id]);
    // The lock was taken between the reap and this launch, which touched
    // nothing: not a story that ran, not news.
    if (rc === EXIT_LAUNCH_BUSY) {
      log(busyLine(launchLockHolder(root)), TAG);
      stopped = 'another launch holds the repo';
      break;
    }

    const status = storyField(root, id, 'status');
    const reviewPath = `${root}/.review/${id}.md`;
    const verdict = existsSync(reviewPath) ? (readReview(readFileSync(reviewPath, 'utf8')).verdict ?? '') : '';
    ran.push({ id, status, verdict, rc });

    // An agent's provider refused the call (a usage limit): the launcher
    // parked the story and told the human. Every story after it would be
    // refused as well, so the drain stops here, saying nothing more.
    if (rc === EXIT_AGENT_REFUSED) {
      warn(`${id}: the reviewer's provider refused — the drain stops here; the launcher has told the human`, TAG);
      break;
    }

    const base = storyField(root, id, 'base') || cfg.baseBranch;

    switch (status) {
      case 'done':
        log(`${id}: done`, TAG);
        // Only a COMPUTED PASS merges. merge.ts checks this again and
        // refuses on its own; asking here keeps a FAIL from even reaching it.
        if (verdict === 'PASS' && autoMerge === '1') {
          if (runInherit('bash', [`${o.fleetHome}/fleet`, 'merge', cfg.name, id]) === 0) {
            notify(`${cfg.name}/${id} merged → ${base} (computed PASS)\nundo: /revert ${cfg.name} ${id}`);
          } else {
            warn(`${id} passed but did not merge`, TAG);
            notify(`${id} computed PASS but did not merge into ${base} — see the queue log`);
          }
        } else if (verdict === 'PASS') {
          log(`${id}: PASS, not merged (AUTO_MERGE=0)`, TAG);
          notify(`${id} computed PASS and is waiting for a human to merge it into ${base}`);
        }
        break;
      // blocked and needs_human are announced by the launcher, in setStatus:
      // a story can stop without a queue, and saying it twice is how a
      // channel stops being read.
      case 'blocked':
        warn(`${id}: blocked — a question is waiting in .blocked/${id}.md`, TAG);
        break;
      case 'needs_human':
        warn(`${id}: needs_human — see .review/${id}.md`, TAG);
        break;
      default:
        warn(`${id}: ended as '${status || 'unknown'}' (launcher exit ${rc})`, TAG);
        notify(`${id} ended as '${status || 'unknown'}' (launcher exit ${rc}) — that is not a state the queue expects`);
    }
  }

  if (n >= max) warn(`stopped at the --max ceiling of ${max} stories`, TAG);

  out('\n');
  out(`${DIM}─── queue finished, started ${started} ───${RST}\n`);
  if (ran.length === 0) {
    out(stopped !== '' ? `nothing ran: ${stopped}\n` : 'nothing was ready to run\n');
  } else {
    for (const r of ran) out(`  ${formatRanLine(r)}\n`);
  }
  out('\n');
  runInherit('bash', [`${o.fleetHome}/fleet`, 'status', cfg.name]);

  return 0;
}
