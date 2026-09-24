// run-queue.ts — the entry point behind run-queue.sh (seam 6). Exit codes
// as the bash had them: every die is 1 with an XX line on stderr; a normal
// drain, an empty queue and --all's own walk are 0. lib.sh's die line for a
// bad repo or config reaches stderr from the child bash itself. No exit
// hooks: run-queue.sh never trapped a signal — each story it launches is its
// own process with its own cleanup.
import { resolve } from 'node:path';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { dieMessage } from '../lib/log.ts';
import { USAGE, runAll, runQueue } from '../run-queue.ts';

const FLEET_HOME = resolve(import.meta.dirname, '../../..');

function main(argv: readonly string[]): number {
  const [target, ...rest] = argv;
  if (target === undefined) throw new Die(USAGE);
  if (target === '--all') return runAll({ fleetHome: FLEET_HOME, argv: rest, env: process.env });
  const cfg = loadRepo(FLEET_HOME, target);
  return runQueue(cfg, { fleetHome: FLEET_HOME, argv: rest, env: process.env });
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof Die) dieMessage(e.message);
  else if (e instanceof ConfigError) {
    if (!e.alreadyReported) dieMessage(e.message);
  } else dieMessage(`run-queue.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
