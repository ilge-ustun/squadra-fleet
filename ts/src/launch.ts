// launch.ts — the story loop, behind `fleet launch` (bin/launch.ts); the
// queue and a human's hand run use the same command line:
//
//   fleet launch <repo>          take the repo's next ready story
//   fleet launch <repo> 004      run one specific story
//   fleet launch <repo> --reap   reap orphans and exit
//
// The repo is a name in repos/ (lib.sh: load_repo, reached through
// lib/config.ts); how it is built and tested comes from its own
// .fleet/config. Nothing here assumes the cwd.
//
// STATE lives in git. Each story file carries frontmatter:
//
//   ---
//   status: ready
//   round: 0
//   ---
//
//   ready         → waiting in the queue
//   in_progress   → a launcher is working on it right now
//   blocked       → the agent asked a question; see .blocked/<id>.md
//   needs_human   → MAX_ROUNDS reviews failed; see .review/<id>.md
//   done          → reviewer said PASS; branch waiting for your merge
//
// ROUNDS: on FAIL the builder is re-run with the reviewer's findings in its
// prompt, then reviewed again. After MAX_ROUNDS failures the story stops at
// needs_human. A stopped story does NOT stop the queue.
//
// Status changes are committed and pushed so the queue is visible from a
// phone. .runs/<id>.json is machine-local (gitignored).
//
// PROMPTS live in prompts/*.md, rendered by lib/render.ts. The agents are
// the `claude` and `codex` CLIs, started by lib/agents.ts with the prompt on
// stdin.
//
// VERDICT is computed here, not read from the reviewer. The reviewer
// proposes mutations as files; this program runs the baseline, applies each
// mutation in a clean tree, classifies, and vetoes a PASS on any surviving
// mutation, any uncovered AC, or a red baseline (lib/verdict.ts). Evidence
// goes to .review/<id>/round-N/ and is committed. See prompts/README.md,
// "The verdict contract". test/suite.sh exercises every path with fake agents.
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { builderModelUsed, claudeRefusal, parseBuilderOutput, reviewerMessages, reviewerModelUsed, reviewerRefusal, runBuilder, runReviewer } from './lib/agents.ts';
import { reviewerResetAt } from './lib/codex-limits.ts';
import { baselineLine, runBaseline } from './lib/baseline.ts';
import type { RepoConfig } from './lib/config.ts';
import { RunnerError, runMutations, runProbes } from './lib/evidence.ts';
import { deleteFrontmatterField, setStoryField, storyField } from './lib/frontmatter.ts';
import { add, branchExists, commit, diffNameOnly, fetch, mergeBase, porcelain, pushFollowingUpstream, revListCount, revParse, stagedIsEmpty, worktreeAdd, worktreeRemoveForce } from './lib/git.ts';
import { Die } from './lib/die.ts';
import { withFleetLock } from './lib/lock.ts';
import { dieMessage, log, out, warn } from './lib/log.ts';
import { COMPUTED_SEP, REASON_END, formatIsoSeconds, renderRoundSection } from './lib/machine-block.ts';
import { runBashTo } from './lib/proc.ts';
import { procsInWorktree as realProcsInWorktree, storyTrees } from './lib/procs.ts';
import { RenderError, leftoverLine, renderPrompt, type RenderVars } from './lib/render.ts';
import { readReview } from './lib/review.ts';
import { checkScope } from './lib/scope.ts';
import { computeVerdict } from './lib/verdict.ts';
import { byCodePoint, nextToRun } from './status.ts';

/** lib.sh's `die`, from lib/die.ts; still exported here for launch.test.ts. */
export { Die };

// ── pure helpers ─────────────────────────────────────────────────────────────

/** What `$(…)` leaves: every trailing newline gone. */
export const capture = (s: string): string => s.replace(/\n+$/, '');

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();
const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

/** `grep -oE '^\*\*AC[0-9]+' | tr -d '*' | sort -u`: the ids in code-point
 *  order — AC1 AC10 AC2. Split on \n only: grep's ^ does not break at \r or
 *  U+2028, and neither does this. */
export function acIds(storyText: string): string[] {
  const ids = new Set<string>();
  for (const line of storyText.split('\n')) {
    const m = /^\*\*AC[0-9]+/.exec(line);
    if (m !== null) ids.add(m[0].slice(2));
  }
  return [...ids].sort(byCodePoint);
}

/** `grep -qE '^verdict: SPEC'` on the old review file:
 *  any line, prefix match. */
export function chooseBuildPrompt(o: { round: number; roundStart: number; reviewText: string; reviewFileText: string }): string {
  if (o.round === o.roundStart + 1 && o.reviewText === '') return 'build-round1.md';
  if (o.round === o.roundStart + 1 && o.reviewFileText.split('\n').some((l) => l.startsWith('verdict: SPEC'))) return 'build-after-spec.md';
  return 'build-round2.md';
}

/** 24 Sep: a haiku story gets one round. After that the default builder
 *  model takes over (sonnet if the default is haiku as well), so trying the
 *  cheap model costs one round at most. */
export const isHaiku = (m: string): boolean => m === 'haiku' || m.startsWith('claude-haiku');
export function builderModelForRound(model: string, round: number, fallback: string): string {
  if (round <= 1 || !isHaiku(model)) return model;
  return isHaiku(fallback) ? 'sonnet' : fallback;
}

/** `grep -qE '^verdict: (FAIL|UNPARSEABLE|SPEC)'` — any line. */
export function priorFailingReview(text: string): boolean {
  return text.split('\n').some((l) => /^verdict: (FAIL|UNPARSEABLE|SPEC)/.test(l));
}

/** `awk '/^## Round /{p=1} p'`: from the first round heading on, every
 *  record ended with a newline as awk ends it. */
export function keepEarlierRounds(text: string): string {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const i = lines.findIndex((l) => l.startsWith('## Round '));
  return i === -1 ? '' : `${lines.slice(i).join('\n')}\n`;
}

/** A refused round retried and refused again: its trailing section goes, so
 *  an outage of hours leaves one UNAVAILABLE section, not one per retry. The
 *  section's leading blank line goes with it; anything else stays. */
export function dropTrailingUnavailable(text: string, round: number): string {
  const lines = text.split('\n');
  let i = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if ((lines[k] ?? '').startsWith('## Round ')) { i = k; break; }
  }
  if (i === -1 || lines[i] !== `## Round ${round}${COMPUTED_SEP}UNAVAILABLE`) return text;
  const cut = i > 0 && lines[i - 1] === '' ? i - 1 : i;
  return cut === 0 ? '' : `${lines.slice(0, cut).join('\n')}\n`;
}

export function finalReviewHeader(o: { storyId: string; verdict: string; round: number; ceiling: number; baseSha: string }): string {
  return `# Review: ${o.storyId}\n\nverdict: ${o.verdict}\nrounds: ${o.round} of ${o.ceiling}\nbase: ${o.baseSha}\n`;
}

export const runFileStart = (storyId: string, pid: number, started: string): string =>
  `{"story":"${storyId}","pid":${pid},"started":"${started}"}\n`;

export const runFileEnd = (storyId: string, verdict: string, round: number): string =>
  `${JSON.stringify({ story: storyId, verdict, rounds: round }, null, 2)}\n`;

/** `echo "$BUILD_OUT" | head -20`. */
export const head20 = (text: string): string => `${text.split('\n').slice(0, 20).join('\n')}\n`;

/** An unquoted `$FLEET_NOTIFY_CMD "$1"`: the command word-split. */
export const splitCommand = (cmd: string): string[] => cmd.split(/[ \t\n]+/).filter((w) => w !== '');

/** EX_UNAVAILABLE: an agent's provider refused the call (a usage limit);
 *  the story is parked and a human was told. The queue stops its drain on
 *  it — every story after this one would be refused too. */
export const EXIT_AGENT_REFUSED = 69;

/** A time as the phone shows it: HH:MM today, with the date otherwise. */
export function clockTime(d: Date, now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/** The one message a refused review sends: who refused and in their words,
 *  that nothing is lost, and the human's two ways on — wait for the reset
 *  (the queue holds for this story, then reviews it) or have Claude review
 *  it now, a weaker check since Claude built it. */
export function pausedMessage(o: { repo: string; id: string; who: string; refusal: string; resumeAt: Date; known: boolean; now: Date }): string {
  const when = `${clockTime(o.resumeAt, o.now)}${o.known ? '' : ' (no reset time was given: a retry, not a promise)'}`;
  return [
    `${o.repo}/${o.id} — ${o.who} refused the review: "${o.refusal}"`,
    `Nothing is lost: the builder's work is on story/${o.id} and the round is not counted. The queue is paused until you choose:`,
    `/wait ${o.repo} ${o.id} — resume this story automatically after ${when}`,
    `/fallback ${o.repo} ${o.id} — review it now with Claude (opus); a weaker check: the same vendor as its builder`,
  ].join('\n');
}

/** The one message a builder refused by Claude sends. The human decided
 *  (25 Sep) that nothing follows it: no retry, no fallback, no hold. */
export function builderRefusedMessage(o: { repo: string; id: string; refusal: string }): string {
  return [
    `${o.repo}/${o.id} — Claude refused the builder: "${o.refusal}"`,
    `Nothing else will happen: the story is stopped, the round is not counted, and anything the builder committed stays on story/${o.id} unreviewed.`,
    `/promote ${o.repo} ${o.id} when you want it to run again.`,
  ].join('\n');
}

export interface Knobs {
  builderModel: string;
  reviewerModel: string;
  maxTurns: string;
  agentTimeoutRaw: string;
  agentTimeout: number;
  maxRoundsRaw: string;
  maxRounds: number;
  pushStatus: string;
  reviewOnly: string;
  lockWait: number;
  notifyCmd: string;
  /** Minutes until a refused review is tried again when neither codex's
   *  sessions nor its message name a reset time. */
  reviewerRetryMin: number;
  /** The model Claude reviews with after a human's /fallback. */
  fallbackReviewerModel: string;
}

/** `${X:-default}`: unset or empty means the default. The three numbers
 *  must be numbers: a name or `30m` is a die — pinned. */
export function readKnobs(env: NodeJS.ProcessEnv, fleetHome: string): Knobs {
  const v = (k: string, d: string): string => env[k] || d;
  const num = (k: string, raw: string, re: RegExp): number => {
    if (!re.test(raw)) throw new Die(`${k} is not a number: '${raw}'`);
    return Number(raw);
  };
  const agentTimeoutRaw = v('AGENT_TIMEOUT', '1800');
  const maxRoundsRaw = v('MAX_ROUNDS', '2');
  const lockWaitRaw = v('FLEET_LOCK_WAIT', '120');
  return {
    builderModel: v('BUILDER_MODEL', 'sonnet'),
    reviewerModel: env['REVIEWER_MODEL'] || '',
    maxTurns: v('MAX_TURNS', '60'),
    agentTimeoutRaw,
    agentTimeout: num('AGENT_TIMEOUT', agentTimeoutRaw, /^[0-9]+(\.[0-9]+)?$/),
    maxRoundsRaw,
    maxRounds: num('MAX_ROUNDS', maxRoundsRaw, /^[0-9]+$/),
    pushStatus: v('PUSH_STATUS', '1'),
    reviewOnly: v('REVIEW_ONLY', '0'),
    lockWait: num('FLEET_LOCK_WAIT', lockWaitRaw, /^[0-9]+(\.[0-9]+)?$/),
    notifyCmd: v('FLEET_NOTIFY_CMD', `bash ${fleetHome}/fleet telegram send`),
    reviewerRetryMin: num('REVIEWER_RETRY_MIN', v('REVIEWER_RETRY_MIN', '60'), /^[0-9]+$/),
    fallbackReviewerModel: v('FALLBACK_REVIEWER_MODEL', 'opus'),
  };
}

// ── the program ──────────────────────────────────────────────────────────────

export interface LaunchOptions {
  fleetHome: string;
  /** What followed the repo name: a story id, --reap, or nothing. */
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Registers what must run when the process is killed (SIGTERM, SIGINT
   *  or SIGHUP). The normal exit runs it through `finally`. */
  onExit: (fn: () => void) => void;
  procsInWorktree?: (path: string) => string[];
  /** The launch lock bin/launch.ts took before calling (lib/lock.ts): one
   *  launch per repo. Told the story once one is selected, so a launch that
   *  finds the lock held can say what it is behind. */
  launchLock: { name(what: string): void };
}

export async function launch(cfg: RepoConfig, o: LaunchOptions): Promise<number> {
  const root = cfg.root;
  const knobs = readKnobs(o.env, o.fleetHome);
  const procs = o.procsInWorktree ?? realProcsInWorktree;
  const promptsDir = `${o.fleetHome}/prompts`;
  const started = Date.now();
  const secs = (): number => Math.floor((Date.now() - started) / 1000);

  /** Every .stories/*.md, TEMPLATE included. */
  const storyFiles = (): string[] => {
    let names: string[];
    try {
      names = readdirSync(`${root}/.stories`);
    } catch {
      return [];
    }
    return names.filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort(byCodePoint).map((n) => n.slice(0, -3));
  };

  /** A notification can never change what happened: output discarded,
   *  failure ignored, an unconfigured notifier its own business. */
  const notify = (msg: string): void => {
    const [cmd, ...args] = splitCommand(knobs.notifyCmd);
    if (cmd === undefined) return;
    spawnSync(cmd, [...args, msg], { stdio: 'ignore' });
  };

  /** Under the fleet lock, each path added on its own (git add stages
   *  nothing when one pathspec is missing, L-02), the evidence directory
   *  too; nothing staged is fine; a failed commit is a die — the story's
   *  state would otherwise live only in the working tree. A push refused
   *  because the branch moved on origin merges origin in and goes again
   *  (L-36); one that still fails is a warning. */
  const commitStatus = (id: string, st: string): void => {
    withFleetLock(root, knobs.lockWait, () => warn('waited for the fleet lock — going ahead'), () => {
      for (const p of [`.stories/${id}.md`, `.review/${id}.md`, `.blocked/${id}.md`]) {
        if (isFile(`${root}/${p}`)) add(root, p);
      }
      if (isDir(`${root}/.review/${id}`)) add(root, `.review/${id}`);
      if (stagedIsEmpty(root)) return;
      if (commit(root, `story(${id}): ${st}`) !== 0) throw new Die(`status commit failed for ${id} (${st})`);
      if (knobs.pushStatus !== '1') return;
      const p = pushFollowingUpstream(root);
      if (!p.pushed) warn(`status push failed — queue not visible remotely (${p.why})`);
      else if (p.merged !== '') log(`status push refused — ${p.merged} merged in, and pushed`);
    });
  };

  /** Write, commit, and say so for the two states that need a human.
   *  `done` is not announced: merging is the queue's news. A stop with more
   *  to say than the review's reasons — a refused reviewer — brings its own
   *  message. */
  const setStatus = (id: string, st: string, message?: string): void => {
    setStoryField(root, id, 'status', st);
    commitStatus(id, st);
    if (message !== undefined) {
      notify(message);
    } else if (st === 'needs_human') {
      const review = isFile(`${root}/.review/${id}.md`) ? readReview(readFileSync(`${root}/.review/${id}.md`, 'utf8')).reasons : '';
      notify(`${id} needs_human — ${review}\nwhy: /why ${id}`);
    } else if (st === 'blocked') {
      const q = isFile(`${root}/.blocked/${id}.md`) ? capture(readFileSync(`${root}/.blocked/${id}.md`).subarray(0, 600).toString('utf8')) : '';
      notify(`${id} is blocked and asked a question:\n${q}\nanswer with: /answer ${id} <your answer>`);
    }
  };

  /** A story left in_progress goes back to the queue unless something still
   *  runs in one of its trees, found by cwd (L-04). Under the launch lock no
   *  launcher is alive while this runs, so such a process is an agent whose
   *  launcher is gone, still at work on the story: the run stops (L-31). */
  const reapOrphans = (): void => {
    for (const id of storyFiles()) {
      if (storyField(root, id, 'status') !== 'in_progress') continue;
      for (const wt of storyTrees(root, id)) {
        if (!isDir(wt)) continue;
        const pids = procs(wt);
        if (pids.length > 0) throw new Die(`story ${id}: its launcher is gone but processes still run in ${wt} (pids: ${pids.join(' ')}) — kill them by cwd, then run again`);
      }
      warn(`orphan: ${id} was in_progress, nothing running in its trees — returning to queue`);
      setStatus(id, 'ready');
    }
  };

  /** The untracked files a fresh worktree does not inherit, named by the
   *  target (SEED_FILES). Missing is a die. */
  const seedEnv = (target: string): void => {
    for (const f of cfg.seedFiles) {
      if (!isFile(`${root}/${f}`)) throw new Die(`${f} is missing from ${root} — the worktree would not behave like production`);
      try {
        copyFileSync(`${root}/${f}`, `${target}/${f}`);
      } catch (e) {
        throw new Die(`cannot copy seed file ${f} into ${target}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  // ── main ───────────────────────────────────────────────────────────────

  reapOrphans();
  if (o.argv[0] === '--reap') return 0;

  const storyId = o.argv[0] || nextToRun(root);
  if (storyId === '') {
    log('queue empty — nothing ready');
    return 0;
  }
  o.launchLock.name(`story ${storyId}`);
  const storyFile = `${root}/.stories/${storyId}.md`;
  if (!isFile(storyFile)) throw new Die(`no story file: ${storyFile}`);

  let current = storyField(root, storyId, 'status');
  if (current === '') {
    setStoryField(root, storyId, 'status', 'ready');
    current = 'ready';
  }
  switch (current) {
    case 'ready': break;
    case 'in_progress': throw new Die(`${storyId} is in_progress (reap_orphans should have caught this)`);
    case 'needs_human': throw new Die(`${storyId} needs a human — read .review/${storyId}.md, then set status to ready`);
    default: throw new Die(`${storyId} has status '${current}' — set it back to ready to rerun`);
  }

  // Acceptance criteria are headed `**ACn — …**` at column 0. A story with
  // none can never be verified, so it leaves the queue before any agent
  // spends quota on it — needs_human, not a bare die, which would leave it
  // `ready` and first in line for ever.
  const acs = acIds(readFileSync(storyFile, 'utf8'));
  if (acs.length === 0) {
    setStatus(storyId, 'needs_human');
    throw new Die(`${storyId} declares no acceptance criteria (**ACn — …** at column 0) — nothing a runner can verify`);
  }

  // Epics: a story may name the branch it is cut from; BASE_BRANCH is the
  // default. And it may name the model that builds it.
  const storyBase = storyField(root, storyId, 'base') || cfg.baseBranch;
  if (storyBase !== cfg.baseBranch) log(`base: ${storyBase} (from the story)`);
  let builderModel = knobs.builderModel;
  const storyModel = storyField(root, storyId, 'model');
  if (storyModel !== '') {
    builderModel = storyModel;
    log(`model: ${builderModel} (from the story)`);
  }

  const builderWt = `${root}/../wt-${storyId}`;
  const reviewerWt = `${root}/../wt-${storyId}-review`;
  const branch = `story/${storyId}`;
  const reviewFile = `${root}/.review/${storyId}.md`;
  // A story whose last review its provider refused resumes at that review:
  // the builder had finished, and nobody has judged its work yet (L-32).
  const resumeAtReview = isFile(reviewFile) && readReview(readFileSync(reviewFile, 'utf8')).verdict === 'UNAVAILABLE';
  // A human's /fallback on a refused review: Claude reviews every round of
  // this launch, with codex's prompt and contract. The key is removed at the
  // claim, so the choice is this launch's alone.
  const reviewerKey = storyField(root, storyId, 'reviewer');
  const fallbackReviewer = reviewerKey === 'claude';
  if (reviewerKey !== '' && !fallbackReviewer) warn(`reviewer: '${reviewerKey}' is not a reviewer the fleet knows — codex reviews`);
  // Findings live in .review/<id>.md, not only in this process (L-05).
  let reviewText = '';
  if (isFile(reviewFile) && priorFailingReview(readFileSync(reviewFile, 'utf8'))) {
    reviewText = capture(readFileSync(reviewFile, 'utf8'));
    warn('prior failing review found — builder starts from the findings');
  }
  const runFile = `${root}/.runs/${storyId}.json`;
  // Rounds continue across reruns: a story sent back to ready after
  // needs_human resumes at its recorded round.
  const roundField = storyField(root, storyId, 'round');
  const roundStart = /^[0-9]+$/.test(roundField) ? Number(roundField) : 0;
  const roundCeiling = roundStart + knobs.maxRounds;

  const cleanupReviewer = (): void => {
    if (isDir(reviewerWt)) worktreeRemoveForce(root, reviewerWt);
  };
  o.onExit(cleanupReviewer);

  try {
    log(`story ${storyId}`);
    // not_before was the wait for a refused reviewer; claimed, it is over.
    deleteFrontmatterField(storyFile, 'not_before');
    deleteFrontmatterField(storyFile, 'reviewer');
    setStatus(storyId, 'in_progress');
    writeFileSync(runFile, runFileStart(storyId, process.pid, formatIsoSeconds(new Date())));

    fetch(root, 'origin');

    if (isDir(builderWt)) {
      log(`resuming existing worktree ${builderWt}`);
    } else {
      if (branchExists(root, branch)) {
        if (worktreeAdd(root, builderWt, { branch }) !== 0) throw new Die('worktree add (existing branch) failed');
      } else if (worktreeAdd(root, builderWt, { newBranch: branch, startPoint: `origin/${storyBase}` }) !== 0) {
        throw new Die('worktree add failed');
      }
      seedEnv(builderWt);
      log('installing deps');
      mkdirSync(`${root}/.runs`, { recursive: true });
      if (runBashTo(cfg.installCmd, { cwd: builderWt, logFile: `${root}/.runs/${storyId}-install-builder.log` }) !== 0) {
        throw new Die(`install failed in the builder tree (${cfg.installCmd}) — see .runs/${storyId}-install-builder.log`);
      }
    }

    const baseSha = mergeBase(builderWt, 'HEAD', `origin/${storyBase}`);
    log(`base ${baseSha.slice(0, 8)}`);

    // The story reaches both agents in their prompt, not as a file in the
    // worktree (L-19). A target may add rules of its own (REPO_RULES), read
    // from the checkout, not the worktree: the rules are the target's.
    const storyText = capture(readFileSync(storyFile, 'utf8'));
    let repoRulesText = '';
    if (cfg.repoRules) {
      try {
        repoRulesText = capture(readFileSync(`${root}/${cfg.repoRules}`, 'utf8'));
      } catch {
        throw new Die(`REPO_RULES ${cfg.repoRules} is not readable in ${root}`);
      }
    }
    const checkMutation = `bash ${o.fleetHome}/fleet check-mutation ${cfg.name}`;

    // The variables the prompts are rendered with, as the round goes on.
    const state = { rules: '', headSha: '', round: '' };
    const render = (file: string): string => {
      const vars: RenderVars = {
        STORY_ID: storyId, RULES: state.rules, REVIEW_TEXT: reviewText, STORY_TEXT: storyText, STORY_BASE: storyBase,
        HEAD_SHA: state.headSha, BASE_SHA: baseSha, ROUND: state.round, REPO_RULES_TEXT: repoRulesText,
        VITEST_CMD: cfg.vitestCmd, BUILD_CMD: cfg.buildCmd, LINT_CMD: cfg.lintCmd, CHECK_MUTATION: checkMutation,
        E2E_STEP: cfg.e2eCmd !== undefined ? `, then ${cfg.e2eCmd}` : '',
      };
      let r;
      try {
        r = renderPrompt(promptsDir, file, vars);
      } catch (e) {
        if (e instanceof RenderError) throw new Die(e.message);
        throw e;
      }
      if (r.leftover.length > 0) warn(leftoverLine(file, r.leftover));
      return r.text;
    };
    // rules.md itself contains {{STORY_ID}}, so it is rendered first and then
    // embedded as {{RULES}} by the build prompts.
    state.rules = render('rules.md');

    // ── review rounds ────────────────────────────────────────────────────

    const newFile = `${reviewFile}.new`;
    writeFileSync(newFile, (roundStart > 0 || resumeAtReview) && isFile(reviewFile) ? keepEarlierRounds(readFileSync(reviewFile, 'utf8')) : '');
    let verdict = '';
    let round = roundStart;

    while (round < roundCeiling) {
      round += 1;
      setStoryField(root, storyId, 'round', String(round));
      log(`round ${round} of ${roundCeiling}`);

      const roundStartSha = revParse(builderWt, 'HEAD');
      const evidenceDir = `${root}/.review/${storyId}/round-${round}`;
      mkdirSync(evidenceDir, { recursive: true });
      const tRound = secs();
      let tBuild = 0;
      let tReview = 0;
      let tBase = 0;
      let tMut = 0;
      let builderHandedOver = false;

      state.round = String(round);
      const reviewFileText = isFile(reviewFile) ? readFileSync(reviewFile, 'utf8') : '';
      const roundModel = builderModelForRound(builderModel, round, knobs.builderModel);
      if (roundModel !== builderModel) log(`model: ${roundModel} for round ${round} — haiku builds one round`);
      const buildPrompt = render(chooseBuildPrompt({ round, roundStart, reviewText, reviewFileText }));

      let buildErr: string;
      let builderUsed = '';
      let buildMsg: string;
      // The first round of a resumed story reviews what its builder left
      // before the refusal; what that builder said is in this round's
      // evidence already, and so is its TDD handover.
      const resumedRound = resumeAtReview && round === roundStart + 1;
      const reviewOnlyRound = knobs.reviewOnly === '1' || resumedRound;
      if (resumedRound) {
        buildErr = 'skipped';
        buildMsg = isFile(`${evidenceDir}/builder.md`) ? capture(readFileSync(`${evidenceDir}/builder.md`, 'utf8')) : '(resumed: no builder ran this launch)';
        if (isFile(`${evidenceDir}/builder.json`)) builderUsed = builderModelUsed(readFileSync(`${evidenceDir}/builder.json`, 'utf8'));
        log('the reviewer was unavailable last time — reviewing the existing head, no builder round');
      } else if (knobs.reviewOnly === '1') {
        // REVIEW_ONLY re-reviews the branch head with no builder round.
        buildErr = 'skipped';
        buildMsg = '(REVIEW_ONLY: no builder ran this round; reviewing the existing head)';
        log('REVIEW_ONLY: skipping the builder');
      } else {
        log(`builder: ${roundModel}`);
        let t0 = secs();
        const b = await runBuilder({ wt: builderWt, prompt: buildPrompt, model: roundModel, maxTurns: knobs.maxTurns, timeoutSec: knobs.agentTimeout });
        tBuild = secs() - t0;
        t0 = 0;
        if (b.timedOut) {
          setStatus(storyId, 'needs_human');
          throw new Die(`round ${round}: the builder exceeded AGENT_TIMEOUT (${knobs.agentTimeoutRaw}s) and was killed`);
        }
        const buildOut = capture(b.output);
        builderUsed = builderModelUsed(buildOut);
        const parsed = parseBuilderOutput(buildOut);
        buildErr = parsed.isError;
        buildMsg = parsed.message;
        // The whole object, not just the two fields read here: what the CLI
        // reports about cost and duration is in there.
        writeFileSync(`${evidenceDir}/builder.json`, `${parsed.evidence}\n`);

        // Claude refused the call (a usage limit): the human decided that a
        // message is all that follows. The round is not counted; anything
        // committed before the refusal stays on the branch, unreviewed — a
        // half-built round is not a round. The review file is untouched.
        const refused = claudeRefusal(buildOut);
        if (refused !== undefined) {
          warn(`round ${round}: Claude refused the builder — ${refused}`);
          rmSync(newFile, { force: true });
          setStoryField(root, storyId, 'round', String(round - 1));
          setStatus(storyId, 'needs_human', builderRefusedMessage({ repo: cfg.name, id: storyId, refusal: refused }));
          writeFileSync(runFile, runFileEnd(storyId, 'BUILDER_REFUSED', round - 1));
          return EXIT_AGENT_REFUSED;
        }
        if (buildErr === 'parse-failed') {
          warn('builder output was not JSON — first 20 lines of raw output:');
          out(head20(buildOut));
        }

        if (isFile(`${builderWt}/.blocked/${storyId}.md`)) {
          copyFileSync(`${builderWt}/.blocked/${storyId}.md`, `${root}/.blocked/${storyId}.md`);
          warn('BLOCKED — agent asked a question:');
          out(readFileSync(`${root}/.blocked/${storyId}.md`, 'utf8'));
          setStatus(storyId, 'blocked');
          rmSync(newFile, { force: true });
          out('\n');
          out(`answer by editing .stories/${storyId}.md, then set status back to ready\n`);
          return 0;
        }

        // The builder's own TDD evidence, in the reviewer's format, copied
        // before the reviewer runs so one runner judges both.
        if (isDir(`${builderWt}/.review-out/mutations`)) {
          mkdirSync(`${evidenceDir}/mutations`, { recursive: true });
          cpSync(`${builderWt}/.review-out/mutations`, `${evidenceDir}/mutations`, { recursive: true });
          rmSync(`${builderWt}/.review-out`, { recursive: true, force: true });
          builderHandedOver = true;
          log('builder handed over TDD evidence');
        }
      }

      const headSha = revParse(builderWt, 'HEAD');
      const roundCommits = revListCount(builderWt, `${roundStartSha}..${headSha}`);
      const totalCommits = revListCount(builderWt, `${baseSha}..${headSha}`);

      // Postcondition, not self-report: a round is productive if it produced
      // anything the harness can judge (L-23). Nothing at all is a die.
      if (roundCommits === 0 && !reviewOnlyRound && !builderHandedOver) {
        setStatus(storyId, 'needs_human');
        throw new Die(`round ${round} produced no commits (is_error=${buildErr}). Said: ${buildMsg}`);
      }
      log(`builder: ${roundCommits} commit(s) this round, ${totalCommits} total, head ${headSha.slice(0, 8)}`);

      // ── reviewer: clean worktree at the builder's head ─────────────────

      cleanupReviewer();
      log(`reviewer worktree at ${headSha.slice(0, 8)}`);
      if (worktreeAdd(root, reviewerWt, { detach: headSha }) !== 0) throw new Die('reviewer worktree failed');
      seedEnv(reviewerWt);
      if (runBashTo(cfg.installCmd, { cwd: reviewerWt, logFile: `${root}/.runs/${storyId}-install-reviewer.log` }) !== 0) {
        throw new Die(`install failed in the reviewer tree (${cfg.installCmd}) — see .runs/${storyId}-install-reviewer.log`);
      }

      // What this round changed, computed once: the baseline and the scope
      // check read the same answer.
      const changedPaths = diffNameOnly(builderWt, `${baseSha}..${headSha}`);
      let t0 = secs();
      const baseline = runBaseline({
        wt: reviewerWt, evidenceDir, rawJson: `${root}/.runs/${storyId}-round${round}-baseline.json`, installCmd: cfg.installCmd,
        vitestCmd: cfg.vitestCmd, buildCmd: cfg.buildCmd, lintCmd: cfg.lintCmd,
        ...(cfg.e2eCmd !== undefined ? { e2eCmd: cfg.e2eCmd } : {}),
        ...(cfg.e2eTimeoutSec !== undefined ? { e2eTimeoutSec: cfg.e2eTimeoutSec } : {}),
      });
      log(`baseline: ${baselineLine(baseline)}`);
      const scope = checkScope({ deny: storyField(root, storyId, 'scope_deny'), changed: changedPaths, storyId });
      writeFileSync(`${evidenceDir}/scope.txt`, scope.fileText);
      log(scope.logLine);
      tBase = secs() - t0;

      state.headSha = headSha;
      const reviewPrompt = render('review.md');

      // Who reviews: codex, or Claude after a human's /fallback. Each yields
      // what it said, what it ran on, and whether its provider refused.
      const reviewerCli = fallbackReviewer ? 'claude' : 'codex';
      const reviewerModelAsked = fallbackReviewer ? knobs.fallbackReviewerModel : knobs.reviewerModel;
      const codexHome = process.env['CODEX_HOME'] || join(process.env['HOME'] ?? '', '.codex');
      log(fallbackReviewer ? `reviewer: claude ${reviewerModelAsked} (fallback)` : `reviewer: codex${reviewerModelAsked !== '' ? ` ${reviewerModelAsked}` : ''}`);
      t0 = secs();
      let reviewerUsed: string;
      let refusal: string | undefined;
      let refusalNote: string;
      let reviewerSaid: string;
      let reviewRaw: string;
      if (fallbackReviewer) {
        const cr = await runBuilder({ wt: reviewerWt, prompt: reviewPrompt, model: reviewerModelAsked, maxTurns: knobs.maxTurns, timeoutSec: knobs.agentTimeout });
        tReview = secs() - t0;
        if (cr.timedOut) {
          setStatus(storyId, 'needs_human');
          throw new Die(`round ${round}: the reviewer exceeded AGENT_TIMEOUT (${knobs.agentTimeoutRaw}s) and was killed`);
        }
        reviewRaw = capture(cr.output);
        const parsed = parseBuilderOutput(reviewRaw);
        writeFileSync(`${evidenceDir}/reviewer.json`, `${parsed.evidence}\n`);
        reviewerUsed = builderModelUsed(reviewRaw);
        refusal = claudeRefusal(reviewRaw);
        refusalNote = '(reviewer unavailable: Claude refused the call)';
        reviewerSaid = parsed.isError === '' || parsed.message === 'no result field' ? '' : parsed.message;
      } else {
        const reviewerStartMs = Date.now();
        const rv = await runReviewer({
          wt: reviewerWt, prompt: reviewPrompt, model: reviewerModelAsked, timeoutSec: knobs.agentTimeout, stderrFile: `${evidenceDir}/reviewer.stderr`,
        });
        tReview = secs() - t0;
        reviewerUsed = reviewerModelUsed({ codexHome, cwd: resolve(reviewerWt), sinceMs: reviewerStartMs });
        if (rv.timedOut) {
          setStatus(storyId, 'needs_human');
          throw new Die(`round ${round}: the reviewer exceeded AGENT_TIMEOUT (${knobs.agentTimeoutRaw}s) and was killed`);
        }
        reviewRaw = capture(rv.stdout);
        refusal = reviewerRefusal(reviewRaw);
        refusalNote = `(reviewer unavailable, codex exit ${rv.status ?? 'by signal'})`;
        if (refusal !== undefined) writeFileSync(`${evidenceDir}/reviewer.unavailable.jsonl`, `${reviewRaw}\n`);
        const msgs = reviewerMessages(reviewRaw);
        if (refusal === undefined) for (const n of msgs.noise) writeSync(2, `${n}\n`);
        reviewerSaid = msgs.text;
      }

      // The provider refused the call (21 Sep: a codex usage limit). Nobody
      // reviewed, so there is no verdict to compute and the round is not
      // counted: the builder's work stays on its branch, line 3 says
      // UNAVAILABLE, not_before holds when codex will answer again, and the
      // story waits at needs_human for a human to choose — wait for that, or
      // a Claude review now. Checked before the tree: a refusal mid-turn may
      // leave it dirty, and it is thrown away.
      if (refusal !== undefined) {
        warn(`round ${round}: the reviewer's provider refused the call — ${refusal}`);
        writeFileSync(`${evidenceDir}/builder.md`, `${buildMsg}\n`);
        writeFileSync(`${evidenceDir}/reviewer.md`, `${refusalNote} ${refusal}\n`);
        const now = new Date();
        // Only codex's reset can be read; Claude's is tried again after
        // REVIEWER_RETRY_MIN, and the message says it is a guess.
        const resetAt = fallbackReviewer ? undefined : reviewerResetAt({ codexHome, message: refusal, now });
        const resumeAt = resetAt ?? new Date(now.getTime() + knobs.reviewerRetryMin * 60_000);
        writeFileSync(newFile, dropTrailingUnavailable(readFileSync(newFile, 'utf8'), round));
        appendFileSync(newFile, renderRoundSection({
          round: String(round), headSha, roundCommits: String(roundCommits), reviewedAt: formatIsoSeconds(now),
          baseline, timing: { build: String(tBuild), base: String(tBase), review: String(tReview), mut: '0', total: String(secs() - tRound) },
          builderModel: roundModel, builderModelUsed: builderUsed, reviewerCli, reviewerModel: reviewerModelAsked, reviewerModelUsed: reviewerUsed, acIds: acs, scope: scope.scope, scopeHits: scope.hits,
          model: 'UNAVAILABLE', computed: 'UNAVAILABLE', reasons: [`reviewer unavailable: ${refusal}`], mutRows: [], probeRows: [],
          builderText: readFileSync(`${evidenceDir}/builder.md`), reviewerText: readFileSync(`${evidenceDir}/reviewer.md`),
        }));
        writeFileSync(reviewFile, Buffer.concat([
          Buffer.from(finalReviewHeader({ storyId, verdict: 'UNAVAILABLE', round: round - 1, ceiling: roundCeiling, baseSha })), readFileSync(newFile),
        ]));
        rmSync(newFile, { force: true });
        setStoryField(root, storyId, 'round', String(round - 1));
        setStoryField(root, storyId, 'not_before', formatIsoSeconds(resumeAt));
        setStatus(storyId, 'needs_human', pausedMessage({ repo: cfg.name, id: storyId, who: fallbackReviewer ? 'Claude' : 'Codex', refusal, resumeAt, known: resetAt !== undefined, now }));
        writeFileSync(runFile, runFileEnd(storyId, 'UNAVAILABLE', round - 1));
        return EXIT_AGENT_REFUSED;
      }

      reviewText = reviewerSaid;
      if (reviewText === '' && fallbackReviewer) {
        warn('the fallback reviewer said nothing — its output is kept as reviewer.json');
        reviewText = '(no reviewer message — see reviewer.json)';
      } else if (reviewText === '') {
        writeFileSync(`${evidenceDir}/reviewer.raw.jsonl`, `${reviewRaw}\n`);
        warn('reviewer produced no agent_message — raw stream kept as reviewer.raw.jsonl');
        reviewText = '(no reviewer message — see reviewer.raw.jsonl and reviewer.stderr)';
      }

      // The reviewer's output contract: files under .review-out/, the tree
      // otherwise untouched. A dirty tree is a prompt problem — a human's.
      const dirty = porcelain(reviewerWt);
      if (dirty !== '') {
        setStatus(storyId, 'needs_human');
        throw new Die(`reviewer left the tree dirty:\n${dirty}`);
      }

      // Everything the verdict will rest on, into git before anything is judged.
      writeFileSync(`${evidenceDir}/builder.md`, `${buildMsg}\n`);
      writeFileSync(`${evidenceDir}/reviewer.md`, `${reviewText}\n`);
      for (const kind of ['mutations', 'probes']) {
        if (isDir(`${reviewerWt}/.review-out/${kind}`)) {
          mkdirSync(`${evidenceDir}/${kind}`, { recursive: true });
          cpSync(`${reviewerWt}/.review-out/${kind}`, `${evidenceDir}/${kind}`, { recursive: true });
        }
      }

      t0 = secs();
      const rawPrefix = (name: string): string => `${root}/.runs/${storyId}-round${round}-${name}`;
      let mutRows;
      let probeRows;
      try {
        mutRows = runMutations({ wt: reviewerWt, evidenceDir, rawPrefix, vitestCmd: cfg.vitestCmd, log });
        probeRows = runProbes({ wt: reviewerWt, evidenceDir, probeDir: cfg.probeDir, rawPrefix, vitestCmd: cfg.vitestCmd, log });
      } catch (e) {
        if (!(e instanceof RunnerError)) throw e;
        if (e.before !== undefined) dieMessage(e.before);
        throw new Die(e.message);
      }
      tMut = secs() - t0;

      // ── verdict ────────────────────────────────────────────────────────
      // The rule is lib/verdict.ts and the section's text lib/machine-block.ts.
      // The reviewer's line is one input; the machine may veto a PASS and
      // never grants one.
      const builderBytes = readFileSync(`${evidenceDir}/builder.md`);
      const reviewerBytes = readFileSync(`${evidenceDir}/reviewer.md`);
      const v = computeVerdict({
        baseline, scope: scope.scope, scopeHits: scope.hits, acIds: acs, mutRows, probeRows, reviewerText: reviewerBytes.toString('utf8'),
      });
      appendFileSync(newFile, renderRoundSection({
        round: String(round), headSha, roundCommits: String(roundCommits), reviewedAt: formatIsoSeconds(new Date()),
        baseline, timing: { build: String(tBuild), base: String(tBase), review: String(tReview), mut: String(tMut), total: String(secs() - tRound) },
        builderModel: roundModel, builderModelUsed: builderUsed, reviewerCli, reviewerModel: reviewerModelAsked, reviewerModelUsed: reviewerUsed, acIds: acs, scope: scope.scope, scopeHits: scope.hits,
        model: v.model, computed: v.computed, reasons: v.reasons, mutRows, probeRows, builderText: builderBytes, reviewerText: reviewerBytes,
      }));
      verdict = v.computed;
      if (v.model === 'PASS' && verdict === 'FAIL') warn(`machine veto: ${v.reasons.map((r) => `${r}${REASON_END}`).join('')}`);

      // What the next round's builder reads is the review so far — exactly
      // what a restart reloads from the file. One path.
      reviewText = capture(readFileSync(newFile, 'utf8'));

      if (verdict === 'PASS') {
        log(`round ${round}: PASS`);
        break;
      }
      // A spec defect cannot be fixed by another build round.
      if (verdict === 'SPEC') {
        warn(`round ${round}: SPEC — the story is wrong, not the build`);
        break;
      }
      warn(`round ${round}: ${verdict}`);
      if (round < roundCeiling) log('re-running builder with the findings');
    }

    // ── outcome ──────────────────────────────────────────────────────────

    const body = readFileSync(newFile);
    writeFileSync(reviewFile, Buffer.concat([Buffer.from(finalReviewHeader({ storyId, verdict, round, ceiling: roundCeiling, baseSha })), body]));
    rmSync(newFile, { force: true });

    if (verdict === 'PASS') {
      setStatus(storyId, 'done');
      log(`VERDICT: PASS after ${round} round(s) → ${reviewFile}`);
    } else if (verdict === 'SPEC') {
      setStatus(storyId, 'needs_human');
      warn(`SPEC defect on round ${round} — the story needs rewriting → ${reviewFile}`);
      warn('this story is stopped. The queue is not.');
    } else {
      setStatus(storyId, 'needs_human');
      warn(`ceiling reached: ${knobs.maxRoundsRaw} rounds, last verdict ${verdict} → ${reviewFile}`);
      warn('this story is stopped. The queue is not.');
    }

    writeFileSync(runFile, runFileEnd(storyId, verdict, round));

    out('\n');
    out(`branch ${branch}, worktree ${builderWt}\n`);
    out(`when finished: git worktree remove ${builderWt}\n`);
    return 0;
  } finally {
    cleanupReviewer();
  }
}
