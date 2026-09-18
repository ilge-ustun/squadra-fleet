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
assert_not_contains() { [[ "$1" == *"$2"* ]] && fail "$3: unexpected '$2'" || ok; }

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

# SELF_TEST_CMD=true in the defaults is load-bearing: any case whose builder
# touches fleet/ (28–30 do) would otherwise make the launcher run THIS suite
# inside the fixture, where the nesting guard exits 3 and every such case
# fails for a reason that has nothing to do with what it tests. Cases 46 and
# 47 override it; env takes the last assignment, and "$@" comes after.
run() {                               # run <story-id> [VAR=value …] → LOG RC
  local id="$1"; shift
  LOG="$FX/launch.log"
  ( cd "$REPO" && env PATH="$REPO/fleet/test:$PATH" \
      BASE_BRANCH=base INSTALL_CMD=true PUSH_STATUS=1 \
      VITEST_CMD="$REPO/fleet/test/vitest" BUILD_CMD=true LINT_CMD=true \
      FAKE_MUTATIONS=patch FAKE_VITEST=marker SELF_TEST_CMD=true \
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
  assert_grep 'fleet/prompts/rules.md' "$LOG" "names the dirty path"
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
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=fleet/prompts/rules.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" "$status" "story status"
  assert_grep "^scope: +$scope" "$REPO/.review/$STORY.md" "scope line in the Machine block"
  assert_contains "$(tracked)" ".review/$STORY/round-1/scope.txt" "scope evidence committed"
  assert_grep 'fleet/prompts/rules.md' "$REPO/.review/$STORY/round-1/scope.txt" "changed path recorded"
}
case_28_scope_violation() { scope_case c28 "28 denied file changed → VIOLATION vetoes PASS (nested glob)" 'fleet/*' needs_human 'VIOLATION fleet/prompts/rules.md'
                            assert_grep '^computed: FAIL — .*scope VIOLATION' "$REPO/.review/$STORY.md" "reason enumerated"; }
case_29_scope_undeclared() { scope_case c29 "29 no scope_deny → CLEAN, nothing forbidden" - done 'CLEAN'; }
case_30_scope_elsewhere()  { scope_case c30 "30 deny names other files → CLEAN"           'src/* docs/*' done 'CLEAN'; }

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
  # Only commits this run made — the fixture clones the real repo, whose
  # history genuinely contains "spec synced" commits from stories 007-010.
  assert_not_grep 'spec synced' <(git -C "$FX/wt-$STORY" log --format=%s origin/base..HEAD) "no fleet state committed to the story branch"
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
# own state — .stories, .review, fleet/, docs/fleet — stays on the
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

# fleet/lint-story.sh — mechanical, no fixture and no launcher needed.
# Red when a check is removed; the false-positive guard is red when the "/"
# requirement on citations is dropped, which is how the first version of that
# check behaved: 20 false positives across the real stories, zero findings.
case_39_lint_story() {
  CASE="39 lint-story: shape and citations"
  local d="$TMP/lint"; mkdir -p "$d"
  local lint="$SRC/fleet/lint-story.sh" out rc

  write_story() { printf '%s' "$2" > "$d/$1.md"; }
  lint() { out="$(cd "$SRC" && bash "$lint" "$d/$1.md" ${2:-} 2>&1)"; rc=$?; }

  write_story good '---
status: ready
round: 0
scope_deny: src/x/*
---
# Story: fine
It cites `fleet/lint-story.sh` and `fleet/launch.sh:1`.
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
See `docs/fleet/does-not-exist.md` for the diagnosis.
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
See `docs/fleet/does-not-exist.md:12` for the diagnosis.
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
See `fleet/lint-story.sh:99999`.
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
  ( cd "$REPO" && env PATH="$REPO/fleet/test:$PATH" \
      BASE_BRANCH=base INSTALL_CMD=true PUSH_STATUS=1 \
      VITEST_CMD="$REPO/fleet/test/vitest" BUILD_CMD=true LINT_CMD=true \
      FAKE_MUTATIONS=patch FAKE_VITEST=marker SELF_TEST_CMD=true \
      FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID="$STORY" \
      FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 \
      bash fleet/run-queue.sh ) > "$FX/queue.log" 2>&1
  local qrc=$?

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
  ( cd "$REPO" && env PATH="$REPO/fleet/test:$PATH" \
      BASE_BRANCH=base INSTALL_CMD=true PUSH_STATUS=1 \
      VITEST_CMD="$REPO/fleet/test/vitest" BUILD_CMD=true LINT_CMD=true \
      FAKE_MUTATIONS=patch FAKE_VITEST=marker SELF_TEST_CMD=true \
      FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID=901 \
      FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 \
      bash fleet/run-queue.sh ) > "$FX/queue.log" 2>&1

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

  ( cd "$REPO" && env PATH="$REPO/fleet/test:$PATH" \
      BASE_BRANCH=base INSTALL_CMD=true PUSH_STATUS=1 \
      VITEST_CMD="$REPO/fleet/test/vitest" BUILD_CMD=true LINT_CMD=true \
      FAKE_MUTATIONS=patch FAKE_VITEST=marker SELF_TEST_CMD=true \
      FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID="$STORY" \
      FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 \
      bash fleet/run-queue.sh ) > "$FX/queue.log" 2>&1

  assert_grep 'orphan' "$FX/queue.log" "the stranded story was recognised as an orphan"
  assert_eq "$(field status)" done "and carried through to a verdict"
  assert_grep 'resuming existing worktree' "$FX/queue.log" "its worktree was reused, not rebuilt"
  assert_contains "$(git -C "$FX/wt-$STORY" log --format=%s origin/base..HEAD | tr '\n' ' ')" \
    "work the builder had already done" "the work it had already done survived"
}

# Phase A1 (L-26). The baseline is npm test / build / lint and none of them
# touch fleet/: a round that changes the harness is judged by an instrument
# that cannot see it. When the round's diff includes a fleet/ path, the
# launcher's own suite joins the baseline.
#
# SELF_TEST_CMD exists for this case. The real command is
# `bash fleet/test-lib.sh`, and running it from here is this suite recursing
# into itself — the nesting guard at the top would exit 3 whatever the
# launcher did, so the case could never distinguish pass from fail.
#
# Cases 43–45 are reserved for story 014, whose acceptance criteria name them.
#
# Red when the self-test branch in run_baseline is deleted: a harness suite
# that fails no longer stops the story.
case_46_baseline_self_test() {
  CASE="46 a round touching fleet/ runs the launcher's own suite"; fixture c46
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=fleet/prompts/rules.md \
      FAKE_REVIEWER=PASS MAX_ROUNDS=1 SELF_TEST_CMD=false
  assert_eq "$(field status)" needs_human "story status"
  assert_eq "$(review_line 3)" "verdict: FAIL" "machine veto over a model PASS"
  assert_grep 'self RED' "$REPO/.review/$STORY.md" "machine block names the self-test"
  assert_grep '^computed: FAIL — .*baseline self RED' "$REPO/.review/$STORY.md" "and gives it as a reason"
  assert_file "$REPO/.review/$STORY/round-1/baseline/self-test.log" "its output is evidence"
  assert_contains "$(tracked)" ".review/$STORY/round-1/baseline/self-test.log" "evidence committed"
}

# The other half of the same branch: a round that changes nothing under fleet/
# must not pay for the suite. Red when the fleet/ guard is dropped and the
# self-test runs unconditionally — SELF_TEST_CMD=false would then veto here too.
case_47_self_test_only_for_fleet() {
  CASE="47 a round outside fleet/ does not run the self-test"; fixture c47
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md \
      FAKE_REVIEWER=PASS MAX_ROUNDS=1 SELF_TEST_CMD=false
  assert_eq "$(field status)" done "story status"
  assert_grep 'self SKIPPED' "$REPO/.review/$STORY.md" "machine block says it was skipped"
  assert_no_file "$REPO/.review/$STORY/round-1/baseline/self-test.log" "no log, because it never ran"
}

# ── run ──────────────────────────────────────────────────────────────────────

CASES=(case_1_happy case_2_nocommit case_3_blocked case_4_fail_two_rounds
       case_5_restart_after_fail case_6_unparseable case_7_status_commits_land
       case_8_is_error_false case_9_spec case_10_render_prompt case_11_no_acs
       case_12_baseline_test_red case_13_baseline_build_red case_14_baseline_lint_red
       case_15_baseline_notests case_16_reviewer_dirty_tree case_17_reviewer_output_copied
       case_18_mutation_red case_19_mutation_green case_20_mutation_notests
       case_21_mutation_badpatch case_22_mutation_prered case_23_mutation_cmd
       case_24_veto_green case_25_veto_no_mutation case_26_veto_wrong_ac
       case_27_round2_gets_machine_facts
       case_28_scope_violation case_29_scope_undeclared case_30_scope_elsewhere
       case_31_codex_stderr_notice case_32_huge_review_prompt
       case_33_story_amendment_reaches_builder case_34_review_only
       case_35_builder_tdd_mutation case_36_reviewer_probes
       case_37_evidence_only_round case_38_story_base case_39_lint_story case_40_agent_timeout case_41_run_queue case_42_resume_after_crash
       case_46_baseline_self_test case_47_self_test_only_for_fleet)

for c in "${CASES[@]}"; do
  [[ -z "$ONLY" || "$c" == *"$ONLY"* ]] || continue
  "$c"
done

echo
printf '%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
