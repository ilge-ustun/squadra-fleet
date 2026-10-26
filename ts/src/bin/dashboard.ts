// fleet dashboard bundle — the read-only dashboard's data (src/dashboard/):
// everything the page shows, as one JSON document on stdout. Writes
// nothing. 0; 1 with an XX line for a usage error.
import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildBundle } from '../dashboard/bundle.ts';
import { loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { readJournal } from '../lib/journal.ts';
import { dieMessage } from '../lib/log.ts';
import { runSync } from '../lib/proc.ts';
import { registeredRepos } from '../run-queue.ts';

const FLEET_HOME = resolve(import.meta.dirname, '../../..');
const USAGE = 'usage: fleet dashboard bundle';

/** A fleet process that still runs: a launcher, a merge, a writer. */
function alive(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('/ts/src/bin/');
  } catch {
    return false;
  }
}

function bundle(): number {
  const b = buildBundle({
    registry: () => registeredRepos(FLEET_HOME, process.env),
    load: (name) => loadRepo(FLEET_HOME, name, { captureStderr: true }),
    journal: (repo) => readJournal(repo),
    systemctl: (args) => {
      const r = runSync('systemctl', args);
      return { status: r.status ?? 1, stdout: r.stdout };
    },
    fleetHome: FLEET_HOME,
    now: () => new Date(),
    alive,
  });
  writeSync(1, `${JSON.stringify(b)}\n`);
  return 0;
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'bundle' && rest.length === 0) process.exitCode = bundle();
  else throw new Die(USAGE);
} catch (e) {
  if (e instanceof Die) dieMessage(e.message);
  else dieMessage(`dashboard.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
