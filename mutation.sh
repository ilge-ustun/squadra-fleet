# mutation.sh — the mutation classifier's bash face. Sourced by launch.sh
# (the verdict) and by check-mutation.sh (a builder checking its own evidence
# before the verdict does). The classifier itself is ts/src/classifier.ts,
# reached through ts/src/bin/mutation.ts; one classifier, so the two can never
# disagree. The classes, and how each is reached, are documented there.
#
# A mutation is ACn-<slug>.patch with a .test (vitest selector) or .cmd (any
# command) beside it. Raw runner output lands at <raw-prefix>-pre.*,
# <raw-prefix>-apply.log and <raw-prefix>-mut.* — launch.sh reads -mut.json
# for the .result file.
#
# Needs die and VITEST_CMD from the caller (lib.sh, load_repo), and node on
# PATH: .nvmrc names the version, the systemd units carry its bin directory,
# and a builder inherits the queue's PATH. VITEST_CMD travels as an argument,
# not through the environment — lib.sh keeps a target's config out of the
# environment on purpose.

FLEET_MUTATION_CLI="$FLEET_HOME/ts/src/bin/mutation.ts"
command -v node >/dev/null || die "node not on PATH — the classifier runs on Node $(cat "$FLEET_HOME/.nvmrc" 2>/dev/null)"

porcelain() { git -C "$1" status --porcelain | grep -v '^?? \.review-out/' || true; }

run_selector() {                      # run_selector <wt> <kind> <selector-file> <raw-out-prefix> → RED|GREEN|NO_TESTS
  : "${VITEST_CMD:?run_selector needs VITEST_CMD — load_repo first}"
  node "$FLEET_MUTATION_CLI" run-selector "$3" --wt "$1" --kind "$2" --raw "$4" --vitest-cmd "$VITEST_CMD"
}

find_selector() {                     # find_selector <patch> → SEL_KIND SEL_FILE; 1 when there is none
  local base="${1%.patch}"
  if   [[ -f "$base.test" ]]; then SEL_KIND=test; SEL_FILE="$base.test"
  elif [[ -f "$base.cmd"  ]]; then SEL_KIND=cmd;  SEL_FILE="$base.cmd"
  else SEL_KIND=""; SEL_FILE=""; return 1; fi
}

# MUT_CLASS is set, not printed, as it always was — but for a better reason
# now. The classifier runs in its own process, so a failure there (a dirty
# tree, a missing node) is an exit status this function sees in the parent
# shell and turns into a die that ends the caller. Inside $(…) a die would
# have ended only the subshell.
classify_mutation() {                 # classify_mutation <wt> <patch> <kind> <selector-file> <raw-prefix> <restore> → MUT_CLASS
  : "${VITEST_CMD:?classify_mutation needs VITEST_CMD — load_repo first}"
  local name; name="$(basename "$2" .patch)"
  MUT_CLASS="$(node "$FLEET_MUTATION_CLI" classify "$2" --wt "$1" --kind "$3" --selector "$4" --raw "$5" --restore "$6" --vitest-cmd "$VITEST_CMD")" \
    || die "mutation runner: $name — the classifier failed (node $(node --version)); its message is above"
  case "$MUT_CLASS" in
    RED|GREEN|NO_TESTS|PRE_RED|SELECTOR_INVALID|PATCH_INVALID) ;;
    *) die "mutation runner: $name — not a class: '$MUT_CLASS'" ;;
  esac
}
