// The event log: <target>/.runs/events.jsonl, one JSON object per line, one
// line per thing the fleet did — a pass that starts and ends (a launch, a
// round, a builder call, a baseline step, a mutation, a merge, a writer) or
// an instant (a promotion, an answer, a verdict, a queue pickup). It is what
// a reader shows a story's life from: git says when a status changed, the
// Machine block how long a round's phases took in sum; neither says when a
// pass started, which one is running now, or that a launcher died in it.
//
// Every line carries `v`, `ts` (local, milliseconds, offset), `run_id` (one
// per process: <repo>.<subject>.<YYYYMMDDTHHMMSS>.<pid>), `repo`, `pass`,
// `event` (start|end|mark) and `source` (`log` here; a backfill reader
// writes git|mtime|journal|machine). A start and its end share `span`, the
// end has `dur_s`, and every start has the `pid` — so an open span whose pid
// is gone is a pass that died. The rest is per pass: story, epic, round,
// name, agent, model, model_used, result, exit, reason, evidence (a path in
// the target), head, commits, turns, cost_usd, ac, check, reused, intent, …
//
// Each line is one append, under LINE_MAX bytes (O_APPEND keeps lines whole
// across the launcher, the queue, the bot and a merge writing at once). A
// line that cannot be written is a warning, once, and nothing more: the log
// records what happened and must never change it — the rule notify follows.
// The file is the target's and gitignored with the rest of .runs/.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const EVENTS_FILE = '.runs/events.jsonl';
export const EVENTS_VERSION = 1;
/** A line's ceiling in bytes, newline included. */
export const LINE_MAX = 4000;
const REASON_MAX = 500;
const INTENT_MAX = 2048;
const STRING_MAX = 300;

export type EventKind = 'start' | 'end' | 'mark';
export type EventSource = 'log' | 'git' | 'mtime' | 'journal' | 'machine';
export type EventValue = string | number | boolean | undefined;
/** What a caller adds to a line; undefined and '' are left out. */
export type EventFields = Readonly<Record<string, EventValue>>;

export interface FleetEvent {
  v: number;
  ts: string;
  run_id: string;
  repo: string;
  pass: string;
  event: EventKind;
  source: EventSource;
  span?: string;
  story?: string;
  epic?: string;
  round?: number;
  name?: string;
  result?: string;
  reason?: string;
  dur_s?: number;
  pid?: number;
  [field: string]: unknown;
}

const p2 = (n: number): string => String(n).padStart(2, '0');

/** `date -Iseconds` with milliseconds: local time, numeric offset. */
export function formatIsoMs(d: Date): string {
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
    + `.${String(d.getMilliseconds()).padStart(3, '0')}${off >= 0 ? '+' : '-'}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
}

/** The start of a run in its id: local, to the second. */
export function runStamp(d: Date): string {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/** Every line that parses; one cut short by a crash is skipped. */
export function readEvents(text: string): FleetEvent[] {
  const out: FleetEvent[] = [];
  for (const l of text.split('\n')) {
    if (l.trim() === '') continue;
    try {
      const e: unknown = JSON.parse(l);
      if (e !== null && typeof e === 'object' && !Array.isArray(e)) out.push(e as FleetEvent);
    } catch {
      /* a partial line */
    }
  }
  return out;
}

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The line, its strings cut to their ceilings and, when it is still too
 *  long, the intent and the reason shortened until it fits. */
export function eventLine(e: Record<string, EventValue>): string {
  const o: Record<string, EventValue> = {};
  let truncated = false;
  for (const [k, v] of Object.entries(e)) {
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string') { o[k] = v; continue; }
    const max = k === 'intent' ? INTENT_MAX : k === 'reason' ? REASON_MAX : STRING_MAX;
    o[k] = cut(v, max);
    if (o[k] !== v) truncated = true;
  }
  const line = (): string => `${JSON.stringify(truncated ? { ...o, truncated } : o)}\n`;
  for (const k of ['intent', 'reason', 'evidence', 'name']) {
    while (Buffer.byteLength(line()) >= LINE_MAX && typeof o[k] === 'string' && (o[k] as string).length > 16) {
      o[k] = cut(o[k] as string, Math.floor((o[k] as string).length / 2));
      truncated = true;
    }
  }
  return line();
}

export interface EventLogOptions {
  /** The target's checkout; the log is <root>/.runs/events.jsonl. */
  root: string;
  repo: string;
  /** What this run is about, in its id: a story id, an epic, `drain`. */
  subject: string;
  /** On every line of the run unless a line names its own. */
  story?: string | undefined;
  epic?: string | undefined;
  pid?: number;
  now?: () => Date;
  /** The append; a test hands its own. */
  write?: (line: string) => void;
  /** Said once, when the first line cannot be written. */
  warn?: (msg: string) => void;
}

export interface EventLog {
  readonly runId: string;
  /** Fields every later line carries (a round number, say). */
  context(f: EventFields): void;
  start(span: string, pass: string, f?: EventFields): void;
  /** The pass and the fields of its start — not its intent, reason or
   *  result — and the seconds since it. */
  end(span: string, f?: EventFields): void;
  mark(pass: string, f?: EventFields): void;
  /** Ends every open span, innermost first: a run cut short. */
  endOpen(f: EventFields): void;
  /** The open spans, outermost first. */
  open(): string[];
}

export function openEventLog(o: EventLogOptions): EventLog {
  const now = o.now ?? ((): Date => new Date());
  const pid = o.pid ?? process.pid;
  const file = join(o.root, EVENTS_FILE);
  const write = o.write ?? ((line: string): void => {
    mkdirSync(join(o.root, '.runs'), { recursive: true });
    appendFileSync(file, line);
  });
  const runId = `${o.repo}.${o.subject}.${runStamp(now())}.${pid}`;
  let ctx: Record<string, EventValue> = { story: o.story, epic: o.epic };
  const spans = new Map<string, { pass: string; fields: EventFields; at: number }>();
  let warned = false;

  const emit = (event: EventKind, pass: string, span: string | undefined, f: EventFields, at: Date, extra: EventFields = {}): void => {
    const line = eventLine({
      v: EVENTS_VERSION, ts: formatIsoMs(at), run_id: runId, span, repo: o.repo, ...ctx, pass, event, ...extra, ...f, source: 'log',
    });
    try {
      write(line);
    } catch (e) {
      if (warned) return;
      warned = true;
      o.warn?.(`event log: cannot write ${file} — ${e instanceof Error ? e.message : String(e)}; the run goes on without it`);
    }
  };

  const end = (span: string, f: EventFields = {}): void => {
    const at = now();
    const s = spans.get(span);
    spans.delete(span);
    const pass = s?.pass ?? (typeof f['pass'] === 'string' ? f['pass'] : 'unknown');
    const extra: EventFields = s === undefined ? {} : { ...s.fields, dur_s: Math.round(at.getTime() - s.at) / 1000 };
    emit('end', pass, span, f, at, extra);
  };

  return {
    runId,
    context: (f) => { ctx = { ...ctx, ...f }; },
    start: (span, pass, f = {}) => {
      const at = now();
      const { intent: _i, reason: _r, result: _s, ...fields } = f;
      spans.set(span, { pass, fields, at: at.getTime() });
      emit('start', pass, span, f, at, { pid });
    },
    end,
    mark: (pass, f = {}) => emit('mark', pass, undefined, f, now()),
    endOpen: (f) => {
      for (const span of [...spans.keys()].reverse()) end(span, f);
    },
    open: () => [...spans.keys()],
  };
}
