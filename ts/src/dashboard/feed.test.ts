import { describe, expect, it } from 'vitest';
import type { FleetEvent } from '../lib/events.ts';
import { FEED_LIMIT, FEED_MAX, feedAt, type FeedItem } from './feed.ts';

const T = (hms: string): string => `2026-10-22T${hms}.000+02:00`;
let n = 0;
const ev = (ts: string, f: Partial<FleetEvent> & { pass: string; event: FleetEvent['event'] }): FleetEvent => ({ v: 1, ts, run_id: 'k.135.L1', repo: 'khaita', story: '135', source: 'log', n: n++, ...f } as FleetEvent);

const epicOnly = (e: FleetEvent): FleetEvent => { delete e.story; return e; };

const KHAITA: FleetEvent[] = [
  ev(T('10:01:00'), { pass: 'status', event: 'mark', run_id: 'k.135.git', source: 'git', name: 'ready', reason: 'promoted to ready (coordinator)', sha: 'aaaa1111' }),
  ev(T('10:01:00'), { pass: 'promote', event: 'mark', run_id: 'k.135.git', source: 'git', by: 'coordinator', result: 'READY', sha: 'aaaa1111' }),
  ev(T('10:59:58'), { pass: 'queue', event: 'mark', run_id: 'k.drain.D', story: '135', name: 'pickup', wait_s: 3538 }),
  ev(T('11:00:00'), { pass: 'launch', event: 'start', span: 'launch', pid: 4242, model: 'opus' }),
  ev(T('11:00:41'), { pass: 'round', event: 'start', span: 'r1', round: 1 }),
  ev(T('11:00:41'), { pass: 'builder', event: 'start', span: 'r1.build', round: 1, name: 'build', agent: 'claude', model: 'opus' }),
  ev(T('11:16:44'), { pass: 'builder', event: 'end', span: 'r1.build', round: 1, name: 'build', agent: 'claude', result: 'OK', dur_s: 963, commits: 3, head: 'a2e1d5ed', turns: 56, cost_usd: 2.97 }),
  ev(T('11:17:20'), { pass: 'baseline', event: 'start', span: 'r1.baseline.1', round: 1, name: 'all', head: 'a2e1d5ed' }),
  ev(T('11:17:20'), { pass: 'baseline', event: 'start', span: 'r1.baseline.1.test', round: 1, name: 'test' }),
  ev(T('11:18:00'), { pass: 'baseline', event: 'end', span: 'r1.baseline.1.test', round: 1, name: 'test', result: 'GREEN', dur_s: 40 }),
  ev(T('11:21:00'), { pass: 'baseline', event: 'end', span: 'r1.baseline.1', round: 1, name: 'all', result: 'GREEN', dur_s: 220 }),
  ev(T('11:21:01'), { pass: 'tdd', event: 'start', span: 'r1.tdd.1', round: 1, name: 'check', check: 1 }),
  ev(T('11:23:40'), { pass: 'tdd', event: 'end', span: 'r1.tdd.1', round: 1, name: 'check', result: 'RED', dur_s: 159 }),
  ev(T('11:23:41'), { pass: 'scope', event: 'mark', round: 1, result: 'CLEAN' }),
  ev(T('11:23:41'), { pass: 'reviewer', event: 'start', span: 'r1.reviewer', round: 1, agent: 'codex', model: 'gpt-6' }),
  ev(T('11:24:48'), { pass: 'reviewer', event: 'end', span: 'r1.reviewer', round: 1, agent: 'codex', result: 'OK', dur_s: 67 }),
  ev(T('11:24:49'), { pass: 'mutation', event: 'start', span: 'r1.mut.AC1-remove', round: 1, name: 'AC1-remove' }),
  ev(T('11:25:30'), { pass: 'mutation', event: 'end', span: 'r1.mut.AC1-remove', round: 1, name: 'AC1-remove', result: 'RED', dur_s: 41 }),
  ev(T('11:29:59'), { pass: 'verdict', event: 'mark', round: 1, result: 'PASS', reviewer: 'PASS' }),
  ev(T('11:30:00'), { pass: 'round', event: 'end', span: 'r1', round: 1, result: 'PASS', dur_s: 1759 }),
  ev(T('11:30:01'), { pass: 'launch', event: 'end', span: 'launch', result: 'PASS', dur_s: 1801 }),
  ev(T('11:31:00'), { pass: 'merge', event: 'start', span: 'merge', run_id: 'k.135.M', into: 'epic/cards', pid: 5151 }),
  ev(T('11:31:20'), { pass: 'merge', event: 'end', span: 'merge', run_id: 'k.135.M', into: 'epic/cards', result: 'MERGED', dur_s: 20 }),
  epicOnly(ev(T('15:00:00'), { pass: 'epic_merge', event: 'mark', run_id: 'k.epic-cards.git', epic: 'epic/cards', source: 'git', result: 'MERGED', branch: 'epic/cards', into: 'develop' })),
];
const QR: FleetEvent[] = [
  ev(T('11:10:00'), { pass: 'launch', event: 'start', span: 'launch', run_id: 'q.020.L1', repo: 'qr', story: '020', pid: 777 }),
  ev(T('11:10:30'), { pass: 'builder', event: 'start', span: 'r1.build', run_id: 'q.020.L1', repo: 'qr', story: '020', round: 1, agent: 'claude' }),
];
const EVENTS = { khaita: KHAITA, qr: QR };
const brief = (x: FeedItem): string => `${x.ts.slice(11, 19)} ${x.repo}/${x.story ?? x.epic ?? '-'} ${x.pass} ${x.state}${x.result !== undefined ? ` ${x.result}` : ''}`;

describe('feedAt', () => {
  it('every repo, newest first: a pass by its end, a mark as it is, and no step of a round', () => {
    const f = feedAt({ events: EVENTS, alive: new Set([777]), limit: 50, steps: false });
    expect(f.items.map(brief)).toEqual([
      '15:00:00 khaita/epic/cards epic_merge mark MERGED',
      '11:31:20 khaita/135 merge ended MERGED',
      '11:30:01 khaita/135 launch ended PASS',
      '11:30:00 khaita/135 round ended PASS',
      '11:29:59 khaita/135 verdict mark PASS',
      '11:24:48 khaita/135 reviewer ended OK',
      '11:21:00 khaita/135 baseline ended GREEN',
      '11:16:44 khaita/135 builder ended OK',
      '11:10:30 qr/020 builder running',
      '11:10:00 qr/020 launch running',
      '10:59:58 khaita/135 queue mark',
      '10:01:00 khaita/135 promote mark READY',
    ]);
    expect(f.more).toBe(false);
  });

  it('the steps of a round on request: baseline steps, tdd, scope, mutations', () => {
    const f = feedAt({ events: EVENTS, alive: new Set(), limit: 50, steps: true });
    const passes = f.items.map((x) => `${x.pass}${x.name !== undefined ? `:${x.name}` : ''}`);
    expect(passes).toEqual(expect.arrayContaining(['mutation:AC1-remove', 'scope', 'tdd:check', 'baseline:test', 'baseline:all']));
    expect(f.items.find((x) => x.pass === 'mutation')?.step).toBe(true);
    expect(f.items.find((x) => x.pass === 'builder')?.step).toBe(false);
  });

  it('at a moment: nothing after it, and a pass that ends later runs then', () => {
    const f = feedAt({ events: EVENTS, at: T('11:20:00'), alive: new Set(), limit: 50, steps: false });
    expect(f.items.map(brief).slice(0, 5)).toEqual([
      '11:17:20 khaita/135 baseline running',
      '11:16:44 khaita/135 builder ended OK',
      '11:10:30 qr/020 builder no end',
      '11:10:00 qr/020 launch no end',
      '11:00:41 khaita/135 round running',
    ]);
    expect(f.items.some((x) => Date.parse(x.ts) > Date.parse(T('11:20:00')))).toBe(false);
  });

  it('a start with no end runs while its pid lives, and has no end once it is gone', () => {
    expect(feedAt({ events: { qr: QR }, alive: new Set([777]), limit: 5, steps: false }).items.map((x) => x.state)).toEqual(['running', 'running']);
    expect(feedAt({ events: { qr: QR }, alive: new Set(), limit: 5, steps: false }).items.map((x) => x.state)).toEqual(['no end', 'no end']);
  });

  it("says what each was, in the page's words", () => {
    const f = feedAt({ events: EVENTS, alive: new Set(), limit: 50, steps: false });
    const of = (pass: string): FeedItem | undefined => f.items.find((x) => x.pass === pass);
    expect(of('builder')).toMatchObject({ title: 'Builder', why: '3 commit(s), head a2e1d5ed · 56 turns · $2.97', dur_s: 963, round: 1, src: 'log' });
    expect(of('round')?.title).toBe('Round 1');
    expect(of('launch')?.title).toBe('Launch');
    expect(of('queue')).toMatchObject({ title: 'Picked up by the queue', why: 'waited 59 min since ready' });
    expect(of('promote')).toMatchObject({ title: 'Promoted to ready', why: 'by coordinator', src: 'git' });
    expect(of('epic_merge')).toMatchObject({ title: 'Land on develop', epic: 'epic/cards' });
    expect(of('verdict')).toMatchObject({ title: 'computed PASS', ic: 'check', tone: 'good' });
    expect(of('verdict')?.why).toBeUndefined();
    const fail = feedAt({ events: { k: [ev(T('09:00:00'), { pass: 'verdict', event: 'mark', result: 'FAIL', reason: 'AC2 mutation survived', reviewer: 'PASS' })] }, alive: new Set(), limit: 5, steps: false });
    expect(fail.items[0]).toMatchObject({ title: 'computed FAIL', why: 'AC2 mutation survived · the reviewer said PASS', tone: 'crit' });
    expect(of('merge')?.title).toBe('Merge into epic/cards');
  });

  it('a status mark shows once: not when a promotion says it again, nor when a launch or a merge stands for it', () => {
    const f = feedAt({ events: EVENTS, alive: new Set(), limit: 50, steps: false });
    expect(f.items.filter((x) => x.ts === T('10:01:00')).map((x) => x.pass)).toEqual(['promote']);
    const status = (name: string, sha: string): FleetEvent => ev(T('09:00:00'), { pass: 'status', event: 'mark', source: 'git', name, reason: name === 'draft' ? 'drafted by the writer' : name, sha });
    const alone = feedAt({ events: { khaita: ['draft', 'in_progress', 'done', 'merged'].map((s, i) => status(s, `b${i}`)) }, alive: new Set(), limit: 5, steps: false });
    expect(alone.items).toEqual([expect.objectContaining({ pass: 'status', name: 'draft', title: 'draft', why: 'drafted by the writer', state: 'mark' })]);
  });

  it('keeps the newest up to the limit, and says there is more', () => {
    const f = feedAt({ events: EVENTS, alive: new Set(), limit: 3, steps: false });
    expect(f.items.map((x) => x.pass)).toEqual(['epic_merge', 'merge', 'launch']);
    expect(f.more).toBe(true);
    expect(FEED_LIMIT).toBeLessThan(FEED_MAX);
  });
});
