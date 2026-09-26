// When codex's usage limit lifts, for a story paused on a refused review.
// The `exec --json` stream carries only the refusal's text ("… try again at
// 2:17 PM."); the numbers are in codex's session rollouts under
// $CODEX_HOME/sessions — `token_count` events whose rate_limits snapshot
// has a window's used_percent and the epoch it resets at:
//
//   {"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex",
//     "primary":{"used_percent":100.0,"window_minutes":300,"resets_at":1789993067},"secondary":{…}}}}
//
// The limit is the account's, not a worktree's, so the newest codex
// snapshot anywhere decides; the refused session's own rollout carries none
// (21 Sep: its snapshot was `premium`, all null). Nothing here throws: codex
// updates itself weekly, and a shape it no longer writes must mean "unknown",
// never a failed round.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DAY_MS = 86_400_000;
/** Rollouts older than this are not read, and a reset further off than
 *  this is not believed: the longest codex window is a week. */
const HORIZON_MS = 8 * DAY_MS;

function rollouts(dir: string, sinceMs: number, into: { path: string; mtime: number }[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) rollouts(p, sinceMs, into);
    else if (e.name.endsWith('.jsonl')) {
      try {
        const mtime = statSync(p).mtimeMs;
        if (mtime >= sinceMs) into.push({ path: p, mtime });
      } catch {
        // gone between the listing and the stat
      }
    }
  }
}

type Window = { used_percent?: unknown; resets_at?: unknown } | null | undefined;

/** The last codex snapshot in one rollout: its windows, or undefined when
 *  the file has none. */
function lastCodexSnapshot(path: string): Window[] | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let v: unknown;
    try {
      v = JSON.parse(lines[i] ?? '');
    } catch {
      continue;
    }
    const rl = (v as { payload?: { type?: unknown; rate_limits?: Record<string, unknown> | null } } | null)?.payload;
    if (rl?.type !== 'token_count' || rl.rate_limits == null) continue;
    const r = rl.rate_limits;
    if (r['limit_id'] !== 'codex') continue;
    const windows = [r['primary'], r['secondary']].filter((w) => w !== null && typeof w === 'object') as Window[];
    if (windows.length > 0) return windows;
  }
  return undefined;
}

/** When the codex window that is used up resets — the latest of those at
 *  100%, if it lies ahead within the horizon. The newest rollout that has a
 *  codex snapshot decides; one with no window at 100% means the refusal was
 *  not a window limit, and the answer is unknown. */
export function codexResetFromSessions(o: { codexHome: string; nowMs: number }): Date | undefined {
  const files: { path: string; mtime: number }[] = [];
  rollouts(join(o.codexHome, 'sessions'), o.nowMs - HORIZON_MS, files);
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files) {
    const windows = lastCodexSnapshot(f.path);
    if (windows === undefined) continue;
    let best: number | undefined;
    for (const w of windows) {
      if (typeof w?.used_percent !== 'number' || typeof w.resets_at !== 'number') continue;
      if (w.used_percent < 100) continue;
      const ms = w.resets_at * 1000;
      if (ms <= o.nowMs || ms > o.nowMs + HORIZON_MS) continue;
      if (best === undefined || ms > best) best = ms;
    }
    return best === undefined ? undefined : new Date(best);
  }
  return undefined;
}

/** "try again at 2:17 PM" — the machine's local time, as codex prints it
 *  (21 Sep: 2:17 PM was 14:17:47 CEST, the snapshot's epoch). A time
 *  already past today is tomorrow. */
export function resetFromMessage(message: string, now: Date): Date | undefined {
  const m = /try again at (\d{1,2}):(\d{2})\s*([AP]M)\b/i.exec(message);
  if (m === null) return undefined;
  const hour = (Number(m[1]) % 12) + ((m[3] ?? '').toUpperCase() === 'PM' ? 12 : 0);
  const d = new Date(now);
  d.setHours(hour, Number(m[2]), 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** The sessions' exact epoch first, then the message's clock time;
 *  undefined when neither says. */
export function reviewerResetAt(o: { codexHome: string; message: string; now: Date }): Date | undefined {
  return codexResetFromSessions({ codexHome: o.codexHome, nowMs: o.now.getTime() }) ?? resetFromMessage(o.message, o.now);
}
