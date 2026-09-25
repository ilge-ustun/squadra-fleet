#!/usr/bin/env bash
#
# write-story.sh <repo> <story-id> "<what you want>" [--base epic/<name>]
#
#   write-story.sh khaita 011 "the dark-theme toggle shows a sun, should be a moon" --base epic/ui-polish
#
# Turns an intent into a story the fleet can act on. One agent, read-only over
# the epic's code, writes .stories/<id>.md at `status: draft`; the story is
# then linted mechanically and left for a human to read and promote to
# `ready`. Nothing is committed and no builder runs.
#
# Why it exists: authoring a story by hand costs a careful session — read the
# code, verify every citation, bound each criterion, name its mutation. That
# cost, not the supply of ideas, is what limits how much work the fleet can be
# given. This converts authoring into approving.
#
# The agent runs in a throwaway worktree at the epic's tip, so it reads the
# code the story will be built against rather than whatever the integration
# branch happens to have.
#
# ts/src/write-story.ts. This wrapper keeps the name every caller uses.
#
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
command -v node >/dev/null || die "node not on PATH — write-story runs on Node $(cat "$FLEET_HOME/.nvmrc" 2>/dev/null)"
exec node "$FLEET_HOME/ts/src/bin/write-story.ts" "$@"
