# Fleet: the migration to TypeScript — plan, and seams 1–4 as built

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
- `.fleet/config` is sourced bash. `lib/config.ts` (seam 3) runs
  `load_repo` in a child bash that sources the same `lib.sh` and prints the
  keys as NUL-separated pairs; the contract is not narrowed to `KEY=value`,
  lib.sh's `die` text reaches the caller from that bash's inherited stderr,
  and a caller's environment still wins over the file.
- The subprocess helper is `runSync`; the agent calls use the async `run`
  (`lib/proc.ts`, seam 4): the child leads its own process group, SIGTERM
  at `AGENT_TIMEOUT`, SIGKILL 30 s later, the whole group — `timeout -k`'s
  semantics, so nothing outlives the call in the worktree.
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
2. **Verdict and the Machine block** — built, below.
3. **`status.sh` and `check-mutation.sh`** — built, below.
4. **`launch.sh`** — built, below. The agent calls stay on the `claude` and
   `codex` CLIs, not the SDKs (the plan had said the SDKs; the decision and
   its reasons are in the record). Lanes and a story-selection lock are
   features, not migration, and were left where they were.

The plan first said "`telegram.sh`, `merge.sh`, `reset.sh`, `revert.sh`,
`run-queue.sh` and the systemd side stay bash indefinitely". **Reversed by
the human on 24 Sep 2026**, after the first real stories ran on the
TypeScript fleet: the migration continues, in this order.

5. **`merge.sh`, then `revert.sh` and `reset.sh`** — landing, where
   correctness matters most. `status.ts` in-process instead of
   `status.sh --json | jq`, `baselineColour` for the post-merge baseline,
   `git.ts`, `procs.ts`, `frontmatter.ts`. No fleet lock inside the three
   (the bash never took one; the bot holds it around them).
6. **`run-queue.sh`** — one `nextReady`, shared with the launcher, which
   settles the `TEMPLATE.md` disagreement. The process boundary between the
   queue and a story's launcher stays: it isolates memory and a die.
7. **Story authoring**: `lint-story.sh`, `write-story.sh`, `new-epic.sh`.
   `render.sh` retires with `write-story.sh`, its last user. The citation
   checks against a story's base are the delicate part.
8. **`telegram.sh`** — the hard part is testing: the bot's `curl` is faked
   on PATH, Node's `fetch` bypasses PATH, so the suite needs a new seam (an
   API base URL pointing at a local fake server) before anything moves.
   `flock` becomes `lock.ts`.

Small ones any time: `install-skills.sh`, `update-agents.sh`, the wrappers.

Stays bash: `lib.sh`'s `load_repo` as the `.fleet/config` contract (a
target's config is sourced bash; `config.ts` reads it through a child
bash), `test-lib.sh` as the acceptance layer, and the systemd units.

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
- `check-mutation.sh:40` still checked for `jq`, which it no longer needed;
  it went with the seam-3 wrapper.

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

## Seam 2: the verdict and the round section, as built (branch `ts-classifier`, 23 Sep 2026)

```
ts/src/lib/verdict.ts          computeVerdict: the reviewer's line parsed per newline-delimited line, the reasons in
                               bash's order, PASS→FAIL the only change the machine makes. Alone in its file: case 108
                               replaces it and requires the launcher to answer what the stub says
ts/src/lib/machine-block.ts    renderRoundSection, byte for byte; the row parsers; the labels and separators a reader
                               will split on; formatIsoSeconds (= date -Iseconds)
ts/src/bin/verdict.ts          stdin JSON (the round's values, as strings) → --append the section, one tab-separated line back
ts/src/lib/result-summary.ts   the .result file's second line, jq -c parity decided row by row
ts/fixtures/verdict/           gen.sh — the retired bash block and heredoc verbatim — and five goldens it wrote
launch.sh                      the verdict block is one jq -n | node call; run_mutations hands the .result to the
                               classifier; run_probes checks run_selector's status
```

What changed in substance:

- **A crashed probe runner no longer passes a story.** `run_probes` took
  `$(run_selector …)` without its status; an empty class vetoed nothing and
  the story went to `done`. Now it dies (case 107). This was the last
  die-in-subshell hazard named in the handoff's §7.
- The `.result` file is written by the classifier, and the stale `-mut.json`
  line a resumed round could append after a PRE_RED is gone with it.
- The rule and the text are typed and tested in one place. Seam 3's reader of
  `.review/<id>.md` splits on the constants the writer exports.

Deliberate non-parities, each pinned by a unit test: a CR or U+2028 inside
the reviewer's text is not a line break (a JS multiline regex would have made
it one; grep's `^…$` did not); U+3000 after `VERDICT: PASS` is UNPARSEABLE
(glibc's `[[:space:]]` may admit it, JS's blank class does not); a mutation
slug with whitespace shows its first word in the table and the whole in the
reason, as awk's `$3` and `read -r` did; DEL in a failed test's name is
escaped `\u007f` in the `.result` line as jq escaped it.

Verified: `bash test-lib.sh` green with cases 107 and 108; 88 unit tests and
tsc clean; the goldens matched the bash heredoc on the first run; fifteen
cases run under the previous `launch.sh` and under the new one produced
nineteen byte-identical review files once `reviewed:`, `timing:` and the
per-run `base:`/`head:` SHAs are masked; the veto cases green with
`ts/node_modules` moved away; wall time 2m28s → 2m39s, one more `node` start per round. `jq` calls: one removed (the `.result`
summary), one added (the round's JSON); the count is unchanged.

## Seam 3: `status.sh` and `check-mutation.sh`, as built (branch `ts-classifier`, 23 Sep 2026)

```
ts/src/lib/config.ts           loadRepo: load_repo in a child bash, NUL pairs back, stderr inherited; ConfigError.alreadyReported
ts/src/lib/frontmatter.ts      frontmatter_field / story_field record by record; `records()` = awk's line rule
ts/src/lib/procs.ts            procs_in_worktree by /proc/<pid>/cwd
ts/src/lib/review.ts           the reader of .review/<id>.md: verdict, the last computed line's reasons, the last Machine block
ts/src/lib/git.ts              += refExists, branchExists, isAncestor, revListCount
ts/src/status.ts               the walk: order, title, review, worktree, git, landingOf; liveness injected
ts/src/status-views.ts         the table, the epic block, the phone form, the JSON — from one Status
ts/src/bin/status.ts           <repo> [--json|--epics|--bot] [--all] [id]; load_repo before the flags, as the bash did
ts/src/bin/mutation.ts         += check <repo> <patch…> [--wt <dir>] — check-mutation.sh line for line
ts/fixtures/status/            make-target.sh (one deterministic target, every landing state), gen.sh (runs
                               git show 14f675e:status.sh — the last bash — under C.UTF-8), ten goldens
status.sh, check-mutation.sh   wrappers: source lib.sh, require node, exec the bin
```

What changed in substance:

- **The first entry points that run entirely in Node.** Every caller
  (`merge.sh --json`, `telegram.sh --bot`, `run-queue.sh`'s closing table,
  the builder's rules) keeps its command line; nothing downstream moved.
- **One config loader.** `lib/config.ts` does not parse `.fleet/config`; it
  asks bash. Cases 109 and 110 replace it with a stub that throws and require
  both entry points to fail with the stub's text — red under bash, which
  never loaded it.
- **The writer and the reader of `.review/<id>.md` share one vocabulary**:
  `lib/review.ts` splits on the constants `lib/machine-block.ts` exports.
- **A flag bug the goldens had not caught**, found by the old-vs-new parity
  script: `--json`, `--epics` and `--bot` are independent flags with a
  precedence in the bash (`--epics`, then `--json`, then `--bot`, which also
  shapes the epic block); the first TS kept only the last one. Three goldens
  pin the combinations now.
- **A bash quirk, reproduced rather than fixed**: `width_of` counts
  characters but bash's `printf '%-Ns'` pads to N *bytes*, so a lone `—`
  cell is two spaces short of its column. The goldens hold it; the renderer
  copies it; a unit row names it. Fixing the alignment is a later, visible
  change, not a parity port.
- **What stays bash, deliberately:** `set_story_field` (the writer),
  `lib.sh`'s `frontmatter_field` for the scripts that stay bash,
  `telegram.sh`'s own `/why` awk (proven equal to `lib/review.ts` by the
  same inputs), `mutation.sh`'s `find_selector`, `porcelain` and
  `classify_mutation` until seam 4 retires `launch.sh`'s use of them.

Deliberate non-parities, each pinned by a unit test: table widths, story
order and evidence order are the `C.UTF-8` ones under any locale — the
systemd units set no `LANG`, where bash padded by bytes, so a khaita title
with an em dash widened its column by two there and does not now; gawk's
`[[:space:]]` under `C.UTF-8` strips U+3000 after `key:` and in the title
prefix, the TS strips ASCII whitespace only (seam 2's choice again); the
epic state string is not run through printf's `%b`; a `--json` row whose
verdict holds a quote is kept where jq's hand-built `--argjson` dropped it;
DEL is emitted raw in the JSON; `--wt` with no value prints the usage, not
bash's `${2:?}` text.

Verified: `bash test-lib.sh` green with cases 109 and 110 (681); 185 unit
tests and tsc clean; the ten goldens byte-identical, generated from the
bash before any TS rendered; 20 of 20 invocations (stdout, stderr, exit
status) identical between `git show HEAD~1:status.sh` and the wrapper on
the golden target, including the error paths; on the live khaita registry,
read-only, every view identical under `C.UTF-8`; wall time 2m39s → 2m24s
after the `status.sh` swap (the walk in one process beats the bash loop's
git calls), 2m29s with `check` — the suite's fixture never carries
`ts/node_modules`, so every run proves the runtime needs none. No khaita
run of `check-mutation.sh` this time: the target held no mutation evidence
and the run would have written `.review-out/` into it.

## Seam 4: the launcher, as built (branch `ts-classifier`, 23 Sep 2026)

```
ts/src/launch.ts               the story loop, launch.sh's order and its every line of output; the pure parts
                               (acIds, chooseBuildPrompt, keepEarlierRounds, the run-file shapes, readKnobs) tested alone
ts/src/bin/launch.ts           the repo through lib/config.ts, claude and codex on PATH, the four directories, the exit
                               codes; SIGTERM/SIGINT/SIGHUP remove the reviewer worktree and exit 128+n, the agent's
                               group left alone (L-04), as the bash EXIT trap did
ts/src/lib/proc.ts             += run: async, the child leads its own process group, SIGTERM at the timeout and SIGKILL
                               after the grace to the whole group (timeout -k's semantics — checked: neither leaves a
                               survivor); resolved on close; EPIPE on stdin swallowed
ts/src/lib/agents.ts           the two CLIs — builderArgv, reviewerArgv, runBuilder (merged output), runReviewer (stderr
                               to reviewer.stderr), parseBuilderOutput (launch.sh:535-541 as jq 1.7 evaluated it, row by
                               row), reviewerMessages (the jq filter and jq's stderr line for a non-object). The one file an
                               SDK seam would replace
ts/src/lib/render.ts           render_prompt, held equal to render.sh by a differential test (write-story.sh still uses it)
ts/src/lib/frontmatter.ts      += setStoryField, lib.sh:102-113 byte for byte, differential against it
ts/src/lib/lock.ts             the fleet lock: flock on a descriptor Node keeps open, the bot's with_lock unchanged
ts/src/lib/git.ts              += fetch, worktree add/remove, merge-base, rev-parse, diff --name-only, add, commit, push
ts/src/lib/baseline.ts         run_baseline: the jq -e rule (including jq's ordering), the summary as jq shaped it,
                               build and lint through `( cmd ) 2>&1 | tail -n 200` under pipefail
ts/src/lib/scope.ts            check_scope with bashGlobMatch, 36 rows proven against bash's own [[ == ]]
ts/src/lib/evidence.ts         run_mutations and run_probes in-process; writeResultFile (from the classify verb); RunnerError
launch.sh                      the wrapper: lib.sh, the node guard, exec
render.sh                      the replacement side of every ${out//pat/value} quoted (below)
test/claude, test/codex        FAKE_BUILDER_OUTPUT=garbage|shape, FAKE_REVIEWER=silent; headers corrected
test-lib.sh                    cases 111, 111b, 112 (characterised before the move), 113 (the loader stub);
                               FLEET_LAUNCH_OVERRIDE retired
gone                           mutation.sh, ts/src/bin/verdict.ts, mutation.ts's run-selector and classify verbs
```

What changed in substance:

- **The agents are still the CLIs.** The plan had said `@anthropic-ai/claude-agent-sdk`
  and `@openai/codex-sdk`; decided otherwise with the human once the machine
  was looked at: the Claude SDK does not run the `claude` on PATH but a
  234 MB CLI it bundles, over a stream-json protocol, with three peer
  packages; the Codex SDK pins its own `@openai/codex` 0.156.1; both would
  put `node_modules` in the live checkout and in every fixture copy, and the
  suite's fakes could no longer shadow the real binaries (L-14) — the sixty
  launcher cases would have needed an injection seam. Zero runtime
  dependencies hold; `lib/agents.ts` is the seam an SDK would replace, and
  the handoff §9 records what a seam 5 would have to prove first.
- **`render.sh` corrupted every `&`.** Found by the plan review, not by a
  case: bash 5.2's `patsub_replacement` is on, and an unquoted replacement
  value turns `&` into the matched text — `R&D uses &&` reached the agent as
  `R{{STORY}}D uses {{STORY}}{{STORY}}`; khaita stories 012, 017, 018 and 019
  carried it. The TypeScript substitutes literally and `render.sh` is quoted,
  so `write-story.sh` is fixed too; the differential test holds both. L-28.
- **Two paths no case covered were characterised first** (commit 1, before
  anything moved), and what bash really did there was not what a reading
  said: a builder printing non-JSON leaves `BUILD_ERR` *empty* (jq fails,
  stderr dropped) so the "was not JSON" warning never fires; the warning is
  for JSON of the wrong shape. Cases 111, 111b and 112 pin it as the bash
  had it; the port reproduces it.
- **Everything runs in one process.** One node start per round instead of
  three to six; the suite's wall time 2m29s → 2m16s. The `.result` writer,
  the reasons reader and the verdict are library calls; the CLI verbs that
  carried them across the process boundary are gone.
- **The edit-while-running hazard is gone** for the launcher: `launch.sh`
  execs node, which loads the whole module graph before `main`.

Deliberate non-parities, each pinned by a unit test: a rendered value is
inserted literally (`&`, `\&`, `\\`, `$&` survive); a non-numeric
`MAX_ROUNDS`, `AGENT_TIMEOUT` or `FLEET_LOCK_WAIT` is a die (bash read a name
as 0, or let `timeout` complain), and `AGENT_TIMEOUT` is seconds only (`0`
still means none); the KILL path after the grace is reported as a timeout
where `timeout` returned 137 and bash went on with partial output; a seed
file whose parent directory is missing in the worktree is a die; the
blocked notification's 600-byte cut may end in U+FFFD; agent output is
decoded as UTF-8; the merged builder output is chunk-ordered; the four
config commands are bash lines (the bash word-split them; identical for
khaita's values); `test.summary.json` holds an error object where jq failed
on the shape and bash left an empty file; an object followed by trailing
garbage from the builder is "not JSON" as a whole; `set_story_field` refuses
a value with `/ & \` or a newline instead of corrupting the file; the
`cat: … No such file` line before a die for an unreadable prompt or rules
file is not reproduced; jq's number literal (`1.50`) is not preserved in
`is_error`; every directory listing is code-point order under any locale.
And as before: `next_ready` and `reap_orphans` still consider `TEMPLATE.md`
(run-queue.sh's own `next_ready` skips it) — parity, a candidate fix outside
the migration.

Verified: `bash test-lib.sh` 703 → 710 (cases 111, 111b, 112, 113), 2m16s;
340 unit tests, tsc clean; the four in-process stub constraints (cases 106,
107, 108, 113) hold with the launcher importing the stubbed files directly.
Parity beyond the suite: 26 scenarios run under the bash launcher at
`ede26ca` and under the TypeScript one on the suite's own fixture — PASS,
FAIL×2, SPEC, blocked, no commit, dirty reviewer, builder and reviewer
timeouts, scope violation with a red probe, green probes, a resume after
needs_human, REVIEW_ONLY, a builder handover red and green, the garbage and
wrong-shape builder outputs, a silent and an unparseable reviewer, a bad
patch, a mutation for the wrong AC, no ACs, a story model with
REVIEWER_MODEL, a missing seed file, a failing install, `--reap`, an empty
queue — 675 files diffed per side (every prompt and argv the fakes
recorded, `review.md`, every `round-N/*`, `launch.log`, the target's git
log, the committed and working story, `.runs/<id>.json`), identical once
shas and the two clock lines are normalised. `launch.sh khaita --reap`
under the queue unit's exact `PATH`, read-only: exit 0, the checkout
unchanged. No `sleep` survives the suite (the group kill). The fixture
never carries `ts/node_modules`, so every run proves the runtime needs none.

## Seam 5: `merge.sh`, `revert.sh` and `reset.sh`, as built (branch `ts-landing`, 24 Sep 2026)

```
ts/src/merge.ts                merge.sh's order and its every line of output: parseArgs, refusal (the row from status.ts
                               in-process, in merge.sh:100-125's order), the throwaway worktree at origin's tip, the
                               post-merge baseline, MERGE_MODE=pr, the record, the builder worktree's removal
ts/src/revert.ts               revert.sh: checkStory, the throwaway worktree, revert -m 1, the push, the record
ts/src/reset.ts                reset.sh: parseArgs, the liveness and unmerged refusals, the six steps, the per-path staging
ts/src/bin/{merge,revert,reset}.ts   argv → loadRepo → the module; Die and ConfigError as the other bins; merge and revert
                               remove their worktree on SIGTERM/SIGINT/SIGHUP through lib/exit-hooks.ts
ts/src/lib/die.ts              Die, out of launch.ts (still exported there)
ts/src/lib/exit-hooks.ts       the EXIT trap, out of bin/launch.ts: makeExitHooks (tested alone), installExitHooks
ts/src/lib/git.ts              += pushRef, mergeNoFf, mergeAbort, revertMerge, revertAbort, branchForce, branchDelete,
                               worktreePrune, worktreeCheckedOutBranches, lsFilesTracked, addAll, logOneline;
                               worktreeRemoveForce returns the status
ts/src/lib/proc.ts             += runToFile, the argv form of runBashTo
ts/src/lib/frontmatter.ts      += replaceFrontmatterField, deleteFrontmatterField, recordMergedSha — record-scoped (below)
ts/src/lib/baseline.ts         += runMergeBaseline: whole logs under .runs/<logid>-merge-*.log, no summary; runVitestJson shared
merge.sh revert.sh reset.sh    wrappers: source lib.sh, require node, exec the bin
test-lib.sh                    cases 118-124 (characterised before the move, each seen red against a copy with the block
                               deleted), 125-127 (the loader stub, red under bash)
```

What changed in substance:

- **The story's state is read in-process.** `merge.sh` shelled to
  `status.sh --json` and read six fields through `jq -r`; `merge.ts` calls
  `statusOf(cfg, { one: id })` and reads the typed row (`merged`, `live`,
  `branch === DASH`). One node start per merge instead of two; the
  "exactly one story" check stays (`TEMPLATE` passes the file check and
  `storyIds` drops it).
- **Nothing new is locked.** None of the three took the fleet lock and none
  does now: the bot holds `flock -w 900` around `merge.sh` (`telegram.sh:230`)
  and `with_lock` around `revert.sh`; an inner `withFleetLock` would have
  waited `FLEET_LOCK_WAIT` on every `/merge`, then warned and gone ahead.
- **Two latent bugs found by the port**, both about a log written before its
  directory existed: `merge.sh:167` wrote `.runs/<logid>-merge.log` before
  the `mkdir -p` at `:181`, and `revert.sh:51` never made `.runs/` at all —
  on a checkout without it (a fresh clone, an `--epic` merge from a
  terminal) the failed redirect made a clean merge read "does not merge
  cleanly" and a clean revert "did not apply". Fixed and pinned (cases 125b
  and 126b, red under bash). L-29.
- **The record-commit sequences stay inline**, one per script: their
  messages differ four ways (the phone reads them) and a shared helper would
  have hidden which script said what. Only two git primitives were added
  for them (`lsFilesTracked`, `addAll`).
- **`runMergeBaseline` is a second function, not a generalisation** of
  `runBaseline`: the launcher's is pinned by the seam-4 record (`tail -n 200`,
  the summary file, `round-N/baseline/`); the merge's logs are whole and the
  die names them. The suite rule is shared.

Deliberate non-parities, each pinned by a test: the frontmatter writers touch
the record between the `---` lines only — `merge.sh:229-233` grepped and
sed'd `^merged:` over the whole file, `revert.sh:67` deleted every
`^merged:` line, `reset.sh:83` substituted the first `status:`/`round:`
anywhere, so a `merged:` or `status:` in a story's prose was edited too
(`frontmatter.test.ts`, the "non-parity, pinned" rows; kept from bash: an
empty `merged:` replaced in place, nothing inserted by `reset`, nothing
recorded when line 1 is not `---`); a story with no review file or no
`verdict:` line is refused in words (`has no .review/<id>.md — nothing
computed a PASS`, `'s review has no verdict line — …`) where bash printed
`computed null, not PASS` (`merge.test.ts`); a seed file that cannot be
copied into the merge worktree is a die, as in the launcher, where bash
printed cp's error and went on (`seedMergeWorktree`); the config commands
run as a bash line (seam 4's choice); `.runs/` is made first (above).
Reproduced, not fixed: `diff --cached --quiet` commits anything else staged;
`reset`'s `.runs/<id>-*` glob also takes `900-b-*` for 900 (`runsOfStory`);
the status snapshot is taken before `git fetch`; `revert` moves the local
base with `branch -f` without `merge.sh:211`'s checked-out check (a warning
on failure); `reset`'s pid list ends in a trailing space.

Verified: `bash test-lib.sh` 745 → 856 (cases 118–127, every one seen red
first); 427 unit tests (350 before), tsc clean; every merge, revert and
reset case green on the first run against each port. Parity beyond the
suite: 41 scenarios run under the bash scripts at `e2f20ea` and under the
TypeScript ones on the suite's own fixture — a story into its epic, twice,
`--land` and its three refusals, `--epic` and its four, the usage paths,
FAIL, not done, no review, no verdict line, no branch, live, a red build,
a red suite, a failing install, a conflict, a local branch ahead of origin,
`PUSH_STATUS=0`, pr mode for a story and an epic, a failing `PR_CMD`, pr
without push, a revert and a second, none recorded, a landed story, a sha
not on origin, a conflict, the usage paths, a reset with `--force`, `--draft`
twice, unmerged, live, against origin's branch, the usage paths, a reset
after a merge — 343 files diffed per side (every script's stdout+stderr and
exit status, the story file, every ref's subjects and tree, `.runs/*`, the
porcelain, the worktree list) after normalising shas, paths and clocks:
identical except the two verdict-wording lines above. On the live khaita
registry, read-only, each wrapper's first refusal: `merge.sh khaita 021` →
`021 is draft, not done`, `--epic epic/nope` → `origin has no epic/nope`,
`revert.sh khaita 021` → `no recorded merge`, `reset.sh khaita 021 --bogus`
→ `unknown option`, exit 1 each, the checkout at `ec02943` untouched. The
fixture never carries `ts/node_modules`, so every run proves the runtime
needs none.

Fixed after the seam, a behaviour change and so not part of the parity port
(branch `land-record`, 24 Sep): `--land` with the base checked out — khaita's
checkout is on `develop` — pushed the merge, could not move the local branch
under itself, then committed the `merged:` record on that stale base; the
record's push was refused and the human's `git pull --ff-only` failed
(ahead 1, behind 2). Now a checkout that is on the base and clean is
fast-forwarded to the merge before the record (`currentBranch`,
`mergeFfOnly`, `porcelain`); a dirty one keeps the warning and the local
record. Case 120c (red against the port as merged), 120d for the dirty tree.
