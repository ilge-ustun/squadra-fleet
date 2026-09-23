import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from './proc.ts';
import { readReview } from './review.ts';

// status.sh:148, :151 and :234 — the three awk programs this module replaces.
const VERDICT_AWK = '/^verdict:/ {print $2; exit}';
const REASONS_AWK = '/^computed:/ {r=$2} END{print r}';
const BLOCK_AWK = '/^### Machine/ {blk=""; inblk=1; next} /^### / {inblk=0} inblk {blk=blk $0 "\\n"} END {printf "### Machine\\n%s", blk}';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-review-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const env = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
function bashReads(text: string): { verdict: string; reasons: string; machineBlock: string } {
  const p = join(dir, 'r.md');
  writeFileSync(p, text);
  const verdict = runSync('awk', [VERDICT_AWK, p], { env }).stdout.replace(/\n$/, '');
  // awk -F' — ' … | sed 's/[; ]*$//'   ($(…) strips trailing newlines)
  const reasons = runSync('bash', ['-c', `awk -F' — ' '${REASONS_AWK}' "$1" | sed 's/[; ]*$//'`, '_', p], { env }).stdout.replace(/\n+$/, '');
  const machineBlock = runSync('bash', ['-c', `printf '%s' "$(awk '${BLOCK_AWK}' "$1")"`, '_', p], { env }).stdout;
  return { verdict, reasons, machineBlock };
}

const ROUND = (n: number, v: string, reasons: string, body = 'baseline:  test GREEN\n') =>
  `## Round ${n} — ${v}\nhead: abc\n\n### Machine\n${body}model:     ${v}\ncomputed:  ${v}${reasons}\n\n### Builder said\nb\n\n### Reviewer\nVERDICT: ${v}\n`;

const ONE = `# Review: 900\n\nverdict: FAIL\nrounds: 1 of 3\nbase: abc\n\n${ROUND(1, 'FAIL', ' — AC1 GREEN: marker; scope VIOLATION: src/x ; ')}`;
const TWO = `# Review: 900\n\nverdict: PASS\nrounds: 2 of 3\nbase: abc\n\n${ROUND(1, 'FAIL', ' — AC1 GREEN: marker; ')}${ROUND(2, 'PASS', '', 'acs:       AC1 \n')}`;

describe('readReview — status.sh:146-152, 232-234', () => {
  it.each([
    ['one round, vetoed', ONE],
    ['two rounds: first verdict line, last computed and block', TWO],
    ['no review content at all', ''],
    ['verdict line without a value', 'verdict:\nrounds: 1 of 3\n'],
    ['verdict with extra words: field 2 only', 'verdict: PASS but really\n'],
    ['computed with two separators keeps the second piece only', `computed:  FAIL — AC1 GREEN: a — b; \n`],
    ['computed without reasons', 'computed:  PASS\n'],
    ['computed with reasons but no trailing separator', 'computed:  FAIL — x; y\n'],
    ['### Machinery is a prefix match, as the awk has it', '### Machinery\nfoo\n### Next\n'],
    ['block runs to the end when no ### follows', '### Machine\nfoo\nbar\n'],
    ['block lines keep their blank lines but not the trailing ones', '### Machine\nfoo\n\nbar\n\n\n### Builder said\n'],
    ['tabs before the verdict word are field separators', 'verdict:\t\tSPEC\n'],
  ])('%s', (_name, text) => {
    const got = readReview(text);
    const want = bashReads(text);
    expect(got.verdict ?? '').toBe(want.verdict);
    expect(got.reasons).toBe(want.reasons);
    expect(got.machineBlock ?? '### Machine').toBe(want.machineBlock);
  });

  it('the shape status.sh needs, spelled out', () => {
    expect(readReview(ONE)).toEqual({
      verdict: 'FAIL',
      reasons: 'AC1 GREEN: marker; scope VIOLATION: src/x',
      machineBlock: '### Machine\nbaseline:  test GREEN\nmodel:     FAIL\ncomputed:  FAIL — AC1 GREEN: marker; scope VIOLATION: src/x ; ',
    });
    expect(readReview(TWO).verdict).toBe('PASS');
    expect(readReview(TWO).reasons).toBe('');
    expect(readReview(TWO).machineBlock).toContain('acs:       AC1 ');
    expect(readReview('').verdict).toBeUndefined();
    expect(readReview('').machineBlock).toBeUndefined();
    expect(readReview('verdict:\n').verdict).toBe('');
  });
});
