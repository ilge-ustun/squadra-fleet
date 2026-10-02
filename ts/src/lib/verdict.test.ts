import { describe, expect, it } from 'vitest';
import { computeVerdict, parseReviewerVerdict, type VerdictInput } from './verdict.ts';

describe('parseReviewerVerdict — grep -E per line', () => {
  it.each([
    ['fake review, call 1.\nfinding: none.\nVERDICT: PASS', 'PASS', 'the fake reviewer, last line, no trailing newline'],
    ['VERDICT: FAIL\n', 'FAIL', 'first line'],
    ['a\nVERDICT: SPEC\nb\n', 'SPEC', 'anywhere, not only last'],
    ['VERDICT: PASS \t\r', 'PASS', 'trailing blanks and a CR are allowed'],
    ['VERDICT: SPEC\nVERDICT: FAIL\nVERDICT: PASS', 'PASS', 'several lines → PASS first'],
    ['VERDICT: SPEC\nVERDICT: FAIL', 'FAIL', 'then FAIL'],
    ['fake review.\nverdict: pass (lowercase, not the contract)', 'UNPARSEABLE', 'the fake\'s garbage'],
    ['VERDICT: PASSED', 'UNPARSEABLE', 'no suffix'],
    [' VERDICT: PASS', 'UNPARSEABLE', 'column 0 only'],
    ['foo\rVERDICT: PASS', 'UNPARSEABLE', 'a CR is not a line break for grep (it is under a JS /m regex)'],
    ['foo VERDICT: PASS', 'UNPARSEABLE', 'nor is U+2028'],
    ['VERDICT: PASS　', 'UNPARSEABLE', 'decided: JS [ \\t\\r\\f\\v] does not admit exotic Unicode spaces glibc may'],
    ['(no reviewer message — see reviewer.raw.jsonl and reviewer.stderr)', 'UNPARSEABLE', 'the launcher\'s placeholder'],
    ['', 'UNPARSEABLE', 'empty'],
  ] as const)('%j → %s (%s)', (text, expected, _why) => {
    expect(parseReviewerVerdict(text)).toBe(expected);
  });
});

const green: VerdictInput = {
  baseline: { test: 'GREEN', build: 'GREEN', lint: 'GREEN' },
  scope: 'CLEAN',
  scopeHits: [],
  acIds: ['AC1'],
  mutRows: [{ ac: 'AC1', cls: 'RED', slug: 'marker' }],
  probeRows: [],
  reviewerText: 'VERDICT: PASS',
};

describe('computeVerdict — the rule', () => {
  it('everything green, reviewer PASS → PASS, no reasons', () => {
    expect(computeVerdict(green)).toEqual({ model: 'PASS', computed: 'PASS', reasons: [] });
  });
  it.each([
    [{ baseline: { test: 'RED', build: 'GREEN', lint: 'GREEN' } }, 'baseline test RED'],
    [{ baseline: { test: 'GREEN', build: 'RED', lint: 'GREEN' } }, 'baseline build RED'],
    [{ baseline: { test: 'GREEN', build: 'GREEN', lint: 'RED' } }, 'baseline lint RED'],
    [{ baseline: { test: 'GREEN', build: 'GREEN', lint: 'GREEN', e2e: 'RED' } }, 'baseline e2e RED'],
    [{ scope: 'VIOLATION', scopeHits: ['src/marker.txt'] }, 'scope VIOLATION: src/marker.txt '],
    [{ scope: 'VIOLATION', scopeHits: ['.fleet/config', 'src/a.ts'] }, 'scope VIOLATION: .fleet/config src/a.ts '],
    [{ acIds: ['AC1', 'AC2'] }, 'AC2 has no mutation'],
    [{ mutRows: [{ ac: 'AC1', cls: 'GREEN', slug: 'marker' }] }, 'AC1 marker GREEN'],
    [{ mutRows: [{ ac: 'AC1', cls: 'SELECTOR_INVALID', slug: 'marker' }] }, 'AC1 marker SELECTOR_INVALID'],
    [{ mutRows: [{ ac: 'AC1', cls: 'NO_SELECTOR', slug: 'bad' }] }, 'AC1 bad NO_SELECTOR'],
    [{ mutRows: [{ ac: 'AC1', cls: '', slug: 'x' }] }, 'AC1 x '],
    [{ probeRows: [{ name: 'probe-red.test.tsx', cls: 'RED' }] }, 'probe probe-red.test.tsx RED'],
  ] as const)('%j → the reason %j and a veto', (patch, reason) => {
    const r = computeVerdict({ ...green, ...patch } as VerdictInput);
    expect(r.reasons).toEqual([reason]);
    expect(r).toMatchObject({ model: 'PASS', computed: 'FAIL' });
  });
  it('a GREEN probe is not a reason', () => {
    expect(computeVerdict({ ...green, probeRows: [{ name: 'p.test.tsx', cls: 'GREEN' }] }).reasons).toEqual([]);
  });
  it('a NO_SELECTOR row still counts as coverage: one reason, not two', () => {
    const r = computeVerdict({ ...green, mutRows: [{ ac: 'AC1', cls: 'NO_SELECTOR', slug: 'bad' }] });
    expect(r.reasons).toEqual(['AC1 bad NO_SELECTOR']);
  });
  it('coverage matches the id followed by a space: AC1 is not covered by AC10', () => {
    const r = computeVerdict({ ...green, acIds: ['AC1', 'AC10'], mutRows: [{ ac: 'AC10', cls: 'RED', slug: 'x' }] });
    expect(r.reasons).toEqual(['AC1 has no mutation']);
  });
  it('reasons come in this order: baseline, scope, coverage in AC order, rows in row order, probes', () => {
    const r = computeVerdict({
      baseline: { test: 'RED', build: 'GREEN', lint: 'RED' },
      scope: 'VIOLATION', scopeHits: ['a'],
      acIds: ['AC1', 'AC2', 'AC3'],
      mutRows: [{ ac: 'AC3', cls: 'GREEN', slug: 'z' }, { ac: 'AC1', cls: 'PRE_RED', slug: 'y' }],
      probeRows: [{ name: 'p1', cls: 'GREEN' }, { name: 'p2', cls: 'RED' }],
      reviewerText: 'VERDICT: PASS',
    });
    expect(r.reasons).toEqual([
      'baseline test RED', 'baseline lint RED', 'scope VIOLATION: a ', 'AC2 has no mutation',
      'AC3 z GREEN', 'AC1 y PRE_RED', 'probe p2 RED',
    ]);
  });
  it.each(['FAIL', 'SPEC', 'UNPARSEABLE'] as const)('%s from the reviewer passes through with the reasons attached', (v) => {
    const r = computeVerdict({ ...green, mutRows: [{ ac: 'AC1', cls: 'GREEN', slug: 'marker' }], reviewerText: v === 'UNPARSEABLE' ? 'nothing' : `VERDICT: ${v}` });
    expect(r).toEqual({ model: v, computed: v, reasons: ['AC1 marker GREEN'] });
  });
  it('the veto is the only way the machine changes a verdict: never PASS from anything else', () => {
    expect(computeVerdict({ ...green, reviewerText: 'VERDICT: FAIL' })).toEqual({ model: 'FAIL', computed: 'FAIL', reasons: [] });
  });
});

describe('the optional e2e run', () => {
  it('a green e2e run is not a reason', () => {
    expect(computeVerdict({ ...green, baseline: { test: 'GREEN', build: 'GREEN', lint: 'GREEN', e2e: 'GREEN' } }).computed).toBe('PASS');
  });
  it('a red one comes after the lint in the reasons', () => {
    expect(computeVerdict({ ...green, baseline: { test: 'GREEN', build: 'GREEN', lint: 'RED', e2e: 'RED' } }).reasons)
      .toEqual(['baseline lint RED', 'baseline e2e RED']);
  });
});
