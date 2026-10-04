import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { E2E_TIMEOUT_DEFAULT, baselineColour, baselineCommands, baselineForReviewer, runBaseline, runMergeBaseline } from './baseline.ts';
import { readdirSync, realpathSync } from 'node:fs';

// The harness runs the suite, the build and the lint in the clean reviewer
// tree, before the reviewer is asked anything.
const FAKE_VITEST = resolve(import.meta.dirname, '../../../test/fakes/vitest');

// The rule: `jq -e '.numTotalTests > 0 and .numFailedTests == 0'` — anything
// jq cannot read or that lacks a count is RED. Not the classifier's rule
// (vitest-json.ts falls through to GREEN); the two are different on purpose.
describe('baselineColour', () => {
  it.each([
    [undefined, 'RED', 'no file'],
    ['', 'RED', 'empty file'],
    ['not json', 'RED', 'unparseable'],
    ['{}', 'RED', 'no counts (null > 0 is false)'],
    ['{"numTotalTests":0,"numFailedTests":0}', 'RED', 'zero tests ran (L-08)'],
    ['{"numTotalTests":2,"numFailedTests":1}', 'RED', 'a failure'],
    ['{"numTotalTests":2,"numFailedTests":0}', 'GREEN', 'green'],
    ['{"numTotalTests":"2","numFailedTests":0}', 'GREEN', 'jq orders a string above every number, so "2" > 0 (checked)'],
    ['{"numTotalTests":[2],"numFailedTests":0}', 'GREEN', 'and an array too'],
    ['{"numTotalTests":true,"numFailedTests":0}', 'RED', 'a boolean sorts below numbers'],
    ['{"numTotalTests":2,"numFailedTests":"0"}', 'RED', '"0" == 0 is false in jq'],
    ['{"numTotalTests":2}', 'RED', 'numFailedTests missing: null == 0 is false'],
    ['[2]', 'RED', 'not an object'],
  ] as const)('%j → %s (%s)', (text, expected, _why) => {
    expect(baselineColour(text)).toBe(expected);
  });
});

describe('runBaseline', () => {
  let dir: string; let wt: string; let ev: string; let raw: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-baseline-'));
    wt = join(dir, 'wt'); ev = join(dir, 'ev'); raw = join(dir, 'runs', '900-round1-baseline.json');
    mkdirSync(join(wt, 'src'), { recursive: true }); mkdirSync(join(dir, 'runs')); mkdirSync(join(dir, 'trace'));
    writeFileSync(join(wt, 'src/marker.txt'), 'm\n');
    for (const k of ['FAKE_VITEST', 'FAKE_TRACE_DIR']) saved[k] = process.env[k];
    process.env['FAKE_TRACE_DIR'] = join(dir, 'trace');
  });
  afterEach(() => {
    for (const k of ['FAKE_VITEST', 'FAKE_TRACE_DIR']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (o: { vitestCmd?: string; buildCmd?: string; lintCmd?: string } = {}) =>
    runBaseline({ wt, evidenceDir: ev, rawJson: raw, installCmd: 'npm ci', vitestCmd: o.vitestCmd ?? FAKE_VITEST, buildCmd: o.buildCmd ?? 'true', lintCmd: o.lintCmd ?? 'true' });

  it('all green: the three colours, the summary in jq\'s shape, the logs', () => {
    process.env['FAKE_VITEST'] = 'pass';
    expect(run()).toEqual({ test: 'GREEN', build: 'GREEN', lint: 'GREEN' });
    expect(readFileSync(join(ev, 'baseline/test.summary.json'), 'utf8')).toBe(
      '{\n  "numTotalTests": 2,\n  "numPassedTests": 2,\n  "numFailedTests": 0,\n  "success": true,\n  "failed": []\n}\n');
    expect(existsSync(join(ev, 'baseline/test.log'))).toBe(true);
    expect(readFileSync(join(ev, 'baseline/build.log'), 'utf8')).toBe('');
    expect(readFileSync(join(ev, 'baseline/lint.log'), 'utf8')).toBe('');
    // What fleet merge compares before it reuses this run (L-39).
    expect(JSON.parse(readFileSync(join(ev, 'baseline/commands.json'), 'utf8'))).toEqual(
      { install: 'npm ci', test: FAKE_VITEST, build: 'true', lint: 'true', e2e: null, e2eTimeoutSec: null });
    expect(existsSync(raw)).toBe(true);
  });

  it('a failing suite: RED, the failed names listed', () => {
    process.env['FAKE_VITEST'] = 'fail';
    expect(run().test).toBe('RED');
    expect(readFileSync(join(ev, 'baseline/test.summary.json'), 'utf8')).toBe(
      '{\n  "numTotalTests": 2,\n  "numPassedTests": 1,\n  "numFailedTests": 1,\n  "success": false,\n  "failed": [\n    "fake suite a"\n  ]\n}\n');
  });

  it('zero tests collected is RED (L-08)', () => {
    process.env['FAKE_VITEST'] = 'notests';
    expect(run().test).toBe('RED');
  });

  it('a runner that writes no JSON: RED, the error object, a stale raw file removed first', () => {
    writeFileSync(raw, '{"numTotalTests":2,"numFailedTests":0}');
    expect(run({ vitestCmd: 'true' }).test).toBe('RED');
    expect(existsSync(raw)).toBe(false);
    expect(readFileSync(join(ev, 'baseline/test.summary.json'), 'utf8')).toBe('{"error":"vitest wrote no JSON — see test.log"}\n');
  });

  it('a raw file that cannot be summarised: an error object in the summary, whatever the colour', () => {
    const fake = join(dir, 'fake-vitest');
    writeFileSync(fake, '#!/usr/bin/env bash\nwhile (($#)); do case "$1" in --outputFile) printf "%s" "$OUT" > "$2"; shift 2;; *) shift;; esac; done\nexit 1\n');
    chmodSync(fake, 0o755);
    process.env['OUT'] = 'not json';
    expect(run({ vitestCmd: fake }).test).toBe('RED');
    expect(readFileSync(join(ev, 'baseline/test.summary.json'), 'utf8')).toBe('{"error":"vitest JSON is not JSON — see test.log"}\n');
    process.env['OUT'] = '{"numTotalTests":1,"numFailedTests":0,"testResults":"nope"}';
    expect(run({ vitestCmd: fake }).test).toBe('GREEN');
    expect(readFileSync(join(ev, 'baseline/test.summary.json'), 'utf8')).toBe('{"error":"vitest JSON has no testResults — see test.log"}\n');
    delete process.env['OUT'];
  });

  it('build and lint: the status is the command\'s, both streams in the log, the last 200 lines', () => {
    process.env['FAKE_VITEST'] = 'pass';
    const r = run({ buildCmd: 'echo out; echo err >&2; exit 3', lintCmd: 'seq 1 300' });
    expect(r.build).toBe('RED');
    expect(r.lint).toBe('GREEN');
    expect(readFileSync(join(ev, 'baseline/build.log'), 'utf8')).toBe('out\nerr\n');
    const lint = readFileSync(join(ev, 'baseline/lint.log'), 'utf8').split('\n');
    expect(lint[0]).toBe('101');
    expect(lint.length).toBe(201);
  });

  it('a config command is a bash line: a missing program is RED', () => {
    process.env['FAKE_VITEST'] = 'pass';
    const r = run({ buildCmd: 'echo a | grep -q b', lintCmd: 'fleet-no-such-program-xyz' });
    expect(r.build).toBe('RED');
    expect(r.lint).toBe('RED');
    expect(readFileSync(join(ev, 'baseline/lint.log'), 'utf8')).toMatch(/command not found/);
  });

  it('runs in the worktree', () => {
    process.env['FAKE_VITEST'] = 'pass';
    run({ buildCmd: 'pwd -P' });
    expect(readFileSync(join(ev, 'baseline/build.log'), 'utf8').trim()).toBe(readFileSync(join(ev, 'baseline/build.log'), 'utf8').trim());
    expect(readFileSync(join(ev, 'baseline/build.log'), 'utf8')).toMatch(/\/wt\n$/);
  });
});

// The post-merge baseline: the same three commands in the merge worktree,
// but whole logs under .runs/<logid>-merge-*.log (no tail), no summary file,
// and the install step outside (merge.ts runs it first, with its own log and
// die, as launch.ts does).
describe('runMergeBaseline', () => {
  let dir: string; let wt: string; let runs: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-mbaseline-'));
    wt = join(dir, 'wt'); runs = join(dir, 'runs');
    mkdirSync(join(wt, 'src'), { recursive: true }); mkdirSync(runs); mkdirSync(join(dir, 'trace'));
    writeFileSync(join(wt, 'src/marker.txt'), 'm\n');
    for (const k of ['FAKE_VITEST', 'FAKE_TRACE_DIR']) saved[k] = process.env[k];
    process.env['FAKE_TRACE_DIR'] = join(dir, 'trace');
  });
  afterEach(() => {
    for (const k of ['FAKE_VITEST', 'FAKE_TRACE_DIR']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (o: { vitestCmd?: string; buildCmd?: string; lintCmd?: string } = {}) =>
    runMergeBaseline({
      wt, rawJson: join(runs, '900-merge-baseline.json'),
      testLog: join(runs, '900-merge-test.log'), buildLog: join(runs, '900-merge-build.log'), lintLog: join(runs, '900-merge-lint.log'),
      e2eLog: join(runs, '900-merge-e2e.log'), vitestCmd: o.vitestCmd ?? FAKE_VITEST, buildCmd: o.buildCmd ?? 'true', lintCmd: o.lintCmd ?? 'true',
    });

  it('all green: the three colours, the four files under .runs and nothing else — no summary', () => {
    process.env['FAKE_VITEST'] = 'pass';
    expect(run()).toEqual({ test: 'GREEN', build: 'GREEN', lint: 'GREEN' });
    expect(readdirSync(runs).sort()).toEqual(['900-merge-baseline.json', '900-merge-build.log', '900-merge-lint.log', '900-merge-test.log']);
    expect(readFileSync(join(runs, '900-merge-build.log'), 'utf8')).toBe('');
  });

  it('a failing suite, zero tests, and a runner that writes no JSON (a stale raw file removed first): RED', () => {
    process.env['FAKE_VITEST'] = 'fail';
    expect(run().test).toBe('RED');
    process.env['FAKE_VITEST'] = 'notests';
    expect(run().test).toBe('RED');
    writeFileSync(join(runs, '900-merge-baseline.json'), '{"numTotalTests":2,"numFailedTests":0}');
    expect(run({ vitestCmd: 'true' }).test).toBe('RED');
    expect(existsSync(join(runs, '900-merge-baseline.json'))).toBe(false);
  });

  it('build and lint: the status is the command\'s, the whole of both streams in the log (no tail — runBaseline keeps 200)', () => {
    process.env['FAKE_VITEST'] = 'pass';
    expect(run({ buildCmd: 'seq 1 300; echo err >&2; exit 1', lintCmd: 'false' })).toEqual({ test: 'GREEN', build: 'RED', lint: 'RED' });
    const log = readFileSync(join(runs, '900-merge-build.log'), 'utf8').split('\n');
    expect(log.length).toBe(302);
    expect(log[0]).toBe('1');
    expect(log[300]).toBe('err');
  });

  it('runs in the worktree, each command a bash line', () => {
    process.env['FAKE_VITEST'] = 'pass';
    expect(run({ buildCmd: `test "$(pwd -P)" = "${realpathSync(wt)}"`, lintCmd: 'cd src && test -f marker.txt' })).toEqual({ test: 'GREEN', build: 'GREEN', lint: 'GREEN' });
  });
});

// E2E_CMD: an optional fourth run, a browser suite. Absent, the baseline is
// exactly the three runs it was; present, it runs after the lint and its
// colour is its exit status.
describe('the optional e2e run', () => {
  let dir: string; let wt: string; let ev: string; let runs: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
    wt = join(dir, 'wt'); ev = join(dir, 'ev'); runs = join(dir, 'runs');
    mkdirSync(join(wt, 'src'), { recursive: true }); mkdirSync(runs); mkdirSync(join(dir, 'trace'));
    writeFileSync(join(wt, 'src/marker.txt'), 'm\n');
    for (const k of ['FAKE_VITEST', 'FAKE_TRACE_DIR']) saved[k] = process.env[k];
    process.env['FAKE_TRACE_DIR'] = join(dir, 'trace');
    process.env['FAKE_VITEST'] = 'pass';
  });
  afterEach(() => {
    for (const k of ['FAKE_VITEST', 'FAKE_TRACE_DIR']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
  });
  const story = (e2eCmd?: string) => runBaseline({
    wt, evidenceDir: ev, rawJson: join(runs, '900-round1-baseline.json'), installCmd: 'npm ci', vitestCmd: FAKE_VITEST, buildCmd: 'true', lintCmd: 'true',
    ...(e2eCmd !== undefined ? { e2eCmd } : {}),
  });
  const merge = (e2eCmd?: string) => runMergeBaseline({
    wt, rawJson: join(runs, '900-merge-baseline.json'),
    testLog: join(runs, '900-merge-test.log'), buildLog: join(runs, '900-merge-build.log'), lintLog: join(runs, '900-merge-lint.log'),
    e2eLog: join(runs, '900-merge-e2e.log'), vitestCmd: FAKE_VITEST, buildCmd: 'true', lintCmd: 'true',
    ...(e2eCmd !== undefined ? { e2eCmd } : {}),
  });

  it('absent: no e2e key and no e2e log, in both baselines', () => {
    expect(story()).toEqual({ test: 'GREEN', build: 'GREEN', lint: 'GREEN' });
    expect(existsSync(join(ev, 'baseline/e2e.log'))).toBe(false);
    expect(merge()).toEqual({ test: 'GREEN', build: 'GREEN', lint: 'GREEN' });
    expect(existsSync(join(runs, '900-merge-e2e.log'))).toBe(false);
  });
  it('an empty E2E_CMD is the same as none', () => {
    expect(story('')).toEqual({ test: 'GREEN', build: 'GREEN', lint: 'GREEN' });
    expect(merge('')).toEqual({ test: 'GREEN', build: 'GREEN', lint: 'GREEN' });
  });
  it('present: its exit status is its colour, its output in its log, run in the worktree', () => {
    expect(story('pwd; echo E2E_OK').e2e).toBe('GREEN');
    const log = readFileSync(join(ev, 'baseline/e2e.log'), 'utf8');
    expect(log).toContain('E2E_OK');
    expect(log).toContain(realpathSync(wt));
    expect(story('echo E2E_FAIL; exit 3').e2e).toBe('RED');
    expect(merge('echo M_OK').e2e).toBe('GREEN');
    expect(readFileSync(join(runs, '900-merge-e2e.log'), 'utf8')).toContain('M_OK');
    expect(merge('false').e2e).toBe('RED');
  });
});

// A browser suite starts servers. One that never returns, or one that leaves
// a server behind, would stall the launcher: the e2e run is bounded by
// e2eTimeoutSec and swept for leftovers afterwards, and either is RED.
describe('the e2e run is bounded and swept', () => {
  let dir: string; let wt: string; let ev: string; let runs: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-e2e-bound-'));
    wt = join(dir, 'wt'); ev = join(dir, 'ev'); runs = join(dir, 'runs');
    mkdirSync(join(wt, 'src'), { recursive: true }); mkdirSync(runs); mkdirSync(join(dir, 'trace'));
    writeFileSync(join(wt, 'src/marker.txt'), 'm\n');
    for (const k of ['FAKE_VITEST', 'FAKE_TRACE_DIR']) saved[k] = process.env[k];
    process.env['FAKE_TRACE_DIR'] = join(dir, 'trace');
    process.env['FAKE_VITEST'] = 'pass';
  });
  afterEach(() => {
    for (const k of ['FAKE_VITEST', 'FAKE_TRACE_DIR']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
  });
  const story = (e2eCmd: string, e2eTimeoutSec?: number) => runBaseline({
    wt, evidenceDir: ev, rawJson: join(runs, '900-round1-baseline.json'), installCmd: 'npm ci', vitestCmd: FAKE_VITEST, buildCmd: 'true', lintCmd: 'true',
    e2eCmd, ...(e2eTimeoutSec !== undefined ? { e2eTimeoutSec } : {}),
  });
  const merge = (e2eCmd: string, e2eTimeoutSec?: number) => runMergeBaseline({
    wt, rawJson: join(runs, '900-merge-baseline.json'),
    testLog: join(runs, '900-merge-test.log'), buildLog: join(runs, '900-merge-build.log'), lintLog: join(runs, '900-merge-lint.log'),
    e2eLog: join(runs, '900-merge-e2e.log'), vitestCmd: FAKE_VITEST, buildCmd: 'true', lintCmd: 'true',
    e2eCmd, ...(e2eTimeoutSec !== undefined ? { e2eTimeoutSec } : {}),
  });
  const alive = (pid: string): boolean => existsSync(`/proc/${pid}`);

  it('a run that outlasts its timeout is killed, whole process group, and is RED with the reason in its log', () => {
    const t0 = Date.now();
    expect(story('sleep 30 & wait', 1).e2e).toBe('RED');
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(readFileSync(join(ev, 'baseline/e2e.log'), 'utf8')).toContain('timed out after 1 s');
    const t1 = Date.now();
    expect(merge('sleep 30', 1).e2e).toBe('RED');
    expect(Date.now() - t1).toBeLessThan(15_000);
    expect(readFileSync(join(runs, '900-merge-e2e.log'), 'utf8')).toContain('timed out after 1 s');
  }, 40_000);
  it('a process left running in the tree, even in its own session, is killed and makes the run RED', () => {
    const pidFile = join(dir, 'leftover.pid');
    expect(story(`setsid sleep 300 >/dev/null 2>&1 & echo $! > '${pidFile}'; sleep 0.3`).e2e).toBe('RED');
    const pid = readFileSync(pidFile, 'utf8').trim();
    expect(alive(pid)).toBe(false);
    expect(readFileSync(join(ev, 'baseline/e2e.log'), 'utf8')).toContain('left running');
  }, 20_000);
  it('a run within its time that leaves nothing behind stays GREEN, and the default bound is not 0', () => {
    expect(story('echo fine').e2e).toBe('GREEN');
    expect(readFileSync(join(ev, 'baseline/e2e.log'), 'utf8')).not.toContain('[fleet]');
    expect(merge('echo fine').e2e).toBe('GREEN');
  });
});

describe('baselineCommands — what a baseline ran, in one comparable shape', () => {
  const c = { installCmd: 'npm ci', vitestCmd: 'npx vitest run', buildCmd: 'npm run build', lintCmd: 'npm run lint' };
  it('no e2e, or an empty one, is null with no bound', () => {
    expect(baselineCommands(c)).toEqual({ install: 'npm ci', test: 'npx vitest run', build: 'npm run build', lint: 'npm run lint', e2e: null, e2eTimeoutSec: null });
    expect(baselineCommands({ ...c, e2eCmd: '' })).toEqual(baselineCommands(c));
  });
  it('an e2e run carries its bound, the default when none is set', () => {
    expect(baselineCommands({ ...c, e2eCmd: 'npm run e2e' })).toMatchObject({ e2e: 'npm run e2e', e2eTimeoutSec: E2E_TIMEOUT_DEFAULT });
    expect(baselineCommands({ ...c, e2eCmd: 'npm run e2e', e2eTimeoutSec: 60 })).toMatchObject({ e2eTimeoutSec: 60 });
  });
});

// review.md's {{BASELINE}}: what the reviewer is told the harness already ran,
// so it does not spend its minutes running it again (L-39).
describe('baselineForReviewer', () => {
  const green = { test: 'GREEN', build: 'GREEN', lint: 'GREEN', e2e: 'GREEN' } as const;
  const summary = (failed: string[], total = 1545) =>
    JSON.stringify({ numTotalTests: total, numPassedTests: total - failed.length, numFailedTests: failed.length, success: failed.length === 0, failed });

  it('the line, the suite\'s count, and where the logs are', () => {
    expect(baselineForReviewer(green, summary([]), '/t/.review/900/round-1/baseline')).toBe(
      'test GREEN | build GREEN | lint GREEN | e2e GREEN — the suite ran 1545 tests, 0 failed. Logs: /t/.review/900/round-1/baseline/');
  });

  it('a red suite names what failed, ten at most', () => {
    const names = Array.from({ length: 12 }, (_, k) => `t${k}`);
    const s = baselineForReviewer({ ...green, test: 'RED' }, summary(names), '/l');
    expect(s).toMatch(/^test RED \| build GREEN/);
    expect(s).toContain('1545 tests, 12 failed: t0; t1; t2; t3; t4; t5; t6; t7; t8; t9; and 2 more.');
  });

  it('a summary that is an error object, or none, says the suite gave no count', () => {
    expect(baselineForReviewer({ ...green, test: 'RED' }, '{"error":"vitest wrote no JSON — see test.log"}\n', '/l')).toContain('the suite reported no count — see test.log');
    expect(baselineForReviewer({ test: 'RED', build: 'RED', lint: 'RED' }, undefined, '/l')).toBe('test RED | build RED | lint RED — the suite reported no count — see test.log. Logs: /l/');
  });
});
