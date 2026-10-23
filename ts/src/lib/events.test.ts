import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENTS_FILE, LINE_MAX, formatIsoMs, openEventLog, readEvents, runStamp, type FleetEvent } from './events.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-events-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A clock the test moves by hand. */
function clock(start = '2026-10-23T10:00:00.000Z'): { now: () => Date; tick: (ms: number) => void } {
  let t = Date.parse(start);
  return { now: () => new Date(t), tick: (ms) => { t += ms; } };
}
const lines = (): FleetEvent[] => readEvents(readFileSync(join(root, EVENTS_FILE), 'utf8'));

describe('formatIsoMs and runStamp', () => {
  it('is local time with milliseconds and the offset', () => {
    expect(formatIsoMs(new Date(2026, 9, 23, 14, 5, 6, 7))).toMatch(/^2026-10-23T14:05:06\.007[+-]\d\d:\d\d$/);
  });
  it('names a run by its local start to the second', () => {
    expect(runStamp(new Date(2026, 9, 3, 4, 5, 6))).toBe('20261003T040506');
  });
});

describe('openEventLog', () => {
  it('appends one JSON line per event to <root>/.runs/events.jsonl, the directory made when absent', () => {
    const c = clock();
    const ev = openEventLog({ root, repo: 'khaita', subject: '135', story: '135', epic: 'epic/search', pid: 4242, now: c.now });
    ev.start('launch', 'launch', { model: 'sonnet' });
    c.tick(1500);
    ev.mark('verdict', { result: 'PASS', reason: '' });
    c.tick(500);
    ev.end('launch', { result: 'PASS', exit: 0 });
    const got = lines();
    expect(got.map((e) => e.event)).toEqual(['start', 'mark', 'end']);
    for (const e of got) {
      expect(e).toMatchObject({ v: 1, repo: 'khaita', story: '135', epic: 'epic/search', source: 'log' });
      expect(e.run_id).toMatch(/^khaita\.135\.\d{8}T\d{6}\.4242$/);
    }
    expect(got[0]).toMatchObject({ span: 'launch', pass: 'launch', model: 'sonnet', pid: 4242 });
    expect(got[1]).not.toHaveProperty('reason');            // '' and undefined are left out
    expect(got[1]).not.toHaveProperty('pid');               // a pid on starts only
    expect(got[2]).toMatchObject({ span: 'launch', pass: 'launch', result: 'PASS', exit: 0, dur_s: 2 });
  });

  it('takes pass and name of an end from its start, and the duration to the millisecond', () => {
    const c = clock();
    const ev = openEventLog({ root, repo: 'r', subject: '001', pid: 1, now: c.now });
    ev.start('r1.builder', 'builder', { name: 'build', round: 1 });
    c.tick(61_234);
    ev.end('r1.builder', { result: 'OK' });
    expect(lines()[1]).toMatchObject({ pass: 'builder', name: 'build', round: 1, dur_s: 61.234 });
  });

  it('carries context set mid-run on every later line, and a line may override it', () => {
    const ev = openEventLog({ root, repo: 'r', subject: '001', pid: 1 });
    ev.context({ round: 2 });
    ev.mark('scope', { result: 'CLEAN' });
    ev.mark('scope', { result: 'CLEAN', round: 3 });
    expect(lines().map((e) => e.round)).toEqual([2, 3]);
  });

  it('ends what is still open, innermost first — a launch that stops mid-round', () => {
    const ev = openEventLog({ root, repo: 'r', subject: '001', pid: 1 });
    ev.start('launch', 'launch');
    ev.start('r1', 'round');
    ev.start('r1.builder', 'builder');
    expect(ev.open()).toEqual(['launch', 'r1', 'r1.builder']);
    ev.endOpen({ result: 'KILLED', reason: 'SIGTERM' });
    expect(ev.open()).toEqual([]);
    expect(lines().slice(3).map((e) => [e.span, e.pass, e.result])).toEqual([
      ['r1.builder', 'builder', 'KILLED'], ['r1', 'round', 'KILLED'], ['launch', 'launch', 'KILLED'],
    ]);
  });

  it('writes the end of a span it never saw start, with the pass it is given', () => {
    const ev = openEventLog({ root, repo: 'r', subject: '001', pid: 1 });
    ev.end('x', { pass: 'merge', result: 'FAILED' });
    expect(lines()[0]).toMatchObject({ event: 'end', span: 'x', pass: 'merge', result: 'FAILED' });
    expect(lines()[0]).not.toHaveProperty('dur_s');
  });

  it('cuts a reason to 500 characters and an intent to 2048, and keeps every line under LINE_MAX bytes', () => {
    const ev = openEventLog({ root, repo: 'r', subject: '001', pid: 1 });
    ev.start('writer', 'writer', { intent: 'é'.repeat(3000), reason: 'x'.repeat(900), other: 'y'.repeat(3000) });
    const raw = readFileSync(join(root, EVENTS_FILE), 'utf8');
    expect(Buffer.byteLength(raw)).toBeLessThan(LINE_MAX);
    const e = lines()[0]!;
    expect(String(e.reason).length).toBeLessThanOrEqual(500);
    expect(String(e.intent).length).toBeLessThanOrEqual(2048);
    expect(e.truncated).toBe(true);
  });

  it('never throws when the log cannot be written: it warns once and the run goes on', () => {
    mkdirSync(join(root, '.runs'));
    chmodSync(join(root, '.runs'), 0o500);
    const warned: string[] = [];
    const ev = openEventLog({ root, repo: 'r', subject: '001', pid: 1, warn: (m) => warned.push(m) });
    expect(() => { ev.mark('promote'); ev.mark('promote'); }).not.toThrow();
    chmodSync(join(root, '.runs'), 0o700);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/event log/);
    expect(existsSync(join(root, EVENTS_FILE))).toBe(false);
  });
});

describe('readEvents', () => {
  it('reads every JSON line and skips one that is not — a line cut by a crash', () => {
    const text = '{"v":1,"pass":"a"}\n{"v":1,"pa\n\n{"v":1,"pass":"b"}\n';
    expect(readEvents(text).map((e) => e.pass)).toEqual(['a', 'b']);
  });
});
