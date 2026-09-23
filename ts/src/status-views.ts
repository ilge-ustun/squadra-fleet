// status.sh's four outputs, from one Status: the terminal table (colour,
// every column as wide as its longest value, so a title is never cut), the
// epic block that leads it, the phone form for the bot (a <pre> block
// wraps at ~40 columns there, so no table: id and title, then base | state
// | round | verdict, between rules, newest first, no colour), and the JSON
// merge.sh reads (one object per story, always an array, numbers as
// numbers, absent values null).
//
// Widths are bash's under the suite's C.UTF-8, quirk included: width_of
// counts characters (${#v}), but bash's printf '%-Ns' pads to N BYTES, so a
// `—` cell (one character, three bytes) gets two spaces fewer than an ASCII
// one — the goldens hold it, and this reproduces it rather than fixing the
// alignment behind a byte-for-byte seam. Pinned non-parities: the epic
// state string is not run through printf's %b; a JSON row is never dropped
// for an odd verdict; DEL is emitted raw.
import type { Detail, EpicRow, Status, StoryRow } from './status.ts';

const ESC = {
  red: '\x1b[31m', grn: '\x1b[32m', ylw: '\x1b[33m', dim: '\x1b[2m', rst: '\x1b[0m',
} as const;
type Palette = { [K in keyof typeof ESC]: string };
const NONE: Palette = { red: '', grn: '', ylw: '', dim: '', rst: '' };

export type Mode = 'default' | 'epics' | 'bot' | 'json';

export interface ViewOptions {
  mode: Mode;
  all: boolean;
  one: string | undefined;
  repoName: string;
  baseBranch: string;
}

function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
/** printf '%-Ns': pads by bytes, whatever the locale (bash 5.2). */
function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - Buffer.byteLength(s)));
}
function colourFor(landing: string, p: Palette): string {
  switch (landing) {
    case 'landed': case 'on epic': return p.grn;
    case 'awaiting merge': return p.ylw;
    case 'needs_human': case 'blocked': return p.red;
    case 'in_progress': return p.ylw;
    default: return p.rst;
  }
}

/** status.sh:84-121. undefined when no story names an epic. */
export function renderEpics(epics: EpicRow[], o: ViewOptions, p: Palette): string | undefined {
  if (epics.length === 0) return undefined;
  let out = '';
  for (const e of epics) {
    const word = e.total === 1 ? 'story' : 'stories';
    if (o.mode === 'bot') {
      out += `${e.name}\n  ${e.total} ${word}, ${e.merged} merged\n`;
      out += e.ahead > 0 ? `  ${e.ahead} ahead of ${o.baseBranch} → /merge ${o.repoName} ${e.name}\n` : `  in ${o.baseBranch}\n`;
      continue;
    }
    const state = e.ahead > 0
      ? `${p.ylw}${e.ahead} ahead of ${o.baseBranch}${p.rst}  → merge.sh ${o.repoName} --epic ${e.name}`
      : `${p.dim}in ${o.baseBranch}${p.rst}`;
    out += `${pad(e.name, 22)} ${e.total} ${word}, ${e.merged} merged  ${state}\n`;
  }
  return out;
}

function renderDetail(d: Detail, p: Palette): string {
  let s = `\n${d.block}`;
  if (d.evidence !== undefined) s += `\n${p.dim}evidence: ${d.evidence.map((n) => `${n} `).join('')}${p.rst}`;
  return `${s}\n`;
}

/** status.sh:276-292. */
export function renderTable(rows: StoryRow[], detail: Detail | undefined, p: Palette): string {
  const w = (h: string, vals: string[]): number => Math.max(cpLen(h), ...vals.map(cpLen));
  const W = {
    id: w('ID', rows.map((r) => r.id)),
    title: w('TITLE', rows.map((r) => r.title)),
    land: w('STATUS', rows.map((r) => r.landing)),
    round: w('R', rows.map((r) => r.round)),
    verdict: w('VERDICT', rows.map((r) => r.verdict)),
    into: w('INTO', rows.map((r) => r.base)),
  };
  const line = (id: string, title: string, c: string, land: string, rst: string, round: string, verdict: string, into: string, notes: string): string =>
    `${pad(id, W.id)}  ${pad(title, W.title)}  ${c}${pad(land, W.land)}${rst}  ${pad(round, W.round)}  ${pad(verdict, W.verdict)}  ${pad(into, W.into)}  ${notes}\n`;
  let out = line('ID', 'TITLE', '', 'STATUS', '', 'R', 'VERDICT', 'INTO', 'NOTES');
  out += `${p.dim}${'─'.repeat(W.id + W.title + W.land + W.round + W.verdict + W.into + 12)}${p.rst}\n`;
  for (const r of rows) {
    out += line(r.id, r.title, colourFor(r.landing, p), r.landing, p.rst, r.round, r.verdict, r.base, r.notes.join(', '));
  }
  if (detail !== undefined) out += renderDetail(detail, p);
  return out;
}

/** status.sh:247-273: the phone. landed and done hidden unless --all or one id. */
export function renderBot(rows: StoryRow[], detail: Detail | undefined, o: ViewOptions): string {
  let out = '';
  let shown = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r === undefined) continue;
    if (!o.all && o.one === undefined && (r.landing === 'landed' || r.landing === 'done')) continue;
    if (!shown) out += '-------\n';
    shown = true;
    const round = /^[0-9]+$/.test(r.round) ? `R${r.round}` : r.round;
    out += `${r.id} ${r.title}\n→ ${r.base} | ${r.landing} | ${round} | ${r.verdict}\n`;
    if (r.notes.length > 0) out += `! ${r.notes.join(', ')}\n`;
    out += '-------\n';
  }
  if (!shown) {
    out += rows.length > 0 ? `nothing in flight — /status-all ${o.repoName} shows what has landed\n` : 'no stories yet\n';
  }
  if (detail !== undefined) out += renderDetail(detail, NONE);
  return out;
}

/** status.sh:204-219, 240: the fourteen keys, in that order. */
export function renderJson(rows: StoryRow[]): string {
  const objs = rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    landing: r.landing,
    round: /^[0-9]+$/.test(r.round) ? Number(r.round) : null,
    verdict: r.verdict === '—' || r.verdict === '' ? null : r.verdict,
    base: r.base,
    branch: r.branch,
    merged: r.merged,
    ahead: r.ahead,
    worktree: r.worktree,
    live: r.live,
    blocked: r.blocked,
    reasons: r.reasons,
  }));
  return `${JSON.stringify(objs, null, 2)}\n`;
}

/** The whole of stdout for one invocation. */
export function renderStatus(st: Status, o: ViewOptions): string {
  const p: Palette = o.mode === 'bot' ? NONE : { ...ESC };
  if (o.mode === 'epics') return renderEpics(st.epics, o, p) ?? 'no story names an epic\n';
  if (o.mode === 'json') return renderJson(st.stories);
  const epics = renderEpics(st.epics, o, p);
  const head = epics === undefined ? '' : `${epics}\n`;
  return head + (o.mode === 'bot' ? renderBot(st.stories, st.detail, o) : renderTable(st.stories, st.detail, p));
}
