#!/usr/bin/env bash
#
# fleet/revert.sh <id>
#
# Undo the merge fleet/merge.sh made, by id rather than by sha. This is the
# other half of auto-merge: the fleet is allowed to change an epic branch
# without asking because undoing it is one word on a phone.
#
# It reverts the merge commit recorded in the story's `merged:` frontmatter,
# so it undoes exactly what was merged even if the epic has moved on since.
#
# What it does NOT do: re-run the baseline. A revert restores a state that was
# green when it was merged, and the point of this script is to be fast when
# something has gone wrong. The next merge into that epic runs a full
# post-merge baseline and will catch anything this left behind. Stated rather
# than hidden: if the epic has moved on, "the state before" is not the state
# you get back.
#
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
BASE_BRANCH="${BASE_BRANCH:-develop}"
PUSH_STATUS="${PUSH_STATUS:-1}"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'
log()  { printf '%s==> %s%s\n' "$GRN" "$1" "$RST"; }
warn() { printf '%s!! %s%s\n'  "$YLW" "$1" "$RST"; }
die()  { printf '%sXX %s%s\n'  "$RED" "$1" "$RST" >&2; exit 1; }

ID="${1:-}"
[[ -n "$ID" ]] || die "usage: fleet/revert.sh <id>"
STORY_FILE="$REPO_ROOT/.stories/$ID.md"
[[ -f "$STORY_FILE" ]] || die "no such story: .stories/$ID.md"

story_field() {                       # story_field <key>
  awk -v k="$1" '
    NR==1 && $0!="---" { exit }
    /^---$/ { if (++d==2) exit; next }
    d==1 && $0 ~ "^"k":" { sub("^"k":[[:space:]]*",""); print; exit }
  ' "$STORY_FILE"
}

SHA="$(story_field merged)"
[[ -n "$SHA" ]] || die "$ID has no recorded merge — nothing to revert"
BASE="$(story_field base)"; BASE="${BASE:-$BASE_BRANCH}"
case "$BASE" in
  "$BASE_BRANCH"|main|master) die "$ID is based on $BASE — that branch is a human's, here too" ;;
esac

RWT="$REPO_ROOT/../revert-$ID"
cleanup() { [[ -d "$RWT" ]] && git -C "$REPO_ROOT" worktree remove "$RWT" --force >/dev/null 2>&1; }
trap cleanup EXIT
cleanup

git -C "$REPO_ROOT" fetch -q origin || die "fetch failed"
git -C "$REPO_ROOT" worktree add --detach "$RWT" "origin/$BASE" >/dev/null || die "worktree add failed"

git -C "$RWT" merge-base --is-ancestor "$SHA" HEAD 2>/dev/null \
  || die "${SHA:0:8} is not on origin/$BASE — it was already reverted, or never landed"

# -m 1: a merge commit has two parents and git will not guess which side to
# keep. 1 is the branch that was merged INTO, i.e. the epic without the story.
if ! git -C "$RWT" revert -m 1 --no-edit "$SHA" > "$REPO_ROOT/.runs/$ID-revert.log" 2>&1; then
  git -C "$RWT" revert --abort 2>/dev/null
  die "the revert did not apply — either the epic changed underneath it, or the merge carried no content to undo. See .runs/$ID-revert.log; this one is a human's"
fi

if [[ "$PUSH_STATUS" == "1" ]]; then
  git -C "$RWT" push -q origin "HEAD:refs/heads/$BASE" || die "push failed — the revert is local only"
fi
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BASE"; then
  git -C "$REPO_ROOT" branch -f "$BASE" "$(git -C "$RWT" rev-parse HEAD)" >/dev/null 2>&1 \
    || warn "could not move the local $BASE — it is checked out somewhere"
fi
log "$BASE reverted: ${SHA:0:8} is undone"

# The story is no longer merged, and says so, or the next status would claim a
# merge that has been taken back.
sed -i "/^merged:/d" "$STORY_FILE"
git -C "$REPO_ROOT" add -- ".stories/$ID.md"
if git -C "$REPO_ROOT" diff --cached --quiet; then
  warn "the story file did not change"
else
  git -C "$REPO_ROOT" commit -q -m "story($ID): merge into $BASE reverted" \
    || die "could not record the revert in the story"
  [[ "$PUSH_STATUS" == "1" ]] && { git -C "$REPO_ROOT" push -q 2>/dev/null || warn "push failed — the record is local only"; }
fi

log "$ID is unmerged again; its branch story/$ID still holds the work"
