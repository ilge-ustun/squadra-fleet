// test/telegram-api.mts — a fake Telegram Bot API for test-lib.sh (seam 8).
//
//   node test/telegram-api.mts <trace-dir> <updates-file>
//
// test/curl shadowed `curl` on PATH, and that was the whole interception:
// the bash bot never reached api.telegram.org. Node's fetch never looks at
// PATH, so the TypeScript bot is pointed here instead — TELEGRAM_API_BASE
// names this server on a loopback port — and this records what test/curl
// recorded, in the same two-file shape, so a case can read either:
//
//   <trace>/api-calls     one line per request: `api <url>`, so a test can count
//                         them or grep the query string (offset=…)
//   <trace>/api-args-N    the URL, then for a sendMessage each decoded form
//                         field as key=value on its own line — text= first
//                         on its line, then the message's remaining lines as
//                         they are, exactly where the message text was read
//                         from curl's --data-urlencode arguments before
//
// Two requests exist:
//
//   POST …/sendMessage    records the request and answers {"ok":true}
//   GET  …/getUpdates     answers the contents of <updates-file>, read on each
//                         request (a case rewrites it between polls), or an
//                         empty result while the file does not exist
//
// The port is chosen by the kernel and written to <trace>/api-port once the
// server listens; the suite waits for that file. Killed by the suite when the
// case's fixture goes; nothing here exits on its own.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const [trace, updatesFile] = process.argv.slice(2);
if (trace === undefined || updatesFile === undefined) {
  process.stderr.write('usage: telegram-api.mts <trace-dir> <updates-file>\n');
  process.exit(2);
}
const TRACE: string = trace;
const UPDATES: string = updatesFile;

const EMPTY = '{"ok":true,"result":[]}\n';

function record(url: string, fields: string[]): void {
  appendFileSync(join(TRACE, 'api-calls'), `api ${url}\n`);
  const n = readFileSync(join(TRACE, 'api-calls'), 'utf8').split('\n').filter((l) => l.startsWith('api ')).length;
  writeFileSync(join(TRACE, `api-args-${n}`), [url, ...fields].map((l) => `${l}\n`).join(''));
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const host = req.headers.host ?? '127.0.0.1';
    const url = `http://${host}${req.url ?? '/'}`;
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const body = Buffer.concat(chunks).toString('utf8');
    const fields: string[] = [];
    for (const [k, v] of new URLSearchParams(body)) fields.push(`${k}=${v}`);
    record(url, fields);
    res.setHeader('content-type', 'application/json');
    if (path.endsWith('/sendMessage')) {
      res.end(`{"ok":true,"result":{"message_id":${fields.length}}}\n`);
    } else if (path.endsWith('/getUpdates')) {
      res.end(existsSync(UPDATES) ? readFileSync(UPDATES, 'utf8') : EMPTY);
    } else {
      res.end(EMPTY);
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  const a = server.address();
  if (a === null || typeof a === 'string') throw new Error('telegram-api: no port');
  writeFileSync(join(TRACE, 'api-port'), `${a.port}\n`);
});
