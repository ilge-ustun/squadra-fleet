// The one place a runner's JSON becomes RED, GREEN or NO_TESTS. Every
// classification the fleet makes — the verdict's, and a builder checking
// its own evidence — passes through here, so the two cannot disagree. It
// is also where an adapter for a runner that is not vitest would begin.
//
// The rule is mutation.sh:36-39 exactly, including what `jq -e` did with
// input it could not use: an empty or unparseable file, or one without the
// counts, fell through every test to GREEN. Kept for parity; a stricter
// reading is a decision for later, made once, here.
import { existsSync, readFileSync } from 'node:fs';
import type { RunClass } from './types.ts';

export function classFromVitestJson(text: string | undefined): RunClass {
  if (text === undefined) return 'NO_TESTS';            // the runner wrote no file
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return 'GREEN';
  }
  const o = (typeof doc === 'object' && doc !== null ? doc : {}) as Record<string, unknown>;
  const total = o['numTotalTests'];
  const failed = o['numFailedTests'];
  if (typeof total === 'number' && total === 0) return 'NO_TESTS';
  if (typeof failed === 'number' && failed > 0) return 'RED';
  return 'GREEN';
}

/** The file's text, or undefined when the runner never wrote it. */
export function readVitestJson(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
