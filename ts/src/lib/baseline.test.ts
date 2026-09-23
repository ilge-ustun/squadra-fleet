import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { baselineColour, runBaseline } from './baseline.ts';

// launch.sh:129-152 — the harness runs the suite, the build and the lint in
// the clean reviewer tree, before the reviewer is asked anything.
const FAKE_VITEST = resolve(import.meta.dirname, '../../../test/vitest');

// The rule at launch.sh:135: `jq -e '.numTotalTests > 0 and .numFailedTests == 0'`
// — anything jq cannot read or that lacks a count is RED. Not the classifier's
// rule (vitest-json.ts falls through to GREEN); the two are different on purpose.
describe('baselineColour — launch.sh:135', () => {
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
    runBaseline({ wt, evidenceDir: ev, rawJson: raw, vitestCmd: o.vitestCmd ?? FAKE_VITEST, buildCmd: o.buildCmd ?? 'true', lintCmd: o.lintCmd ?? 'true' });

  it('all green: the three colours, the summary as jq shaped it, the logs', () => {
    process.env['FAKE_VITEST'] = 'pass';
    expect(run()).toEqual({ test: 'GREEN', build: 'GREEN', lint: 'GREEN' });
    expect(readFileSync(join(ev, 'baseline/test.summary.json'), 'utf8')).toBe(
      '{\n  "numTotalTests": 2,\n  "numPassedTests": 2,\n  "numFailedTests": 0,\n  "success": true,\n  "failed": []\n}\n');
    expect(existsSync(join(ev, 'baseline/test.log'))).toBe(true);
    expect(readFileSync(join(ev, 'baseline/build.log'), 'utf8')).toBe('');
    expect(readFileSync(join(ev, 'baseline/lint.log'), 'utf8')).toBe('');
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

  it('a raw file jq could not summarise: RED, and an error object where bash left an empty file (pinned)', () => {
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

  it('a config command is a bash line here (the bash word-split it — pinned): a missing program is RED', () => {
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
