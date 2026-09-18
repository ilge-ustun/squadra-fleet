#!/usr/bin/env bash
#
# fleet/status.sh [story-id]
#
# What the fleet is doing and what it decided. Read-only: safe to run while a
# launcher is working, and safe to run from a phone over ssh.
#
#   ./fleet/status.sh          every story
#   ./fleet/status.sh 007      one story, with the latest round's machine block
#
# The verdict shown is the COMPUTED one (`verdict:` line 3 of .review/<id>.md),
# not the reviewer's — see fleet/prompts/README.md, "The verdict contract".
#
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
BASE_BRANCH="${BASE_BRANCH:-develop}"
ONE="${1:-}"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'

story_field() {                       # story_field <id> <key>
  local f="$REPO_ROOT/.stories/$1.md"
  [[ -f "$f" ]] || { echo ""; return; }
  awk -v k="$2" '
    NR==1 && $0!="---" { exit }
    /^---$/ { if (++d==2) exit; next }
    d==1 && $0 ~ "^"k":" { sub("^"k":[[:space:]]*",""); print; exit }
  ' "$f"
}

colour_for() {                        # colour_for <status>
  case "$1" in
    done)                echo "$GRN" ;;
    needs_human|blocked) echo "$RED" ;;
    in_progress)         echo "$YLW" ;;
    *)                   echo "$RST" ;;
  esac
}

# A story is "live" if something is actually running in its worktree — the
# only trustworthy answer (L-04: a dead launcher does not stop the work, and
# in_progress in the frontmatter can be a stale orphan).
live_in() {                           # live_in <worktree> → 0 if a process is there
  local wt p cwd
  wt="$(readlink -f "$1" 2>/dev/null)" || return 1
  [[ -n "$wt" ]] || return 1
  for p in /proc/[0-9]*; do
    cwd="$(readlink "$p/cwd" 2>/dev/null)" || continue
    [[ "$cwd" == "$wt" || "$cwd" == "$wt"/* ]] && return 0
  done
  return 1
}

printf '%-5s %-12s %-6s %-8s %-9s %s\n' ID STATUS ROUND VERDICT BRANCH NOTES
printf '%s%s%s\n' "$DIM" "$(printf '%.0s─' {1..78})" "$RST"

for f in $(ls -1 "$REPO_ROOT"/.stories/*.md 2>/dev/null | sort); do
  id="$(basename "$f" .md)"
  [[ "$id" == "TEMPLATE" ]] && continue
  [[ -n "$ONE" && "$id" != "$ONE" ]] && continue

  status="$(story_field "$id" status)"; status="${status:-—}"
  round="$(story_field "$id" round)";   round="${round:-—}"
  review="$REPO_ROOT/.review/$id.md"
  verdict="—"; reasons=""
  if [[ -f "$review" ]]; then
    verdict="$(awk '/^verdict:/ {print $2; exit}' "$review")"
    # Last round's reasons; the launcher separates them with "; " and leaves a
    # trailing one.
    reasons="$(awk -F' — ' '/^computed:/ {r=$2} END{print r}' "$review" | sed 's/[; ]*$//')"
  fi

  notes=()
  wt="$REPO_ROOT/../wt-$id"
  if [[ -d "$wt" ]]; then
    if live_in "$wt"; then notes+=("RUNNING"); else notes+=("worktree"); fi
  fi
  branch="story/$id"
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    if git -C "$REPO_ROOT" merge-base --is-ancestor "$branch" "$BASE_BRANCH" 2>/dev/null; then
      notes+=("merged")
    else
      ahead="$(git -C "$REPO_ROOT" rev-list --count "$BASE_BRANCH..$branch" 2>/dev/null)"
      notes+=("$ahead unmerged")
    fi
  else
    branch="—"
  fi
  [[ -f "$REPO_ROOT/.blocked/$id.md" ]] && notes+=("BLOCKED: see .blocked/$id.md")
  [[ -n "$reasons" ]] && notes+=("$reasons")

  c="$(colour_for "$status")"
  # Entries contain spaces ("4 unmerged"), so join explicitly — an unquoted
  # array expansion would split them.
  note_str=""
  if (( ${#notes[@]} )); then
    for n in "${notes[@]}"; do note_str+="${note_str:+, }$n"; done
  fi
  printf '%-5s %s%-12s%s %-6s %-8s %-9s %s\n' \
    "$id" "$c" "$status" "$RST" "$round" "$verdict" "${branch#story/}" "$note_str"

  # One story: show the latest round's machine block, the thing worth reading.
  if [[ -n "$ONE" && -f "$review" ]]; then
    echo
    awk '/^### Machine/ {blk=""; inblk=1; next} /^### / {inblk=0} inblk {blk=blk $0 "\n"} END {printf "### Machine\n%s", blk}' "$review"
    ev="$REPO_ROOT/.review/$id"
    [[ -d "$ev" ]] && printf '%sevidence: %s%s\n' "$DIM" "$(ls -1 "$ev" | tr '\n' ' ')" "$RST"
  fi
done
