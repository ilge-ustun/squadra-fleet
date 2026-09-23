#!/usr/bin/env bash
#
# gen.sh — the goldens for machine-block.test.ts, produced by the bash the
# renderer replaced: launch.sh's verdict block (its lines 677-712 at 7840de7)
# and the round-section heredoc (715-745), verbatim apart from two
# substitutions that make the output deterministic — `$(date -Iseconds)` is
# $REVIEWED and `$(( SECONDS - T_ROUND ))` is $T_TOTAL. Run it to regenerate:
#
#   bash ts/fixtures/verdict/gen.sh
#
# Each variant writes <name>.input.json (what the TypeScript side is given)
# and <name>.expected.md (what bash wrote for it). A change in either file
# under review is a change in the contract.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The builder message every variant carries: what a heredoc must NOT expand.
BUILD_MSG='fake builder did: commit (call 1)
$HOME and `backticks` and $(echo not-run) and \n and \\ stay as written
EOF
last line'

emit() {                              # emit <name>  — reads the variables set by the caller
  local name="$1"
  local ac cls slug pname pcls

  # ── launch.sh 677-678 ──
  MUT_TABLE="$(printf '%s' "$MUT_ROWS" | awk 'NF { printf "%-4s %-13s %s\n", $1, $2, $3 }')"
  PROBE_TABLE="$(printf '%s' "$PROBE_ROWS" | awk 'NF { printf "%-13s %s\n", $2, $1 }')"

  # ── launch.sh 680-683 ──
  if   echo "$REVIEW_TEXT" | grep -qE '^VERDICT: PASS[[:space:]]*$'; then VERDICT="PASS"
  elif echo "$REVIEW_TEXT" | grep -qE '^VERDICT: FAIL[[:space:]]*$'; then VERDICT="FAIL"
  elif echo "$REVIEW_TEXT" | grep -qE '^VERDICT: SPEC[[:space:]]*$'; then VERDICT="SPEC"
  else VERDICT="UNPARSEABLE"; fi

  # ── launch.sh 693-712 ──
  MODEL_VERDICT="$VERDICT"
  MACHINE_REASONS=""
  [[ "$BASE_TEST"  == GREEN ]] || MACHINE_REASONS+="baseline test $BASE_TEST; "
  [[ "$BASE_BUILD" == GREEN ]] || MACHINE_REASONS+="baseline build $BASE_BUILD; "
  [[ "$BASE_LINT"  == GREEN ]] || MACHINE_REASONS+="baseline lint $BASE_LINT; "
  [[ "$SCOPE" == CLEAN ]] || MACHINE_REASONS+="scope $SCOPE: ${SCOPE_HITS}; "
  for ac in $AC_IDS; do
    grep -q "^$ac " <<< "$MUT_ROWS" || MACHINE_REASONS+="$ac has no mutation; "
  done
  while read -r ac cls slug; do
    [[ -n "$ac" && "$cls" != RED ]] && MACHINE_REASONS+="$ac $slug $cls; "
  done <<< "$MUT_ROWS"
  while read -r pname pcls; do
    [[ -n "$pname" && "$pcls" == RED ]] && MACHINE_REASONS+="probe $pname RED; "
  done <<< "$PROBE_ROWS"
  if [[ -n "$MACHINE_REASONS" && "$VERDICT" == "PASS" ]]; then
    VERDICT="FAIL"
  fi

  # ── launch.sh 715-745, the heredoc ──
  cat > "$HERE/$name.expected.md" <<EOF

## Round $ROUND — $VERDICT

head: $HEAD_SHA
commits this round: $ROUND_COMMITS
reviewed: $REVIEWED

### Machine

baseline: test $BASE_TEST | build $BASE_BUILD | lint $BASE_LINT
timing:   builder ${T_BUILD}s | baseline ${T_BASE}s | reviewer ${T_REVIEW}s | mutations ${T_MUT}s | total ${T_TOTAL}s
builder:  $BUILDER_MODEL
reviewer: codex${REVIEWER_MODEL:+ $REVIEWER_MODEL}
acs:      $AC_IDS
scope:    $SCOPE${SCOPE_HITS:+ $SCOPE_HITS}
model:    $MODEL_VERDICT
computed: $VERDICT${MACHINE_REASONS:+ — $MACHINE_REASONS}
${MUT_TABLE:+mutations:
$MUT_TABLE
}${PROBE_TABLE:+probes:
$PROBE_TABLE}

### Builder said

$BUILD_MSG

### Reviewer

$REVIEW_TEXT
EOF

  jq -n --arg round "$ROUND" --arg head "$HEAD_SHA" --arg commits "$ROUND_COMMITS" --arg reviewed "$REVIEWED" \
        --arg bt "$BASE_TEST" --arg bb "$BASE_BUILD" --arg bl "$BASE_LINT" \
        --arg tb "$T_BUILD" --arg tbase "$T_BASE" --arg trev "$T_REVIEW" --arg tmut "$T_MUT" --arg ttot "$T_TOTAL" \
        --arg builder "$BUILDER_MODEL" --arg reviewer "$REVIEWER_MODEL" --arg acs "$AC_IDS" \
        --arg scope "$SCOPE" --arg hits "$SCOPE_HITS" --arg mut "$MUT_ROWS" --arg probes "$PROBE_ROWS" \
        --arg bmsg "$BUILD_MSG" --arg rtext "$REVIEW_TEXT" \
        '{round:$round, headSha:$head, roundCommits:$commits, reviewedAt:$reviewed,
          baseline:{test:$bt,build:$bb,lint:$bl},
          timing:{build:$tb,base:$tbase,review:$trev,mut:$tmut,total:$ttot},
          builderModel:$builder, reviewerModel:$reviewer, acs:$acs, scope:$scope, scopeHits:$hits,
          mutRows:$mut, probeRows:$probes, builderMsg:$bmsg, reviewerText:$rtext}' > "$HERE/$name.input.json"
  printf '%s: %s\n' "$name" "$VERDICT"
}

# Defaults every variant starts from; each overrides what it is about.
reset() {
  ROUND=1; HEAD_SHA=430cfc13b2b4328285ddb4c3e4ed53b902194e33; ROUND_COMMITS=2; REVIEWED=2026-09-23T12:00:00+02:00
  BASE_TEST=GREEN; BASE_BUILD=GREEN; BASE_LINT=GREEN
  T_BUILD=456; T_BASE=61; T_REVIEW=145; T_MUT=80; T_TOTAL=801
  BUILDER_MODEL=claude-sonnet-4-6; REVIEWER_MODEL=""
  AC_IDS="AC1 "; SCOPE=CLEAN; SCOPE_HITS=""
  MUT_ROWS=""; PROBE_ROWS=""
  REVIEW_TEXT=$'fake review, call 1.\nfinding: none.\nVERDICT: PASS'
}

reset
emit no-tables                        # no mutation at all: coverage vetoes; neither table

reset
AC_IDS="AC1 AC10 AC2 "
MUT_ROWS=$'AC1 RED marker\nAC10 SELECTOR_INVALID a-long-slug-name\nAC2 NO_SELECTOR bad\nAC1 GREEN tdd-observed-red\n'
emit mutations                        # the table only; AC10 fills the column, SELECTOR_INVALID overflows it

reset
PROBE_ROWS=$'probe-green.test.tsx GREEN\nprobe-red.test.tsx RED\n'
emit probes                           # the probes table only; a RED probe vetoes

reset
ROUND=2; ROUND_COMMITS=0
BUILDER_MODEL=claude-opus-5; REVIEWER_MODEL=gpt-5-codex
AC_IDS="AC1 AC2 "
MUT_ROWS=$'AC1 RED marker\nAC2 RED clock\n'
PROBE_ROWS=$'probe-green.test.tsx GREEN\n'
REVIEW_TEXT=$'fake review, call 2.\nfinding: none.\nVERDICT: PASS'
emit both                             # a clean PASS with both tables and a named reviewer model

reset
BASE_LINT=RED
SCOPE=VIOLATION; SCOPE_HITS=".fleet/config src/a.ts "
MUT_ROWS=$'AC1 GREEN marker\n'
REVIEW_TEXT=$'the story asks for the impossible.\nVERDICT: SPEC\n'
emit spec                             # SPEC is immune to the veto; the reasons are still listed
