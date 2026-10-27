import { describe, expect, it } from 'vitest';
import type { FleetEvent } from '../lib/events.ts';
import type { CatalogRepo, CatalogStory, HistoryEntry } from './catalog.ts';
import { momentAt, stateAt, type NowInfo } from './moment.ts';

const T = (hm: string, day = '22'): string => `2026-10-${day}T${hm}:00.000+02:00`;
const h = (ts: string, kind: string): HistoryEntry => ({ ts, kind, msg: kind, src: 'git' });
const story = (id: string, o: Partial<CatalogStory> = {}): CatalogStory => ({
  id, title: `story ${id}`, status: 'done', landing: 'landed', verdict: 'PASS', reasons: [], base: 'epic/cards', epic: 'epic/cards', round: 1, model: null,
  live: false, blocked: false, acs: [], symptom: '', question: null, intent: null, history: [], rounds: [], readyAt: null, pickedAt: null, queueWaitS: null,
  draftAt: null, doneAt: null, mergedAt: null, landedAt: null, landedHow: null, ...o,
});
const ev = (ts: string, f: Partial<FleetEvent> & { pass: string; event: FleetEvent['event'] }): FleetEvent => ({ v: 1, ts, run_id: 'run1', repo: 'k', source: 'log', ...f });
const NOW: NowInfo = { units: {}, locks: {}, testDeploy: null, alive: [] };

describe('stateAt', () => {
  const s = story('135', { history: [h(T('10:00'), 'draft'), h(T('10:01'), 'promoted'), h(T('11:00'), 'in_progress'), h(T('12:00'), 'done'), h(T('12:01'), 'merged')] });
  const lands = [{ ts: T('15:00') }];
  it('replays the history, and a merge on the epic until the epic lands', () => {
    expect(stateAt(s, lands, Date.parse(T('09:00')))).toBeNull();
    expect(stateAt(s, lands, Date.parse(T('10:30')))).toEqual({ state: 'ready', since: T('10:01') });
    expect(stateAt(s, lands, Date.parse(T('11:30')))).toEqual({ state: 'in_progress', since: T('11:00') });
    expect(stateAt(s, lands, Date.parse(T('13:00')))).toEqual({ state: 'on epic', since: T('12:01') });
    expect(stateAt(s, lands, Date.parse(T('16:00')))).toEqual({ state: 'landed', since: T('15:00') });
  });
  it('a story with no epic lands at its merge', () => {
    const x = story('010', { epic: null, base: 'develop', history: [h(T('10:00'), 'done'), h(T('10:05'), 'merged')] });
    expect(stateAt(x, [], Date.parse(T('11:00')))).toEqual({ state: 'landed', since: T('10:05') });
  });
});

describe('momentAt', () => {
  const repo = (stories: CatalogStory[]): CatalogRepo => ({ name: 'k', baseBranch: 'develop', stories, epics: [] });
  const running = story('140', { status: 'in_progress', landing: 'in_progress', history: [h(T('10:00'), 'ready'), h(T('11:00'), 'in_progress')] });
  const launch = [
    ev(T('11:00'), { pass: 'launch', event: 'start', span: 'launch', story: '140', pid: 4242 }),
    ev(T('11:01'), { pass: 'round', event: 'start', span: 'r1', story: '140', round: 1 }),
    ev(T('11:01'), { pass: 'builder', event: 'start', span: 'r1.build', story: '140', round: 1, name: 'build', agent: 'claude', model: 'opus' }),
    ev(T('11:20'), { pass: 'builder', event: 'end', span: 'r1.build', story: '140', round: 1, name: 'build', result: 'OK' }),
    ev(T('11:20'), { pass: 'baseline', event: 'start', span: 'r1.baseline.1', story: '140', round: 1, name: 'all' }),
  ];

  it('now: the story\'s landing, and the pass that runs, by a pid that is alive', () => {
    const m = momentAt({ repos: [repo([running])], events: { k: launch }, now: { ...NOW, alive: [4242] }, generatedAt: T('11:30') });
    expect(m.now).toBe(true);
    expect(m.repos['k']?.states['140']).toEqual({ state: 'in_progress', since: T('11:00') });
    expect(m.repos['k']?.running['140']).toEqual({ pid: 4242, round: 1, pass: 'baseline', name: 'all', since: T('11:20'), launchSince: T('11:00'), src: 'log' });
  });

  it('now: an open launch whose pid is gone is a dead launcher', () => {
    const m = momentAt({ repos: [repo([running])], events: { k: launch }, now: NOW, generatedAt: T('11:30') });
    expect(m.repos['k']?.running['140']?.dead).toEqual({ ts: null, src: 'log', why: 'pid 4242 is gone, and its launch wrote no end' });
  });

  it('a past moment: what ran then, and nothing is known of the unit or the lock', () => {
    const m = momentAt({ repos: [repo([running])], events: { k: launch }, now: NOW, generatedAt: T('18:00'), at: T('11:10') });
    expect(m.now).toBe(false);
    expect(m.repos['k']?.running['140']).toMatchObject({ pass: 'builder', name: 'build', agent: 'claude', model: 'opus', since: T('11:01') });
    expect(m.repos['k']?.running['140']?.dead).toBeUndefined();
    expect(m.repos['k']?.unit).toEqual({ known: false, active: false, since: null, next: null, src: 'unknown' });
    expect(m.repos['k']?.lock).toEqual({ known: true, held: true, pid: 4242, what: 'launch 140' });
  });

  it('a launch the unit killed stays dead until the story moves on, in the pass it died in', () => {
    // The journal ends every span the unit's death left open, at its time.
    const why = 'Main process exited, code=killed, status=9/KILL';
    const killed = [...launch, ...['r1.baseline.1', 'r1', 'launch'].map((span) => ev(T('11:25'), { pass: span === 'launch' ? 'launch' : span === 'r1' ? 'round' : 'baseline', event: 'end', span, story: '140', result: 'KILLED', reason: why, source: 'journal' }))];
    const m = momentAt({ repos: [repo([running])], events: { k: killed }, now: NOW, generatedAt: T('18:00'), at: T('12:00') });
    expect(m.repos['k']?.running['140']).toMatchObject({ round: 1, pass: 'baseline', name: 'all', since: T('11:20'), dead: { ts: T('11:25'), src: 'journal', why } });
  });

  it('why a story stopped: its verdict, a timeout, a question', () => {
    const nh = story('150', { status: 'needs_human', landing: 'needs_human', history: [h(T('11:00'), 'in_progress'), h(T('12:00'), 'needs_human')] });
    const evs = [
      ev(T('11:00'), { pass: 'launch', event: 'start', span: 'launch', story: '150', run_id: 'run2', pid: 1 }),
      ev(T('11:59'), { pass: 'builder', event: 'end', span: 'r1.build', story: '150', run_id: 'run2', result: 'TIMEOUT', reason: 'killed at AGENT_TIMEOUT (3600s)' }),
      ev(T('12:00'), { pass: 'launch', event: 'end', span: 'launch', story: '150', run_id: 'run2', result: 'NEEDS_HUMAN' }),
    ];
    const m = momentAt({ repos: [repo([nh])], events: { k: evs }, now: NOW, generatedAt: T('13:00') });
    expect(m.repos['k']?.stops['150']).toEqual({ ts: T('11:59'), msg: 'builder TIMEOUT — killed at AGENT_TIMEOUT (3600s)', src: 'log' });
  });

  it('the unit, the lock and the test deploy now, from systemd and the fleet\'s files', () => {
    const now: NowInfo = {
      units: { k: { state: 'activating', lastStart: T('11:29'), lastEnd: T('11:14'), next: T('11:44') } },
      locks: { k: { pid: 4242, what: 'launch 140', held: true } },
      testDeploy: { repo: 'k', branch: 'develop', sha: 'e4f074f1', since: T('09:00'), active: true },
      alive: [4242],
    };
    const m = momentAt({ repos: [repo([running])], events: { k: launch }, now, generatedAt: T('11:30') });
    expect(m.repos['k']?.unit).toEqual({ known: true, active: true, since: T('11:29'), next: T('11:44'), src: 'systemd' });
    expect(m.repos['k']?.lock).toEqual({ known: true, held: true, pid: 4242, what: 'launch 140' });
    expect(m.repos['k']?.testDeploy).toEqual({ known: true, branch: 'develop', sha: 'e4f074f1', since: T('09:00'), active: true, src: '.test-deploy.json' });
  });

  it('a repo with no story yet at the moment is not registered then', () => {
    const m = momentAt({ repos: [repo([running])], events: { k: launch }, now: NOW, generatedAt: T('18:00'), at: T('09:00') });
    expect(m.repos['k']?.registered).toBe(false);
  });
});
