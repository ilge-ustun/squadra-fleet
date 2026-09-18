# Fleet handoff — state as of 18 Sep 2026, end of day

Autonomous coding-agent fleet for `khaita-app`. Supersedes every earlier
handoff. Read `docs/fleet/lessons.md` alongside this — L-01 … L-26 hold the
findings this only summarises.

**Orient by running things, not by trusting this file.** Numbers in prose rot
(L-11). The commands that produce them:

```bash
./fleet/status.sh                 # every story: status, round, computed verdict, epic
bash fleet/test-lib.sh            # the harness's own suite — 42 cases
npx vitest run                    # the app's suite
git log --oneline develop -20
```

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

`develop` carries `.stories/`, `.review/`, `fleet/`, `docs/fleet/`. Epic
branches carry **product code only** — a story branch never receives fleet
state, because the story text reaches both agents in their prompt rather than
as a file in the worktree (§3). Epics drift from `develop` as fleet work
continues; that is normal and merges cleanly.

A story names its epic with `base:` in frontmatter. Omitted, it uses
`BASE_BRANCH` (default `develop`).

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
default PATH — `fleet/systemd/fleet-queue.service` sets it explicitly.

**Memory, measured:** an interactive Claude Code session on this host is
**~530 MB**; Hermes ~694 MB; system ~120 MB. ~1.4 GB is committed before the
fleet starts and a Next build peaks near 1.4 GB. **Never run the launcher as a
child of the session driving it** — the tool's own low-memory policy killed one
mid-builder on 17 Sep. Detached, always:

```bash
setsid nohup bash -c 'bash fleet/launch.sh 0NN; echo "exit=$?"' > log 2>&1 < /dev/null &
```

Two agents plus a Next build at once left ~1.0 GB free. It held, but only just.

---

## 3. The machine

### Pipeline

```
intent (a sentence)
  → fleet/write-story.sh  Opus 5, read-only worktree at the epic's tip,
                          writes .stories/<id>.md at status: draft
  → fleet/lint-story.sh   mechanical: cited paths exist and lines are in range,
                          ACs are **ACn-headed, base: is a real branch; warns on
                          an unquantified every/all/any and on baseline ACs
  → a human reads it and sets status: ready
  → fleet/launch.sh <id>   (or fleet/run-queue.sh for the whole queue)
       zero **ACn headings → needs_human before any agent runs
       worktree ../wt-<id> cut from origin/<base:>
       builder (claude -p, prompt on stdin, AGENT_TIMEOUT)
         → hands over .review-out/mutations/ACn-tdd-*  (its "observed red")
       postcondition: commits OR handed-over evidence; .blocked/ checked first
       clean reviewer worktree detached at the builder's head
       ★ BASELINE   vitest (JSON) / build / lint → evidence
       ★ SCOPE      changed paths vs scope_deny globs → evidence
       reviewer (codex exec, prompt on stdin, AGENT_TIMEOUT)
         → .review-out/mutations/ACn-* and optional .review-out/probes/*
       ★ reviewer's tree must be clean apart from .review-out/, else needs_human
       ★ MUTATION RUNNER  per patch: pre-run green? apply, run, classify,
                          restore, verify clean
       ★ PROBE RUNNER     each probe run against the tree as it stands
       ★ COMPUTE VERDICT
  → .review/<id>.md + .review/<id>/round-N/ committed with the status
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
`PRE_RED` (already failing unmutated), `PATCH_INVALID`, `NO_SELECTOR`. **A
probe is the inverse — RED means it found something, so RED vetoes.** Probes
are optional: requiring one is a check that cannot go red.

### Files

```
fleet/launch.sh        the launcher; --reap runs reap_orphans and exits
fleet/run-queue.sh     drains every ready story; reaps first; --max N
fleet/write-story.sh   intent → draft story (STORY_MODEL, default claude-opus-5)
fleet/lint-story.sh    mechanical story checks; --strict makes warnings fatal
fleet/status.sh        read-only; one line per story + a round's Machine block
fleet/test-lib.sh      42 cases; fake agents in fleet/test/
fleet/render.sh        render_prompt(); {{STORY}} {{INTENT}} {{STORY_BASE}} …
fleet/prompts/*.md     rules, build-round{1,2}, build-after-spec, review,
                       write-story, README (the verdict contract)
fleet/systemd/         timer + oneshot service, NOT installed — see its README
.stories/<id>.md       spec; frontmatter status/round/base/scope_deny
.review/<id>.md        summary; `verdict:` on line 3; ### Machine per round
.review/<id>/round-N/  committed evidence: baseline, scope, mutations, probes,
                       reviewer.md, reviewer.stderr, builder.md
.runs/                 raw JSON and logs — machine-local, gitignored
```

### Seams (all `${X:-default}`)

`BASE_BRANCH` `BUILDER_MODEL` `STORY_MODEL` `MAX_TURNS` `MAX_ROUNDS`
`AGENT_TIMEOUT` `INSTALL_CMD` `TEST_CMD` `BUILD_CMD` `LINT_CMD` `VITEST_CMD`
`PUSH_STATUS` `REVIEW_ONLY`

`REVIEW_ONLY=1` skips the builder and the commit postcondition — for when
`needs_human` was a spec defect rather than a build defect. It earned itself
on story 008 the day it landed.

---

## 4. Unattended

`fleet/run-queue.sh` drains the queue: reaps orphans first, runs every `ready`
story, and a stopped story does not stop the queue. Guards: `--max` (default
20), and it stops if a story returns to `ready` without finishing.

**Crash resume works and is tested** (`test-lib` case 42). A power cut leaves a
story at `in_progress` with a worktree holding the builder's commits; the next
drain reaps it, reuses the worktree, and continues rounds from the frontmatter
rather than restarting at one.

**`AGENT_TIMEOUT`** (1800s) wraps both agent calls in `timeout -k 30`. On
timeout the story goes to `needs_human` naming the timeout. Children may
outlive the kill (L-04) — the next run's `procs_in_worktree` finds them and
refuses to start, which is correct.

**systemd** units are written and pass `systemd-analyze --user verify`, but are
**not installed**. Two commands in `fleet/systemd/README.md`; one needs an
admin (`loginctl enable-linger fleet` — currently `no`, so units would die with
the ssh session).

---

## 5. Stories

Run `./fleet/status.sh` rather than trusting this table.

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
| 014 | the queue refreshes from origin | **needs_human** after 2 rounds, §6 |

**Round yield is governed by the bounded domain, not the AC count** (L-20):
5 unbounded ACs → 8 rounds; 2 ACs with one unbounded "every" → 3; 2 bounded
ACs → 1.

---

## 6. What needs a human, in order

1. **Story 014** — `needs_human`, worktree `../wt-014` at `88b0b7f`. The
   behaviour is right: the refresh works, a failed refresh continues the drain,
   a conflict aborts cleanly, and a human's in-progress merge is protected —
   that last one found by a reviewer **probe** in round 1 and fixed in round 2.
   Two survivors, both gaps between an AC's words and its test:
   `AC2-delete-continuation-message` (the AC says the log line states it is
   continuing; the test only greps `refresh failed`) and
   `AC3-drop-final-newline` (the AC says "byte-identical"; the test misses a
   dropped trailing newline). **Verified by hand: the full harness suite passes
   on that branch — 243 assertions, nothing existing broken.** Recommended: one
   more round (`MAX_ROUNDS=1`) strengthening AC3's assertion — byte-identity of
   uncommitted work is the claim that matters here — and weakening AC2's
   wording to what its test proves. Merging over the FAIL is the wrong call on
   this file specifically.
2. **Story 012** — its root cause is that `public/sw.js` bytes never change on
   deploy, so no new worker installs and the banner is **unreachable**, not
   badly made. Fixing it properly means versioning or stamping `sw.js` at build
   time, which also fixes `/manifest.json` and the icons never refreshing for
   returning users. That reaches into how the app builds. Read its ACs before
   promoting.
3. **Story 013** — ready to promote as-is.
4. **The harness-verification gap (L-26)** — the baseline is `npm test` /
   `build` / `lint`, all of which exercise the app. **Nothing in the baseline
   touches `fleet/`.** A story that changes the harness is guarded only by the
   reviewer's mutations plus a human running `test-lib`. Extending
   `run_baseline` to also run `test-lib` when the changed paths include
   `fleet/` is ~10 lines and should land before agents touch the harness
   routinely.
5. **The remaining khaita items** — mobile search and lyrics-language defaults
   on `epic/search`; "shazam" needs decomposing before it is a story.

---

## 7. Harness gaps still open

- **Nothing merges itself.** Every merge so far has been a human's. Defensible
  while computed PASS has five data points; revisit later.
- **No write-side control plane.** `status.sh` reads; there is no approve /
  promote / unblock path. Story 014 is the first half of that bridge — the
  queue seeing a promotion made elsewhere.
- **No `fleet/reset.sh`.** Clearing a story is still four manual steps.
- **`warn` → `die` audit.** `seed_env`'s missing-file warning caused bug #1 and
  is still a warning.
- **`.blocked/` has never fired from a builder** in twelve stories. The
  story-writer escalates instead — 011 raised a product question and refused to
  decide — and intake is arguably the right place for it (L-24).
- **`PRE_RED` overloads two meanings**: a genuinely failing instrument, and a
  selector of the wrong kind (014 round 1 put a shell command in a `.test`
  file). Worth splitting.
- **Epic → develop merges are untested.** Only `story → epic` and
  `story → develop` have happened.

---

## 8. Conventions worth preserving

- One task, one commit. Show `git status --short` with each.
- **Show the `fleet/launch.sh` diff before applying it.**
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
- Never suppress stderr on a step that can fail meaningfully; stderr is
  evidence (`reviewer.stderr`).
- `--sandbox danger-full-access` for Codex: bwrap cannot create net namespaces
  here; isolation comes from the worktree and the unprivileged user.
