import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { runSync } from './proc.ts';
import { EXIT_LAUNCH_BUSY, launchLockHolder, launchLockPath, lockPath, takeLaunchLock, withFleetLock } from './lock.ts';

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

// One launch per repo: `.git/fleet-launch.lock`, taken without waiting and
// held for the launcher's whole life — the kernel lets go when it exits,
// however it exits. The file names the holder, `<pid> <what>`.
describe('takeLaunchLock', () => {
  const launchFree = (): boolean => runSync('flock', ['-n', launchLockPath(root), 'true']).status === 0;
  const lockTs = join(import.meta.dirname, 'lock.ts');
  let child: ChildProcess | undefined;
  afterEach(() => { child?.kill('SIGKILL'); child = undefined; });

  /** A node process that takes the launch lock and keeps it until killed;
   *  resolves with its first line of output, `held` or `busy <holder>`. */
  function takeInChild(what: string): Promise<string> {
    const script = `import { takeLaunchLock } from ${JSON.stringify(lockTs)};
      const l = takeLaunchLock(${JSON.stringify(root)}, ${JSON.stringify(what)});
      process.stdout.write(l.held ? 'held\\n' : 'busy ' + l.holder + '\\n');
      setInterval(() => {}, 1000);`;
    child = spawn('node', ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    return new Promise((resolve) => {
      let out = '';
      child!.stdout!.on('data', (b: Buffer) => { out += b.toString(); if (out.includes('\n')) resolve(out.trim()); });
    });
  }

  it('takes a free lock and says who holds it; name() says what it is doing now', () => {
    const l = takeLaunchLock(root, 'selecting');
    expect(l.held).toBe(true);
    if (!l.held) return;
    expect(launchFree()).toBe(false);
    expect(readFileSync(launchLockPath(root), 'utf8')).toBe(`${process.pid} selecting\n`);
    l.name('story 900');
    expect(readFileSync(launchLockPath(root), 'utf8')).toBe(`${process.pid} story 900\n`);
    expect(launchLockHolder(root)).toBe(`${process.pid} story 900`);
    l.release();
    expect(launchFree()).toBe(true);
  });

  it('a held lock is busy: the holder comes back, and its line is left as it was', async () => {
    expect(await takeInChild('story 900')).toBe('held');
    const before = readFileSync(launchLockPath(root), 'utf8');
    expect(before).toBe(`${child!.pid} story 900\n`);
    const l = takeLaunchLock(root, 'reap');
    expect(l).toEqual({ held: false, holder: `${child!.pid} story 900` });
    expect(readFileSync(launchLockPath(root), 'utf8')).toBe(before);
  });

  // fleet test-deploy waits for a launch rather than failing at once: a
  // build beside a story's could run the machine out of memory, and a human
  // who asked for a deploy would rather wait for it.
  it('with waitSec, a busy lock is waited for and taken when its holder lets go', async () => {
    holder = spawn('flock', [launchLockPath(root), 'sleep', '0.6'], { stdio: 'ignore' });
    for (let i = 0; i < 100 && launchFree(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(launchFree()).toBe(false);
    const t0 = Date.now();
    const l = takeLaunchLock(root, 'test-deploy epic/x', 10);
    expect(l.held).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    expect(launchLockHolder(root)).toBe(`${process.pid} test-deploy epic/x`);
    if (l.held) l.release();
  });

  it('with waitSec, a lock still held when the wait runs out is busy', async () => {
    holder = spawn('flock', [launchLockPath(root), 'sleep', '5'], { stdio: 'ignore' });
    for (let i = 0; i < 100 && launchFree(); i++) await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    expect(takeLaunchLock(root, 'test-deploy epic/x', 1).held).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it('the lock goes with its process, even on SIGKILL', async () => {
    expect(await takeInChild('story 900')).toBe('held');
    expect(launchFree()).toBe(false);
    child!.kill('SIGKILL');
    for (let i = 0; i < 100 && !launchFree(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(launchFree()).toBe(true);
    const l = takeLaunchLock(root, 'story 901');
    expect(l.held).toBe(true);
    if (l.held) l.release();
  });

  it('a child started after the lock was taken does not keep it (the agents never hold it)', () => {
    const l = takeLaunchLock(root, 'story 900');
    if (!l.held) throw new Error('not held');
    holder = spawn('sleep', ['5'], { stdio: 'ignore' });
    l.release();
    expect(launchFree()).toBe(true);
  });

  it('a flock that cannot run is a Die, not "busy"', () => {
    const path = process.env['PATH'];
    process.env['PATH'] = join(root, 'nowhere');
    try {
      expect(() => takeLaunchLock(root, 'story 900')).toThrow(/flock/);
    } finally {
      process.env['PATH'] = path;
    }
  });

  it('launchLockHolder is the file\'s line, empty when there is none', () => {
    expect(launchLockHolder(root)).toBe('');
    writeFileSync(launchLockPath(root), '123 story 900\n');
    expect(launchLockHolder(root)).toBe('123 story 900');
  });

  it('launchLockPath is .git/fleet-launch.lock; busy is 75 (EX_TEMPFAIL)', () => {
    expect(launchLockPath('/r')).toBe('/r/.git/fleet-launch.lock');
    expect(EXIT_LAUNCH_BUSY).toBe(75);
  });
});
