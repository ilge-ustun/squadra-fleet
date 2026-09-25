#!/usr/bin/env bash
#
# lint-story.sh <repo> <story-id|path> [--strict]
#
# Mechanical checks on a story, before any agent spends quota on it. No model,
# no network, no git writes. Errors exit 1; warnings print and exit 0 unless
# --strict.
#
# Every check here exists because something cost rounds:
#
#   citations      story 004 rotted — it cited a diagnosis file and a symptom
#                  that no longer existed. A story is read as fact by two
#                  agents; a stale file:line is a false premise (L-09).
#   AC headings    the launcher extracts AC ids with `grep '^\*\*AC[0-9]+'`.
#                  A story whose ACs are a table (005) is invisible to it and
#                  dies at "declares no acceptance criteria".
#   unbounded ACs  L-20. "every stub in the worker global" cost story 008 two
#                  rounds; "every snapshot a test delivers" cost 006 one. An
#                  unquantified every/all/any in an AC heading is a scope
#                  declaration that outranks Out of scope.
#   baseline ACs   the harness runs test/build/lint unconditionally, so an AC
#                  asserting them is noise that cannot fail independently.
#
# The checks themselves — ts/src/lint-story.ts, which documents each one line
# for line against this file. This wrapper keeps the name every caller
# (write-story.sh, skills, docs, a human) uses.
#
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
command -v node >/dev/null || die "node not on PATH — lint-story runs on Node $(cat "$FLEET_HOME/.nvmrc" 2>/dev/null)"
exec node "$FLEET_HOME/ts/src/bin/lint-story.ts" "$@"
