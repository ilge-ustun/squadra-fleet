import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { procsInWorktree } from './procs.ts';
import { run, runBashTo, runInherit, runSync, runToFile } from './proc.ts';

describe('runSync', () => {
  it('returns the exit status and both streams', () => {
    const r = runSync('bash', ['-c', 'echo out; echo err >&2; exit 3']);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('out\n');
    expect(r.stderr).toBe('err\n');
  });

  it('runs in the given directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-proc-'));
    try {
      const r = runSync('pwd', [], { cwd: dir });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(runSync('pwd', [], { cwd: dir }).stdout.trim());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing program as a non-zero status, not a throw', () => {
    const r = runSync('fleet-no-such-program-xyz', []);
    expect(r.status).not.toBe(0);
  });
});

describe('runBashTo', () => {
  it('runs the line under bash with stdout and stderr in the log file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-proc-'));
    try {
      const log = join(dir, 'run.log');
      const status = runBashTo('echo one; echo two >&2; [[ -n $BASH_VERSION ]] && exit 7', { cwd: dir, logFile: log });
      expect(status).toBe(7);
      expect(readFileSync(log, 'utf8')).toBe('one\ntwo\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('truncates a previous log even when the line does nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-proc-'));
    try {
      const log = join(dir, 'run.log');
      writeFileSync(log, 'stale\n');
      expect(runBashTo('true', { cwd: dir, logFile: log })).toBe(0);
      expect(readFileSync(log, 'utf8')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runSync options for the config loader', () => {
  it('env replaces the environment the child sees', () => {
    const r = runSync('bash', ['-c', 'echo "${FLEET_T_A:-unset}|${HOME:-nohome}"'], {
      env: { PATH: process.env['PATH'] ?? '', FLEET_T_A: 'a' },
    });
    expect(r.stdout).toBe('a|nohome\n');
  });

  it("stderr: 'inherit' passes the child's stderr through and captures nothing", () => {
    const r = runSync('bash', ['-c', 'echo out; exit 0'], { stderr: 'inherit' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('out\n');
    expect(r.stderr).toBe('');
  });
});

// run — the agent calls (launch.sh:521-524, 629-630): the prompt on stdin,
// `2>&1` or `2> file`, and `timeout -k 30 N` reproduced: SIGTERM to the whole
// process group at N seconds, SIGKILL 30 s later, the whole group so a fake's
// `sleep 999` cannot outlive the call and sit in the worktree.
describe('run', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-run-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns the status and, with stderr: merge, both streams in arrival order', async () => {
    const r = await run('bash', ['-c', 'echo a; sleep 0.1; echo b >&2; sleep 0.1; echo c; exit 3'], { cwd: dir, stderr: 'merge' });
    expect(r.status).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe('a\nb\nc\n');
  });

  it('with stderr: <fd> writes stderr there and keeps stdout apart (reviewer.stderr)', async () => {
    const file = join(dir, 'err.txt');
    const fd = openSync(file, 'w');
    let r;
    try {
      r = await run('bash', ['-c', 'echo out; echo notice >&2'], { cwd: dir, stderr: fd });
    } finally {
      closeSync(fd);
    }
    expect(r.stdout).toBe('out\n');
    expect(readFileSync(file, 'utf8')).toBe('notice\n');
  });

  it('a 200 KB prompt round-trips through stdin (L-18: no argv ceiling)', async () => {
    const big = 'x'.repeat(200_000) + '\n';
    const r = await run('cat', [], { cwd: dir, input: big, stderr: 'merge' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(big);
  });

  it('a child that exits without reading its stdin is a status, not an EPIPE throw', async () => {
    const r = await run('bash', ['-c', 'exit 5'], { cwd: dir, input: 'y'.repeat(200_000), stderr: 'merge' });
    expect(r.status).toBe(5);
  });

  it('resolves on close, so a grandchild that still holds stdout is read to the end', async () => {
    const r = await run('bash', ['-c', '(sleep 0.3; echo late) & echo early; exit 0'], { cwd: dir, stderr: 'merge' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('early\nlate\n');
  });

  it('a missing program is a status, not a throw', async () => {
    const r = await run('fleet-no-such-program-xyz', [], { cwd: dir, stderr: 'merge' });
    expect(r.status).not.toBe(0);
  });

  it('kills the whole process group at the timeout and says so (the fake hang, case 40)', async () => {
    const t0 = Date.now();
    const r = await run('bash', ['-c', 'sleep 30; echo never'], { cwd: dir, timeoutSec: 1, graceSec: 1, stderr: 'merge' });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe('');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(procsInWorktree(dir)).toEqual([]);           // the sleep died with its bash
  });

  it('a child that ignores SIGTERM is SIGKILLed after the grace, and still reported as a timeout', async () => {
    const t0 = Date.now();
    const r = await run('bash', ['-c', 'trap "" TERM; sleep 30; echo never'], { cwd: dir, timeoutSec: 1, graceSec: 1, stderr: 'merge' });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe('SIGKILL');
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(procsInWorktree(dir)).toEqual([]);
  });

  it('timeoutSec 0 means no timeout, as `timeout 0` did', async () => {
    const r = await run('bash', ['-c', 'sleep 0.2; echo done'], { cwd: dir, timeoutSec: 0, stderr: 'merge' });
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe('done\n');
  });
});

describe('runInherit', () => {
  it('the exit status, -1 when the program cannot start', () => {
    expect(runInherit('bash', ['-c', 'exit 0'])).toBe(0);
    expect(runInherit('bash', ['-c', 'exit 7'])).toBe(7);
    expect(runInherit('/nonexistent/prog', [])).toBe(-1);
  });

  it('cwd and env reach the child, as with the other run* calls', () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-proc-inherit-'));
    runInherit('bash', ['-c', 'pwd > out; echo "$FLEET_T_B" >> out'], {
      cwd: d,
      env: { PATH: process.env['PATH'] ?? '', FLEET_T_B: 'b' },
    });
    expect(readFileSync(join(d, 'out'), 'utf8')).toBe(`${d}\nb\n`);
    rmSync(d, { recursive: true, force: true });
  });
});

describe('runToFile', () => {
  it('an argv form of runBashTo: both streams to the log, the status back (merge.sh:167)', () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-proc-'));
    const log = join(d, 'x.log');
    writeFileSync(log, 'stale\n');
    expect(runToFile('bash', ['-c', 'echo out; echo err >&2; exit 3'], { logFile: log })).toBe(3);
    expect(readFileSync(log, 'utf8')).toBe('out\nerr\n');
    expect(runToFile('/nonexistent/prog', [], { logFile: log })).toBe(-1);
    rmSync(d, { recursive: true, force: true });
  });
});
