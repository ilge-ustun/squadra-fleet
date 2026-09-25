#!/usr/bin/env bash
#
# bin/install-skills.sh — link skills/<name> into every harness on this machine.
#
#   fleet install-skills
#
# The coordinator's procedures live in skills/<name>/SKILL.md, one format
# two harnesses read. Claude Code loads personal skills from
# ~/.claude/skills/<name>: linked here. Codex reads them from this repo's
# .agents/skills (a tracked symlink to skills/), so a codex started in the
# fleet repo has them and a codex anywhere else does not — above all the
# unattended reviewer, which runs in a target's worktree and has no use for
# the coordinator's procedures (24 Sep: it loaded fleet-coordinate and
# fleet-verdict into every review). Links an older version of this script
# made in $CODEX_HOME/skills are removed; anything else there (a reviewer's
# own skills) is left alone.
#
# Symlinks, so the fleet's copy is the only copy and a `git pull` here
# updates both. Idempotent. A directory that is not our own symlink is
# someone's work and is refused, not replaced.
#
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }

SRC="$FLEET_HOME/skills"
[[ -d "$SRC" ]] || die "no skills/ directory in $FLEET_HOME"
[[ "$(readlink -f "$FLEET_HOME/.agents/skills")" == "$(readlink -f "$SRC")" ]] \
  || die ".agents/skills in $FLEET_HOME is not a link to skills/ — Codex would not find the fleet skills"
TARGETS=("$HOME/.claude/skills")

rc=0; linked=0
for dest in "${TARGETS[@]}"; do
  mkdir -p "$dest" || die "cannot create $dest"
  for skill in "$SRC"/*/; do
    skill="${skill%/}"; name="$(basename "$skill")"
    [[ -f "$skill/SKILL.md" ]] || { warn "skills/$name has no SKILL.md — skipped"; continue; }
    link="$dest/$name"
    if [[ -L "$link" ]]; then
      [[ "$(readlink -f "$link")" == "$(readlink -f "$skill")" ]] || { ln -sfn "$skill" "$link"; log "relinked $link"; }
    elif [[ -e "$link" ]]; then
      warn "$link exists and is not a symlink — not ours, left alone"; rc=1; continue
    else
      ln -s "$skill" "$link" || die "cannot link $link"
    fi
    linked=$((linked + 1))
  done
done

# Codex's home: remove only our own links — a symlink named after a fleet
# skill that points into a skills/ directory of a fleet checkout.
CODEX_SKILLS="${CODEX_HOME:-$HOME/.codex}/skills"
removed=0
for skill in "$SRC"/*/; do
  name="$(basename "${skill%/}")"; link="$CODEX_SKILLS/$name"
  [[ -L "$link" && "$(readlink "$link")" == */skills/"$name" ]] || continue
  rm "$link" && removed=$((removed + 1))
done
log "$linked links in ${TARGETS[*]}; Codex reads them from $FLEET_HOME/.agents/skills"
(( removed == 0 )) || log "removed $removed old fleet link(s) from $CODEX_SKILLS — the reviewer no longer loads them"
exit "$rc"
