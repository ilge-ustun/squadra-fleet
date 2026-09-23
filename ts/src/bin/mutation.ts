// mutation.ts — the classifier's command line: `check`, what check-mutation.sh
// is. The verdict's own use of the classifier is in-process since seam 4
// (ts/src/lib/evidence.ts); the `run-selector` and `classify` verbs that
// served the bash launcher are gone with it.
//
//   check <repo> <patch…> [--wt <dir>]
//       → one line per patch, `CLASS name`; exit 0 only when every patch is RED
//         (check-mutation.sh's header says the rest: the tree must be clean
//         and must be the named repo's checkout or one of its worktrees;
//         raw runner output lands in <tree>/.review-out/checks/)
//
// VITEST_CMD comes from the target's config through lib/config.ts, never
// from the environment: lib.sh keeps the target's config out of the
// environment on purpose (lib.sh:14-18).
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { DirtyTreeError, classifyMutation, findSelector } from '../classifier.ts';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { porcelain } from '../lib/git.ts';
import { dieMessage, out, warn } from '../lib/log.ts';
import { runSync } from '../lib/proc.ts';

const USAGE = 'usage: mutation.ts check <repo> <patch…> [--wt <dir>]';
const CHECK_USAGE = 'usage: check-mutation.sh <repo> <patch…> [--wt <dir>]';
const FLEET_HOME = resolve(import.meta.dirname, '../../..');

class UsageError extends Error {}
/** lib.sh's die: the message on stderr, exit 1. */
class DieError extends Error {}

/** check-mutation.sh, line for line (its header is the contract). */
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
        }).cls;
      } catch (e) {
        // mutation.sh:45-46 printed the classifier's message, then its own.
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
