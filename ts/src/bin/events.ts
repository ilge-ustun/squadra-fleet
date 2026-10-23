// fleet events <repo> [<id>|epic/<name>] [--backfill] [--journal] — a
// target's event log as JSON lines, oldest first, and with --backfill the
// past it did not see (src/events.ts). Read-only. 0, or 1 with an XX line
// for a bad repo or a usage error.
import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { dieMessage } from '../lib/log.ts';
import { USAGE, events } from '../events.ts';

const FLEET_HOME = resolve(import.meta.dirname, '../../..');

function main(argv: readonly string[]): number {
  const [repo, ...rest] = argv;
  if (repo === undefined) throw new Die(USAGE);
  const cfg = loadRepo(FLEET_HOME, repo);
  return events(cfg, { argv: rest, out: (line) => writeSync(1, `${line}\n`) });
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof Die) dieMessage(e.message);
  else if (e instanceof ConfigError) {
    if (!e.alreadyReported) dieMessage(e.message);
  } else dieMessage(`events.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
