import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSync } from './proc.ts';
import { RunnerError, runMutations, runProbes, writeResultFile } from './evidence.ts';

// launch.sh:161-183 (run_mutations) and :239-267 (run_probes): the
// reviewer's files under round-N/mutations and round-N/probes, run by the
// harness in the reviewer's worktree, a .result beside each.
const FAKE_VITEST = resolve(import.meta.dirname, '../../../test/fakes/vitest');

let dir: string; let wt: string; let ev: string; let runs: string;
const saved: Record<string, string | undefined> = {};
const logged: string[] = [];
function git(args: string[]): void {
  const r = runSync('git', args, { cwd: wt, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}
/** A patch against HEAD that appends the marker to src/marker.txt. */
function markerPatch(dirOf: string, name: string, ext?: 'test' | 'cmd'): void {
  writeFileSync(join(wt, 'src/marker.txt'), 'the fake agents mutate this file\n\nFLEET_MUTANT_MARKER\n');
  const diff = runSync('git', ['diff', '--', 'src/marker.txt'], { cwd: wt }).stdout;
  git(['checkout', '-q', '--', 'src/marker.txt']);
  writeFileSync(join(dirOf, `${name}.patch`), diff);
  if (ext === 'test') writeFileSync(join(dirOf, `${name}.test`), 'fake.test.tsx\n');
  if (ext === 'cmd') writeFileSync(join(dirOf, `${name}.cmd`), 'grep -q FLEET_MUTANT_MARKER src/marker.txt && exit 1 || exit 0\n');
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-evidence-'));
  wt = join(dir, 'wt'); ev = join(dir, 'ev'); runs = join(dir, 'runs');
  mkdirSync(join(wt, 'src'), { recursive: true }); mkdirSync(ev); mkdirSync(runs); mkdirSync(join(dir, 'trace'));
  writeFileSync(join(wt, 'src/marker.txt'), 'the fake agents mutate this file\n');
  runSync('git', ['init', '-q', '-b', 'base', wt]);
  git(['add', '-A']); git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one']);
  for (const k of ['FAKE_VITEST', 'FAKE_TRACE_DIR']) saved[k] = process.env[k];
  process.env['FAKE_TRACE_DIR'] = join(dir, 'trace');
  process.env['FAKE_VITEST'] = 'marker';
  logged.length = 0;
});
afterEach(() => {
  for (const k of ['FAKE_VITEST', 'FAKE_TRACE_DIR']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
});
const rawPrefix = (name: string): string => join(runs, `900-round1-${name}`);
const log = (msg: string): void => { logged.push(msg); };

describe('writeResultFile — the .result file the classify verb wrote (bin/mutation.ts, seam 2)', () => {
  it('class alone without a mutated run; class and the summary line with one; class alone when the JSON is unusable', () => {
    const p = join(dir, 'x.result');
    writeResultFile(p, 'NO_SELECTOR');
    expect(readFileSync(p, 'utf8')).toBe('NO_SELECTOR\n');
    const j = join(dir, 'mut.json');
    writeFileSync(j, '{"numTotalTests":2,"numFailedTests":1,"testResults":[{"assertionResults":[{"fullName":"a","status":"failed"}]}]}');
    writeResultFile(p, 'RED', j);
    expect(readFileSync(p, 'utf8')).toBe('RED\n{"numTotalTests":2,"numFailedTests":1,"failed":["a"]}\n');
    writeFileSync(j, 'not json');
    writeResultFile(p, 'GREEN', j);
    expect(readFileSync(p, 'utf8')).toBe('GREEN\n');
    writeResultFile(p, 'PATCH_INVALID', join(dir, 'never-written.json'));
    expect(readFileSync(p, 'utf8')).toBe('PATCH_INVALID\n');
  });
});

describe('runMutations — launch.sh:161-183', () => {
  it('no mutations directory: no rows, nothing logged', () => {
    expect(runMutations({ wt, evidenceDir: ev, rawPrefix, vitestCmd: FAKE_VITEST, log })).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('AC*-*.patch in code-point order; ac before the first dash, slug after; .test, .cmd and none; a .result each', () => {
    const m = join(ev, 'mutations'); mkdirSync(m);
    markerPatch(m, 'AC2-x', 'test');
    markerPatch(m, 'AC1-tdd-observed-red', 'test');
    markerPatch(m, 'AC10-y', 'cmd');
    markerPatch(m, 'AC3-none');
    writeFileSync(join(m, 'README.md'), 'not a patch\n');
    writeFileSync(join(m, 'nope.patch'), 'no AC prefix\n');
    writeFileSync(join(m, 'AC4.patch'), 'no dash\n');
    const rows = runMutations({ wt, evidenceDir: ev, rawPrefix, vitestCmd: FAKE_VITEST, log });
    expect(rows).toEqual([
      { ac: 'AC1', cls: 'RED', slug: 'tdd-observed-red' },
      { ac: 'AC10', cls: 'RED', slug: 'y' },
      { ac: 'AC2', cls: 'RED', slug: 'x' },
      { ac: 'AC3', cls: 'NO_SELECTOR', slug: 'none' },
    ]);
    expect(logged).toEqual(['mutation AC1-tdd-observed-red: RED', 'mutation AC10-y: RED', 'mutation AC2-x: RED', 'mutation AC3-none: NO_SELECTOR']);
    expect(readFileSync(join(m, 'AC1-tdd-observed-red.result'), 'utf8')).toMatch(/^RED\n\{"numTotalTests":2,"numFailedTests":1,"failed":\["fake suite a"\]\}\n$/);
    expect(readFileSync(join(m, 'AC10-y.result'), 'utf8')).toBe('RED\n');
    expect(readFileSync(join(m, 'AC3-none.result'), 'utf8')).toBe('NO_SELECTOR\n');
    expect(existsSync(join(m, 'nope.result'))).toBe(false);
    expect(existsSync(`${rawPrefix('AC1-tdd-observed-red')}-mut.json`)).toBe(true);
    expect(readFileSync(join(wt, 'src/marker.txt'), 'utf8')).not.toMatch(/FLEET_MUTANT_MARKER/);   // restored: checkout
  });

  it('a survivor and a bad patch are classes, not failures', () => {
    const m = join(ev, 'mutations'); mkdirSync(m);
    process.env['FAKE_VITEST'] = 'pass';
    markerPatch(m, 'AC1-alive', 'test');
    writeFileSync(join(m, 'AC2-bad.patch'), '--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-x\n+y\n');
    writeFileSync(join(m, 'AC2-bad.test'), 'fake.test.tsx\n');
    expect(runMutations({ wt, evidenceDir: ev, rawPrefix, vitestCmd: FAKE_VITEST, log }).map((r) => r.cls)).toEqual(['GREEN', 'PATCH_INVALID']);
  });

  it('a dirty tree is the classifier\'s message and then the launcher\'s, as two lines (mutation.sh@14f675e:45-46, the shim)', () => {
    const m = join(ev, 'mutations'); mkdirSync(m);
    markerPatch(m, 'AC1-marker', 'test');
    writeFileSync(join(wt, 'dirty.txt'), 'x\n');
    let err: unknown;
    try { runMutations({ wt, evidenceDir: ev, rawPrefix, vitestCmd: FAKE_VITEST, log }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RunnerError);
    const e = err as RunnerError;
    expect(e.before).toMatch(/dirty.txt/);
    expect(e.message).toBe(`mutation runner: AC1-marker — the classifier failed (node ${process.version}); its message is above`);
  });
});

describe('runProbes — launch.sh:239-267', () => {
  it('no probes directory: no rows', () => {
    expect(runProbes({ wt, evidenceDir: ev, probeDir: 'src', rawPrefix, vitestCmd: FAKE_VITEST, log })).toEqual([]);
  });

  it('*.test.tsx first, then *.test.ts, each sorted; copied under fleet-probe-, run, removed; a .result each', () => {
    const p = join(ev, 'probes'); mkdirSync(p);
    process.env['FAKE_VITEST'] = 'pass';
    for (const n of ['probe-red.test.tsx', 'probe-green.test.tsx', 'a.test.ts', 'z.test.tsx', 'notes.txt']) writeFileSync(join(p, n), `// ${n}\n`);
    const rows = runProbes({ wt, evidenceDir: ev, probeDir: 'src', rawPrefix, vitestCmd: FAKE_VITEST, log });
    expect(rows).toEqual([
      { name: 'probe-green.test.tsx', cls: 'GREEN' },
      { name: 'probe-red.test.tsx', cls: 'RED' },
      { name: 'z.test.tsx', cls: 'GREEN' },
      { name: 'a.test.ts', cls: 'GREEN' },
    ]);
    expect(logged).toEqual(['probe probe-green.test.tsx: GREEN', 'probe probe-red.test.tsx: RED', 'probe z.test.tsx: GREEN', 'probe a.test.ts: GREEN']);
    expect(readFileSync(join(p, 'probe-red.test.tsx.result'), 'utf8')).toBe('RED\n');
    expect(readFileSync(`${rawPrefix('probe-probe-red.test.tsx')}.sel`, 'utf8')).toBe('src/fleet-probe-probe-red.test.tsx\n');
    expect(readdirSync(join(wt, 'src')).filter((n) => n.startsWith('fleet-probe-'))).toEqual([]);
    expect(readFileSync(join(dir, 'trace/calls'), 'utf8')).toMatch(/vitest src\/fleet-probe-probe-red\.test\.tsx/);
  });

  it('a PROBE_DIR that is not in the worktree is a die, naming it (case 86b)', () => {
    const p = join(ev, 'probes'); mkdirSync(p);
    writeFileSync(join(p, 'x.test.ts'), '//\n');
    expect(() => runProbes({ wt, evidenceDir: ev, probeDir: 'lib', rawPrefix, vitestCmd: FAKE_VITEST, log }))
      .toThrow('probe runner: PROBE_DIR lib does not exist in the worktree — a probe copied there would silently never run');
  });

  it('a dirty tree before a probe is a die', () => {
    const p = join(ev, 'probes'); mkdirSync(p);
    writeFileSync(join(p, 'x.test.ts'), '//\n');
    writeFileSync(join(wt, 'dirty.txt'), 'x\n');
    expect(() => runProbes({ wt, evidenceDir: ev, probeDir: 'src', rawPrefix, vitestCmd: FAKE_VITEST, log })).toThrow('probe runner: tree dirty before x.test.ts');
  });

  it('a runner that throws is its message and then the launcher\'s (case 107)', () => {
    const p = join(ev, 'probes'); mkdirSync(p);
    writeFileSync(join(p, 'x.test.ts'), '//\n');
    let err: unknown;
    try {
      runProbes({ wt, evidenceDir: ev, probeDir: 'src', rawPrefix, vitestCmd: FAKE_VITEST, log, runSelector: () => { throw new Error('fleet-test: runner injected'); } });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RunnerError);
    expect((err as RunnerError).before).toBe('fleet-test: runner injected');
    expect((err as RunnerError).message).toBe('probe runner: x.test.ts — the runner failed; its message is above');
  });
});
