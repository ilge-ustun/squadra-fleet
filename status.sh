#!/usr/bin/env bash
#
# status.sh <repo> [--json|--epics|--bot] [--all] [story-id]
#
# What the fleet is doing and what it decided — ts/src/bin/status.ts, which
# documents the views, the landing states and the exit codes. This wrapper
# keeps the name every caller and every document uses.
#
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
command -v node >/dev/null || die "node not on PATH — status runs on Node $(cat "$FLEET_HOME/.nvmrc" 2>/dev/null)"
exec node "$FLEET_HOME/ts/src/bin/status.ts" "$@"
