// The round's evidence runs: the mutations and the probes. The reviewer
// proposes them as files under round-N/; the harness runs them in the
// reviewer's clean worktree, through the same classifier a builder's
// `fleet check-mutation` uses, and writes a .result beside each. A failure
// of the machinery — a dirty tree, a runner that could not start — is a
// RunnerError the launcher turns into two XX lines: the classifier's
// message, then its own.
//
// The same runner is the tdd check (L-42): right after a green baseline the
// launcher runs the builder's tdd- pairs alone, records what each came to,
// and the round's mutation phase takes those classes for every pair whose
// head, patch and selector are unchanged instead of running it a second time.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classifyMutation, findSelector, runSelector as classifierRunSelector, type RunSelectorInput, type Selector } from '../classifier.ts';
import { porcelain, revParse } from './git.ts';
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

/** What a mutation's class stands on, and the class. */
export interface KnownRun {
  digest: string;
  cls: string;
}

/** The run, exactly: the HEAD the clean tree is at, the patch's bytes, and
 *  the selector's kind and bytes. Two runs with one digest are the same run. */
export function mutationDigest(head: string, patch: string, sel: Selector | undefined): string {
  const h = createHash('sha256');
  h.update(`${head}\0`);
  h.update(readFileSync(patch));
  h.update('\0');
  if (sel !== undefined) {
    h.update(`${sel.kind}\0`);
    h.update(readFileSync(sel.file));
  }
  return h.digest('hex');
}

export interface MutationsInput {
  wt: string;
  evidenceDir: string;
  /** The .runs prefix for a mutation's raw files: <id>-round<N>-<name>. */
  rawPrefix: (name: string) => string;
  vitestCmd: string;
  /** CARGO_CMD, when the target's RUNNERS list cargo. */
  cargoCmd?: string;
  log: (msg: string) => void;
  /** Runs already made, by name — the tdd check's. A patch whose digest is
   *  the one recorded keeps its class and is not run again. */
  known?: ReadonlyMap<string, KnownRun>;
  /** Filled with every patch this call classifies, by name. */
  record?: Map<string, KnownRun>;
  /** GREEN pre-runs to share with another call at the same HEAD (L-39);
   *  a map of its own when absent. */
  preRuns?: Map<string, string>;
}

/** `AC*-*.patch` in glob order (code point), `ac` before the first `-`,
 *  `slug` after it; the classifier restores by checkout (a throwaway tree);
 *  NO_SELECTOR when neither .test nor .cmd sits beside the patch. */
export function runMutations(i: MutationsInput): MutRow[] {
  const mdir = join(i.evidenceDir, 'mutations');
  if (!isDir(mdir)) return [];
  const rows: MutRow[] = [];
  // One map for the round: the tree is the same clean HEAD before every
  // patch, so a GREEN pre-run of a selector stands for the next patch that
  // names it (L-39).
  const preRuns = i.preRuns ?? new Map<string, string>();
  const head = i.known !== undefined || i.record !== undefined ? revParse(i.wt, 'HEAD') : '';
  for (const n of readdirSync(mdir).filter((x) => /^AC[\s\S]*-[\s\S]*\.patch$/.test(x)).sort(byCodePoint)) {
    const patch = join(mdir, n);
    const name = n.slice(0, -'.patch'.length);
    const dash = name.indexOf('-');
    const ac = name.slice(0, dash);
    const slug = name.slice(dash + 1);
    const sel = findSelector(patch);
    const digest = head === '' ? '' : mutationDigest(head, patch, sel);
    const seen = i.known?.get(name);
    if (seen !== undefined && seen.digest === digest) {
      if (!existsSync(join(mdir, `${name}.result`))) writeFileSync(join(mdir, `${name}.result`), `${seen.cls}\n`);
      i.record?.set(name, seen);
      rows.push({ ac, cls: seen.cls, slug });
      i.log(`mutation ${name}: ${seen.cls} (run by the tdd check at this head)`);
      continue;
    }
    let cls: string;
    if (sel !== undefined) {
      try {
        const r = classifyMutation({
          wt: i.wt, patch, kind: sel.kind, selectorFile: sel.file, rawPrefix: i.rawPrefix(name), restore: 'checkout', vitestCmd: i.vitestCmd, preRuns,
          ...(i.cargoCmd !== undefined ? { cargoCmd: i.cargoCmd } : {}),
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
    i.record?.set(name, { digest, cls });
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
  /** CARGO_CMD and CARGO_PROBE_DIR, both present when the target's RUNNERS
   *  list cargo: a reviewer's *.rs probe then runs as a test target there. */
  cargoCmd?: string;
  cargoProbeDir?: string;
  log: (msg: string) => void;
  /** The selector runner; the classifier's unless a test injects one. */
  runSelector?: (i: RunSelectorInput) => RunClass;
}

/** The package a CARGO_PROBE_DIR's tests belong to: `name` under
 *  `[package]` in the Cargo.toml beside it. */
export function probePackage(wt: string, cargoProbeDir: string): string {
  const toml = `${dirname(cargoProbeDir)}/Cargo.toml`;
  const text = existsSync(join(wt, toml)) ? readFileSync(join(wt, toml), 'utf8') : '';
  const m = /^\[package\][^[]*?^name\s*=\s*"([A-Za-z0-9_-]+)"/m.exec(text);
  if (m?.[1] === undefined) {
    throw new RunnerError(`probe runner: no [package] name in ${toml} — CARGO_PROBE_DIR ${cargoProbeDir} must be a package's tests directory`);
  }
  return m[1];
}

/** `*.test.tsx` then `*.test.ts`, each in glob order, then — when the target
 *  lists cargo — `*.rs`; a vitest probe is copied to
 *  PROBE_DIR/fleet-probe-<name>, a Rust one to CARGO_PROBE_DIR/fleet_probe_<stem>.rs,
 *  its own integration-test target, and the .sel names that path or
 *  `cargo:<package>/fleet_probe_<stem>`; each is run through the selector
 *  runner and removed; the tree must be clean before and after;
 *  <name>.result is the class alone. */
export function runProbes(i: ProbesInput): ProbeRow[] {
  const pdir = join(i.evidenceDir, 'probes');
  if (!isDir(pdir)) return [];
  const all = readdirSync(pdir).filter((n) => !n.startsWith('.'));
  const rust = i.cargoCmd !== undefined && i.cargoProbeDir !== undefined;
  const names = [
    ...all.filter((n) => n.endsWith('.test.tsx')).sort(byCodePoint),
    ...all.filter((n) => n.endsWith('.test.ts')).sort(byCodePoint),
    ...(rust ? all.filter((n) => n.endsWith('.rs')).sort(byCodePoint) : []),
  ];
  const run = i.runSelector ?? classifierRunSelector;
  const rows: ProbeRow[] = [];
  for (const name of names) {
    let dest: string;
    let selector: string;
    if (name.endsWith('.rs')) {
      const dir = i.cargoProbeDir ?? '';
      if (!isDir(join(i.wt, dir))) {
        throw new RunnerError(`probe runner: CARGO_PROBE_DIR ${dir} does not exist in the worktree — a probe copied there would silently never run`);
      }
      const target = `fleet_probe_${name.slice(0, -'.rs'.length).replace(/[^A-Za-z0-9_]/g, '_')}`;
      dest = `${dir}/${target}.rs`;
      selector = `cargo:${probePackage(i.wt, dir)}/${target}`;
    } else {
      if (!isDir(join(i.wt, i.probeDir))) {
        throw new RunnerError(`probe runner: PROBE_DIR ${i.probeDir} does not exist in the worktree — a probe copied there would silently never run`);
      }
      dest = `${i.probeDir}/fleet-probe-${name}`;
      selector = dest;
    }
    const raw = i.rawPrefix(`probe-${name}`);
    if (porcelain(i.wt) !== '') throw new RunnerError(`probe runner: tree dirty before ${name}`);
    copyFileSync(join(pdir, name), join(i.wt, dest));
    writeFileSync(`${raw}.sel`, `${selector}\n`);
    let cls: RunClass;
    try {
      cls = run({
        wt: i.wt, kind: 'test', selectorFile: `${raw}.sel`, rawPrefix: raw, vitestCmd: i.vitestCmd,
        ...(i.cargoCmd !== undefined ? { cargoCmd: i.cargoCmd } : {}),
      });
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
