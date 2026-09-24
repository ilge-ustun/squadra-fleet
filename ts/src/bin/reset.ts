// reset.ts — the entry point behind reset.sh (seam 5). The repo name is
// required before it is loaded, as the bash did (reset.sh:29-30). Exit codes
// as the bash had them: every die is 1 with an XX line on stderr, a finished
// reset 0. No EXIT trap: the bash had none — nothing here is a throwaway
// worktree.
import { resolve } from 'node:path';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { dieMessage } from '../lib/log.ts';
import { USAGE, reset } from '../reset.ts';

const FLEET_HOME = resolve(import.meta.dirname, '../../..');

function main(argv: readonly string[]): number {
  const [repo, ...rest] = argv;
  if (repo === undefined) throw new Die(USAGE);
  const cfg = loadRepo(FLEET_HOME, repo);
  return reset(cfg, { argv: rest, env: process.env });
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof Die) dieMessage(e.message);
  else if (e instanceof ConfigError) {
    if (!e.alreadyReported) dieMessage(e.message);
  } else dieMessage(`reset.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
