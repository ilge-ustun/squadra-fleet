#!/usr/bin/env bash
#
# fleet/telegram.sh send "<text>"
# fleet/telegram.sh poll
#
# The fleet's way of reaching a human, and the human's way of reaching back.
#
# Why polling. The box is behind NAT with no public HTTPS endpoint, so a
# webhook is impossible without a tunnel. getUpdates is a pull, exactly like
# the systemd timer that already polls the story queue: no inbound port, no
# certificate, nothing new to secure.
#
# Configuration lives in .env.fleet at the repo root — NOT in .env.local.
# .env.local is in the launcher's SEED_FILES and is copied into every builder
# and reviewer worktree, so a token there is a token handed to every agent.
# .env.fleet is gitignored by the existing .env* rule and is read only here.
#
#   TELEGRAM_BOT_TOKEN=123456:AA…      from @BotFather
#   TELEGRAM_CHAT_ID=987654321         your own numeric id
#
# Authorisation is one comparison and it is the entire security model: anyone
# who finds the bot can message it, so an update is acted on only when its
# sender is TELEGRAM_CHAT_ID. Everything else is dropped without a reply — a
# reply would confirm the bot exists.
#
# Nothing here dies. A fleet whose notifications fail must still run: a
# notification is not part of a verdict, and killing a round because Telegram
# was unreachable would be strictly worse than being told late.
#
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
OFFSET_FILE="$REPO_ROOT/.bot-offset"
QUEUE_START_CMD="${QUEUE_START_CMD:-systemctl --user start fleet-queue.service}"
CURL_TIMEOUT="${CURL_TIMEOUT:-20}"

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'
log()  { printf '%s==> [bot] %s%s\n' "$GRN" "$1" "$RST"; }
warn() { printf '%s!! [bot] %s%s\n'  "$YLW" "$1" "$RST"; }

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" && -f "$REPO_ROOT/.env.fleet" ]]; then
  set -a; . "$REPO_ROOT/.env.fleet"; set +a
fi

configured() { [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; }
api()        { printf 'https://api.telegram.org/bot%s/%s' "$TELEGRAM_BOT_TOKEN" "$1"; }

# ── out ──────────────────────────────────────────────────────────────────────

send() {                              # send <text>
  local text="$1"
  configured || { warn "not configured (.env.fleet) — message not sent: ${text%%$'\n'*}"; return 0; }
  curl -sS --max-time "$CURL_TIMEOUT" -X POST "$(api sendMessage)" \
       --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" \
       --data-urlencode "text=$text" > /dev/null \
    || warn "sendMessage failed — the fleet is fine, you just were not told"
  return 0
}

# ── in ───────────────────────────────────────────────────────────────────────
#
# Commands are a fixed set with no grammar: the first word selects a handler
# and each handler parses its own arguments. No part of a message ever reaches
# a shell. A story id must look like one before it is used as a path.

story_ok() { [[ "$1" =~ ^[0-9]{3}$ && -f "$REPO_ROOT/.stories/$1.md" ]]; }

cmd_status() { ( cd "$REPO_ROOT" && bash fleet/status.sh ) | sed 's/\x1b\[[0-9;]*m//g'; }

cmd_why() {                           # cmd_why <id>
  local id="$1"
  story_ok "$id" || { echo "no such story: $id"; return; }
  [[ -f "$REPO_ROOT/.review/$id.md" ]] || { echo "$id has no review yet"; return; }
  awk '/^### Machine/ {blk=""; inblk=1; next} /^### / {inblk=0} inblk {blk=blk $0 "\n"}
       END {printf "%s", blk}' "$REPO_ROOT/.review/$id.md"
}

cmd_promote() {                       # cmd_promote <id>
  local id="$1"
  story_ok "$id" || { echo "no such story: $id"; return; }
  local f="$REPO_ROOT/.stories/$id.md"
  sed -i "0,/^status:.*/s//status: ready/" "$f"
  git -C "$REPO_ROOT" add -- ".stories/$id.md"
  if git -C "$REPO_ROOT" diff --cached --quiet; then
    echo "$id was already ready"
  else
    git -C "$REPO_ROOT" commit -q -m "story($id): promoted to ready (telegram)" \
      && { git -C "$REPO_ROOT" push -q 2>/dev/null || true; echo "$id is ready — the next drain will pick it up"; } \
      || echo "$id could not be committed"
  fi
}

cmd_answer() {                        # cmd_answer <id> <text…>
  local id="$1"; shift
  story_ok "$id" || { echo "no such story: $id"; return; }
  local b="$REPO_ROOT/.blocked/$id.md"
  [[ -f "$b" ]] || { echo "$id is not blocked — nothing is waiting for an answer"; return; }
  printf '\n## Answer (telegram, %s)\n\n%s\n' "$(date -Iseconds)" "$*" >> "$b"
  sed -i "0,/^status:.*/s//status: ready/" "$REPO_ROOT/.stories/$id.md"
  git -C "$REPO_ROOT" add -- ".blocked/$id.md" ".stories/$id.md"
  git -C "$REPO_ROOT" commit -q -m "story($id): answered, back to ready (telegram)" >/dev/null \
    && { git -C "$REPO_ROOT" push -q 2>/dev/null || true; echo "answered — $id is ready again"; } \
    || echo "$id could not be committed"
}

cmd_revert() {                        # cmd_revert <id>
  local id="$1"
  story_ok "$id" || { echo "no such story: $id"; return; }
  # The script owns every refusal; this only reports what it said.
  if ( cd "$REPO_ROOT" && bash fleet/revert.sh "$id" ) 2>&1 | sed 's/\x1b\[[0-9;]*m//g'; then
    echo "$id reverted"
  else
    echo "$id was not reverted — see the output above"
  fi
}

cmd_run() {
  if $QUEUE_START_CMD >/dev/null 2>&1; then echo "queue started"; else echo "could not start the queue"; fi
}

dispatch() {                          # dispatch <text> → reply on stdout
  local text="$1" verb arg rest
  read -r verb arg rest <<< "$text"
  case "$verb" in
    /status)  cmd_status ;;
    /why)     cmd_why "${arg:-}" ;;
    /promote) cmd_promote "${arg:-}" ;;
    /answer)  [[ -n "${rest:-}" ]] && cmd_answer "${arg:-}" "$rest" || echo "usage: /answer <id> <text>" ;;
    /revert)  cmd_revert "${arg:-}" ;;
    /run)     cmd_run ;;
    *)        printf '%s\n' "/status  /why <id>  /promote <id>  /answer <id> <text>  /revert <id>  /run" ;;
  esac
}

poll() {
  configured || { warn "not configured (.env.fleet) — nothing to poll"; return 0; }
  local offset raw updates n from text reply
  offset="$(cat "$OFFSET_FILE" 2>/dev/null || echo 0)"
  [[ "$offset" =~ ^[0-9]+$ ]] || offset=0

  raw="$(curl -sS --max-time "$CURL_TIMEOUT" "$(api getUpdates)?offset=$offset&timeout=0")" \
    || { warn "getUpdates failed"; return 0; }
  jq -e '.ok == true' >/dev/null 2>&1 <<< "$raw" || { warn "getUpdates returned no result"; return 0; }

  n="$(jq '.result | length' <<< "$raw")"
  (( n == 0 )) && return 0

  # The highest update_id is acknowledged whatever happens to the messages
  # themselves: an update that cannot be handled must not be replayed for ever.
  jq -r '.result[-1].update_id + 1' <<< "$raw" > "$OFFSET_FILE"

  local i=0
  while (( i < n )); do
    updates="$(jq -c ".result[$i]" <<< "$raw")"; i=$((i + 1))
    from="$(jq -r '.message.from.id // empty' <<< "$updates")"
    text="$(jq -r '.message.text // empty'    <<< "$updates")"
    [[ -n "$text" ]] || continue
    if [[ "$from" != "$TELEGRAM_CHAT_ID" ]]; then
      # No reply: answering would confirm the bot exists to whoever found it.
      warn "ignored a message from $from"
      continue
    fi
    log "command: ${text%%$'\n'*}"
    reply="$(dispatch "$text")"
    send "${reply:-(no output)}"
  done
}

case "${1:-}" in
  send) shift; [[ $# -ge 1 ]] || { echo "usage: fleet/telegram.sh send <text>" >&2; exit 2; }; send "$*" ;;
  poll) poll ;;
  *)    echo "usage: fleet/telegram.sh {send <text>|poll}" >&2; exit 2 ;;
esac
