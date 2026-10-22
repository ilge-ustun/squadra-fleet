import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderPrompt } from './render.ts';
import { runnerVars } from './runner-prompts.ts';

const PROMPTS = resolve(import.meta.dirname, '../../../prompts');
const CARGO = { cargoCmd: 'cargo test --locked', cargoProbeDir: 'core/tests' };

describe('runnerVars — what a prompt says about the target\'s runners', () => {
  it('a vitest-only target gets no words in any prompt', () => {
    for (const f of ['rules.md', 'review.md', 'write-story.md', 'build-round1.md']) expect(runnerVars(f, {})).toEqual({});
  });

  it('a cargo target: the builder learns the selector and how it runs', () => {
    const v = runnerVars('rules.md', CARGO);
    expect(v.CARGO_SELECTOR).toMatch(/^\n {27}or, for a Rust test/);
    expect(v.CARGO_SELECTOR).toContain('cargo:<package>[/<target>][::<test path>]');
    expect(v.CARGO_SELECTOR).toContain('cargo test --locked -p <package> --test <target> <test path> -- --exact');
  });

  it('a cargo target: the reviewer learns the selector and the Rust probe and where it lands', () => {
    const v = runnerVars('review.md', CARGO);
    expect(v.CARGO_SELECTOR).toMatch(/^\n {21}or, for a Rust test/);
    expect(v.CARGO_PROBE).toContain('.review-out/probes/<name>.rs');
    expect(v.CARGO_PROBE).toContain('core/tests');
  });

  it('a cargo target: the story writer learns a Rust test can be an instrument', () => {
    expect(runnerVars('write-story.md', CARGO).CARGO_INSTRUMENT).toContain('cargo test');
  });
});

describe('the prompts with a vitest-only target are the prompts without the placeholders', () => {
  it.each(['rules.md', 'review.md', 'write-story.md'])('%s', (file) => {
    const vars = {
      STORY_ID: '900', RULES: 'r', REVIEW_TEXT: 'v', STORY_TEXT: 's', INTENT: 'i', STORY_BASE: 'b', HEAD_SHA: 'h', BASE_SHA: 'b', ROUND: '1',
      VITEST_CMD: 'vt', BUILD_CMD: 'bd', LINT_CMD: 'ln', CHECK_MUTATION: 'cm', BASELINE_FIXES: '1', BASELINE: 'bl', TDD_FIXES: '1',
      ...runnerVars(file, {}),
    };
    const rendered = renderPrompt(PROMPTS, file, vars).text;
    const source = readFileSync(resolve(PROMPTS, file), 'utf8');
    expect(source).toMatch(/\{\{CARGO_[A-Z]+\}\}/);
    expect(rendered).not.toMatch(/cargo/i);
    expect(renderPrompt(PROMPTS, file, vars).leftover).toEqual([]);
  });
});
