// The one place `cargo test` output becomes RED, GREEN or NO_TESTS — the
// cargo runner's counterpart of vitest-json.ts, and the same contract: every
// classification of a `cargo:` selector, the verdict's and a builder's own
// `fleet check-mutation`, passes through here.
//
// libtest's JSON output is nightly-only, so this reads its plain output on
// stable. One `cargo test` runs one binary per target (the lib's unit tests,
// each tests/*.rs, the doc tests), and each binary prints
//
//   running N tests
//   test <name> ... ok | FAILED | ignored     (a `.` per test under -q)
//   test result: ok|FAILED. P passed; F failed; I ignored; …
//
// on stdout, at the start of a line. The counts are summed over the binaries.
// The per-test lines are not read: -q replaces them with dots.
//
//   no `running` line            NO_TESTS — nothing ran: a compile error, an
//                                unknown package or target (L-08: never RED)
//   F > 0                        RED
//   a binary that started and    RED — the test process died (an abort, a
//   never printed its result,    signal) while a selected test ran
//   with a non-zero exit
//   P = 0                        NO_TESTS — the selector matched no test, or
//                                only ignored ones: nothing was asserted
//   a non-zero exit otherwise    NO_TESTS — every binary reported ok and
//                                cargo still failed; no test can be named
//   else                         GREEN
import type { RunClass } from './types.ts';

const RUNNING = /^running (\d+) tests?$/gm;
const RESULT = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm;

export function classFromLibtest(log: string, status: number): RunClass {
  const started = [...log.matchAll(RUNNING)].length;
  if (started === 0) return 'NO_TESTS';
  let passed = 0;
  let failed = 0;
  let reported = 0;
  for (const m of log.matchAll(RESULT)) {
    reported += 1;
    passed += Number(m[1]);
    failed += Number(m[2]);
  }
  if (failed > 0) return 'RED';
  if (status !== 0 && reported < started) return 'RED';
  if (passed === 0) return 'NO_TESTS';
  if (status !== 0) return 'NO_TESTS';
  return 'GREEN';
}

/** A `cargo:` selector, parsed. `target` is an integration-test target (a
 *  tests/<name>.rs) or `lib` for the library's unit tests; absent, every
 *  target of the package. `path` is a test's full libtest name; absent,
 *  every test in what was named. */
export interface CargoSelector {
  pkg: string;
  target?: string;
  path?: string;
}

// The whole line, nothing a shell could read twice: a package and a target
// are cargo names, a path is `::`-joined identifiers.
const SELECTOR = /^cargo:([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?(?:::([A-Za-z0-9_]+(?:::[A-Za-z0-9_]+)*))?$/;

/** The selector, or undefined when the line is not one — which the
 *  classifier reports as SELECTOR_INVALID, like a vitest path that names no
 *  test. */
export function parseCargoSelector(line: string): CargoSelector | undefined {
  const m = SELECTOR.exec(line.replace(/\s+$/, ''));
  if (m === null) return undefined;
  const [, pkg, target, path] = m;
  if (pkg === undefined) return undefined;
  return { pkg, ...(target !== undefined ? { target } : {}), ...(path !== undefined ? { path } : {}) };
}

/** What follows CARGO_CMD: `-p <pkg> [--test <t> | --lib] [<path> -- --exact]`. */
export function cargoArgs(s: CargoSelector): string {
  const parts = ['-p', s.pkg];
  if (s.target === 'lib') parts.push('--lib');
  else if (s.target !== undefined) parts.push('--test', s.target);
  if (s.path !== undefined) parts.push(s.path, '--', '--exact');
  return parts.join(' ');
}
