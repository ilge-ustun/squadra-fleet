// The mutation classifier — what mutation.sh was (`git show
// 8fe954a:mutation.sh`; the file is gone since seam 4). One classifier for
// the verdict (ts/src/lib/evidence.ts, in-process) and for a builder
// checking its own evidence (check-mutation.sh), so the two can never
// disagree.
//
// A mutation is ACn-<slug>.patch with a .test (vitest selector) or .cmd (any
// command) beside it. In a clean tree:
//
//   pre-run, unmutated  → must be GREEN. NO_TESTS → SELECTOR_INVALID: the
//                         selector never named a test. RED → PRE_RED: the
//                         instrument was already red and proves nothing
//   git apply           → else PATCH_INVALID
//   run, mutated        → RED needs a REAL failure (.test: numFailedTests > 0;
//                         zero tests collected is NO_TESTS, never RED — L-08.
//                         .cmd: non-zero exit). GREEN = the mutation survived
//   restore             → the tree must be clean again, or nothing measured
//                         after can be trusted: DirtyTreeError, and the run stops
//
// Nothing here exits or prints; bin/mutation.ts does that.
import { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { apply, applyCheck, applyReverse, checkoutClean, porcelain } from './lib/git.ts';
import { runBashTo } from './lib/proc.ts';
import type { MutationClass, Restore, RunClass, SelectorKind } from './lib/types.ts';
import { classFromVitestJson, readVitestJson } from './lib/vitest-json.ts';

export class DirtyTreeError extends Error {
  readonly when: 'before' | 'after';
  readonly porcelain: string;
  constructor(when: 'before' | 'after', name: string, porcelainText: string) {
    super(
      when === 'before'
        ? `mutation runner: tree dirty before ${name}\n${porcelainText}`
        : `mutation runner: tree dirty after restoring ${name}\n${porcelainText}`,
    );
    this.name = 'DirtyTreeError';
    this.when = when;
    this.porcelain = porcelainText;
  }
}

export interface Selector {
  kind: SelectorKind;
  file: string;
}

/** The .test beside the patch, else the .cmd, else nothing (mutation.sh@8fe954a:45-50). */
export function findSelector(patch: string): Selector | undefined {
  const base = patch.replace(/\.patch$/, '');
  if (existsSync(`${base}.test`)) return { kind: 'test', file: `${base}.test` };
  if (existsSync(`${base}.cmd`)) return { kind: 'cmd', file: `${base}.cmd` };
  return undefined;
}

export interface RunSelectorInput {
  wt: string;
  kind: SelectorKind;
  selectorFile: string;
  /** Raw output lands at <rawPrefix>.json and <rawPrefix>.log. */
  rawPrefix: string;
  /** The target's VITEST_CMD; must accept `<selector> --reporter json --outputFile <f>`. */
  vitestCmd: string;
}

/** One run of a selector in the tree as it stands (mutation.sh@8fe954a:29-43).
 *  The first line of the selector file is the selector; it is handed to bash
 *  unquoted, by contract — a .cmd is a command, and a .test may carry
 *  `-t "a pattern with spaces"`. */
export function runSelector(i: RunSelectorInput): RunClass {
  const raw = `${i.rawPrefix}.json`;
  const log = `${i.rawPrefix}.log`;
  const line = readFileSync(i.selectorFile, 'utf8').split('\n')[0] ?? '';
  rmSync(raw, { force: true });
  switch (i.kind) {
    case 'test': {
      runBashTo(`${i.vitestCmd} ${line} --reporter json --outputFile '${raw}'`, { cwd: i.wt, logFile: log });
      return classFromVitestJson(readVitestJson(raw));
    }
    case 'cmd': {
      return runBashTo(line, { cwd: i.wt, logFile: log }) === 0 ? 'GREEN' : 'RED';
    }
  }
}

/** Two ways back to the committed tree, both safe only because the tree was
 *  asserted clean first (mutation.sh@8fe954a:52-61). */
export function restoreTree(wt: string, mode: Restore, patch: string): void {
  switch (mode) {
    case 'checkout':
      checkoutClean(wt);
      return;
    case 'reverse':
      if (applyReverse(wt, patch) !== 0) checkoutClean(wt);
      return;
  }
}

export interface ClassifyInput extends RunSelectorInput {
  patch: string;
  /** Raw files: <rawPrefix>-pre.*, <rawPrefix>-apply.log, <rawPrefix>-mut.*. */
  rawPrefix: string;
  restore: Restore;
}

export interface Classification {
  cls: Exclude<MutationClass, 'NO_SELECTOR'>;
  /** The mutated run's JSON, when there was one (a .test that got that far). */
  mutJsonPath?: string;
}

/** The classifier (mutation.sh@8fe954a:65-88). Throws DirtyTreeError; returns every class. */
export function classifyMutation(i: ClassifyInput): Classification {
  const name = basename(i.patch, '.patch');
  const dirtyBefore = porcelain(i.wt);
  if (dirtyBefore !== '') throw new DirtyTreeError('before', name, dirtyBefore);

  const pre = runSelector({ ...i, rawPrefix: `${i.rawPrefix}-pre` });
  if (pre === 'NO_TESTS') {
    // A path that does not exist, a -t pattern that matches no test, or a
    // shell command written into a .test file (014, round 1). Not the same
    // finding as an instrument that runs and fails, so not the same name.
    return { cls: 'SELECTOR_INVALID' };
  }
  if (pre !== 'GREEN') return { cls: 'PRE_RED' };

  const applyLog = `${i.rawPrefix}-apply.log`;
  const check = applyCheck(i.wt, i.patch);
  writeFileSync(applyLog, check.stderr);
  let applied = check.status === 0;
  if (applied) {
    const a = apply(i.wt, i.patch);
    appendFileSync(applyLog, a.stderr);
    applied = a.status === 0;
  }
  if (!applied) {
    restoreTree(i.wt, 'checkout', i.patch);
    return { cls: 'PATCH_INVALID' };
  }

  const mutPrefix = `${i.rawPrefix}-mut`;
  const cls = runSelector({ ...i, rawPrefix: mutPrefix });
  restoreTree(i.wt, i.restore, i.patch);
  const dirtyAfter = porcelain(i.wt);
  if (dirtyAfter !== '') throw new DirtyTreeError('after', name, dirtyAfter);
  return i.kind === 'test' && existsSync(`${mutPrefix}.json`)
    ? { cls, mutJsonPath: `${mutPrefix}.json` }
    : { cls };
}
