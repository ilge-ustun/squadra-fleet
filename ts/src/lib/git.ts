// The five git operations the classifier needs, each a plain call. All
// take the tree as an absolute path (`git -C`), never the cwd.
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
