// bundle.ts — everything the dashboard shows, read once: for each registered
// repo its catalog (catalog.ts), its events (the log and its backfill, the
// journal included), each round's Machine block, and what only the present
// says — the queue unit and its timer, the launch lock, the test deploy, the
// pids that still run. `fleet dashboard bundle` prints it; the server
// (serve.ts) runs that in a child and answers from the result.
//
// Read-only: git log and show, the files, systemctl show. It writes nothing
// and holds no lock. A repo that cannot be read is an error in the bundle,
// and the others are read.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoConfig } from '../lib/config.ts';
import { EVENTS_FILE, formatIsoMs, readEvents, type FleetEvent } from '../lib/events.ts';
import { roundUsage } from '../lib/history.ts';
import { launchLockHolder } from '../lib/lock.ts';
import { backfill, combine } from '../events.ts';
import { statusOf } from '../status.ts';
import { catalogRepo, machineTexts, type CatalogRepo } from './catalog.ts';
import type { NowInfo } from './moment.ts';

export interface Bundle {
  v: 1;
  generatedAt: string;
  repos: CatalogRepo[];
  events: Record<string, FleetEvent[]>;
  /** repo → story → round → its Machine block. */
  machine: Record<string, Record<string, Record<number, string>>>;
  now: NowInfo;
  /** `<repo>: <why>` for each repo that could not be read. */
  errors: string[];
}

export interface BundleDeps {
  registry: () => string[];
  load: (name: string) => RepoConfig;
  /** The queue units' journal of a repo (lib/journal.ts readJournal). */
  journal: (repo: string) => string;
  systemctl: (args: string[]) => { status: number; stdout: string };
  fleetHome: string;
  now: () => Date;
  /** Whether a pid is a fleet process that still runs. */
  alive: (pid: number) => boolean;
}

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

const unixTime = (v: string | undefined): string | null => {
  const m = /^@(\d+)$/.exec(v ?? '');
  return m === null ? null : formatIsoMs(new Date(Number(m[1]) * 1000));
};

/** `systemctl show -p ActiveState -p ExecMainStartTimestamp -p ExecMainExitTimestamp --timestamp=unix`. */
export function parseUnit(text: string): { state: string; lastStart: string | null; lastEnd: string | null } {
  const f = new Map(text.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const));
  return { state: f.get('ActiveState') ?? '', lastStart: unixTime(f.get('ExecMainStartTimestamp')), lastEnd: unixTime(f.get('ExecMainExitTimestamp')) };
}

function unitOf(d: BundleDeps, repo: string): NowInfo['units'][string] {
  const show = d.systemctl(['--user', 'show', `fleet-queue@${repo}.service`, '-p', 'ActiveState', '-p', 'ExecMainStartTimestamp', '-p', 'ExecMainExitTimestamp', '--timestamp=unix']);
  if (show.status !== 0) return null;
  const u = parseUnit(show.stdout);
  if (u.state === '') return null;
  let next: string | null = null;
  const timers = d.systemctl(['--user', 'list-timers', '--all', '--output=json', `fleet-queue@${repo}.timer`]);
  if (timers.status === 0) {
    try {
      const t: unknown = JSON.parse(timers.stdout);
      const usec = Array.isArray(t) ? (t[0] as { next?: unknown } | undefined)?.next : undefined;
      if (typeof usec === 'number' && usec > 0) next = formatIsoMs(new Date(usec / 1000));
    } catch {
      /* no timer */
    }
  }
  return { ...u, next };
}

/** `.test-deploy.json`, without its URL or its checkout's path. */
function testDeployOf(d: BundleDeps): NowInfo['testDeploy'] {
  const text = read(join(d.fleetHome, '.test-deploy.json'));
  if (text === undefined) return null;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const since = typeof j['since'] === 'string' ? new Date(j['since'].replace(' ', 'T')) : undefined;
    const active = d.systemctl(['--user', 'show', 'fleet-test-deploy.service', '-p', 'ActiveState']);
    return {
      repo: String(j['repo'] ?? ''), branch: String(j['branch'] ?? ''), sha: String(j['short'] ?? j['sha'] ?? ''),
      since: since !== undefined && !Number.isNaN(since.getTime()) ? formatIsoMs(since) : '',
      active: active.status === 0 && /^ActiveState=active$/m.test(active.stdout),
    };
  } catch {
    return null;
  }
}

export function buildBundle(d: BundleDeps): Bundle {
  const b: Bundle = { v: 1, generatedAt: formatIsoMs(d.now()), repos: [], events: {}, machine: {}, now: { units: {}, locks: {}, testDeploy: testDeployOf(d), alive: [] }, errors: [] };
  const alive = new Set<number>();
  for (const name of d.registry()) {
    let cfg: RepoConfig;
    try {
      cfg = d.load(name);
    } catch (e) {
      b.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const root = cfg.root;
    const events = combine(readEvents(read(join(root, EVENTS_FILE)) ?? ''), backfill(cfg, { journal: true, readJournal: d.journal }));
    const machine: Record<string, Record<number, string>> = {};
    const repo = catalogRepo({
      name, baseBranch: cfg.baseBranch, status: statusOf(cfg), events,
      files: (id) => {
        const review = read(join(root, '.review', `${id}.md`));
        if (review !== undefined) machine[id] = machineTexts(review);
        return { story: read(join(root, '.stories', `${id}.md`)) ?? '', review, blocked: read(join(root, '.blocked', `${id}.md`)) };
      },
      usage: (id, n) => roundUsage(root, id, n),
    });
    b.repos.push(repo);
    b.events[name] = events;
    b.machine[name] = machine;
    b.now.units[name] = unitOf(d, name);
    const holder = /^(\d+) (.*)$/.exec(launchLockHolder(root));
    const pid = holder === null ? null : Number(holder[1]);
    b.now.locks[name] = holder === null ? null : { pid, what: holder[2] ?? '', held: pid !== null && d.alive(pid) };
    const ended = new Set(events.filter((e) => e.event === 'end').map((e) => `${e.run_id}|${e.span ?? ''}`));
    for (const e of events) {
      if (e.event === 'start' && typeof e.pid === 'number' && !ended.has(`${e.run_id}|${e.span ?? ''}`) && d.alive(e.pid)) alive.add(e.pid);
    }
  }
  b.now.alive = [...alive].sort((x, y) => x - y);
  return b;
}
