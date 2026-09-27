# Fleet lessons

Cross-story findings. One entry per finding, newest last. Per-story detail
stays in the target's `.review/<id>.md`; this file is for what generalises.
The story numbers are the first target's, kept because they are the
evidence.

Every entry states how the failure is prevented now:

- **by construction** — code or structure makes it impossible; closed
- **by discipline** — depends on someone remembering; still open, and will
  fail the first time the person is tired

Entries marked *by discipline* are a work queue, not a record.

---

## Carried over from the 14 Sep handoff

**Enforced by:** on a lesson names the `test/suite.sh` case or function
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
**Prevention:** by construction — `procsInWorktree` (`ts/src/lib/procs.ts`)
scans `/proc/*/cwd`, both sides resolved with `realpath`. Side benefit:
multiplexer-agnostic, so swapping tmux costs nothing.

**Enforced by:** `case_53_reset_refuses_while_live`

### L-05 — findings did not survive a restart
They lived only in a shell variable. After FAIL + restart the builder
re-read the story, saw its own commits and reported done. Twice.
**Lesson:** anything the next round needs must be on disk before the round
ends.
**Prevention:** by construction — `REVIEW_TEXT` read from
`.review/<id>.md` at startup, round-1 fresh-build branch gated on it being
empty.

**Enforced by:** `case_5_restart_after_fail`

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
The target's `CLAUDE.md` claimed 16 files / 66 tests. Three agent runs "corrected" this to
18 / 102. Measured baseline: **18 files / 96 tests**. No one counted; the
figure was repeated until it looked established, including once in this
session by me.
**Lesson:** tests constrain code; nothing constrains the documents agents
read to orient themselves, and each agent that reads a stale doc writes a
new doc citing it. Prefer naming the command that produces a number over
stating the number.
**Prevention:** by discipline. Same class as a diagnosis document that went
on asserting a theory the next story refuted.

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
**Prevention:** by discipline, narrowed: the prompts live in `prompts/*.md`
and `prompts/README.md` records the three places the verdict line is parsed,
so a change to either side is reviewable in one diff.

---

## Found while building the verdict runner (17 Sep, evening)

### L-14 — a fake that does not shadow the real binary is the real binary
`test/suite.sh`'s first run named its stand-ins `fake-claude` and
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
over. `test/fakes/codex` emits the notice on every run.

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
(`ts/src/lib/agents.ts`), which is also codex's intended mode and removes the
L-17 notice at its root. `test/suite.sh` case 32 grows a review past the limit on
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
**Prevention:** by construction — the launcher reads the story from the
checkout (the base copy) and hands it to both agents in their prompt, never
as a file in the worktree, so an amendment reaches the next round whatever
the branch holds.

**Enforced by:** `case_33_story_amendment_reaches_builder`

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
postcondition, and nothing else; `test/suite.sh` case 34. Used on 008
round 3, which is the run that passed.

**Enforced by:** `case_34_review_only`

## Found by story 010 — the first production-code story after Phase 3

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
commits. Nothing at all is still a die; `test/suite.sh` case 2 is
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
from a real builder. The mechanism is tested (case 3); what is untested is
any real agent's willingness to use it.

**Enforced by:** `case_3_blocked`

## Found by story 014 — the fleet working on its own harness (18 Sep)

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
**Prevention:** by discipline, with a nudge — `fleet lint-story` warns on an
unquantified every/all/any but cannot judge whether a claim exceeds its
instrument. The writing prompt now says it; nothing enforces it.

### L-26 — the harness verifies the app, not itself
The baseline — test, build, lint — exercises the application. Story 014
changed the harness itself, which then lived in the target repo, and passed
a green baseline that proved nothing about it: its only real verification
was the reviewer's mutations and a human running the harness's suite by
hand. Worse, the suite itself was writable by the builder; a quietly
weakened case would have been invisible to the pipeline.
**Lesson:** a verification system's weakest coverage should not be of itself.
**Prevention:** by construction since 19 Sep — the harness is its own
repository and never a fleet target, so no round's diff can contain a
harness file. What remains is by discipline: `bash test/suite.sh` by hand
before every commit to the fleet (CLAUDE.md).

### L-27 — a self-test inherits the configuration of the run that calls it
Story 014's round three was started with `MAX_ROUNDS=1`. The baseline's
self-test step (since removed, L-26) ran the harness's suite with that in
the environment, so the suite's own fixtures inherited it; the cases that
check what happens across *two* rounds failed, and the machine vetoed a
story whose sixteen mutations were all RED and whose reviewer said PASS.
Nothing was wrong with the story. The harness had configured its own
examiner.
**Lesson:** a check that runs the system under test inherits whatever the
current run was configured with, and its fixtures assume defaults. The
failure looks exactly like a real finding, which is worse than a crash.
**Prevention:** by construction — `test/suite.sh` re-executes itself under
`env -i` with an allowlist (`PATH`, `HOME`, `TMPDIR`, `LANG`, and the two
override seams) before any fixture is built. An allowlist, not a list of variables to drop:
a drop-list must grow with every new setting, and the once it is forgotten
the symptom is a false veto indistinguishable from a true one.

**Enforced by:** `case_88_suite_env_is_clean`


## Found while porting the harness to TypeScript (23–25 Sep)

### L-28 — an unquoted replacement value is a pattern, not a value

`render.sh` substituted each placeholder with `${out//\{\{STORY\}\}/${STORY_TEXT:-}}`.
bash 5.2 turns `patsub_replacement` on by default, and in an unquoted
replacement `&` stands for the matched text: `R&D uses &&` reached the
builder and the reviewer as `R{{STORY}}D uses {{STORY}}{{STORY}}`, `\&`
became `&`, `\\` became `\`, and the log said `unsubstituted in build-round1.md:
{{STORY}}` — a warning that looked like a prompt-file typo. Four real
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

**Prevention:** `ts/src/lib/render.ts` splits and joins, never
`String.replace` with a string (whose `$&` is the same trap). Its test
renders a value holding `& \& \\ $& $1` and requires it back byte for byte.

**Found again (25 Sep 2026):** the bash bot escaped a `--pre`
message with `${text//</&lt;}` — the same construct — so every code-block
message went to Telegram as `<pre>…<lt;…>gt;…</pre>`, invalid HTML that the
API refuses, and `curl -sS` without `--fail` swallowed the refusal. Any
`/status` reply with an angle bracket in a title was never delivered, and
nothing said so. The old-vs-new differential of the TypeScript port put
`<` in a value and the bash side came out wrong.

**Enforced by:** `ts/src/lib/render.test.ts` — the row "a value is inserted literally";
`test/suite.sh` case 135 for the bot's escape

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
the script to TypeScript, by reading it in the order the port had to reproduce.

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
repo. A bare `fleet launch <repo>` (no story id — a human
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

### L-31 — a scan for signs of life is not a lock

On 21 Sep (khaita 015) two launchers ran one story. A launch started by
hand was in its review phase when a queue drain began; the drain's
`--reap` looked for processes in `wt-015`, found none — the reviewer, its
install and its baseline all run in `wt-015-review`, and the launcher's own
node process runs in neither — called the story an orphan, set it `ready`
(390be3f) and claimed it again (7fe3750). Both launchers then worked on
015 at once.

The reap judged liveness by scanning one of the story's two trees, and a
scan of both still cannot see a launcher between agents: running git,
computing the verdict, waiting up to 120 s on the fleet lock at a status
commit.

**Lesson:** "is anyone still working on this?" is answered by something the
worker holds, not by looking for traces of its work. A process scan answers
a narrower question — were agents left behind — and only where it looks.

**Prevention:** `fleet launch` takes `.git/fleet-launch.lock` before it
reads or reaps anything and holds it until it exits; the kernel drops it
however the process ends. Another launch, a drain's `--reap` included,
exits 75 and touches nothing, and the queue leaves the repo to its next
drain. The reap still scans — both trees now (`storyTrees`) — for agents a
SIGKILLed launcher left running, since those do not hold the lock.
`/promote` and `/answer` refuse an `in_progress` story.

**Enforced by:** `case_137_one_launch_per_repo` (red against the launcher
without the lock: `--reap` returned a story under review to `ready`; 137c
stays red with the two-tree scan alone), `case_138_reap_sees_a_storys_trees`,
`case_139_bot_leaves_in_progress_alone`, `case_140_queue_leaves_a_busy_repo`.

### L-32 — a provider's refusal was read as the reviewer's verdict

On 21 Sep (khaita 015, round 3) codex's whole stream was a refusal:
`{"type":"error","message":"You've hit your usage limit … try again at
2:17 PM."}` and a `turn.failed`. The launcher kept only `agent_message`
items, found none, and scored the round UNPARSEABLE — a reviewer failure.
The round was spent, the builder ran again on a placeholder "review", and
the phone got `015 needs_human — ` with no reason at all. A human read the
raw stream, found the quota, and set the story back to ready an hour
later; round 4 then rebuilt on that placeholder.

**Lesson:** "the reviewer said nothing we can parse" and "nobody reviewed"
are different outcomes with different owners. The first is the reviewer's
and costs a round; the second is the provider's, costs nothing, and is
news for a human. An extractor that keeps only the happy-path items cannot
tell them apart.

**Prevention:** `reviewerRefusal` reads the stream: an `error` or
`turn.failed` and no `turn.completed` is a refusal. The round is not
counted, line 3 says `UNAVAILABLE` (a type `computeVerdict` cannot return),
`not_before` holds codex's own reset (its session rollouts, else its
message), the queue pauses until the human chooses `/wait` or `/fallback`,
and the resumed launch reviews the head with no builder round. Claude's
refusal of the builder is detected the same way (`claudeRefusal`) and only
reported, as the human decided.

**Enforced by:** `case_141_refused_reviewer_costs_no_round` (red against the
launcher before: UNPARSEABLE, a second builder round, the generic message),
`case_142_refused_story_resumes_at_its_review`,
`case_143_queue_pauses_on_a_refused_review`, `case_144_bot_wait_and_fallback`,
`case_145_builder_refused_by_claude`, `case_146_fallback_reviewer_is_claude`.
### L-33 — a job must not wait on a job that can outlive its own timeout

`/run` started the queue with `systemctl --user start fleet-queue.service`.
For a oneshot, `start` returns when the unit *finishes*: the poll sat
inside the whole drain. The poll is a oneshot too, with a two-minute start
timeout, so systemd killed it — three times in two days (24 Sep 15:15 and
18:20, 25 Sep 11:27) — with the reply "queue started" unsent, and the bot
deaf for those two minutes, since a running poll skips the timer's next
firings. The drain itself was never harmed; the harm was silence.

**Lesson:** when one unit starts another, ask what "start" waits for. A
oneshot's start is its whole run. A caller with a shorter life than the
callee's must enqueue and return, or it dies holding the callee's hand —
and takes with it whatever it still had to say.

**Prevention:** the default `QUEUE_START_CMD` is `systemctl --user start
--no-block fleet-queue.service`: exit 0 means the job was queued, which is
all "queue started" claims. The knob's doc comment and `systemd/README.md`
say why, so a hand-set command keeps the property.

**Enforced by:** `ts/src/telegram.test.ts` — the row pinning
`readBotKnobs({}).queueStartCmd` (red before the fix). Nothing in the suite
can observe it: its bot sets `QUEUE_START_CMD=true`; the proof is a `/run`
from the phone answered within seconds.

### L-34 — a detached child still belongs to its unit's cgroup

After L-33's cousin on 22 Sep (the epic/pwa merge killed at the poll's
two-minute timeout), `/merge` forked its job with `detached: true` and
answered at once. That fixed the timeout, but not the kill. A detached
process is a new session, but it stays in the same cgroup, and when a
oneshot's main process exits, systemd kills what is left in the unit's cgroup
(`KillMode=control-group`, the default). Every `/merge` since then would
have died seconds after "merging …", before landing anything or sending its
result. None was sent in production, and the suite runs the bot outside
systemd, where nothing kills the child, so case 99 passed throughout. Found
on 27 Sep with a transient oneshot whose `setsid sleep` child was gone as soon
as the unit ended.

**Lesson:** a test that runs outside the supervisor cannot see what the
supervisor does. Whether a process can outlive its caller depends on the
caller's unit, not on how the process was forked.

**Prevention:** a job that must outlive the poll is a unit of its own:
`DETACH_CMD`, default `systemd-run --user --collect --quiet --setenv=PATH
--setenv=HOME`, then `--unit=<name>`. The poll's PATH and HOME go along,
because the manager's environment has no node. Checked on the machine: a
unit started from inside another unit outlives it.

**Enforced by:** `case_148_bot_job_is_its_own_unit`, with the fakes
`test/fakes/systemd-run` and `test/fakes/systemctl` (both in
`shadow_check`: a real one started from a fixture would be a real unit), and
the `defaultDeps.spawnDetached` rows in `ts/src/telegram.test.ts`, red
against the fork.

### L-35 — systemd-run rewrites `${…}` in the command it is given

L-34's fix put the bot's jobs under `systemd-run`, which hands the command to
systemd as an `ExecStart`. systemd expands `${NAME}` in those arguments with
the unit's environment before bash ever sees them, and it does this even
inside a single `bash -c` argument. The first real test deploy after #21
(27 Sep) showed it. The journal said `Invalid environment variable name
evaluates to an empty string: l#==> `, and `${last#==> }`, the
`/testdeploy` job's link, reached bash as an empty string. An empty message
is not sent, so the build succeeded and the human was never told. `$1`, `$@`
and `${out:-…}` came through, which is why `/merge`'s job looked fine. The
suite's fake `systemd-run` passed arguments through untouched, so no case
could see this.

**Lesson:** a fake that stands in for a program has to stand in for the
program's transformations too, or at least refuse the input they would
mangle. Passing arguments through is a claim about the real program, and
here it was false.

**Prevention:** every `systemd-run` the fleet issues passes
`--expand-environment=no` (DETACH_CMD's default, and the test server's
start). The fake `systemd-run` refuses an argument that holds `${` unless
that flag is given.

**Enforced by:** the tripwire in `test/fakes/systemd-run` (cases 148 and 150
go red without the flag), the `--expand-environment=no` assertions in cases
148 and 149, and the `readBotKnobs` defaults row in
`ts/src/telegram.test.ts`.

