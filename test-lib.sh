#!/usr/bin/env bash
#
# fleet/test-lib.sh — tests for fleet/launch.sh, with fake agents.
#
#   bash fleet/test-lib.sh              run every case
#   bash fleet/test-lib.sh blocked      run cases whose name contains "blocked"
#
# No network, no npm, no models. Each case gets a fresh fixture:
#
#   $TMP/<case>/origin.git   bare local clone of this repo — the launcher's `origin`
#   $TMP/<case>/repo         working clone on branch `base`, with
#                            - THIS working tree's fleet/ copied in and committed,
#                              so the launcher under test is the one on disk,
#                              not the one at HEAD
#                            - .stories/ and .review/ emptied, one fixture story
#   $TMP/<case>/trace        what the fakes recorded
#
# fleet/test/{claude,codex,npm} are put first on PATH; launch.sh resolves
# `claude` and `codex` by bare name (`command -v`, and the calls at the
# builder and reviewer steps), so no launcher change is needed for the
# substitution. Worktrees land as $TMP/<case>/wt-<id>, siblings of repo/,
# exactly as in production (launch.sh: "$REPO_ROOT/../wt-$STORY_ID").
#
# Observing red. Most cases characterise behaviour launch.sh already has, so
# "see it fail first" means: run the case against a copy of launch.sh with
# the named block deleted. FLEET_LAUNCH_OVERRIDE=<file> substitutes that
# copy into the fixture; the real fleet/launch.sh is never modified.
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

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(git -C "$HERE" rev-parse --show-toplevel)"
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

# ── fixture ──────────────────────────────────────────────────────────────────

shadow_check() {                      # shadow_check <fixture-repo> — die unless the fakes are what resolves
  local repo="$1" name got
  for name in claude codex npm; do
    got="$(PATH="$repo/fleet/test:$PATH" command -v "$name")"
    if [[ "$got" != "$repo/fleet/test/$name" ]]; then
      echo "test-lib: '$name' resolves to '$got', not the fake — refusing to run the launcher" >&2
      exit 3
    fi
  done
}

fixture() {                           # fixture <case-name> → FX REPO TRACE
  FX="$TMP/$1"; REPO="$FX/repo"; TRACE="$FX/trace"
  mkdir -p "$TRACE"; : > "$TRACE/calls"

  git clone -q --bare "$SRC" "$FX/origin.git"
  git clone -q "$FX/origin.git" "$REPO"
  git -C "$REPO" config user.name  fleet-test
  git -C "$REPO" config user.email fleet-test@localhost
  git -C "$REPO" checkout -q -b base

  rm -rf "$REPO/fleet"; cp -r "$SRC/fleet" "$REPO/fleet"
  [[ -n "${FLEET_LAUNCH_OVERRIDE:-}" ]] && cp "$FLEET_LAUNCH_OVERRIDE" "$REPO/fleet/launch.sh"
  [[ -n "${FLEET_RENDER_OVERRIDE:-}" ]] && cp "$FLEET_RENDER_OVERRIDE" "$REPO/fleet/render.sh"
  git -C "$REPO" rm -rq --ignore-unmatch .stories .review
  mkdir -p "$REPO/.stories"
  cat > "$REPO/.stories/$STORY.md" <<'EOF'
---
status: ready
round: 0
---

# Story 900: fixture story

**AC1 — the fixture has one criterion.** Goes red when removed.
EOF
  git -C "$REPO" add -A fleet .stories
  git -C "$REPO" commit -qm "fixture: launcher under test + story $STORY"
  git -C "$REPO" push -q -u origin base

  shadow_check "$REPO"
}

run() {                               # run <story-id> [VAR=value …] → LOG RC
  local id="$1"; shift
  LOG="$FX/launch.log"
  ( cd "$REPO" && env PATH="$REPO/fleet/test:$PATH" \
      BASE_BRANCH=base INSTALL_CMD=true PUSH_STATUS=1 \
      VITEST_CMD="$REPO/fleet/test/vitest" FAKE_VITEST=pass BUILD_CMD=true LINT_CMD=true \
      FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID="$STORY" "$@" \
      bash fleet/launch.sh "$id" ) > "$LOG" 2>&1
  RC=$?
}
tracked() { git -C "$REPO" ls-tree -r HEAD --name-only; }

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
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=SPEC
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" needs_human "story status"
  assert_eq "$(review_line 3)" "verdict: SPEC" ".review line 3"
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
  local pd="$TMP/prompts" render="${FLEET_RENDER_OVERRIDE:-$SRC/fleet/render.sh}" out rc
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

# ── run ──────────────────────────────────────────────────────────────────────

CASES=(case_1_happy case_2_nocommit case_3_blocked case_4_fail_two_rounds
       case_5_restart_after_fail case_6_unparseable case_7_status_commits_land
       case_8_is_error_false case_9_spec case_10_render_prompt case_11_no_acs
       case_12_baseline_test_red case_13_baseline_build_red case_14_baseline_lint_red
       case_15_baseline_notests)

for c in "${CASES[@]}"; do
  [[ -z "$ONLY" || "$c" == *"$ONLY"* ]] || continue
  "$c"
done

echo
printf '%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
