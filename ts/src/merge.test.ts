import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Die } from './lib/die.ts';
import { USAGE, logIdOf, parseArgs, refusal, seedMergeWorktree } from './merge.ts';
import { DASH, type StoryRow } from './status.ts';

// The pure parts of `fleet merge`; the flow itself is proven by test/suite.sh
// (cases 56-59, 74, 75, 91, 92, 118-122, 125), as the launcher's is.

describe('parseArgs', () => {
  it.each([
    [['900'], { mode: 'story', id: '900', land: false }],
    [['900', '--land'], { mode: 'story', id: '900', land: true }],
    [['--land', '900'], { mode: 'story', id: '900', land: true }],
    [['--epic', 'epic/x'], { mode: 'epic', id: 'epic/x', land: false }],
  ] as const)('%j', (argv, expected) => {
    expect(parseArgs(argv, 'develop')).toEqual(expected);
  });

  it.each([
    [[], USAGE],
    [['900', '901'], USAGE],
    [['--epic'], USAGE],
    [['--bogus'], `unknown option --bogus — ${USAGE}`],
    [['--epic', 'develop'], "--epic takes an epic/... branch, not 'develop'"],
    [['--epic', 'epic/x', '--land'], '--epic already lands on develop; --land is for a story'],
  ] as const)('%j → die', (argv, message) => {
    expect(() => parseArgs(argv, 'develop')).toThrow(new Die(message));
  });
});

describe('logIdOf — ${ID//\\//-}', () => {
  it('a story id is itself; an epic name has its slash replaced', () => {
    expect(logIdOf('900')).toBe('900');
    expect(logIdOf('epic/ui-a11y')).toBe('epic-ui-a11y');
    expect(logIdOf('a/b/c')).toBe('a-b-c');
  });
});

describe('refusal — the checks, in the order they are made', () => {
  const row = (o: Partial<StoryRow>): StoryRow => ({
    id: '900', title: 't', status: 'done', landing: 'awaiting merge', round: '1', verdict: 'PASS', base: 'epic/x',
    branch: 'story/900', merged: false, ahead: 1, worktree: true, live: false, blocked: false, reasons: '', notes: [], ...o,
  });
  const ctx = { id: '900', land: false, baseBranch: 'develop', repoName: 'khaita' };
  const die = (message: string) => ({ kind: 'die', message });

  it.each([
    ['not done', row({ status: 'needs_human' }), ctx, die('900 is needs_human, not done — nothing to merge')],
    ['not PASS', row({ verdict: 'FAIL' }), ctx, die('900 computed FAIL, not PASS — the machine vetoed it')],
    ['no review file', row({ verdict: DASH }), ctx, die('900 has no .review/900.md — nothing computed a PASS')],
    ['no verdict line', row({ verdict: '' }), ctx, die("900's review has no verdict line — nothing computed a PASS")],
    ['live', row({ live: true }), ctx, die('900 has something running in its worktree')],
    ['no branch', row({ branch: DASH }), ctx, die('900 has no branch')],
    ['--land on an epic story, before "already merged" can answer', row({ merged: true }), { ...ctx, land: true },
      die('900 lives on epic/x, not on develop — land its epic: fleet merge khaita --epic epic/x')],
    ['already merged', row({ merged: true }), ctx, { kind: 'already' }],
    ['based on main', row({ base: 'main' }), ctx, die('900 is based on main — main is never merged here, --land or not')],
    ['based on master, --land or not', row({ base: 'master' }), { ...ctx, land: true }, die('900 is based on master — main is never merged here, --land or not')],
    ['the integration branch without --land', row({ base: 'develop' }), ctx,
      die('900 is based on develop — the integration branch is merged by a human: fleet merge khaita 900 --land, or /merge khaita 900')],
    ['the integration branch with --land', row({ base: 'develop' }), { ...ctx, land: true }, { kind: 'go' }],
    ['an epic story: go', row({}), ctx, { kind: 'go' }],
    ['order: status before verdict before live', row({ status: 'ready', verdict: 'FAIL', live: true }), ctx, die('900 is ready, not done — nothing to merge')],
  ])('%s', (_name, r, c, expected) => {
    expect(refusal(r, c)).toEqual(expected);
  });
});

// A seed file the checkout has is copied into the merge worktree; one it
// does not have is skipped. Where the copy itself fails (the worktree lacks
// the parent directory) it dies, as the launcher does for its trees.
describe('seedMergeWorktree', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-merge-seed-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('copies what exists, skips what does not, dies when the copy fails', () => {
    const root = join(dir, 'root'); const mwt = join(dir, 'mwt');
    mkdirSync(root); mkdirSync(mwt);
    writeFileSync(join(root, '.env.local'), 'A=1\n');
    seedMergeWorktree(root, mwt, ['.env.local', 'missing.env']);
    expect(readFileSync(join(mwt, '.env.local'), 'utf8')).toBe('A=1\n');
    mkdirSync(join(root, 'sub')); writeFileSync(join(root, 'sub/x.env'), 'B=2\n');
    expect(() => seedMergeWorktree(root, mwt, ['sub/x.env'])).toThrow(/cannot copy seed file sub\/x.env/);
  });
});
