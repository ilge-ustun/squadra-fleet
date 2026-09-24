#!/usr/bin/env bash
#
# run-queue.sh <repo>|--all [--max N]
#
#   run-queue.sh khaita                  drain the queue of the repo `khaita`
#   run-queue.sh khaita --max 3          at most three stories
#   run-queue.sh --all                   every registered repo, one after another
#
# Runs every `ready` story in turn until the queue is empty — the launcher
# decides, the queue merges. Two guards against looping for ever: --max N (a
# hard ceiling, default 20) and the same-story-twice check.
#
# The drain itself, the two loop guards and refresh_from_origin — ts/src/
# run-queue.ts, which documents them. This wrapper keeps the name every
# caller (fleet-queue.service, the skills, the docs) uses.
#
# Run it detached, never as a child of an interactive session:
#   setsid nohup bash run-queue.sh khaita > queue.log 2>&1 < /dev/null &
#
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
command -v node >/dev/null || die "node not on PATH — the queue runs on Node $(cat "$FLEET_HOME/.nvmrc" 2>/dev/null)"
exec node "$FLEET_HOME/ts/src/bin/run-queue.ts" "$@"
