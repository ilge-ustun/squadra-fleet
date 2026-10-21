#!/usr/bin/env bash
#
# bin/remote-control.sh — a Claude Code Remote Control server for the
# coordinator, in the foreground until it is stopped.
#
# The coordinator is reached from claude.ai/code or the Claude app. A
# session started by hand, in tmux over ssh, does not survive a reboot (the
# 20 Oct maintenance); fleet-remote-control.service runs this at every start
# of the user manager and again after every exit. The server keeps one
# session open and starts more on demand, all in REMOTE_CONTROL_DIR.
#
# REMOTE_CONTROL_DIR (default ~/work) must be a directory `claude` has been
# trusted in once. Not the home directory: Remote Control never saves trust
# for it, and the server exits at once. Its sessions keep the memory of that
# directory's project, unless its .claude/settings.local.json names another
# with autoMemoryDirectory. `fleet remote-control <repo>` serves one project's
# coordinator from the repo's own checkout instead (fleet-remote-control@.service).
#
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }

# With a repo argument the server is that project's coordinator: it works in
# the repo's checkout (REPO_PATH in repos/<repo>.env), so its sessions keep
# that directory's memory apart from the fleet's, and it is named after it.
if [[ -n "${1:-}" ]]; then
  repo="$1"
  [[ "$repo" =~ ^[A-Za-z0-9_-]+$ ]] || die "not a repo name: '$repo'"
  f="$FLEET_REGISTRY_DIR/$repo.env"
  [[ -f "$f" ]] || die "unknown repo '$repo' — no $f"
  REMOTE_CONTROL_DIR="$( . "$f" >/dev/null 2>&1 && printf '%s' "${REPO_PATH:-}" )"
  [[ -n "$REMOTE_CONTROL_DIR" ]] || die "$f sets no REPO_PATH"
  REMOTE_CONTROL_NAME="$repo"
fi

dir="${REMOTE_CONTROL_DIR:-$HOME/work}"
[[ -d "$dir" ]] || die "no directory $dir — set REMOTE_CONTROL_DIR to the coordinator's"
command -v claude >/dev/null || die "claude not on PATH"
cd "$dir" || die "cannot cd to $dir"

# At most two sessions: each took ~250 MB beside the server's ~150 MB (20
# Oct), on a 7.9 GB box where two drains may take 3 GB each (fleet-queue@<repo>.service)
# and a coordinator's own build or Lighthouse run more.
exec claude remote-control --name "${REMOTE_CONTROL_NAME:-fleet}" --capacity 2
