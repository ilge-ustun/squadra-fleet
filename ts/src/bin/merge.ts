// fleet merge <repo> <id>             a story into its epic — the queue does this
// fleet merge <repo> <id> --land      a story whose base IS the integration
//                                     branch, onto it — a human's word (/merge
//                                     from the phone); the queue never passes --land
// fleet merge <repo> --epic <name>    an epic into the integration branch — a
//                                     human's call, never the fleet's
//
// The refusals, the throwaway worktree, the post-merge baseline, MERGE_MODE
// and the record are src/merge.ts. The argument count is checked before the
// repo is loaded, so `fleet merge t` is the usage without touching any
// target. Every die is 1 with an XX line on stderr; "already merged", a
// pr-mode request and a finished merge are 0. lib.sh's die line for a bad
// repo or config reaches stderr from the child bash itself. On SIGTERM,
// SIGINT or SIGHUP the throwaway merge worktree is removed and the process
// ends with 128+signal.
import { resolve } from 'node:path';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { installExitHooks } from '../lib/exit-hooks.ts';
import { dieMessage } from '../lib/log.ts';
import { USAGE, merge } from '../merge.ts';

const FLEET_HOME = resolve(import.meta.dirname, '../../..');

const onExit = installExitHooks();

function main(argv: readonly string[]): number {
  const [repo, ...rest] = argv;
  if (repo === undefined || argv.length < 2) throw new Die(USAGE);
  const cfg = loadRepo(FLEET_HOME, repo);
  return merge(cfg, { argv: rest, env: process.env, onExit });
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof Die) dieMessage(e.message);
  else if (e instanceof ConfigError) {
    if (!e.alreadyReported) dieMessage(e.message);
  } else dieMessage(`merge.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
