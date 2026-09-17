#!/usr/bin/env bash
#
# fleet/launch.sh [story-id]
#
# Phase 4b: queue, orphan recovery, and a review round ceiling.
#
#   ./fleet/launch.sh          take the next ready story
#   ./fleet/launch.sh 004      run one specific story
#
# STATE lives in git. Each story file carries frontmatter:
#
#   ---
#   status: ready
#   round: 0
#   ---
#
#   ready         → waiting in the queue
#   in_progress   → a launcher is working on it right now
#   blocked       → the agent asked a question; see .blocked/<id>.md
#   needs_human   → MAX_ROUNDS reviews failed; see .review/<id>.md
#   done          → reviewer said PASS; branch waiting for your merge
#
# ROUNDS: on FAIL the builder is re-run with the reviewer's findings in its
# prompt, then reviewed again. After MAX_ROUNDS failures the story stops at
# needs_human. A stopped story does NOT stop the queue.
#
# Status changes are committed and pushed so the queue is visible from a phone.
# .runs/<id>.json is machine-local (gitignored).
#
# PROMPTS live in fleet/prompts/*.md, rendered by fleet/render.sh. See
# fleet/prompts/README.md — in particular the verdict contract, which is parsed
# in three places that do not reference each other.
#
set -uo pipefail

# ── config ───────────────────────────────────────────────────────────────────

REPO_ROOT="$(git rev-parse --show-toplevel)"
BASE_BRANCH="${BASE_BRANCH:-feat/pwa}"
BUILDER_MODEL="${BUILDER_MODEL:-claude-sonnet-4-6}"
MAX_TURNS="${MAX_TURNS:-60}"
MAX_ROUNDS="${MAX_ROUNDS:-2}"        # escalation ceiling
ALLOWED_TOOLS="Read,Write,Edit,Grep,Glob,Bash"
INSTALL_CMD="${INSTALL_CMD:-npm ci}"   # overridable so fleet/test-lib.sh can skip the install
VITEST_CMD="${VITEST_CMD:-npx vitest run}"   # baseline + mutation runner; test-lib points it at a fake
BUILD_CMD="${BUILD_CMD:-npm run build}"
LINT_CMD="${LINT_CMD:-npm run lint}"
PUSH_STATUS="${PUSH_STATUS:-1}"      # PUSH_STATUS=0 to work offline
PROMPTS_DIR="$REPO_ROOT/fleet/prompts"

# Untracked runtime config a fresh worktree does not inherit.
# Story 002: without .env.local everything builds and tests green while the app
# talks to projects/undefined. No instrument in the suite catches that.
SEED_FILES=(.env.local)

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'
log()  { printf '%s==> %s%s\n' "$GRN" "$1" "$RST"; }
warn() { printf '%s!! %s%s\n'  "$YLW" "$1" "$RST"; }
die()  { printf '%sXX %s%s\n'  "$RED" "$1" "$RST" >&2; exit 1; }

# render_prompt() — needs die/warn above, and PROMPTS_DIR from config.
source "$REPO_ROOT/fleet/render.sh" || die "cannot source fleet/render.sh"

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

# git add fails ENTIRELY if any one pathspec is missing — it stages nothing and
# exits 128. Adding all three at once silently dropped every status commit
# whenever .blocked/<id>.md did not exist. Add each path separately.
commit_status() {                     # commit_status <id> <status>
  local id="$1" st="$2" p
  for p in ".stories/$id.md" ".review/$id.md" ".blocked/$id.md"; do
    [[ -f "$REPO_ROOT/$p" ]] && git -C "$REPO_ROOT" add "$p"
  done
  # Evidence directory: baseline results now, mutations later. A directory,
  # so guarded separately from the files above (same L-02 reasoning).
  [[ -d "$REPO_ROOT/.review/$id" ]] && git -C "$REPO_ROOT" add ".review/$id"
  git -C "$REPO_ROOT" diff --cached --quiet && return 0
  git -C "$REPO_ROOT" commit -q -m "story($id): $st" || warn "status commit failed"
  if [[ "$PUSH_STATUS" == "1" ]]; then
    git -C "$REPO_ROOT" push -q 2>/dev/null || warn "status push failed — queue not visible remotely"
  fi
  return 0
}

# ── baseline ─────────────────────────────────────────────────────────────────
#
# The harness runs the suite, the build and the lint itself, in the clean
# reviewer tree, before the reviewer is asked anything. Results are files
# under .review/<id>/round-N/baseline/, committed with the status: evidence
# a verdict can cite that is still there tomorrow. A red baseline is a
# machine veto — the verdict is FAIL whatever the reviewer says.
#
# vitest's JSON reporter (shape read from a real run, 17 Sep): a transform
# error reports numTotalTests=0 with success=false, visually identical to a
# caught bug in the terminal (L-08). Green therefore requires tests to have
# actually run: numTotalTests > 0 AND numFailedTests == 0.

run_baseline() {                      # run_baseline <worktree> <evidence-dir> → BASE_TEST BASE_BUILD BASE_LINT
  local wt="$1" ev="$2/baseline" raw="$REPO_ROOT/.runs/$STORY_ID-round$ROUND-baseline.json"
  mkdir -p "$ev"
  rm -f "$raw"

  ( cd "$wt" && $VITEST_CMD --reporter json --outputFile "$raw" ) > "$ev/test.log" 2>&1
  if [[ -f "$raw" ]] && jq -e '.numTotalTests > 0 and .numFailedTests == 0' "$raw" >/dev/null; then
    BASE_TEST=GREEN
  else
    BASE_TEST=RED
  fi
  if [[ -f "$raw" ]]; then
    jq '{numTotalTests, numPassedTests, numFailedTests, success,
         failed: [.testResults[].assertionResults[] | select(.status=="failed") | .fullName]}' \
      "$raw" > "$ev/test.summary.json"
  else
    printf '{"error":"vitest wrote no JSON — see test.log"}\n' > "$ev/test.summary.json"
  fi

  ( cd "$wt" && $BUILD_CMD ) 2>&1 | tail -n 200 > "$ev/build.log" && BASE_BUILD=GREEN || BASE_BUILD=RED
  ( cd "$wt" && $LINT_CMD  ) 2>&1 | tail -n 200 > "$ev/lint.log"  && BASE_LINT=GREEN  || BASE_LINT=RED

  log "baseline: test $BASE_TEST | build $BASE_BUILD | lint $BASE_LINT"
}

# ── mutation runner ──────────────────────────────────────────────────────────
#
# The reviewer proposes mutations as files; the harness runs them. For each
# .review/<id>/round-N/mutations/ACn-<slug>.patch with a .test (vitest
# selector) or .cmd (any command) beside it, in the clean reviewer tree:
#
#   pre-run, unmutated  → must be green, else PRE_RED: the instrument was
#                         already failing and proves nothing
#   git apply           → else PATCH_INVALID
#   run, mutated        → RED needs a REAL failure. .test: numFailedTests > 0;
#                         zero tests collected is NO_TESTS (the mutation broke
#                         compilation — L-08), never RED. .cmd: non-zero exit.
#                         GREEN = the mutation survived: for this behaviour the
#                         instrument is absent.
#   restore             → tree must be clean again, or the run stops: nothing
#                         measured after a failed restore can be trusted
#
# Selector lines are executed with bash -c: a .cmd is a command by contract,
# and a .test may carry `-t "a pattern with spaces"`. Same trust as the
# reviewer already has — it wrote them in a tree it could edit.

porcelain() { git -C "$1" status --porcelain | grep -v '^?? \.review-out/' || true; }

run_selector() {                      # run_selector <wt> <kind> <selector-file> <raw-out-prefix> → RED|GREEN|NO_TESTS
  local wt="$1" kind="$2" line raw="$4.json" log="$4.log"
  line="$(head -n1 "$3")"
  rm -f "$raw"
  case "$kind" in
    test)
      ( cd "$wt" && bash -c "$VITEST_CMD $line --reporter json --outputFile '$raw'" ) > "$log" 2>&1
      if   [[ ! -f "$raw" ]];                                  then echo NO_TESTS
      elif jq -e '.numTotalTests == 0'  "$raw" >/dev/null;     then echo NO_TESTS
      elif jq -e '.numFailedTests > 0'  "$raw" >/dev/null;     then echo RED
      else                                                          echo GREEN; fi ;;
    cmd)
      if ( cd "$wt" && bash -c "$line" ) > "$log" 2>&1; then echo GREEN; else echo RED; fi ;;
  esac
}

run_mutations() {                     # run_mutations <wt> <evidence-dir> → MUT_ROWS (one "ACn CLASS slug" per line)
  local wt="$1" mdir="$2/mutations" p name ac slug kind sel cls pre raw
  MUT_ROWS=""
  [[ -d "$mdir" ]] || return 0

  for p in "$mdir"/AC*-*.patch; do
    [[ -e "$p" ]] || continue
    name="$(basename "$p" .patch)"; ac="${name%%-*}"; slug="${name#*-}"
    raw="$REPO_ROOT/.runs/$STORY_ID-round$ROUND-$name"

    if   [[ -f "$mdir/$name.test" ]]; then kind=test; sel="$mdir/$name.test"
    elif [[ -f "$mdir/$name.cmd"  ]]; then kind=cmd;  sel="$mdir/$name.cmd"
    else kind=""; fi

    if [[ -z "$kind" ]]; then
      cls=NO_SELECTOR
    else
      [[ -z "$(porcelain "$wt")" ]] || die "mutation runner: tree dirty before $name"
      pre="$(run_selector "$wt" "$kind" "$sel" "$raw-pre")"
      if [[ "$pre" != GREEN ]]; then
        cls=PRE_RED
      elif ! git -C "$wt" apply --check "$p" 2> "$raw-apply.log" || ! git -C "$wt" apply "$p" 2>> "$raw-apply.log"; then
        cls=PATCH_INVALID
        git -C "$wt" checkout -q -- . ; git -C "$wt" clean -qfd -e .review-out
      else
        cls="$(run_selector "$wt" "$kind" "$sel" "$raw-mut")"
        git -C "$wt" checkout -q -- . ; git -C "$wt" clean -qfd -e .review-out
        [[ -z "$(porcelain "$wt")" ]] || die "mutation runner: tree dirty after restoring $name"
      fi
    fi

    {
      echo "$cls"
      [[ "$kind" == test && -f "$raw-mut.json" ]] && \
        jq -c '{numTotalTests, numFailedTests, failed: [.testResults[].assertionResults[] | select(.status=="failed") | .fullName]}' "$raw-mut.json"
    } > "$mdir/$name.result"
    MUT_ROWS+="$ac $cls $slug"$'\n'
    log "mutation $name: $cls"
  done
}

set_status() {                        # set_status <id> <status>
  set_story_field "$1" status "$2"
  commit_status "$1" "$2"
}

# ── worktree occupancy ───────────────────────────────────────────────────────
#
# Found by cwd, not command line. pgrep -f does not work: the builder is started
# with `cd $WT && claude ...`, so the path never appears in any child's argv —
# only in its cwd. Verified: pgrep found nothing, /proc scan found the process.
# Killing the launcher leaves claude and its children alive, so a dead launcher
# pid is not evidence that work stopped.

procs_in_worktree() {                 # procs_in_worktree <path> → prints pids
  local wt p cwd
  wt="$(readlink -f "$1" 2>/dev/null)" || return 0
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
  ready)       : ;;
  in_progress) die "$STORY_ID is in_progress (reap_orphans should have caught this)" ;;
  needs_human) die "$STORY_ID needs a human — read .review/$STORY_ID.md, then set status to ready" ;;
  *)           die "$STORY_ID has status '$CURRENT' — set it back to ready to rerun" ;;
esac

# Acceptance criteria are headed `**ACn — …**` at column 0 (.stories/TEMPLATE.md).
# The mutation runner keys on these ids; a story with none can never be
# verified, so it leaves the queue before any agent spends quota on it.
# needs_human rather than a bare die: a die here would leave the story
# `ready`, first in next_ready(), and wedge the queue unattended.
AC_IDS="$(grep -oE '^\*\*AC[0-9]+' "$STORY_FILE" | tr -d '*' | sort -u | tr '\n' ' ')"
if [[ -z "${AC_IDS// /}" ]]; then
  set_status "$STORY_ID" needs_human
  die "$STORY_ID declares no acceptance criteria (**ACn — …** at column 0) — nothing a runner can verify"
fi

BUILDER_WT="$REPO_ROOT/../wt-$STORY_ID"
REVIEWER_WT="$REPO_ROOT/../wt-$STORY_ID-review"
BRANCH="story/$STORY_ID"
REVIEW_FILE="$REPO_ROOT/.review/$STORY_ID.md"
# Findings live in .review/<id>.md, not only in this process. Without this a
# restart after FAIL loses them: the builder re-reads the story, sees its own
# commits, and concludes the work is done. Observed twice on story 004.
REVIEW_TEXT=""
if [[ -f "$REVIEW_FILE" ]] && grep -qE '^verdict: (FAIL|UNPARSEABLE|SPEC)' "$REVIEW_FILE"; then
  REVIEW_TEXT="$(cat "$REVIEW_FILE")"
  warn "prior failing review found — builder starts from the findings"
fi
RUN_FILE="$REPO_ROOT/.runs/$STORY_ID.json"

cleanup_reviewer() { [[ -d "$REVIEWER_WT" ]] && git -C "$REPO_ROOT" worktree remove "$REVIEWER_WT" --force 2>/dev/null; }
trap cleanup_reviewer EXIT

log "story $STORY_ID"
set_status "$STORY_ID" in_progress
printf '{"story":"%s","pid":%d,"started":"%s"}\n' "$STORY_ID" $$ "$(date -Iseconds)" > "$RUN_FILE"

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

# rules.md itself contains {{STORY_ID}}, so it is rendered first and then
# embedded as {{RULES}} by the build prompts.
RULES="$(render_prompt rules.md)"

# ── review rounds ────────────────────────────────────────────────────────────

: > "$REVIEW_FILE.new"
VERDICT=""
ROUND=0

while (( ROUND < MAX_ROUNDS )); do
  ROUND=$(( ROUND + 1 ))
  set_story_field "$STORY_ID" round "$ROUND"
  log "round $ROUND of $MAX_ROUNDS"

  ROUND_START_SHA="$(git -C "$BUILDER_WT" rev-parse HEAD)"
  
  if (( ROUND == 1 )) && [[ -z "$REVIEW_TEXT" ]]; then
    BUILD_PROMPT="$(render_prompt build-round1.md)"
  elif (( ROUND == 1 )) && grep -qE '^verdict: SPEC' "$REVIEW_FILE" 2>/dev/null; then
    BUILD_PROMPT="$(render_prompt build-after-spec.md)"
  else
    BUILD_PROMPT="$(render_prompt build-round2.md)"
  fi

  log "builder: $BUILDER_MODEL"
  BUILD_OUT="$(cd "$BUILDER_WT" && claude -p "$BUILD_PROMPT" \
    --model "$BUILDER_MODEL" --max-turns "$MAX_TURNS" \
    --allowedTools "$ALLOWED_TOOLS" --output-format json 2>&1)"

  # jq's // is the ALTERNATIVE operator: it fires on null AND on false, so
  # `.is_error // "parse-failed"` rewrote every SUCCESSFUL run as parse-failed.
  # has() tests for the key, not its truthiness.
  BUILD_ERR="$(echo "$BUILD_OUT" | jq -r 'if has("is_error") then (.is_error|tostring) else "parse-failed" end' 2>/dev/null)"
  BUILD_MSG="$(echo "$BUILD_OUT" | jq -r '.result // "no result field"' 2>/dev/null)"

  if [[ "$BUILD_ERR" == "parse-failed" ]]; then
    warn "builder output was not JSON — first 20 lines of raw output:"
    echo "$BUILD_OUT" | head -20
  fi

  if [[ -f "$BUILDER_WT/.blocked/$STORY_ID.md" ]]; then
    cp "$BUILDER_WT/.blocked/$STORY_ID.md" "$REPO_ROOT/.blocked/$STORY_ID.md"
    warn "BLOCKED — agent asked a question:"
    cat "$REPO_ROOT/.blocked/$STORY_ID.md"
    set_status "$STORY_ID" blocked
    rm -f "$REVIEW_FILE.new"
    echo
    echo "answer by editing .stories/$STORY_ID.md, then set status back to ready"
    exit 0
  fi

  HEAD_SHA="$(git -C "$BUILDER_WT" rev-parse HEAD)"
  ROUND_COMMITS="$(git -C "$BUILDER_WT" rev-list --count "$ROUND_START_SHA..$HEAD_SHA")"
  TOTAL_COMMITS="$(git -C "$BUILDER_WT" rev-list --count "$BASE_SHA..$HEAD_SHA")"

  # Postcondition, not self-report. Phase 2: is_error was false while the agent
  # did nothing at all.
  if (( ROUND_COMMITS == 0 )); then
    set_status "$STORY_ID" needs_human
    die "round $ROUND produced no commits (is_error=$BUILD_ERR). Said: $BUILD_MSG"
  fi
  log "builder: $ROUND_COMMITS commit(s) this round, $TOTAL_COMMITS total, head ${HEAD_SHA:0:8}"

  # ── reviewer: clean worktree at the builder's head ─────────────────────────

  cleanup_reviewer
  log "reviewer worktree at ${HEAD_SHA:0:8}"
  git -C "$REPO_ROOT" worktree add --detach "$REVIEWER_WT" "$HEAD_SHA" >/dev/null || die "reviewer worktree failed"
  seed_env "$REVIEWER_WT"
  ( cd "$REVIEWER_WT" && $INSTALL_CMD ) >/dev/null 2>&1 || warn "$INSTALL_CMD failed in reviewer tree"

  EVIDENCE_DIR="$REPO_ROOT/.review/$STORY_ID/round-$ROUND"
  run_baseline "$REVIEWER_WT" "$EVIDENCE_DIR"

  REVIEW_PROMPT="$(render_prompt review.md)"

  # --sandbox danger-full-access: bwrap cannot create network namespaces on this
  # host (RTM_NEWADDR: Operation not permitted), so Codex's own sandbox fails to
  # start before it reads anything. Isolation comes from the detached worktree
  # and the unprivileged fleet user with no sudo — not from bwrap.
  log "reviewer: codex"
  REVIEW_RAW="$(cd "$REVIEWER_WT" && codex exec --json --sandbox danger-full-access "$REVIEW_PROMPT" 2>&1)"

  # codex emits JSON Lines; claude emits one object. Falls back to raw output if
  # the filter matches nothing — that fallback has already earned its keep once.
  REVIEW_TEXT="$(echo "$REVIEW_RAW" | jq -r 'select(.type=="item.completed") | .item.text // empty' 2>/dev/null)"
  [[ -n "$REVIEW_TEXT" ]] || REVIEW_TEXT="$REVIEW_RAW"

  # ── reviewer output contract ───────────────────────────────────────────────
  #
  # The reviewer proposes mutations as files under .review-out/ and must leave
  # the tree otherwise untouched — the harness applies them, not the reviewer.
  # A dirty tree means the contract was not followed and nothing the runner
  # measures afterwards can be trusted. That is a prompt problem, so it goes
  # to a human rather than back into the queue.
  DIRTY="$(git -C "$REVIEWER_WT" status --porcelain | grep -v '^?? \.review-out/' || true)"
  if [[ -n "$DIRTY" ]]; then
    set_status "$STORY_ID" needs_human
    die "reviewer left the tree dirty:"$'\n'"$DIRTY"
  fi

  # Everything the verdict will rest on, into git before anything is judged.
  printf '%s\n' "$BUILD_MSG"   > "$EVIDENCE_DIR/builder.md"
  printf '%s\n' "$REVIEW_TEXT" > "$EVIDENCE_DIR/reviewer.md"
  if [[ -d "$REVIEWER_WT/.review-out/mutations" ]]; then
    mkdir -p "$EVIDENCE_DIR/mutations"
    cp -r "$REVIEWER_WT/.review-out/mutations/." "$EVIDENCE_DIR/mutations/"
  fi

  run_mutations "$REVIEWER_WT" "$EVIDENCE_DIR"
  MUT_TABLE="$(printf '%s' "$MUT_ROWS" | awk 'NF { printf "%-4s %-13s %s\n", $1, $2, $3 }')"

  if   echo "$REVIEW_TEXT" | grep -qE '^VERDICT: PASS[[:space:]]*$'; then VERDICT="PASS"
  elif echo "$REVIEW_TEXT" | grep -qE '^VERDICT: FAIL[[:space:]]*$'; then VERDICT="FAIL"
  elif echo "$REVIEW_TEXT" | grep -qE '^VERDICT: SPEC[[:space:]]*$'; then VERDICT="SPEC"
  else VERDICT="UNPARSEABLE"; fi

  # ── verdict ────────────────────────────────────────────────────────────────
  #
  # The reviewer's line is one input. The machine may veto a PASS; it never
  # grants one, and it never touches SPEC (the story is wrong, not the build).
  #   baseline   test, build, lint all green
  #   coverage   every AC in the story has at least one mutation
  #   D1         every mutation is RED — a survivor means the instrument is
  #              absent or the mutation is wrong, and either needs a human
  MODEL_VERDICT="$VERDICT"
  MACHINE_REASONS=""
  [[ "$BASE_TEST"  == GREEN ]] || MACHINE_REASONS+="baseline test $BASE_TEST; "
  [[ "$BASE_BUILD" == GREEN ]] || MACHINE_REASONS+="baseline build $BASE_BUILD; "
  [[ "$BASE_LINT"  == GREEN ]] || MACHINE_REASONS+="baseline lint $BASE_LINT; "
  for ac in $AC_IDS; do
    grep -q "^$ac " <<< "$MUT_ROWS" || MACHINE_REASONS+="$ac has no mutation; "
  done
  while read -r ac cls slug; do
    [[ -n "$ac" && "$cls" != RED ]] && MACHINE_REASONS+="$ac $slug $cls; "
  done <<< "$MUT_ROWS"
  if [[ -n "$MACHINE_REASONS" && "$VERDICT" == "PASS" ]]; then
    VERDICT="FAIL"
    warn "machine veto: $MACHINE_REASONS"
  fi


  cat >> "$REVIEW_FILE.new" <<EOF

## Round $ROUND — $VERDICT

head: $HEAD_SHA
commits this round: $ROUND_COMMITS
reviewed: $(date -Iseconds)

### Machine

baseline: test $BASE_TEST | build $BASE_BUILD | lint $BASE_LINT
acs:      $AC_IDS
model:    $MODEL_VERDICT
computed: $VERDICT${MACHINE_REASONS:+ — $MACHINE_REASONS}
${MUT_TABLE:+mutations:
$MUT_TABLE}

### Builder said

$BUILD_MSG

### Reviewer

$REVIEW_TEXT
EOF

  # What the next round's builder reads is the review so far — Machine block
  # and prose — exactly what a restart reloads from the file. One path.
  REVIEW_TEXT="$(cat "$REVIEW_FILE.new")"

  if [[ "$VERDICT" == "PASS" ]]; then
    log "round $ROUND: PASS"
    break
  fi

  # A spec defect cannot be fixed by another build round. Stop the rounds; the
  # outcome block sends it to needs_human with the reviewer's reasoning intact.
  if [[ "$VERDICT" == "SPEC" ]]; then
    warn "round $ROUND: SPEC — the story is wrong, not the build"
    break
  fi

  warn "round $ROUND: $VERDICT"
  (( ROUND < MAX_ROUNDS )) && log "re-running builder with the findings"
done

# ── outcome ──────────────────────────────────────────────────────────────────

{
  echo "# Review: $STORY_ID"
  echo
  echo "verdict: $VERDICT"
  echo "rounds: $ROUND of $MAX_ROUNDS"
  echo "base: $BASE_SHA"
  cat "$REVIEW_FILE.new"
} > "$REVIEW_FILE"
rm -f "$REVIEW_FILE.new"

if [[ "$VERDICT" == "PASS" ]]; then
  set_status "$STORY_ID" done
  log "VERDICT: PASS after $ROUND round(s) → $REVIEW_FILE"
elif [[ "$VERDICT" == "SPEC" ]]; then
  set_status "$STORY_ID" needs_human
  warn "SPEC defect on round $ROUND — the story needs rewriting → $REVIEW_FILE"
  warn "this story is stopped. The queue is not."
else
  set_status "$STORY_ID" needs_human
  warn "ceiling reached: $MAX_ROUNDS rounds, last verdict $VERDICT → $REVIEW_FILE"
  warn "this story is stopped. The queue is not."
fi

jq -n --arg s "$STORY_ID" --arg v "$VERDICT" --arg r "$ROUND" \
  '{story:$s,verdict:$v,rounds:($r|tonumber)}' > "$RUN_FILE"

echo
echo "branch $BRANCH, worktree $BUILDER_WT"
echo "when finished: git worktree remove $BUILDER_WT"
