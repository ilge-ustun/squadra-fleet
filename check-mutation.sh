#!/usr/bin/env bash
#
# check-mutation.sh <repo> <patch…> [--wt <dir>]
#
#   check-mutation.sh khaita .review-out/mutations/AC1-tdd-guard.patch
#   check-mutation.sh khaita .review-out/mutations/AC*-tdd-*.patch
#
# Runs the verdict's own mutation classifier (mutation.sh — the same code
# launch.sh runs) on a tree someone is still working in: the builder's
# worktree, or a human's checkout. For each patch, with its .test or .cmd
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
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
USAGE='usage: check-mutation.sh <repo> <patch…> [--wt <dir>]'
[[ $# -ge 1 ]] || die "$USAGE"
load_repo "$1"; shift
source "$FLEET_HOME/mutation.sh" || die "cannot source mutation.sh"
command -v jq >/dev/null || die "jq not on PATH"

WT="$PWD"; PATCHES=()
while (($#)); do
  case "$1" in
    --wt) WT="${2:?--wt needs a directory}"; shift 2 ;;
    -*)   die "$USAGE" ;;
    *)    PATCHES+=("$1"); shift ;;
  esac
done
(( ${#PATCHES[@]} )) || die "$USAGE"

WT="$(cd "$WT" 2>/dev/null && pwd -P)" || die "no such directory: $WT"
[[ "$(git -C "$WT" rev-parse --show-toplevel 2>/dev/null)" == "$WT" ]] \
  || die "$WT is not the top of a git checkout"
[[ "$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" == "$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)" ]] \
  || die "$WT is not a checkout of repo '$REPO_NAME' ($REPO_ROOT)"

DIRTY="$(porcelain "$WT")"
[[ -z "$DIRTY" ]] || die "tree not clean — commit first, then produce the patch from the committed head:"$'\n'"$DIRTY"

mkdir -p "$WT/.review-out/checks"
ALL_RED=1
for p in "${PATCHES[@]}"; do
  [[ "$p" = /* ]] || p="$PWD/$p"
  [[ -f "$p" ]] || die "no such patch: $p"
  name="$(basename "$p" .patch)"
  raw="$WT/.review-out/checks/$name"
  if find_selector "$p"; then
    classify_mutation "$WT" "$p" "$SEL_KIND" "$SEL_FILE" "$raw" reverse
    cls="$MUT_CLASS"
  else
    cls=NO_SELECTOR
  fi
  [[ "$cls" == RED ]] || ALL_RED=0
  printf '%s %s\n' "$cls" "$name"
done
(( ALL_RED )) || { warn "not every mutation is RED — the verdict would say the same"; exit 1; }
