import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { apiUrl, getUpdates, sendMessage } from './telegram-api.ts';

// One POST for a message, one GET for the updates, twenty seconds each, and
// nothing here ever throws: the bot's caller warns and goes on, because a
// notification is not part of a verdict.
interface Seen { method: string; url: string; body: string; contentType: string }
let server: Server;
let base: string;
let seen: Seen[];
let answer: (req: IncomingMessage, res: ServerResponse) => void;

beforeEach(async () => {
  seen = [];
  answer = (_req, res) => res.end('{"ok":true,"result":[]}');
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString(), contentType: String(req.headers['content-type'] ?? '') });
      answer(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (a === null || typeof a === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${a.port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });

const TOKEN = '123:AA';

describe('apiUrl', () => {
  it('is https://api.telegram.org/bot<token>/<method> by default', () => {
    expect(apiUrl(undefined, TOKEN, 'sendMessage')).toBe('https://api.telegram.org/bot123:AA/sendMessage');
  });
  it('TELEGRAM_API_BASE replaces the host, a trailing slash tolerated', () => {
    expect(apiUrl('http://127.0.0.1:1/', TOKEN, 'getUpdates')).toBe('http://127.0.0.1:1/bot123:AA/getUpdates');
  });
});

describe('sendMessage', () => {
  it('POSTs chat_id and text as a form, no parse_mode by default', async () => {
    const ok = await sendMessage({ base, token: TOKEN, chatId: '42', text: 'a & b\nline two', timeoutSec: 5 });
    expect(ok).toBe(true);
    expect(seen).toHaveLength(1);
    const s = seen[0]!;
    expect(s.method).toBe('POST');
    expect(s.url).toBe('/bot123:AA/sendMessage');
    expect(s.contentType).toContain('application/x-www-form-urlencoded');
    const p = new URLSearchParams(s.body);
    expect(p.get('chat_id')).toBe('42');
    expect(p.get('text')).toBe('a & b\nline two');
    expect(p.has('parse_mode')).toBe(false);
  });

  it('carries parse_mode=HTML when asked', async () => {
    await sendMessage({ base, token: TOKEN, chatId: '42', text: '<pre>t</pre>', parseMode: 'HTML', timeoutSec: 5 });
    expect(new URLSearchParams(seen[0]!.body).get('parse_mode')).toBe('HTML');
  });

  it('is false when nothing listens', async () => {
    expect(await sendMessage({ base: 'http://127.0.0.1:1', token: TOKEN, chatId: '42', text: 'x', timeoutSec: 5 })).toBe(false);
  });

  it('is false when the API answers an error status', async () => {
    answer = (_req, res) => { res.statusCode = 400; res.end('{"ok":false}'); };
    expect(await sendMessage({ base, token: TOKEN, chatId: '42', text: 'x', timeoutSec: 5 })).toBe(false);
  });

  it('gives up after timeoutSec (curl --max-time)', async () => {
    answer = () => { /* never answers */ };
    const t0 = Date.now();
    expect(await sendMessage({ base, token: TOKEN, chatId: '42', text: 'x', timeoutSec: 0.3 })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('getUpdates', () => {
  it('GETs with offset and timeout=0 and hands back the updates', async () => {
    answer = (_req, res) => res.end('{"ok":true,"result":[{"update_id":5,"message":{"from":{"id":42},"text":"/help"}}]}');
    const r = await getUpdates({ base, token: TOKEN, offset: 3, timeoutSec: 5 });
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.url).toBe('/bot123:AA/getUpdates?offset=3&timeout=0');
    expect(r).toEqual({ ok: true, updates: [{ update_id: 5, message: { from: { id: 42 }, text: '/help' } }] });
  });

  it("is 'failed' when nothing listens (curl's exit status)", async () => {
    expect(await getUpdates({ base: 'http://127.0.0.1:1', token: TOKEN, offset: 0, timeoutSec: 5 })).toEqual({ ok: false, reason: 'failed' });
  });

  it("is 'no-result' when the body is not JSON or .ok is not true (jq -e '.ok == true')", async () => {
    answer = (_req, res) => res.end('<html>oops</html>');
    expect(await getUpdates({ base, token: TOKEN, offset: 0, timeoutSec: 5 })).toEqual({ ok: false, reason: 'no-result' });
    answer = (_req, res) => res.end('{"ok":false,"description":"Unauthorized"}');
    expect(await getUpdates({ base, token: TOKEN, offset: 0, timeoutSec: 5 })).toEqual({ ok: false, reason: 'no-result' });
    answer = (_req, res) => res.end('{"ok":true}');
    expect(await getUpdates({ base, token: TOKEN, offset: 0, timeoutSec: 5 })).toEqual({ ok: false, reason: 'no-result' });
  });

  it('gives up after timeoutSec', async () => {
    answer = () => {};
    expect(await getUpdates({ base, token: TOKEN, offset: 0, timeoutSec: 0.3 })).toEqual({ ok: false, reason: 'failed' });
  });
});
