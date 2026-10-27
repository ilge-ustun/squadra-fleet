import { describe, expect, it } from 'vitest';
import type { FleetEvent } from '../lib/events.ts';
import type { CatalogStory, HistoryEntry } from './catalog.ts';
import { storyLife, type Entry, type LaunchView } from './life.ts';

const T = (hms: string): string => `2026-10-22T${hms}.000+02:00`;
const h = (ts: string, kind: string, msg = kind): HistoryEntry => ({ ts, kind, msg, src: 'git' });
let n = 0;
const ev = (ts: string, f: Partial<FleetEvent> & { pass: string; event: FleetEvent['event'] }): FleetEvent => ({ v: 1, ts, run_id: 'k.135.L1', repo: 'k', story: '135', source: 'log', n: n++, ...f } as FleetEvent);
const story = (o: Partial<CatalogStory> = {}): CatalogStory => ({
  id: '135', title: 'Title row', status: 'done', landing: 'landed', verdict: 'PASS', reasons: [], base: 'epic/cards', epic: 'epic/cards', round: 1, model: 'opus',
  live: false, blocked: false, acs: [], symptom: '', question: null, intent: null, rounds: [], readyAt: T('10:01:00'), pickedAt: T('11:00:00'), queueWaitS: 3540,
  draftAt: T('10:00:00'), doneAt: T('11:30:00'), mergedAt: T('11:31:00'), landedAt: T('15:00:00'), landedHow: 'epic merge',
  history: [h(T('10:00:00'), 'draft'), h(T('10:01:00'), 'promoted', 'promoted to ready (coordinator)'), h(T('11:00:00'), 'in_progress'), h(T('11:30:00'), 'done'), h(T('11:31:00'), 'merged')],
  ...o,
});

const LOG: FleetEvent[] = [
  ev(T('09:58:00'), { pass: 'writer', event: 'start', span: 'writer', run_id: 'k.135.W', agent: 'claude', model: 'opus', intent: 'make it end' }),
  ev(T('09:59:30'), { pass: 'writer', event: 'end', span: 'writer', run_id: 'k.135.W', agent: 'claude', model: 'opus', result: 'OK', dur_s: 90 }),
  ev(T('10:59:58'), { pass: 'queue', event: 'mark', run_id: 'k.drain.D', name: 'pickup', wait_s: 3538, ready_since: T('10:01:00') }),
  ev(T('11:00:00'), { pass: 'launch', event: 'start', span: 'launch', pid: 4242, model: 'opus' }),
  ev(T('11:00:01'), { pass: 'install', event: 'start', span: 'install.builder', name: 'builder' }),
  ev(T('11:00:40'), { pass: 'install', event: 'end', span: 'install.builder', name: 'builder', result: 'OK' }),
  ev(T('11:00:41'), { pass: 'round', event: 'start', span: 'r1', round: 1 }),
  ev(T('11:00:41'), { pass: 'builder', event: 'start', span: 'r1.build', round: 1, name: 'build', agent: 'claude', model: 'opus' }),
  ev(T('11:16:44'), { pass: 'builder', event: 'end', span: 'r1.build', round: 1, name: 'build', agent: 'claude', model: 'opus', model_used: 'claude-opus-5-5', result: 'OK', commits: 3, head: 'a2e1d5ed', turns: 56, cost_usd: 2.97 }),
  ev(T('11:16:45'), { pass: 'install', event: 'start', span: 'r1.baseline.1.install', round: 1, name: 'reviewer', head: 'a2e1d5ed' }),
  ev(T('11:17:20'), { pass: 'install', event: 'end', span: 'r1.baseline.1.install', round: 1, name: 'reviewer', result: 'OK' }),
  ev(T('11:17:20'), { pass: 'baseline', event: 'start', span: 'r1.baseline.1', round: 1, name: 'all', head: 'a2e1d5ed' }),
  ev(T('11:17:20'), { pass: 'baseline', event: 'start', span: 'r1.baseline.1.test', round: 1, name: 'test' }),
  ev(T('11:18:00'), { pass: 'baseline', event: 'end', span: 'r1.baseline.1.test', round: 1, name: 'test', result: 'GREEN' }),
  ev(T('11:18:00'), { pass: 'baseline', event: 'start', span: 'r1.baseline.1.e2e', round: 1, name: 'e2e' }),
  ev(T('11:21:00'), { pass: 'baseline', event: 'end', span: 'r1.baseline.1.e2e', round: 1, name: 'e2e', result: 'GREEN' }),
  ev(T('11:21:00'), { pass: 'baseline', event: 'end', span: 'r1.baseline.1', round: 1, name: 'all', result: 'GREEN', reason: 'test GREEN | e2e GREEN' }),
  ev(T('11:21:01'), { pass: 'tdd', event: 'start', span: 'r1.tdd.1', round: 1, name: 'check', check: 1 }),
  ev(T('11:23:40'), { pass: 'tdd', event: 'end', span: 'r1.tdd.1', round: 1, name: 'check', result: 'RED', reason: '4 RED' }),
  ev(T('11:23:41'), { pass: 'scope', event: 'mark', round: 1, result: 'CLEAN' }),
  ev(T('11:23:41'), { pass: 'reviewer', event: 'start', span: 'r1.reviewer', round: 1, agent: 'codex', model: 'gpt-6' }),
  ev(T('11:24:48'), { pass: 'reviewer', event: 'end', span: 'r1.reviewer', round: 1, agent: 'codex', result: 'OK' }),
  ev(T('11:24:48'), { pass: 'mutation', event: 'start', span: 'r1.mut.AC1-remove', round: 1, name: 'AC1-remove', ac: 'AC1' }),
  ev(T('11:26:00'), { pass: 'mutation', event: 'end', span: 'r1.mut.AC1-remove', round: 1, name: 'AC1-remove', result: 'RED' }),
  ev(T('11:26:00'), { pass: 'mutation', event: 'start', span: 'r1.mut.AC2-cap', round: 1, name: 'AC2-cap', ac: 'AC2' }),
  ev(T('11:26:00'), { pass: 'mutation', event: 'end', span: 'r1.mut.AC2-cap', round: 1, name: 'AC2-cap', result: 'RED', reused: true }),
  ev(T('11:29:59'), { pass: 'verdict', event: 'mark', round: 1, result: 'PASS', reviewer: 'PASS' }),
  ev(T('11:29:59'), { pass: 'round', event: 'end', span: 'r1', round: 1, result: 'PASS' }),
  ev(T('11:30:00'), { pass: 'launch', event: 'end', span: 'launch', result: 'PASS' }),
  ev(T('11:30:30'), { pass: 'merge', event: 'start', span: 'merge', run_id: 'k.135.M', into: 'epic/cards', branch: 'story/135' }),
  ev(T('11:30:31'), { pass: 'baseline', event: 'mark', run_id: 'k.135.M', name: 'merge', result: 'SKIPPED', reason: "the round's baseline stands" }),
  ev(T('11:31:00'), { pass: 'merge', event: 'end', span: 'merge', run_id: 'k.135.M', into: 'epic/cards', result: 'MERGED', sha: '1a2b3c4d' }),
  { v: 1, ts: T('15:00:00'), run_id: 'k.epic-cards.git', repo: 'k', epic: 'epic/cards', pass: 'epic_merge', event: 'mark', result: 'MERGED', into: 'develop', sha: 'beefbeef', source: 'git' },
];

const kinds = (es: readonly Entry[]): string[] => es.map((e) => (e.kind === 'mark' ? `mark:${e.m.title}` : e.kind === 'row' ? `row:${e.p.pass}` : e.kind));

describe('storyLife', () => {
  it('writer, draft, promotion, pickup, one launch, the wait on the epic, the epic\'s land', () => {
    const life = storyLife({ story: story(), events: LOG, machine: { 1: 'baseline: test GREEN' }, baseBranch: 'develop', alive: new Set() });
    expect(kinds(life.entries)).toEqual([
      'row:writer', 'mark:Draft committed', 'mark:Promoted to ready', 'gap', 'mark:The queue picks it up', 'launch', 'gap', 'group',
    ]);
    expect(life.entries[3]).toEqual({ kind: 'gap', secs: 3538, why: 'waiting in the queue' });
    expect(life.entries[6]).toEqual({ kind: 'gap', secs: 12540, why: 'on the epic, waiting for the epic to land' });
    expect(life.sources).toEqual(['git', 'log']);
  });

  it('a launch holds its rounds; a round its passes, the baseline\'s steps and the mutations folded under them', () => {
    const life = storyLife({ story: story(), events: LOG, machine: { 1: 'baseline: test GREEN' }, baseBranch: 'develop', alive: new Set() });
    const l = life.entries.find((e): e is { kind: 'launch'; l: LaunchView } => e.kind === 'launch')?.l;
    expect(l).toMatchObject({ k: 1, pid: 4242, state: 'ended', result: 'PASS', start: { ts: T('11:00:00'), src: 'log' }, end: { ts: T('11:30:00'), src: 'log' } });
    expect(l?.pre.map((p) => p.title)).toEqual(['Builder tree + install']);
    const r = l?.rounds[0];
    expect(r).toMatchObject({ n: 1, result: 'PASS', machine: 'baseline: test GREEN' });
    expect(r?.rows.map((x) => (x.kind === 'mark' ? `mark:${x.m.title}` : x.p.title))).toEqual([
      'Builder', 'Reviewer tree at the head + install', 'Baseline at a2e1d5ed', 'tdd check', 'mark:scope CLEAN', 'Reviewer', 'Mutations — 2 run, 1 taken from the tdd check', 'mark:computed PASS',
    ]);
    const builder = r?.rows[0];
    expect(builder?.kind === 'row' && builder.p).toMatchObject({ agent: 'claude', model: 'opus', modelUsed: 'claude-opus-5-5', result: 'OK', reason: '3 commit(s), head a2e1d5ed · 56 turns · $2.97' });
    const base = r?.rows[2];
    expect(base?.kind === 'row' && base.p.children?.map((c) => `${c.title} ${c.result}`)).toEqual(['test GREEN', 'e2e GREEN']);
    const muts = r?.rows[6];
    expect(muts?.kind === 'row' && muts.p).toMatchObject({ result: 'RED', children: [{ title: 'AC1-remove', result: 'RED' }, { title: 'AC2-cap (the tdd check\'s class stands)', result: 'RED' }] });
    expect(l?.after.map((p) => `${p.title} ${p.result} ${p.reason}`)).toEqual(["Merge into epic/cards MERGED post-merge baseline SKIPPED — the round's baseline stands"]);
  });

  it('an open launch whose pid is gone died; one whose pid runs is running', () => {
    const open = LOG.filter((e) => ms(e.ts) <= ms(T('11:20:00')));
    const s = story({ status: 'in_progress', landing: 'in_progress', history: story().history.slice(0, 3) });
    const dead = storyLife({ story: s, events: open, machine: {}, baseBranch: 'develop', alive: new Set() });
    const L = (x: typeof dead): LaunchView | undefined => x.entries.find((e): e is { kind: 'launch'; l: LaunchView } => e.kind === 'launch')?.l;
    expect(L(dead)).toMatchObject({ state: 'dead', dead: { ts: null, why: 'pid 4242 is gone, and the launch wrote no end' } });
    expect(L(dead)?.rounds[0]?.rows.at(-1)).toMatchObject({ kind: 'row', p: { title: 'Baseline at a2e1d5ed', open: true, end: null } });
    const live = storyLife({ story: s, events: open, machine: {}, baseBranch: 'develop', alive: new Set([4242]) });
    expect(L(live)).toMatchObject({ state: 'running' });
  });

  it('a story from before the log: its launch from git, its round from the Machine block', () => {
    const past: FleetEvent[] = [
      { v: 1, ts: T('11:00:00'), run_id: 'k.135.G', repo: 'k', story: '135', span: 'launch', pass: 'launch', event: 'start', source: 'git' },
      { v: 1, ts: T('11:00:10'), run_id: 'k.135.M1', repo: 'k', story: '135', span: 'r1', round: 1, pass: 'round', event: 'start', source: 'machine' },
      { v: 1, ts: T('11:00:10'), run_id: 'k.135.M1', repo: 'k', story: '135', span: 'r1.build', round: 1, pass: 'builder', event: 'start', name: 'build', agent: 'claude', source: 'machine' },
      { v: 1, ts: T('11:16:00'), run_id: 'k.135.M1', repo: 'k', story: '135', span: 'r1.build', round: 1, pass: 'builder', event: 'end', name: 'build', agent: 'claude', approx: true, source: 'machine' },
      { v: 1, ts: T('11:29:00'), run_id: 'k.135.M1', repo: 'k', story: '135', round: 1, pass: 'verdict', event: 'mark', result: 'PASS', source: 'machine' },
      { v: 1, ts: T('11:29:00'), run_id: 'k.135.M1', repo: 'k', story: '135', span: 'r1', round: 1, pass: 'round', event: 'end', result: 'PASS', source: 'machine' },
      { v: 1, ts: T('11:30:00'), run_id: 'k.135.G', repo: 'k', story: '135', span: 'launch', pass: 'launch', event: 'end', result: 'PASS', source: 'git' },
    ];
    const life = storyLife({ story: story({ mergedAt: null, landedAt: null, history: story().history.slice(0, 4) }), events: past, machine: {}, baseBranch: 'develop', alive: new Set() });
    const l = life.entries.find((e): e is { kind: 'launch'; l: LaunchView } => e.kind === 'launch')?.l;
    expect(l).toMatchObject({ state: 'ended', start: { src: 'git' }, rounds: [{ n: 1, result: 'PASS', start: { src: 'machine' } }] });
    expect(l?.rounds[0]?.rows.map((x) => (x.kind === 'mark' ? x.m.title : `${x.p.title}${x.p.approx === true ? ' (approx)' : ''}`))).toEqual(['Builder (approx)', 'computed PASS']);
    expect(life.entries[0]).toMatchObject({ kind: 'row', p: { pass: 'writer', start: null, end: { ts: T('10:00:00'), src: 'git' } } });
  });
});

describe('storyLife, from the journal and the files', () => {
  const J = (ts: string, f: Partial<FleetEvent> & { pass: string; event: FleetEvent['event'] }): FleetEvent => ({ v: 1, ts, run_id: 'k.135.J', repo: 'k', story: '135', source: 'journal', ...f } as FleetEvent);
  const events: FleetEvent[] = [
    J(T('11:00:00'), { pass: 'launch', event: 'start', span: 'launch', pid: 77 }),
    J(T('11:00:01'), { pass: 'round', event: 'start', span: 'r1', round: 1 }),
    J(T('11:01:00'), { pass: 'tdd', event: 'start', span: 'r1.tdd.1.AC1-x', round: 1, name: 'AC1-x', check: 1 }),
    J(T('11:02:00'), { pass: 'tdd', event: 'end', span: 'r1.tdd.1.AC1-x', round: 1, name: 'AC1-x', result: 'RED' }),
    J(T('11:02:00'), { pass: 'tdd', event: 'start', span: 'r1.tdd.1.AC2-y', round: 1, name: 'AC2-y', check: 1 }),
    J(T('11:03:00'), { pass: 'tdd', event: 'end', span: 'r1.tdd.1.AC2-y', round: 1, name: 'AC2-y', result: 'RED' }),
    // The Machine block's whole mutation phase, and each mutation from its file's time.
    { v: 1, ts: T('11:10:00'), run_id: 'k.135.M', repo: 'k', story: '135', span: 'r1.mut', round: 1, pass: 'mutation', event: 'start', name: 'all', source: 'machine' },
    { v: 1, ts: T('11:10:00'), run_id: 'k.135.M', repo: 'k', story: '135', span: 'r1.mut.AC1-a', round: 1, pass: 'mutation', event: 'start', name: 'AC1-a', source: 'machine' },
    { v: 1, ts: T('11:11:00'), run_id: 'k.135.M', repo: 'k', story: '135', span: 'r1.mut.AC1-a', round: 1, pass: 'mutation', event: 'end', name: 'AC1-a', result: 'RED', source: 'mtime' },
    { v: 1, ts: T('11:12:00'), run_id: 'k.135.M', repo: 'k', story: '135', span: 'r1.mut', round: 1, pass: 'mutation', event: 'end', name: 'all', source: 'machine' },
    J(T('11:12:00'), { pass: 'verdict', event: 'mark', round: 1, result: 'PASS' }),
    J(T('11:12:00'), { pass: 'round', event: 'end', span: 'r1', round: 1, result: 'PASS' }),
    J(T('11:12:01'), { pass: 'launch', event: 'end', span: 'launch', result: 'PASS' }),
    // The queue's merge, another process: its lines are the merge's.
    J(T('11:12:30'), { pass: 'merge', event: 'start', span: 'merge', run_id: 'k.135.Q', into: 'epic/cards' }),
    J(T('11:12:31'), { pass: 'baseline', event: 'mark', run_id: 'k.135.Q', name: 'merge', result: 'SKIPPED', reason: 'the round stands' }),
    J(T('11:12:40'), { pass: 'merge', event: 'end', span: 'merge', run_id: 'k.135.Q', into: 'epic/cards', result: 'MERGED' }),
  ];
  const life = storyLife({ story: story({ mergedAt: null, landedAt: null, history: story().history.slice(0, 4) }), events, machine: {}, baseBranch: 'develop', alive: new Set() });
  const l = life.entries.find((e): e is { kind: 'launch'; l: LaunchView } => e.kind === 'launch')?.l;

  it('a merge\'s own lines are the merge\'s, not the launch\'s', () => {
    expect(l?.pre).toEqual([]);
    expect(l?.after.map((p) => `${p.title} ${p.result} · ${p.reason}`)).toEqual(['Merge into epic/cards MERGED · post-merge baseline SKIPPED — the round stands']);
  });

  it('the tdd check\'s pairs, and the mutations without the Machine block\'s total', () => {
    const rows = l?.rounds[0]?.rows.flatMap((x) => (x.kind === 'row' ? [x.p] : [])) ?? [];
    expect(rows.map((p) => `${p.title} ${p.result}`)).toEqual(['tdd check — 2 pairs RED', 'AC1-a RED']);
  });
});

const ms = (iso: string): number => Date.parse(iso);
