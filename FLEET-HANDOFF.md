# Fleet handoff — state as of 18 Sep 2026 (midday)

Autonomous coding-agent fleet for `khaita-app`. Supersedes the 17 Sep handoff.
Read `docs/fleet/lessons.md` alongside this — L-14 … L-21 were added in the
session this document closes. The design that session implemented is in
`fleet/prompts/README.md` ("The verdict contract"); its history is in the
commits `110d165..92c8982` on `feat/pwa`.

---

## 1. The architecture

Four layers. Unchanged as a model; the harness layer now does what the table
always said it did.

| Layer | Owns | Implementation |
|---|---|---|
| **Harness** | launcher, worktrees, concurrency, retry, **verdict computation** | `fleet/launch.sh` (~650 lines) + `fleet/render.sh`; tested by `fleet/test-lib.sh` |
| **Agent** | roles, prompts, model per lane, review protocol | `fleet/prompts/*.md`; Claude Code builder, Codex reviewer |
| **State** | story specs, gates, review log, **evidence** | markdown + frontmatter, `.review/<id>/round-N/`, all in git |
| **Control plane** | how the human submits work and unblocks gates | tmux + SSH, or a Claude Code session. **Still the weakest layer, and now measured** — see §2. |

```
.stories/<id>.md   spec + ACs headed **ACn + frontmatter status/round/scope_deny
  → launcher picks first `ready`; zero **ACn headings → needs_human before any agent
  → worktree ../wt-<id>; base copy of the story SYNCED in as a launcher commit
  → claude -p (prompt on stdin), TDD enforced by RULES
  → postcondition: did commits appear? (NOT is_error)
  → clean reviewer worktree at builder's head
  → ★ harness BASELINE: vitest (JSON reporter) / build / lint → evidence
  → ★ harness SCOPE: changed paths vs story scope_deny globs → evidence
  → codex exec (prompt on stdin): prose + VERDICT line + .review-out/mutations/
  → ★ harness: reviewer tree must be clean apart from .review-out/, else needs_human
  → ★ harness MUTATION RUNNER: per patch — pre-run green? apply, run, RED/GREEN/
      NO_TESTS/PRE_RED/PATCH_INVALID, restore, tree clean? → .result per mutation
  → ★ harness COMPUTES the verdict:
        machine_pass = baseline green ∧ scope CLEAN ∧ every AC has ≥1 mutation
                     ∧ every mutation RED
        final = SPEC if model says SPEC | PASS if machine_pass ∧ model PASS | FAIL
      The machine can veto, never grant.
  → .review/<id>.md (### Machine block per round) + .review/<id>/round-N/ committed
  → FAIL → next round with the review-so-far as findings → ceiling → needs_human
  → rounds continue across reruns (round: in frontmatter)
```

---

## 2. Infrastructure

**VPS:** Ubuntu 24.04, 2 CPU / 4 GB / 60 GB + 8 GB swap, IP `179.237.101.204`.

**Users, no sudo, home 700:** `ubuntu` (admin), `fleet` (agents,
`~/work/khaita/khaita-app`), `hermes` (personal agent, systemd user service).

**Installed under `fleet`:** Claude Code 2.1.263, Codex 0.153.4, Node 24 via
nvm, jq.

**Memory — measured 17 Sep evening, not estimated:** an interactive Claude
Code session on this host = **530 MB**; Hermes = **694 MB** (three python
processes); system ≈ 120 MB. That is ~1.4 GB committed before the fleet
starts, on 3.9 GB with 2 CPUs (vitest runs two jsdom workers). The 14 Sep
"two lanes would fit" was measured without an interactive session on the box.
A launcher run as a *background task of a Claude Code session* was killed by
the tool's own low-memory policy mid-builder. Every run after that was
launched detached — `setsid nohup bash -c 'bash fleet/launch.sh <id>; echo
"launcher exit=$?"' > log 2>&1 < /dev/null &` — and completed. **Run the
launcher from tmux or detached; never as a child of the session driving it.**

---

## 3. What changed 17–18 Sep — the verdict is computed

All of this is on `feat/pwa`, pushed, 167 assertions green in
`bash fleet/test-lib.sh` (34 cases).

### Harness

- **`fleet/test-lib.sh` + `fleet/test/{claude,codex,vitest,npm}`** — the
  launcher's regression suite. Fakes are resolved by bare name on PATH
  (launch.sh calls `claude`/`codex` unqualified). Each case names the
  launch.sh block whose deletion turns it red; **every case was observed red
  before its block existed** (against the pre-change launcher via
  `FLEET_LAUNCH_OVERRIDE`, or against mutant copies). Two guards, learned the
  expensive way: `shadow_check` refuses to run unless the fakes are what
  resolves (the first run started the *real* Claude on the fixture and
  recursed three deep — L-14); a nested invocation exits.
- **AC extraction before any agent** (`**ACn` at column 0); none →
  `needs_human`, not a bare die (a die would leave it first in the queue).
- **Baseline** run by the harness in the clean reviewer tree: vitest JSON
  reporter, build, lint. GREEN needs `numTotalTests > 0 ∧ numFailedTests == 0`
  — a transform error is zero tests and RED (L-08, by construction; shapes
  read from real vitest 3.2.7 runs).
- **Scope** — `scope_deny:` frontmatter, deny-only bash globs; no allow list
  by decision. `.blocked/<id>.md`, `.stories/<id>.md`, `docs/fleet/<id>-*.md`
  always allowed.
- **Reviewer output contract** — `.review-out/mutations/ACn-<slug>.patch` +
  `.test` (vitest selector) or `.cmd`; tree must be clean otherwise, else
  `needs_human`.
- **Mutation runner** — applies, runs, classifies, restores; dies if the tree
  will not restore.
- **Verdict computation** — as in §1. **D1 by decision: any surviving
  mutation vetoes.** SPEC is immune. Round 2's `{{REVIEW_TEXT}}` is the
  review file so far (Machine blocks + prose), the same content a restart
  reloads.
- **Evidence** — `.review/<id>/round-N/{baseline/,scope.txt,mutations/*,
  reviewer.md,reviewer.stderr,builder.md}` committed with each status. Raw
  vitest JSON and logs in `.runs/` (machine-local, re-derivable from
  patch + SHA).
- Found by the first real story and fixed by construction, each with a
  red-observed case: codex stderr merged into the JSON stream broke
  extraction under no TTY (**L-17**); a 134 KB prompt on argv exceeded
  `MAX_ARG_STRLEN` — **prompts now go on stdin** to both agents (**L-18**);
  a story amended on the base never reached a resumed worktree — **the base
  story is synced into the worktree as a launcher commit** (**L-19**);
  rounds now continue across reruns instead of clobbering `round-1/`.

### Added 18 Sep

- **`REVIEW_ONLY=1`** — skip the builder and the commit postcondition, review
  the branch head as it stands. Everything after the builder runs unchanged
  and `commits this round: 0` is recorded honestly. The mode a story needs
  when `needs_human` was a spec defect rather than a build defect; used on 008
  round 3, which is the run that passed (L-21). `test-lib` case 34.
- **`fleet/status.sh`** — one line per story: status, round, computed verdict,
  branch, worktree/merge state, the last round's veto reasons; with a story id,
  that round's `### Machine` block. Read-only, so safe while a launcher works
  and safe over ssh. Liveness is a `/proc` cwd scan, not the frontmatter
  (L-04: `in_progress` can be a stale orphan).

### Agent

- `review.md` carries the mutation contract and states the veto: *a
  surviving mutation fails the story regardless of your VERDICT line.*
- `README.md` — "The verdict contract" rewritten; records honestly that the
  `^VERDICT:` grep matches any line, not only the last.
- `TEMPLATE.md` — frontmatter with `scope_deny`; AC heading shape required;
  no "suite/build/lint green" ACs (baseline is automatic).
- No model changes. Builder Sonnet, reviewer Codex, unchanged.

### State

- `.stories/007.md`, `.stories/008.md`, `.stories/009.md` (draft), their
  `.review/<id>.md` and per-round evidence directories.
- `docs/fleet/lessons.md` L-14 … L-21.

---

## 4. Stories 007 and 008 — the first two through the computed verdict

Both merged into `feat/pwa`. Suite: `npx vitest run` → **20 files / 131
tests**. `public/sw.js` itself is unchanged by either — `scope_deny` held.

### 007 — `public/sw.js` fetch-handler instrument (merged over a FAIL)

Five ACs over everything the file does. Eight rounds; rounds 3 and 5 never
reached a reviewer (harness defects L-18, L-19, both fixed).

| round | mutations | survived |
|---|---|---|
| 1 | 10 | `AC2-wrong-storage-key`, `AC3-remove-m1-target`, `AC3-reverse-fallbacks` |
| 2 | 19 | `AC3-store-payload` |
| 4 | 7 | `AC2-wrong-cache-key` |
| 6 | 9 | `AC3-cache-first` |
| 7 | 22 | `AC3-remove-ok-guard` |
| 8 | 27 | `AC2-wrong-fetch-url`, `AC3-wrong-fetch-url` |

Merged at round 8 over the reviewer's FAIL, by human decision, with the
per-round tallies and the reason recorded in `.stories/007.md` § Outcome so
`status: done` is never mistaken for a PASS. Every round's survivor was a
genuine new class the story had not bounded. **Model and machine agreed in
every round that ran** — including rounds 1–2, where the model's verdict line
was unreadable (L-17) and the computed verdict was right anyway.

### 008 — argument-sensitive stubs (PASS, the first one computed)

Two ACs over one property, written narrow on purpose. Three rounds.

| round | mutations | survived |
|---|---|---|
| 1 | 6 | `AC1-remove-notification-open`, `AC1-unregistered-cache-delete` |
| 2 | 5 | `AC1-notification-options` |
| 3 | 11 | **none** → `computed: PASS` |

Rounds 1 and 2 caught **every mutation the story named** and failed only on
AC1's original unquantified "every stub in the worker global", which pulled
in the `push` and `notificationclick` handlers that no AC describes. That was
a spec defect, not a build defect: AC1's domain was quantified, and round 3
re-reviewed the *unchanged head* under `REVIEW_ONLY=1` — no builder round
spent — and passed with eleven mutations RED, including the two
`wrong-fetch-url` mutations that had survived every round of 007.

### What the pair measures

Not "fewer ACs" — **a bounded domain**. See lessons L-20. 008 had two ACs and
still burned two rounds on one unbounded "every". The convention was already
written in §9 of the 17 Sep handoff and broken the next day by its author.

Round yield after the L-17/18/19 fixes: **5 of 5 rounds reached a verdict**
(007 rounds 6–8, 008 rounds 1–3 minus the REVIEW_ONLY one is 5 builder rounds
plus one review-only round; none aborted).

## 5. Offline routing — scoped, unchanged

Scoped 17 Sep; nothing built. The findings, all verified against the current
files then:

- `public/sw.js:78` passes `?_rsc=` through **deliberately** (Phase 2 threat
  T-02-03: a stale `_rsc` 307s and browsers reject a cached redirect for a
  navigation). The guard is right online and produces the failure offline.
  Any fix must satisfy both; deleting the line breaks online navigation.
- The three failing routes are **dynamic server segments** with no
  `generateStaticParams` (`routes-manifest.json`), while all three pages are
  `"use client"` reading `useParams()` — the server round-trip hands the
  client a parameter it already has in `location.pathname`. That mismatch is
  the structural cause.
- `sw.js:111`'s fallback to `/collections/mekhor/M1` is the line that turns a
  network failure into the wrong page at the right URL. Story 007's AC3 pins
  it deliberately so the fix starts from red.
- **Product decisions still open:** what an unvisited route shows offline;
  whether wrong-content-silently or visible-failure is the interim; whether
  `/songs/[slug]` (359, unbounded) is in scope — it rules out
  `generateStaticParams`.

---

## 6. Story 004 — unchanged

`needs_human`, branch `story/004`, worktree `../wt-004` at `08b02e6`. Same
plan as 17 Sep: extract the Collection instrument fix path-scoped, rewrite
per the old 7.2, re-branch from current `feat/pwa`. Note the base has moved
a lot; `.stories/004.md` predates `scope_deny` and the AC heading rule
(its ACs *are* `**ACn**`-headed, so it would extract).

---

## 7. Harness gaps found by using it

Closed since 17 Sep: no test harness; verdict from prose; evidence in /tmp;
no `INSTALL_CMD` seam. Still open:

- ~~No review-only entry point~~ — **closed 18 Sep**, `REVIEW_ONLY=1`.
- ~~No status view~~ — **closed 18 Sep**, `fleet/status.sh`.
- **Merging a story conflicts on its own story file, every time.** `sync_story`
  commits the base copy into the worktree, so `.stories/<id>.md` is edited on
  both sides. It happened on 007 and on 008. The resolution is always
  `git checkout --ours .stories/<id>.md` — the base copy is the spec of
  record. Mechanical; a `.gitattributes` merge driver would close it.
- **The reviewer still runs mutations privately** before handing them over
  (`.review-out/mutation-results.txt` appears in its worktree). Harmless,
  costs reviewer time; the prompt could say "you need not run them".
- **`MAX_ROUNDS` is per launch.** Every rerun of 007 was one round because it
  was launched with `MAX_ROUNDS=1`; a converging story wants 2.
- **`die` mid-round leaves `.review/<id>.md.new`** — re-seeded on the next
  run; cosmetic.
- **No reset.** `fleet/reset.sh <id>` still absent.
- **`warn` → `die` audit** — still. `seed_env`'s missing-file warning is
  still a warning.
- **Memory / control plane** — §2. Not a harness bug; a deployment fact.

---

## 8. `.blocked/` has still never fired — eight stories

007 never blocked: every finding was addressable inside scope. The
escalation fixture the 17 Sep handoff proposed (offline routing, written
*without* answering the product question) remains the right test and remains
untried. `fleet/test-lib.sh` case 3 proves the launcher handles it when it
does fire.

---

## 9. Conventions worth preserving

- One task, one commit. Held through 007's six rounds — every builder commit
  is one concern.
- Every AC names its instrument and how it goes red; ACs headed `**ACn**`.
- Quantify the domain of every AC.
- State the instrument's weakness in the story.
- **Read the current file, never a diff hunk.**
- **A check that cannot go red is absent.** The harness now enforces this on
  the workload by mutation; test-lib enforces it on the harness by the same
  rule. Every harness block was observed red before it existed.
- **Show the `launch.sh` diff before applying it.** Held throughout.
- **Prompts on stdin, never argv.** (L-18)
- **Never edit `launch.sh` while a launcher is running it** — bash reads
  scripts incrementally.
- Kill by cwd, never by launcher (L-04). Used twice this session.
- `--sandbox danger-full-access` for Codex — unchanged reason.
- Never suppress stderr on a step that can fail meaningfully; stderr is
  evidence (`reviewer.stderr`).

---

## 10. Files

```
fleet/launch.sh              launcher (~650 lines): AC extraction, story sync,
                             baseline, scope, contract check, mutation runner,
                             computed verdict, evidence commit
fleet/render.sh              render_prompt(), unchanged
fleet/test-lib.sh            33 cases, fake agents, FLEET_LAUNCH_OVERRIDE for
                             observing red against a mutant copy
fleet/test/{claude,codex,vitest,npm}   fakes, resolved by bare name on PATH
fleet/prompts/*.md           rules, build-round1, build-round2, build-after-spec,
                             review (mutation contract), README (verdict contract)
.stories/<id>.md             specs; frontmatter status/round/scope_deny
.stories/TEMPLATE.md         story shape and conventions
.review/<id>.md              summary; verdict: on line 3; ### Machine per round
.review/<id>/round-N/        committed evidence per round
.blocked/<id>.md             agent questions (never yet written)
.runs/                       raw vitest JSON + logs, machine-local, gitignored
docs/fleet/lessons.md        L-01 … L-19
docs/fleet/005-verification/ browser evidence, offline routing defect
```

**Base branch:** `feat/pwa` at `92c8982`, even with origin. 002, 003, 005,
006 merged. 004 and 007 unmerged. Worktrees `../wt-004`, `../wt-006`
(stale, removable), `../wt-007` present.

---

## 11. Next, in order

1. **Story 009** — drafted, `status: draft`. The collection page's test mocks
   away the component it exists to render (`CollectionPage.test.tsx:21-25`,
   one test in the file); story 004's unextracted P1 finding, verified against
   the current base. Two ACs, bounded domain, `scope_deny` on the components
   themselves so the instrument is what changes.
2. **Phase 3 of the verdict plan** — builder-emitted TDD mutations (the
   builder's "observed red" becomes a harness postcondition) and reviewer
   probes (runnable regression tests; a RED probe vetoes). Deferred until a
   story had gone through; two have.
3. **Rewrite and rerun 004** from a fresh branch off current `feat/pwa`, now
   that 009 extracts its instrument finding.
4. **The escalation fixture** — offline routing written *without* answering the
   product question, to see `.blocked/` fire for the first time in nine
   stories.
5. **`fleet/reset.sh`**, the `warn`→`die` audit, a `.gitattributes` merge
   driver for `.stories/*.md`.
6. **Control plane** — decide where the interactive session lives; it costs
   the fleet host 530 MB. `status.sh` is the artifact it was missing.
