// fleet mcp — the fleet as a Model Context Protocol server (src/mcp/). An
// agent session — Claude Code, Codex — starts it as its child and calls its
// tools: the repos, status, one story, its review, its events, the latest
// events. Read-only: nothing it calls writes.
//
// The stdio transport: one JSON-RPC message a line, stdin in, stdout out.
// stdout carries those messages and nothing else — one log line there and
// the client cannot parse the stream — so the start line and a tool's bug
// go to stderr, which the client keeps as the server's log. lib/log.ts's
// log() and warn() write to stdout and are not used here.
//
// It ends when the client closes stdin. 1 with an XX line for an argument.
import { readFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { backfill, combine } from '../events.ts';
import { loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { EVENTS_FILE, readEvents } from '../lib/events.ts';
import { dieMessage } from '../lib/log.ts';
import { runSync } from '../lib/proc.ts';
import { handleLine, type Server } from '../mcp/server.ts';
import { fleetServer } from '../mcp/tools.ts';
import { registeredRepos } from '../run-queue.ts';
import { statusOf } from '../status.ts';

const FLEET_HOME = resolve(import.meta.dirname, '../../..');
const USAGE = 'usage: fleet mcp — a read-only MCP server on stdin and stdout, for an agent session to start (README.md, "The MCP server")';

/** A fleet process that still runs, as bin/dashboard.ts asks it. */
function alive(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('/ts/src/bin/');
  } catch {
    return false;
  }
}

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

class Gone extends Error {}

/** All of a line to stdout. A terminal shares one file with stdin, which
 *  readline makes non-blocking, so a write can be partial or EAGAIN. */
function send(text: string): void {
  const b = Buffer.from(text);
  for (let off = 0; off < b.length;) {
    try {
      off += writeSync(1, b, off);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPIPE') throw new Gone();
      if (code !== 'EAGAIN') throw e;
    }
  }
}

function main(argv: readonly string[]): void {
  if (argv.length > 0) throw new Die(USAGE);
  // A read takes no lock a commit needs, as fleet-dashboard.service says.
  process.env['GIT_OPTIONAL_LOCKS'] = '0';
  const head = runSync('git', ['-C', FLEET_HOME, 'rev-parse', '--short', 'HEAD']);
  const version = head.status === 0 ? head.stdout.trim() : 'unknown';
  const server: Server = {
    ...fleetServer({
      registry: () => registeredRepos(FLEET_HOME, process.env),
      load: (name) => loadRepo(FLEET_HOME, name, { captureStderr: true }),
      status: (cfg, one) => statusOf(cfg, one === undefined ? {} : { one }),
      events: (cfg, journal) => combine(readEvents(read(join(cfg.root, EVENTS_FILE)) ?? ''), backfill(cfg, { journal })),
      alive,
    }, version),
    warn: (m) => writeSync(2, `!! fleet mcp: ${m}\n`),
  };
  writeSync(2, `==> fleet mcp: read-only, fleet ${version}, tools: ${server.tools.map((t) => t.name).join(' ')}\n`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    const out = handleLine(line, server);
    try {
      if (out !== undefined) send(`${out}\n`);
    } catch (e) {
      if (!(e instanceof Gone)) throw e;
      rl.close();
    }
  });
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (e instanceof Die) dieMessage(e.message);
  else dieMessage(`mcp.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
