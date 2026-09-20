#!/usr/bin/env bash
#
# telegram.sh send [--pre] "<text>"
# telegram.sh poll
#
# The fleet's way of reaching a human, and the human's way of reaching back.
#
# Why polling. The box is behind NAT with no public HTTPS endpoint, so a
# webhook is impossible without a tunnel. getUpdates is a pull, exactly like
# the systemd timer that already polls the story queue: no inbound port, no
# certificate, nothing new to secure.
#
# Configuration lives in .env.fleet at the FLEET repo root (gitignored there),
# never in a target: a target's seed files are copied into every builder and
# reviewer worktree, so a token there is a token handed to every agent.
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

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
LOG_TAG=bot
OFFSET_FILE="$FLEET_HOME/.bot-offset"
QUEUE_START_CMD="${QUEUE_START_CMD:-systemctl --user start fleet-queue.service}"
CURL_TIMEOUT="${CURL_TIMEOUT:-20}"

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" && -f "$FLEET_HOME/.env.fleet" ]]; then
  set -a; . "$FLEET_HOME/.env.fleet"; set +a
fi

configured() { [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; }
api()        { printf 'https://api.telegram.org/bot%s/%s' "$TELEGRAM_BOT_TOKEN" "$1"; }

# ── out ──────────────────────────────────────────────────────────────────────

# Telegram caps a message at 4096 characters. A table that cannot fit is sent
# as several messages, split on line boundaries so no row is cut in half;
# the margin below the cap leaves room for the <pre> wrapper.
SEND_MAX="${SEND_MAX:-3800}"

send() {                              # send [--pre] <text>
  local pre=0; [[ "${1:-}" == --pre ]] && { pre=1; shift; }
  local text="$1"
  configured || { warn "not configured (.env.fleet) — message not sent: ${text%%$'\n'*}"; return 0; }
  local chunk="" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ -n "$chunk" && $(( ${#chunk} + 1 + ${#line} )) -gt "$SEND_MAX" ]]; then
      send_one "$pre" "$chunk"; chunk=""
    fi
    chunk+="${chunk:+$'\n'}$line"
  done <<< "$text"
  [[ -n "$chunk" ]] && send_one "$pre" "$chunk"
  return 0
}

# --pre: a monospace block, so a table keeps its columns on a phone. HTML
# parse mode, with the three characters HTML would misread escaped.
send_one() {                          # send_one <pre 0|1> <text>
  local text="$2"; local -a mode=()
  if [[ "$1" == 1 ]]; then
    text="${text//&/&amp;}"; text="${text//</&lt;}"; text="${text//>/&gt;}"
    text="<pre>$text</pre>"; mode=(--data-urlencode "parse_mode=HTML")
  fi
  curl -sS --max-time "$CURL_TIMEOUT" -X POST "$(api sendMessage)" \
       --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" \
       --data-urlencode "text=$text" "${mode[@]}" > /dev/null \
    || warn "sendMessage failed — the fleet is fine, you just were not told"
  return 0
}

# ── in ───────────────────────────────────────────────────────────────────────
#
# Commands are a fixed set with no grammar: the first word selects a handler,
# the second names the repo (load_repo refuses anything that is not a plain
# name), and each handler parses its own arguments. No part of a message ever
# reaches a shell. A story id must look like one before it is used as a path.

story_ok() { [[ "$1" =~ ^[0-9]{3}$ && -f "$REPO_ROOT/.stories/$1.md" ]]; }

# The launcher commits in this same checkout on its own schedule. Two writers,
# one index: the loser gets "Unable to create .git/index.lock", and since a
# failed status commit is a die, the loser is a dead round. Every writer takes
# the same advisory lock first — launch.sh does the same in
# commit_status.
with_lock() {                         # with_lock <command…>
  exec 9>"$REPO_ROOT/.git/fleet.lock"
  flock -w "${FLEET_LOCK_WAIT:-120}" 9 || warn "waited ${FLEET_LOCK_WAIT:-120}s for the fleet lock — going ahead"
  "$@"
  local rc=$?
  flock -u 9
  return $rc
}

cmd_status() { bash "$FLEET_HOME/status.sh" "$REPO_NAME" --bot; }

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
  if bash "$FLEET_HOME/revert.sh" "$REPO_NAME" "$id" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'; then
    echo "$id reverted"
  else
    echo "$id was not reverted — see the output above"
  fi
}

cmd_run() {
  if $QUEUE_START_CMD >/dev/null 2>&1; then echo "queue started"; else echo "could not start the queue"; fi
}

dispatch() {                          # dispatch <text> → reply on stdout
  local text="$1" verb repo arg rest
  read -r verb repo arg rest <<< "$text"
  case "$verb" in
    /run) cmd_run; return ;;
    /status|/why|/promote|/answer|/revert) : ;;
    *) printf '%s\n' "/status <repo>  /why <repo> <id>  /promote <repo> <id>  /answer <repo> <id> <text>  /revert <repo> <id>  /run"; return ;;
  esac
  # dispatch runs inside a command substitution, so a die here — an unknown
  # repo, a name that is not a name — ends only this command and its message
  # is the reply. The poll loop never dies.
  load_repo "${repo:-}"
  case "$verb" in
    /status)  cmd_status ;;
    /why)     cmd_why "${arg:-}" ;;
    /promote) with_lock cmd_promote "${arg:-}" ;;
    /answer)  [[ -n "${rest:-}" ]] && with_lock cmd_answer "${arg:-}" "$rest" || echo "usage: /answer <repo> <id> <text>" ;;
    /revert)  with_lock cmd_revert "${arg:-}" ;;
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
    reply="$(dispatch "$text" 2>&1)"
    # A table goes as a code block; everything else as plain text, so a URL
    # in a reply stays a link.
    if [[ "${text%% *}" == /status ]]; then send --pre "${reply:-(no output)}"
    else                                    send "${reply:-(no output)}"; fi
  done
}

case "${1:-}" in
  send) shift
        pre=""; [[ "${1:-}" == --pre ]] && { pre=--pre; shift; }
        [[ $# -ge 1 ]] || { echo "usage: telegram.sh send [--pre] <text>" >&2; exit 2; }
        send $pre "$*" ;;
  poll) poll ;;
  *)    echo "usage: telegram.sh {send <text>|poll}" >&2; exit 2 ;;
esac
