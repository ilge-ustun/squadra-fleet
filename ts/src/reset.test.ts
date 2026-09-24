import { describe, expect, it } from 'vitest';
import { Die } from './lib/die.ts';
import { USAGE, parseArgs, pidsLine, runsOfStory } from './reset.ts';

// The pure parts of reset.sh; the flow is proven by test-lib.sh (cases 52,
// 53, 54, 124, 127).

describe('parseArgs — reset.sh:33-42', () => {
  it.each([
    [['900'], { id: '900', force: false, newStatus: 'ready' }],
    [['900', '--force'], { id: '900', force: true, newStatus: 'ready' }],
    [['--draft', '900'], { id: '900', force: false, newStatus: 'draft' }],
    [['900', '--force', '--draft'], { id: '900', force: true, newStatus: 'draft' }],
  ] as const)('%j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });

  it.each([
    [[], USAGE],
    [['--force'], USAGE],
    [['900', '901'], 'one story at a time'],
    [['--nope'], 'unknown option: --nope'],
    [['900', '-f'], 'unknown option: -f'],
  ] as const)('%j → die', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(new Die(message));
  });
});

describe('the small shapes', () => {
  it("pidsLine — reset.sh:55: the pids joined by tr '\\n' ' ', trailing space included", () => {
    expect(pidsLine('900', '/r/../wt-900', ['123', '456'])).toBe('900 has processes running in /r/../wt-900 (123 456 ) — stop them first');
  });

  it('runsOfStory — reset.sh:87: `rm -f .runs/<id>-*`, a glob that also takes 900-b-* for 900 (as the bash did)', () => {
    const names = ['900.json', '900-merge.log', '900-round1-baseline.json', '900-b-x.log', '9000-x.log', 'epic-test-merge.log', '901-x.log'];
    expect(runsOfStory(names, '900')).toEqual(['900-merge.log', '900-round1-baseline.json', '900-b-x.log']);
  });
});
