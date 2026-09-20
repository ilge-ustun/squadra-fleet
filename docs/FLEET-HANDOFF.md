# Fleet handoff — state as of 19 Sep 2026

Autonomous coding-agent fleet. Its first and so far only target is
`khaita-app`. Supersedes every earlier handoff. Read `docs/lessons.md`
alongside this — L-01 … L-27 hold the findings this only summarises.

**Orient by running things, not by trusting this file.** Numbers in prose rot
(L-11). The commands that produce them:

```bash
bash status.sh khaita             # every story: status, round, computed verdict, epic
bash test-lib.sh                  # the harness's own suite; the count is on its last line
git log --oneline -20
git -C ~/work/khaita/khaita-app log --oneline develop -20
```

---

## 0. Where things live (19 Sep 2026)

The fleet is its own repository, `~/work/fleet` (`github.com/ilge-ustun/squadra-fleet`),
and takes any repo it is pointed at. It is **never itself a target**.

```
~/work/fleet/                       the harness: scripts at the root, prompts/, test/, systemd/
  lib.sh                            FLEET_HOME, load_repo, the frontmatter reader, procs_in_worktree
  repos/<name>.env                  the registry — REPO_PATH=/abs/path and nothing else
  .env.fleet  .bot-offset           machine-local, gitignored: the bot's token and cursor

<target>/.fleet/config              the target's own settings, committed there, sourced by load_repo:
                                    BASE_BRANCH INSTALL_CMD VITEST_CMD BUILD_CMD LINT_CMD
                                    SEED_FILES PROBE_DIR, optional REPO_RULES (a markdown snippet
                                    rendered into the agents' rules)
<target>/.stories .review .blocked  committed state, on the target's integration branch
<target>/.runs .review-out          machine-local, gitignored in the target
```

Every entry point names its repo first: `launch.sh khaita 014`,
`status.sh khaita`, `merge.sh khaita 014`, `run-queue.sh khaita` or
`run-queue.sh --all`. Telegram commands too: `/promote khaita 013`. A
variable in the caller's environment wins over `.fleet/config`; a missing
file or key is a `die`. Two registered repos may not share a parent
directory (their `../wt-<id>` worktrees would collide) — `load_repo` refuses.
`.fleet/*` is always scope-denied to a builder, because the harness sources it.

**Runner contract, stated as a limitation:** `VITEST_CMD` must accept
`<selector> --reporter json --outputFile <f>` and write vitest's JSON shape
(`numTotalTests`, `numFailedTests`); the baseline and the mutation runner read
that. Another runner needs an adapter, not just a different command string.

---

## 1. Branches

```
main                        5a16624
└── develop                 ← integration. FLEET STATE LIVES HERE ONLY.
     │                        Fast-forwards to main. The checkout sits here.
     ├── epic/offline-pwa   ← stories 012, 013 target this
     ├── epic/search        ← nothing yet (items 4, 5 in §6)
     ├── epic/ui-polish     ← story 011 merged here
     └── epic/shazam        ← nothing yet; a project, not a story
          └── story/NNN     ← the launcher cuts these from the story's base:
```

`develop` carries `.stories/`, `.review/`, `.fleet/`. Epic branches carry
**product code only** — a story branch never receives fleet state, because
the story text reaches both agents in their prompt rather than as a file in
the worktree (§3). The harness itself is not in the target at all (§0). Epics drift from `develop` as fleet work
continues; that is normal and merges cleanly.

A story names its epic with `base:` in frontmatter. Omitted, it uses the
target's `BASE_BRANCH` (`develop`, in khaita's `.fleet/config`).

`develop` was brought up to date on 18 Sep with `git merge -s ours` from the
PWA line, **not** a force-push: its twelve stale commits (Feb–May 2026) stay
reachable, nothing was rewritten, and no `--force` was needed. `feat/pwa`
still exists, identical to `develop`.

---

## 2. Infrastructure

**VPS:** Ubuntu 24.04, 2 CPU / 3.9 GB / 60 GB + 8 GB swap, `179.237.101.204`.
Users `ubuntu` (admin), `fleet` (agents, `~/work/khaita/khaita-app`), `hermes`.

**Installed under `fleet`:** Claude Code 2.1.263 (`~/.local/bin/claude`),
Codex 0.153.4 and Node 24 under nvm, jq. Neither agent is on a systemd unit's
default PATH — `systemd/fleet-queue.service` sets it explicitly.

**Memory, measured:** an interactive Claude Code session on this host is
**~530 MB**; Hermes ~694 MB; system ~120 MB. ~1.4 GB is committed before the
fleet starts and a Next build peaks near 1.4 GB. **Never run the launcher as a
child of the session driving it** — the tool's own low-memory policy killed one
mid-builder on 17 Sep. Detached, always:

```bash
cd ~/work/fleet && setsid nohup bash -c 'bash launch.sh khaita 0NN; echo "exit=$?"' > log 2>&1 < /dev/null &
```

Two agents plus a Next build at once left ~1.0 GB free. It held, but only just.

---

## 3. The machine

### Pipeline

```
intent (a sentence)
  → write-story.sh <repo> <id> "<intent>"
                          Opus 5, read-only worktree at the epic's tip,
                          writes .stories/<id>.md at status: draft
  → lint-story.sh <repo> <id>
                          mechanical: cited paths exist and lines are in range,
                          ACs are **ACn-headed, base: is a real branch; warns on
                          an unquantified every/all/any and on baseline ACs
  → a human reads it and sets status: ready
        — at a terminal, or /promote <repo> <id> from a phone
  → launch.sh <repo> <id>  (or run-queue.sh <repo>|--all for the whole queue)
       zero **ACn headings → needs_human before any agent runs
       worktree ../wt-<id> cut from origin/<base:>, SEED_FILES copied in
       builder (claude -p, prompt on stdin, AGENT_TIMEOUT)
         → hands over .review-out/mutations/ACn-tdd-*  (its "observed red")
       postcondition: commits OR handed-over evidence; .blocked/ checked first
       clean reviewer worktree detached at the builder's head
       ★ BASELINE   VITEST_CMD (JSON) / BUILD_CMD / LINT_CMD → evidence
       ★ SCOPE      changed paths vs scope_deny globs, .fleet/* always → evidence
       reviewer (codex exec, prompt on stdin, AGENT_TIMEOUT)
         → .review-out/mutations/ACn-* and optional .review-out/probes/*
       ★ reviewer's tree must be clean apart from .review-out/, else needs_human
       ★ MUTATION RUNNER  per patch: pre-run green? apply, run, classify,
                          restore, verify clean
       ★ PROBE RUNNER     each probe run against the tree as it stands
       ★ COMPUTE VERDICT
  → .review/<id>.md + .review/<id>/round-N/ committed with the status
       stopped (needs_human | blocked) → the launcher notifies, with the
                                          command that answers it
  → merge.sh <repo> <id>   (the QUEUE calls this on a computed PASS; a
                            hand-run launcher never changes a branch)
       refuses anything but a computed PASS on an epic/* base
       merges in a throwaway worktree, runs the baseline on the MERGED result,
       and pushes only if that is green
       → notifies: "merged → epic/x  ·  undo: /revert <repo> <id>"
  → a human merges the epic into the integration branch:
       merge.sh <repo> --epic epic/x    — same baseline, never automatic
```

### The verdict

```
machine_pass := baseline green ∧ scope CLEAN
              ∧ every **ACn has ≥1 mutation ∧ every mutation RED
              ∧ no probe RED
final := SPEC if the reviewer said SPEC
       | PASS if machine_pass ∧ the reviewer said PASS
       | FAIL otherwise, every failing condition named on `computed:`
```

**The machine can veto, never grant.** Mutation classes: `RED` (a real
failure), `GREEN` (survived — for that behaviour the instrument is absent),
`NO_TESTS` (zero collected: the mutation broke compilation; never RED),
`PRE_RED` (already failing unmutated), `SELECTOR_INVALID` (collected no tests
even unmutated), `PATCH_INVALID`, `NO_SELECTOR`. **A
probe is the inverse — RED means it found something, so RED vetoes.** Probes
are optional: requiring one is a check that cannot go red.

### Files

```
lib.sh                 sourced first by every script: FLEET_HOME, load_repo,
                       story_field/set_story_field, procs_in_worktree, log/warn/die
launch.sh              the launcher; <repo> --reap runs reap_orphans and exits
run-queue.sh           drains every ready story of <repo>, or --all; reaps first; --max N
write-story.sh         intent → draft story (STORY_MODEL, default claude-opus-5)
lint-story.sh          mechanical story checks; --strict makes warnings fatal
status.sh              read-only; one line per story, --json for machines
merge.sh               story → its epic, or --epic <name> → the integration
                       branch (a human's call); post-merge baseline before any
                       push; records the merge sha in the story
revert.sh              undoes that merge by story id
reset.sh               clears a story back to the queue; refuses if live or
                       unmerged without --force
telegram.sh            send | poll — the notification and the control plane
test-lib.sh            the suite; fake agents in test/; re-executes under env -i
render.sh              render_prompt(); {{STORY}} {{INTENT}} {{STORY_BASE}}
                       {{REPO_RULES}} {{VITEST_CMD}} …
prompts/*.md           rules, build-round{1,2}, build-after-spec, review,
                       write-story, README (the verdict contract)
repos/<name>.env       the registry (§0)
systemd/               two timer + oneshot pairs (queue, bot), NOT installed —
                       see its README, and .env.fleet for the bot's token
<target>/.fleet/       config (+ rules.md) — the target's side of the contract (§0)
<target>/.stories/<id>.md       spec; frontmatter status/round/base/scope_deny/model,
                                plus merged: written by merge.sh
<target>/.review/<id>.md        summary; `verdict:` on line 3; ### Machine per round
<target>/.review/<id>/round-N/  committed evidence: baseline, scope, mutations, probes,
                                reviewer.md, reviewer.stderr, builder.md/.json
<target>/.runs/                 raw JSON and logs — machine-local, gitignored
```

### Seams

Fleet-level, `${X:-default}` in the scripts: `BUILDER_MODEL` `STORY_MODEL`
`MAX_TURNS` `MAX_ROUNDS` `AGENT_TIMEOUT` `PUSH_STATUS` `REVIEW_ONLY`
`FLEET_NOTIFY_CMD` `AUTO_MERGE` `FLEET_LOCK_WAIT` `QUEUE_START_CMD`
`FLEET_REGISTRY_DIR`.

Per-target, from `.fleet/config` with **no** fleet-level default: `BASE_BRANCH`
`INSTALL_CMD` `VITEST_CMD` `BUILD_CMD` `LINT_CMD` `SEED_FILES` `PROBE_DIR`
`REPO_RULES`. The caller's environment overrides the file.

A story's `model:` overrides `BUILDER_MODEL` for that story alone.

`REVIEW_ONLY=1` skips the builder and the commit postcondition — for when
`needs_human` was a spec defect rather than a build defect. It earned itself
on story 008 the day it landed.

---

## 4. Unattended

`run-queue.sh <repo>` drains one repo's queue: reaps orphans first, runs every
`ready` story, and a stopped story does not stop the queue. Guards: `--max`
(default 20), and it stops if a story returns to `ready` without finishing.
`run-queue.sh --all` does that for every registered repo, one process each.

**Crash resume works and is tested** (`test-lib` case 42). A power cut leaves a
story at `in_progress` with a worktree holding the builder's commits; the next
drain reaps it, reuses the worktree, and continues rounds from the frontmatter
rather than restarting at one.

**`AGENT_TIMEOUT`** (1800s) wraps both agent calls in `timeout -k 30`. On
timeout the story goes to `needs_human` naming the timeout. Children may
outlive the kill (L-04) — the next run's `procs_in_worktree` finds them and
refuses to start, which is correct.

**Notifications and the control plane.** `telegram.sh` is both: the fleet
sends through `FLEET_NOTIFY_CMD` (the launcher when a story stops, the queue
when one merges), and reads commands back by polling `getUpdates` — a pull,
because the box has no public endpoint. Commands:
`/status <repo>` `/why <repo> <id>` `/promote <repo> <id>` `/answer <repo>
<id> <text>` `/revert <repo> <id>` `/run`. Only messages from `TELEGRAM_CHAT_ID` are acted on
and nobody else gets a reply at all. The token
goes in `.env.fleet` at the fleet repo root, never in a target — a target's
seed files are copied into every agent worktree.

Nothing in the notifier can fail a run. Unconfigured, it warns and returns 0.

**systemd** units are written and pass `systemd-analyze --user verify`, but are
**not installed** — now two pairs, `fleet-queue` (15 min) and `fleet-bot`
(1 min). Commands in `systemd/README.md`; one needs an admin
(`loginctl enable-linger fleet` — currently `no`, so units would die with the
ssh session), and the bot needs a @BotFather token before it does anything.

---

## 5. Stories

Run `bash status.sh khaita` rather than trusting this table.

| id | what | state |
|---|---|---|
| 002, 003 | favourite icon fill; mykhaita tab wrap | done, merged |
| 004 | offline collection loading | **retired 18 Sep** — superseded, not completed. Its three findings were extracted into 005/006/009; its remaining work rested on a primary-lease theory its own reviewer refuted from the SDK source and the browser evidence contradicts. See the story's Retired section. |
| 005 | Firestore persistence was never enabled | done by hand, `round: 0` |
| 006 | an empty snapshot wrote `undefined` | done |
| 007 | `public/sw.js` had no instrument that could go red | done, **merged over a FAIL** by human decision; reasons and per-round tallies in the story's Outcome section. 8 rounds. |
| 008 | argument-sensitive stubs | done, PASS in 3 |
| 009 | the collection page's test mocked away the collection | done, PASS in 1 |
| 010 | "still loading" vs "loaded and empty" | done, PASS in 3 |
| 011 | theme toggle icons | done, PASS in 1, **merged into `epic/ui-polish`** |
| 012 | "new version available" | **draft** — needs a decision, §6 |
| 013 | offline chip stuck on | **draft**, ready to promote |
| 014 | the queue refreshes from origin | done, **PASS in 4**, merged into `develop`. Round 3 was vetoed by the harness's own bug (L-27); round 4 was `REVIEW_ONLY=1` and all ten mutations went RED |

**Round yield is governed by the bounded domain, not the AC count** (L-20):
5 unbounded ACs → 8 rounds; 2 ACs with one unbounded "every" → 3; 2 bounded
ACs → 1.

---

## 6. What needs a human, in order

1. **A @BotFather token.** Everything in the control plane is built and
   tested, and none of it does anything until `.env.fleet` has
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, and the two `fleet-bot` units
   are symlinked. Steps in `systemd/README.md`. Until then every
   notification is a `warn` into the queue log, which nobody reads at 2 a.m.
   — which was the whole problem.
2. **`loginctl enable-linger fleet`** — needs an admin. Without it both timers
   die with the ssh session.
3. **Watch the first auto-merge.** The machinery is covered by the suite,
   including the post-merge baseline that keeps a bad merge off the epic, but
   it has never run on a real story. `AUTO_MERGE=0` turns it off.
4. **Story 012** — its root cause is that `public/sw.js` bytes never change on
   deploy, so no new worker installs and the banner is **unreachable**, not
   badly made. Fixing it properly means versioning or stamping `sw.js` at build
   time, which also fixes `/manifest.json` and the icons never refreshing for
   returning users. That reaches into how the app builds. Read its ACs before
   promoting.
5. **Story 013** — ready to promote as-is. `/promote khaita 013` once the bot is up.
6. **The remaining khaita items** — mobile search and lyrics-language defaults
   on `epic/search`; "shazam" needs decomposing before it is a story.
7. **`epic/ui-polish` is 2 ahead of `develop`** (`bash status.sh khaita --epics`).
   `bash merge.sh khaita --epic epic/ui-polish` when you want it in.

---

## 7. Harness gaps still open

- **Auto-merge has never run on a real story.** The machinery exists and the
  suite covers it, including the post-merge baseline that undoes a bad merge
  and the `AUTO_MERGE=0` switch. What it has not had is a real story on a real
  epic. Treat the first few as worth watching.
- **The bot is written and not installed.** It needs a @BotFather token in
  `.env.fleet` and the two units symlinked; both are a human's, and until then
  every notification is a `warn` into the queue log.
- **`.blocked/` has never fired from a builder** in fourteen stories. The
  story-writer escalates instead — 011 raised a product question and refused to
  decide — and intake is arguably the right place for it (L-24). The path is
  covered by `test-lib`; the field has never exercised it.
- **The harness is verified by hand.** Since 19 Sep it is its own repo and
  never a target, so no round can touch it and the self-test branch is gone
  (L-26, L-27). `bash test-lib.sh` before every commit there is the whole of
  the discipline; nothing enforces it.
- **The first real run from the new home has not happened.** Every script is
  covered by the suite against a synthetic target; the read-only entry points
  have been run against the real checkout. A full round with real agents from
  `~/work/fleet` is still to be watched.
- **Lanes.** One, still. The lock (C4) makes two safe; whether two fit is a
  memory question, and the timing line now in every Machine block is what will
  answer it. The trigger, stated in advance: ≥3 stories `ready` for a day, and
  peak RSS under 1.2 GB per lane.

---

## 8. Conventions worth preserving

- One task, one commit. Show `git status --short` with each.
- **Show the `launch.sh` diff before applying it.**
- Every AC names its instrument and the mutation that turns it red.
- **Bound the domain of every AC** (L-20) and **claim only what you instrument**
  (L-25).
- State the instrument's weakness in the story rather than letting the reviewer
  find it.
- Read the current file, never a diff hunk (L-09).
- A check that cannot go red is absent, not weak — and a check that cries wolf
  is worse than no check (`lint-story`'s first version: 20 false positives,
  zero findings).
- Prompts on stdin, never argv (L-18).
- Kill by cwd or by exact process name, never by a `pkill -f` pattern that can
  match your own command line.
- Never edit `launch.sh` while a launcher is running it.
- `bash test-lib.sh` green before every commit in the fleet repo.
- Never suppress stderr on a step that can fail meaningfully; stderr is
  evidence (`reviewer.stderr`).
- `--sandbox danger-full-access` for Codex: bwrap cannot create net namespaces
  here; isolation comes from the worktree and the unprivileged user.
