// What the prompts say about a target's runners. A target whose RUNNERS do
// not list cargo gets no words here, so its prompts are what they were
// before cargo existed, byte for byte. A cargo target's builder and reviewer
// learn the `cargo:` selector form (rules.md, review.md), its reviewer the
// Rust probe (review.md), and its story writer that a Rust test can be an
// instrument (write-story.md). The indentation follows each file's own.
import type { RenderVars } from './render.ts';

export interface RunnerFacts {
  /** CARGO_CMD, present exactly when the target lists cargo. */
  cargoCmd?: string;
  cargoProbeDir?: string;
}

export function runnerVars(file: string, f: RunnerFacts): RenderVars {
  if (f.cargoCmd === undefined) return {};
  const dir = f.cargoProbeDir ?? '';
  switch (file) {
    case 'rules.md': {
      const i = ' '.repeat(27);
      return {
        CARGO_SELECTOR: [
          '',
          `${i}or, for a Rust test (this repo's RUNNERS list cargo), a`,
          `${i}cargo: selector, cargo:<package>[/<target>][::<test path>],`,
          `${i}e.g.  cargo:my-crate/scan::stale_file_is_removed`,
          `${i}<target> is a tests/<target>.rs file, or lib for the unit`,
          `${i}tests in src/. The harness runs it as`,
          `${i}  ${f.cargoCmd} -p <package> --test <target> <test path> -- --exact`,
        ].join('\n'),
      };
    }
    case 'review.md': {
      const i = ' '.repeat(21);
      return {
        CARGO_SELECTOR: [
          '',
          `${i}or, for a Rust test (this repo's RUNNERS list cargo), a`,
          `${i}cargo: selector, cargo:<package>[/<target>][::<test path>],`,
          `${i}where <target> is a tests/<target>.rs file, or lib for the`,
          `${i}unit tests in src/, e.g.`,
          `${i}  cargo:my-crate/scan::stale_file_is_removed`,
        ].join('\n'),
        CARGO_PROBE: `, or a Rust integration test to\n.review-out/probes/<name>.rs, which the harness runs as its own test\ntarget in ${dir}`,
      };
    }
    case 'write-story.md':
      return {
        CARGO_INSTRUMENT: ` In this repo an instrument can be a\nvitest test or a Rust test that \`cargo test\` runs (its RUNNERS list\ncargo): a criterion about Rust code names a test in its crate.`,
      };
    default:
      return {};
  }
}
