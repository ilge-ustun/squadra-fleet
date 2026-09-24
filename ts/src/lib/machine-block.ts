// The round section of .review/<id>.md — what launch.sh appended with a
// heredoc at its lines 715-745 — rendered byte for byte. The labels and the
// separators are exported so the reader that status.sh (seam 3) grows can
// split the same text this writes.
//
//   ## Round N — VERDICT            the computed verdict, after any veto
//   head / commits this round / reviewed
//   ### Machine
//   baseline: … timing: … builder: … reviewer: … acs: … scope: … model: … computed: …
//   mutations: / probes: tables     each only when it has rows
//   ### Builder said / ### Reviewer the two texts, verbatim
//
// The renderer takes structured values. Where bash carried a raw string
// (acs, scope hits) the shape it could produce is reproduced exactly:
// every id and every hit followed by one space.
import type { Baseline, MutRow, ProbeRow, Verdict } from './types.ts';

export const MACHINE_HEADING = '### Machine';
export const BUILDER_HEADING = '### Builder said';
export const REVIEWER_HEADING = '### Reviewer';
export const COMPUTED_SEP = ' — ';
export const REASON_END = '; ';
/** Labels are padded to this width: `computed: ` is ten characters. */
export const LABEL_WIDTH = 10;
export const LABELS = {
  baseline: 'baseline:',
  timing: 'timing:',
  builder: 'builder:',
  reviewer: 'reviewer:',
  acs: 'acs:',
  scope: 'scope:',
  model: 'model:',
  computed: 'computed:',
} as const;

export interface Timing {
  build: string;
  base: string;
  review: string;
  mut: string;
  total: string;
}

export interface RoundSection {
  round: string;
  headSha: string;
  roundCommits: string;
  /** `date -Iseconds`: formatIsoSeconds(new Date()) at write time. */
  reviewedAt: string;
  baseline: Baseline;
  timing: Timing;
  builderModel: string;
  /** What the builder actually ran on (claude's modelUsage), shown after
   *  the name asked for when it differs; '' or absent when unknown. */
  builderModelUsed?: string;
  /** '' when codex runs on its own default. */
  reviewerModel: string;
  /** What codex actually ran on (its session file); '' or absent when unknown. */
  reviewerModelUsed?: string;
  acIds: string[];
  scope: string;
  scopeHits: string[];
  model: Verdict;
  computed: Verdict;
  reasons: string[];
  mutRows: MutRow[];
  probeRows: ProbeRow[];
  /** The builder.md file: the message plus one newline. Inserted verbatim. */
  builderText: Buffer;
  /** The reviewer.md file, likewise. */
  reviewerText: Buffer;
}

/** One line of MUT_ROWS, split as both `awk` and `read -r ac cls slug` split
 *  it: first word, second word, the rest. A missing word is ''. Blank lines
 *  are not rows. */
export function parseMutRows(text: string): MutRow[] {
  const rows: MutRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\S+)(?:\s+(\S+))?(?:\s+(.*?))?\s*$/.exec(line);
    if (m === null) continue;
    rows.push({ ac: m[1] ?? '', cls: m[2] ?? '', slug: m[3] ?? '' });
  }
  return rows;
}

/** One line of PROBE_ROWS: name, class (class may be missing). */
export function parseProbeRows(text: string): ProbeRow[] {
  const rows: ProbeRow[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\S+)(?:\s+(\S+))?\s*$/.exec(line);
    if (m === null) continue;
    rows.push({ name: m[1] ?? '', cls: m[2] ?? '' });
  }
  return rows;
}

/** `AC1 AC2 ` → ['AC1', 'AC2']; the same for scope hits. */
export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((w) => w !== '');
}

/** `date -Iseconds`: local time, seconds, numeric offset with a colon. */
export function formatIsoSeconds(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

const label = (k: keyof typeof LABELS): string => LABELS[k].padEnd(LABEL_WIDTH);

/** awk 'NF { printf "%-4s %-13s %s\n", $1, $2, $3 }' — the table's first
 *  field of the slug only, as awk's $3 is. */
function mutationTable(rows: MutRow[]): string {
  return rows.map((r) => `${r.ac.padEnd(4)} ${r.cls.padEnd(13)} ${r.slug.split(/\s+/)[0] ?? ''}`).join('\n');
}

/** awk 'NF { printf "%-13s %s\n", $2, $1 }' — class first, then the name. */
function probeTable(rows: ProbeRow[]): string {
  return rows.map((r) => `${r.cls.padEnd(13)} ${r.name}`).join('\n');
}

/** ` → <model>` when an agent resolved the name it was given to another. */
const resolved = (asked: string, used: string | undefined): string =>
  used === undefined || used === '' || used === asked ? '' : ` → ${used}`;

export function renderRoundSection(s: RoundSection): Buffer {
  const b = s.baseline;
  const t = s.timing;
  const hits = s.scopeHits.map((h) => `${h} `).join('');
  const reasons = s.reasons.map((r) => `${r}${REASON_END}`).join('');
  const mut = mutationTable(s.mutRows);
  const probes = probeTable(s.probeRows);
  const head =
    `\n## Round ${s.round}${COMPUTED_SEP}${s.computed}\n\n` +
    `head: ${s.headSha}\n` +
    `commits this round: ${s.roundCommits}\n` +
    `reviewed: ${s.reviewedAt}\n\n` +
    `${MACHINE_HEADING}\n\n` +
    `${label('baseline')}test ${b.test} | build ${b.build} | lint ${b.lint}\n` +
    `${label('timing')}builder ${t.build}s | baseline ${t.base}s | reviewer ${t.review}s | mutations ${t.mut}s | total ${t.total}s\n` +
    `${label('builder')}${s.builderModel}${resolved(s.builderModel, s.builderModelUsed)}\n` +
    `${label('reviewer')}codex${s.reviewerModel === '' ? '' : ` ${s.reviewerModel}`}${resolved(s.reviewerModel, s.reviewerModelUsed)}\n` +
    `${label('acs')}${s.acIds.map((a) => `${a} `).join('')}\n` +
    `${label('scope')}${s.scope}${hits === '' ? '' : ` ${hits}`}\n` +
    `${label('model')}${s.model}\n` +
    `${label('computed')}${s.computed}${reasons === '' ? '' : `${COMPUTED_SEP}${reasons}`}\n` +
    (mut === '' ? '' : `mutations:\n${mut}\n`) +
    (probes === '' ? '' : `probes:\n${probes}`) +
    `\n\n${BUILDER_HEADING}\n\n`;
  return Buffer.concat([
    Buffer.from(head, 'utf8'),
    s.builderText,
    Buffer.from(`\n${REVIEWER_HEADING}\n\n`, 'utf8'),
    s.reviewerText,
  ]);
}
