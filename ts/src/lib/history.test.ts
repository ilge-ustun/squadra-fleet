import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from './proc.ts';
import { readySince } from './history.ts';

// A throwaway target: one story whose status changes commit by commit, each
// commit at a time the test names.
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-history-'));
  runSync('git', ['init', '-q', '-b', 'base', root]);
  mkdirSync(join(root, '.stories'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function story(status: string, at: string, body = 'x'): void {
  writeFileSync(join(root, '.stories', '007.md'), `---\nstatus: ${status}\nround: 0\n---\n\n# Story 007: t\n\n${body}\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  runSync('git', ['add', '-A'], { cwd: root, env });
  const r = runSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', `story(007): ${status}`], { cwd: root, env });
  if (r.status !== 0) throw new Error(r.stderr);
}

describe('readySince — when the story became ready, from the commits that touched it', () => {
  it('is the first commit of the run of ready commits that ends at HEAD, an edit while ready included', () => {
    story('draft', '2026-10-20T10:00:00+02:00');
    story('ready', '2026-10-20T11:00:00+02:00');
    story('ready', '2026-10-20T11:30:00+02:00', 'an edit while it waits');
    expect(readySince(root, '007')?.toISOString()).toBe('2026-10-20T09:00:00.000Z');
  });

  it('starts again at the last time it came back to ready', () => {
    story('ready', '2026-10-20T11:00:00+02:00');
    story('in_progress', '2026-10-20T11:05:00+02:00');
    story('ready', '2026-10-20T12:00:00+02:00');
    expect(readySince(root, '007')?.toISOString()).toBe('2026-10-20T10:00:00.000Z');
  });

  it('is undefined when the committed story is not ready, or has no commit, or the root is no repository', () => {
    story('ready', '2026-10-20T11:00:00+02:00');
    story('in_progress', '2026-10-20T11:05:00+02:00');
    expect(readySince(root, '007')).toBeUndefined();
    expect(readySince(root, '999')).toBeUndefined();
    expect(readySince(join(root, 'nowhere'), '007')).toBeUndefined();
  });
});
