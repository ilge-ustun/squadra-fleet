import { describe, expect, it } from 'vitest';
import {
  Die, acIds, builderModelForRound, capture, chooseBuildPrompt, finalReviewHeader, head20, keepEarlierRounds, priorFailingReview, readKnobs, runFileEnd,
  runFileStart, splitCommand,
} from './launch.ts';

// The launcher's pure parts. The loop itself is proven by test-lib.sh's
// sixty launcher cases and the old-versus-new diff recorded in the commit.

describe('capture — what $(…) leaves', () => {
  it('strips every trailing newline and nothing else', () => {
    expect(capture('a\nb\n\n\n')).toBe('a\nb');
    expect(capture('a\n')).toBe('a');
    expect(capture('a')).toBe('a');
    expect(capture('\n\n')).toBe('');
    expect(capture('a  \n')).toBe('a  ');
  });
});

describe('acIds — grep -oE "^\\*\\*AC[0-9]+" | tr -d "*" | sort -u (launch.sh:377)', () => {
  it('column 0 only, unique, code-point order (AC1 AC10 AC2), split on \\n only', () => {
    expect(acIds('# S\n**AC2 — b**\n**AC1 — a**\n**AC10 — c**\n  **AC3 — indented, not counted**\n**AC1 — again**\n')).toEqual(['AC1', 'AC10', 'AC2']);
    expect(acIds('no criteria\n')).toEqual([]);
    expect(acIds('**AC1 — a**\r\n')).toEqual(['AC1']);
    expect(acIds('x **AC1 — not a line start to grep**')).toEqual([]);
  });
});

describe('chooseBuildPrompt — launch.sh:499-505', () => {
  it('round1 on the first round with no findings; after-spec when the old review says SPEC; round2 otherwise', () => {
    expect(chooseBuildPrompt({ round: 1, roundStart: 0, reviewText: '', reviewFileText: '' })).toBe('build-round1.md');
    expect(chooseBuildPrompt({ round: 3, roundStart: 2, reviewText: '', reviewFileText: '' })).toBe('build-round1.md');
    expect(chooseBuildPrompt({ round: 1, roundStart: 0, reviewText: 'findings', reviewFileText: '# R\n\nverdict: SPEC\n' })).toBe('build-after-spec.md');
    expect(chooseBuildPrompt({ round: 1, roundStart: 0, reviewText: 'findings', reviewFileText: 'x\nverdict: SPECIAL\n' })).toBe('build-after-spec.md');   // grep's prefix match
    expect(chooseBuildPrompt({ round: 1, roundStart: 0, reviewText: 'findings', reviewFileText: '# R\n\nverdict: FAIL\n' })).toBe('build-round2.md');
    expect(chooseBuildPrompt({ round: 2, roundStart: 0, reviewText: 'findings', reviewFileText: 'verdict: SPEC\n' })).toBe('build-round2.md');
    expect(chooseBuildPrompt({ round: 1, roundStart: 0, reviewText: '', reviewFileText: 'verdict: SPEC\n' })).toBe('build-round1.md');   // no findings wins
  });
});

describe('priorFailingReview — grep -qE "^verdict: (FAIL|UNPARSEABLE|SPEC)" on any line (launch.sh:408)', () => {
  it.each([
    ['# R\n\nverdict: FAIL\n', true], ['verdict: UNPARSEABLE', true], ['x\nverdict: SPEC\n', true],
    ['verdict: PASS\n', false], ['verdict: \n', false], ['\nreviewer said verdict: FAIL in prose\n', false],
    ['# R\nverdict: PASS\n### Reviewer\nverdict: FAIL\n', true],   // any line, not the first verdict: — pinned
  ])('%j → %s', (text, expected) => {
    expect(priorFailingReview(text)).toBe(expected);
  });
});

describe('keepEarlierRounds — awk "/^## Round /{p=1} p" (launch.sh:477)', () => {
  it('from the first "## Round " line to the end, each line with its newline', () => {
    expect(keepEarlierRounds('# Review: 900\n\nverdict: FAIL\n\n## Round 1\n\na\n\n## Round 2\nb\n')).toBe('## Round 1\n\na\n\n## Round 2\nb\n');
    expect(keepEarlierRounds('# Review\nverdict: FAIL\n')).toBe('');
    expect(keepEarlierRounds('## Round 1\nxxxx')).toBe('## Round 1\nxxxx\n');           // awk adds the missing final newline (case 32)
    expect(keepEarlierRounds('## Rounds are not it\n## Round 1\n')).toBe('## Round 1\n');
    expect(keepEarlierRounds('')).toBe('');
  });
});

describe('the review file header and the run file (launch.sh:426, 719-726, 742-743)', () => {
  it('header lines', () => {
    expect(finalReviewHeader({ storyId: '900', verdict: 'PASS', round: 1, ceiling: 2, baseSha: 'abc' })).toBe('# Review: 900\n\nverdict: PASS\nrounds: 1 of 2\nbase: abc\n');
    expect(finalReviewHeader({ storyId: '900', verdict: '', round: 0, ceiling: 0, baseSha: '' })).toBe('# Review: 900\n\nverdict: \nrounds: 0 of 0\nbase: \n');
  });
  it('the run file: one printf line at the start, jq -n pretty at the end', () => {
    expect(runFileStart('900', 4242, '2026-09-23T15:29:26+02:00')).toBe('{"story":"900","pid":4242,"started":"2026-09-23T15:29:26+02:00"}\n');
    expect(runFileEnd('900', 'PASS', 2)).toBe('{\n  "story": "900",\n  "verdict": "PASS",\n  "rounds": 2\n}\n');
  });
});

describe('head20 — echo "$BUILD_OUT" | head -20', () => {
  it('the first 20 lines, each ended', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `l${i + 1}`);
    expect(head20(lines.join('\n'))).toBe(`${lines.slice(0, 20).join('\n')}\n`);
    expect(head20('one')).toBe('one\n');
    expect(head20('')).toBe('\n');
  });
});

describe('readKnobs — the ${X:-default} knobs of launch.sh:57-71,96', () => {
  it('defaults; an empty value is the default too', () => {
    const k = readKnobs({}, '/fleet');
    expect(k).toMatchObject({ builderModel: 'sonnet', reviewerModel: '', maxTurns: '60', agentTimeoutRaw: '1800', agentTimeout: 1800,
      maxRoundsRaw: '2', maxRounds: 2, pushStatus: '1', reviewOnly: '0', lockWait: 120, notifyCmd: 'bash /fleet/telegram.sh send' });
    expect(readKnobs({ BUILDER_MODEL: '', MAX_ROUNDS: '', AGENT_TIMEOUT: '', FLEET_NOTIFY_CMD: '' }, '/f')).toMatchObject({ builderModel: 'sonnet', maxRounds: 2, agentTimeout: 1800, notifyCmd: 'bash /f/telegram.sh send' });
  });
  it('the environment wins', () => {
    expect(readKnobs({ BUILDER_MODEL: 'm', REVIEWER_MODEL: 'r', MAX_TURNS: '7', AGENT_TIMEOUT: '5', MAX_ROUNDS: '1', PUSH_STATUS: '0', REVIEW_ONLY: '1', FLEET_LOCK_WAIT: '0.5', FLEET_NOTIFY_CMD: 'true' }, '/f'))
      .toMatchObject({ builderModel: 'm', reviewerModel: 'r', maxTurns: '7', agentTimeout: 5, maxRounds: 1, pushStatus: '0', reviewOnly: '1', lockWait: 0.5, notifyCmd: 'true' });
  });
  it('a non-numeric MAX_ROUNDS, AGENT_TIMEOUT or FLEET_LOCK_WAIT is a die (bash: an arithmetic 0 or timeout\'s own error — pinned)', () => {
    expect(() => readKnobs({ MAX_ROUNDS: 'abc' }, '/f')).toThrow(Die);
    expect(() => readKnobs({ AGENT_TIMEOUT: '30m' }, '/f')).toThrow(/AGENT_TIMEOUT/);
    expect(() => readKnobs({ FLEET_LOCK_WAIT: 'x' }, '/f')).toThrow(/FLEET_LOCK_WAIT/);
    expect(readKnobs({ AGENT_TIMEOUT: '0' }, '/f').agentTimeout).toBe(0);
    expect(readKnobs({ AGENT_TIMEOUT: '1.5' }, '/f').agentTimeout).toBe(1.5);
  });
});

describe('splitCommand — an unquoted $FLEET_NOTIFY_CMD', () => {
  it('splits on whitespace, drops empties', () => {
    expect(splitCommand('bash /f/telegram.sh send')).toEqual(['bash', '/f/telegram.sh', 'send']);
    expect(splitCommand('  true  ')).toEqual(['true']);
    expect(splitCommand('')).toEqual([]);
  });
});

describe('builderModelForRound — a haiku story gets one round (24 Sep)', () => {
  it('round 1 keeps whatever the story asked for', () => {
    expect(builderModelForRound('haiku', 1, 'sonnet')).toBe('haiku');
    expect(builderModelForRound('opus', 1, 'sonnet')).toBe('opus');
  });
  it('a later round of a haiku story goes to the default', () => {
    expect(builderModelForRound('haiku', 2, 'sonnet')).toBe('sonnet');
    expect(builderModelForRound('claude-haiku-4-5-20251001', 3, 'opus')).toBe('opus');
  });
  it('and to sonnet when the default is haiku too', () => {
    expect(builderModelForRound('haiku', 2, 'haiku')).toBe('sonnet');
  });
  it('other models keep their model every round', () => {
    expect(builderModelForRound('opus', 2, 'sonnet')).toBe('opus');
    expect(builderModelForRound('sonnet', 5, 'sonnet')).toBe('sonnet');
  });
});
