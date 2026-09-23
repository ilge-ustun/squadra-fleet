#!/usr/bin/env bash
#
# launch.sh <repo> [story-id|--reap]
#
# The story loop — builder, baseline, reviewer, mutations, probes, verdict —
# is ts/src/launch.ts, which documents the states, the rounds and the verdict
# contract; ts/src/bin/launch.ts is the entry point. This wrapper keeps the
# name run-queue.sh, the documents and a hand run use. It execs node, which
# loads the whole program before it starts: editing the TypeScript while a
# launcher runs is safe, which editing this file never was.
#
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
command -v node >/dev/null || die "node not on PATH — the launcher runs on Node $(cat "$FLEET_HOME/.nvmrc" 2>/dev/null)"
exec node "$FLEET_HOME/ts/src/bin/launch.ts" "$@"
