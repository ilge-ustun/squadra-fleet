import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetEvent } from './events.ts';
import { runSync } from './proc.ts';
import { classifyStatus, epicsCreated, gitEvents, machineEvents, mtimeEvents, readySince, reviewRounds } from './history.ts';

// A throwaway target: one story whose status changes commit by commit, each
// commit at a time the test names.
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-history-'));
  runSync('git', ['init', '-q', '-b', 'base', root]);
  mkdirSync(join(root, '.stories'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function commitAt(msg: string, at: string): void {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  const r = runSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg], { cwd: root, env });
  if (r.status !== 0) throw new Error(r.stderr);
}
const rows = (ev: readonly FleetEvent[]): string[] => ev.map((e) => [e.event, e.pass, e.name ?? '-', e.result ?? '-', e.source].join(' '));

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

describe("classifyStatus — the fleet's own status commits, and nothing else", () => {
  it.each([
    ['draft', 'draft', undefined],
    ['draft — from the coordinator', 'draft', undefined],
    ['promoted to ready (telegram)', 'ready', 'telegram'],
    ['promoted to ready (coordinator, delegated by the human)', 'ready', 'coordinator, delegated by the human'],
    ['answered, back to ready (telegram)', 'ready', 'telegram'],
    ['wait for the reviewer, then review (telegram)', 'ready', 'telegram'],
    ['reviewed by Claude instead (telegram)', 'ready', 'telegram'],
    ['ready', 'ready', undefined],
    ['in_progress', 'in_progress', undefined],
    ['done', 'done', undefined],
    ['blocked', 'blocked', undefined],
    ['needs_human', 'needs_human', undefined],
    ['merged into epic/x at 1234abcd', 'merged', undefined],
    ['reset to draft', 'draft', undefined],
    ['merge into epic/x reverted', 'reverted', undefined],
  ])('%s → %s', (rest, status, by) => {
    expect(classifyStatus(rest)).toMatchObject({ status, ...(by !== undefined ? { by } : {}) });
  });
  it('a builder commit that names its story is not a status', () => {
    expect(classifyStatus('the search panel is a centered card')).toBeUndefined();
    expect(classifyStatus('done with the header')).toBeUndefined();
  });
});

describe('gitEvents — status marks, promotions, launches and merges from the commits', () => {
  it('reads every status commit, a launch from in_progress to its end, and the merge commits', () => {
    commitAt('story(007): draft', '2026-10-20T10:00:00+02:00');
    commitAt('story(007): promoted to ready (telegram)', '2026-10-20T10:05:00+02:00');
    commitAt('story(007): in_progress', '2026-10-20T10:20:00+02:00');
    commitAt('story(007): the button is round', '2026-10-20T10:30:00+02:00');
    commitAt('story(007): done', '2026-10-20T11:00:00+02:00');
    commitAt('merge(007): story/007 into epic/x', '2026-10-20T11:01:00+02:00');
    commitAt('story(007): merged into epic/x at 1234abcd', '2026-10-20T11:01:05+02:00');
    commitAt('merge(epic/x): epic/x into base', '2026-10-21T09:00:00+02:00');
    const ev = gitEvents(root, 'r');
    expect(rows(ev)).toEqual([
      'mark status draft - git',
      'mark status ready - git',
      'mark promote - READY git',
      'mark status in_progress - git',
      'start launch - - git',
      'mark status done - git',
      'end launch - PASS git',
      'mark merge - MERGED git',
      'mark status merged - git',
      'mark epic_merge - MERGED git',
    ]);
    expect(ev[2]).toMatchObject({ story: '007', by: 'telegram' });
    expect(ev[6]).toMatchObject({ dur_s: 2400, run_id: ev[4]?.run_id });
    expect(ev[7]).toMatchObject({ story: '007', epic: 'epic/x', into: 'epic/x' });
    expect(ev[9]).toMatchObject({ epic: 'epic/x', into: 'base' });
    expect(new Date(String(ev[0]?.ts)).toISOString()).toBe('2026-10-20T08:00:00.000Z');
  });

  it('a launch that comes back to ready ends DIED: its launcher was reaped', () => {
    commitAt('story(007): in_progress', '2026-10-20T10:20:00+02:00');
    commitAt('story(007): ready', '2026-10-20T12:00:00+02:00');
    expect(rows(gitEvents(root, 'r')).filter((r) => r.includes('launch'))).toEqual(['start launch - - git', 'end launch - DIED git']);
  });
});

describe('epicsCreated — when fleet new-epic pushed each epic, from the reflog', () => {
  it('reads the first line of origin/epic/<name>\'s reflog', () => {
    commitAt('one', '2026-10-20T10:00:00+02:00');
    const sha = runSync('git', ['-C', root, 'rev-parse', 'HEAD']).stdout.trim();
    runSync('git', ['-C', root, 'update-ref', 'refs/remotes/origin/epic/x', sha]);
    mkdirSync(join(root, '.git/logs/refs/remotes/origin/epic'), { recursive: true });
    writeFileSync(join(root, '.git/logs/refs/remotes/origin/epic/x'), `${'0'.repeat(40)} ${sha} t <t@t> 1760947200 +0200\tfetch: storing head\n`);
    const ev = epicsCreated(root, 'r');
    expect(rows(ev)).toEqual(['mark epic created CREATED git']);
    expect(ev[0]).toMatchObject({ epic: 'epic/x', sha: sha.slice(0, 8) });
    expect(new Date(String(ev[0]?.ts)).getTime()).toBe(1760947200_000);
  });
});

const REVIEW = `# Review: 135

verdict: PASS
rounds: 2 of 2

## Round 1 — FAIL

head: 1111111111111111111111111111111111111111
commits this round: 2
reviewed: 2026-10-22T01:00:00+02:00

### Machine

baseline: test GREEN | build GREEN | lint GREEN
timing:   builder 600s | baseline 200s | reviewer 100s | mutations 50s | total 1000s
builder:  opus → claude-opus-5-5
reviewer: codex → gpt-6.1-sol
computed: FAIL — mutation AC1-x survived (GREEN); 

## Round 2 — PASS

head: 2222222222222222222222222222222222222222
commits this round: 1
reviewed: 2026-10-22T02:47:38+02:00

### Machine

baseline: test GREEN | build RED | lint GREEN
timing:   builder 963s | baseline 232s | reviewer 67s | mutations 255s | total 1554s
builder:  opus
reviewer: claude opus (fallback) → claude-opus-5-5
computed: PASS
`;

describe('reviewRounds — each round of a review file', () => {
  it('reads the number, verdict, head, reviewed time, timing, models and reasons', () => {
    const r = reviewRounds(REVIEW);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({
      n: 1, computed: 'FAIL', head: '11111111', reasons: 'mutation AC1-x survived (GREEN)',
      timing: { builder: 600, baseline: 200, reviewer: 100, mutations: 50, total: 1000 },
      builderModel: 'opus', builderUsed: 'claude-opus-5-5', reviewerCli: 'codex', reviewerUsed: 'gpt-6.1-sol',
    });
    expect(r[0]?.reviewed.toISOString()).toBe('2026-10-21T23:00:00.000Z');
    expect(r[1]).toMatchObject({ n: 2, computed: 'PASS', reviewerCli: 'claude', reviewerModel: 'opus', baseline: 'test GREEN | build RED | lint GREEN' });
  });
});

describe("machineEvents — a round's phases placed by its Machine block", () => {
  it('ends the round at reviewed, starts it total seconds before, and places each phase in order', () => {
    const ev = machineEvents({ repo: 'k', story: '135', epic: 'epic/e', rounds: reviewRounds(REVIEW).slice(0, 1) });
    expect(rows(ev)).toEqual([
      'start round - - machine', 'start builder build - machine', 'end builder build - machine',
      'start baseline all - machine', 'end baseline all GREEN machine',
      'start reviewer - - machine', 'end reviewer - - machine',
      'start mutation all - machine', 'end mutation all - machine',
      'mark verdict - FAIL machine', 'end round - FAIL machine',
    ]);
    const t = (i: number): string => new Date(String(ev[i]?.ts)).toISOString().slice(11, 19);
    expect([t(0), t(2), t(4), t(5), t(7), t(10)]).toEqual(['22:43:20', '22:53:20', '22:56:40', '22:57:30', '22:59:10', '23:00:00']);
    expect(ev[2]).toMatchObject({ model: 'opus', model_used: 'claude-opus-5-5', approx: true });
    expect(ev[9]).toMatchObject({ reason: 'mutation AC1-x survived (GREEN)', story: '135', epic: 'epic/e', round: 1 });
  });
});

describe('mtimeEvents — baseline steps and mutations ended when their files were written', () => {
  it('ends each step at its log\'s time, inside the round, and skips a time outside it', () => {
    const dir = join(root, '.review/135/round-1');
    mkdirSync(join(dir, 'baseline'), { recursive: true });
    mkdirSync(join(dir, 'mutations'), { recursive: true });
    const reviewed = Date.parse('2026-10-22T01:00:00+02:00') / 1000;
    const file = (p: string, at: number, text = 'x\n'): void => { writeFileSync(join(dir, p), text); utimesSync(join(dir, p), at, at); };
    file('baseline/test.log', reviewed - 300);
    file('baseline/build.log', reviewed - 250);
    file('baseline/lint.log', reviewed - 9999);
    file('mutations/AC1-x.result', reviewed - 20, 'RED\n');
    const ev = mtimeEvents({ root, repo: 'k', story: '135', rounds: reviewRounds(REVIEW).slice(0, 1) });
    expect(rows(ev)).toEqual([
      'start baseline test - machine', 'end baseline test - mtime',
      'start baseline build - mtime', 'end baseline build - mtime',
      'start mutation AC1-x - machine', 'end mutation AC1-x RED mtime',
    ]);
  });
});
