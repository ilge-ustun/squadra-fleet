// The queue's journal as events, for the past the event log did not see.
// Every line the launcher, the queue and the merge print (`==>`, `!!`, `XX`)
// reaches the journal of the unit that ran them, fleet-queue@<repo> (and,
// before 21 Oct, the one fleet-queue unit), to the microsecond and with the
// pid of the process that printed it. This turns them back into the passes
// the log writes today: the pickup, the launch, the install, each round,
// builder call, baseline, tdd pair, the scope, the reviewer, each mutation
// and probe, the verdict, and the queue's merge.
//
// The journal is free text, not a contract, and it rotates. What it does not
// say stays unsaid: a reviewer's end is the Machine block's seconds after its
// start (source `machine`), or unknown; a launch the journal loses without a
// word — a reboot — keeps its spans open.
import { formatIsoMs, runStamp, type EventKind, type EventSource, type EventValue, type FleetEvent } from './events.ts';
import { runSync } from './proc.ts';

export interface JournalLine {
  at: Date;
  ident: string;
  pid: number;
  /** The message, colour codes removed. */
  msg: string;
}

const LINE = /^(\S+) \S+ ([^\s[]+)\[(\d+)\]: (.*)$/;
const ANSI = /\x1b\[[0-9;]*m/g;

/** `journalctl -o short-iso-precise` output, one entry per line that parses. */
export function parseJournal(text: string): JournalLine[] {
  const out: JournalLine[] = [];
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw);
    if (m === null) continue;
    const at = new Date(m[1] ?? '');
    if (Number.isNaN(at.getTime())) continue;
    out.push({ at, ident: m[2] ?? '', pid: Number(m[3]), msg: (m[4] ?? '').replace(ANSI, '').trimEnd() });
  }
  return out;
}

/** An event a reader made: the log's shape, its time from `source`. */
export function pastEvent(at: Date, f: Readonly<Record<string, EventValue>> & { pass: string; event: EventKind; source: EventSource }): FleetEvent {
  const o: Record<string, unknown> = { v: 1, ts: formatIsoMs(at) };
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') o[k] = v;
  return o as FleetEvent;
}

export interface JournalOptions {
  repo: string;
  /** What the Machine block says of a round: the reviewer's seconds, and
   *  the computed verdict's reasons. */
  machine?: (story: string, round: number) => { reviewer?: number | undefined; reasons?: string | undefined } | undefined;
}

type Fields = Record<string, EventValue>;
interface Open { pass: string; at: Date; fields: Fields }
/** One process the journal names by its pid: a launch, a merge or a drain. */
interface Proc {
  repo: string;
  story?: string | undefined;
  epic?: string | undefined;
  model?: string | undefined;
  runId?: string | undefined;
  round?: number | undefined;
  open: Map<string, Open>;
  baselines: number;
  prevAt?: Date | undefined;
  /** Where the next mutation starts: the reviewer's end, once known. */
  afterReviewer?: Date | undefined;
}

/** The events of one repo's lines, in the order the lines came. */
export function journalEvents(lines: readonly JournalLine[], o: JournalOptions): FleetEvent[] {
  const out: FleetEvent[] = [];
  const procs = new Map<number, Proc>();
  let legacyRepo = '';

  const base = (p: Proc, span: string | undefined, f: Fields, round = true): Fields => ({
    run_id: p.runId, span, repo: p.repo, story: p.story, epic: p.epic, round: round ? p.round : undefined, ...f,
  });
  const emit = (p: Proc, at: Date, pass: string, event: EventKind, f: Fields, source: EventSource = 'journal'): void => {
    if (p.repo !== o.repo) return;
    out.push(pastEvent(at, { ...f, pass, event, source }));
  };
  const start = (p: Proc, span: string, pass: string, at: Date, f: Fields = {}, round = true): void => {
    p.open.set(span, { pass, at, fields: base(p, span, f, round) });
    emit(p, at, pass, 'start', base(p, span, f, round));
  };
  const end = (p: Proc, span: string, at: Date, f: Fields = {}, source: EventSource = 'journal'): void => {
    const s = p.open.get(span);
    if (s === undefined) return;
    p.open.delete(span);
    emit(p, at, s.pass, 'end', { ...s.fields, dur_s: Math.round(at.getTime() - s.at.getTime()) / 1000, ...f }, source);
  };
  const mark = (p: Proc, pass: string, at: Date, f: Fields = {}): void => emit(p, at, pass, 'mark', base(p, undefined, f));
  const endAll = (p: Proc, at: Date, f: Fields): void => {
    for (const span of [...p.open.keys()].reverse()) end(p, span, at, f);
  };
  /** A span that ends at this line and started at the line before it. */
  const pair = (p: Proc, span: string, pass: string, from: Date, at: Date, f: Fields, result: string, extra: Fields = {}): void => {
    start(p, span, pass, from, f);
    end(p, span, at, { result, ...extra });
  };

  for (const l of lines) {
    // systemd's own lines: a unit killed ends what its processes left open.
    if (l.ident === 'systemd') {
      const m = /^fleet-queue(?:@([^.\s]+))?\.service: (Main process exited, code=killed.*|Failed with result 'timeout'.*)$/.exec(l.msg);
      if (m === null) continue;
      const repo = m[1] ?? legacyRepo;
      for (const p of procs.values()) if (p.repo === repo && p.open.size > 0) endAll(p, l.at, { result: 'KILLED', reason: m[2] });
      continue;
    }
    let repo: string;
    if (l.ident.startsWith('fleet-queue-')) repo = l.ident.slice('fleet-queue-'.length);
    else if (l.ident === 'fleet-queue') {
      const r = /^==> \[queue\] repo: (\S+)$/.exec(l.msg);
      if (r !== null) legacyRepo = r[1] ?? '';
      repo = procs.get(l.pid)?.repo ?? legacyRepo;
    } else continue;
    let p = procs.get(l.pid);
    if (p === undefined) {
      p = { repo, open: new Map(), baselines: 0 };
      procs.set(l.pid, p);
    }
    const prev = p.prevAt ?? l.at;
    p.prevAt = l.at;
    const lead = l.msg.slice(0, 3);
    if (lead !== '==>' && lead !== '!! ' && lead !== 'XX ') continue;
    const msg = l.msg.replace(/^(==>|!!|XX) /, '');
    let m: RegExpExecArray | null;

    // ── the queue ─────────────────────────────────────────────────────────
    if ((m = /^\[queue\] story (\S+) \((\d+) of at most \d+\)$/.exec(msg)) !== null) {
      p.runId ??= `${repo}.drain.${runStamp(l.at)}.${l.pid}`;
      emit(p, l.at, 'queue', 'mark', { run_id: p.runId, repo, story: m[1], name: 'pickup', n: Number(m[2]) });
      continue;
    }
    if (msg.startsWith('[queue] ')) continue;

    // ── a launch ──────────────────────────────────────────────────────────
    if ((m = /^base: (\S+) \(from the story\)$/.exec(msg)) !== null) { p.epic = m[1]?.startsWith('epic/') ? m[1] : undefined; continue; }
    if ((m = /^model: (\S+) \(from the story\)$/.exec(msg)) !== null) { p.model = m[1]; continue; }
    if ((m = /^story (\S+)$/.exec(msg)) !== null) {
      p.story = m[1];
      p.runId = `${repo}.${m[1]}.${runStamp(l.at)}.${l.pid}`;
      start(p, 'launch', 'launch', l.at, { pid: l.pid, model: p.model }, false);
      continue;
    }
    if ((m = /^merging (story\/(\S+)|epic\/\S+) into (\S+) \(at [0-9a-f]+\)$/.exec(msg)) !== null) {
      const into = m[3] ?? '';
      p.story = m[2];
      p.epic = m[2] === undefined ? m[1] : into.startsWith('epic/') ? into : undefined;
      p.runId = `${repo}.${m[2] ?? (m[1] ?? '').replace('/', '-')}.${runStamp(l.at)}.${l.pid}`;
      start(p, 'merge', m[2] === undefined ? 'epic_merge' : into.startsWith('epic/') ? 'merge' : 'land', l.at, { pid: l.pid, branch: m[1], into }, false);
      continue;
    }
    if (p.runId === undefined) continue;
    const r = p.round;
    const story = p.story ?? '';

    if (msg === 'installing deps') start(p, 'install.builder', 'install', l.at, { name: 'builder' }, false);
    else if (/^base [0-9a-f]{8}$/.test(msg)) end(p, 'install.builder', l.at, { result: 'OK' });
    else if ((m = /^round (\d+) of \d+$/.exec(msg)) !== null) {
      p.round = Number(m[1]);
      p.baselines = 0;
      p.afterReviewer = undefined;
      start(p, `r${p.round}`, 'round', l.at);
    } else if ((m = /^builder: ([A-Za-z][A-Za-z0-9._-]*)$/.exec(msg)) !== null) {
      start(p, `r${r}.build`, 'builder', l.at, { name: 'build', agent: 'claude', model: m[1] });
    } else if ((m = /^builder: (\d+) commit\(s\) this round, \d+ total, head ([0-9a-f]+)$/.exec(msg)) !== null) {
      end(p, `r${r}.build`, l.at, { result: 'OK', commits: Number(m[1]), head: m[2] });
    } else if ((m = /^baseline RED \((.*)\) — back to the builder, fix (\d+) of \d+$/.exec(msg)) !== null) {
      start(p, `r${r}.baseline-fix-${m[2]}`, 'builder', l.at, { name: `baseline-fix-${m[2]}`, agent: 'claude', reason: `baseline RED: ${m[1]}` });
    } else if ((m = /^baseline fix (\d+): (\d+) commit\(s\) this round, head ([0-9a-f]+)$/.exec(msg)) !== null) {
      end(p, `r${r}.baseline-fix-${m[1]}`, l.at, { result: 'OK', head: m[3] });
    } else if ((m = /^tdd check: not every pair is RED — back to the builder, fix (\d+) of \d+$/.exec(msg)) !== null) {
      start(p, `r${r}.tdd-fix-${m[1]}`, 'builder', l.at, { name: `tdd-fix-${m[1]}`, agent: 'claude' });
    } else if ((m = /^tdd fix (\d+): .*head ([0-9a-f]+)/.exec(msg)) !== null) {
      end(p, `r${r}.tdd-fix-${m[1]}`, l.at, { result: 'OK', head: m[2] });
    } else if ((m = /^(baseline|tdd) fix (\d+) (made no commit|changed nothing)/.exec(msg)) !== null) {
      end(p, `r${r}.${m[1]}-fix-${m[2]}`, l.at, { result: 'OK', commits: 0 });
    } else if ((m = /^reviewer worktree at ([0-9a-f]+)$/.exec(msg)) !== null) {
      p.baselines += 1;
      start(p, `r${r}.baseline.${p.baselines}`, 'baseline', l.at, { name: 'all', head: m[1], reason: "from the reviewer tree's creation, its install included" });
    } else if ((m = /^baseline: (.*)$/.exec(msg)) !== null) {
      end(p, `r${r}.baseline.${p.baselines}`, l.at, { result: /RED/.test(m[1] ?? '') ? 'RED' : 'GREEN', reason: m[1] });
    } else if ((m = /^tdd check (\d+): mutation (\S+): (\S+)/.exec(msg)) !== null) {
      pair(p, `r${r}.tdd.${m[1]}.${m[2]}`, 'tdd', prev, l.at, { name: m[2], ac: /^(AC\d+)/.exec(m[2] ?? '')?.[1], check: Number(m[1]) }, m[3] ?? '');
    } else if ((m = /^scope: (CLEAN|VIOLATION)(.*)$/.exec(msg)) !== null) {
      mark(p, 'scope', l.at, { result: m[1], reason: m[2]?.trim() });
    } else if ((m = /^reviewer: (codex|claude)(?: ([^ (]\S*))?( \(fallback\))?$/.exec(msg)) !== null) {
      start(p, `r${r}.reviewer`, 'reviewer', l.at, { agent: m[1], model: m[2] });
      const secs = r === undefined ? undefined : o.machine?.(story, r)?.reviewer;
      if (secs !== undefined) {
        p.afterReviewer = new Date(l.at.getTime() + secs * 1000);
      }
    } else if ((m = /^(mutation|probe) (\S+): (\S+)( \(run by the tdd check at this head\))?$/.exec(msg)) !== null) {
      let from = prev;
      if (p.open.has(`r${r}.reviewer`)) {
        const until = p.afterReviewer !== undefined && p.afterReviewer <= l.at ? p.afterReviewer : prev;
        end(p, `r${r}.reviewer`, until, {}, p.afterReviewer !== undefined && p.afterReviewer <= l.at ? 'machine' : 'journal');
        from = until;
      }
      const kind = m[1] === 'probe' ? 'probe' : 'mutation';
      const reused = m[4] !== undefined ? true : undefined;
      pair(p, `r${r}.${kind === 'probe' ? 'probe' : 'mut'}.${m[2]}`, kind, from, l.at, { name: m[2], ac: /^(AC\d+)/.exec(m[2] ?? '')?.[1], reused }, m[3] ?? '');
    } else if ((m = /^round (\d+): (PASS|FAIL|SPEC|UNPARSEABLE)$/.exec(msg)) !== null) {
      if (p.open.has(`r${r}.reviewer`)) end(p, `r${r}.reviewer`, prev);
      const reasons = o.machine?.(story, Number(m[1]))?.reasons;
      mark(p, 'verdict', l.at, { result: m[2], reason: reasons });
      end(p, `r${m[1]}`, l.at, { result: m[2] });
    } else if ((m = /^round (\d+): the reviewer's provider refused the call — (.*)$/.exec(msg)) !== null) {
      end(p, `r${r}.reviewer`, l.at, { result: 'UNAVAILABLE', reason: m[2] });
      mark(p, 'verdict', l.at, { result: 'UNAVAILABLE', reason: m[2] });
      endAll(p, l.at, { result: 'UNAVAILABLE' });
    } else if ((m = /^round (\d+): Claude refused (.*?) — (.*)$/.exec(msg)) !== null) {
      for (const span of [...p.open.keys()].filter((s) => p.open.get(s)?.pass === 'builder')) end(p, span, l.at, { result: 'REFUSED', reason: m[3] });
      endAll(p, l.at, { result: 'BUILDER_REFUSED', reason: m[3] });
    } else if (msg.startsWith('BLOCKED — ')) {
      for (const span of [...p.open.keys()].filter((s) => p.open.get(s)?.pass === 'builder')) end(p, span, l.at, { result: 'BLOCKED' });
      mark(p, 'blocked', l.at);
      endAll(p, l.at, { result: 'BLOCKED' });
    } else if ((m = /^VERDICT: (\S+) after \d+ round/.exec(msg)) !== null || (m = /^ceiling reached: .* last verdict (\S+)/.exec(msg)) !== null) {
      endAll(p, l.at, { result: m[1] });
    } else if (/^SPEC defect on round/.test(msg)) {
      endAll(p, l.at, { result: 'SPEC' });
    } else if ((m = /^post-merge baseline: SKIPPED — (.*)$/.exec(msg)) !== null) {
      mark(p, 'baseline', l.at, { name: 'merge', result: 'SKIPPED', reason: m[1] });
    } else if ((m = /^post-merge baseline: running — (.*)$/.exec(msg)) !== null) {
      start(p, 'merge.baseline', 'baseline', l.at, { name: 'merge', reason: m[1] }, false);
    } else if ((m = /^post-merge baseline: (test \S+ \|.*)$/.exec(msg)) !== null) {
      end(p, 'merge.baseline', l.at, { result: /RED/.test(m[1] ?? '') ? 'RED' : 'GREEN', reason: m[1] });
    } else if ((m = /^\S+ is now ([0-9a-f]+)$/.exec(msg)) !== null) {
      const s = p.open.get('merge');
      if (s !== undefined) s.fields = { ...s.fields, sha: m[1] };
    } else if (/^\S+ merged into \S+ — revert with/.test(msg) || /^epic\/\S+ merged into \S+ — nothing recorded/.test(msg)) {
      end(p, 'merge', l.at, { result: 'MERGED' });
    } else if (lead === 'XX ') {
      if ((m = /^round \d+: (the builder|the builder's .*|the reviewer) exceeded AGENT_TIMEOUT/.exec(msg)) !== null) {
        const pass = m[1] === 'the reviewer' ? 'reviewer' : 'builder';
        for (const span of [...p.open.keys()].filter((s) => p.open.get(s)?.pass === pass)) end(p, span, l.at, { result: 'TIMEOUT', reason: msg });
      }
      const result = p.open.has('merge') ? (/does not merge cleanly/.test(msg) ? 'CONFLICT' : /post-merge baseline is red/.test(msg) ? 'RED' : 'FAILED') : 'DIED';
      endAll(p, l.at, { result, reason: msg });
    }
  }
  return out;
}

/** The journal of a repo's queue units, as `journalctl` gives it: the
 *  lines the fleet printed and systemd's about the units; '' when it cannot
 *  be read. */
export function readJournal(repo: string, since?: string): string {
  const r = runSync('journalctl', [
    '--user', '-u', 'fleet-queue.service', '-u', `fleet-queue@${repo}.service`, '-o', 'short-iso-precise', '--no-pager',
    '--grep', '^(\\x1b\\[[0-9;]*m)?(==>|!!|XX) |fleet-queue', ...(since !== undefined ? ['--since', since] : []),
  ], { maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : '';
}
