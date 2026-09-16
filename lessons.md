# Fleet lessons

Cross-story findings. One entry per finding, newest last. Per-story detail
stays in `.review/<id>.md` and `docs/fleet/<id>-diagnosis.md`; this file is
for what generalises.

Every entry states how the failure is prevented now:

- **by construction** — code or structure makes it impossible; closed
- **by discipline** — depends on someone remembering; still open, and will
  fail the first time the person is tired

Entries marked *by discipline* are a work queue, not a record.

---

## Carried over from the 14 Sep handoff

### L-01 — `.env.local` absent in fresh worktrees
App built, suite fully green, connected to `projects/undefined`. Found by a
human looking at the screen; no automated check could see it.
**Lesson:** a green suite says nothing about configuration the suite mocks.
**Prevention:** by construction — `SEED_FILES` seeded before `npm ci`.

### L-02 — `git add a b c` stages nothing if `c` is missing
Exit 128. Every status commit silently dropped, because `.blocked/<id>.md`
usually does not exist. `2>/dev/null` hid it.
**Lesson:** batch operations fail atomically; a missing optional path kills
the whole call.
**Prevention:** by construction — each path added separately, guarded.

### L-03 — jq `//` fires on `null` and `false`
`.is_error // "parse-failed"` rewrote every *successful* run as parse-failed.
**Lesson:** the alternative operator is not a null-coalesce.
**Prevention:** by construction — `if has("is_error") then ... else ... end`.

### L-04 — `kill -9` on the launcher does not stop the work
`claude`, its shell, `npm` and `vitest` all survive. `pgrep -f "wt-004"`
finds nothing: the worktree path exists only in **cwd**, never in argv.
**Lesson:** identify processes by what they are doing, not by how they were
named.
**Prevention:** by construction — `procs_in_worktree()` scans `/proc/*/cwd`
with `readlink -f` normalisation. Side benefit: multiplexer-agnostic, so
swapping tmux costs nothing.

### L-05 — findings did not survive a restart
They lived only in a shell variable. After FAIL + restart the builder
re-read the story, saw its own commits and reported done. Twice.
**Lesson:** anything the next round needs must be on disk before the round
ends.
**Prevention:** by construction — `REVIEW_TEXT` read from
`.review/<id>.md` at startup, round-1 fresh-build branch gated on it being
empty.

---

## Found while extracting story 005 (15 Sep)

### L-06 — the suite mocks the module under test
All 18 test files call `vi.mock("@/utils/firebase")`. The module body never
executes under test, so deleting its persistence config left the suite
fully green. A production bug lived in it through four stories.
**Lesson:** when the mock boundary sits *above* the code you want to prove,
there is no instrument — not a weak one, an absent one. Check where the
boundary is before writing an AC that depends on the code below it.
**Prevention:** by discipline. Nothing detects a module that no test
imports for real.

### L-07 — a success flag set after a non-throwing call proves nothing
`persistenceEnabled = true` on the line after `initializeFirestore`. The
throwing path sets it correctly via the catch; the silent-fallback path
reports success while persistence is absent. The likelier failure mode was
the one that reported true.
**Lesson:** a flag assigned on the happy path records "no exception", not
"the thing worked". If the SDK can degrade without throwing, the flag is
green theatre.
**Prevention:** by discipline. Still true after the 005 fix — the flag is
now *correlated* with persistence, not evidence of it.

### L-08 — a transform error is visually identical to a detected bug
A test file that fails to compile reports `FAIL`, red banner,
`Test Files 1 failed`. So does a test correctly catching the bug. The
distinguishing line is `Tests: no tests` versus `Tests: 2 failed | 2 passed`.
**Lesson:** when capturing red evidence, read the test count, never the
colour. A suite that cannot compile asserts nothing.
**Prevention:** by discipline. Noted in `.stories/005.md` so the reviewer
re-running it knows which red is which.

### L-09 — reasoning from a diff hunk instead of the file
A comment appeared stale because the hunk began mid-sentence; the full
comment was correct. Nearly shipped a "fix" to correct code. Same error the
004 builder made, and the reason the reviewer protocol re-derives evidence
from a clean worktree rather than reading the diff.
**Lesson:** a hunk is an excerpt. Any conclusion about intent, naming or
correctness needs the file.
**Prevention:** by discipline for humans; by construction for the reviewer,
which receives a spec and a SHA, never the diff.

### L-10 — one commit carrying three concerns cannot be extracted
`fix(004): address review findings — real Collection instrument, reverse
race, Firebase config`. Cherry-picking it would have dragged two unreviewed
changes onto the base. Workaround: path-scoped
`git diff <base> <branch> -- <file> | git apply`.
**Lesson:** one-task-one-commit is not tidiness, it is what makes a single
change extractable later. It broke under review pressure, in the same run
where the scope boundary broke — an agent told "address these findings"
treats the list as one task. Prompt fix, not a code fix.
**Prevention:** by discipline. Belongs with the scope-escalation rule.

### L-11 — numbers in repo prose are unconstrained and propagate
`CLAUDE.md` claims 16 files / 66 tests. Three agent runs "corrected" this to
18 / 102. Measured baseline: **18 files / 96 tests**. No one counted; the
figure was repeated until it looked established, including once in this
session by me.
**Lesson:** tests constrain code; nothing constrains the documents agents
read to orient themselves, and each agent that reads a stale doc writes a
new doc citing it. Prefer naming the command that produces a number over
stating the number.
**Prevention:** by discipline. Same class as
`docs/fleet/004-diagnosis.md` still asserting the refuted lease theory.

### L-12 — a harness fix living only in a working copy
The L-05 fix sat uncommitted in `fleet/launch.sh` for a day. One
`git checkout .` from losing it, with no record it had ever been solved.
**Lesson:** the state design is "durability lives in git". The launcher is
the file most likely to violate it, because it is edited by hand under
debugging pressure rather than by a story.
**Prevention:** by discipline.

### L-13 — the harness depends on a format only a prompt enforces
`grep -qE '^verdict: (FAIL|UNPARSEABLE)'` assumes `.review/<id>.md` carries
exactly one `verdict:` line, at column zero, reflecting current aggregate
state. Verified true today: plain markdown, no frontmatter, summary block
above per-round `## Round N` sections.
**Lesson:** the reviewer prompt and this grep are coupled, and the coupling
is recorded nowhere. If a prompt change moves the verdict into frontmatter
or emits one per round, the grep silently misses, `REVIEW_TEXT` stays
empty, and L-05 returns *looking fixed*.
**Prevention:** by discipline. Strongest argument yet for moving prompts to
`fleet/prompts/*.md` — the coupling becomes reviewable in one diff.
