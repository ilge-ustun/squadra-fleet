// The fleet lock: one advisory lock on <target>/.git/fleet.lock around every
// status commit, so the launcher and the bot, two writers on one index,
// never collide. As with `exec 9>lock; flock -w N 9`, the lock lives on the
// open file description. Node opens the file, hands the descriptor to a
// `flock` child as its fd 3, and keeps the description open — the lock
// survives the child's exit and goes when the descriptor is closed
// (checked, 23 Sep).
import { spawnSync } from 'node:child_process';
import { closeSync, constants, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Die } from './die.ts';

export function lockPath(root: string): string {
  return join(root, '.git', 'fleet.lock');
}

/** Take the lock (waiting up to waitSec — FLEET_LOCK_WAIT, 120), run fn,
 *  release. A wait that runs out calls onWaitFailed (each caller warns)
 *  and goes ahead anyway: a status commit lost to a lock is a dead round. */
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

// The launch lock: one launch per repo. `fleet launch` takes
// <target>/.git/fleet-launch.lock before it touches anything — --reap
// included — without waiting, and never lets go: the descriptor stays open
// for the life of the process, so the kernel releases the lock when the
// launcher ends, however it ends. While one launcher holds it no other can
// select, claim or reap, which is what makes the reap safe: a scan for
// processes in a story's worktrees cannot see a launcher that is between
// agents (L-31). The agents do not inherit it — node opens files
// close-on-exec and hands the descriptor only to the flock child — so a
// launcher killed with SIGKILL frees the repo while its agents may still be
// running; the reap's tree scan is what finds those.

/** EX_TEMPFAIL: another launch holds the repo; this one touched nothing. */
export const EXIT_LAUNCH_BUSY = 75;

export function launchLockPath(root: string): string {
  return join(root, '.git', 'fleet-launch.lock');
}

export type LaunchLock =
  | { held: true; name(what: string): void; release(): void }
  | { held: false; holder: string };

/** Take the launch lock, or say who has it. The file holds the holder's
 *  `<pid> <what>`; it is opened without truncating, so a failed attempt
 *  leaves that line for the next one to read. A flock that cannot run at
 *  all is a Die — "busy" is only ever flock's own answer. A launch never
 *  waits; `fleet test-deploy` waits up to waitSec for a launch to end. */
export function takeLaunchLock(root: string, what: string, waitSec = 0): LaunchLock {
  const path = launchLockPath(root);
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o644);
  const wait = waitSec > 0 ? ['-w', String(waitSec)] : ['-n'];
  const r = spawnSync('flock', [...wait, '-E', String(EXIT_LAUNCH_BUSY), '3'], { stdio: ['ignore', 'inherit', 'inherit', fd] });
  if (r.status === EXIT_LAUNCH_BUSY) {
    closeSync(fd);
    return { held: false, holder: launchLockHolder(root) };
  }
  if (r.status !== 0) {
    closeSync(fd);
    throw new Die(`cannot take ${path}: flock ${r.error !== undefined ? r.error.message : `exited ${r.status ?? r.signal}`}`);
  }
  const name = (w: string): void => {
    ftruncateSync(fd, 0);
    writeSync(fd, `${process.pid} ${w}\n`, 0);
  };
  name(what);
  return { held: true, name, release: () => closeSync(fd) };
}

/** The holder's line, `<pid> <what>`; '' when there is no file or no line. */
export function launchLockHolder(root: string): string {
  try {
    return readFileSync(launchLockPath(root), 'utf8').trim();
  } catch {
    return '';
  }
}
