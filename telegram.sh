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
# The commands, the send and the poll — ts/src/telegram.ts, which documents
# them. This wrapper keeps the name every caller (fleet-bot.service, the
# launcher's FLEET_NOTIFY_CMD, the queue, the skills) uses.
#
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" || { echo "cannot source lib.sh" >&2; exit 1; }
command -v node >/dev/null || die "node not on PATH — the bot runs on Node $(cat "$FLEET_HOME/.nvmrc" 2>/dev/null)"
exec node "$FLEET_HOME/ts/src/bin/telegram.ts" "$@"
