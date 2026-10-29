// life.ts — one story's life as the dashboard's event log shows it (the C2
// view): the writer, each status change, each queue pickup, each launch with
// its rounds and their passes, the merge on its epic, the epic's land and the
// test deploy, in time order, with the waits between them. Built from the
// events alone — the log, or for the past its backfill — so each time keeps
// the source it came from. Pure.
import type { FleetEvent } from '../lib/events.ts';
import type { CatalogStory } from './catalog.ts';

export interface At {
  ts: string;
  src: string;
}

export interface PassRow {
  pass: string;
  title: string;
  name?: string;
  agent?: string;
  model?: string;
  modelUsed?: string;
  start: At | null;
  end: At | null;
  result?: string;
  reason?: string;
  evidence?: string;
  /** Started, and no end yet: it runs, or it died in it. */
  open?: boolean;
  /** A time placed by a reader, not measured: the order of phases assumed. */
  approx?: boolean;
  children?: PassRow[];
}

export interface MarkRow {
  ts: string;
  src: string;
  title: string;
  why?: string;
  ic: string;
  tone: string;
}

export type Row = { kind: 'row'; p: PassRow } | { kind: 'mark'; m: MarkRow };

export interface RoundView {
  n: number;
  start: At | null;
  end: At | null;
  result?: string;
  reasons?: string;
  rows: Row[];
  machine?: string;
}

export interface LaunchView {
  k: number;
  pid?: number;
  start: At;
  end: At | null;
  result?: string;
  reason?: string;
  state: 'ended' | 'running' | 'dead';
  dead?: { ts: string | null; src: string; why: string };
  pre: PassRow[];
  rounds: RoundView[];
  after: PassRow[];
}

export type Entry =
  | Row
  | { kind: 'gap'; secs: number; why: string }
  | { kind: 'launch'; l: LaunchView }
  | { kind: 'group'; title: string; result?: string; start: At | null; end: At | null; rows: Row[] }
  | { kind: 'note'; text: string };

export interface Life {
  entries: Entry[];
  /** Every source a time on the page came from. */
  sources: string[];
}

const ms = (iso: string): number => Date.parse(iso);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const at = (e: FleetEvent | undefined): At | null => (e === undefined ? null : { ts: e.ts, src: e.source });
/** A wait shorter than this is not shown. */
const GAP_MIN_S = 60;

/** A start with its end, or a mark. */
export interface Item {
  s?: FleetEvent;
  e?: FleetEvent;
  m?: FleetEvent;
}
export const head = (x: Item): FleetEvent => (x.s ?? x.m ?? x.e) as FleetEvent;
const tOf = (x: Item): number => ms(head(x).ts);
const endT = (x: Item): number => ms((x.e ?? x.m ?? x.s ?? ({ ts: '' } as FleetEvent)).ts);

/** Pairs each start with the end of the same run and span, in time order. */
export function items(events: readonly FleetEvent[]): Item[] {
  const out: Item[] = [];
  const open = new Map<string, Item>();
  for (const e of [...events].sort((a, b) => ms(a.ts) - ms(b.ts))) {
    const key = `${e.run_id}|${e.span ?? ''}`;
    if (e.event === 'start') {
      const x: Item = { s: e };
      open.set(key, x);
      out.push(x);
    } else if (e.event === 'end') {
      const x = open.get(key);
      if (x !== undefined) { x.e = e; open.delete(key); } else out.push({ e });
    } else out.push({ m: e });
  }
  return out;
}

const VERDICT: Record<string, [string, string]> = { PASS: ['check', 'good'], FAIL: ['x', 'crit'], SPEC: ['doc', 'warn'], UNPARSEABLE: ['question', 'warn'], UNAVAILABLE: ['pause', 'warn'] };

export function titleOf(x: Item): string {
  const f = head(x);
  const name = str(f.name) ?? '';
  switch (f.pass) {
    case 'builder': {
      const fix = /^(baseline|tdd)-fix-(\d+)$/.exec(name);
      return fix !== null ? `Builder, resumed — ${fix[1]} fix ${fix[2]}` : 'Builder';
    }
    case 'install': return name === 'reviewer' ? 'Reviewer tree at the head + install' : 'Builder tree + install';
    case 'baseline': return name === 'all' ? `Baseline${str(f['head']) !== undefined ? ` at ${String(f['head'])}` : ''}` : name;
    case 'reviewer': return 'Reviewer';
    case 'tdd': return name === 'check' ? `check ${String(f['check'] ?? '')}`.trim() : name;
    case 'mutation': case 'probe':
      if (name === 'all') return f.pass === 'probe' ? 'Probes' : 'Mutations';
      return `${name}${(x.e ?? x.s)?.['reused'] === true ? " (the tdd check's class stands)" : ''}`;
    case 'writer': return 'Story writer drafts the story';
    case 'lint': return 'fleet lint-story';
    case 'merge': return `Merge into ${String(f['into'] ?? '?')}`;
    case 'land': return `Land on ${String(f['into'] ?? '?')}`;
    case 'test_deploy': return `Test deploy of ${String(f['branch'] ?? '?')}`;
    default: return name !== '' ? `${f.pass} — ${name}` : f.pass;
  }
}

export function passRow(x: Item, title = titleOf(x)): PassRow {
  const f = head(x);
  const p: PassRow = { pass: f.pass, title, start: at(x.s ?? x.m), end: at(x.e ?? x.m) };
  const name = str(f.name);
  if (name !== undefined) p.name = name;
  const agent = str(f['agent']);
  const model = str(f['model']);
  const used = str(x.e?.['model_used']);
  if (agent !== undefined) p.agent = agent;
  if (model !== undefined) p.model = model;
  if (used !== undefined) p.modelUsed = used;
  const result = str((x.e ?? x.m)?.result);
  if (result !== undefined) p.result = result;
  const details: string[] = [];
  const reason = str(x.e?.reason) ?? str(x.m?.reason) ?? str(x.s?.reason);
  if (reason !== undefined) details.push(reason);
  if (f.pass === 'builder' && x.e !== undefined) {
    if (typeof x.e['commits'] === 'number') details.push(`${x.e['commits']} commit(s)${str(x.e['head']) !== undefined ? `, head ${String(x.e['head'])}` : ''}`);
    if (typeof x.e['turns'] === 'number') details.push(`${x.e['turns']} turns`);
    if (typeof x.e['cost_usd'] === 'number') details.push(`$${x.e['cost_usd'].toFixed(2)}`);
  }
  if (details.length > 0) p.reason = details.join(' · ');
  const evidence = str(f['evidence']);
  if (evidence !== undefined) p.evidence = evidence;
  if (x.s !== undefined && x.e === undefined) p.open = true;
  if (x.s?.['approx'] === true || x.e?.['approx'] === true) p.approx = true;
  return p;
}

export function markRow(x: Item, question: string | null): MarkRow {
  const f = x.m as FleetEvent;
  const r = f.result ?? '';
  const base = { ts: f.ts, src: f.source };
  const why = str(f.reason);
  switch (f.pass) {
    case 'scope': return { ...base, title: `scope ${r}`, ...(why !== undefined ? { why } : {}), ic: r === 'CLEAN' ? 'check' : 'x', tone: r === 'CLEAN' ? 'good' : 'crit' };
    case 'verdict': {
      const [ic, tone] = VERDICT[r] ?? ['dot', 'neutral'];
      const said = str(f['reviewer']);
      const text = [why !== undefined ? `computed: ${r} — ${why}` : `computed: ${r}`, said !== undefined && said !== r ? `the reviewer said ${said}` : ''].filter((s) => s !== '').join(' · ');
      return { ...base, title: `computed ${r}`, why: text, ic, tone };
    }
    case 'blocked': {
      const q = why ?? question;
      return { ...base, title: 'blocked — asked a question', ...(q !== null ? { why: q } : {}), ic: 'question', tone: 'warn' };
    }
    case 'baseline': return { ...base, title: `post-merge baseline ${r}`, ...(why !== undefined ? { why } : {}), ic: r === 'RED' ? 'x' : 'check', tone: r === 'RED' ? 'crit' : 'good' };
    default: return { ...base, title: `${f.pass}${r !== '' ? ` ${r}` : ''}`, ...(why !== undefined ? { why } : {}), ic: 'dot', tone: 'neutral' };
  }
}

/** One parent row over several runs of one kind: the tdd check's, the mutations, the probes. */
function folded(pass: string, xs: readonly Item[]): PassRow {
  const kids = xs.map((x) => passRow(x));
  if (xs.length === 1) return pass === 'tdd' ? { ...(kids[0] as PassRow), title: 'tdd check' } : kids[0] as PassRow;
  const red = kids.filter((k) => k.result === 'RED').length;
  const reused = kids.filter((k) => k.title.endsWith("(the tdd check's class stands)")).length;
  const word = pass === 'mutation' ? `Mutations — ${xs.length} run, ${reused} taken from the tdd check` : pass === 'probe' ? `Probes — ${xs.length} run`
    : `tdd check — ${xs.length} ${kids.every((k) => k.name === 'check') ? 'runs' : 'pairs'}`;
  const first = kids[0] as PassRow;
  const last = kids.at(-1) as PassRow;
  const p: PassRow = { pass, title: word, start: first.start, end: last.end, result: pass === 'probe' ? (kids.every((k) => k.result === 'GREEN') ? 'GREEN' : `${kids.filter((k) => k.result !== 'GREEN').length} not GREEN`) : red === kids.length ? 'RED' : `${red}/${kids.length} RED`, children: kids };
  if (kids.some((k) => k.open === true)) p.open = true;
  return p;
}

/** A round's or a merge's items as rows: a baseline over its steps, the
 *  tdd runs, mutations and probes each folded under one row. */
function rowsOf(list: readonly Item[], question: string | null): Row[] {
  const out: Row[] = [];
  const used = new Set<Item>();
  const sorted = [...list].sort((a, b) => tOf(a) - tOf(b));
  for (const x of sorted) {
    if (used.has(x)) continue;
    const f = head(x);
    if (x.m !== undefined) { out.push({ kind: 'mark', m: markRow(x, question) }); used.add(x); continue; }
    if (f.pass === 'tdd' || f.pass === 'mutation' || f.pass === 'probe') {
      const all = sorted.filter((y) => head(y).pass === f.pass && y.m === undefined);
      all.forEach((y) => used.add(y));
      // The Machine block's span over the whole phase stands only when no
      // run of it has its own.
      const each = all.filter((y) => head(y).name !== 'all');
      out.push({ kind: 'row', p: folded(f.pass, each.length > 0 ? each : all) });
      continue;
    }
    if (f.pass === 'baseline' && f.name === 'all' && f.span !== undefined) {
      const kids = sorted.filter((y) => y !== x && head(y).pass === 'baseline' && y.m === undefined && (head(y).span ?? '').startsWith(`${f.span}.`));
      kids.forEach((y) => used.add(y));
      used.add(x);
      const p = passRow(x);
      if (kids.length > 0) p.children = kids.map((y) => passRow(y));
      out.push({ kind: 'row', p });
      continue;
    }
    used.add(x);
    out.push({ kind: 'row', p: passRow(x) });
  }
  return out;
}

const MARK: Record<string, { title: string; ic: string; tone: string }> = {
  draft: { title: 'Draft committed', ic: 'pencil', tone: 'neutral' },
  promoted: { title: 'Promoted to ready', ic: 'clock', tone: 'run' },
  ready: { title: 'Set to ready', ic: 'clock', tone: 'run' },
  answered: { title: 'Answered', ic: 'check', tone: 'good' },
  blocked: { title: 'Blocked — a question', ic: 'question', tone: 'warn' },
  needs_human: { title: 'needs_human', ic: 'hand', tone: 'crit' },
  declined: { title: 'Declined', ic: 'slash', tone: 'neutral' },
  reverted: { title: 'Merge reverted', ic: 'x', tone: 'crit' },
};
const WAIT: Record<string, string> = {
  draft: 'a draft, waiting for its promotion', promoted: 'waiting in the queue', ready: 'waiting in the queue', answered: 'waiting in the queue',
  blocked: 'waiting for the answer', needs_human: 'waiting for a human (needs_human)', dead: 'dead — nothing ran until a drain returned it to ready',
  epic: 'on the epic, waiting for the epic to land', done: 'done, waiting for its merge', landed: 'landed, before the test deploy', reverted: 'reverted',
};

export interface LifeInput {
  story: CatalogStory;
  /** The repo's events, log and backfill combined. */
  events: readonly FleetEvent[];
  /** Each round's Machine block. */
  machine: Readonly<Record<number, string>>;
  baseBranch: string;
  /** The pids that still run. */
  alive: ReadonlySet<number>;
}

interface Timed {
  t: number;
  end: number;
  entry: Entry;
  /** What a wait after it is waiting for. */
  wait?: string;
}

export function storyLife(o: LifeInput): Life {
  const s = o.story;
  const sources = new Set<string>();
  const all = items(o.events.filter((e) => e.story === s.id && e.pass !== 'status'));
  for (const x of all) for (const e of [x.s, x.e, x.m]) if (e !== undefined) sources.add(e.source);
  const timed: Timed[] = [];

  // The writer and the lint, or what git says of the draft.
  const writers = all.filter((x) => head(x).pass === 'writer' || head(x).pass === 'lint');
  for (const x of writers) timed.push({ t: tOf(x), end: endT(x), entry: { kind: 'row', p: passRow(x) } });
  if (!writers.some((x) => head(x).pass === 'writer')) {
    const draft = s.history.find((h) => h.kind === 'draft');
    const p: PassRow = { pass: 'writer', title: 'Story writer drafts the story', start: null, end: draft === undefined ? null : { ts: draft.ts, src: draft.src }, reason: 'Not recorded: the story was written before the event log.', evidence: `.stories/${s.id}.md` };
    const t = draft === undefined ? -Infinity : ms(draft.ts) - 1;
    timed.push({ t, end: t, entry: { kind: 'row', p } });
  }

  // The launches, each with its rounds and what followed it.
  const launches = all.filter((x) => x.s?.pass === 'launch');
  const launchRuns = new Set(launches.map((x) => head(x).run_id));
  /** A merge is its own process: its lines are the merge's, never a launch's. */
  const mergeRuns = new Set(all.filter((x) => ['merge', 'land'].includes(head(x).pass)).map((x) => head(x).run_id));
  const spans: { from: number; to: number }[] = launches.map((x, i) => ({ from: tOf(x) - 2000, to: i + 1 < launches.length ? tOf(launches[i + 1] as Item) - 2000 : Infinity }));
  const claimed = new Set<Item>(launches);
  launches.forEach((L, i) => {
    const w = spans[i] as { from: number; to: number };
    const S = L.s as FleetEvent;
    const inWindow = (x: Item): boolean => tOf(x) >= w.from && tOf(x) < w.to;
    const member = (x: Item): boolean => !claimed.has(x) && (head(x).run_id === S.run_id
      || (!launchRuns.has(head(x).run_id) && !mergeRuns.has(head(x).run_id) && inWindow(x) && ['machine', 'mtime', 'journal'].includes(head(x).source) && !['queue', 'writer', 'lint'].includes(head(x).pass)));
    const mine = all.filter(member);
    mine.forEach((x) => claimed.add(x));
    const merges = all.filter((x) => !claimed.has(x) && ['merge', 'land'].includes(head(x).pass) && inWindow(x));
    const myMerges = new Set(merges.map((x) => head(x).run_id));
    const mergeItems = all.filter((x) => !claimed.has(x) && myMerges.has(head(x).run_id));
    mergeItems.forEach((x) => claimed.add(x));

    const pre = mine.filter((x) => head(x).round === undefined && head(x).pass !== 'round').map((x) => passRow(x));
    const ns = [...new Set(mine.flatMap((x) => (typeof head(x).round === 'number' ? [head(x).round as number] : [])))].sort((a, b) => a - b);
    const rounds: RoundView[] = ns.map((n) => {
      const ri = mine.find((x) => x.s?.pass === 'round' && x.s.round === n);
      const rest = mine.filter((x) => head(x).round === n && head(x).pass !== 'round');
      const verdict = rest.find((x) => x.m?.pass === 'verdict')?.m;
      const r: RoundView = { n, start: at(ri?.s), end: at(ri?.e), rows: rowsOf(rest, s.question) };
      const result = str(ri?.e?.result) ?? str(verdict?.result);
      if (result !== undefined) r.result = result;
      const reasons = str(verdict?.reason) ?? (s.rounds.find((x) => x.n === n)?.reasons.join('; ') || undefined);
      if (reasons !== undefined) r.reasons = reasons;
      const machine = o.machine[n];
      if (machine !== undefined) r.machine = machine;
      return r;
    });
    const after = [...myMerges].map((run) => {
      const ofRun = mergeItems.filter((x) => head(x).run_id === run);
      const main = ofRun.find((x) => ['merge', 'land'].includes(head(x).pass)) as Item;
      const p = passRow(main);
      const skipped = ofRun.find((x) => x.m?.pass === 'baseline' && x.m.result === 'SKIPPED')?.m;
      if (skipped !== undefined) p.reason = [p.reason, `post-merge baseline SKIPPED${str(skipped.reason) !== undefined ? ` — ${skipped.reason}` : ''}`].filter((v) => v !== undefined).join(' · ');
      const kids = ofRun.filter((x) => x !== main && x !== undefined && x.m === undefined).map((x) => passRow(x));
      if (kids.length > 0) p.children = kids;
      return p;
    });

    const E = L.e;
    const pid = typeof S.pid === 'number' ? S.pid : undefined;
    const l: LaunchView = { k: i + 1, start: { ts: S.ts, src: S.source }, end: at(E), state: 'ended', pre, rounds, after };
    if (pid !== undefined) l.pid = pid;
    if (str(E?.result) !== undefined) l.result = String(E?.result);
    if (str(E?.reason) !== undefined) l.reason = String(E?.reason);
    if (E !== undefined && (E.result === 'KILLED' || E.result === 'DIED')) {
      l.state = 'dead';
      l.dead = { ts: E.ts, src: E.source, why: E.reason ?? E.result };
    } else if (E === undefined) {
      if (pid !== undefined) {
        if (o.alive.has(pid)) l.state = 'running';
        else { l.state = 'dead'; l.dead = { ts: null, src: S.source, why: `pid ${pid} is gone, and the launch wrote no end` }; }
      } else if (s.live) l.state = 'running';
      else if (i === launches.length - 1 && s.status === 'in_progress') { l.state = 'dead'; l.dead = { ts: null, src: S.source, why: 'in_progress, and nothing runs in its trees' }; }
    }
    const lastEnd = Math.max(E !== undefined ? ms(E.ts) : tOf(L), ...after.map((p) => (p.end !== null ? ms(p.end.ts) : 0)), ...mine.map(endT));
    const wait = l.state === 'dead' ? 'dead' : l.result === 'BLOCKED' ? 'blocked' : l.result === 'PASS' ? (after.some((p) => p.result === 'MERGED') && s.epic !== null ? 'epic' : 'done') : l.result !== undefined ? 'needs_human' : undefined;
    timed.push({ t: tOf(L), end: lastEnd, entry: { kind: 'launch', l }, ...(wait !== undefined ? { wait } : {}) });

    // The queue's pickup of this launch.
    const pick = all.find((x) => x.m?.pass === 'queue' && x.m.name === 'pickup' && tOf(x) <= tOf(L) + 2000 && tOf(x) >= tOf(L) - 600_000);
    if (pick?.m !== undefined) {
      claimed.add(pick);
      const waited = typeof pick.m['wait_s'] === 'number' ? pick.m['wait_s'] : undefined;
      const since = str(pick.m['ready_since']);
      timed.push({ t: tOf(pick), end: tOf(pick), entry: { kind: 'mark', m: { ts: pick.m.ts, src: pick.m.source, title: 'The queue picks it up', ...(waited !== undefined ? { why: `ready since ${since ?? '?'}: waited ${waited} s` } : {}), ic: 'arrow', tone: 'neutral' } } });
    }
  });

  // The status changes no launch stands for, as marks.
  const inLaunch = (t: number): boolean => timed.some((x) => x.entry.kind === 'launch' && t >= x.t - 2000 && t <= x.end + 5000);
  let afterLaunch = false;
  for (const h of s.history) {
    const t = ms(h.ts);
    if (h.kind === 'in_progress' || h.kind === 'done' || h.kind === 'merged') { if (h.kind === 'in_progress') afterLaunch = true; continue; }
    if (inLaunch(t)) continue;
    const m = MARK[h.kind] ?? { title: h.kind, ic: 'dot', tone: 'neutral' };
    const title = h.kind === 'ready' && afterLaunch ? 'Back to ready' : m.title;
    timed.push({ t, end: t, entry: { kind: 'mark', m: { ts: h.ts, src: h.src, title, why: h.msg, ic: m.ic, tone: m.tone } }, ...(WAIT[h.kind] !== undefined ? { wait: h.kind } : {}) });
  }

  // The epic's land after the story's merge, and the test deploy after it.
  let landT: number | undefined;
  if (s.epic !== null && s.mergedAt !== null) {
    const epicItems = items(o.events.filter((e) => e.epic === s.epic && e.story === undefined && ['epic_merge', 'baseline', 'install'].includes(e.pass)));
    const land = epicItems.find((x) => head(x).pass === 'epic_merge' && tOf(x) >= ms(s.mergedAt as string));
    if (land !== undefined) {
      const f = head(land);
      sources.add(f.source);
      const run = epicItems.filter((x) => x !== land && head(x).run_id === f.run_id);
      const rows: Row[] = land.m !== undefined
        ? [{ kind: 'mark', m: { ts: f.ts, src: f.source, title: 'merge commit', why: `merge(${s.epic}) at ${String(f['sha'] ?? '?')}`, ic: 'merge', tone: 'good' } }]
        : rowsOf(run, null);
      const result = str((land.e ?? land.m)?.result);
      timed.push({ t: tOf(land), end: endT(land), entry: { kind: 'group', title: `${s.epic} lands into ${String(f['into'] ?? o.baseBranch)}`, ...(result !== undefined ? { result } : {}), start: at(land.s ?? land.m), end: at(land.e ?? land.m), rows }, wait: 'landed' });
      landT = tOf(land);
    }
  }
  if (landT !== undefined || (s.epic === null && s.landedAt !== null)) {
    const from = landT ?? ms(s.landedAt as string);
    const deploy = items(o.events.filter((e) => e.pass === 'test_deploy' && e.event !== 'mark' && e['branch'] === o.baseBranch)).find((x) => tOf(x) >= from);
    if (deploy !== undefined) {
      sources.add(head(deploy).source);
      timed.push({ t: tOf(deploy), end: endT(deploy), entry: { kind: 'row', p: passRow(deploy) } });
    }
  }

  // In time order, with the waits between.
  timed.sort((a, b) => a.t - b.t);
  const entries: Entry[] = [];
  let prevEnd: number | undefined;
  let wait: string | undefined;
  for (const x of timed) {
    if (prevEnd !== undefined && Number.isFinite(prevEnd) && Number.isFinite(x.t) && (x.t - prevEnd) / 1000 > GAP_MIN_S) {
      entries.push({ kind: 'gap', secs: Math.round((x.t - prevEnd) / 1000), why: WAIT[wait ?? ''] ?? 'waiting' });
    }
    entries.push(x.entry);
    if (Number.isFinite(x.end)) prevEnd = Math.max(prevEnd ?? -Infinity, x.end);
    if (x.wait !== undefined) wait = x.wait;
  }
  for (const h of s.history) sources.add(h.src);
  return { entries, sources: [...sources].sort() };
}
