// fleet launch <repo> [story-id|--reap] — one story through the loop, or
// --reap to clear the orphans an interrupted run left. The loop — builder,
// baseline, reviewer, mutations, probes, verdict — is src/launch.ts, which
// documents the states, the rounds and the verdict contract. Before it, this
// checks the repo, the two agents on PATH and the four directories.
//
// One launch per repo: the launch lock (lib/lock.ts) is taken right after
// the repo loads, before anything is read or reaped, and held until the
// process ends. A launch that finds it held prints who holds it (!!) and
// exits 75, having touched nothing — the queue leaves the repo to its next
// drain (L-31).
//
// Every die is 1 with an XX line on stderr; a finished run, a blocked story,
// an empty queue and --reap are 0; another launch holding the repo is 75. lib.sh's die line for a bad repo or
// config reaches stderr from the child bash itself. On SIGTERM, SIGINT or
// SIGHUP the reviewer worktree is removed and the process ends with
// 128+signal; the agent's process group is left alone (L-04).
//
// Run it detached, never as a child of an interactive session:
//   setsid nohup bash -c 'fleet launch <repo> <id>' > log 2>&1 < /dev/null &
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { installExitHooks } from '../lib/exit-hooks.ts';
import { EXIT_LAUNCH_BUSY, takeLaunchLock } from '../lib/lock.ts';
import { dieMessage, warn } from '../lib/log.ts';
import { runSync } from '../lib/proc.ts';
import { launch } from '../launch.ts';

const USAGE = 'usage: fleet launch <repo> [story-id|--reap]';
const FLEET_HOME = resolve(import.meta.dirname, '../../..');

const onExit = installExitHooks();

const onPath = (name: string): boolean => runSync('bash', ['-c', 'command -v "$1"', '_', name]).status === 0;

async function main(argv: readonly string[]): Promise<number> {
  const [repo, ...rest] = argv;
  if (repo === undefined) throw new Die(USAGE);
  const cfg = loadRepo(FLEET_HOME, repo);
  const what = rest[0] === '--reap' ? 'reap' : rest[0] !== undefined && rest[0] !== '' ? `story ${rest[0]}` : 'selecting';
  const lock = takeLaunchLock(cfg.root, what);
  if (!lock.held) {
    const [pid = '?', ...holding] = lock.holder.split(' ');
    warn(`another launch holds ${repo}: pid ${pid}, ${holding.join(' ') || 'unknown'} — nothing was touched`);
    return EXIT_LAUNCH_BUSY;
  }
  for (const tool of ['claude', 'codex']) {
    if (!onPath(tool)) throw new Die(`${tool} not on PATH`);
  }
  for (const d of ['.stories', '.review', '.runs', '.blocked']) mkdirSync(`${cfg.root}/${d}`, { recursive: true });
  return launch(cfg, { fleetHome: FLEET_HOME, argv: rest, env: process.env, onExit, launchLock: lock });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof Die) dieMessage(e.message);
    else if (e instanceof ConfigError) {
      if (!e.alreadyReported) dieMessage(e.message);
    } else dieMessage(`launch.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exitCode = 1;
  },
);
