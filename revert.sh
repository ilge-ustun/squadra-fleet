#!/usr/bin/env bash
#
# revert.sh <repo> <id>   revert the merge commit recorded in the story's
#                         `merged:` — exactly what was merged, even if the
#                         epic moved on. /revert from the phone is this.
#
# The refusals, the throwaway worktree and the record — ts/src/revert.ts,
# which documents them. This wrapper keeps the name every caller uses.
#
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
command -v node >/dev/null || die "node not on PATH — revert runs on Node $(cat "$FLEET_HOME/.nvmrc" 2>/dev/null)"
exec node "$FLEET_HOME/ts/src/bin/revert.ts" "$@"
