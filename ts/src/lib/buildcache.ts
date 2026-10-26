// buildcache.ts — the build folders a cargo target keeps outside its
// worktrees, and the prune that deletes them once their worktree is gone.
//
// A cargo target gives each worktree its own build folder,
// CARGO_TARGET_DIR="$HOME/.cache/fleet-cargo/<repo>/${PWD##*/}" (README, the
// runner contract): outside the tree, so the reviewer's tree, made afresh at
// every head, reuses what the last head compiled, and one per tree, because
// cargo trusts file times and a shared folder passed code it never compiled.
// The fleet removes worktrees and nothing removed their folders: on 26 Oct
// 2026, 34 of them held 99 GB of a 154 GB disk. Each drain prunes them
// (run-queue.ts).
import { readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

/** The folder holding one build folder per worktree of a repo:
 *  FLEET_CARGO_CACHE (default ~/.cache/fleet-cargo), then the repo's name.
 *  '' when neither that nor HOME is set. */
export function buildCacheDir(env: NodeJS.ProcessEnv, repo: string): string {
  const home = env['HOME'] ?? '';
  const top = env['FLEET_CARGO_CACHE'] ?? (home !== '' ? join(home, '.cache', 'fleet-cargo') : '');
  return top !== '' ? join(top, repo) : '';
}

/** A folder this prune is deleting; no worktree is ever named so. */
const PRUNING = '.pruning-';

/** Deletes every entry of `dir` that no live worktree is named after, and
 *  returns their names, sorted. `live` is the worktrees' paths; an empty
 *  list is a git that did not answer — the checkout itself is always one —
 *  and deletes nothing. Each folder is renamed before any is deleted: a
 *  worktree made after `live` was read runs its install before cargo, so
 *  its build starts in a new folder, never in one being deleted. A prune
 *  that died left renamed folders; they go first, unnamed. Throws what
 *  rename and rm throw. */
export function pruneBuildCache(dir: string, live: readonly string[]): string[] {
  if (live.length === 0) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const keep = new Set(live.map((p) => basename(p)));
  const gone = names.filter((n) => !keep.has(n));
  for (const n of gone.filter((n) => n.startsWith(PRUNING))) rmSync(join(dir, n), { recursive: true, force: true });
  const removed = gone.filter((n) => !n.startsWith(PRUNING)).sort();
  for (const n of removed) renameSync(join(dir, n), join(dir, PRUNING + n));
  for (const n of removed) rmSync(join(dir, PRUNING + n), { recursive: true, force: true });
  return removed;
}
