// The .result evidence file's second line. Separate from vitest-json.ts on
// purpose: that file is the one decision (case 106 stubs its two exports);
// this is reporting.

/** The .result file's second line: the mutated run's JSON through
 *  `jq -c '{numTotalTests, numFailedTests, failed: [...]}'`, as jq 1.7
 *  prints it, decided row by row in result-summary.test.ts: a missing count
 *  prints null; when testResults or an assertionResults is not an array,
 *  none is returned; DEL is escaped as jq escapes it. Nobody reads this
 *  line today; the builder and a human may. */
export function resultSummaryLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof doc !== 'object' || doc === null) return undefined;
  const o = doc as Record<string, unknown>;
  const results = o['testResults'];
  if (!Array.isArray(results)) return undefined;
  const failed: unknown[] = [];
  for (const r of results) {
    const assertions = typeof r === 'object' && r !== null ? (r as Record<string, unknown>)['assertionResults'] : undefined;
    if (!Array.isArray(assertions)) return undefined;
    for (const a of assertions) {
      const ar = typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : {};
      if (ar['status'] === 'failed') failed.push(ar['fullName'] ?? null);
    }
  }
  return JSON.stringify({
    numTotalTests: o['numTotalTests'] ?? null,
    numFailedTests: o['numFailedTests'] ?? null,
    failed,
  }).replace(/\x7f/g, '\\u007f');
}
