// Prompt rendering, for the launcher and write-story. Bodies live in
// prompts/*.md and reference values as {{NAME}}, never $NAME, so the files
// are inert text.
//
// The order of the replacements is part of the contract: they run one after
// another on the growing string, so a value inserted early is subject to the
// later replacements (RULES may carry {{ROUND}}) and not to the earlier
// ones. Substitution is literal — split and join, never a regex
// replacement, whose "$&" would insert the match (L-28).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class RenderError extends Error {}

/** The variables a render reads. STORY_TEXT fills {{STORY}} and
 *  REPO_RULES_TEXT {{REPO_RULES}}; the rest share their placeholder's name. */
export type RenderVar =
  | 'STORY_ID' | 'RULES' | 'REVIEW_TEXT' | 'STORY_TEXT' | 'INTENT' | 'STORY_BASE' | 'HEAD_SHA' | 'BASE_SHA' | 'ROUND'
  | 'REPO_RULES_TEXT' | 'VITEST_CMD' | 'BUILD_CMD' | 'LINT_CMD' | 'E2E_STEP' | 'CHECK_MUTATION';

export type RenderVars = Partial<Record<RenderVar, string>>;

/** Placeholder, variable, in that order; the rows in replacement order. */
const ORDER: ReadonlyArray<readonly [string, RenderVar]> = [
  ['STORY_ID', 'STORY_ID'], ['RULES', 'RULES'], ['REVIEW_TEXT', 'REVIEW_TEXT'], ['STORY', 'STORY_TEXT'], ['INTENT', 'INTENT'],
  ['STORY_BASE', 'STORY_BASE'], ['HEAD_SHA', 'HEAD_SHA'], ['BASE_SHA', 'BASE_SHA'], ['ROUND', 'ROUND'],
  ['REPO_RULES', 'REPO_RULES_TEXT'], ['VITEST_CMD', 'VITEST_CMD'], ['BUILD_CMD', 'BUILD_CMD'], ['LINT_CMD', 'LINT_CMD'],
  ['E2E_STEP', 'E2E_STEP'],
  ['CHECK_MUTATION', 'CHECK_MUTATION'],
];

/** The names whose empty value is a die when the SOURCE uses `{{<name>}}`.
 *  The list says STORY_TEXT, and no file writes {{STORY_TEXT}}, so {{STORY}}
 *  is never guarded; REPO_RULES is exempt on purpose (a target need not add
 *  rules), and so is E2E_STEP (', then <E2E_CMD>', empty when the repo runs none). Kept as it is, pinned by a test. */
const GUARDED: readonly RenderVar[] = [
  'STORY_ID', 'RULES', 'REVIEW_TEXT', 'STORY_TEXT', 'INTENT', 'STORY_BASE', 'HEAD_SHA', 'BASE_SHA', 'ROUND',
  'VITEST_CMD', 'BUILD_CMD', 'LINT_CMD', 'CHECK_MUTATION',
];

export interface Rendered {
  text: string;
  /** `{{[A-Z_]*}}` still present, unique, in code-point order — what the
   *  launcher warns about once as `unsubstituted in <file>: …`. */
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

/** The warning's text — each name followed by one space. */
export function leftoverLine(file: string, leftover: readonly string[]): string {
  return `unsubstituted in ${file}: ${leftover.join(' ')} `;
}
