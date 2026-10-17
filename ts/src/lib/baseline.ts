// The baseline. The harness runs the suite, the build and the lint itself —
// and the repo's browser suite when it sets E2E_CMD —
// in the clean reviewer tree, before the reviewer is asked anything; the
// results are files under round-N/baseline/, committed with the status. A
// red baseline is a machine veto.
//
// Green requires tests to have actually run: vitest's JSON reporter says
// numTotalTests=0 with success=false for a transform error, visually
// identical to a caught bug in the terminal (L-08). The rule is
// `jq -e '.numTotalTests > 0 and .numFailedTests == 0'`, including jq's
// ordering (a string or an array is "greater than 0"); it is NOT the
// classifier's rule in vitest-json.ts, which falls through to GREEN — the
// two differ on purpose, and case 106 stubs that file, so nothing here may
// import it.
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBashTo } from './proc.ts';
import { procsInWorktree } from './procs.ts';
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

/** test.summary.json: jq's `{numTotalTests, numPassedTests, numFailedTests,
 *  success, failed: [...]}`, pretty, with null for an absent count; or the
 *  error object when the runner wrote no file. JSON of another shape gets
 *  an error object too — pinned in baseline.test.ts. */
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
 *  command is a bash line (pinned in baseline.test.ts). */
function tailed(cmd: string, cwd: string, logFile: string): Colour {
  const fd = openSync(logFile, 'w');
  try {
    const r = spawnSync('bash', ['-o', 'pipefail', '-c', `( ${cmd}\n) 2>&1 | tail -n 200`], { cwd, stdio: ['ignore', fd, 'inherit'] });
    return r.status === 0 ? 'GREEN' : 'RED';
  } finally {
    closeSync(fd);
  }
}

/** The e2e run's bound when the repo sets no E2E_TIMEOUT: fifteen minutes,
 *  three times the five the first browser suite (khaita 062) was sized for. */
export const E2E_TIMEOUT_DEFAULT = 900;

/** Wait up to `ms` for every pid to be gone; the ones still alive. */
function survivors(pids: readonly string[], ms: number): string[] {
  const end = Date.now() + ms;
  let alive = pids.filter((p) => existsSync(`/proc/${p}`));
  while (alive.length > 0 && Date.now() < end) {
    spawnSync('sleep', ['0.1']);
    alive = alive.filter((p) => existsSync(`/proc/${p}`));
  }
  return alive;
}

function signal(pids: readonly string[], sig: NodeJS.Signals): void {
  for (const p of pids) {
    try {
      process.kill(Number(p), sig);
    } catch {
      // gone already
    }
  }
}

/** The e2e run. A browser suite starts servers, and a run that never
 *  returns or a server it leaves behind would stall the launcher, whose
 *  baseline is synchronous (khaita 062's writer saw the hang). So:
 *  - the line runs under coreutils `timeout`, which leads its own process
 *    group and kills the whole group at the bound (KILL ten seconds after
 *    TERM);
 *  - afterwards every process whose cwd is in the tree is a leftover, even
 *    one that escaped the group with setsid: TERM, then KILL after five
 *    seconds;
 *  - a timeout or a leftover is RED whatever the exit status, with a
 *    `[fleet]` line in the log saying which.
 *  `tail` keeps the story baseline's 200-line log (tailed()); without it
 *  the whole of both streams goes to the log, as runBashTo writes the
 *  merge's. */
function runE2e(cmd: string, cwd: string, logFile: string, timeoutSec: number, tail: boolean): Colour {
  const line = tail ? `( ${cmd}\n) 2>&1 | tail -n 200` : cmd;
  const fd = openSync(logFile, 'w');
  const t0 = Date.now();
  let status: number | null;
  try {
    const r = spawnSync('timeout', ['--kill-after=10', String(timeoutSec), 'bash', '-o', 'pipefail', '-c', line], {
      cwd, stdio: ['ignore', fd, tail ? 'inherit' : fd],
    });
    status = r.status;
  } finally {
    closeSync(fd);
  }
  const notes: string[] = [];
  if ((status === 124 || status === 137) && Date.now() - t0 >= timeoutSec * 1000) notes.push(`timed out after ${timeoutSec} s`);
  const left = procsInWorktree(cwd).filter((p) => p !== String(process.pid));
  if (left.length > 0) {
    signal(left, 'SIGTERM');
    signal(survivors(left, 5000), 'SIGKILL');
    notes.push(`left running in the tree, killed: pids ${left.join(' ')}`);
  }
  if (notes.length > 0) appendFileSync(logFile, `\n[fleet] e2e ${notes.join('; ')}\n`);
  return status === 0 && notes.length === 0 ? 'GREEN' : 'RED';
}

/** The commands a baseline ran, written beside its logs as
 *  baseline/commands.json. fleet merge reuses a round's baseline only when
 *  the merged tree is the tree that round checked AND these are what it
 *  would run now: the same commands on the same tree have nothing new to say
 *  (L-39). e2e is null when the repo runs none; its bound only when it does. */
export interface BaselineCommands {
  install: string;
  test: string;
  build: string;
  lint: string;
  e2e: string | null;
  e2eTimeoutSec: number | null;
}

export function baselineCommands(c: {
  installCmd: string; vitestCmd: string; buildCmd: string; lintCmd: string; e2eCmd?: string; e2eTimeoutSec?: number;
}): BaselineCommands {
  const e2e = c.e2eCmd ? c.e2eCmd : null;
  return {
    install: c.installCmd,
    test: c.vitestCmd,
    build: c.buildCmd,
    lint: c.lintCmd,
    e2e,
    e2eTimeoutSec: e2e === null ? null : (c.e2eTimeoutSec ?? E2E_TIMEOUT_DEFAULT),
  };
}

export interface BaselineInput {
  wt: string;
  /** round-N; the files go under its baseline/. */
  evidenceDir: string;
  /** .runs/<id>-round<N>-baseline.json — removed first, so a stale file
   *  cannot stand in for a run that wrote nothing. */
  rawJson: string;
  /** Not run here — the caller installed the tree — but recorded in
   *  baseline/commands.json with the rest. */
  installCmd: string;
  vitestCmd: string;
  buildCmd: string;
  lintCmd: string;
  /** Run after the lint when set and not empty; its log is baseline/e2e.log. */
  e2eCmd?: string;
  /** Seconds before the e2e run's process group is killed; default 900. */
  e2eTimeoutSec?: number;
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
  writeFileSync(join(ev, 'commands.json'), `${JSON.stringify(baselineCommands(i), null, 2)}\n`);
  const text = runVitestJson(i.wt, i.vitestCmd, i.rawJson, join(ev, 'test.log'));
  const test = baselineColour(text);
  writeFileSync(join(ev, 'test.summary.json'), summary(text));
  const build = tailed(i.buildCmd, i.wt, join(ev, 'build.log'));
  const lint = tailed(i.lintCmd, i.wt, join(ev, 'lint.log'));
  if (!i.e2eCmd) return { test, build, lint };
  return { test, build, lint, e2e: runE2e(i.e2eCmd, i.wt, join(ev, 'e2e.log'), i.e2eTimeoutSec ?? E2E_TIMEOUT_DEFAULT, true) };
}

/** The post-merge baseline in the merge worktree. The same rule for the
 *  suite; build and lint by exit status with the whole of both streams in
 *  their logs (`> log 2>&1`, no tail); no summary file — the logs under
 *  .runs/<logid>-merge-*.log are what the die names. The install step is
 *  the caller's, with its own log and its own die. */
export interface MergeBaselineInput {
  wt: string;
  rawJson: string;
  testLog: string;
  buildLog: string;
  lintLog: string;
  e2eLog: string;
  vitestCmd: string;
  buildCmd: string;
  lintCmd: string;
  e2eCmd?: string;
  e2eTimeoutSec?: number;
}

export function runMergeBaseline(i: MergeBaselineInput): Baseline {
  const test = baselineColour(runVitestJson(i.wt, i.vitestCmd, i.rawJson, i.testLog));
  const build: Colour = runBashTo(i.buildCmd, { cwd: i.wt, logFile: i.buildLog }) === 0 ? 'GREEN' : 'RED';
  const lint: Colour = runBashTo(i.lintCmd, { cwd: i.wt, logFile: i.lintLog }) === 0 ? 'GREEN' : 'RED';
  if (!i.e2eCmd) return { test, build, lint };
  return { test, build, lint, e2e: runE2e(i.e2eCmd, i.wt, i.e2eLog, i.e2eTimeoutSec ?? E2E_TIMEOUT_DEFAULT, false) };
}

/** `test G | build G | lint G`, then ` | e2e G` when the repo ran one — the
 *  launcher's and the merge's log line. */
export function baselineLine(b: Baseline): string {
  return `test ${b.test} | build ${b.build} | lint ${b.lint}${b.e2e === undefined ? '' : ` | e2e ${b.e2e}`}`;
}

/** Every run that ran is GREEN. */
export function baselineGreen(b: Baseline): boolean {
  return b.test === 'GREEN' && b.build === 'GREEN' && b.lint === 'GREEN' && (b.e2e === undefined || b.e2e === 'GREEN');
}

/** The suite's count from test.summary.json, and what failed, ten names at
 *  most; a sentence saying there is none when the summary has no count. */
function suiteCount(summaryText: string | undefined): string {
  let count = 'the suite reported no count — see test.log';
  try {
    const o = summaryText === undefined ? undefined : (JSON.parse(summaryText) as Record<string, unknown>);
    const total = o?.['numTotalTests'];
    const failed = Array.isArray(o?.['failed']) ? (o['failed'] as unknown[]).map(String) : undefined;
    if (typeof total === 'number' && failed !== undefined) {
      const named = failed.slice(0, 10).join('; ');
      const more = failed.length > 10 ? `; and ${failed.length - 10} more` : '';
      count = `the suite ran ${total} tests, ${failed.length} failed${failed.length > 0 ? `: ${named}${more}` : ''}`;
    }
  } catch {
    // an unreadable summary is the default sentence
  }
  return count;
}

/** review.md's {{BASELINE}}: the harness's own baseline at the head under
 *  review — the line, the suite's count from test.summary.json (and what
 *  failed, ten names at most), and where the logs are — so the reviewer
 *  judges with it instead of spending its minutes running it again (L-39).
 *  Its results decide either way. */
export function baselineForReviewer(b: Baseline, summaryText: string | undefined, logsDir: string): string {
  return `${baselineLine(b)} — ${suiteCount(summaryText)}. Logs: ${logsDir.replace(/\/+$/, '')}/`;
}

/** The runs that are RED, in the order they ran: the fix loop's log line. */
export function redSteps(b: Baseline): string[] {
  return (['test', 'build', 'lint', 'e2e'] as const).filter((k) => b[k] === 'RED');
}

/** How many log lines of each RED run baseline-fix.md carries. */
export const FIX_TAIL_LINES = 150;

/** The last `n` lines of a log, or a sentence saying there are none. */
export function logTail(file: string, n: number): string {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return '(no log was written)';
  }
  const lines = text.replace(/\n+$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') return '(the log is empty)';
  return lines.slice(-n).join('\n');
}

/** baseline-fix.md's {{BASELINE_RED}}: the harness's baseline that was RED
 *  at the builder's head, handed back to the builder that wrote the code, in
 *  its own session, before anyone reviews it — the line, the suite's count,
 *  and for each RED run the command it was and the last `tailLines` lines
 *  of its log, so the builder starts from the failure instead of running
 *  the whole baseline again to find it. */
export function baselineForBuilder(b: Baseline, o: { summaryText: string | undefined; logsDir: string; commands: BaselineCommands; tailLines?: number }): string {
  const dir = o.logsDir.replace(/\/+$/, '');
  const n = o.tailLines ?? FIX_TAIL_LINES;
  const run: Record<string, string> = {
    test: `${o.commands.test} --reporter json — ${suiteCount(o.summaryText)}`,
    build: o.commands.build,
    lint: o.commands.lint,
    e2e: `${o.commands.e2e ?? ''} (bounded at ${o.commands.e2eTimeoutSec ?? E2E_TIMEOUT_DEFAULT} s)`,
  };
  const parts = [baselineLine(b)];
  for (const step of redSteps(b)) {
    parts.push(`${step} RED: ${run[step]}\nThe end of ${dir}/${step}.log, ${n} lines at most:\n----\n${logTail(`${dir}/${step}.log`, n)}\n----`);
  }
  return parts.join('\n\n');
}
