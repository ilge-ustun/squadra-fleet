// mutation.ts — the classifier's command line. Two verbs for the bash that
// still drives the verdict, one line of stdout each, the class and nothing
// else, so `MUT_CLASS="$(node … classify …)"` in mutation.sh gets exactly
// the class or a non-zero status; and `check`, what check-mutation.sh is.
//
//   run-selector <selector-file> --wt <dir> --kind test|cmd --raw <prefix> --vitest-cmd <cmd>
//       → RED | GREEN | NO_TESTS
//   classify <patch> --wt <dir> --kind test|cmd --selector <file> --raw <prefix>
//            --restore checkout|reverse --vitest-cmd <cmd> [--result <file>]
//       → RED | GREEN | NO_TESTS | PRE_RED | SELECTOR_INVALID | PATCH_INVALID
//         --result writes the evidence file: the class on line 1 and, for a
//         .test that reached the mutated run, the failed tests on line 2
//         a dirty tree before or after: the porcelain on stderr, exit 1, nothing on stdout
//   check <repo> <patch…> [--wt <dir>]
//       → one line per patch, `CLASS name`; exit 0 only when every patch is RED
//         (check-mutation.sh's header says the rest: the tree must be clean
//         and must be the named repo's checkout or one of its worktrees;
//         raw runner output lands in <tree>/.review-out/checks/)
//
// VITEST_CMD comes as an argument, not from the environment: lib.sh keeps
// the target's config out of the environment on purpose (lib.sh:14-18), and
// the runner this starts must see the same environment it saw from bash.
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { DirtyTreeError, classifyMutation, findSelector, runSelector } from '../classifier.ts';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { porcelain } from '../lib/git.ts';
import { dieMessage, out, warn } from '../lib/log.ts';
import { runSync } from '../lib/proc.ts';
import { isRestore, isSelectorKind } from '../lib/types.ts';
import { writeResultFile } from '../lib/evidence.ts';

const USAGE =
  'usage: mutation.ts run-selector <selector-file> --wt <dir> --kind test|cmd --raw <prefix> --vitest-cmd <cmd>\n' +
  '       mutation.ts classify <patch> --wt <dir> --kind test|cmd --selector <file> --raw <prefix> --restore checkout|reverse --vitest-cmd <cmd>';

const CHECK_USAGE = 'usage: check-mutation.sh <repo> <patch…> [--wt <dir>]';
const FLEET_HOME = resolve(import.meta.dirname, '../../..');

class UsageError extends Error {}
/** lib.sh's die: the message on stderr, exit 1. */
class DieError extends Error {}

interface Parsed {
  positional: string[];
  flags: Map<string, string>;
}

/** `--name value` pairs and positionals; every flag takes one value. */
function parse(argv: readonly string[], allowed: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const value = argv[i + 1];
      if (!allowed.includes(name)) throw new UsageError(`unknown option --${name}\n${USAGE}`);
      if (value === undefined) throw new UsageError(`--${name} needs a value\n${USAGE}`);
      flags.set(name, value);
      i++;
    } else {
      positional.push(a);
    }
  }
  return positional.length === 0 ? { positional, flags } : { positional, flags };
}

function need(p: Parsed, name: string): string {
  const v = p.flags.get(name);
  if (v === undefined || v === '') throw new UsageError(`--${name} is required\n${USAGE}`);
  return v;
}

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
  switch (verb) {
    case 'check':
      return check(rest);
    case 'run-selector': {
      const p = parse(rest, ['wt', 'kind', 'raw', 'vitest-cmd']);
      const [selectorFile] = p.positional;
      if (selectorFile === undefined || p.positional.length !== 1) throw new UsageError(USAGE);
      const kind = need(p, 'kind');
      if (!isSelectorKind(kind)) throw new UsageError(`--kind must be test or cmd, not '${kind}'`);
      const cls = runSelector({
        wt: resolve(need(p, 'wt')),
        kind,
        selectorFile: resolve(selectorFile),
        rawPrefix: resolve(need(p, 'raw')),
        vitestCmd: need(p, 'vitest-cmd'),
      });
      out(`${cls}\n`);
      return 0;
    }
    case 'classify': {
      const p = parse(rest, ['wt', 'kind', 'selector', 'raw', 'restore', 'vitest-cmd', 'result']);
      const [patch] = p.positional;
      if (patch === undefined || p.positional.length !== 1) throw new UsageError(USAGE);
      const kind = need(p, 'kind');
      if (!isSelectorKind(kind)) throw new UsageError(`--kind must be test or cmd, not '${kind}'`);
      const restore = need(p, 'restore');
      if (!isRestore(restore)) throw new UsageError(`--restore must be checkout or reverse, not '${restore}'`);
      const r = classifyMutation({
        wt: resolve(need(p, 'wt')),
        patch: resolve(patch),
        kind,
        selectorFile: resolve(need(p, 'selector')),
        rawPrefix: resolve(need(p, 'raw')),
        restore,
        vitestCmd: need(p, 'vitest-cmd'),
      });
      const result = p.flags.get('result');
      if (result !== undefined) writeResultFile(resolve(result), r.cls, r.mutJsonPath);
      out(`${r.cls}\n`);
      return 0;
    }
    default:
      throw new UsageError(USAGE);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof DirtyTreeError || e instanceof UsageError || e instanceof DieError) dieMessage(e.message);
  else if (e instanceof ConfigError) { if (!e.alreadyReported) dieMessage(e.message); }
  else dieMessage(`mutation.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
