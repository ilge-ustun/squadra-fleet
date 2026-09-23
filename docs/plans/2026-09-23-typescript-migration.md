# Fleet: the migration to TypeScript — plan, and seam 1 as built

Decided by the human on 23 Sep 2026 (`FLEET-HANDOFF.md` §9): the harness
moves from bash to TypeScript, one seam at a time behind the existing
contract, never as a rewrite. This file is the plan for every seam and the
record of the first. Numbers in prose rot (L-11): `bash test-lib.sh` and
`cd ts && npm test` produce the current ones.

## Decisions that refine §9

| §9 said | decided (23 Sep, with the human) | why |
|---|---|---|
| `ts/` built by tsc to `dist/` | **no `dist/`**. Bash calls `node ts/src/bin/<name>.ts`; Node 24 strips types as it loads (`process.features.typescript === "strip"`, nothing on stderr). `tsc --noEmit` type-checks, vitest runs unit tests | no build step, no stale-`dist` failure mode |
| "`execa` at most" | **zero runtime dependencies**: `node:child_process`, `node:fs`. `typescript`, `vitest`, `@types/node` are devDependencies only | a call from a systemd timer or a builder's session must work whether or not `npm ci` was ever run. The fixture copy excludes `ts/node_modules`, so every suite run proves it |
| "tests scripts through `PATH`" | the suite runs scripts as `bash "$FLEET/<name>.sh"` by absolute path into a per-case copy; only the fakes come via PATH | bash entry points find `ts/` through `FLEET_HOME`; a same-name bash entry is transparent to every caller |

## Rules that hold from seam 1 on

Later seams run everything in one process, so these are set now:

- Modules throw typed errors; only `ts/src/bin/*.ts` turns them into
  messages and exit codes. No `process.exit` in a module.
- Output through `fs.writeSync(1|2, …)` and `process.exitCode`; a
  `console.log` before `process.exit` can be cut off.
- What a bash caller has loaded (`VITEST_CMD`, `REPO_ROOT`, …) travels as
  **argv**, not through the environment: `lib.sh` keeps a target's config
  out of the environment on purpose (`lib.sh:14-18`), and the runner the
  classifier starts must see the environment it saw from bash.
- `.fleet/config` is sourced bash. When TS needs it (seam 3), `lib/config.ts`
  shells out to `bash -c 'source lib.sh; load_repo "$1"; declare -p …'` and
  reads the values back; the contract is not narrowed to `KEY=value`.
- The subprocess helper is `runSync`; an async `run` with timeout and
  kill-after-grace arrives with seam 4 (`AGENT_TIMEOUT`).
- Anything larger than a few flags crosses from bash to TS on **stdin as
  JSON**, never argv (L-18, the 128 KB ceiling).
- Relative imports end in `.ts`; no `enum`, `namespace` or parameter
  properties (`erasableSyntaxOnly`). vitest compiles through esbuild, which
  accepts syntax Node's stripper rejects — `npm run check` and
  `bash test-lib.sh` (real `node`) are the proofs, `npm test` is not.
- Every TS module has vitest tests beside it, red first; every bash-facing
  change has a `test-lib.sh` case, red first (`FLEET_TS_OVERRIDE` lays a
  directory over `ts/src/` in the fixture for that).

## The seams, in order

1. **Classifier** — built, below.
2. **Verdict and the Machine block.** `computeVerdict({baseline, scope,
   acIds, mutRows, probeRows, reviewerVerdict}) → {model, computed, reasons}`
   and `renderMachineBlock(...)`, reproducing `launch.sh:693-745` byte for
   byte: the trailing `"; "` on every reason, the `%-4s %-13s %s` mutation
   table, `reviewer: codex` when `REVIEWER_MODEL` is empty. `launch.sh` sends
   its globals as JSON on stdin and pastes the block back. The unchecked
   `cls="$(run_selector …)"` at `launch.sh:260` gets its status check here
   (today an empty class would write an empty `.result` and veto nothing).
   The `.result` second line (`launch.sh:181-182`) moves into
   `lib/vitest-json.ts` using `mutJsonPath`. Pinned by cases 9, 24–26, 51,
   78, 103; read by `status.sh:148,151`, `run-queue.sh:134,138`,
   `telegram.sh:160`. Also fix `prompts/README.md:25-33`, which omits scope
   and probes from the rule. Old review files lack `reviewer:` (added in
   `5d94376`); a parser accepts it missing.
3. **`status.sh`.** `ts/src/bin/status.ts` behind a same-name bash wrapper:
   `lib/config.ts` (above), the frontmatter reader (`lib.sh:89-96`),
   `procs_in_worktree` (`lib.sh:122-130`), the git queries
   (`status.sh:63-121, 143-199`). `check-mutation.sh` becomes a five-line
   wrapper over a `check` verb in the same step, since both need
   `load_repo`. `merge.sh:92-96` is the only program that parses `--json`;
   cases 55, 56, 80, 90, 93, 96 and 100 pin the outputs. `--bot` uses the
   no-colour option already in `log.ts`.
4. **`launch.sh`**, last, with the agent calls on
   `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` — the first
   runtime dependencies. To settle then: the suite's fakes shadow `claude`
   and `codex` on PATH (L-14); both SDKs spawn those CLIs, so the fakes may
   still apply through the SDKs' executable-path options, else an injection
   seam is needed. Also where the story-selection lock and lanes go.

`telegram.sh`, `merge.sh`, `reset.sh`, `revert.sh`, `run-queue.sh` and the
systemd side stay bash indefinitely.

## Seam 1: the classifier, as built (branch `ts-classifier`, 23 Sep 2026)

```
.nvmrc                       v24.20.0 — what the units pin, what khaita pins
ts/package.json              private, type module; scripts check (tsc -p .) and test (vitest run); devDependencies only
ts/tsconfig.json             strict, nodenext, noEmit, allowImportingTsExtensions, erasableSyntaxOnly, verbatimModuleSyntax
ts/src/lib/types.ts          RunClass, MutationClass, SelectorKind, Restore — string unions
ts/src/lib/log.ts            lib.sh's ==> / !! / XX lines, writeSync, a colour switch, no exit
ts/src/lib/proc.ts           runSync (no shell), runBashTo (always bash — /bin/sh is dash; log truncated before the spawn)
ts/src/lib/git.ts            porcelain, apply --check, apply, apply -R, checkout + clean -e .review-out
ts/src/lib/vitest-json.ts    THE decision: a runner's JSON → RED | GREEN | NO_TESTS. One place; the adapter seam for a non-vitest runner
ts/src/classifier.ts         findSelector, runSelector, restoreTree, classifyMutation → {cls, mutJsonPath?}; throws DirtyTreeError
ts/src/bin/mutation.ts       verbs run-selector and classify, one line of stdout each
mutation.sh                  the shim: porcelain and find_selector in bash; run_selector and classify_mutation call the bin
```

`launch.sh` and `check-mutation.sh` were not edited: both source
`mutation.sh`, so both reach the TypeScript classifier through it. Case 106
proves it — a stub `vitest-json.ts` that answers GREEN makes the verdict and
`check-mutation.sh` both say GREEN, and was red against the bash classifier.

What changed in substance, and what did not:

- The die-in-subshell hazard (`FLEET-HANDOFF.md` §7) is gone for
  `classify_mutation`: the classifier's failure is an exit status checked in
  the parent shell, its message already on stderr, and the class is
  validated against the vocabulary before it can reach a table.
- `run_probes`' `cls="$(run_selector …)"` (`launch.sh:260`) is still
  unchecked — a known gap, closed at seam 2 when `launch.sh` is edited.
- Parity, not improvement, in the decision: an empty, unparseable or
  countless JSON file falls through to GREEN as it did under `jq -e`; the
  runner's exit code is ignored for `.test`; only the first selector line is
  used; the selector line is handed to bash unquoted, by contract. Each is
  pinned by a unit test so a later change is a decision, not an accident.
- `mutation.sh`'s `restore_tree` had no caller outside the file and is not
  exposed by the shim.
- `check-mutation.sh:40` still checks for `jq`, which it no longer needs;
  it goes with the seam-3 wrapper.

Verified before the branch was offered for landing: `bash test-lib.sh`
green with the new cases 105 and 106; wall time 2m13s → 2m28s on the 2-CPU
VPS — one `node` start (~60 ms) per classify or probe call, some two
hundred per run, the price of a process boundary that goes away when
`launch.sh` is TypeScript;
`cd ts && npm run check && npm test` clean and green; the classifier cases
green under the queue unit's exact `PATH` (`env -i PATH=<systemd line>`)
and with `ts/node_modules` moved away; every module loads under bare
`node`. The real vitest JSON shape is exercised by no test — the suite's
fake writes it — so it was checked live, 23 Sep, on khaita `develop`
(`227b781`): `check-mutation.sh khaita` from the branch on story 019's
committed `AC1-fixed-source` and `AC1-missing-push` patches said `RED` for
both, 4 tests collected and 1 failed, the same counts the bash verdict
recorded in `.review/019/round-2`; the tree was clean afterwards; 8 s.

The live checkout needs no `npm ci`, ever: `ts/node_modules` serves tsc and
vitest in a development worktree and nothing else.
