import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatIsoMs } from '../lib/events.ts';
import { readMachine, type MachineOptions } from './machine.ts';

let dir: string;
const put = (path: string, text: string): void => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const RC = '/user.slice/user-1001.slice/user@1001.service/app.slice/app-fleet\\x2dremote\\x2dcontrol.slice/fleet-remote-control@qr-desktop-scanner.service';
const QUEUE = '/user.slice/user-1001.slice/user@1001.service/app.slice/app-fleet\\x2dqueue.slice/fleet-queue@qr\\x2ddesktop\\x2dscanner.service';
const HERMES = '/user.slice/user-1002.slice/user@1002.service/app.slice/hermes-gateway.service';
const CADDY = '/system.slice/caddy.service';
const proc = (pid: number, name: string, rssKb: number | null, cgroup: string): void => {
  put(`proc/${pid}/status`, `Name:\t${name}\nUmask:\t0022\nState:\tS (sleeping)\n${rssKb === null ? '' : `VmRSS:\t  ${rssKb} kB\n`}Threads:\t1\n`);
  put(`proc/${pid}/cgroup`, `0::${cgroup}\n`);
};
const unit = (path: string, f: { current: number; anon?: number; file?: number; peak?: number; high?: string; max?: string }): void => {
  put(`cgroup${path}/memory.current`, `${f.current}\n`);
  if (f.anon !== undefined) put(`cgroup${path}/memory.stat`, `anon ${f.anon}\nfile ${f.file ?? 0}\nkernel 1000\nshmem 0\n`);
  if (f.peak !== undefined) put(`cgroup${path}/memory.peak`, `${f.peak}\n`);
  put(`cgroup${path}/memory.high`, `${f.high ?? 'max'}\n`);
  put(`cgroup${path}/memory.max`, `${f.max ?? 'max'}\n`);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-machine-'));
  put('proc/meminfo', 'MemTotal:        8130772 kB\nMemFree:         1112144 kB\nMemAvailable:    5880424 kB\nBuffers:         1167176 kB\nSwapTotal:      16777212 kB\nSwapFree:       16396400 kB\n');
  put('proc/loadavg', '1.79 0.64 0.22 3/331 2887001\n');
  put('proc/uptime', '100.00 50.00\n');
  put('passwd', 'root:x:0:0:root:/root:/bin/bash\nfleet:x:1001:1001::/home/fleet:/bin/bash\n');
  proc(101, 'claude', 900_000, RC);
  proc(102, 'node', 200_000, RC);
  proc(103, 'node', 100_000, RC);
  proc(104, 'bash', 4_000, RC);
  proc(105, 'git', 1_000, RC);
  proc(201, 'caddy', 30_000, CADDY);
  proc(301, 'hermes', 310_000, HERMES);
  proc(401, 'node', 120_000, QUEUE);
  proc(2, 'kthreadd', null, '/');
  put('proc/999/cgroup', `0::${CADDY}\n`); // gone before its status was read
  unit(RC, { current: 2_000_000_000, anon: 1_500_000_000, file: 400_000_000, peak: 6_300_000_000 });
  unit(CADDY, { current: 25_000_000, anon: 9_000_000, file: 14_000_000 });
  unit(HERMES, { current: 323_000_000, anon: 306_000_000, file: 10_000_000, peak: 581_000_000, max: '1073741824' });
  unit(QUEUE, { current: 150_000_000, anon: 120_000_000, file: 25_000_000, peak: 1_800_000_000, high: '3145728000', max: '3670016000' });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const opts = (o: Partial<MachineOptions> = {}): MachineOptions => ({
  proc: join(dir, 'proc'), cgroup: join(dir, 'cgroup'), passwd: join(dir, 'passwd'), disk: dir,
  cpus: 4, now: () => new Date('2026-10-28T17:00:00+01:00'), ...o,
});

describe('readMachine', () => {
  it('reads memory, swap, load and the disk, in bytes', () => {
    const m = readMachine(opts());
    expect(m.at).toBe(formatIsoMs(new Date('2026-10-28T17:00:00+01:00')));
    expect(m.cpus).toBe(4);
    expect(m.memory).toEqual({ total: 8130772 * 1024, available: 5880424 * 1024 });
    expect(m.swap).toEqual({ total: 16777212 * 1024, free: 16396400 * 1024 });
    expect(m.load).toEqual([1.79, 0.64, 0.22]);
    expect(m.disk?.total).toBeGreaterThan(0);
    expect(m.disk?.free).toBeLessThanOrEqual(m.disk?.total ?? 0);
  });

  it('names the units that hold processes, largest in use first, with their limits', () => {
    const m = readMachine(opts());
    expect(m.units.map((u) => u.unit)).toEqual(['fleet-remote-control@qr-desktop-scanner.service', 'hermes-gateway.service', 'fleet-queue@qr-desktop-scanner.service', 'caddy.service']);
    expect(m.units[0]).toEqual({
      unit: 'fleet-remote-control@qr-desktop-scanner.service', owner: 'fleet', inUse: 1_500_000_000, cache: 400_000_000, charged: 2_000_000_000, peak: 6_300_000_000,
      high: null, max: null, pids: 5,
      procs: [{ name: 'claude', count: 1, rss: 900_000 * 1024 }, { name: 'node', count: 2, rss: 300_000 * 1024 }, { name: 'bash', count: 1, rss: 4_000 * 1024 }],
    });
    expect(m.units[1]).toMatchObject({ owner: 'uid 1002', high: null, max: 1073741824, peak: 581_000_000 });
    expect(m.units[2]).toMatchObject({ owner: 'fleet', high: 3145728000, max: 3670016000 });
    expect(m.units[3]).toMatchObject({ owner: 'system', peak: null, pids: 1 });
  });

  it('keeps the largest few; a kernel thread and a process that is gone are not counted', () => {
    const m = readMachine(opts({ top: 2 }));
    expect(m.units.map((u) => u.unit)).toEqual(['fleet-remote-control@qr-desktop-scanner.service', 'hermes-gateway.service']);
    expect(JSON.stringify(readMachine(opts()))).not.toContain('kthreadd');
  });

  it('says nothing it cannot read, and never throws', () => {
    const m = readMachine(opts({ proc: join(dir, 'none'), cgroup: join(dir, 'none'), passwd: join(dir, 'none'), disk: join(dir, 'none') }));
    expect(m).toMatchObject({ memory: null, swap: null, load: null, disk: null, units: [] });
  });

  it('a unit without memory.stat is ranked by what it is charged', () => {
    rmSync(join(dir, `cgroup${CADDY}/memory.stat`));
    unit(CADDY, { current: 3_000_000_000 });
    const m = readMachine(opts());
    expect(m.units[0]).toMatchObject({ unit: 'caddy.service', inUse: null, cache: null, charged: 3_000_000_000 });
  });
});
