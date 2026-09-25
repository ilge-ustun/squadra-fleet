import { describe, expect, it } from 'vitest';
import { makeExitHooks } from './exit-hooks.ts';

describe('makeExitHooks — `trap cleanup EXIT` for a bin', () => {
  it('runs every hook once, in registration order, and forgets them', () => {
    const { register, run } = makeExitHooks();
    const seen: string[] = [];
    register(() => seen.push('a'));
    register(() => seen.push('b'));
    run();
    run();
    expect(seen).toEqual(['a', 'b']);
  });

  it('a hook that throws does not stop the others: cleanup is best effort', () => {
    const { register, run } = makeExitHooks();
    const seen: string[] = [];
    register(() => {
      throw new Error('boom');
    });
    register(() => seen.push('b'));
    expect(() => run()).not.toThrow();
    expect(seen).toEqual(['b']);
  });
});
