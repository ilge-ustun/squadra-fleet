// mutation.ts — the classifier's command line, for the bash that still
// drives it. Two verbs, one line of stdout each, the class and nothing
// else, so `MUT_CLASS="$(node … classify …)"` in mutation.sh gets exactly
// the class or a non-zero status.
//
//   run-selector <selector-file> --wt <dir> --kind test|cmd --raw <prefix> --vitest-cmd <cmd>
//       → RED | GREEN | NO_TESTS
//   classify <patch> --wt <dir> --kind test|cmd --selector <file> --raw <prefix>
//            --restore checkout|reverse --vitest-cmd <cmd> [--result <file>]
//       → RED | GREEN | NO_TESTS | PRE_RED | SELECTOR_INVALID | PATCH_INVALID
//         --result writes the evidence file: the class on line 1 and, for a
//         .test that reached the mutated run, the failed tests on line 2
//         a dirty tree before or after: the porcelain on stderr, exit 1, nothing on stdout
//
// VITEST_CMD comes as an argument, not from the environment: lib.sh keeps
// the target's config out of the environment on purpose (lib.sh:14-18), and
// the runner this starts must see the same environment it saw from bash.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DirtyTreeError, classifyMutation, runSelector } from '../classifier.ts';
import { dieMessage, out } from '../lib/log.ts';
import { isRestore, isSelectorKind } from '../lib/types.ts';
import { resultSummaryLine } from '../lib/result-summary.ts';
import { readVitestJson } from '../lib/vitest-json.ts';

const USAGE =
  'usage: mutation.ts run-selector <selector-file> --wt <dir> --kind test|cmd --raw <prefix> --vitest-cmd <cmd>\n' +
  '       mutation.ts classify <patch> --wt <dir> --kind test|cmd --selector <file> --raw <prefix> --restore checkout|reverse --vitest-cmd <cmd>';

class UsageError extends Error {}

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

function main(argv: readonly string[]): number {
  const [verb, ...rest] = argv;
  switch (verb) {
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
      if (result !== undefined) {
        const line2 = r.mutJsonPath === undefined ? undefined : resultSummaryLine(readVitestJson(r.mutJsonPath));
        writeFileSync(resolve(result), `${r.cls}\n${line2 === undefined ? '' : `${line2}\n`}`);
      }
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
  if (e instanceof DirtyTreeError || e instanceof UsageError) dieMessage(e.message);
  else dieMessage(`mutation.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
