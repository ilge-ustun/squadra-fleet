import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { runSync } from './proc.ts';
import { lockPath, withFleetLock } from './lock.ts';

// `exec 9>"$REPO_ROOT/.git/fleet.lock"; flock -w N 9`, one file for the
// launcher and the bot, so they never commit into one index at once.
let root: string;
let holder: ChildProcess | undefined;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-lock-')); mkdirSync(join(root, '.git')); });
afterEach(() => { holder?.kill('SIGKILL'); holder = undefined; rmSync(root, { recursive: true, force: true }); });

const free = (): boolean => runSync('flock', ['-n', lockPath(root), 'true']).status === 0;
async function heldByAnother(seconds: string): Promise<void> {
  holder = spawn('flock', [lockPath(root), 'sleep', seconds], { stdio: 'ignore' });
  for (let i = 0; i < 100 && free(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(free()).toBe(false);
}

describe('withFleetLock', () => {
  it('holds the lock while fn runs, returns its value, releases after', () => {
    let duringFn: boolean | undefined;
    const v = withFleetLock(root, 5, () => { throw new Error('should not wait'); }, () => { duringFn = free(); return 42; });
    expect(v).toBe(42);
    expect(duringFn).toBe(false);
    expect(free()).toBe(true);
  });

  it('releases when fn throws', () => {
    expect(() => withFleetLock(root, 5, () => {}, () => { throw new Error('boom'); })).toThrow('boom');
    expect(free()).toBe(true);
  });

  it('waits for a holder up to waitSec, then goes on with the lock', async () => {
    await heldByAnother('0.5');
    const t0 = Date.now();
    let waited = false;
    withFleetLock(root, 5, () => { waited = true; }, () => { expect(free()).toBe(false); });
    expect(waited).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  });

  it('a wait that runs out calls onWaitFailed and still runs fn (a lost status commit is a dead round)', async () => {
    await heldByAnother('3');
    let waited = false;
    let ran = false;
    withFleetLock(root, 0, () => { waited = true; }, () => { ran = true; });
    expect(waited).toBe(true);
    expect(ran).toBe(true);
  });

  it('lockPath is .git/fleet.lock under the root', () => {
    expect(lockPath('/r')).toBe('/r/.git/fleet.lock');
  });
});
