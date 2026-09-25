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

**Enforced by:** on a lesson names the `test-lib.sh` case or function
that fails if the lesson is un-learned. A lesson without the field is making no
such claim — it is advice, and says so by its absence. `case_72` checks that
every name here still exists, so a lesson cannot go on claiming an instrument
it has lost.

### L-01 — `.env.local` absent in fresh worktrees
App built, suite fully green, connected to `projects/undefined`. Found by a
human looking at the screen; no automated check could see it.
**Lesson:** a green suite says nothing about configuration the suite mocks.
**Prevention:** by construction — `SEED_FILES` seeded before `npm ci`.

**Enforced by:** `case_48_missing_seed_file`

### L-02 — `git add a b c` stages nothing if `c` is missing
Exit 128. Every status commit silently dropped, because `.blocked/<id>.md`
usually does not exist. `2>/dev/null` hid it.
**Lesson:** batch operations fail atomically; a missing optional path kills
the whole call.
**Prevention:** by construction — each path added separately, guarded.

**Enforced by:** `case_7_status_commits_land`

### L-03 — jq `//` fires on `null` and `false`
`.is_error // "parse-failed"` rewrote every *successful* run as parse-failed.
**Lesson:** the alternative operator is not a null-coalesce.
**Prevention:** by construction — `if has("is_error") then ... else ... end`.

**Enforced by:** `case_8_is_error_false`

### L-04 — `kill -9` on the launcher does not stop the work
`claude`, its shell, `npm` and `vitest` all survive. `pgrep -f "wt-004"`
finds nothing: the worktree path exists only in **cwd**, never in argv.
**Lesson:** identify processes by what they are doing, not by how they were
named.
**Prevention:** by construction — `procs_in_worktree()` scans `/proc/*/cwd`
with `readlink -f` normalisation. Side benefit: multiplexer-agnostic, so
swapping tmux costs nothing.

**Enforced by:** `case_53_reset_refuses_while_live`

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

**Enforced by:** `case_5_restart_after_fail`

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

**Enforced by:** `case_15_baseline_notests`

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
The L-05 fix sat uncommitted in `launch.sh` for a day. One
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
`prompts/*.md` — the coupling becomes reviewable in one diff.

---

## Found while building the verdict runner (17 Sep, evening)

### L-14 — a fake that does not shadow the real binary is the real binary
`test-lib.sh`'s first run named its stand-ins `fake-claude` and
`fake-codex`. The launcher calls `claude` and `codex` by bare name, so the
*real* Claude Code started with the fixture story, ran the test script
itself, and recursed three deep on real quota before being killed by
process (L-04 applied — the launcher's death stops nothing).
**Lesson:** a substitution through PATH is only a substitution if the name
matches; nothing warns when it does not.
**Prevention:** by construction — `shadow_check` refuses to start the
launcher unless every fake is what `command -v` resolves, and a nested
invocation (`FAKE_TRACE_DIR` already set) exits before doing anything.

**Enforced by:** `shadow_check`

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
(`prompts/README.md`, "The verdict contract").

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

**Enforced by:** `case_17_reviewer_output_copied`

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
over. `test/codex` emits the notice on every run.

**Enforced by:** `case_31_codex_stderr_notice`

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
(`ts/src/lib/agents.ts` since seam 4; before it `printf '%s' … | claude -p`,
`… | codex exec`), which is also codex's intended mode and removes the L-17
notice at its root. `test-lib.sh` case 32 grows a review past the limit on
a rerun and asserts the builder still receives it.

**Enforced by:** `case_32_huge_review_prompt`

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
the reviewer's detached tree inherits. `test-lib.sh` case 33.

## Found by running two stories back to back (18 Sep)

**Enforced by:** `case_33_story_amendment_reaches_builder`

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
postcondition, and nothing else; `test-lib.sh` case 34. Used on 008
round 3, which is the run that passed.

## Found by story 010 — the first production-code story after Phase 3

**Enforced by:** `case_34_review_only`

### L-22 — evidence must be produced against the state it will be judged in
The builder's TDD patches were hand-authored during the TDD step, before the
fix, and the harness applies them to the head the round ends on. Under
one-task-one-commit there were three commits in between, so two of three
patches were `PATCH_INVALID` — twice. `rules.md` had said "a `git diff`
against your own commit", which does not say *which* commit.
**Lesson:** a claim about state is only checkable against the state it is
checked in. An agent asked for evidence must be told when to produce it, not
only what to produce. The builder worked this out itself in round 2 — *"the
patches were regenerated directly from `git diff` on the actual working tree
(not hand-authored), which is why they were PATCH_INVALID last round"* —
which is the reviewer-grade diagnosis the format is supposed to make possible.
**Prevention:** by construction for the checking (`PATCH_INVALID` is a class
the runner reports and vetoes on, so an unverifiable claim can never read as a
verified one); by wording for the producing — `rules.md` now says produce it
with `git diff` from the working tree, LAST, after the final commit.

### L-23 — a productive round need not produce a commit
Phase 3.1 gitignored `.review-out/` so neither agent could commit scratch onto
a story branch. That made a round whose only correct output is evidence
invisible to the no-commits postcondition, which was written when code was the
only output a builder could produce. Story 010 round 2 did exactly the right
thing — regenerated its patches, changed no code because none needed changing
— and was killed for it.
**Lesson:** an invariant encodes the set of outcomes that existed when it was
written. Adding a new kind of output silently narrows it into a false
negative. The question the postcondition means to ask is "did this round
produce anything the harness can judge", and commits had been the only
possible answer.
**Prevention:** by construction — the check also stands down when the builder
handed evidence over, which the runner judges exactly as the reviewer judges
commits. Nothing at all is still a die; `test-lib.sh` case 2 is
unchanged and case 37 covers the new path.

**Enforced by:** `case_37_evidence_only_round`

### L-24 — an escalation fixture must make the decision unavoidable, not merely present
Story 010 was written to force `.blocked/` to fire for the first time: a
product question with no technically correct answer — what a collection page
should show when it is loaded and empty. The builder did not block. It gated
the existing `<Loading />` on the new signal and let the page fall through to
the frame it already renders, satisfying the AC without inventing any UI.
**Lesson:** that is arguably not a guess. AC2 asked for an observable absence
("does not render the loading state"), and an absence can be delivered by
removing something rather than by choosing what to add. A fixture only forces
escalation if its criteria cannot be met without picking between materially
different outcomes. Naming the open question in the story — 010 quoted 006
naming it — is not the same as making it load-bearing.
**Prevention:** by discipline, and unproven: `.blocked/` has still never fired
in fourteen stories. The mechanism is tested (`test-lib` case 3); what is untested
is any real agent's willingness to use it.

## Found by story 014 — the fleet working on its own harness (18 Sep)

**Enforced by:** `case_3_blocked`

### L-25 — claim only what you instrument
Story 014's criteria were unusually precise, and precision cuts both ways. AC3
said an uncommitted edit must be **"byte-identical"** after a refresh; its test
compared content and missed a dropped trailing newline, so the reviewer's
`drop-final-newline` mutation survived. AC2 said the log line "says the drain
is continuing on local state"; the test only grepped `refresh failed`, so
deleting the second half of the message survived. Both vetoes were correct —
the ACs did claim those things.
**Lesson:** L-20 says bound the domain. This is its complement: state the claim
at the strength you intend to instrument, no stronger. A stronger claim is not
a safer one — it is more surface for a mutation to land on, and every extra
inch of it must be tested or it becomes a finding. "Byte-identical" invited a
byte-level probe the test never meant to cover.
**Prevention:** by discipline, with a nudge — `lint-story.sh` warns on an
unquantified every/all/any but cannot judge whether a claim exceeds its
instrument. The writing prompt now says it; nothing enforces it.

### L-26 — the harness verifies the app, not itself
The baseline is `npm test`, `npm run build`, `npm run lint`. All three exercise
the application. **Nothing in the baseline touches ``.** So story 014 —
which changed `run-queue.sh` and `test-lib.sh` — passed a green
baseline that proved nothing about it, and its only real verification was the
reviewer's mutations plus a human running `test-lib` by hand afterwards.
Worse, `test-lib.sh` itself was writable by the builder: a quietly weakened
unrelated case would have been invisible to the pipeline. It did not happen —
the diff was purely additive — but nothing prevented it.
**Lesson:** a verification system's weakest coverage should not be of itself.
`launch.sh` was protected by `scope_deny`, so the judge was never the judged;
that part was right. The baseline was the hole.
**Prevention:** closed by construction, 18 Sep. `run_baseline` runs
`SELF_TEST_CMD` (default `bash test-lib.sh`) whenever the round's changed
paths include ``, and a RED result vetoes like any other baseline
failure. It reports SKIPPED rather than GREEN when it does not run: a check
that did not run must not read as a check that passed. Cases 46 and 47.
**What it still does not cover:** the suite is only as good as its cases, and
the same builder that weakens a case could weaken the case that guards it.
Nothing here makes the harness self-verifying — it makes a harness change
visible to the same instrument every other change already faces.

**19 Sep 2026:** the harness is its own repository now and is never a fleet
target, so no round's diff can contain a harness file and the self-test branch
was removed — a check that cannot fire is absent, not weak. Prevention is
`bash test-lib.sh` by hand before every commit in the fleet repo (CLAUDE.md
there). No case enforces this any more.

### L-27 — a self-test inherits the configuration of the run that calls it

Story 014's round three was started with `MAX_ROUNDS=1`, because it needed
exactly one more round. The baseline's new self-test step ran
`bash test-lib.sh` in the reviewer worktree — and `MAX_ROUNDS=1` was in
the environment, so the suite's own fixtures inherited it. Cases 4, 5, 9 and
27 exist to check what happens across *two* rounds; with the ceiling at one
they failed. 230 passed, 14 failed, and the machine vetoed a story whose
sixteen mutations were all RED and whose reviewer said PASS.

Nothing was wrong with the story. The harness had configured its own examiner.

**Lesson:** a check that runs the system under test inherits whatever the
current run was configured with, and its fixtures assume defaults. The failure
is not loud — it looks exactly like a real finding, which is worse than a
crash.

**Prevention:** `env -i` with a four-variable allowlist (`PATH`, `HOME`,
`TMPDIR`, `LANG`), not a list of variables to drop. A drop-list has to be
extended every time the launcher grows a seam, and the once it is forgotten
the symptom is a false veto indistinguishable from a true one. The case proves
the environment is clean by making the child's environment the log
(`SELF_TEST_CMD=env`), which is the only way to assert on something a
subprocess cannot report back.

**19 Sep 2026:** the launcher no longer runs the suite (see L-26), so the
`env -i` moved into `test-lib.sh` itself, which re-executes under a clean
environment before any fixture is built: a developer shell with `MAX_ROUNDS=1`
exported would otherwise reproduce this exactly.

**Enforced by:** `case_88_suite_env_is_clean`


## Found by the seam-4 plan review (23 Sep)

### L-28 — an unquoted replacement value is a pattern, not a value

`render.sh` substituted each placeholder with `${out//\{\{STORY\}\}/${STORY_TEXT:-}}`.
bash 5.2 turns `patsub_replacement` on by default, and in an unquoted
replacement `&` stands for the matched text: `R&D uses &&` reached the
builder and the reviewer as `R{{STORY}}D uses {{STORY}}{{STORY}}`, `\&`
became `&`, `\\` became `\`, and the log said `unsubstituted in build-round1.md:
{{STORY}}` — a warning that looked like a prompt-file typo. Four khaita
stories (012, 017, 018, 019) contain `&&`; every one of their rounds ran on
a corrupted prompt. Nobody noticed: the agents read past it, the suite's
fixture story has no `&`, and case 10 tested the guards, not a value with
punctuation.

**Lesson:** a substitution mechanism has a grammar on both sides. The
placeholder side was made inert on purpose (`{{NAME}}`, not `$NAME`); the
value side was assumed inert and was not. Reproducing a bash construct in
another language is where such an assumption surfaces — the port's
differential test put `&` in a value because the port had to decide what
to do with it.

**Prevention:** `render.sh` quotes every replacement value; `ts/src/lib/render.ts`
splits and joins, never `String.replace` with a string (whose `$&` is the
same trap). The differential test renders a value holding `& \& \\ $& $1`
through both and requires the same bytes.

**Found again at seam 8 (25 Sep 2026):** `telegram.sh:71` escaped a `--pre`
message with `${text//</&lt;}` — the same construct — so every code-block
message went to Telegram as `<pre>…<lt;…>gt;…</pre>`, invalid HTML that the
API refuses, and `curl -sS` without `--fail` swallowed the refusal. Any
`/status` reply with an angle bracket in a title was never delivered, and
nothing said so. The old-vs-new differential of the TypeScript port put
`<` in a value and the bash side came out wrong.

**Enforced by:** `ts/src/lib/render.test.ts` — the row "a value is inserted literally";
`test-lib.sh` case 135 for the bot's escape

### L-29 — a redirect into a directory that may not exist reports the command as failed

`merge.sh` ran `git merge … > "$REPO_ROOT/.runs/$LOGID-merge.log" 2>&1` at
line 167 and `mkdir -p "$REPO_ROOT/.runs"` at line 181; `revert.sh` never
made `.runs/` at all. On a checkout without that directory — a fresh clone,
or an `--epic` merge from a terminal before any story ran there — the shell
could not open the log, the command never ran, and the `if !` branch
reported a clean merge as "does not merge cleanly into <base> — a human has
to resolve it" (a revert: "did not apply"). Nothing in the suite had a
target without `.runs/`: the launcher makes the four directories on its
first run, and every merge case runs after a launch. Found while porting
the script (seam 5), by reading it in the order the port had to reproduce.

**Lesson:** `cmd > log || die "cmd failed"` conflates two failures — the
command's and the log's — and the message names the wrong one. The
directory a log lives in is part of the command's precondition, not its
aftermath.

**Prevention:** `merge.ts` and `revert.ts` make `.runs/` before the first
log; a case removes `.runs/` before an `--epic` merge and before a revert.

**Enforced by:** `case_125_merge_through_the_loader` (125b, red under the bash: a
checkout without `.runs/` merges), `case_126_revert_through_the_loader` (126b).

### L-30 — a glob that includes a placeholder is a bug waiting for the placeholder to look real

`run-queue.sh`'s `next_ready` explicitly skipped `TEMPLATE.md`
(`[[ "$id" == "TEMPLATE" ]] && continue`); `launch.ts`'s own `nextReady`,
ported from `launch.sh`'s original glob, did not — a comment even recorded
the choice: "the bash glob did not skip it." The gap sat unnoticed because
nothing had ever set `TEMPLATE.md`'s own `status:` to `ready`. But
`TEMPLATE.md`'s frontmatter is not a comment — it is the real file every
`write-story.sh` copies from, and its `status: ready` line is the
placeholder text itself, never meant to be edited, sitting in every target
repo including khaita's. A bare `launch.sh <repo>` (no story id — a human
testing something by hand, not a path the queue or the bot ever calls)
picks `argv[0] || nextReady()`: with nothing else ready, `nextReady()`
found `TEMPLATE`, and the launcher ran the whole pipeline against it,
leaving it `needs_human` with a builder's mutations in its frontmatter.

**Lesson:** a glob or a loop over "every story" is a claim about what
counts as a story. When one entry is a template, a fixture, or otherwise
not real data, the code that iterates "every story" must say so at the
point of iteration — not rely on every value that entry could ever hold
being obviously wrong. `TEMPLATE.md`'s placeholder frontmatter meeting the
literal condition for "ready" was not a contrived edge case; it was the
file as shipped.

**Prevention:** the exclusion moved to one place, `status.ts`'s
`storyIds`, and every chooser of "the next story" — the launcher's bare
invocation, the queue's drain — reads through it. There is now one
`nextReady`, not two that could drift again.

**Enforced by:** `case_128_bare_launch_never_picks_template` (red against
real `launch.ts` before the fix: a bare launch with `TEMPLATE.md` at
`status: ready` and nothing else ready actually ran the pipeline against
it, leaving it `needs_human`).
