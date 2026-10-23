// What a target's git history says about a story, for the event log: the
// times the fleet's own commits record. Read-only; a git that fails is an
// unknown, never a die — a reader of the past must not stop the present.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { builderUsage } from './agents.ts';
import { runStamp, type EventKind, type EventSource, type EventValue, type FleetEvent } from './events.ts';
import { fieldOfText } from './frontmatter.ts';
import { pastEvent } from './journal.ts';
import { runSync } from './proc.ts';

/** `git show <sha>:<path>`; undefined when the commit has no such file. */
function showAt(root: string, sha: string, path: string): string | undefined {
  const r = runSync('git', ['-C', root, 'show', `${sha}:${path}`]);
  return r.status === 0 ? r.stdout : undefined;
}

/** When the story became ready: the oldest commit of the unbroken run of
 *  commits, newest first from HEAD, whose story file says `status: ready`.
 *  Undefined when HEAD's story is not ready — a status edited and not yet
 *  committed, say — or nothing can be read. At most `max` commits are read. */
export function readySince(root: string, id: string, max = 30): Date | undefined {
  const path = `.stories/${id}.md`;
  const r = runSync('git', ['-C', root, 'log', `-n${max}`, '--format=%H %ct', 'HEAD', '--', path]);
  if (r.status !== 0) return undefined;
  let since: Date | undefined;
  for (const line of r.stdout.split('\n')) {
    const [sha, ct] = line.split(' ');
    if (sha === undefined || sha === '' || ct === undefined) continue;
    const text = showAt(root, sha, path);
    if (text === undefined || fieldOfText(text, 'status') !== 'ready') break;
    since = new Date(Number(ct) * 1000);
  }
  return since;
}

// ── the backfill: events for the past the log did not see ───────────────────
//
// Each reader returns events in the log's shape (lib/events.ts), each line
// tagged with where its time comes from: `git` (a commit's time, to the
// second), `machine` (a Machine block's seconds, placed back from its
// `reviewed:` time; `approx` when the order of phases is assumed) or `mtime`
// (when an evidence file was written, in this checkout). What none of them
// says is not made up.

/** A status commit's subject, after `story(<id>): `: the status it set and
 *  who set it; undefined for a builder's commit that names its story. */
export function classifyStatus(rest: string): { status: string; kind: string; by?: string; into?: string; sha?: string } | undefined {
  const by = (m: RegExpExecArray): { by?: string } => (m[1] !== undefined ? { by: m[1] } : {});
  let m: RegExpExecArray | null;
  if (/^draft(?: —.*)?$/.test(rest)) return { status: 'draft', kind: 'draft' };
  if ((m = /^promoted to ready(?: \((.*)\))?$/.exec(rest)) !== null) return { status: 'ready', kind: 'promote', ...by(m) };
  if ((m = /^answered, back to ready(?: \((.*)\))?$/.exec(rest)) !== null) return { status: 'ready', kind: 'answer', ...by(m) };
  if ((m = /^wait for the reviewer, then review(?: \((.*)\))?$/.exec(rest)) !== null) return { status: 'ready', kind: 'wait', ...by(m) };
  if ((m = /^reviewed by Claude instead(?: \((.*)\))?$/.exec(rest)) !== null) return { status: 'ready', kind: 'fallback', ...by(m) };
  if ((m = /^(ready|in_progress|done|blocked|needs_human)$/.exec(rest)) !== null) return { status: m[1] ?? '', kind: m[1] ?? '' };
  if ((m = /^merged into (\S+) at ([0-9a-f]{7,})$/.exec(rest)) !== null) return { status: 'merged', kind: 'merged', into: m[1] ?? '', sha: m[2] ?? '' };
  if ((m = /^reset to (ready|draft)$/.exec(rest)) !== null) return { status: m[1] ?? '', kind: 'reset' };
  if ((m = /^merge into (\S+) reverted$/.exec(rest)) !== null) return { status: 'reverted', kind: 'revert', into: m[1] ?? '' };
  if (/^declined\b/.test(rest)) return { status: 'declined', kind: 'declined' };
  return undefined;
}

const epicOf = (base: string | undefined): string | undefined => (base !== undefined && base.startsWith('epic/') ? base : undefined);
/** How a launch that git saw start ended, from the status that followed it. */
const LAUNCH_END: Record<string, string> = { done: 'PASS', needs_human: 'NEEDS_HUMAN', blocked: 'BLOCKED', ready: 'DIED', draft: 'RESET' };

/** Every status commit and merge commit this checkout knows — HEAD and
 *  origin's branches — oldest first, as events: a `status` mark for each
 *  status, a `promote`, `answer`, `reset` or `revert` mark where one was
 *  made, a `launch` span from each in_progress to the status that ended it,
 *  and a `merge`, `land` or `epic_merge` mark for each merge commit. */
export function gitEvents(root: string, repo: string): FleetEvent[] {
  const r = runSync('git', ['-C', root, 'log', 'HEAD', '--remotes=origin', '--format=%H%x09%ct%x09%s', '--grep=^story(', '--grep=^merge('], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const out: FleetEvent[] = [];
  const open = new Map<string, { at: Date; runId: string }>();
  for (const line of r.stdout.split('\n').reverse()) {
    const [sha = '', ct = '', ...rest] = line.split('\t');
    const subject = rest.join('\t');
    if (sha === '' || ct === '') continue;
    const at = new Date(Number(ct) * 1000);
    const commit = sha.slice(0, 8);
    let m: RegExpExecArray | null;
    if ((m = /^merge\((epic\/[^)]+)\): (\S+) into (\S+)/.exec(subject)) !== null) {
      out.push(pastEvent(at, { run_id: `${repo}.${m[1]?.replace('/', '-')}.git`, repo, epic: m[1], pass: 'epic_merge', event: 'mark', result: 'MERGED', branch: m[2], into: m[3], sha: commit, source: 'git' }));
      continue;
    }
    if ((m = /^merge\(([^)/]+)\): (\S+) into (\S+)/.exec(subject)) !== null) {
      const into = m[3] ?? '';
      out.push(pastEvent(at, {
        run_id: `${repo}.${m[1]}.git`, repo, story: m[1], epic: epicOf(into), pass: into.startsWith('epic/') ? 'merge' : 'land', event: 'mark', result: 'MERGED', branch: m[2], into, sha: commit, source: 'git',
      }));
      continue;
    }
    if ((m = /^story\(([^)]+)\): (.*)$/.exec(subject)) === null) continue;
    const id = m[1] ?? '';
    const c = classifyStatus(m[2] ?? '');
    if (c === undefined) continue;
    const f = { run_id: `${repo}.${id}.git`, repo, story: id, source: 'git' as const };
    out.push(pastEvent(at, { ...f, pass: 'status', event: 'mark', name: c.status, reason: m[2], by: c.by, into: c.into, sha: c.sha ?? commit }));
    if (c.kind === 'promote') out.push(pastEvent(at, { ...f, pass: 'promote', event: 'mark', by: c.by, result: 'READY', sha: commit }));
    else if (c.kind === 'answer' || c.kind === 'wait' || c.kind === 'fallback') out.push(pastEvent(at, { ...f, pass: 'answer', event: 'mark', name: c.kind, by: c.by, result: 'READY', sha: commit }));
    else if (c.kind === 'reset') out.push(pastEvent(at, { ...f, pass: 'reset', event: 'mark', result: c.status.toUpperCase(), sha: commit }));
    else if (c.kind === 'revert') out.push(pastEvent(at, { ...f, pass: 'revert', event: 'mark', result: 'REVERTED', into: c.into, sha: commit }));
    const was = open.get(id);
    if (was !== undefined && LAUNCH_END[c.status] !== undefined) {
      open.delete(id);
      out.push(pastEvent(at, { ...f, run_id: was.runId, span: 'launch', pass: 'launch', event: 'end', dur_s: Math.round(at.getTime() - was.at.getTime()) / 1000, result: LAUNCH_END[c.status] }));
    }
    if (c.status === 'in_progress') {
      const runId = `${repo}.${id}.${runStamp(at)}.git`;
      open.set(id, { at, runId });
      out.push(pastEvent(at, { ...f, run_id: runId, span: 'launch', pass: 'launch', event: 'start' }));
    }
  }
  return out;
}

/** When each epic of origin was created: the first line of its reflog in
 *  this checkout (git keeps 90 days of it), as an `epic` mark. */
export function epicsCreated(root: string, repo: string): FleetEvent[] {
  const refs = runSync('git', ['-C', root, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/epic/']);
  const common = runSync('git', ['-C', root, 'rev-parse', '--git-common-dir']);
  if (refs.status !== 0 || common.status !== 0) return [];
  const gitDir = resolve(root, common.stdout.trim());
  const out: FleetEvent[] = [];
  for (const ref of refs.stdout.split('\n').filter((l) => l !== '')) {
    let first = '';
    try {
      first = readFileSync(join(gitDir, 'logs', ref), 'utf8').split('\n')[0] ?? '';
    } catch {
      continue;
    }
    const m = /^[0-9a-f]{40} ([0-9a-f]{40}) .*? (\d{9,11}) [+-]\d{4}\t(.*)$/.exec(first);
    if (m === null) continue;
    const epic = ref.slice('refs/remotes/origin/'.length);
    out.push(pastEvent(new Date(Number(m[2]) * 1000), {
      run_id: `${repo}.${epic.replace('/', '-')}.git`, repo, epic, pass: 'epic', event: 'mark', name: 'created', result: 'CREATED', sha: m[1]?.slice(0, 8), reason: `reflog: ${m[3]}`, source: 'git',
    }));
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

export interface RoundFacts {
  n: number;
  computed: string;
  head: string;
  reviewed: Date;
  timing?: { builder: number; baseline: number; reviewer: number; mutations: number; total: number };
  builderModel?: string;
  builderUsed?: string;
  reviewerCli?: string;
  reviewerModel?: string;
  reviewerUsed?: string;
  baseline?: string;
  reasons: string;
}

/** Each `## Round N — VERDICT` section with a `reviewed:` time. */
export function reviewRounds(text: string): RoundFacts[] {
  const out: RoundFacts[] = [];
  for (const part of text.split(/^## Round /m).slice(1)) {
    const h = /^(\d+) — (\S+)/.exec(part);
    const g = (re: RegExp): string | undefined => re.exec(part)?.[1];
    const reviewed = g(/^reviewed: (\S+)$/m);
    if (h === null || reviewed === undefined || Number.isNaN(Date.parse(reviewed))) continue;
    const r: RoundFacts = { n: Number(h[1]), computed: h[2] ?? '', head: (g(/^head: ([0-9a-f]+)$/m) ?? '').slice(0, 8), reviewed: new Date(reviewed), reasons: '' };
    const t = /^timing:\s+builder (\d+)s \| baseline (\d+)s \| reviewer (\d+)s \| mutations (\d+)s \| total (\d+)s/m.exec(part);
    if (t !== null) r.timing = { builder: Number(t[1]), baseline: Number(t[2]), reviewer: Number(t[3]), mutations: Number(t[4]), total: Number(t[5]) };
    const b = g(/^builder:\s+(.*)$/m);
    if (b !== undefined) {
      const [asked = '', used] = b.split(' → ');
      r.builderModel = asked.trim();
      if (used !== undefined) r.builderUsed = used.trim();
    }
    const rv = g(/^reviewer:\s+(.*)$/m);
    if (rv !== undefined) {
      const [asked = '', used] = rv.split(' → ');
      const [cli = '', model] = asked.replace(' (fallback)', '').trim().split(/\s+/);
      r.reviewerCli = cli;
      if (model !== undefined) r.reviewerModel = model;
      if (used !== undefined) r.reviewerUsed = used.trim();
    }
    const base = g(/^baseline:\s+(.*)$/m);
    if (base !== undefined) r.baseline = base.trim();
    const computed = g(/^computed:\s+(.*)$/m) ?? '';
    r.reasons = (computed.split(' — ').slice(1).join(' — ')).replace(/[; ]*$/, '');
    out.push(r);
  }
  return out;
}

export interface RoundSource {
  repo: string;
  story: string;
  epic?: string | undefined;
  rounds: readonly RoundFacts[];
}

const ago = (d: Date, secs: number): Date => new Date(d.getTime() - secs * 1000);

/** A round's phases, placed back from its `reviewed:` time by its Machine
 *  block's seconds: the round started `total` seconds before; the builder
 *  first, then the baseline (approx: fixes and the tdd check interleave), then
 *  the reviewer and the mutations, which end at `reviewed:`. */
export function machineEvents(o: RoundSource & { usage?: (n: number) => { turns?: number; costUsd?: number } }): FleetEvent[] {
  const out: FleetEvent[] = [];
  for (const r of o.rounds) {
    const t = r.timing;
    if (t === undefined) continue;
    const runId = `${o.repo}.${o.story}.${runStamp(ago(r.reviewed, t.total))}.machine`;
    const f = (span: string | undefined, pass: string, event: EventKind, x: Readonly<Record<string, EventValue>> = {}): Record<string, EventValue> & { pass: string; event: EventKind; source: 'machine' } => ({
      run_id: runId, span, repo: o.repo, story: o.story, epic: o.epic, round: r.n, ...x, pass, event, source: 'machine',
    });
    const start = ago(r.reviewed, t.total);
    const built = new Date(start.getTime() + t.builder * 1000);
    const based = new Date(built.getTime() + t.baseline * 1000);
    const mutating = ago(r.reviewed, t.mutations);
    const reviewing = ago(mutating, t.reviewer);
    const u = o.usage?.(r.n) ?? {};
    const dur = (a: Date, b: Date): number => Math.round(b.getTime() - a.getTime()) / 1000;
    const k = `r${r.n}`;
    out.push(
      pastEvent(start, f(k, 'round', 'start')),
      pastEvent(start, f(`${k}.build`, 'builder', 'start', { name: 'build', agent: 'claude', model: r.builderModel })),
      pastEvent(built, f(`${k}.build`, 'builder', 'end', { name: 'build', agent: 'claude', model: r.builderModel, model_used: r.builderUsed, dur_s: t.builder, turns: u.turns, cost_usd: u.costUsd, approx: true })),
      pastEvent(built, f(`${k}.baseline`, 'baseline', 'start', { name: 'all', approx: true })),
      pastEvent(based, f(`${k}.baseline`, 'baseline', 'end', { name: 'all', dur_s: t.baseline, result: r.baseline === undefined ? undefined : /RED/.test(r.baseline) ? 'RED' : 'GREEN', reason: r.baseline, approx: true })),
      pastEvent(reviewing, f(`${k}.reviewer`, 'reviewer', 'start', { agent: r.reviewerCli, model: r.reviewerModel })),
      pastEvent(mutating, f(`${k}.reviewer`, 'reviewer', 'end', { agent: r.reviewerCli, model: r.reviewerModel, model_used: r.reviewerUsed, dur_s: dur(reviewing, mutating) })),
      pastEvent(mutating, f(`${k}.mut`, 'mutation', 'start', { name: 'all' })),
      pastEvent(r.reviewed, f(`${k}.mut`, 'mutation', 'end', { name: 'all', dur_s: t.mutations })),
      pastEvent(r.reviewed, f(undefined, 'verdict', 'mark', { result: r.computed, reason: r.reasons, head: r.head })),
      pastEvent(r.reviewed, f(k, 'round', 'end', { dur_s: t.total, result: r.computed })),
    );
  }
  return out;
}

const mtimeOf = (p: string): Date | undefined => {
  try {
    return statSync(p).mtime;
  } catch {
    return undefined;
  }
};

/** What a round's evidence files say of when they were written, in this
 *  checkout: each baseline step ends when its log was written, each
 *  mutation when its .result was. A time outside the round — a file git
 *  checked out later, say — says nothing and is skipped. */
export function mtimeEvents(o: RoundSource & { root: string }): FleetEvent[] {
  const out: FleetEvent[] = [];
  for (const r of o.rounds) {
    const t = r.timing;
    if (t === undefined) continue;
    const dir = join(o.root, '.review', o.story, `round-${r.n}`);
    const begin = ago(r.reviewed, t.total + 60);
    const finish = new Date(r.reviewed.getTime() + 60_000);
    const inRound = (d: Date | undefined): d is Date => d !== undefined && d >= begin && d <= finish;
    const runId = `${o.repo}.${o.story}.${runStamp(ago(r.reviewed, t.total))}.machine`;
    const f = (span: string, pass: string, event: EventKind, source: EventSource, x: Readonly<Record<string, EventValue>>): Record<string, EventValue> & { pass: string; event: EventKind; source: EventSource } => ({
      run_id: runId, span, repo: o.repo, story: o.story, epic: o.epic, round: r.n, ...x, pass, event, source,
    });
    // The baseline's steps, from the machine's start of the baseline.
    let from = new Date(ago(r.reviewed, t.total).getTime() + t.builder * 1000);
    let fromSource: EventSource = 'machine';
    for (const step of ['test', 'build', 'lint', 'e2e']) {
      const at = mtimeOf(join(dir, 'baseline', `${step}.log`));
      if (!inRound(at) || at < from) continue;
      const k = `r${r.n}.baseline.${step}`;
      out.push(pastEvent(from, f(k, 'baseline', 'start', fromSource, { name: step })), pastEvent(at, f(k, 'baseline', 'end', 'mtime', { name: step, dur_s: Math.round(at.getTime() - from.getTime()) / 1000, evidence: `.review/${o.story}/round-${r.n}/baseline/${step}.log` })));
      from = at;
      fromSource = 'mtime';
    }
    // The mutations, in the order their results were written, from the
    // machine's start of the mutation phase.
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, 'mutations')).filter((n) => n.endsWith('.result'));
    } catch {
      /* no mutations */
    }
    from = ago(r.reviewed, t.mutations);
    fromSource = 'machine';
    const timed = names.map((n) => ({ n, at: mtimeOf(join(dir, 'mutations', n)) })).filter((x): x is { n: string; at: Date } => inRound(x.at) && x.at >= from);
    for (const { n, at } of timed.sort((a, b) => a.at.getTime() - b.at.getTime())) {
      const name = n.slice(0, -'.result'.length);
      const cls = (readFileSync(join(dir, 'mutations', n), 'utf8').split('\n')[0] ?? '').trim();
      const k = `r${r.n}.mut.${name}`;
      out.push(
        pastEvent(from, f(k, 'mutation', 'start', fromSource, { name, ac: /^(AC\d+)/.exec(name)?.[1] })),
        pastEvent(at, f(k, 'mutation', 'end', 'mtime', { name, ac: /^(AC\d+)/.exec(name)?.[1], dur_s: Math.round(at.getTime() - from.getTime()) / 1000, result: cls, evidence: `.review/${o.story}/round-${r.n}/mutations/${n}` })),
      );
      from = at;
      fromSource = 'mtime';
    }
  }
  return out;
}

/** What a round's builder calls cost: the turns and dollars of every
 *  builder*.json in its evidence, summed; empty when none says. */
export function roundUsage(root: string, story: string, n: number): { turns?: number; costUsd?: number } {
  const dir = join(root, '.review', story, `round-${n}`);
  let turns = 0;
  let cost = 0;
  let seen = false;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => /^builder.*\.json$/.test(f));
  } catch {
    return {};
  }
  for (const f of names) {
    let text: string;
    try {
      text = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const u = builderUsage(text);
    if (u.turns !== undefined) { turns += u.turns; seen = true; }
    if (u.costUsd !== undefined) { cost += u.costUsd; seen = true; }
  }
  return seen ? { turns, costUsd: Math.round(cost * 10000) / 10000 } : {};
}
