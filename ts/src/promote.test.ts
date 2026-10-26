import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoConfig } from './lib/config.ts';
import { EVENTS_FILE, readEvents } from './lib/events.ts';
import { runSync } from './lib/proc.ts';
import { QUEUE_START_DEFAULT, launcherHas, promote, queueStartArgv, storyOk } from './promote.ts';

// A target with no origin: pushQuiet fails quietly, as the bot's does.
let root: string;
const git = (...args: string[]): string => runSync('git', ['-C', root, ...args]).stdout.trim();
const cfg = (): RepoConfig => ({ name: 't', root } as RepoConfig);
function story(status: string, extra = ''): void {
  writeFileSync(join(root, '.stories', '900.md'), `---\nstatus: ${status}\nround: 0\n${extra}---\n\n# Story 900: t\n`);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-promote-'));
  mkdirSync(join(root, '.stories'));
  writeFileSync(join(root, '.gitignore'), '.runs/\n');
  story('draft', 'base: epic/x\n');
  runSync('git', ['init', '-q', '-b', 'base', root]);
  git('config', 'user.name', 't'); git('config', 'user.email', 't@t');
  git('add', '.'); git('commit', '-qm', 'fixture');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('queueStartArgv', () => {
  it('splits the command and names the repo where {repo} stands', () => {
    expect(queueStartArgv(QUEUE_START_DEFAULT, 'khaita')).toEqual(['systemctl', '--user', 'start', '--no-block', 'fleet-queue@khaita.service']);
    expect(queueStartArgv('true', 'k')).toEqual(['true']);
  });
});

describe('storyOk and launcherHas', () => {
  it('a three-digit id whose file exists; in_progress is the launcher\'s', () => {
    expect(storyOk(root, '900')).toBe(true);
    expect(storyOk(root, '901')).toBe(false);
    expect(storyOk(root, '../900')).toBe(false);
    expect(launcherHas(root, '900')).toBeUndefined();
    story('in_progress');
    expect(launcherHas(root, '900')).toMatch(/^900 is in_progress — a launcher has it/);
  });
});

describe('promote', () => {
  it('sets ready, commits with who did it, starts the drain, and writes a promote mark', () => {
    let started = 0;
    const r = promote(cfg(), '900', { by: 'fleet promote', startQueue: () => { started += 1; return true; } });
    expect(r).toEqual({ promoted: true, reply: '900 is ready — a drain is starting, or the one running takes it next' });
    expect(readFileSync(join(root, '.stories', '900.md'), 'utf8')).toContain('\nstatus: ready\n');
    expect(git('log', '-1', '--format=%s')).toBe('story(900): promoted to ready (fleet promote)');
    expect(git('status', '--porcelain')).toBe('');
    expect(started).toBe(1);
    expect(readEvents(readFileSync(join(root, EVENTS_FILE), 'utf8'))).toMatchObject([
      { pass: 'promote', event: 'mark', story: '900', epic: 'epic/x', by: 'fleet promote', from: 'draft', result: 'READY', queue: 'started' },
    ]);
  });

  it('a drain that cannot start still promotes, and says the next one takes it', () => {
    expect(promote(cfg(), '900', { by: 'x', startQueue: () => false }).reply).toBe('900 is ready — could not start a drain now; the next one picks it up');
  });

  it('changes nothing for a story already ready, one a launcher has, or one that does not exist', () => {
    const none = (): boolean => { throw new Error('no drain may start'); };
    expect(promote(cfg(), '901', { by: 'x', startQueue: none })).toEqual({ promoted: false, reply: 'no such story: 901' });
    story('ready', 'base: epic/x\n');
    git('commit', '-qam', 'ready');
    expect(promote(cfg(), '900', { by: 'x', startQueue: none })).toEqual({ promoted: false, reply: '900 was already ready' });
    story('in_progress');
    expect(promote(cfg(), '900', { by: 'x', startQueue: none }).promoted).toBe(false);
    expect(existsSync(join(root, EVENTS_FILE))).toBe(false);
  });
});
