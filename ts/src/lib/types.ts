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
