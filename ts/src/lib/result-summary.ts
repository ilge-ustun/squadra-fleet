// The .result evidence file's second line. Separate from vitest-json.ts on
// purpose: that file is the one decision (case 106 stubs its two exports);
// this is reporting.

/** The .result file's second line: what launch.sh used to write with
 *  `jq -c '{numTotalTests, numFailedTests, failed: [...]}'` from the mutated
 *  run's JSON. Parity with jq 1.7, decided row by row in vitest-json.test.ts:
 *  a missing count prints null; when testResults or an assertionResults is
 *  not an array jq errored and no line was written, so none is returned;
 *  DEL is escaped as jq escapes it. Nobody reads this line today; the
 *  builder and a human may. */
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
