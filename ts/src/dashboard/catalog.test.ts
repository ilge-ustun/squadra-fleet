import { describe, expect, it } from 'vitest';
import type { FleetEvent } from '../lib/events.ts';
import type { Status, StoryRow } from '../status.ts';
import { catalogRepo, historyOf, machineTexts, parseStoryText, roundsOf } from './catalog.ts';

const ev = (ts: string, f: Partial<FleetEvent> & { pass: string; event: FleetEvent['event'] }): FleetEvent => ({ v: 1, ts, run_id: 'r', repo: 'k', source: 'git', ...f });
const mark = (ts: string, story: string, name: string, reason: string, extra: Partial<FleetEvent> = {}): FleetEvent => ev(ts, { pass: 'status', event: 'mark', story, name, reason, ...extra });

const STORY = `---
status: done
round: 1
base: epic/cards
model: opus
---

# Story 135: Each line's title row ends at its last card

## Symptom

On a wide screen the title row runs to the page edge
while the cards stop early.

Second paragraph.

## Acceptance criteria

**AC1 — The title row ends at the last card's slot.** Goes red when removed.
**AC2 — An empty line keeps a page-wide row.** Goes red when removed.
`;

const REVIEW = `# Review: 135

verdict: PASS
rounds: 1 of 2

## Round 1 — PASS

head: a2e1d5edc27c1ca5764e5f53f14e0f6236dd19dc
reviewed: 2026-10-22T02:47:38+02:00

### Machine

baseline: test GREEN | build GREEN | lint GREEN | e2e GREEN
timing:   builder 963s | baseline 232s | reviewer 67s | mutations 255s | total 1554s
builder:  opus → claude-opus-5-5
reviewer: codex → gpt-6.1-sol
computed: PASS —
mutations:
AC1  RED           remove-sizing
AC2  GREEN         narrow-empty


### Builder said

It is built.
`;

const row = (id: string, o: Partial<StoryRow> = {}): StoryRow => ({
  id, title: 'Each line\'s title row ends at its last card', status: 'done', landing: 'landed', round: '1', verdict: 'PASS', base: 'epic/cards',
  branch: `story/${id}`, merged: true, ahead: 0, worktree: false, live: false, blocked: false, reasons: '', notes: [], ...o,
});

describe('parseStoryText', () => {
  it('reads the model, the criteria and the first paragraph of the Symptom', () => {
    expect(parseStoryText(STORY)).toEqual({
      model: 'opus',
      acs: [{ id: 'AC1', claim: "The title row ends at the last card's slot" }, { id: 'AC2', claim: 'An empty line keeps a page-wide row' }],
      symptom: 'On a wide screen the title row runs to the page edge while the cards stop early.',
    });
  });
});

describe('roundsOf and machineTexts', () => {
  it('reads each round: timing, models, verdict, reasons and the mutation rows', () => {
    expect(roundsOf(REVIEW)).toEqual([{
      n: 1, head: 'a2e1d5ed', reviewed: '2026-10-22T02:47:38+02:00', computed: 'PASS', reasons: [],
      timing: { builder: 963, baseline: 232, reviewer: 67, mutations: 255, total: 1554 },
      builderModel: 'opus', builderUsed: 'claude-opus-5-5', reviewerCli: 'codex', reviewerUsed: 'gpt-6.1-sol',
      baseline: 'test GREEN | build GREEN | lint GREEN | e2e GREEN',
      mutations: [{ ac: 'AC1', cls: 'RED', name: 'remove-sizing' }, { ac: 'AC2', cls: 'GREEN', name: 'narrow-empty' }],
    }]);
  });

  it('keeps each round\'s Machine block, up to the next heading', () => {
    const m = machineTexts(REVIEW);
    expect(Object.keys(m)).toEqual(['1']);
    expect(m[1]).toMatch(/^baseline: test GREEN/);
    expect(m[1]).toMatch(/AC2 {2}GREEN {9}narrow-empty$/);
  });
});

describe('historyOf', () => {
  it('turns the status marks into kinds: a promotion and an answer are their own', () => {
    const h = historyOf([
      mark('2026-10-21T10:00:00.000+02:00', '135', 'draft', 'draft'),
      mark('2026-10-21T10:00:00.000+02:00', '135', 'ready', 'promoted to ready (telegram)', { by: 'telegram' }),
      mark('2026-10-21T11:00:00.000+02:00', '135', 'in_progress', 'in_progress'),
      mark('2026-10-21T11:30:00.000+02:00', '135', 'blocked', 'blocked'),
      mark('2026-10-21T12:00:00.000+02:00', '135', 'ready', 'answered, back to ready (telegram)'),
      mark('2026-10-21T12:00:00.000+02:00', '136', 'ready', 'ready'),
      ev('2026-10-21T12:10:00.000+02:00', { pass: 'launch', event: 'start', story: '135' }),
      mark('2026-10-21T13:00:00.000+02:00', '135', 'merged', 'merged into epic/cards at 1a2b3c4d', { into: 'epic/cards', sha: '1a2b3c4d' }),
    ], '135');
    expect(h.map((x) => x.kind)).toEqual(['draft', 'promoted', 'in_progress', 'blocked', 'answered', 'merged']);
    expect(h[1]).toEqual({ ts: '2026-10-21T10:00:00.000+02:00', kind: 'promoted', msg: 'promoted to ready (telegram)', src: 'git', by: 'telegram' });
    expect(h[5]).toMatchObject({ kind: 'merged', into: 'epic/cards', sha: '1a2b3c4d' });
  });
});

describe('catalogRepo', () => {
  const events: FleetEvent[] = [
    ev('2026-10-20T09:00:00.000+02:00', { pass: 'epic', event: 'mark', epic: 'epic/cards', name: 'created', sha: '70aad19e' }),
    ev('2026-10-21T09:59:00.000+02:00', { pass: 'writer', event: 'start', story: '135', intent: 'make the title row end at the cards', model: 'opus', source: 'log' }),
    mark('2026-10-21T10:00:00.000+02:00', '135', 'draft', 'draft'),
    mark('2026-10-21T10:01:00.000+02:00', '135', 'ready', 'promoted to ready (coordinator)'),
    mark('2026-10-21T11:01:00.000+02:00', '135', 'in_progress', 'in_progress'),
    mark('2026-10-22T02:48:00.000+02:00', '135', 'done', 'done'),
    mark('2026-10-22T02:49:00.000+02:00', '135', 'merged', 'merged into epic/cards at 1a2b3c4d', { into: 'epic/cards', sha: '1a2b3c4d' }),
    ev('2026-10-22T09:00:00.000+02:00', { pass: 'epic_merge', event: 'mark', epic: 'epic/cards', result: 'MERGED', into: 'develop', sha: 'beefbeef' }),
    mark('2026-10-23T09:00:00.000+02:00', '140', 'draft', 'draft'),
  ];
  const status: Status = {
    epics: [{ name: 'epic/cards', total: 1, merged: 1, ahead: 0, exists: true }],
    stories: [row('135'), row('140', { title: 'Next', status: 'draft', landing: 'draft', round: '—', verdict: '—', base: 'develop', branch: '—', merged: false })],
  };
  const files = (id: string): { story: string; review?: string; blocked?: string } => (id === '135' ? { story: STORY, review: REVIEW } : { story: '---\nstatus: draft\n---\n\n# Story 140: Next\n' });
  const R = catalogRepo({ name: 'khaita', baseBranch: 'develop', status, events, files, usage: () => ({ turns: 56, costUsd: 2.97 }) });

  it('derives each story\'s times from its history and its epic\'s land', () => {
    const s = R.stories.find((x) => x.id === '135');
    expect(s).toMatchObject({
      epic: 'epic/cards', round: 1, model: 'opus', verdict: 'PASS', landing: 'landed',
      readyAt: '2026-10-21T10:01:00.000+02:00', pickedAt: '2026-10-21T11:01:00.000+02:00', queueWaitS: 3600,
      draftAt: '2026-10-21T10:00:00.000+02:00', doneAt: '2026-10-22T02:48:00.000+02:00', mergedAt: '2026-10-22T02:49:00.000+02:00',
      landedAt: '2026-10-22T09:00:00.000+02:00', landedHow: 'epic merge',
      intent: { text: 'make the title row end at the cards', ts: '2026-10-21T09:59:00.000+02:00', src: 'log', model: 'opus' },
    });
    expect(s?.rounds[0]).toMatchObject({ n: 1, turns: 56, costUsd: 2.97 });
  });

  it('a story with no epic and no verdict yet', () => {
    expect(R.stories.find((x) => x.id === '140')).toMatchObject({ epic: null, round: null, verdict: null, rounds: [], intent: null, landedAt: null });
  });

  it('lists each epic with its creation, its lands and its stories', () => {
    expect(R.epics).toEqual([{
      name: 'epic/cards', exists: true, ahead: 0, stories: ['135'],
      created: { ts: '2026-10-20T09:00:00.000+02:00', src: 'git', sha: '70aad19e' },
      lands: [{ ts: '2026-10-22T09:00:00.000+02:00', src: 'git', sha: 'beefbeef', into: 'develop' }],
    }]);
  });
});
