// Prompt rendering — render.sh's render_prompt, for the launcher. Bodies live
// in prompts/*.md and reference values as {{NAME}}, never $NAME, so the files
// are inert text. write-story.sh still sources render.sh; render.test.ts
// proves this file equal to it, byte for byte, on every branch.
//
// The order of the replacements is part of the contract: bash ran them one
// after another on the growing string, so a value inserted early is subject
// to the later replacements (RULES may carry {{ROUND}}) and not to the
// earlier ones. Substitution is literal — split and join, never a regex
// replacement, whose "$&" would be bash's `&` corruption over again.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class RenderError extends Error {}

/** The variables render.sh reads, by their shell names. */
export type RenderVar =
  | 'STORY_ID' | 'RULES' | 'REVIEW_TEXT' | 'STORY_TEXT' | 'INTENT' | 'STORY_BASE' | 'HEAD_SHA' | 'BASE_SHA' | 'ROUND'
  | 'REPO_RULES_TEXT' | 'VITEST_CMD' | 'BUILD_CMD' | 'LINT_CMD' | 'CHECK_MUTATION';

export type RenderVars = Partial<Record<RenderVar, string>>;

/** render.sh:14-30 — placeholder, variable, in that order. */
const ORDER: ReadonlyArray<readonly [string, RenderVar]> = [
  ['STORY_ID', 'STORY_ID'], ['RULES', 'RULES'], ['REVIEW_TEXT', 'REVIEW_TEXT'], ['STORY', 'STORY_TEXT'], ['INTENT', 'INTENT'],
  ['STORY_BASE', 'STORY_BASE'], ['HEAD_SHA', 'HEAD_SHA'], ['BASE_SHA', 'BASE_SHA'], ['ROUND', 'ROUND'],
  ['REPO_RULES', 'REPO_RULES_TEXT'], ['VITEST_CMD', 'VITEST_CMD'], ['BUILD_CMD', 'BUILD_CMD'], ['LINT_CMD', 'LINT_CMD'],
  ['CHECK_MUTATION', 'CHECK_MUTATION'],
];

/** render.sh:36 — the names whose empty value is a die when the SOURCE uses
 *  `{{<name>}}`. The list says STORY_TEXT, and no file writes {{STORY_TEXT}},
 *  so {{STORY}} is never guarded; REPO_RULES is exempt on purpose (a target
 *  need not add rules). Kept as it is: parity, pinned by a test. */
const GUARDED: readonly RenderVar[] = [
  'STORY_ID', 'RULES', 'REVIEW_TEXT', 'STORY_TEXT', 'INTENT', 'STORY_BASE', 'HEAD_SHA', 'BASE_SHA', 'ROUND',
  'VITEST_CMD', 'BUILD_CMD', 'LINT_CMD', 'CHECK_MUTATION',
];

export interface Rendered {
  text: string;
  /** `{{[A-Z_]*}}` still present, unique, in code-point order — what bash
   *  warned about once as `unsubstituted in <file>: …`. */
  leftover: string[];
}

export function renderPrompt(promptsDir: string, file: string, vars: RenderVars): Rendered {
  let src: string;
  try {
    src = readFileSync(join(promptsDir, file), 'utf8');
  } catch {
    throw new RenderError(`prompt not found: ${file}`);
  }
  src = src.replace(/\n+$/, '');                       // src="$(cat …)"
  let out = src;
  for (const [ph, v] of ORDER) out = out.split(`{{${ph}}}`).join(vars[v] ?? '');
  for (const p of GUARDED) {
    if (src.includes(`{{${p}}}`) && !vars[p]) throw new RenderError(`${file} uses {{${p}}} but ${p} is empty`);
  }
  const leftover = [...new Set(out.match(/\{\{[A-Z_]*\}\}/g) ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (out === '') throw new RenderError(`rendered prompt is empty: ${file}`);
  return { text: out, leftover };
}

/** The warning's text, render.sh:44 — each name followed by one space. */
export function leftoverLine(file: string, leftover: readonly string[]): string {
  return `unsubstituted in ${file}: ${leftover.join(' ')} `;
}
