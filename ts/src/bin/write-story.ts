// fleet write-story <repo> <story-id> "<what you want>" [--base epic/<name>]
//
//   fleet write-story <repo> 011 "the dark-theme toggle shows a sun, should be a moon" --base epic/ui-polish
//
// An intent → a draft story, linted (src/write-story.ts). Authoring a story
// by hand costs a careful session — read the code, verify every citation,
// bound each criterion, name its mutation — and that cost, not the supply of
// ideas, is what limits how much work the fleet can be given. This converts
// authoring into approving.
//
// `claude` must be on PATH before even the story id is parsed. Every die is
// 1 with an XX line on stderr; a linted draft is 0, one with errors 1. On
// SIGTERM, SIGINT or SIGHUP the throwaway worktree is removed and the
// process ends with 128+signal.
import { resolve } from 'node:path';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { installExitHooks } from '../lib/exit-hooks.ts';
import { dieMessage } from '../lib/log.ts';
import { runSync } from '../lib/proc.ts';
import { USAGE, writeStory } from '../write-story.ts';

const FLEET_HOME = resolve(import.meta.dirname, '../../..');
const onExit = installExitHooks();
const onPath = (name: string): boolean => runSync('bash', ['-c', 'command -v "$1"', '_', name]).status === 0;

async function main(argv: readonly string[]): Promise<number> {
  const [target, ...rest] = argv;
  if (target === undefined) throw new Die(USAGE);
  const cfg = loadRepo(FLEET_HOME, target);
  if (!onPath('claude')) throw new Die('claude not on PATH');
  return writeStory(cfg, { fleetHome: FLEET_HOME, argv: rest, env: process.env, onExit });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof Die) dieMessage(e.message);
    else if (e instanceof ConfigError) {
      if (!e.alreadyReported) dieMessage(e.message);
    } else dieMessage(`write-story.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exitCode = 1;
  },
);
