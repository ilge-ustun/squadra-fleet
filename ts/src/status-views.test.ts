import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadRepo, type RepoConfig } from './lib/config.ts';
import { runSync } from './lib/proc.ts';
import { DASH, statusOf, type StoryRow } from './status.ts';
import { renderEpics, renderJson, renderStatus, type ViewOptions } from './status-views.ts';

// The goldens are what the LAST BASH status.sh printed for make-target.sh's
// target (ts/fixtures/status/gen.sh, status.sh@14f675e, C.UTF-8). The same
// target is built here and rendered through the TypeScript; the bytes must
// be the same. No process runs in the worktrees in either run.
const FLEET_HOME = resolve(import.meta.dirname, '../..');
const FIXTURES = join(FLEET_HOME, 'ts/fixtures/status');

let dir: string;
let cfg: RepoConfig;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-status-'));
  const r = runSync('bash', [join(FIXTURES, 'make-target.sh'), join(dir, 't')]);
  if (r.status !== 0) throw new Error(`make-target.sh: ${r.stderr}`);
  const env: NodeJS.ProcessEnv = { FLEET_REGISTRY_DIR: join(dir, 't/repos') };
  for (const k of ['PATH', 'HOME']) if (process.env[k] !== undefined) env[k] = process.env[k];
  cfg = loadRepo(FLEET_HOME, 't', { env, captureStderr: true });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const noProcs = { procsInWorktree: () => [] as string[] };
type Flags = Partial<Pick<ViewOptions, 'json' | 'epics' | 'bot'>>;
const MODES: Record<string, Flags> = { default: {}, epics: { epics: true }, bot: { bot: true }, json: { json: true } };
function view(mode: string, all = false, one?: string): ViewOptions {
  const flags = mode.split('+').reduce<Flags>((f, m) => ({ ...f, ...MODES[m] }), {});
  return { json: false, epics: false, bot: false, ...flags, all, one, repoName: cfg.name, baseBranch: cfg.baseBranch };
}
function golden(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.expected.txt`), 'utf8');
}

describe('the ten views, byte for byte against the bash status.sh', () => {
  it.each([
    ['default', 'default', false, undefined],
    ['epics', 'epics', false, undefined],
    ['bot', 'bot', false, undefined],
    ['bot-all', 'bot', true, undefined],
    ['json', 'json', false, undefined],
    ['one', 'default', false, '900'],
    ['bot-one', 'bot', false, '900'],
    ['epics-bot', 'epics+bot', false, undefined],
    ['json-bot', 'json+bot', false, undefined],
    ['epics-json', 'epics+json', false, undefined],
  ] as const)('%s', (name, mode, all, one) => {
    const st = statusOf(cfg, one === undefined ? {} : { one }, noProcs);
    expect(renderStatus(st, view(mode, all, one))).toBe(golden(name));
  });
});

function row(over: Partial<StoryRow>): StoryRow {
  return {
    id: '1', title: 't', status: 'done', landing: 'done', round: DASH, verdict: DASH, base: 'base', branch: DASH,
    merged: false, ahead: 0, worktree: false, live: false, blocked: false, reasons: '', notes: [], ...over,
  };
}

describe('the edges the goldens cannot hold', () => {
  it('a live process makes the note RUNNING and live true', () => {
    const st = statusOf(cfg, { one: '900' }, { procsInWorktree: () => ['1'] });
    expect(st.stories[0]?.notes).toEqual(['RUNNING']);
    expect(st.stories[0]?.live).toBe(true);
    expect(renderJson(st.stories)).toContain('"live": true');
  });

  it('an unknown id: no rows, no detail; --json is []; --bot has no rows to show, so "no stories yet"', () => {
    const st = statusOf(cfg, { one: 'nope' }, noProcs);
    expect(st.stories).toEqual([]);
    expect(st.detail).toBeUndefined();
    expect(renderStatus(st, view('json'))).toBe('[]\n');
    expect(renderStatus(st, view('bot', false, 'nope'))).toMatch(/\nno stories yet\n$/);
  });

  it('everything landed and no --all: the bot points at /status-all', () => {
    const rows = [row({ landing: 'landed' }), row({ id: '2', landing: 'done' })];
    expect(renderStatus({ epics: [], stories: rows }, view('bot'))).toBe('nothing in flight — /status-all t shows what has landed\n');
  });

  it("bash's quirk, reproduced: widths in characters, padding in bytes — a lone — cell is two spaces short", () => {
    const out = renderStatus({ epics: [], stories: [row({ id: 'abc', title: '—' })] }, view('default'));
    // TITLE is 5 wide (the header); '—' is 3 bytes, so 2 spaces of padding, then the 2-space gap.
    expect(out.split('\n')[2]).toMatch(/^abc  —    \x1b\[0mdone  /);
  });

  it('no stories at all: the bot says so; the table is a header and a rule', () => {
    const empty = { epics: [], stories: [] };
    expect(renderStatus(empty, view('bot'))).toBe('no stories yet\n');
    expect(renderStatus(empty, view('epics'))).toBe('no story names an epic\n');
    const table = renderStatus(empty, view('default'));
    expect(table.split('\n')[0]).toBe('ID  TITLE  STATUS  R  VERDICT  INTO  NOTES');
    expect(table.split('\n')[1]).toBe(`\x1b[2m${'─'.repeat(2 + 5 + 6 + 1 + 7 + 4 + 12)}\x1b[0m`);
  });

  it('every landing colour (status.sh:51-59)', () => {
    const rows = ['landed', 'on epic', 'awaiting merge', 'needs_human', 'blocked', 'in_progress', 'draft'].map((l) => row({ landing: l }));
    const out = renderStatus({ epics: [], stories: rows }, view('default'));
    expect(out).toContain('\x1b[32mlanded        \x1b[0m');
    expect(out).toContain('\x1b[32mon epic       \x1b[0m');
    expect(out).toContain('\x1b[33mawaiting merge\x1b[0m');
    expect(out).toContain('\x1b[31mneeds_human   \x1b[0m');
    expect(out).toContain('\x1b[31mblocked       \x1b[0m');
    expect(out).toContain('\x1b[33min_progress   \x1b[0m');
    expect(out).toContain('\x1b[0mdraft         \x1b[0m');
  });

  it('non-parity, pinned: the epic state is not run through %b — a backslash stays a backslash', () => {
    const out = renderEpics([{ name: 'epic/a\\tb', total: 1, merged: 0, ahead: 1 }], view('default'), {
      red: '', grn: '', ylw: '', dim: '', rst: '',
    });
    expect(out).toBe('epic/a\\tb              1 story, 0 merged  1 ahead of base  → merge.sh t --epic epic/a\\tb\n');
  });

  it('non-parity, pinned: a verdict holding a quote keeps its JSON row (jq dropped it); DEL is raw', () => {
    const out = renderJson([row({ id: '1', verdict: 'PA"SS' }), row({ id: '2', title: 'a\x7fb' })]);
    const arr = JSON.parse(out) as Array<{ id: string; verdict: string | null; title: string }>;
    expect(arr.map((o) => o.id)).toEqual(['1', '2']);
    expect(arr[0]?.verdict).toBe('PA"SS');
    expect(out).toContain('a\x7fb');
  });

  it('round becomes a number only when it is digits; verdict null for the dash and for empty', () => {
    const out = renderJson([row({ round: '007', verdict: '' }), row({ round: 'x', verdict: DASH }), row({ round: '3', verdict: 'SPEC' })]);
    const arr = JSON.parse(out) as Array<{ round: number | null; verdict: string | null }>;
    expect(arr.map((o) => o.round)).toEqual([7, null, 3]);
    expect(arr.map((o) => o.verdict)).toEqual([null, null, 'SPEC']);
  });
});
