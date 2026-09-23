#!/usr/bin/env bash
#
# check-mutation.sh <repo> <patch…> [--wt <dir>]
#
#   check-mutation.sh khaita .review-out/mutations/AC1-tdd-guard.patch
#   check-mutation.sh khaita .review-out/mutations/AC*-tdd-*.patch
#
# Runs the verdict's own mutation classifier (ts/src/classifier.ts — the
# same code the launcher runs in-process) on a tree someone is still
# working in: the builder's worktree, or a human's checkout. For each patch, with its .test or .cmd
# beside it: pre-run the selector, apply the patch, run it again, undo the
# patch with `git apply -R`, and print the class the verdict would print.
#
#   RED               the mutation was caught — this is the only good answer
#   GREEN             it survived: the instrument does not assert this
#   NO_TESTS          the mutation broke compilation; nothing was collected
#   PRE_RED           the selector already fails on the unmutated tree
#   SELECTOR_INVALID  the selector names no test (wrong path, wrong -t)
#   PATCH_INVALID     the patch does not apply to this head
#   NO_SELECTOR       no .test or .cmd beside the patch
#
# Exit 0 only when every patch is RED, so a builder can loop and stop.
#
# The tree must be clean apart from .review-out/ — everything committed —
# or nothing runs. The safe point is a commit: a restore over uncommitted
# work is how real fixes were lost before this existed, and a patch made
# before the final commit will not apply to the head the verdict sees.
#
# The tree is the cwd unless --wt names it; it must be the named repo's
# checkout or one of its worktrees. Raw runner output lands in
# .review-out/checks/ inside the tree, where the caller can read it.
#
# This file is the wrapper; the program is the `check` verb of
# ts/src/bin/mutation.ts.
#
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
command -v node >/dev/null || die "node not on PATH — the classifier runs on Node $(cat "$FLEET_HOME/.nvmrc" 2>/dev/null)"
exec node "$FLEET_HOME/ts/src/bin/mutation.ts" check "$@"
