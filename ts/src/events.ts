// events.ts — `fleet events <repo> [<id>|epic/<name>] [--backfill] [--journal]`
// (bin/events.ts): what the target's .runs/events.jsonl recorded
// (lib/events.ts), one JSON object per line, oldest first. A story id keeps
// that story's events; an epic keeps the epic's and its stories'.
//
// --backfill adds the past the log did not see, each line with the source
// of its time: the fleet's commits (`git`), the Machine blocks (`machine`),
// the evidence files' times (`mtime`); --journal adds the queue's journal
// as well (`journal`, to the microsecond, as long as the journal keeps it).
// One pass described twice is shown once: the log stands for every other
// source, the journal for git's launches and the Machine block's rounds. A
// status mark from git is always kept: the log writes none.
//
// Read-only: it writes nothing, anywhere.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoConfig } from './lib/config.ts';
import { Die } from './lib/die.ts';
import { EVENTS_FILE, readEvents, type FleetEvent } from './lib/events.ts';
import { storyField } from './lib/frontmatter.ts';
import { epicsCreated, gitEvents, machineEvents, mtimeEvents, reviewRounds, roundUsage, type RoundFacts } from './lib/history.ts';
import { journalEvents, parseJournal, readJournal } from './lib/journal.ts';
import { storyIds } from './status.ts';

export const USAGE = 'usage: fleet events <repo> [<story-id>|epic/<name>] [--backfill] [--journal]';

export function parseArgs(argv: readonly string[]): { filter: string | undefined; backfill: boolean; journal: boolean } {
  let filter: string | undefined;
  let backfill = false;
  let journal = false;
  for (const a of argv) {
    if (a === '--backfill') backfill = true;
    else if (a === '--journal') { journal = true; backfill = true; }
    else if (a.startsWith('-') || filter !== undefined) throw new Die(USAGE);
    else filter = a;
  }
  return { filter, backfill, journal };
}

const t = (e: FleetEvent): number => Date.parse(e.ts);
/** Two descriptions of one instant: a launch start, a promotion. */
const SAME_INSTANT_MS = 120_000;
/** Two descriptions of one round's end: the journal's line and the
 *  Machine block's `reviewed:` are seconds apart; a round is longer. */
const SAME_ROUND_MS = 15 * 60_000;
const near = (list: readonly FleetEvent[], same: (x: FleetEvent) => boolean, at: number, ms: number): boolean => list.some((x) => same(x) && Math.abs(t(x) - at) <= ms);
const launchStarts = (list: readonly FleetEvent[]): FleetEvent[] => list.filter((e) => e.pass === 'launch' && e.event === 'start');
const roundEnds = (list: readonly FleetEvent[]): FleetEvent[] => list.filter((e) => (e.pass === 'verdict' && e.event === 'mark') || (e.pass === 'round' && e.event === 'end'));

/** The log, and what the past adds to it, oldest first. */
export function combine(log: readonly FleetEvent[], past: readonly FleetEvent[]): FleetEvent[] {
  const journal = past.filter((e) => e.source === 'journal');
  const machine = past.filter((e) => e.source === 'machine');
  const logStarts = launchStarts(log);
  const journalStarts = launchStarts(journal);
  const betterEnds = [...roundEnds(log), ...roundEnds(journal)];
  const drop = new Set<string>();
  // A run another source describes better goes whole: its launch start, or
  // its round's end, close to theirs.
  for (const s of launchStarts(past)) {
    const same = (x: FleetEvent): boolean => x.story === s.story;
    if (near(logStarts, same, t(s), SAME_INSTANT_MS) || (s.source === 'git' && near(journalStarts, same, t(s), SAME_INSTANT_MS))) drop.add(s.run_id);
  }
  for (const v of roundEnds(machine)) {
    if (near(betterEnds, (x) => x.story === v.story && x.round === v.round, t(v), SAME_ROUND_MS)) drop.add(v.run_id);
  }
  const better = [...log, ...journal];
  const kept = past.filter((e) => {
    if (e.pass === 'status') return true;
    if (drop.has(e.run_id)) return false;
    if (e.source === 'git' && ['promote', 'answer', 'reset', 'revert'].includes(e.pass)) {
      return !near(log, (x) => x.pass === e.pass && x.story === e.story, t(e), SAME_INSTANT_MS);
    }
    if (e.source === 'git' && ['merge', 'land', 'epic_merge'].includes(e.pass)) {
      return !better.some((x) => x.pass === e.pass && x.event !== 'start' && x.result === 'MERGED'
        && ((x['sha'] !== undefined && x['sha'] === e['sha']) || (x.story === e.story && x.epic === e.epic && Math.abs(t(x) - t(e)) <= SAME_ROUND_MS)));
    }
    if (e.source === 'git' && e.pass === 'epic') return !log.some((x) => x.pass === 'epic' && x.epic === e.epic);
    if (e.source === 'journal' && e.pass === 'queue') return !near(log, (x) => x.pass === 'queue' && x.name === e.name && x.story === e.story, t(e), SAME_INSTANT_MS);
    return true;
  });
  return [...log, ...kept].sort((a, b) => t(a) - t(b));
}

/** A story's events, or an epic's and its stories'; all when no filter. */
export function selectEvents(ev: readonly FleetEvent[], filter: string | undefined): FleetEvent[] {
  if (filter === undefined) return [...ev];
  return ev.filter((e) => (filter.startsWith('epic/') ? e.epic === filter : e.story === filter));
}

/** The past of one repo, from every source but the log. */
export function backfill(cfg: RepoConfig, o: { journal: boolean; readJournal?: (repo: string) => string }): FleetEvent[] {
  const root = cfg.root;
  const out = [...gitEvents(root, cfg.name), ...epicsCreated(root, cfg.name)];
  const reviews = new Map<string, RoundFacts[]>();
  for (const id of storyIds(root)) {
    let text: string;
    try {
      text = readFileSync(join(root, '.review', `${id}.md`), 'utf8');
    } catch {
      continue;
    }
    const rounds = reviewRounds(text);
    reviews.set(id, rounds);
    const base = storyField(root, id, 'base');
    const epic = base.startsWith('epic/') ? base : undefined;
    out.push(...machineEvents({ repo: cfg.name, story: id, epic, rounds, usage: (n) => roundUsage(root, id, n) }), ...mtimeEvents({ root, repo: cfg.name, story: id, epic, rounds }));
  }
  if (o.journal) {
    const lines = parseJournal((o.readJournal ?? readJournal)(cfg.name));
    out.push(...journalEvents(lines, {
      repo: cfg.name,
      machine: (story, n) => {
        const r = reviews.get(story)?.filter((x) => x.n === n).at(-1);
        return r === undefined ? undefined : { reviewer: r.timing?.reviewer, reasons: r.reasons };
      },
    }));
  }
  return out;
}

export interface EventsOptions {
  /** After the repo name. */
  argv: readonly string[];
  /** One line of output. */
  out: (line: string) => void;
  readJournal?: (repo: string) => string;
}

export function events(cfg: RepoConfig, o: EventsOptions): number {
  const a = parseArgs(o.argv);
  let text = '';
  try {
    text = readFileSync(join(cfg.root, EVENTS_FILE), 'utf8');
  } catch {
    /* no log yet: only the past, when asked */
  }
  const past = a.backfill ? backfill(cfg, { journal: a.journal, ...(o.readJournal !== undefined ? { readJournal: o.readJournal } : {}) }) : [];
  for (const e of selectEvents(combine(readEvents(text), past), a.filter)) o.out(JSON.stringify(e));
  return 0;
}
