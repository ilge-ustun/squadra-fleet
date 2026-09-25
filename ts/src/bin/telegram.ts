// fleet telegram send [--pre] "<text>" | poll — the fleet's way of reaching
// a human, and the human's way of reaching back; src/telegram.ts documents
// the commands, the configuration and the security model. fleet-bot.timer
// runs `poll` every minute; the launcher's FLEET_NOTIFY_CMD is `send`.
//
// Usage is 2; everything else is 0 — a notification that fails, a poll that
// finds Telegram unreachable, a command that dies, all warn and end
// normally, because nothing that happens here is part of a verdict. The one
// exception is a bug in this program itself: an exception nothing caught is
// an XX line and 1, so the journal shows it rather than a silent 0.
import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { dieMessage } from '../lib/log.ts';
import { TAG, makeContext, poll, send } from '../telegram.ts';

const FLEET_HOME = resolve(import.meta.dirname, '../../..');

async function main(argv: readonly string[]): Promise<number> {
  const [verb, ...rest] = argv;
  const c = makeContext(FLEET_HOME, process.env);
  if (verb === 'send') {
    let pre = false;
    let words = rest;
    if (words[0] === '--pre') { pre = true; words = words.slice(1); }
    if (words.length < 1) { writeSync(2, 'usage: fleet telegram send [--pre] <text>\n'); return 2; }
    await send(c, words.join(' '), pre);   // "$*"
    return 0;
  }
  if (verb === 'poll') {
    await poll(c);
    return 0;
  }
  writeSync(2, 'usage: fleet telegram {send <text>|poll}\n');
  return 2;
}

main(process.argv.slice(2)).then(
  (rc) => { process.exitCode = rc; },
  (e: unknown) => {
    dieMessage(`telegram.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, TAG);
    process.exitCode = 1;
  },
);
