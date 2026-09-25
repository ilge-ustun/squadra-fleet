import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RenderError, leftoverLine, renderPrompt, type RenderVars } from './render.ts';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-render-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function prompt(name: string, text: string): string {
  writeFileSync(join(dir, name), text);
  return name;
}

/** The rendered text, or the thrown RenderError's XX line, or the
 *  unsubstituted-placeholder warning line prefixed to a successful render. */
function render(file: string, vars: RenderVars): string {
  try {
    const r = renderPrompt(dir, file, vars);
    return (r.leftover.length > 0 ? `!! ${leftoverLine(file, r.leftover)}\n` : '') + r.text;
  } catch (e) {
    if (!(e instanceof RenderError)) throw e;
    return `XX ${e.message}\n`;
  }
}

const ALL: RenderVars = {
  STORY_ID: '900', RULES: 'R', REVIEW_TEXT: 'V', STORY_TEXT: 'S', INTENT: 'I', STORY_BASE: 'base', HEAD_SHA: 'h', BASE_SHA: 'b',
  ROUND: '2', REPO_RULES_TEXT: 'RR', VITEST_CMD: 'vt', BUILD_CMD: 'bd', LINT_CMD: 'lt', CHECK_MUTATION: 'cm',
};

describe('renderPrompt', () => {
  it('every placeholder, and a trailing newline stripped as $(cat) strips it', () => {
    const f = prompt(
      'all.md',
      '{{STORY_ID}} {{RULES}} {{REVIEW_TEXT}} {{STORY}} {{INTENT}} {{STORY_BASE}} {{HEAD_SHA}} {{BASE_SHA}} {{ROUND}} {{REPO_RULES}} {{VITEST_CMD}} {{BUILD_CMD}} {{LINT_CMD}} {{CHECK_MUTATION}}\n\n\n',
    );
    expect(render(f, ALL)).toBe('900 R V S I base h b 2 RR vt bd lt cm');
  });

  it('order is the contract: a value inserted early is subject to the later replacements, not the earlier ones', () => {
    const f = prompt('order.md', 'A {{RULES}} B {{REVIEW_TEXT}}');
    expect(render(f, { ...ALL, RULES: 'round={{ROUND}}', REVIEW_TEXT: 'id={{STORY_ID}}' })).toBe(
      '!! unsubstituted in order.md: {{STORY_ID}} \nA round=2 B id={{STORY_ID}}',
    );
  });

  it('a value is inserted literally — &, \\&, \\\\, $& and $1 survive (L-28)', () => {
    const f = prompt('amp.md', 'S={{STORY}} R={{REVIEW_TEXT}}');
    expect(render(f, { ...ALL, STORY_TEXT: 'R&D uses && and a \\& and \\\\', REVIEW_TEXT: 'cost $& or $1' })).toBe(
      'S=R&D uses && and a \\& and \\\\ R=cost $& or $1',
    );
  });

  it('a value with newlines and unicode', () => {
    const f = prompt('nl.md', '# {{STORY_ID}}\n{{STORY}}\nend');
    expect(render(f, { ...ALL, STORY_TEXT: 'line 1\n\nline 3 — Über' })).toBe('# 900\nline 1\n\nline 3 — Über\nend');
  });

  it('{{STORY}} is never guarded: the die list says STORY_TEXT, which no file uses', () => {
    const f = prompt('story-empty.md', 'S=[{{STORY}}] end');
    expect(render(f, { ...ALL, STORY_TEXT: '' })).toBe('S=[] end');
  });

  it('an empty placeholder the file uses dies, naming it', () => {
    const f = prompt('a.md', 'id {{STORY_ID}}\n');
    expect(render(f, { STORY_ID: '' })).toBe('XX a.md uses {{STORY_ID}} but STORY_ID is empty\n');
    const d = prompt('d.md', 'run {{VITEST_CMD}}\n');
    expect(render(d, { VITEST_CMD: '' })).toBe('XX d.md uses {{VITEST_CMD}} but VITEST_CMD is empty\n');
  });

  it('an unknown placeholder is warned about, not fatal; {{}} counts', () => {
    const f = prompt('b.md', 'x {{NOPE}} {{}} {{NOPE}} {{ALSO_X}}\n');
    expect(render(f, { STORY_ID: '900' })).toBe('!! unsubstituted in b.md: {{ALSO_X}} {{NOPE}} {{}} \nx {{NOPE}} {{}} {{NOPE}} {{ALSO_X}}'); // sort -u, code point: } after Z
  });

  it('an empty REPO_RULES is legal and substitutes to nothing', () => {
    const f = prompt('c.md', 'rules {{REPO_RULES}} end\n');
    expect(render(f, { REPO_RULES_TEXT: '' })).toBe('rules  end');
  });

  it('the guard reads the source: a placeholder that arrives through a value is not guarded — a later replacement empties it', () => {
    const f = prompt('via.md', '{{RULES}}');
    expect(render(f, { RULES: 'x {{VITEST_CMD}}', VITEST_CMD: '' })).toBe('x ');
  });

  it('a prompt that renders to nothing dies', () => {
    const f = prompt('e.md', '{{REPO_RULES}}\n');
    expect(render(f, { REPO_RULES_TEXT: '' })).toBe('XX rendered prompt is empty: e.md\n');
  });

  it('a missing prompt file dies', () => {
    expect(render('nope.md', ALL)).toBe('XX prompt not found: nope.md\n');
  });

  it('the real prompt files render with fixture-like values and leave no placeholder unsubstituted', () => {
    const real = resolve(import.meta.dirname, '../../../prompts');
    const vars: RenderVars = { ...ALL, RULES: 'RULES-TEXT', REVIEW_TEXT: 'REVIEW', STORY_TEXT: '# Story 900\n\n**AC1 — a**' };
    for (const f of ['rules.md', 'build-round1.md', 'build-round2.md', 'build-after-spec.md', 'review.md', 'write-story.md']) {
      const r = renderPrompt(real, f, vars);
      expect(r.leftover, f).toEqual([]);
    }
  });
});
