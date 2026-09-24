// The baseline — launch.sh:129-152. The harness runs the suite, the build and
// the lint itself, in the clean reviewer tree, before the reviewer is asked
// anything; the results are files under round-N/baseline/, committed with
// the status. A red baseline is a machine veto.
//
// Green requires tests to have actually run: vitest's JSON reporter says
// numTotalTests=0 with success=false for a transform error, visually
// identical to a caught bug in the terminal (L-08). The rule is the bash
// one, `jq -e '.numTotalTests > 0 and .numFailedTests == 0'`, including
// jq's ordering (a string or an array is "greater than 0"); it is NOT the
// classifier's rule in vitest-json.ts, which falls through to GREEN — the
// two differ on purpose, and case 106 stubs that file, so nothing here may
// import it.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBashTo } from './proc.ts';
import type { Baseline, Colour } from './types.ts';

/** jq's `v > 0`: numbers by value; null and booleans sort below numbers,
 *  strings, arrays and objects above. */
const jqGreaterThanZero = (v: unknown): boolean =>
  typeof v === 'number' ? v > 0 : typeof v === 'string' || (typeof v === 'object' && v !== null);

export function baselineColour(text: string | undefined): Colour {
  if (text === undefined) return 'RED';
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return 'RED';
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return 'RED';   // .numTotalTests errors on an array
  const o = doc as Record<string, unknown>;
  return jqGreaterThanZero(o['numTotalTests']) && o['numFailedTests'] === 0 ? 'GREEN' : 'RED';
}

/** test.summary.json (launch.sh:140-146): jq's `{numTotalTests,
 *  numPassedTests, numFailedTests, success, failed: [...]}`, pretty, with
 *  null for an absent count; or the error object when the runner wrote no
 *  file. Where jq failed on the shape and bash left an empty file, this
 *  writes an error object too — pinned in baseline.test.ts. */
function summary(text: string | undefined): string {
  if (text === undefined) return '{"error":"vitest wrote no JSON — see test.log"}\n';
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return '{"error":"vitest JSON is not JSON — see test.log"}\n';
  }
  const noResults = '{"error":"vitest JSON has no testResults — see test.log"}\n';
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return noResults;
  const o = doc as Record<string, unknown>;
  const results = o['testResults'];
  if (!Array.isArray(results)) return noResults;
  const failed: unknown[] = [];
  for (const r of results) {
    const assertions = typeof r === 'object' && r !== null ? (r as Record<string, unknown>)['assertionResults'] : undefined;
    if (!Array.isArray(assertions)) return noResults;
    for (const a of assertions) {
      const ar = typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : {};
      if (ar['status'] === 'failed') failed.push(ar['fullName'] ?? null);
    }
  }
  return `${JSON.stringify({
    numTotalTests: o['numTotalTests'] ?? null,
    numPassedTests: o['numPassedTests'] ?? null,
    numFailedTests: o['numFailedTests'] ?? null,
    success: o['success'] ?? null,
    failed,
  }, null, 2)}\n`;
}

/** `( cd "$wt" && $CMD ) 2>&1 | tail -n 200 > log` under pipefail: the
 *  status is the command's, the log its last 200 lines of both streams. The
 *  command is a bash line (the bash word-split it; khaita's values are the
 *  same either way — pinned). */
function tailed(cmd: string, cwd: string, logFile: string): Colour {
  const fd = openSync(logFile, 'w');
  try {
    const r = spawnSync('bash', ['-o', 'pipefail', '-c', `( ${cmd}\n) 2>&1 | tail -n 200`], { cwd, stdio: ['ignore', fd, 'inherit'] });
    return r.status === 0 ? 'GREEN' : 'RED';
  } finally {
    closeSync(fd);
  }
}

export interface BaselineInput {
  wt: string;
  /** round-N; the files go under its baseline/. */
  evidenceDir: string;
  /** .runs/<id>-round<N>-baseline.json — removed first, so a stale file
   *  cannot stand in for a run that wrote nothing. */
  rawJson: string;
  vitestCmd: string;
  buildCmd: string;
  lintCmd: string;
}

/** The suite with the JSON reporter, the raw file removed first so a stale
 *  one cannot stand in for a run that wrote nothing; the JSON text back, or
 *  undefined when the runner wrote none. */
function runVitestJson(wt: string, vitestCmd: string, rawJson: string, logFile: string): string | undefined {
  rmSync(rawJson, { force: true });
  runBashTo(`${vitestCmd} --reporter json --outputFile '${rawJson}'`, { cwd: wt, logFile });
  return existsSync(rawJson) ? readFileSync(rawJson, 'utf8') : undefined;
}

export function runBaseline(i: BaselineInput): Baseline {
  const ev = join(i.evidenceDir, 'baseline');
  mkdirSync(ev, { recursive: true });
  const text = runVitestJson(i.wt, i.vitestCmd, i.rawJson, join(ev, 'test.log'));
  const test = baselineColour(text);
  writeFileSync(join(ev, 'test.summary.json'), summary(text));
  const build = tailed(i.buildCmd, i.wt, join(ev, 'build.log'));
  const lint = tailed(i.lintCmd, i.wt, join(ev, 'lint.log'));
  return { test, build, lint };
}

/** merge.sh:186-193 — the post-merge baseline in the merge worktree. The same
 *  rule for the suite; build and lint by exit status with the whole of both
 *  streams in their logs (`> log 2>&1`, no tail); no summary file — the logs
 *  under .runs/<logid>-merge-*.log are what the die names. The install step
 *  (merge.sh:182-184) is the caller's, with its own log and its own die. */
export interface MergeBaselineInput {
  wt: string;
  rawJson: string;
  testLog: string;
  buildLog: string;
  lintLog: string;
  vitestCmd: string;
  buildCmd: string;
  lintCmd: string;
}

export function runMergeBaseline(i: MergeBaselineInput): Baseline {
  const test = baselineColour(runVitestJson(i.wt, i.vitestCmd, i.rawJson, i.testLog));
  const build: Colour = runBashTo(i.buildCmd, { cwd: i.wt, logFile: i.buildLog }) === 0 ? 'GREEN' : 'RED';
  const lint: Colour = runBashTo(i.lintCmd, { cwd: i.wt, logFile: i.lintLog }) === 0 ? 'GREEN' : 'RED';
  return { test, build, lint };
}
