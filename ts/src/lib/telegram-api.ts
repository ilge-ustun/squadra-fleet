// The Telegram Bot API, the two calls telegram.sh made with curl
// (telegram.sh:42,74-77,291-293): a POST for a message, a GET for the
// updates, each with a wall-clock limit (curl --max-time). Node's fetch
// instead of curl: nothing else on this box needs curl once this is the
// client, and the same call is one process, not two.
//
// Nothing here throws. A notification is not part of a verdict, and a bot
// that cannot reach Telegram must say so and go on; the caller warns.
//
// The base URL is a seam: test/suite.sh's fake API (test/fakes/telegram-api.mts)
// listens on a loopback port, and TELEGRAM_API_BASE points a bot at it —
// fetch never looks at PATH, so a fake curl could not stand in.
export const DEFAULT_BASE = 'https://api.telegram.org';

export function apiUrl(base: string | undefined, token: string, method: string): string {
  const b = (base === undefined || base === '' ? DEFAULT_BASE : base).replace(/\/+$/, '');
  return `${b}/bot${token}/${method}`;
}

export interface SendOptions {
  base?: string | undefined;
  token: string;
  chatId: string;
  text: string;
  /** 'HTML' for a <pre> block (telegram.sh:72); absent means plain text. */
  parseMode?: 'HTML';
  timeoutSec: number;
}

/** sendMessage. True when Telegram accepted it (a 2xx); false on any
 *  failure — unreachable, timed out, or an error status (curl -sS without
 *  --fail counted a 400 as sent; this does not, and the caller's warning is
 *  the only difference). */
export async function sendMessage(o: SendOptions): Promise<boolean> {
  const body = new URLSearchParams({ chat_id: o.chatId, text: o.text });
  if (o.parseMode !== undefined) body.set('parse_mode', o.parseMode);
  try {
    const res = await fetch(apiUrl(o.base, o.token, 'sendMessage'), {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(o.timeoutSec * 1000),
    });
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}

/** One update as getUpdates returns it: only what the bot reads. */
export interface Update {
  update_id: number;
  message?: { from?: { id?: number }; text?: string };
}

export interface GetUpdatesOptions {
  base?: string | undefined;
  token: string;
  offset: number;
  timeoutSec: number;
}

/** 'failed': the request did not complete (curl's non-zero exit —
 *  telegram.sh:292). 'no-result': it did, but the body is not
 *  `{"ok":true,"result":[…]}` (jq -e '.ok == true' — telegram.sh:293). */
export type GetUpdatesResult = { ok: true; updates: Update[] } | { ok: false; reason: 'failed' | 'no-result' };

export async function getUpdates(o: GetUpdatesOptions): Promise<GetUpdatesResult> {
  let raw: string;
  try {
    const res = await fetch(`${apiUrl(o.base, o.token, 'getUpdates')}?offset=${o.offset}&timeout=0`, {
      signal: AbortSignal.timeout(o.timeoutSec * 1000),
    });
    raw = await res.text();
  } catch {
    return { ok: false, reason: 'failed' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'no-result' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'no-result' };
  const p = parsed as { ok?: unknown; result?: unknown };
  if (p.ok !== true || !Array.isArray(p.result)) return { ok: false, reason: 'no-result' };
  return { ok: true, updates: p.result as Update[] };
}
