// launch.ts — the entry point behind launch.sh. What launch.sh did before its
// main body (launch.sh:44-81): the repo, the two agents on PATH, the four
// directories; then src/launch.ts. Exit codes as the bash had them: every
// die is 1 with an XX line on stderr; a finished run, a blocked story, an
// empty queue and --reap are 0. lib.sh's die line for a bad repo or config
// reaches stderr from the child bash itself. On SIGTERM, SIGINT or SIGHUP
// the reviewer worktree is removed and the process ends with 128+signal, as
// the bash EXIT trap did — the agent's process group is left alone, as bash
// left it (L-04).
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { installExitHooks } from '../lib/exit-hooks.ts';
import { dieMessage } from '../lib/log.ts';
import { runSync } from '../lib/proc.ts';
import { launch } from '../launch.ts';

const USAGE = 'usage: launch.sh <repo> [story-id|--reap]';
const FLEET_HOME = resolve(import.meta.dirname, '../../..');

const onExit = installExitHooks();

const onPath = (name: string): boolean => runSync('bash', ['-c', 'command -v "$1"', '_', name]).status === 0;

async function main(argv: readonly string[]): Promise<number> {
  const [repo, ...rest] = argv;
  if (repo === undefined) throw new Die(USAGE);
  const cfg = loadRepo(FLEET_HOME, repo);
  for (const tool of ['claude', 'codex']) {
    if (!onPath(tool)) throw new Die(`${tool} not on PATH`);
  }
  for (const d of ['.stories', '.review', '.runs', '.blocked']) mkdirSync(`${cfg.root}/${d}`, { recursive: true });
  return launch(cfg, { fleetHome: FLEET_HOME, argv: rest, env: process.env, onExit });
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
