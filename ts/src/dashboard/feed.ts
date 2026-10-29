// feed.ts — the fleet's latest events, every repo at once, newest first: the
// Overview's "Latest" list (api/feed). Built from the bundle's events (the
// log and its backfill) and cut at a moment like the rest of the page. A
// pass shows once: by its end, or by its start while it runs. The steps of a
// round (the baseline's steps, the tdd check, scope, the mutations and
// probes, the installs) show only on request: one round has dozens. Pure.
import type { FleetEvent } from '../lib/events.ts';
import { head, items, markRow, passRow, titleOf, type Item } from './life.ts';

/** How many items an answer holds when the page names no number, and at most. */
export const FEED_LIMIT = 40;
export const FEED_MAX = 200;
const WHY_MAX = 300;

export interface FeedItem {
  /** A pass's end; its start while it runs; a mark's time. */
  ts: string;
  src: string;
  repo: string;
  story?: string;
  epic?: string;
  round?: number;
  pass: string;
  name?: string;
  title: string;
  result?: string;
  why?: string;
  dur_s?: number;
  /** `no end`: started, never ended, and its process is gone. */
  state: 'ended' | 'running' | 'no end' | 'mark';
  /** One of a round's steps, shown on request. */
  step: boolean;
  /** A mark's icon and tone, as the story's log shows it. */
  ic?: string;
  tone?: string;
}

export interface Feed {
  at: string | null;
  items: FeedItem[];
  /** Older items exist past the limit. */
  more: boolean;
}

export interface FeedInput {
  /** repo → its events (Bundle.events). */
  events: Readonly<Record<string, readonly FleetEvent[]>>;
  /** The moment; absent is now. */
  at?: string | undefined;
  /** The fleet's pids that still run (Bundle.now.alive). */
  alive: ReadonlySet<number>;
  limit: number;
  steps: boolean;
}

const STEPS = new Set(['tdd', 'mutation', 'probe', 'scope', 'install']);
const isStep = (f: FleetEvent): boolean => STEPS.has(f.pass) || (f.pass === 'baseline' && f.event !== 'mark' && f.name !== 'all');
/** The launch and the merge stand for these, as in the story's log. */
const STATUS_SHOWN_ELSEWHERE = new Set(['in_progress', 'done', 'merged']);
/** A status commit these marks say again, by its sha. */
const SAYS_STATUS = new Set(['promote', 'answer', 'reset', 'revert']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const cut = (s: string): string => (s.length <= WHY_MAX ? s : `${s.slice(0, WHY_MAX - 1)}…`);
function wait(s: number): string {
  return s < 90 ? `${Math.round(s)} s` : s < 90 * 60 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}

function markOf(x: Item): { title: string; why?: string; ic?: string; tone?: string } {
  const m = x.m as FleetEvent;
  const by = str(m['by']);
  switch (m.pass) {
    case 'status': {
      const name = str(m.name) ?? '?';
      const why = str(m.reason);
      return { title: name, ...(why !== undefined && why !== name ? { why } : {}) };
    }
    case 'promote': return { title: 'Promoted to ready', ...(by !== undefined ? { why: `by ${by}` } : {}) };
    case 'answer': {
      const name = str(m.name) ?? 'answer';
      return { title: name === 'answer' ? 'Answered' : `Answered with /${name}`, ...(by !== undefined ? { why: `by ${by}` } : {}) };
    }
    case 'queue': {
      const w = m['wait_s'];
      return { title: 'Picked up by the queue', ...(typeof w === 'number' ? { why: `waited ${wait(w)} since ready` } : {}) };
    }
    case 'epic_merge': return { title: `Land on ${str(m['into']) ?? '?'}` };
    case 'verdict': {
      // The title says the verdict; the reason says why, and the reviewer only
      // when it said otherwise.
      const r = markRow(x, null);
      const said = str(m['reviewer']);
      const why = [str(m.reason), said !== undefined && said !== m.result ? `the reviewer said ${said}` : undefined].filter((s) => s !== undefined).join(' · ');
      return { title: r.title, ...(why !== '' ? { why } : {}), ic: r.ic, tone: r.tone };
    }
    case 'epic': return { title: `${str(m.epic) ?? 'An epic'} ${str(m.name) ?? 'created'}` };
    case 'merge': case 'land': return { title: titleOf(x) };
    case 'reset': return { title: 'Reset' };
    case 'revert': return { title: `Reverted${str(m['into']) !== undefined ? ` from ${String(m['into'])}` : ''}` };
    default: {
      const r = markRow(x, null);
      return { title: r.title, ...(r.why !== undefined ? { why: r.why } : {}), ic: r.ic, tone: r.tone };
    }
  }
}

function itemOf(x: Item, until: number, alive: ReadonlySet<number>, pids: ReadonlyMap<string, number>, step: boolean): FeedItem {
  const f = head(x);
  const it: FeedItem = { ts: f.ts, src: f.source, repo: f.repo, pass: f.pass, title: '', state: 'mark', step };
  const story = str(f.story);
  const epic = str(f.epic);
  const name = str(f.name);
  if (story !== undefined) it.story = story;
  if (epic !== undefined) it.epic = epic;
  if (typeof f.round === 'number') it.round = f.round;
  if (name !== undefined) it.name = name;
  if (x.m !== undefined) {
    const m = markOf(x);
    const result = str(x.m.result);
    return { ...it, title: m.title, ...(m.why !== undefined ? { why: cut(m.why) } : {}), ...(result !== undefined ? { result } : {}), ...(m.ic !== undefined ? { ic: m.ic } : {}), ...(m.tone !== undefined ? { tone: m.tone } : {}) };
  }
  // An end after the moment is not known yet at it: the pass runs then.
  const e = x.e !== undefined && Date.parse(x.e.ts) <= until ? x.e : undefined;
  const seen: Item = e !== undefined || x.s === undefined ? x : { s: x.s };
  it.title = f.pass === 'launch' ? 'Launch' : f.pass === 'round' ? `Round ${f.round ?? '?'}` : titleOf(seen);
  const why = passRow(seen, it.title).reason;
  if (why !== undefined) it.why = cut(why);
  if (e !== undefined) {
    it.ts = e.ts;
    it.src = e.source;
    it.state = 'ended';
    const result = str(e.result);
    if (result !== undefined) it.result = result;
    if (typeof e.dur_s === 'number') it.dur_s = e.dur_s;
    else if (x.s !== undefined) it.dur_s = (Date.parse(e.ts) - Date.parse(x.s.ts)) / 1000;
    return it;
  }
  const pid = pids.get(f.run_id);
  it.state = x.e !== undefined || (pid !== undefined && alive.has(pid)) ? 'running' : 'no end';
  return it;
}

export function feedAt(o: FeedInput): Feed {
  const until = o.at === undefined ? Number.POSITIVE_INFINITY : Date.parse(o.at);
  const limit = Math.max(1, Math.min(FEED_MAX, Math.floor(o.limit)));
  const all = Object.values(o.events).flat();
  // A run's pid is on its first start; its later passes run in it.
  const pids = new Map<string, number>();
  for (const e of all) if (typeof e.pid === 'number' && !pids.has(e.run_id)) pids.set(e.run_id, e.pid);
  const said = new Set(all.filter((e) => e.event === 'mark' && SAYS_STATUS.has(e.pass) && str(e['sha']) !== undefined).map((e) => `${e.repo}|${String(e['sha'])}`));
  const out: FeedItem[] = [];
  for (const x of items(all)) {
    const f = head(x);
    if (Date.parse(f.ts) > until) continue;
    const step = isStep(f);
    if (step && !o.steps) continue;
    if (x.m !== undefined && f.pass === 'status' && (STATUS_SHOWN_ELSEWHERE.has(f.name ?? '') || said.has(`${f.repo}|${String(f['sha'])}`))) continue;
    out.push(itemOf(x, until, o.alive, pids, step));
  }
  // Newest first; of two at one time, the later written first.
  out.reverse().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return { at: o.at ?? null, items: out.slice(0, limit), more: out.length > limit };
}
