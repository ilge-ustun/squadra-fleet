// The git operations the classifier, status and the launcher need, each a
// plain call. All take the tree as an absolute path (`git -C`), never the
// cwd. Where the bash let git's stderr through to the log (a hook's output,
// `Preparing worktree …`, a fatal), so does the call here; where it dropped
// it (`push -q 2>/dev/null`, `worktree remove … 2>/dev/null`), so does this.
import { runSync, type RunResult } from './proc.ts';

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
 *  nothing thrown — cleanup_reviewer runs on every exit. */
export function worktreeRemoveForce(root: string, path: string): void {
  runSync('git', ['-C', root, 'worktree', 'remove', path, '--force']);
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
