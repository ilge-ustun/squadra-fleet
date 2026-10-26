#!/usr/bin/env bash
#
# test/suite.sh — tests for the fleet's commands, with fake agents.
#
#   bash test/suite.sh              run every case
#   bash test/suite.sh blocked      run cases whose name contains "blocked"
#
# No network, no npm, no models. Each case gets a fresh fixture:
#
#   $TMP/<case>/fleet        THIS working tree, copied — the fleet under test is
#                            the one on disk, not the one at HEAD — with a
#                            registry of one entry, `t`, pointing at repo/
#   $TMP/<case>/origin.git   a bare repo — the target's `origin`
#   $TMP/<case>/repo         a synthetic target on branch `base`: src/marker.txt
#                            (the file the fakes mutate), .fleet/config naming
#                            the fakes, one fixture story, a .stories/TEMPLATE.md
#   $TMP/<case>/trace        what the fakes recorded
#
# Every script is run from $TMP/<case>, never from inside the target: a script
# that still depends on its cwd being the repo fails here.
#
# test/fakes/{claude,codex,npm} are put first on PATH; the launcher resolves
# `claude` and `codex` by bare name (`command -v` in ts/src/bin/launch.ts,
# and the calls in ts/src/lib/agents.ts), so no launcher change is needed
# for the substitution. Worktrees land as $TMP/<case>/wt-<id>, siblings of
# repo/, exactly as in production (launch.ts: `${root}/../wt-${storyId}`).
# test/fakes/{systemd-run,systemctl} stand in for the human's user manager
# the same way: a detached bot job and a test deploy's server are units of
# their own there, and a real one started from a fixture would be a real
# unit — the live test deploy stopped by a suite run.
#
# Observing red. Most cases characterise behaviour the scripts already have,
# so "see it fail first" means: run the case against a copy with the named
# block deleted. FLEET_LIB_OVERRIDE=<file> substitutes that copy into the
# fixture; FLEET_TS_OVERRIDE=<dir> lays a directory over ts/src/, and a case
# may write a stub straight into the fixture's ts/src/lib/ after `fixture`
# (cases 106-110, 113). The real scripts are never modified. Each case's
# comment names the block whose deletion turns it red.
#
# Two guards, both learned the expensive way on the first run (17 Sep): the
# fakes were named fake-claude/fake-codex, so `claude` resolved to the REAL
# agent, which read the fixture story, ran this very script, and recursed
# three deep on real quota before being killed.
#   1. shadow_check — every fake must be what actually resolves, or we stop.
#   2. no nesting  — if FAKE_TRACE_DIR is already set we are inside a fixture;
#      a real agent got in. Stop, never fan out.
#
set -uo pipefail

if [[ -n "${FAKE_TRACE_DIR:-}" ]]; then
  echo "suite: FAKE_TRACE_DIR is set — refusing to run inside a fixture (nested invocation)" >&2
  exit 3
fi

# A clean environment, always (L-27). The fixtures assume the scripts'
# DEFAULTS; whatever the calling shell has exported — MAX_ROUNDS=1 from a
# hand-run round, say — would silently become the suite's configuration and
# turn correct cases into failures that look like findings. An allowlist,
# not a drop-list: a drop-list must grow with every new seam and the once it
# is forgotten the symptom is indistinguishable from a real failure. The
# three override seams are the red-observation mechanism and must survive.
if [[ -z "${FLEET_TEST_CLEAN:-}" ]]; then
  exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C.UTF-8}" \
       FLEET_LIB_OVERRIDE="${FLEET_LIB_OVERRIDE:-}" \
       FLEET_TS_OVERRIDE="${FLEET_TS_OVERRIDE:-}" \
       FLEET_TEST_CLEAN=1 bash "$0" "$@"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_HOME="$(dirname "$HERE")"       # the fleet under test is this working tree
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fleet-test.XXXXXX")"
trap 'api_stop; rm -rf "$TMP"' EXIT

ONLY="${1:-}"
STORY=900
PASSED=0; FAILED=0; CASE=""

# ── assertions ───────────────────────────────────────────────────────────────

ok()   { PASSED=$((PASSED + 1)); }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL  [%s] %s\n' "$CASE" "$1"; }

assert_eq()       { [[ "$1" == "$2" ]] && ok || fail "$3: expected '$2', got '$1'"; }
assert_grep()     { grep -qE -- "$1" "$2" 2>/dev/null && ok || fail "$3: expected /$1/ in ${2#$TMP/}"; }
assert_not_grep() { grep -qE -- "$1" "$2" 2>/dev/null && fail "$3: found /$1/ in ${2#$TMP/}" || ok; }
assert_contains() { [[ "$1" == *"$2"* ]] && ok || fail "$3: expected '$2' in: $1"; }
assert_file()     { [[ -f "$1" ]] && ok || fail "$2: missing ${1#$TMP/}"; }
assert_no_file()  { [[ -f "$1" ]] && fail "$2: unexpected ${1#$TMP/}" || ok; }
assert_not_contains() { [[ "$1" == *"$2"* ]] && fail "$3: unexpected '$2'" || ok; }

# ── fixture ──────────────────────────────────────────────────────────────────

shadow_check() {                      # shadow_check <fleet-copy> — die unless the fakes are what resolves
  local fleet="$1" name got
  for name in claude codex npm systemd-run systemctl cargo; do
    got="$(PATH="$fleet/test/fakes:$PATH" command -v "$name")"
    if [[ "$got" != "$fleet/test/fakes/$name" ]]; then
      echo "suite: '$name' resolves to '$got', not the fake — refusing to run the launcher" >&2
      exit 3
    fi
  done
}

# The fleet under test is a copy of a working tree, minus its git metadata,
# its real registry (a typo'd name in a case must never reach a real
# checkout), anything machine-local (.test-deploy.json names the real
# target's tree, which a case's --stop would remove), and ts/node_modules:
# the TypeScript side's devDependencies (tsc, vitest) are tens of megabytes
# that would be copied once per case, and nothing under ts/ may need them at
# run time — their absence in every fixture is what proves that.
copy_fleet() {                        # copy_fleet <src> <dst>
  mkdir -p "$2"
  tar -C "$1" --exclude=./.git --exclude=./repos --exclude=./ts/node_modules -cf - . | tar -C "$2" -xf -
  rm -rf "$2/.env.fleet" "$2/.bot-offset" "$2/.test-deploy.json" "$2/.test-deploy-waiting"
}

# The fake Telegram API. Node's fetch never looks at PATH, so no fake on PATH
# can stand in for it; the bot is pointed by TELEGRAM_API_BASE at
# test/fakes/telegram-api.mts on a loopback port instead. One server per
# fixture, started by the first bot call, stopped when the fixture goes: a
# detached /merge sends its result after the poll that started it has
# returned, and that late send must still find the recorder. It reads
# $FX/updates.json on every getUpdates — the file `update` writes — so a
# case may rewrite it between polls.
api_start() {                         # api_start → API_BASE
  if [[ ! -s "$TRACE/api-port" ]]; then
    ( cd "$FX" && exec node "$FLEET/test/fakes/telegram-api.mts" "$TRACE" "$FX/updates.json" ) &
    echo $! > "$FX/api.pid"
    local i=0
    until [[ -s "$TRACE/api-port" ]]; do
      (( i++ > 100 )) && { fail "the fake Telegram API did not start"; return 1; }
      sleep 0.05
    done
  fi
  API_BASE="http://127.0.0.1:$(cat "$TRACE/api-port")"
}
api_stop() {
  units_stop
  [[ -n "${FX:-}" && -f "$FX/api.pid" ]] || return 0
  kill "$(cat "$FX/api.pid")" 2>/dev/null; rm -f "$FX/api.pid"
}
# Whatever the fake systemd-run started in this fixture — a test deploy's
# server lives past the command that started it, as the real one does — goes
# with the fixture.
units_stop() {
  [[ -n "${TRACE:-}" && -d "$TRACE/units" ]] || return 0
  local f
  for f in "$TRACE"/units/*.pid; do
    [[ -f "$f" ]] || continue
    kill -KILL -- "-$(cat "$f")" 2>/dev/null; rm -f "$f"
  done
}
# What reached the API: one request per api-args-N, the URL then the decoded
# form fields, text= first on its line and a multi-line message's remaining
# lines as they are; api-calls has one `api <url>` line per request.
api_args()  { cat "$TRACE"/api-args-* 2>/dev/null; }
api_calls() { cat "$TRACE"/api-calls 2>/dev/null; }
api_clear() { rm -f "$TRACE"/api-args-*; }

fixture() {                           # fixture <case-name> [story-status] → FX FLEET REPO TRACE
  api_stop
  FX="$TMP/$1"; FLEET="$FX/fleet"; REPO="$FX/repo"; TRACE="$FX/trace"
  local status="${2:-ready}"
  mkdir -p "$TRACE"; : > "$TRACE/calls"

  # One registry entry, t, names the target below. The override seams put a
  # copy with a block deleted in place of a script (or, for TypeScript, lay a
  # directory over ts/src/) so a case can be observed red.
  copy_fleet "$FLEET_HOME" "$FLEET"
  [[ -n "${FLEET_LIB_OVERRIDE:-}" ]]    && cp "$FLEET_LIB_OVERRIDE"    "$FLEET/bin/lib.sh"
  [[ -n "${FLEET_TS_OVERRIDE:-}" ]]     && cp -r "$FLEET_TS_OVERRIDE/." "$FLEET/ts/src/"
  mkdir -p "$FLEET/repos"
  printf 'REPO_PATH=%s\n' "$REPO" > "$FLEET/repos/t.env"

  # A synthetic target, not a clone of anything real: a bare origin, a working
  # clone on `base`, a marker file for the fakes to mutate, and the fleet.
  git init -q --bare "$FX/origin.git"
  git -C "$FX/origin.git" symbolic-ref HEAD refs/heads/base   # a clone of it checks out base, quietly
  git init -q -b base "$REPO"
  git -C "$REPO" config user.name  fleet-test
  git -C "$REPO" config user.email fleet-test@localhost
  git -C "$REPO" remote add origin "$FX/origin.git"

  mkdir -p "$REPO/src" "$REPO/.stories" "$REPO/.fleet"
  printf 'the fake agents mutate this file\n' > "$REPO/src/marker.txt"
  # The target says how it is built and tested; here, with the fakes. A case
  # overrides a value by putting it in the environment (BUILD_CMD=false).
  cat > "$REPO/.fleet/config" <<EOF
BASE_BRANCH=base
INSTALL_CMD=true
VITEST_CMD=$FLEET/test/fakes/vitest
BUILD_CMD=true
LINT_CMD=true
SEED_FILES=.env.local
PROBE_DIR=src
EOF
  printf '# fixture target\n' > "$REPO/README.md"
  # .env.local is untracked in production because the target ignores .env*;
  # without this line seed_env would dirty every reviewer worktree.
  printf '.env.local\n.runs/\n.review-out/\n' > "$REPO/.gitignore"
  cat > "$REPO/.stories/TEMPLATE.md" <<'EOF'
---
status: draft
round: 0
---

# Story NNN: title

**AC1 — one bounded claim.** Goes red when removed.
EOF
  cat > "$REPO/.stories/$STORY.md" <<EOF
---
status: $status
round: 0
---

# Story 900: fixture story

**AC1 — the fixture has one criterion.** Goes red when removed.
EOF

  # SEED_FILES=(.env.local) and the launcher dies without it. Untracked here
  # too, so the fixture matches production rather than papering over it.
  printf 'FLEET_TEST=1\n' > "$REPO/.env.local"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "fixture: target + story $STORY"
  git -C "$REPO" push -q -u origin base

  shadow_check "$FLEET"
}

# One helper per script. Each runs from $FX, not the target, with the fakes
# first on PATH. The target's commands come from its .fleet/config; a case
# that needs one changed puts it in "$@", and env takes the last assignment,
# so the case's VAR=value wins over the defaults here — and, inside the
# script, over the config file.
FAKES() { printf '%s' "$FLEET/test/fakes:$PATH"; }
run() {                               # run <story-id> [VAR=value …] → LOG RC
  local id="$1"; shift
  LOG="$FX/launch.log"
  ( cd "$FX" && env PATH="$(FAKES)" \
      PUSH_STATUS=1 FAKE_MUTATIONS=patch FAKE_VITEST=marker FLEET_NOTIFY_CMD=true \
      FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID="$STORY" CODEX_HOME="$FX/codex-home" "$@" \
      bash "$FLEET/fleet" launch t "$id" ) > "$LOG" 2>&1
  RC=$?
}
queue() {                             # queue [VAR=value …] → $FX/queue.log QRC   (QUEUE_TARGET=--all for every repo)
  ( cd "$FX" && env PATH="$(FAKES)" \
      PUSH_STATUS=1 FAKE_MUTATIONS=patch FAKE_VITEST=marker FLEET_NOTIFY_CMD=true \
      FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID="$STORY" CODEX_HOME="$FX/codex-home" FLEET_CARGO_CACHE="$FX/cargo-cache" "$@" \
      bash "$FLEET/fleet" run-queue "${QUEUE_TARGET:-t}" ) > "$FX/queue.log" 2>&1
  QRC=$?
}
status_run() {                        # status_run [args…] → stdout
  ( cd "$FX" && bash "$FLEET/fleet" status t "$@" )
}
tracked() { git -C "$REPO" ls-tree -r HEAD --name-only; }

frontmatter() {                       # frontmatter <file> <key>
  awk -v k="$2" '/^---$/{d++; next} d==1 && $0 ~ "^"k":" {sub("^"k":[[:space:]]*",""); print; exit}' "$1"
}
field() {                             # field <key> → frontmatter value of the fixture story
  awk -v k="$1" '
    NR==1 && $0!="---" { exit }
    /^---$/ { if (++d==2) exit; next }
    d==1 && $0 ~ "^"k":" { sub("^"k":[[:space:]]*",""); print; exit }
  ' "$REPO/.stories/$STORY.md"
}
review_line() { sed -n "${1}p" "$REPO/.review/$STORY.md" 2>/dev/null; }
calls()       { grep -c "^$1\$" "$TRACE/calls"; }
arg_after()   { sed -n "/^$1\$/{n;p;q}" "$2"; }   # arg_after <flag> <args-trace> → the value given after it
set_ready()   { sed -i '0,/^status:.*/s//status: ready/' "$REPO/.stories/$STORY.md"; }

# A launcher in the background, for the cases about two at once. The same
# environment as run(), its own log; BG_PID is the launcher's node process
# itself (fleet execs node), so it is the pid the launch lock records.
launch_bg() {                         # launch_bg <tag> <story-id|--reap> [VAR=value …] → BG_PID, $FX/bg-<tag>.log
  local tag="$1" id="$2"; shift 2
  ( cd "$FX" && exec env PATH="$(FAKES)" \
      PUSH_STATUS=1 FAKE_MUTATIONS=patch FAKE_VITEST=marker FLEET_NOTIFY_CMD=true \
      FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID="$STORY" CODEX_HOME="$FX/codex-home" "$@" \
      bash "$FLEET/fleet" launch t "$id" ) > "$FX/bg-$tag.log" 2>&1 &
  BG_PID=$!
}
wait_for() {                          # wait_for <seconds> <command…> — poll until it succeeds; 1 if it never does
  local limit=$(( $1 * 20 )) i=0; shift
  until "$@"; do (( i++ >= limit )) && return 1; sleep 0.05; done
}
open_gate() { : > "$TRACE/gate-open"; }   # releases every FAKE_REVIEWER=gate reviewer

# The event log (lib/events.ts): <target>/.runs/events.jsonl. events_rows
# prints one line per event — `event pass name result` with `-` for what a
# line lacks — and, after them, `open <span>` for every span a run started
# and never ended, and `bad <line>` for a line that is not JSON or lacks a
# field every line carries.
events_rows() {                       # events_rows [file] → stdout
  node -e '
    const fs = require("fs");
    const open = new Map();
    for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      if (l === "") continue;
      let e;
      try { e = JSON.parse(l); } catch { console.log(`bad ${l}`); continue; }
      if (e.v !== 1 || !e.ts || !e.run_id || !e.repo || !e.pass || !e.event || e.source !== "log") console.log(`bad ${l}`);
      console.log([e.event, e.pass, e.name ?? "-", e.result ?? "-"].join(" "));
      const k = `${e.run_id} ${e.span}`;
      if (e.event === "start") open.set(k, e.span);
      if (e.event === "end") open.delete(k);
    }
    for (const span of open.values()) console.log(`open ${span}`);
  ' "${1:-$REPO/.runs/events.jsonl}"
}

# ── cases ────────────────────────────────────────────────────────────────────

# Red when the outcome block's `set_status "$STORY_ID" done` is deleted.
# Also carries the INSTALL_CMD seam: red while INSTALL_CMD is hardcoded,
# because the npm tripwire on PATH then gets called.
case_1_happy() {
  CASE="1 commit + PASS → done"; fixture c1
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" done "story status"
  assert_eq "$(review_line 3)" "verdict: PASS" ".review line 3"
  assert_not_grep '^npm ' "$TRACE/calls" "INSTALL_CMD seam — npm must not be reached"
  assert_eq "$(calls claude)" 1 "builder called once"
  assert_eq "$(calls codex)"  1 "reviewer called once"
  # Phase 1.2: the harness ran the baseline itself and committed the evidence.
  assert_grep 'baseline: test GREEN \| build GREEN \| lint GREEN' "$REPO/.review/$STORY.md" "machine block records a green baseline"
  assert_contains "$(tracked)" ".review/$STORY/round-1/baseline/test.summary.json" "baseline evidence committed"
  # Phase 1.5: PASS was computed, not just parsed — AC1's mutation went RED.
  assert_grep '^computed: PASS$' "$REPO/.review/$STORY.md" "computed PASS with no reasons"
  assert_grep '^AC1 +RED +marker' "$REPO/.review/$STORY.md" "the mutation that earned it"
  # Phase 1.7: the rendered review prompt carries the output contract. A text
  # check — weak, stated as such; the real check is a real story run.
  assert_grep '\.review-out/mutations/' "$TRACE/codex-prompt-1" "review prompt names the mutation dir"
  assert_grep 'regardless of your VERDICT line' "$TRACE/codex-prompt-1" "review prompt states the veto"
}

# Red when the no-commits postcondition (set_status needs_human; die) is deleted.
case_2_nocommit() {
  CASE="2 no commits → needs_human"; fixture c2
  run "$STORY" FAKE_BUILDER=nocommit FAKE_REVIEWER=PASS
  assert_eq "$RC" 1 "exit code (die)"
  assert_eq "$(field status)" needs_human "story status"
  assert_grep 'produced no commits' "$LOG" "reason in output"
  assert_eq "$(calls codex)" 0 "reviewer must not run"
}

# Red when the .blocked/ detection block is deleted.
case_3_blocked() {
  CASE="3 .blocked/ written → blocked"; fixture c3
  run "$STORY" FAKE_BUILDER=blocked FAKE_REVIEWER=PASS
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" blocked "story status"
  assert_file "$REPO/.blocked/$STORY.md" "question copied to the base repo"
  assert_grep 'BLOCKED' "$LOG" "announced"
  assert_eq "$(calls codex)" 0 "reviewer must not run"
  assert_no_file "$REPO/.review/$STORY.md" "no review written"
}

# Red when the prompt selection (round1 / after-spec / round2) is collapsed
# to always render build-round1.md.
case_4_fail_two_rounds() {
  CASE="4 FAIL → round 2 gets the findings"; fixture c4
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" needs_human "story status"
  assert_eq "$(review_line 3)" "verdict: FAIL" ".review line 3"
  assert_eq "$(review_line 4)" "rounds: 2 of 2" ".review line 4"
  assert_eq "$(calls claude)" 2 "builder called twice"
  assert_not_grep 'REJECTED' "$TRACE/claude-prompt-1" "round 1 prompt is the fresh build"
  assert_grep 'REJECTED' "$TRACE/claude-prompt-2" "round 2 prompt is the rejected build"
  assert_grep 'fake review, call 1' "$TRACE/claude-prompt-2" "round 1 findings reached round 2"
}

# L-05. Red when launch.ts stops reading reviewText from the file at startup:
# a restart after FAIL then renders the fresh-build prompt and the findings
# are lost.
case_5_restart_after_fail() {
  CASE="5 restart after FAIL resumes from findings"; fixture c5
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  assert_eq "$(calls claude)" 3 "builder called a third time"
  assert_grep 'REJECTED' "$TRACE/claude-prompt-3" "restart renders the rejected-build prompt"
  assert_grep 'prior failing review found' "$LOG" "launcher says so"
  # Rounds continue across reruns (found on 007's rerun): the third round is
  # round 3, its evidence lands in round-3/, round-1/ is not clobbered, and
  # the review file keeps every round's section. Red when ROUND restarts at 0.
  assert_eq "$(review_line 4)" "rounds: 3 of 3" "round numbering continues"
  assert_file "$REPO/.review/$STORY/round-3/reviewer.md" "round-3 evidence dir"
  assert_grep 'fake review, call 1' "$REPO/.review/$STORY/round-1/reviewer.md" "round-1 evidence not clobbered"
  assert_grep '^## Round 1 ' "$REPO/.review/$STORY.md" "review file keeps round 1"
  assert_grep '^## Round 3 ' "$REPO/.review/$STORY.md" "review file has round 3"
}

# Red when the UNPARSEABLE fallthrough is changed to any real verdict.
case_6_unparseable() {
  CASE="6 garbage verdict → UNPARSEABLE"; fixture c6
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=garbage
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" needs_human "story status"
  assert_eq "$(review_line 3)" "verdict: UNPARSEABLE" ".review line 3"
}

# L-02. Red when the per-path guarded `git add` loop is replaced by one
# `git add` of all three paths — .blocked/ is absent, so nothing stages and
# no status commit ever lands.
case_7_status_commits_land() {
  CASE="7 status commits land without .blocked/"; fixture c7
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  local subjects; subjects="$(git -C "$REPO" log --format=%s)"
  assert_contains "$subjects" "story($STORY): in_progress" "in_progress committed"
  assert_contains "$subjects" "story($STORY): done" "done committed"
  assert_contains "$(git -C "$FX/origin.git" log base --format=%s)" "story($STORY): done" "pushed to origin"
}

# L-03. Red when the jq `has("is_error")` guard reverts to `.is_error // …`:
# is_error:false then reads as parse-failed and the launcher warns "builder
# output was not JSON". (First version of this case grepped for the literal
# "parse-failed", which the launcher never prints on this path — the mutant
# survived. Instrument was absent, not weak.)
case_8_is_error_false() {
  CASE="8 is_error:false is not parse-failed"; fixture c8
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_not_grep 'builder output was not JSON' "$LOG" "no false parse failure"
  assert_grep 'fake builder did: commit' "$REPO/.review/$STORY.md" "builder result recorded"
}

# Red when the SPEC break is deleted (rounds continue) or when the
# after-spec prompt branch is deleted (rerun gets the round-2 prompt).
case_9_spec() {
  CASE="9 SPEC stops the rounds; rerun gets the after-spec prompt"; fixture c9
  # FAKE_VITEST=pass: the mutation survives (GREEN). Phase 1.5: a machine
  # veto must not touch SPEC — the story is wrong, not the build.
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=SPEC FAKE_VITEST=pass
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" needs_human "story status"
  assert_eq "$(review_line 3)" "verdict: SPEC" ".review line 3 — SPEC immune to the veto"
  assert_eq "$(review_line 4)" "rounds: 1 of 2" "stopped after round 1"
  assert_eq "$(calls claude)" 1 "builder called once"
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=SPEC MAX_ROUNDS=1
  assert_grep 'PREVIOUS REVIEW' "$TRACE/claude-prompt-2" "rerun renders build-after-spec"
  assert_not_grep 'REJECTED' "$TRACE/claude-prompt-2" "rerun does not render round-2"
}

case_11_no_acs() {
  CASE="11 story without ACs → needs_human before any agent"; fixture c11
  cat > "$REPO/.stories/$STORY.md" <<'EOF'
---
status: ready
round: 0
---

# Story 900: fixture story with no criteria

| AC | claim |
|---|---|
| AC1 | a table row is not a heading |
EOF
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$RC" 1 "exit code (die)"
  assert_eq "$(field status)" needs_human "story status"
  assert_grep 'no acceptance criteria' "$LOG" "reason in output"
  assert_eq "$(calls claude)" 0 "builder must not run"
  assert_eq "$(calls codex)"  0 "reviewer must not run"
}

# Phase 1.2. The harness runs test/build/lint in the reviewer tree before
# the reviewer is asked anything; a red baseline is a machine veto — FAIL
# whatever the reviewer's VERDICT line says. Red when the veto block after
# the VERDICT parse is deleted (the model's PASS then stands).
baseline_case() {                     # baseline_case <name> <label> <expect-in-machine-block> [VAR=value …]
  local name="$1" label="$2" expect="$3"; shift 3
  CASE="$label"; fixture "$name"
  # MAX_ROUNDS=1: a vetoed round is a FAIL and would otherwise (correctly)
  # trigger round 2; one round keeps the case about the veto itself.
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 "$@"
  assert_eq "$(field status)" needs_human "story status"
  assert_eq "$(review_line 3)" "verdict: FAIL" ".review line 3 — machine veto over model PASS"
  assert_grep "$expect" "$REPO/.review/$STORY.md" "machine block names the red baseline"
  assert_grep 'model: *PASS' "$REPO/.review/$STORY.md" "model verdict still recorded"
  assert_eq "$(calls codex)" 1 "reviewer still ran (its prose is evidence)"
}
case_12_baseline_test_red()  { baseline_case c12 "12 baseline test RED vetoes PASS"  'baseline: test RED'  FAKE_VITEST=fail
                               assert_grep '"numFailedTests": *1' "$REPO/.review/$STORY/round-1/baseline/test.summary.json" "summary carries the count"; }
case_13_baseline_build_red() { baseline_case c13 "13 baseline build RED vetoes PASS" 'build RED'           BUILD_CMD=false
                               assert_file "$REPO/.review/$STORY/round-1/baseline/build.log" "build log kept"; }
case_14_baseline_lint_red()  { baseline_case c14 "14 baseline lint RED vetoes PASS"  'lint RED'            LINT_CMD=false; }
# L-08: a suite that collects zero tests is not green.
case_15_baseline_notests()   { baseline_case c15 "15 baseline with zero tests is RED" 'baseline: test RED' FAKE_VITEST=notests; }

# Phase 1.3. The reviewer proposes mutations as files under .review-out/ and
# must leave the tree otherwise untouched. Red when the clean-tree check
# after codex is deleted: a reviewer that applied its own mutation then sails
# through to a verdict.
case_16_reviewer_dirty_tree() {
  CASE="16 reviewer leaves the tree dirty → needs_human"; fixture c16
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_MUTATIONS=dirty
  assert_eq "$RC" 1 "exit code (die)"
  assert_eq "$(field status)" needs_human "story status"
  assert_grep 'left the tree dirty' "$LOG" "reason in output"
  assert_grep 'src/marker.txt' "$LOG" "names the dirty path"
}

# Phase 1.3. Red when the copy-out after codex is deleted: the mutation
# files die with the reviewer worktree and never reach git.
case_17_reviewer_output_copied() {
  CASE="17 reviewer output reaches the evidence dir"; fixture c17
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_MUTATIONS=patch MAX_ROUNDS=1
  local t; t="$(tracked)"
  assert_contains "$t" ".review/$STORY/round-1/mutations/AC1-marker.patch" "patch committed"
  assert_contains "$t" ".review/$STORY/round-1/mutations/AC1-marker.test"  "selector committed"
  assert_contains "$t" ".review/$STORY/round-1/reviewer.md" "reviewer prose committed"
  assert_contains "$t" ".review/$STORY/round-1/builder.md"  "builder message committed"
  assert_grep 'FLEET_MUTANT_MARKER' "$REPO/.review/$STORY/round-1/mutations/AC1-marker.patch" "patch content intact"
  assert_grep 'fake review, call 1' "$REPO/.review/$STORY/round-1/reviewer.md" "prose content intact"
}

# Phase 1.4. The harness applies each proposed mutation in the clean reviewer
# tree, runs the selector, classifies, restores. Red when run_mutations (or
# its call) is deleted: no .result files, no rows in the Machine table.
# The veto on these classes is 1.5; here only the classification is asserted.
mutation_case() {                     # mutation_case <name> <label> <expected-class> <mutation-name> [VAR=value …]
  local name="$1" label="$2" cls="$3" mut="$4"; shift 4
  CASE="$label"; fixture "$name"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 "$@"
  local res="$REPO/.review/$STORY/round-1/mutations/$mut.result"
  assert_file "$res" "result file written"
  assert_eq "$(head -n1 "$res" 2>/dev/null)" "$cls" "classification"
  assert_contains "$(tracked)" ".review/$STORY/round-1/mutations/$mut.result" "result committed"
  assert_grep "^${mut%%-*} +$cls +${mut#*-}" "$REPO/.review/$STORY.md" "row in the Machine table"
}
case_18_mutation_red() {
  mutation_case c18 "18 mutation caught → RED" RED AC1-marker FAKE_MUTATIONS=patch FAKE_VITEST=marker
  # Line 2 of the .result: the mutated run's counts and failed tests, the bytes
  # `jq -c` wrote and the classifier writes now. Red with the line deleted.
  assert_eq "$(sed -n 2p "$REPO/.review/$STORY/round-1/mutations/AC1-marker.result")" \
    '{"numTotalTests":2,"numFailedTests":1,"failed":["fake suite a"]}' "the .result second line"
}
case_19_mutation_green()    { mutation_case c19 "19 mutation survives → GREEN"             GREEN        AC1-marker FAKE_MUTATIONS=patch    FAKE_VITEST=pass; }
case_20_mutation_notests()  { mutation_case c20 "20 mutation breaks compilation → NO_TESTS" NO_TESTS     AC1-marker FAKE_MUTATIONS=patch    FAKE_VITEST=marker-notests; }
case_21_mutation_badpatch() { mutation_case c21 "21 patch does not apply → PATCH_INVALID"   PATCH_INVALID AC1-bad   FAKE_MUTATIONS=badpatch; }
case_22_mutation_prered()   { mutation_case c22 "22 instrument already red → PRE_RED"      PRE_RED      AC1-marker FAKE_MUTATIONS=patch    FAKE_VITEST=fail; }
# L-39. Two mutations in one round name one selector. The tree is the same
# clean HEAD before each, so the first's GREEN pre-run stands for the second
# (khaita 071 ran a 165 s full-suite pre-run twice). Red when runMutations
# stops sharing its cache: the second -pre.log is a run of its own.
case_22b_mutation_prerun_once() {
  CASE="22b two mutations, one selector: one pre-run"; fixture c22b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 FAKE_MUTATIONS=twice FAKE_VITEST=marker
  assert_grep '^AC1 +RED +again' "$REPO/.review/$STORY.md" "the first caught"
  assert_grep '^AC1 +RED +marker' "$REPO/.review/$STORY.md" "the second caught"
  assert_grep 'same selector and HEAD as .*AC1-again-pre, GREEN' "$REPO/.runs/$STORY-round1-AC1-marker-pre.log" "the second reused the first's pre-run"
  assert_not_grep 'same selector' "$REPO/.runs/$STORY-round1-AC1-again-pre.log" "the first ran its own"
}
case_23_mutation_cmd()      { mutation_case c23 "23 .cmd selector, non-zero exit → RED"    RED          AC1-marker FAKE_MUTATIONS=cmd; }
# Phase A3. PRE_RED used to mean two things: an instrument that genuinely
# fails before the mutation (22, worth a human's attention) and a selector
# that collects no tests at all — a path that does not exist, a shell command
# in a .test file (014 round 1). They need different answers, so they need
# different names. Red while both map to PRE_RED.
case_51_selector_invalid() { mutation_case c51 "51 selector collects no tests → SELECTOR_INVALID" SELECTOR_INVALID AC1-marker FAKE_MUTATIONS=patch FAKE_VITEST=notests
                             assert_grep '^computed: FAIL — .*SELECTOR_INVALID' "$REPO/.review/$STORY.md" "it vetoes, and says which class"; }

# Phase 1.5. The verdict is computed: every AC needs ≥1 mutation and every
# mutation must be RED (D1 — any GREEN vetoes). Red when the mutation checks
# in the veto block are deleted: the model's PASS then stands.
veto_case() {                         # veto_case <name> <label> <expected-reason-regex> [VAR=value …]
  local name="$1" label="$2" reason="$3"; shift 3
  CASE="$label"; fixture "$name"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 "$@"
  assert_eq "$(field status)" needs_human "story status"
  assert_eq "$(review_line 3)" "verdict: FAIL" "machine veto over model PASS"
  assert_grep "^computed: FAIL — .*$reason" "$REPO/.review/$STORY.md" "reason enumerated"
  assert_grep '^model: *PASS' "$REPO/.review/$STORY.md" "model verdict still recorded"
}
case_24_veto_green()       { veto_case c24 "24 a surviving mutation vetoes PASS (D1)" 'AC1 marker GREEN'  FAKE_VITEST=pass; }
case_25_veto_no_mutation() { veto_case c25 "25 an AC with no mutation vetoes PASS"    'AC1 has no mutation' FAKE_MUTATIONS=none; }
case_26_veto_wrong_ac()    { veto_case c26 "26 a mutation for another AC does not cover AC1" 'AC1 has no mutation' FAKE_MUTATIONS=ac2only; }

# Phase 1.5. In-run round 2 must see the Machine block, not only the prose.
# Red when the reviewText refresh after the round section is deleted.
case_27_round2_gets_machine_facts() {
  CASE="27 round 2 prompt carries the Machine block"; fixture c27
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL FAKE_VITEST=pass
  assert_eq "$(calls claude)" 2 "two rounds ran"
  assert_grep '^### Machine' "$TRACE/claude-prompt-2" "machine block present"
  assert_grep '^AC1 +GREEN +marker' "$TRACE/claude-prompt-2" "the surviving mutation, as a fact"
  assert_grep 'fake review, call 1' "$TRACE/claude-prompt-2" "reviewer prose still present"
}

# Phase 2.1. `scope_deny:` in the story frontmatter — space-separated globs —
# names files the builder must not touch. Deny-only: no allow list, no line
# means nothing forbidden. Red when check_scope (or its veto) is deleted:
# a builder that changed a denied file then PASSes.
set_deny() { sed -i "2a scope_deny: $1" "$REPO/.stories/$STORY.md"; }
scope_case() {                        # scope_case <name> <label> <deny-globs|-> <expect-status> <expect-scope-regex>
  local name="$1" label="$2" deny="$3" status="$4" scope="$5"
  CASE="$label"; fixture "$name"
  [[ "$deny" == - ]] || set_deny "$deny"
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=src/marker.txt FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" "$status" "story status"
  assert_grep "^scope: +$scope" "$REPO/.review/$STORY.md" "scope line in the Machine block"
  assert_contains "$(tracked)" ".review/$STORY/round-1/scope.txt" "scope evidence committed"
  assert_grep 'src/marker.txt' "$REPO/.review/$STORY/round-1/scope.txt" "changed path recorded"
}
case_28_scope_violation() { scope_case c28 "28 denied file changed → VIOLATION vetoes PASS (nested glob)" 'src/*' needs_human 'VIOLATION src/marker.txt'
                            assert_grep '^computed: FAIL — .*scope VIOLATION' "$REPO/.review/$STORY.md" "reason enumerated"; }
case_29_scope_undeclared() { scope_case c29 "29 no scope_deny → CLEAN, nothing forbidden" - done 'CLEAN'; }
case_30_scope_elsewhere()  { scope_case c30 "30 deny names other files → CLEAN"           'lib/* docs/*' done 'CLEAN'; }

# Found on the first real run (007, round 1). codex prints "Reading
# additional input from stdin..." to stderr when stdin is not a TTY — every
# unattended run. Merged into the JSON stream it made jq abort at line 1;
# the raw JSONL became the review text and the VERDICT was UNPARSEABLE. The fake
# now always emits that line, so every reviewer case exercises this; this
# case names it. Red when stderr is merged back or the filter is strict.
case_31_codex_stderr_notice() {
  CASE="31 codex stderr notice does not break extraction"; fixture c31
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$(review_line 3)" "verdict: PASS" "verdict parsed from the agent_message"
  assert_grep '^fake review, call 1' "$REPO/.review/$STORY/round-1/reviewer.md" "reviewer.md is prose, not JSON"
  assert_not_grep '"type":"item' "$REPO/.review/$STORY/round-1/reviewer.md" "no raw JSONL in reviewer.md"
  assert_grep 'Reading prompt from stdin' "$REPO/.review/$STORY/round-1/reviewer.stderr" "stderr kept as evidence"
  assert_contains "$(tracked)" ".review/$STORY/round-1/reviewer.stderr" "stderr committed"
}

# Found on 007's third round. The round-2 prompt embeds the whole review file;
# at 134 KB it exceeded the kernel's per-argument limit (MAX_ARG_STRLEN,
# 131072), `claude -p "$PROMPT"` never exec'd, and the round died with empty
# output. Prompts now go to the agents on stdin. Red when they go back to argv.
case_32_huge_review_prompt() {
  CASE="32 a >128 KB review still reaches the builder (prompt on stdin)"; fixture c32
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  head -c 140000 /dev/zero | tr '\0' x >> "$REPO/.review/$STORY.md"
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(calls claude)" 2 "builder ran on the rerun"
  assert_grep 'REJECTED' "$TRACE/claude-prompt-2" "builder received the round-2 prompt"
  local size; size="$(wc -c < "$TRACE/claude-prompt-2" 2>/dev/null || echo 0)"
  (( size > 131072 )) && ok || fail "prompt size $size not over MAX_ARG_STRLEN — the case does not test the limit"
  assert_eq "$(field status)" done "story completed"
}

# Found on 007's fifth round: the builder read the story from its worktree and
# the reviewer's tree is detached at the builder's head, so a story amended on
# the base after the branch was cut reached neither. First fixed by syncing the
# file into the worktree; now fixed at the root — the story text is rendered
# into both prompts, so no copy of it need exist in the worktree at all. Red
# when the prompts stop carrying {{STORY}}.
case_33_story_amendment_reaches_builder() {
  CASE="33 a story amended on the base reaches both agents"; fixture c33
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  printf '\n**AC2 — amended after the branch was cut.** Goes red when ignored.\n' >> "$REPO/.stories/$STORY.md"
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 FAKE_MUTATIONS=ac2only
  assert_grep 'amended after the branch was cut' "$TRACE/claude-prompt-2" "builder prompt carries the amendment"
  assert_grep 'amended after the branch was cut' "$TRACE/codex-prompt-2" "reviewer prompt carries it too"
  assert_grep '^acs: .*AC2' "$REPO/.review/$STORY.md" "verdict computed against the amended AC set"
  assert_grep 'commits this round: 1' "$REPO/.review/$STORY.md" "no sync commit inflating the count"
}

# REVIEW_ONLY: re-review the branch head without a builder round. The case a
# story hits after needs_human when a human fixes the branch by hand — until
# now impossible, because the round postcondition demands a builder commit.
# Red when the postcondition's REVIEW_ONLY guard is deleted (the round dies
# at "produced no commits"), or when the builder block is no longer skipped.
case_34_review_only() {
  CASE="34 REVIEW_ONLY re-reviews the head with no builder round"; fixture c34
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  assert_eq "$(field status)" needs_human "first run stopped"
  set_ready
  run "$STORY" FAKE_BUILDER=nocommit FAKE_REVIEWER=PASS MAX_ROUNDS=1 REVIEW_ONLY=1
  assert_eq "$(calls claude)" 1 "builder did not run again"
  assert_eq "$(calls codex)"  2 "reviewer ran again"
  assert_eq "$(field status)" done "verdict computed on the existing head"
  assert_grep 'commits this round: 0' "$REPO/.review/$STORY.md" "zero commits recorded honestly"
  assert_grep 'REVIEW_ONLY' "$REPO/.review/$STORY.md" "the round says no builder ran"
  assert_file "$REPO/.review/$STORY/round-2/mutations/AC1-marker.result" "mutations still ran"
}

# Phase 3.1. RULES say "write the failing test, run it, SEE IT FAIL". Until
# now that was a sentence in a commit message. The builder hands the harness
# the same evidence the reviewer does — a patch removing the behaviour, and
# the selector that must go red — and the runner judges it. Red when the
# builder's copy-out is deleted (no tdd row) or when its classification is
# left out of the veto (a false "observed red" claim passes).
case_35_builder_tdd_mutation() {
  CASE="35 a builder's TDD claim is run, not believed"; fixture c35
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=red FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep '^AC1 +RED +tdd-observed-red' "$REPO/.review/$STORY.md" "the builder's claim ran"
  assert_contains "$(tracked)" ".review/$STORY/round-1/mutations/AC1-tdd-observed-red.result" "committed"
  assert_eq "$(field status)" done "true claim does not block a PASS"

  CASE="35b a false TDD claim fails the story"; fixture c35b
  # TDD_FIXES=0: the tdd check hands nothing back (case 159), so the claim
  # the builder made is the one the verdict reads.
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=green FAKE_REVIEWER=PASS MAX_ROUNDS=1 TDD_FIXES=0
  assert_grep '^AC1 +GREEN +tdd-observed-red' "$REPO/.review/$STORY.md" "survived"
  assert_eq "$(review_line 3)" "verdict: FAIL" "machine veto over model PASS"
  assert_grep '^computed: FAIL — .*tdd-observed-red GREEN' "$REPO/.review/$STORY.md" "reason names the tdd claim"
}

# Phase 3.2. A probe is a test the reviewer constructs to hunt a regression no
# existing test covers (004's reverse-race, 006's cache→empty→populated). They
# used to be written to /tmp and lost with the worktree. A probe is the INVERSE
# of a mutation: RED means it found something, so RED vetoes. Red when
# run_probes, its copy-out, or the probe clause of the veto is deleted.
case_36_reviewer_probes() {
  CASE="36 a green probe is recorded and changes nothing"; fixture c36
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_PROBES=green MAX_ROUNDS=1
  assert_eq "$(field status)" done "a probe that finds nothing does not block"
  assert_grep '^probes:$' "$REPO/.review/$STORY.md" "probes table starts its own line"
  assert_grep '^GREEN +probe-green.test.tsx' "$REPO/.review/$STORY.md" "row in the Machine table"
  assert_contains "$(tracked)" ".review/$STORY/round-1/probes/probe-green.test.tsx" "probe committed"

  CASE="36b a red probe vetoes and is kept as the next story's instrument"; fixture c36b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_PROBES=red MAX_ROUNDS=1
  assert_eq "$(review_line 3)" "verdict: FAIL" "machine veto over model PASS"
  assert_grep '^computed: FAIL — .*probe probe-red.test.tsx RED' "$REPO/.review/$STORY.md" "reason names the probe"
  assert_contains "$(tracked)" ".review/$STORY/round-1/probes/probe-red.test.tsx" "the failing probe is committed verbatim"

  CASE="36c no probes is not a finding"; fixture c36c
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "probes are optional"
  assert_not_grep '^probes:' "$REPO/.review/$STORY.md" "no empty probe table"
}

# Found on story 010 round 2, by the builder doing the right thing. Told its
# TDD patches were PATCH_INVALID, it regenerated them and changed no code —
# correct, and invisible: .review-out/ is gitignored (3.1), so a round whose
# only legitimate output is evidence can never produce a commit. The
# postcondition, written when code was the only possible output, killed it.
# A round is productive if it produced anything the harness can judge.
# Red when the handover clause is removed from the postcondition.
# Case 2 still guards the original hazard: nothing at all is still a die.
case_37_evidence_only_round() {
  CASE="37 a round that only hands over evidence is not 'no commits'"; fixture c37
  run "$STORY" FAKE_BUILDER=nocommit FAKE_BUILDER_MUTATIONS=red FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$RC" 0 "exit code (not the postcondition die)"
  assert_eq "$(calls codex)" 1 "the reviewer still ran"
  assert_grep 'commits this round: 0' "$REPO/.review/$STORY.md" "zero commits recorded honestly"
  assert_grep '^AC1 +RED +tdd-observed-red' "$REPO/.review/$STORY.md" "the handed-over evidence was judged"
  assert_eq "$(field status)" done "the round reached a verdict"
}

# Epics. A story declares the branch it is cut from, so one queue can serve
# several epics at once (epic/offline-pwa, epic/search, …) while the fleet's
# own state — .stories, .review — stays on the
# integration branch the launcher is checked out on. BASE_BRANCH remains the
# default for a story that names none. Red when the story's base: is ignored
# and the worktree is cut from BASE_BRANCH instead.
case_38_story_base() {
  CASE="38 a story's base: decides which branch it is cut from"; fixture c38
  git -C "$REPO" checkout -q -b epic/test
  echo "only on the epic base" > "$REPO/EPIC_MARKER.txt"
  git -C "$REPO" add EPIC_MARKER.txt
  git -C "$REPO" commit -qm "epic/test: a file that exists only here"
  git -C "$REPO" push -q -u origin epic/test
  git -C "$REPO" checkout -q base
  sed -i '2a base: epic/test' "$REPO/.stories/$STORY.md"

  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_file "$FX/wt-$STORY/EPIC_MARKER.txt" "worktree cut from the story's own base"
  assert_eq "$(git -C "$FX/wt-$STORY" rev-parse --abbrev-ref HEAD)" "story/$STORY" "on its story branch"
  assert_eq "$(field status)" done "the story still reaches a verdict"
  assert_grep 'EPIC_MARKER.txt' <(git -C "$REPO" show "origin/epic/test:EPIC_MARKER.txt" >/dev/null 2>&1 && echo EPIC_MARKER.txt) "epic base untouched by the run"
}

# fleet lint-story — mechanical, no launcher needed.
# Red when a check is removed; the false-positive guard is red when the "/"
# requirement on citations is dropped, which is how the first version of that
# check behaved: 20 false positives across the real stories, zero findings.
case_39_lint_story() {
  CASE="39 lint-story: shape and citations"; fixture c39
  local d="$FX/lint"; mkdir -p "$d"
  local out rc

  write_story() { printf '%s' "$2" > "$d/$1.md"; }
  lint() { out="$(cd "$FX" && bash "$FLEET/fleet" lint-story t "$d/$1.md" ${2:-} 2>&1)"; rc=$?; }

  write_story good '---
status: ready
round: 0
scope_deny: src/x/*
---
# Story: fine
It cites `src/marker.txt` and `src/marker.txt:1`.
## Acceptance criteria
**AC1 — one bounded claim.** Goes red when removed.
## Known weakness
None stated.
## Out of scope
- nothing
'
  lint good; assert_eq "$rc" 0 "a well-formed story passes"

  write_story noac '---
status: ready
round: 0
---
# Story: criteria in a table
| AC | claim |
|---|---|
| AC1 | invisible to the launcher |
'
  lint noac; assert_eq "$rc" 1 "a story whose ACs are a table fails"
  assert_contains "$out" "no acceptance criteria" "and says why"

  write_story stale '---
status: ready
round: 0
---
# Story: rotted
See `docs/does-not-exist.md` for the diagnosis.
## Acceptance criteria
**AC1 — a claim.** Goes red when removed.
'
  lint stale; assert_eq "$rc" 0 "a missing path with no line is a warning — it may be an instrument to create"
  assert_contains "$out" "new instrument, or rot" "and says which question it is"

  write_story staleline '---
status: ready
round: 0
---
# Story: rotted with a line number
See `docs/does-not-exist.md:12` for the diagnosis.
## Acceptance criteria
**AC1 — a claim.** Goes red when removed.
'
  lint staleline; assert_eq "$rc" 1 "a missing path WITH a line number fails — a line asserts it exists now"
  assert_contains "$out" "does-not-exist.md:12" "and names it"

  write_story overrange '---
status: ready
round: 0
---
# Story: out of range
See `src/marker.txt:99999`.
## Acceptance criteria
**AC1 — a claim.** Goes red when removed.
'
  lint overrange; assert_eq "$rc" 1 "a line number past the end of the file fails"

  write_story unbounded '---
status: ready
round: 0
---
# Story: unbounded
## Acceptance criteria
**AC1 — every stub in the worker global is argument-sensitive.** Goes red.
'
  lint unbounded; assert_eq "$rc" 0 "an unquantified every is a warning, not an error"
  assert_contains "$out" "unquantified domain" "and is named (L-20)"
  lint unbounded --strict; assert_eq "$rc" 1 "--strict makes it fatal"


  write_story temporal '---
status: ready
round: 0
---
# Story: determinism, not scope
## Acceptance criteria
**AC1 — the same input produces the same output every time.** Goes red when it does not.
'
  lint temporal; assert_eq "$rc" 0 "temporal every is not a scope warning"
  assert_not_contains "$out" "unquantified domain" "every time is determinism, not an unbounded set"

  write_story command '---
status: ready
round: 0
---
# Story: a command is not a path
Run `git log -- public/sw.js` to see the history.
## Acceptance criteria
**AC1 — a bounded claim.** Goes red when removed.
'
  lint command; assert_eq "$rc" 0 "a backticked command is not a citation"

  write_story badbase '---
status: ready
round: 0
base: epic/not-a-real-branch
---
# Story: bad base
## Acceptance criteria
**AC1 — a claim.** Goes red when removed.
'
  lint badbase; assert_eq "$rc" 1 "a base: naming no branch fails"

  # The regression guard: prose full of things that look like paths but are not.
  write_story prose '---
status: ready
round: 0
---
# Story: prose
The handler reads `req.method`, `req.url` and `res.ok`, calls `cache.match`
and `caches.open`, and lives in `sw.js`. See `02-REVIEW.md`. It fetches
`/manifest.json` and `/_next/static/chunks/x.js`, and may write
`.blocked/900.md`.
## Acceptance criteria
**AC1 — a bounded claim.** Goes red when removed.
'
  lint prose; assert_eq "$rc" 0 "JS expressions, bare filenames and URL paths are not citations"
}

# Unattended, a hung agent is indistinguishable from a slow one and blocks the
# queue for ever. MAX_TURNS bounds the builder's turns, nothing bounded its
# wall clock — a hung round was killed by hand on 18 Sep only because someone
# was watching. Red when the timeout wrapper is removed from either call.
case_40_agent_timeout() {
  CASE="40 a hung builder is killed and the story stops"; fixture c40
  run "$STORY" FAKE_BUILDER=hang FAKE_REVIEWER=PASS AGENT_TIMEOUT=5 MAX_ROUNDS=1
  assert_eq "$RC" 1 "exit code (die)"
  assert_eq "$(field status)" needs_human "story status"
  assert_grep 'exceeded AGENT_TIMEOUT' "$LOG" "says why"
  assert_eq "$(calls codex)" 0 "the reviewer never ran"

  CASE="40b a hung reviewer is killed and the story stops"; fixture c40b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=hang AGENT_TIMEOUT=5 MAX_ROUNDS=1
  assert_eq "$RC" 1 "exit code (die)"
  assert_eq "$(field status)" needs_human "story status"
  assert_grep 'exceeded AGENT_TIMEOUT' "$LOG" "says why"
}

# The queue runner. Until it existed a human launched each story, watched it,
# and launched the next — the fleet did the judgment unattended but not the
# operating. Red when the loop stops after one story, or when a stopped story
# stops the queue (it must not: that has been the design since phase 4b).
case_41_run_queue() {
  CASE="41 the queue runs every ready story and stops when empty"; fixture c41
  # a second and third story beside the fixture's own
  for extra in 901 902; do
    sed "s/Story $STORY/Story $extra/" "$REPO/.stories/$STORY.md" > "$REPO/.stories/$extra.md"
  done
  # 901 will fail its round; the queue must carry on to 902 regardless
  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local qrc=$QRC

  assert_eq "$qrc" 0 "the runner exits cleanly"
  assert_grep 'queue empty' "$FX/queue.log" "it stopped because nothing was ready"
  for id in "$STORY" 901 902; do
    assert_eq "$(awk -v k=status '/^---$/{d++; next} d==1 && $0 ~ "^"k":" {sub("^"k":[[:space:]]*",""); print; exit}' "$REPO/.stories/$id.md")" done "story $id reached a verdict"
  done
  assert_eq "$(calls claude)" 3 "the builder ran once per story"

  CASE="41b a stopped story does not stop the queue"; fixture c41b
  sed "s/Story $STORY/Story 901/" "$REPO/.stories/$STORY.md" > "$REPO/.stories/901.md"
  # no ACs at all: 900 dies before any agent runs, 901 must still run
  cat > "$REPO/.stories/$STORY.md" <<'EOS'
---
status: ready
round: 0
---
# Story 900: no criteria the launcher can see
EOS
  queue FAKE_STORY_ID=901 FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1

  assert_grep 'no acceptance criteria' "$FX/queue.log" "900 was rejected"
  assert_eq "$(awk -v k=status '/^---$/{d++; next} d==1 && $0 ~ "^"k":" {sub("^"k":[[:space:]]*",""); print; exit}' "$REPO/.stories/901.md")" done "901 still ran and finished"
  assert_grep 'queue empty' "$FX/queue.log" "and the queue drained"
}

# Server stops mid-round: power cut, reboot, OOM. What that leaves is a story
# at `in_progress`, a worktree on disk with the builder's commits in it, and no
# processes anywhere. Everything that matters is on disk or in git, so the
# question is only whether the fleet picks it back up by itself.
case_42_resume_after_crash() {
  CASE="42 a crashed run is reaped and resumed by the queue"; fixture c42
  # Exactly the state a reboot leaves behind.
  git -C "$REPO" worktree add -q "$FX/wt-$STORY" -b "story/$STORY" origin/base
  git -C "$REPO" -C "$FX/wt-$STORY" commit -q --allow-empty -m "work the builder had already done" 2>/dev/null \
    || git -C "$FX/wt-$STORY" commit -q --allow-empty -m "work the builder had already done"
  sed -i '0,/^status:.*/s//status: in_progress/' "$REPO/.stories/$STORY.md"

  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1

  assert_grep 'orphan' "$FX/queue.log" "the stranded story was recognised as an orphan"
  assert_eq "$(field status)" done "and carried through to a verdict"
  assert_grep 'resuming existing worktree' "$FX/queue.log" "its worktree was reused, not rebuilt"
  assert_contains "$(git -C "$FX/wt-$STORY" log --format=%s origin/base..HEAD | tr '\n' ' ')" \
    "work the builder had already done" "the work it had already done survived"
}

# Phase A2, the warn → die audit. Three warnings guarded conditions under
# which nothing measured afterwards means anything; each is now a die.
#
# A seed file is a file the worktree needs to behave like production — today
# just .env.local, the Firebase config. Missing it, the builder works in a
# tree where the app cannot reach Firestore and every result is about that,
# not about the story. This warning is what produced bug #1.
#
# Red while it is a warn: the run continues and the story reaches a verdict.
case_48_missing_seed_file() {
  CASE="48 a missing seed file stops the run"; fixture c48
  rm -f "$REPO/.env.local"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$RC" 1 "exit code (die)"
  assert_grep '\.env\.local' "$LOG" "the message names the file"
  assert_eq "$(calls claude)" 0 "the builder must not run"
}

# A failed install leaves node_modules stale or absent. The baseline then
# measures the install, not the story — and reports it as a red suite.
# Red while it is a warn: the run continues to a verdict.
case_49_install_failure() {
  CASE="49 a failed install stops the run"; fixture c49
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS INSTALL_CMD=false
  assert_eq "$RC" 1 "exit code (die)"
  assert_grep 'install' "$LOG" "the message names the step"
  assert_eq "$(calls claude)" 0 "the builder must not run"
}

# commitStatus returns early when there is nothing staged, so a failure here
# is a real one: a hook, a lock, a broken identity. Continuing means the story
# runs on with its state only in the working tree — invisible to fleet status,
# to the queue and to a resumed run after a crash.
# Red while it is a warn: the run continues with uncommitted state.
case_50_status_commit_failure() {
  CASE="50 a failed status commit stops the run"; fixture c50
  printf '#!/bin/sh\nexit 1\n' > "$REPO/.git/hooks/pre-commit"
  chmod +x "$REPO/.git/hooks/pre-commit"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$RC" 1 "exit code (die)"
  assert_grep 'status commit failed' "$LOG" "the message says what failed"
  assert_eq "$(calls claude)" 0 "the builder must not run"
}

# Phase A4. Clearing a story so it can be run again was four manual steps:
# remove the worktree, delete the branch, edit the frontmatter, delete the
# review. Four steps done by hand at the end of a long session is where state
# gets left half-cleared.
#
# reset() is destructive by definition, so the cases are mostly about what it
# refuses to do.
reset_run() {                         # reset_run <args…> → RLOG RRC
  RLOG="$FX/reset.log"
  ( cd "$FX" && env PUSH_STATUS=1 bash "$FLEET/fleet" reset t "$@" ) > "$RLOG" 2>&1
  RRC=$?
}

# Red without ts/src/reset.ts, and red again if any one of the four steps is
# dropped from it.
case_52_reset() {
  CASE="52 reset clears a story back to the queue"; fixture c52
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  assert_eq "$(field status)" needs_human "precondition: the story stopped"
  assert_file "$REPO/.review/$STORY.md" "precondition: a review exists"

  reset_run "$STORY" --force
  assert_eq "$RRC" 0 "exit code"
  assert_eq "$(field status)" ready "status back to ready"
  assert_eq "$(field round)" 0 "round back to 0"
  [[ -d "$FX/wt-$STORY" ]] && fail "worktree still there" || ok
  git -C "$REPO" show-ref --verify --quiet "refs/heads/story/$STORY" && fail "branch still there" || ok
  assert_no_file "$REPO/.review/$STORY.md" "review file gone"
  [[ -d "$REPO/.review/$STORY" ]] && fail "evidence dir still there" || ok
  assert_not_contains "$(tracked)" ".review/$STORY" "and gone from the index, not just the worktree"
  assert_contains "$(git -C "$REPO" log -1 --format=%s)" "reset" "the reset is a commit, not a local edit"
}

# The guard that matters. A launcher mid-round has a live process in the
# worktree; removing it under the agent loses the round and leaves git holding
# a worktree that is not there. Red when the liveness check (procsInWorktree)
# is deleted: the reset proceeds and the branch is gone.
case_53_reset_refuses_while_live() {
  CASE="53 reset refuses while something is running in the worktree"; fixture c53
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  ( cd "$FX/wt-$STORY" && exec sleep 30 ) &
  local pid=$!
  sleep 0.3
  reset_run "$STORY" --force
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  assert_eq "$RRC" 1 "exit code (die)"
  assert_grep 'running' "$RLOG" "the message says why"
  git -C "$REPO" show-ref --verify --quiet "refs/heads/story/$STORY" && ok || fail "the branch must survive"
  assert_eq "$(field status)" needs_human "and the status is untouched"
}

# --force is required because the branch holds work that is on no other
# branch. Red when the unmerged check is deleted: the work goes without a word.
case_54_reset_refuses_unmerged() {
  CASE="54 reset refuses to drop unmerged work without --force"; fixture c54
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  reset_run "$STORY"
  assert_eq "$RRC" 1 "exit code (die)"
  assert_grep 'force' "$RLOG" "the message names the way through"
  git -C "$REPO" show-ref --verify --quiet "refs/heads/story/$STORY" && ok || fail "the branch must survive"
  assert_eq "$(field status)" needs_human "and the status is untouched"
}

# Phase C3. fleet status is the only thing that knows where a story stands,
# and it knows it by parsing frontmatter and asking git — there is no state
# file, deliberately: a second source of truth would need keeping in sync
# with the frontmatter, which is already authoritative. --json gives the same
# values a shape a machine can consume without re-parsing a terminal table.
#
# Red without --json: fleet status prints its table and jq rejects it.
case_55_status_json() {
  CASE="55 fleet status --json is machine-readable"; fixture c55
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  local out; out="$( status_run --json )"
  jq -e . >/dev/null 2>&1 <<< "$out" && ok || fail "output parses as JSON"
  assert_eq "$(jq -r '.[0].id'      <<< "$out")" "$STORY" "id"
  assert_eq "$(jq -r '.[0].status'  <<< "$out")" done     "status"
  assert_eq "$(jq -r '.[0].verdict' <<< "$out")" PASS     "computed verdict"
  assert_eq "$(jq -r '.[0].round'   <<< "$out")" 1        "round, as a number"
  assert_eq "$(jq -r '.[0].base'    <<< "$out")" base     "the epic it belongs to"
  assert_eq "$(jq -r '.[0].merged'  <<< "$out")" false    "not merged into it yet"
  # One story, still an array: a caller should not need two parsers.
  local one; one="$( status_run --json "$STORY" )"
  assert_eq "$(jq -r 'length' <<< "$one")" 1 "a single story is an array of one"
  # The table must still be the default — fleet status is read by people too.
  local table; table="$( status_run )"
  assert_contains "$table" "ID" "the human table is still the default"
}

# Phase E1. Nothing merged itself in thirteen stories; every merge was a
# human's. fleet merge is what the queue will call on a computed PASS, so most
# of its cases are about the refusals — the point is not that it merges, it is
# that it merges only what it should and undoes itself when it is wrong.
#
# The post-merge baseline is the check that earns the autonomy: two stories
# that each passed alone can still break each other on the epic branch, and
# nothing before this ran a suite against the merged result.

epic_story() {                        # epic_story <case-name> — a story on an epic branch
  fixture "$1"
  git -C "$REPO" checkout -q -b epic/test
  git -C "$REPO" push -q -u origin epic/test
  git -C "$REPO" checkout -q base
  sed -i '2a base: epic/test' "$REPO/.stories/$STORY.md"
}

merge_run() {                         # merge_run [VAR=value…] [-- <fleet merge flags…>] → MLOG MRC
  local -a vars=() flags=(); local a after=0
  for a in "$@"; do
    if [[ "$a" == -- ]]; then after=1; continue; fi
    if (( after )); then flags+=("$a"); else vars+=("$a"); fi
  done
  MLOG="$FX/merge.log"
  ( cd "$FX" && env PATH="$(FAKES)" PUSH_STATUS=1 FAKE_VITEST=pass FAKE_TRACE_DIR="$TRACE" \
      "${vars[@]}" bash "$FLEET/fleet" merge t "$STORY" "${flags[@]}" ) > "$MLOG" 2>&1
  MRC=$?
}
merge_epic() {                        # merge_epic <log> [VAR=value…] → exit code
  local log="$1"; shift
  ( cd "$FX" && env PATH="$(FAKES)" PUSH_STATUS=1 FAKE_VITEST=pass FAKE_TRACE_DIR="$TRACE" \
      "$@" bash "$FLEET/fleet" merge t --epic epic/test ) > "$log" 2>&1
}

epic_head() { git -C "$REPO" rev-parse "origin/epic/test"; }

# Red without ts/src/merge.ts, and red again if the push or the frontmatter
# record is dropped: a merge nobody can see, or one that cannot be reverted.
case_56_merge() {
  CASE="56 a computed PASS merges into its epic"; epic_story c56
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "precondition: the story passed"
  local before; before="$(epic_head)"
  assert_eq "$(test -d "$REPO/../wt-$STORY" && echo present || echo gone)" present "precondition: the launcher left its worktree"

  merge_run
  assert_eq "$MRC" 0 "exit code"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/epic/test && ok \
    || fail "the story is an ancestor of the epic"
  [[ "$(epic_head)" != "$before" ]] && ok || fail "the epic moved"
  assert_grep '^merged: [0-9a-f]{7,}' "$REPO/.stories/$STORY.md" "the merge sha is recorded, so it can be reverted"
  assert_contains "$(git -C "$REPO" log -1 --format=%s)" "merged" "and recorded as a commit on the integration branch"
  # 24 Sep: wt-020 and wt-025 stayed on disk after their merges; the launcher
  # only printed "when finished: git worktree remove". A merged story's work
  # is in its epic, and fleet revert works from the recorded sha. Red while
  # the worktree survives the merge.
  assert_eq "$(test -d "$REPO/../wt-$STORY" && echo present || echo gone)" gone "the story's builder worktree is removed"
  git -C "$REPO" rev-parse --verify --quiet "refs/heads/story/$STORY" >/dev/null && ok \
    || fail "the story's branch stays"
}

# Red when the verdict check is deleted: a story the harness vetoed lands.
case_57_merge_refuses_fail() {
  CASE="57 merge refuses a story the machine vetoed"; epic_story c57
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  assert_eq "$(field status)" needs_human "precondition: the story failed"
  local before; before="$(epic_head)"
  merge_run
  assert_eq "$MRC" 1 "exit code (die)"
  assert_grep 'FAIL|needs_human|not done' "$MLOG" "the message says why"
  assert_eq "$(epic_head)" "$before" "the epic did not move"
}

# The check that earns auto-merge. Red when the post-merge baseline or its
# undo is deleted: the epic keeps a merge whose suite is red.
case_58_merge_undoes_itself() {
  CASE="58 a red post-merge baseline undoes the merge"; epic_story c58
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before; before="$(epic_head)"
  merge_run BUILD_CMD=false
  assert_eq "$MRC" 1 "exit code (die)"
  assert_grep 'baseline' "$MLOG" "the message names the baseline"
  assert_eq "$(epic_head)" "$before" "the epic is exactly where it was"
  assert_not_grep '^merged:' "$REPO/.stories/$STORY.md" "and nothing claims it merged"
}

# L-39. The queue merges a story into an epic that has not moved since the
# story was cut, so the merged tree is the tree its last round checked GREEN,
# and with the same commands a second run has nothing new to say (khaita 071:
# 6m13s re-checking an identical tree). Red when merge.ts runs the post-merge
# baseline anyway — the fake vitest is called — or when it reuses the round
# after the epic moved.
case_58b_merge_reuses_the_round() {
  CASE="58b an unmoved epic: the round's GREEN baseline stands for the merge"; epic_story c58b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_file "$REPO/.review/$STORY/round-1/baseline/commands.json" "the round recorded the commands it ran"
  local nv; nv="$(grep -c '^vitest' "$TRACE/calls")"
  merge_run
  assert_eq "$MRC" 0 "exit code"
  assert_grep 'post-merge baseline: SKIPPED .*round 1 checked GREEN' "$MLOG" "the log names the round that stands for it"
  assert_eq "$(grep -c '^vitest' "$TRACE/calls")" "$nv" "no suite ran"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/epic/test && ok || fail "the story is in the epic"

  CASE="58c the epic moved: the merge runs its own baseline"; epic_story c58c
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  # Another story reached the epic after this one was cut.
  git -C "$REPO" worktree add -q "$FX/epic-wt" epic/test
  echo moved > "$FX/epic-wt/epic-moved.txt"
  git -C "$FX/epic-wt" add epic-moved.txt
  git -C "$FX/epic-wt" commit -qm "another story"
  git -C "$FX/epic-wt" push -q origin epic/test
  git -C "$REPO" worktree remove --force "$FX/epic-wt"
  nv="$(grep -c '^vitest' "$TRACE/calls")"
  merge_run
  assert_eq "$MRC" 0 "exit code"
  assert_grep 'post-merge baseline: running .*not the tree round 1 checked' "$MLOG" "the log says why it runs"
  assert_eq "$(grep -c '^vitest' "$TRACE/calls")" $((nv + 1)) "the suite ran on the merged tree"
}

# develop and main are human-only, always. Red when that guard is deleted.
case_59_merge_refuses_integration_branch() {
  CASE="59 merge refuses to touch the integration branch"; fixture c59
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before; before="$(git -C "$REPO" rev-parse origin/base)"
  merge_run
  assert_eq "$MRC" 1 "exit code (die)"
  assert_grep 'base' "$MLOG" "the message names the branch it will not touch"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$before" "the integration branch did not move"
}

# Phase D. The bot is both halves of the control plane: how the fleet reaches
# a human and how the human reaches back. TELEGRAM_API_BASE names the fake
# API, so no case here touches the network.

bot() {                               # bot <verb> [args…] → BLOG BRC
  BLOG="$FX/bot.log"
  api_start || return
  ( cd "$FX" && env PATH="$(FAKES)" \
      FAKE_TRACE_DIR="$TRACE" FAKE_VITEST=pass \
      TELEGRAM_BOT_TOKEN=test-token TELEGRAM_CHAT_ID=42 \
      FAKE_TELEGRAM_UPDATES="${FAKE_TELEGRAM_UPDATES:-}" \
      TELEGRAM_API_BASE="$API_BASE" \
      QUEUE_START_CMD=true \
      bash "$FLEET/fleet" telegram "$@" ) > "$BLOG" 2>&1
  BRC=$?
}

update() {                            # update <update_id> <from_id> <text> → writes $FX/updates.json
  jq -nc --argjson uid "$1" --argjson from "$2" --arg text "$3" \
    '{ok:true, result:[{update_id:$uid, message:{from:{id:$from}, text:$text}}]}' \
    > "$FX/updates.json"
  FAKE_TELEGRAM_UPDATES="$FX/updates.json"
}

sent() { api_args | grep -c 'sendMessage' ; }

# A detached merge answers twice: the acknowledgement while it runs, and its
# result when it ends. Nothing in the poll waits for the second one, so a case
# that asserts on it has to.
wait_for_send() {                     # wait_for_send <n> [seconds]
  local want="$1" limit="${2:-90}" waited=0
  while (( $(sent) < want )); do
    if (( waited++ >= limit * 2 )); then
      fail "waited ${limit}s for $want message(s), saw $(sent)"
      return 1
    fi
    sleep 0.5
  done
  return 0
}
# The whole recorded argv, not just the line starting with text=: a message is
# multi-line and only its first line carries the prefix.
sent_text() { api_args; }

# Red when the send call is removed, or when it stops passing the text.
case_60_bot_send() {
  CASE="60 send reaches the API with the text"; fixture c60
  bot send "014 needs_human"
  assert_eq "$BRC" 0 "exit code"
  assert_eq "$(sent)" 1 "one sendMessage"
  assert_contains "$(sent_text)" "014 needs_human" "carrying the message"
}

# A fleet with no bot configured must still run: a notification is not part of
# a verdict. Red if the missing configuration is made fatal.
case_61_bot_unconfigured_is_not_fatal() {
  CASE="61 an unconfigured bot does not stop anything"; fixture c61
  BLOG="$FX/bot.log"
  ( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" \
      bash "$FLEET/fleet" telegram send "anyone there" ) > "$BLOG" 2>&1
  assert_eq "$?" 0 "exit code is still 0"
  assert_grep 'not configured' "$BLOG" "and it says why"
  assert_eq "$(sent)" 0 "nothing was sent"
}

# The whole security model. Anyone who finds the bot can message it; only the
# configured chat id is acted on, and an unauthorised sender gets no reply at
# all, because a reply confirms the bot exists.
# Red when the from.id comparison is deleted: a stranger can promote a story.
case_62_bot_ignores_strangers() {
  CASE="62 a message from anyone else changes nothing"; fixture c62
  update 100 999 "/promote t $STORY"
  bot poll
  assert_eq "$BRC" 0 "exit code"
  assert_eq "$(sent)" 0 "no reply — not even a refusal"
  assert_eq "$(field status)" ready "the story was not touched"
  assert_grep 'ignored a message from 999' "$BLOG" "but it is recorded"
}

# Red when /status stops going through fleet status.
case_63_bot_status() {
  CASE="63 /status answers with the table"; fixture c63
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  update 101 42 "/status t"
  bot poll
  assert_eq "$(sent)" 1 "one reply"
  assert_contains "$(sent_text)" "$STORY" "naming the story"
  assert_contains "$(sent_text)" "awaiting merge" "and its landing state"
}

# The write path: this is what makes a phone a control plane.
# Red when cmdPromote stops committing: the queue on the next drain sees
# nothing, because it reads what is committed.
case_64_bot_promote() {
  CASE="64 /promote puts a story back in the queue"; fixture c64
  sed -i '0,/^status:.*/s//status: draft/' "$REPO/.stories/$STORY.md"
  git -C "$REPO" commit -qam "park the fixture story"
  update 102 42 "/promote t $STORY"
  bot poll
  assert_eq "$(field status)" ready "status changed"
  assert_contains "$(git -C "$REPO" log -1 --format=%s)" "promoted" "and committed, which is what the queue reads"
  assert_contains "$(sent_text)" "ready" "the human is told"
}

# An update acknowledged once must never be replayed: /promote twice is
# harmless, but /run twice is a second drain. Red when the offset write is
# deleted.
case_65_bot_offset_advances() {
  CASE="65 an update is acted on once"; fixture c65
  update 500 42 "/status t"
  bot poll
  assert_eq "$(cat "$FLEET/.bot-offset" 2>/dev/null)" 501 "offset is one past the last update"
  assert_contains "$(api_calls)" 'offset=0' "the first poll started from 0"
  bot poll
  assert_contains "$(api_calls)" 'offset=501' "the second asked only for what follows"
}

# Phase E3. Auto-merge is allowed to change an epic branch without asking
# because undoing it is one word on a phone. This is that word.

revert_run() {                        # revert_run → RVLOG RVRC
  RVLOG="$FX/revert.log"
  ( cd "$FX" && env PUSH_STATUS=1 bash "$FLEET/fleet" revert t "$STORY" ) > "$RVLOG" 2>&1
  RVRC=$?
}

# Red when the revert, the push or the frontmatter cleanup is dropped:
# the epic keeps the merge, or fleet status goes on claiming a merge that
# is undone.
case_66_revert() {
  CASE="66 revert undoes the merge it recorded"; epic_story c66
  # A builder that changes a file, not an empty commit: reverting a merge that
  # carried no content is a no-op git refuses, and the case would be testing
  # the fixture rather than the revert.
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before_tree; before_tree="$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")"
  local before; before="$(epic_head)"
  merge_run
  assert_eq "$MRC" 0 "precondition: merged"
  [[ "$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")" != "$before_tree" ]] \
    && ok || fail "precondition: the merge changed the epic's content"

  revert_run
  assert_eq "$RVRC" 0 "exit code"
  assert_eq "$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")" "$before_tree" \
    "the epic's tree is exactly what it was before the merge"
  [[ "$(epic_head)" != "$before" ]] && ok || fail "by a new commit, not by moving the branch back"
  assert_not_grep '^merged:' "$REPO/.stories/$STORY.md" "and the story no longer claims it"
}

# Red when the recorded-sha check is deleted: reverting something that never
# merged would revert whatever HEAD happened to be.
case_67_revert_needs_a_merge() {
  CASE="67 revert refuses a story that never merged"; epic_story c67
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before; before="$(epic_head)"
  revert_run
  assert_eq "$RVRC" 1 "exit code (die)"
  assert_grep 'no recorded merge' "$RVLOG" "the message says why"
  assert_eq "$(epic_head)" "$before" "the epic did not move"
}

# The revert the merge notification offers has to be reachable from the same
# phone that received it, or the revert window is a window onto a laptop.
# Red when /revert is not in the dispatch table.
case_68_bot_revert() {
  CASE="68 /revert undoes a merge from the phone"; epic_story c68
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before_tree; before_tree="$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")"
  merge_run
  assert_eq "$MRC" 0 "precondition: merged"
  update 200 42 "/revert t $STORY"
  bot poll
  assert_eq "$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")" "$before_tree" "the epic is back"
  assert_contains "$(sent_text)" "reverted" "and the human is told"
}

# Phase E2. The launcher decides; the queue merges. A hand-run fleet launch
# never merges anything — that separation is what keeps a debugging session
# from changing a branch.

queue_run() {                         # queue_run [VAR=value…] → $FX/queue.log
  : > "$FX/notify.log"
  cat > "$FX/notify.sh" <<'EON'
printf '%s\n---\n' "$*" >> "$(dirname "$0")/notify.log"
EON
  queue FLEET_NOTIFY_CMD="bash $FX/notify.sh" \
      FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1 "$@"
}

# Red when the merge call is removed from the queue: the story reaches PASS and
# stops there, which is where the fleet has stopped for thirteen stories.
case_69_queue_merges_a_pass() {
  CASE="69 the queue merges a computed PASS and says how to undo it"; epic_story c69
  local before_tree; before_tree="$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")"
  queue_run
  assert_eq "$(field status)" done "the story passed"
  [[ "$(git -C "$REPO" rev-parse "origin/epic/test^{tree}")" != "$before_tree" ]] \
    && ok || fail "the epic has the story's change"
  assert_grep "merged" "$FX/notify.log" "the human is told it merged"
  assert_grep "/revert t $STORY" "$FX/notify.log" "and told the exact way to undo it"
}

# A FAIL must never merge, however the queue is feeling. Red when the verdict
# is read from the reviewer's prose instead of the computed line, or when the
# merge is called unconditionally.
case_70_queue_does_not_merge_a_fail() {
  CASE="70 the queue does not merge a story the machine vetoed"; epic_story c70
  local before; before="$(epic_head)"
  queue_run FAKE_REVIEWER=FAIL
  assert_eq "$(field status)" needs_human "the story stopped"
  assert_eq "$(epic_head)" "$before" "the epic did not move"
  assert_grep "needs_human|needs a human" "$FX/notify.log" "and the human is told it needs them"
}

# AUTO_MERGE=0 is the off switch. Red when it is not honoured — a fleet that
# cannot be told to stop merging is a fleet you turn off entirely.
case_71_auto_merge_can_be_turned_off() {
  CASE="71 AUTO_MERGE=0 leaves the merge to a human"; epic_story c71
  local before; before="$(epic_head)"
  queue_run AUTO_MERGE=0
  assert_eq "$(field status)" done "the story still passed"
  assert_eq "$(epic_head)" "$before" "but nothing merged"
}

# Phase F3. A lesson is prose, and prose cannot fail. What CAN fail is a
# lesson that claims an instrument it no longer has: rename a case, delete it,
# drop it from CASES, and docs/lessons.md goes on telling the next agent
# that the mistake is covered.
#
# This checks the working tree, not a fixture: it is about the files on disk,
# and a fixture would test whatever was last committed instead.
#
# Red when a lesson names a case that does not exist, or one that exists but
# is not in CASES and therefore never runs. Both observed, 18 Sep.
case_72_lessons_name_real_cases() {
  CASE="72 every lesson that claims an instrument still has it"
  local lessons="$FLEET_HOME/docs/lessons.md" lib="$FLEET_HOME/test/suite.sh"
  assert_file "$lessons" "the lessons file is where it is expected"
  local names cases_block missing="" unrun="" n
  cases_block="$(sed -n '/^CASES=(/,/)$/p' "$lib")"
  names="$(grep -oE '^\*\*Enforced by:\*\* `[a-zA-Z0-9_]+`' "$lessons" | tr -d '`' | awk '{print $NF}')"
  [[ -n "$names" ]] && ok || fail "no lesson declares an instrument — the check would be vacuous"
  while read -r n; do
    [[ -n "$n" ]] || continue
    grep -qE "^$n\(\)" "$lib" || { missing+="$n "; continue; }
    [[ "$n" == case_* ]] && ! grep -q "$n" <<< "$cases_block" && unrun+="$n "
  done <<< "$names"
  assert_eq "$missing" "" "lessons naming something that is not in the suite"
  assert_eq "$unrun"   "" "lessons naming a case that is not in CASES, so never runs"
}

# Phase E4. Epic → develop has never happened in fourteen stories: only
# story → epic and story → develop. An untested path is where the next
# surprise lives, so it gets the same post-merge baseline and a case.
#
# It stays human-run. The queue calls fleet merge with a story id and nothing
# else; nothing in the fleet calls --epic.
case_74_merge_epic_into_integration() {
  CASE="74 an epic merges into the integration branch, with the same baseline"; epic_story c74
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run
  assert_eq "$MRC" 0 "precondition: the story is on the epic"
  local before; before="$(git -C "$REPO" rev-parse origin/base)"

  MLOG="$FX/merge-epic.log"
  merge_epic "$MLOG"
  local rc=$?
  assert_eq "$rc" 0 "exit code"
  [[ "$(git -C "$REPO" rev-parse origin/base)" != "$before" ]] && ok || fail "the integration branch moved"
  git -C "$REPO" merge-base --is-ancestor origin/epic/test origin/base && ok \
    || fail "the epic is an ancestor of it"

  # Same guard as a story merge: a red post-merge baseline keeps it off.
  CASE="74b a red baseline keeps an epic off the integration branch"; epic_story c74b
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run
  before="$(git -C "$REPO" rev-parse origin/base)"
  merge_epic "$FX/merge-epic2.log" BUILD_CMD=false
  assert_eq "$?" 1 "exit code (die)"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$before" "the integration branch did not move"
}

# Red when --epic accepts anything that is not an epic branch: the same
# machinery pointed at main is the one thing this must never do.
case_75_merge_epic_refuses_non_epic() {
  CASE="75 --epic refuses a branch that is not an epic"; epic_story c75
  local before; before="$(git -C "$REPO" rev-parse origin/base)"
  local out; out="$( cd "$FX" && bash "$FLEET/fleet" merge t --epic base 2>&1 )"
  assert_contains "$out" "epic/" "the message says what it will take"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$before" "and nothing moved"
}

# Phase F1. Every story got the same builder at the same model: a one-line CSS
# fix and a service-worker rewrite cost the same. `model:` in the frontmatter
# is the smallest thing that changes that — the frontmatter reader and the
# BUILDER_MODEL seam both already exist.
#
# Red when the frontmatter is not consulted: the default model is used for a
# story that asked for another.
case_76_story_model() {
  CASE="76 a story may name the model that builds it"; fixture c76
  sed -i '2a model: fleet-test-model' "$REPO/.stories/$STORY.md"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep '^fleet-test-model$' "$TRACE/claude-args-1" "the builder ran on the story's model"
  assert_grep 'model: fleet-test-model' "$LOG" "and the run says so"
  # `model:` in the Machine block is the reviewer's VERDICT; the builder's
  # model is `builder:`. Two lines called model: in the one place a human
  # reads to decide is how a block stops being read.
  assert_grep '^builder:  fleet-test-model' "$REPO/.review/$STORY.md" "and the block records which model built it"

  CASE="76b a story that names none gets the default"; fixture c76b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep '^sonnet$' "$TRACE/claude-args-1" "the launcher's default model"
}

# Phase D1, the launcher's half. The queue notifies about merges; the launcher
# notifies about the states that stop a story, because a story can stop
# without a queue — a hand-run launcher left detached for an hour is exactly
# when nobody is watching.
#
# The notification lives in set_status rather than at each exit: there are
# five paths to needs_human today and the next one would be added without a
# notification.
#
# Red when the notify call is removed from set_status.
case_77_launcher_notifies_a_stop() {
  CASE="77 the launcher says when a story stops"; fixture c77
  cat > "$FX/notify.sh" <<'EON'
printf '%s\n---\n' "$*" >> "$(dirname "$0")/notify.log"
EON
  : > "$FX/notify.log"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1 \
      FLEET_NOTIFY_CMD="bash $FX/notify.sh"
  assert_eq "$(field status)" needs_human "the story stopped"
  assert_grep "$STORY" "$FX/notify.log" "the message names the story"
  assert_grep 'needs_human' "$FX/notify.log" "and the state it stopped in"

  CASE="77b a story that finishes is the queue's news, not the launcher's"; fixture c77b
  cat > "$FX/notify.sh" <<'EON'
printf '%s\n---\n' "$*" >> "$(dirname "$0")/notify.log"
EON
  : > "$FX/notify.log"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 \
      FLEET_NOTIFY_CMD="bash $FX/notify.sh"
  assert_eq "$(field status)" done "the story passed"
  assert_eq "$(wc -c < "$FX/notify.log")" 0 "and the launcher said nothing — merging is the queue's to announce"
}

# Phase C1/C2. Nothing recorded what a round cost. "Is a second lane worth
# it", "is a bigger model worth it for this story", "why did that take an
# hour" were all unanswerable, and each would have been answered by numbers
# the agents already return and the launcher was throwing away.
#
# Red when the raw builder object is not kept, or the timing line is dropped.
case_78_round_cost_is_recorded() {
  CASE="78 a round records what it cost"; fixture c78
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local ev="$REPO/.review/$STORY/round-1"
  assert_file "$ev/builder.json" "the builder's own object is kept, not just its prose"
  jq -e 'has("is_error")' >/dev/null 2>&1 < "$ev/builder.json" && ok \
    || fail "and it is the JSON the agent returned"
  assert_contains "$(tracked)" ".review/$STORY/round-1/builder.json" "committed with the rest of the evidence"
  assert_grep '^timing: ' "$REPO/.review/$STORY.md" "the machine block says what the round cost"
  assert_grep 'builder [0-9]+s' "$REPO/.review/$STORY.md" "per phase, in seconds"
  assert_grep 'total [0-9]+s' "$REPO/.review/$STORY.md" "and in total"
}

# Phase C4. The bot writes .stories/<id>.md and commits it in the main
# checkout; the launcher commits there too, on its own schedule. Two writers,
# one index. Without a lock the loser gets "Unable to create .git/index.lock"
# — and since 18 Sep a failed status commit is a die, so the loser is a dead
# round.
#
# The case makes the hazard deterministic rather than hoping to catch a race:
# a background holder takes the fleet lock AND leaves a real .git/index.lock
# behind it, exactly as a mid-commit git does. A writer that does not wait for
# the fleet lock walks into the index lock and fails.
#
# Red without the lock: /promote finds index.lock and the story never changes.
case_79_writers_do_not_collide() {
  CASE="79 a second writer waits rather than walking into a held index"; fixture c79
  sed -i '0,/^status:.*/s//status: draft/' "$REPO/.stories/$STORY.md"
  git -C "$REPO" commit -qam "park the fixture story"

  # The holder: take the fleet lock, plant an index.lock, hold both briefly.
  ( exec 9>"$REPO/.git/fleet.lock"
    flock 9
    : > "$REPO/.git/index.lock"
    sleep 3
    rm -f "$REPO/.git/index.lock" ) &
  local holder=$!
  sleep 0.5

  update 300 42 "/promote t $STORY"
  bot poll
  wait "$holder" 2>/dev/null

  assert_eq "$(field status)" ready "the promotion landed"
  assert_contains "$(git -C "$REPO" log -1 --format=%s)" "promoted" "as a commit, having waited its turn"
}

# Phase E4, the reading half. Stories are visible one at a time; an epic — the
# thing a human actually decides to merge — was visible nowhere. Red without
# --epics, and red again if it stops counting what is merged.
case_80_status_epics() {
  CASE="80 fleet status --epics says where each epic stands"; epic_story c80
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local out; out="$( status_run --epics )"
  assert_contains "$out" "epic/test" "the epic is listed"
  assert_contains "$out" "1 story" "with how many stories belong to it"
  assert_contains "$out" "0 merged" "and how many of them have landed on it"
  merge_run
  out="$( status_run --epics )"
  assert_contains "$out" "1 merged" "which changes when one does"
  assert_contains "$out" "ahead" "and says the epic is ahead of the integration branch"

  # 24 Sep: a story may name an epic before fleet new-epic has made it (024
  # on epic/search). Status said "in develop", as if it had landed. Red while
  # a missing branch reads as landed.
  CASE="80b an epic with no branch yet says so"; fixture c80b draft
  sed -i '2a base: epic/ghost' "$REPO/.stories/$STORY.md"
  out="$( status_run --epics )"
  assert_contains "$out" "no branch yet" "not 'in base'"
  assert_contains "$out" "fleet new-epic t ghost" "with the command that makes it"

  # 22 Oct (qr-desktop-scanner 005, 007): a story that has just started has a
  # branch cut at its epic's tip and no commit of its own yet, so the branch is
  # an ancestor of the epic, and the epic block counted it merged until the
  # builder's first commit (0, 1, 0 merged while the table said in_progress).
  # Red while the epic block counts by ancestry alone.
  CASE="80c a story still running is not counted merged on its epic"; epic_story c80c
  git -C "$REPO" branch "story/$STORY" epic/test
  sed -i '0,/^status:.*/s//status: in_progress/' "$REPO/.stories/$STORY.md"
  out="$( status_run --epics )"
  assert_contains "$out" "0 merged" "a branch with nothing of its own on it has not been merged"
}

# AC1. Red when the refresh call is deleted from ts/src/run-queue.ts: the
# checkout never learns the story is ready and the queue reports nothing ready.
# Also red when the refresh is replaced with `git pull --ff-only` (refused on
# divergence) or with `git reset --hard` (pre-run HEAD is no longer ancestor).
case_43_refresh_diverged() {
  CASE="43 story promoted on origin runs even with local-only commits"
  fixture c43 draft

  # Checkout adds a commit touching a different file; story stays draft.
  echo "local-only" > "$REPO/local-only.txt"
  git -C "$REPO" add local-only.txt
  git -C "$REPO" commit -qm "local: local-only file"
  local pre_head; pre_head="$(git -C "$REPO" rev-parse HEAD)"

  # Origin: promote story to ready via a second clone (simulates phone edit).
  git clone -q "$FX/origin.git" "$FX/origin2"
  git -C "$FX/origin2" config user.name  fleet-test
  git -C "$FX/origin2" config user.email fleet-test@localhost
  git -C "$FX/origin2" checkout -q base
  sed -i '0,/^status:.*/s//status: ready/' "$FX/origin2/.stories/$STORY.md"
  git -C "$FX/origin2" add ".stories/$STORY.md"
  git -C "$FX/origin2" commit -qm "phone: promote story to ready"
  git -C "$FX/origin2" push -q origin base

  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1

  assert_eq "$(field status)" done "AC1: story reached done"
  git -C "$REPO" merge-base --is-ancestor "$pre_head" HEAD \
    && ok || fail "AC1: pre-run HEAD is not an ancestor of new HEAD"
}

# AC2. Red when the failure branch exits or dies instead of continuing (the
# story is never run), or when the warning line is removed.
case_44_refresh_fail() {
  CASE="44 failed refresh does not stop the drain"; fixture c44

  # Break the origin URL so fetch fails immediately.
  git -C "$REPO" remote set-url origin "/no/such/path"

  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1

  assert_eq "$(field status)" done "AC2: story reached done despite fetch failure"
  local rfl; rfl="$(grep 'refresh failed' "$FX/queue.log" | head -1)"
  [[ -n "$rfl" ]] && ok || fail "AC2: queue log has no 'refresh failed' line"
  [[ "$rfl" == *"continuing on local state"* ]] \
    && ok || fail "AC2: 'refresh failed' line does not say 'continuing on local state'"
}

# AC3. Red when the queue leaves a conflicted merge in place (abort
# deleted), when -X theirs resolves it silently (no warning, conflict-file
# gets origin's version), or when the uncommitted edit is lost.
case_45_conflict_leaves_local_work() {
  CASE="45 conflicting refresh leaves local work unchanged"
  fixture c45
  printf 'line: original\n'  > "$REPO/conflict-file.txt"
  printf 'initial content\n' > "$REPO/clean.txt"
  git -C "$REPO" add conflict-file.txt clean.txt
  git -C "$REPO" commit -qm "fixture: files"
  git -C "$REPO" push -q origin base

  # Checkout: commit a change to conflict-file.txt; story stays ready.
  printf 'line: checkout\n' > "$REPO/conflict-file.txt"
  git -C "$REPO" add conflict-file.txt
  git -C "$REPO" commit -qm "local: checkout version"
  local pre_head; pre_head="$(git -C "$REPO" rev-parse HEAD)"

  # Uncommitted edit to a tracked file that neither commit touches.
  printf 'dirty\n' >> "$REPO/clean.txt"
  local clean_sum_before; clean_sum_before="$(sha256sum "$REPO/clean.txt" | awk '{print $1}')"

  # Origin: conflict on the same line of conflict-file.txt.
  git clone -q "$FX/origin.git" "$FX/origin2"
  git -C "$FX/origin2" config user.name  fleet-test
  git -C "$FX/origin2" config user.email fleet-test@localhost
  git -C "$FX/origin2" checkout -q base
  printf 'line: origin\n' > "$FX/origin2/conflict-file.txt"
  git -C "$FX/origin2" add conflict-file.txt
  git -C "$FX/origin2" commit -qm "origin: origin version"
  git -C "$FX/origin2" push -q origin base

  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1

  git -C "$REPO" merge-base --is-ancestor "$pre_head" HEAD \
    && ok || fail "AC3: pre-run HEAD is not an ancestor of new HEAD"
  assert_eq "$(git -C "$REPO" show HEAD:conflict-file.txt)" "line: checkout" \
    "AC3: committed conflict-file still has checkout version"
  assert_no_file "$REPO/.git/MERGE_HEAD" "AC3: no merge left in progress"
  [[ ! -d "$REPO/.git/rebase-merge" ]] && ok || fail "AC3: rebase-merge dir exists"
  assert_not_grep '<<<<<<<' "$REPO/conflict-file.txt" "AC3: no conflict markers in worktree"
  local clean_sum_after; clean_sum_after="$(sha256sum "$REPO/clean.txt" | awk '{print $1}')"
  assert_eq "$clean_sum_after" "$clean_sum_before" \
    "AC3: uncommitted edit is byte-identical (sha256sum)"
  assert_grep 'refresh failed' "$FX/queue.log" "AC3: queue log has refresh failed line"
  assert_eq "$(field status)" done "AC3: story reached done"
}

# P1 guard. Red when the MERGE_HEAD guard is removed from ts/src/run-queue.ts:
# the in-progress merge is aborted and the staged resolution is lost.
# Uses --max 0 so commitStatus never runs and MERGE_HEAD stays set.
case_81_existing_merge_preserved() {
  CASE="81 an in-progress merge resolution is not discarded by the refresh"
  fixture c81
  printf 'line: original\n' > "$REPO/conflict-file.txt"
  git -C "$REPO" add conflict-file.txt
  git -C "$REPO" commit -qm "fixture: files"
  git -C "$REPO" push -q origin base

  # Checkout: local commit that conflicts with origin.
  printf 'line: checkout\n' > "$REPO/conflict-file.txt"
  git -C "$REPO" add conflict-file.txt
  git -C "$REPO" commit -qm "local: checkout version"

  # Origin: conflicting change on the same line.
  git clone -q "$FX/origin.git" "$FX/origin2"
  git -C "$FX/origin2" config user.name  fleet-test
  git -C "$FX/origin2" config user.email fleet-test@localhost
  git -C "$FX/origin2" checkout -q base
  printf 'line: origin\n' > "$FX/origin2/conflict-file.txt"
  git -C "$FX/origin2" add conflict-file.txt
  git -C "$FX/origin2" commit -qm "origin: conflicting version"
  git -C "$FX/origin2" push -q origin base

  # Human: starts a conflicting merge, carefully resolves it, stages the fix.
  git -C "$REPO" fetch -q origin
  git -C "$REPO" merge --no-edit origin/base 2>/dev/null || true
  printf 'line: carefully resolved human work\n' > "$REPO/conflict-file.txt"
  git -C "$REPO" add conflict-file.txt
  # MERGE_HEAD now set; the resolution is staged but not committed.

  queue MAX=0

  assert_file "$REPO/.git/MERGE_HEAD" "AC81: MERGE_HEAD not aborted by refresh"
  assert_eq "$(git -C "$REPO" show :conflict-file.txt)" \
    "line: carefully resolved human work" "AC81: staged resolution preserved"
  assert_grep 'refresh skipped' "$FX/queue.log" "AC81: queue log shows refresh was skipped"
}

# ── run ──────────────────────────────────────────────────────────────────────

# lib.sh, sourced alone. load_repo is where the registry meets the target's
# config, and every refusal here is one a bot command or a typo can reach.
#
# Red without lib.sh, and red again when any refusal or the env-over-file
# rule is deleted.
case_82_load_repo() {
  CASE="82 load_repo: registry, config, env over file"
  local d="$TMP/c82" lib="${FLEET_LIB_OVERRIDE:-$FLEET_HOME/bin/lib.sh}" out rc
  # Each target in its own parent directory: siblings would share ../wt-<id>
  # and load_repo refuses them (case 89).
  mkdir -p "$d/repos" "$d/a/target/.fleet" "$d/b/target2"
  git init -q "$d/a/target"; git init -q "$d/b/target2"
  printf 'REPO_PATH=%s\n' "$d/a/target"  > "$d/repos/t.env"
  printf 'REPO_PATH=%s\n' "$d/b/target2" > "$d/repos/noconf.env"
  printf 'REPO_PATH=%s\n' "$d/c/nowhere" > "$d/repos/gone.env"
  cat > "$d/a/target/.fleet/config" <<'EOF'
BASE_BRANCH=base
INSTALL_CMD='true'
VITEST_CMD='fake vitest'
BUILD_CMD=true
LINT_CMD=true
SEED_FILES='.env.local extra.env'
PROBE_DIR=src
EOF
  probe() {                           # probe <repo-name> [VAR=value …] → out rc
    local name="$1"; shift
    out="$( env -i PATH="$PATH" HOME="$HOME" "$@" FLEET_REGISTRY_DIR="$d/repos" \
            bash -c 'source "$1" && load_repo "$2" && printf "%s|%s|%s|%s|%s\n" "$REPO_ROOT" "$BASE_BRANCH" "$VITEST_CMD" "${#SEED_FILES_ARR[@]}" "${SEED_FILES_ARR[1]}"' \
            _ "$lib" "$name" 2>&1 )"; rc=$?
  }
  probe t
  assert_eq "$rc" 0 "a registered repo with a config loads"
  assert_contains "$out" "$d/a/target|base|fake vitest|2|extra.env" "path, config values and the split seed list"

  probe nope;   assert_eq "$rc" 1 "an unregistered name dies";   assert_contains "$out" "unknown repo 'nope'" "and says so"
  probe '../t'; assert_eq "$rc" 1 "a path is not a repo name";   assert_contains "$out" "not a repo name" "and says so"
  probe gone;   assert_eq "$rc" 1 "a REPO_PATH that is not a git checkout dies"
  probe noconf; assert_eq "$rc" 1 "a target without .fleet/config dies"; assert_contains "$out" ".fleet/config" "and names the file"

  probe t BASE_BRANCH=fromenv VITEST_CMD='from env'
  assert_eq "$rc" 0 "still loads with overrides"
  assert_contains "$out" "$d/a/target|fromenv|from env|" "a variable in the environment wins over the file"

  sed -i '/^PROBE_DIR=/d' "$d/a/target/.fleet/config"
  probe t; assert_eq "$rc" 1 "a missing required key dies"; assert_contains "$out" "PROBE_DIR" "and names it"
  probe t PROBE_DIR=probes; assert_eq "$rc" 0 "unless the environment supplies it"

  # Plan of 20 Sep: how a repo lands. Absent means direct; pr needs the command.
  probe t PROBE_DIR=probes MERGE_MODE=pr
  assert_eq "$rc" 1 "MERGE_MODE=pr without PR_CMD dies"; assert_contains "$out" "PR_CMD" "and names the missing key"
  probe t PROBE_DIR=probes MERGE_MODE=bogus
  assert_eq "$rc" 1 "an unknown MERGE_MODE dies"; assert_contains "$out" "MERGE_MODE" "and names the key"
  probe t PROBE_DIR=probes MERGE_MODE=pr PR_CMD='echo url'
  assert_eq "$rc" 0 "pr with a command loads"
  printf 'MERGE_MODE=pr\nPR_CMD=echo\n' >> "$d/a/target/.fleet/config"
  probe t PROBE_DIR=probes MERGE_MODE=direct
  assert_eq "$rc" 0 "MERGE_MODE from the environment wins over the file, like every key"
}

# The harness sources <target>/.fleet/config. A builder that can change it on
# a story branch can change what the harness runs, so it is denied whether or
# not the story names it — the mirror image of the always-allowed .blocked/.
# And nothing of the harness's own is allow-listed any more: docs/fleet/ was a
# khaita convention, not a rule.
#
# Red when the .fleet/ check is deleted (83) or the docs/fleet allowance is
# restored (83b).
case_83_scope_fleet_config() {
  CASE="83 .fleet/* is denied whatever the story says"; fixture c83
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=.fleet/config FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" needs_human "story status"
  assert_grep '^scope: +VIOLATION \.fleet/config' "$REPO/.review/$STORY.md" "the config is named"

  CASE="83b docs/fleet/<id>-*.md is an ordinary path now"; fixture c83b
  mkdir -p "$REPO/docs/fleet"; printf 'notes\n' > "$REPO/docs/fleet/$STORY-notes.md"
  git -C "$REPO" add docs; git -C "$REPO" commit -qm "fixture: a docs file"; git -C "$REPO" push -q origin base
  set_deny 'docs/*'
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH="docs/fleet/$STORY-notes.md" FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" needs_human "story status"
  assert_grep "^scope: +VIOLATION docs/fleet/$STORY-notes.md" "$REPO/.review/$STORY.md" "no allowance for a docs path"
}

# Which files a fresh worktree must be given is the target's knowledge
# (khaita: .env.local, or the app talks to projects/undefined — story 002),
# so it comes from .fleet/config, and a target may have none.
#
# Red while SEED_FILES is a hardcoded array in the launcher: extra.env is
# never looked for (85), and .env.local is demanded of a target that has no
# seed files at all (85b).
case_85_seed_files_from_config() {
  CASE="85 the seed list is the target's, not the harness's"; fixture c85
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 SEED_FILES='.env.local extra.env'
  assert_eq "$RC" 1 "a seed file the target names and does not have stops the run"
  assert_grep 'extra.env is missing' "$LOG" "and it is named"

  CASE="85b an empty seed list is legal"; fixture c85b
  rm -f "$REPO/.env.local"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 SEED_FILES=
  assert_eq "$(field status)" done "nothing to seed, nothing to miss"
}

# A probe must land inside the target's test include glob or it collects no
# tests; where that is (khaita: src/__tests__) is the target's knowledge.
#
# Red while the destination is hardcoded (86), and when the launcher copies
# into a directory that is not there — cp fails, nothing notices, the probe
# silently never runs (86b).
case_86_probe_dir() {
  CASE="86 a probe lands in the target's PROBE_DIR"; fixture c86
  mkdir -p "$REPO/lib"; printf 'x\n' > "$REPO/lib/.keep"
  git -C "$REPO" add lib; git -C "$REPO" commit -qm "fixture: lib/"; git -C "$REPO" push -q origin base
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_PROBES=green MAX_ROUNDS=1 PROBE_DIR=lib
  assert_eq "$(field status)" done "precondition: the round completes"
  assert_grep 'vitest lib/fleet-probe-probe-green.test.tsx' "$TRACE/calls" "the selector is under PROBE_DIR"

  CASE="86b a PROBE_DIR the worktree does not have stops the run"; fixture c86b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_PROBES=green MAX_ROUNDS=1 PROBE_DIR=nowhere
  assert_eq "$RC" 1 "die"
  assert_grep 'nowhere' "$LOG" "naming the directory"
}

# The prompts used to name khaita's stack: "Run: npm test, npm run build,
# npm run lint" while the harness ran $VITEST_CMD/$BUILD_CMD/$LINT_CMD, and a
# "no firebase" rule for every target. The commands now come from the
# target's config, and a target may add its own rules through REPO_RULES.
#
# Red while review.md says npm (84), while rules.md has no {{REPO_RULES}}
# (84b), and when render_prompt starts refusing an empty REPO_RULES (84c).
case_84_prompts_carry_the_targets_facts() {
  CASE="84 the reviewer is told the target's commands, not npm's"; fixture c84
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep "baseline — $FLEET/test/fakes/vitest, true, true —" "$TRACE/codex-prompt-1" "the config's commands, in order"
  assert_not_grep 'npm test' "$TRACE/codex-prompt-1" "and not khaita's"
  # L-39: the reviewer is told the harness's result instead of re-running it.
  # Red while review.md asks it to run them again, or {{BASELINE}} is unfilled.
  assert_grep 'test GREEN \| build GREEN \| lint GREEN — the suite ran 2 tests, 0 failed\. Logs: .*/\.review/'"$STORY"'/round-1/baseline/' \
    "$TRACE/codex-prompt-1" "the reviewer is given the baseline's result and its logs"
  assert_grep 'Do not run the whole suite' "$TRACE/codex-prompt-1" "and asked not to run it again"

  CASE="84b REPO_RULES reaches the builder through the rules"; fixture c84b
  printf -- '- Never touch the SENTINEL_RULE_9f3 subsystem.\n' > "$REPO/.fleet/rules.md"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 REPO_RULES=.fleet/rules.md
  assert_grep 'SENTINEL_RULE_9f3' "$TRACE/claude-prompt-1" "the target's rule is in the builder prompt"
  assert_not_grep 'firebase' "$TRACE/claude-prompt-1" "khaita's rule is not"

  CASE="84c a target without REPO_RULES renders without a gap"; fixture c84c
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "the round completes"
  assert_not_grep '{{REPO_RULES}}' "$TRACE/claude-prompt-1" "no leftover placeholder"
  assert_not_grep 'unsubstituted' "$LOG" "and no warning about one"

  # 24 Sep: 025's round 1 passed its tests and failed the baseline on a
  # type error that only the build reports; the builder had never been told
  # the build or the lint exist. Red while the rules name only the tests.
  CASE="84d the builder is told the baseline's three commands"; fixture c84d
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep "baseline, on your final commit: $FLEET/test/fakes/vitest, then true, then true" "$TRACE/claude-prompt-1" "the target's test, build and lint commands, in the builder prompt"
}

# One fleet, many repos. `--all` walks the registry and drains each repo in
# turn, in a fresh process per repo so nothing — config, counters, a die —
# crosses from one to the next.
#
# Red when --all is not understood ("not a repo name"), or when the walk
# stops at the first repo.
case_87_queue_all_repos() {
  CASE="87 fleet run-queue --all drains every registered repo"; fixture c87
  # A second target, in its own directory, with its own origin and story 901.
  local U="$FX/two/repo-u"
  mkdir -p "$FX/two"
  cp -r "$FX/origin.git" "$FX/two/origin-u.git"
  git clone -q "$FX/two/origin-u.git" "$U"
  git -C "$U" config user.name fleet-test; git -C "$U" config user.email fleet-test@localhost
  sed -i "s/Story $STORY/Story 901/" "$U/.stories/$STORY.md"
  git -C "$U" mv ".stories/$STORY.md" .stories/901.md
  git -C "$U" commit -qam "fixture: story 901"
  git -C "$U" push -q origin base
  printf 'FLEET_TEST=1\n' > "$U/.env.local"
  printf 'REPO_PATH=%s\n' "$U" > "$FLEET/repos/u.env"

  QUEUE_TARGET=--all queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$QRC" 0 "exit code"
  assert_eq "$(field status)" done "repo t: story $STORY reached a verdict"
  assert_eq "$(frontmatter "$U/.stories/901.md" status)" done "repo u: story 901 reached a verdict"
  assert_eq "$(calls claude)" 2 "one builder run per repo"
  assert_grep 'repo: t' "$FX/queue.log" "the walk names each repo"
  assert_grep 'repo: u' "$FX/queue.log" "…and the next one"
}

# Two targets under one parent directory would share ../wt-<id>: story 014
# of one is story 014 of the other, as far as the worktree path is concerned.
# The registry is the only place that can see both, so load_repo refuses.
#
# Red when the check is deleted: the second entry loads without complaint.
case_89_shared_parent_dir_refused() {
  CASE="89 two registered repos in one parent directory are refused"; fixture c89
  git clone -q "$FX/origin.git" "$FX/repo-v"          # a sibling of repo/, same parent
  printf 'REPO_PATH=%s\n' "$FX/repo-v" > "$FLEET/repos/v.env"
  local out; out="$( cd "$FX" && bash "$FLEET/fleet" status t 2>&1 )"
  assert_eq "$?" 1 "load_repo dies"
  assert_contains "$out" "same parent directory" "and says why"
  assert_contains "$out" "v" "naming the other entry"
}

# L-27. The launcher no longer runs this suite, but a developer's shell can
# still export MAX_ROUNDS=1 and reproduce it exactly: cases 4, 5, 9 and 27
# need the two-round ceiling and would fail looking like real findings. The
# suite therefore re-executes itself under env -i with a short allowlist
# before any fixture is built. This case is the suite looking at its own
# environment — the only vantage point from which the leak is visible.
#
# Red when the re-exec at the top is deleted: MAX_ROUNDS=1 bash test/suite.sh 88
case_88_suite_env_is_clean() {
  CASE="88 the suite runs under a clean environment"
  local leaked="" v
  for v in MAX_ROUNDS BASE_BRANCH VITEST_CMD BUILD_CMD LINT_CMD INSTALL_CMD PUSH_STATUS AGENT_TIMEOUT; do
    [[ -v "$v" ]] && leaked+="$v "
  done
  assert_eq "$leaked" "" "launcher seams leaked into the suite's environment"
  [[ -n "${PATH:-}" ]] && ok || fail "PATH survived, or nothing would run"
  [[ -n "${HOME:-}" ]] && ok || fail "HOME survived, or git would have no identity"
}

# Plan of 20 Sep. From a phone an id means nothing and `done` covers three
# situations: waiting for a human, sitting on an epic, landed. The title comes
# from the story's heading; the landing state is derived from git and the
# computed verdict, never stored. The epic block leads the default output so
# what a human decides to merge is the first thing they read, and --bot is
# the phone form: no colour, the hint spelled as the bot command.
#
# Red without the title, without the derived state (a bare `done`), without
# the INTO column, without the epic line in the default output, and without
# --bot (usage, exit 2).
case_90_status_titles_and_landing() {
  CASE="90 fleet status: title, landing state, INTO, epic summary, --bot"; fixture c90
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  # A second story that has not run, so the table has one line per state.
  sed "s/Story $STORY/Story 901/; 0,/^status:.*/s//status: draft/" "$REPO/.stories/$STORY.md" \
    > "$REPO/.stories/901.md"
  local out; out="$( status_run )"
  assert_contains "$out" "TITLE" "the table has a title column"
  assert_contains "$out" "INTO" "and says where each story lands"
  assert_contains "$out" "fixture story" "the title, without its 'Story NNN:' prefix"
  assert_not_contains "$out" "Story $STORY:" "the prefix is stripped"
  assert_contains "$out" "awaiting merge" "a PASS nobody merged is awaiting merge"
  assert_contains "$out" "draft" "a story that has not run shows its frontmatter status as is"
  local j; j="$( status_run --json )"
  assert_eq "$(jq -r '.[0].title'   <<< "$j")" "fixture story"   "--json carries the title"
  assert_eq "$(jq -r '.[0].landing' <<< "$j")" "awaiting merge"  "and the landing state"
  assert_eq "$(jq -r '.[0].status'  <<< "$j")" done              "while status stays the frontmatter's"
  assert_eq "$(jq -r '.[1].landing' <<< "$j")" draft             "a draft's landing state is its status"
  # A phone wraps a <pre> block at ~40 columns, so --bot is not the table:
  # a short state line and the title on its own line, newest story first.
  local bot; bot="$( status_run --bot )"
  assert_not_contains "$bot" "TITLE" "--bot has no table header"
  assert_contains "$bot" $'-------\n'"$STORY fixture story"$'\n→ base | awaiting merge | R1 | PASS\n' \
    "a rule, id and title, one line with base, state, round and verdict"
  assert_contains "$bot" $'\n! worktree\n-------' "notes on their own line, then a rule"
  [[ "${bot%%$STORY*}" == *901* ]] && ok || fail "901 comes before $STORY: newest first"

  CASE="90b a story on an epic: on epic, then landed"; epic_story c90b
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  out="$( status_run )"
  assert_contains "$out" "epic/test" "INTO names the epic"
  assert_contains "$out" "awaiting merge" "not merged yet"
  merge_run
  assert_eq "$MRC" 0 "the story merged into its epic"
  out="$( status_run )"
  assert_contains "$out" "on epic" "merged into an epic that is not in the integration branch"
  assert_contains "$out" "1 merged" "the epic block leads the default output"
  assert_contains "$out" "fleet merge t --epic epic/test" "with the command a human runs to land it"
  local bot; bot="$( status_run --bot )"
  assert_contains "$bot" "/merge t epic/test" "--bot spells the hint as the phone command"
  assert_contains "$bot" $'\n→ epic/test | on epic | R1 | PASS\n' "and has the same state"
  assert_not_contains "$bot" $'\x1b[' "with no colour codes"
  local epics; epics="$( status_run --epics )"
  assert_contains "$epics" "epic/test" "--epics still prints the epic block"
  assert_not_contains "$epics" "on epic" "and nothing else"
  merge_epic "$FX/merge-epic.log"
  assert_eq "$?" 0 "the epic landed on the integration branch"
  out="$( status_run )"
  assert_contains "$out" "landed" "and the story is now landed"
  assert_eq "$(jq -r '.[0].landing' <<< "$( status_run --json )")" landed "--json agrees"
}

# Plan of 20 Sep. A table sent as plain text arrives in a proportional font
# and falls apart; inside <pre> it keeps its columns and scrolls sideways.
# Telegram caps a message at 4096 characters, so a long table goes as
# several messages split on line boundaries rather than one refused send.
#
# Red without --pre (no parse_mode, no <pre> in the argv) and without the
# split (one send for a table that cannot fit).
case_93_bot_status_pre() {
  CASE="93 /status arrives as a code block, split when it cannot fit"; fixture c93
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  update 110 42 "/status t"
  bot poll
  assert_eq "$(sent)" 1 "one message for a short table"
  assert_contains "$(sent_text)" "parse_mode=HTML" "sent as HTML"
  assert_contains "$(sent_text)" "text=<pre>" "inside a code block"
  assert_contains "$(sent_text)" "</pre>" "which is closed"
  assert_contains "$(sent_text)" "fixture story" "and carries the table"
  assert_not_contains "$(sent_text)" $'\x1b[' "with no colour codes"

  CASE="93 a table over the limit is split on line boundaries"; fixture c93-long
  local i long; long="$(printf 'a%.0s' {1..200})"
  for i in $(seq 901 925); do
    sed "s/Story $STORY: fixture story/Story $i: $long/" "$REPO/.stories/$STORY.md" > "$REPO/.stories/$i.md"
  done
  update 111 42 "/status t"
  bot poll
  assert_eq "$(sent)" 2 "two messages"
  local n; n="$(api_args | grep -c '^text=<pre>')"
  assert_eq "$n" 2 "each its own code block"
  # A row is never cut in half: every one of the 25 arrives as a whole line.
  assert_eq "$(api_args | grep -cE "(^|<pre>)9[0-9][0-9] $long\$")" 25 "every title arrived whole on its own line, one opening the second message"
}

# Plan of 20 Sep. fleet merge refuses the integration branch because the
# QUEUE must never land anything there. A human's word from a phone is a
# different thing: --land lifts that one refusal for this invocation. The
# queue never passes it, so auto-merge stays story → epic. main and master
# stay refused whatever the flag, and a story that lives on an epic is not
# landed one by one — its epic is, and the refusal says how.
#
# Red when --land is unknown or ignored, when it also lifts main, when it lets
# an epic story skip its epic, or when the queue starts passing it.
case_91_merge_land() {
  CASE="91 --land lands a PASS story on the integration branch, a human's call"; fixture c91
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before; before="$(git -C "$REPO" rev-parse origin/base)"
  merge_run
  assert_eq "$MRC" 1 "without --land the refusal of case 59 stands"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$before" "and the integration branch did not move"
  local nv; nv="$(grep -c '^vitest' "$TRACE/calls")"
  assert_grep '[-]-land' "$MLOG" "the refusal names the flag a human would pass"
  merge_run -- --land
  assert_eq "$MRC" 0 "with --land it merges"
  assert_eq "$(grep -c '^vitest' "$TRACE/calls")" $((nv + 1)) "after the post-merge baseline"
  [[ "$(git -C "$REPO" rev-parse origin/base)" != "$before" ]] && ok || fail "the integration branch moved"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base && ok || fail "and holds the story"
  local sha; sha="$(field merged)"
  [[ -n "$sha" ]] && git -C "$REPO" merge-base --is-ancestor "$sha" origin/base && ok \
    || fail "merged: records a sha that is in the integration branch"

  CASE="91b --land does not lift main"; fixture c91b
  git -C "$REPO" push -q origin base:main
  sed -i '2a base: main' "$REPO/.stories/$STORY.md"
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run -- --land
  assert_eq "$MRC" 1 "refused"
  assert_grep 'main' "$MLOG" "naming main"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/main && fail "main took the story" || ok

  CASE="91c a story on an epic is landed through its epic, not by --land"; epic_story c91c
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local ebefore; ebefore="$(epic_head)"
  merge_run -- --land
  assert_eq "$MRC" 1 "refused"
  assert_grep '[-]-epic epic/test' "$MLOG" "with the epic command named"
  # The launcher's own status commits move the integration branch; what must
  # not reach it is the story.
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base && fail "the integration branch took the story" || ok
  assert_eq "$(epic_head)" "$ebefore" "nor did the epic move"
  # Once it is on its epic the answer is the same command, not "already merged".
  merge_run
  assert_eq "$MRC" 0 "merged into its epic"
  merge_run -- --land
  assert_eq "$MRC" 1 "still refused with --land"
  assert_grep '[-]-epic epic/test' "$MLOG" "still naming the epic command"

  CASE="91d the queue still never lands a PASS story on the integration branch"; fixture c91d
  queue_run
  assert_eq "$(field status)" done "the story passed"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base && fail "the integration branch took the story" || ok
  assert_eq "$(field merged)" "" "nothing recorded"
}

# Plan of 20 Sep. A repo whose host wants a request rather than a push:
# MERGE_MODE=pr pushes the branch and runs PR_CMD in the target checkout with
# the source branch appended and PR_SOURCE/PR_TARGET in its environment; what
# it prints — the request's URL — is the reply. Nothing is merged and nothing
# recorded: the merge happens on the host and lands in origin/<base> like any
# human merge. Every refusal applies as in direct mode.
#
# Red when MERGE_MODE is ignored (a merge happens), when the branch is not
# pushed first, when the command does not get the branch, or when a refusal
# is skipped in pr mode.
case_92_merge_pr_mode() {
  CASE="92 MERGE_MODE=pr pushes the branch and opens a request instead of merging"; epic_story c92
  cat > "$FX/fake-pr.sh" <<'EOP'
printf 'args=%s\nsource=%s\ntarget=%s\ncwd=%s\n' "$*" "${PR_SOURCE:-}" "${PR_TARGET:-}" "$(pwd -P)" >> "$(dirname "$0")/pr.log"
echo "https://example.test/mr/1"
EOP
  local pr="bash $FX/fake-pr.sh"
  merge_run MERGE_MODE=pr PR_CMD="$pr"
  assert_eq "$MRC" 1 "a story that is not done is refused in pr mode too"
  assert_no_file "$FX/pr.log" "and no request was opened"

  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before nv; before="$(epic_head)"; nv="$(grep -c '^vitest' "$TRACE/calls")"
  merge_run MERGE_MODE=pr PR_CMD="$pr"
  assert_eq "$MRC" 0 "exit 0"
  git -C "$REPO" rev-parse --verify --quiet "origin/story/$STORY" >/dev/null && ok || fail "the story branch was pushed first"
  assert_grep "^args=story/$STORY\$" "$FX/pr.log" "the command got the branch appended"
  assert_grep "^source=story/$STORY\$" "$FX/pr.log" "and as PR_SOURCE"
  assert_grep '^target=epic/test$' "$FX/pr.log" "and the base as PR_TARGET"
  assert_grep "^cwd=$(cd "$REPO" && pwd -P)\$" "$FX/pr.log" "run in the target checkout"
  assert_contains "$(cat "$MLOG")" "https://example.test/mr/1" "what it printed is the output"
  assert_eq "$(epic_head)" "$before" "the epic did not move"
  assert_eq "$(field merged)" "" "nothing recorded in the story"
  assert_eq "$(grep -c '^vitest' "$TRACE/calls")" "$nv" "no post-merge baseline ran: the merge is the host's"

  CASE="92b an epic in pr mode"; rm -f "$FX/pr.log"
  merge_run
  assert_eq "$MRC" 0 "landed on the epic directly, so the epic is ahead"
  before="$(git -C "$REPO" rev-parse origin/base)"
  merge_epic "$FX/merge-epic.log" MERGE_MODE=pr PR_CMD="$pr"
  assert_eq "$?" 0 "exit 0"
  assert_grep '^args=epic/test$' "$FX/pr.log" "the epic is the source"
  assert_grep '^target=base$' "$FX/pr.log" "the integration branch the target"
  assert_contains "$(cat "$FX/merge-epic.log")" "https://example.test/mr/1" "the URL is the output"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$before" "the integration branch did not move"
}

# Plan of 20 Sep. Landing on the integration branch is a human's decision,
# and the phone is where the human is. /merge <repo> <id> is fleet merge
# with --land; /merge <repo> epic/<name> is --epic. fleet merge owns every
# refusal and the reply is what it said, colours stripped — in pr mode that
# is the request's URL.
#
# Red when /merge is an unknown verb, when the story form forgets --land
# (refused), or when the epic form is not wired.
case_93b_bot_merge() {
  CASE="93b /merge lands a story on the integration branch from the phone"; fixture c93b
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  update 120 42 "/merge t $STORY"
  bot poll
  wait_for_send 2
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base && ok || fail "the integration branch holds the story"
  assert_contains "$(sent_text)" "merged into base" "and the human is told"
  assert_not_contains "$(sent_text)" $'\x1b[' "without colour codes"

  CASE="93c /merge lands an epic"; epic_story c93c
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run
  assert_eq "$MRC" 0 "precondition: the story is on its epic"
  update 121 42 "/merge t epic/test"
  bot poll
  wait_for_send 2
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base && ok || fail "the integration branch holds the epic"
  assert_contains "$(sent_text)" "epic/test merged into base" "and the human is told"

  CASE="93d /merge with anything else is usage"; fixture c93d
  local before; before="$(git -C "$REPO" rev-parse origin/base)"
  update 122 42 "/merge t nope"
  bot poll
  assert_contains "$(sent_text)" "usage" "usage"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$before" "and nothing moved"
  update 123 42 "/merge t"
  bot poll
  assert_eq "$(sent)" 2 "a missing argument is answered too"
}

# Plan of 20 Sep. An epic was only a branch name a story's base: pointed at,
# and nothing enforced the name. Now the name is enforced where a story is
# born: fleet write-story takes --base epic/* only, fleet lint-story accepts
# a base that is absent, the integration branch, or epic/*, and fleet
# new-epic is the one way an epic branch comes into being — cut from
# origin's integration branch and pushed, so the next story can name it.
#
# Red when write-story accepts feat/x (the branch exists, so the old
# existence check passes and the agent runs), when lint-story accepts
# base: feat/x, and when new-epic is missing or accepts a second run or
# a name that is not a name.
case_94_epic_naming() {
  CASE="94 an epic is named epic/* at creation, and created by fleet new-epic"; fixture c94
  git -C "$REPO" push -q origin base:feat/x
  git -C "$REPO" push -q origin base:epic/test
  local out rc
  ws() {                              # ws <id> <base> → out rc
    out="$( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_BUILDER=nocommit \
            bash "$FLEET/fleet" write-story t "$1" "x" --base "$2" 2>&1 )"; rc=$?
  }
  ws 901 feat/x
  assert_eq "$rc" 1 "write-story refuses a base that is not epic/*"
  assert_contains "$out" "fleet new-epic" "and says how an epic is made"
  assert_eq "$(calls claude)" 0 "before any agent runs"
  ws 902 epic/test
  assert_eq "$(calls claude)" 1 "an epic/* base gets past the check to the agent"
  # 24 Sep: the writer names the alias, so a new Opus is picked up by the
  # CLI with no change here. Red while the default is a pinned id.
  assert_grep '^opus$' "$TRACE/claude-args-1" "the writer runs on the opus alias by default"

  local d="$FX/lint"; mkdir -p "$d"
  lint_base() {                       # lint_base <name> <base-line> → out rc
    printf -- '---\nstatus: ready\nround: 0\n%s\nscope_deny: src/x/*\n---\n# Story: %s\n## Acceptance criteria\n**AC1 — one bounded claim.** Goes red when removed.\n' "$2" "$1" > "$d/$1.md"
    out="$( cd "$FX" && bash "$FLEET/fleet" lint-story t "$d/$1.md" 2>&1 )"; rc=$?
  }
  lint_base feat "base: feat/x";     assert_eq "$rc" 1 "lint: base: feat/x is an error, although the branch exists"
  assert_contains "$out" "epic/" "naming the rule"
  lint_base epic "base: epic/test";  assert_eq "$rc" 0 "lint: base: epic/test is accepted"
  lint_base integ "base: base";      assert_eq "$rc" 0 "lint: the integration branch is accepted"
  lint_base none "";                 assert_eq "$rc" 0 "lint: no base is accepted"

  new_epic() {                        # new_epic <name> → out rc
    out="$( cd "$FX" && env PATH="$(FAKES)" bash "$FLEET/fleet" new-epic t "$1" 2>&1 )"; rc=$?
  }
  new_epic search
  assert_eq "$rc" 0 "new-epic creates an epic"
  assert_eq "$(git -C "$REPO" rev-parse --verify --quiet origin/epic/search)" "$(git -C "$REPO" rev-parse origin/base)" \
    "on origin, cut from origin's integration branch"
  assert_contains "$out" "epic/search" "and says so"
  assert_eq "$(git -C "$REPO" branch --show-current)" base "the checkout stays where it was"
  new_epic search
  assert_eq "$rc" 1 "a second time it refuses"
  assert_contains "$out" "exists" "and says why"
  new_epic 'bad name'
  assert_eq "$rc" 1 "a name with a space is refused"
  new_epic epic/x
  assert_eq "$rc" 1 "so is one that already carries the prefix"
  git -C "$REPO" rev-parse --verify --quiet origin/epic/epic/x >/dev/null && fail "nothing was created for it" || ok
}

# .stories lives on the integration branch; the code a story cites lives on its
# epic. Reading citations off the checkout therefore called every file an epic
# introduced "does not exist" and counted every changed file's lines from the
# wrong branch — six such lines on khaita's story 016, two of them errors. The
# cost is not the noise: a citation that really has rotted is indistinguishable
# from it.
case_98_lint_cites_resolve_against_base() {
  CASE="98 lint-story resolves citations against the story's base, not the checkout"; fixture c98
  local d="$FX/lint"; mkdir -p "$d"
  local out rc

  # An epic that adds a file and lengthens one the integration branch has. The
  # checkout stays on base, where the added file does not exist and the other
  # is a single line.
  git -C "$REPO" checkout -q -b epic/test
  printf 'a\nb\nc\nd\ne\nf\ng\nh\n' > "$REPO/src/added.ts"
  printf 'x\n%.0s' {1..40} > "$REPO/src/marker.txt"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "epic: one new file, one longer file"
  git -C "$REPO" push -q origin epic/test
  git -C "$REPO" checkout -q base
  [[ -e "$REPO/src/added.ts" ]] && fail "the checkout must not hold the epic's file" || ok
  assert_eq "$(wc -l < "$REPO/src/marker.txt")" 1 "and holds the short marker"

  story() {                           # story <name> <base-line> <citation prose>
    printf -- '---\nstatus: ready\nround: 0\n%s\nscope_deny: src/x/*\n---\n# Story: %s\n%s\n## Acceptance criteria\n**AC1 — one bounded claim.** Goes red when removed.\n' \
      "$2" "$1" "$3" > "$d/$1.md"
  }
  lint() { out="$(cd "$FX" && bash "$FLEET/fleet" lint-story t "$d/$1.md" 2>&1)"; rc=$?; }

  story onepic "base: epic/test" 'It cites `src/added.ts:5` and `src/marker.txt:35-40`.'
  lint onepic
  assert_eq "$rc" 0 "a file the epic adds, cited with a line, is not rot"
  assert_not_contains "$out" "added.ts" "and is not mentioned at all"
  assert_not_contains "$out" "marker.txt" "nor is a range only the epic's version reaches"
  assert_contains "$out" "checked against origin/epic/test" "and the summary says where it looked"

  story overrun "base: epic/test" 'It cites `src/marker.txt:41`.'
  lint overrun
  assert_eq "$rc" 1 "a range past the end of the epic version still fails"
  assert_contains "$out" "has 40 lines" "counted on the epic, not the 1 line the checkout has"

  story rotted "base: epic/test" 'It cites `src/gone.ts:3`.'
  lint rotted
  assert_eq "$rc" 1 "a file on neither branch still fails"
  assert_contains "$out" "gone.ts:3" "and is named"

  # No base: means the integration branch, and that resolves from git too.
  story integ "" 'It cites `src/marker.txt:2`.'
  lint integ
  assert_eq "$rc" 1 "with no base: the integration branch is the reference"
  assert_contains "$out" "has 1 lines" "which is where the count comes from"

  # Nothing to resolve against — a target whose base is on neither origin nor
  # local. The checkout is the last resort, which is where it began.
  printf 'only here\n' > "$REPO/src/untracked.ts"
  story loose "" 'It cites `src/untracked.ts:1`.'
  out="$(cd "$FX" && BASE_BRANCH=nosuch bash "$FLEET/fleet" lint-story t "$d/loose.md" 2>&1)"; rc=$?
  assert_eq "$rc" 0 "with no resolvable base ref it falls back to the checkout"
  rm -f "$REPO/src/untracked.ts"
}

# A merge runs the post-merge baseline — install, suite, build, lint. The poll
# that answers /merge is a systemd oneshot with TimeoutStartSec=2min, so running
# the merge inside it means systemd kills whichever merge is slower than that:
# khaita's epic/pwa merge died at exactly two minutes on 22 Sep 2026 with its
# worktree left behind, nothing landed, and no reply. The poll must answer and
# get out of the way.
case_99_bot_merge_detaches() {
  CASE="99 /merge answers at once and reports when the merge ends"; fixture c99
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1

  # A baseline slower than the poll, so "the merge has not finished yet" is a
  # fact about this case rather than a race it happens to win.
  # Slow, then the ordinary fake — the baseline reads the JSON report it
  # writes, so a bare sleep would just look like a red suite.
  printf '#!/usr/bin/env bash\nsleep 3\nexec vitest "$@"\n' > "$FX/slow-vitest"
  chmod +x "$FX/slow-vitest"

  update 120 42 "/merge t $STORY"
  local started elapsed
  started="$(date +%s)"
  VITEST_CMD="$FX/slow-vitest" bot poll
  elapsed=$(( $(date +%s) - started ))

  (( elapsed < 3 )) && ok || fail "the poll returned before the baseline could finish (took ${elapsed}s)"
  assert_eq "$(sent)" 1 "one message so far — the acknowledgement"
  assert_contains "$(sent_text)" "merging" "which says the merge is running"
  assert_not_contains "$(sent_text)" "merged into base" "and does not claim it has landed"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base \
    && fail "nothing has landed yet" || ok

  wait_for_send 2
  assert_contains "$(sent_text)" "merged into base" "the result arrives on its own"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base && ok || fail "and the merge really happened"
}

# The phone is not a terminal. Every verb but /run and /help takes the repo
# first, and with one repo registered naming it each time is ceremony that
# turns /why 012 into "unknown repo '012'" — the registry path is a true
# answer to a question nobody asked. With exactly one repo the words shift
# right and that repo is used; with several nothing is guessed.
case_95_bot_help_and_repo_default() {
  CASE="95 /help groups the verbs and says what each does"; fixture c95
  update 120 42 "/help"
  bot poll
  assert_eq "$(sent)" 1 "one message"
  local t; t="$(sent_text)"
  assert_contains "$t" "/status-all" "names status-all"
  assert_contains "$t" "/repo" "names repo"
  assert_contains "$t" "/promote" "names promote"
  assert_contains "$t" "/merge" "names merge"
  assert_contains "$t" "/revert" "names revert"
  assert_contains "$t" "/run" "names run"
  assert_contains "$t" "Look" "a group heading"
  assert_contains "$t" "Land" "another group heading"

  CASE="95 an unknown verb answers with the same help"; fixture c95-unknown
  update 121 42 "/nope"
  bot poll
  assert_contains "$(sent_text)" "/status-all" "the fallback is the help"

  CASE="95 with one repo registered the repo may be left out"; fixture c95-one
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  update 122 42 "/why $STORY"
  bot poll
  assert_not_contains "$(sent_text)" "unknown repo" "no registry error"
  assert_contains "$(sent_text)" "computed" "the machine block came back"

  api_clear
  CASE="95 /status with no repo at all uses the only one"
  update 123 42 "/status"
  bot poll
  assert_contains "$(sent_text)" "fixture story" "the table came back"

  api_clear
  CASE="95 a misspelt repo is told so, not read as a story id"
  update 124 42 "/why nosuch $STORY"
  bot poll
  assert_contains "$(sent_text)" "unknown repo: nosuch" "it names what was not found"
  assert_contains "$(sent_text)" "known: t" "and what is registered"
  assert_not_contains "$(sent_text)" "no such story" "it did not shift a name into the id slot"
}

# /status is the view a human reads on a phone between rounds: what still
# wants attention. A landed story wants none, and after fourteen of them the
# two that matter are below the fold. /status-all keeps the whole history one
# command away.
case_96_bot_status_hides_landed() {
  CASE="96 /status hides what has landed"; fixture c96
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run -- --land
  assert_eq "$MRC" 0 "the story landed"
  cat > "$REPO/.stories/901.md" <<'EOS'
---
status: ready
round: 0
---

# Story 901: still going
EOS
  git -C "$REPO" add .stories/901.md
  git -C "$REPO" commit -q -m "story 901"
  update 130 42 "/status t"
  bot poll
  assert_contains "$(sent_text)" "still going" "the open story is shown"
  assert_not_contains "$(sent_text)" "fixture story" "the landed one is not"

  api_clear
  CASE="96 /status-all shows it again"
  update 131 42 "/status-all t"
  bot poll
  assert_contains "$(sent_text)" "fixture story" "the landed story is back"
  assert_contains "$(sent_text)" "still going" "and the open one too"
  assert_contains "$(sent_text)" "text=<pre>" "still a code block"

  api_clear
  CASE="96 with nothing in flight /status says so"; fixture c96-empty
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run -- --land
  update 132 42 "/status t"
  bot poll
  assert_contains "$(sent_text)" "status-all" "it names the command that shows them"
}

# A human who has forgotten a repo's name cannot ask the bot today: every
# verb needs the name they are missing.
case_97_bot_repo_list() {
  CASE="97 /repo lists the registry"; fixture c97
  update 140 42 "/repo"
  bot poll
  assert_eq "$(sent)" 1 "one message"
  assert_contains "$(sent_text)" "$REPO" "names the checkout it points at"
  assert_not_contains "$(sent_text)" "unknown repo" "it needs no repo of its own"
}

# A1 (22 Sep). The builder hands its TDD evidence to the verdict and learns
# one round later whether a patch applied or a selector named a test.
# fleet check-mutation <repo> <patch…> [--wt <dir>] runs the verdict's own
# classifier — the same runSelector, the same classes — on the builder's
# committed tree, restores with git apply -R, and exits 0 only when every
# patch is RED. Red while the command does not exist.
case_100_check_mutation() {
  CASE="100 fleet check-mutation classifies like the verdict"; fixture c100
  local m="$REPO/.review-out/mutations" before out rc
  mkdir -p "$m"
  printf '\nFLEET_MUTANT_MARKER\n' >> "$REPO/src/marker.txt"
  git -C "$REPO" diff -- src/marker.txt > "$m/AC1-tdd-marker.patch"
  git -C "$REPO" checkout -q -- src/marker.txt
  printf 'fake.test.tsx\n' > "$m/AC1-tdd-marker.test"
  before="$(git -C "$REPO" hash-object src/marker.txt)"

  check() {                           # check <class> <rc> <label> [VAR=value …] — from $FX, the tree named by --wt
    local cls="$1" erc="$2" label="$3" patch="${PATCH:-AC1-tdd-marker}"; shift 3
    out="$( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_VITEST=marker "$@" \
            bash "$FLEET/fleet" check-mutation t "$m/$patch.patch" --wt "$REPO" 2>&1 )"; rc=$?
    assert_eq "$(printf '%s\n' "$out" | grep -E '^[A-Z_]+ +AC1' | tail -n1)" "$cls $patch" "$label: class line"
    assert_eq "$rc" "$erc" "$label: exit code"
    assert_eq "$(git -C "$REPO" hash-object src/marker.txt)" "$before" "$label: the real file is restored byte for byte"
    assert_eq "$(git -C "$REPO" status --porcelain | grep -v '^?? .review-out/')" "" "$label: tree clean afterwards"
  }
  check RED              0 "caught"               FAKE_VITEST=marker
  check GREEN            1 "survived"             FAKE_VITEST=pass
  check NO_TESTS         1 "broke compilation"    FAKE_VITEST=marker-notests
  check PRE_RED          1 "instrument already red" FAKE_VITEST=fail
  check SELECTOR_INVALID 1 "selector names no test" FAKE_VITEST=notests
  printf -- '--- a/nope.txt\n+++ b/nope.txt\n@@ -1 +1 @@\n-x\n+y\n' > "$m/AC1-bad.patch"
  printf 'fake.test.tsx\n' > "$m/AC1-bad.test"
  PATCH=AC1-bad check PATCH_INVALID 1 "patch does not apply"
  rm "$m/AC1-bad.test"
  PATCH=AC1-bad check NO_SELECTOR   1 "no selector beside the patch"

  # Two patches at once: one line each, exit 1 because one is not RED.
  out="$( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_VITEST=marker \
          bash "$FLEET/fleet" check-mutation t "$m/AC1-tdd-marker.patch" "$m/AC1-bad.patch" --wt "$REPO" 2>&1 )"; rc=$?
  assert_contains "$out" "RED AC1-tdd-marker" "two patches: first classified"
  assert_contains "$out" "NO_SELECTOR AC1-bad" "two patches: second classified"
  assert_eq "$rc" 1 "two patches: exit 1 when any is not RED"

  # The default tree is the cwd, as a builder runs it.
  out="$( cd "$REPO" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_VITEST=marker \
          bash "$FLEET/fleet" check-mutation t .review-out/mutations/AC1-tdd-marker.patch 2>&1 )"; rc=$?
  assert_contains "$out" "RED AC1-tdd-marker" "cwd is the tree when --wt is absent"
  assert_eq "$rc" 0 "and it exits 0"

  # An uncommitted change is refused before anything runs: the safe point is
  # a commit, and a restore over uncommitted work is how real fixes got lost.
  local calls; calls="$(grep -c '^vitest' "$TRACE/calls")"
  printf 'uncommitted\n' >> "$REPO/README.md"
  out="$( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_VITEST=marker \
          bash "$FLEET/fleet" check-mutation t "$m/AC1-tdd-marker.patch" --wt "$REPO" 2>&1 )"; rc=$?
  assert_eq "$rc" 1 "dirty tree: exit 1"
  assert_contains "$out" "README.md" "dirty tree: names the path"
  assert_eq "$(grep -c '^vitest' "$TRACE/calls")" "$calls" "dirty tree: nothing ran"
  assert_grep 'uncommitted' "$REPO/README.md" "dirty tree: the uncommitted work is untouched"
}

# A1 (22 Sep). The builder is told, in its rules, to run fleet check-mutation
# on its own TDD evidence before it finishes — with the repo name rendered
# in, so the line is runnable as printed. Red while rules.md does not say so.
case_101_builder_told_to_check_evidence() {
  CASE="101 the builder's rules name fleet check-mutation for this repo"; fixture c101
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep "bash $FLEET/fleet check-mutation t " "$TRACE/claude-prompt-1" "the helper, with this fleet's path and this repo's name"
  assert_grep 'tdd-\*\.patch' "$TRACE/claude-prompt-1" "applied to the builder's own tdd- patches"
  assert_not_grep '{{CHECK_MUTATION}}' "$TRACE/claude-prompt-1" "no leftover placeholder"
  assert_not_grep 'unsubstituted' "$LOG" "and no warning about one"
}

# A2 (22 Sep). 20 of the 24 FAIL rounds since 007 were the reviewer's probes
# going red or the reviewer's mutations surviving: the builder never saw the
# attack it would face. The reviewer's checks and the machine's vocabulary
# now sit in the builder's rules, in round 1 and in round 2. Red while
# rules.md carries neither.
case_102_builder_sees_the_reviewers_attack() {
  CASE="102 the builder's rules carry the reviewer's checks"; fixture c102
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL FAKE_VITEST=pass
  assert_eq "$(calls claude)" 2 "two rounds ran"
  local n
  for n in 1 2; do
    assert_grep 'behaviour under test outright' "$TRACE/claude-prompt-$n" "round $n: the delete-it-outright check"
    assert_grep 'PROBE' "$TRACE/claude-prompt-$n" "round $n: told what a probe is"
    assert_grep 'SELECTOR_INVALID' "$TRACE/claude-prompt-$n" "round $n: the machine vocabulary"
  done
}

# L-40 (17 Oct). Each criterion's "Goes red when" list is what the reviewer
# writes its mutations from, and the builder never applied one: khaita 113
# round 1 failed on a locator its test created and never asserted, which
# the story's own item would have shown red in seconds; 114 round 1 failed
# on an item no implementation could make red, which the builder found only
# in round 2 and then blocked on. The rules now have it apply one item per
# criterion, see the test go red, undo it, and block when the story's own
# instrument cannot show the item. Red while rules.md does not say so.
case_156_builder_checks_the_storys_red_list() {
  CASE="156 the builder's rules have it apply one of each criterion's Goes-red items"; fixture c156
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL FAKE_VITEST=pass
  assert_eq "$(calls claude)" 2 "two rounds ran"
  local n
  for n in 1 2; do
    assert_grep 'take ONE item per criterion' "$TRACE/claude-prompt-$n" "round $n: one item per criterion"
    assert_grep 'not the change your tdd- patch for' "$TRACE/claude-prompt-$n" "round $n: one the tdd- patch does not already prove"
    assert_grep 'cheapest to run' "$TRACE/claude-prompt-$n" "round $n: the cheapest of the rest"
    assert_grep 'undo the change .*Commit nothing from' "$TRACE/claude-prompt-$n" "round $n: nothing committed from it"
    assert_grep 'the story claims more than that$' "$TRACE/claude-prompt-$n" "round $n: and a story that claims too much is a question"
  done
}

# A4 (22 Sep). The reviewer ran on whatever ~/.codex/config.toml defaulted
# to; nothing could name a model for it, so a quota outage on that one
# model stranded every story. REVIEWER_MODEL is the seam, recorded in the
# Machine block beside builder:. Red while codex is called without -m.
case_103_reviewer_model() {
  CASE="103 REVIEWER_MODEL names the reviewer's model"; fixture c103
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 REVIEWER_MODEL=fleet-test-reviewer
  assert_grep '^-m$' "$TRACE/codex-args-1" "codex got -m"
  assert_grep '^fleet-test-reviewer$' "$TRACE/codex-args-1" "with the model"
  assert_grep '^reviewer: codex fleet-test-reviewer$' "$REPO/.review/$STORY.md" "the block records which model reviewed"

  CASE="103b unset, codex keeps its own default"; fixture c103b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_not_grep '^-m$' "$TRACE/codex-args-1" "no -m"
  assert_grep '^reviewer: codex$' "$REPO/.review/$STORY.md" "the block says so"
}

# B2 (22 Sep). The coordinator's procedures are skills/<name>/SKILL.md,
# one format two harnesses read: Claude Code from ~/.claude/skills/<name>,
# Codex from ~/.codex/skills/<name>. install-skills.sh symlinks them into
# both, is idempotent, and refuses to replace anything that is not its own
# symlink. Red while the script does not exist.
case_104_install_skills() {
  # 24 Sep: Codex gets the fleet skills from the fleet repo's .agents/skills
  # (project scope), not from $CODEX_HOME/skills: the unattended reviewer is
  # codex in a target's worktree, and it loaded the coordinator's procedures
  # (fleet-coordinate, fleet-verdict) into every review of 020 and 025.
  # Red while install-skills.sh links into $CODEX_HOME/skills, or leaves the
  # links an older run made there, or the repo has no .agents/skills.
  CASE="104 install-skills.sh: Claude Code gets every skill; Codex only inside the fleet repo"; fixture c104
  local H="$FX/home" out rc n
  mkdir -p "$H"
  out="$( cd "$FX" && HOME="$H" bash "$FLEET/fleet" install-skills 2>&1 )"; rc=$?
  assert_eq "$rc" 0 "exit 0"
  n="$(ls -d "$FLEET"/skills/*/ | wc -l)"
  assert_eq "$(find "$H/.claude/skills" -maxdepth 1 -type l | wc -l)" "$n" "one link per skill for Claude Code"
  assert_eq "$(readlink -f "$H/.claude/skills/fleet-story")" "$(readlink -f "$FLEET/skills/fleet-story")" "the link points at the fleet's copy"
  assert_eq "$(find "$H/.codex/skills" -maxdepth 1 -name 'fleet-*' 2>/dev/null | wc -l)" 0 "no fleet skill in Codex's home, where every codex run would load it"
  assert_eq "$(readlink -f "$FLEET/.agents/skills")" "$(readlink -f "$FLEET/skills")" "the fleet repo's .agents/skills is skills/"
  assert_grep '^name: fleet-story$' "$FLEET/.agents/skills/fleet-story/SKILL.md" "readable there, with the frontmatter Codex reads"

  out="$( cd "$FX" && HOME="$H" bash "$FLEET/fleet" install-skills 2>&1 )"; rc=$?
  assert_eq "$rc" 0 "second run: exit 0"
  assert_eq "$(find "$H/.claude/skills" -maxdepth 1 -type l | wc -l)" "$n" "second run: still one link per skill"

  # The links an older install made in Codex's home are ours: removed. A
  # directory there that is not our symlink is someone's work: left alone.
  mkdir -p "$H/.codex/skills"
  ln -s "$FLEET/skills/fleet-story" "$H/.codex/skills/fleet-story"
  mkdir -p "$H/.codex/skills/fleet-land"; printf 'theirs\n' > "$H/.codex/skills/fleet-land/SKILL.md"
  mkdir -p "$H/.codex/skills/security-review"; printf 'a reviewer skill\n' > "$H/.codex/skills/security-review/SKILL.md"
  out="$( cd "$FX" && HOME="$H" bash "$FLEET/fleet" install-skills 2>&1 )"; rc=$?
  assert_eq "$rc" 0 "exit 0"
  assert_eq "$(test -e "$H/.codex/skills/fleet-story" && echo present || echo gone)" gone "our old Codex link is removed"
  assert_grep '^theirs$' "$H/.codex/skills/fleet-land/SKILL.md" "a directory that is not ours stays"
  assert_grep '^a reviewer skill$' "$H/.codex/skills/security-review/SKILL.md" "and so does any other Codex skill"

  # A directory in Claude's home that is not our symlink: refused, named.
  rm "$H/.claude/skills/fleet-land"; mkdir -p "$H/.claude/skills/fleet-land"; printf 'theirs\n' > "$H/.claude/skills/fleet-land/SKILL.md"
  out="$( cd "$FX" && HOME="$H" bash "$FLEET/fleet" install-skills 2>&1 )"; rc=$?
  assert_eq "$rc" 1 "a foreign directory: exit 1"
  assert_contains "$out" "fleet-land" "names it"
  assert_grep '^theirs$' "$H/.claude/skills/fleet-land/SKILL.md" "and leaves it alone"
}

# The fixture is a copy of the working tree, once per case. ts/node_modules
# must not come along (size, and the proof that nothing under ts/ needs it at
# run time); everything else must. Exercised on a synthetic tree so it can go
# red whether or not anything is installed here. Red while copy_fleet is cp -r.
case_105_fixture_excludes_node_modules() {
  CASE="105 the fixture carries no ts/node_modules"; fixture c105
  local src="$FX/src-tree" dst="$FX/dst-tree"
  mkdir -p "$src/ts/node_modules/typescript" "$src/ts/src/lib" "$src/.git" "$src/repos"
  printf 'x\n' > "$src/ts/node_modules/typescript/package.json"
  printf 'export {}\n' > "$src/ts/src/lib/a.ts"
  printf '# fleet\n' > "$src/fleet"; printf 'token\n' > "$src/.env.fleet"
  copy_fleet "$src" "$dst"
  assert_no_file "$dst/ts/node_modules/typescript/package.json" "node_modules left behind"
  [[ -d "$dst/ts/node_modules" ]] && fail "ts/node_modules directory copied" || ok
  assert_file "$dst/ts/src/lib/a.ts" "ts/src copied"
  assert_file "$dst/fleet" "the entry point copied"
  assert_no_file "$dst/.env.fleet" "machine-local token not copied"
  [[ -d "$dst/.git" || -d "$dst/repos" ]] && fail ".git or repos copied" || ok
}

# One classifier. The verdict (fleet launch) and a builder's own check
# (fleet check-mutation) both reach ts/src/lib/vitest-json.ts, the one place
# a runner's JSON becomes a class. Replace that file with a stub that answers
# GREEN to everything: a marker mutation the fake runner would catch must
# then come out GREEN from both, and the veto must follow. Red when either
# caller turns a runner's JSON into a class without vitest-json.ts.
case_106_one_classifier() {
  CASE="106 the verdict and fleet check-mutation share one classifier"; fixture c106
  cat > "$FLEET/ts/src/lib/vitest-json.ts" <<'STUB'
import type { RunClass } from './types.ts';
export function classFromVitestJson(_text: string | undefined): RunClass { return 'GREEN'; }
export function readVitestJson(_path: string): string | undefined { return ''; }
STUB
  local m="$REPO/.review-out/mutations" out rc
  mkdir -p "$m"
  printf '\nFLEET_MUTANT_MARKER\n' >> "$REPO/src/marker.txt"
  git -C "$REPO" diff -- src/marker.txt > "$m/AC1-tdd-marker.patch"
  git -C "$REPO" checkout -q -- src/marker.txt
  printf 'fake.test.tsx\n' > "$m/AC1-tdd-marker.test"
  out="$( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_VITEST=marker \
          bash "$FLEET/fleet" check-mutation t "$m/AC1-tdd-marker.patch" --wt "$REPO" 2>&1 )"; rc=$?
  assert_contains "$out" "GREEN AC1-tdd-marker" "check-mutation gives the stub's answer"
  assert_eq "$rc" 1 "and exits 1"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep '^AC1 +GREEN +marker' "$REPO/.review/$STORY.md" "the verdict gives the stub's answer"
  assert_eq "$(review_line 3)" "verdict: FAIL" "and the veto follows"
}

# A probe's class is only as good as the run behind it: a runner that failed
# to start, taken unchecked, would leave the class empty, the .result empty,
# the probe row without a class, and the veto nothing to look at — a silent
# PASS marked done. Break the runner for probes only (a probe's selector path
# carries fleet-probe-; mutations do not) and the launcher must stop, not
# finish. Red when runProbes (ts/src/lib/evidence.ts) carries on past a
# runSelector that threw.
case_107_probe_runner_failure_is_not_a_pass() {
  CASE="107 a failing probe runner stops the round rather than passing it"; fixture c107
  sed -i "s|^export function runBashTo(line: string, o: BashToOptions): number {|&\n  if (line.includes('fleet-probe-')) throw new Error('injected: probe runner failure');|" "$FLEET/ts/src/lib/proc.ts"
  grep -q 'injected: probe runner failure' "$FLEET/ts/src/lib/proc.ts" || { fail "the injection did not land — proc.ts changed shape"; return; }
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_PROBES=green MAX_ROUNDS=1
  [[ "$RC" -ne 0 ]] && ok || fail "the launcher exited 0 with a broken probe runner"
  [[ "$(field status)" != done ]] && ok || fail "the story was marked done"
  assert_not_grep '^verdict: PASS' "$REPO/.review/$STORY.md" "no PASS was written"
  assert_grep 'probe runner' "$LOG" "the log says which runner failed"
}

# One verdict. The rule — reasons, veto — is ts/src/lib/verdict.ts and
# nothing else; the launcher only carries the answer. Replace that file with
# a rule that says PASS to everything and a round the real rule would veto
# (a GREEN mutation under a reviewer PASS) must come out PASS, done, with an
# empty computed line. Red when the launcher vetoes anywhere but
# ts/src/lib/verdict.ts.
case_108_one_verdict() {
  CASE="108 the launcher's verdict is computed by ts/src/lib/verdict.ts"; fixture c108
  cat > "$FLEET/ts/src/lib/verdict.ts" <<'STUB'
export function computeVerdict(_i: unknown): { model: 'PASS'; computed: 'PASS'; reasons: string[] } {
  return { model: 'PASS', computed: 'PASS', reasons: [] };
}
STUB
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_VITEST=pass MAX_ROUNDS=1
  assert_eq "$RC" 0 "the launcher finished"
  assert_eq "$(field status)" done "the stub's PASS stood"
  assert_eq "$(review_line 3)" "verdict: PASS" "verdict line"
  assert_grep '^computed: PASS$' "$REPO/.review/$STORY.md" "no reasons, no veto"
  assert_grep '^AC1 +GREEN +marker' "$REPO/.review/$STORY.md" "the survivor is still in the table"
}

# One config loader. fleet status (and, from case 110, fleet check-mutation)
# run as `node ts/src/bin/<x>.ts`, and the only way from there to the
# target's .fleet/config is ts/src/lib/config.ts — which runs lib.sh's
# load_repo in a child bash. Replace that module with one that throws and
# the entry point must fail with its text. Then, with the real module, the
# things the entry point must keep: success is silent on stderr (the bot
# merges stderr into the reply), load_repo runs before the flag loop (an
# unknown repo exits 1 even with a bad flag; a bad flag alone exits 2). Red
# when ts/src/bin/status.ts reaches the config other than through
# ts/src/lib/config.ts: it answers as usual.
config_stub() {                       # config_stub — ts/src/lib/config.ts that throws on load
  cat > "$FLEET/ts/src/lib/config.ts" <<'STUB'
export class ConfigError extends Error { readonly alreadyReported = false; }
export function loadRepo(_home: string, _name: string, _o?: unknown): never {
  throw new Error('fleet-test: config stub reached');
}
STUB
}
case_109_status_through_the_loader() {
  CASE="109 fleet status reaches the target through ts/src/lib/config.ts"; fixture c109
  config_stub
  local out rc err
  out="$( cd "$FX" && bash "$FLEET/fleet" status t --json 2>&1 )"; rc=$?
  assert_contains "$out" "fleet-test: config stub reached" "status --json went through the loader"
  assert_eq "$rc" 1 "and failed with it"
  fixture c109b
  err="$FX/status.err"
  out="$( cd "$FX" && bash "$FLEET/fleet" status t --json "$STORY" 2>"$err" )"; rc=$?
  assert_eq "$rc" 0 "the real loader: --json exits 0"
  assert_eq "$(jq -r '.[0].id' <<< "$out")" "$STORY" "and names the story"
  assert_eq "$(cat "$err")" "" "nothing on stderr on success"
  ( cd "$FX" && bash "$FLEET/fleet" status t -x >/dev/null 2>&1 ); assert_eq "$?" 2 "an unknown flag exits 2"
  ( cd "$FX" && bash "$FLEET/fleet" status nope -x >/dev/null 2>&1 ); assert_eq "$?" 1 "an unknown repo exits 1 before the flags are read"
  out="$( cd "$FX" && bash "$FLEET/fleet" status nope 2>&1 )"
  assert_contains "$out" "unknown repo 'nope'" "lib.sh's own die text reaches the caller"
}

# The same loader for fleet check-mutation: `node ts/src/bin/mutation.ts
# check` reaches VITEST_CMD and REPO_ROOT through ts/src/lib/config.ts. With
# the stub it must fail with the stub's text. Then the real thing: a RED run
# is silent on stderr, and any -flag but --wt is usage, exit 1. Red when
# ts/src/bin/mutation.ts reaches the config other than through
# ts/src/lib/config.ts: it prints RED and exits 0.
case_110_check_through_the_loader() {
  CASE="110 fleet check-mutation reaches the target through ts/src/lib/config.ts"; fixture c110
  local m="$REPO/.review-out/mutations" out rc err
  mutation_patch() {                  # mutation_patch — AC1-tdd-marker.patch and its .test under $m
    mkdir -p "$m"
    printf '\nFLEET_MUTANT_MARKER\n' >> "$REPO/src/marker.txt"
    git -C "$REPO" diff -- src/marker.txt > "$m/AC1-tdd-marker.patch"
    git -C "$REPO" checkout -q -- src/marker.txt
    printf 'fake.test.tsx\n' > "$m/AC1-tdd-marker.test"
  }
  mutation_patch; config_stub
  out="$( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_VITEST=marker \
          bash "$FLEET/fleet" check-mutation t "$m/AC1-tdd-marker.patch" --wt "$REPO" 2>&1 )"; rc=$?
  assert_contains "$out" "fleet-test: config stub reached" "check-mutation went through the loader"
  assert_eq "$rc" 1 "and failed with it"
  fixture c110b; m="$REPO/.review-out/mutations"; mutation_patch
  err="$FX/check.err"
  out="$( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_VITEST=marker \
          bash "$FLEET/fleet" check-mutation t "$m/AC1-tdd-marker.patch" --wt "$REPO" 2>"$err" )"; rc=$?
  assert_eq "$out" "RED AC1-tdd-marker" "the real loader: the class line and nothing else on stdout"
  assert_eq "$rc" 0 "exit 0 on all RED"
  assert_eq "$(cat "$err")" "" "nothing on stderr on success"
  out="$( cd "$FX" && bash "$FLEET/fleet" check-mutation t "$m/AC1-tdd-marker.patch" -x 2>&1 )"; rc=$?
  assert_eq "$rc" 1 "an unknown flag is a die"
  assert_contains "$out" "usage: fleet check-mutation" "with the usage"
  out="$( cd "$FX" && bash "$FLEET/fleet" check-mutation t 2>&1 )"; rc=$?
  assert_eq "$rc" 1 "no patch is a die"
  assert_contains "$out" "usage: fleet check-mutation" "with the usage"
}

# Two paths of the builder block. The first: when `claude` prints something
# other than its JSON object, parseBuilderOutput (ts/src/lib/agents.ts)
# cannot parse it, so buildErr is EMPTY — not "parse-failed" — the warning
# does not fire, builder.json keeps the raw text, and builder.md is the empty
# buildMsg. Red when that fallback (the raw text as the evidence when
# JSON.parse throws) is deleted: builder.json is then empty.
case_111_builder_output_not_json() {
  CASE="111 builder output that is not JSON is kept raw, silently"; fixture c111
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_BUILDER_OUTPUT=garbage
  local ev="$REPO/.review/$STORY/round-1"
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" done "the round went on to the reviewer"
  assert_not_grep 'builder output was not JSON' "$LOG" "the warning is for JSON of the wrong shape, not for non-JSON"
  assert_eq "$(cat "$ev/builder.json")" "not json {" "builder.json holds the raw output"
  assert_contains "$(tracked)" ".review/$STORY/round-1/builder.json" "and is committed"
  assert_eq "$(stat -c %s "$ev/builder.md")" 1 "builder.md is one empty line (buildMsg is empty)"
  # The empty buildErr is visible in the one message that prints it.
  fixture c111n
  run "$STORY" FAKE_BUILDER=nocommit FAKE_REVIEWER=PASS FAKE_BUILDER_OUTPUT=garbage
  assert_eq "$RC" 1 "no commit is still the die"
  assert_contains "$(cat "$LOG")" "produced no commits (is_error=). Said: " "is_error is empty, not parse-failed, and Said is empty"
}

# JSON that is not the CLI's object — no is_error key — is the path the
# warning was written for: buildErr is "parse-failed", the first 20 lines
# are shown, builder.json is the pretty print, builder.md says "no result
# field". Red when the warning block (launch.ts: `if (buildErr ===
# 'parse-failed') { … }`) is deleted.
case_111b_builder_output_wrong_shape() {
  CASE="111b builder JSON of the wrong shape is warned about"; fixture c111b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_BUILDER_OUTPUT=shape
  local ev="$REPO/.review/$STORY/round-1"
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" done "the round went on"
  assert_grep 'builder output was not JSON' "$LOG" "the warning"
  assert_grep '^\{"unexpected":"shape"\}$' "$LOG" "followed by the raw output"
  assert_eq "$(cat "$ev/builder.md")" "no result field" "builder.md"
  assert_eq "$(cat "$ev/builder.json")" $'{\n  "unexpected": "shape"\n}' "builder.json is the pretty print"
}

# The reviewer's stream without any agent_message: the raw JSONL is kept as
# evidence, reviewer.md carries the placeholder, and the verdict rule reads
# that placeholder as UNPARSEABLE. Red when the empty-reviewText block
# (launch.ts: `if (reviewText === '') { … }`) is deleted:
# reviewer.raw.jsonl is never written and reviewer.md is an empty line.
case_112_reviewer_without_a_message() {
  CASE="112 a reviewer that says nothing leaves its raw stream and an UNPARSEABLE round"; fixture c112
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=silent MAX_ROUNDS=1
  local ev="$REPO/.review/$STORY/round-1"
  assert_eq "$RC" 0 "exit code (the ceiling, not a die)"
  assert_eq "$(field status)" needs_human "story status"
  assert_eq "$(review_line 3)" "verdict: UNPARSEABLE" ".review line 3"
  assert_grep 'reviewer produced no agent_message' "$LOG" "the warning"
  assert_file "$ev/reviewer.raw.jsonl" "the raw stream is kept"
  assert_grep '"type":"turn.completed"' "$ev/reviewer.raw.jsonl" "and is the stream"
  assert_contains "$(tracked)" ".review/$STORY/round-1/reviewer.raw.jsonl" "committed with the round"
  assert_eq "$(cat "$ev/reviewer.md")" "(no reviewer message — see reviewer.raw.jsonl and reviewer.stderr)" "reviewer.md is the placeholder"
}

# One loader for the launcher too: fleet launch runs ts/src/bin/launch.ts,
# whose only way to the target's .fleet/config is ts/src/lib/config.ts. With
# the stub in place the launcher must fail with the stub's text before any
# agent runs. Then the real thing: a PASS run whose log carries no bin-level
# error and no stack frame. Red when ts/src/bin/launch.ts reaches the config
# other than through ts/src/lib/config.ts: it runs the story to done.
case_113_launch_through_the_loader() {
  CASE="113 fleet launch reaches the target through ts/src/lib/config.ts"; fixture c113
  config_stub
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$RC" 1 "the stub's throw ends the launcher"
  assert_grep 'fleet-test: config stub reached' "$LOG" "with its text"
  assert_eq "$(calls claude)" 0 "before any agent ran"
  fixture c113b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$RC" 0 "the real loader: a PASS run"
  assert_eq "$(field status)" done "ends done"
  assert_not_grep 'launch\.ts:' "$LOG" "no bin-level error in the log"
  assert_not_grep '^ +at ' "$LOG" "no stack frames"
}

# 24 Sep. Haiku is cheap enough to try on a small, fully specified story, and
# the price of trying must be one round at most: a Haiku round that fails is
# followed by the default builder model, not by Haiku again.
#
# Red when the launcher uses the story's model for every round.
case_114_haiku_builds_one_round() {
  CASE="114 a haiku story's round 2 is built by the default model"; fixture c114
  sed -i '2a model: haiku' "$REPO/.stories/$STORY.md"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL
  assert_eq "$(calls claude)" 2 "two builder rounds"
  assert_grep '^haiku$' "$TRACE/claude-args-1" "round 1 on haiku, as the story asks"
  assert_grep '^sonnet$' "$TRACE/claude-args-2" "round 2 on the default"
  assert_grep 'haiku builds one round' "$LOG" "and the run says why"
  assert_eq "$(grep -c '^builder:  haiku$' "$REPO/.review/$STORY.md")" 1 "the block records haiku for round 1 only"
  assert_eq "$(grep -c '^builder:  sonnet$' "$REPO/.review/$STORY.md")" 1 "and sonnet for round 2"

  CASE="114b a story on another model keeps it every round"; fixture c114b
  sed -i '2a model: opus' "$REPO/.stories/$STORY.md"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL
  assert_grep '^opus$' "$TRACE/claude-args-2" "round 2 still on the story's model"
}

# 24 Sep. With aliases, `builder: sonnet` no longer says which model built a
# round, and codex's default is invisible altogether. The block records what
# each agent reports it ran on: claude's modelUsage, codex's session file.
#
# Red when the launcher does not read them back.
case_115_block_records_the_models_used() {
  CASE="115 the block records the model each agent actually ran"; fixture c115
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 \
      FAKE_BUILDER_USED=claude-sonnet-9 FAKE_REVIEWER_USED=gpt-test-9 CODEX_HOME="$FX/codex-home"
  assert_grep '^builder:  sonnet → claude-sonnet-9$' "$REPO/.review/$STORY.md" "the alias and what it resolved to"
  assert_grep '^reviewer: codex → gpt-test-9$' "$REPO/.review/$STORY.md" "codex's default, named"
}

# 24 Sep. A story's model: is an alias — haiku, sonnet, opus or fable — so a
# new release reaches the builder without editing stories. A pinned id goes
# stale silently (six stories named claude-opus-5 when opus had moved on);
# a typo would reach the CLI and die a round in.
#
# Red while fleet lint-story does not read model:.
case_116_lint_story_model() {
  CASE="116 lint: model: is one of the aliases"; fixture c116
  local d="$FX/lint" out rc m
  mkdir -p "$d"
  lint_model() {                      # lint_model <name> <model-line> → out rc
    printf -- '---\nstatus: ready\nround: 0\n%s\nscope_deny: src/x/*\n---\n# Story: %s\n## Acceptance criteria\n**AC1 — one bounded claim.** Goes red when removed.\n' "$2" "$1" > "$d/$1.md"
    out="$( cd "$FX" && bash "$FLEET/fleet" lint-story t "$d/$1.md" 2>&1 )"; rc=$?
  }
  for m in sonnet opus fable; do
    lint_model "ok-$m" "model: $m"; assert_eq "$rc" 0 "model: $m is accepted"
  done
  lint_model none "";                         assert_eq "$rc" 0 "no model: is accepted (the default)"
  lint_model pinned "model: claude-opus-5";   assert_eq "$rc" 1 "a pinned id is an error"
  assert_contains "$out" "sonnet, opus or fable" "naming the aliases"
  lint_model typo "model: sonet";             assert_eq "$rc" 1 "a typo is an error"
  # Retired: both of its real trials needed a second round.
  lint_model haiku "model: haiku";            assert_eq "$rc" 1 "haiku is retired, no longer an alias"
  assert_contains "$out" "sonnet, opus or fable" "the error still names the live aliases"
}

# 24 Sep. Aliases only track new releases if the CLIs themselves are new:
# Claude Code updates itself, codex (an npm global under nvm) never does.
# update-agents.sh updates both, and only while the queue is idle — a codex
# replaced under a running reviewer is a dead round.
#
# Red while update-agents.sh does not exist.
case_117_update_agents() {
  CASE="117 update-agents.sh updates both CLIs, never under a running queue"; fixture c117
  local B="$FX/bin" out rc
  mkdir -p "$B"
  printf '#!/usr/bin/env bash\necho "claude $*" >> "%s/calls"\necho 9.9.9\n' "$TRACE" > "$B/claude"
  printf '#!/usr/bin/env bash\necho "codex $*" >> "%s/calls"\necho codex-cli 9.9.9\n' "$TRACE" > "$B/codex"
  printf '#!/usr/bin/env bash\necho "npm $*" >> "%s/calls"\n' "$TRACE" > "$B/npm"
  chmod +x "$B/claude" "$B/codex" "$B/npm"
  upd() { out="$( env PATH="$B:$PATH" FLEET_QUEUE_ACTIVE_CMD="$1" bash "$FLEET/fleet" update-agents 2>&1 )"; rc=$?; }

  upd true
  assert_eq "$rc" 0 "a running queue is not a failure"
  assert_contains "$out" "queue is running" "it says why it did nothing"
  assert_not_grep '^claude update' "$TRACE/calls" "claude untouched"
  assert_not_grep '^npm ' "$TRACE/calls" "codex untouched"

  upd false
  assert_eq "$rc" 0 "idle: exit 0"
  assert_grep '^claude update$' "$TRACE/calls" "claude updated"
  assert_grep '^npm install -g @openai/codex@latest' "$TRACE/calls" "codex updated to latest"
}

# 24 Sep. The merge paths no other case pins. 118: the two exit-0 "nothing
# to do" answers and the argv refusals. Red against a copy of
# ts/src/merge.ts with the "already merged" test (`if (r.merged)`) or the
# epic's "already in base" test deleted — the second run merges again or
# dies; and with parseArgs' `startsWith('-')` arm deleted, --bogus is an id.
case_118_merge_nothing_to_do_and_usage() {
  CASE="118 a second merge of the same story is nothing to do, exit 0"; epic_story c118
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run
  assert_eq "$MRC" 0 "precondition: merged"
  local head nv; head="$(epic_head)"; nv="$(grep -c '^vitest' "$TRACE/calls")"
  merge_run
  assert_eq "$MRC" 0 "exit 0, not a die"
  assert_grep "$STORY is already merged into epic/test" "$MLOG" "and says so"
  assert_eq "$(epic_head)" "$head" "the epic did not move"
  assert_eq "$(grep -c '^vitest' "$TRACE/calls")" "$nv" "no baseline ran"

  CASE="118b an epic already in the integration branch"
  merge_epic "$FX/merge-epic.log"
  assert_eq "$?" 0 "precondition: the epic landed"
  local bhead; bhead="$(git -C "$REPO" rev-parse origin/base)"
  merge_epic "$FX/merge-epic2.log"
  assert_eq "$?" 0 "exit 0"
  assert_grep 'epic/test is already in base' "$FX/merge-epic2.log" "and says so"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$bhead" "the integration branch did not move"

  CASE="118c the argv refusals"
  merge_run -- --bogus
  assert_eq "$MRC" 1 "an unknown flag is a die"
  assert_grep 'unknown option --bogus' "$MLOG" "naming it"
  ( cd "$FX" && bash "$FLEET/fleet" merge t ) > "$FX/usage.log" 2>&1
  assert_eq "$?" 1 "no id is a die"
  assert_grep 'usage: fleet merge' "$FX/usage.log" "with the usage"
  ( cd "$FX" && bash "$FLEET/fleet" merge t "$STORY" 901 ) > "$FX/two.log" 2>&1
  assert_eq "$?" 1 "two ids are a die"
  assert_grep 'usage: fleet merge' "$FX/two.log" "with the usage"
  ( cd "$FX" && bash "$FLEET/fleet" merge t --epic epic/test --land ) > "$FX/epic-land.log" 2>&1
  assert_eq "$?" 1 "--epic with --land is a die"
  assert_grep '[-]-land is for a story' "$FX/epic-land.log" "saying which flag is for what"
}

# 119: the liveness refusal, the mirror of case 53. A merge while the
# launcher still runs in the worktree would merge a round in progress. Red
# when the `live` check (merge.ts: `if (r.live)`) is deleted: the merge goes.
case_119_merge_refuses_while_live() {
  CASE="119 merge refuses while something runs in the story's worktree"; epic_story c119
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before; before="$(epic_head)"
  ( cd "$FX/wt-$STORY" && exec sleep 30 ) &
  local pid=$!
  sleep 0.3
  merge_run
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  assert_eq "$MRC" 1 "exit code (die)"
  assert_grep 'something running in its worktree' "$MLOG" "the message says why"
  assert_eq "$(epic_head)" "$before" "the epic did not move"
  assert_eq "$(test -d "$FX/wt-$STORY" && echo present || echo gone)" present "and the worktree is untouched"
  merge_run
  assert_eq "$MRC" 0 "once it is quiet, the merge goes"
  assert_grep "worktree removed: .*wt-$STORY \(branch story/$STORY kept\)" "$MLOG" "and says it removed the worktree"
}

# 120: the local copy of the base branch. The merge is made on origin's
# branch in a throwaway worktree; a local branch that is ahead of origin
# would be silently dropped when the local branch is moved over the result,
# so that is refused; otherwise the local branch follows, unless it is
# checked out, where the human is told. Red when the ancestor check or the
# branch -f is deleted.
case_120_merge_and_the_local_base_branch() {
  CASE="120 merge refuses when the local epic has commits origin does not"; epic_story c120
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before; before="$(epic_head)"
  git -C "$REPO" checkout -q epic/test
  git -C "$REPO" commit -q --allow-empty -m "local only, never pushed"
  git -C "$REPO" checkout -q base
  merge_run
  assert_eq "$MRC" 1 "exit code (die)"
  assert_grep 'local epic/test has commits origin does not' "$MLOG" "the message says why"
  assert_eq "$(epic_head)" "$before" "the epic did not move"

  CASE="120b after a merge the local epic branch follows origin"
  git -C "$REPO" branch -q -f epic/test origin/epic/test
  merge_run
  assert_eq "$MRC" 0 "merged"
  assert_eq "$(git -C "$REPO" rev-parse epic/test)" "$(field merged)" "local epic/test is at the recorded sha"
  assert_eq "$(git -C "$REPO" rev-parse epic/test)" "$(epic_head)" "which is origin's"

  # 24 Sep. The checkout is on the base (khaita's is on develop), so the
  # merge is pushed but the local branch cannot be moved under it; the
  # record was then committed on the stale local base and its push refused
  # — `git pull --ff-only` failed for the human afterwards. Now a clean
  # checkout is fast-forwarded to the merge before the record.
  CASE="120c a clean checked-out base is fast-forwarded before the record"; fixture c120c
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run -- --land
  assert_eq "$MRC" 0 "landed"
  assert_grep 'local base is checked out and clean — fast-forwarded' "$MLOG" "the log says what happened to the checkout"
  assert_not_grep 'push failed' "$MLOG" "the record's push went"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base && ok || fail "origin's base holds the story"
  assert_eq "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" base "the checkout is still on base"
  assert_eq "$(git -C "$REPO" rev-parse base)" "$(git -C "$REPO" rev-parse origin/base)" "and level with origin"
  git -C "$REPO" show origin/base:.stories/$STORY.md | grep -q '^merged: ' && ok || fail "the record reached origin"

  CASE="120d a dirty checkout is not touched; the human is told"; fixture c120d
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  printf 'uncommitted\n' >> "$REPO/src/marker.txt"
  merge_run -- --land
  assert_eq "$MRC" 0 "landed"
  assert_grep 'local base is checked out — run: git pull --ff-only' "$MLOG" "the warning names the command"
  assert_grep 'push failed — the record is local only' "$MLOG" "and the record stays local, as before"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" origin/base && ok || fail "origin's base holds the story"
  assert_grep 'uncommitted' "$REPO/src/marker.txt" "the human's edit survives"
}

# 121: a story that does not merge cleanly. The merge is aborted, the throwaway
# worktree removed by the cleanup, and nothing is recorded or run. Red when
# the mergeAbort/die branch or the cleanup in merge()'s `finally` is deleted.
case_121_merge_conflict() {
  CASE="121 a story that does not merge cleanly is refused and leaves nothing behind"; epic_story c121
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  # The epic appends its own line where the builder appended one.
  git -C "$REPO" checkout -q epic/test
  printf '\nthe epic moved on this line\n' >> "$REPO/README.md"
  git -C "$REPO" commit -qam "epic: a conflicting line"
  git -C "$REPO" push -q origin epic/test
  git -C "$REPO" checkout -q base
  local before nv; before="$(epic_head)"; nv="$(grep -c '^vitest' "$TRACE/calls")"
  merge_run
  assert_eq "$MRC" 1 "exit code (die)"
  assert_grep 'does not merge cleanly into epic/test' "$MLOG" "the message says why"
  assert_eq "$(epic_head)" "$before" "the epic did not move"
  [[ -d "$FX/merge-$STORY" ]] && fail "the merge worktree was left behind" || ok
  assert_eq "$(git -C "$REPO" worktree list | grep -c "merge-$STORY")" 0 "and git no longer lists it"
  assert_not_grep '^merged:' "$REPO/.stories/$STORY.md" "nothing claims it merged"
  assert_eq "$(grep -c '^vitest' "$TRACE/calls")" "$nv" "no baseline ran"
  assert_file "$REPO/.runs/$STORY-merge.log" "git's account of the conflict is in .runs"
}

# 122: PUSH_STATUS=0, the knob every writer honours. The merge happens on the
# local branch only; pr mode, which is nothing but a push, refuses. Red when
# the three PUSH_STATUS guards in ts/src/merge.ts are deleted.
case_122_merge_without_push() {
  CASE="122 PUSH_STATUS=0 merges locally and pushes nothing"; epic_story c122
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before obase; before="$(epic_head)"; obase="$(git -C "$REPO" rev-parse origin/base)"
  merge_run PUSH_STATUS=0
  assert_eq "$MRC" 0 "exit 0"
  assert_eq "$(epic_head)" "$before" "origin's epic did not move"
  git -C "$REPO" merge-base --is-ancestor "story/$STORY" epic/test && ok || fail "the local epic holds the story"
  assert_eq "$(git -C "$REPO" rev-parse epic/test)" "$(field merged)" "at the recorded sha"
  assert_contains "$(git -C "$REPO" log -1 --format=%s)" "merged" "the record is committed"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$obase" "and not pushed"

  CASE="122b pr mode is a push, so PUSH_STATUS=0 refuses it"
  merge_run PUSH_STATUS=0 MERGE_MODE=pr PR_CMD=true
  assert_eq "$MRC" 1 "exit code (die)"
  assert_grep 'PUSH_STATUS=0 forbids it' "$MLOG" "the message says why"

  CASE="122c a failing PR_CMD is a die"
  merge_run MERGE_MODE=pr PR_CMD=false
  assert_eq "$MRC" 1 "exit code (die)"
  assert_grep 'PR_CMD failed' "$MLOG" "naming it"
}

# 123: revert's refusals. The integration branch is a human's in both
# directions; a recorded sha that is not on origin's branch was already
# reverted or never landed; a revert that does not apply is aborted and the
# throwaway worktree removed. Red when any of the three is deleted.
case_123_revert_refusals() {
  CASE="123 revert refuses a story landed on the integration branch"; fixture c123
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run -- --land
  assert_eq "$MRC" 0 "precondition: landed"
  [[ -n "$(field merged)" ]] && ok || fail "precondition: the merge is recorded"
  local before; before="$(git -C "$REPO" rev-parse origin/base)"
  revert_run
  assert_eq "$RVRC" 1 "exit code (die)"
  assert_grep "is based on base — that branch is a human's, here too" "$RVLOG" "the message says why"
  assert_eq "$(git -C "$REPO" rev-parse origin/base)" "$before" "the integration branch did not move"

  CASE="123b a recorded sha that is not on origin's epic"; epic_story c123b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local tip; tip="$(git -C "$REPO" rev-parse "story/$STORY")"
  sed -i "2a merged: $tip" "$REPO/.stories/$STORY.md"
  before="$(epic_head)"
  revert_run
  assert_eq "$RVRC" 1 "exit code (die)"
  assert_grep "${tip:0:8} is not on origin/epic/test" "$RVLOG" "the message names the sha and the branch"
  assert_eq "$(epic_head)" "$before" "the epic did not move"
  [[ -d "$FX/revert-$STORY" ]] && fail "the revert worktree was left behind" || ok
  assert_grep "^merged: $tip" "$REPO/.stories/$STORY.md" "the record is left as it was"

  CASE="123c a revert that does not apply is aborted"; epic_story c123c
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run
  assert_eq "$MRC" 0 "precondition: merged"
  # The epic rewrites the line the story added; undoing the merge no longer applies.
  git -C "$REPO" checkout -q epic/test
  sed -i 's/fake builder touched this/the epic rewrote this/' "$REPO/README.md"
  git -C "$REPO" commit -qam "epic: rewrite the story's line"
  git -C "$REPO" push -q origin epic/test
  git -C "$REPO" checkout -q base
  before="$(epic_head)"
  revert_run
  assert_eq "$RVRC" 1 "exit code (die)"
  assert_grep 'the revert did not apply' "$RVLOG" "the message says why"
  assert_eq "$(epic_head)" "$before" "the epic did not move"
  [[ -d "$FX/revert-$STORY" ]] && fail "the revert worktree was left behind" || ok
  assert_eq "$(git -C "$REPO" worktree list | grep -c "revert-$STORY")" 0 "and git no longer lists it"
  assert_grep '^merged: [0-9a-f]{7,}' "$REPO/.stories/$STORY.md" "the record still stands"
  assert_file "$REPO/.runs/$STORY-revert.log" "git's account is in .runs"
}

# 124: reset's flags and its second run. --draft, the two argv refusals, a
# reset of a story that is already clear, and the base fallback to origin's
# branch when the local one is missing. Red when --draft is ignored, an argv
# arm is deleted, or the fallback is dropped (the unmerged count reads 0 and
# the branch goes).
case_124_reset_flags_and_second_run() {
  CASE="124 --draft puts the story back as a draft"; fixture c124
  reset_run "$STORY" --draft
  assert_eq "$RRC" 0 "exit 0"
  assert_eq "$(field status)" draft "status is draft"
  assert_eq "$(field round)" 0 "round is 0"
  assert_grep "$STORY is draft, round 0" "$RLOG" "and says so"
  assert_contains "$(git -C "$REPO" log -1 --format=%s)" "reset to draft" "committed"

  CASE="124b the argv refusals"
  reset_run "$STORY" 901
  assert_eq "$RRC" 1 "two ids"
  assert_grep 'one story at a time' "$RLOG" "the message"
  reset_run "$STORY" --nope
  assert_eq "$RRC" 1 "an unknown flag"
  assert_grep 'unknown option: --nope' "$RLOG" "naming it"
  reset_run
  assert_eq "$RRC" 1 "no id"
  assert_grep 'usage: fleet reset' "$RLOG" "the usage"

  CASE="124c a second reset finds nothing to do and says so"
  local head; head="$(git -C "$REPO" rev-parse HEAD)"
  reset_run "$STORY" --draft
  assert_eq "$RRC" 0 "exit 0"
  assert_grep 'already clear in git' "$RLOG" "the warning"
  assert_grep "$STORY is draft, round 0" "$RLOG" "and the closing line"
  assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$head" "no commit"

  CASE="124d the unmerged count is against origin's base when the local branch is missing"; fixture c124d
  git -C "$REPO" push -q origin base:epic/only-on-origin
  sed -i '2a base: epic/only-on-origin' "$REPO/.stories/$STORY.md"
  git -C "$REPO" branch -q "story/$STORY" base
  git -C "$REPO" checkout -q "story/$STORY"
  git -C "$REPO" commit -q --allow-empty -m "work on no other branch"
  git -C "$REPO" checkout -q base
  reset_run "$STORY"
  assert_eq "$RRC" 1 "exit code (die)"
  assert_grep 'has 1 commit\(s\) that origin/epic/only-on-origin does not — rerun with --force' "$RLOG" "counted against origin's branch"
  assert_grep '^    [0-9a-f]{7,} work on no other branch' "$RLOG" "the commits listed, indented, before the die"
  git -C "$REPO" show-ref --verify --quiet "refs/heads/story/$STORY" && ok || fail "the branch survives"
}

# fleet merge runs ts/src/bin/merge.ts, which reaches the target through the
# same loader as the other bins: with the stub, the merge ends with its text.
# Then a checkout without .runs/ merges (merge.ts makes .runs/ before git's
# merge log goes there), and a normal merge leaves no bin-level line in the
# log (case 113's shape). Red when ts/src/bin/merge.ts reaches the config
# other than through ts/src/lib/config.ts; red again with the mkdirSync of
# .runs/ deleted: the merge log cannot be opened and the epic does not land.
case_125_merge_through_the_loader() {
  CASE="125 fleet merge reaches the target through ts/src/lib/config.ts"; epic_story c125
  config_stub
  merge_epic "$FX/merge-epic.log"
  assert_eq "$?" 1 "the stub's throw ends the merge"
  assert_grep 'fleet-test: config stub reached' "$FX/merge-epic.log" "with its text"

  CASE="125b a checkout without .runs/ merges"; epic_story c125b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run
  assert_eq "$MRC" 0 "precondition: the story is on its epic"
  rm -rf "$REPO/.runs"
  local before; before="$(git -C "$REPO" rev-parse origin/base)"
  merge_epic "$FX/merge-epic.log"
  assert_eq "$?" 0 "the epic lands"
  [[ "$(git -C "$REPO" rev-parse origin/base)" != "$before" ]] && ok || fail "the integration branch moved"
  assert_file "$REPO/.runs/epic-test-merge.log" "and git's account of the merge is in .runs"
  assert_not_grep 'merge\.ts:' "$FX/merge-epic.log" "no bin-level error in the log"
  assert_not_grep '^ +at ' "$FX/merge-epic.log" "no stack frames"
  assert_not_grep 'merge\.ts:' "$MLOG" "nor in the story merge's"
}

# fleet revert runs ts/src/bin/revert.ts, through the same loader: the stub
# ends a revert with its text; then the real loader through case 66's
# revert, with no bin-level line in the log. Red when ts/src/bin/revert.ts
# reaches the config other than through ts/src/lib/config.ts, and red again
# with revert.ts's mkdirSync of .runs/ deleted.
case_126_revert_through_the_loader() {
  CASE="126 fleet revert reaches the target through ts/src/lib/config.ts"; epic_story c126
  config_stub
  revert_run
  assert_eq "$RVRC" 1 "the stub's throw ends the revert"
  assert_grep 'fleet-test: config stub reached' "$RVLOG" "with its text"

  CASE="126b the real loader: a revert, no bin-level line"; epic_story c126b
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run
  assert_eq "$MRC" 0 "precondition: merged"
  rm -rf "$REPO/.runs"
  revert_run
  assert_eq "$RVRC" 0 "reverted, with .runs/ made on the way"
  assert_file "$REPO/.runs/$STORY-revert.log" "git's account is in .runs"
  assert_not_grep 'revert\.ts:' "$RVLOG" "no bin-level error in the log"
  assert_not_grep '^ +at ' "$RVLOG" "no stack frames"
}

# fleet reset runs ts/src/bin/reset.ts, through the same loader: the stub
# ends a reset with its text and the story untouched; then case 52's reset
# through the real loader, with no bin-level line in the log. Red when
# ts/src/bin/reset.ts reaches the config other than through
# ts/src/lib/config.ts.
case_127_reset_through_the_loader() {
  CASE="127 fleet reset reaches the target through ts/src/lib/config.ts"; fixture c127
  config_stub
  reset_run "$STORY" --force
  assert_eq "$RRC" 1 "the stub's throw ends the reset"
  assert_grep 'fleet-test: config stub reached' "$RLOG" "with its text"
  assert_eq "$(field status)" ready "and the story is untouched"

  CASE="127b the real loader: a reset, no bin-level line"; fixture c127b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  reset_run "$STORY" --force
  assert_eq "$RRC" 0 "reset"
  assert_eq "$(field status)" ready "status back to ready"
  assert_not_grep 'reset\.ts:' "$RLOG" "no bin-level error in the log"
  assert_not_grep '^ +at ' "$RLOG" "no stack frames"
}

# A bare `fleet launch <repo>` picks a story to build when none is named,
# through the queue's own choice, nextReady in ts/src/status.ts, which skips
# TEMPLATE.md — and TEMPLATE.md carrying status: ready is real, not
# hypothetical (khaita's does). Red when a bare launch picks from launch.ts's
# storyFiles(), which keeps TEMPLATE.md: it tries to build the template.
case_128_bare_launch_never_picks_template() {
  CASE="128 a bare launch never picks TEMPLATE.md, ready or not"; fixture c128 draft
  sed -i 's/^status: draft/status: ready/' "$REPO/.stories/TEMPLATE.md"
  ( cd "$FX" && env PATH="$(FAKES)" \
      PUSH_STATUS=1 FAKE_MUTATIONS=patch FAKE_VITEST=marker FLEET_NOTIFY_CMD=true \
      FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID="$STORY" \
      bash "$FLEET/fleet" launch t ) > "$FX/bare.log" 2>&1
  local rc=$?
  assert_eq "$rc" 0 "nothing ready is not an error"
  assert_grep 'queue empty' "$FX/bare.log" "it says the queue is empty"
  assert_eq "$(calls claude)" 0 "the builder never ran"
  assert_eq "$(frontmatter "$REPO/.stories/TEMPLATE.md" status)" ready "TEMPLATE.md is untouched"
}

# The queue's own loop guards. Red against a scratch copy of
# ts/src/run-queue.ts with the ceiling (the loop's `n < max`) blanked: it
# would run all three stories.
case_129_queue_max_ceiling() {
  CASE="129 --max stops the drain and says so"; fixture c129
  for extra in 901 902; do
    sed "s/Story $STORY/Story $extra/" "$REPO/.stories/$STORY.md" > "$REPO/.stories/$extra.md"
  done
  queue MAX=2 FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$QRC" 0 "the runner still exits cleanly"
  assert_grep 'stopped at the --max ceiling of 2 stories' "$FX/queue.log" "the ceiling is named"
  assert_eq "$(frontmatter "$REPO/.stories/$STORY.md" status)" done "the first two ran…"
  assert_eq "$(frontmatter "$REPO/.stories/901.md" status)" done "…both of them"
  assert_eq "$(frontmatter "$REPO/.stories/902.md" status)" ready "…the third did not"
  assert_eq "$(calls claude)" 2 "the builder ran exactly twice"
  assert_grep 'queue finished, started' "$FX/queue.log" "the closing table header"
  assert_grep "^  $STORY done PASS exit=0" "$FX/queue.log" "…one RAN line per story run"
  assert_grep '^  901 done PASS exit=0' "$FX/queue.log" "…in the order they ran"
}

# Red against a scratch copy with the `id === prev` comparison in
# ts/src/run-queue.ts blanked: a story a fake builder leaves `ready` (never
# reaching a terminal status) would be picked again and again, forever.
case_130_queue_same_story_twice_stops() {
  CASE="130 a story ready again without finishing stops the queue, not loops it"; fixture c130
  # FAKE_REVIEWER=NONE: the launcher's own MAX_ROUNDS exhausts to needs_human
  # normally; here the fixture story is put back to `ready` by hand after the
  # launcher returns, standing in for a launcher bug that never reaches a
  # terminal state — nextReady would pick it right back up.
  mv "$FLEET/fleet" "$FLEET/fleet.real"
  cat > "$FLEET/fleet" <<EOF
#!/usr/bin/env bash
bash "$FLEET/fleet.real" "\$@"
rc=\$?
[[ "\$1" == launch ]] && sed -i 's/^status:.*/status: ready/' "$REPO/.stories/$STORY.md"
exit \$rc
EOF
  chmod +x "$FLEET/fleet"
  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$QRC" 0 "the runner exits cleanly, not hung"
  assert_grep "$STORY is ready again without having finished" "$FX/queue.log" "the loop names the story"
  assert_grep 'stopping rather than looping' "$FX/queue.log" "…and says why it stopped"
  assert_eq "$(calls claude)" 1 "the launcher ran exactly once, not forever"
}

# refreshFromOrigin (ts/src/run-queue.ts) never fails the drain: a fetch
# failure is a warning, and the story still runs from local state. Red
# against a scratch copy that lets a fetch failure `die` instead of `warn`.
case_131_queue_refresh_resilience() {
  CASE="131 a fetch failure warns, the drain still runs from local state"; fixture c131
  # Point origin at a path that no longer exists: `git fetch` fails, cleanly.
  git -C "$REPO" remote set-url origin "$FX/gone.git"
  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$QRC" 0 "the runner exits cleanly"
  assert_grep 'refresh failed: fetch from origin failed, continuing on local state' "$FX/queue.log" "warned, not died"
  assert_eq "$(field status)" done "the story still ran"
}

# fleet write-story's full happy path, end to end — case 94 only
# characterises the --base validation slice.
case_132_write_story_end_to_end() {
  CASE="132 fleet write-story: worktree, render, agent, copy-back, lint — end to end"; fixture c132
  git -C "$REPO" push -q origin base:epic/test
  local out rc

  write() {                          # write <id> <intent> [VAR=value...] → out rc
    local id="$1" intent="$2"; shift 2
    out="$( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID="$id" "$@" \
            bash "$FLEET/fleet" write-story t "$id" "$intent" --base epic/test 2>&1 )"; rc=$?
  }

  write 950 "the moon toggle should show a moon" FAKE_BUILDER=story
  assert_eq "$rc" 0 "a well-formed draft lints clean and the command succeeds"
  assert_contains "$out" "draft ready" "and says so"
  assert_eq "$(calls claude)" 1 "one agent call"
  assert_grep '^--allowedTools$' "$TRACE/claude-args-1" "the writer's own tool list"
  assert_grep '^Read,Grep,Glob,Bash,Write$' "$TRACE/claude-args-1" "not the launcher's — no Edit"
  assert_contains "$(cat "$TRACE/claude-prompt-1")" "950" "the id was rendered in"
  assert_contains "$(cat "$TRACE/claude-prompt-1")" "the moon toggle should show a moon" "so was the intent"
  assert_contains "$(cat "$TRACE/claude-prompt-1")" "epic/test" "and the base"
  assert_not_contains "$(cat "$TRACE/claude-prompt-1")" "{{" "nothing left unsubstituted"
  assert_eq "$(frontmatter "$REPO/.stories/950.md" status)" draft "the copied-back story is a draft"
  [[ -d "$REPO/../ws-950" ]] && fail "worktree left behind" || ok

  write 951 "x" FAKE_BUILDER=nocommit
  assert_eq "$rc" 1 "no story written is a failure"
  assert_contains "$out" "no story was written" "and says so"
  [[ -e "$REPO/.stories/951.md" ]] && fail "951.md exists but should not" || ok
  [[ -d "$REPO/../ws-951" ]] && fail "worktree left behind after failure" || ok

  write 952 "x" FAKE_BUILDER=story FAKE_STORY_NOAC=1
  assert_eq "$rc" 1 "a draft with lint errors fails the command"
  assert_contains "$out" "the draft has errors above" "and says so"
  assert_eq "$(frontmatter "$REPO/.stories/952.md" status)" draft "but is still copied back for a human to fix"
}

CASES=(case_1_happy case_2_nocommit case_3_blocked case_4_fail_two_rounds
       case_5_restart_after_fail case_6_unparseable
       case_7_status_commits_land case_8_is_error_false case_9_spec
       case_11_no_acs case_12_baseline_test_red
       case_13_baseline_build_red case_14_baseline_lint_red
       case_15_baseline_notests case_16_reviewer_dirty_tree
       case_17_reviewer_output_copied case_18_mutation_red
       case_19_mutation_green case_20_mutation_notests
       case_21_mutation_badpatch case_22_mutation_prered case_22b_mutation_prerun_once
       case_23_mutation_cmd
       case_24_veto_green case_25_veto_no_mutation case_26_veto_wrong_ac
       case_27_round2_gets_machine_facts case_28_scope_violation
       case_29_scope_undeclared case_30_scope_elsewhere
       case_31_codex_stderr_notice case_32_huge_review_prompt
       case_33_story_amendment_reaches_builder case_34_review_only
       case_35_builder_tdd_mutation case_36_reviewer_probes
       case_37_evidence_only_round case_38_story_base case_39_lint_story
       case_40_agent_timeout case_41_run_queue case_42_resume_after_crash
       case_43_refresh_diverged case_44_refresh_fail
       case_45_conflict_leaves_local_work case_48_missing_seed_file
       case_49_install_failure case_50_status_commit_failure
       case_51_selector_invalid case_52_reset
       case_53_reset_refuses_while_live case_54_reset_refuses_unmerged
       case_55_status_json case_56_merge case_57_merge_refuses_fail
       case_58_merge_undoes_itself case_58b_merge_reuses_the_round
       case_59_merge_refuses_integration_branch
       case_60_bot_send case_61_bot_unconfigured_is_not_fatal
       case_62_bot_ignores_strangers case_63_bot_status case_64_bot_promote
       case_65_bot_offset_advances case_66_revert
       case_67_revert_needs_a_merge case_68_bot_revert
       case_69_queue_merges_a_pass case_70_queue_does_not_merge_a_fail
       case_71_auto_merge_can_be_turned_off case_72_lessons_name_real_cases
       case_74_merge_epic_into_integration
       case_75_merge_epic_refuses_non_epic case_76_story_model
       case_77_launcher_notifies_a_stop case_78_round_cost_is_recorded
       case_79_writers_do_not_collide case_80_status_epics
       case_81_existing_merge_preserved case_82_load_repo
       case_83_scope_fleet_config case_84_prompts_carry_the_targets_facts
       case_85_seed_files_from_config case_86_probe_dir
       case_87_queue_all_repos case_88_suite_env_is_clean case_89_shared_parent_dir_refused
       case_90_status_titles_and_landing case_91_merge_land case_92_merge_pr_mode
       case_93_bot_status_pre case_93b_bot_merge case_94_epic_naming
       case_95_bot_help_and_repo_default case_96_bot_status_hides_landed
       case_97_bot_repo_list case_98_lint_cites_resolve_against_base
       case_99_bot_merge_detaches case_100_check_mutation
       case_101_builder_told_to_check_evidence case_102_builder_sees_the_reviewers_attack
       case_156_builder_checks_the_storys_red_list
       case_103_reviewer_model case_104_install_skills
       case_105_fixture_excludes_node_modules case_106_one_classifier
       case_107_probe_runner_failure_is_not_a_pass case_108_one_verdict
       case_109_status_through_the_loader case_110_check_through_the_loader
       case_111_builder_output_not_json case_111b_builder_output_wrong_shape
       case_112_reviewer_without_a_message case_113_launch_through_the_loader
       case_114_haiku_builds_one_round case_115_block_records_the_models_used
       case_116_lint_story_model case_117_update_agents
       case_118_merge_nothing_to_do_and_usage case_119_merge_refuses_while_live
       case_120_merge_and_the_local_base_branch case_121_merge_conflict
       case_122_merge_without_push case_123_revert_refusals
       case_124_reset_flags_and_second_run case_125_merge_through_the_loader
       case_126_revert_through_the_loader case_127_reset_through_the_loader
       case_128_bare_launch_never_picks_template case_129_queue_max_ceiling
       case_130_queue_same_story_twice_stops case_131_queue_refresh_resilience
       case_132_write_story_end_to_end case_133_telegram_api_fake case_134_bot_api_unreachable case_135_bot_pre_escapes_html
       case_136_fleet_entry_point case_137_one_launch_per_repo
       case_138_reap_sees_a_storys_trees case_139_bot_leaves_in_progress_alone
       case_140_queue_leaves_a_busy_repo case_141_refused_reviewer_costs_no_round
       case_142_refused_story_resumes_at_its_review
       case_143_queue_pauses_on_a_refused_review
       case_144_bot_wait_and_fallback
       case_145_builder_refused_by_claude
       case_146_fallback_reviewer_is_claude case_147_no_attribution
       case_148_bot_job_is_its_own_unit case_149_test_deploy
       case_150_bot_testdeploy case_151_refused_push_follows_origin
       case_152_e2e_baseline case_153_merge_runs_e2e case_154_e2e_bounded
       case_155_baseline_fix_in_the_round
       case_158_review_keeps_rounds_across_a_stop case_159_tdd_pairs_run_once_by_the_harness
       case_160_story_reds_are_real case_161_answered_question_does_not_block_again
       case_162_queue_timer_fires_after_any_boot case_163_remote_control
       case_164_queue_waits_for_free_memory case_165_queue_unit_per_repo
       case_166_runners_config case_167_cargo_evidence case_167h_one_cargo_classifier
       case_168_cargo_probes case_169_prompts_name_the_runners
       case_170_launch_writes_its_events
       case_171_queue_writes_its_events
       case_172_merge_writes_its_events
       case_173_writer_and_lint_write_events
       case_174_promote
       case_175_answers_and_epics_are_marked
       case_176_revert_reset_and_test_deploy_are_logged
       case_177_fleet_events
       case_178_drain_prunes_the_build_cache
       case_179_dashboard_bundle)

# The recorder the bot is tested against, checked against itself before
# any bot case relies on it: a sendMessage with a multi-line text arrives
# decoded, one field per line, and a getUpdates carries its query string
# into the call log and answers what $FX/updates.json holds. Red while
# test/fakes/telegram-api.mts is absent.
case_133_telegram_api_fake() {
  CASE="133 the fake Telegram API records what it is sent"; fixture c133
  update 7 42 "/repo"
  api_start || return
  local out
  out="$( cd "$FX" && node -e '
    const b = process.argv[1];
    (async () => {
      let r = await fetch(b + "/bottest-token/sendMessage", { method: "POST",
        body: new URLSearchParams({ chat_id: "42", text: "<pre>row one\nrow two</pre>", parse_mode: "HTML" }) });
      process.stdout.write(await r.text());
      r = await fetch(b + "/bottest-token/getUpdates?offset=7&timeout=0");
      process.stdout.write(await r.text());
    })();' "$API_BASE" 2>&1 )"
  assert_contains "$out" '"ok":true,"result":{"message_id"' "sendMessage is acknowledged"
  assert_contains "$out" '"update_id":7' "getUpdates answers with the fixture's update"
  assert_eq "$(sent)" 1 "one sendMessage recorded"
  assert_file "$TRACE/api-args-1" "as the first request"
  assert_grep '^chat_id=42$' "$TRACE/api-args-1" "the chat id, decoded"
  assert_grep '^text=<pre>row one$' "$TRACE/api-args-1" "the text's first line"
  assert_grep '^row two</pre>$' "$TRACE/api-args-1" "and its second line, as it was"
  assert_grep '^parse_mode=HTML$' "$TRACE/api-args-1" "the parse mode"
  assert_contains "$(api_calls)" "getUpdates?offset=7" "the poll's query string is in the call log"
  assert_eq "$(api_calls | grep -c '^api ')" 2 "two calls in all"
}

# Two ways the API can fail: Telegram unreachable at all, and a poll
# answered with something other than updates. Both are warnings and exit 0 —
# a bot whose API is gone must say so and end normally, as fleet-bot.service
# runs it every minute and a failed unit is noise, not information — and
# neither moves the offset. Red when a failed request is allowed to throw.
case_134_bot_api_unreachable() {
  CASE="134 an unreachable API is a warning, not a failure"; fixture c134
  local rc
  BLOG="$FX/bot.log"
  ( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" \
      TELEGRAM_BOT_TOKEN=test-token TELEGRAM_CHAT_ID=42 TELEGRAM_API_BASE=http://127.0.0.1:1 \
      bash "$FLEET/fleet" telegram send "anyone there" ) > "$BLOG" 2>&1; rc=$?
  assert_eq "$rc" 0 "send exits 0"
  assert_grep 'sendMessage failed' "$BLOG" "and says so"
  ( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" \
      TELEGRAM_BOT_TOKEN=test-token TELEGRAM_CHAT_ID=42 TELEGRAM_API_BASE=http://127.0.0.1:1 \
      bash "$FLEET/fleet" telegram poll ) > "$BLOG" 2>&1; rc=$?
  assert_eq "$rc" 0 "poll exits 0"
  assert_grep 'getUpdates failed' "$BLOG" "and says so"
  assert_no_file "$FLEET/.bot-offset" "nothing was acknowledged"

  CASE="134 a poll answered with something other than updates"
  printf '<html>oops</html>\n' > "$FX/updates.json"
  bot poll
  assert_eq "$BRC" 0 "poll exits 0"
  assert_grep 'getUpdates returned no result' "$BLOG" "and says what it got"
  assert_no_file "$FLEET/.bot-offset" "nothing was acknowledged"
  assert_eq "$(sent)" 0 "nothing was sent"
}

# --pre wraps the text in <pre> for Telegram's HTML parse mode, so &, <
# and > go as &amp;, &lt; and &gt;: a --pre message with an angle bracket
# left as it is would be invalid HTML that Telegram refuses. Red when the
# escaping in htmlPre (ts/src/telegram.ts) is deleted.
case_135_bot_pre_escapes_html() {
  CASE="135 --pre escapes the characters HTML would misread"; fixture c135
  bot send --pre "a & b <c> d"
  assert_eq "$BRC" 0 "exit code"
  assert_eq "$(sent)" 1 "one message"
  assert_contains "$(sent_text)" "text=<pre>a &amp; b &lt;c&gt; d</pre>" "escaped, then wrapped"
}

# The one entry point. Every command is `fleet <command> …`; with no
# command, or one it does not know, it prints the usage on stderr and exits
# 2 before anything is loaded; `help` prints it on stdout. Reached through a
# symlink (~/.local/bin/fleet, say) it still finds its own tree. Red while
# the file is absent; red again with the readlink -f deleted (the link
# case), or with the unknown-command branch falling through to node.
case_136_fleet_entry_point() {
  CASE="136 fleet: usage, unknown commands, help, a symlink"; fixture c136
  local out rc c
  out="$(cd "$FX" && bash "$FLEET/fleet" 2>&1)"; rc=$?
  assert_eq "$rc" 2 "no command is a usage error"
  assert_contains "$out" "usage: fleet <command>" "with the usage"
  for c in status events write-story lint-story promote new-epic launch run-queue check-mutation merge revert reset test-deploy telegram install-skills update-agents dashboard; do
    assert_contains "$out" "
  $c " "the usage lists $c"
  done
  out="$(cd "$FX" && bash "$FLEET/fleet" bogus t 2>&1)"; rc=$?
  assert_eq "$rc" 2 "an unknown command is a usage error"
  assert_contains "$out" "unknown command 'bogus'" "and names it"
  assert_contains "$out" "usage: fleet <command>" "with the usage"
  out="$(cd "$FX" && bash "$FLEET/fleet" help 2>/dev/null)"; rc=$?
  assert_eq "$rc" 0 "help is not an error"
  assert_contains "$out" "usage: fleet <command>" "help prints the usage on stdout"
  mkdir -p "$FX/bin"; ln -s "$FLEET/fleet" "$FX/bin/fleet"
  out="$(cd "$FX" && "$FX/bin/fleet" status t 2>&1)"; rc=$?
  assert_eq "$rc" 0 "a symlinked fleet runs, executable as it is"
  assert_contains "$out" "fixture story" "and reaches the registry and ts/ of its own tree"
}

# One launch per repo. The launcher holds <target>/.git/fleet-launch.lock
# for as long as it lives; another launch — a bare one, one for another
# story, the queue's --reap — finds it held, exits 75 and touches nothing.
# The 21 Sep incident (khaita 015) is (a): a drain's --reap looked for life
# only in wt-<id>, found none while the story was being reviewed in
# wt-<id>-review, and returned it to `ready`. (c) is a stretch with no
# process in either tree at all — a launcher waiting on the fleet lock at
# its in_progress commit — which only a lock can see. Red while
# ts/src/bin/launch.ts takes no launch lock: (a) reaps 900, (b) runs 901,
# (c) reaps 901.
case_137_one_launch_per_repo() {
  CASE="137 one launch per repo: a second launch exits 75 and touches nothing"; fixture c137
  sed "s/Story $STORY/Story 901/" "$REPO/.stories/$STORY.md" > "$REPO/.stories/901.md"
  git -C "$REPO" add .stories/901.md && git -C "$REPO" commit -qm "fixture: story 901" && git -C "$REPO" push -q
  local holder rc
  codex_called() { grep -q '^codex$' "$TRACE/calls"; }

  launch_bg 900 "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=gate MAX_ROUNDS=1 AGENT_TIMEOUT=120
  holder=$BG_PID
  wait_for 60 codex_called || fail "the background launcher never reached its reviewer"

  CASE="137a --reap while a story is being reviewed"
  run --reap
  assert_eq "$RC" 75 "busy is its own exit code"
  assert_grep "pid $holder" "$LOG" "the message names the holder's pid"
  assert_grep "$STORY" "$LOG" "…and its story"
  assert_eq "$(field status)" in_progress "the live story is not reaped"
  assert_eq "$(git -C "$REPO" log --format=%s | grep -c "^story($STORY): ready")" 0 "no ready commit"

  CASE="137b a launch for another story at the same time"
  run 901 FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$RC" 75 "busy"
  assert_eq "$(frontmatter "$REPO/.stories/901.md" status)" ready "901 is left as it was"
  assert_eq "$(calls claude)" 1 "only the first launcher's builder ran"

  CASE="137d the holder finishes and leaves no lock behind"
  open_gate
  wait "$holder"; rc=$?
  assert_eq "$rc" 0 "the background launcher ends normally"
  assert_eq "$(field status)" done "…with its story done"

  CASE="137c a launcher with no process in any tree is still alive"
  ( exec 9>"$REPO/.git/fleet.lock"; flock 9; sleep 4 ) &
  local fleetlock=$!
  sleep 0.3
  launch_bg 901 901 FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  holder=$BG_PID
  wait_for 20 grep -q '^status: in_progress' "$REPO/.stories/901.md" || fail "901 never reached in_progress"
  run --reap
  assert_eq "$RC" 75 "busy, though nothing runs in wt-901 or wt-901-review"
  assert_eq "$(frontmatter "$REPO/.stories/901.md" status)" in_progress "901 is not reaped"
  wait "$fleetlock"
  wait "$holder"; rc=$?
  assert_eq "$rc" 0 "901's launcher ran: the first launcher's lock went with it"
  assert_eq "$(frontmatter "$REPO/.stories/901.md" status)" done "…to done"
  run --reap
  assert_eq "$RC" 0 "and once nothing runs, --reap takes the lock"
}

# Reap looks in both of a story's trees. Under the launch lock no launcher
# is alive while reap runs, so a process in wt-<id> or wt-<id>-review is an
# agent its launcher left behind (killed with SIGKILL, say) — still working
# on the story, so the story is not an orphan and the reap stops. Red today
# for (a): reap looked only in wt-<id>, the tree the 21 Sep incident missed.
# (b) characterises the check that already existed — red against a copy of
# ts/src/launch.ts with the `pids.length > 0` throw deleted.
case_138_reap_sees_a_storys_trees() {
  local tree pid
  for tree in "wt-$STORY-review" "wt-$STORY"; do
    CASE="138 a process left in $tree stops the reap"; fixture "c138-$tree" in_progress
    mkdir -p "$FX/$tree"
    ( cd "$FX/$tree" && exec sleep 30 ) &
    pid=$!
    sleep 0.3
    run --reap
    kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
    assert_eq "$RC" 1 "a live orphan is a die"
    assert_grep "$tree" "$LOG" "the message names the tree"
    assert_grep "$pid" "$LOG" "…and the pid"
    assert_eq "$(field status)" in_progress "the story is left alone"
    assert_eq "$(git -C "$REPO" log --format=%s | grep -c "^story($STORY): ready")" 0 "no ready commit"
  done
}

# /promote and /answer leave an in_progress story alone. The status is the
# launcher's while it runs: /promote wrote `ready` over it unasked, and
# /answer did the same for any story that had ever been blocked, since
# .blocked/<id>.md outlives the answer. A story whose launcher died is the
# reap's to return. Red while cmdPromote and cmdAnswer (ts/src/telegram.ts)
# do not read the status first.
case_139_bot_leaves_in_progress_alone() {
  CASE="139 /promote and /answer refuse an in_progress story"; fixture c139 in_progress
  mkdir -p "$REPO/.blocked"; printf '# Question\n\nwhich?\n' > "$REPO/.blocked/$STORY.md"
  git -C "$REPO" add .blocked && git -C "$REPO" commit -qm "fixture: a question once asked"
  local head; head="$(git -C "$REPO" rev-parse HEAD)"
  update 139 42 "/promote t $STORY"
  bot poll
  assert_eq "$(field status)" in_progress "/promote left the status alone"
  assert_contains "$(sent_text)" "in_progress" "…and said why"
  update 140 42 "/answer t $STORY go on"
  bot poll
  assert_eq "$(field status)" in_progress "/answer left the status alone"
  assert_not_grep 'go on' "$REPO/.blocked/$STORY.md" "…and the question file"
  assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$head" "nothing was committed"
}

# A busy repo is the next drain's. When another launch holds the repo, the
# queue's --reap exits 75: the drain says so and stops before its refresh
# (an unlocked git merge in the checkout the holder commits to) and before
# any launch. A launch that exits 75 — the lock taken between the reap and
# it — stops the drain the same way. Neither is news: no notification. Red
# while ts/src/run-queue.ts ignores the reap's exit and reads 75 as a story
# that "ended as 'ready' … not a state the queue expects".
case_140_queue_leaves_a_busy_repo() {
  CASE="140a a drain while another launch holds the repo"; fixture c140
  sed "s/Story $STORY/Story 901/" "$REPO/.stories/$STORY.md" > "$REPO/.stories/901.md"
  git -C "$REPO" add .stories/901.md && git -C "$REPO" commit -qm "fixture: story 901" && git -C "$REPO" push -q
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s/notified"\n' "$TRACE" > "$FX/notify"; chmod +x "$FX/notify"
  local holder
  codex_called() { grep -q '^codex$' "$TRACE/calls"; }
  launch_bg 900 "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=gate MAX_ROUNDS=1 AGENT_TIMEOUT=120
  holder=$BG_PID
  wait_for 60 codex_called || fail "the background launcher never reached its reviewer"
  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 FLEET_NOTIFY_CMD="$FX/notify"
  assert_eq "$QRC" 0 "the drain exits cleanly"
  assert_grep "a launch is already running \(pid $holder, story $STORY\) — leaving the queue to the next drain" "$FX/queue.log" "it says who has the repo"
  assert_not_grep 'refreshing from origin' "$FX/queue.log" "no refresh beside a live launcher"
  assert_eq "$(frontmatter "$REPO/.stories/901.md" status)" ready "901 waits"
  assert_eq "$(calls claude)" 1 "only the holder's builder ran"
  assert_no_file "$TRACE/notified" "nobody was told"
  open_gate; wait "$holder"

  CASE="140b a launch that finds the repo taken after the reap"; fixture c140b
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s/notified"\n' "$TRACE" > "$FX/notify"; chmod +x "$FX/notify"
  mv "$FLEET/fleet" "$FLEET/fleet.real"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'if [[ "$1" == launch && "$3" != --reap ]]; then\n'
    printf '  printf "4242 story 777\\n" > "%s/.git/fleet-launch.lock"\n' "$REPO"
    printf '  exit 75\n'
    printf 'fi\n'
    printf 'exec bash "%s/fleet.real" "$@"\n' "$FLEET"
  } > "$FLEET/fleet"
  chmod +x "$FLEET/fleet"
  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 FLEET_NOTIFY_CMD="$FX/notify"
  assert_eq "$QRC" 0 "the drain exits cleanly"
  assert_grep 'a launch is already running \(pid 4242, story 777\) — leaving the queue to the next drain' "$FX/queue.log" "the same line"
  assert_eq "$(grep -c 'is ready again without having finished' "$FX/queue.log")" 0 "not mistaken for a story that never finished"
  assert_eq "$(field status)" ready "the story waits"
  assert_no_file "$TRACE/notified" "nobody was told"
}

# A reviewer its provider refused costs no round and pauses the story. On
# 21 Sep (khaita 015 round 3) codex answered "You've hit your usage limit
# … try again at 2:17 PM"; the launcher read the empty review as
# UNPARSEABLE, burned the round, ran the builder again on a placeholder, and
# the phone got "015 needs_human — " with no reason. Now: the round is not
# counted, the builder's work stays on its branch, line 3 says UNAVAILABLE,
# `not_before` holds codex's reset, the story waits at needs_human for a
# human's choice, and one message offers it — /wait or /fallback. Red while
# ts/src/launch.ts reads the refusal as the reviewer's verdict.
case_141_refused_reviewer_costs_no_round() {
  local resets msgs
  notifier() { printf '#!/usr/bin/env bash\nprintf "%%s\\n---\\n" "$*" >> "%s/notified"\n' "$TRACE" > "$FX/notify"; chmod +x "$FX/notify"; }
  for exitcode in 1 0; do
    CASE="141 codex refuses the round-1 review (codex exits $exitcode)"; fixture "c141-$exitcode"; notifier
    resets=$(( $(date +%s) + 3600 ))
    run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit FAKE_REVIEWER_EXIT="$exitcode" FAKE_CODEX_RESETS_AT="$resets" FLEET_NOTIFY_CMD="$FX/notify"
    assert_eq "$RC" 69 "refused is its own exit code"
    assert_eq "$(field status)" needs_human "the story waits for a human's choice"
    assert_eq "$(field round)" 0 "the round is not counted"
    assert_eq "$(review_line 3)" "verdict: UNAVAILABLE" "line 3 names the outcome"
    assert_eq "$(field not_before)" "$(date -d "@$resets" -Iseconds)" "not before codex's reset, from its sessions"
    assert_grep '^## Round 1 — UNAVAILABLE' "$REPO/.review/$STORY.md" "the round's section"
    assert_grep "^computed: UNAVAILABLE — reviewer unavailable: You've hit your usage limit" "$REPO/.review/$STORY.md" "…with codex's own words"
    assert_eq "$(calls claude)" 1 "the builder ran once"
    assert_eq "$(calls codex)" 1 "the reviewer was asked once"
    assert_eq "$(git -C "$REPO" rev-list --count "base..story/$STORY")" 1 "the builder's commit is kept on its branch"
    assert_contains "$(tracked)" ".review/$STORY/round-1/reviewer.unavailable.jsonl" "the refusal is evidence, committed"
    assert_grep 'turn.failed' "$REPO/.review/$STORY/round-1/reviewer.unavailable.jsonl" "…the stream as codex sent it"
    msgs="$(cat "$TRACE/notified" 2>/dev/null)"
    assert_eq "$(grep -c '^---$' <<< "$msgs")" 1 "one message"
    assert_contains "$msgs" "t/$STORY — Codex refused the review" "it names the repo, the story and who refused"
    assert_contains "$msgs" "try again at 2:17 PM" "codex's words"
    assert_contains "$msgs" "/wait t $STORY" "the first choice"
    assert_contains "$msgs" "/fallback t $STORY" "the second"
    assert_not_contains "$msgs" "needs_human —" "not the generic needs_human message"
  done

  CASE="141c a refusal in round 2 keeps round 1"; fixture c141c; notifier
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit FLEET_NOTIFY_CMD="$FX/notify"
  assert_eq "$RC" 69 "refused"
  assert_eq "$(field round)" 1 "round 1 stands, round 2 is not counted"
  assert_grep '^## Round 1 — FAIL' "$REPO/.review/$STORY.md" "round 1's section is kept"
  assert_grep '^## Round 2 — UNAVAILABLE' "$REPO/.review/$STORY.md" "round 2 says what happened"
  assert_eq "$(review_line 3)" "verdict: UNAVAILABLE" "line 3"
  assert_eq "$(review_line 4)" "rounds: 1 of 3" "rounds counts what was judged, of this launch's ceiling"
  assert_eq "$(git -C "$REPO" rev-list --count "base..story/$STORY")" 2 "both rounds' commits are kept"
  assert_contains "$(cat "$TRACE/notified")" "resume this story automatically after" "no reset known from sessions: the message's own time"
}

# A story the reviewer could not judge resumes at its review. Its builder
# finished before the refusal, so the next launch — after /wait's reset, or
# a /fallback — runs no builder round: the first round reviews the head as
# it stands, the refused round's section stays as history, and the builder's
# own TDD handover (round-N/mutations) is judged as it would have been. The
# resume still goes through computeVerdict — it can never grant a PASS. A
# second refusal replaces the trailing UNAVAILABLE section rather than
# adding one per retry. Red after case 141's change alone: the second launch
# calls the builder, and its round-2 prompt is built on a refusal.
case_142_refused_story_resumes_at_its_review() {
  CASE="142a refused, then reviewed"; fixture c142a
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$RC" 0 "the resumed launch ends normally"
  assert_eq "$(field status)" done "…done"
  assert_eq "$(calls claude)" 1 "no second builder round"
  assert_eq "$(calls codex)" 2 "the reviewer, asked again"
  assert_eq "$(field round)" 1 "one round judged"
  assert_eq "$(review_line 3)" "verdict: PASS" "line 3"
  assert_eq "$(grep -c '^## Round 1 — ' "$REPO/.review/$STORY.md")" 2 "the refused round's section stays, then the judged one"
  assert_grep '^## Round 1 — PASS' "$REPO/.review/$STORY.md" "…ending in PASS"
  assert_eq "$(field not_before)" "" "not_before is gone once the story is claimed"
  assert_grep 'reviewing the existing head, no builder round' "$LOG" "the log says why no builder ran"

  CASE="142b refused twice"; fixture c142b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit
  assert_eq "$RC" 69 "refused again"
  assert_eq "$(calls claude)" 1 "still one builder round"
  assert_eq "$(grep -c '^## Round 1 — UNAVAILABLE' "$REPO/.review/$STORY.md")" 1 "one UNAVAILABLE section, not one per retry"
  assert_eq "$(field round)" 0 "the round still not counted"

  CASE="142c a resumed review cannot be granted a PASS the machine refuses"; fixture c142c
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_VITEST=pass MAX_ROUNDS=1
  assert_eq "$(review_line 3)" "verdict: FAIL" "the reviewer said PASS; the surviving mutation vetoes it"
  assert_eq "$(field status)" needs_human "…and the story stops"

  CASE="142d the builder's own handover is judged after the resume"; fixture c142d
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=red FAKE_MUTATIONS=none FAKE_REVIEWER=limit
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_MUTATIONS=none FAKE_REVIEWER=PASS
  assert_eq "$(review_line 3)" "verdict: PASS" "AC1's only instrument is the builder's, from before the pause"
  assert_grep 'AC1 +RED +tdd-observed-red' "$REPO/.review/$STORY.md" "…and it is in the table"

  CASE="142e a refused REVIEW_ONLY run resumes without the variable"; fixture c142e
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 FAKE_MUTATIONS=none
  set_ready
  run "$STORY" REVIEW_ONLY=1 FAKE_REVIEWER=limit
  assert_eq "$RC" 69 "refused"
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$(calls claude)" 1 "only the first launch's builder ever ran"
  assert_eq "$(field status)" done "reviewed and done"
}

# The queue pauses on a refused review, waits for the story, then runs it
# first. A launch that exits 69 stops the drain — every story after it
# would be refused too — and the queue says nothing of its own: the
# launcher has sent the one message. While the refused story waits for a
# human's choice nothing starts; after /wait it holds until not_before; then
# that story runs first, ahead of lower ids, as a review-only round. Red
# while ts/src/run-queue.ts reads 69 as an ordinary needs_human and starts
# the next story.
case_143_queue_pauses_on_a_refused_review() {
  CASE="143a a refused review stops the drain"; fixture c143 draft
  sed "s/Story $STORY/Story 901/; s/^status: draft/status: ready/" "$REPO/.stories/$STORY.md" > "$REPO/.stories/901.md"
  git -C "$REPO" add .stories/901.md && git -C "$REPO" commit -qm "fixture: story 901" && git -C "$REPO" push -q
  printf '#!/usr/bin/env bash\nprintf "%%s\\n---\\n" "$*" >> "%s/notified"\n' "$TRACE" > "$FX/notify"; chmod +x "$FX/notify"
  sent_count() { grep -c '^---$' "$TRACE/notified" 2>/dev/null || echo 0; }
  s901() { frontmatter "$REPO/.stories/901.md" "$1"; }

  queue FAKE_BUILDER=commit FAKE_REVIEWER=limit FLEET_NOTIFY_CMD="$FX/notify"
  assert_eq "$QRC" 0 "the drain exits cleanly"
  assert_eq "$(s901 status)" needs_human "901 waits for a choice"
  assert_grep "901: an agent's provider refused the call — the drain stops here" "$FX/queue.log" "the drain says why it stopped"
  assert_eq "$(sent_count)" 1 "one message, the launcher's"
  assert_contains "$(cat "$TRACE/notified")" "/wait t 901" "…the one with the choices"

  CASE="143b no answer yet: nothing starts"
  sed -i 's/^status: draft/status: ready/' "$REPO/.stories/$STORY.md"
  git -C "$REPO" commit -qam "900 promoted meanwhile"
  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS FLEET_NOTIFY_CMD="$FX/notify"
  assert_grep 'paused: 901 waits for /wait or /fallback' "$FX/queue.log" "the pause is named"
  assert_eq "$(field status)" ready "900 does not jump the pause"
  assert_eq "$(calls claude)" 1 "no builder ran"
  assert_eq "$(sent_count)" 1 "nothing new was sent"

  CASE="143c /wait: held until not_before"
  sed -i '0,/^status:.*/s//status: ready/' "$REPO/.stories/901.md"
  git -C "$REPO" commit -qam "/wait 901"
  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS FLEET_NOTIFY_CMD="$FX/notify"
  assert_contains "$(cat "$FX/queue.log")" "holding for 901 until $(s901 not_before)" "the hold names the story and the time"
  assert_eq "$(field status)" ready "900 still waits"
  assert_eq "$(calls claude)" 1 "no builder ran"

  CASE="143d the reset has passed: the paused story first, then the rest"
  sed -i "s/^not_before:.*/not_before: $(date -d '-1 minute' -Iseconds)/" "$REPO/.stories/901.md"
  git -C "$REPO" commit -qam "the reset passed"
  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 FLEET_NOTIFY_CMD="$FX/notify"
  assert_eq "$(s901 status)" done "901 reviewed and done"
  assert_eq "$(field status)" done "then 900"
  assert_eq "$(grep -oE 'story (900|901) \(' "$FX/queue.log" | head -1)" "story 901 (" "901 went first, ahead of the lower id"
  assert_eq "$(calls claude)" 2 "901's resumed round built nothing; 900's did"
}

# /wait and /fallback: the human's two answers to a refused review, from the
# phone. Both only for a story paused on one (needs_human, line 3
# UNAVAILABLE). /wait makes it ready and keeps not_before, which the queue
# holds for; /fallback makes it ready with `reviewer: claude` and no
# not_before, for the next drain. Red while ts/src/telegram.ts does not know
# the verbs: the bot answers with its help.
case_144_bot_wait_and_fallback() {
  CASE="144a /wait on a story that is not paused"; fixture c144a
  update 144 42 "/wait t $STORY"
  bot poll
  assert_contains "$(sent_text)" "$STORY is not waiting for a reviewer choice" "refused, and said why"
  assert_eq "$(field status)" ready "untouched"

  CASE="144b /wait on a paused story"; fixture c144b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit
  local nb head; nb="$(field not_before)"
  update 145 42 "/wait t $STORY"
  bot poll
  assert_eq "$(field status)" ready "ready again"
  assert_eq "$(field not_before)" "$nb" "the reset it waits for is kept"
  assert_contains "$(git -C "$REPO" log -1 --format=%s)" "wait for the reviewer" "committed, which is what the queue reads"
  assert_contains "$(sent_text)" "then is reviewed first" "the human is told what happens next"

  CASE="144c /fallback on a paused story"; fixture c144c
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit
  update 146 42 "/fallback t $STORY"
  bot poll
  assert_eq "$(field status)" ready "ready again"
  assert_eq "$(field reviewer)" claude "Claude reviews it"
  assert_eq "$(field not_before)" "" "nothing to wait for"
  assert_contains "$(git -C "$REPO" log -1 --format=%s)" "reviewed by Claude instead" "committed"
  assert_contains "$(sent_text)" "weaker check" "the reply says what the choice costs"
  head="$(git -C "$REPO" rev-parse HEAD)"
  update 147 42 "/fallback t $STORY"
  bot poll
  assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$head" "a second /fallback changes nothing"
}

# The builder refused by Claude (a usage limit): one message, then nothing.
# The human decided (25 Sep): no retry, no fallback, no hold. The round is
# not counted, whatever the builder committed before the refusal stays on
# its branch and is not reviewed, the story stops at needs_human, and the
# launcher exits 69 so the drain stops. Red while ts/src/launch.ts reads the
# refusal as a round that "produced no commits" — or, with a commit, sends
# a half-built round to the reviewer.
case_145_builder_refused_by_claude() {
  notifier() { printf '#!/usr/bin/env bash\nprintf "%%s\\n---\\n" "$*" >> "%s/notified"\n' "$TRACE" > "$FX/notify"; chmod +x "$FX/notify"; }
  local msgs
  CASE="145a the builder refused"; fixture c145a; notifier
  run "$STORY" FAKE_BUILDER=limit FAKE_REVIEWER=PASS FLEET_NOTIFY_CMD="$FX/notify"
  assert_eq "$RC" 69 "refused is its own exit code"
  assert_eq "$(field status)" needs_human "the story stops"
  assert_eq "$(field round)" 0 "the round is not counted"
  assert_eq "$(calls codex)" 0 "nothing was reviewed"
  assert_no_file "$REPO/.review/$STORY.md" "no review: nothing was judged"
  msgs="$(cat "$TRACE/notified" 2>/dev/null)"
  assert_eq "$(grep -c '^---$' <<< "$msgs")" 1 "one message"
  assert_contains "$msgs" "t/$STORY — Claude refused the builder" "who refused"
  assert_contains "$msgs" "resets 3pm" "…in Claude's words"
  assert_contains "$msgs" "Nothing else will happen" "…and that nothing follows"
  assert_contains "$msgs" "/promote t $STORY" "…and how to go on"
  assert_not_contains "$msgs" "/wait" "no choices offered: the human decided on none"

  CASE="145b refused after a commit"; fixture c145b; notifier
  run "$STORY" FAKE_BUILDER=commit-then-limit FAKE_REVIEWER=PASS FLEET_NOTIFY_CMD="$FX/notify"
  assert_eq "$RC" 69 "refused"
  assert_eq "$(git -C "$REPO" rev-list --count "base..story/$STORY")" 1 "the commit stays on the branch"
  assert_eq "$(calls codex)" 0 "a half-built round is not reviewed"

  CASE="145c the drain stops at it"; fixture c145c; notifier
  sed "s/Story $STORY/Story 901/" "$REPO/.stories/$STORY.md" > "$REPO/.stories/901.md"
  git -C "$REPO" add .stories/901.md && git -C "$REPO" commit -qm "fixture: story 901" && git -C "$REPO" push -q
  queue FAKE_BUILDER=limit FAKE_REVIEWER=PASS FLEET_NOTIFY_CMD="$FX/notify"
  assert_eq "$QRC" 0 "the drain exits cleanly"
  assert_eq "$(frontmatter "$REPO/.stories/901.md" status)" ready "901 was not started"
  assert_eq "$(calls claude)" 1 "one builder call"
  assert_eq "$(grep -c '^---$' "$TRACE/notified")" 1 "one message, the launcher's"
  assert_grep "$STORY: an agent's provider refused the call — the drain stops here" "$FX/queue.log" "the drain says why it stopped"

  CASE="145d the story writer refused: said plainly"; fixture c145d
  git -C "$REPO" push -q origin base:epic/test
  local out rc
  out="$( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID=950 FAKE_BUILDER=limit \
          bash "$FLEET/fleet" write-story t 950 "an intent" --base epic/test 2>&1 )"; rc=$?
  assert_eq "$rc" 1 "a die"
  assert_contains "$out" "Claude refused the story writer: You've hit your limit" "…saying who refused, in its words"
}

# The fallback reviewer: after a human's /fallback on a refused review,
# Claude reviews the story — every round of that launch — with the same
# prompt, the same output contract (.review-out/, a clean tree) and the same
# computed verdict: the machine still vetoes, never grants. The Machine
# block says who reviewed. The launch removes `reviewer: claude` when it
# claims the story, so the choice covers that launch alone. If Claude
# refuses the review too, the story pauses as with codex. Red while
# ts/src/launch.ts ignores the key: codex is asked again, and refuses again.
case_146_fallback_reviewer_is_claude() {
  fallback() {                        # what /fallback commits, done by hand
    sed -i '0,/^status:.*/s//status: ready/; /^not_before:/d' "$REPO/.stories/$STORY.md"
    sed -i '0,/^---$/!{0,/^---$/s/^---$/reviewer: claude\n---/}' "$REPO/.stories/$STORY.md"
    git -C "$REPO" commit -qam "story($STORY): reviewed by Claude instead"
  }
  CASE="146a /fallback, then Claude reviews"; fixture c146a
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit
  fallback
  assert_eq "$(field reviewer)" claude "the fixture stands in for /fallback"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit FAKE_CLAUDE_REVIEWER=PASS
  assert_eq "$RC" 0 "the launch ends normally"
  assert_eq "$(field status)" done "reviewed and done"
  assert_eq "$(calls codex)" 1 "codex was not asked again"
  assert_eq "$(calls claude-review)" 1 "Claude reviewed"
  assert_eq "$(calls claude)" 1 "no builder round: the story resumed at its review"
  assert_grep '^reviewer: claude opus \(fallback\) → claude-opus-fake$' "$REPO/.review/$STORY.md" "the Machine block says who reviewed"
  assert_grep '^--model$' "$TRACE/claude-review-args-1" "claude was given a model…"
  assert_grep '^opus$' "$TRACE/claude-review-args-1" "…opus"
  assert_eq "$(field reviewer)" "" "the choice was for that launch: the key is gone"

  CASE="146b Claude's PASS is still the machine's to veto"; fixture c146b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit
  fallback
  run "$STORY" FAKE_BUILDER=commit FAKE_CLAUDE_REVIEWER=PASS FAKE_VITEST=pass MAX_ROUNDS=1
  assert_eq "$(review_line 3)" "verdict: FAIL" "a mutation that survives vetoes Claude's PASS"

  CASE="146c Claude refuses the fallback review too"; fixture c146c
  printf '#!/usr/bin/env bash\nprintf "%%s\\n---\\n" "$*" >> "%s/notified"\n' "$TRACE" > "$FX/notify"; chmod +x "$FX/notify"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit
  fallback
  run "$STORY" FAKE_BUILDER=commit FAKE_CLAUDE_REVIEWER=limit FLEET_NOTIFY_CMD="$FX/notify"
  assert_eq "$RC" 69 "refused"
  assert_eq "$(field status)" needs_human "paused again"
  assert_eq "$(review_line 3)" "verdict: UNAVAILABLE" "line 3"
  assert_contains "$(cat "$TRACE/notified")" "t/$STORY — Claude refused the review" "the message names Claude"
  assert_eq "$(grep -c '^## Round 1 — UNAVAILABLE' "$REPO/.review/$STORY.md")" 1 "still one UNAVAILABLE section"
}

# Commits and PRs carry the human's name only: no Co-Authored-By, no
# Claude-Session link, no "Generated with". Claude Code adds them unless its
# `attribution` setting says otherwise, so every claude the fleet starts gets
# that setting on the command line: an unattended run must not depend on
# ~/.claude/settings.json, which `claude doctor` has rewritten before. The
# models stay recorded where they were: the Machine block and the round
# evidence. Red while builderArgv passes no --settings.
NO_ATTRIBUTION='{"attribution":{"commit":"","pr":"","sessionUrl":false}}'
case_147_no_attribution() {
  CASE="147a the builder starts with attribution off"; fixture c147a
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(arg_after --settings "$TRACE/claude-args-1")" "$NO_ATTRIBUTION" "the builder's --settings"

  CASE="147b so does the story writer"; fixture c147b
  git -C "$REPO" push -q origin base:epic/test
  ( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID=951 FAKE_BUILDER=story \
      bash "$FLEET/fleet" write-story t 951 "the moon toggle should show a moon" --base epic/test >/dev/null 2>&1 )
  assert_eq "$(calls claude)" 1 "the writer ran"
  assert_eq "$(arg_after --settings "$TRACE/claude-args-1")" "$NO_ATTRIBUTION" "the writer's --settings"
}

# L-34. A detached child of the poll is still in fleet-bot.service's cgroup,
# and a oneshot's end kills whatever is left there: the /merge job of case 99
# was killed seconds after its acknowledgement, every time, and only the
# suite — which runs the bot outside systemd — ever saw one finish. A job
# that must outlive the poll is a unit of its own, started with systemd-run.
# Red while spawnDetached forks the job itself: no systemd-run call.
case_148_bot_job_is_its_own_unit() {
  CASE="148 /merge's job runs as a unit of its own, and still reports"; fixture c148
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  update 120 42 "/merge t $STORY"
  bot poll
  wait_for_send 2
  local args="$TRACE/systemd-run-args-1"
  assert_file "$args" "the job went through systemd-run"
  assert_grep '^--user$' "$args" "in the human's user manager"
  assert_grep '^--collect$' "$args" "unloaded when it ends, failed or not"
  assert_grep '^--unit=fleet-merge-[0-9]+$' "$args" "named for what it is"
  assert_grep '^--setenv=PATH$' "$args" "with the poll's PATH — the manager's has no node"
  assert_grep '^--expand-environment=no$' "$args" "and the job's dollar-braces left for bash (L-35)"
  assert_contains "$(sent_text)" "merged into base" "and its result still reaches the human"
}

# 27 Sep. A branch on a URL other computers can open, before it lands: the
# human names the branch, the fleet builds it in <target>/../test-deploy and
# serves it from a unit of its own on a loopback port, which the web server
# the human set up once (Caddy, docs/operations.md) publishes with a
# certificate. One slot on the machine; a deploy replaces what it held.
#
# td_setup gives the fixture what production has: a port, a URL, and a
# server — here a few lines of node serving the tree's src/marker.txt, so a
# case can tell which branch is being served.
td_setup() {                          # td_setup → TD_PORT TD_SERVE, and epic/test with its own marker
  TD_PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  cat > "$FX/serve.mjs" <<'EOF'
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
createServer((_q, s) => s.end(readFileSync('src/marker.txt'))).listen(Number(process.env.PORT), '127.0.0.1');
EOF
  TD_SERVE="exec node $FX/serve.mjs"
  git -C "$REPO" checkout -q -b epic/test
  printf 'epic content\n' > "$REPO/src/marker.txt"
  git -C "$REPO" commit -qam "epic: its own marker"
  git -C "$REPO" push -q -u origin epic/test
  git -C "$REPO" checkout -q base
}
td() {                                # td <args…> → TDLOG TDRC      (TD_URL= for no URL in the environment)
  TDLOG="$FX/td.log"
  ( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" \
      TEST_DEPLOY_URL="${TD_URL-https://test.example}" TEST_DEPLOY_PORT="$TD_PORT" \
      TEST_DEPLOY_START_WAIT="${TEST_DEPLOY_START_WAIT:-15}" START_CMD="${START_CMD:-$TD_SERVE}" \
      bash "$FLEET/fleet" test-deploy t "$@" ) > "$TDLOG" 2>&1
  TDRC=$?
}
served() { curl -s --max-time 5 "http://127.0.0.1:$TD_PORT/"; }
td_unit_pid() { cat "$TRACE/units/fleet-test-deploy.service.pid" 2>/dev/null; }

# Red while `fleet test-deploy` does not exist; then, one at a time, without
# the seed copy, the stop of the old server, the origin-before-local
# resolution, the build's die, and the wait for the server to answer.
case_149_test_deploy() {
  CASE="149a an epic is built in ../test-deploy and served on the test port"; fixture c149a; td_setup
  td epic/test
  assert_eq "$TDRC" 0 "exit code"
  assert_contains "$(cat "$TDLOG")" "t epic/test ($(git -C "$REPO" rev-parse --short origin/epic/test)) is up at https://test.example" "the last word is the URL"
  assert_eq "$(tail -n 1 "$TDLOG" | sed 's/\x1b\[[0-9;]*m//g')" "==> t epic/test ($(git -C "$REPO" rev-parse --short origin/epic/test)) is up at https://test.example" "on the last line"
  assert_eq "$(served)" "epic content" "the epic's tree is what is served"
  assert_eq "$(git -C "$FX/test-deploy" rev-parse HEAD)" "$(git -C "$REPO" rev-parse origin/epic/test)" "a worktree at the epic's tip"
  assert_file "$FX/test-deploy/.env.local" "seeded like any worktree"
  local a; a="$(ls "$TRACE"/systemd-run-args-* | tail -n 1)"
  assert_grep '^--unit=fleet-test-deploy$' "$a" "served by the one test unit"
  assert_grep "^--working-directory=$FX/test-deploy\$" "$a" "from the tree"
  assert_grep "^--setenv=PORT=$TD_PORT\$" "$a" "on the test port"
  assert_grep '^--user$' "$a" "in the human's user manager"
  assert_grep '^--expand-environment=no$' "$a" "START_CMD's dollar-braces left for bash (L-35)"
  td --status
  assert_eq "$TDRC" 0 "--status exit code"
  assert_contains "$(cat "$TDLOG")" "t epic/test ($(git -C "$REPO" rev-parse --short origin/epic/test)) at https://test.example — up since" "--status says what is served and that it is up"
  flock -n "$REPO/.git/fleet-launch.lock" true && ok || fail "the launch lock is free again after the deploy"

  CASE="149b a local story branch replaces it; the old server is stopped"
  local old; old="$(td_unit_pid)"
  git -C "$REPO" checkout -q -b "story/$STORY"
  printf 'story content\n' > "$REPO/src/marker.txt"
  git -C "$REPO" commit -qam "story: its own marker"
  git -C "$REPO" checkout -q base
  td "story/$STORY"
  assert_eq "$TDRC" 0 "exit code"
  assert_eq "$(served)" "story content" "the local branch is served — origin has none"
  kill -0 "$old" 2>/dev/null && fail "the old server still runs" || ok
  assert_grep '^systemctl --user stop fleet-test-deploy' "$TRACE/calls" "stopped through its unit"

  CASE="149c origin's tip wins over a stale local branch of the same name"
  git -C "$REPO" branch -f epic/test base
  td epic/test
  assert_eq "$(served)" "epic content" "origin/epic/test, not the local one"

  CASE="149d an unknown branch or a bad name is refused and the deploy stays"
  td nosuch
  assert_eq "$TDRC" 1 "exit code"
  assert_contains "$(cat "$TDLOG")" "no branch nosuch on origin or in $REPO" "says so"
  assert_eq "$(served)" "epic content" "what was served still is"
  local bad
  for bad in '--upload-pack=x' 'a..b' 'epic/test;id' ''; do
    td "$bad"
    [[ "$TDRC" != 0 ]] && ok || fail "'$bad' was accepted"
  done
  assert_eq "$(served)" "epic content" "and still is"

  CASE="149e a red build dies, and nothing is served afterwards"
  BUILD_CMD=false td epic/test
  assert_eq "$TDRC" 1 "exit code"
  assert_contains "$(cat "$TDLOG")" "build failed" "names the step"
  assert_eq "$(served)" "" "the old server went before the build"
  td --status
  assert_contains "$(cat "$TDLOG")" "nothing is deployed for testing" "--status agrees"

  CASE="149f a server that never answers is a die, not a URL"
  START_CMD=false td epic/test
  assert_eq "$TDRC" 1 "exit code"
  assert_contains "$(cat "$TDLOG")" "the server exited" "says so"
  assert_not_contains "$(cat "$TDLOG")" "is up at" "no URL"

  CASE="149g --stop stops it and removes the tree"
  td epic/test
  assert_eq "$(served)" "epic content" "precondition: served"
  td --stop
  assert_eq "$TDRC" 0 "exit code"
  assert_contains "$(cat "$TDLOG")" "stopped t epic/test" "says what it stopped"
  assert_eq "$(served)" "" "nothing answers"
  [[ -d "$FX/test-deploy" ]] && fail "the tree is still there" || ok
  td --stop
  assert_contains "$(cat "$TDLOG")" "nothing is deployed for testing" "a second stop has nothing to do"
  assert_eq "$TDRC" 0 "and is not an error"

  CASE="149h no URL: a die naming where it goes; .env.fleet is read"
  TD_URL= td epic/test
  assert_eq "$TDRC" 1 "exit code"
  assert_contains "$(cat "$TDLOG")" "TEST_DEPLOY_URL" "names the setting"
  assert_contains "$(cat "$TDLOG")" ".env.fleet" "and the file"
  printf 'TEST_DEPLOY_URL=https://from-file.example\n' > "$FLEET/.env.fleet"
  TD_URL= td epic/test
  assert_eq "$TDRC" 0 "read from .env.fleet"
  assert_contains "$(cat "$TDLOG")" "is up at https://from-file.example" "that URL"
  rm -f "$FLEET/.env.fleet"

  CASE="149i a launch that holds the lock is waited for, up to TEST_DEPLOY_LOCK_WAIT"; fixture c149i; td_setup
  printf '4242 launch 900\n' > "$REPO/.git/fleet-launch.lock"
  # -o: the lock stays with flock, not its sleep, so killing flock frees it.
  flock -o "$REPO/.git/fleet-launch.lock" sleep 30 & local holder=$!
  wait_for 5 bash -c "! flock -n '$REPO/.git/fleet-launch.lock' true"
  TEST_DEPLOY_LOCK_WAIT=1 td epic/test
  assert_eq "$TDRC" 75 "busy, as a second launch is"
  assert_contains "$(cat "$TDLOG")" "4242 launch 900" "names the holder"
  assert_no_file "$TRACE/systemd-run-args-1" "nothing was started"
  [[ -d "$FX/test-deploy" ]] && fail "a tree was made" || ok
  kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
  flock "$REPO/.git/fleet-launch.lock" sleep 2 & holder=$!
  wait_for 5 bash -c "! flock -n '$REPO/.git/fleet-launch.lock' true"
  TEST_DEPLOY_LOCK_WAIT=20 td epic/test
  assert_eq "$TDRC" 0 "a holder that lets go in time is waited for"
  assert_contains "$(cat "$TDLOG")" "t epic/test: waiting for the launch lock — launch 900 (pid 4242) holds it; the build starts when it is free, and gives up after 20s" "and says it waits, for whom, and how long"
  assert_eq "$(served)" "epic content" "then deploys"
  wait "$holder" 2>/dev/null
}

# The phone half. /testdeploy <repo> <branch> answers at once and starts the
# build as a unit of its own — it takes minutes and the poll has two (L-33,
# L-34); the build sends the URL when the server answers. With no branch it
# is --status, with `stop` --stop. With one repo registered a branch in the
# repo slot is a branch: a repo name never holds a '/'.
# Red while the verb is unknown; then without the detached job.
case_150_bot_testdeploy() {
  CASE="150a /testdeploy builds from the phone and sends the URL when it is up"; fixture c150; td_setup
  update 130 42 "/testdeploy t epic/test"
  TEST_DEPLOY_URL=https://test.example TEST_DEPLOY_PORT="$TD_PORT" START_CMD="$TD_SERVE" bot poll
  assert_eq "$(sent)" 1 "the acknowledgement first"
  assert_contains "$(sent_text)" "building epic/test" "which says it builds"
  wait_for_send 2
  assert_contains "$(sent_text)" "t epic/test ($(git -C "$REPO" rev-parse --short origin/epic/test)) is up at https://test.example" "then the URL"
  assert_eq "$(served)" "epic content" "and it is served"
  assert_grep '^--unit=fleet-test-deploy-build$' "$TRACE/systemd-run-args-1" "the build is a unit of its own"

  CASE="150b /testdeploy with no branch is the status, and a branch alone finds the one repo"
  api_clear
  update 131 42 "/testdeploy t"
  TEST_DEPLOY_URL=https://test.example TEST_DEPLOY_PORT="$TD_PORT" bot poll
  assert_contains "$(sent_text)" "t epic/test ($(git -C "$REPO" rev-parse --short origin/epic/test)) at https://test.example — up since" "the status"
  api_clear
  update 132 42 "/testdeploy nosuch/branch"
  TEST_DEPLOY_URL=https://test.example TEST_DEPLOY_PORT="$TD_PORT" START_CMD="$TD_SERVE" bot poll
  assert_contains "$(sent_text)" "building nosuch/branch" "a word with a / is a branch of the one repo"
  wait_for_send 2
  assert_contains "$(sent_text)" "no branch nosuch/branch" "whose failure is sent too"

  CASE="150c /testdeploy stop, and a bad name is refused before anything starts"
  api_clear
  update 133 42 "/testdeploy t a..b"
  bot poll
  assert_contains "$(sent_text)" "not a branch name" "refused"
  local n; n="$(ls "$TRACE"/systemd-run-args-* | wc -l)"
  api_clear
  update 134 42 "/testdeploy t stop"
  TEST_DEPLOY_URL=https://test.example TEST_DEPLOY_PORT="$TD_PORT" bot poll
  assert_contains "$(sent_text)" "stopped t epic/test" "the failed deploy never touched what was served"
  assert_eq "$(ls "$TRACE"/systemd-run-args-* | wc -l)" "$n" "and no job was started for either"
  api_clear
  update 135 42 "/help"
  bot poll
  assert_contains "$(sent_text)" "/testdeploy <repo> <branch>" "/help lists it"

  CASE="150d /testdeploy behind a launch says so at once, and the status says it waits"; fixture c150d; td_setup
  printf '4242 story 045\n' > "$REPO/.git/fleet-launch.lock"
  flock -o "$REPO/.git/fleet-launch.lock" sleep 60 & local holder=$!
  wait_for 5 bash -c "! flock -n '$REPO/.git/fleet-launch.lock' true"
  update 136 42 "/testdeploy t epic/test"
  TEST_DEPLOY_URL=https://test.example TEST_DEPLOY_PORT="$TD_PORT" START_CMD="$TD_SERVE" bot poll
  assert_contains "$(sent_text)" "building epic/test" "the acknowledgement"
  wait_for_send 2 20
  assert_contains "$(sent_text)" "t epic/test: waiting for the launch lock — story 045 (pid 4242) holds it" "told at once who holds the lock (L-37)"
  assert_not_contains "$(sent_text)" "is up at" "while nothing is built"
  api_clear
  update 137 42 "/testdeploy t"
  TEST_DEPLOY_URL=https://test.example TEST_DEPLOY_PORT="$TD_PORT" bot poll
  assert_contains "$(sent_text)" "t epic/test: waiting for the launch lock — story 045 (pid 4242) holds it" "the status says it waits, and for whom"
  kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
  wait_for_send 2
  assert_contains "$(sent_text)" "t epic/test ($(git -C "$REPO" rev-parse --short origin/epic/test)) is up at https://test.example" "then the URL, once the lock is free"
  api_clear
  update 138 42 "/testdeploy t"
  TEST_DEPLOY_URL=https://test.example TEST_DEPLOY_PORT="$TD_PORT" bot poll
  assert_not_contains "$(sent_text)" "waiting for the launch lock" "the wait is over"
  assert_contains "$(sent_text)" "up since" "the status is the deploy's again"
}

# 151: 28 Sep. An epic landed from the phone while a launcher was mid-round.
# merge.ts does not fast-forward a checkout with changes in it, so origin's
# base moved on without the local one, and every status push after that was
# refused ("status push failed — queue not visible remotely"), the merge
# record's too, until a human pushed by hand (L-36). A refused push now merges
# the upstream in, as the queue's refresh does, and pushes once more; the
# refresh pushes what its merge left ahead. Red against launch.ts, merge.ts
# and run-queue.ts without them.
origin_moves() {                      # origin_moves <msg> → LANDED: a commit on origin's base from another clone
  rm -rf "$FX/elsewhere"
  git clone -q "$FX/origin.git" "$FX/elsewhere"
  printf '%s\n' "$1" > "$FX/elsewhere/landed.txt"
  git -C "$FX/elsewhere" add landed.txt
  git -C "$FX/elsewhere" -c user.name=fleet-test -c user.email=fleet-test@localhost commit -qm "$1"
  git -C "$FX/elsewhere" push -q origin base
  LANDED="$(git -C "$FX/elsewhere" rev-parse HEAD)"
}
level_with_origin() {                 # level_with_origin <what> — the checkout's base is origin's, and holds LANDED
  git -C "$REPO" fetch -q origin
  assert_eq "$(git -C "$REPO" rev-parse base)" "$(git -C "$REPO" rev-parse origin/base)" "$1: the checkout and origin agree"
  git -C "$REPO" merge-base --is-ancestor "$LANDED" base && ok || fail "$1: what landed elsewhere is kept, not rewritten"
}
case_151_refused_push_follows_origin() {
  CASE="151 a status push refused because origin moved merges origin in and pushes again"; fixture c151
  origin_moves "an epic landed elsewhere"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "the story ran"
  assert_not_grep 'status push failed' "$LOG" "no status push was left behind"
  level_with_origin "after the launch"
  git -C "$REPO" show "origin/base:.stories/$STORY.md" | grep -q '^status: done' \
    && ok || fail "origin holds the story's last status"

  CASE="151b the merge record's push too"; epic_story c151b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  origin_moves "an epic landed elsewhere"
  merge_run
  assert_eq "$MRC" 0 "merged"
  assert_not_grep 'push failed' "$MLOG" "the record's push went"
  level_with_origin "after the merge"
  git -C "$REPO" show "origin/base:.stories/$STORY.md" | grep -q '^merged: ' \
    && ok || fail "the record reached origin"

  CASE="151c the queue's refresh pushes what its merge left ahead"; fixture c151c draft
  origin_moves "an epic landed elsewhere"
  printf 'refused\n' > "$REPO/status.txt"
  git -C "$REPO" add status.txt
  git -C "$REPO" commit -qm "story(900): a status commit whose push was refused"
  queue MAX=0
  assert_grep 'refreshed from origin/base' "$FX/queue.log" "the refresh merged"
  level_with_origin "after the refresh"
  git -C "$REPO" show origin/base:status.txt >/dev/null 2>&1 && ok || fail "the local commit reached origin"

  # The same guard landing keeps (case 120d): a tree with someone's edit in
  # it is told, not merged into.
  CASE="151d a checkout with changes of its own is not merged into; the warning stays"; fixture c151d
  origin_moves "an epic landed elsewhere"
  printf 'a human is editing this\n' >> "$REPO/README.md"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "the story ran"
  assert_grep 'status push failed — queue not visible remotely' "$LOG" "the warning stays"
  git -C "$REPO" merge-base --is-ancestor "$LANDED" base && fail "origin was merged into a dirty checkout" || ok
  assert_grep 'a human is editing this' "$REPO/README.md" "the edit survives"
}

# A browser suite sees what neither the tests (jsdom) nor the build see. A
# repo opts in with E2E_CMD in .fleet/config; the launcher runs it after the
# lint, and a red run vetoes like a red build. Red without E2E_CMD in
# lib.sh's keys, without the baseline step, or without the veto.
case_152_e2e_baseline() {
  baseline_case c152 "152 baseline e2e RED vetoes PASS" 'lint GREEN \| e2e RED' E2E_CMD=false
  assert_file "$REPO/.review/$STORY/round-1/baseline/e2e.log" "e2e log kept"

  CASE="152b a green e2e run is recorded, and both agents are told it runs"; fixture c152b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 E2E_CMD="echo E2E_RAN_7c1"
  assert_eq "$(field status)" done "story status"
  assert_eq "$(review_line 3)" "verdict: PASS" ".review line 3"
  assert_grep 'baseline: test GREEN \| build GREEN \| lint GREEN \| e2e GREEN' "$REPO/.review/$STORY.md" "machine block records the e2e run"
  assert_grep 'E2E_RAN_7c1' "$REPO/.review/$STORY/round-1/baseline/e2e.log" "the command ran in the baseline"
  assert_grep "then true, then echo E2E_RAN_7c1" "$TRACE/claude-prompt-1" "the builder is told to run it"
  assert_grep "baseline — $FLEET/test/fakes/vitest, true, true, then echo E2E_RAN_7c1 —" "$TRACE/codex-prompt-1" "the reviewer too"
  assert_grep 'lint GREEN \| e2e GREEN — the suite ran' "$TRACE/codex-prompt-1" "with the e2e run's result"

  CASE="152c a repo without E2E_CMD keeps the three-run baseline"; fixture c152c
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep 'baseline: test GREEN \| build GREEN \| lint GREEN$' "$REPO/.review/$STORY.md" "no e2e column"
  assert_no_file "$REPO/.review/$STORY/round-1/baseline/e2e.log" "no e2e log"
  assert_not_grep '\{\{E2E' "$TRACE/claude-prompt-1" "no leftover placeholder for the builder"
  assert_not_grep '\{\{E2E' "$TRACE/codex-prompt-1" "nor for the reviewer"
}

# The post-merge baseline runs the same e2e command, so a merge cannot land
# what the browser suite rejects. Red without it in merge.ts.
# L-43 (18 Oct). Two rounds were lost to criteria that were never going to
# go red for the reason stated: one already passed on the base in the
# instrument's browser, one rested on an audit rule nobody had seen fire.
# The writer's prompt and the coordinator's review now ask both questions,
# and an answer that changes an AC edits the story in the same commit.
# Red while the prompt and the two skills do not say so.
case_160_story_reds_are_real() {
  CASE="160 the writer and the coordinator ask whether each red is real"; fixture c160
  git -C "$REPO" push -q origin base:epic/test
  ( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID=960 FAKE_BUILDER=story \
      bash "$FLEET/fleet" write-story t 960 "x" --base epic/test >/dev/null 2>&1 )
  assert_grep 'environment it runs in. If so, the criterion proves nothing' "$TRACE/claude-prompt-1" "the writer: red on the base, where the instrument runs"
  assert_grep "claim about someone else's code" "$TRACE/claude-prompt-1" "the writer: a tool's behaviour is a claim"
  assert_grep 'Known weakness as not observed' "$TRACE/claude-prompt-1" "or it is stated as not observed"
  assert_grep 'Red on the base, for the reason stated' "$FLEET_HOME/skills/fleet-story/SKILL.md" "the coordinator's review asks it too"
  assert_grep "read the code, not to build, run or measure" "$FLEET_HOME/skills/fleet-story/SKILL.md" "the intent keeps the writer reading"
  assert_grep 'in the same commit as the answer' "$FLEET_HOME/skills/fleet-verdict/SKILL.md" "an answer that changes an AC edits the story"
}

case_153_merge_runs_e2e() {
  CASE="153 a red post-merge e2e run undoes the merge"; epic_story c153
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before; before="$(epic_head)"
  merge_run E2E_CMD=false
  assert_eq "$MRC" 1 "exit code (die)"
  assert_grep 'e2e RED' "$MLOG" "the message names the e2e run"
  assert_eq "$(epic_head)" "$before" "the epic is exactly where it was"
  assert_not_grep '^merged:' "$REPO/.stories/$STORY.md" "and nothing claims it merged"

  CASE="153b a green post-merge e2e run merges"; epic_story c153b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run E2E_CMD=true
  assert_eq "$MRC" 0 "exit code"
  assert_grep 'post-merge baseline: test GREEN \| build GREEN \| lint GREEN \| e2e GREEN' "$MLOG" "the e2e run is in the baseline line"
}

# An e2e suite starts servers, and a server that outlives its run, or a run
# that never returns, would stall the launcher: the baseline is synchronous
# and nothing else times it. khaita's 062 writer saw exactly that hang. The
# e2e run gets E2E_TIMEOUT seconds (default 900) and its process group is
# killed when they run out; whatever is still running in the tree afterwards
# is killed too, and either way the run is RED. Red without the timeout (the
# case waits out a 60 s sleep) or without the sweep (the sleeper survives).
case_154_e2e_bounded() {
  local t0
  CASE="154 an e2e run that never returns is killed at E2E_TIMEOUT and is RED"; fixture c154
  t0=$SECONDS
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 E2E_CMD="sleep 60" E2E_TIMEOUT=2
  (( SECONDS - t0 < 50 )) && ok || fail "the launcher waited out the sleep ($((SECONDS - t0)) s)"
  assert_eq "$(review_line 3)" "verdict: FAIL" ".review line 3 — machine veto"
  assert_grep 'lint GREEN \| e2e RED' "$REPO/.review/$STORY.md" "machine block names the e2e run"
  assert_grep 'timed out after 2 s' "$REPO/.review/$STORY/round-1/baseline/e2e.log" "the log says why"

  CASE="154b a process the e2e run leaves in the tree is killed, and the run is RED"; fixture c154b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 E2E_CMD="setsid sleep 300 >/dev/null 2>&1 & echo started"
  assert_eq "$(review_line 3)" "verdict: FAIL" ".review line 3 — machine veto"
  assert_grep 'left running' "$REPO/.review/$STORY/round-1/baseline/e2e.log" "the log names the leftover"
  pgrep -f '^sleep 300$' >/dev/null && fail "the leftover sleep is still running" || ok

  CASE="154c a post-merge e2e run that never returns is killed, and nothing lands"; epic_story c154c
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local before; before="$(epic_head)"
  t0=$SECONDS
  merge_run E2E_CMD="sleep 60" E2E_TIMEOUT=2
  (( SECONDS - t0 < 50 )) && ok || fail "the merge waited out the sleep ($((SECONDS - t0)) s)"
  assert_eq "$MRC" 1 "exit code (die)"
  assert_grep 'e2e RED' "$MLOG" "the message names the e2e run"
  assert_eq "$(epic_head)" "$before" "the epic is exactly where it was"
}

# Baseline fixes inside a round (the human's decision, 15 Oct 2026). The
# builder no longer runs the whole baseline before it hands over: the harness
# runs it anyway, and in khaita 089–096 the builder's own runs were 10–22 of
# its 25–40 minutes, never once catching a RED the harness then missed. When
# the harness's baseline is RED after a builder call, the launcher resumes
# that builder's session (`--resume <its session_id>`) with
# prompts/baseline-fix.md — the RED runs, their commands and their logs —
# before the reviewer runs, BASELINE_FIXES times at most (default 2), and
# runs the baseline again on the head the fix leaves. Red without the loop in
# ts/src/launch.ts: 155a's round fails on its RED build and passes only in
# round 2, after a whole second round; 155c–155g call claude once. 155b pins
# BASELINE_FIXES=0 as the fleet before the loop, red when the loop ignores
# the knob; 155h red when the loop runs in a REVIEW_ONLY round, 155i when it
# runs without a session to resume.
fix_build() {                         # fix_build → $FX/build.sh: RED on its first run, GREEN on every run after
  cat > "$FX/build.sh" <<EOF
n=\$(cat "$FX/builds" 2>/dev/null || echo 0)
echo \$((n + 1)) > "$FX/builds"
if [ "\$n" -eq 0 ]; then echo "src/marker.ts(1,7): error TS2322: FAKE_TYPE_ERROR_7f3"; exit 1; fi
echo "fake build GREEN, run \$((n + 1))"
EOF
}
case_155_baseline_fix_in_the_round() {
  local tip ev
  CASE="155a a RED build goes back to the builder's own session, and the round passes"; fixture c155a; fix_build
  ev="$REPO/.review/$STORY/round-1"
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=red FAKE_REVIEWER=PASS BUILD_CMD="bash $FX/build.sh"
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" done "story status"
  assert_eq "$(review_line 3)" "verdict: PASS" ".review line 3"
  assert_eq "$(review_line 4)" "rounds: 1 of 2" "passed in round 1"
  assert_eq "$(calls claude)" 2 "the builder, then one fix"
  assert_eq "$(calls codex)" 1 "reviewed once, after the baseline went GREEN"
  assert_eq "$(cat "$FX/builds" 2>/dev/null)" 2 "the build ran twice: RED, then GREEN on the fix's head"
  assert_not_grep '^--resume$' "$TRACE/claude-args-1" "the round's builder starts afresh"
  assert_not_grep 'Run them all yourself' "$TRACE/claude-prompt-1" "the rules no longer send it to run the whole baseline…"
  assert_grep 'at most 2 time\(s\) a round' "$TRACE/claude-prompt-1" "…they say a RED comes back to it, and how often"
  assert_eq "$(arg_after --resume "$TRACE/claude-args-2")" fake-session-1 "the fix resumes the builder's own session"
  assert_eq "$(arg_after --model "$TRACE/claude-args-2")" sonnet "…on the round's model"
  assert_grep 'baseline RED \(build\) — back to the builder, fix 1 of 2' "$LOG" "the log says so"
  assert_grep 'FAKE_TYPE_ERROR_7f3' "$TRACE/claude-prompt-2" "the fix prompt carries the RED log"
  assert_grep "build RED: bash $FX/build.sh" "$TRACE/claude-prompt-2" "…names the RED run"
  assert_grep 'This is fix 1 of 2' "$TRACE/claude-prompt-2" "…and which fix it is"
  assert_not_grep 'Implement the story below' "$TRACE/claude-prompt-2" "…and is not the build prompt again"
  assert_grep 'FAKE_TYPE_ERROR_7f3' "$ev/baseline-red-1/build.log" "the RED run is kept"
  assert_contains "$(tracked)" ".review/$STORY/round-1/baseline-red-1/build.log" "…and committed"
  assert_file "$ev/builder-fix-1.json" "the fix call's object is kept"
  assert_grep 'fake build GREEN, run 2' "$ev/baseline/build.log" "baseline/ is the run on the final head"
  assert_grep 'baseline: +test GREEN \| build GREEN \| lint GREEN' "$REPO/.review/$STORY.md" "the Machine block records the GREEN"
  tip="$(git -C "$REPO" rev-parse "story/$STORY")"
  assert_grep "^head: $tip\$" "$REPO/.review/$STORY.md" "the reviewed head is the fix's"
  assert_grep '^commits this round: 2$' "$REPO/.review/$STORY.md" "the fix's commit is the round's"
  assert_grep 'fake builder did: commit \(call 1\)' "$ev/builder.md" "the builder's message…"
  assert_grep 'baseline fix 1 of 2: the harness.s baseline was RED \(build\)' "$ev/builder.md" "…then the fix, marked as one…"
  assert_grep 'fake builder did: commit \(call 2\)' "$ev/builder.md" "…and what it said"
  assert_grep '^AC1 +RED +tdd-fixed' "$REPO/.review/$STORY.md" "the fix's TDD evidence is what ran…"
  assert_no_file "$ev/mutations/AC1-tdd-observed-red.patch" "…in place of the set made before the fix"

  CASE="155b BASELINE_FIXES=0: a RED baseline fails the round, as before the loop"; fixture c155b; fix_build
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 BUILD_CMD="bash $FX/build.sh" BASELINE_FIXES=0
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(review_line 3)" "verdict: FAIL" "the RED vetoes"
  assert_grep '^computed: FAIL — .*baseline build RED' "$REPO/.review/$STORY.md" "…and is the reason"
  assert_eq "$(calls claude)" 1 "the builder once, no fix"
  assert_eq "$(calls codex)" 1 "reviewed"
  assert_no_file "$REPO/.review/$STORY/round-1/baseline-red-1/build.log" "nothing moved aside"
  assert_not_grep 'back to the builder' "$LOG" "nothing said"
  assert_grep 'at most 0 time\(s\) a round' "$TRACE/claude-prompt-1" "and the rules promise no fix"

  CASE="155c fixes run out: BASELINE_FIXES calls, then the RED fails the round"; fixture c155c
  ev="$REPO/.review/$STORY/round-1"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 BUILD_CMD=false
  assert_eq "$(review_line 3)" "verdict: FAIL" "the RED vetoes"
  assert_eq "$(calls claude)" 3 "the builder and two fixes"
  assert_eq "$(arg_after --resume "$TRACE/claude-args-3")" fake-session-1 "the second fix resumes the same session"
  assert_grep 'back to the builder, fix 2 of 2' "$LOG" "the log counts them"
  assert_file "$ev/baseline-red-1/build.log" "each RED run is kept"
  assert_file "$ev/baseline-red-2/build.log" "…both"
  assert_file "$ev/baseline/build.log" "and baseline/ is the last run"
  assert_eq "$(calls codex)" 1 "reviewed once, at the end"
  assert_grep '^commits this round: 3$' "$REPO/.review/$STORY.md" "every fix commit is the round's"

  CASE="155d a fix that commits nothing ends the loop; the RED stands"; fixture c155d
  ev="$REPO/.review/$STORY/round-1"
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_RESUMED=nocommit FAKE_REVIEWER=PASS MAX_ROUNDS=1 BUILD_CMD=false
  assert_eq "$(review_line 3)" "verdict: FAIL" "the RED vetoes"
  assert_eq "$(calls claude)" 2 "one fix, not two"
  assert_grep 'baseline fix 1 made no commit — the RED baseline stands' "$LOG" "said"
  assert_file "$ev/baseline/build.log" "baseline/ is still the head's"
  assert_file "$ev/baseline-red-1/build.log" "and the RED the fix was given is kept"
  assert_eq "$(calls codex)" 1 "reviewed"

  CASE="155e a fix that asks a question blocks the story"; fixture c155e
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_RESUMED=blocked FAKE_REVIEWER=PASS BUILD_CMD=false
  assert_eq "$RC" 0 "exit code"
  assert_eq "$(field status)" blocked "story status"
  assert_file "$REPO/.blocked/$STORY.md" "the question reaches the checkout"
  assert_eq "$(calls codex)" 0 "nothing reviewed"
  assert_file "$REPO/.review/$STORY/round-1/builder-fix-1.json" "the fix call's object is kept"

  CASE="155f a fix Claude refuses stops the story; the round is not counted"; fixture c155f
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_RESUMED=limit FAKE_REVIEWER=PASS BUILD_CMD=false
  assert_eq "$RC" 69 "refused is its own exit code"
  assert_eq "$(field status)" needs_human "the story stops"
  assert_eq "$(field round)" 0 "the round is not counted"
  assert_eq "$(calls codex)" 0 "nothing reviewed"
  assert_no_file "$REPO/.review/$STORY.md" "no review: nothing was judged"

  CASE="155g a fix that hangs is killed, and the story stops"; fixture c155g
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_RESUMED=hang FAKE_REVIEWER=PASS BUILD_CMD=false AGENT_TIMEOUT=5
  assert_eq "$RC" 1 "exit code (die)"
  assert_eq "$(field status)" needs_human "story status"
  assert_grep "the builder's baseline fix 1 exceeded AGENT_TIMEOUT" "$LOG" "says which call"
  assert_eq "$(calls codex)" 0 "nothing reviewed"

  CASE="155h REVIEW_ONLY has no builder to send a RED back to"; fixture c155h
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=FAIL MAX_ROUNDS=1
  set_ready
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 REVIEW_ONLY=1 BUILD_CMD=false
  assert_eq "$(calls claude)" 1 "no builder ran, and no fix"
  assert_eq "$(review_line 3)" "verdict: FAIL" "the RED vetoes"
  assert_not_grep 'back to the builder' "$LOG" "nothing said"
  assert_not_grep 'no session to resume' "$LOG" "…not even that there is no session: no builder ran"

  CASE="155i a builder whose output names no session cannot be resumed; the RED stands"; fixture c155i
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_OUTPUT=garbage FAKE_REVIEWER=PASS MAX_ROUNDS=1 BUILD_CMD=false
  assert_eq "$(calls claude)" 1 "no fix call: a fresh builder is not the one that wrote the code"
  assert_eq "$(review_line 3)" "verdict: FAIL" "the RED vetoes"
  assert_grep 'no session to resume' "$LOG" "said"
}

# Red when the launcher writes .review/<id>.md only at the end of a launch:
# a round that stops the launch early — a question in .blocked/, here —
# took every section the launch had written with it, and the next launch
# then read no prior FAIL, so its builder got the round-1 prompt without
# the findings (khaita 114: round 1 FAILed, round 2 blocked, and its review
# showed Round 3 alone).
case_158_review_keeps_rounds_across_a_stop() {
  CASE="158 a round-2 question keeps round 1's section and findings"; fixture c158
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_SEQ="commit blocked" FAKE_REVIEWER=FAIL
  assert_eq "$(field status)" blocked "round 2 asked a question"
  assert_file "$REPO/.review/$STORY.md" "the review file is written"
  assert_grep '^## Round 1 — FAIL$' "$REPO/.review/$STORY.md" "round 1's section is in it"
  assert_eq "$(review_line 3)" "verdict: FAIL" "line 3 is the last computed verdict"
  assert_eq "$(review_line 4)" "rounds: 1 of 2" "and the rounds judged so far"
  assert_grep '^## Round 1 — FAIL$' <(git -C "$REPO" show HEAD:.review/$STORY.md) "committed with the blocked status"

  # The answer: ready again, and the question gone from the worktree, as
  # the real builder removes it (khaita 114, round 3).
  set_ready; rm -f "$FX/wt-$STORY/.blocked/$STORY.md"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$(field status)" done "the answered story passes"
  assert_grep 'REJECTED' "$TRACE/claude-prompt-3" "round 3's builder is told round 1 was rejected…"
  assert_grep '^## Round 1 — FAIL$' "$TRACE/claude-prompt-3" "…and given its findings"
  assert_grep '^## Round 1 — FAIL$' "$REPO/.review/$STORY.md" "the final review keeps round 1"
  assert_grep '^## Round 3 — PASS$' "$REPO/.review/$STORY.md" "and adds round 3"
}

# L-44 (18 Oct). A blocked story, answered and set ready, is relaunched in
# the worktree it stopped in, and that worktree still held the builder's
# .blocked/<id>.md. The launcher looks for that file after every builder
# call, so unless the next builder happened to delete it (khaita 114's
# round 3 did), the story blocked again on the old question. And the
# answer never reached that builder: it is in the checkout's copy, not in
# any prompt. Red while the stale question stays in the worktree.
case_161_answered_question_does_not_block_again() {
  CASE="161 an answered question moves to the evidence; the builder gets it with the answer"; fixture c161
  run "$STORY" FAKE_BUILDER=blocked FAKE_REVIEWER=PASS
  assert_eq "$(field status)" blocked "the builder asked a question"
  assert_not_grep 'AN EARLIER QUESTION, ANSWERED' "$TRACE/claude-prompt-1" "a first launch has no answered question"
  printf '\n## Answer (telegram, 2026-10-18T12:00:00Z)\n\ntake option B\n' >> "$REPO/.blocked/$STORY.md"
  set_ready                                   # as /answer does; the worktree keeps its file
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS
  assert_eq "$(field status)" done "the answered story is built, not blocked again"
  assert_grep 'AN EARLIER QUESTION, ANSWERED' "$TRACE/claude-prompt-2" "the relaunched builder is told"
  assert_grep '^fake question: which option\?$' "$TRACE/claude-prompt-2" "…what was asked"
  assert_grep '^take option B$' "$TRACE/claude-prompt-2" "…and the answer"
  assert_file "$REPO/.review/$STORY/round-2/question.md" "the old question is kept as evidence"
  assert_contains "$(tracked)" ".review/$STORY/round-2/question.md" "and committed"
  assert_grep 'question an earlier launch' "$LOG" "the log says so"

  CASE="161b a question asked in the relaunch still blocks"; fixture c161b
  run "$STORY" FAKE_BUILDER=blocked FAKE_REVIEWER=PASS
  printf '\n## Answer (telegram, 2026-10-18T12:00:00Z)\n\ntake option B\n' >> "$REPO/.blocked/$STORY.md"
  set_ready
  run "$STORY" FAKE_BUILDER=blocked FAKE_REVIEWER=PASS
  assert_eq "$(field status)" blocked "a new question blocks"
  assert_eq "$(calls codex)" 0 "nothing reviewed"
  assert_not_grep '^take option B$' "$REPO/.blocked/$STORY.md" "the checkout holds the new question"
}

# L-42 (17 Oct). The builder ran `fleet check-mutation` over its own tdd-
# pairs before it handed over, and the mutation phase ran the same pairs
# again: 447 of 487 s of khaita 113's round-2 builder, and 67 s of an
# average round's mutation phase. The harness now runs the pairs once, right
# after a green baseline and before the reviewer, hands any that is not RED
# back to the builder's session (TDD_FIXES times), and the mutation phase
# takes their classes. Red while the launcher has no tdd check.
case_159_tdd_pairs_run_once_by_the_harness() {
  local cm calls_before
  CASE="159 a true pair is run once, after the baseline and before the reviewer"; fixture c159
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=red FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "story status"
  assert_grep 'tdd check 1: 1 RED' "$LOG" "the check ran and says so"
  assert_grep '^tdd: +check 1: 1 RED \([0-9]+s\)$' "$REPO/.review/$STORY.md" "the Machine block records it"
  assert_grep 'mutation AC1-tdd-observed-red: RED \(run by the tdd check at this head\)' "$LOG" "the mutation phase takes its class"
  assert_grep '^AC1 +RED +tdd-observed-red' "$REPO/.review/$STORY.md" "and the verdict reads it"
  cm="$(grep -n '^vitest fake.test.tsx$' "$TRACE/calls" | head -1 | cut -d: -f1)"
  calls_before="$(grep -n '^codex$' "$TRACE/calls" | head -1 | cut -d: -f1)"
  (( cm < calls_before )) && ok || fail "the pair ran before the reviewer (line $cm, codex at $calls_before)"
  assert_eq "$(grep -c '^vitest fake.test.tsx$' "$TRACE/calls")" 3 "tdd pre + mutated, then the reviewer's mutated run on the shared pre-run"
  assert_contains "$(tracked)" ".review/$STORY/round-1/tdd-check-1.txt" "the run's classes are committed"

  CASE="159b a pair that is not RED goes back to the builder's session; new pairs run at the same head"; fixture c159b
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=green FAKE_BUILDER_RESUMED=nocommit FAKE_BUILDER_MUTATIONS_RESUMED=red FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "the fixed pair passes"
  assert_eq "$(calls claude)" 2 "the builder and one tdd fix"
  assert_eq "$(arg_after --resume "$TRACE/claude-args-2")" fake-session-1 "the fix resumes the builder's session"
  assert_grep 'This is fix 1 of 2' "$TRACE/claude-prompt-2" "the fix is told which it is"
  assert_grep '^GREEN +AC1-tdd-observed-red$' "$TRACE/claude-prompt-2" "…and every pair's class"
  assert_grep 'stayed green' "$TRACE/claude-prompt-2" "…and what GREEN means"
  assert_grep 'selector \(\.test\): fake.test.tsx' "$TRACE/claude-prompt-2" "…and its selector"
  assert_eq "$(grep -c 'baseline: ' "$LOG")" 1 "no commit: the baseline is not run again"
  assert_file "$REPO/.review/$STORY/round-1/mutations/AC1-tdd-fixed.patch" "the fix's pairs are the round's"
  assert_no_file "$REPO/.review/$STORY/round-1/mutations/AC1-tdd-observed-red.patch" "…in place of the ones before"
  assert_file "$REPO/.review/$STORY/round-1/builder-tdd-fix-1.json" "the fix call's object is kept"
  assert_grep '^tdd: +check 1: 1 GREEN \([0-9]+s\) \| fix 1 \| check 2: 1 RED \([0-9]+s\)$' "$REPO/.review/$STORY.md" "the Machine block tells it"
  assert_eq "$(calls codex)" 1 "reviewed once, after the pairs are RED"

  CASE="159h a later check runs only the pairs a fix changed"; fixture c159h
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=kept+green FAKE_BUILDER_RESUMED=nocommit FAKE_BUILDER_MUTATIONS_RESUMED=kept+red FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "story status"
  assert_grep 'tdd check 2: mutation AC1-tdd-kept: RED \(run by the tdd check at this head\)' "$LOG" "the unchanged pair is not run again"
  assert_grep 'tdd check 2: mutation AC1-tdd-fixed: RED[^(]*$' "$LOG" "the fixed one is"
  assert_grep '^AC1 +RED +tdd-kept' "$REPO/.review/$STORY.md" "and both reach the verdict"

  CASE="159c a fix that commits: the baseline runs again before the pairs"; fixture c159c
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=green FAKE_BUILDER_RESUMED=commit FAKE_BUILDER_MUTATIONS_RESUMED=red FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "story status"
  assert_eq "$(grep -c 'baseline: ' "$LOG")" 2 "the baseline ran on both heads"
  assert_grep '\| fix 1 \(committed\) \| check 2: 1 RED' "$REPO/.review/$STORY.md" "the Machine block tells it"
  assert_grep '^commits this round: 2$' "$REPO/.review/$STORY.md" "the fix's commit is the round's"

  CASE="159d fixes run out: TDD_FIXES calls, then the pair fails the round"; fixture c159d
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=green FAKE_BUILDER_RESUMED=nocommit FAKE_REVIEWER=PASS MAX_ROUNDS=1 TDD_FIXES=1
  assert_eq "$(calls claude)" 2 "the builder and one fix"
  assert_grep 'still not RED after 1 fix' "$LOG" "said"
  assert_eq "$(review_line 3)" "verdict: FAIL" "the pair vetoes"
  assert_grep '^computed: FAIL — .*tdd-fixed GREEN' "$REPO/.review/$STORY.md" "the reason names it"
  assert_grep 'mutation AC1-tdd-fixed: GREEN \(run by the tdd check at this head\)' "$LOG" "not run a second time"

  CASE="159e TDD_FIXES=0: nothing goes back"; fixture c159e
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=green FAKE_REVIEWER=PASS MAX_ROUNDS=1 TDD_FIXES=0
  assert_eq "$(calls claude)" 1 "no fix call"
  assert_eq "$(review_line 3)" "verdict: FAIL" "the pair vetoes"
  assert_not_grep 'still not RED' "$LOG" "and nothing is said about fixes that were never offered"

  CASE="159f a fix that asks a question blocks the story"; fixture c159f
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=green FAKE_BUILDER_RESUMED=blocked FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" blocked "story status"
  assert_eq "$(calls codex)" 0 "nothing reviewed"

  CASE="159g the builder is told the harness runs its pairs, and how often it hands one back"; fixture c159g
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 TDD_FIXES=3
  assert_grep 'Do not run the classifier over your pairs before you hand over' "$TRACE/claude-prompt-1" "the rules say so"
  assert_grep 'at most 3 time\(s\) a round — and one still not RED' "$TRACE/claude-prompt-1" "with the knob's value"
  assert_not_grep 'tdd check' "$LOG" "no pairs handed over: no check"
}

# L-45 (20 Oct). After the VPS maintenance the user manager came up 351 s
# after the kernel. The queue timer's OnBootSec=2min was already past, and
# systemd 255 drops a past one-off firing of a timer that has Persistent=true
# and a stamp file (the same timer without either fires at once — probed);
# OnUnitActiveSec has no base until the service has run once. So the queue
# never ran in that boot: ten hours, khaita 125 stranded at in_progress,
# while the bot's timer (no Persistent) fired every minute. Red while the
# timer counts from the kernel's boot and keeps a stamp.
case_162_queue_timer_fires_after_any_boot() {
  CASE="162 the queue timer counts from the user manager's start and keeps no stamp"
  local t="$FLEET_HOME/systemd/fleet-queue@.timer"
  assert_grep '^OnStartupSec=2min$' "$t" "two minutes after the user manager starts, always in its future"
  assert_not_grep '^OnBootSec=' "$t" "not after the kernel's boot, which a late manager has passed"
  assert_not_grep '^Persistent=' "$t" "no stamp to drop the late firing by (Persistent only ever applied to OnCalendar)"
  assert_grep '^OnUnitActiveSec=15min$' "$t" "and every fifteen minutes after a drain starts"
}

# 20 Oct. The coordinator's session had been started by hand, in tmux over
# ssh, with /remote-control; the maintenance's reboots ended it and nothing
# brought it back. `fleet remote-control` runs a Claude Code Remote Control
# server in the foreground, and fleet-remote-control.service runs that at
# every start of the user manager and after every exit. Red while neither
# exists.
case_163_remote_control() {
  CASE="163 fleet remote-control serves Remote Control from REMOTE_CONTROL_DIR"; fixture c163
  local B="$FX/bin" W="$FX/work" out rc
  mkdir -p "$B" "$W"
  cat > "$B/claude" <<EOF
#!/usr/bin/env bash
pwd > "$TRACE/rc-pwd"
printf '%s\n' "\$@" > "$TRACE/rc-args"
EOF
  chmod +x "$B/claude"
  out="$( env PATH="$B:$PATH" REMOTE_CONTROL_DIR="$W" bash "$FLEET/fleet" remote-control 2>&1 )"; rc=$?
  assert_eq "$rc" 0 "the server's exit is the command's"
  assert_eq "$(cat "$TRACE/rc-pwd" 2>/dev/null)" "$W" "in REMOTE_CONTROL_DIR"
  assert_eq "$(head -n 1 "$TRACE/rc-args" 2>/dev/null)" remote-control "the server, not an interactive session"
  assert_grep '^--capacity$' "$TRACE/rc-args" "with a ceiling on its sessions"

  CASE="163b a missing directory is a die, and claude is not started"
  rm -f "$TRACE/rc-args"
  out="$( env PATH="$B:$PATH" REMOTE_CONTROL_DIR="$FX/nowhere" bash "$FLEET/fleet" remote-control 2>&1 )"; rc=$?
  assert_eq "$rc" 1 "exit 1"
  assert_contains "$out" "$FX/nowhere" "it names the directory"
  assert_no_file "$TRACE/rc-args" "nothing started"

  CASE="163c the unit runs it at every start of the user manager and after every exit"
  local u="$FLEET/systemd/fleet-remote-control.service"
  assert_grep '^ExecStart=.*/fleet remote-control$' "$u" "it runs the command"
  assert_grep '^Restart=always$' "$u" "it comes back after any exit"
  assert_grep '^StartLimitIntervalSec=0$' "$u" "and never gives up"
  assert_grep '^WantedBy=default.target$' "$u" "started with the user manager"

  CASE="163d a repo argument serves from that repo's checkout, named after it"
  mkdir -p "$FX/repos" "$FX/qr"
  printf 'REPO_PATH=%s\n' "$FX/qr" > "$FX/repos/qr.env"
  out="$( env PATH="$B:$PATH" FLEET_REGISTRY_DIR="$FX/repos" bash "$FLEET/fleet" remote-control qr 2>&1 )"; rc=$?
  assert_eq "$rc" 0 "the server's exit is the command's"
  assert_eq "$(cat "$TRACE/rc-pwd" 2>/dev/null)" "$FX/qr" "in the repo's REPO_PATH"
  assert_grep '^qr$' "$TRACE/rc-args" "named after the repo"
  out="$( env PATH="$B:$PATH" FLEET_REGISTRY_DIR="$FX/repos" bash "$FLEET/fleet" remote-control nowhere 2>&1 )"; rc=$?
  assert_eq "$rc" 1 "an unregistered repo is a die"

  CASE="163e the template unit runs one server per registered repo"
  local t="$FLEET/systemd/fleet-remote-control@.service"
  assert_grep '^ExecStart=.*/fleet remote-control %i$' "$t" "the instance is the repo"
  assert_grep '^Restart=always$' "$t" "it comes back after any exit"
  assert_grep '^WantedBy=default.target$' "$t" "started with the user manager"

  # 26 Oct: the server draws its six-line screen again every second, and on
  # stdout to the journal that was 96% of the user journal's lines, which
  # pushed the queue's history out. A per-unit LogRateLimitBurst does not
  # reach a user unit's journal (tried on systemd 255). Red while either
  # unit sends stdout to the journal.
  CASE="163f neither unit keeps the server's screen; its errors stay in the journal"
  for u in "$u" "$t"; do
    assert_grep '^StandardOutput=null$' "$u" "${u##*/}: the screen goes nowhere"
    assert_grep '^StandardError=journal$' "$u" "${u##*/}: its errors are kept"
  done
}

# 20 Oct. A second project will drain beside khaita on a 7.9 GB box, and one
# lane peaked at 1.8 GB (25 Sep). A drain that finds less than
# LAUNCH_MIN_FREE_MB (default 2500) available launches nothing and leaves the
# repo to its next drain, as it does for a launch lock held by another. The
# file read is FLEET_MEMINFO (default /proc/meminfo), the seam this case uses.
# Red while run-queue.ts never reads it: the builder runs at 1000 MB free.
case_164_queue_waits_for_free_memory() {
  CASE="164 a drain with too little free memory launches nothing"; fixture c164
  printf 'MemTotal:  8120000 kB\nMemAvailable:  1024000 kB\n' > "$FX/meminfo"
  queue FLEET_MEMINFO="$FX/meminfo" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$QRC" 0 "the drain still exits cleanly"
  assert_grep 'only 1000 MB of memory is available \(LAUNCH_MIN_FREE_MB=2500\) — leaving the queue to the next drain' "$FX/queue.log" "it says why it left the repo"
  assert_grep 'nothing ran: only 1000 MB' "$FX/queue.log" "and the summary says nothing ran for that reason"
  assert_eq "$(field status)" ready "the story is still ready"
  assert_eq "$(calls claude)" 0 "no builder ran"

  CASE="164b the knob moves the line, and 0 turns the guard off"
  queue FLEET_MEMINFO="$FX/meminfo" LAUNCH_MIN_FREE_MB=0 FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "with the guard off the story ran"

  CASE="164c enough memory: the drain runs the story"
  fixture c164c
  printf 'MemAvailable:  3072000 kB\n' > "$FX/meminfo"
  queue FLEET_MEMINFO="$FX/meminfo" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "3000 MB is enough"

  CASE="164d a meminfo that cannot be read does not stop the fleet"
  fixture c164d
  queue FLEET_MEMINFO="$FX/nowhere" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$(field status)" done "unknown is not low"
}

# 20 Oct. A second project (a Tauri app) drains beside khaita on the same
# box. One `--all` unit walks the repos one after another, so a long khaita
# epic made the other repo wait. The launch lock is per repo already; what
# was missing was a unit per repo: fleet-queue@<repo> (service and timer),
# each running `run-queue <repo>`. Red while the units are the single --all
# pair, and while update-agents asks only about fleet-queue.service.
case_165_queue_unit_per_repo() {
  CASE="165 the queue is a template: one drain unit per registered repo"
  local s="$FLEET_HOME/systemd/fleet-queue@.service" t="$FLEET_HOME/systemd/fleet-queue@.timer"
  assert_grep '^ExecStart=.*/fleet run-queue %i --max 5$' "$s" "it drains the instance's repo, five stories at most"
  assert_not_grep 'run-queue --all' "$s" "not every repo one after another"
  assert_grep '^Type=oneshot$' "$s" "a repo's drain is never entered twice"
  assert_grep '^Environment=AGENT_TIMEOUT=3600$' "$s" "the agents' ceiling is the old unit's"
  assert_grep '^TimeoutStartSec=6h$' "$s" "so is the drain's"
  assert_grep '^MemoryHigh=3000M$' "$s" "a share of the box for two concurrent drains"
  assert_grep '^WantedBy=timers.target$' "$t" "the timer is enabled per instance"
  assert_no_file "$FLEET_HOME/systemd/fleet-queue.service" "the single --all service is gone"
  assert_no_file "$FLEET_HOME/systemd/fleet-queue.timer" "and its timer"

  CASE="165b the agent updater waits while any repo's drain runs"
  assert_grep 'fleet-queue@\*\.service' "$FLEET_HOME/bin/update-agents.sh" "it asks about every instance"
}

# 22 Oct. A target says which test runners its evidence may name. RUNNERS
# lists them; absent means vitest, so every target written before this loads
# as it did. vitest stays required: VITEST_CMD is the baseline's test step.
# cargo needs CARGO_CMD (the prefix the harness appends a selector's
# arguments to) and CARGO_PROBE_DIR (where a reviewer's Rust probe lands).
#
# Red while lib.sh does not know RUNNERS: nothing is refused and RUNNERS is
# never defaulted.
case_166_runners_config() {
  CASE="166 RUNNERS: vitest by default, cargo with its command, the rest refused"
  local d="$TMP/c166" lib="${FLEET_LIB_OVERRIDE:-$FLEET_HOME/bin/lib.sh}" out rc
  mkdir -p "$d/repos" "$d/a/target/.fleet"
  git init -q "$d/a/target"
  printf 'REPO_PATH=%s\n' "$d/a/target" > "$d/repos/t.env"
  cat > "$d/a/target/.fleet/config" <<'EOF'
BASE_BRANCH=base
INSTALL_CMD=true
VITEST_CMD='fake vitest'
BUILD_CMD=true
LINT_CMD=true
SEED_FILES=
PROBE_DIR=src
EOF
  probe() {                           # probe [VAR=value …] → out rc
    out="$( env -i PATH="$PATH" HOME="$HOME" "$@" FLEET_REGISTRY_DIR="$d/repos" \
            bash -c 'source "$1" && load_repo t && printf "%s|%s|%s\n" "$RUNNERS" "${CARGO_CMD:-}" "${CARGO_PROBE_DIR:-}"' \
            _ "$lib" 2>&1 )"; rc=$?
  }
  probe
  assert_eq "$rc" 0 "a config without RUNNERS loads"
  assert_eq "$out" "vitest||" "and means vitest alone"

  probe RUNNERS='vitest cargo' CARGO_CMD='cargo test' CARGO_PROBE_DIR=core/tests
  assert_eq "$rc" 0 "vitest and cargo with both cargo keys load"
  assert_eq "$out" "vitest cargo|cargo test|core/tests" "and hand the keys back"

  probe RUNNERS='vitest cargo' CARGO_PROBE_DIR=core/tests
  assert_eq "$rc" 1 "cargo without CARGO_CMD dies"; assert_contains "$out" "CARGO_CMD" "and names the key"
  probe RUNNERS='vitest cargo' CARGO_CMD='cargo test'
  assert_eq "$rc" 1 "cargo without CARGO_PROBE_DIR dies"; assert_contains "$out" "CARGO_PROBE_DIR" "and names the key"
  probe RUNNERS='vitest jest'
  assert_eq "$rc" 1 "an unknown runner dies"; assert_contains "$out" "jest" "and names it"
  probe RUNNERS=cargo CARGO_CMD='cargo test' CARGO_PROBE_DIR=core/tests
  assert_eq "$rc" 1 "a list without vitest dies"; assert_contains "$out" "VITEST_CMD" "because vitest is the baseline's test step"
  probe CARGO_CMD='cargo test'
  assert_eq "$rc" 1 "a cargo key without cargo in RUNNERS dies"; assert_contains "$out" "RUNNERS" "and says why"

  printf "RUNNERS='vitest cargo'\nCARGO_CMD='cargo test --locked'\nCARGO_PROBE_DIR=core/tests\n" >> "$d/a/target/.fleet/config"
  probe
  assert_eq "$out" "vitest cargo|cargo test --locked|core/tests" "the keys come from the file like every other"
}

# A target whose RUNNERS list cargo: its config names the fake cargo as
# CARGO_CMD and a crate, fake-core, whose tests/ is CARGO_PROBE_DIR.
cargo_target() {                      # cargo_target — after fixture
  printf "RUNNERS='vitest cargo'\nCARGO_CMD='%s test'\nCARGO_PROBE_DIR=crates/fake-core/tests\n" "$FLEET/test/fakes/cargo" >> "$REPO/.fleet/config"
  mkdir -p "$REPO/crates/fake-core/tests"
  printf '[package]\nname = "fake-core"\nversion = "0.1.0"\nedition = "2021"\n' > "$REPO/crates/fake-core/Cargo.toml"
  printf '#[test]\nfn marker_absent() {}\n' > "$REPO/crates/fake-core/tests/scan.rs"
  git -C "$REPO" add -A; git -C "$REPO" commit -qm "fixture: a cargo target"; git -C "$REPO" push -q origin base
}

# 22 Oct. A Rust test is evidence like a vitest one: a .test whose line is
# `cargo:<package>[/<target>][::<test path>]` runs as `$CARGO_CMD -p … --
# --exact` and its libtest output becomes the same classes. Every case checks
# the trace as well as the class: the fake vitest decides by the marker
# alone, so without the trace a cargo selector handed to vitest would look
# caught.
#
# Red while classifier.ts hands every .test line to VITEST_CMD: no cargo call
# is traced, and 167c/d/f come out RED where they must not.
case_167_cargo_evidence() {
  local want='cargo test -p fake-core --test scan marker_absent -- --exact'
  CASE="167 a cargo: mutation the Rust test catches is RED"; fixture c167; cargo_target
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 FAKE_MUTATIONS=cargo FAKE_CARGO=marker
  assert_grep '^AC1 +RED +marker' "$REPO/.review/$STORY.md" "row in the Machine table"
  assert_grep "^$want\$" "$TRACE/calls" "run by cargo, as CARGO_CMD and the parsed selector"
  assert_eq "$(field status)" done "a caught Rust mutation passes like a vitest one"

  CASE="167b a cargo: mutation that survives is GREEN and vetoes"; fixture c167b; cargo_target
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 FAKE_MUTATIONS=cargo FAKE_CARGO=pass
  assert_grep '^computed: FAIL — .*AC1 marker GREEN' "$REPO/.review/$STORY.md" "the veto names it"
  assert_grep "^$want\$" "$TRACE/calls" "run by cargo"

  CASE="167c a cargo: mutation that breaks the build is NO_TESTS, never RED"; fixture c167c; cargo_target
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 FAKE_MUTATIONS=cargo FAKE_CARGO=marker-nocompile
  assert_grep '^AC1 +NO_TESTS +marker' "$REPO/.review/$STORY.md" "a compile error is not a caught mutation (L-08)"

  CASE="167d a cargo: selector that names no test is SELECTOR_INVALID"; fixture c167d; cargo_target
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 FAKE_MUTATIONS=cargo FAKE_CARGO=nomatch
  assert_grep '^AC1 +SELECTOR_INVALID +marker' "$REPO/.review/$STORY.md" "zero tests ran before the patch"

  CASE="167e a builder's tdd pair may name a Rust test"; fixture c167e; cargo_target
  run "$STORY" FAKE_BUILDER=commit FAKE_BUILDER_MUTATIONS=cargo-red FAKE_REVIEWER=PASS MAX_ROUNDS=1 FAKE_CARGO=marker
  assert_grep '^AC1 +RED +tdd-observed-red' "$REPO/.review/$STORY.md" "the tdd check ran it"
  assert_grep "^$want\$" "$TRACE/calls" "through cargo"

  CASE="167f a cargo: selector in a repo whose RUNNERS do not list cargo names no test"; fixture c167f
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 FAKE_MUTATIONS=cargo FAKE_CARGO=marker
  assert_grep '^AC1 +SELECTOR_INVALID +marker' "$REPO/.review/$STORY.md" "refused, not handed to vitest"
  assert_not_grep '^cargo ' "$TRACE/calls" "and cargo never runs"
  assert_not_grep 'vitest cargo:' "$TRACE/calls" "nor vitest"

  CASE="167g fleet check-mutation runs a cargo: pair as the verdict does"; fixture c167g; cargo_target
  local m="$REPO/.review-out/mutations" out rc
  mkdir -p "$m"
  printf '\nFLEET_MUTANT_MARKER\n' >> "$REPO/src/marker.txt"
  git -C "$REPO" diff -- src/marker.txt > "$m/AC1-tdd-marker.patch"
  git -C "$REPO" checkout -q -- src/marker.txt
  printf 'cargo:fake-core/scan::marker_absent\n' > "$m/AC1-tdd-marker.test"
  out="$( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_VITEST=pass FAKE_CARGO=marker \
          bash "$FLEET/fleet" check-mutation t "$m/AC1-tdd-marker.patch" --wt "$REPO" 2>&1 )"; rc=$?
  assert_contains "$out" "RED AC1-tdd-marker" "caught"
  assert_eq "$rc" 0 "and exits 0"
  assert_grep "^$want\$" "$TRACE/calls" "through cargo"
}

# One classifier for cargo too: the verdict and fleet check-mutation both
# reach ts/src/lib/libtest.ts. Replace it with a stub that answers GREEN to
# everything, and a cargo mutation the fake cargo would catch comes out GREEN
# from both. Red when either caller classifies cargo output without it.
case_167h_one_cargo_classifier() {
  CASE="167h the verdict and fleet check-mutation share one cargo classifier"; fixture c167h; cargo_target
  cat >> "$FLEET/ts/src/lib/libtest.ts" <<'STUB'
export function classFromLibtestStubbed(): RunClass { return 'GREEN'; }
STUB
  sed -i 's/^export function classFromLibtest(log: string, status: number): RunClass {$/export function classFromLibtest(_log: string, _status: number): RunClass { return classFromLibtestStubbed(); }\nfunction unused(log: string, status: number): RunClass {/' "$FLEET/ts/src/lib/libtest.ts"
  local m="$REPO/.review-out/mutations" out
  mkdir -p "$m"
  printf '\nFLEET_MUTANT_MARKER\n' >> "$REPO/src/marker.txt"
  git -C "$REPO" diff -- src/marker.txt > "$m/AC1-tdd-marker.patch"
  git -C "$REPO" checkout -q -- src/marker.txt
  printf 'cargo:fake-core/scan::marker_absent\n' > "$m/AC1-tdd-marker.test"
  out="$( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_VITEST=pass FAKE_CARGO=marker \
          bash "$FLEET/fleet" check-mutation t "$m/AC1-tdd-marker.patch" --wt "$REPO" 2>&1 )"
  assert_contains "$out" "GREEN AC1-tdd-marker" "check-mutation gives the stub's answer"
  rm -rf "$m"
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 FAKE_MUTATIONS=cargo FAKE_CARGO=marker
  assert_grep '^AC1 +GREEN +marker' "$REPO/.review/$STORY.md" "the verdict gives the stub's answer"
}

# A reviewer's Rust probe: .review-out/probes/<name>.rs, copied into
# CARGO_PROBE_DIR as its own integration-test target fleet_probe_<name>, run
# by cargo, removed. RED vetoes, as a vitest probe's does. Red while
# runProbes reads only *.test.ts(x): the .rs probe never runs and no row
# appears.
case_168_cargo_probes() {
  CASE="168 a green Rust probe is recorded and changes nothing"; fixture c168; cargo_target
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_PROBES=cargo-green MAX_ROUNDS=1 FAKE_CARGO=pass
  assert_eq "$(field status)" done "a probe that finds nothing does not block"
  assert_grep '^GREEN +probe-green.rs' "$REPO/.review/$STORY.md" "row in the Machine table"
  assert_grep '^cargo test -p fake-core --test fleet_probe_probe_green$' "$TRACE/calls" "run as its own target in the package"
  assert_contains "$(tracked)" ".review/$STORY/round-1/probes/probe-green.rs" "probe committed"

  CASE="168b a red Rust probe vetoes"; fixture c168b; cargo_target
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS FAKE_PROBES=cargo-red MAX_ROUNDS=1 FAKE_CARGO=pass
  assert_eq "$(review_line 3)" "verdict: FAIL" "machine veto over model PASS"
  assert_grep '^computed: FAIL — .*probe probe-red.rs RED' "$REPO/.review/$STORY.md" "reason names the probe"
  assert_contains "$(tracked)" ".review/$STORY/round-1/probes/probe-red.rs" "kept for the next story"
}

# The prompts name a target's runners. A target without cargo in RUNNERS
# must get the prompts it got before cargo existed, byte for byte: run one
# story with the prompts as they are and one with every {{CARGO_*}}
# placeholder deleted from them, and the builder's and the reviewer's
# prompts must be the same once the fixture's own path is masked. A cargo
# target's builder and reviewer are told the cargo: form, CARGO_CMD and
# where a Rust probe lands. The two fixtures' paths and commit hashes are
# masked; nothing else may differ.
#
# Red while a placeholder renders anything for a vitest-only target (169),
# and while the cargo facts are not rendered (169b).
case_169_prompts_name_the_runners() {
  CASE="169 a vitest-only target's prompts are unchanged, byte for byte"
  local a b f
  # The fixture's path and its commits' hashes differ between two fixtures.
  mask() { sed -E "s#$1#FX#g; s/[0-9a-f]{40}/SHA/g"; }
  fixture c169s
  sed -i 's/{{CARGO_[A-Z]*}}//g' "$FLEET"/prompts/*.md
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  b="$TRACE"; local fx_b="$FX"
  fixture c169
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  a="$TRACE"
  for f in claude-prompt-1 codex-prompt-1; do
    if [[ -s "$a/$f" ]] && cmp -s <(mask "$FX" < "$a/$f") <(mask "$fx_b" < "$b/$f"); then ok; else fail "$f differs from the prompt without placeholders"; fi
    assert_not_grep 'cargo' "$a/$f" "$f names no cargo"
  done

  CASE="169b a cargo target's builder and reviewer are told the cargo: form"; fixture c169b; cargo_target
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_grep 'cargo:<package>\[/<target>\]\[::<test path>\]' "$TRACE/claude-prompt-1" "the builder's rules"
  assert_grep "$FLEET/test/fakes/cargo test -p <package> --test <target> <test path> -- --exact" "$TRACE/claude-prompt-1" "with the target's CARGO_CMD"
  assert_grep 'cargo:<package>\[/<target>\]\[::<test path>\]' "$TRACE/codex-prompt-1" "the reviewer's mutation files"
  assert_grep 'target in crates/fake-core/tests' "$TRACE/codex-prompt-1" "and where a Rust probe lands"
  assert_not_grep 'unsubstituted' "$LOG" "no placeholder left"
}

# The launcher writes the story's life to <target>/.runs/events.jsonl: the
# launch, each round, each builder call, each baseline step, the scope,
# the reviewer, each mutation and the computed verdict, every span ended —
# also when the story stops at a question or a builder is killed. Red while
# launch.ts writes no event.
case_170_launch_writes_its_events() {
  CASE="170 a launch writes its passes to .runs/events.jsonl"; fixture c170
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$RC" 0 "exit code"
  assert_file "$REPO/.runs/events.jsonl" "the log exists"
  events_rows > "$FX/rows"
  assert_not_grep '^bad ' "$FX/rows" "every line is JSON with v, ts, run_id, repo, pass, event, source"
  assert_not_grep '^open ' "$FX/rows" "every span that started ended"
  local want
  for want in 'start launch - -' 'end launch - PASS' 'start round - -' 'end round - PASS' 'end install builder OK' \
              'end builder build OK' 'end baseline all GREEN' 'end baseline test GREEN' 'end baseline build GREEN' \
              'end baseline lint GREEN' 'end install reviewer OK' 'mark scope - CLEAN' 'end reviewer - OK' \
              'end mutation AC1-marker RED' 'mark verdict - PASS'; do
    assert_grep "^$want\$" "$FX/rows" "an event: $want"
  done
  assert_grep '"pass":"builder".*"model":"sonnet"' "$REPO/.runs/events.jsonl" "the builder's model is named"
  assert_grep '"pass":"verdict","event":"mark","result":"PASS","reviewer":"PASS"' "$REPO/.runs/events.jsonl" "the verdict mark says what the reviewer said"
  assert_grep '"pass":"launch","event":"start".*"pid":[0-9]' "$REPO/.runs/events.jsonl" "the launch start carries its pid"
  assert_grep '"story":"900"' "$REPO/.runs/events.jsonl" "lines name the story"
  assert_not_contains "$(tracked)" ".runs/events.jsonl" "the log is not committed"

  CASE="170b a question ends the launch BLOCKED, with a blocked mark"; fixture c170b
  run "$STORY" FAKE_BUILDER=blocked FAKE_REVIEWER=PASS
  events_rows > "$FX/rows"
  assert_grep '^mark blocked ' "$FX/rows" "the question is marked"
  assert_grep '^end builder build BLOCKED$' "$FX/rows" "the builder ended BLOCKED"
  assert_grep '^end launch - BLOCKED$' "$FX/rows" "the launch ended BLOCKED"
  assert_not_grep '^open ' "$FX/rows" "nothing left open"

  CASE="170c a killed builder ends TIMEOUT, and the launch DIED with the reason"; fixture c170c
  run "$STORY" FAKE_BUILDER=hang FAKE_REVIEWER=PASS AGENT_TIMEOUT=2 MAX_ROUNDS=1
  events_rows > "$FX/rows"
  assert_grep '^end builder build TIMEOUT$' "$FX/rows" "the builder ended TIMEOUT"
  assert_grep '^end launch - DIED$' "$FX/rows" "the launch DIED"
  assert_grep '"result":"DIED".*exceeded AGENT_TIMEOUT' "$REPO/.runs/events.jsonl" "with the die's text"
  assert_not_grep '^open ' "$FX/rows" "nothing left open"
}

# The queue writes its pickups to the event log: the story, when it became
# ready (from git) and how long it waited; a drain that ran a story is a
# span, and a drain held back is a `held` mark with the reason. Red while
# run-queue.ts writes no event.
case_171_queue_writes_its_events() {
  CASE="171 a pickup is a queue mark with the wait, inside a drain span"; fixture c171
  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$QRC" 0 "the drain exits cleanly"
  events_rows > "$FX/rows"
  assert_not_grep '^bad ' "$FX/rows" "every line is well formed"
  assert_not_grep '^open ' "$FX/rows" "every span ended"
  assert_grep '^start queue drain -$' "$FX/rows" "the drain started"
  assert_grep '^mark queue pickup -$' "$FX/rows" "the story was picked up"
  assert_grep '^end queue drain DONE$' "$FX/rows" "the drain ended"
  assert_grep '"story":"900","pass":"queue","event":"mark","name":"pickup","n":1,"ready_since":"[0-9-]+T[0-9:.]+[+-][0-9:]+","wait_s":[0-9]+' "$REPO/.runs/events.jsonl" "with the time it became ready, from git, and the wait"
  assert_grep '^end launch - PASS$' "$FX/rows" "and the launch it started wrote its own"

  CASE="171b a drain held back by low memory is a held mark, and no drain span"; fixture c171b
  printf 'MemAvailable:  1024000 kB\n' > "$FX/meminfo"
  queue FLEET_MEMINFO="$FX/meminfo" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  events_rows > "$FX/rows"
  assert_grep '^mark queue held -$' "$FX/rows" "the hold is marked"
  assert_grep '"name":"held","reason":"only 1000 MB of memory is available' "$REPO/.runs/events.jsonl" "with its reason"
  assert_not_grep 'drain' "$FX/rows" "a drain that ran nothing has no span"
}

# fleet merge writes its span to the event log: a story merged into its
# epic ends MERGED with the sha, with a SKIPPED mark when its round's
# baseline stands (L-39); an epic landed is an epic_merge with the
# post-merge baseline's steps inside it; a red baseline ends it RED. Red
# while merge.ts writes no event.
case_172_merge_writes_its_events() {
  CASE="172 a story merged into its epic is a merge span, ended MERGED"; epic_story c172
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run
  assert_eq "$MRC" 0 "precondition: merged"
  events_rows > "$FX/rows"
  assert_not_grep '^(bad|open) ' "$FX/rows" "well formed, every span ended"
  assert_grep '^start merge - -$' "$FX/rows" "the merge started"
  assert_grep '^mark baseline merge SKIPPED$' "$FX/rows" "the round's baseline stood for it"
  assert_grep '^end merge - MERGED$' "$FX/rows" "and it ended MERGED"
  assert_grep '"branch":"story/900","into":"epic/test","sha":"[0-9a-f]{8}","pass":"merge","event":"end"' "$REPO/.runs/events.jsonl" "with the branch, the epic and the sha"

  CASE="172b an epic landed is an epic_merge span, with the baseline's steps"
  merge_epic "$FX/merge-epic.log"
  assert_eq "$?" 0 "precondition: landed"
  events_rows > "$FX/rows"
  assert_not_grep '^(bad|open) ' "$FX/rows" "well formed, every span ended"
  assert_grep '^end epic_merge - MERGED$' "$FX/rows" "the epic landed"
  local step
  for step in test build lint; do assert_grep "^end baseline $step GREEN\$" "$FX/rows" "its $step step"; done
  assert_grep '^end baseline merge GREEN$' "$FX/rows" "and the whole baseline"
  assert_grep '"epic":"epic/test","branch":"epic/test","into":"base".*"pass":"epic_merge","event":"end"' "$REPO/.runs/events.jsonl" "naming the epic and the integration branch"

  CASE="172c a red post-merge baseline ends the merge RED, with the die's text"; epic_story c172c
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run
  merge_epic "$FX/merge-epic.log" BUILD_CMD=false
  events_rows > "$FX/rows"
  assert_grep '^end baseline build RED$' "$FX/rows" "the build step was RED"
  assert_grep '^end epic_merge - RED$' "$FX/rows" "the epic merge ended RED"
  assert_grep '"result":"RED","exit":1,"reason":"post-merge baseline is red' "$REPO/.runs/events.jsonl" "with why"
}

# The writer is a span in the event log, and its start keeps the intent:
# the one place an intent is kept, never the story file, which is the
# builder's prompt. The lint after it is a span too, PASS or FAIL with the
# first error; a draft linted from outside .stories/ is not logged. Red
# while write-story.ts and lint-story.ts write no event.
case_173_writer_and_lint_write_events() {
  CASE="173 the writer keeps the intent on its start; the lint ends PASS"; fixture c173
  git -C "$REPO" push -q origin base:epic/test
  ( cd "$FX" && env PATH="$(FAKES)" FAKE_TRACE_DIR="$TRACE" FAKE_STORY_ID=950 FAKE_BUILDER=story \
      bash "$FLEET/fleet" write-story t 950 "the moon toggle should show a moon" --base epic/test ) > "$FX/write.log" 2>&1
  events_rows > "$FX/rows"
  assert_not_grep '^(bad|open) ' "$FX/rows" "well formed, every span ended"
  assert_grep '^start writer - -$' "$FX/rows" "the writer started"
  assert_grep '^end writer - OK$' "$FX/rows" "and ended OK"
  assert_grep '"story":"950","epic":"epic/test","pass":"writer","event":"start".*"model":"opus".*"intent":"the moon toggle should show a moon"' "$REPO/.runs/events.jsonl" "its start keeps the intent"
  assert_not_grep 'moon toggle' "$REPO/.stories/950.md" "the story file does not"
  assert_grep '^end lint - PASS$' "$FX/rows" "the lint passed"

  CASE="173b a lint with errors ends FAIL with the first error; a draft from elsewhere is not logged"
  sed -i '/^\*\*AC1/d' "$REPO/.stories/950.md"
  ( cd "$FX" && bash "$FLEET/fleet" lint-story t 950 ) > "$FX/lint.log" 2>&1
  assert_grep '"pass":"lint","event":"end".*"result":"FAIL".*"reason":"no acceptance criteria' "$REPO/.runs/events.jsonl" "FAIL, with the first error"
  cp "$REPO/.stories/950.md" "$FX/draft.md"
  local before; before="$(wc -l < "$REPO/.runs/events.jsonl")"
  ( cd "$FX" && bash "$FLEET/fleet" lint-story t "$FX/draft.md" ) > "$FX/lint2.log" 2>&1
  assert_eq "$(wc -l < "$REPO/.runs/events.jsonl")" "$before" "a file outside .stories/ writes nothing"
}

# fleet promote does at a terminal what /promote does from the phone: the
# status to ready, one commit, a push, the repo's drain started through
# QUEUE_START_CMD. Both are one path (src/promote.ts) and both write a
# promote mark. Red while there is no fleet promote, and while either
# writes no mark.
promote_run() {                       # promote_run [args…] → PLOG PRC
  PLOG="$FX/promote.log"
  ( cd "$FX" && env PATH="$(FAKES)" PUSH_STATUS=1 QUEUE_START_CMD="touch $FX/queue-started-{repo}" \
      bash "$FLEET/fleet" promote t "$@" ) > "$PLOG" 2>&1
  PRC=$?
}
case_174_promote() {
  CASE="174 fleet promote: ready, one commit, pushed, a drain started, a promote mark"; fixture c174 draft
  promote_run "$STORY"
  assert_eq "$PRC" 0 "exit code"
  assert_eq "$(field status)" ready "the story is ready"
  assert_eq "$(git -C "$REPO" log -1 --format=%s)" "story($STORY): promoted to ready (fleet promote)" "one commit, named"
  assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$(git -C "$REPO" rev-parse origin/base)" "pushed"
  assert_file "$FX/queue-started-t" "the repo's drain was started"
  assert_contains "$(cat "$PLOG")" "$STORY is ready — a drain is starting" "and it says so"
  assert_grep '"story":"900","pass":"promote","event":"mark","by":"fleet promote","from":"draft","result":"READY","queue":"started"' "$REPO/.runs/events.jsonl" "a promote mark"

  CASE="174b promoted again: nothing to do, 0; a story a launcher has: refused, 1"
  rm -f "$FX/queue-started-t"
  promote_run "$STORY"
  assert_eq "$PRC" 0 "already ready is not an error"
  assert_contains "$(cat "$PLOG")" "$STORY was already ready" "and says so"
  assert_no_file "$FX/queue-started-t" "no drain started"
  sed -i '0,/^status:.*/s//status: in_progress/' "$REPO/.stories/$STORY.md"
  git -C "$REPO" commit -qam "a launcher has it"
  promote_run "$STORY"
  assert_eq "$PRC" 1 "exit code"
  assert_contains "$(cat "$PLOG")" "$STORY is in_progress — a launcher has it" "says why"
  assert_eq "$(field status)" in_progress "untouched"
  promote_run 999
  assert_eq "$PRC" 1 "an unknown story is 1"
  promote_run "$STORY" --by
  assert_contains "$(cat "$PLOG")" "usage: fleet promote" "--by without a name is the usage"

  CASE="174c --by names who promoted it, in the commit and the mark"; fixture c174c draft
  promote_run "$STORY" --by "coordinator, delegated by the human"
  assert_eq "$(git -C "$REPO" log -1 --format=%s)" "story($STORY): promoted to ready (coordinator, delegated by the human)" "the commit names who"
  assert_grep '"by":"coordinator, delegated by the human"' "$REPO/.runs/events.jsonl" "so does the mark"

  CASE="174d /promote takes the same path: the same commit, and a mark by telegram"; fixture c174d draft
  update 102 42 "/promote t $STORY"
  bot poll
  assert_eq "$(field status)" ready "status changed"
  assert_eq "$(git -C "$REPO" log -1 --format=%s)" "story($STORY): promoted to ready (telegram)" "the bot's commit, as before"
  assert_grep '"pass":"promote","event":"mark","by":"telegram","from":"draft"' "$REPO/.runs/events.jsonl" "a promote mark by telegram"
}

# A human's answer is an `answer` mark — /answer, /wait and /fallback — and
# a new epic is an `epic` mark, the start of its chronology. Red while the
# bot and new-epic write no mark.
case_175_answers_and_epics_are_marked() {
  CASE="175 /answer is an answer mark by telegram"; fixture c175
  run "$STORY" FAKE_BUILDER=blocked FAKE_REVIEWER=PASS
  update 175 42 "/answer t $STORY use the moon"
  bot poll
  assert_eq "$(field status)" ready "precondition: answered"
  assert_grep '"story":"900","pass":"answer","event":"mark","name":"answer","by":"telegram","result":"READY"' "$REPO/.runs/events.jsonl" "an answer mark"

  CASE="175b /wait and /fallback are answer marks too"; fixture c175b
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit
  update 176 42 "/wait t $STORY"
  bot poll
  assert_grep '"pass":"answer","event":"mark","name":"wait","by":"telegram"' "$REPO/.runs/events.jsonl" "a wait mark"
  fixture c175c
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=limit
  update 177 42 "/fallback t $STORY"
  bot poll
  assert_grep '"pass":"answer","event":"mark","name":"fallback","by":"telegram"' "$REPO/.runs/events.jsonl" "a fallback mark"

  CASE="175d fleet new-epic is an epic mark, with the sha it was cut at"; fixture c175d
  ( cd "$FX" && env PATH="$(FAKES)" bash "$FLEET/fleet" new-epic t search ) > "$FX/epic.log" 2>&1
  assert_grep "\"epic\":\"epic/search\",\"pass\":\"epic\",\"event\":\"mark\",\"name\":\"created\",\"result\":\"CREATED\",\"from\":\"base\",\"sha\":\"$(git -C "$REPO" rev-parse --short origin/epic/search)\"" "$REPO/.runs/events.jsonl" "an epic mark"
}

# A revert and a reset are marks; a test deploy is a span with its
# install, build and start inside, ended UP or FAILED. Red while revert.ts,
# reset.ts and test-deploy.ts write no event.
case_176_revert_reset_and_test_deploy_are_logged() {
  CASE="176 a revert is a revert mark with the sha it undid"; epic_story c176
  run "$STORY" FAKE_BUILDER=touch FAKE_TOUCH=README.md FAKE_REVIEWER=PASS MAX_ROUNDS=1
  merge_run
  local sha; sha="$(field merged)"
  revert_run
  assert_eq "$RVRC" 0 "precondition: reverted"
  assert_grep "\"pass\":\"revert\",\"event\":\"mark\",\"result\":\"REVERTED\",\"sha\":\"${sha:0:8}\",\"into\":\"epic/test\"" "$REPO/.runs/events.jsonl" "a revert mark"

  CASE="176b a reset is a reset mark with the status it set"
  reset_run "$STORY" --force --draft
  assert_eq "$RRC" 0 "precondition: reset"
  assert_grep '"pass":"reset","event":"mark","result":"DRAFT","force":true' "$REPO/.runs/events.jsonl" "a reset mark"

  CASE="176c a test deploy is a span, its steps inside, ended UP"; fixture c176c; td_setup
  td epic/test
  assert_eq "$TDRC" 0 "precondition: up"
  events_rows > "$FX/rows"
  assert_not_grep '^(bad|open) ' "$FX/rows" "well formed, every span ended"
  local step
  for step in install build; do assert_grep "^end test_deploy $step OK\$" "$FX/rows" "its $step step"; done
  assert_grep '^end test_deploy deploy UP$' "$FX/rows" "the deploy ended UP"
  assert_grep "\"sha\":\"$(git -C "$REPO" rev-parse --short origin/epic/test)\",\"pass\":\"test_deploy\",\"event\":\"end\",\"name\":\"deploy\",\"branch\":\"epic/test\"" "$REPO/.runs/events.jsonl" "naming the branch and the sha"

  CASE="176d a red build ends the deploy FAILED, with why"
  BUILD_CMD=false td epic/test
  assert_eq "$TDRC" 1 "precondition: the build failed"
  events_rows > "$FX/rows"
  assert_grep '^end test_deploy deploy FAILED$' "$FX/rows" "the deploy ended FAILED"
  assert_grep '"name":"deploy".*"result":"FAILED","exit":1,"reason":"build failed' "$REPO/.runs/events.jsonl" "with the step that failed"
  assert_not_grep '^open ' "$FX/rows" "nothing left open"
  td --stop
}

# fleet events prints the log as JSON lines, oldest first, all of it, a
# story's or an epic's; --backfill adds what git, the Machine blocks and the
# evidence files say the log did not see, each line with its source, and
# shows a launch the log has once. It writes nothing. Red while there is no
# fleet events.
case_177_fleet_events() {
  CASE="177 fleet events: the log as JSON lines, a story's or an epic's"; epic_story c177
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  local out n; n="$(wc -l < "$REPO/.runs/events.jsonl")"
  out="$(cd "$FX" && bash "$FLEET/fleet" events t 2>&1)"
  assert_eq "$(printf '%s\n' "$out" | wc -l)" "$n" "every line of the log"
  assert_eq "$(printf '%s\n' "$out" | head -1 | jq -r '.pass + " " + .event')" "launch start" "oldest first"
  assert_eq "$(cd "$FX" && bash "$FLEET/fleet" events t 901 | wc -l)" 0 "another story's: none"
  assert_eq "$(cd "$FX" && bash "$FLEET/fleet" events t epic/test | wc -l)" "$n" "the epic's: its story's"
  local before; before="$(git -C "$REPO" status --porcelain; md5sum < "$REPO/.runs/events.jsonl")"

  CASE="177b --backfill adds the status commits from git, and the launch the log has once"
  out="$(cd "$FX" && bash "$FLEET/fleet" events t "$STORY" --backfill 2>&1)"
  assert_eq "$(printf '%s\n' "$out" | jq -r 'select(.pass=="status") | .name + " " + .source' | tr '\n' ',')" "in_progress git,done git," "git's status marks"
  assert_eq "$(printf '%s\n' "$out" | jq -r 'select(.pass=="launch" and .event=="start") | .source' | tr '\n' ',')" "log," "one launch start, the log's"
  assert_eq "$(git -C "$REPO" status --porcelain; md5sum < "$REPO/.runs/events.jsonl")" "$before" "nothing was written"

  CASE="177c a story the log never saw: its launch from git, its round from the Machine block"
  rm "$REPO/.runs/events.jsonl"
  out="$(cd "$FX" && bash "$FLEET/fleet" events t "$STORY" --backfill 2>&1)"
  assert_eq "$(printf '%s\n' "$out" | jq -r 'select(.pass=="launch") | .event + " " + .source + " " + (.result // "-")' | tr '\n' ',')" "start git -,end git PASS," "the launch, from git"
  assert_eq "$(printf '%s\n' "$out" | jq -r 'select(.pass=="verdict") | .source + " " + .result' | tr '\n' ',')" "machine PASS," "the verdict, from the Machine block"
  assert_eq "$(cd "$FX" && bash "$FLEET/fleet" events t --bogus 2>&1 >/dev/null | grep -c 'usage: fleet events')" 1 "an unknown flag is the usage"

  # journald rotates; a human saves the queue's lines in .runs/journal-*.log
  # first (docs/operations.md), and --journal reads the copies with it.
  CASE="177d --journal reads the journal's copies saved in .runs/journal-*.log"
  printf '%s\n' \
    '2026-10-18T04:21:38.100000+02:00 box fleet-queue-t[4322]: ==> story 900' \
    '2026-10-18T04:21:39.100000+02:00 box fleet-queue-t[4322]: ==> round 1 of 2' > "$REPO/.runs/journal-2026-10.log"
  out="$(cd "$FX" && bash "$FLEET/fleet" events t "$STORY" --journal 2>&1)"
  assert_eq "$(printf '%s\n' "$out" | jq -r 'select(.source=="journal") | .pass + " " + .event' | tr '\n' ',')" "launch start,round start," "the saved launch and its round, from the copy"
}

# A cargo target keeps one build folder per worktree outside it,
# ~/.cache/fleet-cargo/<repo>/<worktree's name> (README, the runner
# contract); nothing deleted them, and on 26 Oct 34 of them held 99 GB of a
# 154 GB disk. Each drain deletes the folders whose worktree is gone
# (lib/buildcache.ts). The queue helper points FLEET_CARGO_CACHE into the
# fixture, so no case touches the real one. Red while run-queue.ts deletes
# nothing.
case_178_drain_prunes_the_build_cache() {
  CASE="178 a drain deletes each build folder whose worktree is gone"; fixture c178 draft
  local c="$FX/cargo-cache/t" n
  git -C "$REPO" worktree add -q --detach "$FX/wt-live"
  git -C "$REPO" worktree add -q --detach "$FX/wt-hand"; rm -rf "$FX/wt-hand"   # removed by hand: git still lists it
  for n in repo wt-live wt-hand wt-gone merge-epic-x; do mkdir -p "$c/$n/debug"; : > "$c/$n/debug/lib.rlib"; done
  queue
  assert_eq "$QRC" 0 "the drain exits cleanly"
  assert_eq "$(ls "$c" | tr '\n' ' ')" "repo wt-live " "the checkout's and the live worktree's folders stay, the rest go"
  assert_file "$c/wt-live/debug/lib.rlib" "a live folder keeps what it built"
  assert_grep 'build cache: removed merge-epic-x wt-gone wt-hand' "$FX/queue.log" "the drain says which it removed"

  CASE="178b after a story, the folder of the worktree its launch removed goes"; fixture c178b
  c="$FX/cargo-cache/t"; mkdir -p "$c/repo"
  queue FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1 INSTALL_CMD='mkdir -p "$FLEET_CARGO_CACHE/t/${PWD##*/}"'
  assert_eq "$QRC" 0 "the drain exits cleanly"
  assert_grep 'build cache: removed .*wt-900-review' "$FX/queue.log" "the reviewer's folder, made by its install, is removed"
  assert_eq "$([[ -d "$c/wt-900" ]] && echo kept || echo gone)" "$([[ -d "$FX/wt-900" ]] && echo kept || echo gone)" "the builder's folder goes exactly when its worktree did"
  assert_eq "$([[ -d "$c/repo" ]] && echo kept)" kept "the checkout's own folder stays"
}

# fleet dashboard bundle: everything the dashboard shows, read once — the
# catalog, the events with their backfill, each round's Machine block, and
# the present. Read-only. Red while the fleet has no dashboard command.
case_179_dashboard_bundle() {
  CASE="179 fleet dashboard bundle reads every repo, and writes nothing"; fixture c179
  run "$STORY" FAKE_BUILDER=commit FAKE_REVIEWER=PASS MAX_ROUNDS=1
  assert_eq "$RC" 0 "precondition: the story ran"
  local before out rc
  before="$(git -C "$REPO" status --porcelain; git -C "$REPO" log --oneline | wc -l; ls -la --time-style=+%s "$REPO/.runs" | md5sum)"
  out="$(cd "$FX" && bash "$FLEET/fleet" dashboard bundle 2>"$FX/bundle.err")"; rc=$?
  assert_eq "$rc" 0 "exit 0"
  assert_eq "$(printf '%s' "$out" | jq -r '[.repos[].name] | join(",")')" t "the registered repo"
  assert_eq "$(printf '%s' "$out" | jq -r '.repos[0].stories[] | select(.id=="900") | [.history[].kind] | join(",")')" "in_progress,done" "its story's history, from git"
  assert_eq "$(printf '%s' "$out" | jq -r '.repos[0].stories[] | select(.id=="900") | .rounds[0].computed + " " + (.rounds[0].timing.total | type)')" "PASS number" "its round, from the Machine block"
  assert_eq "$(printf '%s' "$out" | jq -r '[.events.t[] | select(.source=="log" and .pass=="launch") | .event] | join(",")')" "start,end" "the log's launch"
  assert_eq "$(printf '%s' "$out" | jq -r '.machine.t["900"]["1"] | startswith("baseline:")')" true "and the round's Machine block"
  assert_eq "$(git -C "$REPO" status --porcelain; git -C "$REPO" log --oneline | wc -l; ls -la --time-style=+%s "$REPO/.runs" | md5sum)" "$before" "nothing was written"
  out="$(cd "$FX" && bash "$FLEET/fleet" dashboard bogus 2>&1)"; rc=$?
  assert_eq "$rc" 1 "an unknown subcommand fails"
  assert_contains "$out" "usage: fleet dashboard" "with the usage"
}

for c in "${CASES[@]}"; do
  [[ -z "$ONLY" || "$c" == *"$ONLY"* ]] || continue
  "$c"
done

echo
printf '%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
