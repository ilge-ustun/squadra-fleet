# Fleet handoff — state as of 25 Sep 2026

Autonomous coding-agent fleet. Its first and so far only target is
`khaita-app`. Supersedes every earlier handoff. `README.md` is the map,
this file is the state, `docs/lessons.md` (L-01 … L-30) the reasons,
`docs/COORDINATORS.md` the coordinator on other harnesses and models.

**Orient by running things, not by trusting this file.** Numbers in prose rot
(L-11). The commands that produce them:

```bash
cd ~/work/fleet
bash status.sh khaita --bot --all     # every story: landing state, round, computed verdict
bash test-lib.sh                      # the harness's own suite; the count is on its last line (916 on 25 Sep)
git log --oneline -15
git -C ~/work/khaita/khaita-app log --oneline develop -15
systemctl --user is-active fleet-bot.service fleet-queue.service
```

## What happened since the 20 Sep handoff

- **21–22 Sep — `epic/pwa` built and landed.** Stories 012, 015, 016, 017,
  018, 019 (the service worker rewritten: no more wrong-document fallback,
  songs render offline from cached data with provenance, the 4 s timer
  gone, a generated worker with a build id and versioned caches). Landed
  into `develop` at `0450c02` with a green post-merge baseline. `epic/pwa`,
  `epic/offline-pwa`, `epic/ui-polish` are all in `develop`.
- **22 Sep — two fleet defects found in the field and fixed.**
  `lint-story.sh` resolved citations against the checkout, not the story's
  base (case 98). `/merge` from the phone ran inside a two-minute systemd
  oneshot and was killed mid-flight, leaving worktrees behind; it now
  detaches and answers when done (case 99).
- **22 Sep — the `/insights` report, checked against every verdict.** Its
  patch-mechanics advice was already structural here; what cost rounds was
  the builder never seeing the reviewer's attack (20 of 24 FAIL rounds since
  007 were probes RED or mutations surviving). Landed: `mutation.sh` +
  `check-mutation.sh` (cases 100, 101), the reviewer's checks and the
  verdict vocabulary in the builder's rules (102), `REVIEWER_MODEL` (103),
  khaita's test-environment traps in `.fleet/rules.md`.
- **22 Sep — the coordinator as skills.** Five harness-neutral
  `skills/*/SKILL.md`, `install-skills.sh` (case 104), `AGENTS.md → CLAUDE.md`
  in both repos, `docs/COORDINATORS.md`, `docs/coordinator-trials.md`. Both
  Claude Code and Codex list the five. The coordinator is optional; the
  fleet is autonomous from `ready` to `on epic`.
- **22 Sep — `README.md` rewritten** as the complete documentation.
- **23 Sep — decision: the harness migrates to TypeScript**, one seam at a
  time. §9. The same day, seam 1 — the classifier — was built on branch
  `ts-classifier` (worktree `../fleet-wt-ts-classifier`), **not landed**:
  the human lands it. Seam 2 — the verdict rule and the round section of
  `.review/<id>.md`, `ts/src/lib/verdict.ts` and `machine-block.ts` — followed
  on the same branch the same day, with the probe runner's silent PASS
  closed on the way. Seam 3 — `status.sh` and `check-mutation.sh` as
  wrappers over `ts/src/bin/status.ts` and `mutation.ts check`, with
  `ts/src/lib/config.ts` running `load_repo` for the TypeScript side —
  followed the same day. Seam 4 — `launch.sh` as a wrapper over
  `ts/src/bin/launch.ts`, the story loop in Node with the agents still the
  `claude` and `codex` CLIs (the SDKs were weighed and declined: bundled
  binaries, runtime dependencies, the fakes could no longer shadow) — the
  same day, proven by the suite and a 26-scenario old-versus-new diff.
  Its plan review found that `render.sh` had been corrupting every `&` in
  a prompt (bash 5.2's `patsub_replacement`; four khaita stories carried
  it); fixed on both sides, L-28. `mutation.sh` and `bin/verdict.ts` are
  gone. **24 Sep — the migration continues**, reversing the "stays bash
  indefinitely" line for the remaining scripts, after the fleet's first
  real stories ran on the TypeScript side. Seam 5 — `merge.sh`, `revert.sh`,
  `reset.sh` — landed the same day, L-29 (a redirect into a directory that
  may not exist), then a same-day follow-up fixing `--land` on a checked-out
  base. Seam 6 — `run-queue.sh` — landed the same day: `nextReady` unified
  between the launcher and the queue (they had disagreed on `TEMPLATE.md`;
  a real bug, not hypothetical — L-30). `docs/plans/2026-09-23-typescript-migration.md`
  is the plan for every seam and the record of each built one.
- **24 Sep — haiku retired as a builder model** (PR #6): 0 of 2 round-1
  passes; `model:` accepts `sonnet`, `opus`, `fable`.
- **24–25 Sep — `epic/ui-a11y` built on the TypeScript fleet.** Stories 020,
  021, 022 and 025 all computed PASS and are merged into the epic; the
  epic itself waits for a human `/merge` (§6).
- **25 Sep — seam 7, story authoring** (PR #8): `lint-story.sh`,
  `new-epic.sh`, `write-story.sh` as wrappers; `render.sh` retired. The
  same day all three ran live against khaita for the first time
  (`epic/search` created, stories 024 and 026 drafted), clean (PR #9).
- **25 Sep — seam 8, `telegram.sh`** (PR #10), the last numbered seam. The
  suite gained a fake Bot API (`test/telegram-api.mts`) because Node's
  `fetch` bypasses the fake-on-PATH trick; `test/curl` is gone. The
  old-vs-new differential found a real bug in the bash bot: every `--pre`
  message with an angle bracket was invalid HTML that Telegram refused,
  silently (L-28's mechanism, recorded there). **The migration is
  complete**: every command is TypeScript; `load_repo`, `test-lib.sh` and
  the systemd units stay bash by decision.

Fleet `main` is at `bb8c36f` (PR #10), suite 916, 538 unit tests, both
units inactive at the last fast-forward; the live bot polled clean on the
new code. khaita `develop` is at `6ae4858`.

---

## 0. Where things live

The fleet is its own repository, `~/work/fleet`
(`github.com/ilge-ustun/squadra-fleet`), and takes any repo it is pointed
at. It is **never itself a target**. The checkout is live: the timers run it.

```
~/work/fleet/
  lib.sh                 FLEET_HOME, load_repo (the .fleet/config contract), log/warn/die for the wrappers
  launch.sh              the launcher — wrapper over ts/src/bin/launch.ts
  check-mutation.sh      the classifier on a working tree (a builder's, or yours) — wrapper over `mutation.ts check`
  status.sh              what the fleet is doing — wrapper over ts/src/bin/status.ts
  merge.sh               story → epic, --land, --epic, MERGE_MODE — wrapper over ts/src/bin/merge.ts
  revert.sh reset.sh     undo a story's merge; a story back to the queue — wrappers over ts/src/bin/{revert,reset}.ts
  run-queue.sh           drain every ready story, --all, --max — wrapper over ts/src/bin/run-queue.ts
  lint-story.sh          mechanical checks before any agent runs — wrapper over ts/src/bin/lint-story.ts
  new-epic.sh            origin-only epic branch creation — wrapper over ts/src/bin/new-epic.ts
  write-story.sh         intent → draft story, one agent — wrapper over ts/src/bin/write-story.ts
  ts/                    the TypeScript side: src/launch.ts (the story loop), src/merge.ts, src/revert.ts, src/reset.ts,
                         src/run-queue.ts, src/lint-story.ts, src/new-epic.ts, src/write-story.ts, src/classifier.ts,
                         src/status.ts, src/status-views.ts, src/telegram.ts, src/lib/{agents,render,baseline,scope,
                         evidence,vitest-json,result-summary,verdict,machine-block,review,frontmatter,config,env-file,
                         lock,git,proc,procs,log,die,exit-hooks,telegram-api,types}.ts, src/bin/{launch,merge,revert,
                         reset,run-queue,lint-story,new-epic,write-story,mutation,status,telegram}.ts;
                         run by node as is, no build, no runtime deps; fixtures/ hold the goldens and their generators
  .nvmrc                 v24.20.0 — the Node the systemd units carry on PATH
  telegram.sh            send | poll — the notifications and the phone commands — wrapper over ts/src/bin/telegram.ts
  prompts/               rules, build-round1/2, build-after-spec, review, write-story, README
  skills/                fleet-coordinate, fleet-story, fleet-verdict, fleet-land, fleet-develop
  install-skills.sh      links skills/ into ~/.claude/skills; Codex reads .agents/skills (→ skills/) in this repo only
  test-lib.sh test/      the suite and the fakes (claude, codex, vitest, npm; telegram-api.mts, the fake Bot API)
  systemd/               the two timer pairs, live since 20 Sep
  repos/<name>.env       the registry — REPO_PATH=/abs/path and nothing else
  .env.fleet .bot-offset machine-local, gitignored: the bot's token and cursor
  AGENTS.md → CLAUDE.md  the same rules for Codex and Claude Code
  docs/                  this file, lessons.md, COORDINATORS.md, coordinator-trials.md, plans/

<target>/.fleet/config       BASE_BRANCH INSTALL_CMD VITEST_CMD BUILD_CMD LINT_CMD SEED_FILES
                             PROBE_DIR, optional REPO_RULES MERGE_MODE PR_CMD
<target>/.fleet/rules.md     rendered into the builder's rules ({{REPO_RULES}})
<target>/.stories .review .blocked   committed state, on the integration branch
<target>/.runs .review-out           machine-local, gitignored
<target>/AGENTS.md → CLAUDE.md
```

Every entry point names its repo first. A variable in the caller's
environment wins over `.fleet/config`; a missing file or key is a `die`. Two
registered repos may not share a parent directory. `.fleet/*` is always
scope-denied to a builder.

**Runner contract, a limitation:** `VITEST_CMD` must accept
`<selector> --reporter json --outputFile <f>` and write vitest's JSON shape.
Another runner needs an adapter (§9 is where that adapter would be written).

---

## 1. Branches (khaita)

```
main
└── develop  6ae4858        ← integration. FLEET STATE LIVES HERE ONLY. The checkout sits here.
     ├── epic/offline-pwa   013            — in develop
     ├── epic/ui-polish     011            — in develop
     ├── epic/pwa           012, 015–019   — in develop at 0450c02
     ├── epic/ui-a11y       020–022, 025   — all merged into the epic; 12 commits ahead of develop, not landed
     ├── epic/search        024, 026       — both draft, and they contradict each other (§6)
     └── epic/shazam        nothing yet; a project, not a story
```

Epic branches carry product code only; a story branch never receives fleet
state, because the story text reaches the agents in their prompt. No
worktrees exist; nothing is in flight. **`develop` has not been deployed
since `epic/pwa` landed** — §6 item 1.

---

## 2. Infrastructure

**VPS:** Ubuntu 24.04, 2 CPU / 3.8 GB / 60 GB + 8 GB swap, `179.237.101.204`.
Users `ubuntu` (admin), `fleet` (agents, `~/work/khaita/khaita-app`), `hermes`.

**Installed under `fleet`:** Claude Code 2.1.282 (it updates itself), Codex
0.153.4, Node 24.20.0 under nvm (`.nvmrc`), flock (util-linux), jq (the
suite only), `gh` 2.101 and `glab` 1.118 in `~/.local/bin`. `gh` is logged
in to github.com (the fleet's own PRs); `glab` is not — the human's step,
§6. No Gemini CLI, no OpenCode, no local models (the RAM rules them out).

**Remotes and keys:** this repo pushes to `squadra-fleet` through a
write-enabled deploy key bound to the host alias `github.com-squadra-fleet`.
khaita keeps its GitLab deploy key. Deploy keys push; they cannot open a
request — that is what the `gh`/`glab` tokens are for.

**Memory, measured:** an interactive Claude Code session is ~530 MB; a Next
build peaks near 1.4 GB. **Never run a launcher as a child of the session
driving it** — the session's low-memory policy killed one mid-builder on
17 Sep. Detached, always:

```bash
cd ~/work/fleet && setsid nohup bash -c 'bash launch.sh khaita 0NN; echo "exit=$?"' > log 2>&1 < /dev/null &
```

A coordinator on any harness starts no launcher at all: it promotes, and
the queue timer or a human's `/run` does the rest.

---

## 3. The machine

### Pipeline

```
intent → write-story.sh <repo> <id> "<intent>" [--base epic/<name>]
           Opus 5, throwaway worktree at the epic's tip, writes .stories/<id>.md at draft
       → lint-story.sh <repo> <id> [--strict]
           citations resolved against the story's BASE; **ACn headings; base is BASE_BRANCH or epic/*
       → the coordinator (optional) reads, edits, lints, commits `story(<id>): draft`
       → a human sets status: ready — /promote <repo> <id>
       → the queue (every 15 min) → launch.sh <repo> <id>
           worktree ../wt-<id> from origin/<base>, SEED_FILES copied in
           builder: claude -p on stdin; rules carry the reviewer's checks, the verdict
             vocabulary, and `check-mutation.sh` to run on its own ACn-tdd-* evidence
           postcondition: commits or handed-over evidence; .blocked/ checked first
           reviewer worktree detached at the builder's head
           ★ BASELINE  ★ SCOPE
           reviewer: codex exec on stdin (REVIEWER_MODEL → -m); mutations + optional probes
           ★ tree clean apart from .review-out/, else needs_human
           ★ MUTATION RUNNER  ★ PROBE RUNNER (ts/src/lib/evidence.ts)  ★ COMPUTED VERDICT
       → .review/<id>.md + .review/<id>/round-N/ committed; a stop notifies with its command
       → merge.sh <repo> <id>   the queue, on a computed PASS, story → its epic (post-merge baseline)
       → a human: merge.sh --epic / <id> --land, or /merge from the phone (detached)
```

### The verdict

```
machine_pass := baseline green ∧ scope CLEAN ∧ every **ACn has ≥1 mutation
              ∧ every mutation RED ∧ no probe RED
final := SPEC if the reviewer said SPEC | PASS if machine_pass ∧ reviewer PASS | FAIL otherwise
```

**The machine can veto, never grant.** Classes: `RED` `GREEN` `NO_TESTS`
`PRE_RED` `SELECTOR_INVALID` `PATCH_INVALID` `NO_SELECTOR`; a probe RED
vetoes. The classifier is `ts/src/classifier.ts` (the launcher calls it
in-process); `check-mutation.sh <repo> <patch…> [--wt <dir>]` runs
it on a committed working tree, restores with `git apply -R`, exits 0 only
on all-RED. The Machine block records
`builder:` and `reviewer:` models.

### Seams

Fleet-level: `BUILDER_MODEL` (`sonnet`; a story's `model:`
overrides) `STORY_MODEL` (`opus`) `REVIEWER_MODEL` (empty = codex's
default) `MAX_TURNS` (60) `MAX_ROUNDS` (2) `AGENT_TIMEOUT` (1800) `PUSH_STATUS`
`REVIEW_ONLY` `AUTO_MERGE` `FLEET_NOTIFY_CMD` `FLEET_LOCK_WAIT` `QUEUE_START_CMD`
`FLEET_REGISTRY_DIR`. Per-target, from `.fleet/config`, no fleet default.

---

## 4. Unattended

`run-queue.sh --all --max 5` every 15 minutes: reaps orphans, runs every
`ready` story lowest id first, merges each computed PASS into its epic. A
stopped story does not stop the queue. Crash resume is tested (case 42).
`AGENT_TIMEOUT` wraps both agent calls. The bot polls every minute:
`/status /status-all /why /promote /answer /merge /revert /run /repo /help`;
only `TELEGRAM_CHAT_ID` is answered. `/merge` detaches and reports when the
post-merge baseline ends. Nothing in the notifier can fail a run.

---

## 5. Stories

Run `bash status.sh khaita --bot --all` rather than trusting this table.

| id | what | outcome |
|---|---|---|
| 002–003, 005–006, 008–010 | early fixes, the instruments, loading vs empty | landed on `develop` |
| 004 | offline collection loading | retired 18 Sep; findings extracted into 005/006/009 |
| 007 | `sw.js` had no instrument that could go red | landed over a FAIL by human decision, 8 rounds |
| 011 | theme toggle icons | `epic/ui-polish`, R1, in develop |
| 013 | offline chip stuck on | `epic/offline-pwa`, R1, in develop; the first auto-merge |
| 014 | the queue refreshes from origin | develop, R4 (round 3 was the harness's own bug, L-27) |
| 012 | the update banner and a build-stamped registration | `epic/pwa`, R8 — six rounds were reviewer probes |
| 015 | offline, an unvisited URL rendered another page's document | R5 |
| 016 | a song URL is a dead end offline though the device holds the song | R4, opus |
| 017 | the 4 s timer replaced by `fromCache`-driven states | R2, opus; the writer found the listener lacked `includeMetadataChanges` |
| 018 | a partially-held song shows what it has, with provenance | R2, opus |
| 019 | generated worker, build id, versioned caches | R2, opus; in develop at `0450c02` |
| 020 | the song page ends in two footers | `epic/ui-a11y`, R1, on epic |
| 021 | the theme switch sits under the hand that opened the side panel | `epic/ui-a11y`, R2, on epic |
| 022 | the tab bars cannot be reached or driven from the keyboard | `epic/ui-a11y`, R1, opus, on epic |
| 025 | the lyrics-language checkboxes forget what the user hid | `epic/ui-a11y`, R2, on epic |
| 024 | iPhone Safari: the search field never opens the suggestions | `epic/search`, draft |
| 026 | a misspelt song or singer name finds nothing | `epic/search`, draft; contradicts 024 |

Rounds per story since the builder's rules gained the reviewer's attack
(020–025, all run after 22 Sep): R1, R2, R1, R2 — against R2–R8 for the
`epic/pwa` stories before it. Four stories is not yet a trend.

---

## 6. What needs a human, in order

1. **Land `epic/ui-a11y`** — `/merge khaita epic/ui-a11y` (or `merge.sh
   khaita --epic epic/ui-a11y`). Four stories, all computed PASS; the
   post-merge baseline decides.
2. **Decide the order of 024 and 026** before promoting either: as drafted
   their tests disagree over the query `Mangalom`. khaita's
   `docs/fleet/backlog-search.md` says what to check, and 026 carries two
   product questions only a human can answer.
3. **Deploy khaita** — `npm run deploy` from `develop`, human only. This is
   the first deploy carrying the generated worker: expected on a phone that
   has the old build — the worker is replaced by byte comparison, the
   "new version available" banner shows, and `khaita-shell-v1` is retired on
   activation. If the banner does not show, story 019's Human verification
   section says what to look at.
4. **Log `glab` in** (`glab auth login --hostname gitlab.com --token`, a
   project token on khaita-app, `api` scope, Developer role), then
   `MERGE_MODE=pr` and the `PR_CMD` from `README.md` in khaita's
   `.fleet/config`, and one `/merge` to see the URL come back.
5. **The first coordinator trial on Codex.** Before it: from inside a
   `codex -C ~/work/khaita/khaita-app --add-dir ~/work/khaita --add-dir
   ~/work/fleet -s workspace-write -c sandbox_workspace_write.network_access=true`
   session, check once that `git push` and `bash write-story.sh` work. Then
   the protocol in `docs/COORDINATORS.md`; the row goes in
   `docs/coordinator-trials.md`. A good first intent: the asset cache in
   khaita's worker grows across deploys (item 6).
6. **Next khaita stories:** the unbounded asset cache (`khaita-assets` is
   never retired; 019's known follow-up); "shazam" needs decomposing.

---

## 7. Harness gaps still open

- **A lock around story selection.** A manual `launch.sh` and a queue drain
  can both claim the same story. The queue lock covers drains only.
- **Pre-commit hooks in the builder session** (second wave): a
  `PreToolUse` hook on `git commit` running `VITEST_CMD` would have saved
  019's round 1 (baseline test and build RED). Decide after a few stories
  show whether A2 already brought rounds down.
- **`.blocked/` has never fired from a builder** in nineteen stories; the
  writer escalates instead. Covered by `test-lib`, never exercised.
- **Lanes.** One. The trigger, stated in advance: ≥3 stories `ready` for a
  day and peak RSS under 1.2 GB per lane. Needs the selection lock first.
- **Codex quota.** `REVIEWER_MODEL` exists now; nothing falls back
  automatically when the reviewer's model is out of quota.
- **The bash ceiling** was the reason for §9, and seam 4 closed it for the
  launcher: no `die` inside `$(…)`, no `jq` parsing the CLIs, no
  edit-while-running hazard (`launch.sh` execs node, which loads everything
  first). What the bash had hidden and the port found: `render.sh`'s `&`
  corruption (L-28), the builder's non-JSON output going unwarned, the
  `.result` writer living in a CLI verb, a `TEMPLATE.md` a bare launch could
  pick (L-30). Seams 5-8 closed it for every other command: `merge.sh`,
  `revert.sh`, `reset.sh`, `run-queue.sh`, `lint-story.sh`, `new-epic.sh`,
  `write-story.sh` and `telegram.sh` (whose `--pre` escape was the last
  instance of L-28). No gap remains here.

---

## 8. Conventions worth preserving

- One task, one commit. `git status --short` with each. `bash test-lib.sh`
  green before every commit; a case observed red first.
- Edit the fleet in a worktree; fast-forward `main` only with both units
  inactive. Show the `ts/src/launch.ts` diff before applying it (editing
  it mid-run is safe since seam 4; it reaches the next launch).
- Every AC names its instrument and the mutation that turns it red. Bound
  the domain (L-20). Claim only what you instrument (L-25). State the
  instrument's weakness in the story.
- Read the current file, never a diff hunk (L-09). Prompts on stdin (L-18).
- A check that cannot go red is absent, not weak; a check that cries wolf is
  worse than none.
- Kill by cwd or exact name, never `pkill -f`. Never suppress stderr on a
  step that can fail meaningfully.
- Tokens are the human's: `.env.fleet` mode 600 at the fleet root, CLI
  logins in the CLIs' own config, never in a target or a repo.
- A coordinator starts no launcher, promotes nothing, lands nothing.

---

## 9. Future: migration to TypeScript

**Decision (the human's, 23 Sep 2026): the harness moves from bash to
TypeScript.** Reason: the fleet will mainly build web apps, and TypeScript
is the human's main language — one toolchain across harness and targets.

**For it:** one language and one toolchain (tsc, eslint, vitest) shared
with the targets, so a builder can be given a story about the harness
itself without switching worlds; compile-time types on the two agent event
streams and on verdict states — the class of bug the harness has actually
had; async and streams as the language default, which is what parallel
lanes need; the Anthropic and OpenAI agent SDKs in TS replace `claude -p |
jq` and `codex exec --json | jq`, contracts instead of parsed stdout; Node
is already on the box; the file is read whole before it runs, so the
edit-while-running hazard disappears.

**Against it:** ~2,700 lines of working, 644-assertion-tested bash would be
rewritten, and rewrites regress; Node must exist on every box that runs the
fleet, where bash always does; `subprocess`-style glue (git, npm, worktrees)
is one pipe in bash and several lines with `execa`; async stack traces are
harder to read than `set -x`; the pull of a framework that hides the
control flow the bash version makes explicit.

**Refined on 23 Sep, with the human, when seam 1 was built** (the full
plan and the record: `docs/plans/2026-09-23-typescript-migration.md`): no
`dist/` — Node 24 strips types as it loads, so bash calls
`node ts/src/bin/<name>.ts` and `tsc --noEmit` only type-checks; zero
runtime dependencies (`node:child_process`, `node:fs`), devDependencies
only, and the fixture copy excludes `ts/node_modules` so every suite run
proves it; and a correction — the suite runs scripts by absolute path into
a per-case copy, only the fakes come through `PATH`.

**How — not a rewrite:**

1. Keep `test-lib.sh` as the acceptance layer. It runs each script by
   absolute path into a copy of the tree, with fakes on `PATH`; a bash entry
   point of the same name that calls `node` passes the same cases
   unchanged. Add vitest unit tests beside the TS code.
2. One seam at a time, behind the existing contract, each landing green:
   the classifier (`mutation.sh` + `check-mutation.sh` — newest, most
   self-contained, and where a non-vitest runner adapter would live) →
   verdict computation and the Machine block → `status.sh` → `launch.sh`
   last, with the agent calls moved to the SDKs. (This step first said
   `telegram.sh`, `merge.sh`, `reset.sh`, `revert.sh` and the systemd side
   stay bash indefinitely; reversed on 24 Sep 2026 — the migration
   continues, seams 5–8 in `docs/plans/2026-09-23-typescript-migration.md`.
   `load_repo`, `test-lib.sh` and the units stay bash.)
3. No framework, no runtime dependencies; the control flow stays as
   readable as the bash it replaces.
4. Layout: `~/work/fleet/ts/` with its own `package.json`, run by `node`
   as is, reached through thin bash entries with the old names so nothing
   downstream (the bot, the units, the skills, the docs) changes.

**Status:** all four seams landed on `main` on 24 Sep 2026 (PR #1; the model
policy in PR #2, the first fixes in PR #3): the classifier, the verdict and
the round section, `status.sh` and `check-mutation.sh` with the config
loader, and the launcher. Seams 5–7 (`merge.sh`, `revert.sh`, `reset.sh`;
`run-queue.sh`; story authoring) landed 24–25 Sep (PRs #5, #7, #8); seam 8
(`telegram.sh`, the last numbered seam) landed 25 Sep (PR #10): the
migration is complete. Step 2's
"with the agent calls moved to the SDKs" was weighed at seam 4 and
declined, with the human: `@anthropic-ai/claude-agent-sdk` runs a 234 MB CLI
it bundles over a stream-json protocol, not the `claude` on PATH, and needs
three peer packages; `@openai/codex-sdk` pins its own `@openai/codex`; both
would put `node_modules` in the live checkout and in every fixture copy,
and the suite's fakes could no longer shadow the real binaries (L-14). So
the launcher spawns the CLIs from `ts/src/lib/agents.ts`, the one file an
SDK seam would replace; zero runtime dependencies hold. A seam 5 would
first have to show that the fakes can stand in through the SDKs'
executable-path options with their wire protocols, that subscription OAuth
works through the bundled CLIs, and what `npm ci` in the live checkout
costs. The next few stories should still measure A2's effect on rounds
(§5 has the first four).
