#!/usr/bin/env bash
#
# merge.sh <repo> <id>          a story into its epic   — the queue calls this
# merge.sh <repo> <id> --land   a story whose base IS the integration branch,
#                               onto it — a human's word (/merge from the
#                               phone); the queue never passes --land
# merge.sh <repo> --epic <name> an epic into the integration branch — a human
#                               calls this, and nothing in the fleet does
#
# MERGE_MODE (the target's .fleet/config, default direct) says how the result
# reaches origin. direct: merge here, run the post-merge baseline, push. pr:
# push the branch and run PR_CMD — the host's `glab mr create` or `gh pr
# create` — in the target checkout with the source branch appended and
# PR_SOURCE / PR_TARGET in its environment; what it prints (the request's
# URL) is the output. Nothing is merged and nothing recorded in pr mode: the
# merge happens on the host and lands in origin/<base> like any human merge.
# Every refusal below applies in both modes.
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
#   the story's base is main or master  → no, and never
#   the story's base is the integration
#   branch                              → no, unless a human said --land
#   --land on a story that lives on an
#   epic                                → no; its epic lands, with --epic
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

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
USAGE="usage: merge.sh <repo> <id> [--land] | <repo> --epic <epic/name>"
[[ $# -ge 2 ]] || die "$USAGE"
load_repo "$1"; shift          # REPO_ROOT, BASE_BRANCH, the commands, SEED_FILES and MERGE_MODE come from the target
PUSH_STATUS="${PUSH_STATUS:-1}"

MODE=story; ID=""; LAND=0
while (($#)); do
  case "$1" in
    --land) LAND=1; shift ;;
    --epic) MODE=epic; ID="${2:-}"; [[ -n "$ID" ]] || die "$USAGE"; shift 2 ;;
    -*)     die "unknown option $1 — $USAGE" ;;
    *)      [[ -z "$ID" ]] || die "$USAGE"; ID="$1"; shift ;;
  esac
done
if [[ "$MODE" == epic ]]; then
  # The one thing this must never do is point the same machinery at main.
  [[ "$ID" == epic/* ]] || die "--epic takes an epic/... branch, not '$ID'"
  (( LAND == 0 )) || die "--epic already lands on $BASE_BRANCH; --land is for a story"
else
  [[ -n "$ID" ]] || die "$USAGE"
  [[ -f "$REPO_ROOT/.stories/$ID.md" ]] || die "no such story: .stories/$ID.md"
fi
LOGID="${ID//\//-}"

MWT="$REPO_ROOT/../merge-$LOGID"
cleanup() { [[ -d "$MWT" ]] && git -C "$REPO_ROOT" worktree remove "$MWT" --force >/dev/null 2>&1; }
trap cleanup EXIT

# ── refusals ─────────────────────────────────────────────────────────────────
#
# status.sh --json is the single reader of story state; duplicating its
# frontmatter parsing here is how the two would drift.

if [[ "$MODE" == epic ]]; then
  BRANCH="$ID"; BASE="$BASE_BRANCH"; MERGE_REF="origin/$BRANCH"
  git -C "$REPO_ROOT" fetch -q origin || die "fetch failed"
  git -C "$REPO_ROOT" rev-parse --verify --quiet "origin/$BRANCH" >/dev/null \
    || die "origin has no $BRANCH"
  git -C "$REPO_ROOT" merge-base --is-ancestor "origin/$BRANCH" "origin/$BASE" 2>/dev/null \
    && { log "$BRANCH is already in $BASE"; exit 0; }
else

S="$(bash "$FLEET_HOME/status.sh" "$REPO_NAME" --json "$ID")" \
  || die "could not read the story's state"
jq -e 'length == 1' >/dev/null <<< "$S" || die "status.sh did not report exactly one story for $ID"

get() { jq -r ".[0].$1" <<< "$S"; }
STATUS="$(get status)"; VERDICT="$(get verdict)"; BASE="$(get base)"
LIVE="$(get live)";     MERGED="$(get merged)";   BRANCH="$(get branch)"

[[ "$STATUS" == done ]]  || die "$ID is $STATUS, not done — nothing to merge"
[[ "$VERDICT" == PASS ]] || die "$ID computed $VERDICT, not PASS — the machine vetoed it"
[[ "$LIVE" == false ]]   || die "$ID has something running in its worktree"
[[ "$BRANCH" != "—" ]]   || die "$ID has no branch"
# A human's --land on a story that lives on an epic gets the command that
# works, merged into its epic already or not — before "already merged"
# could answer instead.
if (( LAND == 1 )); then
  case "$BASE" in
    main|master|"$BASE_BRANCH") ;;
    *) die "$ID lives on $BASE, not on $BASE_BRANCH — land its epic: merge.sh $REPO_NAME --epic $BASE" ;;
  esac
fi
[[ "$MERGED" == false ]] || { log "$ID is already merged into $BASE"; exit 0; }

# The queue calls this on every computed PASS. It must never land anything
# on the integration branch: that is a human's decision, and --land is how
# a human says it (never from run-queue.sh). main and master stay refused
# whatever the flag. A story that lives on an epic is not landed on its own
# — its epic is, as one piece — so --land refuses it and names the command.
case "$BASE" in
  main|master)
    die "$ID is based on $BASE — main is never merged here, --land or not" ;;
  "$BASE_BRANCH")
    (( LAND == 1 )) || die "$ID is based on $BASE — the integration branch is merged by a human: merge.sh $REPO_NAME $ID --land, or /merge $REPO_NAME $ID" ;;
esac

git -C "$REPO_ROOT" fetch -q origin || die "fetch failed"
git -C "$REPO_ROOT" rev-parse --verify --quiet "origin/$BASE" >/dev/null \
  || die "origin has no $BASE"
fi

# ── pr mode: the host merges ─────────────────────────────────────────────────
#
# The branch goes to origin (a story branch is never pushed by the launcher,
# so this is its first push), PR_CMD opens the request, and its output —
# the URL — is this script's output. No throwaway worktree, no post-merge
# baseline here: the host's pipeline is that check, and the merge is the
# reviewer's click. Nothing is recorded in the story; status.sh derives
# `landed` from origin once the host has merged.
if [[ "$MERGE_MODE" == pr ]]; then
  [[ "$PUSH_STATUS" == "1" ]] || die "MERGE_MODE=pr pushes the branch; PUSH_STATUS=$PUSH_STATUS forbids it"
  if [[ "$MODE" == story ]]; then
    git -C "$REPO_ROOT" push -q origin "$BRANCH:refs/heads/$BRANCH" || die "push of $BRANCH failed"
  fi
  log "$BRANCH → $BASE: opening a request with: $PR_CMD $BRANCH"
  export PR_SOURCE="$BRANCH" PR_TARGET="$BASE"
  OUT="$(cd "$REPO_ROOT" && eval "$PR_CMD" '"$BRANCH"')" || die "PR_CMD failed:"$'\n'"$OUT"
  printf '%s\n' "$OUT"
  log "nothing merged here — the request is merged on the host and lands in origin/$BASE"
  exit 0
fi

cleanup
# Detached at origin's tip, in both modes. Naming the branch instead fails
# outright when it is checked out somewhere — and the integration branch
# always is, in the checkout this is running from. What gets published is
# HEAD:refs/heads/<base>, so the local branch is a cache to be refreshed
# afterwards, never the thing being merged into.
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BASE"; then
  git -C "$REPO_ROOT" merge-base --is-ancestor "$BASE" "origin/$BASE" \
    || die "local $BASE has commits origin does not — push or reset it first, or they would be merged over"
fi
git -C "$REPO_ROOT" worktree add --detach "$MWT" "origin/$BASE" >/dev/null || die "worktree add failed"

BEFORE="$(git -C "$MWT" rev-parse HEAD)"
log "merging $BRANCH into $BASE (at ${BEFORE:0:8})"
if ! git -C "$MWT" merge --no-ff "${MERGE_REF:-$BRANCH}" -m "merge($ID): $BRANCH into $BASE" > "$REPO_ROOT/.runs/$LOGID-merge.log" 2>&1; then
  git -C "$MWT" merge --abort 2>/dev/null
  die "$BRANCH does not merge cleanly into $BASE — a human has to resolve it"
fi

# ── the baseline that earns this ─────────────────────────────────────────────
#
# Same rule as the launcher's baseline (ts/src/lib/baseline.ts): a suite
# that collects zero tests is not green (L-08). Duplicated in bash rather
# than called — merge.sh stays bash — and it is the same eleven lines.

for f in "${SEED_FILES_ARR[@]}"; do
  [[ -f "$REPO_ROOT/$f" ]] && cp "$REPO_ROOT/$f" "$MWT/$f"
done
mkdir -p "$REPO_ROOT/.runs"
log "installing deps in the merge worktree"
( cd "$MWT" && $INSTALL_CMD ) > "$REPO_ROOT/.runs/$LOGID-merge-install.log" 2>&1 \
  || die "install failed in the merge worktree — see .runs/$LOGID-merge-install.log"

RAW="$REPO_ROOT/.runs/$LOGID-merge-baseline.json"
rm -f "$RAW"
( cd "$MWT" && $VITEST_CMD --reporter json --outputFile "$RAW" ) > "$REPO_ROOT/.runs/$LOGID-merge-test.log" 2>&1
if [[ -f "$RAW" ]] && jq -e '.numTotalTests > 0 and .numFailedTests == 0' "$RAW" >/dev/null; then
  M_TEST=GREEN; else M_TEST=RED; fi
( cd "$MWT" && $BUILD_CMD ) > "$REPO_ROOT/.runs/$LOGID-merge-build.log" 2>&1 && M_BUILD=GREEN || M_BUILD=RED
( cd "$MWT" && $LINT_CMD  ) > "$REPO_ROOT/.runs/$LOGID-merge-lint.log"  2>&1 && M_LINT=GREEN  || M_LINT=RED
log "post-merge baseline: test $M_TEST | build $M_BUILD | lint $M_LINT"

if [[ "$M_TEST$M_BUILD$M_LINT" != GREENGREENGREEN ]]; then
  # Nothing was pushed, so there is nothing to undo: the merge exists only in
  # a worktree this script is about to delete.
  die "post-merge baseline is red (test $M_TEST, build $M_BUILD, lint $M_LINT) — $BASE is untouched, logs in .runs/$LOGID-merge-*"
fi

# ── publish ──────────────────────────────────────────────────────────────────

MERGE_SHA="$(git -C "$MWT" rev-parse HEAD)"
if [[ "$PUSH_STATUS" == "1" ]]; then
  git -C "$MWT" push -q origin "HEAD:refs/heads/$BASE" \
    || die "push of $BASE failed — the merge is local only"
fi
# Move the local branch to what was just published, unless someone is standing
# on it — in which case say so rather than leave a stale ref quietly behind.
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BASE"; then
  if git -C "$REPO_ROOT" worktree list --porcelain | grep -qx "branch refs/heads/$BASE"; then
    warn "local $BASE is checked out — run: git pull --ff-only"
  else
    git -C "$REPO_ROOT" branch -f "$BASE" "$MERGE_SHA" >/dev/null 2>&1 \
      || warn "could not move local $BASE to ${MERGE_SHA:0:8}"
  fi
fi
log "$BASE is now ${MERGE_SHA:0:8}"

if [[ "$MODE" == epic ]]; then
  log "$ID merged into $BASE — nothing recorded: an epic is not a story, and this was a human's call"
  exit 0
fi

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

log "$ID merged into $BASE — revert with: revert.sh $REPO_NAME $ID"
