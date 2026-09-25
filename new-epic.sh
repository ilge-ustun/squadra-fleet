#!/usr/bin/env bash
#
# new-epic.sh <repo> <name>
#
#   new-epic.sh khaita search      → origin/epic/search, cut from origin/develop
#
# The one way an epic branch comes into being. An epic is a branch named
# epic/<name> that stories are cut from (`base:` in their frontmatter, or
# write-story.sh --base) and merged into by the queue; the epic itself lands
# on the integration branch when a human says so (merge.sh --epic, or /merge
# from the phone). Nothing else about an epic is stored anywhere: status.sh
# derives its state from the branches.
#
# Cut from ORIGIN's integration branch, not the local one, and pushed at
# once, so the launcher — which cuts every worktree from origin — can use it
# on the next story. The checkout is not touched: no checkout, no switch.
#
# ts/src/new-epic.ts. This wrapper keeps the name every caller uses.
#
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
command -v node >/dev/null || die "node not on PATH — new-epic runs on Node $(cat "$FLEET_HOME/.nvmrc" 2>/dev/null)"
exec node "$FLEET_HOME/ts/src/bin/new-epic.ts" "$@"
