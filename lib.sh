# lib.sh — sourced first by every script:  source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#
# Nothing here runs on source beyond assignments and function definitions.
#
# Where things are. FLEET_HOME is this directory: the scripts, prompts/, the
# fakes in test/, the registry in repos/. The target repo is never assumed to
# be the cwd — it is named, looked up in the registry, and checked.
#
#   repos/<name>.env          REPO_PATH=/abs/path   — and nothing else
#   <target>/.fleet/config    the target's own settings, sourced by load_repo:
#                             BASE_BRANCH INSTALL_CMD VITEST_CMD BUILD_CMD
#                             LINT_CMD SEED_FILES PROBE_DIR, optional REPO_RULES
#
# A variable already in the caller's environment wins over the file, so a
# test can point VITEST_CMD at a fake and a hand run can override one value
# without editing the target. The file is NOT exported: under run-queue.sh
# --all one repo's BASE_BRANCH would otherwise reach the next repo's process
# and look, to it, like a caller's override.

FLEET_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLEET_REGISTRY_DIR="${FLEET_REGISTRY_DIR:-$FLEET_HOME/repos}"
PROMPTS_DIR="$FLEET_HOME/prompts"
# How the fleet reaches a human. One seam, so a test can substitute a recorder
# and nothing here ever reaches the network.
FLEET_NOTIFY_CMD="${FLEET_NOTIFY_CMD:-bash $FLEET_HOME/telegram.sh send}"

FLEET_REPO_KEYS="BASE_BRANCH INSTALL_CMD VITEST_CMD BUILD_CMD LINT_CMD SEED_FILES PROBE_DIR REPO_RULES"
FLEET_REPO_REQUIRED="BASE_BRANCH INSTALL_CMD VITEST_CMD BUILD_CMD LINT_CMD PROBE_DIR"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
# LOG_TAG, when a script sets it, prefixes every line: [queue], [bot].
log()  { printf '%s==> %s%s%s\n' "$GRN" "${LOG_TAG:+[$LOG_TAG] }" "$1" "$RST"; }
warn() { printf '%s!! %s%s%s\n'  "$YLW" "${LOG_TAG:+[$LOG_TAG] }" "$1" "$RST"; }
die()  { printf '%sXX %s%s%s\n'  "$RED" "${LOG_TAG:+[$LOG_TAG] }" "$1" "$RST" >&2; exit 1; }

load_repo() {                         # load_repo <name> → REPO_NAME REPO_ROOT + the config keys + SEED_FILES_ARR
  local name="$1" f k kv
  local -a keep=()
  # The bot hands user text straight in here; a name is a name, not a path.
  [[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || die "not a repo name: '$name'"
  f="$FLEET_REGISTRY_DIR/$name.env"
  [[ -f "$f" ]] || die "unknown repo '$name' — no $f"
  REPO_NAME="$name"
  # Read in a subshell: the entry can contribute REPO_PATH and nothing else.
  REPO_ROOT="$( . "$f" >/dev/null 2>&1 && printf '%s' "${REPO_PATH:-}" )"
  [[ -n "$REPO_ROOT" ]] || die "$f sets no REPO_PATH"
  [[ "$(git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null)" == "$(readlink -f "$REPO_ROOT" 2>/dev/null)" ]] \
    || die "REPO_PATH $REPO_ROOT (repo '$name') is not the top of a git checkout"
  # Worktrees are siblings of the target (../wt-<id>), and story ids are
  # per-repo, so two targets under one parent directory would share them.
  # The registry is the only place that can see both.
  local other opath parent
  parent="$(dirname "$(readlink -f "$REPO_ROOT")")"
  for other in "$FLEET_REGISTRY_DIR"/*.env; do
    [[ -e "$other" && "$other" != "$f" ]] || continue
    opath="$( . "$other" >/dev/null 2>&1 && printf '%s' "${REPO_PATH:-}" )"
    [[ -n "$opath" && "$(dirname "$(readlink -f "$opath")")" == "$parent" ]] \
      && die "repos '$name' and '$(basename "$other" .env)' sit in the same parent directory ($parent) — their ../wt-<id> worktrees would collide"
  done
  [[ -f "$REPO_ROOT/.fleet/config" ]] \
    || die "$REPO_ROOT has no .fleet/config — the target must say how it is built and tested"
  # File provides defaults, environment wins: save what the caller set, source,
  # restore. -v tells set from unset; printf -v assigns by name; no eval.
  for k in $FLEET_REPO_KEYS; do [[ -v "$k" ]] && keep+=("$k=${!k}"); done
  . "$REPO_ROOT/.fleet/config" || die "could not read $REPO_ROOT/.fleet/config"
  for kv in "${keep[@]}"; do printf -v "${kv%%=*}" '%s' "${kv#*=}"; done
  for k in $FLEET_REPO_REQUIRED; do
    [[ -n "${!k:-}" ]] || die ".fleet/config for '$name' sets no $k"
  done
  # SEED_FILES may legitimately be empty; it must still be stated.
  [[ -v SEED_FILES ]] || die ".fleet/config for '$name' sets no SEED_FILES (SEED_FILES= is allowed)"
  read -ra SEED_FILES_ARR <<< "${SEED_FILES:-}"
}

# ── story frontmatter ────────────────────────────────────────────────────────
#
# One reader, used by every script; the writer is the launcher's and the
# bot's. A story's frontmatter is the fleet's state — there is no state file.

frontmatter_field() {                 # frontmatter_field <file> <key>
  [[ -f "$1" ]] || { echo ""; return; }
  awk -v k="$2" '
    NR==1 && $0!="---" { exit }
    /^---$/ { if (++d==2) exit; next }
    d==1 && $0 ~ "^"k":" { sub("^"k":[[:space:]]*",""); print; exit }
  ' "$1"
}

story_field() {                       # story_field <id> <key>
  frontmatter_field "$REPO_ROOT/.stories/$1.md" "$2"
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

# ── liveness ─────────────────────────────────────────────────────────────────
#
# L-04: a dead launcher does not stop the work it started, and `in_progress`
# in the frontmatter can be a stale orphan. The only trustworthy answer is
# what is actually running in the worktree — found by cwd, because the
# worktree path appears nowhere in the agents' command lines.

procs_in_worktree() {                 # procs_in_worktree <path> → prints pids
  local wt p cwd
  wt="$(readlink -f "$1" 2>/dev/null)" || return 0
  [[ -n "$wt" ]] || return 0
  for p in /proc/[0-9]*; do
    cwd="$(readlink "$p/cwd" 2>/dev/null)" || continue
    [[ "$cwd" == "$wt" || "$cwd" == "$wt"/* ]] && basename "$p"
  done
}
