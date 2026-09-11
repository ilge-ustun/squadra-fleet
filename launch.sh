#!/usr/bin/env bash
#
# fleet/launch.sh <story-id>
#
# Phase 3: one story, one worktree, builder then reviewer, verdict to a file.
# No queue yet — that is Phase 4. This runs exactly one story, passed as an
# argument, and exits.
#
#   ./fleet/launch.sh 002
#
# Reads   .stories/<id>.md
# Writes  .review/<id>.md          verdict + reviewer output
#         .runs/<id>.json          pid, timestamps, shas  (Phase 4 uses this)
# Leaves  ../wt-<id>               builder worktree, on branch story/<id>
#                                  NOT removed — you inspect and merge, then
#                                  clean up. Phase 4 automates that.
#
set -uo pipefail

STORY_ID="${1:-}"
[[ -n "$STORY_ID" ]] || { echo "usage: $0 <story-id>"; exit 2; }

# ── config ───────────────────────────────────────────────────────────────────

REPO_ROOT="$(git rev-parse --show-toplevel)"
STORY_FILE="$REPO_ROOT/.stories/$STORY_ID.md"
REVIEW_FILE="$REPO_ROOT/.review/$STORY_ID.md"
RUN_FILE="$REPO_ROOT/.runs/$STORY_ID.json"

BUILDER_WT="$REPO_ROOT/../wt-$STORY_ID"
REVIEWER_WT="$REPO_ROOT/../wt-$STORY_ID-review"
BRANCH="story/$STORY_ID"
BASE_BRANCH="${BASE_BRANCH:-feat/pwa}"

BUILDER_MODEL="${BUILDER_MODEL:-claude-sonnet-4-6}"
MAX_TURNS="${MAX_TURNS:-60}"
ALLOWED_TOOLS="Read,Write,Edit,Grep,Glob,Bash"

# Phase 2 finding: the agent self-installs node_modules when missing, but
# relying on it noticing is prevention by discipline. Do it deterministically.
INSTALL_CMD="npm ci"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'
log()  { printf '%s==> %s%s\n' "$GRN" "$1" "$RST"; }
warn() { printf '%s!! %s%s\n'  "$YLW" "$1" "$RST"; }
die()  { printf '%sXX %s%s\n'  "$RED" "$1" "$RST" >&2; exit 1; }

# ── preflight ────────────────────────────────────────────────────────────────

[[ -f "$STORY_FILE" ]] || die "no story file: $STORY_FILE"
command -v claude >/dev/null || die "claude not on PATH"
command -v codex  >/dev/null || die "codex not on PATH"
command -v jq     >/dev/null || die "jq not on PATH"

mkdir -p "$REPO_ROOT/.review" "$REPO_ROOT/.runs"

cleanup_reviewer() {
  [[ -d "$REVIEWER_WT" ]] && git -C "$REPO_ROOT" worktree remove "$REVIEWER_WT" --force 2>/dev/null
}
trap cleanup_reviewer EXIT

# ── 1. builder worktree ──────────────────────────────────────────────────────

log "worktree: $BUILDER_WT on $BRANCH"

[[ -d "$BUILDER_WT" ]] && die "worktree already exists: $BUILDER_WT (finish or remove it first)"

git -C "$REPO_ROOT" fetch origin --quiet
git -C "$REPO_ROOT" worktree add "$BUILDER_WT" -b "$BRANCH" "origin/$BASE_BRANCH" \
  || die "worktree add failed"

BASE_SHA="$(git -C "$BUILDER_WT" rev-parse HEAD)"
log "base: ${BASE_SHA:0:8}"

log "installing deps"
( cd "$BUILDER_WT" && $INSTALL_CMD ) >/dev/null 2>&1 || warn "$INSTALL_CMD failed — builder may have to handle it"

cat > "$RUN_FILE" <<EOF
{"story":"$STORY_ID","pid":$$,"started":"$(date -Iseconds)","base_sha":"$BASE_SHA","status":"building"}
EOF

# ── 2. builder ───────────────────────────────────────────────────────────────

BUILD_PROMPT="Read .stories/$STORY_ID.md and implement it.

Rules that override anything you infer:
- TDD is mandatory. Write the failing test, run it, SEE IT FAIL, then implement.
  A test never observed red is not a test.
- One task, one commit. Commit after each task.
- Do not run deploy commands, firebase commands, or anything that writes to Firestore.
- If a decision is needed that the story does not answer, write .blocked/$STORY_ID.md
  with the question and the options, and stop. Do not guess.
  Format: what you need to decide, each option with its cost, your recommendation.
- Stay in scope. Do not fix unrelated things you notice; mention them at the end instead."

log "builder: $BUILDER_MODEL"

BUILD_OUT="$(cd "$BUILDER_WT" && claude -p "$BUILD_PROMPT" \
  --model "$BUILDER_MODEL" \
  --max-turns "$MAX_TURNS" \
  --allowedTools "$ALLOWED_TOOLS" \
  --output-format json 2>&1)"

BUILD_ERR="$(echo "$BUILD_OUT" | jq -r '.is_error // "parse-failed"' 2>/dev/null)"
BUILD_MSG="$(echo "$BUILD_OUT" | jq -r '.result // "no result field"' 2>/dev/null)"

# ── 3. postcondition, not self-report ────────────────────────────────────────
#
# Phase 2 finding: is_error was false while the agent did nothing at all
# (it lacked write permission and just printed its intent). Exit status and
# is_error are NOT verdicts. Verify the observable postcondition.

HEAD_SHA="$(git -C "$BUILDER_WT" rev-parse HEAD)"
NEW_COMMITS="$(git -C "$BUILDER_WT" rev-list --count "$BASE_SHA..$HEAD_SHA")"

if [[ -f "$BUILDER_WT/.blocked/$STORY_ID.md" ]]; then
  log "BLOCKED — agent asked a question"
  cat "$BUILDER_WT/.blocked/$STORY_ID.md"
  jq -n --arg s "$STORY_ID" '{story:$s,status:"blocked"}' > "$RUN_FILE"
  exit 0
fi

if [[ "$NEW_COMMITS" -eq 0 ]]; then
  die "builder produced no commits (is_error=$BUILD_ERR). Said: $BUILD_MSG"
fi

log "builder committed $NEW_COMMITS change(s), head ${HEAD_SHA:0:8}"

# ── 4. reviewer worktree — CLEAN, at the builder's head ──────────────────────
#
# The point of the second worktree: the reviewer derives evidence from a fresh
# checkout instead of reading the builder's diff. Reviewing from the builder's
# own tree is cheaper and defeats the purpose.

log "reviewer worktree at ${HEAD_SHA:0:8}"
git -C "$REPO_ROOT" worktree add --detach "$REVIEWER_WT" "$HEAD_SHA" >/dev/null \
  || die "reviewer worktree failed"

( cd "$REVIEWER_WT" && $INSTALL_CMD ) >/dev/null 2>&1 || warn "$INSTALL_CMD failed in reviewer tree"

REVIEW_PROMPT="You are reviewing a change against its specification.

The specification is in .stories/$STORY_ID.md — read it first.
You are in a clean checkout at commit $HEAD_SHA. The base was $BASE_SHA.

Do NOT review by reading the diff. Derive your evidence independently:
read the current state of the files, run the tests, run the build.

For every claim you make, cite file:line. A claim without a citation is not
a finding.

Check specifically:
1. Does each acceptance criterion in the story hold? Name the instrument that
   proves it — a test, a command, an observable postcondition.
2. Can that instrument go red? If a check would pass regardless of what shipped,
   say so explicitly; treat it as absent, not weak.
3. Is anything here outside the story's scope?
4. Does anything the story did not mention regress?

Run: npm test, npm run build, npm run lint.

End your response with exactly one line, nothing after it:
VERDICT: PASS
or
VERDICT: FAIL"

log "reviewer: codex"

REVIEW_RAW="$(cd "$REVIEWER_WT" && codex exec --json --sandbox workspace-write "$REVIEW_PROMPT" 2>&1)"

# codex emits JSON Lines, not one object (claude emits one object).
REVIEW_TEXT="$(echo "$REVIEW_RAW" \
  | jq -r 'select(.type=="item.completed") | .item.text // empty' 2>/dev/null)"
[[ -n "$REVIEW_TEXT" ]] || REVIEW_TEXT="$REVIEW_RAW"

# ── 5. verdict ───────────────────────────────────────────────────────────────

if echo "$REVIEW_TEXT" | grep -qE '^VERDICT: PASS[[:space:]]*$'; then
  VERDICT="PASS"
elif echo "$REVIEW_TEXT" | grep -qE '^VERDICT: FAIL[[:space:]]*$'; then
  VERDICT="FAIL"
else
  VERDICT="UNPARSEABLE"
fi

cat > "$REVIEW_FILE" <<EOF
# Review: $STORY_ID

verdict: $VERDICT
base: $BASE_SHA
head: $HEAD_SHA
commits: $NEW_COMMITS
reviewed: $(date -Iseconds)

## Builder said

$BUILD_MSG

## Reviewer

$REVIEW_TEXT
EOF

jq -n --arg s "$STORY_ID" --arg v "$VERDICT" --arg h "$HEAD_SHA" \
  '{story:$s,status:"reviewed",verdict:$v,head_sha:$h}' > "$RUN_FILE"

case "$VERDICT" in
  PASS) log  "VERDICT: PASS  → $REVIEW_FILE" ;;
  FAIL) warn "VERDICT: FAIL  → $REVIEW_FILE" ;;
  *)    warn "VERDICT UNPARSEABLE — read $REVIEW_FILE yourself" ;;
esac

echo
echo "worktree kept at $BUILDER_WT (branch $BRANCH)"
echo "when done:  git worktree remove $BUILDER_WT"
