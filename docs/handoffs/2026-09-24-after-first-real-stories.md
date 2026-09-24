# Handoff — 24 Sep 2026: the TypeScript fleet ran real stories; next, continue the migration

For the session that continues the bash→TypeScript migration. As always, read
`README.md`, `CLAUDE.md` and `docs/FLEET-HANDOFF.md` first, then
`docs/plans/2026-09-23-typescript-migration.md` (seams 1–4, the rules that hold
for every seam). This file covers what those documents do not say yet.

## Where things stand

- **`main` is the TypeScript fleet**, live since 24 Sep. PR #1 is the migration,
  PR #2 the model policy. The live checkout `~/work/fleet` is at `fdc8bc9`, and
  the suite passed there at 735.
- **The bash harness is kept on branch `bash-fleet`** (`37a1986`, pushed) as a
  backup. Nothing runs it.
- **PR #3, branch `fixes-0924`, is not landed at the time of writing.** It holds
  the five fixes from today's runs (below) and this file. Suite 745, 350 unit
  tests, tsc clean. After a human merges it, do this once with both services
  inactive:
  ```bash
  cd ~/work/fleet && git pull --ff-only && bash test-lib.sh
  bash install-skills.sh      # removes the old fleet links from ~/.codex/skills (fix 1)
  git -C ~/work/khaita/khaita-app worktree remove --force ../wt-020
  git -C ~/work/khaita/khaita-app worktree remove --force ../wt-025   # merged before fix 3 existed
  ```
- **Not installed:** `fleet-agents-update.timer`, the weekly claude and codex
  update from PR #2. Installing it is a human's step, described in
  `systemd/README.md`. Until then codex stays at 0.153.4, whose default is
  already `gpt-6-astra`.

## What the first real stories showed

Two khaita stories ran through the queue on the TypeScript launcher. Both PASS,
both merged into `epic/ui-a11y` by the queue.

| story | rounds | builder | reviewer | notes |
|---|---|---|---|---|
| 020 song-page footer | 1 | `claude-sonnet-4-6` (before PR #2) | codex (`gpt-6-astra`, read from its session file) | 848 s in all |
| 025 lyrics languages | 2 | `haiku → claude-haiku-4-5-20251001` ($0.45), then `sonnet → claude-sonnet-5` ($0.77) | `codex → gpt-6-astra` | round 1 failed on the baseline: build RED (implicit `any`); round 2 PASS; the one-round Haiku rule worked as designed |

The watch list from the 23 Sep handoff, item by item:

1. **Builder output shape:** fine. `builder.json` is the CLI's object,
   `result` is a string, `is_error` false.
2. **Reviewer stream:** `reviewer.md` is prose, with no `jq: error` lines.
   **Finding:** the stderr notice is "Reading prompt from stdin...", not the
   text the fake printed (fixed, 5).
3. **No `unsubstituted` warning:** confirmed, 0 in the queue journal today.
4. **Timeout and group kill:** never triggered, so still unobserved.
5. **Memory:** unobserved. systemd reports `MemoryCurrent` only while the unit
   runs. Watch `systemctl --user status fleet-queue` during a round.
6. **The `timing:` line:** integer seconds, the same magnitudes as before.
7. **Status and the bot under the units' locale:** the table renders. `/status`
   was not exercised from the phone this session.
8. **`.result` files and `test.summary.json`:** present, the same shapes.

## Five fixes from those runs (PR #3), each with a test seen failing first

1. **The reviewer no longer loads the fleet skills.** `install-skills.sh` had
   linked them into `~/.codex/skills`, so every codex run loaded them,
   including the reviewer. 020's and 025's reviews say "using the
   fleet-coordinate and fleet-verdict skills". Codex now reads them from this
   repo's `.agents/skills` (a tracked symlink to `skills/`), so it has them only
   when started in `~/work/fleet`. A probe skill confirmed that codex loads a
   repository's `.agents/skills`, symlinked directory included. Reviewer skills
   of its own (security, design) can go in `~/.codex/skills` or a target's
   `.agents/skills`; `install-skills.sh` leaves them alone. Case 104.
2. **The builder is told to run the build and the lint.** `rules.md` named
   only the tests. It now names the target's `VITEST_CMD`, `BUILD_CMD` and
   `LINT_CMD`, which is what cost 025 its Haiku round. Case 84d.
3. **`merge.sh` removes a merged story's builder worktree**, unless
   something is running in it. The branch stays; `revert.sh` works from the
   recorded sha. Case 56.
4. **Status says "no branch yet → new-epic.sh …"** for an epic a story names
   before the branch exists. It used to print `epic/search … in develop`, as if
   the epic had landed. Case 80b and a unit test.
5. **`test/codex` prints the real stderr notice.** Case 31 and a unit test.

## Open items, none blocking the migration

- **The builder also sees the fleet skills.** They are in `~/.claude/skills`,
  global for Claude Code. No builder output mentions using them. The fix
  would be the same scoping as for codex, but coordinator sessions start in
  `~/work`, not in the fleet repo. Probe Claude Code's project-skill lookup,
  and whether it walks up from a worktree, before moving anything, or our own
  sessions lose the skills.
- `next_ready` in the launcher and `run-queue.sh` still disagree about
  `TEMPLATE.md` (the 23 Sep item). This is resolved naturally when `run-queue`
  is ported (below).
- Lanes (two stories at once) and a story-selection lock are features, still
  untouched. The box has about 2.2 GB free, so a second concurrent story is a
  memory question first.
- Haiku trial so far: 1 story, round 1 failed on something fix 2 addresses.
  021 is `model: haiku` and is the next data point.

## khaita, for context (not this session's work)

- `develop` `ec02943`. **`epic/ui-a11y`** (`96c32c4`) holds 020 and 025, 7
  commits ahead of develop; landing it (`/merge khaita epic/ui-a11y`) is the
  human's call, and 025 was urgent.
- Drafts: 021 (theme switch, haiku), 022 (keyboard tabs, opus; promote after
  025, which is done), 024 (iPhone search, `base: epic/search`, which does not
  exist yet; the human creates epics from develop when work starts, not
  before). 023 (ARIA labels) is to be drafted once 021 and 022 are merged
  into the epic.
- Backlogs in the khaita repo: `docs/fleet/backlog-search.md`,
  `docs/fleet/backlog-offline-recovery.md`, both with the human's answers
  recorded.

## The next session: continue the migration

The plan document ends with "`telegram.sh`, `merge.sh`, `reset.sh`,
`revert.sh`, `run-queue.sh` and the systemd side stay bash indefinitely". **The
human reversed that on 24 Sep: the migration continues.** The first act of
the session is to write that decision into the plan, with the seam order
agreed.

What is still bash (lines, and what each calls):

| script | lines | calls |
|---|---|---|
| `telegram.sh` | 331 | `curl`, `flock`, `jq`, `status.sh`, `revert.sh`, `merge.sh` detached |
| `merge.sh` | 244 | `status.sh --json` through `jq`; git; the post-merge baseline |
| `lint-story.sh` | 188 | none; awk and grep over the story, git for citations |
| `run-queue.sh` | 177 | `launch.sh`, `merge.sh`, `status.sh`, itself for `--all` |
| `lib.sh` | 130 | sourced by all; `load_repo` is the config contract |
| `reset.sh` / `revert.sh` | 106 / 77 | git; the story's frontmatter |
| `write-story.sh` | 95 | `claude -p`, `render.sh`, `lint-story.sh`, `jq` |
| `render.sh` | 57 | used only by `write-story.sh` now (`render.ts` serves the launcher) |
| `new-epic.sh`, `install-skills.sh`, `update-agents.sh`, `check-mutation.sh` | 40, 39, 34, 40 | small; `check-mutation.sh` is already a wrapper |
| `test-lib.sh` | 2 900+ | the acceptance layer: 106 case functions, 745 assertions |

A proposed order, to be agreed with the human:

- **Seam 5: `merge.sh`, then `revert.sh` and `reset.sh`.** Landing is where
  correctness matters most. It reuses what exists: `status.ts` in-process
  instead of `status.sh --json | jq`, `baseline.ts` for the post-merge
  baseline, `git.ts`, `lock.ts`, `procs.ts`. `revert.sh` and `reset.sh` share
  its readers.
- **Seam 6: `run-queue.sh`.** One `nextReady`, shared with the launcher, which
  settles the `TEMPLATE.md` disagreement. Decide whether the queue calls the
  launcher in-process or keeps one process per story. The process boundary
  isolates memory and a die, and that is worth keeping.
- **Seam 7: story authoring, `lint-story.sh`, `write-story.sh` and
  `new-epic.sh`.** `render.sh` retires with `write-story.sh`, its last user.
  The citation checks are the delicate part (the lint checks against a
  story's base).
- **Seam 8: `telegram.sh`.** The hard part is testing. The bot uses `curl`,
  faked on PATH; Node's `fetch` bypasses PATH, so the suite needs a new seam
  (e.g. an API base URL pointing at a local fake server) before anything
  moves. `flock` becomes `lock.ts`.
- **Small ones, any time:** `install-skills.sh`, `update-agents.sh`,
  `new-epic.sh`, and the wrappers.
- **Stays bash:** `lib.sh`'s `load_repo` as the `.fleet/config` contract
  (`config.ts` already reads it through a child bash; a target's config is
  sourced bash by contract), `test-lib.sh` as the acceptance layer, and the
  systemd units.

Method, as it held for seams 1–4. Characterise first: a `test-lib.sh` case
for any behaviour not yet pinned, seen red against a copy with the block
deleted. Then port, with vitest beside each module, red first. Keep a bash
wrapper with the same name, so no caller changes. For a larger script,
repeat the old-versus-new parity diff (`git archive` of the old tree beside
the new, the fixture helpers cut from `test-lib.sh`, every produced file
diffed after normalising shas and clocks); the 23 Sep handoff describes it.
Record each seam in the plan document as it is built.

## Rules that held today and hold tomorrow

Work in a worktree (`../fleet-wt-<topic>`), never in `~/work/fleet` while the
timers run. A case seen red before every change. `bash test-lib.sh` green
before every commit; for `ts/`, also `cd ts && npm run check && npm test`. One
task, one commit. Show the `ts/src/launch.ts` diff before applying it. Land
through a PR the human merges, then `git pull --ff-only` in the live checkout
with both services inactive. Never start a launcher as a child of the
session. Kill by cwd, never `pkill -f`.
