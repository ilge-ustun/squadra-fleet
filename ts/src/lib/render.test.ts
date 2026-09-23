import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSync } from './proc.ts';
import { RenderError, leftoverLine, renderPrompt, type RenderVars } from './render.ts';

// render.sh, sourced in a child bash exactly as case 10 does it, is the
// oracle: the same file, the same values, the same bytes out — or the same
// die. write-story.sh still uses render.sh, so the two must stay equal.
const RENDER_SH = resolve(import.meta.dirname, '../../../render.sh');
const SCRIPT =
  'render="$1"; PROMPTS_DIR="$2"; f="$3"; shift 3\n' +
  'die(){ echo "XX $1" >&2; exit 1; }; warn(){ echo "!! $1"; }\n' +
  'source "$render"\n' +
  'for kv in "$@"; do printf -v "${kv%%=*}" "%s" "${kv#*=}"; done\n' +
  'render_prompt "$f"';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-render-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function prompt(name: string, text: string): string {
  writeFileSync(join(dir, name), text);
  return name;
}
function bash(promptsDir: string, file: string, vars: RenderVars): { rc: number; stdout: string; stderr: string } {
  const r = runSync('bash', ['-c', SCRIPT, '_', RENDER_SH, promptsDir, file, ...Object.entries(vars).map(([k, v]) => `${k}=${v}`)],
    { env: { PATH: process.env['PATH'] ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
  return { rc: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** Both sides: the TS result rendered the way the bash shim prints it. */
function both(file: string, vars: RenderVars): { ts: string; sh: string } {
  const b = bash(dir, file, vars);
  let ts: string;
  try {
    const r = renderPrompt(dir, file, vars);
    ts = (r.leftover.length > 0 ? `!! ${leftoverLine(file, r.leftover)}\n` : '') + r.text;
  } catch (e) {
    if (!(e instanceof RenderError)) throw e;
    ts = `XX ${e.message}\n`;
    expect(b.rc).toBe(1);
    return { ts, sh: b.stderr };
  }
  expect(b.rc).toBe(0);
  return { ts, sh: b.stdout };
}

const ALL: RenderVars = {
  STORY_ID: '900', RULES: 'R', REVIEW_TEXT: 'V', STORY_TEXT: 'S', INTENT: 'I', STORY_BASE: 'base', HEAD_SHA: 'h', BASE_SHA: 'b',
  ROUND: '2', REPO_RULES_TEXT: 'RR', VITEST_CMD: 'vt', BUILD_CMD: 'bd', LINT_CMD: 'lt', CHECK_MUTATION: 'cm',
};

describe('renderPrompt — render.sh, byte for byte', () => {
  it('every placeholder, and a trailing newline stripped as $(cat) strips it', () => {
    const f = prompt('all.md', '{{STORY_ID}} {{RULES}} {{REVIEW_TEXT}} {{STORY}} {{INTENT}} {{STORY_BASE}} {{HEAD_SHA}} {{BASE_SHA}} {{ROUND}} {{REPO_RULES}} {{VITEST_CMD}} {{BUILD_CMD}} {{LINT_CMD}} {{CHECK_MUTATION}}\n\n\n');
    const { ts, sh } = both(f, ALL);
    expect(ts).toBe('900 R V S I base h b 2 RR vt bd lt cm');
    expect(ts).toBe(sh);
  });

  it('order is the contract: a value inserted early is subject to the later replacements, not the earlier ones', () => {
    const f = prompt('order.md', 'A {{RULES}} B {{REVIEW_TEXT}}');
    const { ts, sh } = both(f, { ...ALL, RULES: 'round={{ROUND}}', REVIEW_TEXT: 'id={{STORY_ID}}' });
    expect(ts).toBe('!! unsubstituted in order.md: {{STORY_ID}} \nA round=2 B id={{STORY_ID}}');
    expect(ts).toBe(sh);
  });

  it('a value is inserted literally — &, \\&, \\\\, $& and $1 survive (the patsub_replacement finding)', () => {
    const f = prompt('amp.md', 'S={{STORY}} R={{REVIEW_TEXT}}');
    const { ts, sh } = both(f, { ...ALL, STORY_TEXT: 'R&D uses && and a \\& and \\\\', REVIEW_TEXT: 'cost $& or $1' });
    expect(ts).toBe('S=R&D uses && and a \\& and \\\\ R=cost $& or $1');
    expect(ts).toBe(sh);
  });

  it('a value with newlines and unicode', () => {
    const f = prompt('nl.md', '# {{STORY_ID}}\n{{STORY}}\nend');
    const { ts, sh } = both(f, { ...ALL, STORY_TEXT: 'line 1\n\nline 3 — Über' });
    expect(ts).toBe('# 900\nline 1\n\nline 3 — Über\nend');
    expect(ts).toBe(sh);
  });

  it('{{STORY}} is never guarded: the die list says STORY_TEXT, which no file uses (parity, pinned)', () => {
    const f = prompt('story-empty.md', 'S=[{{STORY}}] end');
    const { ts, sh } = both(f, { ...ALL, STORY_TEXT: '' });
    expect(ts).toBe('S=[] end');
    expect(ts).toBe(sh);
  });

  it('case 10: an empty placeholder the file uses dies, naming it', () => {
    const f = prompt('a.md', 'id {{STORY_ID}}\n');
    const { ts, sh } = both(f, { STORY_ID: '' });
    expect(ts).toBe('XX a.md uses {{STORY_ID}} but STORY_ID is empty\n');
    expect(ts).toBe(sh);
    const d = prompt('d.md', 'run {{VITEST_CMD}}\n');
    const r = both(d, { VITEST_CMD: '' });
    expect(r.ts).toBe('XX d.md uses {{VITEST_CMD}} but VITEST_CMD is empty\n');
    expect(r.ts).toBe(r.sh);
  });

  it('case 10: an unknown placeholder is warned about, not fatal; {{}} counts', () => {
    const f = prompt('b.md', 'x {{NOPE}} {{}} {{NOPE}} {{ALSO_X}}\n');
    const { ts, sh } = both(f, { STORY_ID: '900' });
    expect(ts).toBe('!! unsubstituted in b.md: {{ALSO_X}} {{NOPE}} {{}} \nx {{NOPE}} {{}} {{NOPE}} {{ALSO_X}}');   // sort -u, code point: } after Z
    expect(ts).toBe(sh);
  });

  it('case 10: an empty REPO_RULES is legal and substitutes to nothing', () => {
    const f = prompt('c.md', 'rules {{REPO_RULES}} end\n');
    const { ts, sh } = both(f, { REPO_RULES_TEXT: '' });
    expect(ts).toBe('rules  end');
    expect(ts).toBe(sh);
  });

  it('the guard reads the source: a placeholder that arrives through a value is not guarded — a later replacement empties it', () => {
    const f = prompt('via.md', '{{RULES}}');
    const { ts, sh } = both(f, { RULES: 'x {{VITEST_CMD}}', VITEST_CMD: '' });
    expect(ts).toBe('x ');
    expect(ts).toBe(sh);
  });

  it('a prompt that renders to nothing dies', () => {
    const f = prompt('e.md', '{{REPO_RULES}}\n');
    const { ts, sh } = both(f, { REPO_RULES_TEXT: '' });
    expect(ts).toBe('XX rendered prompt is empty: e.md\n');
    expect(ts).toBe(sh);
  });

  it('a missing prompt file dies (bash also shows cat\'s own line first; this side has only the die)', () => {
    const { ts, sh } = both('nope.md', ALL);
    expect(ts).toBe('XX prompt not found: nope.md\n');
    expect(sh).toMatch(/^cat: .*No such file or directory\nXX prompt not found: nope\.md\n$/);
  });

  it('the real prompt files render with fixture-like values, no leftovers, equal to bash', () => {
    const real = resolve(import.meta.dirname, '../../../prompts');
    const vars: RenderVars = { ...ALL, RULES: 'RULES-TEXT', REVIEW_TEXT: 'REVIEW', STORY_TEXT: '# Story 900\n\n**AC1 — a**' };
    for (const f of ['rules.md', 'build-round1.md', 'build-round2.md', 'build-after-spec.md', 'review.md']) {
      const r = renderPrompt(real, f, vars);
      expect(r.leftover, f).toEqual([]);
      const b = bash(real, f, vars);
      expect(b.rc, f).toBe(0);
      expect(r.text, f).toBe(b.stdout);
    }
  });
});
