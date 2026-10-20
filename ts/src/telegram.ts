// telegram.ts — the fleet's way of reaching a human, and the human's way of
// reaching back. bin/telegram.ts is the entry point behind
// `fleet telegram send [--pre] <text>` and `fleet telegram poll`.
//
// Why polling. The box is behind NAT with no public HTTPS endpoint, so a
// webhook is impossible without a tunnel. getUpdates is a pull, exactly like
// the systemd timer that already polls the story queue: no inbound port, no
// certificate, nothing new to secure.
//
// Configuration lives in .env.fleet at the FLEET repo root (gitignored
// there), never in a target: a target's seed files are copied into every
// builder and reviewer worktree, so a token there is a token handed to every
// agent.
//
//   TELEGRAM_BOT_TOKEN=123456:AA…      from @BotFather
//   TELEGRAM_CHAT_ID=987654321         your own numeric id
//
// Authorisation is one comparison and it is the entire security model:
// anyone who finds the bot can message it, so an update is acted on only
// when its sender is TELEGRAM_CHAT_ID. Everything else is dropped without a
// reply — a reply would confirm the bot exists.
//
// Nothing here dies. A fleet whose notifications fail must still run: a
// notification is not part of a verdict, and killing a round because
// Telegram was unreachable would be strictly worse than being told late.
// Inside a command, a die (an unknown repo, a config the loader refuses) is
// that command's reply.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRepo as loadRepoThroughBash, type RepoConfig } from './lib/config.ts';
import { readEnvFile } from './lib/env-file.ts';
import { deleteFrontmatterField, replaceFrontmatterField, setStoryField, storyField } from './lib/frontmatter.ts';
import { add, commit, pushQuiet, stagedIsEmpty } from './lib/git.ts';
import { lockPath, withFleetLock } from './lib/lock.ts';
import { log as logLine, warn as warnLine } from './lib/log.ts';
import { runSync } from './lib/proc.ts';
import { readReview } from './lib/review.ts';
import { byCodePoint } from './status.ts';
import { getUpdates as apiGetUpdates, sendMessage as apiSendMessage } from './lib/telegram-api.ts';
import { splitCommand } from './launch.ts';
import { branchNameOk } from './test-deploy.ts';

export const TAG = { tag: 'bot' };

// ── configuration ────────────────────────────────────────────────────────────

export interface BotConfig {
  token: string;
  chatId: string;
}

/** The environment wins: with TELEGRAM_BOT_TOKEN set, .env.fleet is not
 *  read at all; without it, the file supplies both values (sourced under
 *  set -a, so the file's TELEGRAM_CHAT_ID replaces an environment one). A
 *  file bash cannot source is one warning and "not configured". */
export function configuredFrom(env: NodeJS.ProcessEnv, fleetHome: string, warned: string[] | ((m: string) => void)): BotConfig | undefined {
  const warn = typeof warned === 'function' ? warned : (m: string): void => { warned.push(m); };
  let token = env['TELEGRAM_BOT_TOKEN'] ?? '';
  let chatId = env['TELEGRAM_CHAT_ID'] ?? '';
  const file = join(fleetHome, '.env.fleet');
  if (token === '' && existsSync(file)) {
    try {
      const m = readEnvFile(file, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], env);
      token = m.get('TELEGRAM_BOT_TOKEN') ?? token;
      chatId = m.get('TELEGRAM_CHAT_ID') ?? chatId;
    } catch (e) {
      warn(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  }
  return token !== '' && chatId !== '' ? { token, chatId } : undefined;
}

export interface BotKnobs {
  /** TELEGRAM_API_BASE — the suite's fake API; absent means api.telegram.org. */
  base: string | undefined;
  /** TELEGRAM_TIMEOUT (20): curl's --max-time, per request. */
  timeoutSec: number;
  /** SEND_MAX (3800): Telegram caps a message at 4096; the margin leaves
   *  room for the <pre> wrapper. */
  sendMax: number;
  /** FLEET_LOCK_WAIT (120). */
  lockWait: number;
  /** QUEUE_START_CMD: how /run starts a drain. `{repo}` in it is the repo's
   *  name — each registered repo has a unit of its own, fleet-queue@<repo>,
   *  so two repos drain side by side; a command without it is run as it is.
   *  It must return once the
   *  drain is started, never when it ends: fleet-queue is a oneshot, so a
   *  plain `systemctl start` waits for the whole drain, and the poll — a
   *  oneshot of its own with a two-minute start timeout — is killed before
   *  it can answer, and the bot is deaf meanwhile (24–25 Sep, L-33). */
  queueStartCmd: string;
  /** DETACH_CMD: the words a job that must outlive the poll runs under,
   *  before its --unit=<name>. A child the poll forks itself is still in
   *  fleet-bot.service's cgroup, and systemd kills what is left there when
   *  the oneshot ends — the /merge job died seconds after its
   *  acknowledgement (L-34). As a transient unit of its own it lives until
   *  it is done; --collect unloads it then, failed or not, and the poll's
   *  PATH (node) and HOME go with it, since the manager's have neither.
   *  --expand-environment=no, because systemd otherwise expands ${…} in the
   *  job's bash with the unit's environment before bash sees it: the
   *  /testdeploy link arrived as an empty message (L-35). */
  detachCmd: string;
}

const num = (v: string | undefined, d: number): number => (v !== undefined && v !== '' && /^[0-9]+(\.[0-9]+)?$/.test(v) ? Number(v) : d);

export function readBotKnobs(env: NodeJS.ProcessEnv): BotKnobs {
  const base = env['TELEGRAM_API_BASE'];
  return {
    base: base === undefined || base === '' ? undefined : base,
    timeoutSec: num(env['TELEGRAM_TIMEOUT'], 20),
    sendMax: num(env['SEND_MAX'], 3800),
    lockWait: num(env['FLEET_LOCK_WAIT'], 120),
    queueStartCmd: env['QUEUE_START_CMD'] ?? 'systemctl --user start --no-block fleet-queue@{repo}.service',
    detachCmd: env['DETACH_CMD'] ?? 'systemd-run --user --collect --quiet --expand-environment=no --setenv=PATH --setenv=HOME',
  };
}

// ── the seams a test replaces ────────────────────────────────────────────────

export interface BotDeps {
  io: { log: (msg: string) => void; warn: (msg: string) => void };
  api: { sendMessage: typeof apiSendMessage; getUpdates: typeof apiGetUpdates };
  /** `bash $FLEET_HOME/fleet <command> <args…>` with both streams captured
   *  in order-of-arrival's nearest equivalent: stdout, then stderr. */
  runFleet: (command: string, args: readonly string[]) => { status: number; output: string };
  /** A job that outlives the poll, started as a unit of its own through
   *  DETACH_CMD: `merge` is `fleet merge <args…>` under the fleet lock,
   *  `test-deploy` is `fleet test-deploy <args…>`; each sends its own result.
   *  The status and output are the starter's: whether the job started, not
   *  how it ended. */
  spawnDetached: (command: string, args: readonly string[]) => { status: number; output: string };
  /** An argv, output discarded; the exit status. */
  runCommand: (argv: readonly string[]) => number;
  /** lib.sh's load_repo, its die text captured so it can be the reply. */
  loadRepo: (fleetHome: string, name: string) => RepoConfig;
  now: () => Date;
}

export interface BotContext {
  fleetHome: string;
  env: NodeJS.ProcessEnv;
  knobs: BotKnobs;
  deps: BotDeps;
}

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

// The /merge job, run detached: a unit of its own (DETACH_CMD). A merge
// installs deps and runs the whole post-merge baseline — minutes of work —
// and the poll is a systemd oneshot with TimeoutStartSec=2min, so a merge
// run inside it hands systemd the power to kill it (khaita's epic/pwa merge
// died at exactly two minutes on 22 Sep 2026: worktree left behind, nothing
// landed, no reply at all). A child forked into the poll's own cgroup fares
// no better: it is killed when the poll ends (L-34). So: start a unit,
// acknowledge now, let the merge send its own result. It takes the fleet
// lock itself, because the poll's lock goes the moment the command returns.
// (The job inherits no descriptor of the poll's lock — Node hands a child
// only the stdio it names — so it cannot wait on a lock it already holds a
// handle to.)
const DETACHED_JOB = [
  'fleet="$1"; lock="$2"; shift 2',
  'out="$(flock -w 900 "$lock" bash "$fleet/fleet" merge "$@" 2>&1 | sed "s/\\x1b\\[[0-9;]*m//g")"',
  'bash "$fleet/fleet" telegram send --pre "${out:-(no output)}"',
].join('\n');

// The /testdeploy job: the build, then one message — two when the build has
// to wait for a story's launch first: the waiting line is sent the moment it
// is logged (hence sed -u), naming the story that holds the repo (L-37). When
// the build succeeds,
// the message is the command's last line, the URL, as plain text so that the
// phone shows it as a link. When it fails, the message is the tail of its
// output as a code block. The whole output also goes to the unit's journal
// (`journalctl --user -u fleet-test-deploy-build`). The unit's fixed name is
// what stops a second /testdeploy while one is still building: systemd-run
// refuses a unit that is already loaded. No fleet lock: a test deploy commits
// nothing, and it takes the launch lock itself.
const TEST_DEPLOY_JOB = [
  'fleet="$1"; shift',
  'log="$(mktemp)"',
  'bash "$fleet/fleet" test-deploy "$@" 2>&1 | sed -u "s/\x1b\[[0-9;]*m//g" | tee "$log" | while IFS= read -r l; do',
  '  printf "%s\\n" "$l"',
  '  if [[ $l == "==> "*": waiting for the launch lock — "* ]]; then bash "$fleet/fleet" telegram send "${l#==> }" </dev/null; fi',
  'done',
  'if (( PIPESTATUS[0] == 0 )); then last="$(tail -n 1 "$log")"; bash "$fleet/fleet" telegram send "${last#==> }"',
  'else bash "$fleet/fleet" telegram send --pre "$(tail -n 25 "$log")"; fi',
  'rm -f "$log"',
].join('\n');

export function defaultDeps(fleetHome: string, env: NodeJS.ProcessEnv, detachCmd: string, lockFile: () => string): BotDeps {
  return {
    io: { log: (m) => logLine(m, TAG), warn: (m) => warnLine(m, TAG) },
    api: { sendMessage: apiSendMessage, getUpdates: apiGetUpdates },
    runFleet: (command, args) => {
      const r = runSync('bash', [join(fleetHome, 'fleet'), command, ...args], { env });
      return { status: r.status, output: r.stdout + r.stderr };
    },
    spawnDetached: (command, args) => {
      let job: string[];
      if (command === 'merge') job = [`--unit=fleet-merge-${Date.now()}`, 'bash', '-c', DETACHED_JOB, '_', fleetHome, lockFile(), ...args];
      else if (command === 'test-deploy') job = ['--unit=fleet-test-deploy-build', 'bash', '-c', TEST_DEPLOY_JOB, '_', fleetHome, ...args];
      else throw new Error(`telegram.ts: no detached job for ${command}`);
      const [cmd, ...words] = splitCommand(detachCmd);
      if (cmd === undefined) return { status: 1, output: 'DETACH_CMD is empty' };
      const r = runSync(cmd, [...words, ...job], { env });
      return { status: r.status, output: r.stdout + r.stderr };
    },
    runCommand: (argv) => {
      const [cmd, ...args] = argv;
      if (cmd === undefined) return 1;
      return runSync(cmd, args, { env }).status;
    },
    // The child bash that runs load_repo needs LOG_TAG=bot in its
    // environment for lib.sh's die to print `XX [bot] …`.
    loadRepo: (home, name) => loadRepoThroughBash(home, name, { env: { ...env, LOG_TAG: 'bot' }, captureStderr: true }),
    now: () => new Date(),
  };
}

// ── out ──────────────────────────────────────────────────────────────────────

/** Lines are packed into chunks of at most `max` characters, split only
 *  on line boundaries so no table row is cut in half; a single line longer
 *  than `max` goes alone, whole. A text ending in '\n' has an empty last
 *  line, kept; an empty text is nothing. */
export function splitText(text: string, max: number): string[] {
  const out: string[] = [];
  let chunk = '';
  for (const line of text.split('\n')) {
    if (chunk !== '' && chunk.length + 1 + line.length > max) {
      out.push(chunk);
      chunk = '';
    }
    chunk += (chunk !== '' ? '\n' : '') + line;
  }
  if (chunk !== '') out.push(chunk);
  return out;
}

/** --pre: a monospace block, so a table keeps its columns on a phone. HTML
 *  parse mode, with the three characters HTML would misread escaped. */
export function htmlPre(text: string): string {
  return `<pre>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
}

/** send [--pre] <text>. Not configured: one warning naming the message's
 *  first line, nothing sent, and the caller is fine. */
export async function send(c: BotContext, text: string, pre: boolean): Promise<void> {
  const cfg = configuredFrom(c.env, c.fleetHome, c.deps.io.warn);
  if (cfg === undefined) {
    c.deps.io.warn(`not configured (.env.fleet) — message not sent: ${text.split('\n')[0] ?? ''}`);
    return;
  }
  for (const chunk of splitText(text, c.knobs.sendMax)) {
    const ok = await c.deps.api.sendMessage({
      base: c.knobs.base, token: cfg.token, chatId: cfg.chatId, timeoutSec: c.knobs.timeoutSec,
      text: pre ? htmlPre(chunk) : chunk,
      ...(pre ? { parseMode: 'HTML' as const } : {}),
    });
    if (!ok) c.deps.io.warn('sendMessage failed — the fleet is fine, you just were not told');
  }
}

// ── in ───────────────────────────────────────────────────────────────────────
//
// Commands are a fixed set with no grammar: the first word selects a handler,
// the second names the repo (load_repo refuses anything that is not a plain
// name), and each handler parses its own arguments. No part of a message
// ever reaches a shell. A story id must look like one before it is used as
// a path.

export interface Command {
  verb: string;
  repo: string;
  arg: string;
  rest: string;
}

/** `read -r verb repo arg rest <<< "$text"`: the first line only, blanks
 *  and tabs separate the first three words, the rest is what follows with
 *  its inner spacing kept and its ends trimmed. */
export function parseCommand(text: string): Command {
  const line = (text.split('\n')[0] ?? '').replace(/^[ \t]+|[ \t]+$/g, '');
  const m = /^(\S*)(?:[ \t]+(\S+))?(?:[ \t]+(\S+))?(?:[ \t]+(.*))?$/.exec(line);
  return { verb: m?.[1] ?? '', repo: m?.[2] ?? '', arg: m?.[3] ?? '', rest: m?.[4] ?? '' };
}

export function storyOk(root: string, id: string): boolean {
  return /^[0-9]{3}$/.test(id) && existsSync(join(root, '.stories', `${id}.md`));
}

/** `date -Iseconds`: local time, the zone offset, no fraction. */
export function isoSeconds(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/** What /why sends: the last `### Machine` block's lines, without the
 *  heading — lib/review.ts reads the block, this drops its first line. */
export function machineBlockBody(review: string): string {
  const block = readReview(review).machineBlock;
  if (block === undefined) return '';
  return block.split('\n').slice(1).join('\n');
}

const registryDir = (c: BotContext): string => c.env['FLEET_REGISTRY_DIR'] ?? join(c.fleetHome, 'repos');

/** The registered repos, in the glob's order. */
function repoNames(c: BotContext): string[] {
  let names: string[];
  try {
    names = readdirSync(registryDir(c)).filter((f) => f.endsWith('.env')).map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
  return names.sort(byCodePoint);
}

// Every verb but /run, /help and /repo takes the repo first. A human on a
// phone forgets which name the registry uses; this is the cheapest way to
// ask, and it needs no repo of its own to answer.
function cmdRepo(c: BotContext): string {
  const lines: string[] = [];
  for (const n of repoNames(c)) {
    const text = readFileSync(join(registryDir(c), `${n}.env`), 'utf8');
    const p = text.split('\n').find((l) => l.startsWith('REPO_PATH='))?.slice('REPO_PATH='.length);
    lines.push(`${n}  ${p === undefined || p === '' ? '?' : p}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'no repos registered — add one at repos/<name>.env';
}

// Grouped by what the human is doing, because a flat list of eight verbs is
// read as eight unrelated things. This is also the unknown-verb reply: a
// wrong command is exactly when the list is wanted.
const HELP = [
  'Look',
  '/status <repo> — the stories still in flight',
  '/status-all <repo> — those, plus what has landed',
  '/why <repo> <id> — the machine block of the last round',
  '/repo — the repos this bot knows',
  '',
  'Move a story on',
  '/promote <repo> <id> — draft to ready, and a drain starts',
  '/answer <repo> <id> <text> — answer a blocked story and requeue it',
  '/wait <repo> <id> — a refused review: resume it after the reset; the queue holds for it',
  '/fallback <repo> <id> — a refused review: Claude reviews it at the next drain (a weaker check)',
  '',
  'Land it, or take it back',
  '/merge <repo> <id> — land a story on the integration branch',
  '/merge <repo> epic/<name> — land a whole epic',
  '  both answer at once and send the result when the baseline is done',
  '/revert <repo> <id> — undo a story\'s merge into its epic',
  '',
  'Try it before it lands',
  '/testdeploy <repo> <branch> — build a branch and serve it at the test URL; the link follows when it is up (after a running story, if one is building — you are told which)',
  '/testdeploy <repo> — what the test URL serves now',
  '/testdeploy <repo> stop — stop serving it',
  '',
  'Run it',
  '/run [repo] — drain the queue now instead of waiting for the timer (no repo: every repo)',
  '/help — this',
].join('\n');

function cmdHelp(c: BotContext): string {
  const only = repoNames(c);
  return only.length === 1 ? `${HELP}\n\nOne repo is registered (${only[0]}), so you can leave <repo> out.` : HELP;
}

/** Starts one repo's drain: QUEUE_START_CMD with {repo} replaced. */
function startQueue(c: BotContext, repo: string): boolean {
  return c.deps.runCommand(splitCommand(c.knobs.queueStartCmd).map((w) => w.replaceAll('{repo}', repo))) === 0;
}

/** /run [repo]: that repo's drain, or with none every registered repo's.
 *  One repo registered answers as it always did. */
function cmdRun(c: BotContext, repo: string): string {
  const known = repoNames(c);
  if (repo !== '' && !known.includes(repo)) return `unknown repo: ${repo}\nknown: ${known.join(' ')}\n/help lists the commands`;
  const names = repo === '' ? known : [repo];
  if (names.length === 0) return 'no repos registered — add one at repos/<name>.env';
  const failed = names.filter((n) => !startQueue(c, n));
  if (failed.length === 0) return names.length === 1 ? 'queue started' : `queue started: ${names.join(', ')}`;
  return names.length === 1 ? 'could not start the queue' : `could not start the queue for: ${failed.join(', ')}`;
}

function cmdStatus(c: BotContext, cfg: RepoConfig, all: boolean): string {
  return c.deps.runFleet('status', [cfg.name, '--bot', ...(all ? ['--all'] : [])]).output;
}

function cmdWhy(cfg: RepoConfig, id: string): string {
  if (!storyOk(cfg.root, id)) return `no such story: ${id}`;
  const f = join(cfg.root, '.review', `${id}.md`);
  if (!existsSync(f)) return `${id} has no review yet`;
  return machineBlockBody(readFileSync(f, 'utf8'));
}

/** While a story is in_progress its status is the launcher's: neither verb
 *  may write `ready` over it. A launcher that died leaves it to the next
 *  drain's reap, which checks the story's trees first (L-31). */
function launcherHas(root: string, id: string): string | undefined {
  if (storyField(root, id, 'status') !== 'in_progress') return undefined;
  return `${id} is in_progress — a launcher has it; if that launcher died, the next drain returns it to the queue`;
}

/** A promotion is wanted now (L-39): after its commit it starts a drain with
 *  the command /run uses. A drain already running takes the story after its
 *  current one (run-queue's nextToRun), so a second start is a no-op. */
function cmdPromote(c: BotContext, cfg: RepoConfig, id: string): string {
  if (!storyOk(cfg.root, id)) return `no such story: ${id}`;
  const running = launcherHas(cfg.root, id);
  if (running !== undefined) return running;
  const rel = `.stories/${id}.md`;
  replaceFrontmatterField(join(cfg.root, rel), 'status', 'ready');
  add(cfg.root, rel);
  if (stagedIsEmpty(cfg.root)) return `${id} was already ready`;
  if (commit(cfg.root, `story(${id}): promoted to ready (telegram)`) !== 0) return `${id} could not be committed`;
  pushQuiet(cfg.root);
  return startQueue(c, cfg.name)
    ? `${id} is ready — a drain is starting, or the one running takes it next`
    : `${id} is ready — could not start a drain now; the next one picks it up`;
}

function cmdAnswer(c: BotContext, cfg: RepoConfig, id: string, text: string): string {
  if (!storyOk(cfg.root, id)) return `no such story: ${id}`;
  const running = launcherHas(cfg.root, id);
  if (running !== undefined) return running;
  const b = join(cfg.root, '.blocked', `${id}.md`);
  if (!existsSync(b)) return `${id} is not blocked — nothing is waiting for an answer`;
  appendFileSync(b, `\n## Answer (telegram, ${isoSeconds(c.deps.now())})\n\n${text}\n`);
  replaceFrontmatterField(join(cfg.root, `.stories/${id}.md`), 'status', 'ready');
  add(cfg.root, `.blocked/${id}.md`);
  add(cfg.root, `.stories/${id}.md`);
  if (commit(cfg.root, `story(${id}): answered, back to ready (telegram)`) !== 0) return `${id} could not be committed`;
  pushQuiet(cfg.root);
  return `answered — ${id} is ready again`;
}

/** A story its reviewer's provider refused waits at needs_human with
 *  `verdict: UNAVAILABLE` on its review's line 3 for one of two answers
 *  (L-32). Anything else is not waiting for one. */
function pausedOnReviewer(root: string, id: string): boolean {
  if (storyField(root, id, 'status') !== 'needs_human') return false;
  try {
    return readReview(readFileSync(join(root, '.review', `${id}.md`), 'utf8')).verdict === 'UNAVAILABLE';
  } catch {
    return false;
  }
}

/** Commit one story's frontmatter change and push it; the reply on
 *  success, or the failure's. */
function commitStory(cfg: RepoConfig, id: string, subject: string, reply: string): string {
  add(cfg.root, `.stories/${id}.md`);
  if (commit(cfg.root, `story(${id}): ${subject} (telegram)`) !== 0) return `${id} could not be committed`;
  pushQuiet(cfg.root);
  return reply;
}

/** Wait for the reset: ready again with its not_before, which the queue
 *  holds for; then the story is reviewed first, with no builder round. */
function cmdWait(cfg: RepoConfig, id: string): string {
  if (!storyOk(cfg.root, id)) return `no such story: ${id}`;
  if (!pausedOnReviewer(cfg.root, id)) return `${id} is not waiting for a reviewer choice`;
  replaceFrontmatterField(join(cfg.root, '.stories', `${id}.md`), 'status', 'ready');
  const nb = storyField(cfg.root, id, 'not_before');
  return commitStory(cfg, id, 'wait for the reviewer, then review',
    `${id} waits${nb === '' ? '' : ` until ${nb}`}, then is reviewed first; the queue holds until then`);
}

/** Claude reviews it instead, at the next drain — for the rest of that
 *  launch, which removes the key when it claims the story. Not started from
 *  here: a drain started by the bot would hold its poll, and the fleet lock
 *  with it, for as long as the drain runs. */
function cmdFallback(cfg: RepoConfig, id: string): string {
  if (!storyOk(cfg.root, id)) return `no such story: ${id}`;
  if (!pausedOnReviewer(cfg.root, id)) return `${id} is not waiting for a reviewer choice`;
  const file = join(cfg.root, '.stories', `${id}.md`);
  replaceFrontmatterField(file, 'status', 'ready');
  deleteFrontmatterField(file, 'not_before');
  setStoryField(cfg.root, id, 'reviewer', 'claude');
  return commitStory(cfg, id, 'reviewed by Claude instead',
    `${id} will be reviewed by Claude (opus) at the next drain — /run to start one now. A weaker check: the same vendor as its builder.`);
}

// The script owns every refusal; this only reports what it said.
function cmdRevert(c: BotContext, cfg: RepoConfig, id: string): string {
  if (!storyOk(cfg.root, id)) return `no such story: ${id}`;
  const r = c.deps.runFleet('revert', [cfg.name, id]);
  const said = stripAnsi(r.output).replace(/\n$/, '');
  const verdict = r.status === 0 ? `${id} reverted` : `${id} was not reverted — see the output above`;
  return said === '' ? verdict : `${said}\n${verdict}`;
}

// Landing on the integration branch is a human's decision; sending this is
// how the human makes it. The script owns every refusal and this only
// reports what it said — in pr mode, the request's URL.
function cmdMerge(c: BotContext, cfg: RepoConfig, what: string): string {
  let args: string[];
  if (/^[0-9]{3}$/.test(what)) {
    if (!storyOk(cfg.root, what)) return `no such story: ${what}`;
    args = [cfg.name, what, '--land'];
  } else if (what.startsWith('epic/')) {
    args = [cfg.name, '--epic', what];
  } else {
    return 'usage: /merge <repo> <id>  (a story based on the integration branch)  |  /merge <repo> epic/<name>';
  }
  const started = c.deps.spawnDetached('merge', args);
  if (started.status !== 0) return `could not start the merge of ${what}: ${started.output.trim()}`;
  return `merging ${what} — deps, suite, build and lint run first, so give it a few minutes. The result follows on its own.`;
}

// A test deploy is the machine's one slot, not a story: the script owns every
// refusal and every result. The build runs detached, since it takes minutes,
// and it sends the URL itself. The branch name is checked here first, so that
// a typo is answered at once rather than a few seconds later.
function cmdTestDeploy(c: BotContext, cfg: RepoConfig, what: string): string {
  if (what === '' || what === 'stop') {
    const r = c.deps.runFleet('test-deploy', [cfg.name, what === '' ? '--status' : '--stop']);
    return stripAnsi(r.output).replace(/\n$/, '');
  }
  if (!branchNameOk(what)) return `not a branch name: '${what}'\nusage: /testdeploy <repo> <branch>  |  /testdeploy <repo>  |  /testdeploy <repo> stop`;
  const started = c.deps.spawnDetached('test-deploy', [cfg.name, what]);
  if (started.status !== 0) return `could not start the test deploy of ${what} — is one still building? ${started.output.trim()}`;
  return `building ${what} for the test URL — install and build take a few minutes; the link follows when it answers.`;
}

export type Resolved = { repo: string; arg: string; rest: string } | { reply: string };

/** The repo comes first, but with one repo registered naming it every time
 *  is ceremony, and forgetting it used to answer "unknown repo '012'" — a
 *  true statement about the registry, and no use to anyone. With exactly one
 *  repo the words shift right and that repo is used — only when the word in
 *  the repo slot is plainly not a repo name: absent, a story id, or a word
 *  with a '/' in it (an epic, any branch), which no repo name has.
 *  A misspelt repo is told so rather than quietly read as a story id. With
 *  several, nothing is guessed: the reply names the ones that exist. */
export function resolveRepo(c: BotContext, cmd: Command): Resolved {
  const { repo, arg, rest } = cmd;
  if (repo !== '' && existsSync(join(registryDir(c), `${repo}.env`))) return { repo, arg, rest };
  const only = repoNames(c);
  if (only.length === 1 && (repo === '' || /^[0-9]{3,}$/.test(repo) || repo.includes('/'))) {
    return { repo: only[0] ?? '', arg: repo, rest: arg !== '' ? `${arg} ${rest}` : rest };
  }
  return { reply: `unknown repo: ${repo === '' ? '(none given)' : repo}\nknown: ${only.join(' ')}\n/help lists the commands` };
}

/** dispatch <text> → the reply: a die anywhere in a command is the reply,
 *  and trailing newlines are removed, as `$(…)` removes them. */
export function dispatch(c: BotContext, text: string): string {
  return dispatchRaw(c, text).replace(/\n+$/, '');
}

function dispatchRaw(c: BotContext, text: string): string {
  const cmd = parseCommand(text);
  switch (cmd.verb) {
    case '/run': return cmdRun(c, cmd.repo);
    case '/help': case '/start': return cmdHelp(c);
    case '/repo': case '/repos': return cmdRepo(c);
    case '/status': case '/status-all': case '/why': case '/promote': case '/answer': case '/wait': case '/fallback': case '/revert': case '/merge': case '/testdeploy': break;
    default: return cmdHelp(c);
  }
  const r = resolveRepo(c, cmd);
  if ('reply' in r) return r.reply;
  try {
    const cfg = c.deps.loadRepo(c.fleetHome, r.repo);
    // Under the fleet lock. A wait that runs out heads the reply as a `!!`
    // line — without colour codes, which a phone shows as they are.
    const locked = (fn: () => string): string => {
      let waited = false;
      const v = withFleetLock(cfg.root, c.knobs.lockWait, () => { waited = true; }, fn);
      return waited ? `!! waited ${c.knobs.lockWait}s for the fleet lock — going ahead\n${v}` : v;
    };
    switch (cmd.verb) {
      case '/status': return cmdStatus(c, cfg, false);
      case '/status-all': return cmdStatus(c, cfg, true);
      case '/why': return cmdWhy(cfg, r.arg);
      case '/promote': return locked(() => cmdPromote(c, cfg, r.arg));
      case '/answer': return r.rest !== '' ? locked(() => cmdAnswer(c, cfg, r.arg, r.rest)) : 'usage: /answer <repo> <id> <text>';
      case '/wait': return locked(() => cmdWait(cfg, r.arg));
      case '/fallback': return locked(() => cmdFallback(cfg, r.arg));
      case '/revert': return locked(() => cmdRevert(c, cfg, r.arg));
      case '/merge': return locked(() => cmdMerge(c, cfg, r.arg));
      case '/testdeploy': return cmdTestDeploy(c, cfg, r.arg);
      default: return '';
    }
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** poll. One getUpdates from the saved offset; the highest update_id is
 *  acknowledged whatever happens to the messages themselves — an update that
 *  cannot be handled must not be replayed for ever. */
export async function poll(c: BotContext): Promise<void> {
  const cfg = configuredFrom(c.env, c.fleetHome, c.deps.io.warn);
  if (cfg === undefined) {
    c.deps.io.warn('not configured (.env.fleet) — nothing to poll');
    return;
  }
  const offsetFile = join(c.fleetHome, '.bot-offset');
  let offset = 0;
  try {
    const raw = readFileSync(offsetFile, 'utf8').replace(/\n$/, '');
    if (/^[0-9]+$/.test(raw)) offset = Number(raw);
  } catch { /* no offset yet: 0 */ }

  const r = await c.deps.api.getUpdates({ base: c.knobs.base, token: cfg.token, offset, timeoutSec: c.knobs.timeoutSec });
  if (!r.ok) {
    c.deps.io.warn(r.reason === 'failed' ? 'getUpdates failed' : 'getUpdates returned no result');
    return;
  }
  const last = r.updates[r.updates.length - 1];
  if (last === undefined) return;
  writeFileSync(offsetFile, `${last.update_id + 1}\n`);

  for (const u of r.updates) {
    const from = u.message?.from?.id;
    const text = u.message?.text ?? '';
    if (text === '') continue;
    if (String(from ?? '') !== cfg.chatId) {
      // No reply: answering would confirm the bot exists to whoever found it.
      c.deps.io.warn(`ignored a message from ${from ?? ''}`);
      continue;
    }
    c.deps.io.log(`command: ${text.split('\n')[0] ?? ''}`);
    const reply = dispatch(c, text) || '(no output)';
    // A table goes as a code block; everything else as plain text, so a URL
    // in a reply stays a link.
    const verb = text.split(' ')[0] ?? '';
    await send(c, reply, verb === '/status' || verb === '/status-all');
  }
}

export function makeContext(fleetHome: string, env: NodeJS.ProcessEnv): BotContext {
  let root: string | undefined;
  const knobs = readBotKnobs(env);
  const deps = defaultDeps(fleetHome, env, knobs.detachCmd, () => {
    if (root === undefined) throw new Error('telegram.ts: the fleet lock needs a loaded repo');
    return lockPath(root);
  });
  const loadRepo = deps.loadRepo;
  deps.loadRepo = (home, name) => {
    const cfg = loadRepo(home, name);
    root = cfg.root;
    return cfg;
  };
  return { fleetHome, env, knobs, deps };
}
