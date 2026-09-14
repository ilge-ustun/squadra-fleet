#!/usr/bin/env bash
#
# fleet/launch.sh [story-id]
#
# Phase 4a: queue + status + orphan recovery.
#
#   ./fleet/launch.sh          take the next ready story
#   ./fleet/launch.sh 003      run one specific story
#
# STATE lives in git, not here. Each story file carries frontmatter:
#
#   ---
#   status: ready
#   round: 0
#   ---
#
#   ready         → waiting in the queue
#   in_progress   → a launcher is working on it right now
#   blocked       → the agent asked a question; see .blocked/<id>.md
#   review_failed → reviewer said FAIL; see .review/<id>.md
#   done          → reviewer said PASS; branch waiting for your merge
#
# Status changes are committed and pushed so the queue is visible from a phone.
# .runs/<id>.json is machine-local (gitignored) and holds only the PID.
#
# A blocked or failed story does NOT stop the queue — it stops itself.
#
# KNOWN GAPS (Phase 4b):
#   - orphan detection checks the LAUNCHER's pid. Killing the launcher does not
#     kill claude or its children, so work can continue in a worktree the
#     launcher believes is free. Detection should test the worktree, not a pid.
#   - no round ceiling: FAIL is recorded but round 2 is never run.
#   - the .blocked/ path has never been exercised.
#
set -uo pipefail

# ── config ───────────────────────────────────────────────────────────────────

REPO_ROOT="$(git rev-parse --show-toplevel)"
BASE_BRANCH="${BASE_BRANCH:-feat/pwa}"
BUILDER_MODEL="${BUILDER_MODEL:-claude-sonnet-4-6}"
MAX_TURNS="${MAX_TURNS:-60}"
ALLOWED_TOOLS="Read,Write,Edit,Grep,Glob,Bash"
INSTALL_CMD="npm ci"
PUSH_STATUS="${PUSH_STATUS:-1}"      # PUSH_STATUS=0 to work offline

# Untracked runtime config a fresh worktree does not inherit.
# Story 002: without .env.local everything builds and tests green while the app
# talks to projects/undefined. No instrument in the suite catches that.
SEED_FILES=(.env.local)

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'
log()  { printf '%s==> %s%s\n' "$GRN" "$1" "$RST"; }
warn() { printf '%s!! %s%s\n'  "$YLW" "$1" "$RST"; }
die()  { printf '%sXX %s%s\n'  "$RED" "$1" "$RST" >&2; exit 1; }

command -v claude >/dev/null || die "claude not on PATH"
command -v codex  >/dev/null || die "codex not on PATH"
command -v jq     >/dev/null || die "jq not on PATH"
mkdir -p "$REPO_ROOT/.stories" "$REPO_ROOT/.review" "$REPO_ROOT/.runs" "$REPO_ROOT/.blocked"

# ── frontmatter ──────────────────────────────────────────────────────────────

story_field() {                       # story_field <id> <key>
  local f="$REPO_ROOT/.stories/$1.md"
  [[ -f "$f" ]] || { echo ""; return; }
  awk -v k="$2" '
    NR==1 && $0!="---" { exit }
    /^---$/ { if (++d==2) exit; next }
    d==1 && $0 ~ "^"k":" { sub("^"k":[[:space:]]*",""); print; exit }
  ' "$f"
}

set_story_field() {                   # set_story_field <id> <key> <value>
  local id="$1" k="$2" v="$3" f="$REPO_ROOT/.stories/$1.md"
  if head -1 "$f" | grep -q '^---$'; then
    if story_field "$id" "$k" | grep -q .; then
      sed -i "0,/^$k:.*/s//$k: $v/" "$f"
    else
      sed -i "1a $k: $v" "$f"
    fi
  else
    printf -- '---\n%s: %s\n---\n\n%s\n' "$k" "$v" "$(cat "$f")" > "$f.tmp" && mv "$f.tmp" "$f"
  fi
}

# Status transitions are commits. Without the push there is no phone view.
#
# git add fails ENTIRELY if any one pathspec is missing — it stages nothing and
# exits 128. Adding all three paths at once silently dropped every status commit
# whenever .blocked/<id>.md did not exist, which is almost always. Add each path
# separately, only if it exists.
commit_status() {                     # commit_status <id> <status>
  local id="$1" st="$2" p
  for p in ".stories/$id.md" ".review/$id.md" ".blocked/$id.md"; do
    [[ -f "$REPO_ROOT/$p" ]] && git -C "$REPO_ROOT" add "$p"
  done
  git -C "$REPO_ROOT" diff --cached --quiet && return 0
  git -C "$REPO_ROOT" commit -q -m "story($id): $st" || warn "status commit failed"
  if [[ "$PUSH_STATUS" == "1" ]]; then
    git -C "$REPO_ROOT" push -q 2>/dev/null || warn "status push failed — queue not visible remotely"
  fi
  return 0
}

set_status() {                        # set_status <id> <status>
  set_story_field "$1" status "$2"
  commit_status "$1" "$2"
}

# ── orphan recovery ──────────────────────────────────────────────────────────
#
# A story left in_progress with no live launcher is an orphan: the process was
# killed, or the machine was rebuilt. Reset it to ready. The worktree is left
# alone — it holds committed work, and the next run continues from it. That is
# the recovery path proved in Phase 2: story file + git log, no session state.
#
# UNSOUND, see KNOWN GAPS: a dead launcher pid does not mean work stopped.




# Anything running inside a worktree, found by cwd rather than command line.
# pgrep -f does not work here: the builder is started with `cd $WT && claude ...`,
# so the path never appears in any child's argv — only in its cwd. Verified
# empirically: pgrep found nothing, /proc scan found the process.
procs_in_worktree() {                 # procs_in_worktree <path> → prints pids
  local wt p cwd
  wt="$(readlink -f "$1")" || return 0
  [[ -n "$wt" ]] || return 0
  for p in /proc/[0-9]*; do
    cwd="$(readlink "$p/cwd" 2>/dev/null)" || continue
    [[ "$cwd" == "$wt" || "$cwd" == "$wt"/* ]] && basename "$p"
  done
}

reap_orphans() {
  local f id wt pids
  for f in "$REPO_ROOT"/.stories/*.md; do
    [[ -e "$f" ]] || continue
    id="$(basename "$f" .md)"
    [[ "$(story_field "$id" status)" == "in_progress" ]] || continue

    wt="$REPO_ROOT/../wt-$id"
    if [[ -d "$wt" ]]; then
      pids="$(procs_in_worktree "$wt" | tr '\n' ' ')"
      if [[ -n "${pids// /}" ]]; then
        die "story $id: still running in $wt (pids: $pids) — not an orphan"
      fi
    fi

    warn "orphan: $id was in_progress, nothing running in its worktree — returning to queue"
    set_status "$id" ready
  done
}

# ── story selection ──────────────────────────────────────────────────────────

next_ready() {
  local f id
  for f in $(ls -1 "$REPO_ROOT"/.stories/*.md 2>/dev/null | sort); do
    id="$(basename "$f" .md)"
    [[ "$(story_field "$id" status)" == "ready" ]] && { echo "$id"; return; }
  done
  echo ""
}

seed_env() {
  local target="$1" f
  for f in "${SEED_FILES[@]}"; do
    if [[ -f "$REPO_ROOT/$f" ]]; then
      cp "$REPO_ROOT/$f" "$target/$f"
    else
      warn "$f missing — worktree runs without it"
    fi
  done
}

# ── main ─────────────────────────────────────────────────────────────────────

reap_orphans

STORY_ID="${1:-$(next_ready)}"
[[ -n "$STORY_ID" ]] || { log "queue empty — nothing ready"; exit 0; }

STORY_FILE="$REPO_ROOT/.stories/$STORY_ID.md"
[[ -f "$STORY_FILE" ]] || die "no story file: $STORY_FILE"

CURRENT="$(story_field "$STORY_ID" status)"
[[ -z "$CURRENT" ]] && { set_story_field "$STORY_ID" status ready; CURRENT=ready; }
case "$CURRENT" in
  ready)        : ;;
  in_progress)  die "$STORY_ID is in_progress (reap_orphans should have caught this)" ;;
  *)            die "$STORY_ID has status '$CURRENT' — set it back to ready to rerun" ;;
esac

BUILDER_WT="$REPO_ROOT/../wt-$STORY_ID"
REVIEWER_WT="$REPO_ROOT/../wt-$STORY_ID-review"
BRANCH="story/$STORY_ID"
REVIEW_FILE="$REPO_ROOT/.review/$STORY_ID.md"
RUN_FILE="$REPO_ROOT/.runs/$STORY_ID.json"

cleanup_reviewer() { [[ -d "$REVIEWER_WT" ]] && git -C "$REPO_ROOT" worktree remove "$REVIEWER_WT" --force 2>/dev/null; }
trap cleanup_reviewer EXIT

log "story $STORY_ID"
set_status "$STORY_ID" in_progress
printf '{"story":"%s","pid":%d,"started":"%s"}\n' "$STORY_ID" $$ "$(date -Iseconds)" > "$RUN_FILE"

# ── worktree: create, or resume an existing one ──────────────────────────────

git -C "$REPO_ROOT" fetch origin --quiet

if [[ -d "$BUILDER_WT" ]]; then
  log "resuming existing worktree $BUILDER_WT"
else
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$REPO_ROOT" worktree add "$BUILDER_WT" "$BRANCH" >/dev/null || die "worktree add (existing branch) failed"
  else
    git -C "$REPO_ROOT" worktree add "$BUILDER_WT" -b "$BRANCH" "origin/$BASE_BRANCH" >/dev/null || die "worktree add failed"
  fi
  seed_env "$BUILDER_WT"
  log "installing deps"
  ( cd "$BUILDER_WT" && $INSTALL_CMD ) >/dev/null 2>&1 || warn "$INSTALL_CMD failed"
fi

BASE_SHA="$(git -C "$BUILDER_WT" merge-base HEAD "origin/$BASE_BRANCH")"
log "base ${BASE_SHA:0:8}"

# ── builder ──────────────────────────────────────────────────────────────────

BUILD_PROMPT="Read .stories/$STORY_ID.md and implement it.
Check git log first — if some tasks are already committed, continue from the
first unfinished one. Do not redo committed work.

Rules that override anything you infer:
- TDD is mandatory. Write the failing test, run it, SEE IT FAIL, then implement.
  A test never observed red is not a test.
- One task, one commit.
- Do not run deploy commands, firebase commands, or anything that writes to Firestore.
- If a decision is needed that the story does not answer, write .blocked/$STORY_ID.md
  with the question and the options, and stop. Do not guess.
  Format: what must be decided, each option with its cost, your recommendation.
- Stay in scope. Mention unrelated problems at the end; do not fix them."

log "builder: $BUILDER_MODEL"
BUILD_OUT="$(cd "$BUILDER_WT" && claude -p "$BUILD_PROMPT" \
  --model "$BUILDER_MODEL" --max-turns "$MAX_TURNS" \
  --allowedTools "$ALLOWED_TOOLS" --output-format json 2>&1)"
BUILD_ERR="$(echo "$BUILD_OUT" | jq -r '.is_error // "parse-failed"' 2>/dev/null)"
BUILD_MSG="$(echo "$BUILD_OUT" | jq -r '.result // "no result field"' 2>/dev/null)"

# Without this, a crashed claude (non-JSON output) is reported downstream as
# "builder produced no commits", hiding the real cause.
if [[ "$BUILD_ERR" == "parse-failed" ]]; then
  warn "builder output was not JSON — first 20 lines of raw output:"
  echo "$BUILD_OUT" | head -20
fi

# ── postcondition, not self-report ───────────────────────────────────────────
# Phase 2: is_error was false while the agent did nothing at all.

if [[ -f "$BUILDER_WT/.blocked/$STORY_ID.md" ]]; then
  cp "$BUILDER_WT/.blocked/$STORY_ID.md" "$REPO_ROOT/.blocked/$STORY_ID.md"
  warn "BLOCKED — agent asked a question:"
  cat "$REPO_ROOT/.blocked/$STORY_ID.md"
  set_status "$STORY_ID" blocked
  echo
  echo "answer by editing .stories/$STORY_ID.md, then set status back to ready"
  exit 0
fi

HEAD_SHA="$(git -C "$BUILDER_WT" rev-parse HEAD)"
NEW_COMMITS="$(git -C "$BUILDER_WT" rev-list --count "$BASE_SHA..$HEAD_SHA")"
if [[ "$NEW_COMMITS" -eq 0 ]]; then
  set_status "$STORY_ID" review_failed
  die "builder produced no commits (is_error=$BUILD_ERR). Said: $BUILD_MSG"
fi
log "builder: $NEW_COMMITS commit(s), head ${HEAD_SHA:0:8}"

# ── reviewer: clean worktree at the builder's head ───────────────────────────

log "reviewer worktree at ${HEAD_SHA:0:8}"
git -C "$REPO_ROOT" worktree add --detach "$REVIEWER_WT" "$HEAD_SHA" >/dev/null || die "reviewer worktree failed"
seed_env "$REVIEWER_WT"
( cd "$REVIEWER_WT" && $INSTALL_CMD ) >/dev/null 2>&1 || warn "$INSTALL_CMD failed in reviewer tree"

REVIEW_PROMPT="You are reviewing a change against its specification.

The specification is in .stories/$STORY_ID.md — read it first.
You are in a clean checkout at commit $HEAD_SHA. The base was $BASE_SHA.

Do NOT review by reading the diff. Derive your evidence independently:
read the current state of the files, run the tests, run the build.

For every claim you make, cite file:line. A claim without a citation is not
a finding.

Check specifically:
1. Does each acceptance criterion hold? Name the instrument that proves it.
2. Can that instrument go red? Prove it by mutation where you can. A check that
   passes regardless of what shipped is absent, not weak — say so.
3. Is anything here outside the story's scope?
4. Does anything the story did not mention regress?

Run: npm test, npm run build, npm run lint.

End your response with exactly one line, nothing after it:
VERDICT: PASS
or
VERDICT: FAIL"

# --sandbox danger-full-access: bwrap cannot create network namespaces on this
# host (RTM_NEWADDR: Operation not permitted), so Codex's own sandbox fails to
# start before it reads anything. Isolation comes from the detached worktree and
# the unprivileged fleet user with no sudo — not from bwrap.
log "reviewer: codex"
REVIEW_RAW="$(cd "$REVIEWER_WT" && codex exec --json --sandbox danger-full-access "$REVIEW_PROMPT" 2>&1)"

# codex emits JSON Lines; claude emits one object. Falls back to raw output if
# the filter matches nothing — that fallback has already earned its keep once.
REVIEW_TEXT="$(echo "$REVIEW_RAW" | jq -r 'select(.type=="item.completed") | .item.text // empty' 2>/dev/null)"
[[ -n "$REVIEW_TEXT" ]] || REVIEW_TEXT="$REVIEW_RAW"

if   echo "$REVIEW_TEXT" | grep -qE '^VERDICT: PASS[[:space:]]*$'; then VERDICT="PASS"
elif echo "$REVIEW_TEXT" | grep -qE '^VERDICT: FAIL[[:space:]]*$'; then VERDICT="FAIL"
else VERDICT="UNPARSEABLE"; fi

PREV_ROUND="$(story_field "$STORY_ID" round)"
[[ "$PREV_ROUND" =~ ^[0-9]+$ ]] || PREV_ROUND=0
ROUND=$(( PREV_ROUND + 1 ))
set_story_field "$STORY_ID" round "$ROUND"

cat > "$REVIEW_FILE" <<EOF
# Review: $STORY_ID

verdict: $VERDICT
round: $ROUND
base: $BASE_SHA
head: $HEAD_SHA
commits: $NEW_COMMITS
reviewed: $(date -Iseconds)

## Builder said

$BUILD_MSG

## Reviewer

$REVIEW_TEXT
EOF

case "$VERDICT" in
  PASS) set_status "$STORY_ID" done;          log  "VERDICT: PASS  → $REVIEW_FILE" ;;
  *)    set_status "$STORY_ID" review_failed; warn "VERDICT: $VERDICT  → $REVIEW_FILE" ;;
esac

jq -n --arg s "$STORY_ID" --arg v "$VERDICT" --arg h "$HEAD_SHA" \
  '{story:$s,verdict:$v,head_sha:$h}' > "$RUN_FILE"

echo
echo "branch $BRANCH, worktree $BUILDER_WT"
echo "merge it, then: git worktree remove $BUILDER_WT"
