#!/usr/bin/env bash
#
# status.sh <repo> [--json|--epics|--bot] [story-id]
#
# What the fleet is doing and what it decided. Read-only: safe to run while a
# launcher is working, and safe to run from a phone over ssh.
#
#   status.sh khaita           the epics, then every story of the repo `khaita`
#   status.sh khaita 007       one story, with the latest round's machine block
#   status.sh khaita --json    the same values as JSON, for the bot and merge.sh
#   status.sh khaita --epics   only the epic block — what a human decides to merge
#   status.sh khaita --bot     the phone form: a <pre> block wraps at ~40
#                              columns there, so no table — per story: id and
#                              title, then base | state | round | verdict,
#                              between rules; newest first; no colour
#
# The verdict shown is the COMPUTED one (`verdict:` line 3 of .review/<id>.md),
# not the reviewer's — see prompts/README.md, "The verdict contract".
#
# STATUS is a landing state derived on every run, never stored — the story's
# frontmatter `status:` is authoritative and is left alone:
#   draft ready in_progress blocked needs_human   as in the frontmatter
#   awaiting merge   done, computed PASS, not merged — a human's decision
#   on epic          done, merged into an epic that is not in the integration branch
#   landed           done, merged, and its base is in the integration branch
#   done             done and none of the above (a FAIL nobody merged)
#
# --bot is the phone view and hides `landed` and `done`, which ask nothing of
# anyone; --all turns that off. One story named by id is always shown.
#
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
USAGE="usage: status.sh <repo> [--json|--epics|--bot] [--all] [story-id]"
[[ $# -ge 1 ]] || die "$USAGE"
load_repo "$1"; shift
JSON=0; EPICS=0; BOT=0; ALL=0; ONE=""
while (($#)); do
  case "$1" in
    --json)  JSON=1; shift ;;
    --epics) EPICS=1; shift ;;
    --bot)   BOT=1; shift ;;
    --all)   ALL=1; shift ;;
    -*)      echo "$USAGE" >&2; exit 2 ;;
    *)       ONE="$1"; shift ;;
  esac
done
# A phone renders no colour; what it would show is the escape bytes.
(( BOT == 1 )) && RED="" GRN="" YLW="" DIM="" RST=""

colour_for() {                        # colour_for <landing>
  case "$1" in
    landed|"on epic")    echo "$GRN" ;;
    "awaiting merge")    echo "$YLW" ;;
    needs_human|blocked) echo "$RED" ;;
    in_progress)         echo "$YLW" ;;
    *)                   echo "$RST" ;;
  esac
}

# A story is "live" if something is actually running in its worktree — the
# only trustworthy answer (L-04; procs_in_worktree in lib.sh).
live_in() { [[ -n "$(procs_in_worktree "$1")" ]]; }   # live_in <worktree> → 0 if a process is there

# Origin's branch when this checkout knows it, else the local one. merge.sh
# publishes by pushing — the push moves origin/<branch> here at once, while a
# local branch that is checked out stays behind until someone pulls — so
# origin is the truth about what has landed. No fetch: this stays read-only.
ref_of() {                            # ref_of <branch> → ref
  git -C "$REPO_ROOT" rev-parse --verify --quiet "origin/$1" >/dev/null 2>&1 && echo "origin/$1" || echo "$1"
}
BASE_REF="$(ref_of "$BASE_BRANCH")"

# The title is the story's first heading; the "Story NNN:" prefix repeats the
# ID column and is dropped.
title_of() {                          # title_of <file> → text
  awk '/^# / { sub(/^# +/, ""); sub(/^[Ss]tory +[0-9]+[[:space:]]*[:—-]+[[:space:]]*/, ""); print; exit }' "$1"
}

# An epic — the thing a human actually decides to merge — was visible nowhere.
# This block leads the default output. Counts come from the same walk the
# table does, so the two cannot disagree. Prints nothing when no story names
# an epic, except under --epics where silence would look like a failure.
print_epics() {
  declare -A n_total=() n_merged=()
  local f id e into ref ahead state word hint
  for f in $(ls -1 "$REPO_ROOT"/.stories/*.md 2>/dev/null | sort); do
    id="$(basename "$f" .md)"; [[ "$id" == "TEMPLATE" ]] && continue
    e="$(story_field "$id" base)"; [[ -n "$e" && "$e" != "$BASE_BRANCH" ]] || continue
    n_total[$e]=$(( ${n_total[$e]:-0} + 1 ))
    into="$(ref_of "$e")"
    if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/story/$id" \
       && git -C "$REPO_ROOT" merge-base --is-ancestor "story/$id" "$into" 2>/dev/null; then
      n_merged[$e]=$(( ${n_merged[$e]:-0} + 1 ))
    fi
  done
  if (( ${#n_total[@]} == 0 )); then
    (( EPICS == 1 )) && echo "no story names an epic"
    return 1
  fi
  for e in $(printf '%s\n' "${!n_total[@]}" | sort); do
    ref="$(ref_of "$e")"
    ahead="$(git -C "$REPO_ROOT" rev-list --count "$BASE_REF..$ref" 2>/dev/null || echo 0)"
    [[ "$ahead" =~ ^[0-9]+$ ]] || ahead=0
    (( ${n_total[$e]} == 1 )) && word=story || word=stories
    if (( BOT == 1 )); then
      printf '%s\n  %s %s, %s merged\n' "$e" "${n_total[$e]}" "$word" "${n_merged[$e]:-0}"
      if (( ahead > 0 )); then printf '  %s ahead of %s → /merge %s %s\n' "$ahead" "$BASE_BRANCH" "$REPO_NAME" "$e"
      else                     printf '  in %s\n' "$BASE_BRANCH"; fi
      continue
    fi
    if (( ahead > 0 )); then
      state="${YLW}$ahead ahead of $BASE_BRANCH${RST}  → merge.sh $REPO_NAME --epic $e"
    else
      state="${DIM}in $BASE_BRANCH${RST}"
    fi
    printf '%-22s %s %s, %s merged  %b\n' \
      "$e" "${n_total[$e]}" "$word" "${n_merged[$e]:-0}" "$state"
  done
  return 0
}

if (( EPICS == 1 )); then print_epics; exit 0; fi
if (( JSON == 0 )); then print_epics && echo; fi

# There is no state file, deliberately: the frontmatter is authoritative and a
# second copy would need keeping in sync with it. --json is the same walk,
# emitted as data — one object per story, always an array, so a caller never
# needs two parsers. jq builds it, so no value has to be escaped by hand.
JSON_ROWS=""

# The table is collected first and printed after, so every column is as wide
# as its longest value: a title is never cut, and a long line simply scrolls.
R_ID=(); R_TITLE=(); R_LAND=(); R_ROUND=(); R_VERDICT=(); R_INTO=(); R_NOTES=()
DETAIL=""

for f in $(ls -1 "$REPO_ROOT"/.stories/*.md 2>/dev/null | sort); do
  id="$(basename "$f" .md)"
  [[ "$id" == "TEMPLATE" ]] && continue
  [[ -n "$ONE" && "$id" != "$ONE" ]] && continue

  title="$(title_of "$f")"; title="${title:-—}"
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
  base="$(story_field "$id" base)"; base="${base:-$BASE_BRANCH}"
  into="$(ref_of "$base")"
  merged=false; ahead=0
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    if git -C "$REPO_ROOT" merge-base --is-ancestor "$branch" "$into" 2>/dev/null; then
      merged=true
    else
      ahead="$(git -C "$REPO_ROOT" rev-list --count "$into..$branch" 2>/dev/null)"
    fi
  else
    branch="—"
  fi
  # A branch deleted after its merge leaves only the `merged:` sha merge.sh
  # recorded; that sha in the base is the same fact.
  merged_sha="$(story_field "$id" merged)"
  if [[ "$merged" == false && -n "$merged_sha" ]] \
     && git -C "$REPO_ROOT" merge-base --is-ancestor "$merged_sha" "$into" 2>/dev/null; then
    merged=true
  fi
  # The landing state, derived: see the header. A story with no branch and no
  # record has nothing that could be merged, so it is not awaiting one.
  landing="$status"
  if [[ "$status" == done ]]; then
    if [[ "$merged" == true ]]; then
      if [[ "$base" == "$BASE_BRANCH" ]] \
         || git -C "$REPO_ROOT" merge-base --is-ancestor "$into" "$BASE_REF" 2>/dev/null; then
        landing=landed
      else
        landing="on epic"
      fi
    elif [[ "$verdict" == PASS && "$branch" != "—" ]]; then
      landing="awaiting merge"
    fi
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
        --arg  id "$id"       --arg status "$status" --arg base "$base" \
        --arg  title "$title" --arg landing "$landing" \
        --arg  branch "$branch" --arg reasons "$reasons" \
        --argjson round "$j_round" --argjson verdict "$j_verdict" \
        --argjson ahead "$j_ahead" --argjson merged "$merged" \
        --argjson worktree "$has_wt" --argjson live "$live" --argjson blocked "$blocked" \
        '{id:$id, title:$title, status:$status, landing:$landing, round:$round,
          verdict:$verdict, base:$base, branch:$branch, merged:$merged, ahead:$ahead,
          worktree:$worktree, live:$live, blocked:$blocked, reasons:$reasons}')"$'\n'
    continue
  fi

  # Entries contain spaces ("BLOCKED: see …"), so join explicitly — an unquoted
  # array expansion would split them.
  note_str=""
  if (( ${#notes[@]} )); then
    for n in "${notes[@]}"; do note_str+="${note_str:+, }$n"; done
  fi
  R_ID+=("$id"); R_TITLE+=("$title"); R_LAND+=("$landing"); R_ROUND+=("$round")
  R_VERDICT+=("$verdict"); R_INTO+=("$base"); R_NOTES+=("$note_str")

  # One story: show the latest round's machine block, the thing worth reading.
  if [[ -n "$ONE" && -f "$review" ]]; then
    DETAIL="$(awk '/^### Machine/ {blk=""; inblk=1; next} /^### / {inblk=0} inblk {blk=blk $0 "\n"} END {printf "### Machine\n%s", blk}' "$review")"
    ev="$REPO_ROOT/.review/$id"
    [[ -d "$ev" ]] && DETAIL+=$'\n'"${DIM}evidence: $(ls -1 "$ev" | tr '\n' ' ')${RST}"
  fi
done

if (( JSON == 1 )); then printf '%s' "$JSON_ROWS" | jq -s .; exit 0; fi

# The phone, the shape the user asked for on 20 Sep: a rule, then per story
# the id and title (wrapping is harmless there), one line with the base,
# the state, the round and the verdict, what would have been NOTES, and a
# rule. Newest first — the current work is what the screen shows before
# any scrolling.
if (( BOT == 1 )); then
  # The phone view answers "what wants me?", so a landed story is noise: it
  # asks for nothing and pushes the ones that do below the fold. --all turns
  # the filter off, a story named by id is always shown, and the terminal
  # table below still prints every row.
  shown=0
  for (( i = ${#R_ID[@]} - 1; i >= 0; i-- )); do
    if (( ALL == 0 )) && [[ -z "$ONE" ]]; then
      case "${R_LAND[$i]}" in landed|done) continue ;; esac
    fi
    (( shown )) || echo "-------"
    shown=1
    r="${R_ROUND[$i]}"; [[ "$r" =~ ^[0-9]+$ ]] && r="R$r"
    printf '%s %s\n→ %s | %s | %s | %s\n' \
      "${R_ID[$i]}" "${R_TITLE[$i]}" "${R_INTO[$i]}" "${R_LAND[$i]}" "$r" "${R_VERDICT[$i]}"
    [[ -n "${R_NOTES[$i]}" ]] && printf '! %s\n' "${R_NOTES[$i]}"
    echo "-------"
  done
  if (( shown == 0 )); then
    if (( ${#R_ID[@]} )); then
      echo "nothing in flight — /status-all $REPO_NAME shows what has landed"
    else
      echo "no stories yet"
    fi
  fi
  [[ -n "$DETAIL" ]] && { echo; printf '%s\n' "$DETAIL"; }
  exit 0
fi

width_of() {                          # width_of <header> <values…> → longest, in characters
  local w=${#1}; shift; local v
  for v in "$@"; do (( ${#v} > w )) && w=${#v}; done
  echo "$w"
}
W_ID=$(width_of ID "${R_ID[@]}");            W_TITLE=$(width_of TITLE "${R_TITLE[@]}")
W_LAND=$(width_of STATUS "${R_LAND[@]}");    W_ROUND=$(width_of R "${R_ROUND[@]}")
W_VERDICT=$(width_of VERDICT "${R_VERDICT[@]}"); W_INTO=$(width_of INTO "${R_INTO[@]}")
FMT="%-${W_ID}s  %-${W_TITLE}s  %s%-${W_LAND}s%s  %-${W_ROUND}s  %-${W_VERDICT}s  %-${W_INTO}s  %s\n"
printf "$FMT" ID TITLE "" STATUS "" R VERDICT INTO NOTES
printf '%s%s%s\n' "$DIM" "$(printf '%.0s─' $(seq 1 $(( W_ID + W_TITLE + W_LAND + W_ROUND + W_VERDICT + W_INTO + 12 )) ))" "$RST"
for i in "${!R_ID[@]}"; do
  c="$(colour_for "${R_LAND[$i]}")"
  printf "$FMT" "${R_ID[$i]}" "${R_TITLE[$i]}" "$c" "${R_LAND[$i]}" "$RST" \
    "${R_ROUND[$i]}" "${R_VERDICT[$i]}" "${R_INTO[$i]}" "${R_NOTES[$i]}"
done
[[ -n "$DETAIL" ]] && { echo; printf '%s\n' "$DETAIL"; }
exit 0
