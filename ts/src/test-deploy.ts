// fleet test-deploy <repo> <branch>   build a branch and serve it at the test URL
// fleet test-deploy <repo> --status   what the test URL serves, and whether it is up
// fleet test-deploy <repo> --stop     stop serving it, and remove its tree
//
// A branch on a URL other computers can open, before anything lands. Not a
// deploy to production, which stays the human's own, by hand, but a build of
// one branch on this machine, served until the next one replaces it.
//
// One slot on the machine: one URL (TEST_DEPLOY_URL), the loopback port
// behind it (TEST_DEPLOY_PORT), and the user unit that serves it
// (fleet-test-deploy). The web server the human set up once (Caddy, see
// docs/operations.md) holds the certificate and passes the URL to the port.
// A deploy replaces whatever the slot held, whichever repo it came from.
//
// The tree is <target>/../test-deploy, beside the story worktrees. It is a
// detached worktree at the branch's tip: origin's when origin has the branch
// (an epic), the local one otherwise (a story branch, which the fleet does
// not push). It is made afresh each time, seeded, installed and built with
// the target's own SEED_FILES, INSTALL_CMD and BUILD_CMD, and served with its
// START_CMD (`npm start` when the target names none), with PORT set.
//
// A Next build peaks near 1.4 GB on a 3.8 GB machine, so the build runs under
// the target's launch lock (lib/lock.ts) and never beside a story's. If a
// launch holds the lock, this waits for it, up to TEST_DEPLOY_LOCK_WAIT. The
// server is light and outlives this process: it is a transient unit of its
// own (systemd-run), so an SSH session or the bot's job can end without
// taking it along (L-34).
import { copyFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import type { RepoConfig } from './lib/config.ts';
import { Die } from './lib/die.ts';
import { readEnvFile } from './lib/env-file.ts';
import { fetch as gitFetch, refExists, revParse, revParseShort, worktreeAdd, worktreePaths, worktreePrune, worktreeRemoveForce } from './lib/git.ts';
import { EXIT_LAUNCH_BUSY, takeLaunchLock } from './lib/lock.ts';
import { log, warn } from './lib/log.ts';
import { runInherit, runSync } from './lib/proc.ts';
import { procsInWorktree } from './lib/procs.ts';

/** The user unit that serves the slot. */
export const UNIT = 'fleet-test-deploy';

export interface TestDeployKnobs {
  /** TEST_DEPLOY_URL: what the human opens; '' when unset. */
  url: string;
  /** TEST_DEPLOY_PORT (4100): the loopback port the web server passes to. */
  port: number;
  /** TEST_DEPLOY_LOCK_WAIT (3600): seconds to wait for a launch to let go. */
  lockWaitSec: number;
  /** TEST_DEPLOY_START_WAIT (90): seconds for the server to answer. */
  startWaitSec: number;
}

const KEYS = ['TEST_DEPLOY_URL', 'TEST_DEPLOY_PORT', 'TEST_DEPLOY_LOCK_WAIT', 'TEST_DEPLOY_START_WAIT'] as const;

/** The environment wins; `.env.fleet`, machine-local beside the bot's token,
 *  supplies what it leaves unset. An empty value counts as unset. */
export function readKnobs(env: NodeJS.ProcessEnv, fleetHome: string): TestDeployKnobs {
  const v = new Map<string, string>();
  const file = join(fleetHome, '.env.fleet');
  if (existsSync(file)) {
    try {
      for (const [k, x] of readEnvFile(file, KEYS, env)) if (x !== '') v.set(k, x);
    } catch (e) {
      throw new Die(e instanceof Error ? e.message : String(e));
    }
  }
  for (const k of KEYS) {
    const x = env[k];
    if (x !== undefined && x !== '') v.set(k, x);
  }
  const whole = (k: string, d: number): number => {
    const x = v.get(k);
    if (x === undefined) return d;
    if (!/^[0-9]+$/.test(x)) throw new Die(`${k}=${x} is not a whole number`);
    return Number(x);
  };
  return {
    url: v.get('TEST_DEPLOY_URL') ?? '',
    port: whole('TEST_DEPLOY_PORT', 4100),
    lockWaitSec: whole('TEST_DEPLOY_LOCK_WAIT', 3600),
    startWaitSec: whole('TEST_DEPLOY_START_WAIT', 90),
  };
}

/** A name the human typed, on a phone or into argv, checked before git sees
 *  it: no leading '-' (it would be an option), no '..', and nothing that
 *  git's own check-ref-format refuses. */
export function branchNameOk(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes('..')
    && runSync('git', ['check-ref-format', '--branch', name]).status === 0;
}

/** The branch's tip: origin's when origin has it, else the local branch's. */
export function branchTip(root: string, branch: string): { ref: string; sha: string } | undefined {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    if (refExists(root, ref)) return { ref, sha: revParse(root, ref) };
  }
  return undefined;
}

/** The tree a repo's test deploy is built in: beside the story worktrees. */
export function treeDir(root: string): string {
  return resolve(root, '..', 'test-deploy');
}

// ── what the slot holds ──────────────────────────────────────────────────────

export interface Deployed {
  repo: string;
  root: string;
  branch: string;
  sha: string;
  short: string;
  url: string;
  since: string;
}

/** Machine-local, like `.bot-offset`: the slot is the machine's, not a repo's. */
export function stateFile(fleetHome: string): string {
  return join(fleetHome, '.test-deploy.json');
}

export function readState(fleetHome: string): Deployed | undefined {
  let text: string;
  try {
    text = readFileSync(stateFile(fleetHome), 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as Deployed;
  } catch {
    throw new Die(`${stateFile(fleetHome)} is not JSON — remove it and deploy again`);
  }
}

/** `YYYY-MM-DD HH:MM`, local time: what the human reads in --status. */
export function localMinute(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── the unit ─────────────────────────────────────────────────────────────────

const systemctl = (...args: string[]): { status: number; stderr: string } => runSync('systemctl', ['--user', ...args]);

function unitActive(): boolean {
  return systemctl('is-active', '--quiet', UNIT).status === 0;
}

/** A unit that is not loaded has nothing to stop: systemctl's 5. */
function stopUnit(): void {
  const r = systemctl('stop', UNIT);
  if (r.status !== 0 && r.status !== 5) throw new Die(`could not stop ${UNIT}: ${r.stderr.trim()}`);
}

/** True when something accepts a connection on the loopback port. */
function answers(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (v: boolean): void => {
      s.destroy();
      ok(v);
    };
    s.setTimeout(2000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── the tree ─────────────────────────────────────────────────────────────────

function isWorktreeOf(root: string, dir: string): boolean {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return false;
  }
  return worktreePaths(root).includes(real);
}

/** Refuses while anything still runs in the tree (the unit is stopped first,
 *  so something that does is not ours to kill), and refuses a directory
 *  that is not this repo's worktree. */
function removeTree(root: string, dir: string): void {
  if (existsSync(dir)) {
    const pids = procsInWorktree(dir);
    if (pids.length > 0) throw new Die(`processes still run in ${dir} (pids: ${pids.join(' ')}) — kill them by cwd, then run again`);
    if (!isWorktreeOf(root, dir)) throw new Die(`${dir} is in the way: it is not a worktree of ${root} — move it, then run again`);
    if (worktreeRemoveForce(root, dir) !== 0 || existsSync(dir)) throw new Die(`could not remove ${dir}`);
  }
  worktreePrune(root);
}

function step(name: string, line: string, dir: string): void {
  log(`${name}: ${line}`);
  if (runInherit('bash', ['-c', line], { cwd: dir }) !== 0) {
    throw new Die(`${name} failed: ${line} in ${dir} — nothing is served; the tree is left as it is`);
  }
}

// ── the three verbs ──────────────────────────────────────────────────────────

export interface DeployOptions {
  fleetHome: string;
  branch: string;
  knobs: TestDeployKnobs;
}

/** 0 when the server answers at the URL's port; EXIT_LAUNCH_BUSY when a
 *  launch held the repo for longer than TEST_DEPLOY_LOCK_WAIT (in that case
 *  nothing was touched); a Die otherwise. From the moment the old server is
 *  stopped until the new one answers, the slot holds nothing. */
export async function deploy(cfg: RepoConfig, o: DeployOptions): Promise<number> {
  const { root } = cfg;
  if (!branchNameOk(o.branch)) throw new Die(`not a branch name: '${o.branch}'`);
  if (o.knobs.url === '') {
    throw new Die(`TEST_DEPLOY_URL is not set — put the URL the web server answers on in ${join(o.fleetHome, '.env.fleet')} (TEST_DEPLOY_URL=https://…); docs/operations.md has the one-time setup`);
  }
  const what = `test-deploy ${o.branch}`;
  let lock = takeLaunchLock(root, what);
  if (!lock.held) {
    log(`waiting up to ${o.knobs.lockWaitSec}s for the launch lock — held by ${lock.holder || 'unknown'}`);
    lock = takeLaunchLock(root, what, o.knobs.lockWaitSec);
    if (!lock.held) {
      warn(`the launch lock is still held by ${lock.holder || 'unknown'} — nothing was touched`);
      return EXIT_LAUNCH_BUSY;
    }
  }
  try {
    if (gitFetch(root, 'origin') !== 0) throw new Die(`git fetch origin failed in ${root}`);
    const tip = branchTip(root, o.branch);
    if (tip === undefined) throw new Die(`no branch ${o.branch} on origin or in ${root}`);
    const short = revParseShort(root, tip.sha);
    log(`test deploy of ${cfg.name} ${o.branch} at ${short} (${tip.ref})`);

    stopUnit();
    rmSync(stateFile(o.fleetHome), { force: true });
    if (await answers(o.knobs.port)) {
      throw new Die(`something else answers on port ${o.knobs.port} — not ${UNIT}, which is stopped; free the port or set TEST_DEPLOY_PORT (and the web server) to another`);
    }
    const dir = treeDir(root);
    removeTree(root, dir);
    if (worktreeAdd(root, dir, { detach: tip.sha }) !== 0) throw new Die(`could not add the worktree ${dir}`);
    for (const f of cfg.seedFiles) {
      if (!existsSync(join(root, f))) throw new Die(`${f} is missing from ${root} — the build would not behave like production`);
      copyFileSync(join(root, f), join(dir, f));
    }
    step('install', cfg.installCmd, dir);
    step('build', cfg.buildCmd, dir);

    const start = cfg.startCmd ?? 'npm start';
    log(`start: ${start}, PORT=${o.knobs.port}, as ${UNIT}`);
    const r = runSync('systemd-run', [
      '--user', '--collect', '--quiet', `--unit=${UNIT}`, `--working-directory=${dir}`,
      '--setenv=PATH', '--setenv=HOME', `--setenv=PORT=${o.knobs.port}`,
      'bash', '-c', start,
    ]);
    if (r.status !== 0) throw new Die(`could not start ${UNIT}: ${(r.stdout + r.stderr).trim()}`);
    const deadline = Date.now() + o.knobs.startWaitSec * 1000;
    while (!(await answers(o.knobs.port))) {
      if (!unitActive()) throw new Die(`the server exited before it answered on port ${o.knobs.port} — journalctl --user -u ${UNIT} says why`);
      if (Date.now() >= deadline) {
        stopUnit();
        throw new Die(`nothing answered on port ${o.knobs.port} within ${o.knobs.startWaitSec}s — ${UNIT} is stopped; journalctl --user -u ${UNIT} says why`);
      }
      await sleep(500);
    }
    const st: Deployed = { repo: cfg.name, root, branch: o.branch, sha: tip.sha, short, url: o.knobs.url, since: localMinute(new Date()) };
    writeFileSync(stateFile(o.fleetHome), `${JSON.stringify(st, null, 2)}\n`);
    log(`${cfg.name} ${o.branch} (${short}) is up at ${o.knobs.url}`);
    return 0;
  } finally {
    lock.release();
  }
}

/** One line: what the slot serves and whether it is up. */
export function status(fleetHome: string, repo: string): string {
  const st = readState(fleetHome);
  const up = unitActive();
  if (st === undefined) {
    return up ? `${UNIT} runs, but no deploy is recorded — fleet test-deploy ${repo} --stop` : 'nothing is deployed for testing';
  }
  const head = `${st.repo} ${st.branch} (${st.short}) at ${st.url}`;
  return up ? `${head} — up since ${st.since}` : `${head} — DOWN, the server is not running; fleet test-deploy ${st.repo} ${st.branch} builds it again`;
}

/** Stops the server whatever repo it serves, and removes that repo's tree. */
export function stop(fleetHome: string): string {
  const st = readState(fleetHome);
  if (st === undefined && !unitActive()) return 'nothing is deployed for testing';
  stopUnit();
  if (st !== undefined) removeTree(st.root, treeDir(st.root));
  rmSync(stateFile(fleetHome), { force: true });
  return st !== undefined ? `stopped ${st.repo} ${st.branch} (${st.short}); ${st.url} serves nothing now` : `stopped ${UNIT}`;
}
