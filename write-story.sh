#!/usr/bin/env bash
#
# fleet/write-story.sh <story-id> "<what you want>" [--base epic/<name>]
#
#   ./fleet/write-story.sh 011 "the dark-theme toggle shows a sun, should be a moon" --base epic/ui-polish
#
# Turns an intent into a story the fleet can act on. One agent, read-only over
# the epic's code, writes .stories/<id>.md at `status: draft`; the story is
# then linted mechanically and left for a human to read and promote to
# `ready`. Nothing is committed and no builder runs.
#
# Why it exists: authoring a story by hand costs a careful session — read the
# code, verify every citation, bound each criterion, name its mutation. That
# cost, not the supply of ideas, is what limits how much work the fleet can be
# given. This converts authoring into approving.
#
# The agent runs in a throwaway worktree at the epic's tip, so it reads the
# code the story will be built against rather than whatever the integration
# branch happens to have.
#
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
BASE_BRANCH="${BASE_BRANCH:-develop}"
STORY_MODEL="${STORY_MODEL:-claude-opus-5}"   # the highest-judgment job in the loop
MAX_TURNS="${MAX_TURNS:-60}"
ALLOWED_TOOLS="Read,Grep,Glob,Bash,Write"
PROMPTS_DIR="$REPO_ROOT/fleet/prompts"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'
log()  { printf '%s==> %s%s\n' "$GRN" "$1" "$RST"; }
warn() { printf '%s!! %s%s\n'  "$YLW" "$1" "$RST"; }
die()  { printf '%sXX %s%s\n'  "$RED" "$1" "$RST" >&2; exit 1; }

source "$REPO_ROOT/fleet/render.sh" || die "cannot source fleet/render.sh"
command -v claude >/dev/null || die "claude not on PATH"

STORY_ID="${1:-}"; INTENT="${2:-}"
[[ -n "$STORY_ID" && -n "$INTENT" ]] || die "usage: fleet/write-story.sh <story-id> \"<what you want>\" [--base epic/<name>]"
[[ "$STORY_ID" =~ ^[0-9A-Za-z_-]+$ ]] || die "story id '$STORY_ID' is not a plain identifier"

STORY_BASE="$BASE_BRANCH"
if [[ "${3:-}" == "--base" ]]; then
  STORY_BASE="${4:?--base needs a branch}"
fi
git -C "$REPO_ROOT" rev-parse --verify --quiet "origin/$STORY_BASE" >/dev/null \
  || die "no such branch on origin: $STORY_BASE"

STORY_FILE="$REPO_ROOT/.stories/$STORY_ID.md"
[[ -e "$STORY_FILE" ]] && die ".stories/$STORY_ID.md already exists — pick another id or delete it"

WT="$REPO_ROOT/../ws-$STORY_ID"
cleanup() { [[ -d "$WT" ]] && git -C "$REPO_ROOT" worktree remove "$WT" --force 2>/dev/null; }
trap cleanup EXIT

log "story $STORY_ID on $STORY_BASE, model $STORY_MODEL"
git -C "$REPO_ROOT" fetch origin --quiet
git -C "$REPO_ROOT" worktree add --detach "$WT" "origin/$STORY_BASE" >/dev/null \
  || die "could not create a worktree at origin/$STORY_BASE"

# The template and conventions live on the integration branch; the epic may not
# have them. Put them where the agent is told to look.
mkdir -p "$WT/.stories"
cp "$REPO_ROOT/.stories/TEMPLATE.md" "$WT/.stories/TEMPLATE.md"

PROMPT="$(render_prompt write-story.md)"

log "writing"
OUT="$(cd "$WT" && printf '%s' "$PROMPT" | claude -p \
  --model "$STORY_MODEL" --max-turns "$MAX_TURNS" \
  --allowedTools "$ALLOWED_TOOLS" --output-format json 2>&1)"

ERR="$(echo "$OUT" | jq -r 'if has("is_error") then (.is_error|tostring) else "parse-failed" end' 2>/dev/null)"
MSG="$(echo "$OUT" | jq -r '.result // "no result field"' 2>/dev/null)"
[[ "$ERR" == "parse-failed" ]] && { warn "agent output was not JSON — first 20 lines:"; echo "$OUT" | head -20; }

# Postcondition, not self-report: did a story actually appear?
[[ -f "$WT/.stories/$STORY_ID.md" ]] || die "no story was written (is_error=$ERR). Said: $MSG"

cp "$WT/.stories/$STORY_ID.md" "$STORY_FILE"
log "wrote .stories/$STORY_ID.md ($(wc -l < "$STORY_FILE") lines)"

echo
echo "$MSG"
echo

log "linting"
if bash "$REPO_ROOT/fleet/lint-story.sh" "$STORY_ID"; then
  echo
  log "draft ready — read it, then set status: ready and run ./fleet/launch.sh $STORY_ID"
else
  echo
  warn "the draft has errors above. Fix them or rewrite before promoting it."
  exit 1
fi
