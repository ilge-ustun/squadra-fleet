#!/usr/bin/env bash
#
# make-target.sh <dir> — one deterministic target for the status goldens.
#
# Builds <dir>/repo (a git checkout with .fleet/config, stories, reviews),
# <dir>/wt-<id> for two stories (the sibling rule, status.sh's ../wt-<id>),
# and <dir>/repos/t.env, a private registry for FLEET_REGISTRY_DIR.
# status-views.test.ts renders it and compares bytes with the goldens beside
# this file. Nothing status prints depends on a sha or a clock, so two builds
# render the same.
#
# Every landing state, and the edges that bit while planning: story order by filename (900-b.md < 900.md < 9000.md), a review
# without a verdict line (an empty cell, not a dash), a story with no
# frontmatter and no heading, the "Story NNN:" prefixes in three spellings,
# an epic ahead of the base and one already in it, origin/<base> known and
# origin/<epic> not, evidence names that collate differently by locale.
set -euo pipefail
dir="$1"
mkdir -p "$dir"
dir="$(cd "$dir" && pwd -P)"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
repo="$dir/repo"
git init -q -b base "$repo"
g() { git -C "$repo" "$@"; }
g config user.name t
g config user.email t@t
commit() {                            # commit <file> <message>
  printf '%s\n' "$2" > "$repo/$1"
  g add -A
  g commit -qm "$2"
}
mkdir -p "$repo/.fleet" "$repo/.stories" "$repo/.review" "$repo/.blocked" "$repo/src"
cat > "$repo/.fleet/config" <<'CFG'
BASE_BRANCH=base
INSTALL_CMD=true
VITEST_CMD=true
BUILD_CMD=true
LINT_CMD=true
SEED_FILES=
PROBE_DIR=src
CFG
commit README.md base

# 904: done, merged into base → landed.
g checkout -q -b story/904; commit s904 "story 904"; g checkout -q base; g merge -q --ff-only story/904
# epic/done: its story 907 merged into it, and it merged into base → in base; 907 landed.
g checkout -q -b epic/done; g checkout -q -b story/907; commit s907 "story 907"
g checkout -q epic/done; g merge -q --ff-only story/907; g checkout -q base; g merge -q --ff-only epic/done
# 905: done, no branch, merged: <sha> recorded by merge.sh — the sha is in base → landed.
merged_sha="$(g rev-parse HEAD)"
# epic/test: story 902 merged into it, one more commit on it → 2 ahead of base; 906 ready on it, no branch.
g checkout -q -b epic/test; g checkout -q -b story/902; commit s902 "story 902"
g checkout -q epic/test; g merge -q --ff-only story/902; commit e2 "epic work"
# 900: done PASS, one commit, not merged → awaiting merge.  901: done, review without a verdict.
# 9000: in_progress. Each from base.
for id in 900 901 9000; do g checkout -q -b "story/$id" base; commit "s$id" "story $id"; done
g checkout -q base
g update-ref refs/remotes/origin/base base          # origin knows base, not the epics

story() {                             # story <id> <frontmatter…> -- <body>
  local id="$1"; shift
  { if [[ "$1" != -- ]]; then echo '---'; while [[ "$1" != -- ]]; do echo "$1"; shift; done; echo '---'; echo; fi
    shift; printf '%s\n' "$@"; } > "$repo/.stories/$id.md"
}
story 900-b 'status: draft' 'base: base' -- '# Order before ids' '' 'Sorts before 900.md: - is 0x2d, . is 0x2e.'
story 900   'status: done' 'round: 1' -- '# Story 900: fixture story' '' 'AC1 …'
story 901   'status: done' 'round: 1' -- '#   Two spaces after the hash' ''
story 902   'status: done' 'round: 1' 'base: epic/test' -- '# story 902 - lower case, hyphen' ''
story 904   'status: done' 'round: 1' -- '# Story 904 — landed' ''
story 905   'status: done' 'round: 2' "merged: $merged_sha" -- '# Merged by sha, branch gone' ''
story 906   'status: ready' 'base: epic/test' -- '# Story 906: ready on the epic' ''
story 907   'status: done' 'round: 1' 'base: epic/done' -- '# On an epic that landed' ''
story 908   -- 'No frontmatter, no heading, nothing to show.'
story 9000  'status: in_progress' 'round: 2' -- '# Story 9000 — Über long title, ümlauts and — dashes' ''
printf -- '---\nstatus: draft\n---\n\n# Story NNN: template\n' > "$repo/.stories/TEMPLATE.md"
echo 'not a story' > "$repo/.stories/notes.txt"

review() {                            # review <id> <verdict-line-or-empty> <rounds…>
  local id="$1" v="$2"; shift 2
  { printf '# Review: %s\n\n' "$id"; [[ -n "$v" ]] && printf '%s\n' "$v"; printf 'rounds: 1 of 3\nbase: 0000000\n'
    printf '%s' "$@"; } > "$repo/.review/$id.md"
}
round() {                             # round <n> <verdict> <computed-line> [tables]
  printf '\n## Round %s — %s\nhead: 0000000\ncommits this round: 1\nreviewed: 2026-09-23T10:00:00+02:00\n\n### Machine\nbaseline:  test GREEN  build GREEN  lint GREEN\ntiming:    builder 10s  baseline 5s  reviewer 20s  mutations 3s  total 40s\nbuilder:   fleet-test-model\nreviewer:  codex\nacs:       AC1 \nscope:     CLEAN\nmodel:     %s\n%s\n%s\n### Builder said\ndone\n\n### Reviewer\nVERDICT: %s\n' \
    "$1" "$2" "$2" "$3" "${4:-}" "$2"
}
review 900  'verdict: PASS' "$(round 1 PASS 'computed:  PASS' $'mutations:\nAC1  RED           marker\n')"
review 901  ''              "$(round 1 FAIL 'computed:  FAIL — AC1 GREEN: marker; ')"
review 902  'verdict: PASS' "$(round 1 PASS 'computed:  PASS')"
review 904  'verdict: PASS' "$(round 1 PASS 'computed:  PASS')"
review 905  'verdict: PASS' "$(round 1 FAIL 'computed:  FAIL — AC1 GREEN: marker; ')" "$(round 2 PASS 'computed:  PASS')"
review 907  'verdict: PASS' "$(round 1 PASS 'computed:  PASS')"
review 9000 'verdict: FAIL' "$(round 1 FAIL 'computed:  FAIL — AC1 GREEN: marker; ')" \
                            "$(round 2 FAIL 'computed:  FAIL — scope VIOLATION: src/a — b ; AC2 NO_TESTS: guard; ')"
mkdir -p "$repo/.review/900"
for n in Round-3 builder.md round-1 round.1 round_1 .hidden; do : > "$repo/.review/900/$n"; done
echo 'stuck on the API' > "$repo/.blocked/9000.md"
mkdir -p "$dir/wt-900" "$dir/wt-9000"
mkdir -p "$dir/repos"
printf 'REPO_PATH=%s\n' "$repo" > "$dir/repos/t.env"
