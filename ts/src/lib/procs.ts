// Liveness, L-04: a dead launcher does not stop the work it started, and
// `in_progress` in the frontmatter can be a stale orphan. The only
// trustworthy answer is what is running in the worktree — found by cwd,
// because the worktree path appears nowhere in the agents' command lines.
import { readdirSync, readlinkSync, realpathSync } from 'node:fs';

/** The pids whose cwd is the worktree or under it; none when the path does
 *  not resolve. Processes whose cwd we may not read are skipped. */
export function procsInWorktree(path: string): string[] {
  let wt: string;
  try {
    wt = realpathSync(path);
  } catch {
    return [];
  }
  const pids: string[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    let cwd: string;
    try {
      cwd = readlinkSync(`/proc/${name}/cwd`);
    } catch {
      continue;
    }
    if (cwd === wt || cwd.startsWith(`${wt}/`)) pids.push(name);
  }
  return pids;
}
