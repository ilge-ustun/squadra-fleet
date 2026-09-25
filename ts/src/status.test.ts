import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from './lib/proc.ts';
import { DASH, byCodePoint, landingOf, listDir, nextReady, storyIds, titleOf } from './status.ts';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-statusw-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('landingOf — the table in status.sh\'s header', () => {
  const base = { branch: 'story/1', base: 'base', baseBranch: 'base', intoInBase: () => false };
  it.each([
    ['draft', { status: 'draft', merged: false, verdict: 'PASS' }, 'draft'],
    ['in_progress stays whatever git says', { status: 'in_progress', merged: true, verdict: 'PASS' }, 'in_progress'],
    ['done + merged into the base', { status: 'done', merged: true, verdict: 'PASS' }, 'landed'],
    ['done + merged into an epic not in the base', { status: 'done', merged: true, verdict: 'PASS', base: 'epic/x' }, 'on epic'],
    ['done + merged into an epic that is in the base', { status: 'done', merged: true, verdict: 'FAIL', base: 'epic/x', intoInBase: () => true }, 'landed'],
    ['done + PASS + a branch', { status: 'done', merged: false, verdict: 'PASS' }, 'awaiting merge'],
    ['done + PASS + no branch: nothing to merge', { status: 'done', merged: false, verdict: 'PASS', branch: DASH }, 'done'],
    ['done + FAIL nobody merged', { status: 'done', merged: false, verdict: 'FAIL' }, 'done'],
    ['done + empty verdict', { status: 'done', merged: false, verdict: '' }, 'done'],
  ])('%s', (_name, over, expected) => {
    expect(landingOf({ ...base, ...over })).toBe(expected);
  });

  it('asks whether the epic is in the base only when that decides anything', () => {
    let asked = 0;
    landingOf({ ...base, status: 'done', merged: true, verdict: 'PASS', intoInBase: () => { asked++; return true; } });
    landingOf({ ...base, status: 'done', merged: false, verdict: 'PASS', base: 'epic/x', intoInBase: () => { asked++; return true; } });
    expect(asked).toBe(0);
  });
});

describe('storyIds — ls .stories/*.md | sort, under C.UTF-8', () => {
  it('sorts the filenames, .md on: 900-b.md < 900.md < 9000.md; skips TEMPLATE, dotfiles and other extensions', () => {
    const root = join(dir, 'order');
    mkdirSync(join(root, '.stories'), { recursive: true });
    for (const n of ['9000.md', '900.md', '900-b.md', 'TEMPLATE.md', '.draft.md', 'notes.txt', '10.md']) {
      writeFileSync(join(root, '.stories', n), '');
    }
    const ids = storyIds(root);
    expect(ids).toEqual(['10', '900-b', '900', '9000']);
    const ls = runSync('bash', ['-c', 'ls -1 "$1"/.stories/*.md | sort | xargs -n1 basename', '_', root], {
      env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    }).stdout.trim().split('\n').map((n) => n.slice(0, -3)).filter((n) => n !== 'TEMPLATE');
    expect(ids).toEqual(ls);
  });

  it('no .stories directory: no ids', () => {
    expect(storyIds(join(dir, 'nowhere'))).toEqual([]);
  });

  it('byCodePoint orders astral characters after the BMP, as bytes do (a bare sort() would not)', () => {
    const a = '\u{1F600}'; // U+1F600, UTF-16 D83D DE00
    const b = '�';    // U+FFFD
    expect(byCodePoint(a, b)).toBeGreaterThan(0);
    expect([a, b].sort()).toEqual([a, b]);
    expect([a, b].sort(byCodePoint)).toEqual([b, a]);
  });
});

describe('nextReady — the one choice a bare launch and the queue both make', () => {
  const write = (root: string, id: string, status: string): void => {
    mkdirSync(join(root, '.stories'), { recursive: true });
    writeFileSync(join(root, '.stories', `${id}.md`), `---\nstatus: ${status}\nround: 0\n---\n`);
  };

  it('the first ready story, by storyIds() order', () => {
    const root = join(dir, 'nextready-order');
    write(root, '900', 'done');
    write(root, '901', 'ready');
    write(root, '902', 'ready');
    expect(nextReady(root)).toBe('901');
  });

  it('nothing ready: empty string', () => {
    const root = join(dir, 'nextready-none');
    write(root, '900', 'done');
    expect(nextReady(root)).toBe('');
  });

  it("TEMPLATE.md is never picked, even when its own status is ready — a real state, not a hypothetical one", () => {
    const root = join(dir, 'nextready-template');
    write(root, 'TEMPLATE', 'ready');
    expect(nextReady(root)).toBe('');
  });

  it('no .stories directory: empty string, not a throw', () => {
    expect(nextReady(join(dir, 'nextready-missing'))).toBe('');
  });
});

describe('listDir — ls -1 of the evidence directory', () => {
  it('names without dotfiles, code-point order; undefined for a file or nothing', () => {
    const ev = join(dir, 'ev');
    mkdirSync(ev);
    for (const n of ['round_1', 'Round-3', '.hidden', 'builder.md', 'round-1', 'round.1']) writeFileSync(join(ev, n), '');
    expect(listDir(ev)).toEqual(['Round-3', 'builder.md', 'round-1', 'round.1', 'round_1']);
    expect(listDir(join(ev, 'round_1'))).toBeUndefined();
    expect(listDir(join(dir, 'nope'))).toBeUndefined();
  });
});

describe('titleOf — status.sh:76-78, against the awk', () => {
  const AWK = '/^# / { sub(/^# +/, ""); sub(/^[Ss]tory +[0-9]+[[:space:]]*[:—-]+[[:space:]]*/, ""); print; exit }';
  function awk(text: string): string {
    const p = join(dir, 'title.md');
    writeFileSync(p, text);
    return runSync('awk', [AWK, p], { env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } }).stdout.replace(/\n$/, '');
  }
  it.each([
    ['colon', '# Story 900: fixture story\n', 'fixture story'],
    ['em dash, no space before it', '# Story 9000— Über\n', 'Über'],
    ['hyphen, lower case', '# story 902 - lower\n', 'lower'],
    ['mixed punctuation run', '# Story 12 :—- mixed\n', 'mixed'],
    ['many spaces after the hash', '#   Two spaces\n', 'Two spaces'],
    ['no number: the prefix stays', '# Story: no number\n', 'Story: no number'],
    ['no space after the hash is not a heading', '#Story 1: x\n# real\n', 'real'],
    ['## is not the title; the first # line is, wherever it is', '---\nstatus: x\n---\n## sub\n# Title\n', 'Title'],
    ['nothing', 'plain text\n', ''],
    ['a heading with only the prefix', '# Story 5:\n', ''],
  ])('%s', (_name, text, expected) => {
    expect(titleOf(text)).toBe(expected);
    expect(titleOf(text)).toBe(awk(text));
  });
});
