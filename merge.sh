#!/usr/bin/env bash
#
# fleet/merge.sh <id>
#
# Merge a story into its epic branch, but only if the machine already said so
# and only if the merged result still holds up.
#
# Every merge in the fleet's first thirteen stories was a human's. This is the
# piece that changes that, so it is written as a list of refusals:
#
#   status is not `done`                → no
#   the computed verdict is not PASS    → no. The reviewer's own line does not
#                                         count; line 3 of .review/<id>.md is
#                                         the harness's computation.
#   something is live in the worktree   → no
#   the story's base is the integration
#   branch, main or master              → no, and never. Those are a human's.
#   already merged                      → nothing to do
#
# Then the part that earns the autonomy: the merge happens in a throwaway
# worktree and the suite, the build and the lint run against the MERGED result.
# Two stories that each passed alone can still break each other, and until now
# nothing ran anything against the combination. Nothing is pushed until that
# baseline is green — so a red one needs no undo, the merge simply never
# leaves the temporary worktree.
#
# After a successful merge the sha is recorded in the story's frontmatter, so
# the revert is deterministic and can be asked for by id rather than by sha.
#
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
BASE_BRANCH="${BASE_BRANCH:-develop}"
PUSH_STATUS="${PUSH_STATUS:-1}"
INSTALL_CMD="${INSTALL_CMD:-npm ci}"
VITEST_CMD="${VITEST_CMD:-npx vitest run}"
BUILD_CMD="${BUILD_CMD:-npm run build}"
LINT_CMD="${LINT_CMD:-npm run lint}"
SEED_FILES=(.env.local)

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'
log()  { printf '%s==> %s%s\n' "$GRN" "$1" "$RST"; }
warn() { printf '%s!! %s%s\n'  "$YLW" "$1" "$RST"; }
die()  { printf '%sXX %s%s\n'  "$RED" "$1" "$RST" >&2; exit 1; }

ID="${1:-}"
[[ -n "$ID" ]] || die "usage: fleet/merge.sh <id>"
[[ -f "$REPO_ROOT/.stories/$ID.md" ]] || die "no such story: .stories/$ID.md"

MWT="$REPO_ROOT/../merge-$ID"
cleanup() { [[ -d "$MWT" ]] && git -C "$REPO_ROOT" worktree remove "$MWT" --force >/dev/null 2>&1; }
trap cleanup EXIT

# ── refusals ─────────────────────────────────────────────────────────────────
#
# status.sh --json is the single reader of story state; duplicating its
# frontmatter parsing here is how the two would drift.

S="$(cd "$REPO_ROOT" && BASE_BRANCH="$BASE_BRANCH" bash fleet/status.sh --json "$ID")" \
  || die "could not read the story's state"
jq -e 'length == 1' >/dev/null <<< "$S" || die "status.sh did not report exactly one story for $ID"

get() { jq -r ".[0].$1" <<< "$S"; }
STATUS="$(get status)"; VERDICT="$(get verdict)"; BASE="$(get base)"
LIVE="$(get live)";     MERGED="$(get merged)";   BRANCH="$(get branch)"

[[ "$STATUS" == done ]]  || die "$ID is $STATUS, not done — nothing to merge"
[[ "$VERDICT" == PASS ]] || die "$ID computed $VERDICT, not PASS — the machine vetoed it"
[[ "$LIVE" == false ]]   || die "$ID has something running in its worktree"
[[ "$BRANCH" != "—" ]]   || die "$ID has no branch"
[[ "$MERGED" == false ]] || { log "$ID is already merged into $BASE"; exit 0; }

case "$BASE" in
  "$BASE_BRANCH"|main|master)
    die "$ID is based on $BASE — the integration branch and main are merged by a human, never here" ;;
esac

# ── merge, in a worktree nobody else is standing in ──────────────────────────

git -C "$REPO_ROOT" fetch -q origin || die "fetch failed"
git -C "$REPO_ROOT" rev-parse --verify --quiet "origin/$BASE" >/dev/null \
  || die "origin has no $BASE"

cleanup
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BASE"; then
  git -C "$REPO_ROOT" merge-base --is-ancestor "$BASE" "origin/$BASE" \
    || die "local $BASE has commits origin does not — push or reset it first"
  git -C "$REPO_ROOT" worktree add "$MWT" "$BASE" >/dev/null || die "worktree add failed"
  git -C "$MWT" merge --ff-only "origin/$BASE" >/dev/null 2>&1
else
  git -C "$REPO_ROOT" worktree add "$MWT" -b "$BASE" "origin/$BASE" >/dev/null || die "worktree add failed"
fi

BEFORE="$(git -C "$MWT" rev-parse HEAD)"
log "merging $BRANCH into $BASE (at ${BEFORE:0:8})"
if ! git -C "$MWT" merge --no-ff "$BRANCH" -m "merge($ID): $BRANCH into $BASE" > "$MWT/../merge-$ID.log" 2>&1; then
  git -C "$MWT" merge --abort 2>/dev/null
  die "$BRANCH does not merge cleanly into $BASE — a human has to resolve it"
fi

# ── the baseline that earns this ─────────────────────────────────────────────
#
# Same rule as the launcher's run_baseline (fleet/launch.sh): a suite that
# collects zero tests is not green (L-08). Duplicated rather than sourced —
# launch.sh runs its main body on source — and it is the same eleven lines.

for f in "${SEED_FILES[@]}"; do
  [[ -f "$REPO_ROOT/$f" ]] && cp "$REPO_ROOT/$f" "$MWT/$f"
done
log "installing deps in the merge worktree"
( cd "$MWT" && $INSTALL_CMD ) > "$REPO_ROOT/.runs/$ID-merge-install.log" 2>&1 \
  || die "install failed in the merge worktree — see .runs/$ID-merge-install.log"

RAW="$REPO_ROOT/.runs/$ID-merge-baseline.json"
mkdir -p "$REPO_ROOT/.runs"; rm -f "$RAW"
( cd "$MWT" && $VITEST_CMD --reporter json --outputFile "$RAW" ) > "$REPO_ROOT/.runs/$ID-merge-test.log" 2>&1
if [[ -f "$RAW" ]] && jq -e '.numTotalTests > 0 and .numFailedTests == 0' "$RAW" >/dev/null; then
  M_TEST=GREEN; else M_TEST=RED; fi
( cd "$MWT" && $BUILD_CMD ) > "$REPO_ROOT/.runs/$ID-merge-build.log" 2>&1 && M_BUILD=GREEN || M_BUILD=RED
( cd "$MWT" && $LINT_CMD  ) > "$REPO_ROOT/.runs/$ID-merge-lint.log"  2>&1 && M_LINT=GREEN  || M_LINT=RED
log "post-merge baseline: test $M_TEST | build $M_BUILD | lint $M_LINT"

if [[ "$M_TEST$M_BUILD$M_LINT" != GREENGREENGREEN ]]; then
  # Nothing was pushed, so there is nothing to undo: the merge exists only in
  # a worktree this script is about to delete.
  die "post-merge baseline is red (test $M_TEST, build $M_BUILD, lint $M_LINT) — $BASE is untouched, logs in .runs/$ID-merge-*"
fi

# ── publish ──────────────────────────────────────────────────────────────────

MERGE_SHA="$(git -C "$MWT" rev-parse HEAD)"
if [[ "$PUSH_STATUS" == "1" ]]; then
  git -C "$MWT" push -q origin "HEAD:refs/heads/$BASE" \
    || die "push of $BASE failed — the merge is local only"
fi
log "$BASE is now ${MERGE_SHA:0:8}"

# The sha goes in the story so a revert can be asked for by id. Recorded on the
# integration branch, which is where all fleet state lives.
f="$REPO_ROOT/.stories/$ID.md"
if awk 'NR==1 && $0=="---"' "$f" | grep -q .; then
  if grep -q '^merged:' "$f"; then
    sed -i "0,/^merged:.*/s//merged: $MERGE_SHA/" "$f"
  else
    sed -i "1a merged: $MERGE_SHA" "$f"
  fi
fi
git -C "$REPO_ROOT" add -- ".stories/$ID.md"
if git -C "$REPO_ROOT" diff --cached --quiet; then
  warn "nothing to record — the story file did not change"
else
  git -C "$REPO_ROOT" commit -q -m "story($ID): merged into $BASE at ${MERGE_SHA:0:8}" \
    || die "could not record the merge in the story"
  [[ "$PUSH_STATUS" == "1" ]] && { git -C "$REPO_ROOT" push -q 2>/dev/null || warn "push failed — the record is local only"; }
fi

log "$ID merged into $BASE — revert with: fleet/revert.sh $ID"
