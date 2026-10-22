import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classFromVitestJson } from './lib/vitest-json.ts';
import { runSync } from './lib/proc.ts';
import { DirtyTreeError, classifyMutation, findSelector, runSelector } from './classifier.ts';

// The fleet's one fake runner, the same one test/suite.sh points VITEST_CMD at.
const FAKE_VITEST = resolve(import.meta.dirname, '../../test/fakes/vitest');
// And its cargo, which test/suite.sh points CARGO_CMD at as `<it> test`.
const FAKE_CARGO = `${resolve(import.meta.dirname, '../../test/fakes/cargo')} test`;

describe('classFromVitestJson — the decision, row by row', () => {
  it.each([
    [undefined, 'NO_TESTS', 'no file'],
    ['', 'GREEN', 'empty file (jq -e exits 4 → falls through)'],
    ['not json', 'GREEN', 'unparseable (jq -e exits 2 → falls through)'],
    ['{}', 'GREEN', 'no counts at all (null == 0 is false, null > 0 is false)'],
    ['{"numTotalTests":0,"numFailedTests":0}', 'NO_TESTS', 'zero collected'],
    ['{"numTotalTests":0,"numFailedTests":1}', 'NO_TESTS', 'zero collected wins over failures'],
    ['{"numTotalTests":2,"numFailedTests":1}', 'RED', 'a real failure'],
    ['{"numTotalTests":2,"numFailedTests":0}', 'GREEN', 'all passed'],
    ['{"numTotalTests":"2","numFailedTests":"1"}', 'GREEN', 'strings are not numbers, as for jq'],
  ] as const)('%j → %s (%s)', (text, expected, _why) => {
    expect(classFromVitestJson(text)).toBe(expected);
  });
});

// A throwaway repo: one commit, src/marker.txt (what the fake's marker mode
// greps, relative to its cwd), patches kept OUTSIDE the tree so porcelain
// never sees them.
interface Fx { dir: string; wt: string; mut: string; trace: string; raw: string }
let fx: Fx;

function git(args: string[], cwd = fx.wt): string {
  const r = runSync('git', args, { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
function commit(msg: string): void {
  git(['add', '-A']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg]);
}
function hashOf(file: string): string {
  return git(['hash-object', file]).trim();
}
function porcelainOf(): string {
  return git(['status', '--porcelain']).split('\n').filter((l) => l && !l.startsWith('?? .review-out/')).join('\n');
}
/** A patch (against HEAD) that appends the marker to src/marker.txt, and its selector. */
function markerPatch(name = 'AC1-marker', selector = 'fake.test.tsx\n', ext: 'test' | 'cmd' = 'test'): string {
  writeFileSync(join(fx.wt, 'src/marker.txt'), 'the fake agents mutate this file\n\nFLEET_MUTANT_MARKER\n');
  const diff = git(['diff', '--', 'src/marker.txt']);
  git(['checkout', '-q', '--', 'src/marker.txt']);
  const p = join(fx.mut, `${name}.patch`);
  writeFileSync(p, diff);
  writeFileSync(join(fx.mut, `${name}.${ext}`), selector);
  return p;
}
function calls(): number {
  return existsSync(join(fx.trace, 'calls')) ? readFileSync(join(fx.trace, 'calls'), 'utf8').split('\n').filter((l) => l.startsWith('vitest')).length : 0;
}
function classify(patch: string, o: { kind?: 'test' | 'cmd'; restore?: 'checkout' | 'reverse'; fake?: string; preRuns?: Map<string, string>; raw?: string } = {}) {
  const kind = o.kind ?? 'test';
  process.env['FAKE_VITEST'] = o.fake ?? 'marker';
  return classifyMutation({
    wt: fx.wt,
    patch,
    kind,
    selectorFile: patch.replace(/\.patch$/, `.${kind}`),
    rawPrefix: join(fx.raw, o.raw ?? 'AC1-marker'),
    restore: o.restore ?? 'checkout',
    vitestCmd: FAKE_VITEST,
    ...(o.preRuns !== undefined ? { preRuns: o.preRuns } : {}),
  });
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-classifier-'));
  fx = { dir, wt: join(dir, 'repo'), mut: join(dir, 'mut'), trace: join(dir, 'trace'), raw: join(dir, 'runs') };
  for (const d of [fx.wt, fx.mut, fx.trace, fx.raw, join(fx.wt, 'src')]) mkdirSync(d, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(fx.wt, 'src/marker.txt'), 'the fake agents mutate this file\n');
  writeFileSync(join(fx.wt, '.gitignore'), '.review-out/\n');
  commit('fixture');
  process.env['FAKE_TRACE_DIR'] = fx.trace;
  process.env['FAKE_VITEST'] = 'marker';
});
afterEach(() => {
  rmSync(fx.dir, { recursive: true, force: true });
  delete process.env['FAKE_TRACE_DIR'];
  delete process.env['FAKE_VITEST'];
  delete process.env['FAKE_CARGO'];
});

describe('findSelector', () => {
  it('prefers .test, then .cmd, else nothing', () => {
    const p = join(fx.mut, 'AC2-x.patch');
    writeFileSync(p, '');
    expect(findSelector(p)).toBeUndefined();
    writeFileSync(join(fx.mut, 'AC2-x.cmd'), 'false\n');
    expect(findSelector(p)).toEqual({ kind: 'cmd', file: join(fx.mut, 'AC2-x.cmd') });
    writeFileSync(join(fx.mut, 'AC2-x.test'), 'a.test.ts\n');
    expect(findSelector(p)).toEqual({ kind: 'test', file: join(fx.mut, 'AC2-x.test') });
  });
});

describe('runSelector', () => {
  const sel = () => {
    const f = join(fx.mut, 'sel.test');
    writeFileSync(f, 'fake.test.tsx -t "a pattern"\nsecond line ignored\n');
    return f;
  };
  it.each([['pass', 'GREEN'], ['fail', 'RED'], ['notests', 'NO_TESTS']] as const)('test kind, fake %s → %s, writes .json and .log', (fake, expected) => {
    process.env['FAKE_VITEST'] = fake;
    const prefix = join(fx.raw, 'r');
    expect(runSelector({ wt: fx.wt, kind: 'test', selectorFile: sel(), rawPrefix: prefix, vitestCmd: FAKE_VITEST })).toBe(expected);
    expect(existsSync(`${prefix}.json`)).toBe(true);
    expect(existsSync(`${prefix}.log`)).toBe(true);
    // only the first line reaches the runner, word-split by bash
    expect(readFileSync(join(fx.trace, 'calls'), 'utf8')).toBe('vitest fake.test.tsx -t a pattern\n');
  });
  it('test kind: a runner that writes no file is NO_TESTS, and a stale .json is removed first', () => {
    const prefix = join(fx.raw, 'r');
    writeFileSync(`${prefix}.json`, '{"numTotalTests":2,"numFailedTests":1}');
    expect(runSelector({ wt: fx.wt, kind: 'test', selectorFile: sel(), rawPrefix: prefix, vitestCmd: 'true' })).toBe('NO_TESTS');
    expect(existsSync(`${prefix}.json`)).toBe(false);
  });
  it('cmd kind: non-zero exit is RED, zero is GREEN, output lands in the log, cwd is the tree', () => {
    const f = join(fx.mut, 'sel.cmd');
    const prefix = join(fx.raw, 'c');
    writeFileSync(f, 'pwd; grep -q FLEET_MUTANT_MARKER src/marker.txt && exit 1 || exit 0\n');
    expect(runSelector({ wt: fx.wt, kind: 'cmd', selectorFile: f, rawPrefix: prefix, vitestCmd: FAKE_VITEST })).toBe('GREEN');
    expect(readFileSync(`${prefix}.log`, 'utf8').trim()).toBe(runSync('pwd', [], { cwd: fx.wt }).stdout.trim());
    writeFileSync(f, 'exit 3\n');
    expect(runSelector({ wt: fx.wt, kind: 'cmd', selectorFile: f, rawPrefix: prefix, vitestCmd: FAKE_VITEST })).toBe('RED');
  });
});

describe('runSelector — a cargo: selector', () => {
  const sel = (line: string) => {
    const f = join(fx.mut, 'sel.test');
    writeFileSync(f, `${line}\n`);
    return f;
  };
  const cargoCalls = (): string[] =>
    existsSync(join(fx.trace, 'calls')) ? readFileSync(join(fx.trace, 'calls'), 'utf8').split('\n').filter((l) => l.startsWith('cargo')) : [];
  it.each([['pass', 'GREEN'], ['fail', 'RED'], ['nomatch', 'NO_TESTS'], ['nocompile', 'NO_TESTS']] as const)('fake %s → %s, through libtest\'s output', (fake, expected) => {
    process.env['FAKE_CARGO'] = fake;
    const prefix = join(fx.raw, 'r');
    expect(runSelector({ wt: fx.wt, kind: 'test', selectorFile: sel('cargo:qr-core/scan::stale_is_swept'), rawPrefix: prefix, vitestCmd: FAKE_VITEST, cargoCmd: FAKE_CARGO })).toBe(expected);
    expect(cargoCalls()).toEqual(['cargo test -p qr-core --test scan stale_is_swept -- --exact']);
    expect(existsSync(`${prefix}.json`)).toBe(false);
    expect(readFileSync(`${prefix}.log`, 'utf8')).toMatch(fake === 'nocompile' ? /could not compile/ : /^running \d+ tests?$/m);
  });
  it('with no CARGO_CMD (RUNNERS does not list cargo) it is NO_TESTS, the log says why, and nothing runs', () => {
    process.env['FAKE_CARGO'] = 'pass';
    const prefix = join(fx.raw, 'r');
    expect(runSelector({ wt: fx.wt, kind: 'test', selectorFile: sel('cargo:qr-core/scan::x'), rawPrefix: prefix, vitestCmd: FAKE_VITEST })).toBe('NO_TESTS');
    expect(readFileSync(`${prefix}.log`, 'utf8')).toMatch(/RUNNERS/);
    expect(cargoCalls()).toEqual([]);
  });
  it('a line that is not a cargo selector is NO_TESTS and runs nothing: no shell ever sees it', () => {
    process.env['FAKE_CARGO'] = 'pass';
    const prefix = join(fx.raw, 'r');
    expect(runSelector({ wt: fx.wt, kind: 'test', selectorFile: sel('cargo:qr-core/scan::x; touch pwned'), rawPrefix: prefix, vitestCmd: FAKE_VITEST, cargoCmd: FAKE_CARGO })).toBe('NO_TESTS');
    expect(readFileSync(`${prefix}.log`, 'utf8')).toMatch(/not a cargo selector/);
    expect(cargoCalls()).toEqual([]);
    expect(existsSync(join(fx.wt, 'pwned'))).toBe(false);
  });
});

describe('classifyMutation — a cargo: selector gets the same classes', () => {
  const cargoClassify = (fake: string, line = 'cargo:qr-core/scan::marker_absent') => {
    const p = markerPatch('AC1-cargo', `${line}\n`);
    process.env['FAKE_CARGO'] = fake;
    return classifyMutation({
      wt: fx.wt, patch: p, kind: 'test', selectorFile: join(fx.mut, 'AC1-cargo.test'), rawPrefix: join(fx.raw, 'AC1-cargo'),
      restore: 'checkout', vitestCmd: FAKE_VITEST, cargoCmd: FAKE_CARGO,
    });
  };
  it.each([
    ['marker', 'RED', 'caught'],
    ['pass', 'GREEN', 'survived'],
    ['marker-nocompile', 'NO_TESTS', 'the mutation broke compilation'],
    ['nomatch', 'SELECTOR_INVALID', 'the selector named no test'],
    ['nocompile', 'SELECTOR_INVALID', 'nothing compiled before the mutation'],
    ['fail', 'PRE_RED', 'already red'],
  ] as const)('fake %s → %s (%s), the tree restored', (fake, expected, _why) => {
    expect(cargoClassify(fake).cls).toBe(expected);
    expect(porcelainOf()).toBe('');
  });
  it('a RED cargo run has no JSON for the .result to summarise', () => {
    expect(cargoClassify('marker').mutJsonPath).toBeUndefined();
  });
});

describe('classifyMutation — the classes', () => {
  it('RED: caught; the tree is restored byte for byte and every raw file exists', () => {
    const p = markerPatch();
    const before = hashOf('src/marker.txt');
    const r = classify(p, { fake: 'marker' });
    expect(r.cls).toBe('RED');
    expect(r.mutJsonPath).toBe(join(fx.raw, 'AC1-marker-mut.json'));
    expect(hashOf('src/marker.txt')).toBe(before);
    expect(porcelainOf()).toBe('');
    for (const s of ['-pre.json', '-pre.log', '-apply.log', '-mut.json', '-mut.log']) {
      expect(existsSync(join(fx.raw, `AC1-marker${s}`)), s).toBe(true);
    }
    expect(calls()).toBe(2);
  });
  it('GREEN: survived', () => {
    expect(classify(markerPatch(), { fake: 'pass' }).cls).toBe('GREEN');
    expect(porcelainOf()).toBe('');
  });
  it('NO_TESTS: the mutation broke compilation', () => {
    expect(classify(markerPatch(), { fake: 'marker-notests' }).cls).toBe('NO_TESTS');
    expect(porcelainOf()).toBe('');
  });
  it('PRE_RED: the instrument was already red; the patch is never applied', () => {
    const r = classify(markerPatch(), { fake: 'fail' });
    expect(r.cls).toBe('PRE_RED');
    expect(r.mutJsonPath).toBeUndefined();
    expect(existsSync(join(fx.raw, 'AC1-marker-apply.log'))).toBe(false);
    expect(existsSync(join(fx.raw, 'AC1-marker-mut.json'))).toBe(false);
    expect(calls()).toBe(1);
  });
  it('SELECTOR_INVALID: the selector collected nothing before the mutation', () => {
    expect(classify(markerPatch(), { fake: 'notests' }).cls).toBe('SELECTOR_INVALID');
    expect(calls()).toBe(1);
  });
  it('PATCH_INVALID: does not apply; -apply.log carries git\'s reason; tree restored by checkout even in reverse mode', () => {
    const p = join(fx.mut, 'AC1-bad.patch');
    writeFileSync(p, '--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-x\n+y\n');
    writeFileSync(join(fx.mut, 'AC1-bad.test'), 'fake.test.tsx\n');
    process.env['FAKE_VITEST'] = 'marker';
    const r = classifyMutation({ wt: fx.wt, patch: p, kind: 'test', selectorFile: join(fx.mut, 'AC1-bad.test'), rawPrefix: join(fx.raw, 'AC1-bad'), restore: 'reverse', vitestCmd: FAKE_VITEST });
    expect(r.cls).toBe('PATCH_INVALID');
    expect(readFileSync(join(fx.raw, 'AC1-bad-apply.log'), 'utf8')).toMatch(/nope\.txt/);
    expect(existsSync(join(fx.raw, 'AC1-bad-mut.json'))).toBe(false);
    expect(porcelainOf()).toBe('');
  });
  it('cmd selector: RED when the command fails on the mutated tree', () => {
    const p = markerPatch('AC1-cmd', 'grep -q FLEET_MUTANT_MARKER src/marker.txt && exit 1 || exit 0\n', 'cmd');
    const r = classify(p, { kind: 'cmd' });
    expect(r.cls).toBe('RED');
    expect(r.mutJsonPath).toBeUndefined();
    expect(porcelainOf()).toBe('');
  });
});

describe('classifyMutation — restore modes', () => {
  /** A patch that also adds a new file, so the two modes differ. */
  function addingPatch(): string {
    writeFileSync(join(fx.wt, 'src/marker.txt'), 'the fake agents mutate this file\n\nFLEET_MUTANT_MARKER\n');
    writeFileSync(join(fx.wt, 'src/new.txt'), 'added by the mutation\n');
    git(['add', '-N', 'src/new.txt']);
    const diff = git(['diff', '--', 'src']);
    git(['reset', '-q']);
    rmSync(join(fx.wt, 'src/new.txt'));
    git(['checkout', '-q', '--', 'src/marker.txt']);
    const p = join(fx.mut, 'AC1-marker.patch');
    writeFileSync(p, diff);
    writeFileSync(join(fx.mut, 'AC1-marker.test'), 'fake.test.tsx\n');
    return p;
  }
  it('checkout: checkout -- . then clean -fd sweeps the added file', () => {
    expect(classify(addingPatch(), { restore: 'checkout' }).cls).toBe('RED');
    expect(existsSync(join(fx.wt, 'src/new.txt'))).toBe(false);
    expect(porcelainOf()).toBe('');
  });
  it('reverse: git apply -R undoes exactly the patch', () => {
    expect(classify(addingPatch(), { restore: 'reverse' }).cls).toBe('RED');
    expect(existsSync(join(fx.wt, 'src/new.txt'))).toBe(false);
    expect(porcelainOf()).toBe('');
  });
  it('reverse leaves other untracked work alone; checkout would not, which is why a human tree uses reverse', () => {
    writeFileSync(join(fx.wt, '.review-out'), ''); rmSync(join(fx.wt, '.review-out'));
    mkdirSync(join(fx.wt, '.review-out/checks'), { recursive: true });
    writeFileSync(join(fx.wt, '.review-out/checks/note.txt'), 'kept\n');
    expect(classify(markerPatch(), { restore: 'reverse' }).cls).toBe('RED');
    expect(existsSync(join(fx.wt, '.review-out/checks/note.txt'))).toBe(true);
    expect(classify(markerPatch(), { restore: 'checkout' }).cls).toBe('RED');
    expect(existsSync(join(fx.wt, '.review-out/checks/note.txt')), 'clean -e .review-out keeps it too').toBe(true);
  });
});

describe('classifyMutation — a dirty tree stops everything', () => {
  it('before: throws naming the path, and the runner is never called', () => {
    const p = markerPatch();
    writeFileSync(join(fx.wt, 'README.md'), 'uncommitted\n');
    commit('a readme');
    writeFileSync(join(fx.wt, 'README.md'), 'uncommitted change\n');
    let err: unknown;
    try { classify(p); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DirtyTreeError);
    expect((err as DirtyTreeError).when).toBe('before');
    expect((err as DirtyTreeError).message).toMatch(/README\.md/);
    expect(calls()).toBe(0);
    expect(readFileSync(join(fx.wt, 'README.md'), 'utf8')).toBe('uncommitted change\n');
  });
  it('after: a selector that litters the tree is caught under reverse (apply -R undoes only the patch)', () => {
    const p = markerPatch('AC1-litter', 'touch src/junk.txt; grep -q FLEET_MUTANT_MARKER src/marker.txt && exit 1 || exit 0\n', 'cmd');
    let err: unknown;
    try { classify(p, { kind: 'cmd', restore: 'reverse' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DirtyTreeError);
    expect((err as DirtyTreeError).when).toBe('after');
    expect((err as DirtyTreeError).message).toMatch(/junk\.txt/);
  });
  it('after: the same litter is swept under checkout, so no error', () => {
    const p = markerPatch('AC1-litter', 'touch src/junk.txt; grep -q FLEET_MUTANT_MARKER src/marker.txt && exit 1 || exit 0\n', 'cmd');
    expect(classify(p, { kind: 'cmd', restore: 'checkout' }).cls).toBe('RED');
    expect(porcelainOf()).toBe('');
  });
});

// L-39. Within one round's runner the tree is the same clean HEAD before every
// patch (asserted), so a selector that ran GREEN unmutated is GREEN unmutated
// for the next patch too. khaita 071 ran one 165 s full-suite pre-run twice.
describe('classifyMutation — the pre-run, once per selector and HEAD', () => {
  it('a second patch with the same selector reuses the GREEN pre-run; its -pre.log says whose', () => {
    const preRuns = new Map<string, string>();
    expect(classify(markerPatch('AC1-a'), { preRuns, raw: 'AC1-a' }).cls).toBe('RED');
    expect(calls()).toBe(2);
    expect(classify(markerPatch('AC1-b'), { preRuns, raw: 'AC1-b' }).cls).toBe('RED');
    expect(calls()).toBe(3);   // the mutated run only
    expect(readFileSync(join(fx.raw, 'AC1-b-pre.log'), 'utf8')).toMatch(/same selector and HEAD as .*AC1-a-pre, GREEN/);
    expect(existsSync(join(fx.raw, 'AC1-b-pre.json'))).toBe(true);   // copied, so the raw files stay complete
  });

  it('a different selector, a different kind or a new HEAD runs its own pre-run', () => {
    const preRuns = new Map<string, string>();
    classify(markerPatch('AC1-a'), { preRuns, raw: 'AC1-a' });
    classify(markerPatch('AC1-b', 'fake.test.tsx -t other\n'), { preRuns, raw: 'AC1-b' });
    expect(calls()).toBe(4);
    classify(markerPatch('AC1-c', 'true\n', 'cmd'), { preRuns, raw: 'AC1-c', kind: 'cmd' });
    writeFileSync(join(fx.wt, 'src/other.txt'), 'x\n'); commit('a new head');
    classify(markerPatch('AC1-d'), { preRuns, raw: 'AC1-d' });
    expect(calls()).toBe(6);   // AC1-c is a .cmd (no vitest call); AC1-d pre and mut
    expect(readFileSync(join(fx.raw, 'AC1-d-pre.log'), 'utf8')).not.toMatch(/same selector/);
  });

  it('PRE_RED and SELECTOR_INVALID are never reused: each patch reports its own', () => {
    const preRuns = new Map<string, string>();
    expect(classify(markerPatch('AC1-a'), { preRuns, raw: 'AC1-a', fake: 'fail' }).cls).toBe('PRE_RED');
    expect(classify(markerPatch('AC1-b'), { preRuns, raw: 'AC1-b', fake: 'fail' }).cls).toBe('PRE_RED');
    expect(classify(markerPatch('AC1-c'), { preRuns, raw: 'AC1-c', fake: 'notests' }).cls).toBe('SELECTOR_INVALID');
    expect(calls()).toBe(3);
    expect(preRuns.size).toBe(0);
  });

  it('without a cache, as fleet check-mutation calls it, every patch runs its own', () => {
    classify(markerPatch('AC1-a'), { raw: 'AC1-a' });
    classify(markerPatch('AC1-b'), { raw: 'AC1-b' });
    expect(calls()).toBe(4);
  });

  it('a patch that does not apply costs no run at all', () => {
    const p = join(fx.mut, 'AC1-bad.patch');
    writeFileSync(p, '--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-x\n+y\n');
    writeFileSync(join(fx.mut, 'AC1-bad.test'), 'fake.test.tsx\n');
    expect(classify(p, { raw: 'AC1-bad' }).cls).toBe('PATCH_INVALID');
    expect(calls()).toBe(0);
  });
});
