// revert.ts — auto-merge is allowed to change an epic branch without asking
// because undoing it is one word on a phone; this is that word:
//
//   fleet revert <repo> <id>   revert the merge commit recorded in the story's
//                              `merged:` — exactly what was merged, even if the
//                              epic moved on. No baseline is re-run; the next
//                              merge into that epic runs one.
//
// The integration branch is a human's in both directions. The revert is
// made in a throwaway worktree at origin's tip, pushed, and the story's
// `merged:` line removed, or the next status would claim a merge that has
// been taken back.
//
// Pinned: .runs/ is created before the revert log; the `merged:` line is
// removed from the frontmatter only, never from the body.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import type { RepoConfig } from './lib/config.ts';
import { Die } from './lib/die.ts';
import { deleteFrontmatterField, storyField } from './lib/frontmatter.ts';
import {
  add, branchExists, branchForce, commit, fetch, isAncestor, pushQuiet, pushRef, revParse, revertAbort, revertMerge, stagedIsEmpty,
  worktreeAdd, worktreeRemoveForce,
} from './lib/git.ts';
import { log, warn } from './lib/log.ts';

export const USAGE = 'usage: fleet revert <repo> <id>';

const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();
const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
const short = (sha: string): string => sha.slice(0, 8);

export interface StoryCheck {
  id: string;
  /** The story's `merged:`; '' when none. */
  merged: string;
  /** The story's `base:`; '' means the integration branch. */
  base: string;
  baseBranch: string;
}

/** The die text, or undefined to go on. */
export function checkStory(s: StoryCheck): string | undefined {
  if (s.merged === '') return `${s.id} has no recorded merge — nothing to revert`;
  const base = s.base || s.baseBranch;
  if (base === s.baseBranch || base === 'main' || base === 'master') return `${s.id} is based on ${base} — that branch is a human's, here too`;
  return undefined;
}

export interface RevertOptions {
  /** After the repo name. */
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** The bin's exit hook: the throwaway worktree is removed on a signal too. */
  onExit: (fn: () => void) => void;
}

export function revert(cfg: RepoConfig, o: RevertOptions): number {
  const root = cfg.root;
  const pushStatus = o.env['PUSH_STATUS'] || '1';
  const id = o.argv[0] ?? '';
  if (id === '') throw new Die(USAGE);
  const storyFile = `${root}/.stories/${id}.md`;
  if (!isFile(storyFile)) throw new Die(`no such story: .stories/${id}.md`);

  const sha = storyField(root, id, 'merged');
  const base = storyField(root, id, 'base') || cfg.baseBranch;
  const refused = checkStory({ id, merged: sha, base, baseBranch: cfg.baseBranch });
  if (refused !== undefined) throw new Die(refused);

  const rwt = `${root}/../revert-${id}`;
  const cleanup = (): void => {
    if (isDir(rwt)) worktreeRemoveForce(root, rwt);
  };
  o.onExit(cleanup);
  cleanup();
  try {
    return run();
  } finally {
    cleanup();
  }

  function run(): number {
    if (fetch(root, 'origin') !== 0) throw new Die('fetch failed');
    if (worktreeAdd(root, rwt, { detach: `origin/${base}` }) !== 0) throw new Die('worktree add failed');
    if (!isAncestor(rwt, sha, 'HEAD')) throw new Die(`${short(sha)} is not on origin/${base} — it was already reverted, or never landed`);

    // -m 1: a merge commit has two parents and git will not guess which side
    // to keep. 1 is the branch that was merged INTO, i.e. the epic without
    // the story.
    mkdirSync(`${root}/.runs`, { recursive: true });
    if (revertMerge(rwt, sha, `${root}/.runs/${id}-revert.log`) !== 0) {
      revertAbort(rwt);
      throw new Die(`the revert did not apply — either the epic changed underneath it, or the merge carried no content to undo. See .runs/${id}-revert.log; this one is a human's`);
    }

    if (pushStatus === '1' && pushRef(rwt, 'HEAD', base) !== 0) throw new Die('push failed — the revert is local only');
    if (branchExists(root, base) && branchForce(root, base, revParse(rwt, 'HEAD')) !== 0) {
      warn(`could not move the local ${base} — it is checked out somewhere`);
    }
    log(`${base} reverted: ${short(sha)} is undone`);

    // The story is no longer merged, and says so, or the next status would
    // claim a merge that has been taken back.
    deleteFrontmatterField(storyFile, 'merged');
    add(root, `.stories/${id}.md`);
    if (stagedIsEmpty(root)) warn('the story file did not change');
    else {
      if (commit(root, `story(${id}): merge into ${base} reverted`) !== 0) throw new Die('could not record the revert in the story');
      if (pushStatus === '1' && pushQuiet(root) !== 0) warn('push failed — the record is local only');
    }

    log(`${id} is unmerged again; its branch story/${id} still holds the work`);
    return 0;
  }
}
