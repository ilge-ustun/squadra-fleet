import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { procsInWorktree } from './procs.ts';

// A child that sits in a subdirectory of the "worktree": the launcher's
// agents are found the same way, by cwd, because the path appears nowhere in
// their command lines (L-04).
let dir: string;
let child: ChildProcess;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-procs-'));
  const sub = join(dir, 'wt', 'deep');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(sub, { recursive: true });
  child = spawn('sleep', ['30'], { cwd: sub, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(() => {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe('procsInWorktree — by cwd', () => {
  it('finds a process whose cwd is under the worktree, by pid', () => {
    const pids = procsInWorktree(join(dir, 'wt'));
    expect(pids).toContain(String(child.pid));
  });

  it('finds a process whose cwd is the worktree itself', () => {
    expect(procsInWorktree(process.cwd())).toContain(String(process.pid));
  });

  it('does not match a sibling whose name merely starts the same', () => {
    // wt vs wt-other: "$cwd" == "$wt"/* needs the slash
    expect(procsInWorktree(join(dir, 'w'))).not.toContain(String(child.pid));
  });

  it('resolves symlinks as readlink -f does', () => {
    expect(procsInWorktree(realpathSync(join(dir, 'wt')))).toContain(String(child.pid));
  });

  it('a path that does not exist has nothing in it', () => {
    expect(procsInWorktree(join(dir, 'nope'))).toEqual([]);
  });
});
