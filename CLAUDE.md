# CLAUDE.md

## What this repo is

A bash harness that runs an autonomous builder/reviewer loop against **other**
repositories: a story is written, a builder agent (Claude Code) implements it in
a worktree, a reviewer agent (Codex) proposes mutations, and the harness runs
the baseline, applies every mutation, and computes the verdict itself. The
machine can veto, never grant. Read `docs/FLEET-HANDOFF.md` and
`docs/lessons.md` (L-01 …) before touching anything.

This repo is **never itself a fleet target**. Nothing here runs the pipeline
against this checkout.

## Registry and config contract

- `repos/<name>.env` — the registry. One file per target repo, holding
  **only** `REPO_PATH=/abs/path`. Nothing else may live in it.
- `<target>/.fleet/config` — the target's own settings, committed there and
  sourced by `lib.sh:load_repo`: `BASE_BRANCH INSTALL_CMD VITEST_CMD
  BUILD_CMD LINT_CMD SEED_FILES PROBE_DIR`, optional `REPO_RULES` (a markdown
  file, relative to the target, rendered into the agent prompts).
  Missing file or missing key is a `die`. A variable already in the caller's
  environment wins over the file.
- Every entry point takes the repo name first: `launch.sh khaita 014`,
  `status.sh khaita`, `merge.sh khaita 014`, `run-queue.sh khaita` or
  `run-queue.sh --all`. Telegram commands are repo-qualified: `/promote khaita 013`.
- Per-repo state (`.stories/ .review/ .blocked/` committed; `.runs/
  .review-out/` ignored) lives in the target. Machine-local fleet files
  (`.env.fleet` with the bot token, `.bot-offset`) live here, gitignored.

## Tests

```bash
bash test-lib.sh            # every case; must be green before any commit
bash test-lib.sh blocked    # cases whose name contains "blocked"
```

Nothing runs this for you. TDD is mandatory: write the failing case, run it,
SEE IT FAIL, then change the script. Most cases characterise behaviour the
scripts already have, so "see it fail" means running the case against a copy
with the block deleted: `FLEET_LAUNCH_OVERRIDE`, `FLEET_RENDER_OVERRIDE`,
`FLEET_LIB_OVERRIDE` substitute that copy into the fixture. A case that has
never been observed red is not a case.

## Working rules

- Never edit `launch.sh` while a launcher is running it — bash reads scripts
  incrementally. `status.sh <repo>` shows what is live.
- Never run a launcher as a child of an interactive agent session; always
  `setsid nohup bash -c '…' > log 2>&1 < /dev/null &`.
- Kill by cwd (`procs_in_worktree`) or exact process name, never by a
  `pkill -f` pattern that can match your own command line.
- Show the `launch.sh` diff before applying it.
- Prefer `die` over `warn` — a warning assumes a human is watching.
- A check that cannot go red is absent, not weak.
- Prompts go to agents on stdin, never argv.
- One task, one commit. Show `git status --short` with each.
