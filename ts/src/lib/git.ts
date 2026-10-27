// The git operations the harness needs, each a plain call. All take the tree as an absolute path (`git -C`), never the
// cwd. Some let git's stderr through to the log (a hook's output,
// `Preparing worktree …`, a fatal); others drop it (`push -q 2>/dev/null`,
// `worktree remove … 2>/dev/null`).
import { out } from './log.ts';
import { runSync, runToFile, type RunResult } from './proc.ts';

/** `git status --porcelain` minus the untracked .review-out/ line: the one
 *  thing a tree under review is allowed to carry. Empty when clean — and
 *  empty on a git error. */
export function porcelain(wt: string): string {
  const r = runSync('git', ['-C', wt, 'status', '--porcelain']);
  if (r.status !== 0) return '';
  return r.stdout
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('?? .review-out/'))
    .join('\n');
}

export function applyCheck(wt: string, patch: string): RunResult {
  return runSync('git', ['-C', wt, 'apply', '--check', patch]);
}

export function apply(wt: string, patch: string): RunResult {
  return runSync('git', ['-C', wt, 'apply', patch]);
}

/** Undo exactly the patch. Non-zero when it no longer applies in reverse. */
export function applyReverse(wt: string, patch: string): number {
  return runSync('git', ['-C', wt, 'apply', '-R', patch]).status;
}

/** Back to the committed tree: tracked files reset, untracked swept,
 *  .review-out/ kept. */
export function checkoutClean(wt: string): void {
  runSync('git', ['-C', wt, 'checkout', '-q', '--', '.']);
  runSync('git', ['-C', wt, 'clean', '-qfd', '-e', '.review-out']);
}

/** `rev-parse --verify --quiet <ref>`: does this checkout know the ref
 *  (status's refOf: origin/<branch> when it exists, else the local one). */
export function refExists(root: string, ref: string): boolean {
  return runSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', ref]).status === 0;
}

/** `show-ref --verify --quiet refs/heads/<name>`: a local branch, only. */
export function branchExists(root: string, name: string): boolean {
  return runSync('git', ['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`]).status === 0;
}

/** `merge-base --is-ancestor <a> <b>`; false when either is unknown. */
export function isAncestor(root: string, a: string, b: string): boolean {
  return runSync('git', ['-C', root, 'merge-base', '--is-ancestor', a, b]).status === 0;
}

/** Every ref of this checkout and the commit it names, from one
 *  `for-each-ref`; an annotated tag names the commit it points at. What
 *  refExists and branchExists answer, without a git call for each. */
export function refShas(root: string): Map<string, string> {
  const r = runSync('git', ['-C', root, 'for-each-ref', '--format=%(refname) %(objectname) %(*objectname)']);
  const refs = new Map<string, string>();
  if (r.status !== 0) return refs;
  for (const line of r.stdout.split('\n')) {
    const [name, sha, peeled] = line.split(' ');
    if (name !== undefined && name !== '' && sha !== undefined) refs.set(name, peeled !== undefined && peeled !== '' ? peeled : sha);
  }
  return refs;
}

/** `rev-list <ref>`: every commit reachable from it, its own included; empty
 *  when git cannot answer. What isAncestor answers, for every commit at
 *  once. 41 bytes a commit, so the buffer is far above any history here. */
export function reachable(root: string, ref: string): Set<string> {
  const r = runSync('git', ['-C', root, 'rev-list', ref], { maxBuffer: 256 * 1024 * 1024 });
  return new Set(r.status === 0 ? r.stdout.split('\n').filter((l) => l !== '') : []);
}

/** `rev-list --count <range>`; 0 when git cannot answer or does not print a
 *  number. */
export function revListCount(root: string, range: string): number {
  const r = runSync('git', ['-C', root, 'rev-list', '--count', range]);
  const t = r.stdout.trim();
  return r.status === 0 && /^[0-9]+$/.test(t) ? Number(t) : 0;
}

// ── the launcher's operations ────────────────────────────────────────────────

/** `git fetch <remote> --quiet`; the status is returned and nobody has to
 *  look at it. */
export function fetch(root: string, remote: string): number {
  return runSync('git', ['-C', root, 'fetch', remote, '--quiet'], { stderr: 'inherit' }).status;
}

export type WorktreeAddOptions =
  | { branch: string }                       // an existing branch
  | { newBranch: string; startPoint: string } // -b story/<id> origin/<base>
  | { detach: string };                      // --detach <sha>, the reviewer's tree

/** `git worktree add …` with stdout dropped (`>/dev/null`) and stderr through. */
export function worktreeAdd(root: string, path: string, o: WorktreeAddOptions): number {
  const args = 'branch' in o ? [path, o.branch] : 'newBranch' in o ? [path, '-b', o.newBranch, o.startPoint] : ['--detach', path, o.detach];
  return runSync('git', ['-C', root, 'worktree', 'add', ...args], { stderr: 'inherit' }).status;
}

/** `git worktree remove <path> --force 2>/dev/null`: both streams dropped,
 *  nothing thrown — the launcher's cleanupReviewer runs on every exit. The
 *  status is returned for merge.ts, which tells the human when it failed. */
export function worktreeRemoveForce(root: string, path: string): number {
  return runSync('git', ['-C', root, 'worktree', 'remove', path, '--force']).status;
}

/** `git merge-base <a> <b>`; '' when git cannot answer (the launcher logs
 *  `base ` and goes on). */
export function mergeBase(root: string, a: string, b: string): string {
  const r = runSync('git', ['-C', root, 'merge-base', a, b], { stderr: 'inherit' });
  return r.status === 0 ? r.stdout.trim() : '';
}

export function revParse(root: string, ref: string): string {
  const r = runSync('git', ['-C', root, 'rev-parse', ref], { stderr: 'inherit' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** The tree a commit holds — two commits with the same content share it;
 *  '' when git cannot answer (an unknown ref says nothing on stderr). */
export function treeOf(root: string, ref: string): string {
  const r = runSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{tree}`]);
  return r.status === 0 ? r.stdout.trim() : '';
}

/** `git diff --name-only <range>`, trailing newlines stripped. */
export function diffNameOnly(root: string, range: string): string {
  return runSync('git', ['-C', root, 'diff', '--name-only', range], { stderr: 'inherit' }).stdout.replace(/\n+$/, '');
}

/** `git add <path>` — one path per call: git add stages nothing at all when
 *  any one pathspec is missing (L-02). */
export function add(root: string, path: string): number {
  return runSync('git', ['-C', root, 'add', path], { stderr: 'inherit' }).status;
}

/** `git diff --cached --quiet`: true when nothing is staged. */
export function stagedIsEmpty(root: string): boolean {
  return runSync('git', ['-C', root, 'diff', '--cached', '--quiet']).status === 0;
}

/** `git commit -q -m <msg>`, stderr through — a hook that refuses says why
 *  in the log (case 50). */
export function commit(root: string, msg: string): number {
  return runSync('git', ['-C', root, 'commit', '-q', '-m', msg], { stderr: 'inherit' }).status;
}

/** `git push -q 2>/dev/null`. */
export function pushQuiet(root: string): number {
  return runSync('git', ['-C', root, 'push', '-q']).status;
}

// ── landing's operations (merge, revert, reset) ──────────────────────────────

/** `git push -q origin <src>:refs/heads/<dst>`, stderr through — the one push
 *  whose refusal a human must read. */
export function pushRef(root: string, src: string, dstBranch: string): number {
  return runSync('git', ['-C', root, 'push', '-q', 'origin', `${src}:refs/heads/${dstBranch}`], { stderr: 'inherit' }).status;
}

/** `git merge --no-ff <ref> -m <msg> > log 2>&1` in the throwaway worktree:
 *  git's whole account goes to the file, nothing to the terminal. */
export function mergeNoFf(wt: string, ref: string, msg: string, logFile: string): number {
  return runToFile('git', ['-C', wt, 'merge', '--no-ff', ref, '-m', msg], { logFile });
}

/** `git merge --abort 2>/dev/null`: both streams dropped, nothing thrown. */
export function mergeAbort(wt: string): void {
  runSync('git', ['-C', wt, 'merge', '--abort']);
}

/** `git revert -m 1 --no-edit <sha> > log 2>&1`: -m 1 keeps the side that
 *  was merged into, i.e. the epic without the story. */
export function revertMerge(wt: string, sha: string, logFile: string): number {
  return runToFile('git', ['-C', wt, 'revert', '-m', '1', '--no-edit', sha], { logFile });
}

/** `git revert --abort 2>/dev/null`. */
export function revertAbort(wt: string): void {
  runSync('git', ['-C', wt, 'revert', '--abort']);
}

/** `git branch -f <name> <sha> >/dev/null 2>&1`: non-zero when the branch is
 *  checked out somewhere, which the caller warns about. */
export function branchForce(root: string, name: string, sha: string): number {
  return runSync('git', ['-C', root, 'branch', '-f', name, sha]).status;
}

/** `git branch -D <name> >/dev/null`, stderr through. */
export function branchDelete(root: string, name: string): number {
  return runSync('git', ['-C', root, 'branch', '-D', name], { stderr: 'inherit' }).status;
}

/** `git worktree prune`. */
export function worktreePrune(root: string): void {
  runSync('git', ['-C', root, 'worktree', 'prune'], { stderr: 'inherit' });
}

/** The `branch refs/heads/…` lines of `git worktree list --porcelain`: every
 *  ref some worktree has checked out; a detached worktree contributes none. */
export function worktreeCheckedOutBranches(root: string): string[] {
  const r = runSync('git', ['-C', root, 'worktree', 'list', '--porcelain']);
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('branch '))
    .map((l) => l.slice('branch '.length));
}

/** The `worktree <path>` lines of `git worktree list --porcelain`: every
 *  worktree's real path, the main checkout's first. */
export function worktreePaths(root: string): string[] {
  const r = runSync('git', ['-C', root, 'worktree', 'list', '--porcelain']);
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}

/** `git ls-files --error-unmatch -- <path> >/dev/null 2>&1`: does git know
 *  the path, so that `add -A` on it cannot fail (L-02). */
export function lsFilesTracked(root: string, path: string): boolean {
  return runSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', path]).status === 0;
}

/** `git add -A -- <path>`: stages a deletion as well as a change. */
export function addAll(root: string, path: string): number {
  return runSync('git', ['-C', root, 'add', '-A', '--', path], { stderr: 'inherit' }).status;
}

/** `git --no-pager log --oneline <range>`, trailing newlines stripped; ''
 *  when git cannot answer. */
export function logOneline(root: string, range: string): string {
  const r = runSync('git', ['-C', root, '--no-pager', 'log', '--oneline', range], { stderr: 'inherit' });
  return r.status === 0 ? r.stdout.replace(/\n+$/, '') : '';
}

/** `git symbolic-ref --short -q HEAD`: the checked-out branch, '' when detached. */
export function currentBranch(root: string): string {
  const r = runSync('git', ['-C', root, 'symbolic-ref', '--short', '-q', 'HEAD']);
  return r.status === 0 ? r.stdout.trim() : '';
}

/** `git merge -q --ff-only <ref>` in the checkout: 0 and moved when HEAD is
 *  an ancestor of the ref, non-zero and untouched otherwise. Both streams
 *  dropped — the caller says what it did. */
export function mergeFfOnly(root: string, ref: string): number {
  return runSync('git', ['-C', root, 'merge', '-q', '--ff-only', ref]).status;
}

// ── the queue's operations ───────────────────────────────────────────────────

/** `git rev-parse --abbrev-ref @{u} 2>/dev/null`: the upstream's short name,
 *  '' when there is none. */
export function upstreamBranch(root: string): string {
  const r = runSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', '@{u}']);
  return r.status === 0 ? r.stdout.trim() : '';
}

/** `git rev-parse --absolute-git-dir 2>/dev/null`, `<root>/.git` on failure:
 *  where MERGE_HEAD/rebase-merge would live. */
export function gitDir(root: string): string {
  const r = runSync('git', ['-C', root, 'rev-parse', '--absolute-git-dir']);
  return r.status === 0 ? r.stdout.trim() : `${root}/.git`;
}

/** `git fetch <remote> 2>/dev/null`: both streams dropped, a refresh's fetch
 *  failure is a warning, not a die. */
export function fetchQuiet(root: string, remote: string): number {
  return runSync('git', ['-C', root, 'fetch', remote]).status;
}

/** `git merge --no-edit <ref> 2>/dev/null`: only stderr is dropped — git's
 *  stdout (`Already up to date.`, a merge summary) reaches ours. */
export function mergeNoEditQuiet(root: string, ref: string): number {
  const r = runSync('git', ['-C', root, 'merge', '--no-edit', ref]);
  if (r.stdout !== '') out(r.stdout);
  return r.status;
}

/** What became of a push that follows its upstream. */
export interface PushOutcome {
  /** The branch reached the remote. */
  pushed: boolean;
  /** The upstream merged in before the second push; '' when none was. */
  merged: string;
  /** Why the branch did not reach the remote; '' when it did. */
  why: string;
}

/** `git push -q`, and when that fails because the branch moved on the
 *  remote — an epic landed from the phone while this checkout could not
 *  follow (L-36) — the upstream merged in the way the queue's refresh does
 *  it, and one push more. A merge, never a rebase: what was pushed stays as
 *  it was. A conflict is aborted. A checkout with changes of its own is not
 *  merged into, the same guard landing keeps before it fast-forwards one. */
export function pushFollowingUpstream(root: string): PushOutcome {
  if (pushQuiet(root) === 0) return { pushed: true, merged: '', why: '' };
  const failed = (why: string): PushOutcome => ({ pushed: false, merged: '', why });
  if (porcelain(root) !== '') return failed('the checkout has uncommitted changes — not merged into');
  const upstream = upstreamBranch(root);
  if (upstream === '') return failed('no upstream to merge');
  if (fetchQuiet(root, 'origin') !== 0) return failed('the fetch failed too');
  if (revListCount(root, `HEAD..${upstream}`) === 0) return failed(`${upstream} holds nothing this checkout lacks`);
  if (mergeNoEditQuiet(root, upstream) !== 0) {
    mergeAbort(root);
    return failed(`merging ${upstream} conflicted — aborted`);
  }
  if (pushQuiet(root) !== 0) return { pushed: false, merged: upstream, why: `refused again after merging ${upstream}` };
  return { pushed: true, merged: upstream, why: '' };
}

// ── lint-story's citation walk ──────────────────────────────────────────────

/** `git cat-file -e <ref>:<path> 2>/dev/null`: does the path exist as a blob
 *  at that ref — false when the ref itself is unknown, not thrown, matching
 *  cat-file's own exit status. */
export function catFileExists(root: string, ref: string, path: string): boolean {
  return runSync('git', ['-C', root, 'cat-file', '-e', `${ref}:${path}`]).status === 0;
}

/** `git show <ref>:<path> 2>/dev/null | wc -l`: the newline count, not a
 *  split length — a file with no trailing newline is one short, as with
 *  wc -l; 0 when git cannot answer (missing path or unknown ref). */
export function showLineCount(root: string, ref: string, path: string): number {
  const r = runSync('git', ['-C', root, 'show', `${ref}:${path}`]);
  if (r.status !== 0) return 0;
  return (r.stdout.match(/\n/g) ?? []).length;
}

// ── new-epic's operations ────────────────────────────────────────────────────

/** `git fetch -q <remote> <ref>`: the one fetch that names a single ref
 *  rather than the whole remote — the newly pushed epic, fetched back so the
 *  caller's own checkout knows it. */
export function fetchRef(root: string, remote: string, ref: string): number {
  return runSync('git', ['-C', root, 'fetch', '-q', remote, ref], { stderr: 'inherit' }).status;
}

/** `git rev-parse --short <ref> 2>/dev/null`: the abbreviated sha for a log
 *  line; '' when git cannot answer. */
export function revParseShort(root: string, ref: string): string {
  const r = runSync('git', ['-C', root, 'rev-parse', '--short', ref]);
  return r.status === 0 ? r.stdout.trim() : '';
}
