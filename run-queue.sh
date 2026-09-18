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
MAX="${MAX:-20}"
[[ "${1:-}" == "--max" ]] && MAX="${2:?--max needs a number}"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
log()  { printf '%s==> [queue] %s%s\n' "$GRN" "$1" "$RST"; }
warn() { printf '%s!! [queue] %s%s\n'  "$YLW" "$1" "$RST"; }

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

  case "$status" in
    done)        log "$id: done" ;;
    blocked)     warn "$id: blocked — a question is waiting in .blocked/$id.md" ;;
    needs_human) warn "$id: needs_human — see .review/$id.md" ;;
    *)           warn "$id: ended as '${status:-unknown}' (launcher exit $rc)" ;;
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
