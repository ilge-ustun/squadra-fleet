# Prompt rendering. Sourced by launch.sh.
#
# Prompt bodies live in fleet/prompts/*.md and reference values as {{NAME}},
# not $NAME, so the files are inert text: nothing expands by accident and a
# prompt file cannot inject shell.
#
# Order matters: rules.md itself contains {{STORY_ID}}, so render RULES first,
# then render the build prompts that embed {{RULES}}.

render_prompt() {
  local out
  out="$(cat "$PROMPTS_DIR/$1")" || die "prompt not found: $1"
  out="${out//\{\{STORY_ID\}\}/$STORY_ID}"
  out="${out//\{\{RULES\}\}/$RULES}"
  out="${out//\{\{REVIEW_TEXT\}\}/$REVIEW_TEXT}"
  out="${out//\{\{HEAD_SHA\}\}/$HEAD_SHA}"
  out="${out//\{\{BASE_SHA\}\}/$BASE_SHA}"
  out="${out//\{\{ROUND\}\}/$ROUND}"

  # An unsubstituted placeholder reaches the agent as literal text and nothing
  # else would catch it. Warn rather than die: a prompt is still usable.
  local leftover
  leftover="$(grep -o '{{[A-Z_]*}}' <<< "$out" | sort -u | tr '\n' ' ')"
  [[ -z "$leftover" ]] || warn "unsubstituted in $1: $leftover"

  printf '%s' "$out"
}
