#!/usr/bin/env bash
#
# fleet/test-lib.sh — tests for fleet/launch.sh, with fake agents.
#
#   bash fleet/test-lib.sh
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
# Two guards, both learned the expensive way on the first run (17 Sep): the
# fakes were named fake-claude/fake-codex, so `claude` resolved to the REAL
# agent, which read the fixture story, ran this very script, and recursed
# three deep on real quota before being killed.
#   1. shadow_check — every fake must be what actually resolves, or we stop.
#   2. no nesting  — if FAKE_TRACE_DIR is already set we are inside a fixture;
#      a real agent got in. Stop, never fan out.
#
# Every case says which launch.sh block turns it red when deleted.
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

STORY=900
PASSED=0; FAILED=0; CASE=""

# ── assertions ───────────────────────────────────────────────────────────────

ok()   { PASSED=$((PASSED + 1)); }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL  [%s] %s\n' "$CASE" "$1"; }

assert_eq()       { [[ "$1" == "$2" ]] && ok || fail "$3: expected '$2', got '$1'"; }
assert_grep()     { grep -qE -- "$1" "$2" 2>/dev/null && ok || fail "$3: expected /$1/ in ${2#$TMP/}"; }
assert_not_grep() { grep -qE -- "$1" "$2" 2>/dev/null && fail "$3: found /$1/ in ${2#$TMP/}" || ok; }

# ── fixture ──────────────────────────────────────────────────────────────────

fixture() {                           # fixture <case-name> → FX REPO TRACE
  FX="$TMP/$1"; REPO="$FX/repo"; TRACE="$FX/trace"
  mkdir -p "$TRACE"; : > "$TRACE/calls"

  git clone -q --bare "$SRC" "$FX/origin.git"
  git clone -q "$FX/origin.git" "$REPO"
  git -C "$REPO" config user.name  fleet-test
  git -C "$REPO" config user.email fleet-test@localhost
  git -C "$REPO" checkout -q -b base

  rm -rf "$REPO/fleet"; cp -r "$SRC/fleet" "$REPO/fleet"
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
      FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID="$STORY" "$@" \
      bash fleet/launch.sh "$id" ) > "$LOG" 2>&1
  RC=$?
}

field() {                             # field <key> → frontmatter value of the fixture story
  awk -v k="$1" '
    NR==1 && $0!="---" { exit }
    /^---$/ { if (++d==2) exit; next }
    d==1 && $0 ~ "^"k":" { sub("^"k":[[:space:]]*",""); print; exit }
  ' "$REPO/.stories/$STORY.md"
}

# ── cases ────────────────────────────────────────────────────────────────────

# 1. The happy path. Red when the outcome block (set_status done) is deleted.
#    Also carries the INSTALL_CMD seam check: red while INSTALL_CMD is
#    hardcoded, because the npm tripwire on PATH then gets called.
CASE="1 commit + PASS → done"
fixture c1
run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
assert_eq "$RC" 0 "exit code"
assert_eq "$(field status)" done "story status"
assert_eq "$(sed -n 3p "$REPO/.review/$STORY.md" 2>/dev/null)" "verdict: PASS" ".review line 3"
assert_not_grep '^npm ' "$TRACE/calls" "INSTALL_CMD seam — npm must not be reached"
assert_grep '^claude$' "$TRACE/calls" "builder was called"
assert_grep '^codex$'  "$TRACE/calls" "reviewer was called"

# ── summary ──────────────────────────────────────────────────────────────────

echo
printf '%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
