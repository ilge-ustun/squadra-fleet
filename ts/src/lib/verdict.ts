// The verdict rule — what launch.sh computed in bash at its lines 677-712.
//
// The reviewer's line is one input. The machine may veto a PASS; it never
// grants one, and it never touches SPEC (the story is wrong, not the build)
// or UNPARSEABLE or the reviewer's own FAIL — the reasons are still listed
// on the computed: line so a human reads the whole picture.
//   baseline   test, build, lint all green
//   scope      no changed path the story denies
//   coverage   every AC in the story has at least one mutation
//   D1         every mutation is RED — a survivor means the instrument is
//              absent or the mutation is wrong, and either needs a human
//   probes     no probe RED — a probe is the inverse of a mutation
//
// This file holds the rule and nothing else, so a test can replace it
// (suite case 108) and prove the launcher's verdict comes from here.
import type { Baseline, MutRow, ProbeRow, Verdict } from './types.ts';

export interface VerdictInput {
  baseline: Baseline;
  scope: string;
  /** Each hit as bash accumulated it — without its trailing space. */
  scopeHits: string[];
  /** AC ids in the story's order (AC_IDS). */
  acIds: string[];
  mutRows: MutRow[];
  probeRows: ProbeRow[];
  /** The reviewer's whole text; the VERDICT: line may be anywhere in it. */
  reviewerText: string;
}

export interface VerdictResult {
  /** What the reviewer said. */
  model: Verdict;
  /** What the machine says after its checks. */
  computed: Verdict;
  /** Each without its trailing "; " — the renderer adds it. */
  reasons: string[];
}

const LINE: readonly [Verdict, RegExp][] = [
  ['PASS', /^VERDICT: PASS[ \t\r\f\v]*$/],
  ['FAIL', /^VERDICT: FAIL[ \t\r\f\v]*$/],
  ['SPEC', /^VERDICT: SPEC[ \t\r\f\v]*$/],
];

/** `grep -qE '^VERDICT: PASS[[:space:]]*$'` per newline-delimited line, then
 *  FAIL, then SPEC (launch.sh:680-683). Split on \n, not a multiline regex:
 *  under /m, ^ and $ also break at \r, U+2028 and U+2029, which grep's do not. */
export function parseReviewerVerdict(text: string): Verdict {
  const lines = text.split('\n');
  for (const [verdict, re] of LINE) {
    if (lines.some((l) => re.test(l))) return verdict;
  }
  return 'UNPARSEABLE';
}

export function computeVerdict(i: VerdictInput): VerdictResult {
  const model = parseReviewerVerdict(i.reviewerText);
  const reasons: string[] = [];
  if (i.baseline.test !== 'GREEN') reasons.push(`baseline test ${i.baseline.test}`);
  if (i.baseline.build !== 'GREEN') reasons.push(`baseline build ${i.baseline.build}`);
  if (i.baseline.lint !== 'GREEN') reasons.push(`baseline lint ${i.baseline.lint}`);
  // bash: "scope $SCOPE: ${SCOPE_HITS}; " where every hit carries a trailing space
  if (i.scope !== 'CLEAN') reasons.push(`scope ${i.scope}: ${i.scopeHits.map((h) => `${h} `).join('')}`);
  for (const ac of i.acIds) {
    if (!i.mutRows.some((r) => r.ac === ac)) reasons.push(`${ac} has no mutation`);
  }
  for (const r of i.mutRows) {
    if (r.cls !== 'RED') reasons.push(`${r.ac} ${r.slug} ${r.cls}`);
  }
  for (const p of i.probeRows) {
    if (p.cls === 'RED') reasons.push(`probe ${p.name} RED`);
  }
  const computed: Verdict = model === 'PASS' && reasons.length > 0 ? 'FAIL' : model;
  return { model, computed, reasons };
}
