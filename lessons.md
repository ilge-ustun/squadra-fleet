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

---

## Found while building the verdict runner (17 Sep, evening)

### L-14 — a fake that does not shadow the real binary is the real binary
`fleet/test-lib.sh`'s first run named its stand-ins `fake-claude` and
`fake-codex`. The launcher calls `claude` and `codex` by bare name, so the
*real* Claude Code started with the fixture story, ran the test script
itself, and recursed three deep on real quota before being killed by
process (L-04 applied — the launcher's death stops nothing).
**Lesson:** a substitution through PATH is only a substitution if the name
matches; nothing warns when it does not.
**Prevention:** by construction — `shadow_check` refuses to start the
launcher unless every fake is what `command -v` resolves, and a nested
invocation (`FAKE_TRACE_DIR` already set) exits before doing anything.

### L-15 — the verdict was a grep over the reviewer's prose
`launch.sh` decided PASS by matching `^VERDICT: PASS$` on the model's
output. Nothing checked that any mutation was applied, any test ran, or
any cited log said what the prose claimed. L-07's flag-on-the-happy-path,
at the harness level.
**Lesson:** a model's report of a check is not the check. The harness owns
verdict computation only if it computes something.
**Prevention:** by construction — the reviewer hands mutations to the
harness as files; the harness applies, runs, classifies, and vetoes a PASS
on any surviving mutation, any uncovered AC, or a red baseline
(`fleet/prompts/README.md`, "The verdict contract").

### L-16 — evidence lived in /tmp, at a path the reviewer chose each run
Four stories, four naming schemes. `.review/004.md` round 1 cites five
mutation logs that do not exist; the same review corrects one of its own
citations mid-round. The verdict's evidence was never in any layer.
**Lesson:** evidence that is not in state is not evidence, it is a memory
of one.
**Prevention:** by construction — the harness writes baseline results,
mutation files, per-mutation `.result`s and both agents' text under
`.review/<id>/round-N/` and commits them with the status. Raw logs stay in
`.runs/` and are re-derivable from patch + SHA.

### L-17 — unattended changes what the agents print
First real run of the verdict runner, detached from a terminal. Codex wrote
"Reading additional input from stdin..." to stderr because stdin was not a
TTY — something no tmux run had ever shown. The launcher merged stderr into
the JSON stream, jq aborted on line 1, the fallback put raw JSONL into
`REVIEW_TEXT`, and the reviewer's `VERDICT: FAIL` — present both rounds —
sat inside a JSON string, never at column 0. Two rounds parsed UNPARSEABLE.
The computed verdict was right anyway (three surviving mutations vetoed
round 1, one vetoed round 2), which is the point of computing it.
**Lesson:** the first unattended run is a different environment from every
attended one. Assumptions about agent output that held under a TTY are
untested until then. A "fallback that earned its keep once" is a silent
path that will be taken when least expected.
**Prevention:** by construction — stderr captured as evidence
(`reviewer.stderr`), never merged; extraction skips non-JSON lines and takes
only `agent_message` items; an empty extraction is recorded, not papered
over. `fleet/test/codex` emits the notice on every run.

### L-18 — a prompt on argv has a hard ceiling, and evidence grows
Round 3 of story 007 died with `is_error=` blank and no output: the
round-2 prompt embeds the review file, the review file held two rounds of
raw JSONL (the L-17 artefact), 134,816 bytes went to `claude -p "$PROMPT"`
as one argument, and `execve` refused it — `MAX_ARG_STRLEN` is 131,072.
The launcher had never seen a prompt that large because no story had ever
carried two rounds of evidence before.
**Lesson:** anything that accumulates per round will cross a fixed limit
eventually; argv was the wrong channel for a payload that grows. The
symptom — empty output, blank `is_error` — looked like the builder said
nothing, when the builder was never started.
**Prevention:** by construction — prompts go to both agents on stdin
(`printf '%s' … | claude -p`, `… | codex exec`), which is also codex's
intended mode and removes the L-17 notice at its root. `fleet/test-lib.sh`
case 32 grows a review past the limit on a rerun and asserts the builder
still receives it.

### L-19 — the story the agents read is the branch copy, not the base copy
Story 007 was amended on `feat/pwa` after four rounds and set back to
ready. The builder resumed its worktree — a branch cut before the
amendment — and read the old text; the reviewer's detached tree at the
builder's head had the same old text. The harness meanwhile extracted AC
ids from the base copy and judged against the amended set. Neither agent
could have satisfied a requirement it could not see. Round 5 was stopped
by process once this was verified.
**Lesson:** `needs_human` exists so a human can rewrite the story. If the
rewrite does not reach the worktree, the loop is a human editing a file
nobody reads. State that is "in git" is only in the branch it is in.
**Prevention:** by construction — `sync_story` copies the base story into
the builder worktree and commits it there as the launcher's own commit
before the round's start SHA (so it is never the builder's work), which
the reviewer's detached tree inherits. `fleet/test-lib.sh` case 33.

## Found by running two stories back to back (18 Sep)

### L-20 — what converges a story is the domain, not the number of ACs
Story 007: five ACs over everything one file does — eight rounds, never a
PASS, merged over a FAIL. Story 008: two ACs over one property — three
rounds, PASS. The tempting conclusion is "fewer ACs". It is wrong.

008's first two rounds caught **every mutation the story named** and failed
only on AC1's opening words, "every stub in the worker global". That domain
is unbounded: it pulled in the `push` and `notificationclick` handlers, which
no AC of 007 or 008 describes and whose surface is a whole notification
payload. Two rounds were spent making stubs argument-sensitive for handlers
nobody had scoped. Quantifying the domain — "every stub the fetch, install
and activate handlers call" — and re-reviewing the *unchanged* build gave a
PASS with eleven mutations RED.

So the cost was not five ACs versus two. It was one unbounded "every".
**Lesson:** a reviewer told to hold a build to "every X" will keep finding a
new X. The story must say which X. This is the same rule story 006's AC3
already paid for, written down in the handoff's conventions, and broken here
anyway — by the author of that handoff entry, one day later.
**Prevention:** by discipline. Nothing can detect an unbounded domain in
prose. The nearest mechanical guard is that every AC names the mutations it
must catch, which 008 did — and which is why the failing rounds were cheap
and diagnosable rather than mysterious.

**Confirmed by 009**, written the same day with the lesson applied: two ACs,
one named component, one named mutation each, domain bounded in the AC line
itself. **PASS in one round** — the first story to pass without a second
attempt, and in a different area of the codebase (a React page test, not the
service worker). The sequence across three stories is monotonic in the
domain, not in the AC count: 5 ACs unbounded → 8 rounds; 2 ACs with one
unbounded "every" → 3 rounds; 2 ACs bounded → 1 round.

### L-21 — a spec defect costs a builder round unless the harness has a way to skip it
008's rounds 1 and 2 ended with a correct build and a wrong spec. Before
`REVIEW_ONLY`, the only way to get a re-review was to let the builder commit
something, because the round postcondition demands a commit — so a spec fix
cost a full builder round and put unrelated changes in the branch.
**Lesson:** `needs_human` exists so a human can change the story. The harness
must then be able to re-judge the same head against the new story.
**Prevention:** by construction — `REVIEW_ONLY=1` skips the builder and the
postcondition, and nothing else; `fleet/test-lib.sh` case 34. Used on 008
round 3, which is the run that passed.
