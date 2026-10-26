import { describe, expect, it } from 'vitest';
import type { FleetEvent } from './lib/events.ts';
import { combine, parseArgs, selectEvents } from './events.ts';

const e = (ts: string, f: Partial<FleetEvent> & { pass: string; event: FleetEvent['event']; source: FleetEvent['source'] }): FleetEvent =>
  ({ v: 1, ts: `2026-10-20T${ts}.000+02:00`, run_id: `r.${f.story ?? 'x'}.${f.source}`, repo: 'r', ...f }) as FleetEvent;
const rows = (ev: readonly FleetEvent[]): string[] => ev.map((x) => `${x.ts.slice(11, 19)} ${x.event} ${x.pass} ${x.source}`);

describe('parseArgs', () => {
  it('takes a story or an epic, --backfill and --journal, in any order', () => {
    expect(parseArgs([])).toEqual({ filter: undefined, backfill: false, journal: false });
    expect(parseArgs(['135', '--backfill'])).toEqual({ filter: '135', backfill: true, journal: false });
    expect(parseArgs(['--journal', 'epic/x'])).toEqual({ filter: 'epic/x', backfill: true, journal: true });
    expect(() => parseArgs(['--bogus'])).toThrow(/usage/);
    expect(() => parseArgs(['1', '2'])).toThrow(/usage/);
  });
});

describe('combine — the log first, then what the past adds that the log does not have', () => {
  it('drops a backfilled launch the log has, whole, and keeps the status marks and an older launch', () => {
    const log = [
      e('10:00:00', { story: '7', pass: 'launch', event: 'start', span: 'launch', source: 'log', run_id: 'L' }),
      e('10:30:00', { story: '7', pass: 'launch', event: 'end', span: 'launch', source: 'log', run_id: 'L' }),
    ];
    const past = [
      e('08:00:00', { story: '7', pass: 'launch', event: 'start', span: 'launch', source: 'journal', run_id: 'J1' }),
      e('08:20:00', { story: '7', pass: 'round', event: 'end', span: 'r1', source: 'journal', run_id: 'J1' }),
      e('10:00:01', { story: '7', pass: 'launch', event: 'start', span: 'launch', source: 'journal', run_id: 'J2' }),
      e('10:10:00', { story: '7', pass: 'builder', event: 'end', span: 'r1.build', source: 'journal', run_id: 'J2' }),
      e('09:59:58', { story: '7', pass: 'status', event: 'mark', name: 'in_progress', source: 'git' }),
    ];
    expect(rows(combine(log, past))).toEqual([
      '08:00:00 start launch journal', '08:20:00 end round journal', '09:59:58 mark status git', '10:00:00 start launch log', '10:30:00 end launch log',
    ]);
  });

  it('drops a git launch the journal has, and a Machine round the journal or the log has', () => {
    const past = [
      e('08:00:00', { story: '7', pass: 'launch', event: 'start', span: 'launch', source: 'git', run_id: 'G' }),
      e('08:30:00', { story: '7', pass: 'launch', event: 'end', span: 'launch', source: 'git', run_id: 'G' }),
      e('08:00:02', { story: '7', pass: 'launch', event: 'start', span: 'launch', source: 'journal', run_id: 'J' }),
      e('08:29:00', { story: '7', pass: 'verdict', event: 'mark', round: 1, source: 'journal', run_id: 'J' }),
      e('08:10:00', { story: '7', pass: 'round', event: 'start', span: 'r1', round: 1, source: 'machine', run_id: 'M1' }),
      e('08:28:58', { story: '7', pass: 'verdict', event: 'mark', round: 1, source: 'machine', run_id: 'M1' }),
      e('06:00:00', { story: '7', pass: 'verdict', event: 'mark', round: 1, source: 'machine', run_id: 'M0' }),
    ];
    expect(rows(combine([], past))).toEqual(['06:00:00 mark verdict machine', '08:00:02 start launch journal', '08:29:00 mark verdict journal']);
  });

  it('drops a promote or a merge git saw when the log has it, and keeps one the log has not', () => {
    const log = [
      e('10:00:00', { story: '7', pass: 'promote', event: 'mark', source: 'log' }),
      e('11:00:00', { story: '7', pass: 'merge', event: 'end', span: 'merge', result: 'MERGED', sha: 'abcd1234', source: 'log', run_id: 'L' }),
    ];
    const past = [
      e('10:00:01', { story: '7', pass: 'promote', event: 'mark', source: 'git' }),
      e('12:00:00', { story: '7', pass: 'promote', event: 'mark', source: 'git' }),
      e('11:00:00', { story: '7', pass: 'merge', event: 'mark', result: 'MERGED', sha: 'abcd1234', source: 'git' }),
    ];
    expect(rows(combine(log, past))).toEqual(['10:00:00 mark promote log', '11:00:00 end merge log', '12:00:00 mark promote git']);
  });
});

describe('selectEvents', () => {
  it('keeps a story\'s events, or an epic\'s and its stories\'', () => {
    const ev = [
      e('01:00:00', { story: '7', epic: 'epic/x', pass: 'launch', event: 'start', source: 'log' }),
      e('02:00:00', { story: '8', pass: 'launch', event: 'start', source: 'log' }),
      e('03:00:00', { epic: 'epic/x', pass: 'epic_merge', event: 'mark', source: 'git' }),
    ];
    expect(selectEvents(ev, '7').map((x) => x.ts.slice(11, 13))).toEqual(['01']);
    expect(selectEvents(ev, 'epic/x').map((x) => x.ts.slice(11, 13))).toEqual(['01', '03']);
    expect(selectEvents(ev, undefined)).toHaveLength(3);
  });
});
