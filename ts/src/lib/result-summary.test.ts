import { describe, expect, it } from 'vitest';
import { resultSummaryLine } from './result-summary.ts';

// The .result file's second line, as
//   jq -c '{numTotalTests, numFailedTests, failed: [.testResults[].assertionResults[] | select(.status=="failed") | .fullName]}'
// prints it. Checked against jq 1.7 case by case; each row below is a decision.
describe('resultSummaryLine', () => {
  const fail = '{"numTotalTests":2,"numPassedTests":1,"numFailedTests":1,"success":false,"testResults":[{"name":"fake.test.tsx","status":"failed","assertionResults":[{"fullName":"fake suite a","status":"failed","failureMessages":["x"]},{"fullName":"fake suite b","status":"passed","failureMessages":[]}]}]}';
  it('the fake runner\'s failing JSON, byte for byte as jq -c', () => {
    expect(resultSummaryLine(fail)).toBe('{"numTotalTests":2,"numFailedTests":1,"failed":["fake suite a"]}');
  });
  it('all passed → an empty failed list', () => {
    expect(resultSummaryLine('{"numTotalTests":2,"numFailedTests":0,"testResults":[{"assertionResults":[{"fullName":"a","status":"passed"}]}]}'))
      .toBe('{"numTotalTests":2,"numFailedTests":0,"failed":[]}');
  });
  it('a missing count is null, as jq prints it (JSON.stringify would drop the key)', () => {
    expect(resultSummaryLine('{"testResults":[]}')).toBe('{"numTotalTests":null,"numFailedTests":null,"failed":[]}');
  });
  it('no testResults array → no line at all, where jq errors', () => {
    expect(resultSummaryLine('{"numTotalTests":0,"numFailedTests":0}')).toBeUndefined();
    expect(resultSummaryLine('{"testResults":[{"name":"x"}]}')).toBeUndefined();
  });
  it('no file, or not JSON → no line', () => {
    expect(resultSummaryLine(undefined)).toBeUndefined();
    expect(resultSummaryLine('')).toBeUndefined();
    expect(resultSummaryLine('nope')).toBeUndefined();
  });
  it('a failed test with no fullName is null, as for jq', () => {
    expect(resultSummaryLine('{"numTotalTests":1,"numFailedTests":1,"testResults":[{"assertionResults":[{"status":"failed"}]}]}'))
      .toBe('{"numTotalTests":1,"numFailedTests":1,"failed":[null]}');
  });
  it('non-ASCII passes through raw and DEL is escaped, both as jq does', () => {
    expect(resultSummaryLine('{"numTotalTests":1,"numFailedTests":1,"testResults":[{"assertionResults":[{"fullName":"AC1 — é \u007f","status":"failed"}]}]}'))
      .toBe('{"numTotalTests":1,"numFailedTests":1,"failed":["AC1 — é \\u007f"]}');
  });
});
