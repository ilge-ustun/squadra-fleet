import { describe, expect, it } from 'vitest';
import { Die } from './lib/die.ts';
import { isValidStoryId, resolveStoryBase } from './write-story.ts';

describe('isValidStoryId (write-story.sh:36)', () => {
  it('a plain identifier only', () => {
    expect(isValidStoryId('011')).toBe(true);
    expect(isValidStoryId('story_1-a')).toBe(true);
    expect(isValidStoryId('bad id')).toBe(false);
    expect(isValidStoryId('bad/id')).toBe(false);
    expect(isValidStoryId('')).toBe(false);
  });
});

describe('resolveStoryBase (write-story.sh:38-45)', () => {
  it('defaults to the integration branch with no --base', () => {
    expect(resolveStoryBase({ defaultBase: 'base', repoName: 't', baseFlag: undefined, baseVal: undefined })).toBe('base');
  });

  it('a --base epic/… branch is accepted', () => {
    expect(resolveStoryBase({ defaultBase: 'base', repoName: 't', baseFlag: '--base', baseVal: 'epic/ui' })).toBe('epic/ui');
  });

  it('--base with no branch dies', () => {
    expect(() => resolveStoryBase({ defaultBase: 'base', repoName: 't', baseFlag: '--base', baseVal: undefined })).toThrow(Die);
  });

  it('--base naming a non-epic branch dies, pointing at fleet new-epic', () => {
    expect(() => resolveStoryBase({ defaultBase: 'base', repoName: 't', baseFlag: '--base', baseVal: 'feat/x' })).toThrow(/fleet new-epic t/);
  });
});
