// The reader of .review/<id>.md, against the labels lib/machine-block.ts
// writes, so the writer and the reader cannot drift.
//
//   verdict       field 2 of the FIRST `verdict:` line (the launcher writes
//                 the computed verdict there); undefined when there is no such
//                 line, '' when the line has no second field
//   reasons       on the LAST `computed:` line, what follows the first ` — `
//                 up to the next one, minus trailing `; ` — the launcher's
//                 reason list ends in one
//   machineBlock  `### Machine` and the lines of the LAST such heading up to
//                 the next `### ` heading, trailing newlines removed as
//                 `$(…)` removed them; undefined when the file has none
//                 (`### Machine…` is a prefix match)
//   readLastRound the LAST `## Round N` section's number, its `head:` line
//                 (before any `### ` heading) and its `baseline:` line (in
//                 its `### Machine` block); undefined when either is missing —
//                 what fleet merge needs to know which tree a round checked
import { COMPUTED_SEP, LABELS, MACHINE_HEADING } from './machine-block.ts';
import { records } from './frontmatter.ts';

export interface Review {
  verdict: string | undefined;
  reasons: string;
  machineBlock: string | undefined;
}

export function readReview(text: string): Review {
  const lines = records(text);

  let verdict: string | undefined;
  let lastComputed: string | undefined;
  let block: string | undefined;
  let inBlock = false;
  for (const line of lines) {
    if (verdict === undefined && line.startsWith('verdict:')) {
      // awk's $2: fields are runs of blanks; a missing field is ''.
      verdict = line.split(/[ \t]+/)[1] ?? '';
    }
    if (line.startsWith(LABELS.computed)) lastComputed = line;
    if (line.startsWith(MACHINE_HEADING)) {
      block = '';
      inBlock = true;
      continue;
    }
    if (line.startsWith('### ')) inBlock = false;
    if (inBlock) block = `${block ?? ''}${line}\n`;
  }

  let reasons = '';
  if (lastComputed !== undefined) {
    reasons = (lastComputed.split(COMPUTED_SEP)[1] ?? '').replace(/[; ]*$/, '');
  }

  return {
    verdict,
    reasons,
    machineBlock: block === undefined ? undefined : `${MACHINE_HEADING}\n${block}`.replace(/\n+$/, ''),
  };
}

export interface LastRound {
  round: string;
  head: string;
  /** What follows the `baseline:` label, as baselineLine() writes it. */
  baseline: string;
}

export function readLastRound(text: string): LastRound | undefined {
  let round: string | undefined;
  let head: string | undefined;
  let baseline: string | undefined;
  let where: 'top' | 'machine' | 'other' = 'top';
  for (const line of records(text)) {
    const m = /^## Round (\d+)/.exec(line);
    if (m !== null) {
      round = m[1];
      head = undefined;
      baseline = undefined;
      where = 'top';
      continue;
    }
    if (round === undefined) continue;
    if (line.startsWith('### ')) where = line.startsWith(MACHINE_HEADING) ? 'machine' : 'other';
    else if (where === 'top' && head === undefined && line.startsWith('head: ')) head = line.slice('head: '.length).trim();
    else if (where === 'machine' && baseline === undefined && line.startsWith(LABELS.baseline)) baseline = line.slice(LABELS.baseline.length).trim();
  }
  if (round === undefined || head === undefined || head === '' || baseline === undefined) return undefined;
  return { round, head, baseline };
}
