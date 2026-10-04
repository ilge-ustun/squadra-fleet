// The mutation classifier. One classifier for the verdict
// (ts/src/lib/evidence.ts, in-process) and for a builder checking its own
// evidence (`fleet check-mutation`), so the two can never disagree.
//
// A mutation is ACn-<slug>.patch with a .test (vitest selector) or .cmd (any
// command) beside it. In a clean tree:
//
//   git apply --check   → else PATCH_INVALID, before anything is run
//   pre-run, unmutated  → must be GREEN. NO_TESTS → SELECTOR_INVALID: the
//                         selector never named a test. RED → PRE_RED: the
//                         instrument was already red and proves nothing.
//                         With a preRuns cache (the round's runner), a GREEN
//                         pre-run of the same selector at the same HEAD
//                         stands for this one (L-39); a red one never does
//   git apply           → else PATCH_INVALID
//   run, mutated        → RED needs a REAL failure (.test: numFailedTests > 0;
//                         zero tests collected is NO_TESTS, never RED — L-08.
//                         .cmd: non-zero exit). GREEN = the mutation survived
//   restore             → the tree must be clean again, or nothing measured
//                         after can be trusted: DirtyTreeError, and the run stops
//
// Nothing here exits or prints; bin/mutation.ts does that.
import { appendFileSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { apply, applyCheck, applyReverse, checkoutClean, porcelain, revParse } from './lib/git.ts';
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

/** The .test beside the patch, else the .cmd, else nothing. */
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

/** One run of a selector in the tree as it stands. The first line of the
 *  selector file is the selector; it is handed to bash unquoted, by
 *  contract — a .cmd is a command, and a .test may carry
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
 *  asserted clean first. */
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
  /** GREEN pre-runs already made, keyed by preRunKey, valued by the raw
   *  prefix of the run that made it. The round's runner passes one map for
   *  all its patches; without it every patch runs its own. */
  preRuns?: Map<string, string>;
}

/** HEAD, the selector's kind and its first line — the run, exactly. The tree
 *  is asserted clean before every patch, so HEAD names its content. */
export function preRunKey(head: string, kind: SelectorKind, line: string): string {
  return `${head}\0${kind}\0${line}`;
}

export interface Classification {
  cls: Exclude<MutationClass, 'NO_SELECTOR'>;
  /** The mutated run's JSON, when there was one (a .test that got that far). */
  mutJsonPath?: string;
}

/** The classifier. Throws DirtyTreeError; returns every class. */
export function classifyMutation(i: ClassifyInput): Classification {
  const name = basename(i.patch, '.patch');
  const dirtyBefore = porcelain(i.wt);
  if (dirtyBefore !== '') throw new DirtyTreeError('before', name, dirtyBefore);

  // A patch that cannot apply is known without running anything; --check
  // changes nothing, so there is nothing to restore.
  const applyLog = `${i.rawPrefix}-apply.log`;
  const check = applyCheck(i.wt, i.patch);
  if (check.status !== 0) {
    writeFileSync(applyLog, check.stderr);
    return { cls: 'PATCH_INVALID' };
  }

  const prePrefix = `${i.rawPrefix}-pre`;
  const line = readFileSync(i.selectorFile, 'utf8').split('\n')[0] ?? '';
  const key = i.preRuns === undefined ? '' : preRunKey(revParse(i.wt, 'HEAD'), i.kind, line);
  const seen = i.preRuns?.get(key);
  let pre: RunClass;
  if (seen !== undefined) {
    writeFileSync(`${prePrefix}.log`, `pre: same selector and HEAD as ${basename(seen)}, GREEN — not run again (L-39)\n`);
    if (existsSync(`${seen}.json`)) copyFileSync(`${seen}.json`, `${prePrefix}.json`);
    pre = 'GREEN';
  } else {
    pre = runSelector({ ...i, rawPrefix: prePrefix });
    if (pre === 'GREEN') i.preRuns?.set(key, prePrefix);
  }
  if (pre === 'NO_TESTS') {
    // A path that does not exist, a -t pattern that matches no test, or a
    // shell command written into a .test file (014, round 1). Not the same
    // finding as an instrument that runs and fails, so not the same name.
    return { cls: 'SELECTOR_INVALID' };
  }
  if (pre !== 'GREEN') return { cls: 'PRE_RED' };

  writeFileSync(applyLog, check.stderr);
  const a = apply(i.wt, i.patch);
  appendFileSync(applyLog, a.stderr);
  if (a.status !== 0) {
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
