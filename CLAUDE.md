# CLAUDE.md

## What this repo is

`README.md` is the map — read it first. A TypeScript harness (`ts/`, run by
Node as is, behind one entry point, `./fleet`) that runs an autonomous
builder/reviewer loop against **other** repositories: a story is written, a
builder agent (Claude Code) implements it in a worktree, a reviewer agent
(Codex) proposes mutations, and the harness runs the baseline, applies every
mutation, and computes the verdict itself. The machine can veto, never
grant. Read `docs/lessons.md` (L-01 …) — the reasons behind the rules below —
before touching anything.

This repo is **never itself a fleet target**. Nothing here runs the pipeline
against this checkout. The checkout at `~/work/fleet` is live — the systemd
timers run it — so it is changed in a worktree (the `fleet-develop` skill).

## Registry and config contract

- `repos/<name>.env` — the registry. One file per target repo, holding
  **only** `REPO_PATH=/abs/path`. Nothing else may live in it.
- `<target>/.fleet/config` — the target's own settings, committed there and
  sourced by `load_repo` in `bin/lib.sh` (the TypeScript side reads it
  through `ts/src/lib/config.ts`, which runs `load_repo` in a child bash;
  nothing parses the file): `BASE_BRANCH INSTALL_CMD VITEST_CMD
  BUILD_CMD LINT_CMD SEED_FILES PROBE_DIR`, optional `REPO_RULES` (a markdown
  file, relative to the target, rendered into the agent prompts), optional
  `MERGE_MODE` (`direct`, the default, or `pr` — which requires `PR_CMD`;
  the contract is in `README.md`).
  Missing file or missing key is a `die`. A variable already in the caller's
  environment wins over the file.
- Every command takes the repo name first: `./fleet launch <repo> <id>`,
  `./fleet status <repo>`, `./fleet merge <repo> <id>`,
  `./fleet new-epic <repo> <name>`, `./fleet run-queue <repo>` or
  `./fleet run-queue --all`. Telegram commands are repo-qualified:
  `/promote <repo> <id>`, `/merge <repo> epic/<name>`.
- An epic is a branch named `epic/*` and nothing else; `fleet new-epic`
  creates it, `fleet write-story --base` and `fleet lint-story` accept no
  other base. Landing on the integration branch is a human's call:
  `fleet merge <repo> --epic epic/<name>`, `fleet merge <repo> <id> --land`,
  or `/merge` — never the queue.
- Per-repo state (`.stories/ .review/ .blocked/` committed; `.runs/
  .review-out/` ignored) lives in the target. Machine-local fleet files
  (`.env.fleet` with the bot token, `.bot-offset`) live here, gitignored.

## Tests

```bash
bash test/suite.sh            # every case; must be green before any commit
bash test/suite.sh blocked    # cases whose name contains "blocked"
```

Nothing runs this for you. TDD is mandatory: write the failing case, run it,
SEE IT FAIL, then change the code. Most cases characterise behaviour the
fleet already has, so "see it fail" means running the case against a copy
with the block deleted: `FLEET_LIB_OVERRIDE` substitutes a copy of
`bin/lib.sh` into the fixture; `FLEET_TS_OVERRIDE` lays a directory
over `ts/src/`, or the case writes a stub into the fixture's `ts/src/lib/`
after `fixture` (cases 106-110, 113). A case that has never been observed
red is not a case.

The TypeScript side (`ts/`, run by `node` as is — no build) has vitest
unit tests beside each module, red first too:

```bash
cd ts && npm ci && npm run check && npm test   # tsc --noEmit, then vitest
```

`npm test` compiles through esbuild, which accepts syntax Node rejects;
`npm run check` and `bash test/suite.sh` (real `node`) are the proofs.
Nothing under `ts/` needs `node_modules` at run time; the live checkout
never runs `npm`.

## Writing the TypeScript

- Modules throw typed errors; only `ts/src/bin/*.ts` turns them into
  messages and exit codes. No `process.exit` in a module.
- Output through `fs.writeSync(1|2, …)` and `process.exitCode`; a
  `console.log` before `process.exit` can be cut off.
- Zero runtime dependencies — `node:*` only. `typescript`, `vitest` and
  `@types/node` are devDependencies; the suite's fixture copy leaves
  `ts/node_modules` out, so every run proves nothing needs them.
- Relative imports end in `.ts`; no `enum`, `namespace` or parameter
  properties (`erasableSyntaxOnly`) — Node strips types, it compiles nothing.
- A target's config never goes into the environment: `load_repo` does not
  export it, and a child — the runner the classifier starts, the next repo
  under `run-queue --all` — must see the environment its caller had.
- Commands run through `runSync`; the agent calls through the async `run`
  (`lib/proc.ts`): the child leads its own process group, SIGTERM at
  `AGENT_TIMEOUT`, SIGKILL 30 s later, the whole group — nothing outlives
  the call in the worktree.
- Anything larger than a few flags reaches a child on stdin, never argv
  (L-18, the 128 KB ceiling).

## Working rules

- `./fleet launch` execs node, which loads the whole program before it
  starts: editing `ts/src/` while a launcher runs is safe; the change
  reaches the next launch. `./fleet status <repo>` shows what is live.
- Never run a launcher as a child of an interactive agent session; always
  `setsid nohup bash -c '…' > log 2>&1 < /dev/null &`.
- Kill by cwd (the processes whose `/proc/<pid>/cwd` is inside the
  worktree — `ts/src/lib/procs.ts`, and the loop in the fleet-land skill)
  or exact process name, never by a `pkill -f` pattern that can match your
  own command line.
- Show the `ts/src/launch.ts` diff before applying it.
- Prefer `die` over `warn` — a warning assumes a human is watching. Never
  suppress stderr on a step that can fail meaningfully (L-02).
- A check that cannot go red is absent, not weak; a check that cries wolf
  is worse than none.
- Read the file, never only a diff hunk (L-09).
- Prompts go to agents on stdin, never argv.
- One task, one commit. Show `git status --short` with each.
- Commits and PRs carry the human's name only: no `Co-Authored-By`,
  `Claude-Session`, "Generated with" or model trailer. The model is
  recorded in the Machine block and the round evidence, never in git; every
  claude the fleet starts gets attribution off from `builderArgv` (case 147).
