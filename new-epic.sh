#!/usr/bin/env bash
#
# new-epic.sh <repo> <name>
#
#   new-epic.sh khaita search      → origin/epic/search, cut from origin/develop
#
# The one way an epic branch comes into being. An epic is a branch named
# epic/<name> that stories are cut from (`base:` in their frontmatter, or
# write-story.sh --base) and merged into by the queue; the epic itself lands
# on the integration branch when a human says so (merge.sh --epic, or /merge
# from the phone). Nothing else about an epic is stored anywhere: status.sh
# derives its state from the branches.
#
# Cut from ORIGIN's integration branch, not the local one, and pushed at
# once, so the launcher — which cuts every worktree from origin — can use it
# on the next story. The checkout is not touched: no checkout, no switch.
#
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
USAGE="usage: new-epic.sh <repo> <name>   (a plain name: letters, digits, _ and -; epic/ is added)"
[[ $# -eq 2 ]] || die "$USAGE"
load_repo "$1"; shift
NAME="$1"
[[ "$NAME" =~ ^[A-Za-z0-9_-]+$ ]] || die "'$NAME' is not a plain name — $USAGE"
EPIC="epic/$NAME"

git -C "$REPO_ROOT" fetch -q origin || die "fetch failed"
git -C "$REPO_ROOT" rev-parse --verify --quiet "origin/$EPIC" >/dev/null \
  && die "$EPIC already exists on origin"
git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/heads/$EPIC" >/dev/null \
  && die "$EPIC already exists locally — push or delete it first"
git -C "$REPO_ROOT" rev-parse --verify --quiet "origin/$BASE_BRANCH" >/dev/null \
  || die "origin has no $BASE_BRANCH to cut from"

git -C "$REPO_ROOT" push -q origin "origin/$BASE_BRANCH:refs/heads/$EPIC" \
  || die "could not push $EPIC"
git -C "$REPO_ROOT" fetch -q origin "$EPIC" || warn "pushed, but could not fetch $EPIC back"
log "$EPIC created on origin from origin/$BASE_BRANCH ($(git -C "$REPO_ROOT" rev-parse --short "origin/$EPIC" 2>/dev/null))"
log "next: write-story.sh $REPO_NAME <id> \"<intent>\" --base $EPIC"
