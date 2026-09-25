// fleet new-epic <repo> <name> — origin/epic/<name>, cut from origin's
// integration branch; src/new-epic.ts. An epic is a branch named epic/<name>
// that stories are cut from (`base:` in their frontmatter, or write-story
// --base) and merged into by the queue; it lands on the integration branch
// when a human says so (fleet merge --epic, or /merge from the phone).
// Nothing else about an epic is stored anywhere: status derives its state
// from the branches. Every die is 1 with an XX line on stderr; a created epic
// is 0.
import { resolve } from 'node:path';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { dieMessage } from '../lib/log.ts';
import { USAGE, newEpic } from '../new-epic.ts';

const FLEET_HOME = resolve(import.meta.dirname, '../../..');

function main(argv: readonly string[]): number {
  const [target, ...rest] = argv;
  if (target === undefined) throw new Die(USAGE);
  const cfg = loadRepo(FLEET_HOME, target);
  return newEpic(cfg, { argv: rest });
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof Die) dieMessage(e.message);
  else if (e instanceof ConfigError) {
    if (!e.alreadyReported) dieMessage(e.message);
  } else dieMessage(`new-epic.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
