import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCacheDir, pruneBuildCache } from './buildcache.ts';

let dir: string;
const folder = (name: string): void => {
  mkdirSync(join(dir, name, 'debug'), { recursive: true });
  writeFileSync(join(dir, name, 'debug', 'libqr_core.rlib'), 'x');
};
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-buildcache-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('buildCacheDir', () => {
  it('is FLEET_CARGO_CACHE, else ~/.cache/fleet-cargo, then the repo; empty with neither', () => {
    expect(buildCacheDir({ FLEET_CARGO_CACHE: '/c', HOME: '/h' }, 'qr')).toBe('/c/qr');
    expect(buildCacheDir({ HOME: '/h' }, 'qr')).toBe('/h/.cache/fleet-cargo/qr');
    expect(buildCacheDir({}, 'qr')).toBe('');
  });
});

describe('pruneBuildCache', () => {
  it('deletes each folder no live worktree is named after, and says which', () => {
    for (const n of ['qr-desktop-scanner', 'wt-021', 'wt-020', 'wt-020-review', 'merge-epic-core', 'debug']) folder(n);
    writeFileSync(join(dir, 'CACHEDIR.TAG'), 'x');
    const live = ['/w/projects/qr-desktop-scanner', '/w/projects/wt-021'];
    expect(pruneBuildCache(dir, live)).toEqual(['CACHEDIR.TAG', 'debug', 'merge-epic-core', 'wt-020', 'wt-020-review']);
    expect(readdirSync(dir).sort()).toEqual(['qr-desktop-scanner', 'wt-021']);
    expect(existsSync(join(dir, 'wt-021', 'debug', 'libqr_core.rlib'))).toBe(true);
  });

  it('finishes what a prune that died left, without naming it again', () => {
    folder('.pruning-wt-019');
    folder('wt-019');
    expect(pruneBuildCache(dir, ['/w/qr'])).toEqual(['wt-019']);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('deletes nothing when git listed no worktree, or there is no folder', () => {
    folder('wt-021');
    expect(pruneBuildCache(dir, [])).toEqual([]);
    expect(readdirSync(dir)).toEqual(['wt-021']);
    expect(pruneBuildCache(join(dir, 'none'), ['/w/qr'])).toEqual([]);
  });
});
