# fleet

An autonomous coding fleet: a bash harness that turns a one-sentence intent
into a story, has a builder agent implement it, has a reviewer agent attack
it, computes the verdict itself, and merges what passes. It runs against
**other** repositories — its first target is `khaita-app` — and is never a
target itself. It is autonomous: from the moment a story is `ready`, the
queue builds, reviews, judges and merges it into its epic with no one
watching, and a human operates the whole loop alone from a terminal or a
phone through a Telegram bot. A coordinator — an agent session beside the
human — is optional help for the two steps that take judgment, drafting and
reading verdicts; nothing depends on one.

The principle that shapes everything: **the machine can veto, never grant.**
A story passes only when the baseline is green, every acceptance criterion
has a test the reviewer proved goes red, no probe found anything, and the
reviewer said PASS. Any one of those missing is a FAIL with the reason named.

This file is the map. `docs/FLEET-HANDOFF.md` is the state, `docs/lessons.md`
(L-01 …) the reasons, `docs/COORDINATORS.md` the coordinator on other
harnesses and models. Orient by running commands, not by trusting prose —
numbers in prose rot.

## The loop

```
intent ──write-story.sh──▶ .stories/<id>.md (draft)
       ──lint-story.sh───▶ cited paths exist on the base, ACs are **ACn headed, base: is legal
       ──the coordinator─▶ reads the draft, edits by hand, lints again, commits
       ──a human────────▶ status: ready   (at a terminal, or /promote from the phone)
       ──the queue───────▶ launch.sh: worktree from origin/<base>; builder; baseline; scope;
                           reviewer; mutation runner; probe runner; computed verdict
                           → .review/<id>.md, committed with the status
       ──merge.sh────────▶ story → its epic, on a computed PASS (the queue does this)
       ──a human────────▶ epic → integration branch, or a develop story → develop
                           (merge.sh --epic / --land, or /merge from the phone)
```

`run-queue.sh` drains every `ready` story of a repo, lowest id first, and
calls `merge.sh` on each computed PASS. Two systemd timers (`systemd/`) run
the queue every 15 minutes and the bot every minute. Nothing in the fleet
lands anything on the integration branch by itself, and nothing in it
promotes a story.

## Roles

Three agents run inside the harness, one judgment runs beside it, and the
harness itself is bash. Each agent is one CLI call on stdin; each is
replaceable at that seam.

| role | runs as | model | does | may not |
|---|---|---|---|---|
| story writer | `write-story.sh`: `claude -p`, tools Read/Grep/Glob/Bash/Write | `STORY_MODEL`, default `claude-opus-5` | reads the epic's tip in a throwaway worktree, verifies the premise, writes `.stories/<id>.md` at `status: draft` | commit, implement, touch any other file |
| builder | `launch.sh`: `claude -p`, tools Read/Write/Edit/Grep/Glob/Bash | `BUILDER_MODEL`, default `claude-sonnet-4-6`; a story's `model:` overrides it | implements the story under mandatory TDD in `../wt-<id>`, commits per task, hands `ACn-tdd-*.patch` + `.test` to `.review-out/mutations/`, runs `check-mutation.sh` on it before finishing | write under `.fleet/` or a `scope_deny` path; guess at a decision the story does not make (it writes `.blocked/<id>.md` and stops) |
| reviewer | `launch.sh`: `codex exec --json` | codex's default, or `REVIEWER_MODEL` | in a clean worktree at the builder's head: reads files, runs the suite, writes one mutation per AC and optional probes, ends with `VERDICT: PASS\|FAIL\|SPEC` | leave the tree dirty (the run stops) |
| the machine | `launch.sh`, `ts/src/classifier.ts` through `mutation.sh` | none | baseline, scope, applies every mutation, runs every probe, computes the verdict | grant a PASS the reviewer did not give |
| the coordinator (optional) | an interactive agent session on any harness, guided by `skills/` | any | intent, draft review, hand edits, reading verdicts, deciding what follows, maintaining the harness | promote, land, launch, deploy, touch tokens |
| the human | terminal or phone | — | promotes, lands, answers blocks, deploys, holds every token | — |

The reviewer's checks are also in the builder's rules since 22 Sep: which
instrument proves each criterion, whether it asserts what the criterion
claims, deleting the behaviour outright, and the edge case a probe would
construct. The builder sees the attack before it faces it.

## Story versus epic

A **story** is one file, `.stories/<id>.md`, and the only specification the
agents get. An **epic** is a branch named `epic/<name>` and nothing more;
stories name it with `base:` and `status.sh` derives everything else from
git. The name is enforced where a story is born: `write-story.sh --base`
takes only `epic/*`, `lint-story.sh` rejects any other base, and
`new-epic.sh` is the one way an epic branch is created.

The frontmatter, read by every script:

| key | who writes it | meaning |
|---|---|---|
| `status` | the writer, the human, the launcher | `draft` → `ready` → `in_progress` → `done` \| `blocked` \| `needs_human` |
| `round` | the launcher | rounds run so far; `MAX_ROUNDS` (default 2) more per launch |
| `base` | the writer | `epic/<name>`, or absent for the integration branch |
| `scope_deny` | the writer | space-separated globs the builder must not touch; deny-only; `.fleet/*` always |
| `model` | the coordinator | the builder's model for this story alone |
| `merged` | `merge.sh` | the merge commit's sha, for `revert.sh` and `status.sh` |

The body follows `.stories/TEMPLATE.md`: Symptom, Evidence, Acceptance
criteria, Known weakness of the instrument, Human verification, Out of
scope. Each criterion is headed `**ACn — <claim>.**` at column 0 (a grep
extracts them; a table is invisible), names the instrument that proves it,
and names the change that turns that instrument red. No criterion says the
suite, build or lint stays green — the baseline is unconditional.

Ids are three digits and ascend in run order: the queue takes the lowest
`ready` first. The next story is drafted only when the previous one reads
`on epic`, because the writer reads the epic's tip.

How each lands:

| what | to | by whom | command |
|---|---|---|---|
| story on an epic | its epic | the queue, on a computed PASS | `merge.sh <repo> <id>` |
| story on the integration branch | the integration branch | a human | `merge.sh <repo> <id> --land` · `/merge <repo> <id>` |
| epic | the integration branch | a human | `merge.sh <repo> --epic epic/<name>` · `/merge <repo> epic/<name>` |
| main / master | — | nobody, ever | refused with or without `--land` |

Every merge runs the suite, build and lint on the **merged** result in a
throwaway worktree and pushes only if that is green (`MERGE_MODE=direct`).
A repo can instead ask for a request on its host (`MERGE_MODE=pr`, below).

### What STATUS means

`status.sh` shows a **landing state**, derived from git and the computed
verdict on every run and never stored. The frontmatter `status:` is the
launcher's word; the landing state says what became of a `done` story's code:

| shown | meaning | what it needs |
|---|---|---|
| `draft` `ready` `in_progress` `blocked` `needs_human` | the frontmatter status, as is | the pipeline, or a human (`/promote`, `/answer`) |
| `awaiting merge` | `done`, computed PASS, branch still there, nobody merged it | a human: `merge.sh <id> --land` or `/merge <repo> <id>` |
| `on epic` | `done` and merged into its epic, which is not yet in the integration branch | the epic to land: `/merge <repo> epic/<name>` |
| `landed` | `done` and its code is in the integration branch — its branch, or the `merged:` sha in its frontmatter, is an ancestor of it | nothing |
| `done` | `done` and none of the above: a FAIL nobody merged, **or** a story merged by hand whose branch is gone and whose `merged:` sha was never recorded | nothing, or a `merged: <sha>` line if you want it to read `landed` |

The machine claims only what it can prove: a story whose code is in the
integration branch but whose evidence was deleted reads `done`, not
`landed`.

## The verdict

The reviewer's `VERDICT:` line is one input; `launch.sh` computes the
result and writes it as line 3 of `.review/<id>.md`, with a `### Machine`
block per round.

```
machine_pass := baseline green — test, build, lint, run by the harness
             ∧ every **ACn in the story has ≥1 mutation in .review-out/mutations/
             ∧ every mutation is RED when the harness runs it
             ∧ no probe is RED
final        := SPEC  if the reviewer said SPEC
             |  PASS  if machine_pass and the reviewer said PASS
             |  FAIL  otherwise — every failing condition is on the `computed:` line
```

A mutation is `ACn-<slug>.patch` (a `git diff`) with a `.test` (vitest
selector) or `.cmd` (any command) beside it, under `.review-out/mutations/`.
The reviewer writes at least one per criterion; the builder writes its own
as `ACn-tdd-<slug>` — the failing test it observed, handed over instead of
described. The harness runs every one in a clean tree with the classifier
in `ts/src/classifier.ts` (bash reaches it through `mutation.sh`):

| class | meaning | who fixes it |
|---|---|---|
| `RED` | the mutation was caught — the only good answer | — |
| `GREEN` | it survived: no instrument asserts that behaviour | the builder: a real test |
| `PRE_RED` | the selector already fails before the mutation | the builder's test, or the base |
| `SELECTOR_INVALID` | the selector names no test (wrong path, wrong `-t`, a shell command in a `.test`) | whoever wrote it |
| `PATCH_INVALID` | the patch does not apply to the head | the patch was made before the last commit |
| `NO_TESTS` | the mutation broke compilation | the mutation, not the test (L-08) |
| `NO_SELECTOR` | no `.test` or `.cmd` beside the patch | whoever wrote it |
| `ACn has no mutation` | no patch for that criterion at all | the reviewer, or a criterion nothing can instrument |
| `probe <name> RED` | the reviewer's edge case fails on the head | the builder; the probe is committed and becomes the instrument |

A **probe** is the inverse of a mutation: a test the reviewer leaves in
`.review-out/probes/`, run by the harness against the tree as it stands. A
failing probe fails the story whatever the `VERDICT:` line says, and is
committed so it can become the next round's instrument.

`SPEC` means a criterion no implementation can satisfy; it is immune to the
veto, ends the rounds, and goes to a human. `UNPARSEABLE` is the launcher's
word for a reviewer that ended without a verdict line; it is not-PASS.

**`check-mutation.sh <repo> <patch…> [--wt <dir>]`** runs the same
classifier on a tree someone is still working in — the builder's worktree,
or a human's checkout. It refuses an uncommitted tree, applies each patch,
runs its selector, undoes the patch with `git apply -R`, prints the class
the verdict would print, and exits 0 only when every patch is RED. The
builder's rules tell it to run this on `.review-out/mutations/AC*-tdd-*.patch`
before finishing, so an invalid selector or a stale patch is found before
the round ends, not after. `prompts/README.md` is the full contract.

Evidence per round is committed to `.review/<id>/round-N/`: `baseline/`,
`scope.txt`, `mutations/` (every patch, selector and `.result`), `probes/`,
`reviewer.md`, `builder.md`. Raw runner output stays machine-local in the
target's `.runs/`.

## Watching it

Every view below is read-only and safe while a round is running.

```bash
cd ~/work/fleet
bash status.sh khaita                  # the epics, then every story — landing state, round, verdict
bash status.sh khaita 013              # one story, with its latest round's Machine block
journalctl --user -u fleet-queue -f    # the queue's drains, live (Ctrl-C to leave)
journalctl --user -u fleet-bot -f      # the bot's polls and the commands it answered
ls -t ~/work/khaita/khaita-app/.runs/ | grep ^013 | head       # raw output, newest first
tail -f ~/work/khaita/khaita-app/.runs/013-round1-*.log        # a mutation being run
```

A story's row says `RUNNING` while something is live in its worktree. From
the phone, `/status <repo>` is the first command above and `/why <repo>
<id>` is the Machine block.

## Commands

Every entry point names its repo first. The phone forms are Telegram verbs
answered by `telegram.sh poll` every minute.

| at a terminal | from the phone | what |
|---|---|---|
| `status.sh <repo> [id]` | `/status <repo>` | the epics, then the stories. The phone form hides `landed` and `done` |
| `status.sh <repo> --bot --all` | `/status-all <repo>` | the same, hiding nothing |
| | `/repo` · `/help` | the repos this bot knows · the verbs, grouped |
| `status.sh <repo> --json` · `--epics` · `--bot` | | for machines · the epic block only · the phone form |
| `write-story.sh <repo> <id> "<intent>" [--base epic/<name>]` | | intent → draft story, linted |
| `lint-story.sh <repo> <id> [--strict]` | | citations against the story's base, AC headings, legal base |
| `new-epic.sh <repo> <name>` | | `origin/epic/<name>`, cut from the integration branch |
| edit `status: ready` | `/promote <repo> <id>` | into the queue |
| `run-queue.sh <repo>` · `--all` | `/run` | drain the queue now instead of at the next timer |
| `launch.sh <repo> <id>` | | one story, one launch; detached, never inside a session |
| `status.sh <repo> <id>` | `/why <repo> <id>` | the latest round's machine block |
| answer in `.blocked/<id>.md`, set ready | `/answer <repo> <id> <text>` | unblock a story |
| `check-mutation.sh <repo> <patch…> [--wt <dir>]` | | the verdict's classifier on a working tree |
| `merge.sh <repo> <id> --land` | `/merge <repo> <id>` | a develop story → the integration branch |
| `merge.sh <repo> --epic epic/<name>` | `/merge <repo> epic/<name>` | an epic → the integration branch |
| `revert.sh <repo> <id>` | `/revert <repo> <id>` | undo a story's merge into its epic |
| `reset.sh <repo> <id> [--force] [--draft]` | | back to the queue |
| `install-skills.sh` | | link `skills/` into `~/.claude/skills` and `~/.codex/skills` |
| `test-lib.sh [substring]` | | the harness's own suite |

A merge from the phone is detached: the bot acknowledges it immediately and
sends the result when it ends. It has to be — the merge installs deps and runs
the whole post-merge baseline, and the poll that answers the command is a
systemd oneshot with a two-minute start timeout, which killed khaita's epic
merge mid-flight on 22 Sep 2026. At a terminal `merge.sh` is synchronous.

Run a launcher detached, never as a child of an interactive agent session:

```bash
cd ~/work/fleet && setsid nohup bash -c 'bash launch.sh khaita 0NN; echo "exit=$?"' > log 2>&1 < /dev/null &
```

## What a target provides

`repos/<name>.env` here holds `REPO_PATH=/abs/path` and nothing else. The
target itself carries, on its integration branch:

```
.fleet/config        sourced by lib.sh:load_repo — every key below
.fleet/rules.md      optional, REPO_RULES: rules rendered into the builder's prompt
.stories/TEMPLATE.md the shape a story takes; write-story.sh gives it to the agent
.stories/ .review/ .blocked/   committed fleet state
.runs/ .review-out/            machine-local, gitignored
AGENTS.md → CLAUDE.md          the same instructions under the name Codex reads
```

`.fleet/config` is env-style and sourced; a variable already in the caller's
environment wins over the file; a missing required key is a `die`.

| key | required | meaning |
|---|---|---|
| `BASE_BRANCH` | yes | the integration branch (`develop`); fleet state lives only here |
| `INSTALL_CMD` | yes | run in every fresh worktree (`npm ci`) |
| `VITEST_CMD` | yes | must accept `<selector> --reporter json --outputFile <f>` and write vitest's JSON shape; the baseline and the classifier read it |
| `BUILD_CMD` `LINT_CMD` | yes | the rest of the baseline |
| `SEED_FILES` | stated, may be empty | untracked files copied into every worktree (`.env.local`) — never a token |
| `PROBE_DIR` | yes | where a reviewer's probe lands, inside the suite's include glob |
| `REPO_RULES` | no | markdown file rendered into the builder's rules as `{{REPO_RULES}}` |
| `MERGE_MODE` | no, default `direct` | `direct`: merge, post-merge baseline, push. `pr`: push the branch, run `PR_CMD` |
| `PR_CMD` | with `pr` | see below |

khaita's `.fleet/rules.md` carries the deploy prohibition and the test
environment's known traps (no `result.all` in @testing-library/react 16,
no SSR test that sets `window = undefined`, no `Date.now()` for uniqueness,
read an unfamiliar API's type in `node_modules` first). Every khaita builder
gets them through `REPO_RULES`.

### `PR_CMD`

Run by `merge.sh` in the target checkout, non-interactive, with the source
branch **appended** as the last argument and `PR_SOURCE` / `PR_TARGET` in
its environment; whatever it prints — the request's URL — is the reply.
Nothing is merged and nothing recorded: the host merges, and `status.sh`
derives `landed` from origin afterwards. The flags come from
`glab mr create --help` / `gh pr create --help` (gh 2.101, glab 1.118):

```bash
MERGE_MODE=pr
PR_CMD='glab mr create --fill --yes --remove-source-branch --target-branch "$PR_TARGET" --source-branch'
# or, on GitHub:
PR_CMD='gh pr create --fill --base "$PR_TARGET" --head'
```

`gh` and `glab` live in `~/.local/bin`; their tokens are the human's, kept in
the CLIs' own config files, never in `.env.fleet` or a target.

## Adding a repo

1. `repos/<name>.env` with `REPO_PATH`. Two repos may not share a parent
   directory (their `../wt-<id>` worktrees would collide); `load_repo` refuses.
2. In the target, on its integration branch: `.fleet/config` with every key
   above, `.stories/TEMPLATE.md`, `.gitignore` entries for `.runs/`,
   `.review-out/` and the seed files, and a `PROBE_DIR` the suite collects.
3. `bash status.sh <name>` — it loads or says which key is missing.
4. `bash new-epic.sh <name> <epic>`, then `write-story.sh … --base epic/<epic>`.

## The coordinator — optional

**The fleet does not need a coordinator.** Everything from `ready` to
`on epic` is the queue's, and a human alone can run the rest:
`write-story.sh` drafts and lints a story from one sentence, the human
reads and promotes it, the queue does the work, `/status` and `/why` say
what happened, `/answer` and `/merge` finish it. The coordinator is
optional help for what takes judgment — phrasing the intent, reviewing the
draft against the code, reading a FAIL and deciding what follows,
maintaining the harness. Use one when that help is worth the tokens; skip
it and nothing changes in the pipeline.

When one is used, its procedures are five skills in `skills/<name>/SKILL.md`, written for any agent: actions
rather than tool names, the reason beside every rule. Claude Code and Codex
read the same `name:`/`description:` frontmatter, so one set of files serves
both; `bash install-skills.sh` links them into `~/.claude/skills/` and
`~/.codex/skills/`. `AGENTS.md` is `CLAUDE.md` under the name Codex reads.

| skill | when |
|---|---|
| `fleet-coordinate` | orientation, what only a human does, the rules for a coordinator of any model, routing |
| `fleet-story` | a wish → intent → `write-story.sh` → the draft review → `lint-story.sh --strict` → commit |
| `fleet-verdict` | the Machine block and the evidence; the decision tree for FAIL, `needs_human`, `blocked`, `UNPARSEABLE`, `SPEC` |
| `fleet-land` | landing states, who merges what, cleanup after a failed merge, `revert.sh`, `reset.sh` |
| `fleet-develop` | changing the harness |

Three rules make a coordinator safe whatever model runs it. It **starts no
launcher** — a promoted story is taken by the queue timer within fifteen
minutes or by a human's `/run`, which is also what lets a sandboxed harness
coordinate at all. It **promotes nothing and lands nothing**; it ends by
naming the command. It **never touches tokens**.

`docs/COORDINATORS.md` has the Codex recipe, the `model_providers` template
for other providers, and the trial protocol; `docs/coordinator-trials.md`
records each trial — harness, model, story, lint result after the
coordinator's own review, hand edits needed, rounds to PASS, and any
attempt at a human-only action. The story commit carries a
`Coordinator: <harness>/<model>` trailer.

## What needs a human

- Promoting a story to `ready` — reading it is the review that matters.
- Landing an epic, or a develop story, on the integration branch.
- Answering `.blocked/<id>.md` and `needs_human` stops; the notification
  carries the command that answers it.
- Deploying: in khaita, `npm run deploy` and every `firebase` command.
- Installing the systemd units and enabling lingering (`systemd/README.md`).
- Tokens: the bot's in `.env.fleet` (mode 600), `gh`/`glab` logins, any
  provider key for another coordinator model.

## Seams

Fleet-level, `${X:-default}` in the scripts, set in the caller's environment:

| seam | default | meaning |
|---|---|---|
| `BUILDER_MODEL` | `claude-sonnet-4-6` | the builder; a story's `model:` overrides it |
| `STORY_MODEL` | `claude-opus-5` | the story writer |
| `REVIEWER_MODEL` | empty | empty keeps codex's own default; set, `codex exec -m`; recorded as `reviewer:` in the Machine block |
| `MAX_TURNS` | 60 | the builder's and writer's turn ceiling |
| `MAX_ROUNDS` | 2 | rounds per launch before `needs_human` |
| `AGENT_TIMEOUT` | 1800 | seconds per agent call; a hung agent is killed and the story goes to a human |
| `REVIEW_ONLY` | 0 | 1 re-reviews the head without a builder — for a `needs_human` that was a spec defect |
| `AUTO_MERGE` | on | the queue merges a computed PASS into its epic |
| `PUSH_STATUS` | 1 | 0 to work offline |
| `FLEET_NOTIFY_CMD` | `telegram.sh send` | how the fleet reaches a human |
| `FLEET_LOCK_WAIT` `QUEUE_START_CMD` `FLEET_REGISTRY_DIR` | | the lock, how the bot starts a drain, where the registry is |

Worktrees are siblings of the target: `../wt-<id>` for a builder,
`../wt-<id>-review` for the reviewer, `../ws-<id>` for the story writer,
`../merge-<name>` for a merge. All are throwaway.

## Tests and working rules

`bash test-lib.sh` runs the suite (fake agents in `test/`, re-executed under
`env -i`); its last line is the count. Green before every commit; a case
that has never been observed red is not a case — a new feature is red
because it is absent, a characterisation is red by running it against a
copy with the block deleted (`FLEET_LAUNCH_OVERRIDE`, `FLEET_RENDER_OVERRIDE`,
`FLEET_LIB_OVERRIDE`; `FLEET_TS_OVERRIDE` lays a directory over `ts/src/`).
The TypeScript side has its own unit tests beside the code: `cd ts && npm ci
&& npm run check && npm test`, green before every commit too; nothing under
`ts/` needs `node_modules` at run time, so the live checkout never runs
`npm`. The checkout at `~/work/fleet` is live — the timers
execute it — so every change is made in a worktree and fast-forwarded in
when both units are inactive. Never edit `launch.sh` while a launcher is
running it. `die` over `warn`. Prompts on stdin, never argv. One task, one
commit. `docs/lessons.md` holds the rest.

## Where things are

```
lib.sh              FLEET_HOME, load_repo, the frontmatter reader, procs_in_worktree, log/warn/die
launch.sh           the launcher              run-queue.sh   the drain
mutation.sh         the classifier's bash face check-mutation.sh  the same classifier, on a working tree
ts/                 the TypeScript side: src/classifier.ts, src/lib/, src/bin/mutation.ts — run by node as is, no build
.nvmrc              the Node the units pin    docs/plans/2026-09-23-typescript-migration.md  the seams
write-story.sh      intent → story            lint-story.sh  mechanical checks against the story's base
new-epic.sh         an epic branch            status.sh      what the fleet is doing
merge.sh            story → epic, --land, --epic, MERGE_MODE
revert.sh           undo a story's merge      reset.sh       back to the queue
telegram.sh         send | poll — the notifications and the phone commands
render.sh           render_prompt()           prompts/       the agents' prompts, README = the verdict contract
skills/             the coordinator's procedures, linked by install-skills.sh
test-lib.sh         the suite                 test/          fake claude, codex, vitest, curl, npm
systemd/            the two timer pairs       docs/          handoff, lessons, coordinators, trials, plans
AGENTS.md → CLAUDE.md   the same rules for Codex and Claude Code
```
