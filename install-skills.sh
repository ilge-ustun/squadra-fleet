#!/usr/bin/env bash
#
# install-skills.sh — link skills/<name> into every harness on this machine.
#
#   bash install-skills.sh
#
# The coordinator's procedures live in skills/<name>/SKILL.md, one format
# two harnesses read: Claude Code loads personal skills from
# ~/.claude/skills/<name>, Codex from $CODEX_HOME/skills/<name> (default
# ~/.codex/skills). Symlinks, so the fleet's copy is the only copy and a
# `git pull` here updates both. Idempotent. A directory that is not our own
# symlink is someone's work and is refused, not replaced.
#
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }

SRC="$FLEET_HOME/skills"
[[ -d "$SRC" ]] || die "no skills/ directory in $FLEET_HOME"
TARGETS=("$HOME/.claude/skills" "${CODEX_HOME:-$HOME/.codex}/skills")

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
log "$linked links across ${#TARGETS[@]} harness directories: ${TARGETS[*]}"
exit "$rc"
