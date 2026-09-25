// The round's evidence runs: the mutations and the probes. The reviewer
// proposes them as files under round-N/; the harness runs them in the
// reviewer's clean worktree, through the same classifier a builder's
// `fleet check-mutation` uses, and writes a .result beside each. A failure
// of the machinery — a dirty tree, a runner that could not start — is a
// RunnerError the launcher turns into two XX lines: the classifier's
// message, then its own.
import { copyFileSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyMutation, findSelector, runSelector as classifierRunSelector, type RunSelectorInput } from '../classifier.ts';
import { porcelain } from './git.ts';
import { resultSummaryLine } from './result-summary.ts';
import type { MutRow, ProbeRow, RunClass } from './types.ts';
import { readVitestJson } from './vitest-json.ts';

export class RunnerError extends Error {
  /** The line printed before the message — the classifier's or the runner's
   *  own words — when there is one. */
  readonly before: string | undefined;
  constructor(message: string, before?: string) {
    super(message);
    this.before = before;
  }
}

/** The .result evidence file: the class on line 1 and, when the mutated run
 *  produced JSON the summary can read, one line of it. */
export function writeResultFile(path: string, cls: string, mutJsonPath?: string): void {
  const line2 = mutJsonPath === undefined ? undefined : resultSummaryLine(readVitestJson(mutJsonPath));
  writeFileSync(path, `${cls}\n${line2 === undefined ? '' : `${line2}\n`}`);
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface MutationsInput {
  wt: string;
  evidenceDir: string;
  /** The .runs prefix for a mutation's raw files: <id>-round<N>-<name>. */
  rawPrefix: (name: string) => string;
  vitestCmd: string;
  log: (msg: string) => void;
}

/** `AC*-*.patch` in glob order (code point), `ac` before the first `-`,
 *  `slug` after it; the classifier restores by checkout (a throwaway tree);
 *  NO_SELECTOR when neither .test nor .cmd sits beside the patch. */
export function runMutations(i: MutationsInput): MutRow[] {
  const mdir = join(i.evidenceDir, 'mutations');
  if (!isDir(mdir)) return [];
  const rows: MutRow[] = [];
  for (const n of readdirSync(mdir).filter((x) => /^AC[\s\S]*-[\s\S]*\.patch$/.test(x)).sort(byCodePoint)) {
    const patch = join(mdir, n);
    const name = n.slice(0, -'.patch'.length);
    const dash = name.indexOf('-');
    const ac = name.slice(0, dash);
    const slug = name.slice(dash + 1);
    const sel = findSelector(patch);
    let cls: string;
    if (sel !== undefined) {
      try {
        const r = classifyMutation({
          wt: i.wt, patch, kind: sel.kind, selectorFile: sel.file, rawPrefix: i.rawPrefix(name), restore: 'checkout', vitestCmd: i.vitestCmd,
        });
        cls = r.cls;
        writeResultFile(join(mdir, `${name}.result`), r.cls, r.mutJsonPath);
      } catch (e) {
        throw new RunnerError(`mutation runner: ${name} — the classifier failed (node ${process.version}); its message is above`, describe(e));
      }
    } else {
      cls = 'NO_SELECTOR';
      writeFileSync(join(mdir, `${name}.result`), `${cls}\n`);
    }
    rows.push({ ac, cls, slug });
    i.log(`mutation ${name}: ${cls}`);
  }
  return rows;
}

export interface ProbesInput {
  wt: string;
  evidenceDir: string;
  /** PROBE_DIR from .fleet/config: where the target's runner collects tests. */
  probeDir: string;
  rawPrefix: (name: string) => string;
  vitestCmd: string;
  log: (msg: string) => void;
  /** The selector runner; the classifier's unless a test injects one. */
  runSelector?: (i: RunSelectorInput) => RunClass;
}

/** `*.test.tsx` then `*.test.ts`, each in glob order; each copied to
 *  PROBE_DIR/fleet-probe-<name>, run through the selector runner with a .sel
 *  file naming that path, removed; the tree must be clean before and after;
 *  <name>.result is the class alone. */
export function runProbes(i: ProbesInput): ProbeRow[] {
  const pdir = join(i.evidenceDir, 'probes');
  if (!isDir(pdir)) return [];
  const all = readdirSync(pdir).filter((n) => !n.startsWith('.'));
  const names = [
    ...all.filter((n) => n.endsWith('.test.tsx')).sort(byCodePoint),
    ...all.filter((n) => n.endsWith('.test.ts')).sort(byCodePoint),
  ];
  const run = i.runSelector ?? classifierRunSelector;
  const rows: ProbeRow[] = [];
  for (const name of names) {
    if (!isDir(join(i.wt, i.probeDir))) {
      throw new RunnerError(`probe runner: PROBE_DIR ${i.probeDir} does not exist in the worktree — a probe copied there would silently never run`);
    }
    const dest = `${i.probeDir}/fleet-probe-${name}`;
    const raw = i.rawPrefix(`probe-${name}`);
    if (porcelain(i.wt) !== '') throw new RunnerError(`probe runner: tree dirty before ${name}`);
    copyFileSync(join(pdir, name), join(i.wt, dest));
    writeFileSync(`${raw}.sel`, `${dest}\n`);
    let cls: RunClass;
    try {
      cls = run({ wt: i.wt, kind: 'test', selectorFile: `${raw}.sel`, rawPrefix: raw, vitestCmd: i.vitestCmd });
    } catch (e) {
      throw new RunnerError(`probe runner: ${name} — the runner failed; its message is above`, describe(e));
    }
    rmSync(join(i.wt, dest), { force: true });
    if (porcelain(i.wt) !== '') throw new RunnerError(`probe runner: tree dirty after removing ${name}`);
    writeFileSync(join(pdir, `${name}.result`), `${cls}\n`);
    rows.push({ name, cls });
    i.log(`probe ${name}: ${cls}`);
  }
  return rows;
}
