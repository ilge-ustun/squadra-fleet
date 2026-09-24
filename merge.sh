#!/usr/bin/env bash
#
# merge.sh <repo> <id>          a story into its epic   — the queue calls this
# merge.sh <repo> <id> --land   a story whose base IS the integration branch,
#                               onto it — a human's word (/merge from the
#                               phone); the queue never passes --land
# merge.sh <repo> --epic <name> an epic into the integration branch — a human
#                               calls this, and nothing in the fleet does
#
# The refusals, the throwaway worktree, the post-merge baseline, MERGE_MODE
# and the record — ts/src/merge.ts, which documents them. This wrapper keeps
# the name every caller (run-queue.sh, telegram.sh, the skills) uses.
#
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
command -v node >/dev/null || die "node not on PATH — merge runs on Node $(cat "$FLEET_HOME/.nvmrc" 2>/dev/null)"
exec node "$FLEET_HOME/ts/src/bin/merge.ts" "$@"
