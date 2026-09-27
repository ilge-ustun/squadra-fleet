# bin/lib.sh — sourced by `fleet` and by the two bash chores beside it.
#
# Nothing here runs on source beyond assignments and function definitions.
# What lives here is what has to be bash: FLEET_HOME, log/warn/die, and
# load_repo — a target's .fleet/config is sourced bash, so the TypeScript
# side (ts/src/lib/config.ts) runs load_repo in a child bash and reads the
# keys back.
#
# FLEET_HOME is the repository root, the parent of bin/. A target is never
# assumed to be the cwd — it is named, looked up in the registry, and checked.
#
#   repos/<name>.env          REPO_PATH=/abs/path   — and nothing else
#   <target>/.fleet/config    the target's own settings, sourced by load_repo:
#                             BASE_BRANCH INSTALL_CMD VITEST_CMD BUILD_CMD
#                             LINT_CMD SEED_FILES PROBE_DIR, optional
#                             REPO_RULES MERGE_MODE PR_CMD START_CMD
#
# A variable already in the caller's environment wins over the file, so a
# test can point VITEST_CMD at a fake and a hand run can override one value
# without editing the target. The file is NOT exported: under `fleet
# run-queue --all` one repo's BASE_BRANCH would otherwise reach the next
# repo's process and look, to it, like a caller's override.

FLEET_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLEET_REGISTRY_DIR="${FLEET_REGISTRY_DIR:-$FLEET_HOME/repos}"

FLEET_REPO_KEYS="BASE_BRANCH INSTALL_CMD VITEST_CMD BUILD_CMD LINT_CMD SEED_FILES PROBE_DIR REPO_RULES MERGE_MODE PR_CMD START_CMD"
FLEET_REPO_REQUIRED="BASE_BRANCH INSTALL_CMD VITEST_CMD BUILD_CMD LINT_CMD PROBE_DIR"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
# LOG_TAG, when set (the bot sets bot), prefixes every line: [bot] …
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
  # How a merge reaches origin: `direct` pushes after the post-merge baseline;
  # `pr` pushes the branch and runs PR_CMD, and the host merges. Absent means
  # direct.
  MERGE_MODE="${MERGE_MODE:-direct}"
  case "$MERGE_MODE" in
    direct) ;;
    pr) [[ -n "${PR_CMD:-}" ]] || die ".fleet/config for '$name' says MERGE_MODE=pr but sets no PR_CMD" ;;
    *)  die ".fleet/config for '$name' sets MERGE_MODE=$MERGE_MODE — direct or pr" ;;
  esac
}
