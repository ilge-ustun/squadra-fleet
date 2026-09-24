import { describe, expect, it } from 'vitest';
import { USAGE, checkStory } from './revert.ts';

// The pure part of revert.sh; the flow is proven by test-lib.sh (cases 66,
// 67, 68, 123, 126).

describe('checkStory — revert.sh:31-36, in that order', () => {
  const c = { id: '900', baseBranch: 'develop' };
  it.each([
    ['no recorded merge', { merged: '', base: 'epic/x' }, '900 has no recorded merge — nothing to revert'],
    ['no recorded merge comes first', { merged: '', base: 'main' }, '900 has no recorded merge — nothing to revert'],
    ['the integration branch', { merged: 'abc1234', base: 'develop' }, "900 is based on develop — that branch is a human's, here too"],
    ['no base means the integration branch', { merged: 'abc1234', base: '' }, "900 is based on develop — that branch is a human's, here too"],
    ['main', { merged: 'abc1234', base: 'main' }, "900 is based on main — that branch is a human's, here too"],
    ['master', { merged: 'abc1234', base: 'master' }, "900 is based on master — that branch is a human's, here too"],
    ['an epic: go', { merged: 'abc1234', base: 'epic/x' }, undefined],
  ])('%s', (_name, story, expected) => {
    expect(checkStory({ ...c, ...story })).toBe(expected);
  });

  it('the usage names the script the human types', () => {
    expect(USAGE).toBe('usage: revert.sh <repo> <id>');
  });
});
