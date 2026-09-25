// write-story.ts — `fleet write-story`. Turns an intent into a story the
// fleet can act on: one agent, read-only over the epic's code, writes
// .stories/<id>.md at `status: draft`; the story is then linted mechanically
// and left for a human to read and promote to `ready`. Nothing is committed
// and no builder runs.
//
// The agent runs in a throwaway worktree at the epic's tip (origin's, not
// local — the launcher cuts every worktree from origin too), so it reads the
// code the story will be built against rather than whatever the integration
// branch happens to have. The prompt is rendered in-process through
// lib/render.ts.
//
// Unlike the launcher's two agent calls, this one has no wall-clock
// timeout — a human is watching a one-off authoring session, not an
// unattended round.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { builderArgv, claudeRefusal, parseBuilderOutput } from './lib/agents.ts';
import { Die } from './lib/die.ts';
import { fetch, refExists, worktreeAdd, worktreeRemoveForce } from './lib/git.ts';
import { log, out, warn } from './lib/log.ts';
import { lintStory } from './lint-story.ts';
import { run } from './lib/proc.ts';
import { renderPrompt } from './lib/render.ts';
import type { RepoConfig } from './lib/config.ts';

export const USAGE = 'usage: fleet write-story <repo> <story-id> "<what you want>" [--base epic/<name>]';

const ALLOWED_TOOLS = 'Read,Grep,Glob,Bash,Write';

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

/** A plain identifier — the same character class as a
 *  story id everywhere else in the harness. */
export function isValidStoryId(id: string): boolean {
  return /^[0-9A-Za-z_-]+$/.test(id);
}

/** The default is the integration branch; a `--base` must name an epic/*
 *  branch. Whether that branch actually exists on origin is a separate,
 *  git-backed check. */
export function resolveStoryBase(o: { defaultBase: string; repoName: string; baseFlag: string | undefined; baseVal: string | undefined }): string {
  if (o.baseFlag !== '--base') return o.defaultBase;
  if (o.baseVal === undefined || o.baseVal === '') throw new Die('--base needs a branch');
  if (!o.baseVal.startsWith('epic/')) {
    throw new Die(`--base takes an epic/… branch, not '${o.baseVal}' — make one with: fleet new-epic ${o.repoName} <name>`);
  }
  return o.baseVal;
}

export interface WriteStoryOptions {
  fleetHome: string;
  /** After the repo name: `[story-id, intent, --base?, branch?]`. */
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Registers what must run when the process is killed (SIGTERM, SIGINT
   *  or SIGHUP). The normal exit runs it through `finally`. */
  onExit: (fn: () => void) => void;
}

export async function writeStory(cfg: RepoConfig, o: WriteStoryOptions): Promise<number> {
  const storyModel = o.env['STORY_MODEL'] || 'opus'; // the highest-judgment job in the loop; an alias, so the newest Opus
  const maxTurns = o.env['MAX_TURNS'] || '60';

  const [storyId, intent, baseFlag, baseVal] = o.argv;
  if (storyId === undefined || storyId === '' || intent === undefined || intent === '') throw new Die(USAGE);
  if (!isValidStoryId(storyId)) throw new Die(`story id '${storyId}' is not a plain identifier`);

  const storyBase = resolveStoryBase({ defaultBase: cfg.baseBranch, repoName: cfg.name, baseFlag, baseVal });
  if (!refExists(cfg.root, `origin/${storyBase}`)) throw new Die(`no such branch on origin: ${storyBase}`);

  const storyFile = join(cfg.root, '.stories', `${storyId}.md`);
  if (existsSync(storyFile)) throw new Die(`.stories/${storyId}.md already exists — pick another id or delete it`);

  const wt = join(cfg.root, '..', `ws-${storyId}`);
  const cleanup = (): void => {
    if (isDir(wt)) worktreeRemoveForce(cfg.root, wt);
  };
  o.onExit(cleanup);

  try {
    log(`story ${storyId} on ${storyBase}, model ${storyModel}`);
    fetch(cfg.root, 'origin');
    if (worktreeAdd(cfg.root, wt, { detach: `origin/${storyBase}` }) !== 0) throw new Die(`could not create a worktree at origin/${storyBase}`);

    mkdirSync(join(wt, '.stories'), { recursive: true });
    copyFileSync(join(cfg.root, '.stories', 'TEMPLATE.md'), join(wt, '.stories', 'TEMPLATE.md'));

    const promptsDir = `${o.fleetHome}/prompts`;
    const rendered = renderPrompt(promptsDir, 'write-story.md', { STORY_ID: storyId, INTENT: intent, STORY_BASE: storyBase });

    log('writing');
    // No timeout, unlike the launcher's builder/reviewer calls — a human is
    // watching a one-off authoring session. stderr merged into stdout.
    const r = await run('claude', builderArgv({ model: storyModel, maxTurns, allowedTools: ALLOWED_TOOLS }), {
      cwd: wt, input: rendered.text, timeoutSec: 0, stderr: 'merge',
    });
    const parsed = parseBuilderOutput(r.stdout);
    const refused = claudeRefusal(r.stdout);
    if (refused !== undefined) throw new Die(`Claude refused the story writer: ${refused}`);
    if (parsed.isError === 'parse-failed') {
      warn('agent output was not JSON — first 20 lines:');
      out(`${r.stdout.split('\n').slice(0, 20).join('\n')}\n`);
    }

    const writtenFile = join(wt, '.stories', `${storyId}.md`);
    if (!existsSync(writtenFile)) throw new Die(`no story was written (is_error=${parsed.isError}). Said: ${parsed.message}`);

    copyFileSync(writtenFile, storyFile);
    const lines = (readFileSync(storyFile, 'utf8').match(/\n/g) ?? []).length;
    log(`wrote .stories/${storyId}.md (${lines} lines)`);

    out('\n');
    out(`${parsed.message}\n`);
    out('\n');

    log('linting');
    if (lintStory(cfg, { argv: [storyId] }) === 0) {
      out('\n');
      log(`draft ready — read it, then set status: ready and run fleet launch ${cfg.name} ${storyId}`);
      return 0;
    }
    out('\n');
    warn('the draft has errors above. Fix them or rewrite before promoting it.');
    return 1;
  } finally {
    cleanup();
  }
}
