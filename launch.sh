#!/usr/bin/env bash
#
# fleet/launch.sh [story-id]
#
# Phase 4b + verdict runner: queue, orphan recovery, review round ceiling,
# harness-run baseline and mutations, computed verdict.
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
# PROMPTS live in fleet/prompts/*.md, rendered by fleet/render.sh.
#
# VERDICT is computed here, not read from the reviewer. The reviewer proposes
# mutations as files; this script runs the baseline, applies each mutation in
# a clean tree, classifies, and vetoes a PASS on any surviving mutation, any
# uncovered AC, or a red baseline. Evidence goes to .review/<id>/round-N/ and
# is committed. See fleet/prompts/README.md, "The verdict contract".
# fleet/test-lib.sh exercises every path with fake agents.
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
REVIEW_ONLY="${REVIEW_ONLY:-0}"      # 1 = re-review the head, run no builder
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

# ── scope ────────────────────────────────────────────────────────────────────
#
# The story's `scope_deny:` frontmatter — space-separated bash globs — names
# files the builder must not touch. Deny-only, by decision: no allow list,
# so the builder is free anywhere not named and the story stays WHAT, not
# HOW. No line means nothing is forbidden. A hit is a machine veto; the
# builder's correct move when it needs a denied file is .blocked/, which
# build-round2.md already says and this now enforces. Two paths the rules
# themselves require are always allowed, so a broad deny cannot punish a
# builder for following RULES.

check_scope() {                       # check_scope <evidence-dir> → SCOPE SCOPE_HITS
  local ev="$1" deny changed f g
  local -a globs=()
  deny="$(story_field "$STORY_ID" scope_deny)"
  changed="$(git -C "$BUILDER_WT" diff --name-only "$BASE_SHA..$HEAD_SHA")"
  # Split the deny list with pathname expansion OFF: a bare `for g in $deny`
  # expands `fleet/*` against the launcher's cwd and the glob never reaches
  # the comparison. Found by test-lib case 28. Inside [[ ]] the unquoted
  # right-hand side is a pattern, not a path.
  set -f; read -ra globs <<< "$deny"; set +f
  SCOPE_HITS=""
  if (( ${#globs[@]} )); then
    while read -r f; do
      [[ -n "$f" ]] || continue
      [[ "$f" == ".blocked/$STORY_ID.md" || "$f" == ".stories/$STORY_ID.md" || "$f" == docs/fleet/$STORY_ID-*.md ]] && continue
      for g in "${globs[@]}"; do
        [[ "$f" == $g ]] && { SCOPE_HITS+="$f "; break; }
      done
    done <<< "$changed"
  fi
  [[ -n "$SCOPE_HITS" ]] && SCOPE=VIOLATION || SCOPE=CLEAN
  {
    echo "deny:    ${deny:-<none>}"
    echo "scope:   $SCOPE ${SCOPE_HITS}"
    echo "changed:"; printf '%s\n' "$changed"
  } > "$ev/scope.txt"
  log "scope: $SCOPE ${SCOPE_HITS}"
}

# ── probes ───────────────────────────────────────────────────────────────────
#
# A probe is a test the reviewer constructs to hunt a regression no existing
# test covers — 004's reverse-race, 006's cache→empty→populated. They used to
# be written to /tmp and lost with the worktree. Now they are run against the
# tree as it stands (no patch), committed, and a RED one vetoes: either a real
# regression, or a wrong probe, and both need a human. Probes are OPTIONAL —
# requiring "at least one" is a check that cannot go red, since a vacuous probe
# satisfies it, so zero probes is not a finding.
#
# A probe must land inside vitest's include glob or it collects no tests; it is
# copied into src/__tests__/ under a fleet- prefix, run, then removed.

run_probes() {                        # run_probes <wt> <evidence-dir> → PROBE_ROWS
  local wt="$1" pdir="$2/probes" p name dest cls raw
  PROBE_ROWS=""
  [[ -d "$pdir" ]] || return 0

  for p in "$pdir"/*.test.tsx "$pdir"/*.test.ts; do
    [[ -e "$p" ]] || continue
    name="$(basename "$p")"
    dest="src/__tests__/fleet-probe-$name"
    raw="$REPO_ROOT/.runs/$STORY_ID-round$ROUND-probe-$name"

    [[ -z "$(porcelain "$wt")" ]] || die "probe runner: tree dirty before $name"
    cp "$p" "$wt/$dest"
    # run_selector reads its selector from a file; a probe's selector is just
    # the path it was copied to.
    printf '%s\n' "$dest" > "$raw.sel"
    cls="$(run_selector "$wt" test "$raw.sel" "$raw")"
    rm -f "$wt/$dest"
    [[ -z "$(porcelain "$wt")" ]] || die "probe runner: tree dirty after removing $name"

    printf '%s\n' "$cls" > "$pdir/$name.result"
    PROBE_ROWS+="$name $cls"$'\n'
    log "probe $name: $cls"
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

# Epics. A story may name the branch it is cut from, so one queue can serve
# several epics (epic/offline-pwa, epic/search, …) while the fleet's own state
# — .stories, .review, fleet/, docs/fleet — stays on the integration branch
# this checkout is on. BASE_BRANCH is the default for a story that names none.
STORY_BASE="$(story_field "$STORY_ID" base)"
STORY_BASE="${STORY_BASE:-$BASE_BRANCH}"
[[ "$STORY_BASE" == "$BASE_BRANCH" ]] || log "base: $STORY_BASE (from the story)"

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
# Rounds continue across reruns. A story sent back to ready after needs_human
# resumes at its recorded round, so its new evidence lands in a new
# round-N/ directory and the earlier rounds' sections stay in the review
# file — instead of a rerun clobbering round-1/. Found on 007's rerun.
ROUND_START="$(story_field "$STORY_ID" round)"
[[ "$ROUND_START" =~ ^[0-9]+$ ]] || ROUND_START=0
ROUND_CEILING=$(( ROUND_START + MAX_ROUNDS ))

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
    git -C "$REPO_ROOT" worktree add "$BUILDER_WT" -b "$BRANCH" "origin/$STORY_BASE" >/dev/null || die "worktree add failed"
  fi
  seed_env "$BUILDER_WT"
  log "installing deps"
  ( cd "$BUILDER_WT" && $INSTALL_CMD ) >/dev/null 2>&1 || warn "$INSTALL_CMD failed"
fi

# ── story sync ───────────────────────────────────────────────────────────────
#
# The builder reads the story from its worktree and the reviewer's tree is
# detached at the builder's head — both descend from the story branch. A
# story amended on the base after that branch was cut (a needs_human
# rewrite, the normal case) reached neither agent: 007 round 5 ran against
# the pre-amendment text. The base copy is the spec of record; it is synced
# into the worktree as a launcher commit before the round's start SHA is
# taken, so it is never counted as the builder's work. Frontmatter differs
# by design (status, round); only the body decides whether to sync.

story_body() { awk 'NR==1 && $0!="---" {p=1} /^---$/ {d++; next} d>=2 || p' "$1"; }

sync_story() {
  local wt_story="$BUILDER_WT/.stories/$STORY_ID.md"
  if [[ ! -f "$wt_story" ]] || ! diff -q <(story_body "$STORY_FILE") <(story_body "$wt_story") >/dev/null; then
    mkdir -p "$BUILDER_WT/.stories"
    cp "$STORY_FILE" "$wt_story"
    git -C "$BUILDER_WT" add ".stories/$STORY_ID.md"
    git -C "$BUILDER_WT" commit -q -m "story($STORY_ID): spec synced from $BASE_BRANCH" || die "story sync commit failed"
    log "story spec synced into the worktree (it had changed on $BASE_BRANCH)"
  fi
}
sync_story

BASE_SHA="$(git -C "$BUILDER_WT" merge-base HEAD "origin/$STORY_BASE")"
log "base ${BASE_SHA:0:8}"

# rules.md itself contains {{STORY_ID}}, so it is rendered first and then
# embedded as {{RULES}} by the build prompts.
RULES="$(render_prompt rules.md)"

# ── review rounds ────────────────────────────────────────────────────────────

if (( ROUND_START > 0 )) && [[ -f "$REVIEW_FILE" ]]; then
  awk '/^## Round /{p=1} p' "$REVIEW_FILE" > "$REVIEW_FILE.new"   # keep earlier rounds
else
  : > "$REVIEW_FILE.new"
fi
VERDICT=""
ROUND=$ROUND_START

while (( ROUND < ROUND_CEILING )); do
  ROUND=$(( ROUND + 1 ))
  set_story_field "$STORY_ID" round "$ROUND"
  log "round $ROUND of $ROUND_CEILING"

  ROUND_START_SHA="$(git -C "$BUILDER_WT" rev-parse HEAD)"
  EVIDENCE_DIR_PENDING="$REPO_ROOT/.review/$STORY_ID/round-$ROUND"
  mkdir -p "$EVIDENCE_DIR_PENDING"
  BUILDER_HANDED_OVER=""
  
  if (( ROUND == ROUND_START + 1 )) && [[ -z "$REVIEW_TEXT" ]]; then
    BUILD_PROMPT="$(render_prompt build-round1.md)"
  elif (( ROUND == ROUND_START + 1 )) && grep -qE '^verdict: SPEC' "$REVIEW_FILE" 2>/dev/null; then
    BUILD_PROMPT="$(render_prompt build-after-spec.md)"
  else
    BUILD_PROMPT="$(render_prompt build-round2.md)"
  fi

  # REVIEW_ONLY re-reviews the branch head with no builder round — the case a
  # story hits after needs_human when a human fixes the branch by hand. Until
  # this existed the only way to get a re-review was to let the builder make a
  # commit, because the postcondition below demands one.
  if [[ "$REVIEW_ONLY" == "1" ]]; then
    BUILD_ERR="skipped"
    BUILD_MSG="(REVIEW_ONLY: no builder ran this round; reviewing the existing head)"
    log "REVIEW_ONLY: skipping the builder"
  else
    log "builder: $BUILDER_MODEL"
    # Prompts go on stdin. A 134 KB round-2 prompt as one argv string exceeded
    # MAX_ARG_STRLEN (131072) on 007's rerun: claude never exec'd, output was
    # empty. stdin has no such limit, and for codex it is the intended mode.
    BUILD_OUT="$(cd "$BUILDER_WT" && printf '%s' "$BUILD_PROMPT" | claude -p \
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

    # RULES demand the builder observe its test fail before implementing.
    # That was a sentence in a commit message; now it is evidence the runner
    # applies. Same format as the reviewer's, slug-prefixed `tdd-` so the
    # producer is visible in the machine table. Copied before the reviewer
    # runs, into the same directory, so one runner judges both.
    if [[ -d "$BUILDER_WT/.review-out/mutations" ]]; then
      mkdir -p "$EVIDENCE_DIR_PENDING/mutations"
      cp -r "$BUILDER_WT/.review-out/mutations/." "$EVIDENCE_DIR_PENDING/mutations/"
      rm -rf "$BUILDER_WT/.review-out"
      BUILDER_HANDED_OVER=1
      log "builder handed over TDD evidence"
    fi
  fi

  HEAD_SHA="$(git -C "$BUILDER_WT" rev-parse HEAD)"
  ROUND_COMMITS="$(git -C "$BUILDER_WT" rev-list --count "$ROUND_START_SHA..$HEAD_SHA")"
  TOTAL_COMMITS="$(git -C "$BUILDER_WT" rev-list --count "$BASE_SHA..$HEAD_SHA")"

  # Postcondition, not self-report. Phase 2: is_error was false while the agent
  # did nothing at all.
  #
  # "Did nothing" is not the same as "committed nothing". Since 3.1 a builder
  # can be asked for evidence rather than code — story 010 round 2 was told its
  # TDD patches did not apply, regenerated them, and correctly changed no code.
  # That output lands in .review-out/, which is gitignored, so it can never be
  # a commit. A round is productive if it produced anything the harness can
  # judge; handed-over mutations are judged by the runner below exactly as
  # commits are judged by the reviewer. Nothing at all is still a die.
  if (( ROUND_COMMITS == 0 )) && [[ "$REVIEW_ONLY" != "1" ]] && [[ -z "$BUILDER_HANDED_OVER" ]]; then
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

  EVIDENCE_DIR="$EVIDENCE_DIR_PENDING"
  run_baseline "$REVIEWER_WT" "$EVIDENCE_DIR"
  check_scope "$EVIDENCE_DIR"

  REVIEW_PROMPT="$(render_prompt review.md)"

  # --sandbox danger-full-access: bwrap cannot create network namespaces on this
  # host (RTM_NEWADDR: Operation not permitted), so Codex's own sandbox fails to
  # start before it reads anything. Isolation comes from the detached worktree
  # and the unprivileged fleet user with no sudo — not from bwrap.
  log "reviewer: codex"
  # codex emits JSON Lines on stdout and notices on stderr — "Reading
  # additional input from stdin..." whenever stdin is not a TTY, i.e. every
  # unattended run. Merged with 2>&1, that one line made jq abort at line 1,
  # extraction came back empty, and the raw JSONL became REVIEW_TEXT: the
  # VERDICT line sat inside a JSON string, never at column 0 → UNPARSEABLE.
  # First real run of the runner, 17 Sep. stderr is kept as evidence, not
  # merged; the filter skips anything that is not JSON and takes only the
  # reviewer's own messages, not command_execution items.
  REVIEW_RAW="$(cd "$REVIEWER_WT" && printf '%s' "$REVIEW_PROMPT" | codex exec --json --sandbox danger-full-access 2> "$EVIDENCE_DIR/reviewer.stderr")"
  REVIEW_TEXT="$(printf '%s\n' "$REVIEW_RAW" | jq -R -r 'fromjson? | select(.type=="item.completed" and .item.type=="agent_message") | .item.text // empty')"
  if [[ -z "$REVIEW_TEXT" ]]; then
    # No reviewer message at all. Keep the raw stream where a human can read
    # it; the verdict path below classifies this as UNPARSEABLE on its own.
    printf '%s\n' "$REVIEW_RAW" > "$EVIDENCE_DIR/reviewer.raw.jsonl"
    warn "reviewer produced no agent_message — raw stream kept as reviewer.raw.jsonl"
    REVIEW_TEXT="(no reviewer message — see reviewer.raw.jsonl and reviewer.stderr)"
  fi


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
  if [[ -d "$REVIEWER_WT/.review-out/probes" ]]; then
    mkdir -p "$EVIDENCE_DIR/probes"
    cp -r "$REVIEWER_WT/.review-out/probes/." "$EVIDENCE_DIR/probes/"
  fi

  run_mutations "$REVIEWER_WT" "$EVIDENCE_DIR"
  run_probes "$REVIEWER_WT" "$EVIDENCE_DIR"
  MUT_TABLE="$(printf '%s' "$MUT_ROWS" | awk 'NF { printf "%-4s %-13s %s\n", $1, $2, $3 }')"
  PROBE_TABLE="$(printf '%s' "$PROBE_ROWS" | awk 'NF { printf "%-13s %s\n", $2, $1 }')"

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
  [[ "$SCOPE" == CLEAN ]] || MACHINE_REASONS+="scope $SCOPE: ${SCOPE_HITS}; "
  for ac in $AC_IDS; do
    grep -q "^$ac " <<< "$MUT_ROWS" || MACHINE_REASONS+="$ac has no mutation; "
  done
  while read -r ac cls slug; do
    [[ -n "$ac" && "$cls" != RED ]] && MACHINE_REASONS+="$ac $slug $cls; "
  done <<< "$MUT_ROWS"
  # A probe is the inverse of a mutation: RED means it FOUND something.
  while read -r pname pcls; do
    [[ -n "$pname" && "$pcls" == RED ]] && MACHINE_REASONS+="probe $pname RED; "
  done <<< "$PROBE_ROWS"
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
scope:    $SCOPE${SCOPE_HITS:+ $SCOPE_HITS}
model:    $MODEL_VERDICT
computed: $VERDICT${MACHINE_REASONS:+ — $MACHINE_REASONS}
${MUT_TABLE:+mutations:
$MUT_TABLE
}${PROBE_TABLE:+probes:
$PROBE_TABLE}

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
  (( ROUND < ROUND_CEILING )) && log "re-running builder with the findings"
done

# ── outcome ──────────────────────────────────────────────────────────────────

{
  echo "# Review: $STORY_ID"
  echo
  echo "verdict: $VERDICT"
  echo "rounds: $ROUND of $ROUND_CEILING"
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
