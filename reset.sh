#!/usr/bin/env bash
#
# fleet/reset.sh <id> [--force] [--draft]
#
#   ./fleet/reset.sh 012            put story 012 back in the queue
#   ./fleet/reset.sh 012 --force    …even though its branch holds work
#   ./fleet/reset.sh 012 --draft    …but parked, not queued
#
# Clearing a story used to be four steps done by hand: remove the worktree,
# delete the branch, edit the frontmatter, delete the review. Four steps at
# the end of a long session is where state gets left half-cleared — a branch
# with no story, a review for a round that no longer exists.
#
# This is destructive, so most of it is about what it refuses to do:
#
#   something running in the worktree   → stop. A launcher mid-round has a live
#                                         process there; removing the worktree
#                                         under it loses the round.
#   the branch holds commits its base
#   does not have                       → stop unless --force, and say how many.
#                                         That work is on no other branch.
#
# What it does NOT do: touch the remote's story branch (the launcher never
# pushes one), and touch any other story.
#
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
BASE_BRANCH="${BASE_BRANCH:-develop}"
PUSH_STATUS="${PUSH_STATUS:-1}"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'
log()  { printf '%s==> %s%s\n' "$GRN" "$1" "$RST"; }
warn() { printf '%s!! %s%s\n'  "$YLW" "$1" "$RST"; }
die()  { printf '%sXX %s%s\n'  "$RED" "$1" "$RST" >&2; exit 1; }

ID=""; FORCE=0; NEW_STATUS=ready
while (($#)); do
  case "$1" in
    --force) FORCE=1; shift ;;
    --draft) NEW_STATUS=draft; shift ;;
    -*)      die "unknown option: $1" ;;
    *)       [[ -z "$ID" ]] || die "one story at a time"; ID="$1"; shift ;;
  esac
done
[[ -n "$ID" ]] || die "usage: fleet/reset.sh <id> [--force] [--draft]"

STORY_FILE="$REPO_ROOT/.stories/$ID.md"
[[ -f "$STORY_FILE" ]] || die "no such story: .stories/$ID.md"

story_field() {                       # story_field <key> — same reader as the launcher's
  awk -v k="$1" '
    NR==1 && $0!="---" { exit }
    /^---$/ { if (++d==2) exit; next }
    d==1 && $0 ~ "^"k":" { sub("^"k":[[:space:]]*",""); print; exit }
  ' "$STORY_FILE"
}

# L-04: a dead launcher does not stop the work it started, and `in_progress`
# in the frontmatter can be a stale orphan. The only trustworthy answer is
# what is actually running in the worktree.
procs_in_worktree() {                 # procs_in_worktree <path> → prints pids
  local wt p cwd
  wt="$(readlink -f "$1" 2>/dev/null)" || return 0
  [[ -n "$wt" ]] || return 0
  for p in /proc/[0-9]*; do
    cwd="$(readlink "$p/cwd" 2>/dev/null)" || continue
    [[ "$cwd" == "$wt" || "$cwd" == "$wt"/* ]] && basename "$p"
  done
}

WT="$REPO_ROOT/../wt-$ID"
BRANCH="story/$ID"
STORY_BASE="$(story_field base)"; STORY_BASE="${STORY_BASE:-$BASE_BRANCH}"

# ── refusals ─────────────────────────────────────────────────────────────────

if [[ -d "$WT" ]]; then
  PIDS="$(procs_in_worktree "$WT")"
  [[ -z "$PIDS" ]] || die "$ID has processes running in $WT ($(tr '\n' ' ' <<< "$PIDS")) — stop them first"
fi

if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  INTO="$STORY_BASE"
  git -C "$REPO_ROOT" rev-parse --verify --quiet "$INTO" >/dev/null 2>&1 || INTO="origin/$STORY_BASE"
  AHEAD="$(git -C "$REPO_ROOT" rev-list --count "$INTO..$BRANCH" 2>/dev/null || echo 0)"
  if (( AHEAD > 0 )) && (( FORCE == 0 )); then
    git -C "$REPO_ROOT" --no-pager log --oneline "$INTO..$BRANCH" | sed 's/^/    /'
    die "$BRANCH has $AHEAD commit(s) that ${INTO} does not — rerun with --force to drop them"
  fi
fi

# ── reset ────────────────────────────────────────────────────────────────────

if [[ -d "$WT" ]]; then
  git -C "$REPO_ROOT" worktree remove "$WT" --force >/dev/null 2>&1 || rm -rf "$WT"
  log "worktree removed: $WT"
fi
git -C "$REPO_ROOT" worktree prune

if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$REPO_ROOT" branch -D "$BRANCH" >/dev/null || die "could not delete $BRANCH"
  log "branch deleted: $BRANCH"
fi

# Frontmatter only, and only the two fields: base and scope_deny belong to the
# story, not to the run.
sed -i -e "0,/^status:.*/s//status: $NEW_STATUS/" -e "0,/^round:.*/s//round: 0/" "$STORY_FILE"

rm -f  "$REPO_ROOT/.review/$ID.md" "$REPO_ROOT/.review/$ID.md.new" "$REPO_ROOT/.blocked/$ID.md"
rm -rf "$REPO_ROOT/.review/$ID"
rm -f  "$REPO_ROOT/.runs/$ID-"* 2>/dev/null
log "review, evidence and any blocked question removed"

# git add fails entirely if one pathspec matches nothing, staging nothing and
# exiting 128 (L-02). Add each path separately, and only if git knows it.
for p in ".stories/$ID.md" ".review/$ID.md" ".review/$ID" ".blocked/$ID.md"; do
  git -C "$REPO_ROOT" ls-files --error-unmatch -- "$p" >/dev/null 2>&1 \
    && git -C "$REPO_ROOT" add -A -- "$p"
done
if git -C "$REPO_ROOT" diff --cached --quiet; then
  warn "nothing to commit — the story was already clear in git"
else
  git -C "$REPO_ROOT" commit -q -m "story($ID): reset to $NEW_STATUS" \
    || die "the reset commit failed — state is only in the working tree"
  if [[ "$PUSH_STATUS" == "1" ]]; then
    git -C "$REPO_ROOT" push -q 2>/dev/null || warn "push failed — the reset is not visible remotely"
  fi
fi

log "$ID is $NEW_STATUS, round 0"
