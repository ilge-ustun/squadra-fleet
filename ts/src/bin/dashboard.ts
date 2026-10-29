// fleet dashboard bundle | serve [--host <loopback>] [--port <n>] — the
// read-only dashboard (src/dashboard/). `bundle` prints everything the page
// shows as one JSON document; `serve` answers the page on a loopback port
// until it is stopped (systemd/fleet-dashboard.service). Neither writes
// anything. 0; 1 with an XX line for a usage error or a port it cannot take.
import { readFileSync, writeSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { buildBundle } from '../dashboard/bundle.ts';
import { readMachine } from '../dashboard/machine.ts';
import { HOST_DEFAULT, PORT_DEFAULT, bundleFromChild, dashboardServer, loopback } from '../dashboard/serve.ts';
import { loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { readJournal } from '../lib/journal.ts';
import { dieMessage, log, warn } from '../lib/log.ts';
import { runSync } from '../lib/proc.ts';
import { registeredRepos } from '../run-queue.ts';

const FLEET_HOME = resolve(import.meta.dirname, '../../..');
const USAGE = 'usage: fleet dashboard bundle | serve [--host <loopback address>] [--port <n>]';

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

function serve(argv: readonly string[]): void {
  let host = HOST_DEFAULT;
  let port = PORT_DEFAULT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--host' && v !== undefined) { host = v; i += 1; } else if (a === '--port' && v !== undefined && /^[0-9]{1,5}$/.test(v) && Number(v) <= 65535) { port = Number(v); i += 1; } else throw new Die(USAGE);
  }
  if (!loopback(host)) throw new Die(`${host} is not a loopback address — the dashboard listens on loopback, and Caddy publishes it (systemd/README.md)`);
  const server = dashboardServer({
    pageDir: join(FLEET_HOME, 'dashboard'),
    load: () => bundleFromChild([process.execPath, join(FLEET_HOME, 'ts/src/bin/dashboard.ts'), 'bundle'], process.env),
    machine: () => readMachine({ proc: '/proc', cgroup: '/sys/fs/cgroup', passwd: '/etc/passwd', disk: FLEET_HOME, cpus: availableParallelism(), now: () => new Date() }),
    warn: (m) => warn(m),
  });
  server.on('error', (e) => {
    dieMessage(`dashboard: ${e.message}`);
    process.exitCode = 1;
    server.close();
  });
  server.listen(port, host, () => {
    const a = server.address() as AddressInfo;
    log(`dashboard: http://${host.includes(':') ? `[${host}]` : host}:${a.port}/ — read-only`);
  });
  const stop = (): void => { server.close(); server.closeAllConnections(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'bundle' && rest.length === 0) process.exitCode = bundle();
  else if (cmd === 'serve') serve(rest);
  else throw new Die(USAGE);
} catch (e) {
  if (e instanceof Die) dieMessage(e.message);
  else dieMessage(`dashboard.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
