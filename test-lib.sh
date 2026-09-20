#!/usr/bin/env bash
#
# test-lib.sh — tests for launch.sh and the other scripts, with fake agents.
#
#   bash test-lib.sh              run every case
#   bash test-lib.sh blocked      run cases whose name contains "blocked"
#
# No network, no npm, no models. Each case gets a fresh fixture:
#
#   $TMP/<case>/fleet        THIS working tree, copied — the fleet under test is
#                            the one on disk, not the one at HEAD — with a
#                            registry of one entry, `t`, pointing at repo/
#   $TMP/<case>/origin.git   a bare repo — the target's `origin`
#   $TMP/<case>/repo         a synthetic target on branch `base`: src/marker.txt
#                            (the file the fakes mutate), .fleet/config naming
#                            the fakes, one fixture story, a .stories/TEMPLATE.md
#   $TMP/<case>/trace        what the fakes recorded
#
# Every script is run from $TMP/<case>, never from inside the target: a script
# that still depends on its cwd being the repo fails here.
#
# test/{claude,codex,npm} are put first on PATH; launch.sh resolves
# `claude` and `codex` by bare name (`command -v`, and the calls at the
# builder and reviewer steps), so no launcher change is needed for the
# substitution. Worktrees land as $TMP/<case>/wt-<id>, siblings of repo/,
# exactly as in production (launch.sh: "$REPO_ROOT/../wt-$STORY_ID").
#
# Observing red. Most cases characterise behaviour launch.sh already has, so
# "see it fail first" means: run the case against a copy of launch.sh with
# the named block deleted. FLEET_LAUNCH_OVERRIDE=<file> substitutes that
# copy into the fixture; the real launch.sh is never modified.
# FLEET_RENDER_OVERRIDE does the same for render.sh. Each case's comment
# names the block whose deletion turns it red.
#
# Two guards, both learned the expensive way on the first run (17 Sep): the
# fakes were named fake-claude/fake-codex, so `claude` resolved to the REAL
# agent, which read the fixture story, ran this very script, and recursed
# three deep on real quota before being killed.
#   1. shadow_check — every fake must be what actually resolves, or we stop.
#   2. no nesting  — if FAKE_TRACE_DIR is already set we are inside a fixture;
#      a real agent got in. Stop, never fan out.
#
set -uo pipefail

if [[ -n "${FAKE_TRACE_DIR:-}" ]]; then
  echo "test-lib: FAKE_TRACE_DIR is set — refusing to run inside a fixture (nested invocation)" >&2
  exit 3
fi

# A clean environment, always (L-27). The fixtures assume the scripts'
# DEFAULTS; whatever the calling shell has exported — MAX_ROUNDS=1 from a
# hand-run round, say — would silently become the suite's configuration and
# turn correct cases into failures that look like findings. An allowlist,
# not a drop-list: a drop-list must grow with every new seam and the once it
# is forgotten the symptom is indistinguishable from a real failure. The
# three override seams are the red-observation mechanism and must survive.
if [[ -z "${FLEET_TEST_CLEAN:-}" ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C.UTF-8}" \
       FLEET_LAUNCH_OVERRIDE="${FLEET_LAUNCH_OVERRIDE:-}" \
       FLEET_RENDER_OVERRIDE="${FLEET_RENDER_OVERRIDE:-}" \
       FLEET_LIB_OVERRIDE="${FLEET_LIB_OVERRIDE:-}" \
       FLEET_TEST_CLEAN=1 bash "$0" "$@"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_HOME="$HERE"                    # the fleet under test is this working tree
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleet-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

ONLY="${1:-}"
STORY=900
PASSED=0; FAILED=0; CASE=""

# ── assertions ───────────────────────────────────────────────────────────────

ok()   { PASSED=$((PASSED + 1)); }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL  [%s] %s\n' "$CASE" "$1"; }

assert_eq()       { [[ "$1" == "$2" ]] && ok || fail "$3: expected '$2', got '$1'"; }
assert_grep()     { grep -qE -- "$1" "$2" 2>/dev/null && ok || fail "$3: expected /$1/ in ${2#$TMP/}"; }
assert_not_grep() { grep -qE -- "$1" "$2" 2>/dev/null && fail "$3: found /$1/ in ${2#$TMP/}" || ok; }
assert_contains() { [[ "$1" == *"$2"* ]] && ok || fail "$3: expected '$2' in: $1"; }
assert_file()     { [[ -f "$1" ]] && ok || fail "$2: missing ${1#$TMP/}"; }
assert_no_file()  { [[ -f "$1" ]] && fail "$2: unexpected ${1#$TMP/}" || ok; }
assert_not_contains() { [[ "$1" == *"$2"* ]] && fail "$3: unexpected '$2'" || ok; }

# ── fixture ──────────────────────────────────────────────────────────────────

shadow_check() {                      # shadow_check <fleet-copy> — die unless the fakes are what resolves
  local fleet="$1" name got
  for name in claude codex npm curl; do
    got="$(PATH="$fleet/test:$PATH" command -v "$name")"
    if [[ "$got" != "$fleet/test/$name" ]]; then
      echo "test-lib: '$name' resolves to '$got', not the fake — refusing to run the launcher" >&2
      exit 3
    fi
  done
}

fixture() {                           # fixture <case-name> [story-status] → FX FLEET REPO TRACE
  FX="$TMP/$1"; FLEET="$FX/fleet"; REPO="$FX/repo"; TRACE="$FX/trace"
  local status="${2:-ready}"
  mkdir -p "$TRACE"; : > "$TRACE/calls"

  # The fleet under test: this working tree, minus its git metadata, its real
  # registry (a typo'd name in a case must never reach a real checkout) and
  # anything machine-local. One registry entry, t, names the target below.
  mkdir -p "$FLEET"
  cp -r "$FLEET_HOME/." "$FLEET"
  rm -rf "$FLEET/.git" "$FLEET/repos" "$FLEET/.env.fleet" "$FLEET/.bot-offset"
  [[ -n "${FLEET_LAUNCH_OVERRIDE:-}" ]] && cp "$FLEET_LAUNCH_OVERRIDE" "$FLEET/launch.sh"
  [[ -n "${FLEET_RENDER_OVERRIDE:-}" ]] && cp "$FLEET_RENDER_OVERRIDE" "$FLEET/render.sh"
  [[ -n "${FLEET_LIB_OVERRIDE:-}" ]]    && cp "$FLEET_LIB_OVERRIDE"    "$FLEET/lib.sh"
  mkdir -p "$FLEET/repos"
  printf 'REPO_PATH=%s\n' "$REPO" > "$FLEET/repos/t.env"

  # A synthetic target, not a clone of anything real: a bare origin, a working
  # clone on `base`, a marker file for the fakes to mutate, and the fleet.
  git init -q --bare "$FX/origin.git"
  git -C "$FX/origin.git" symbolic-ref HEAD refs/heads/base   # a clone of it checks out base, quietly
  git init -q -b base "$REPO"
  git -C "$REPO" config user.name  fleet-test
  git -C "$REPO" config user.email fleet-test@localhost
  git -C "$REPO" remote add origin "$FX/origin.git"

  mkdir -p "$REPO/src" "$REPO/.stories" "$REPO/.fleet"
  printf 'the fake agents mutate this file\n' > "$REPO/src/marker.txt"
  # The target says how it is built and tested; here, with the fakes. A case
  # overrides a value by putting it in the environment (BUILD_CMD=false).
  cat > "$REPO/.fleet/config" <<EOF
BASE_BRANCH=base
INSTALL_CMD=true
VITEST_CMD=$FLEET/test/vitest
BUILD_CMD=true
LINT_CMD=true
SEED_FILES=.env.local
PROBE_DIR=src
EOF
  printf '# fixture target\n' > "$REPO/README.md"
  # .env.local is untracked in production because the target ignores .env*;
  # without this line seed_env would dirty every reviewer worktree.
  printf '.env.local\n.runs/\n.review-out/\n' > "$REPO/.gitignore"
  cat > "$REPO/.stories/TEMPLATE.md" <<'EOF'
---
status: draft
round: 0
---

# Story NNN: title

**AC1 — one bounded claim.** Goes red when removed.
EOF
  cat > "$REPO/.stories/$STORY.md" <<EOF
---
status: $status
round: 0
---

# Story 900: fixture story

**AC1 — the fixture has one criterion.** Goes red when removed.
EOF

  # SEED_FILES=(.env.local) and the launcher dies without it. Untracked here
  # too, so the fixture matches production rather than papering over it.
  printf 'FLEET_TEST=1\n' > "$REPO/.env.local"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "fixture: target + story $STORY"
  git -C "$REPO" push -q -u origin base

  shadow_check "$FLEET"
}

# One helper per script. Each runs from $FX, not the target, with the fakes
# first on PATH. The target's commands come from its .fleet/config; a case
# that needs one changed puts it in "$@", and env takes the last assignment,
# so the case's VAR=value wins over the defaults here — and, inside the
# script, over the config file.
FAKES() { printf '%s' "$FLEET/test:$PATH"; }
run() {                               # run <story-id> [VAR=value …] → LOG RC
  local id="$1"; shift
  LOG="$FX/launch.log"
  ( cd "$FX" && env PATH="$(FAKES)" \
      PUSH_STATUS=1 FAKE_MUTATIONS=patch FAKE_VITEST=marker FLEET_NOTIFY_CMD=true \
      FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID="$STORY" "$@" \
      bash "$FLEET/launch.sh" t "$id" ) > "$LOG" 2>&1
  RC=$?
}
queue() {                             # queue [VAR=value …] → $FX/queue.log QRC   (QUEUE_TARGET=--all for every repo)
  ( cd "$FX" && env PATH="$(FAKES)" \
      PUSH_STATUS=1 FAKE_MUTATIONS=patch FAKE_VITEST=marker FLEET_NOTIFY_CMD=true \
      FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID="$STORY" "$@" \
      bash "$FLEET/run-queue.sh" "${QUEUE_TARGET:-t}" ) > "$FX/queue.log" 2>&1
  QRC=$?
}
status_run() {                        # status_run [args…] → stdout
  ( cd "$FX" && bash "$FLEET/status.sh" t "$@" )
}
tracked() { git -C "$REPO" ls-tree -r HEAD --name-only; }

frontmatter() {                       # frontmatter <file> <key>
  awk -v k="$2" '/^---$/{d++; next} d==1 && $0 ~ "^"k":" {sub("^"k":[[:space:]]*",""); print; exit}' "$1"
}
field() {                             # field <key> → frontmatter value of the fixture story
  awk -v k="$1" '
    NR==1 && $0!="---" { exit }
    /^---$/ { if (++d==2) exit; next }
    d==1 && $0 ~ "^"k":" { sub("^"k":[[:space:]]*",""); print; exit }
  ' "$REPO/.stories/$STORY.md"
}
review_line() { sed -n "${1}p" "$REPO/.review/$STORY.md" 2>/dev/null; }
calls()       { grep -c "^$1\$" "$TRACE/calls"; }
set_ready()   { sed -i '0,/^status:.*/s//status: ready/' "$REPO/.stories/$STORY.md"; }

# ── cases ────────────────────────────────────────────────────────────────────

# Red when the outcome block's `set_status "$STORY_ID" done` is deleted.
# Also carries the INSTALL_CMD seam: red while INSTALL_CMD is hardcoded,
# because the npm tripwire on PATH then gets called.
case_1_happy() {
  CASE="1 commit + PASS → done"; fixture c1
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" done "story status"
  assert_eq "$(review_line 3)" "verdict: PASS" ".review line 3"
  assert_not_grep '^npm ' "$TRACE/calls" "INSTALL_CMD seam — npm must not be reached"
  assert_eq "$(calls claude)" 1 "builder called once"
  assert_eq "$(calls codex)"  1 "reviewer called once"
  # Phase 1.2: the harness ran the baseline itself and committed the evidence.
  assert_grep 'baseline: test GREEN \| build GREEN \| lint GREEN' "$REPO/.review/$STORY.md" "machine block records a green baseline"
  assert_contains "$(tracked)" ".review/$STORY/round-1/baseline/test.summary.json" "baseline evidence committed"
  # Phase 1.5: PASS was computed, not just parsed — AC1's mutation went RED.
  assert_grep '^computed: PASS$' "$REPO/.review/$STORY.md" "computed PASS with no reasons"
  assert_grep '^AC1 +RED +marker' "$REPO/.review/$STORY.md" "the mutation that earned it"
  # Phase 1.7: the rendered review prompt carries the output contract. A text
  # check — weak, stated as such; the real check is a real story run.
  assert_grep '\.review-out/mutations/' "$TRACE/codex-prompt-1" "review prompt names the mutation dir"
  assert_grep 'regardless of your VERDICT line' "$TRACE/codex-prompt-1" "review prompt states the veto"
}

# Red when the no-commits postcondition (set_status needs_human; die) is deleted.
case_2_nocommit() {
  CASE="2 no commits → needs_human"; fixture c2
  run "$STORY" FAKE_BUILDER=nocommit FAKE_REVIEWER=PASS
  assert_eq "$RC" 1 "exit code (die)"
  assert_eq "$(field status)" needs_human "story status"
  assert_grep 'produced no commits' "$LOG" "reason in output"
  assert_eq "$(calls codex)" 0 "reviewer must not run"
}

# Red when the .blocked/ detection block is deleted.
case_3_blocked() {
  CASE="3 .blocked/ written → blocked"; fixture c3
  run "$STORY" FAKE_BUILDER=blocked FAKE_REVIEWER=PASS
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" blocked "story status"
  assert_file "$REPO/.blocked/$STORY.md" "question copied to the base repo"
  assert_grep 'BLOCKED' "$LOG" "announced"
  assert_eq "$(calls codex)" 0 "reviewer must not run"
  assert_no_file "$REPO/.review/$STORY.md" "no review written"
}

# Red when the prompt selection (round1 / after-spec / round2) is collapsed
# to always render build-round1.md.
case_4_fail_two_rounds() {
  CASE="4 FAIL → round 2 gets the findings"; fixture c4
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" needs_human "story status"
  assert_eq "$(review_line 3)" "verdict: FAIL" ".review line 3"
  assert_eq "$(review_line 4)" "rounds: 2 of 2" ".review line 4"
  assert_eq "$(calls claude)" 2 "builder called twice"
  assert_not_grep 'REJECTED' "$TRACE/claude-prompt-1" "round 1 prompt is the fresh build"
  assert_grep 'REJECTED' "$TRACE/claude-prompt-2" "round 2 prompt is the rejected build"
  assert_grep 'fake review, call 1' "$TRACE/claude-prompt-2" "round 1 findings reached round 2"
}

# L-05. Red when the REVIEW_TEXT-from-file block at startup is deleted:
# a restart after FAIL then renders the fresh-build prompt and the findings
# are lost.
case_5_restart_after_fail() {
  CASE="5 restart after FAIL resumes from findings"; fixture c5
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  assert_eq "$(calls claude)" 3 "builder called a third time"
  assert_grep 'REJECTED' "$TRACE/claude-prompt-3" "restart renders the rejected-build prompt"
  assert_grep 'prior failing review found' "$LOG" "launcher says so"
  # Rounds continue across reruns (found on 007's rerun): the third round is
  # round 3, its evidence lands in round-3/, round-1/ is not clobbered, and
  # the review file keeps every round's section. Red when ROUND restarts at 0.
  assert_eq "$(review_line 4)" "rounds: 3 of 3" "round numbering continues"
  assert_file "$REPO/.review/$STORY/round-3/reviewer.md" "round-3 evidence dir"
  assert_grep 'fake review, call 1' "$REPO/.review/$STORY/round-1/reviewer.md" "round-1 evidence not clobbered"
  assert_grep '^## Round 1 ' "$REPO/.review/$STORY.md" "review file keeps round 1"
  assert_grep '^## Round 3 ' "$REPO/.review/$STORY.md" "review file has round 3"
}

# Red when the UNPARSEABLE fallthrough is changed to any real verdict.
case_6_unparseable() {
  CASE="6 garbage verdict → UNPARSEABLE"; fixture c6
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=garbage
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" needs_human "story status"
  assert_eq "$(review_line 3)" "verdict: UNPARSEABLE" ".review line 3"
}

# L-02. Red when the per-path guarded `git add` loop is replaced by one
# `git add` of all three paths — .blocked/ is absent, so nothing stages and
# no status commit ever lands.
case_7_status_commits_land() {
  CASE="7 status commits land without .blocked/"; fixture c7
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  local subjects; subjects="$(git -C "$REPO" log --format=%s)"
  assert_contains "$subjects" "story($STORY): in_progress" "in_progress committed"
  assert_contains "$subjects" "story($STORY): done" "done committed"
  assert_contains "$(git -C "$FX/origin.git" log base --format=%s)" "story($STORY): done" "pushed to origin"
}

# L-03. Red when the jq `has("is_error")` guard reverts to `.is_error // …`:
# is_error:false then reads as parse-failed and the launcher warns "builder
# output was not JSON". (First version of this case grepped for the literal
# "parse-failed", which the launcher never prints on this path — the mutant
# survived. Instrument was absent, not weak.)
case_8_is_error_false() {
  CASE="8 is_error:false is not parse-failed"; fixture c8
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_not_grep 'builder output was not JSON' "$LOG" "no false parse failure"
  assert_grep 'fake builder did: commit' "$REPO/.review/$STORY.md" "builder result recorded"
}

# Red when the SPEC break is deleted (rounds continue) or when the
# after-spec prompt branch is deleted (rerun gets the round-2 prompt).
case_9_spec() {
  CASE="9 SPEC stops the rounds; rerun gets the after-spec prompt"; fixture c9
  # FAKE_VITEST=pass: the mutation survives (GREEN). Phase 1.5: a machine
  # veto must not touch SPEC — the story is wrong, not the build.
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=SPEC FAKE_VITEST=pass
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" needs_human "story status"
  assert_eq "$(review_line 3)" "verdict: SPEC" ".review line 3 — SPEC immune to the veto"
  assert_eq "$(review_line 4)" "rounds: 1 of 2" "stopped after round 1"
  assert_eq "$(calls claude)" 1 "builder called once"
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=SPEC MAX_ROUNDS=1
  assert_grep 'PREVIOUS REVIEW' "$TRACE/claude-prompt-2" "rerun renders build-after-spec"
  assert_not_grep 'REJECTED' "$TRACE/claude-prompt-2" "rerun does not render round-2"
}

# render.sh alone, no fixture. Red when the empty-placeholder check is
# deleted (a prompt with a gap reaches the agent) or the leftover warning is.
case_10_render_prompt() {
  CASE="10 render_prompt guards"
  local pd="$TMP/prompts" render="${FLEET_RENDER_OVERRIDE:-$FLEET_HOME/render.sh}" out rc
  mkdir -p "$pd"
  printf 'id {{STORY_ID}}\n' > "$pd/a.md"
  printf 'x {{NOPE}}\n'      > "$pd/b.md"

  out="$( ( PROMPTS_DIR="$pd"; STORY_ID=""
            die(){ echo "XX $1" >&2; exit 1; }; warn(){ echo "!! $1"; }
            source "$render"; render_prompt a.md ) 2>&1 )"; rc=$?
  assert_eq "$rc" 1 "empty placeholder dies"
  assert_contains "$out" "a.md uses {{STORY_ID}} but STORY_ID is empty" "names the placeholder"

  out="$( ( PROMPTS_DIR="$pd"; STORY_ID=900
            die(){ echo "XX $1" >&2; exit 1; }; warn(){ echo "!! $1"; }
            source "$render"; render_prompt b.md ) 2>&1 )"; rc=$?
  assert_eq "$rc" 0 "unknown placeholder does not die"
  assert_contains "$out" "unsubstituted in b.md: {{NOPE}}" "unknown placeholder is named"

  # The target's optional rules may be empty; the target's commands may not.
  printf 'rules {{REPO_RULES}} end\n' > "$pd/c.md"
  printf 'run {{VITEST_CMD}}\n'       > "$pd/d.md"
  out="$( ( PROMPTS_DIR="$pd"; REPO_RULES_TEXT=""
            die(){ echo "XX $1" >&2; exit 1; }; warn(){ echo "!! $1"; }
            source "$render"; render_prompt c.md ) 2>&1 )"; rc=$?
  assert_eq "$rc" 0 "an empty REPO_RULES is legal"
  assert_not_contains "$out" "unsubstituted" "and is substituted, not left as a gap"
  assert_contains "$out" "rules  end" "to nothing"
  out="$( ( PROMPTS_DIR="$pd"; VITEST_CMD=""
            die(){ echo "XX $1" >&2; exit 1; }; warn(){ echo "!! $1"; }
            source "$render"; render_prompt d.md ) 2>&1 )"; rc=$?
  assert_eq "$rc" 1 "an empty VITEST_CMD dies"
  assert_contains "$out" "d.md uses {{VITEST_CMD}} but VITEST_CMD is empty" "and is named"
}

# Phase 1.1. Red when the AC-extraction block before the builder is deleted:
# a story with no `**ACn` heading then reaches the builder and spends quota
# on something the runner can never verify. Goes to needs_human, not left
# ready — a plain die would leave it first in the queue forever.
case_11_no_acs() {
  CASE="11 story without ACs → needs_human before any agent"; fixture c11
  cat > "$REPO/.stories/$STORY.md" <<'EOF'
---
status: ready
round: 0
---

# Story 900: fixture story with no criteria

| AC | claim |
|---|---|
| AC1 | a table row is not a heading |
EOF
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$RC" 1 "exit code (die)"
  assert_eq "$(field status)" needs_human "story status"
  assert_grep 'no acceptance criteria' "$LOG" "reason in output"
  assert_eq "$(calls claude)" 0 "builder must not run"
  assert_eq "$(calls codex)"  0 "reviewer must not run"
}

# Phase 1.2. The harness runs test/build/lint in the reviewer tree before
# the reviewer is asked anything; a red baseline is a machine veto — FAIL
# whatever the reviewer's VERDICT line says. Red when the veto block after
# the VERDICT parse is deleted (the model's PASS then stands).
baseline_case() {                     # baseline_case <name> <label> <expect-in-machine-block> [VAR=value …]
  local name="$1" label="$2" expect="$3"; shift 3
  CASE="$label"; fixture "$name"
  # MAX_ROUNDS=1: a vetoed round is a FAIL and would otherwise (correctly)
  # trigger round 2; one round keeps the case about the veto itself.
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 "$@"
  assert_eq "$(field status)" needs_human "story status"
  assert_eq "$(review_line 3)" "verdict: FAIL" ".review line 3 — machine veto over model PASS"
  assert_grep "$expect" "$REPO/.review/$STORY.md" "machine block names the red baseline"
  assert_grep 'model: *PASS' "$REPO/.review/$STORY.md" "model verdict still recorded"
  assert_eq "$(calls codex)" 1 "reviewer still ran (its prose is evidence)"
}
case_12_baseline_test_red()  { baseline_case c12 "12 baseline test RED vetoes PASS"  'baseline: test RED'  FAKE_VITEST=fail
                               assert_grep '"numFailedTests": *1' "$REPO/.review/$STORY/round-1/baseline/test.summary.json" "summary carries the count"; }
case_13_baseline_build_red() { baseline_case c13 "13 baseline build RED vetoes PASS" 'build RED'           BUILD_CMD=false
                               assert_file "$REPO/.review/$STORY/round-1/baseline/build.log" "build log kept"; }
case_14_baseline_lint_red()  { baseline_case c14 "14 baseline lint RED vetoes PASS"  'lint RED'            LINT_CMD=false; }
# L-08: a suite that collects zero tests is not green.
case_15_baseline_notests()   { baseline_case c15 "15 baseline with zero tests is RED" 'baseline: test RED' FAKE_VITEST=notests; }

# Phase 1.3. The reviewer proposes mutations as files under .review-out/ and
# must leave the tree otherwise untouched. Red when the clean-tree check
# after codex is deleted: a reviewer that applied its own mutation then sails
# through to a verdict.
case_16_reviewer_dirty_tree() {
  CASE="16 reviewer leaves the tree dirty → needs_human"; fixture c16
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_MUTATIONS=dirty
  assert_eq "$RC" 1 "exit code (die)"
  assert_eq "$(field status)" needs_human "story status"
  assert_grep 'left the tree dirty' "$LOG" "reason in output"
  assert_grep 'src/marker.txt' "$LOG" "names the dirty path"
}

# Phase 1.3. Red when the copy-out after codex is deleted: the mutation
# files die with the reviewer worktree and never reach git.
case_17_reviewer_output_copied() {
  CASE="17 reviewer output reaches the evidence dir"; fixture c17
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_MUTATIONS=patch MAX_ROUNDS=1
  local t; t="$(tracked)"
  assert_contains "$t" ".review/$STORY/round-1/mutations/AC1-marker.patch" "patch committed"
  assert_contains "$t" ".review/$STORY/round-1/mutations/AC1-marker.test"  "selector committed"
  assert_contains "$t" ".review/$STORY/round-1/reviewer.md" "reviewer prose committed"
  assert_contains "$t" ".review/$STORY/round-1/builder.md"  "builder message committed"
  assert_grep 'FLEET_MUTANT_MARKER' "$REPO/.review/$STORY/round-1/mutations/AC1-marker.patch" "patch content intact"
  assert_grep 'fake review, call 1' "$REPO/.review/$STORY/round-1/reviewer.md" "prose content intact"
}

# Phase 1.4. The harness applies each proposed mutation in the clean reviewer
# tree, runs the selector, classifies, restores. Red when run_mutations (or
# its call) is deleted: no .result files, no rows in the Machine table.
# The veto on these classes is 1.5; here only the classification is asserted.
mutation_case() {                     # mutation_case <name> <label> <expected-class> <mutation-name> [VAR=value …]
  local name="$1" label="$2" cls="$3" mut="$4"; shift 4
  CASE="$label"; fixture "$name"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 "$@"
  local res="$REPO/.review/$STORY/round-1/mutations/$mut.result"
  assert_file "$res" "result file written"
  assert_eq "$(head -n1 "$res" 2>/dev/null)" "$cls" "classification"
  assert_contains "$(tracked)" ".review/$STORY/round-1/mutations/$mut.result" "result committed"
  assert_grep "^${mut%%-*} +$cls +${mut#*-}" "$REPO/.review/$STORY.md" "row in the Machine table"
}
case_18_mutation_red()      { mutation_case c18 "18 mutation caught → RED"                 RED          AC1-marker FAKE_MUTATIONS=patch    FAKE_VITEST=marker; }
case_19_mutation_green()    { mutation_case c19 "19 mutation survives → GREEN"             GREEN        AC1-marker FAKE_MUTATIONS=patch    FAKE_VITEST=pass; }
case_20_mutation_notests()  { mutation_case c20 "20 mutation breaks compilation → NO_TESTS" NO_TESTS     AC1-marker FAKE_MUTATIONS=patch    FAKE_VITEST=marker-notests; }
case_21_mutation_badpatch() { mutation_case c21 "21 patch does not apply → PATCH_INVALID"   PATCH_INVALID AC1-bad   FAKE_MUTATIONS=badpatch; }
case_22_mutation_prered()   { mutation_case c22 "22 instrument already red → PRE_RED"      PRE_RED      AC1-marker FAKE_MUTATIONS=patch    FAKE_VITEST=fail; }
case_23_mutation_cmd()      { mutation_case c23 "23 .cmd selector, non-zero exit → RED"    RED          AC1-marker FAKE_MUTATIONS=cmd; }
# Phase A3. PRE_RED used to mean two things: an instrument that genuinely
# fails before the mutation (22, worth a human's attention) and a selector
# that collects no tests at all — a path that does not exist, a shell command
# in a .test file (014 round 1). They need different answers, so they need
# different names. Red while both map to PRE_RED.
case_51_selector_invalid() { mutation_case c51 "51 selector collects no tests → SELECTOR_INVALID" SELECTOR_INVALID AC1-marker FAKE_MUTATIONS=patch FAKE_VITEST=notests
                             assert_grep '^computed: FAIL — .*SELECTOR_INVALID' "$REPO/.review/$STORY.md" "it vetoes, and says which class"; }

# Phase 1.5. The verdict is computed: every AC needs ≥1 mutation and every
# mutation must be RED (D1 — any GREEN vetoes). Red when the mutation checks
# in the veto block are deleted: the model's PASS then stands.
veto_case() {                         # veto_case <name> <label> <expected-reason-regex> [VAR=value …]
  local name="$1" label="$2" reason="$3"; shift 3
  CASE="$label"; fixture "$name"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 "$@"
  assert_eq "$(field status)" needs_human "story status"
  assert_eq "$(review_line 3)" "verdict: FAIL" "machine veto over model PASS"
  assert_grep "^computed: FAIL — .*$reason" "$REPO/.review/$STORY.md" "reason enumerated"
  assert_grep '^model: *PASS' "$REPO/.review/$STORY.md" "model verdict still recorded"
}
case_24_veto_green()       { veto_case c24 "24 a surviving mutation vetoes PASS (D1)" 'AC1 marker GREEN'  FAKE_VITEST=pass; }
case_25_veto_no_mutation() { veto_case c25 "25 an AC with no mutation vetoes PASS"    'AC1 has no mutation' FAKE_MUTATIONS=none; }
case_26_veto_wrong_ac()    { veto_case c26 "26 a mutation for another AC does not cover AC1" 'AC1 has no mutation' FAKE_MUTATIONS=ac2only; }

# Phase 1.5. In-run round 2 must see the Machine block, not only the prose.
# Red when the REVIEW_TEXT refresh after the round section is deleted.
case_27_round2_gets_machine_facts() {
  CASE="27 round 2 prompt carries the Machine block"; fixture c27
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL FAKE_VITEST=pass
  assert_eq "$(calls claude)" 2 "two rounds ran"
  assert_grep '^### Machine' "$TRACE/claude-prompt-2" "machine block present"
  assert_grep '^AC1 +GREEN +marker' "$TRACE/claude-prompt-2" "the surviving mutation, as a fact"
  assert_grep 'fake review, call 1' "$TRACE/claude-prompt-2" "reviewer prose still present"
}

# Phase 2.1. `scope_deny:` in the story frontmatter — space-separated globs —
# names files the builder must not touch. Deny-only: no allow list, no line
# means nothing forbidden. Red when check_scope (or its veto) is deleted:
# a builder that changed a denied file then PASSes.
set_deny() { sed -i "2a scope_deny: $1" "$REPO/.stories/$STORY.md"; }
scope_case() {                        # scope_case <name> <label> <deny-globs|-> <expect-status> <expect-scope-regex>
  local name="$1" label="$2" deny="$3" status="$4" scope="$5"
  CASE="$label"; fixture "$name"
  [[ "$deny" == - ]] || set_deny "$deny"
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=src/marker.txt FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" "$status" "story status"
  assert_grep "^scope: +$scope" "$REPO/.review/$STORY.md" "scope line in the Machine block"
  assert_contains "$(tracked)" ".review/$STORY/round-1/scope.txt" "scope evidence committed"
  assert_grep 'src/marker.txt' "$REPO/.review/$STORY/round-1/scope.txt" "changed path recorded"
}
case_28_scope_violation() { scope_case c28 "28 denied file changed → VIOLATION vetoes PASS (nested glob)" 'src/*' needs_human 'VIOLATION src/marker.txt'
                            assert_grep '^computed: FAIL — .*scope VIOLATION' "$REPO/.review/$STORY.md" "reason enumerated"; }
case_29_scope_undeclared() { scope_case c29 "29 no scope_deny → CLEAN, nothing forbidden" - done 'CLEAN'; }
case_30_scope_elsewhere()  { scope_case c30 "30 deny names other files → CLEAN"           'lib/* docs/*' done 'CLEAN'; }

# Found on the first real run (007, round 1). codex prints "Reading
# additional input from stdin..." to stderr when stdin is not a TTY — every
# unattended run. Merged into the JSON stream it made jq abort at line 1;
# the raw JSONL became REVIEW_TEXT and the VERDICT was UNPARSEABLE. The fake
# now always emits that line, so every reviewer case exercises this; this
# case names it. Red when stderr is merged back or the filter is strict.
case_31_codex_stderr_notice() {
  CASE="31 codex stderr notice does not break extraction"; fixture c31
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$(review_line 3)" "verdict: PASS" "verdict parsed from the agent_message"
  assert_grep '^fake review, call 1' "$REPO/.review/$STORY/round-1/reviewer.md" "reviewer.md is prose, not JSON"
  assert_not_grep '"type":"item' "$REPO/.review/$STORY/round-1/reviewer.md" "no raw JSONL in reviewer.md"
  assert_grep 'Reading additional input' "$REPO/.review/$STORY/round-1/reviewer.stderr" "stderr kept as evidence"
  assert_contains "$(tracked)" ".review/$STORY/round-1/reviewer.stderr" "stderr committed"
}

# Found on 007's third round. The round-2 prompt embeds the whole review file;
# at 134 KB it exceeded the kernel's per-argument limit (MAX_ARG_STRLEN,
# 131072), `claude -p "$PROMPT"` never exec'd, and the round died with empty
# output. Prompts now go to the agents on stdin. Red when they go back to argv.
case_32_huge_review_prompt() {
  CASE="32 a >128 KB review still reaches the builder (prompt on stdin)"; fixture c32
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  head -c 140000 /dev/zero | tr '\0' x >> "$REPO/.review/$STORY.md"
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(calls claude)" 2 "builder ran on the rerun"
  assert_grep 'REJECTED' "$TRACE/claude-prompt-2" "builder received the round-2 prompt"
  local size; size="$(wc -c < "$TRACE/claude-prompt-2" 2>/dev/null || echo 0)"
  (( size > 131072 )) && ok || fail "prompt size $size not over MAX_ARG_STRLEN — the case does not test the limit"
  assert_eq "$(field status)" done "story completed"
}

# Found on 007's fifth round: the builder read the story from its worktree and
# the reviewer's tree is detached at the builder's head, so a story amended on
# the base after the branch was cut reached neither. First fixed by syncing the
# file into the worktree; now fixed at the root — the story text is rendered
# into both prompts, so no copy of it need exist in the worktree at all. Red
# when the prompts stop carrying {{STORY}}.
case_33_story_amendment_reaches_builder() {
  CASE="33 a story amended on the base reaches both agents"; fixture c33
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  printf '\n**AC2 — amended after the branch was cut.** Goes red when ignored.\n' >> "$REPO/.stories/$STORY.md"
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 FAKE_MUTATIONS=ac2only
  assert_grep 'amended after the branch was cut' "$TRACE/claude-prompt-2" "builder prompt carries the amendment"
  assert_grep 'amended after the branch was cut' "$TRACE/codex-prompt-2" "reviewer prompt carries it too"
  assert_grep '^acs: .*AC2' "$REPO/.review/$STORY.md" "verdict computed against the amended AC set"
  assert_grep 'commits this round: 1' "$REPO/.review/$STORY.md" "no sync commit inflating the count"
}

# REVIEW_ONLY: re-review the branch head without a builder round. The case a
# story hits after needs_human when a human fixes the branch by hand — until
# now impossible, because the round postcondition demands a builder commit.
# Red when the postcondition's REVIEW_ONLY guard is deleted (the round dies
# at "produced no commits"), or when the builder block is no longer skipped.
case_34_review_only() {
  CASE="34 REVIEW_ONLY re-reviews the head with no builder round"; fixture c34
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  assert_eq "$(field status)" needs_human "first run stopped"
  set_ready
  run "$STORY" FAKE_BUILDER=nocommit FAKE_REVIEWER=PASS MAX_ROUNDS=1 REVIEW_ONLY=1
  assert_eq "$(calls claude)" 1 "builder did not run again"
  assert_eq "$(calls codex)"  2 "reviewer ran again"
  assert_eq "$(field status)" done "verdict computed on the existing head"
  assert_grep 'commits this round: 0' "$REPO/.review/$STORY.md" "zero commits recorded honestly"
  assert_grep 'REVIEW_ONLY' "$REPO/.review/$STORY.md" "the round says no builder ran"
  assert_file "$REPO/.review/$STORY/round-2/mutations/AC1-marker.result" "mutations still ran"
}

# Phase 3.1. RULES say "write the failing test, run it, SEE IT FAIL". Until
# now that was a sentence in a commit message. The builder hands the harness
# the same evidence the reviewer does — a patch removing the behaviour, and
# the selector that must go red — and the runner judges it. Red when the
# builder's copy-out is deleted (no tdd row) or when its classification is
# left out of the veto (a false "observed red" claim passes).
case_35_builder_tdd_mutation() {
  CASE="35 a builder's TDD claim is run, not believed"; fixture c35
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=red FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep '^AC1 +RED +tdd-observed-red' "$REPO/.review/$STORY.md" "the builder's claim ran"
  assert_contains "$(tracked)" ".review/$STORY/round-1/mutations/AC1-tdd-observed-red.result" "committed"
  assert_eq "$(field status)" done "true claim does not block a PASS"

  CASE="35b a false TDD claim fails the story"; fixture c35b
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=green FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep '^AC1 +GREEN +tdd-observed-red' "$REPO/.review/$STORY.md" "survived"
  assert_eq "$(review_line 3)" "verdict: FAIL" "machine veto over model PASS"
  assert_grep '^computed: FAIL — .*tdd-observed-red GREEN' "$REPO/.review/$STORY.md" "reason names the tdd claim"
}

# Phase 3.2. A probe is a test the reviewer constructs to hunt a regression no
# existing test covers (004's reverse-race, 006's cache→empty→populated). They
# used to be written to /tmp and lost with the worktree. A probe is the INVERSE
# of a mutation: RED means it found something, so RED vetoes. Red when
# run_probes, its copy-out, or the probe clause of the veto is deleted.
case_36_reviewer_probes() {
  CASE="36 a green probe is recorded and changes nothing"; fixture c36
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_PROBES=green MAX_ROUNDS=1
  assert_eq "$(field status)" done "a probe that finds nothing does not block"
  assert_grep '^probes:$' "$REPO/.review/$STORY.md" "probes table starts its own line"
  assert_grep '^GREEN +probe-green.test.tsx' "$REPO/.review/$STORY.md" "row in the Machine table"
  assert_contains "$(tracked)" ".review/$STORY/round-1/probes/probe-green.test.tsx" "probe committed"

  CASE="36b a red probe vetoes and is kept as the next story's instrument"; fixture c36b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_PROBES=red MAX_ROUNDS=1
  assert_eq "$(review_line 3)" "verdict: FAIL" "machine veto over model PASS"
  assert_grep '^computed: FAIL — .*probe probe-red.test.tsx RED' "$REPO/.review/$STORY.md" "reason names the probe"
  assert_contains "$(tracked)" ".review/$STORY/round-1/probes/probe-red.test.tsx" "the failing probe is committed verbatim"

  CASE="36c no probes is not a finding"; fixture c36c
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "probes are optional"
  assert_not_grep '^probes:' "$REPO/.review/$STORY.md" "no empty probe table"
}

# Found on story 010 round 2, by the builder doing the right thing. Told its
# TDD patches were PATCH_INVALID, it regenerated them and changed no code —
# correct, and invisible: .review-out/ is gitignored (3.1), so a round whose
# only legitimate output is evidence can never produce a commit. The
# postcondition, written when code was the only possible output, killed it.
# A round is productive if it produced anything the harness can judge.
# Red when the handover clause is removed from the postcondition.
# Case 2 still guards the original hazard: nothing at all is still a die.
case_37_evidence_only_round() {
  CASE="37 a round that only hands over evidence is not 'no commits'"; fixture c37
  run "$STORY" FAKE_BUILDER=nocommit FAKE_BUILDER_MUTATIONS=red FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$RC" 0 "exit code (not the postcondition die)"
  assert_eq "$(calls codex)" 1 "the reviewer still ran"
  assert_grep 'commits this round: 0' "$REPO/.review/$STORY.md" "zero commits recorded honestly"
  assert_grep '^AC1 +RED +tdd-observed-red' "$REPO/.review/$STORY.md" "the handed-over evidence was judged"
  assert_eq "$(field status)" done "the round reached a verdict"
}

# Epics. A story declares the branch it is cut from, so one queue can serve
# several epics at once (epic/offline-pwa, epic/search, …) while the fleet's
# own state — .stories, .review — stays on the
# integration branch the launcher is checked out on. BASE_BRANCH remains the
# default for a story that names none. Red when the story's base: is ignored
# and the worktree is cut from BASE_BRANCH instead.
case_38_story_base() {
  CASE="38 a story's base: decides which branch it is cut from"; fixture c38
  git -C "$REPO" checkout -q -b epic/test
  echo "only on the epic base" > "$REPO/EPIC_MARKER.txt"
  git -C "$REPO" add EPIC_MARKER.txt
  git -C "$REPO" commit -qm "epic/test: a file that exists only here"
  git -C "$REPO" push -q -u origin epic/test
  git -C "$REPO" checkout -q base
  sed -i '2a base: epic/test' "$REPO/.stories/$STORY.md"

  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_file "$FX/wt-$STORY/EPIC_MARKER.txt" "worktree cut from the story's own base"
  assert_eq "$(git -C "$FX/wt-$STORY" rev-parse --abbrev-ref HEAD)" "story/$STORY" "on its story branch"
  assert_eq "$(field status)" done "the story still reaches a verdict"
  assert_grep 'EPIC_MARKER.txt' <(git -C "$REPO" show "origin/epic/test:EPIC_MARKER.txt" >/dev/null 2>&1 && echo EPIC_MARKER.txt) "epic base untouched by the run"
}

# lint-story.sh — mechanical, no fixture and no launcher needed.
# Red when a check is removed; the false-positive guard is red when the "/"
# requirement on citations is dropped, which is how the first version of that
# check behaved: 20 false positives across the real stories, zero findings.
case_39_lint_story() {
  CASE="39 lint-story: shape and citations"; fixture c39
  local d="$FX/lint"; mkdir -p "$d"
  local out rc

  write_story() { printf '%s' "$2" > "$d/$1.md"; }
  lint() { out="$(cd "$FX" && bash "$FLEET/lint-story.sh" t "$d/$1.md" ${2:-} 2>&1)"; rc=$?; }

  write_story good '---
status: ready
round: 0
scope_deny: src/x/*
---
# Story: fine
It cites `src/marker.txt` and `src/marker.txt:1`.
## Acceptance criteria
**AC1 — one bounded claim.** Goes red when removed.
## Known weakness
None stated.
## Out of scope
- nothing
'
  lint good; assert_eq "$rc" 0 "a well-formed story passes"

  write_story noac '---
status: ready
round: 0
---
# Story: criteria in a table
| AC | claim |
|---|---|
| AC1 | invisible to the launcher |
'
  lint noac; assert_eq "$rc" 1 "a story whose ACs are a table fails"
  assert_contains "$out" "no acceptance criteria" "and says why"

  write_story stale '---
status: ready
round: 0
---
# Story: rotted
See `docs/does-not-exist.md` for the diagnosis.
## Acceptance criteria
**AC1 — a claim.** Goes red when removed.
'
  lint stale; assert_eq "$rc" 0 "a missing path with no line is a warning — it may be an instrument to create"
  assert_contains "$out" "new instrument, or rot" "and says which question it is"

  write_story staleline '---
status: ready
round: 0
---
# Story: rotted with a line number
See `docs/does-not-exist.md:12` for the diagnosis.
## Acceptance criteria
**AC1 — a claim.** Goes red when removed.
'
  lint staleline; assert_eq "$rc" 1 "a missing path WITH a line number fails — a line asserts it exists now"
  assert_contains "$out" "does-not-exist.md:12" "and names it"

  write_story overrange '---
status: ready
round: 0
---
# Story: out of range
See `src/marker.txt:99999`.
## Acceptance criteria
**AC1 — a claim.** Goes red when removed.
'
  lint overrange; assert_eq "$rc" 1 "a line number past the end of the file fails"

  write_story unbounded '---
status: ready
round: 0
---
# Story: unbounded
## Acceptance criteria
**AC1 — every stub in the worker global is argument-sensitive.** Goes red.
'
  lint unbounded; assert_eq "$rc" 0 "an unquantified every is a warning, not an error"
  assert_contains "$out" "unquantified domain" "and is named (L-20)"
  lint unbounded --strict; assert_eq "$rc" 1 "--strict makes it fatal"


  write_story temporal '---
status: ready
round: 0
---
# Story: determinism, not scope
## Acceptance criteria
**AC1 — the same input produces the same output every time.** Goes red when it does not.
'
  lint temporal; assert_eq "$rc" 0 "temporal every is not a scope warning"
  assert_not_contains "$out" "unquantified domain" "every time is determinism, not an unbounded set"

  write_story command '---
status: ready
round: 0
---
# Story: a command is not a path
Run `git log -- public/sw.js` to see the history.
## Acceptance criteria
**AC1 — a bounded claim.** Goes red when removed.
'
  lint command; assert_eq "$rc" 0 "a backticked command is not a citation"

  write_story badbase '---
status: ready
round: 0
base: epic/not-a-real-branch
---
# Story: bad base
## Acceptance criteria
**AC1 — a claim.** Goes red when removed.
'
  lint badbase; assert_eq "$rc" 1 "a base: naming no branch fails"

  # The regression guard: prose full of things that look like paths but are not.
  write_story prose '---
status: ready
round: 0
---
# Story: prose
The handler reads `req.method`, `req.url` and `res.ok`, calls `cache.match`
and `caches.open`, and lives in `sw.js`. See `02-REVIEW.md`. It fetches
`/manifest.json` and `/_next/static/chunks/x.js`, and may write
`.blocked/900.md`.
## Acceptance criteria
**AC1 — a bounded claim.** Goes red when removed.
'
  lint prose; assert_eq "$rc" 0 "JS expressions, bare filenames and URL paths are not citations"
}

# Unattended, a hung agent is indistinguishable from a slow one and blocks the
# queue for ever. MAX_TURNS bounds the builder's turns, nothing bounded its
# wall clock — a hung round was killed by hand on 18 Sep only because someone
# was watching. Red when the timeout wrapper is removed from either call.
case_40_agent_timeout() {
  CASE="40 a hung builder is killed and the story stops"; fixture c40
  run "$STORY" FAKE_BUILDER=hang FAKE_REVIEWER=PASS AGENT_TIMEOUT=5 MAX_ROUNDS=1
  assert_eq "$RC" 1 "exit code (die)"
  assert_eq "$(field status)" needs_human "story status"
  assert_grep 'exceeded AGENT_TIMEOUT' "$LOG" "says why"
  assert_eq "$(calls codex)" 0 "the reviewer never ran"

  CASE="40b a hung reviewer is killed and the story stops"; fixture c40b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=hang AGENT_TIMEOUT=5 MAX_ROUNDS=1
  assert_eq "$RC" 1 "exit code (die)"
  assert_eq "$(field status)" needs_human "story status"
  assert_grep 'exceeded AGENT_TIMEOUT' "$LOG" "says why"
}

# The queue runner. Until it existed a human launched each story, watched it,
# and launched the next — the fleet did the judgment unattended but not the
# operating. Red when the loop stops after one story, or when a stopped story
# stops the queue (it must not: that has been the design since phase 4b).
case_41_run_queue() {
  CASE="41 the queue runs every ready story and stops when empty"; fixture c41
  # a second and third story beside the fixture's own
  for extra in 901 902; do
    sed "s/Story $STORY/Story $extra/" "$REPO/.stories/$STORY.md" > "$REPO/.stories/$extra.md"
  done
  # 901 will fail its round; the queue must carry on to 902 regardless
  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local qrc=$QRC

  assert_eq "$qrc" 0 "the runner exits cleanly"
  assert_grep 'queue empty' "$FX/queue.log" "it stopped because nothing was ready"
  for id in "$STORY" 901 902; do
    assert_eq "$(awk -v k=status '/^---$/{d++; next} d==1 && $0 ~ "^"k":" {sub("^"k":[[:space:]]*",""); print; exit}' "$REPO/.stories/$id.md")" done "story $id reached a verdict"
  done
  assert_eq "$(calls claude)" 3 "the builder ran once per story"

  CASE="41b a stopped story does not stop the queue"; fixture c41b
  sed "s/Story $STORY/Story 901/" "$REPO/.stories/$STORY.md" > "$REPO/.stories/901.md"
  # no ACs at all: 900 dies before any agent runs, 901 must still run
  cat > "$REPO/.stories/$STORY.md" <<'EOS'
---
status: ready
round: 0
---
# Story 900: no criteria the launcher can see
EOS
  queue FAKE_STORY_ID=901 FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1

  assert_grep 'no acceptance criteria' "$FX/queue.log" "900 was rejected"
  assert_eq "$(awk -v k=status '/^---$/{d++; next} d==1 && $0 ~ "^"k":" {sub("^"k":[[:space:]]*",""); print; exit}' "$REPO/.stories/901.md")" done "901 still ran and finished"
  assert_grep 'queue empty' "$FX/queue.log" "and the queue drained"
}

# Server stops mid-round: power cut, reboot, OOM. What that leaves is a story
# at `in_progress`, a worktree on disk with the builder's commits in it, and no
# processes anywhere. Everything that matters is on disk or in git, so the
# question is only whether the fleet picks it back up by itself.
case_42_resume_after_crash() {
  CASE="42 a crashed run is reaped and resumed by the queue"; fixture c42
  # Exactly the state a reboot leaves behind.
  git -C "$REPO" worktree add -q "$FX/wt-$STORY" -b "story/$STORY" origin/base
  git -C "$REPO" -C "$FX/wt-$STORY" commit -q --allow-empty -m "work the builder had already done" 2>/dev/null \
    || git -C "$FX/wt-$STORY" commit -q --allow-empty -m "work the builder had already done"
  sed -i '0,/^status:.*/s//status: in_progress/' "$REPO/.stories/$STORY.md"

  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1

  assert_grep 'orphan' "$FX/queue.log" "the stranded story was recognised as an orphan"
  assert_eq "$(field status)" done "and carried through to a verdict"
  assert_grep 'resuming existing worktree' "$FX/queue.log" "its worktree was reused, not rebuilt"
  assert_contains "$(git -C "$FX/wt-$STORY" log --format=%s origin/base..HEAD | tr '\n' ' ')" \
    "work the builder had already done" "the work it had already done survived"
}

# Phase A2, the warn → die audit. Three warnings guarded conditions under
# which nothing measured afterwards means anything; each is now a die.
#
# A seed file is a file the worktree needs to behave like production — today
# just .env.local, the Firebase config. Missing it, the builder works in a
# tree where the app cannot reach Firestore and every result is about that,
# not about the story. This warning is what produced bug #1.
#
# Red while it is a warn: the run continues and the story reaches a verdict.
case_48_missing_seed_file() {
  CASE="48 a missing seed file stops the run"; fixture c48
  rm -f "$REPO/.env.local"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$RC" 1 "exit code (die)"
  assert_grep '\.env\.local' "$LOG" "the message names the file"
  assert_eq "$(calls claude)" 0 "the builder must not run"
}

# A failed install leaves node_modules stale or absent. The baseline then
# measures the install, not the story — and reports it as a red suite.
# Red while it is a warn: the run continues to a verdict.
case_49_install_failure() {
  CASE="49 a failed install stops the run"; fixture c49
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS INSTALL_CMD=false
  assert_eq "$RC" 1 "exit code (die)"
  assert_grep 'install' "$LOG" "the message names the step"
  assert_eq "$(calls claude)" 0 "the builder must not run"
}

# commit_status returns early when there is nothing staged, so a failure here
# is a real one: a hook, a lock, a broken identity. Continuing means the story
# runs on with its state only in the working tree — invisible to status.sh,
# to the queue and to a resumed run after a crash.
# Red while it is a warn: the run continues with uncommitted state.
case_50_status_commit_failure() {
  CASE="50 a failed status commit stops the run"; fixture c50
  printf '#!/bin/sh\nexit 1\n' > "$REPO/.git/hooks/pre-commit"
  chmod +x "$REPO/.git/hooks/pre-commit"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$RC" 1 "exit code (die)"
  assert_grep 'status commit failed' "$LOG" "the message says what failed"
  assert_eq "$(calls claude)" 0 "the builder must not run"
}

# Phase A4. Clearing a story so it can be run again was four manual steps:
# remove the worktree, delete the branch, edit the frontmatter, delete the
# review. Four steps done by hand at the end of a long session is where state
# gets left half-cleared.
#
# reset() is destructive by definition, so the cases are mostly about what it
# refuses to do.
reset_run() {                         # reset_run <args…> → RLOG RRC
  RLOG="$FX/reset.log"
  ( cd "$FX" && env PUSH_STATUS=1 bash "$FLEET/reset.sh" t "$@" ) > "$RLOG" 2>&1
  RRC=$?
}

# Red without reset.sh, and red again if any one of the four steps is
# dropped from it.
case_52_reset() {
  CASE="52 reset clears a story back to the queue"; fixture c52
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  assert_eq "$(field status)" needs_human "precondition: the story stopped"
  assert_file "$REPO/.review/$STORY.md" "precondition: a review exists"

  reset_run "$STORY" --force
  assert_eq "$RRC" 0 "exit code"
  assert_eq "$(field status)" ready "status back to ready"
  assert_eq "$(field round)" 0 "round back to 0"
  [[ -d "$FX/wt-$STORY" ]] && fail "worktree still there" || ok
  git -C "$REPO" show-ref --verify --quiet "refs/heads/story/$STORY" && fail "branch still there" || ok
  assert_no_file "$REPO/.review/$STORY.md" "review file gone"
  [[ -d "$REPO/.review/$STORY" ]] && fail "evidence dir still there" || ok
  assert_not_contains "$(tracked)" ".review/$STORY" "and gone from the index, not just the worktree"
  assert_contains "$(git -C "$REPO" log -1 --format=%s)" "reset" "the reset is a commit, not a local edit"
}

# The guard that matters. A launcher mid-round has a live process in the
# worktree; removing it under the agent loses the round and leaves git holding
# a worktree that is not there. Red when the procs_in_worktree check is
# deleted: the reset proceeds and the branch is gone.
case_53_reset_refuses_while_live() {
  CASE="53 reset refuses while something is running in the worktree"; fixture c53
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  ( cd "$FX/wt-$STORY" && exec sleep 30 ) &
  local pid=$!
  sleep 0.3
  reset_run "$STORY" --force
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  assert_eq "$RRC" 1 "exit code (die)"
  assert_grep 'running' "$RLOG" "the message says why"
  git -C "$REPO" show-ref --verify --quiet "refs/heads/story/$STORY" && ok || fail "the branch must survive"
  assert_eq "$(field status)" needs_human "and the status is untouched"
}

# --force is required because the branch holds work that is on no other
# branch. Red when the unmerged check is deleted: the work goes without a word.
case_54_reset_refuses_unmerged() {
  CASE="54 reset refuses to drop unmerged work without --force"; fixture c54
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  reset_run "$STORY"
  assert_eq "$RRC" 1 "exit code (die)"
  assert_grep 'force' "$RLOG" "the message names the way through"
  git -C "$REPO" show-ref --verify --quiet "refs/heads/story/$STORY" && ok || fail "the branch must survive"
  assert_eq "$(field status)" needs_human "and the status is untouched"
}

# Phase C3. status.sh is the only thing that knows where a story stands, and
# it knows it by parsing frontmatter and asking git — there is no state file,
# deliberately: a second source of truth would need keeping in sync with the
# frontmatter, which is already authoritative. --json gives the same values a
# shape that the Telegram bot and the merger can consume without re-parsing a
# terminal table.
#
# Red without --json: status.sh prints its table and jq rejects it.
case_55_status_json() {
  CASE="55 status.sh --json is machine-readable"; fixture c55
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  local out; out="$( status_run --json )"
  jq -e . >/dev/null 2>&1 <<< "$out" && ok || fail "output parses as JSON"
  assert_eq "$(jq -r '.[0].id'      <<< "$out")" "$STORY" "id"
  assert_eq "$(jq -r '.[0].status'  <<< "$out")" done     "status"
  assert_eq "$(jq -r '.[0].verdict' <<< "$out")" PASS     "computed verdict"
  assert_eq "$(jq -r '.[0].round'   <<< "$out")" 1        "round, as a number"
  assert_eq "$(jq -r '.[0].base'    <<< "$out")" base     "the epic it belongs to"
  assert_eq "$(jq -r '.[0].merged'  <<< "$out")" false    "not merged into it yet"
  # One story, still an array: a caller should not need two parsers.
  local one; one="$( status_run --json "$STORY" )"
  assert_eq "$(jq -r 'length' <<< "$one")" 1 "a single story is an array of one"
  # The table must still be the default — status.sh is read by people too.
  local table; table="$( status_run )"
  assert_contains "$table" "ID" "the human table is still the default"
}

# Phase E1. Nothing merged itself in thirteen stories; every merge was a
# human's. merge.sh is what the queue will call on a computed PASS, so most of
# its cases are about the refusals — the point is not that it merges, it is
# that it merges only what it should and undoes itself when it is wrong.
#
# The post-merge baseline is the check that earns the autonomy: two stories
# that each passed alone can still break each other on the epic branch, and
# nothing before this ran a suite against the merged result.

epic_story() {                        # epic_story <case-name> — a story on an epic branch
  fixture "$1"
  git -C "$REPO" checkout -q -b epic/test
  git -C "$REPO" push -q -u origin epic/test
  git -C "$REPO" checkout -q base
  sed -i '2a base: epic/test' "$REPO/.stories/$STORY.md"
}

merge_run() {                         # merge_run [VAR=value…] [-- <merge.sh flags…>] → MLOG MRC
  local -a vars=() flags=(); local a after=0
  for a in "$@"; do
    if [[ "$a" == -- ]]; then after=1; continue; fi
    if (( after )); then flags+=("$a"); else vars+=("$a"); fi
  done
  MLOG="$FX/merge.log"
  ( cd "$FX" && env PATH="$(FAKES)" PUSH_STATUS=1 FAKE_VITEST=pass FAKE_TRACE_DIR="$TRACE" \
      "${vars[@]}" bash "$FLEET/merge.sh" t "$STORY" "${flags[@]}" ) > "$MLOG" 2>&1
  MRC=$?
}
merge_epic() {                        # merge_epic <log> [VAR=value…] → exit code
  local log="$1"; shift
  ( cd "$FX" && env PATH="$(FAKES)" PUSH_STATUS=1 FAKE_VITEST=pass FAKE_TRACE_DIR="$TRACE" \
      "$@" bash "$FLEET/merge.sh" t --epic epic/test ) > "$log" 2>&1
}

epic_head() { git -C "$REPO" rev-parse "origin/epic/test"; }

# Red without merge.sh, and red again if the push or the frontmatter
# record is dropped: a merge nobody can see, or one that cannot be reverted.
case_56_merge() {
  CASE="56 a computed PASS merges into its epic"; epic_story c56
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "precondition: the story passed"
  local before; before="$(epic_head)"

  merge_run
  assert_eq "$MRC" 0 "exit code"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/epic/test && ok \
    || fail "the story is an ancestor of the epic"
  [[ "$(epic_head)" != "$before" ]] && ok || fail "the epic moved"
  assert_grep '^merged: [0-9a-f]{7,}' "$REPO/.stories/$STORY.md" "the merge sha is recorded, so it can be reverted"
  assert_contains "$(git -C "$REPO" log -1 --format=%s)" "merged" "and recorded as a commit on the integration branch"
}

# Red when the verdict check is deleted: a story the harness vetoed lands.
case_57_merge_refuses_fail() {
  CASE="57 merge refuses a story the machine vetoed"; epic_story c57
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  assert_eq "$(field status)" needs_human "precondition: the story failed"
  local before; before="$(epic_head)"
  merge_run
  assert_eq "$MRC" 1 "exit code (die)"
  assert_grep 'FAIL|needs_human|not done' "$MLOG" "the message says why"
  assert_eq "$(epic_head)" "$before" "the epic did not move"
}

# The check that earns auto-merge. Red when the post-merge baseline or its
# undo is deleted: the epic keeps a merge whose suite is red.
case_58_merge_undoes_itself() {
  CASE="58 a red post-merge baseline undoes the merge"; epic_story c58
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before; before="$(epic_head)"
  merge_run BUILD_CMD=false
  assert_eq "$MRC" 1 "exit code (die)"
  assert_grep 'baseline' "$MLOG" "the message names the baseline"
  assert_eq "$(epic_head)" "$before" "the epic is exactly where it was"
  assert_not_grep '^merged:' "$REPO/.stories/$STORY.md" "and nothing claims it merged"
}

# develop and main are human-only, always. Red when that guard is deleted.
case_59_merge_refuses_integration_branch() {
  CASE="59 merge refuses to touch the integration branch"; fixture c59
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before; before="$(git -C "$REPO" rev-parse origin/base)"
  merge_run
  assert_eq "$MRC" 1 "exit code (die)"
  assert_grep 'base' "$MLOG" "the message names the branch it will not touch"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$before" "the integration branch did not move"
}

# Phase D. The bot is both halves of the control plane: how the fleet reaches
# a human and how the human reaches back. test/curl shadows curl, so no
# case here touches the network.

bot() {                               # bot <verb> [args…] → BLOG BRC
  BLOG="$FX/bot.log"
  ( cd "$FX" && env PATH="$(FAKES)" \
      FAKE_TRACE_DIR="$TRACE" FAKE_VITEST=pass \
      TELEGRAM_BOT_TOKEN=test-token TELEGRAM_CHAT_ID=42 \
      FAKE_TELEGRAM_UPDATES="${FAKE_TELEGRAM_UPDATES:-}" \
      QUEUE_START_CMD=true \
      bash "$FLEET/telegram.sh" "$@" ) > "$BLOG" 2>&1
  BRC=$?
}

update() {                            # update <update_id> <from_id> <text> → writes $FX/updates.json
  jq -nc --argjson uid "$1" --argjson from "$2" --arg text "$3" \
    '{ok:true, result:[{update_id:$uid, message:{from:{id:$from}, text:$text}}]}' \
    > "$FX/updates.json"
  FAKE_TELEGRAM_UPDATES="$FX/updates.json"
}

sent() { cat "$TRACE"/curl-args-* 2>/dev/null | grep -c 'sendMessage' ; }
# The whole recorded argv, not just the line starting with text=: a message is
# multi-line and only its first line carries the prefix.
sent_text() { cat "$TRACE"/curl-args-* 2>/dev/null; }

# Red when the send call is removed, or when it stops passing the text.
case_60_bot_send() {
  CASE="60 send reaches the API with the text"; fixture c60
  bot send "014 needs_human"
  assert_eq "$BRC" 0 "exit code"
  assert_eq "$(sent)" 1 "one sendMessage"
  assert_contains "$(sent_text)" "014 needs_human" "carrying the message"
}

# A fleet with no bot configured must still run: a notification is not part of
# a verdict. Red if the missing configuration is made fatal.
case_61_bot_unconfigured_is_not_fatal() {
  CASE="61 an unconfigured bot does not stop anything"; fixture c61
  BLOG="$FX/bot.log"
  ( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" \
      bash "$FLEET/telegram.sh" send "anyone there" ) > "$BLOG" 2>&1
  assert_eq "$?" 0 "exit code is still 0"
  assert_grep 'not configured' "$BLOG" "and it says why"
  assert_eq "$(sent)" 0 "nothing was sent"
}

# The whole security model. Anyone who finds the bot can message it; only the
# configured chat id is acted on, and an unauthorised sender gets no reply at
# all, because a reply confirms the bot exists.
# Red when the from.id comparison is deleted: a stranger can promote a story.
case_62_bot_ignores_strangers() {
  CASE="62 a message from anyone else changes nothing"; fixture c62
  update 100 999 "/promote t $STORY"
  bot poll
  assert_eq "$BRC" 0 "exit code"
  assert_eq "$(sent)" 0 "no reply — not even a refusal"
  assert_eq "$(field status)" ready "the story was not touched"
  assert_grep 'ignored a message from 999' "$BLOG" "but it is recorded"
}

# Red when /status stops going through status.sh.
case_63_bot_status() {
  CASE="63 /status answers with the table"; fixture c63
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  update 101 42 "/status t"
  bot poll
  assert_eq "$(sent)" 1 "one reply"
  assert_contains "$(sent_text)" "$STORY" "naming the story"
  assert_contains "$(sent_text)" "awaiting merge" "and its landing state"
}

# The write path: this is what makes a phone a control plane.
# Red when cmd_promote stops committing: the queue on the next drain sees
# nothing, because it reads what is committed.
case_64_bot_promote() {
  CASE="64 /promote puts a story back in the queue"; fixture c64
  sed -i '0,/^status:.*/s//status: draft/' "$REPO/.stories/$STORY.md"
  git -C "$REPO" commit -qam "park the fixture story"
  update 102 42 "/promote t $STORY"
  bot poll
  assert_eq "$(field status)" ready "status changed"
  assert_contains "$(git -C "$REPO" log -1 --format=%s)" "promoted" "and committed, which is what the queue reads"
  assert_contains "$(sent_text)" "ready" "the human is told"
}

# An update acknowledged once must never be replayed: /promote twice is
# harmless, but /run twice is a second drain. Red when the offset write is
# deleted.
case_65_bot_offset_advances() {
  CASE="65 an update is acted on once"; fixture c65
  update 500 42 "/status t"
  bot poll
  assert_eq "$(cat "$FLEET/.bot-offset" 2>/dev/null)" 501 "offset is one past the last update"
  assert_grep 'offset=0' "$TRACE/curl-calls" "the first poll started from 0"
  bot poll
  assert_grep 'offset=501' "$TRACE/curl-calls" "the second asked only for what follows"
}

# Phase E3. Auto-merge is allowed to change an epic branch without asking
# because undoing it is one word on a phone. This is that word.

revert_run() {                        # revert_run → RVLOG RVRC
  RVLOG="$FX/revert.log"
  ( cd "$FX" && env PUSH_STATUS=1 bash "$FLEET/revert.sh" t "$STORY" ) > "$RVLOG" 2>&1
  RVRC=$?
}

# Red when the revert, the push or the frontmatter cleanup is dropped: the
# epic keeps the merge, or status.sh goes on claiming a merge that is undone.
case_66_revert() {
  CASE="66 revert undoes the merge it recorded"; epic_story c66
  # A builder that changes a file, not an empty commit: reverting a merge that
  # carried no content is a no-op git refuses, and the case would be testing
  # the fixture rather than the revert.
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before_tree; before_tree="$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")"
  local before; before="$(epic_head)"
  merge_run
  assert_eq "$MRC" 0 "precondition: merged"
  [[ "$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")" != "$before_tree" ]] \
    && ok || fail "precondition: the merge changed the epic's content"

  revert_run
  assert_eq "$RVRC" 0 "exit code"
  assert_eq "$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")" "$before_tree" \
    "the epic's tree is exactly what it was before the merge"
  [[ "$(epic_head)" != "$before" ]] && ok || fail "by a new commit, not by moving the branch back"
  assert_not_grep '^merged:' "$REPO/.stories/$STORY.md" "and the story no longer claims it"
}

# Red when the recorded-sha check is deleted: reverting something that never
# merged would revert whatever HEAD happened to be.
case_67_revert_needs_a_merge() {
  CASE="67 revert refuses a story that never merged"; epic_story c67
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before; before="$(epic_head)"
  revert_run
  assert_eq "$RVRC" 1 "exit code (die)"
  assert_grep 'no recorded merge' "$RVLOG" "the message says why"
  assert_eq "$(epic_head)" "$before" "the epic did not move"
}

# The revert the merge notification offers has to be reachable from the same
# phone that received it, or the revert window is a window onto a laptop.
# Red when /revert is not in the dispatch table.
case_68_bot_revert() {
  CASE="68 /revert undoes a merge from the phone"; epic_story c68
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before_tree; before_tree="$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")"
  merge_run
  assert_eq "$MRC" 0 "precondition: merged"
  update 200 42 "/revert t $STORY"
  bot poll
  assert_eq "$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")" "$before_tree" "the epic is back"
  assert_contains "$(sent_text)" "reverted" "and the human is told"
}

# Phase E2. The launcher decides; the queue merges. A hand-run launch.sh never
# merges anything — that separation is what keeps a debugging session from
# changing a branch.

queue_run() {                         # queue_run [VAR=value…] → $FX/queue.log
  : > "$FX/notify.log"
  cat > "$FX/notify.sh" <<'EON'
printf '%s\n---\n' "$*" >> "$(dirname "$0")/notify.log"
EON
  queue FLEET_NOTIFY_CMD="bash $FX/notify.sh" \
      FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1 "$@"
}

# Red when the merge call is removed from the queue: the story reaches PASS and
# stops there, which is where the fleet has stopped for thirteen stories.
case_69_queue_merges_a_pass() {
  CASE="69 the queue merges a computed PASS and says how to undo it"; epic_story c69
  local before_tree; before_tree="$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")"
  queue_run
  assert_eq "$(field status)" done "the story passed"
  [[ "$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")" != "$before_tree" ]] \
    && ok || fail "the epic has the story's change"
  assert_grep "merged" "$FX/notify.log" "the human is told it merged"
  assert_grep "/revert t $STORY" "$FX/notify.log" "and told the exact way to undo it"
}

# A FAIL must never merge, however the queue is feeling. Red when the verdict
# is read from the reviewer's prose instead of the computed line, or when the
# merge is called unconditionally.
case_70_queue_does_not_merge_a_fail() {
  CASE="70 the queue does not merge a story the machine vetoed"; epic_story c70
  local before; before="$(epic_head)"
  queue_run FAKE_REVIEWER=FAIL
  assert_eq "$(field status)" needs_human "the story stopped"
  assert_eq "$(epic_head)" "$before" "the epic did not move"
  assert_grep "needs_human|needs a human" "$FX/notify.log" "and the human is told it needs them"
}

# AUTO_MERGE=0 is the off switch. Red when it is not honoured — a fleet that
# cannot be told to stop merging is a fleet you turn off entirely.
case_71_auto_merge_can_be_turned_off() {
  CASE="71 AUTO_MERGE=0 leaves the merge to a human"; epic_story c71
  local before; before="$(epic_head)"
  queue_run AUTO_MERGE=0
  assert_eq "$(field status)" done "the story still passed"
  assert_eq "$(epic_head)" "$before" "but nothing merged"
}

# Phase F3. A lesson is prose, and prose cannot fail. What CAN fail is a
# lesson that claims an instrument it no longer has: rename a case, delete it,
# drop it from CASES, and docs/lessons.md goes on telling the next agent
# that the mistake is covered.
#
# This checks the working tree, not a fixture: it is about the files on disk,
# and a fixture would test whatever was last committed instead.
#
# Red when a lesson names a case that does not exist, or one that exists but
# is not in CASES and therefore never runs. Both observed, 18 Sep.
case_72_lessons_name_real_cases() {
  CASE="72 every lesson that claims an instrument still has it"
  local lessons="$FLEET_HOME/docs/lessons.md" lib="$FLEET_HOME/test-lib.sh"
  assert_file "$lessons" "the lessons file is where it is expected"
  local names cases_block missing="" unrun="" n
  cases_block="$(sed -n '/^CASES=(/,/)$/p' "$lib")"
  names="$(grep -oE '^\*\*Enforced by:\*\* `[a-zA-Z0-9_]+`' "$lessons" | tr -d '`' | awk '{print $NF}')"
  [[ -n "$names" ]] && ok || fail "no lesson declares an instrument — the check would be vacuous"
  while read -r n; do
    [[ -n "$n" ]] || continue
    grep -qE "^$n\(\)" "$lib" || { missing+="$n "; continue; }
    [[ "$n" == case_* ]] && ! grep -q "$n" <<< "$cases_block" && unrun+="$n "
  done <<< "$names"
  assert_eq "$missing" "" "lessons naming something that is not in test-lib"
  assert_eq "$unrun"   "" "lessons naming a case that is not in CASES, so never runs"
}

# Phase E4. Epic → develop has never happened in fourteen stories: only
# story → epic and story → develop. An untested path is where the next
# surprise lives, so it gets the same post-merge baseline and a case.
#
# It stays human-run. The queue calls merge.sh with a story id and nothing
# else; nothing in the fleet calls --epic.
case_74_merge_epic_into_integration() {
  CASE="74 an epic merges into the integration branch, with the same baseline"; epic_story c74
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run
  assert_eq "$MRC" 0 "precondition: the story is on the epic"
  local before; before="$(git -C "$REPO" rev-parse origin/base)"

  MLOG="$FX/merge-epic.log"
  merge_epic "$MLOG"
  local rc=$?
  assert_eq "$rc" 0 "exit code"
  [[ "$(git -C "$REPO" rev-parse origin/base)" != "$before" ]] && ok || fail "the integration branch moved"
  git -C "$REPO" merge-base --is-ancestor origin/epic/test origin/base && ok \
    || fail "the epic is an ancestor of it"

  # Same guard as a story merge: a red post-merge baseline keeps it off.
  CASE="74b a red baseline keeps an epic off the integration branch"; epic_story c74b
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run
  before="$(git -C "$REPO" rev-parse origin/base)"
  merge_epic "$FX/merge-epic2.log" BUILD_CMD=false
  assert_eq "$?" 1 "exit code (die)"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$before" "the integration branch did not move"
}

# Red when --epic accepts anything that is not an epic branch: the same
# machinery pointed at main is the one thing this must never do.
case_75_merge_epic_refuses_non_epic() {
  CASE="75 --epic refuses a branch that is not an epic"; epic_story c75
  local before; before="$(git -C "$REPO" rev-parse origin/base)"
  local out; out="$( cd "$FX" && bash "$FLEET/merge.sh" t --epic base 2>&1 )"
  assert_contains "$out" "epic/" "the message says what it will take"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$before" "and nothing moved"
}

# Phase F1. Every story got the same builder at the same model: a one-line CSS
# fix and a service-worker rewrite cost the same. `model:` in the frontmatter
# is the smallest thing that changes that — story_field and the BUILDER_MODEL
# seam both already exist.
#
# Red when the frontmatter is not consulted: the default model is used for a
# story that asked for another.
case_76_story_model() {
  CASE="76 a story may name the model that builds it"; fixture c76
  sed -i '2a model: fleet-test-model' "$REPO/.stories/$STORY.md"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep '^fleet-test-model$' "$TRACE/claude-args-1" "the builder ran on the story's model"
  assert_grep 'model: fleet-test-model' "$LOG" "and the run says so"
  # `model:` in the Machine block is the reviewer's VERDICT; the builder's
  # model is `builder:`. Two lines called model: in the one place a human
  # reads to decide is how a block stops being read.
  assert_grep '^builder:  fleet-test-model' "$REPO/.review/$STORY.md" "and the block records which model built it"

  CASE="76b a story that names none gets the default"; fixture c76b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep '^claude-sonnet-4-6$' "$TRACE/claude-args-1" "the launcher's default model"
}

# Phase D1, the launcher's half. The queue notifies about merges; the launcher
# notifies about the states that stop a story, because a story can stop
# without a queue — a hand-run launcher left detached for an hour is exactly
# when nobody is watching.
#
# The notification lives in set_status rather than at each exit: there are
# five paths to needs_human today and the next one would be added without a
# notification.
#
# Red when the notify call is removed from set_status.
case_77_launcher_notifies_a_stop() {
  CASE="77 the launcher says when a story stops"; fixture c77
  cat > "$FX/notify.sh" <<'EON'
printf '%s\n---\n' "$*" >> "$(dirname "$0")/notify.log"
EON
  : > "$FX/notify.log"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1 \
      FLEET_NOTIFY_CMD="bash $FX/notify.sh"
  assert_eq "$(field status)" needs_human "the story stopped"
  assert_grep "$STORY" "$FX/notify.log" "the message names the story"
  assert_grep 'needs_human' "$FX/notify.log" "and the state it stopped in"

  CASE="77b a story that finishes is the queue's news, not the launcher's"; fixture c77b
  cat > "$FX/notify.sh" <<'EON'
printf '%s\n---\n' "$*" >> "$(dirname "$0")/notify.log"
EON
  : > "$FX/notify.log"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 \
      FLEET_NOTIFY_CMD="bash $FX/notify.sh"
  assert_eq "$(field status)" done "the story passed"
  assert_eq "$(wc -c < "$FX/notify.log")" 0 "and the launcher said nothing — merging is the queue's to announce"
}

# Phase C1/C2. Nothing recorded what a round cost. "Is a second lane worth
# it", "is a bigger model worth it for this story", "why did that take an
# hour" were all unanswerable, and each would have been answered by numbers
# the agents already return and the launcher was throwing away.
#
# Red when the raw builder object is not kept, or the timing line is dropped.
case_78_round_cost_is_recorded() {
  CASE="78 a round records what it cost"; fixture c78
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local ev="$REPO/.review/$STORY/round-1"
  assert_file "$ev/builder.json" "the builder's own object is kept, not just its prose"
  jq -e 'has("is_error")' >/dev/null 2>&1 < "$ev/builder.json" && ok \
    || fail "and it is the JSON the agent returned"
  assert_contains "$(tracked)" ".review/$STORY/round-1/builder.json" "committed with the rest of the evidence"
  assert_grep '^timing: ' "$REPO/.review/$STORY.md" "the machine block says what the round cost"
  assert_grep 'builder [0-9]+s' "$REPO/.review/$STORY.md" "per phase, in seconds"
  assert_grep 'total [0-9]+s' "$REPO/.review/$STORY.md" "and in total"
}

# Phase C4. The bot writes .stories/<id>.md and commits it in the main
# checkout; the launcher commits there too, on its own schedule. Two writers,
# one index. Without a lock the loser gets "Unable to create .git/index.lock"
# — and since 18 Sep a failed status commit is a die, so the loser is a dead
# round.
#
# The case makes the hazard deterministic rather than hoping to catch a race:
# a background holder takes the fleet lock AND leaves a real .git/index.lock
# behind it, exactly as a mid-commit git does. A writer that does not wait for
# the fleet lock walks into the index lock and fails.
#
# Red without the lock: /promote finds index.lock and the story never changes.
case_79_writers_do_not_collide() {
  CASE="79 a second writer waits rather than walking into a held index"; fixture c79
  sed -i '0,/^status:.*/s//status: draft/' "$REPO/.stories/$STORY.md"
  git -C "$REPO" commit -qam "park the fixture story"

  # The holder: take the fleet lock, plant an index.lock, hold both briefly.
  ( exec 9>"$REPO/.git/fleet.lock"
    flock 9
    : > "$REPO/.git/index.lock"
    sleep 3
    rm -f "$REPO/.git/index.lock" ) &
  local holder=$!
  sleep 0.5

  update 300 42 "/promote t $STORY"
  bot poll
  wait "$holder" 2>/dev/null

  assert_eq "$(field status)" ready "the promotion landed"
  assert_contains "$(git -C "$REPO" log -1 --format=%s)" "promoted" "as a commit, having waited its turn"
}

# Phase E4, the reading half. Stories are visible one at a time; an epic — the
# thing a human actually decides to merge — was visible nowhere. Red without
# --epics, and red again if it stops counting what is merged.
case_80_status_epics() {
  CASE="80 status.sh --epics says where each epic stands"; epic_story c80
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local out; out="$( status_run --epics )"
  assert_contains "$out" "epic/test" "the epic is listed"
  assert_contains "$out" "1 story" "with how many stories belong to it"
  assert_contains "$out" "0 merged" "and how many of them have landed on it"
  merge_run
  out="$( status_run --epics )"
  assert_contains "$out" "1 merged" "which changes when one does"
  assert_contains "$out" "ahead" "and says the epic is ahead of the integration branch"
}

# AC1. Red when the refresh call is deleted from run-queue.sh: the
# checkout never learns the story is ready and the queue reports nothing ready.
# Also red when the refresh is replaced with `git pull --ff-only` (refused on
# divergence) or with `git reset --hard` (pre-run HEAD is no longer ancestor).
case_43_refresh_diverged() {
  CASE="43 story promoted on origin runs even with local-only commits"
  fixture c43 draft

  # Checkout adds a commit touching a different file; story stays draft.
  echo "local-only" > "$REPO/local-only.txt"
  git -C "$REPO" add local-only.txt
  git -C "$REPO" commit -qm "local: local-only file"
  local pre_head; pre_head="$(git -C "$REPO" rev-parse HEAD)"

  # Origin: promote story to ready via a second clone (simulates phone edit).
  git clone -q "$FX/origin.git" "$FX/origin2"
  git -C "$FX/origin2" config user.name  fleet-test
  git -C "$FX/origin2" config user.email fleet-test@localhost
  git -C "$FX/origin2" checkout -q base
  sed -i '0,/^status:.*/s//status: ready/' "$FX/origin2/.stories/$STORY.md"
  git -C "$FX/origin2" add ".stories/$STORY.md"
  git -C "$FX/origin2" commit -qm "phone: promote story to ready"
  git -C "$FX/origin2" push -q origin base

  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1

  assert_eq "$(field status)" done "AC1: story reached done"
  git -C "$REPO" merge-base --is-ancestor "$pre_head" HEAD \
    && ok || fail "AC1: pre-run HEAD is not an ancestor of new HEAD"
}

# AC2. Red when the failure branch exits or dies instead of continuing (the
# story is never run), or when the warning line is removed.
case_44_refresh_fail() {
  CASE="44 failed refresh does not stop the drain"; fixture c44

  # Break the origin URL so fetch fails immediately.
  git -C "$REPO" remote set-url origin "/no/such/path"

  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1

  assert_eq "$(field status)" done "AC2: story reached done despite fetch failure"
  local rfl; rfl="$(grep 'refresh failed' "$FX/queue.log" | head -1)"
  [[ -n "$rfl" ]] && ok || fail "AC2: queue log has no 'refresh failed' line"
  [[ "$rfl" == *"continuing on local state"* ]] \
    && ok || fail "AC2: 'refresh failed' line does not say 'continuing on local state'"
}

# AC3. Red when run-queue.sh leaves a conflicted merge in place (abort
# deleted), when -X theirs resolves it silently (no warning, conflict-file
# gets origin's version), or when the uncommitted edit is lost.
case_45_conflict_leaves_local_work() {
  CASE="45 conflicting refresh leaves local work unchanged"
  fixture c45
  printf 'line: original\n'  > "$REPO/conflict-file.txt"
  printf 'initial content\n' > "$REPO/clean.txt"
  git -C "$REPO" add conflict-file.txt clean.txt
  git -C "$REPO" commit -qm "fixture: files"
  git -C "$REPO" push -q origin base

  # Checkout: commit a change to conflict-file.txt; story stays ready.
  printf 'line: checkout\n' > "$REPO/conflict-file.txt"
  git -C "$REPO" add conflict-file.txt
  git -C "$REPO" commit -qm "local: checkout version"
  local pre_head; pre_head="$(git -C "$REPO" rev-parse HEAD)"

  # Uncommitted edit to a tracked file that neither commit touches.
  printf 'dirty\n' >> "$REPO/clean.txt"
  local clean_sum_before; clean_sum_before="$(sha256sum "$REPO/clean.txt" | awk '{print $1}')"

  # Origin: conflict on the same line of conflict-file.txt.
  git clone -q "$FX/origin.git" "$FX/origin2"
  git -C "$FX/origin2" config user.name  fleet-test
  git -C "$FX/origin2" config user.email fleet-test@localhost
  git -C "$FX/origin2" checkout -q base
  printf 'line: origin\n' > "$FX/origin2/conflict-file.txt"
  git -C "$FX/origin2" add conflict-file.txt
  git -C "$FX/origin2" commit -qm "origin: origin version"
  git -C "$FX/origin2" push -q origin base

  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1

  git -C "$REPO" merge-base --is-ancestor "$pre_head" HEAD \
    && ok || fail "AC3: pre-run HEAD is not an ancestor of new HEAD"
  assert_eq "$(git -C "$REPO" show HEAD:conflict-file.txt)" "line: checkout" \
    "AC3: committed conflict-file still has checkout version"
  assert_no_file "$REPO/.git/MERGE_HEAD" "AC3: no merge left in progress"
  [[ ! -d "$REPO/.git/rebase-merge" ]] && ok || fail "AC3: rebase-merge dir exists"
  assert_not_grep '<<<<<<<' "$REPO/conflict-file.txt" "AC3: no conflict markers in worktree"
  local clean_sum_after; clean_sum_after="$(sha256sum "$REPO/clean.txt" | awk '{print $1}')"
  assert_eq "$clean_sum_after" "$clean_sum_before" \
    "AC3: uncommitted edit is byte-identical (sha256sum)"
  assert_grep 'refresh failed' "$FX/queue.log" "AC3: queue log has refresh failed line"
  assert_eq "$(field status)" done "AC3: story reached done"
}

# P1 guard. Red when the MERGE_HEAD guard is removed from run-queue.sh:
# the in-progress merge is aborted and the staged resolution is lost.
# Uses --max 0 so commit_status never runs and MERGE_HEAD stays set.
case_81_existing_merge_preserved() {
  CASE="81 an in-progress merge resolution is not discarded by the refresh"
  fixture c81
  printf 'line: original\n' > "$REPO/conflict-file.txt"
  git -C "$REPO" add conflict-file.txt
  git -C "$REPO" commit -qm "fixture: files"
  git -C "$REPO" push -q origin base

  # Checkout: local commit that conflicts with origin.
  printf 'line: checkout\n' > "$REPO/conflict-file.txt"
  git -C "$REPO" add conflict-file.txt
  git -C "$REPO" commit -qm "local: checkout version"

  # Origin: conflicting change on the same line.
  git clone -q "$FX/origin.git" "$FX/origin2"
  git -C "$FX/origin2" config user.name  fleet-test
  git -C "$FX/origin2" config user.email fleet-test@localhost
  git -C "$FX/origin2" checkout -q base
  printf 'line: origin\n' > "$FX/origin2/conflict-file.txt"
  git -C "$FX/origin2" add conflict-file.txt
  git -C "$FX/origin2" commit -qm "origin: conflicting version"
  git -C "$FX/origin2" push -q origin base

  # Human: starts a conflicting merge, carefully resolves it, stages the fix.
  git -C "$REPO" fetch -q origin
  git -C "$REPO" merge --no-edit origin/base 2>/dev/null || true
  printf 'line: carefully resolved human work\n' > "$REPO/conflict-file.txt"
  git -C "$REPO" add conflict-file.txt
  # MERGE_HEAD now set; the resolution is staged but not committed.

  queue MAX=0

  assert_file "$REPO/.git/MERGE_HEAD" "AC81: MERGE_HEAD not aborted by refresh"
  assert_eq "$(git -C "$REPO" show :conflict-file.txt)" \
    "line: carefully resolved human work" "AC81: staged resolution preserved"
  assert_grep 'refresh skipped' "$FX/queue.log" "AC81: queue log shows refresh was skipped"
}

# ── run ──────────────────────────────────────────────────────────────────────

# lib.sh, sourced alone. load_repo is where the registry meets the target's
# config, and every refusal here is one a bot command or a typo can reach.
#
# Red without lib.sh, and red again when any refusal or the env-over-file
# rule is deleted.
case_82_load_repo() {
  CASE="82 load_repo: registry, config, env over file"
  local d="$TMP/c82" lib="${FLEET_LIB_OVERRIDE:-$FLEET_HOME/lib.sh}" out rc
  # Each target in its own parent directory: siblings would share ../wt-<id>
  # and load_repo refuses them (case 89).
  mkdir -p "$d/repos" "$d/a/target/.fleet" "$d/b/target2"
  git init -q "$d/a/target"; git init -q "$d/b/target2"
  printf 'REPO_PATH=%s\n' "$d/a/target"  > "$d/repos/t.env"
  printf 'REPO_PATH=%s\n' "$d/b/target2" > "$d/repos/noconf.env"
  printf 'REPO_PATH=%s\n' "$d/c/nowhere" > "$d/repos/gone.env"
  cat > "$d/a/target/.fleet/config" <<'EOF'
BASE_BRANCH=base
INSTALL_CMD='true'
VITEST_CMD='fake vitest'
BUILD_CMD=true
LINT_CMD=true
SEED_FILES='.env.local extra.env'
PROBE_DIR=src
EOF
  probe() {                           # probe <repo-name> [VAR=value …] → out rc
    local name="$1"; shift
    out="$( env -i PATH="$PATH" HOME="$HOME" "$@" FLEET_REGISTRY_DIR="$d/repos" \
            bash -c 'source "$1" && load_repo "$2" && printf "%s|%s|%s|%s|%s\n" "$REPO_ROOT" "$BASE_BRANCH" "$VITEST_CMD" "${#SEED_FILES_ARR[@]}" "${SEED_FILES_ARR[1]}"' \
            _ "$lib" "$name" 2>&1 )"; rc=$?
  }
  probe t
  assert_eq "$rc" 0 "a registered repo with a config loads"
  assert_contains "$out" "$d/a/target|base|fake vitest|2|extra.env" "path, config values and the split seed list"

  probe nope;   assert_eq "$rc" 1 "an unregistered name dies";   assert_contains "$out" "unknown repo 'nope'" "and says so"
  probe '../t'; assert_eq "$rc" 1 "a path is not a repo name";   assert_contains "$out" "not a repo name" "and says so"
  probe gone;   assert_eq "$rc" 1 "a REPO_PATH that is not a git checkout dies"
  probe noconf; assert_eq "$rc" 1 "a target without .fleet/config dies"; assert_contains "$out" ".fleet/config" "and names the file"

  probe t BASE_BRANCH=fromenv VITEST_CMD='from env'
  assert_eq "$rc" 0 "still loads with overrides"
  assert_contains "$out" "$d/a/target|fromenv|from env|" "a variable in the environment wins over the file"

  sed -i '/^PROBE_DIR=/d' "$d/a/target/.fleet/config"
  probe t; assert_eq "$rc" 1 "a missing required key dies"; assert_contains "$out" "PROBE_DIR" "and names it"
  probe t PROBE_DIR=probes; assert_eq "$rc" 0 "unless the environment supplies it"

  # Plan of 20 Sep: how a repo lands. Absent means direct; pr needs the command.
  probe t PROBE_DIR=probes MERGE_MODE=pr
  assert_eq "$rc" 1 "MERGE_MODE=pr without PR_CMD dies"; assert_contains "$out" "PR_CMD" "and names the missing key"
  probe t PROBE_DIR=probes MERGE_MODE=bogus
  assert_eq "$rc" 1 "an unknown MERGE_MODE dies"; assert_contains "$out" "MERGE_MODE" "and names the key"
  probe t PROBE_DIR=probes MERGE_MODE=pr PR_CMD='echo url'
  assert_eq "$rc" 0 "pr with a command loads"
  printf 'MERGE_MODE=pr\nPR_CMD=echo\n' >> "$d/a/target/.fleet/config"
  probe t PROBE_DIR=probes MERGE_MODE=direct
  assert_eq "$rc" 0 "MERGE_MODE from the environment wins over the file, like every key"
}

# The harness sources <target>/.fleet/config. A builder that can change it on
# a story branch can change what the harness runs, so it is denied whether or
# not the story names it — the mirror image of the always-allowed .blocked/.
# And nothing of the harness's own is allow-listed any more: docs/fleet/ was a
# khaita convention, not a rule.
#
# Red when the .fleet/ check is deleted (83) or the docs/fleet allowance is
# restored (83b).
case_83_scope_fleet_config() {
  CASE="83 .fleet/* is denied whatever the story says"; fixture c83
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=.fleet/config FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" needs_human "story status"
  assert_grep '^scope: +VIOLATION \.fleet/config' "$REPO/.review/$STORY.md" "the config is named"

  CASE="83b docs/fleet/<id>-*.md is an ordinary path now"; fixture c83b
  mkdir -p "$REPO/docs/fleet"; printf 'notes\n' > "$REPO/docs/fleet/$STORY-notes.md"
  git -C "$REPO" add docs; git -C "$REPO" commit -qm "fixture: a docs file"; git -C "$REPO" push -q origin base
  set_deny 'docs/*'
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH="docs/fleet/$STORY-notes.md" FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" needs_human "story status"
  assert_grep "^scope: +VIOLATION docs/fleet/$STORY-notes.md" "$REPO/.review/$STORY.md" "no allowance for a docs path"
}

# Which files a fresh worktree must be given is the target's knowledge
# (khaita: .env.local, or the app talks to projects/undefined — story 002),
# so it comes from .fleet/config, and a target may have none.
#
# Red while SEED_FILES is a hardcoded array in the launcher: extra.env is
# never looked for (85), and .env.local is demanded of a target that has no
# seed files at all (85b).
case_85_seed_files_from_config() {
  CASE="85 the seed list is the target's, not the harness's"; fixture c85
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 SEED_FILES='.env.local extra.env'
  assert_eq "$RC" 1 "a seed file the target names and does not have stops the run"
  assert_grep 'extra.env is missing' "$LOG" "and it is named"

  CASE="85b an empty seed list is legal"; fixture c85b
  rm -f "$REPO/.env.local"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 SEED_FILES=
  assert_eq "$(field status)" done "nothing to seed, nothing to miss"
}

# A probe must land inside the target's test include glob or it collects no
# tests; where that is (khaita: src/__tests__) is the target's knowledge.
#
# Red while the destination is hardcoded (86), and when the launcher copies
# into a directory that is not there — cp fails, nothing notices, the probe
# silently never runs (86b).
case_86_probe_dir() {
  CASE="86 a probe lands in the target's PROBE_DIR"; fixture c86
  mkdir -p "$REPO/lib"; printf 'x\n' > "$REPO/lib/.keep"
  git -C "$REPO" add lib; git -C "$REPO" commit -qm "fixture: lib/"; git -C "$REPO" push -q origin base
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_PROBES=green MAX_ROUNDS=1 PROBE_DIR=lib
  assert_eq "$(field status)" done "precondition: the round completes"
  assert_grep 'vitest lib/fleet-probe-probe-green.test.tsx' "$TRACE/calls" "the selector is under PROBE_DIR"

  CASE="86b a PROBE_DIR the worktree does not have stops the run"; fixture c86b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_PROBES=green MAX_ROUNDS=1 PROBE_DIR=nowhere
  assert_eq "$RC" 1 "die"
  assert_grep 'nowhere' "$LOG" "naming the directory"
}

# The prompts used to name khaita's stack: "Run: npm test, npm run build,
# npm run lint" while the harness ran $VITEST_CMD/$BUILD_CMD/$LINT_CMD, and a
# "no firebase" rule for every target. The commands now come from the
# target's config, and a target may add its own rules through REPO_RULES.
#
# Red while review.md says npm (84), while rules.md has no {{REPO_RULES}}
# (84b), and when render_prompt starts refusing an empty REPO_RULES (84c).
case_84_prompts_carry_the_targets_facts() {
  CASE="84 the reviewer is told the target's commands, not npm's"; fixture c84
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep "Run: $FLEET/test/vitest, true, true" "$TRACE/codex-prompt-1" "the config's commands, in order"
  assert_not_grep 'npm test' "$TRACE/codex-prompt-1" "and not khaita's"

  CASE="84b REPO_RULES reaches the builder through the rules"; fixture c84b
  printf -- '- Never touch the SENTINEL_RULE_9f3 subsystem.\n' > "$REPO/.fleet/rules.md"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 REPO_RULES=.fleet/rules.md
  assert_grep 'SENTINEL_RULE_9f3' "$TRACE/claude-prompt-1" "the target's rule is in the builder prompt"
  assert_not_grep 'firebase' "$TRACE/claude-prompt-1" "khaita's rule is not"

  CASE="84c a target without REPO_RULES renders without a gap"; fixture c84c
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "the round completes"
  assert_not_grep '{{REPO_RULES}}' "$TRACE/claude-prompt-1" "no leftover placeholder"
  assert_not_grep 'unsubstituted' "$LOG" "and no warning about one"
}

# One fleet, many repos. `--all` walks the registry and drains each repo in
# turn, in a fresh process per repo so nothing — config, counters, a die —
# crosses from one to the next.
#
# Red when --all is not understood ("not a repo name"), or when the walk
# stops at the first repo.
case_87_queue_all_repos() {
  CASE="87 run-queue.sh --all drains every registered repo"; fixture c87
  # A second target, in its own directory, with its own origin and story 901.
  local U="$FX/two/repo-u"
  mkdir -p "$FX/two"
  cp -r "$FX/origin.git" "$FX/two/origin-u.git"
  git clone -q "$FX/two/origin-u.git" "$U"
  git -C "$U" config user.name fleet-test; git -C "$U" config user.email fleet-test@localhost
  sed -i "s/Story $STORY/Story 901/" "$U/.stories/$STORY.md"
  git -C "$U" mv ".stories/$STORY.md" .stories/901.md
  git -C "$U" commit -qam "fixture: story 901"
  git -C "$U" push -q origin base
  printf 'FLEET_TEST=1\n' > "$U/.env.local"
  printf 'REPO_PATH=%s\n' "$U" > "$FLEET/repos/u.env"

  QUEUE_TARGET=--all queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$QRC" 0 "exit code"
  assert_eq "$(field status)" done "repo t: story $STORY reached a verdict"
  assert_eq "$(frontmatter "$U/.stories/901.md" status)" done "repo u: story 901 reached a verdict"
  assert_eq "$(calls claude)" 2 "one builder run per repo"
  assert_grep 'repo: t' "$FX/queue.log" "the walk names each repo"
  assert_grep 'repo: u' "$FX/queue.log" "…and the next one"
}

# Two targets under one parent directory would share ../wt-<id>: story 014
# of one is story 014 of the other, as far as the worktree path is concerned.
# The registry is the only place that can see both, so load_repo refuses.
#
# Red when the check is deleted: the second entry loads without complaint.
case_89_shared_parent_dir_refused() {
  CASE="89 two registered repos in one parent directory are refused"; fixture c89
  git clone -q "$FX/origin.git" "$FX/repo-v"          # a sibling of repo/, same parent
  printf 'REPO_PATH=%s\n' "$FX/repo-v" > "$FLEET/repos/v.env"
  local out; out="$( cd "$FX" && bash "$FLEET/status.sh" t 2>&1 )"
  assert_eq "$?" 1 "load_repo dies"
  assert_contains "$out" "same parent directory" "and says why"
  assert_contains "$out" "v" "naming the other entry"
}

# L-27. The launcher no longer runs this suite, but a developer's shell can
# still export MAX_ROUNDS=1 and reproduce it exactly: cases 4, 5, 9 and 27
# need the two-round ceiling and would fail looking like real findings. The
# suite therefore re-executes itself under env -i with a short allowlist
# before any fixture is built. This case is the suite looking at its own
# environment — the only vantage point from which the leak is visible.
#
# Red when the re-exec at the top is deleted: MAX_ROUNDS=1 bash test-lib.sh 88
case_88_suite_env_is_clean() {
  CASE="88 the suite runs under a clean environment"
  local leaked="" v
  for v in MAX_ROUNDS BASE_BRANCH VITEST_CMD BUILD_CMD LINT_CMD INSTALL_CMD PUSH_STATUS AGENT_TIMEOUT; do
    [[ -v "$v" ]] && leaked+="$v "
  done
  assert_eq "$leaked" "" "launcher seams leaked into the suite's environment"
  [[ -n "${PATH:-}" ]] && ok || fail "PATH survived, or nothing would run"
  [[ -n "${HOME:-}" ]] && ok || fail "HOME survived, or git would have no identity"
}

# Plan of 20 Sep. From a phone an id means nothing and `done` covers three
# situations: waiting for a human, sitting on an epic, landed. The title comes
# from the story's heading; the landing state is derived from git and the
# computed verdict, never stored. The epic block leads the default output so
# what a human decides to merge is the first thing they read, and --bot is
# the phone form: no colour, the hint spelled as the bot command.
#
# Red without the title, without the derived state (a bare `done`), without
# the INTO column, without the epic line in the default output, and without
# --bot (usage, exit 2).
case_90_status_titles_and_landing() {
  CASE="90 status.sh: title, landing state, INTO, epic summary, --bot"; fixture c90
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  # A second story that has not run, so the table has one line per state.
  sed "s/Story $STORY/Story 901/; 0,/^status:.*/s//status: draft/" "$REPO/.stories/$STORY.md" \
    > "$REPO/.stories/901.md"
  local out; out="$( status_run )"
  assert_contains "$out" "TITLE" "the table has a title column"
  assert_contains "$out" "INTO" "and says where each story lands"
  assert_contains "$out" "fixture story" "the title, without its 'Story NNN:' prefix"
  assert_not_contains "$out" "Story $STORY:" "the prefix is stripped"
  assert_contains "$out" "awaiting merge" "a PASS nobody merged is awaiting merge"
  assert_contains "$out" "draft" "a story that has not run shows its frontmatter status as is"
  local j; j="$( status_run --json )"
  assert_eq "$(jq -r '.[0].title'   <<< "$j")" "fixture story"   "--json carries the title"
  assert_eq "$(jq -r '.[0].landing' <<< "$j")" "awaiting merge"  "and the landing state"
  assert_eq "$(jq -r '.[0].status'  <<< "$j")" done              "while status stays the frontmatter's"
  assert_eq "$(jq -r '.[1].landing' <<< "$j")" draft             "a draft's landing state is its status"
  # A phone wraps a <pre> block at ~40 columns, so --bot is not the table:
  # a short state line and the title on its own line, newest story first.
  local bot; bot="$( status_run --bot )"
  assert_not_contains "$bot" "TITLE" "--bot has no table header"
  assert_contains "$bot" "$STORY  awaiting merge  R1  PASS  → base" "a state line short enough not to wrap"
  assert_contains "$bot" $'\n     fixture story' "the title on its own line under it"
  [[ "${bot%%$STORY*}" == *901* ]] && ok || fail "901 comes before $STORY: newest first"

  CASE="90b a story on an epic: on epic, then landed"; epic_story c90b
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  out="$( status_run )"
  assert_contains "$out" "epic/test" "INTO names the epic"
  assert_contains "$out" "awaiting merge" "not merged yet"
  merge_run
  assert_eq "$MRC" 0 "the story merged into its epic"
  out="$( status_run )"
  assert_contains "$out" "on epic" "merged into an epic that is not in the integration branch"
  assert_contains "$out" "1 merged" "the epic block leads the default output"
  assert_contains "$out" "merge.sh t --epic epic/test" "with the command a human runs to land it"
  local bot; bot="$( status_run --bot )"
  assert_contains "$bot" "/merge t epic/test" "--bot spells the hint as the phone command"
  assert_contains "$bot" "$STORY  on epic  R1  PASS  → epic/test" "and has the same state"
  assert_not_contains "$bot" $'\x1b[' "with no colour codes"
  local epics; epics="$( status_run --epics )"
  assert_contains "$epics" "epic/test" "--epics still prints the epic block"
  assert_not_contains "$epics" "on epic" "and nothing else"
  merge_epic "$FX/merge-epic.log"
  assert_eq "$?" 0 "the epic landed on the integration branch"
  out="$( status_run )"
  assert_contains "$out" "landed" "and the story is now landed"
  assert_eq "$(jq -r '.[0].landing' <<< "$( status_run --json )")" landed "--json agrees"
}

# Plan of 20 Sep. A table sent as plain text arrives in a proportional font
# and falls apart; inside <pre> it keeps its columns and scrolls sideways.
# Telegram caps a message at 4096 characters, so a long table goes as
# several messages split on line boundaries rather than one refused send.
#
# Red without --pre (no parse_mode, no <pre> in the argv) and without the
# split (one send for a table that cannot fit).
case_93_bot_status_pre() {
  CASE="93 /status arrives as a code block, split when it cannot fit"; fixture c93
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  update 110 42 "/status t"
  bot poll
  assert_eq "$(sent)" 1 "one message for a short table"
  assert_contains "$(sent_text)" "parse_mode=HTML" "sent as HTML"
  assert_contains "$(sent_text)" "text=<pre>" "inside a code block"
  assert_contains "$(sent_text)" "</pre>" "which is closed"
  assert_contains "$(sent_text)" "fixture story" "and carries the table"
  assert_not_contains "$(sent_text)" $'\x1b[' "with no colour codes"

  CASE="93 a table over the limit is split on line boundaries"; fixture c93-long
  local i long; long="$(printf 'a%.0s' {1..200})"
  for i in $(seq 901 925); do
    sed "s/Story $STORY: fixture story/Story $i: $long/" "$REPO/.stories/$STORY.md" > "$REPO/.stories/$i.md"
  done
  update 111 42 "/status t"
  bot poll
  assert_eq "$(sent)" 2 "two messages"
  local n; n="$(cat "$TRACE"/curl-args-* | grep -c '^text=<pre>')"
  assert_eq "$n" 2 "each its own code block"
  # A row is never cut in half: every one of the 25 arrives as a whole line.
  assert_eq "$(cat "$TRACE"/curl-args-* | grep -cE "(^|<pre>)     $long\$")" 25 "every title arrived whole on its own line, one opening the second message"
}

# Plan of 20 Sep. merge.sh refuses the integration branch because the QUEUE
# must never land anything there. A human's word from a phone is a different
# thing: --land lifts that one refusal for this invocation. The queue never
# passes it, so auto-merge stays story → epic. main and master stay refused
# whatever the flag, and a story that lives on an epic is not landed one by
# one — its epic is, and the refusal says how.
#
# Red when --land is unknown or ignored, when it also lifts main, when it lets
# an epic story skip its epic, or when the queue starts passing it.
case_91_merge_land() {
  CASE="91 --land lands a PASS story on the integration branch, a human's call"; fixture c91
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before; before="$(git -C "$REPO" rev-parse origin/base)"
  merge_run
  assert_eq "$MRC" 1 "without --land the refusal of case 59 stands"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$before" "and the integration branch did not move"
  local nv; nv="$(grep -c '^vitest' "$TRACE/calls")"
  assert_grep '[-]-land' "$MLOG" "the refusal names the flag a human would pass"
  merge_run -- --land
  assert_eq "$MRC" 0 "with --land it merges"
  assert_eq "$(grep -c '^vitest' "$TRACE/calls")" $((nv + 1)) "after the post-merge baseline"
  [[ "$(git -C "$REPO" rev-parse origin/base)" != "$before" ]] && ok || fail "the integration branch moved"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base && ok || fail "and holds the story"
  local sha; sha="$(field merged)"
  [[ -n "$sha" ]] && git -C "$REPO" merge-base --is-ancestor "$sha" origin/base && ok \
    || fail "merged: records a sha that is in the integration branch"

  CASE="91b --land does not lift main"; fixture c91b
  git -C "$REPO" push -q origin base:main
  sed -i '2a base: main' "$REPO/.stories/$STORY.md"
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run -- --land
  assert_eq "$MRC" 1 "refused"
  assert_grep 'main' "$MLOG" "naming main"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/main && fail "main took the story" || ok

  CASE="91c a story on an epic is landed through its epic, not by --land"; epic_story c91c
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local ebefore; ebefore="$(epic_head)"
  merge_run -- --land
  assert_eq "$MRC" 1 "refused"
  assert_grep '[-]-epic epic/test' "$MLOG" "with the epic command named"
  # The launcher's own status commits move the integration branch; what must
  # not reach it is the story.
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base && fail "the integration branch took the story" || ok
  assert_eq "$(epic_head)" "$ebefore" "nor did the epic move"
  # Once it is on its epic the answer is the same command, not "already merged".
  merge_run
  assert_eq "$MRC" 0 "merged into its epic"
  merge_run -- --land
  assert_eq "$MRC" 1 "still refused with --land"
  assert_grep '[-]-epic epic/test' "$MLOG" "still naming the epic command"

  CASE="91d the queue still never lands a PASS story on the integration branch"; fixture c91d
  queue_run
  assert_eq "$(field status)" done "the story passed"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base && fail "the integration branch took the story" || ok
  assert_eq "$(field merged)" "" "nothing recorded"
}

# Plan of 20 Sep. A repo whose host wants a request rather than a push:
# MERGE_MODE=pr pushes the branch and runs PR_CMD in the target checkout with
# the source branch appended and PR_SOURCE/PR_TARGET in its environment; what
# it prints — the request's URL — is the reply. Nothing is merged and nothing
# recorded: the merge happens on the host and lands in origin/<base> like any
# human merge. Every refusal applies as in direct mode.
#
# Red when MERGE_MODE is ignored (a merge happens), when the branch is not
# pushed first, when the command does not get the branch, or when a refusal
# is skipped in pr mode.
case_92_merge_pr_mode() {
  CASE="92 MERGE_MODE=pr pushes the branch and opens a request instead of merging"; epic_story c92
  cat > "$FX/fake-pr.sh" <<'EOP'
printf 'args=%s\nsource=%s\ntarget=%s\ncwd=%s\n' "$*" "${PR_SOURCE:-}" "${PR_TARGET:-}" "$(pwd -P)" >> "$(dirname "$0")/pr.log"
echo "https://example.test/mr/1"
EOP
  local pr="bash $FX/fake-pr.sh"
  merge_run MERGE_MODE=pr PR_CMD="$pr"
  assert_eq "$MRC" 1 "a story that is not done is refused in pr mode too"
  assert_no_file "$FX/pr.log" "and no request was opened"

  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before nv; before="$(epic_head)"; nv="$(grep -c '^vitest' "$TRACE/calls")"
  merge_run MERGE_MODE=pr PR_CMD="$pr"
  assert_eq "$MRC" 0 "exit 0"
  git -C "$REPO" rev-parse --verify --quiet "origin/story/$STORY" >/dev/null && ok || fail "the story branch was pushed first"
  assert_grep "^args=story/$STORY\$" "$FX/pr.log" "the command got the branch appended"
  assert_grep "^source=story/$STORY\$" "$FX/pr.log" "and as PR_SOURCE"
  assert_grep '^target=epic/test$' "$FX/pr.log" "and the base as PR_TARGET"
  assert_grep "^cwd=$(cd "$REPO" && pwd -P)\$" "$FX/pr.log" "run in the target checkout"
  assert_contains "$(cat "$MLOG")" "https://example.test/mr/1" "what it printed is the output"
  assert_eq "$(epic_head)" "$before" "the epic did not move"
  assert_eq "$(field merged)" "" "nothing recorded in the story"
  assert_eq "$(grep -c '^vitest' "$TRACE/calls")" "$nv" "no post-merge baseline ran: the merge is the host's"

  CASE="92b an epic in pr mode"; rm -f "$FX/pr.log"
  merge_run
  assert_eq "$MRC" 0 "landed on the epic directly, so the epic is ahead"
  before="$(git -C "$REPO" rev-parse origin/base)"
  merge_epic "$FX/merge-epic.log" MERGE_MODE=pr PR_CMD="$pr"
  assert_eq "$?" 0 "exit 0"
  assert_grep '^args=epic/test$' "$FX/pr.log" "the epic is the source"
  assert_grep '^target=base$' "$FX/pr.log" "the integration branch the target"
  assert_contains "$(cat "$FX/merge-epic.log")" "https://example.test/mr/1" "the URL is the output"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$before" "the integration branch did not move"
}

# Plan of 20 Sep. Landing on the integration branch is a human's decision,
# and the phone is where the human is. /merge <repo> <id> is merge.sh with
# --land; /merge <repo> epic/<name> is --epic. The script owns every refusal
# and the reply is what it said, colours stripped — in pr mode that is the
# request's URL.
#
# Red when /merge is an unknown verb, when the story form forgets --land
# (refused), or when the epic form is not wired.
case_93b_bot_merge() {
  CASE="93b /merge lands a story on the integration branch from the phone"; fixture c93b
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  update 120 42 "/merge t $STORY"
  bot poll
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base && ok || fail "the integration branch holds the story"
  assert_contains "$(sent_text)" "merged into base" "and the human is told"
  assert_not_contains "$(sent_text)" $'\x1b[' "without colour codes"

  CASE="93c /merge lands an epic"; epic_story c93c
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run
  assert_eq "$MRC" 0 "precondition: the story is on its epic"
  update 121 42 "/merge t epic/test"
  bot poll
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base && ok || fail "the integration branch holds the epic"
  assert_contains "$(sent_text)" "epic/test merged into base" "and the human is told"

  CASE="93d /merge with anything else is usage"; fixture c93d
  local before; before="$(git -C "$REPO" rev-parse origin/base)"
  update 122 42 "/merge t nope"
  bot poll
  assert_contains "$(sent_text)" "usage" "usage"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$before" "and nothing moved"
  update 123 42 "/merge t"
  bot poll
  assert_eq "$(sent)" 2 "a missing argument is answered too"
}

# Plan of 20 Sep. An epic was only a branch name a story's base: pointed at,
# and nothing enforced the name. Now the name is enforced where a story is
# born: write-story.sh takes --base epic/* only, lint-story.sh accepts a
# base that is absent, the integration branch, or epic/*, and new-epic.sh
# is the one way an epic branch comes into being — cut from origin's
# integration branch and pushed, so the next story can name it.
#
# Red when write-story.sh accepts feat/x (the branch exists, so the old
# existence check passes and the agent runs), when lint-story.sh accepts
# base: feat/x, and when new-epic.sh is missing or accepts a second run or
# a name that is not a name.
case_94_epic_naming() {
  CASE="94 an epic is named epic/* at creation, and created by new-epic.sh"; fixture c94
  git -C "$REPO" push -q origin base:feat/x
  git -C "$REPO" push -q origin base:epic/test
  local out rc
  ws() {                              # ws <id> <base> → out rc
    out="$( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_BUILDER=nocommit \
            bash "$FLEET/write-story.sh" t "$1" "x" --base "$2" 2>&1 )"; rc=$?
  }
  ws 901 feat/x
  assert_eq "$rc" 1 "write-story.sh refuses a base that is not epic/*"
  assert_contains "$out" "new-epic.sh" "and says how an epic is made"
  assert_eq "$(calls claude)" 0 "before any agent runs"
  ws 902 epic/test
  assert_eq "$(calls claude)" 1 "an epic/* base gets past the check to the agent"

  local d="$FX/lint"; mkdir -p "$d"
  lint_base() {                       # lint_base <name> <base-line> → out rc
    printf -- '---\nstatus: ready\nround: 0\n%s\nscope_deny: src/x/*\n---\n# Story: %s\n## Acceptance criteria\n**AC1 — one bounded claim.** Goes red when removed.\n' "$2" "$1" > "$d/$1.md"
    out="$( cd "$FX" && bash "$FLEET/lint-story.sh" t "$d/$1.md" 2>&1 )"; rc=$?
  }
  lint_base feat "base: feat/x";     assert_eq "$rc" 1 "lint: base: feat/x is an error, although the branch exists"
  assert_contains "$out" "epic/" "naming the rule"
  lint_base epic "base: epic/test";  assert_eq "$rc" 0 "lint: base: epic/test is accepted"
  lint_base integ "base: base";      assert_eq "$rc" 0 "lint: the integration branch is accepted"
  lint_base none "";                 assert_eq "$rc" 0 "lint: no base is accepted"

  new_epic() {                        # new_epic <name> → out rc
    out="$( cd "$FX" && env PATH="$(FAKES)" bash "$FLEET/new-epic.sh" t "$1" 2>&1 )"; rc=$?
  }
  new_epic search
  assert_eq "$rc" 0 "new-epic.sh creates an epic"
  assert_eq "$(git -C "$REPO" rev-parse --verify --quiet origin/epic/search)" "$(git -C "$REPO" rev-parse origin/base)" \
    "on origin, cut from origin's integration branch"
  assert_contains "$out" "epic/search" "and says so"
  assert_eq "$(git -C "$REPO" branch --show-current)" base "the checkout stays where it was"
  new_epic search
  assert_eq "$rc" 1 "a second time it refuses"
  assert_contains "$out" "exists" "and says why"
  new_epic 'bad name'
  assert_eq "$rc" 1 "a name with a space is refused"
  new_epic epic/x
  assert_eq "$rc" 1 "so is one that already carries the prefix"
  git -C "$REPO" rev-parse --verify --quiet origin/epic/epic/x >/dev/null && fail "nothing was created for it" || ok
}

CASES=(case_1_happy case_2_nocommit case_3_blocked case_4_fail_two_rounds
       case_5_restart_after_fail case_6_unparseable
       case_7_status_commits_land case_8_is_error_false case_9_spec
       case_10_render_prompt case_11_no_acs case_12_baseline_test_red
       case_13_baseline_build_red case_14_baseline_lint_red
       case_15_baseline_notests case_16_reviewer_dirty_tree
       case_17_reviewer_output_copied case_18_mutation_red
       case_19_mutation_green case_20_mutation_notests
       case_21_mutation_badpatch case_22_mutation_prered case_23_mutation_cmd
       case_24_veto_green case_25_veto_no_mutation case_26_veto_wrong_ac
       case_27_round2_gets_machine_facts case_28_scope_violation
       case_29_scope_undeclared case_30_scope_elsewhere
       case_31_codex_stderr_notice case_32_huge_review_prompt
       case_33_story_amendment_reaches_builder case_34_review_only
       case_35_builder_tdd_mutation case_36_reviewer_probes
       case_37_evidence_only_round case_38_story_base case_39_lint_story
       case_40_agent_timeout case_41_run_queue case_42_resume_after_crash
       case_43_refresh_diverged case_44_refresh_fail
       case_45_conflict_leaves_local_work case_48_missing_seed_file
       case_49_install_failure case_50_status_commit_failure
       case_51_selector_invalid case_52_reset
       case_53_reset_refuses_while_live case_54_reset_refuses_unmerged
       case_55_status_json case_56_merge case_57_merge_refuses_fail
       case_58_merge_undoes_itself case_59_merge_refuses_integration_branch
       case_60_bot_send case_61_bot_unconfigured_is_not_fatal
       case_62_bot_ignores_strangers case_63_bot_status case_64_bot_promote
       case_65_bot_offset_advances case_66_revert
       case_67_revert_needs_a_merge case_68_bot_revert
       case_69_queue_merges_a_pass case_70_queue_does_not_merge_a_fail
       case_71_auto_merge_can_be_turned_off case_72_lessons_name_real_cases
       case_74_merge_epic_into_integration
       case_75_merge_epic_refuses_non_epic case_76_story_model
       case_77_launcher_notifies_a_stop case_78_round_cost_is_recorded
       case_79_writers_do_not_collide case_80_status_epics
       case_81_existing_merge_preserved case_82_load_repo
       case_83_scope_fleet_config case_84_prompts_carry_the_targets_facts
       case_85_seed_files_from_config case_86_probe_dir
       case_87_queue_all_repos case_88_suite_env_is_clean case_89_shared_parent_dir_refused
       case_90_status_titles_and_landing case_91_merge_land case_92_merge_pr_mode
       case_93_bot_status_pre case_93b_bot_merge case_94_epic_naming)

for c in "${CASES[@]}"; do
  [[ -z "$ONLY" || "$c" == *"$ONLY"* ]] || continue
  "$c"
done

echo
printf '%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
