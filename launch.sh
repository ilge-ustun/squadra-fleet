#!/usr/bin/env bash
#
# launch.sh <repo> [story-id|--reap]
#
# Phase 4b + verdict runner: queue, orphan recovery, review round ceiling,
# harness-run baseline and mutations, computed verdict.
#
#   launch.sh khaita           take the next ready story of the repo `khaita`
#   launch.sh khaita 004       run one specific story
#   launch.sh khaita --reap    reap orphans and exit
#
# The repo is a name in repos/ (lib.sh: load_repo); how it is built and tested
# comes from its own .fleet/config. Nothing here assumes the cwd.
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
# PROMPTS live in prompts/*.md, rendered by render.sh.
#
# VERDICT is computed here, not read from the reviewer. The reviewer proposes
# mutations as files; this script runs the baseline, applies each mutation in
# a clean tree, classifies, and vetoes a PASS on any surviving mutation, any
# uncovered AC, or a red baseline. Evidence goes to .review/<id>/round-N/ and
# is committed. See prompts/README.md, "The verdict contract".
# test-lib.sh exercises every path with fake agents.
#
set -uo pipefail

# ── config ───────────────────────────────────────────────────────────────────

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }

# The target is named, never assumed from the cwd. load_repo brings REPO_ROOT
# and the target's own BASE_BRANCH (the integration branch; a story may name
# an epic with base:), INSTALL_CMD, VITEST_CMD, BUILD_CMD, LINT_CMD,
# SEED_FILES and PROBE_DIR from <target>/.fleet/config.
[[ $# -ge 1 ]] || die "usage: launch.sh <repo> [story-id|--reap]"
load_repo "$1"; shift

BUILDER_MODEL="${BUILDER_MODEL:-claude-sonnet-4-6}"
# Empty: codex runs on its own configured default. Named: `codex exec -m`.
# A quota outage on one model stranded every story until this existed.
REVIEWER_MODEL="${REVIEWER_MODEL:-}"
MAX_TURNS="${MAX_TURNS:-60}"
# Wall clock per agent call. MAX_TURNS bounds the builder's turns, nothing
# bounded its time: unattended, a hung agent is indistinguishable from a slow
# one and blocks the queue for ever. -k gives it 30s to die politely before
# KILL. Children may outlive it (L-04); the next run's procs_in_worktree sees
# them and refuses to start, which is the right answer.
AGENT_TIMEOUT="${AGENT_TIMEOUT:-1800}"
MAX_ROUNDS="${MAX_ROUNDS:-2}"        # escalation ceiling
ALLOWED_TOOLS="Read,Write,Edit,Grep,Glob,Bash"
PUSH_STATUS="${PUSH_STATUS:-1}"      # PUSH_STATUS=0 to work offline
REVIEW_ONLY="${REVIEW_ONLY:-0}"      # 1 = re-review the head, run no builder

# render_prompt() — needs die/warn and PROMPTS_DIR from lib.sh.
source "$FLEET_HOME/render.sh" || die "cannot source render.sh"
# porcelain, run_selector, classify_mutation — the verdict's classifier.
source "$FLEET_HOME/mutation.sh" || die "cannot source mutation.sh"

command -v claude >/dev/null || die "claude not on PATH"
command -v codex  >/dev/null || die "codex not on PATH"
command -v jq     >/dev/null || die "jq not on PATH"
mkdir -p "$REPO_ROOT/.stories" "$REPO_ROOT/.review" "$REPO_ROOT/.runs" "$REPO_ROOT/.blocked"

# ── status ───────────────────────────────────────────────────────────────────

# git add fails ENTIRELY if any one pathspec is missing — it stages nothing and
# exits 128. Adding all three at once silently dropped every status commit
# whenever .blocked/<id>.md did not exist. Add each path separately.
commit_status() {                     # commit_status <id> <status>
  local id="$1" st="$2" p
  # The Telegram bot writes .stories/<id>.md and commits in this same checkout
  # on its own timer. Two writers, one index: the loser gets "Unable to create
  # .git/index.lock", and a failed status commit is a die, so the loser is a
  # dead round. Both take the same advisory lock — telegram.sh has the
  # matching with_lock.
  exec 9>"$REPO_ROOT/.git/fleet.lock"
  flock -w "${FLEET_LOCK_WAIT:-120}" 9 || warn "waited for the fleet lock — going ahead"
  for p in ".stories/$id.md" ".review/$id.md" ".blocked/$id.md"; do
    [[ -f "$REPO_ROOT/$p" ]] && git -C "$REPO_ROOT" add "$p"
  done
  # Evidence directory: baseline results now, mutations later. A directory,
  # so guarded separately from the files above (same L-02 reasoning).
  [[ -d "$REPO_ROOT/.review/$id" ]] && git -C "$REPO_ROOT" add ".review/$id"
  git -C "$REPO_ROOT" diff --cached --quiet && { flock -u 9; return 0; }
  # Nothing staged returned above, so a failure here is a real one: a hook, a
  # lock, a broken identity. Continuing would run the story on with its state
  # only in the working tree — invisible to status.sh, to the queue, and to a
  # resumed run after a crash, which is the state the whole design leans on.
  git -C "$REPO_ROOT" commit -q -m "story($id): $st" || die "status commit failed for $id ($st)"
  if [[ "$PUSH_STATUS" == "1" ]]; then
    git -C "$REPO_ROOT" push -q 2>/dev/null || warn "status push failed — queue not visible remotely"
  fi
  flock -u 9
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
# The reviewer proposes mutations as files; the harness runs them. The
# classifier itself — pre-run, apply, run, restore, and the classes — lives in
# mutation.sh, shared with check-mutation.sh so a builder can run the same
# judgment on its own evidence before the verdict does.

run_mutations() {                     # run_mutations <wt> <evidence-dir> → MUT_ROWS (one "ACn CLASS slug" per line)
  local wt="$1" mdir="$2/mutations" p name ac slug kind cls raw
  MUT_ROWS=""
  [[ -d "$mdir" ]] || return 0

  for p in "$mdir"/AC*-*.patch; do
    [[ -e "$p" ]] || continue
    name="$(basename "$p" .patch)"; ac="${name%%-*}"; slug="${name#*-}"
    raw="$REPO_ROOT/.runs/$STORY_ID-round$ROUND-$name"

    if find_selector "$p"; then
      kind="$SEL_KIND"
      classify_mutation "$wt" "$p" "$SEL_KIND" "$SEL_FILE" "$raw" checkout
      cls="$MUT_CLASS"
    else
      kind=""; cls=NO_SELECTOR
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
# builder for following RULES — and one is always denied: the harness sources
# .fleet/config, so a builder that could change it could change what runs.

check_scope() {                       # check_scope <evidence-dir> → SCOPE SCOPE_HITS
  local ev="$1" deny changed f g   # changed: CHANGED_PATHS, computed once before the baseline
  local -a globs=()
  deny="$(story_field "$STORY_ID" scope_deny)"
  changed="$CHANGED_PATHS"
  # Split the deny list with pathname expansion OFF: a bare `for g in $deny`
  # expands `src/*` against the launcher's cwd and the glob never reaches
  # the comparison. Found by test-lib case 28. Inside [[ ]] the unquoted
  # right-hand side is a pattern, not a path.
  set -f; read -ra globs <<< "$deny"; set +f
  SCOPE_HITS=""
  while read -r f; do
    [[ -n "$f" ]] || continue
    [[ "$f" == ".blocked/$STORY_ID.md" || "$f" == ".stories/$STORY_ID.md" ]] && continue
    [[ "$f" == .fleet/* ]] && { SCOPE_HITS+="$f "; continue; }
    for g in "${globs[@]}"; do
      [[ "$f" == $g ]] && { SCOPE_HITS+="$f "; break; }
    done
  done <<< "$changed"
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
# A probe must land inside the test runner's include glob or it collects no
# tests; where that is comes from the target (PROBE_DIR in .fleet/config). It
# is copied there under a fleet- prefix, run, then removed.

run_probes() {                        # run_probes <wt> <evidence-dir> → PROBE_ROWS
  local wt="$1" pdir="$2/probes" p name dest cls raw
  PROBE_ROWS=""
  [[ -d "$pdir" ]] || return 0

  for p in "$pdir"/*.test.tsx "$pdir"/*.test.ts; do
    [[ -e "$p" ]] || continue
    name="$(basename "$p")"
    [[ -d "$wt/$PROBE_DIR" ]] || die "probe runner: PROBE_DIR $PROBE_DIR does not exist in the worktree — a probe copied there would silently never run"
    dest="$PROBE_DIR/fleet-probe-$name"
    raw="$REPO_ROOT/.runs/$STORY_ID-round$ROUND-probe-$name"

    [[ -z "$(porcelain "$wt")" ]] || die "probe runner: tree dirty before $name"
    cp "$p" "$wt/$dest"
    # run_selector reads its selector from a file; a probe's selector is just
    # the path it was copied to.
    printf '%s\n' "$dest" > "$raw.sel"
    # The status matters: a runner that could not start gives no class, and
    # an empty class is neither RED nor GREEN — it would veto nothing (107).
    cls="$(run_selector "$wt" test "$raw.sel" "$raw")" || die "probe runner: $name — the runner failed; its message is above"
    case "$cls" in RED|GREEN|NO_TESTS) ;; *) die "probe runner: $name — not a class: '$cls'" ;; esac
    rm -f "$wt/$dest"
    [[ -z "$(porcelain "$wt")" ]] || die "probe runner: tree dirty after removing $name"

    printf '%s\n' "$cls" > "$pdir/$name.result"
    PROBE_ROWS+="$name $cls"$'\n'
    log "probe $name: $cls"
  done
}

# A notification can never change what happened: it cannot fail a run, and a
# notifier that is unconfigured or unreachable is its own business.
notify() { $FLEET_NOTIFY_CMD "$1" >/dev/null 2>&1 || true; }

set_status() {                        # set_status <id> <status>
  set_story_field "$1" status "$2"
  commit_status "$1" "$2"
  # Here rather than at each exit: there are five paths to needs_human today
  # and the sixth would have been added without a notification. `done` is not
  # announced here — merging is the queue's news, and saying it twice is how
  # a channel stops being read.
  case "$2" in
    needs_human) notify "$1 needs_human — $(awk -F' — ' '/^computed:/ {r=$2} END{print r}' "$REPO_ROOT/.review/$1.md" 2>/dev/null | sed 's/[; ]*$//')
why: /why $1" ;;
    blocked)     notify "$1 is blocked and asked a question:
$(head -c 600 "$REPO_ROOT/.blocked/$1.md" 2>/dev/null)
answer with: /answer $1 <your answer>" ;;
  esac
}

# ── worktree occupancy ───────────────────────────────────────────────────────
#
# Found by cwd, not command line. pgrep -f does not work: the builder is started
# with `cd $WT && claude ...`, so the path never appears in any child's argv —
# only in its cwd. Verified: pgrep found nothing, /proc scan found the process.
# Killing the launcher leaves claude and its children alive, so a dead launcher
# pid is not evidence that work stopped (procs_in_worktree, lib.sh).

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

# Untracked runtime config a fresh worktree does not inherit — which files is
# the target's knowledge, SEED_FILES in its .fleet/config. Story 002: without
# .env.local khaita builds and tests green while talking to projects/undefined,
# and no instrument in its suite catches that.
seed_env() {
  local target="$1" f
  for f in "${SEED_FILES_ARR[@]}"; do
    if [[ -f "$REPO_ROOT/$f" ]]; then
      cp "$REPO_ROOT/$f" "$target/$f"
    else
      # A seed file is what makes the worktree behave like production — today
      # .env.local, the Firebase config. Without it the agent works in a tree
      # where the app cannot reach Firestore, and every result is about that
      # rather than about the story. This warning produced bug #1.
      die "$f is missing from $REPO_ROOT — the worktree would not behave like production"
    fi
  done
}

# ── main ─────────────────────────────────────────────────────────────────────

reap_orphans

# Reaping is what makes a crash recoverable: a story left `in_progress` by a
# power cut is invisible to any scan for `ready`. run-queue.sh calls this
# once before it looks at the queue, because otherwise it would report the
# queue empty while a stranded story sat there for ever.
[[ "${1:-}" == "--reap" ]] && exit 0

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
# several epics (epic/offline-pwa, epic/search, …) while the fleet's state in
# the target — .stories, .review — stays on its integration branch.
# BASE_BRANCH is the default for a story that names none.
STORY_BASE="$(story_field "$STORY_ID" base)"
STORY_BASE="${STORY_BASE:-$BASE_BRANCH}"
[[ "$STORY_BASE" == "$BASE_BRANCH" ]] || log "base: $STORY_BASE (from the story)"

# A story may also name the model that builds it. One line of CSS and a
# service-worker rewrite were costing the same; this is the whole of the fix,
# because story_field and the BUILDER_MODEL seam both already existed.
STORY_MODEL="$(story_field "$STORY_ID" model)"
if [[ -n "$STORY_MODEL" ]]; then
  BUILDER_MODEL="$STORY_MODEL"
  log "model: $BUILDER_MODEL (from the story)"
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
  # A failed install leaves node_modules stale or absent, and the baseline then
  # measures the install rather than the story. Output kept: a step that can
  # fail meaningfully must not have its stderr thrown away.
  mkdir -p "$REPO_ROOT/.runs"
  ( cd "$BUILDER_WT" && $INSTALL_CMD ) > "$REPO_ROOT/.runs/$STORY_ID-install-builder.log" 2>&1 \
    || die "install failed in the builder tree ($INSTALL_CMD) — see .runs/$STORY_ID-install-builder.log"
fi


BASE_SHA="$(git -C "$BUILDER_WT" merge-base HEAD "origin/$STORY_BASE")"
log "base ${BASE_SHA:0:8}"

# rules.md itself contains {{STORY_ID}}, so it is rendered first and then
# embedded as {{RULES}} by the build prompts.
# The story reaches both agents in their prompt, not as a file in the worktree.
# A worktree is cut from an epic branch and the reviewer's tree is detached at
# the builder's head, so neither sees a story amended on the integration branch
# afterwards (L-19). Syncing the file in fixed that but committed fleet state
# onto every story branch, which then conflicted at merge on 007, 008 and 010.
# Embedding closes both: nothing to sync, nothing to conflict.
STORY_TEXT="$(cat "$STORY_FILE")"

# A target may add rules of its own — khaita's "no firebase commands" — as a
# markdown snippet named by REPO_RULES in its .fleet/config, rendered into
# rules.md as {{REPO_RULES}}. Read from the checkout, not the worktree: the
# rules are the target's, not the branch's. Empty is legal; unreadable is not.
REPO_RULES_TEXT=""
if [[ -n "${REPO_RULES:-}" ]]; then
  REPO_RULES_TEXT="$(cat "$REPO_ROOT/$REPO_RULES")" || die "REPO_RULES $REPO_RULES is not readable in $REPO_ROOT"
fi

CHECK_MUTATION="bash $FLEET_HOME/check-mutation.sh $REPO_NAME"   # {{CHECK_MUTATION}} in rules.md
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
  # What the round costs. Nothing recorded it, so "is a second lane worth it"
  # and "is a bigger model worth it here" had no evidence either way. SECONDS
  # is bash's own counter; the agents' JSON carries more (turns, and whatever
  # the CLI reports) and is now kept whole rather than reduced to .result.
  T_ROUND=$SECONDS; T_BUILD=0; T_REVIEW=0; T_BASE=0; T_MUT=0
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
    T0=$SECONDS
    # Prompts go on stdin. A 134 KB round-2 prompt as one argv string exceeded
    # MAX_ARG_STRLEN (131072) on 007's rerun: claude never exec'd, output was
    # empty. stdin has no such limit, and for codex it is the intended mode.
    BUILD_OUT="$(cd "$BUILDER_WT" && printf '%s' "$BUILD_PROMPT" \
      | timeout -k 30 "$AGENT_TIMEOUT" claude -p \
      --model "$BUILDER_MODEL" --max-turns "$MAX_TURNS" \
      --allowedTools "$ALLOWED_TOOLS" --output-format json 2>&1)"
    BUILD_RC=$?
    T_BUILD=$(( SECONDS - T0 ))
    if (( BUILD_RC == 124 )); then
      set_status "$STORY_ID" needs_human
      die "round $ROUND: the builder exceeded AGENT_TIMEOUT (${AGENT_TIMEOUT}s) and was killed"
    fi

    # jq's // is the ALTERNATIVE operator: it fires on null AND on false, so
    # `.is_error // "parse-failed"` rewrote every SUCCESSFUL run as parse-failed.
    # has() tests for the key, not its truthiness.
    BUILD_ERR="$(echo "$BUILD_OUT" | jq -r 'if has("is_error") then (.is_error|tostring) else "parse-failed" end' 2>/dev/null)"
    BUILD_MSG="$(echo "$BUILD_OUT" | jq -r '.result // "no result field"' 2>/dev/null)"
    # The whole object, not just the two fields the launcher reads. Whatever
    # the CLI reports about cost and duration is in there, and a field that is
    # thrown away cannot be asked about later.
    printf '%s\n' "$BUILD_OUT" | jq . > "$EVIDENCE_DIR_PENDING/builder.json" 2>/dev/null \
      || printf '%s\n' "$BUILD_OUT" > "$EVIDENCE_DIR_PENDING/builder.json"

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
  ( cd "$REVIEWER_WT" && $INSTALL_CMD ) > "$REPO_ROOT/.runs/$STORY_ID-install-reviewer.log" 2>&1 \
    || die "install failed in the reviewer tree ($INSTALL_CMD) — see .runs/$STORY_ID-install-reviewer.log"

  EVIDENCE_DIR="$EVIDENCE_DIR_PENDING"
  # What this round changed, computed once: the baseline needs it to decide
  # whether to run the harness's own suite, and check_scope to judge the deny
  # list. Two readings of the same diff could disagree; one cannot.
  CHANGED_PATHS="$(git -C "$BUILDER_WT" diff --name-only "$BASE_SHA..$HEAD_SHA")"
  T0=$SECONDS
  run_baseline "$REVIEWER_WT" "$EVIDENCE_DIR"
  check_scope "$EVIDENCE_DIR"
  T_BASE=$(( SECONDS - T0 ))

  REVIEW_PROMPT="$(render_prompt review.md)"

  # --sandbox danger-full-access: bwrap cannot create network namespaces on this
  # host (RTM_NEWADDR: Operation not permitted), so Codex's own sandbox fails to
  # start before it reads anything. Isolation comes from the detached worktree
  # and the unprivileged fleet user with no sudo — not from bwrap.
  log "reviewer: codex${REVIEWER_MODEL:+ $REVIEWER_MODEL}"
  T0=$SECONDS
  # codex emits JSON Lines on stdout and notices on stderr — "Reading
  # additional input from stdin..." whenever stdin is not a TTY, i.e. every
  # unattended run. Merged with 2>&1, that one line made jq abort at line 1,
  # extraction came back empty, and the raw JSONL became REVIEW_TEXT: the
  # VERDICT line sat inside a JSON string, never at column 0 → UNPARSEABLE.
  # First real run of the runner, 17 Sep. stderr is kept as evidence, not
  # merged; the filter skips anything that is not JSON and takes only the
  # reviewer's own messages, not command_execution items.
  REVIEWER_ARGS=(); [[ -n "$REVIEWER_MODEL" ]] && REVIEWER_ARGS=(-m "$REVIEWER_MODEL")
  REVIEW_RAW="$(cd "$REVIEWER_WT" && printf '%s' "$REVIEW_PROMPT" \
    | timeout -k 30 "$AGENT_TIMEOUT" codex exec --json --sandbox danger-full-access "${REVIEWER_ARGS[@]}" 2> "$EVIDENCE_DIR/reviewer.stderr")"
  REVIEW_RC=$?
  T_REVIEW=$(( SECONDS - T0 ))
  if (( REVIEW_RC == 124 )); then
    set_status "$STORY_ID" needs_human
    die "round $ROUND: the reviewer exceeded AGENT_TIMEOUT (${AGENT_TIMEOUT}s) and was killed"
  fi
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

  T0=$SECONDS
  run_mutations "$REVIEWER_WT" "$EVIDENCE_DIR"
  run_probes "$REVIEWER_WT" "$EVIDENCE_DIR"
  T_MUT=$(( SECONDS - T0 ))
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
timing:   builder ${T_BUILD}s | baseline ${T_BASE}s | reviewer ${T_REVIEW}s | mutations ${T_MUT}s | total $(( SECONDS - T_ROUND ))s
builder:  $BUILDER_MODEL
reviewer: codex${REVIEWER_MODEL:+ $REVIEWER_MODEL}
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
