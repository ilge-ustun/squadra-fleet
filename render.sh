# Prompt rendering. Sourced by launch.sh.
#
# Prompt bodies live in prompts/*.md and reference values as {{NAME}},
# not $NAME, so the files are inert text: nothing expands by accident and a
# prompt file cannot inject shell.
#
# The replacement side of each ${out//pat/"$value"} is QUOTED. bash 5.2 turns
# patsub_replacement on by default, and unquoted, every `&` in a value became
# the matched placeholder text (`R&D uses &&` reached the agent as
# `R{{STORY}}D uses {{STORY}}{{STORY}}`) and `\&`, `\\` lost their backslash.
# Found by the seam-4 plan review, 23 Sep; four khaita stories had carried
# it. The launcher renders through ts/src/lib/render.ts, whose test holds
# this file to the same bytes.
#
# Order matters: rules.md itself contains {{STORY_ID}}, so render RULES first,
# then render the build prompts that embed {{RULES}}.

render_prompt() {
  local src out
  src="$(cat "$PROMPTS_DIR/$1")" || die "prompt not found: $1"
  out="$src"
  out="${out//\{\{STORY_ID\}\}/"${STORY_ID:-}"}"
  out="${out//\{\{RULES\}\}/"${RULES:-}"}"
  out="${out//\{\{REVIEW_TEXT\}\}/"${REVIEW_TEXT:-}"}"
  out="${out//\{\{STORY\}\}/"${STORY_TEXT:-}"}"
  out="${out//\{\{INTENT\}\}/"${INTENT:-}"}"
  out="${out//\{\{STORY_BASE\}\}/"${STORY_BASE:-}"}"
  out="${out//\{\{HEAD_SHA\}\}/"${HEAD_SHA:-}"}"
  out="${out//\{\{BASE_SHA\}\}/"${BASE_SHA:-}"}"
  out="${out//\{\{ROUND\}\}/"${ROUND:-}"}"
  # The target's facts (lib.sh: load_repo). REPO_RULES_TEXT may be empty — a
  # target need not add rules — so it is substituted but not guarded below.
  out="${out//\{\{REPO_RULES\}\}/"${REPO_RULES_TEXT:-}"}"
  out="${out//\{\{VITEST_CMD\}\}/"${VITEST_CMD:-}"}"
  out="${out//\{\{BUILD_CMD\}\}/"${BUILD_CMD:-}"}"
  out="${out//\{\{LINT_CMD\}\}/"${LINT_CMD:-}"}"
  # The fleet's own helper, with this repo's name, so the line is runnable
  # as printed: `bash <fleet>/check-mutation.sh <repo>`.
  out="${out//\{\{CHECK_MUTATION\}\}/"${CHECK_MUTATION:-}"}"

  # A placeholder the file uses but whose variable is empty substitutes to
  # nothing and reaches the agent as a gap, not an error. Name it.
  local p v
  for p in STORY_ID RULES REVIEW_TEXT STORY_TEXT INTENT STORY_BASE HEAD_SHA BASE_SHA ROUND VITEST_CMD BUILD_CMD LINT_CMD CHECK_MUTATION; do
    [[ "$src" == *"{{$p}}"* ]] || continue
    v="${!p:-}"
    [[ -n "$v" ]] || die "$1 uses {{$p}} but $p is empty"
  done

  local leftover
  leftover="$(grep -o '{{[A-Z_]*}}' <<< "$out" | sort -u | tr '\n' ' ')"
  [[ -z "$leftover" ]] || warn "unsubstituted in $1: $leftover"

  [[ -n "$out" ]] || die "rendered prompt is empty: $1"

  printf '%s' "$out"
}
