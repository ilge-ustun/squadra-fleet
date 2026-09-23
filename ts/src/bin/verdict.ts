// verdict.ts — the round's verdict and its section of .review/<id>.md, for
// the bash that still drives the round. One JSON object on stdin, the
// values as launch.sh holds them (strings); the builder's and reviewer's
// texts are read from the round's evidence directory, where launch.sh
// wrote them before anything was judged.
//
//   jq -n … | node ts/src/bin/verdict.ts --append <review-file.new>
//     stdin  {round, headSha, roundCommits, baseline:{test,build,lint},
//             timing:{build,base,review,mut,total}, builderModel, reviewerModel,
//             acs, scope, scopeHits, mutRows, probeRows, evidenceDir}
//     effect the round section appended to the file named by --append
//     stdout one line: COMPUTED<TAB>MODEL<TAB>reasons, each reason ending "; "
//     exit 1 with the reason on stderr and nothing on stdout when the input
//            is not what launch.sh sends, or the evidence cannot be read
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dieMessage, out } from '../lib/log.ts';
import { formatIsoSeconds, parseMutRows, parseProbeRows, renderRoundSection, splitWords, REASON_END } from '../lib/machine-block.ts';
import { isColour, type Baseline } from '../lib/types.ts';
import { computeVerdict } from '../lib/verdict.ts';

const USAGE = 'usage: jq -n … | node verdict.ts --append <file>   (one JSON object on stdin)';

class InputError extends Error {}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new InputError(`verdict: input.${k} must be a string`);
  return v;
}

function obj(o: Record<string, unknown>, k: string): Record<string, unknown> {
  const v = o[k];
  if (typeof v !== 'object' || v === null) throw new InputError(`verdict: input.${k} must be an object`);
  return v as Record<string, unknown>;
}

function colour(o: Record<string, unknown>, k: string): Baseline['test'] {
  const v = str(o, k);
  if (!isColour(v)) throw new InputError(`verdict: baseline.${k} is '${v}', not GREEN or RED`);
  return v;
}

function main(argv: readonly string[]): number {
  if (argv.length !== 2 || argv[0] !== '--append' || argv[1] === undefined || argv[1] === '') throw new InputError(USAGE);
  if (process.stdin.isTTY) throw new InputError(USAGE);
  const appendTo = resolve(argv[1]);
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (e) {
    throw new InputError(`verdict: stdin is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof input !== 'object' || input === null) throw new InputError('verdict: stdin must hold one JSON object');
  const i = input as Record<string, unknown>;
  const b = obj(i, 'baseline');
  const t = obj(i, 'timing');
  const evidenceDir = resolve(str(i, 'evidenceDir'));
  const builderText = readFileSync(join(evidenceDir, 'builder.md'));
  const reviewerText = readFileSync(join(evidenceDir, 'reviewer.md'));

  const baseline: Baseline = { test: colour(b, 'test'), build: colour(b, 'build'), lint: colour(b, 'lint') };
  const acIds = splitWords(str(i, 'acs'));
  const scopeHits = splitWords(str(i, 'scopeHits'));
  const mutRows = parseMutRows(str(i, 'mutRows'));
  const probeRows = parseProbeRows(str(i, 'probeRows'));
  const v = computeVerdict({
    baseline, scope: str(i, 'scope'), scopeHits, acIds, mutRows, probeRows,
    reviewerText: reviewerText.toString('utf8'),
  });
  const section = renderRoundSection({
    round: str(i, 'round'), headSha: str(i, 'headSha'), roundCommits: str(i, 'roundCommits'),
    reviewedAt: formatIsoSeconds(new Date()),
    baseline,
    timing: { build: str(t, 'build'), base: str(t, 'base'), review: str(t, 'review'), mut: str(t, 'mut'), total: str(t, 'total') },
    builderModel: str(i, 'builderModel'), reviewerModel: str(i, 'reviewerModel'),
    acIds, scope: str(i, 'scope'), scopeHits,
    model: v.model, computed: v.computed, reasons: v.reasons, mutRows, probeRows,
    builderText, reviewerText,
  });
  appendFileSync(appendTo, section);
  out(`${v.computed}\t${v.model}\t${v.reasons.map((r) => `${r}${REASON_END}`).join('')}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof InputError) dieMessage(e.message);
  else dieMessage(`verdict.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
