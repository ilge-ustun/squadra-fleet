// reset.ts — a story back to the queue:
//
//   fleet reset <repo> <id> [--force] [--draft]
//
// removes its worktree and branch, resets the frontmatter (status and round
// only: base and scope_deny belong to the story, not to the run), deletes
// the review, the evidence and any blocked question, and commits. Refuses
// while something runs in the worktree, and refuses to drop commits that
// are on no other branch without --force. Nothing in the fleet calls this;
// a human does, from the fleet-verdict skill.
//
// Pinned: status: and round: are replaced in the frontmatter only, never in
// the body.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { RepoConfig } from './lib/config.ts';
import { Die } from './lib/die.ts';
import { replaceFrontmatterField, storyField } from './lib/frontmatter.ts';
import {
  addAll, branchDelete, branchExists, commit, logOneline, lsFilesTracked, pushQuiet, refExists, revListCount, stagedIsEmpty,
  worktreePrune, worktreeRemoveForce,
} from './lib/git.ts';
import { log, out, warn } from './lib/log.ts';
import { procsInWorktree as liveProcs } from './lib/procs.ts';

export const USAGE = 'usage: fleet reset <repo> <id> [--force] [--draft]';

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

// ── the pure parts ───────────────────────────────────────────────────────────

export interface ResetArgs {
  id: string;
  force: boolean;
  newStatus: 'ready' | 'draft';
}

/** The flags after the repo name. */
export function parseArgs(argv: readonly string[]): ResetArgs {
  let id = '';
  let force = false;
  let newStatus: ResetArgs['newStatus'] = 'ready';
  for (const a of argv) {
    if (a === '--force') force = true;
    else if (a === '--draft') newStatus = 'draft';
    else if (a.startsWith('-')) throw new Die(`unknown option: ${a}`);
    else {
      if (id !== '') throw new Die('one story at a time');
      id = a;
    }
  }
  if (id === '') throw new Die(USAGE);
  return { id, force, newStatus };
}

/** The pids as `tr '\n' ' '` leaves them, a trailing space included. */
export const pidsLine = (id: string, wt: string, pids: readonly string[]): string =>
  `${id} has processes running in ${wt} (${pids.join(' ')} ) — stop them first`;

/** `rm -f .runs/$ID-*`: the names the glob takes — including `900-b-…`
 *  for 900. */
export const runsOfStory = (names: readonly string[], id: string): string[] => names.filter((n) => n.startsWith(`${id}-`));

// ── the program ──────────────────────────────────────────────────────────────

export interface ResetOptions {
  /** After the repo name. */
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  procsInWorktree?: (path: string) => string[];
}

export function reset(cfg: RepoConfig, o: ResetOptions): number {
  const root = cfg.root;
  const pushStatus = o.env['PUSH_STATUS'] || '1';
  const procs = o.procsInWorktree ?? liveProcs;
  const { id, force, newStatus } = parseArgs(o.argv);
  const storyFile = `${root}/.stories/${id}.md`;
  if (!isFile(storyFile)) throw new Die(`no such story: .stories/${id}.md`);

  const wt = `${root}/../wt-${id}`;
  const branch = `story/${id}`;
  const storyBase = storyField(root, id, 'base') || cfg.baseBranch;

  // ── refusals ───────────────────────────────────────────────────────────────
  if (isDir(wt)) {
    const pids = procs(wt);
    if (pids.length > 0) throw new Die(pidsLine(id, wt, pids));
  }
  if (branchExists(root, branch)) {
    const into = refExists(root, storyBase) ? storyBase : `origin/${storyBase}`;
    const ahead = revListCount(root, `${into}..${branch}`);
    if (ahead > 0 && !force) {
      const lines = logOneline(root, `${into}..${branch}`);
      if (lines !== '') out(`${lines.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
      throw new Die(`${branch} has ${ahead} commit(s) that ${into} does not — rerun with --force to drop them`);
    }
  }

  // ── reset ──────────────────────────────────────────────────────────────────
  if (isDir(wt)) {
    if (worktreeRemoveForce(root, wt) !== 0) rmSync(wt, { recursive: true, force: true });
    log(`worktree removed: ${wt}`);
  }
  worktreePrune(root);

  if (branchExists(root, branch)) {
    if (branchDelete(root, branch) !== 0) throw new Die(`could not delete ${branch}`);
    log(`branch deleted: ${branch}`);
  }

  // Frontmatter only, and only the two fields: base and scope_deny belong to
  // the story, not to the run.
  replaceFrontmatterField(storyFile, 'status', newStatus);
  replaceFrontmatterField(storyFile, 'round', '0');

  for (const f of [`.review/${id}.md`, `.review/${id}.md.new`, `.blocked/${id}.md`]) rmSync(`${root}/${f}`, { force: true });
  rmSync(`${root}/.review/${id}`, { recursive: true, force: true });
  if (isDir(`${root}/.runs`)) {
    for (const n of runsOfStory(readdirSync(`${root}/.runs`), id)) rmSync(`${root}/.runs/${n}`, { recursive: true, force: true });
  }
  log('review, evidence and any blocked question removed');

  // git add fails entirely if one pathspec matches nothing, staging nothing
  // and exiting 128 (L-02). Add each path separately, and only if git knows it.
  for (const p of [`.stories/${id}.md`, `.review/${id}.md`, `.review/${id}`, `.blocked/${id}.md`]) {
    if (lsFilesTracked(root, p)) addAll(root, p);
  }
  if (stagedIsEmpty(root)) warn('nothing to commit — the story was already clear in git');
  else {
    if (commit(root, `story(${id}): reset to ${newStatus}`) !== 0) throw new Die('the reset commit failed — state is only in the working tree');
    if (pushStatus === '1' && pushQuiet(root) !== 0) warn('push failed — the reset is not visible remotely');
  }

  log(`${id} is ${newStatus}, round 0`);
  return 0;
}
