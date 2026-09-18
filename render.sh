# Prompt rendering. Sourced by launch.sh.
#
# Prompt bodies live in fleet/prompts/*.md and reference values as {{NAME}},
# not $NAME, so the files are inert text: nothing expands by accident and a
# prompt file cannot inject shell.
#
# Order matters: rules.md itself contains {{STORY_ID}}, so render RULES first,
# then render the build prompts that embed {{RULES}}.

render_prompt() {
  local src out
  src="$(cat "$PROMPTS_DIR/$1")" || die "prompt not found: $1"
  out="$src"
  out="${out//\{\{STORY_ID\}\}/${STORY_ID:-}}"
  out="${out//\{\{RULES\}\}/${RULES:-}}"
  out="${out//\{\{REVIEW_TEXT\}\}/${REVIEW_TEXT:-}}"
  out="${out//\{\{STORY\}\}/${STORY_TEXT:-}}"
  out="${out//\{\{INTENT\}\}/${INTENT:-}}"
  out="${out//\{\{STORY_BASE\}\}/${STORY_BASE:-}}"
  out="${out//\{\{HEAD_SHA\}\}/${HEAD_SHA:-}}"
  out="${out//\{\{BASE_SHA\}\}/${BASE_SHA:-}}"
  out="${out//\{\{ROUND\}\}/${ROUND:-}}"

  # A placeholder the file uses but whose variable is empty substitutes to
  # nothing and reaches the agent as a gap, not an error. Name it.
  local p v
  for p in STORY_ID RULES REVIEW_TEXT STORY_TEXT INTENT STORY_BASE HEAD_SHA BASE_SHA ROUND; do
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
