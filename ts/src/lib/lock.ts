// The fleet lock — launch.sh:95-96,103,112 and telegram.sh's with_lock: one
// advisory lock on <target>/.git/fleet.lock around every status commit, so
// the launcher and the bot, two writers on one index, never collide. bash
// did `exec 9>lock; flock -w N 9`: the lock lives on the open file
// description. Node opens the file, hands the descriptor to a `flock` child
// as its fd 3, and keeps the description open — the lock survives the
// child's exit and goes when the descriptor is closed (checked, 23 Sep).
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';

export function lockPath(root: string): string {
  return join(root, '.git', 'fleet.lock');
}

/** Take the lock (waiting up to waitSec — FLEET_LOCK_WAIT, 120), run fn,
 *  release. A wait that runs out calls onWaitFailed and goes ahead anyway,
 *  as the bash warned and went ahead: a status commit lost to a lock is a
 *  dead round. */
export function withFleetLock<T>(root: string, waitSec: number, onWaitFailed: () => void, fn: () => T): T {
  const fd = openSync(lockPath(root), 'w');
  try {
    const r = spawnSync('flock', ['-w', String(waitSec), '3'], { stdio: ['ignore', 'inherit', 'inherit', fd] });
    if (r.status !== 0) onWaitFailed();
    return fn();
  } finally {
    closeSync(fd);
  }
}
