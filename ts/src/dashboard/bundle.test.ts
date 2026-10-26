import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoConfig } from '../lib/config.ts';
import { formatIsoMs } from '../lib/events.ts';
import { runSync } from '../lib/proc.ts';
import { buildBundle, parseUnit, type BundleDeps } from './bundle.ts';

let dir: string;
let root: string;
const git = (...args: string[]): void => { runSync('git', ['-C', root, ...args]); };
const commit = (status: string, msg: string, at: string): void => {
  writeFileSync(join(root, '.stories', '900.md'), `---\nstatus: ${status}\nround: 0\n---\n\n# Story 900: A fixture\n\n**AC1 — It holds.** Goes red when removed.\n`);
  git('add', '-A');
  runSync('git', ['-C', root, 'commit', '-qm', msg], { env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-bundle-'));
  root = join(dir, 't');
  mkdirSync(join(root, '.stories'), { recursive: true });
  runSync('git', ['init', '-q', '-b', 'base', root]);
  git('config', 'user.name', 't'); git('config', 'user.email', 't@t');
  commit('draft', 'story(900): draft', '2026-10-22T10:00:00+02:00');
  commit('ready', 'story(900): promoted to ready (fleet promote)', '2026-10-22T10:05:00+02:00');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const deps = (o: Partial<BundleDeps> = {}): BundleDeps => ({
  registry: () => ['t'],
  load: (name) => {
    if (name !== 't') throw new Error(`no ${name}`);
    return { name, root, baseBranch: 'base' } as RepoConfig;
  },
  journal: () => '',
  systemctl: () => ({ status: 1, stdout: '' }),
  fleetHome: dir,
  now: () => new Date('2026-10-22T11:00:00+02:00'),
  alive: () => false,
  ...o,
});

describe('buildBundle', () => {
  it('reads each repo: its stories and their history, read-only', () => {
    const before = runSync('git', ['-C', root, 'status', '--porcelain']).stdout;
    const b = buildBundle(deps());
    expect(b.errors).toEqual([]);
    expect(b.repos.map((r) => r.name)).toEqual(['t']);
    const s = b.repos[0]?.stories[0];
    expect(s).toMatchObject({ id: '900', title: 'A fixture', status: 'ready', landing: 'ready', acs: [{ id: 'AC1', claim: 'It holds' }] });
    expect(s?.history.map((h) => h.kind)).toEqual(['draft', 'promoted']);
    expect(b.now.units['t']).toBeNull();
    expect(b.now.testDeploy).toBeNull();
    expect(runSync('git', ['-C', root, 'status', '--porcelain']).stdout).toBe(before);
  });

  it('a repo whose config fails is an error, and the others are read', () => {
    const b = buildBundle(deps({ registry: () => ['gone', 't'] }));
    expect(b.errors).toEqual(['gone: no gone']);
    expect(b.repos.map((r) => r.name)).toEqual(['t']);
  });

  it('the present: the queue unit, its timer, the test deploy', () => {
    writeFileSync(join(dir, '.test-deploy.json'), JSON.stringify({ repo: 't', root, branch: 'base', sha: 'e4f074f1aa', short: 'e4f074f', url: 'https://x', since: '2026-10-22 02:52' }));
    const systemctl = (args: string[]): { status: number; stdout: string } => {
      if (args.includes('list-timers')) return { status: 0, stdout: JSON.stringify([{ next: 1792656000000000, unit: 'fleet-queue@t.timer' }]) };
      if (args.includes('fleet-test-deploy.service')) return { status: 0, stdout: 'ActiveState=active\n' };
      return { status: 0, stdout: 'ActiveState=inactive\nExecMainStartTimestamp=@1792655100\nExecMainExitTimestamp=@1792655109\n' };
    };
    const b = buildBundle(deps({ systemctl }));
    expect(b.now.units['t']).toEqual({ state: 'inactive', lastStart: formatIsoMs(new Date(1792655100_000)), lastEnd: formatIsoMs(new Date(1792655109_000)), next: formatIsoMs(new Date(1792656000_000)) });
    expect(b.now.testDeploy).toMatchObject({ repo: 't', branch: 'base', sha: 'e4f074f', active: true });
    expect(JSON.stringify(b)).not.toContain('https://x');
    expect(JSON.stringify(b)).not.toContain(root);
  });
});

describe('parseUnit', () => {
  it('reads systemctl show --timestamp=unix; an empty time is null', () => {
    expect(parseUnit('ActiveState=activating\nExecMainStartTimestamp=@1792655100\nExecMainExitTimestamp=\n')).toEqual({ state: 'activating', lastStart: formatIsoMs(new Date(1792655100_000)), lastEnd: null });
  });
});
