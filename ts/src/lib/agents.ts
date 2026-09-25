// The two agent calls, as launch.sh made them (launch.sh:516-546, 618-644):
// `claude -p …` for the builder with stdout and stderr merged, `codex exec
// --json …` for the reviewer with stderr kept as evidence; the prompt on
// stdin for both (L-18); `timeout -k 30 $AGENT_TIMEOUT` as run()'s timer.
// The CLIs are found on PATH by bare name, which is what lets test/suite.sh's
// fakes stand in (L-14). This file is the seam a later move to the agent
// SDKs would replace; nothing else in the launcher knows how an agent is
// started or what its output looks like.
import { closeSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './proc.ts';

export const ALLOWED_TOOLS = 'Read,Write,Edit,Grep,Glob,Bash';

export function builderArgv(o: { model: string; maxTurns: string; allowedTools?: string }): string[] {
  return ['-p', '--model', o.model, '--max-turns', o.maxTurns, '--allowedTools', o.allowedTools ?? ALLOWED_TOOLS, '--output-format', 'json'];
}

/** --sandbox danger-full-access: bwrap cannot create network namespaces on
 *  the host, so codex's own sandbox fails before it reads anything;
 *  isolation is the detached worktree and the unprivileged user. `-m` only
 *  when a model is named — empty means codex's configured default. */
export function reviewerArgv(o: { model: string }): string[] {
  const a = ['exec', '--json', '--sandbox', 'danger-full-access'];
  return o.model !== '' ? [...a, '-m', o.model] : a;
}

export interface AgentCall {
  /** The worktree the agent works in: its cwd, which is also how it is
   *  found later (procsInWorktree). */
  wt: string;
  prompt: string;
  timeoutSec: number;
  graceSec?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BuilderRun {
  timedOut: boolean;
  /** stdout and stderr merged, as `2>&1` had them. */
  output: string;
}

export async function runBuilder(o: AgentCall & { model: string; maxTurns: string }): Promise<BuilderRun> {
  const r = await run('claude', builderArgv(o), {
    cwd: o.wt, input: o.prompt, timeoutSec: o.timeoutSec, graceSec: o.graceSec ?? 30, stderr: 'merge',
    ...(o.env !== undefined ? { env: o.env } : {}),
  });
  return { timedOut: r.timedOut, output: r.stdout };
}

export interface ReviewerRun {
  timedOut: boolean;
  /** The JSON Lines stream. */
  stdout: string;
}

/** stderr goes to `stderrFile` (round-N/reviewer.stderr): codex prints
 *  "Reading prompt from stdin..." there on every unattended run (the text changes between codex versions),
 *  and merged into the stream it once broke the extraction (L-17). */
export async function runReviewer(o: AgentCall & { model: string; stderrFile: string }): Promise<ReviewerRun> {
  const fd = openSync(o.stderrFile, 'w');
  try {
    const r = await run('codex', reviewerArgv(o), {
      cwd: o.wt, input: o.prompt, timeoutSec: o.timeoutSec, graceSec: o.graceSec ?? 30, stderr: fd,
      ...(o.env !== undefined ? { env: o.env } : {}),
    });
    return { timedOut: r.timedOut, stdout: r.stdout };
  } finally {
    closeSync(fd);
  }
}

export interface BuilderOutput {
  /** BUILD_ERR: jq's `if has("is_error") then (.is_error|tostring) else
   *  "parse-failed" end` with its stderr dropped — so '' when the output is
   *  not JSON or not an object at all (jq failed and printed nothing),
   *  'parse-failed' for JSON without the key. */
  isError: string;
  /** BUILD_MSG: `.result // "no result field"` — the alternative fires on
   *  null and false (L-03: `//` is not "absent"); a non-string is printed as
   *  jq -r prints it, pretty. '' when jq failed. */
  message: string;
  /** builder.json: `jq .` of the value, else the raw text. Written by the
   *  caller with one trailing newline. */
  evidence: string;
}

const jqToString = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** The rows of launch.sh:535-541 as jq 1.7 evaluated them (each pinned in
 *  agents.test.ts). One shape a single JSON.parse cannot mirror: an object
 *  followed by trailing garbage, where jq parsed the fields and then failed
 *  the pretty print — here the whole text is "not JSON". Unreachable from
 *  the real CLI. Also jq keeps a number literal (`1.50`); JS does not. */
export function parseBuilderOutput(output: string): BuilderOutput {
  let v: unknown;
  try {
    v = JSON.parse(output);
  } catch {
    return { isError: '', message: '', evidence: output };
  }
  const evidence = JSON.stringify(v, null, 2);
  if (v !== null && (typeof v !== 'object' || Array.isArray(v))) return { isError: '', message: '', evidence };
  const o = (v ?? {}) as Record<string, unknown>;
  const isError = 'is_error' in o ? jqToString(o['is_error']) : 'parse-failed';
  const r = o['result'];
  const message = r === undefined || r === null || r === false ? 'no result field' : typeof r === 'string' ? r : JSON.stringify(r, null, 2);
  return { isError, message, evidence };
}

export interface ReviewerMessages {
  /** The agent_message texts joined with '\n', trailing newlines stripped
   *  (REVIEW_TEXT as `$(…)` held it); '' when there was none. */
  text: string;
  /** What jq printed to stderr on the way — one line per JSON value that is
   *  not an object, which `.type` cannot index — for the launcher to print
   *  as bash's unredirected stderr did. */
  noise: string[];
}

const jqType = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v;

/** launch.sh:637: per input line, `fromjson? | select(.type=="item.completed"
 *  and .item.type=="agent_message") | .item.text // empty`. A line that is
 *  not JSON is skipped silently (fromjson?); null indexes to null and is
 *  skipped; any other non-object is jq's error line and skipped. */
export function reviewerMessages(jsonl: string): ReviewerMessages {
  const texts: string[] = [];
  const noise: string[] = [];
  const cannotIndex = (n: number, v: unknown): void => {
    noise.push(`jq: error (at <stdin>:${n}): Cannot index ${jqType(v)} with string "type"`);
  };
  jsonl.replace(/\n+$/, '').split('\n').forEach((line, i) => {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      return;
    }
    if (v === null) return;
    if (typeof v !== 'object' || Array.isArray(v)) { cannotIndex(i + 1, v); return; }
    const o = v as Record<string, unknown>;
    if (o['type'] !== 'item.completed') return;
    const item = o['item'];
    if (item === undefined || item === null) return;
    if (typeof item !== 'object' || Array.isArray(item)) { cannotIndex(i + 1, item); return; }
    const it = item as Record<string, unknown>;
    if (it['type'] !== 'agent_message') return;
    const t = it['text'];
    if (t === undefined || t === null || t === false) return;
    texts.push(typeof t === 'string' ? t : JSON.stringify(t, null, 2));
  });
  return { text: texts.join('\n').replace(/\n+$/, ''), noise };
}

/** 24 Sep: the fleet names aliases (`sonnet`, `opus`), so what a round ran
 *  on is read back from the agent. The builder: claude's `modelUsage`, whose
 *  costliest entry is the model that did the work (the CLI also bills small
 *  side calls to Haiku). '' when the output has none. */
export function builderModelUsed(output: string): string {
  let v: unknown;
  try {
    v = JSON.parse(output);
  } catch {
    return '';
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return '';
  const usage = (v as Record<string, unknown>)['modelUsage'];
  if (usage === null || typeof usage !== 'object') return '';
  let best = '';
  let bestCost = -1;
  for (const [name, u] of Object.entries(usage as Record<string, unknown>)) {
    const c = u !== null && typeof u === 'object' ? Number((u as Record<string, unknown>)['costUSD'] ?? 0) : 0;
    if (c > bestCost) { best = name; bestCost = c; }
  }
  return best;
}

/** The reviewer: codex's `exec --json` stream does not name its model, but
 *  every run writes a session file under $CODEX_HOME/sessions/YYYY/MM/DD
 *  whose turn_context carries the cwd and the model. The newest one for the
 *  reviewer worktree, written since the run began, is this run. '' when
 *  there is none — the block then says what it said before. */
export function reviewerModelUsed(o: { codexHome: string; cwd: string; sinceMs: number }): string {
  const files: { path: string; mtime: number }[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        const mtime = statSync(p).mtimeMs;
        if (mtime >= o.sinceMs) files.push({ path: p, mtime });
      }
    }
  };
  walk(join(o.codexHome, 'sessions'));
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files) {
    for (const line of readFileSync(f.path, 'utf8').split('\n')) {
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        continue;
      }
      const r = v as { type?: unknown; payload?: { cwd?: unknown; model?: unknown } } | null;
      if (r?.type === 'turn_context' && r.payload?.cwd === o.cwd && typeof r.payload.model === 'string') return r.payload.model;
    }
  }
  return '';
}
