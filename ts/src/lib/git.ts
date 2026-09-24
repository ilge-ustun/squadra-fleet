// The git operations the classifier, status and the launcher need, each a
// plain call. All take the tree as an absolute path (`git -C`), never the
// cwd. Where the bash let git's stderr through to the log (a hook's output,
// `Preparing worktree …`, a fatal), so does the call here; where it dropped
// it (`push -q 2>/dev/null`, `worktree remove … 2>/dev/null`), so does this.
import { runSync, runToFile, type RunResult } from './proc.ts';

/** `git status --porcelain` minus the untracked .review-out/ line: the one
 *  thing a tree under review is allowed to carry (mutation.sh@8fe954a:27). Empty
 *  when clean — and empty on a git error, as the bash `|| true` made it. */
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
 *  .review-out/ kept (mutation.sh@8fe954a:58). */
export function checkoutClean(wt: string): void {
  runSync('git', ['-C', wt, 'checkout', '-q', '--', '.']);
  runSync('git', ['-C', wt, 'clean', '-qfd', '-e', '.review-out']);
}

/** `rev-parse --verify --quiet <ref>`: does this checkout know the ref
 *  (status.sh:70 — origin/<branch> when it exists, else the local one). */
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

/** `rev-list --count <range>`; 0 when git cannot answer or does not print a
 *  number (status.sh:103-104,173). */
export function revListCount(root: string, range: string): number {
  const r = runSync('git', ['-C', root, 'rev-list', '--count', range]);
  const t = r.stdout.trim();
  return r.status === 0 && /^[0-9]+$/.test(t) ? Number(t) : 0;
}

// ── the launcher's operations (launch.sh:95-112, 428-449, 573-606) ───────────

/** `git fetch <remote> --quiet`; the status is returned and, as in the bash,
 *  nobody has to look at it. */
export function fetch(root: string, remote: string): number {
  return runSync('git', ['-C', root, 'fetch', remote, '--quiet'], { stderr: 'inherit' }).status;
}

export type WorktreeAddOptions =
  | { branch: string }                       // an existing branch (launch.sh:434)
  | { newBranch: string; startPoint: string } // -b story/<id> origin/<base> (:436)
  | { detach: string };                      // --detach <sha>, the reviewer's tree (:597)

/** `git worktree add …` with stdout dropped (`>/dev/null`) and stderr through. */
export function worktreeAdd(root: string, path: string, o: WorktreeAddOptions): number {
  const args = 'branch' in o ? [path, o.branch] : 'newBranch' in o ? [path, '-b', o.newBranch, o.startPoint] : ['--detach', path, o.detach];
  return runSync('git', ['-C', root, 'worktree', 'add', ...args], { stderr: 'inherit' }).status;
}

/** `git worktree remove <path> --force 2>/dev/null`: both streams dropped,
 *  nothing thrown — cleanup_reviewer runs on every exit. The status is
 *  returned for merge.sh:253, which tells the human when it failed. */
export function worktreeRemoveForce(root: string, path: string): number {
  return runSync('git', ['-C', root, 'worktree', 'remove', path, '--force']).status;
}

/** `git merge-base <a> <b>`; '' when git cannot answer (the bash logged
 *  `base ` and went on). */
export function mergeBase(root: string, a: string, b: string): string {
  const r = runSync('git', ['-C', root, 'merge-base', a, b], { stderr: 'inherit' });
  return r.status === 0 ? r.stdout.trim() : '';
}

export function revParse(root: string, ref: string): string {
  const r = runSync('git', ['-C', root, 'rev-parse', ref], { stderr: 'inherit' });
  return r.status === 0 ? r.stdout.trim() : '';
}

/** `git diff --name-only <range>`, trailing newlines stripped as `$(…)` did. */
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

// ── landing's operations (merge.sh, revert.sh, reset.sh — seam 5) ────────────

/** `git push -q origin <src>:refs/heads/<dst>`, stderr through (merge.sh:143,205;
 *  revert.sh:57) — the one push whose refusal a human must read. */
export function pushRef(root: string, src: string, dstBranch: string): number {
  return runSync('git', ['-C', root, 'push', '-q', 'origin', `${src}:refs/heads/${dstBranch}`], { stderr: 'inherit' }).status;
}

/** `git merge --no-ff <ref> -m <msg> > log 2>&1` in the throwaway worktree
 *  (merge.sh:167): git's whole account goes to the file, nothing to the terminal. */
export function mergeNoFf(wt: string, ref: string, msg: string, logFile: string): number {
  return runToFile('git', ['-C', wt, 'merge', '--no-ff', ref, '-m', msg], { logFile });
}

/** `git merge --abort 2>/dev/null`: both streams dropped, nothing thrown. */
export function mergeAbort(wt: string): void {
  runSync('git', ['-C', wt, 'merge', '--abort']);
}

/** `git revert -m 1 --no-edit <sha> > log 2>&1` (revert.sh:51): -m 1 keeps
 *  the side that was merged into, i.e. the epic without the story. */
export function revertMerge(wt: string, sha: string, logFile: string): number {
  return runToFile('git', ['-C', wt, 'revert', '-m', '1', '--no-edit', sha], { logFile });
}

/** `git revert --abort 2>/dev/null`. */
export function revertAbort(wt: string): void {
  runSync('git', ['-C', wt, 'revert', '--abort']);
}

/** `git branch -f <name> <sha> >/dev/null 2>&1` (merge.sh:214, revert.sh:60):
 *  non-zero when the branch is checked out somewhere, which the caller warns about. */
export function branchForce(root: string, name: string, sha: string): number {
  return runSync('git', ['-C', root, 'branch', '-f', name, sha]).status;
}

/** `git branch -D <name> >/dev/null` (reset.sh:77), stderr through. */
export function branchDelete(root: string, name: string): number {
  return runSync('git', ['-C', root, 'branch', '-D', name], { stderr: 'inherit' }).status;
}

/** `git worktree prune` (reset.sh:74). */
export function worktreePrune(root: string): void {
  runSync('git', ['-C', root, 'worktree', 'prune'], { stderr: 'inherit' });
}

/** The `branch refs/heads/…` lines of `git worktree list --porcelain`: every
 *  ref some worktree has checked out (merge.sh:211's `grep -qx "branch …"`);
 *  a detached worktree contributes none. */
export function worktreeCheckedOutBranches(root: string): string[] {
  const r = runSync('git', ['-C', root, 'worktree', 'list', '--porcelain']);
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('branch '))
    .map((l) => l.slice('branch '.length));
}

/** `git ls-files --error-unmatch -- <path> >/dev/null 2>&1` (reset.sh:93): does
 *  git know the path, so that `add -A` on it cannot fail (L-02). */
export function lsFilesTracked(root: string, path: string): boolean {
  return runSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', path]).status === 0;
}

/** `git add -A -- <path>` (reset.sh:94): stages a deletion as well as a change. */
export function addAll(root: string, path: string): number {
  return runSync('git', ['-C', root, 'add', '-A', '--', path], { stderr: 'inherit' }).status;
}

/** `git --no-pager log --oneline <range>` (reset.sh:63), trailing newlines
 *  stripped; '' when git cannot answer. */
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
