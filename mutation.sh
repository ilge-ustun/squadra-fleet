# mutation.sh — the mutation classifier. Sourced by launch.sh (the verdict)
# and by check-mutation.sh (a builder checking its own evidence before the
# verdict does). One classifier, so the two can never disagree.
#
# A mutation is ACn-<slug>.patch with a .test (vitest selector) or .cmd (any
# command) beside it. In a clean tree:
#
#   pre-run, unmutated  → must be green. Failing → PRE_RED: the instrument was
#                         already red and proves nothing. Collecting no tests
#                         → SELECTOR_INVALID: the selector never named a test,
#                         which is a different mistake with a different fix
#   git apply           → else PATCH_INVALID
#   run, mutated        → RED needs a REAL failure. .test: numFailedTests > 0;
#                         zero tests collected is NO_TESTS (the mutation broke
#                         compilation — L-08), never RED. .cmd: non-zero exit.
#                         GREEN = the mutation survived: for this behaviour the
#                         instrument is absent.
#   restore             → tree must be clean again, or the run stops: nothing
#                         measured after a failed restore can be trusted
#
# Selector lines are executed with bash -c: a .cmd is a command by contract,
# and a .test may carry `-t "a pattern with spaces"`. Same trust as the
# reviewer already has — it wrote them in a tree it could edit.
#
# Needs die and VITEST_CMD from the caller (lib.sh, load_repo).

porcelain() { git -C "$1" status --porcelain | grep -v '^?? \.review-out/' || true; }

run_selector() {                      # run_selector <wt> <kind> <selector-file> <raw-out-prefix> → RED|GREEN|NO_TESTS
  local wt="$1" kind="$2" line raw="$4.json" log="$4.log"
  line="$(head -n1 "$3")"
  rm -f "$raw"
  case "$kind" in
    test)
      ( cd "$wt" && bash -c "$VITEST_CMD $line --reporter json --outputFile '$raw'" ) > "$log" 2>&1
      if   [[ ! -f "$raw" ]];                                  then echo NO_TESTS
      elif jq -e '.numTotalTests == 0'  "$raw" >/dev/null;     then echo NO_TESTS
      elif jq -e '.numFailedTests > 0'  "$raw" >/dev/null;     then echo RED
      else                                                          echo GREEN; fi ;;
    cmd)
      if ( cd "$wt" && bash -c "$line" ) > "$log" 2>&1; then echo GREEN; else echo RED; fi ;;
  esac
}

find_selector() {                     # find_selector <patch> → SEL_KIND SEL_FILE; 1 when there is none
  local base="${1%.patch}"
  if   [[ -f "$base.test" ]]; then SEL_KIND=test; SEL_FILE="$base.test"
  elif [[ -f "$base.cmd"  ]]; then SEL_KIND=cmd;  SEL_FILE="$base.cmd"
  else SEL_KIND=""; SEL_FILE=""; return 1; fi
}

# Two ways back to the committed tree, both safe only because the tree was
# asserted clean first. `checkout` is what the verdict runs in its throwaway
# reviewer worktree. `reverse` undoes exactly the patch and nothing else, for
# a tree someone is still working in.
restore_tree() {                      # restore_tree <wt> <checkout|reverse> <patch>
  case "$2" in
    checkout) git -C "$1" checkout -q -- . ; git -C "$1" clean -qfd -e .review-out ;;
    reverse)  git -C "$1" apply -R "$3" 2>/dev/null || { git -C "$1" checkout -q -- . ; git -C "$1" clean -qfd -e .review-out; } ;;
  esac
}

# Sets MUT_CLASS rather than printing it: a die inside $(…) would end only
# the subshell, and the caller would carry on with an empty class.
classify_mutation() {                 # classify_mutation <wt> <patch> <kind> <selector-file> <raw-prefix> <restore> → MUT_CLASS
  local wt="$1" p="$2" kind="$3" sel="$4" raw="$5" restore="$6" name pre
  name="$(basename "$p" .patch)"
  MUT_CLASS=""
  [[ -z "$(porcelain "$wt")" ]] || die "mutation runner: tree dirty before $name"
  pre="$(run_selector "$wt" "$kind" "$sel" "$raw-pre")"
  if [[ "$pre" == NO_TESTS ]]; then
    # The selector collected nothing before the mutation was applied: a
    # path that does not exist, a -t pattern that matches no test, or a
    # shell command written into a .test file (014, round 1). Not the
    # same finding as an instrument that runs and fails, and not the same
    # fix, so not the same name.
    MUT_CLASS=SELECTOR_INVALID
  elif [[ "$pre" != GREEN ]]; then
    MUT_CLASS=PRE_RED
  elif ! git -C "$wt" apply --check "$p" 2> "$raw-apply.log" || ! git -C "$wt" apply "$p" 2>> "$raw-apply.log"; then
    MUT_CLASS=PATCH_INVALID
    restore_tree "$wt" checkout "$p"
  else
    MUT_CLASS="$(run_selector "$wt" "$kind" "$sel" "$raw-mut")"
    restore_tree "$wt" "$restore" "$p"
    [[ -z "$(porcelain "$wt")" ]] || die "mutation runner: tree dirty after restoring $name"
  fi
}
