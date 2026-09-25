import { describe, expect, it } from 'vitest';
import {
  acHeadingLines, citationRange, extractAcs, extractCitations, firstAcGap, isUnboundedDomain, isValidBaseName, isValidModel, mentionsBaseline,
  skipCitation, splitCitation,
} from './lint-story.ts';

describe('extractAcs / firstAcGap', () => {
  it('extracts unique AC ids in numeric order, not textual order', () => {
    expect(extractAcs('**AC10 — x\n**AC2 — y\n**AC2 — y again (dup)\n**AC1 — z')).toEqual(['AC1', 'AC2', 'AC10']);
  });

  it('does not match an AC in a table row, only column 0', () => {
    expect(extractAcs('| AC1 | claim |\n**AC1 — real')).toEqual(['AC1']);
  });

  it('firstAcGap: undefined when contiguous from AC1, else the first missing one', () => {
    expect(firstAcGap(['AC1', 'AC2', 'AC3'])).toBeUndefined();
    expect(firstAcGap(['AC2', 'AC3'])).toBe('AC2');
    expect(firstAcGap(['AC1', 'AC3'])).toBe('AC3');
    expect(firstAcGap([])).toBeUndefined();
  });
});

describe('acHeadingLines / isUnboundedDomain / mentionsBaseline (L-20)', () => {
  it('only lines starting with **ACn are headings', () => {
    expect(acHeadingLines('**AC1 — every widget.\nprose about every thing\n**AC2 — bounded.')).toEqual(['**AC1 — every widget.', '**AC2 — bounded.']);
  });

  it('every/all/any is unbounded unless it is a temporal phrase', () => {
    expect(isUnboundedDomain('**AC1 — every stub in the worker global is argument-sensitive.')).toBe(true);
    expect(isUnboundedDomain('**AC1 — the same input produces the same output every time.')).toBe(false);
    expect(isUnboundedDomain('**AC1 — fails on any run.')).toBe(false); // "any run" is temporal
    expect(isUnboundedDomain('**AC1 — a bounded claim.')).toBe(false);
  });

  it('mentionsBaseline flags suite/build/lint/stay-green ACs', () => {
    expect(mentionsBaseline('**AC1 — npm test stays green.')).toBe(true);
    expect(mentionsBaseline('**AC1 — npm run build succeeds.')).toBe(true);
    expect(mentionsBaseline('**AC1 — the suite passes.')).toBe(true);
    expect(mentionsBaseline('**AC1 — a bounded claim.')).toBe(false);
  });
});

describe('isValidModel / isValidBaseName', () => {
  it('accepts the live aliases and the empty default, not haiku or a pinned id', () => {
    for (const m of ['sonnet', 'opus', 'fable', '']) expect(isValidModel(m)).toBe(true);
    for (const m of ['haiku', 'claude-opus-5', 'sonet']) expect(isValidModel(m)).toBe(false);
  });

  it('accepts the integration branch or an epic/* name', () => {
    expect(isValidBaseName('base', 'base')).toBe(true);
    expect(isValidBaseName('epic/x', 'base')).toBe(true);
    expect(isValidBaseName('feat/x', 'base')).toBe(false);
  });
});

describe('citations: extractCitations / splitCitation / skipCitation / citationRange', () => {
  it('extracts backticked path-like tokens, deduped and sorted, not JS expressions or bare filenames', () => {
    expect(extractCitations('See `src/a.ts:5` and `src/a.ts:5` again, plus `req.method` and `sw.js`.')).toEqual(['req.method', 'src/a.ts:5', 'sw.js']);
  });

  it('splitCitation splits on the first colon only', () => {
    expect(splitCitation('src/a.ts:5-10')).toEqual({ path: 'src/a.ts', lines: '5-10' });
    expect(splitCitation('src/a.ts')).toEqual({ path: 'src/a.ts', lines: '' });
  });

  it('skipCitation: URLs, @-mentions, node_modules, URL paths, .blocked/, bare filenames and extensionless paths', () => {
    expect(skipCitation('https://example.com/x.js')).toBe(true);
    expect(skipCitation('@someone/pkg.json')).toBe(true);
    expect(skipCitation('node_modules/x/index.js')).toBe(true);
    expect(skipCitation('/manifest.json')).toBe(true);
    expect(skipCitation('.blocked/900.md')).toBe(true);
    expect(skipCitation('sw.js')).toBe(true); // no directory
    expect(skipCitation('src/no-extension')).toBe(true); // no '.'
    expect(skipCitation('src/thing.tsx')).toBe(false);
  });

  it('citationRange: first and last of N or N-M, equal for a bare N', () => {
    expect(citationRange('5')).toEqual({ first: 5, last: 5 });
    expect(citationRange('5-10')).toEqual({ first: 5, last: 10 });
  });
});
