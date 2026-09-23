import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from './proc.ts';
import {
  add, branchExists, commit as gitCommit, diffNameOnly, fetch, isAncestor, mergeBase, pushQuiet, refExists, revListCount, revParse,
  stagedIsEmpty, worktreeAdd, worktreeRemoveForce,
} from './git.ts';
import { existsSync } from 'node:fs';

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

// The operations launch.sh makes (launch.sh:95-112, 428-449, 573-606), on a
// second repo with a real bare origin so fetch and push can be exercised.
describe('the operations the launcher makes', () => {
  let d2: string;
  let repo: string;
  let base1 = '';
  const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  function g(args: string[], cwd = repo): string {
    const r = runSync('git', args, { cwd, env: ENV });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  }
  beforeAll(() => {
    d2 = mkdtempSync(join(tmpdir(), 'fleet-git2-'));
    repo = join(d2, 'repo');
    runSync('git', ['init', '-q', '--bare', '-b', 'base', join(d2, 'origin.git')]);
    runSync('git', ['init', '-q', '-b', 'base', repo]);
    g(['config', 'user.name', 't']); g(['config', 'user.email', 't@t']);
    writeFileSync(join(repo, 'a'), 'one\n'); g(['add', '-A']); g(['commit', '-qm', 'one']);
    base1 = g(['rev-parse', 'HEAD']);
    g(['remote', 'add', 'origin', join(d2, 'origin.git')]);
    g(['push', '-q', '-u', 'origin', 'base']);
  });
  afterAll(() => { rmSync(d2, { recursive: true, force: true }); });

  it('fetch: status back, nothing thrown; revParse; mergeBase and its empty answer', () => {
    expect(fetch(repo, 'origin')).toBe(0);
    expect(revParse(repo, 'HEAD')).toBe(base1);
    expect(mergeBase(repo, 'HEAD', 'origin/base')).toBe(base1);
    expect(mergeBase(repo, 'HEAD', 'origin/nope')).toBe('');
  });

  it('worktreeAdd -b from origin/<base>, then by existing branch, then --detach; remove --force', () => {
    const wt = join(d2, 'wt-1');
    expect(worktreeAdd(repo, wt, { newBranch: 'story/1', startPoint: 'origin/base' })).toBe(0);
    expect(existsSync(join(wt, 'a'))).toBe(true);
    expect(g(['rev-parse', '--abbrev-ref', 'HEAD'], wt)).toBe('story/1');
    writeFileSync(join(wt, 'b'), 'two\n'); g(['add', '-A'], wt); g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'two'], wt);
    const head = g(['rev-parse', 'HEAD'], wt);
    worktreeRemoveForce(repo, wt);
    expect(existsSync(wt)).toBe(false);
    expect(worktreeAdd(repo, wt, { branch: 'story/1' })).toBe(0);
    expect(g(['rev-parse', 'HEAD'], wt)).toBe(head);
    const rv = join(d2, 'wt-1-review');
    expect(worktreeAdd(repo, rv, { detach: head })).toBe(0);
    expect(g(['rev-parse', 'HEAD'], rv)).toBe(head);
    expect(diffNameOnly(wt, `${base1}..${head}`)).toBe('b');
    expect(revListCount(wt, `${base1}..${head}`)).toBe(1);
    worktreeRemoveForce(repo, rv);
    worktreeRemoveForce(repo, join(d2, 'never-existed'));       // both streams dropped, nothing thrown
    expect(worktreeAdd(repo, join(d2, 'wt-x'), { newBranch: 'story/1', startPoint: 'origin/base' })).not.toBe(0);  // branch exists
  });

  it('add each path separately, stagedIsEmpty, commit, pushQuiet — the status commit (L-02)', () => {
    expect(stagedIsEmpty(repo)).toBe(true);
    writeFileSync(join(repo, 'a'), 'changed\n');
    expect(add(repo, 'a')).toBe(0);
    expect(add(repo, 'missing-path')).not.toBe(0);           // one missing pathspec fails that add alone
    expect(stagedIsEmpty(repo)).toBe(false);
    expect(gitCommit(repo, 'story(1): done')).toBe(0);
    expect(stagedIsEmpty(repo)).toBe(true);
    expect(g(['log', '-1', '--format=%s'])).toBe('story(1): done');
    expect(pushQuiet(repo)).toBe(0);
    expect(g(['rev-parse', 'base'], join(d2, 'origin.git'))).toBe(g(['rev-parse', 'HEAD']));
  });
});
