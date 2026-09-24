#!/usr/bin/env bash
#
# update-agents.sh — bring the two agent CLIs to their newest release.
#
# The fleet names models by alias (sonnet, opus, haiku; codex's own default),
# and an alias means "the newest model this CLI knows". Claude Code updates
# itself; codex, an npm global under nvm, never does, so its default stays
# whatever the installed version shipped with. fleet-agents-update.timer
# runs this weekly.
#
# Only while the queue is idle: a codex replaced under a running reviewer is
# a dead round. A running queue is not a failure — the next firing tries
# again. FLEET_QUEUE_ACTIVE_CMD is the seam test-lib.sh uses.
#
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
QUEUE_ACTIVE_CMD="${FLEET_QUEUE_ACTIVE_CMD:-systemctl --user is-active --quiet fleet-queue.service}"

if bash -c "$QUEUE_ACTIVE_CMD"; then
  log "the queue is running — not updating the agents now; the next firing will"
  exit 0
fi

command -v claude >/dev/null || die "claude not on PATH"
command -v npm    >/dev/null || die "npm not on PATH — codex is an npm global"

log "claude before: $(claude --version 2>&1 | head -1)"
claude update || die "claude update failed"
log "claude after:  $(claude --version 2>&1 | head -1)"

log "codex before: $(codex --version 2>&1 | head -1)"
npm install -g @openai/codex@latest --no-fund --no-audit || die "npm install -g @openai/codex@latest failed"
log "codex after:  $(codex --version 2>&1 | head -1)"
