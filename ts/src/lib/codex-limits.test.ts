import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexResetFromSessions, resetFromMessage, reviewerResetAt } from './codex-limits.ts';

// When codex's usage limit lifts. The numbers are in its session rollouts —
// a `token_count` event's rate_limits, as codex 0.153 wrote them on 21 Sep:
//   {"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex",
//    "primary":{"used_percent":100.0,"window_minutes":300,"resets_at":1789993067},"secondary":{…}}}}
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'fleet-codex-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const NOW = Date.UTC(2026, 8, 21, 11, 3, 14); // 13:03:14 CEST, the refusal
const window = (used: number, resetsAt: number): object => ({ used_percent: used, window_minutes: 300, resets_at: resetsAt });
const snapshot = (limitId: string, primary: object | null, secondary: object | null = null): string =>
  JSON.stringify({ timestamp: 'x', type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: limitId, primary, secondary } } });
let n = 0;
function rollout(lines: string[], ageSec = 0): string {
  const d = join(home, 'sessions', '2026', '09', '21');
  mkdirSync(d, { recursive: true });
  const f = join(d, `rollout-${++n}.jsonl`);
  writeFileSync(f, `${lines.join('\n')}\n`);
  const t = (NOW - ageSec * 1000) / 1000;
  utimesSync(f, t, t);
  return f;
}
const at = (o: { codexHome: string; nowMs: number }): number | undefined => codexResetFromSessions(o)?.getTime();
const RESET = 1789993067; // 14:17:47 CEST

describe('codexResetFromSessions — the newest codex snapshot decides', () => {
  it('a window at 100%: when it resets (the 21 Sep numbers)', () => {
    rollout([snapshot('codex', window(99, RESET)), snapshot('codex', window(100, RESET), window(16, RESET + 586800))]);
    expect(at({ codexHome: home, nowMs: NOW })).toBe(RESET * 1000);
  });
  it('the refused session\'s own `premium` snapshot, all null, says nothing — an older session\'s does', () => {
    rollout([snapshot('codex', window(100, RESET))], 60);
    rollout([snapshot('premium', null, null)], 0);
    expect(at({ codexHome: home, nowMs: NOW })).toBe(RESET * 1000);
  });
  it('the weekly window at 100%: its reset, days away', () => {
    rollout([snapshot('codex', window(40, RESET), window(100, RESET + 3 * 86400))]);
    expect(at({ codexHome: home, nowMs: NOW })).toBe((RESET + 3 * 86400) * 1000);
  });
  it('no window at 100%: unknown — the refusal was not a window limit', () => {
    rollout([snapshot('codex', window(100, RESET))], 60);
    rollout([snapshot('codex', window(15, RESET))], 0);
    expect(at({ codexHome: home, nowMs: NOW })).toBeUndefined();
  });
  it('a reset already past, or more than eight days off: unknown', () => {
    rollout([snapshot('codex', window(100, NOW / 1000 - 1))]);
    expect(at({ codexHome: home, nowMs: NOW })).toBeUndefined();
    rollout([snapshot('codex', window(100, NOW / 1000 + 9 * 86400))]);
    expect(at({ codexHome: home, nowMs: NOW })).toBeUndefined();
  });
  it('a rollout older than eight days is not read', () => {
    rollout([snapshot('codex', window(100, RESET))], 9 * 86400);
    expect(at({ codexHome: home, nowMs: NOW })).toBeUndefined();
  });
  it('no sessions directory, garbage lines, shapes it does not know: unknown, never a throw', () => {
    expect(at({ codexHome: join(home, 'nowhere'), nowMs: NOW })).toBeUndefined();
    rollout(['not json', '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":"weird"}}}', 'null']);
    expect(at({ codexHome: home, nowMs: NOW })).toBeUndefined();
  });
});

describe('resetFromMessage — "try again at 2:17 PM", local time', () => {
  const now = new Date(2026, 8, 21, 13, 3, 14);
  it('later today', () => {
    expect(resetFromMessage('… or try again at 2:17 PM.', now)).toEqual(new Date(2026, 8, 21, 14, 17));
  });
  it('a time already past today is tomorrow', () => {
    expect(resetFromMessage('try again at 9:05 AM', now)).toEqual(new Date(2026, 8, 22, 9, 5));
  });
  it('12 AM is midnight, 12 PM is noon', () => {
    expect(resetFromMessage('try again at 12:05 AM', now)).toEqual(new Date(2026, 8, 22, 0, 5));
    expect(resetFromMessage('try again at 12:30 PM', new Date(2026, 8, 21, 9, 0))).toEqual(new Date(2026, 8, 21, 12, 30));
  });
  it('no time in it: unknown', () => {
    expect(resetFromMessage('Quota exceeded. Check your plan and billing details.', now)).toBeUndefined();
  });
});

describe('reviewerResetAt — the sessions first, then the message', () => {
  const now = new Date(NOW);
  it('the sessions win: an exact epoch beats a rounded clock time', () => {
    rollout([snapshot('codex', window(100, RESET))]);
    expect(reviewerResetAt({ codexHome: home, message: 'try again at 3:00 PM', now })?.getTime()).toBe(RESET * 1000);
  });
  it('no snapshot: the message', () => {
    expect(reviewerResetAt({ codexHome: home, message: 'try again at 2:17 PM', now })).toEqual(resetFromMessage('try again at 2:17 PM', now));
  });
  it('neither: unknown', () => {
    expect(reviewerResetAt({ codexHome: home, message: 'Quota exceeded.', now })).toBeUndefined();
  });
});
