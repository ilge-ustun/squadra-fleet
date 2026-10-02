// The classifier's vocabulary. String unions, not enums: Node strips types
// and runs the file as is (erasableSyntaxOnly), and the same words appear in
// the Machine block, the builder's rules and the reviewer's prompt.

/** What one run of a selector says. */
export type RunClass = 'RED' | 'GREEN' | 'NO_TESTS';

/** What the classifier says about one mutation. NO_SELECTOR is assigned by the
 *  caller when no .test or .cmd sits beside the patch. */
export type MutationClass =
  | RunClass
  | 'PRE_RED'
  | 'SELECTOR_INVALID'
  | 'PATCH_INVALID'
  | 'NO_SELECTOR';

export const MUTATION_CLASSES: readonly MutationClass[] = [
  'RED', 'GREEN', 'NO_TESTS', 'PRE_RED', 'SELECTOR_INVALID', 'PATCH_INVALID', 'NO_SELECTOR',
];

/** .test — a vitest selector line; .cmd — any command that must exit non-zero. */
export type SelectorKind = 'test' | 'cmd';

/** checkout — back to the committed tree (a throwaway worktree);
 *  reverse — undo exactly the patch (a tree someone is still working in). */
export type Restore = 'checkout' | 'reverse';

export function isSelectorKind(s: string): s is SelectorKind {
  return s === 'test' || s === 'cmd';
}

export function isRestore(s: string): s is Restore {
  return s === 'checkout' || s === 'reverse';
}

/** What a round concludes — the reviewer's word, and the machine's. */
export type Verdict = 'PASS' | 'FAIL' | 'SPEC' | 'UNPARSEABLE';

/** What a round's section and the review's line 3 can say: a verdict, or
 *  UNAVAILABLE — the reviewer's provider refused the call, so nobody judged
 *  the round. The launcher's word alone: parseReviewerVerdict and
 *  computeVerdict return a Verdict, so the type checker keeps a refusal
 *  from ever being computed, let alone as PASS. */
export type RoundOutcome = Verdict | 'UNAVAILABLE';

export type Colour = 'GREEN' | 'RED';

/** The baseline runs on the reviewer's tree: three always, and e2e when
 *  the repo sets E2E_CMD — absent, not GREEN, when it does not. */
export interface Baseline {
  test: Colour;
  build: Colour;
  lint: Colour;
  e2e?: Colour;
}

/** One mutation row: "ACn CLASS slug". cls is a string, not a
 *  MutationClass: a row parsed from text (parseMutRows) can carry any word,
 *  or none. */
export interface MutRow {
  ac: string;
  cls: string;
  slug: string;
}

/** One probe row: "name CLASS". */
export interface ProbeRow {
  name: string;
  cls: string;
}

export function isVerdict(s: string): s is Verdict {
  return s === 'PASS' || s === 'FAIL' || s === 'SPEC' || s === 'UNPARSEABLE';
}

export function isColour(s: string): s is Colour {
  return s === 'GREEN' || s === 'RED';
}
