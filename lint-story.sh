#!/usr/bin/env bash
#
# fleet/lint-story.sh <story-id|path> [--strict]
#
# Mechanical checks on a story, before any agent spends quota on it. No model,
# no network, no git writes. Errors exit 1; warnings print and exit 0 unless
# --strict.
#
# Every check here exists because something cost rounds:
#
#   citations      story 004 rotted — it cited a diagnosis file and a symptom
#                  that no longer existed. A story is read as fact by two
#                  agents; a stale file:line is a false premise (L-09).
#   AC headings    the launcher extracts AC ids with `grep '^\*\*AC[0-9]+'`.
#                  A story whose ACs are a table (005) is invisible to it and
#                  dies at "declares no acceptance criteria".
#   unbounded ACs  L-20. "every stub in the worker global" cost story 008 two
#                  rounds; "every snapshot a test delivers" cost 006 one. An
#                  unquantified every/all/any in an AC heading is a scope
#                  declaration that outranks Out of scope.
#   baseline ACs   the harness runs test/build/lint unconditionally, so an AC
#                  asserting them is noise that cannot fail independently.
#
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
STRICT=0
ARG="${1:?usage: fleet/lint-story.sh <story-id|path> [--strict]}"
[[ "${2:-}" == "--strict" ]] && STRICT=1

if [[ -f "$ARG" ]]; then STORY_FILE="$ARG"; else STORY_FILE="$REPO_ROOT/.stories/$ARG.md"; fi
[[ -f "$STORY_FILE" ]] || { echo "lint-story: no such story: $ARG" >&2; exit 1; }

RED=$'\033[31m'; YLW=$'\033[33m'; GRN=$'\033[32m'; RST=$'\033[0m'
ERRORS=0; WARNINGS=0
err()  { printf '%sERROR%s   %s\n' "$RED" "$RST" "$1" >&2; ERRORS=$((ERRORS + 1)); }
warn() { printf '%swarning%s %s\n' "$YLW" "$RST" "$1"; WARNINGS=$((WARNINGS + 1)); }

body() {                              # the story minus its frontmatter
  awk 'NR==1 && $0!="---" {p=1} /^---$/ {d++; next} d>=2 || p' "$STORY_FILE"
}
field() {                             # field <key> — same parser the launcher uses
  awk -v k="$1" '
    NR==1 && $0!="---" { exit }
    /^---$/ { if (++d==2) exit; next }
    d==1 && $0 ~ "^"k":" { sub("^"k":[[:space:]]*",""); print; exit }
  ' "$STORY_FILE"
}

# ── frontmatter ──────────────────────────────────────────────────────────────

head -1 "$STORY_FILE" | grep -q '^---$' || err "no frontmatter — the launcher reads status/round/base/scope_deny from it"
[[ -n "$(field status)" ]] || err "frontmatter has no status:"
[[ -n "$(field round)"  ]] || warn "frontmatter has no round: — the launcher will treat it as 0"

BASE="$(field base)"
if [[ -n "$BASE" ]]; then
  if ! git -C "$REPO_ROOT" rev-parse --verify --quiet "origin/$BASE" >/dev/null \
    && ! git -C "$REPO_ROOT" rev-parse --verify --quiet "$BASE" >/dev/null; then
    err "base: $BASE — no such branch locally or on origin"
  fi
fi
[[ -n "$(field scope_deny)" ]] || warn "no scope_deny: — nothing is forbidden to the builder"

# ── acceptance criteria ──────────────────────────────────────────────────────

mapfile -t ACS < <(grep -oE '^\*\*AC[0-9]+' "$STORY_FILE" | tr -d '*' | sort -u -V)
if (( ${#ACS[@]} == 0 )); then
  err "no acceptance criteria the launcher can see — they must be headed '**ACn — …' at column 0"
else
  n=1
  for ac in "${ACS[@]}"; do
    [[ "$ac" == "AC$n" ]] || { warn "acceptance criteria are not contiguous from AC1 (found $ac where AC$n was expected)"; break; }
    n=$((n + 1))
  done
fi

# An unquantified "every/all/any" in an AC heading is a scope declaration.
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  warn "unquantified domain in an AC heading — name the set it ranges over (L-20):"$'\n'"          ${line:0:100}"
done < <(grep -E '^\*\*AC[0-9]+' "$STORY_FILE" \
         | grep -ivE '\b(every|each|any|all)[[:space:]]+(time|run|round)s?\b' \
         | grep -iE '\b(every|all|any)\b')

# The harness runs test/build/lint as the baseline, unconditionally.
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  warn "an AC about the suite/build/lint — the harness runs those as the baseline:"$'\n'"          ${line:0:100}"
done < <(grep -E '^\*\*AC[0-9]+' "$STORY_FILE" | grep -iE 'suite|npm (test|run (build|lint))|stay green')

# ── sections the conventions require ─────────────────────────────────────────

for section in "## Acceptance criteria" "## Known weakness" "## Out of scope"; do
  grep -q "^$section" "$STORY_FILE" || warn "no '$section' section"
done

# ── citations ────────────────────────────────────────────────────────────────
#
# A citation is a backticked token containing a "/", optionally with :LINE or
# :LINE-LINE, checked against the working tree. The "/" requirement is what
# keeps this useful: without it the check flagged `res.ok`, `cache.match`,
# `caches.open` (JS expressions) and `sw.js`, `Collection.tsx`, `02-REVIEW.md`
# (bare filenames in prose) across every real story — 20 false positives, zero
# real findings. A check that cries wolf is worse than no check.
#
# Not checked, deliberately: bare filenames without a directory, paths
# beginning with "/" (URL paths like /manifest.json), and anything containing
# whitespace — story 012 cited `git log -- public/sw.js`, a command, which the
# first version read as a path because its character class allowed spaces.

checked=0
while read -r cite; do
  [[ -n "$cite" ]] || continue
  path="${cite%%:*}"; lines="${cite#"$path"}"; lines="${lines#:}"
  # Skip things that look like paths but are not repo files.
  case "$path" in
    http*|*@*|node_modules/*) continue ;;
    /*)          continue ;;   # a URL path, not a repo file
    .blocked/*)  continue ;;   # written at runtime by a builder that stops
  esac
  [[ "$path" == */* ]] || continue   # no directory: a filename in prose, not a citation
  [[ "$path" == *.* ]] || continue
  checked=$((checked + 1))
  if [[ ! -e "$REPO_ROOT/$path" ]]; then
    # A line number asserts the file exists NOW, so a missing one is rot
    # (story 004 cited a diagnosis that was never on the integration branch).
    # A bare path may legitimately be forward-looking: a story names the test
    # file its instrument will create. Story 011 cited
    # src/components/__tests__/ThemeSwitch.test.tsx before writing it, and the
    # first version of this check rejected the draft for it.
    if [[ -n "$lines" ]]; then
      err "cites $path:$lines but that file does not exist"
    else
      warn "cites a file that does not exist — new instrument, or rot? $path"
    fi
    continue
  fi
  [[ -n "$lines" ]] || continue
  total="$(wc -l < "$REPO_ROOT/$path")"
  first="${lines%%-*}"; last="${lines##*-}"
  if (( first > total )) || (( last > total )); then
    err "cites $path:$lines but the file has $total lines"
  fi
done < <(grep -oE '`[A-Za-z0-9_./@-]*\[?[A-Za-z0-9_.-]*\]?[A-Za-z0-9_./-]*\.[a-z]+(:[0-9]+(-[0-9]+)?)?`' "$STORY_FILE" \
         | tr -d '`' | sort -u)

# ── verdict ──────────────────────────────────────────────────────────────────

printf '\n%s: %d error(s), %d warning(s), %d citation(s) checked, %d AC(s)\n' \
  "$(basename "$STORY_FILE")" "$ERRORS" "$WARNINGS" "$checked" "${#ACS[@]}"

if (( ERRORS > 0 )); then exit 1; fi
if (( STRICT == 1 && WARNINGS > 0 )); then
  echo "--strict: warnings are fatal" >&2
  exit 1
fi
printf '%sok%s\n' "$GRN" "$RST"
