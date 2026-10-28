// machine.ts — the machine the fleet runs on, read now: memory, swap, load,
// the disk, and the units that hold the most memory, each with its limits
// and its largest processes by name. The dashboard's server answers it as
// api/machine on each request; nothing records it, so a past moment has none.
//
// Read-only, from fixed paths: /proc, the cgroup tree, the passwd file for a
// user's name, and statfs of the fleet's own filesystem. A process's command
// line is never read, only its name, so no argument reaches the page.
import { readdirSync, readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { formatIsoMs } from '../lib/events.ts';

export interface MachineProc {
  name: string;
  count: number;
  /** Resident memory, summed over the processes of that name. */
  rss: number;
}

export interface MachineUnit {
  /** The unit or scope, its systemd escapes undone. */
  unit: string;
  /** `system`, or the user whose slice holds it. */
  owner: string;
  /** Anonymous memory: the kernel cannot drop it, only swap it. */
  inUse: number | null;
  /** The page cache charged to it; the kernel drops it under pressure. */
  cache: number | null;
  /** memory.current: both, and what MemoryHigh and MemoryMax act on. */
  charged: number | null;
  /** memory.peak: the most it was charged since it started. */
  peak: number | null;
  /** MemoryHigh and MemoryMax; null is none. */
  high: number | null;
  max: number | null;
  pids: number;
  /** Its largest processes, by name. */
  procs: MachineProc[];
}

export interface Machine {
  at: string;
  cpus: number;
  /** The load average over 1, 5 and 15 minutes. */
  load: number[] | null;
  memory: { total: number; available: number } | null;
  swap: { total: number; free: number } | null;
  /** The filesystem the fleet lives on. */
  disk: { total: number; free: number } | null;
  units: MachineUnit[];
}

export interface MachineOptions {
  proc: string;
  cgroup: string;
  passwd: string;
  /** A path on the fleet's filesystem. */
  disk: string;
  cpus: number;
  now: () => Date;
  /** How many units to keep; TOP_UNITS when absent. */
  top?: number;
}

export const TOP_UNITS = 8;
const PROCS_PER_UNIT = 3;

const read = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};
/** A `Key:   123 kB` line of meminfo or a status file, in bytes. */
const kb = (text: string | undefined, key: string): number | null => {
  const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(text ?? '');
  return m === null ? null : Number(m[1]) * 1024;
};
/** A `key 123` line of memory.stat. */
const stat = (text: string | undefined, key: string): number | null => {
  const m = new RegExp(`^${key} (\\d+)$`, 'm').exec(text ?? '');
  return m === null ? null : Number(m[1]);
};
/** A cgroup file of one number; `max` (no limit) and anything else is null. */
const number = (text: string | undefined): number | null => {
  const t = text?.trim();
  return t !== undefined && /^\d+$/.test(t) ? Number(t) : null;
};
const unescape = (name: string): string => name.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

function memoryOf(meminfo: string | undefined, total: string, free: string): { total: number; free: number } | null {
  const t = kb(meminfo, total);
  const f = kb(meminfo, free);
  return t === null || f === null ? null : { total: t, free: f };
}

function loadOf(text: string | undefined): number[] | null {
  const m = /^(\d+\.\d+) (\d+\.\d+) (\d+\.\d+) /.exec(text ?? '');
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function diskOf(path: string): Machine['disk'] {
  try {
    const s = statfsSync(path);
    return { total: s.bsize * s.blocks, free: s.bsize * s.bavail };
  } catch {
    return null;
  }
}

function usersOf(passwd: string | undefined): Map<number, string> {
  const users = new Map<number, string>();
  for (const line of (passwd ?? '').split('\n')) {
    const [name, , uid] = line.split(':');
    if (name !== undefined && name !== '' && uid !== undefined && /^\d+$/.test(uid)) users.set(Number(uid), name);
  }
  return users;
}

/** Each cgroup that holds a process, with its processes by name. */
function unitsOf(o: MachineOptions): MachineUnit[] {
  let pids: string[] = [];
  try {
    pids = readdirSync(o.proc).filter((n) => /^\d+$/.test(n));
  } catch {
    return [];
  }
  const groups = new Map<string, { pids: number; procs: Map<string, MachineProc> }>();
  for (const pid of pids) {
    // A kernel thread sits in the root, `0::/`, and has no VmRSS; a process
    // that ended since the listing has no files.
    const path = /^0::(\/.+)$/m.exec(read(join(o.proc, pid, 'cgroup')) ?? '')?.[1];
    if (path === undefined) continue;
    const status = read(join(o.proc, pid, 'status'));
    const rss = kb(status, 'VmRSS');
    if (rss === null) continue;
    const name = /^Name:\t(.*)$/m.exec(status ?? '')?.[1] ?? '?';
    let g = groups.get(path);
    if (g === undefined) {
      g = { pids: 0, procs: new Map() };
      groups.set(path, g);
    }
    g.pids += 1;
    const p = g.procs.get(name) ?? { name, count: 0, rss: 0 };
    p.count += 1;
    p.rss += rss;
    g.procs.set(name, p);
  }
  const users = usersOf(read(o.passwd));
  const units: MachineUnit[] = [];
  for (const [path, g] of groups) {
    const dir = join(o.cgroup, path);
    const memStat = read(join(dir, 'memory.stat'));
    const uid = /\/user-(\d+)\.slice(?:\/|$)/.exec(path)?.[1];
    units.push({
      unit: unescape(path.slice(path.lastIndexOf('/') + 1)),
      owner: uid === undefined ? 'system' : (users.get(Number(uid)) ?? `uid ${uid}`),
      inUse: stat(memStat, 'anon'),
      cache: stat(memStat, 'file'),
      charged: number(read(join(dir, 'memory.current'))),
      peak: number(read(join(dir, 'memory.peak'))),
      high: number(read(join(dir, 'memory.high'))),
      max: number(read(join(dir, 'memory.max'))),
      pids: g.pids,
      procs: [...g.procs.values()].sort((a, b) => b.rss - a.rss || a.name.localeCompare(b.name)).slice(0, PROCS_PER_UNIT),
    });
  }
  const size = (u: MachineUnit): number => u.inUse ?? u.charged ?? 0;
  return units.sort((a, b) => size(b) - size(a) || a.unit.localeCompare(b.unit)).slice(0, o.top ?? TOP_UNITS);
}

export function readMachine(o: MachineOptions): Machine {
  const meminfo = read(join(o.proc, 'meminfo'));
  const mem = memoryOf(meminfo, 'MemTotal', 'MemAvailable');
  return {
    at: formatIsoMs(o.now()),
    cpus: o.cpus,
    load: loadOf(read(join(o.proc, 'loadavg'))),
    memory: mem === null ? null : { total: mem.total, available: mem.free },
    swap: memoryOf(meminfo, 'SwapTotal', 'SwapFree'),
    disk: diskOf(o.disk),
    units: unitsOf(o),
  };
}
