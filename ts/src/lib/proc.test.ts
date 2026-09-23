import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBashTo, runSync } from './proc.ts';

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
