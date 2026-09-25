import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from './proc.ts';
import {
  add, branchExists, commit as gitCommit, diffNameOnly, fetch, isAncestor, mergeBase, pushQuiet, refExists, revListCount, revParse,
  stagedIsEmpty, worktreeAdd, worktreeRemoveForce,
  addAll, branchDelete, branchForce, logOneline, lsFilesTracked, mergeAbort, mergeNoFf, pushRef, revertAbort, revertMerge,
  worktreeCheckedOutBranches, worktreePrune, currentBranch, mergeFfOnly,
  fetchQuiet, gitDir, mergeNoEditQuiet, upstreamBranch,
  catFileExists, showLineCount,
  fetchRef, revParseShort,
} from './git.ts';
import { existsSync, readFileSync } from 'node:fs';

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

describe("lint-story's citation walk (seam 7)", () => {
  it('catFileExists: a blob at a ref, false for a missing path or an unknown ref', () => {
    expect(catFileExists(root, 'base', 'a')).toBe(true);
    expect(catFileExists(root, 'base', 'nope')).toBe(false);
    expect(catFileExists(root, 'origin/nope', 'a')).toBe(false);
    // story/1 only has 'a' and 'c' — 'b' was added on base after the branch.
    expect(catFileExists(root, 'story/1', 'c')).toBe(true);
    expect(catFileExists(root, 'story/1', 'b')).toBe(false);
  });

  it('showLineCount: the newline count, 0 for a missing path or an unknown ref', () => {
    expect(showLineCount(root, 'base', 'a')).toBe(1); // 'one\n'
    expect(showLineCount(root, 'base', 'nope')).toBe(0);
    expect(showLineCount(root, 'origin/nope', 'a')).toBe(0);
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

// The operations merge.sh, revert.sh and reset.sh make (seam 5), on a third
// repo with a bare origin: a --no-ff merge into a detached worktree of
// origin/<base> and its log file, a conflict and its abort, the revert of a
// merge and one that no longer applies, the local branch moved or refused.
describe('the operations landing makes', () => {
  let d3: string;
  let repo: string;
  let mwt: string;
  let base1 = '';
  let feat = '';
  let mergeSha = '';
  const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  function g(args: string[], cwd = repo): string {
    const r = runSync('git', args, { cwd, env: ENV });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  }
  function c(cwd: string, file: string, text: string, msg: string): string {
    writeFileSync(join(cwd, file), text);
    g(['add', '-A', '--', file], cwd);
    g(['commit', '-qm', msg], cwd);
    return g(['rev-parse', 'HEAD'], cwd);
  }
  beforeAll(() => {
    d3 = mkdtempSync(join(tmpdir(), 'fleet-git3-'));
    repo = join(d3, 'repo');
    mwt = join(d3, 'merge-1');
    runSync('git', ['init', '-q', '--bare', '-b', 'base', join(d3, 'origin.git')]);
    runSync('git', ['init', '-q', '-b', 'base', repo]);
    g(['config', 'user.name', 't']); g(['config', 'user.email', 't@t']);
    base1 = c(repo, 'a', 'one\n', 'one');
    g(['remote', 'add', 'origin', join(d3, 'origin.git')]);
    g(['push', '-q', '-u', 'origin', 'base']);
    g(['checkout', '-q', '-b', 'feat']);
    feat = c(repo, 'f', 'feature\n', 'feat: f');
    g(['checkout', '-q', 'base']);
  });
  afterAll(() => { rmSync(d3, { recursive: true, force: true }); });

  it('pushRef: push -q origin <src>:refs/heads/<dst>', () => {
    expect(pushRef(repo, 'feat', 'feat')).toBe(0);
    expect(g(['rev-parse', 'feat'], join(d3, 'origin.git'))).toBe(feat);
    expect(pushRef(repo, 'nope', 'nope')).not.toBe(0);
  });

  it('mergeNoFf into a detached worktree of origin/base, git\'s account in the log file', () => {
    expect(worktreeAdd(repo, mwt, { detach: 'origin/base' })).toBe(0);
    const log = join(d3, 'merge.log');
    expect(mergeNoFf(mwt, 'feat', 'merge(1): feat into base', log)).toBe(0);
    expect(readFileSync(log, 'utf8')).toMatch(/Merge made by/);
    mergeSha = g(['rev-parse', 'HEAD'], mwt);
    expect(g(['log', '-1', '--format=%s'], mwt)).toBe('merge(1): feat into base');
    expect(g(['rev-list', '--count', `${base1}..HEAD`], mwt)).toBe('2');
    expect(logOneline(mwt, `${base1}..feat`)).toBe(`${feat.slice(0, 7)} feat: f`);
    expect(logOneline(mwt, 'nope..feat')).toBe('');
  });

  it('a conflict: non-zero, CONFLICT in the log, mergeAbort leaves the tree clean', () => {
    g(['checkout', '-q', '-b', 'clash', base1]);
    c(repo, 'a', 'theirs\n', 'clash: a');
    g(['checkout', '-q', 'base']);
    c(mwt, 'a', 'ours\n', 'base: a');
    const log = join(d3, 'clash.log');
    expect(mergeNoFf(mwt, 'clash', 'merge(2): clash', log)).not.toBe(0);
    expect(readFileSync(log, 'utf8')).toMatch(/CONFLICT/);
    mergeAbort(mwt);
    expect(g(['status', '--porcelain'], mwt)).toBe('');
    expect(g(['log', '-1', '--format=%s'], mwt)).toBe('base: a');
  });

  it('revertMerge -m 1 of a merge commit; one that no longer applies is aborted', () => {
    const log = join(d3, 'revert.log');
    expect(revertMerge(mwt, mergeSha, log)).toBe(0);
    expect(existsSync(join(mwt, 'f'))).toBe(false);
    expect(g(['log', '-1', '--format=%s'], mwt)).toMatch(/^Revert "merge\(1\)/);
    // f is back, edited: undoing the merge that added it no longer applies.
    g(['reset', '-q', '--hard', 'HEAD~1'], mwt);
    c(mwt, 'f', 'edited later\n', 'edit f');
    expect(revertMerge(mwt, mergeSha, log)).not.toBe(0);
    expect(readFileSync(log, 'utf8')).toMatch(/CONFLICT|error/);
    revertAbort(mwt);
    expect(g(['status', '--porcelain'], mwt)).toBe('');
    expect(g(['log', '-1', '--format=%s'], mwt)).toBe('edit f');
  });

  it('branchForce moves a branch that is not checked out and refuses one that is', () => {
    expect(branchForce(repo, 'feat', base1)).toBe(0);
    expect(g(['rev-parse', 'feat'])).toBe(base1);
    expect(branchForce(repo, 'base', feat)).not.toBe(0);       // base is checked out in repo
    expect(g(['rev-parse', 'base'])).toBe(base1);
  });

  it('worktreeCheckedOutBranches: the refs the worktrees hold, a detached one not among them', () => {
    expect(worktreeCheckedOutBranches(repo)).toEqual(['refs/heads/base']);
    const wt2 = join(d3, 'wt-feat');
    expect(worktreeAdd(repo, wt2, { branch: 'feat' })).toBe(0);
    expect(worktreeCheckedOutBranches(repo).sort()).toEqual(['refs/heads/base', 'refs/heads/feat']);
    expect(branchDelete(repo, 'feat')).not.toBe(0);            // checked out in wt2
    worktreeRemoveForce(repo, wt2);
    worktreePrune(repo);
    expect(branchDelete(repo, 'feat')).toBe(0);
    expect(branchExists(repo, 'feat')).toBe(false);
    expect(branchDelete(repo, 'feat')).not.toBe(0);            // gone already
  });

  it('lsFilesTracked and addAll on a deleted path (reset.sh:92-94)', () => {
    expect(lsFilesTracked(repo, 'a')).toBe(true);
    expect(lsFilesTracked(repo, 'never')).toBe(false);
    rmSync(join(repo, 'a'));
    expect(addAll(repo, 'a')).toBe(0);
    expect(g(['diff', '--cached', '--name-status'])).toBe('D\ta');
    g(['reset', '-q', '--hard']);
    expect(lsFilesTracked(repo, 'a')).toBe(true);
  });
});

// After seam 5: the checkout that is on the base branch is fast-forwarded to
// the merge before the record is committed on it (merge.ts, case 120c).
describe('currentBranch and mergeFfOnly', () => {
  let d4: string;
  let repo: string;
  const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  function g(args: string[], cwd = repo): string {
    const r = runSync('git', args, { cwd, env: ENV });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  }
  beforeAll(() => {
    d4 = mkdtempSync(join(tmpdir(), 'fleet-git4-'));
    repo = join(d4, 'repo');
    runSync('git', ['init', '-q', '-b', 'base', repo]);
    g(['config', 'user.name', 't']); g(['config', 'user.email', 't@t']);
    writeFileSync(join(repo, 'a'), 'one\n'); g(['add', '-A']); g(['commit', '-qm', 'one']);
  });
  afterAll(() => { rmSync(d4, { recursive: true, force: true }); });

  it('currentBranch: the checked-out branch, \'\' when detached', () => {
    expect(currentBranch(repo)).toBe('base');
    const head = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', '--detach']);
    expect(currentBranch(repo)).toBe('');
    g(['checkout', '-q', 'base']);
    expect(g(['rev-parse', 'HEAD'])).toBe(head);
  });

  it('mergeFfOnly: 0 and moved when a fast-forward; non-zero and untouched when not', () => {
    const base1 = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', '-b', 'ahead']);
    writeFileSync(join(repo, 'b'), 'two\n'); g(['add', '-A']); g(['commit', '-qm', 'two']);
    const ahead = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'base']);
    expect(mergeFfOnly(repo, 'ahead')).toBe(0);
    expect(g(['rev-parse', 'HEAD'])).toBe(ahead);
    g(['checkout', '-q', '-b', 'diverged', base1]);
    writeFileSync(join(repo, 'c'), 'three\n'); g(['add', '-A']); g(['commit', '-qm', 'three']);
    const div = g(['rev-parse', 'HEAD']);
    expect(mergeFfOnly(repo, 'ahead')).not.toBe(0);
    expect(g(['rev-parse', 'HEAD'])).toBe(div);
    expect(g(['status', '--porcelain'])).toBe('');
  });
});

describe('the queue\'s refresh_from_origin operations (seam 6)', () => {
  let d5: string;
  let bare: string;
  let clone: string;
  const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  function g(args: string[], cwd = clone): string {
    const r = runSync('git', args, { cwd, env: ENV });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  }
  beforeAll(() => {
    d5 = mkdtempSync(join(tmpdir(), 'fleet-git5-'));
    bare = join(d5, 'origin.git');
    clone = join(d5, 'clone');
    runSync('git', ['init', '-q', '--bare', '-b', 'base', bare]);
    runSync('git', ['clone', '-q', bare, clone]);
    g(['config', 'user.name', 't']); g(['config', 'user.email', 't@t']);
    writeFileSync(join(clone, 'a'), 'one\n'); g(['add', '-A']); g(['commit', '-qm', 'one']);
    g(['push', '-q', '-u', 'origin', 'base']);
  });
  afterAll(() => { rmSync(d5, { recursive: true, force: true }); });

  it('upstreamBranch: the tracking branch\'s short name, \'\' with none', () => {
    expect(upstreamBranch(clone)).toBe('origin/base');
    const lone = join(d5, 'lone');
    runSync('git', ['init', '-q', '-b', 'base', lone]);
    expect(upstreamBranch(lone)).toBe('');
  });

  it('gitDir: the absolute .git dir; <root>/.git when git cannot answer', () => {
    expect(existsSync(gitDir(clone))).toBe(true);
    expect(gitDir(join(d5, 'nowhere'))).toBe(join(d5, 'nowhere', '.git'));
  });

  it('fetchRef: a single ref, not the whole remote (new-epic.sh:38)', () => {
    g(['push', '-q', 'origin', 'base:refs/heads/epic/x']);
    const other = join(d5, 'fetch-other');
    runSync('git', ['clone', '-q', bare, other]);
    expect(fetchRef(other, 'origin', 'epic/x')).toBe(0);
    expect(g(['rev-parse', 'FETCH_HEAD'], other)).toBe(g(['rev-parse', 'base']));
    expect(fetchRef(other, 'origin', 'nosuch')).not.toBe(0);
  });

  it("revParseShort: the abbreviated sha; '' when git cannot answer", () => {
    const short = revParseShort(clone, 'base');
    expect(short.length).toBeGreaterThan(0);
    expect(g(['rev-parse', 'base'])).toMatch(new RegExp(`^${short}`));
    expect(revParseShort(clone, 'nosuch')).toBe('');
  });

  it('fetchQuiet: 0 on a real remote, non-zero when it cannot be reached', () => {
    expect(fetchQuiet(clone, 'origin')).toBe(0);
    const unreachable = join(d5, 'gone.git');
    g(['remote', 'set-url', 'origin', unreachable]);
    expect(fetchQuiet(clone, 'origin')).not.toBe(0);
    g(['remote', 'set-url', 'origin', bare]);
  });

  it('mergeNoEditQuiet: fast-forwards on a clean merge, fails (untouched) on a conflict', () => {
    const other = join(d5, 'other');
    runSync('git', ['clone', '-q', bare, other]);
    function o(args: string[]): string {
      const r = runSync('git', args, { cwd: other, env: ENV });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    }
    o(['config', 'user.name', 't']); o(['config', 'user.email', 't@t']);
    o(['commit', '--allow-empty', '-qm', 'from elsewhere']);
    o(['push', '-q']);
    expect(fetchQuiet(clone, 'origin')).toBe(0);
    const before = g(['rev-parse', 'HEAD']);
    expect(mergeNoEditQuiet(clone, 'origin/base')).toBe(0);
    expect(g(['rev-parse', 'HEAD'])).not.toBe(before);

    // Now a real conflict: both sides touch 'a'.
    writeFileSync(join(other, 'a'), 'from elsewhere\n');
    o(['commit', '-qam', 'conflicting']);
    o(['push', '-q']);
    writeFileSync(join(clone, 'a'), 'from clone\n');
    g(['commit', '-qam', 'conflicting too']);
    const stuck = g(['rev-parse', 'HEAD']);
    expect(fetchQuiet(clone, 'origin')).toBe(0);
    expect(mergeNoEditQuiet(clone, 'origin/base')).not.toBe(0);
    mergeAbort(clone);
    expect(g(['rev-parse', 'HEAD'])).toBe(stuck);
    expect(g(['status', '--porcelain'])).toBe('');
  });
});
