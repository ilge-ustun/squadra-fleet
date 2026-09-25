import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Die } from './lib/die.ts';
import { runSync } from './lib/proc.ts';
import type { RepoConfig } from './lib/config.ts';
import { newEpic } from './new-epic.ts';

let dir: string;
let clone: string;
let cfg: RepoConfig;

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function g(args: string[]): string {
  const r = runSync('git', args, { cwd: clone, env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-new-epic-'));
  const bare = join(dir, 'origin.git');
  clone = join(dir, 'clone');
  runSync('git', ['init', '-q', '--bare', '-b', 'base', bare]);
  runSync('git', ['clone', '-q', bare, clone]);
  g(['config', 'user.name', 't']);
  g(['config', 'user.email', 't@t']);
  writeFileSync(join(clone, 'a'), 'one\n');
  g(['add', '-A']);
  g(['commit', '-qm', 'one']);
  g(['push', '-q', '-u', 'origin', 'base']);
  cfg = {
    name: 't', root: clone, baseBranch: 'base', installCmd: '', vitestCmd: '', buildCmd: '', lintCmd: '',
    seedFiles: [], probeDir: '.', mergeMode: 'direct',
  };
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('newEpic (new-epic.sh:36-39, seam 7)', () => {
  it('creates the epic on origin, cut from origin/base, checkout untouched', () => {
    expect(newEpic(cfg, { argv: ['search'] })).toBe(0);
    expect(g(['rev-parse', 'origin/epic/search'])).toBe(g(['rev-parse', 'origin/base']));
    expect(g(['symbolic-ref', '--short', 'HEAD'])).toBe('base');
  });

  it('refuses a second time — it already exists', () => {
    expect(() => newEpic(cfg, { argv: ['search'] })).toThrow(/already exists/);
  });

  it('refuses a name with a space, or one that already carries the epic/ prefix', () => {
    expect(() => newEpic(cfg, { argv: ['bad name'] })).toThrow(Die);
    expect(() => newEpic(cfg, { argv: ['epic/x'] })).toThrow(Die);
  });

  it('refuses when argv is not exactly one name', () => {
    expect(() => newEpic(cfg, { argv: [] })).toThrow(Die);
    expect(() => newEpic(cfg, { argv: ['a', 'b'] })).toThrow(Die);
  });

  it('dies when origin has no such base branch to cut from', () => {
    const bad: RepoConfig = { ...cfg, baseBranch: 'nosuch' };
    expect(() => newEpic(bad, { argv: ['other'] })).toThrow(/no nosuch to cut from/);
  });
});
