import { describe, expect, it } from 'vitest';
import { cargoArgs, classFromLibtest, parseCargoSelector } from './libtest.ts';

// Real output, cargo 1.99.1 on stable, captured 22 Oct 2026 from a scratch
// crate: stdout and stderr in one log, as runBashTo writes it. Cargo's own
// lines ("     Running tests/scan.rs (…)") go to stderr; libtest's to stdout.
const OK = `    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 0.00s
     Running tests/scan.rs (target/debug/deps/scan-6f758dc353c7dffe)

running 1 test
test sweeps ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s

`;

const QUIET_OK = `
running 1 test
.
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s

`;

const FAILED = `
running 1 test
test breaks ... FAILED

failures:

---- breaks stdout ----

thread 'breaks' (1711663) panicked at tests/scan.rs:4:15:
assertion \`left == right\` failed: one and one
  left: 2
 right: 3
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace


failures:
    breaks

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s

error: test failed, to rerun pass \`-p demo --test scan\`
`;

// One name, three binaries: the lib's unit tests match nothing, two
// integration targets each run their own \`sweeps\`.
const MULTI = `
running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.00s


running 1 test
test sweeps ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s


running 1 test
test sweeps ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s

`;

const NOMATCH = `
running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.00s


running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s

`;

const IGNORED = `
running 1 test
test tests::slow ... ignored

test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 1 filtered out; finished in 0.00s

`;

const COMPILE_ERROR = `   Compiling demo v0.1.0 (/tmp/demo)
error: this file contains an unclosed delimiter
 --> tests/scan.rs:5:14
  |
5 | fn broken( {
  |          - -^
  |          | |
  |          | unclosed delimiter
  |          unclosed delimiter

error: could not compile \`demo\` (test "scan") due to 1 previous error
`;

const NO_TARGET = `error: no test target named \`nosuch\` in \`demo\` package

help: available test targets:
    other
    scan
`;

// std::process::abort() in the test: the binary started and never reported.
const ABORTED = `
running 1 test
error: test failed, to rerun pass \`-p demo --test abort\`

Caused by:
  process didn't exit successfully: \`target/debug/deps/abort-2d3bea3f4f65d81f aborts --exact\` (signal: 6, SIGABRT: process abort signal)
`;

describe('classFromLibtest — the one place cargo test output becomes a class', () => {
  it('a passing test is GREEN, in the verbose and the quiet format', () => {
    expect(classFromLibtest(OK, 0)).toBe('GREEN');
    expect(classFromLibtest(QUIET_OK, 0)).toBe('GREEN');
  });

  it('a failing test is RED', () => {
    expect(classFromLibtest(FAILED, 101)).toBe('RED');
  });

  it('the counts are summed over every test binary', () => {
    expect(classFromLibtest(MULTI, 0)).toBe('GREEN');
    expect(classFromLibtest(MULTI.replace('test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered', 'test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered'), 101)).toBe('RED');
  });

  it('a selector that matched no test is NO_TESTS, never GREEN (L-08)', () => {
    expect(classFromLibtest(NOMATCH, 0)).toBe('NO_TESTS');
  });

  it('a test that only ran ignored is NO_TESTS: nothing asserted', () => {
    expect(classFromLibtest(IGNORED, 0)).toBe('NO_TESTS');
  });

  it('a compile error, an unknown target or empty output is NO_TESTS, never RED', () => {
    expect(classFromLibtest(COMPILE_ERROR, 101)).toBe('NO_TESTS');
    expect(classFromLibtest(NO_TARGET, 101)).toBe('NO_TESTS');
    expect(classFromLibtest('', 101)).toBe('NO_TESTS');
    expect(classFromLibtest('', 0)).toBe('NO_TESTS');
  });

  it('a test binary that started and died without a result is RED: the test failed', () => {
    expect(classFromLibtest(ABORTED, 101)).toBe('RED');
  });

  it('a non-zero exit after every binary reported ok is NO_TESTS, not a failure nobody can name', () => {
    expect(classFromLibtest(OK, 101)).toBe('NO_TESTS');
  });

  it('a line a test printed is not mistaken for a result unless it starts the line', () => {
    expect(classFromLibtest(`${OK}  test result: FAILED. 0 passed; 1 failed; 0 ignored;\n`, 0)).toBe('GREEN');
  });
});

describe('parseCargoSelector — cargo:<package>[/<target>][::<test path>]', () => {
  it('a package, an integration target and a test', () => {
    expect(parseCargoSelector('cargo:qr-core/scan::stale_screenshot_is_swept')).toEqual({
      pkg: 'qr-core', target: 'scan', path: 'stale_screenshot_is_swept',
    });
  });

  it('a unit test in the library: /lib, and a path with modules', () => {
    expect(parseCargoSelector('cargo:qr-core/lib::decode::tests::finds_two')).toEqual({
      pkg: 'qr-core', target: 'lib', path: 'decode::tests::finds_two',
    });
  });

  it('a package alone, or a package and a target alone', () => {
    expect(parseCargoSelector('cargo:qr-core')).toEqual({ pkg: 'qr-core' });
    expect(parseCargoSelector('cargo:qr-core/scan')).toEqual({ pkg: 'qr-core', target: 'scan' });
    expect(parseCargoSelector('cargo:qr-core::wifi::tests::x')).toEqual({ pkg: 'qr-core', path: 'wifi::tests::x' });
  });

  it('trailing whitespace is dropped', () => {
    expect(parseCargoSelector('cargo:qr-core/scan::x  ')).toEqual({ pkg: 'qr-core', target: 'scan', path: 'x' });
  });

  it('anything a shell could read twice is refused', () => {
    for (const bad of [
      'cargo:qr-core/scan::x; rm -rf ~', 'cargo:qr-core/scan::x && true', 'cargo:qr core', 'cargo:qr-core/scan::$(id)',
      'cargo:', 'cargo:/scan::x', 'cargo:qr-core/::x', 'cargo:qr-core/scan::', 'cargo:qr-core/scan::a::', 'cargo:qr-core/scan::x -- --ignored',
      'qr-core/scan::x', 'cargo:qr-core/scan::x\'',
    ]) expect(parseCargoSelector(bad), bad).toBeUndefined();
  });
});

describe('cargoArgs — the arguments appended to CARGO_CMD', () => {
  it('an exact test in a target', () => {
    expect(cargoArgs({ pkg: 'qr-core', target: 'scan', path: 'x' })).toBe('-p qr-core --test scan x -- --exact');
  });
  it('the library target is --lib', () => {
    expect(cargoArgs({ pkg: 'qr-core', target: 'lib', path: 'a::b' })).toBe('-p qr-core --lib a::b -- --exact');
  });
  it('no path runs the whole target, or the whole package', () => {
    expect(cargoArgs({ pkg: 'qr-core', target: 'scan' })).toBe('-p qr-core --test scan');
    expect(cargoArgs({ pkg: 'qr-core' })).toBe('-p qr-core');
  });
});
