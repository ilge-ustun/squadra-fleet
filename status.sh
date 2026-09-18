#!/usr/bin/env bash
#
# fleet/status.sh [story-id]
#
# What the fleet is doing and what it decided. Read-only: safe to run while a
# launcher is working, and safe to run from a phone over ssh.
#
#   ./fleet/status.sh          every story
#   ./fleet/status.sh 007      one story, with the latest round's machine block
#   ./fleet/status.sh --json   the same values as JSON, for the bot and merge.sh
#   ./fleet/status.sh --epics  one line per epic — what a human decides to merge
#
# The verdict shown is the COMPUTED one (`verdict:` line 3 of .review/<id>.md),
# not the reviewer's — see fleet/prompts/README.md, "The verdict contract".
#
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
BASE_BRANCH="${BASE_BRANCH:-develop}"
JSON=0; EPICS=0; ONE=""
while (($#)); do
  case "$1" in
    --json)  JSON=1; shift ;;
    --epics) EPICS=1; shift ;;
    -*)      echo "usage: fleet/status.sh [--json|--epics] [story-id]" >&2; exit 2 ;;
    *)       ONE="$1"; shift ;;
  esac
done

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

# There is no state file, deliberately: the frontmatter is authoritative and a
# second copy would need keeping in sync with it. --json is the same walk,
# emitted as data — one object per story, always an array, so a caller never
# needs two parsers. jq builds it, so no value has to be escaped by hand.
JSON_ROWS=""

# Stories are visible one at a time; an epic — the thing a human actually
# decides to merge — was visible nowhere. Counts come from the same walk the
# table does, so the two cannot disagree.
if (( EPICS == 1 )); then
  declare -A n_total=() n_merged=()
  for f in $(ls -1 "$REPO_ROOT"/.stories/*.md 2>/dev/null | sort); do
    id="$(basename "$f" .md)"; [[ "$id" == "TEMPLATE" ]] && continue
    e="$(story_field "$id" base)"; [[ -n "$e" && "$e" != "$BASE_BRANCH" ]] || continue
    n_total[$e]=$(( ${n_total[$e]:-0} + 1 ))
    into="$e"
    git -C "$REPO_ROOT" rev-parse --verify --quiet "$into" >/dev/null 2>&1 || into="origin/$e"
    if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/story/$id" \
       && git -C "$REPO_ROOT" merge-base --is-ancestor "story/$id" "$into" 2>/dev/null; then
      n_merged[$e]=$(( ${n_merged[$e]:-0} + 1 ))
    fi
  done
  if (( ${#n_total[@]} == 0 )); then echo "no story names an epic"; exit 0; fi
  for e in $(printf '%s\n' "${!n_total[@]}" | sort); do
    ref="$e"
    git -C "$REPO_ROOT" rev-parse --verify --quiet "$ref" >/dev/null 2>&1 || ref="origin/$e"
    ahead="$(git -C "$REPO_ROOT" rev-list --count "$BASE_BRANCH..$ref" 2>/dev/null || echo 0)"
    [[ "$ahead" =~ ^[0-9]+$ ]] || ahead=0
    if (( ahead > 0 )); then state="${YLW}$ahead ahead of $BASE_BRANCH${RST}"
    else                        state="${DIM}in $BASE_BRANCH${RST}"; fi
    (( ${n_total[$e]} == 1 )) && word=story || word=stories
    printf '%-22s %s %s, %s merged  %b\n' \
      "$e" "${n_total[$e]}" "$word" "${n_merged[$e]:-0}" "$state"
  done
  exit 0
fi

if (( JSON == 0 )); then
  printf '%-5s %-12s %-6s %-8s %-9s %s\n' ID STATUS ROUND VERDICT BRANCH NOTES
  printf '%s%s%s\n' "$DIM" "$(printf '%.0s─' {1..78})" "$RST"
fi

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
  has_wt=false; live=false
  wt="$REPO_ROOT/../wt-$id"
  if [[ -d "$wt" ]]; then
    has_wt=true
    if live_in "$wt"; then live=true; notes+=("RUNNING"); else notes+=("worktree"); fi
  fi
  branch="story/$id"
  # Merged INTO WHAT: a story belongs to its epic, not to the integration
  # branch. story/011 is merged into epic/ui-polish and will reach develop
  # only when that epic does; checking against BASE_BRANCH reported it
  # unmerged forever.
  into="$(story_field "$id" base)"; into="${into:-$BASE_BRANCH}"
  git -C "$REPO_ROOT" rev-parse --verify --quiet "$into" >/dev/null 2>&1 || into="origin/$into"
  merged=false; ahead=0
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    if git -C "$REPO_ROOT" merge-base --is-ancestor "$branch" "$into" 2>/dev/null; then
      merged=true
      notes+=("merged→${into#origin/}")
    else
      ahead="$(git -C "$REPO_ROOT" rev-list --count "$into..$branch" 2>/dev/null)"
      notes+=("$ahead unmerged→${into#origin/}")
    fi
  else
    branch="—"
  fi
  blocked=false
  [[ -f "$REPO_ROOT/.blocked/$id.md" ]] && { blocked=true; notes+=("BLOCKED: see .blocked/$id.md"); }
  [[ -n "$reasons" ]] && notes+=("$reasons")

  if (( JSON == 1 )); then
    # Numbers stay numbers and absent values are null, so a caller can test
    # them rather than string-match a dash.
    [[ "$round"   =~ ^[0-9]+$ ]] && j_round="$round"   || j_round=null
    [[ "$ahead"   =~ ^[0-9]+$ ]] && j_ahead="$ahead"   || j_ahead=0
    [[ "$verdict" == "—" || -z "$verdict" ]] && j_verdict=null || j_verdict="\"$verdict\""
    JSON_ROWS+="$(jq -nc \
        --arg  id "$id"       --arg status "$status" --arg base "${into#origin/}" \
        --arg  branch "$branch" --arg reasons "$reasons" \
        --argjson round "$j_round" --argjson verdict "$j_verdict" \
        --argjson ahead "$j_ahead" --argjson merged "$merged" \
        --argjson worktree "$has_wt" --argjson live "$live" --argjson blocked "$blocked" \
        '{id:$id, status:$status, round:$round, verdict:$verdict, base:$base,
          branch:$branch, merged:$merged, ahead:$ahead, worktree:$worktree,
          live:$live, blocked:$blocked, reasons:$reasons}')"$'\n'
    continue
  fi

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

(( JSON == 1 )) && printf '%s' "$JSON_ROWS" | jq -s .
exit 0
