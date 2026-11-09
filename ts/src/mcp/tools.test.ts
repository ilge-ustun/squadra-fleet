import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, type RepoConfig } from '../lib/config.ts';
import type { FleetEvent } from '../lib/events.ts';
import type { EpicRow, Status, StoryRow } from '../status.ts';
import { ToolError, type Tool } from './server.ts';
import { fleetTools, type ToolDeps } from './tools.ts';

let root: string;
const cfg = (): RepoConfig => ({ name: 't', root, baseBranch: 'base' } as RepoConfig);
const row = (id: string, landing: string, base = 'base'): StoryRow => ({
  id, title: `Story ${id}`, status: ['landed', 'on epic', 'awaiting merge'].includes(landing) ? 'done' : landing, landing, round: '1',
  verdict: 'PASS', base, branch: '—', merged: landing === 'landed', ahead: 0, worktree: false, live: false, blocked: landing === 'blocked', reasons: '', notes: [],
});
const EPICS: EpicRow[] = [
  { name: 'epic/old', total: 2, merged: 2, ahead: 0, exists: true },
  { name: 'epic/new', total: 2, merged: 1, ahead: 3, exists: true },
];
const STATUS: Status = {
  epics: EPICS,
  stories: [row('900', 'landed'), row('901', 'ready', 'epic/new'), row('902', 'done'), row('903', 'declined'), row('904', 'blocked'), row('905', 'on epic', 'epic/new')],
};
const T = (hms: string): string => `2026-10-22T${hms}.000+02:00`;
const ev = (ts: string, f: Partial<FleetEvent> & { pass: string; event: FleetEvent['event'] }): FleetEvent => ({ v: 1, ts, run_id: 't.901.L1', repo: 't', story: '901', source: 'log', ...f } as FleetEvent);
const EVENTS: FleetEvent[] = [
  ev(T('10:00:00'), { pass: 'status', event: 'mark', source: 'git', run_id: 't.900.git', story: '900', name: 'ready', reason: 'promoted to ready' }),
  ev(T('11:00:00'), { pass: 'launch', event: 'start', span: 'launch', pid: 4242, epic: 'epic/new' }),
  ev(T('11:10:00'), { pass: 'verdict', event: 'mark', round: 1, result: 'PASS', epic: 'epic/new' }),
  ev(T('11:10:01'), { pass: 'launch', event: 'end', span: 'launch', result: 'PASS', dur_s: 601, epic: 'epic/new' }),
];

function deps(over: Partial<ToolDeps> = {}): ToolDeps {
  return {
    registry: () => ['t'],
    load: (name) => {
      if (name !== 't') throw new ConfigError(`no registry entry for ${name}`, false);
      return cfg();
    },
    status: (_c, one) => (one === undefined ? STATUS : { epics: EPICS, stories: STATUS.stories.filter((r) => r.id === one), detail: { block: '### Machine\nbaseline:  GREEN', evidence: ['round-1'] } }),
    events: () => EVENTS,
    alive: () => false,
    ...over,
  };
}
const tool = (name: string, d: ToolDeps = deps()): Tool => {
  const t = fleetTools(d).find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};
const json = (text: string): unknown => JSON.parse(text);

const REVIEW = `# Review: 901

verdict: PASS
rounds: 2 of 2
base: 0123abcd

## Round 1 — FAIL

head: aaaa
### Machine
baseline:  RED

## Round 2 — PASS

head: bbbb
### Machine
baseline:  GREEN
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-mcp-'));
  for (const d of ['.stories', '.review', '.blocked']) mkdirSync(join(root, d));
  for (const r of STATUS.stories) writeFileSync(join(root, '.stories', `${r.id}.md`), `---\nstatus: ${r.status}\n---\n\n# Story ${r.id}: t\n`);
  writeFileSync(join(root, '.review', '901.md'), REVIEW);
  writeFileSync(join(root, '.blocked', '904.md'), '# Question\n\nWhich colour?\n');
  writeFileSync(join(root, 'secret.txt'), 'not for agents\n');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('fleetTools', () => {
  it('has six tools, each with a schema that allows nothing it does not name', () => {
    const tools = fleetTools(deps());
    expect(tools.map((t) => t.name)).toEqual(['repos', 'status', 'story', 'verdict', 'events', 'latest']);
    for (const t of tools) expect(t.inputSchema.additionalProperties).toBe(false);
  });
});

describe('repos', () => {
  it('names each repo with its branch and its stories by state', () => {
    expect(json(tool('repos').call({}))).toEqual([{ name: 't', base_branch: 'base', stories: 6, by_state: { landed: 1, ready: 1, done: 1, declined: 1, blocked: 1, 'on epic': 1 } }]);
  });
  it('says why a repo cannot be read, and lists the others', () => {
    const d = deps({ registry: () => ['gone', 't'] });
    const out = json(tool('repos', d).call({})) as { name: string; error?: string }[];
    expect(out.map((r) => r.name)).toEqual(['gone', 't']);
    expect(out[0]?.error).toBe('no registry entry for gone');
  });
});

describe('status', () => {
  it('hides what asks nothing of anyone — landed, done, declined, and landed epics — and says how many', () => {
    const out = json(tool('status').call({ repo: 't' })) as { stories: { id: string }[]; epics: { name: string }[]; hidden: unknown };
    expect(out.stories.map((s) => s.id)).toEqual(['901', '904', '905']);
    expect(out.epics.map((e) => e.name)).toEqual(['epic/new']);
    expect(out.hidden).toEqual({ stories: 3, epics: 1, show_with: 'all: true' });
  });
  it('shows everything with all', () => {
    const out = json(tool('status').call({ repo: 't', all: true })) as { stories: unknown[]; epics: unknown[]; hidden?: unknown };
    expect(out.stories).toHaveLength(6);
    expect(out.epics).toHaveLength(2);
    expect(out.hidden).toBeUndefined();
  });
  it('shows one story with its Machine block and evidence, the row as fleet status --json writes it', () => {
    const out = json(tool('status').call({ repo: 't', id: '901' })) as Record<string, unknown>;
    expect(out['story']).toMatchObject({ id: '901', round: 1, verdict: 'PASS', base: 'epic/new' });
    expect(out['machine_block']).toBe('### Machine\nbaseline:  GREEN');
    expect(out['evidence']).toEqual(['round-1']);
  });
  it('refuses a repo the fleet does not serve, and names the ones it does', () => {
    expect(() => tool('status').call({ repo: 'x' })).toThrow(new ToolError("no repo 'x' — the fleet serves t"));
  });
  it('refuses a story the repo does not have', () => {
    expect(() => tool('status').call({ repo: 't', id: '999' })).toThrow(new ToolError("t has no story '999' — the status tool lists them"));
  });
});

describe('story', () => {
  it('answers the story file, and its open question when there is one', () => {
    expect(tool('story').call({ repo: 't', id: '901' })).toBe('.stories/901.md:\n\n---\nstatus: ready\n---\n\n# Story 901: t\n');
    expect(tool('story').call({ repo: 't', id: '904' })).toContain('.blocked/904.md:\n\n# Question\n\nWhich colour?\n');
  });
  it('reads only a file that is a story: an id is never a path', () => {
    for (const id of ['../secret.txt', '../secret', '/etc/passwd', '901/../../secret']) {
      expect(() => tool('story').call({ repo: 't', id })).toThrow(ToolError);
    }
  });
});

describe('verdict', () => {
  it('answers the head of the review and its last round', () => {
    const text = tool('verdict').call({ repo: 't', id: '901' });
    expect(text).toMatch(/^\.review\/901\.md, its head and round 2 \(it has rounds 1, 2\):\n\n# Review: 901\n\nverdict: PASS\n/);
    expect(text).toContain('## Round 2 — PASS\n\nhead: bbbb');
    expect(text).not.toContain('## Round 1');
  });
  it('answers the round asked for', () => {
    const text = tool('verdict').call({ repo: 't', id: '901', round: 1 });
    expect(text).toContain('## Round 1 — FAIL\n\nhead: aaaa');
    expect(text).not.toContain('## Round 2');
  });
  it('says which rounds there are when the one asked for is not', () => {
    expect(() => tool('verdict').call({ repo: 't', id: '901', round: 3 })).toThrow(new ToolError('.review/901.md has no round 3; it has rounds 1, 2'));
  });
  it('says so when a story has no review yet', () => {
    expect(() => tool('verdict').call({ repo: 't', id: '900' })).toThrow(new ToolError('900 has no review yet: no round of it has ended'));
  });
});

describe('events', () => {
  const lines = (text: string): string[] => text.split('\n').filter((l) => l !== '');
  it('answers a story\'s events, oldest first, one JSON object a line', () => {
    const out = lines(tool('events').call({ repo: 't', id: '901' }));
    expect(out[0]).toBe('# 3 events of t 901, oldest first');
    expect(out.slice(1).map((l) => (json(l) as FleetEvent).pass)).toEqual(['launch', 'verdict', 'launch']);
  });
  it('keeps the newest when it must cut, and says so', () => {
    const out = lines(tool('events').call({ repo: 't', limit: 2 }));
    expect(out[0]).toBe('# the last 2 of 4 events of t, oldest first');
    expect(out.slice(1).map((l) => (json(l) as FleetEvent).ts)).toEqual([T('11:10:00'), T('11:10:01')]);
  });
  it('takes an epic as well as a story', () => {
    expect(lines(tool('events').call({ repo: 't', id: 'epic/new' }))).toHaveLength(4);
  });
  it('asks the journal only when told to', () => {
    const asked: boolean[] = [];
    const d = deps({ events: (_c, journal) => { asked.push(journal); return EVENTS; } });
    tool('events', d).call({ repo: 't' });
    tool('events', d).call({ repo: 't', journal: true });
    expect(asked).toEqual([false, true]);
  });
});

describe('latest', () => {
  it('answers every repo\'s latest events, newest first', () => {
    const out = tool('latest').call({ limit: 2 }).split('\n').filter((l) => l !== '');
    expect(out[0]).toBe('# the latest 2 events of t, newest first; older ones exist');
    const items = out.slice(1).map((l) => json(l) as { pass: string; ts: string });
    expect(items.map((i) => i.pass)).toEqual(['launch', 'verdict']);
  });
});
