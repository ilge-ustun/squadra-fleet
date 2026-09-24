#!/usr/bin/env bash
#
# reset.sh <repo> <id> [--force] [--draft]   a story back to the queue: its
#          worktree and branch removed, the frontmatter reset, the review and
#          evidence deleted, committed. Refuses while something runs in the
#          worktree; refuses to drop unmerged commits without --force.
#
# The refusals and the steps — ts/src/reset.ts, which documents them. This
# wrapper keeps the name the docs and the skills use.
#
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
command -v node >/dev/null || die "node not on PATH — reset runs on Node $(cat "$FLEET_HOME/.nvmrc" 2>/dev/null)"
exec node "$FLEET_HOME/ts/src/bin/reset.ts" "$@"
