// fleet check-mutation <repo> <patch…> [--wt <dir>] — the verdict's own
// mutation classifier (src/classifier.ts, the code the launcher runs
// in-process) on a tree someone is still working in: the builder's worktree,
// or a human's checkout. For each patch, with its .test or .cmd beside it:
// pre-run the selector, apply the patch, run it again, undo the patch with
// `git apply -R`, and print `CLASS name`, the class the verdict would print:
//
//   RED               the mutation was caught — this is the only good answer
//   GREEN             it survived: the instrument does not assert this
//   NO_TESTS          the mutation broke compilation; nothing was collected
//   PRE_RED           the selector already fails on the unmutated tree
//   SELECTOR_INVALID  the selector names no test (wrong path, wrong -t)
//   PATCH_INVALID     the patch does not apply to this head
//   NO_SELECTOR       no .test or .cmd beside the patch
//
// Exit 0 only when every patch is RED, so a builder can loop and stop.
//
// The tree must be clean apart from .review-out/ — everything committed — or
// nothing runs. The safe point is a commit: a restore over uncommitted work
// is how real fixes were lost before this existed, and a patch made before
// the final commit will not apply to the head the verdict sees. The tree is
// the cwd unless --wt names it; it must be the named repo's checkout or one
// of its worktrees. Raw runner output lands in <tree>/.review-out/checks/.
//
// VITEST_CMD (and CARGO_CMD, for a `cargo:` selector) comes from the
// target's config through lib/config.ts, never from the environment: lib.sh keeps the target's config out of the
// environment on purpose.
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { DirtyTreeError, classifyMutation, findSelector } from '../classifier.ts';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { porcelain } from '../lib/git.ts';
import { dieMessage, out, warn } from '../lib/log.ts';
import { runSync } from '../lib/proc.ts';

const USAGE = 'usage: mutation.ts check <repo> <patch…> [--wt <dir>]';
const CHECK_USAGE = 'usage: fleet check-mutation <repo> <patch…> [--wt <dir>]';
const FLEET_HOME = resolve(import.meta.dirname, '../../..');

class UsageError extends Error {}
/** lib.sh's die: the message on stderr, exit 1. */
class DieError extends Error {}

/** The check verb; the header above is its contract. */
function check(argv: readonly string[]): number {
  const [repo, ...rest] = argv;
  if (repo === undefined) throw new DieError(CHECK_USAGE);
  const cfg = loadRepo(FLEET_HOME, repo);
  let wtArg = process.cwd();
  const patches: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a === '--wt') {
      const v = rest[i + 1];
      if (v === undefined || v === '') throw new DieError(`--wt needs a directory\n${CHECK_USAGE}`);
      wtArg = v;
      i++;
    } else if (a.startsWith('-')) {
      throw new DieError(CHECK_USAGE);
    } else {
      patches.push(a);
    }
  }
  if (patches.length === 0) throw new DieError(CHECK_USAGE);

  let wt: string;
  try {
    wt = realpathSync(wtArg);
  } catch {
    throw new DieError(`no such directory: ${wtArg}`);
  }
  if (runSync('git', ['-C', wt, 'rev-parse', '--show-toplevel']).stdout.trim() !== wt) {
    throw new DieError(`${wt} is not the top of a git checkout`);
  }
  const commonDir = (dir: string): string => runSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
  if (commonDir(wt) !== commonDir(cfg.root)) {
    throw new DieError(`${wt} is not a checkout of repo '${cfg.name}' (${cfg.root})`);
  }
  const dirty = porcelain(wt);
  if (dirty !== '') throw new DieError(`tree not clean — commit first, then produce the patch from the committed head:\n${dirty}`);

  mkdirSync(`${wt}/.review-out/checks`, { recursive: true });
  let allRed = true;
  for (const p of patches) {
    const patch = resolve(p);
    if (!existsSync(patch)) throw new DieError(`no such patch: ${patch}`);
    const name = basename(patch, '.patch');
    const sel = findSelector(patch);
    let cls: string;
    if (sel === undefined) {
      cls = 'NO_SELECTOR';
    } else {
      try {
        cls = classifyMutation({
          wt, patch, kind: sel.kind, selectorFile: sel.file,
          rawPrefix: `${wt}/.review-out/checks/${name}`, restore: 'reverse', vitestCmd: cfg.vitestCmd,
          ...(cfg.cargoCmd !== undefined ? { cargoCmd: cfg.cargoCmd } : {}),
        }).cls;
      } catch (e) {
        // The classifier's own message first, then which patch it was.
        if (!(e instanceof DirtyTreeError)) throw e;
        dieMessage(e.message);
        throw new DieError(`mutation runner: ${name} — the classifier failed (node ${process.version}); its message is above`);
      }
    }
    if (cls !== 'RED') allRed = false;
    out(`${cls} ${name}\n`);
  }
  if (!allRed) {
    warn('not every mutation is RED — the verdict would say the same');
    return 1;
  }
  return 0;
}

function main(argv: readonly string[]): number {
  const [verb, ...rest] = argv;
  if (verb !== 'check') throw new UsageError(USAGE);
  return check(rest);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof DirtyTreeError || e instanceof UsageError || e instanceof DieError) dieMessage(e.message);
  else if (e instanceof ConfigError) { if (!e.alreadyReported) dieMessage(e.message); }
  else dieMessage(`mutation.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
