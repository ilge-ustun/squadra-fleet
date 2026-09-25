# Handoff — 25 Sep 2026, later: seam 7 confirmed live; next session starts seam 8 (telegram.sh)

For the session that continues the bash→TypeScript migration. Read
`README.md`, `CLAUDE.md`, `docs/FLEET-HANDOFF.md`, then
`docs/plans/2026-09-23-typescript-migration.md` (seam 7's as-built record
is its last section) and `docs/handoffs/2026-09-25-after-seam-7.md` (the
handoff written right after PR #8 merged). This file covers what happened
*after* that merge, in the same day: seam 7 exercised against a real
target for the first time, plus two khaita stories that came out of it and
need attention before they're built.

## Where things stand

- **`main` is at `2549b3e`** (PR #8 merged); the live checkout `~/work/fleet`
  is at it too, suite 894 there.
- **No new fleet-harness code this session** — this handoff and its
  companion khaita note are the only changes. **Seam 8 (`telegram.sh`) is
  the next real migration work.** Per the plan doc: the hard part is
  testing, not the port. `telegram.sh`'s `curl` is faked on PATH the way
  `claude`/`codex` are, but Node's `fetch` doesn't go through PATH, so
  nothing in `test-lib.sh` today can intercept a TS port's HTTP calls.
  Build that interception seam first (an injectable API base URL, or a
  local fake server) before porting a single line. `lock.ts` already
  exists (seam 4); only `telegram.sh`'s own `flock` usage needs porting.

## Seam 7, exercised live (not just fixtures) — clean

Fixture-based proof was seam 7's whole verification story in PR #8; this
session ran the ported scripts against khaita for real, deliberately, as
the natural next check:

- **`new-epic.sh khaita search`** — created `origin/epic/search` from
  `origin/develop` (`5e2e82c`) cleanly.
- **`lint-story.sh khaita 024`** — went from 1 error ("no such branch") to
  0 once the epic existed; 45 citations resolved correctly against
  `origin/epic/search`. This is case_98's fixture scenario, now proven for
  real.
- **`write-story.sh khaita 026 "..." --base epic/search`** — the one seam-7
  path with zero prior production exposure. Full live run: worktree from
  `origin/epic/search`, a real `claude -p --model opus` call, the
  postcondition check, copy-back, an in-process `lint-story.ts` call (0
  errors, 3 warnings — all forward-looking citations to files the builder
  will create), throwaway worktree cleaned up. Nothing anomalous; the
  wrapper, the async agent call with no timeout, and the in-process lint
  all behaved exactly as the port intended.
- Separately, **story 022** (khaita, `epic/ui-a11y`, `model: opus`, not
  affected by the haiku retirement) ran through the full pipeline
  (launch → mutation classifier → verdict → merge into the epic) cleanly,
  round 1, PASS, 25/25 mutations RED. Confirms seams 1/2/4/5 still work
  against a real target after PR #8 landed alongside PR #6. It does **not**
  add a data point to the haiku-retirement decision (still n=2, 021/025) —
  022's `model:` was pinned to `opus`, never touched the retired tier or
  the new default.

## Two khaita stories need a human decision before either is built

**Full detail lives in khaita's own `docs/fleet/backlog-search.md`** (updated
this session, S1/S2 section) — read it there before touching 024 or 026.
Short version, so it isn't missed:

- **024** (iPhone Safari search field) and **026** (typo-tolerant search
  matcher, drafted this session from backlog item S2) **both touch
  `SearchInput.tsx` and contradict each other.** 024's own test requires
  the query `Mangalom` to find nothing; 026's typo-tolerant matcher
  requires `Mangalom` to find `Mangalam`. They cannot both pass on the same
  branch as drafted.
- The write-story agent's own recommendation (in 026's Evidence section):
  **build 024 first**, then adjust the one `Mangalom` row in 026's test
  table before promoting it — or build 026 first and amend 024. Either
  order works; drafting them in the wrong order does not.
- 026 also surfaces two open product calls that need a human answer before
  promotion, not a fleet decision: whether 3-letter queries should really
  be typo-tolerant (it went stricter than "under 3" was read as — see rows
  T5/T13 of its example table), and a possible Fuse.js edge case around
  counting a letter-swap as one typo vs. two (row T9).
- Both stories are still `draft`. Promoting either to `ready` is a human
  call — read them first, khaita's own backlog note names exactly what to
  check.

## Rules that held today and hold tomorrow

No fleet-harness code changed this session, so the usual TDD/worktree
rules for *that* didn't come up — but the standing rule about not running
mutating fleet commands against a real target without explicit
authorization did: `new-epic.sh`, `lint-story.sh --strict` (read-only) and
`write-story.sh` were only run here because the human said "go ahead" to
both, in this session, for this specific purpose. That authorization does
not carry forward to a future session by default — check with the human
before running either again, and never promote a story to `ready` or run
`launch.sh` unattended without being asked.
