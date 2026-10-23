// promote.ts — a story to `ready`, and a drain started: what the bot's
// /promote does from the phone, and what `fleet promote <repo> <id>` does
// at a terminal (bin/promote.ts). Before the command a coordinator promoted
// by hand — an edit, a commit, a push, a systemctl line — and nothing
// recorded when; both ways are one path now, and each promotion is a
// `promote` mark in the target's .runs/events.jsonl (lib/events.ts).
//
// The caller holds the fleet lock: the commit must not meet a launcher's
// status commit in one index.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoConfig } from './lib/config.ts';
import { openEventLog } from './lib/events.ts';
import { replaceFrontmatterField, storyField } from './lib/frontmatter.ts';
import { add, commit, pushQuiet, stagedIsEmpty } from './lib/git.ts';
import { splitCommand } from './launch.ts';

export const USAGE = 'usage: fleet promote <repo> <id> [--by <who>]';

/** How a drain is started (QUEUE_START_CMD): it must return once the drain
 *  has started, never when it ends (L-33). `{repo}` is the repo's name. */
export const QUEUE_START_DEFAULT = 'systemctl --user start --no-block fleet-queue@{repo}.service';

/** The command line that starts one repo's drain. */
export function queueStartArgv(cmd: string, repo: string): string[] {
  return splitCommand(cmd).map((w) => w.replaceAll('{repo}', repo));
}

/** A three-digit id whose story file exists. */
export function storyOk(root: string, id: string): boolean {
  return /^[0-9]{3}$/.test(id) && existsSync(join(root, '.stories', `${id}.md`));
}

/** While a story is in_progress its status is the launcher's: no verb may
 *  write `ready` over it. A launcher that died leaves it to the next drain's
 *  reap, which checks the story's trees first (L-31). */
export function launcherHas(root: string, id: string): string | undefined {
  if (storyField(root, id, 'status') !== 'in_progress') return undefined;
  return `${id} is in_progress — a launcher has it; if that launcher died, the next drain returns it to the queue`;
}

export interface PromoteOptions {
  /** Who promoted it, in the commit and the mark: `telegram`, `fleet promote`. */
  by: string;
  /** Starts the repo's drain; true when it started. */
  startQueue: () => boolean;
  warn?: (msg: string) => void;
}

/** A promotion is wanted now (L-39): after its commit it starts a drain. A
 *  drain already running takes the story after its current one, so a
 *  second start is a no-op. `promoted` is false when nothing changed. */
export function promote(cfg: RepoConfig, id: string, o: PromoteOptions): { promoted: boolean; reply: string } {
  if (!storyOk(cfg.root, id)) return { promoted: false, reply: `no such story: ${id}` };
  const running = launcherHas(cfg.root, id);
  if (running !== undefined) return { promoted: false, reply: running };
  const from = storyField(cfg.root, id, 'status');
  const rel = `.stories/${id}.md`;
  replaceFrontmatterField(join(cfg.root, rel), 'status', 'ready');
  add(cfg.root, rel);
  if (stagedIsEmpty(cfg.root)) return { promoted: false, reply: `${id} was already ready` };
  if (commit(cfg.root, `story(${id}): promoted to ready (${o.by})`) !== 0) return { promoted: false, reply: `${id} could not be committed` };
  pushQuiet(cfg.root);
  const started = o.startQueue();
  const base = storyField(cfg.root, id, 'base');
  openEventLog({ root: cfg.root, repo: cfg.name, subject: id, story: id, epic: base.startsWith('epic/') ? base : undefined, ...(o.warn !== undefined ? { warn: o.warn } : {}) })
    .mark('promote', { by: o.by, from, result: 'READY', queue: started ? 'started' : 'not started' });
  return {
    promoted: true,
    reply: started
      ? `${id} is ready — a drain is starting, or the one running takes it next`
      : `${id} is ready — could not start a drain now; the next one picks it up`,
  };
}
