#!/usr/bin/env bash
#
# fleet/run-queue.sh [--max N]
#
#   ./fleet/run-queue.sh                 drain the queue
#   ./fleet/run-queue.sh --max 3         at most three stories
#
# Runs every `ready` story in turn until the queue is empty. This is the piece
# that makes the fleet a fleet: until now a human launched each story, watched
# it, and launched the next one.
#
# A stopped story does not stop the queue — that has been the design since
# phase 4b and this honours it. needs_human, blocked and a harness die all end
# that story and the next one starts.
#
# Two guards against looping for ever, because unattended is the whole point:
#
#   --max N          a hard ceiling on stories (default 20)
#   same-story twice a story that comes back `ready` without having reached a
#                    terminal state means something is wrong with the story or
#                    the harness, not with that round. Stop and say so.
#
# Run it detached, never as a child of an interactive session:
#   setsid nohup ./fleet/run-queue.sh > queue.log 2>&1 < /dev/null &
#
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
BASE_BRANCH="${BASE_BRANCH:-develop}"
MAX="${MAX:-20}"
# The launcher decides; the queue merges. A hand-run launch.sh never changes a
# branch — that separation is what keeps a debugging session from landing
# something. AUTO_MERGE=0 turns it off without turning the fleet off.
AUTO_MERGE="${AUTO_MERGE:-1}"
# Every message the fleet sends goes through this one seam, so tests can
# substitute a recorder and nothing here ever reaches the network.
FLEET_NOTIFY_CMD="${FLEET_NOTIFY_CMD:-bash $REPO_ROOT/fleet/telegram.sh send}"
[[ "${1:-}" == "--max" ]] && MAX="${2:?--max needs a number}"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
log()  { printf '%s==> [queue] %s%s\n' "$GRN" "$1" "$RST"; }
warn() { printf '%s!! [queue] %s%s\n'  "$YLW" "$1" "$RST"; }

# A notification is never allowed to change what happened: it cannot fail the
# drain, and its own failure is the notifier's business, not the queue's.
notify() { $FLEET_NOTIFY_CMD "$1" >/dev/null 2>&1 || true; }

story_field() {                       # story_field <id> <key>
  local f="$REPO_ROOT/.stories/$1.md"
  [[ -f "$f" ]] || { echo ""; return; }
  awk -v k="$2" '
    NR==1 && $0!="---" { exit }
    /^---$/ { if (++d==2) exit; next }
    d==1 && $0 ~ "^"k":" { sub("^"k":[[:space:]]*",""); print; exit }
  ' "$f"
}

next_ready() {                        # the same choice launch.sh makes
  local f id
  for f in $(ls -1 "$REPO_ROOT"/.stories/*.md 2>/dev/null | sort); do
    id="$(basename "$f" .md)"
    [[ "$id" == "TEMPLATE" ]] && continue
    [[ "$(story_field "$id" status)" == "ready" ]] && { echo "$id"; return; }
  done
  echo ""
}

# Bring the local branch up to date with origin before scanning for ready
# stories. A promotion made anywhere (phone, GitLab web UI) is visible on the
# next drain without a manual pull.
#
# Rules that protect local work:
#   - A failed fetch does not stop the drain — continue on local state and say so.
#   - A merge conflict is aborted cleanly; pre-run HEAD remains an ancestor of
#     any new HEAD. Uncommitted edits to files neither side touches are preserved.
#
refresh_from_origin() {
  local upstream gitdir
  upstream="$(git rev-parse --abbrev-ref "@{u}" 2>/dev/null)" || {
    warn "refresh failed: no upstream configured, continuing on local state"
    return
  }
  gitdir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || gitdir=".git"
  if [[ -f "$gitdir/MERGE_HEAD" || -d "$gitdir/rebase-merge" ]]; then
    warn "refresh skipped: a merge/rebase is already in progress, continuing on local state"
    return
  fi
  if ! git fetch origin 2>/dev/null; then
    warn "refresh failed: fetch from origin failed, continuing on local state"
    return
  fi
  if ! git merge --no-edit "$upstream" 2>/dev/null; then
    git merge --abort 2>/dev/null || true
    warn "refresh failed: merge conflict with $upstream, continuing on local state"
    return
  fi
  log "refreshed from $upstream"
}

# A crash leaves a story at `in_progress` with nothing running. Any scan for
# `ready` misses it, so the queue would report itself empty while a stranded
# story sat there for ever. Reap first — launch.sh owns that logic and knows
# to check the worktree for live processes before declaring anything an orphan.
log "reaping orphans from any interrupted run"
bash "$REPO_ROOT/fleet/launch.sh" --reap

log "refreshing from origin before scan"
refresh_from_origin

STARTED="$(date -Iseconds)"
RAN=(); PREV=""
n=0

while (( n < MAX )); do
  id="$(next_ready)"
  if [[ -z "$id" ]]; then
    log "queue empty"
    break
  fi
  if [[ "$id" == "$PREV" ]]; then
    warn "$id is ready again without having finished — stopping rather than looping"
    warn "read .review/$id.md and .stories/$id.md before re-running"
    break
  fi
  PREV="$id"; n=$((n + 1))

  log "story $id ($n of at most $MAX)"
  bash "$REPO_ROOT/fleet/launch.sh" "$id"
  rc=$?

  status="$(story_field "$id" status)"
  verdict="$(awk '/^verdict:/ {print $2; exit}' "$REPO_ROOT/.review/$id.md" 2>/dev/null)"
  RAN+=("$id ${status:-?} ${verdict:-—} exit=$rc")

  base="$(story_field "$id" base)"; base="${base:-$BASE_BRANCH}"
  reasons="$(awk -F' — ' '/^computed:/ {r=$2} END{print r}' "$REPO_ROOT/.review/$id.md" 2>/dev/null | sed 's/[; ]*$//')"

  case "$status" in
    done)
      log "$id: done"
      # Only a COMPUTED PASS merges. merge.sh checks this again and refuses on
      # its own; asking here keeps a FAIL from even reaching it.
      if [[ "$verdict" == PASS && "$AUTO_MERGE" == "1" ]]; then
        if bash "$REPO_ROOT/fleet/merge.sh" "$id"; then
          notify "$id merged → $base (computed PASS)
undo: /revert $id"
        else
          warn "$id passed but did not merge"
          notify "$id computed PASS but did not merge into $base — see the queue log"
        fi
      elif [[ "$verdict" == PASS ]]; then
        log "$id: PASS, not merged (AUTO_MERGE=0)"
        notify "$id computed PASS and is waiting for a human to merge it into $base"
      fi ;;
    # blocked and needs_human are announced by the launcher, in set_status:
    # a story can stop without a queue, and saying it twice is how a channel
    # stops being read.
    blocked)     warn "$id: blocked — a question is waiting in .blocked/$id.md" ;;
    needs_human) warn "$id: needs_human — see .review/$id.md" ;;
    *)           warn "$id: ended as '${status:-unknown}' (launcher exit $rc)"
                 notify "$id ended as '${status:-unknown}' (launcher exit $rc) — that is not a state the queue expects" ;;
  esac
done

(( n >= MAX )) && warn "stopped at the --max ceiling of $MAX stories"

echo
printf '%s─── queue finished, started %s ───%s\n' "$DIM" "$STARTED" "$RST"
if (( ${#RAN[@]} == 0 )); then
  echo "nothing was ready to run"
else
  printf '  %s\n' "${RAN[@]}"
fi
echo
bash "$REPO_ROOT/fleet/status.sh"
