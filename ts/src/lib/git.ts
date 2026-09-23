// The git operations the classifier and status need, each a plain call. All
// take the tree as an absolute path (`git -C`), never the cwd. Nothing here
// fetches: status is read-only (status.sh:66-68).
import { runSync, type RunResult } from './proc.ts';

/** `git status --porcelain` minus the untracked .review-out/ line: the one
 *  thing a tree under review is allowed to carry (mutation.sh:27). Empty
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
 *  .review-out/ kept (mutation.sh:58). */
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
