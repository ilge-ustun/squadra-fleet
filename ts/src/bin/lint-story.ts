// lint-story.ts — the entry point behind lint-story.sh (seam 7). Exit codes
// as the bash had them: a `die` before load_repo (no args at all) is 1 with
// an XX line on stderr; a story file that does not exist is 1 with a plain,
// uncoloured line (lint-story.sh:34 — not lib.sh's die, deliberately, since
// it runs before err()/warn() exist); a clean or warnings-only lint is 0,
// any error or a --strict warning is 1.
import { resolve } from 'node:path';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { dieMessage } from '../lib/log.ts';
import { USAGE, lintStory } from '../lint-story.ts';

const FLEET_HOME = resolve(import.meta.dirname, '../../..');

function main(argv: readonly string[]): number {
  const [target, ...rest] = argv;
  if (target === undefined) throw new Die(USAGE);
  const cfg = loadRepo(FLEET_HOME, target);
  return lintStory(cfg, { argv: rest });
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof Die) dieMessage(e.message);
  else if (e instanceof ConfigError) {
    if (!e.alreadyReported) dieMessage(e.message);
  } else dieMessage(`lint-story.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
