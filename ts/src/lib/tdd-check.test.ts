import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tddCounts, tddForBuilder } from './tdd-check.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-tdd-')); mkdirSync(join(dir, 'mutations')); mkdirSync(join(dir, 'runs')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const rawPrefix = (name: string): string => join(dir, 'runs', `900-round1-tdd1-${name}`);

describe('tddCounts — one class count per kind, in the verdict\'s order', () => {
  it('RED first, then the findings; nothing for none', () => {
    expect(tddCounts([])).toBe('no pairs');
    expect(tddCounts([{ ac: 'AC1', cls: 'RED', slug: 'tdd-a' }, { ac: 'AC2', cls: 'RED', slug: 'tdd-b' }])).toBe('2 RED');
    expect(tddCounts([
      { ac: 'AC1', cls: 'GREEN', slug: 'tdd-a' }, { ac: 'AC2', cls: 'RED', slug: 'tdd-b' },
      { ac: 'AC3', cls: 'SELECTOR_INVALID', slug: 'tdd-c' }, { ac: 'AC4', cls: 'GREEN', slug: 'tdd-d' },
    ])).toBe('1 RED 2 GREEN 1 SELECTOR_INVALID');
  });
});

describe('tddForBuilder — what a resumed builder is told', () => {
  it('every pair\'s class; for each one not RED: what it means, its selector, and the end of the log that shows why', () => {
    const m = join(dir, 'mutations');
    writeFileSync(join(m, 'AC1-tdd-a.patch'), 'p\n'); writeFileSync(join(m, 'AC1-tdd-a.test'), 'a.test.ts\n');
    writeFileSync(join(m, 'AC2-tdd-b.patch'), 'p\n'); writeFileSync(join(m, 'AC2-tdd-b.cmd'), 'npm run e2e -- e2e/b.spec.ts\n');
    writeFileSync(join(m, 'AC3-tdd-c.patch'), 'p\n'); writeFileSync(join(m, 'AC3-tdd-c.test'), 'c.test.ts -t "nothing"\n');
    writeFileSync(join(m, 'AC4-tdd-d.patch'), 'p\n');
    writeFileSync(`${rawPrefix('AC2-tdd-b')}-mut.log`, 'line 1\nline 2\n  1 passed\n');
    writeFileSync(`${rawPrefix('AC3-tdd-c')}-pre.log`, 'No test files found\n');
    const text = tddForBuilder([
      { ac: 'AC1', cls: 'RED', slug: 'tdd-a' }, { ac: 'AC2', cls: 'GREEN', slug: 'tdd-b' },
      { ac: 'AC3', cls: 'SELECTOR_INVALID', slug: 'tdd-c' }, { ac: 'AC4', cls: 'NO_SELECTOR', slug: 'tdd-d' },
    ], { mutationsDir: m, rawPrefix, tailLines: 2 });
    expect(text).toContain('RED               AC1-tdd-a\nGREEN             AC2-tdd-b\nSELECTOR_INVALID  AC3-tdd-c\nNO_SELECTOR       AC4-tdd-d\n');
    expect(text).toContain('AC2-tdd-b GREEN: the patch applied and the selector stayed green — your test does not assert what the patch removes.\nselector (.cmd): npm run e2e -- e2e/b.spec.ts\n');
    expect(text).toContain(`The end of ${rawPrefix('AC2-tdd-b')}-mut.log, 2 lines at most:\n----\nline 2\n  1 passed\n----`);
    expect(text).toContain('AC3-tdd-c SELECTOR_INVALID: the selector names no test');
    expect(text).toContain(`The end of ${rawPrefix('AC3-tdd-c')}-pre.log`);
    expect(text).toContain('AC4-tdd-d NO_SELECTOR: no .test or .cmd sits beside the patch.\n');
    expect(text).not.toContain('AC1-tdd-a RED:');
  });
});
