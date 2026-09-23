import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from './proc.ts';
import { branchExists, isAncestor, refExists, revListCount } from './git.ts';

// One throwaway repo: base has two commits, story/1 branches from the first
// and adds one, origin/base is a remote-tracking ref made without a remote.
let dir: string;
let root: string;
let first = '';
let second = '';

function git(args: string[]): string {
  const r = runSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(file: string, msg: string): string {
  writeFileSync(join(root, file), `${msg}\n`);
  git(['add', '-A']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg]);
  return git(['rev-parse', 'HEAD']);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-git-'));
  root = join(dir, 'repo');
  runSync('git', ['init', '-q', '-b', 'base', root]);
  first = commit('a', 'one');
  second = commit('b', 'two');
  git(['branch', 'story/1', first]);
  git(['checkout', '-q', 'story/1']);
  commit('c', 'story');
  git(['checkout', '-q', 'base']);
  git(['update-ref', 'refs/remotes/origin/base', second]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the queries status.sh makes', () => {
  it('refExists: rev-parse --verify --quiet (status.sh:70)', () => {
    expect(refExists(root, 'origin/base')).toBe(true);
    expect(refExists(root, 'base')).toBe(true);
    expect(refExists(root, 'origin/nope')).toBe(false);
  });

  it('branchExists: only refs/heads (status.sh:92,169)', () => {
    expect(branchExists(root, 'story/1')).toBe(true);
    expect(branchExists(root, 'origin/base')).toBe(false);
    expect(branchExists(root, 'story/2')).toBe(false);
  });

  it('isAncestor: merge-base --is-ancestor, false for an unknown ref', () => {
    expect(isAncestor(root, first, 'base')).toBe(true);
    expect(isAncestor(root, 'base', first)).toBe(false);
    expect(isAncestor(root, 'story/1', 'base')).toBe(false);
    expect(isAncestor(root, 'nope', 'base')).toBe(false);
  });

  it('revListCount: the count, 0 when git cannot answer (status.sh:103-104,173)', () => {
    expect(revListCount(root, 'base..story/1')).toBe(1);
    expect(revListCount(root, 'story/1..base')).toBe(1);
    expect(revListCount(root, 'origin/base..story/1')).toBe(1);
    expect(revListCount(root, 'nope..base')).toBe(0);
  });
});
