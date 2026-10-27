// catalog.ts — what the dashboard knows of a repo's stories and epics, built
// from `fleet status` (statusOf), the event log with its backfill, and the
// story and review files. Pure: the caller reads the files and the events;
// nothing here touches git or the disk.
//
// A story's history is its status marks, oldest first; the times the
// dashboard shows (ready, picked up, done, merged, landed) come from it and
// from its epic's lands, each from the event that carries it.
import type { FleetEvent } from '../lib/events.ts';
import { fieldOfText } from '../lib/frontmatter.ts';
import { reviewRounds } from '../lib/history.ts';
import { DASH, type Status } from '../status.ts';

export interface HistoryEntry {
  ts: string;
  /** The status, or `promoted`, `answered`, `merged`, `reverted`. */
  kind: string;
  msg: string;
  src: string;
  by?: string;
  into?: string;
  sha?: string;
}

export interface Mutation {
  ac: string;
  cls: string;
  name: string;
}

export interface RoundSummary {
  n: number;
  head: string;
  /** The `reviewed:` line as written: the round's end. */
  reviewed: string;
  computed: string;
  reasons: string[];
  timing?: { builder: number; baseline: number; reviewer: number; mutations: number; total: number };
  builderModel?: string;
  builderUsed?: string;
  reviewerCli?: string;
  reviewerModel?: string;
  reviewerUsed?: string;
  baseline?: string;
  turns?: number;
  costUsd?: number;
  mutations: Mutation[];
}

export interface Intent {
  text: string;
  ts: string;
  src: string;
  model?: string;
}

export interface CatalogStory {
  id: string;
  title: string;
  status: string;
  landing: string;
  verdict: string | null;
  reasons: string[];
  base: string;
  epic: string | null;
  round: number | null;
  model: string | null;
  live: boolean;
  blocked: boolean;
  acs: { id: string; claim: string }[];
  symptom: string;
  question: string | null;
  intent: Intent | null;
  history: HistoryEntry[];
  rounds: RoundSummary[];
  readyAt: string | null;
  pickedAt: string | null;
  queueWaitS: number | null;
  draftAt: string | null;
  doneAt: string | null;
  mergedAt: string | null;
  landedAt: string | null;
  landedHow: string | null;
}

export interface EpicLand {
  ts: string;
  src: string;
  sha?: string;
  into?: string;
}

export interface CatalogEpic {
  name: string;
  created: { ts: string; src: string; sha?: string } | null;
  lands: EpicLand[];
  stories: string[];
  exists: boolean;
  ahead: number | null;
}

export interface CatalogRepo {
  name: string;
  baseBranch: string;
  stories: CatalogStory[];
  epics: CatalogEpic[];
}

const SYMPTOM_MAX = 700;
const QUESTION_MAX = 300;

/** The model a story asks for, its criteria, and the first paragraph of its Symptom. */
export function parseStoryText(text: string): { model: string | null; acs: { id: string; claim: string }[]; symptom: string } {
  const acs = [...text.matchAll(/^\*\*(AC\d+) — (.*?)\*\*/gm)].map((m) => ({ id: m[1] ?? '', claim: (m[2] ?? '').replace(/\.$/, '') }));
  const sym = /^## Symptom[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text);
  let symptom = (sym?.[1] ?? '').trim().split(/\n\s*\n/)[0]?.replace(/\s*\n\s*/g, ' ') ?? '';
  if (symptom.length > SYMPTOM_MAX) symptom = `${symptom.slice(0, SYMPTOM_MAX - 1)}…`;
  const model = fieldOfText(text, 'model');
  return { model: model === '' ? null : model, acs, symptom };
}

/** The parts of a review after each `## Round ` heading, with their number. */
function roundParts(text: string): { n: number; part: string }[] {
  return text.split(/^## Round /m).slice(1).flatMap((part) => {
    const h = /^(\d+) — /.exec(part);
    return h === null ? [] : [{ n: Number(h[1]), part }];
  });
}

/** Every round of a review that has a `reviewed:` time. */
export function roundsOf(review: string): RoundSummary[] {
  return roundParts(review).flatMap(({ part }) => {
    const f = reviewRounds(`## Round ${part}`)[0];
    const reviewed = /^reviewed: (\S+)$/m.exec(part)?.[1];
    if (f === undefined || reviewed === undefined) return [];
    const mutations: Mutation[] = [];
    const at = part.indexOf('\nmutations:\n');
    if (at >= 0) {
      for (const line of part.slice(at + '\nmutations:\n'.length).split('\n')) {
        const m = /^(AC\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (m === null) break;
        mutations.push({ ac: m[1] ?? '', cls: m[2] ?? '', name: m[3] ?? '' });
      }
    }
    const r: RoundSummary = {
      n: f.n, head: f.head, reviewed, computed: f.computed, reasons: f.reasons.split(/;\s*/).map((s) => s.trim()).filter((s) => s !== ''), mutations,
    };
    if (f.timing !== undefined) r.timing = f.timing;
    for (const k of ['builderModel', 'builderUsed', 'reviewerCli', 'reviewerModel', 'reviewerUsed', 'baseline'] as const) {
      const v = f[k];
      if (v !== undefined && v !== '') r[k] = v;
    }
    return [r];
  });
}

/** Each round's Machine block, without its heading. */
export function machineTexts(review: string): Record<number, string> {
  const out: Record<number, string> = {};
  for (const { n, part } of roundParts(review)) {
    const m = /^### Machine[ \t]*\n([\s\S]*?)(?=^### |(?![\s\S]))/m.exec(part);
    if (m !== null) out[n] = (m[1] ?? '').replace(/^\n+/, '').replace(/\s+$/, '');
  }
  return out;
}

/** A story's status marks as its history, oldest first. */
export function historyOf(events: readonly FleetEvent[], id: string): HistoryEntry[] {
  return events.filter((e) => e.pass === 'status' && e.event === 'mark' && e.story === id).map((e) => {
    const msg = e.reason ?? '';
    const name = e.name ?? '';
    const kind = name !== 'ready' ? name
      : /^promoted to ready/.test(msg) ? 'promoted'
        : /^(answered|wait for the reviewer|reviewed by Claude instead)/.test(msg) ? 'answered' : 'ready';
    const h: HistoryEntry = { ts: e.ts, kind, msg, src: e.source };
    for (const k of ['by', 'into', 'sha'] as const) if (typeof e[k] === 'string' && e[k] !== '') h[k] = e[k];
    return h;
  });
}

const ms = (iso: string): number => Date.parse(iso);

/** The lands of each epic, oldest first: its merge into the integration branch. */
function epicLands(events: readonly FleetEvent[]): Map<string, EpicLand[]> {
  const out = new Map<string, EpicLand[]>();
  for (const e of events) {
    if (e.pass !== 'epic_merge' || e.event === 'start' || e.result !== 'MERGED' || e.epic === undefined) continue;
    const l: EpicLand = { ts: e.ts, src: e.source };
    if (typeof e['sha'] === 'string') l.sha = e['sha'];
    if (typeof e['into'] === 'string') l.into = e['into'];
    out.set(e.epic, [...(out.get(e.epic) ?? []), l]);
  }
  for (const l of out.values()) l.sort((a, b) => ms(a.ts) - ms(b.ts));
  return out;
}

export interface StoryFiles {
  story: string;
  review?: string | undefined;
  blocked?: string | undefined;
}

export interface CatalogInput {
  name: string;
  baseBranch: string;
  status: Status;
  /** The log and its backfill, combined, oldest first. */
  events: readonly FleetEvent[];
  files: (id: string) => StoryFiles;
  /** What a round's builder calls cost (builder*.json). */
  usage?: (id: string, n: number) => { turns?: number; costUsd?: number };
}

export function catalogRepo(o: CatalogInput): CatalogRepo {
  const lands = epicLands(o.events);
  const stories: CatalogStory[] = o.status.stories.map((row) => {
    const f = o.files(row.id);
    const text = parseStoryText(f.story);
    const history = historyOf(o.events, row.id);
    const epic = row.base.startsWith('epic/') ? row.base : null;
    const first = (kinds: string[]): HistoryEntry | undefined => history.find((h) => kinds.includes(h.kind));
    const ready = first(['ready', 'promoted']);
    const picked = ready === undefined ? undefined : history.find((h) => h.kind === 'in_progress' && ms(h.ts) >= ms(ready.ts));
    const done = [...history].reverse().find((h) => h.kind === 'done');
    const merged = first(['merged']);
    const epicLand = (after: string): EpicLand | undefined => (epic === null ? undefined : lands.get(epic)?.find((l) => ms(l.ts) >= ms(after)));
    let landedAt: string | null = null;
    let landedHow: string | null = null;
    if (epic !== null && merged !== undefined) {
      const l = epicLand(merged.ts);
      if (l !== undefined) { landedAt = l.ts; landedHow = 'epic merge'; }
    } else if (epic === null) {
      const l = o.events.find((e) => e.pass === 'land' && e.event !== 'start' && e.story === row.id && e.result === 'MERGED');
      if (l !== undefined) { landedAt = l.ts; landedHow = 'merge'; }
    }
    // The first stories were built on the integration branch, or merged into
    // their epic before merge commits named them: the done commit, or the
    // epic's land after it, says when they landed.
    if (landedAt === null && row.landing === 'landed' && done !== undefined) {
      const l = epicLand(done.ts);
      if (l !== undefined) { landedAt = l.ts; landedHow = 'epic merge'; } else if (epic === null) { landedAt = done.ts; landedHow = 'built on the branch'; }
    }
    const writer = o.events.filter((e) => e.pass === 'writer' && e.event === 'start' && e.story === row.id && typeof e['intent'] === 'string').at(-1);
    const intent: Intent | null = writer === undefined ? null : { text: String(writer['intent']), ts: writer.ts, src: writer.source, ...(typeof writer['model'] === 'string' ? { model: writer['model'] } : {}) };
    const rounds = (f.review === undefined ? [] : roundsOf(f.review)).map((r) => ({ ...r, ...(o.usage?.(row.id, r.n) ?? {}) }));
    const q = f.blocked?.split('\n').map((l) => l.trim()).find((l) => l !== '' && l !== '---')?.replace(/^#+\s*/, '') ?? null;
    return {
      id: row.id, title: row.title === DASH ? '' : row.title, status: row.status, landing: row.landing,
      verdict: row.verdict === DASH || row.verdict === '' ? null : row.verdict,
      reasons: row.reasons.split(/;\s*/).map((s) => s.trim()).filter((s) => s !== ''),
      base: row.base, epic, round: /^[0-9]+$/.test(row.round) ? Number(row.round) : null, model: text.model, live: row.live, blocked: row.blocked,
      acs: text.acs, symptom: text.symptom, question: q === null ? null : q.slice(0, QUESTION_MAX), intent, history, rounds,
      readyAt: ready?.ts ?? null, pickedAt: picked?.ts ?? null,
      queueWaitS: ready !== undefined && picked !== undefined ? Math.round((ms(picked.ts) - ms(ready.ts)) / 1000) : null,
      draftAt: first(['draft'])?.ts ?? null, doneAt: done?.ts ?? null, mergedAt: merged?.ts ?? null, landedAt, landedHow,
    };
  });

  const known = new Map(o.status.epics.map((e) => [e.name, e]));
  const created = new Map<string, { ts: string; src: string; sha?: string }>();
  for (const e of o.events) {
    if (e.pass !== 'epic' || e.event !== 'mark' || e.epic === undefined || created.has(e.epic)) continue;
    created.set(e.epic, { ts: e.ts, src: e.source, ...(typeof e['sha'] === 'string' ? { sha: e['sha'] } : {}) });
  }
  const names = new Set([...known.keys(), ...created.keys(), ...stories.flatMap((s) => (s.epic === null ? [] : [s.epic]))]);
  const epics: CatalogEpic[] = [...names].sort().map((name) => ({
    name,
    created: created.get(name) ?? null,
    lands: lands.get(name) ?? [],
    stories: stories.filter((s) => s.epic === name).map((s) => s.id),
    exists: known.get(name)?.exists ?? created.has(name),
    ahead: known.get(name)?.ahead ?? null,
  }));
  return { name: o.name, baseBranch: o.baseBranch, stories, epics };
}
