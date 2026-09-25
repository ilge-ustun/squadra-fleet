import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from './lib/proc.ts';
import type { RepoConfig } from './lib/config.ts';
import {
  type BotDeps, type BotContext, configuredFrom, dispatch, htmlPre, isoSeconds, machineBlockBody, parseCommand, poll,
  readBotKnobs, resolveRepo, send, splitText, storyOk,
} from './telegram.ts';

// ── pure parts ───────────────────────────────────────────────────────────────

describe('splitText', () => {
  it('an empty text is nothing to send', () => { expect(splitText('', 10)).toEqual([]); });
  it('one short text is one message', () => { expect(splitText('a\nb', 10)).toEqual(['a\nb']); });
  it('a trailing newline is an empty last line, kept', () => {
    expect(splitText('a\n', 10)).toEqual(['a\n']);
  });
  it('splits on line boundaries when the next line would not fit', () => {
    expect(splitText('aaaa\nbbbb\ncccc', 9)).toEqual(['aaaa\nbbbb', 'cccc']);
  });
  it('exactly at the limit still fits (the test is > max)', () => {
    expect(splitText('aaaa\nbbbb', 9)).toEqual(['aaaa\nbbbb']);
  });
  it('a single line over the limit goes alone, whole', () => {
    expect(splitText('short\n' + 'x'.repeat(20) + '\nshort', 10)).toEqual(['short', 'x'.repeat(20), 'short']);
  });
  it('25 rows of 204 characters at 3800: two messages, no row cut', () => {
    const rows = Array.from({ length: 25 }, (_, i) => `9${String(i).padStart(2, '0')} ${'a'.repeat(200)}`);
    const parts = splitText(rows.join('\n'), 3800);
    expect(parts).toHaveLength(2);
    expect(parts.flatMap((p) => p.split('\n'))).toEqual(rows);
  });
});

describe('htmlPre', () => {
  it('escapes the three characters HTML would misread and wraps in <pre>', () => {
    expect(htmlPre('a & b <c> d')).toBe('<pre>a &amp; b &lt;c&gt; d</pre>');
  });
});

describe('parseCommand (`read -r verb repo arg rest`)', () => {
  it('four fields, the rest keeping its inner spaces', () => {
    expect(parseCommand('/answer t 007 yes,  do it')).toEqual({ verb: '/answer', repo: 't', arg: '007', rest: 'yes,  do it' });
  });
  it('fewer words leave the later fields empty', () => {
    expect(parseCommand('/status')).toEqual({ verb: '/status', repo: '', arg: '', rest: '' });
    expect(parseCommand('/why t')).toEqual({ verb: '/why', repo: 't', arg: '', rest: '' });
  });
  it('leading, trailing and repeated blanks and tabs are field separators', () => {
    expect(parseCommand('  /why \t t   007  ')).toEqual({ verb: '/why', repo: 't', arg: '007', rest: '' });
  });
  it('read stops at the first newline: a second line is not part of the command', () => {
    expect(parseCommand('/answer t 007 first\nsecond')).toEqual({ verb: '/answer', repo: 't', arg: '007', rest: 'first' });
  });
  it('backslashes are literal (-r)', () => {
    expect(parseCommand('/answer t 007 a\\b')).toEqual({ verb: '/answer', repo: 't', arg: '007', rest: 'a\\b' });
  });
  it('an empty text is an empty verb', () => {
    expect(parseCommand('')).toEqual({ verb: '', repo: '', arg: '', rest: '' });
  });
});

describe('isoSeconds (date -Iseconds)', () => {
  it('local time with the zone offset, no fraction', () => {
    expect(isoSeconds(new Date(2026, 8, 25, 10, 6, 8))).toMatch(/^2026-09-25T10:06:08[+-]\d\d:\d\d$/);
  });
});

describe('machineBlockBody (/why)', () => {
  it('is the last Machine block without its heading', () => {
    const review = ['---', 'verdict: FAIL', '---', '', '### Round 1', 'x', '### Machine (round 1)', 'computed: FAIL — a', 'builder: sonnet', '', '### Notes', 'n'].join('\n');
    expect(machineBlockBody(review)).toBe('computed: FAIL — a\nbuilder: sonnet');
  });
  it('is empty when there is none', () => { expect(machineBlockBody('---\nverdict: PASS\n---\n')).toBe(''); });
});

// ── a fleet and a target on disk ─────────────────────────────────────────────

let tmp: string;
let fleetHome: string;
let root: string;
let logged: string[];
let warned: string[];
let sent: { text: string; parseMode: string | undefined }[];
let ran: string[][];
let detached: string[][];
let commands: string[][];
let updatesBody: () => Awaited<ReturnType<BotDeps['api']['getUpdates']>>;
let sendOk: boolean;

function git(...args: string[]): string {
  const r = runSync('git', ['-C', root, ...args]);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function cfg(): RepoConfig {
  return { name: 't', root, baseBranch: 'base', installCmd: 'true', vitestCmd: 'true', buildCmd: 'true', lintCmd: 'true', seedFiles: [], probeDir: 'src', mergeMode: 'direct' };
}

function ctx(extraEnv: Record<string, string> = {}): BotContext {
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '', HOME: tmp, TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '42', ...extraEnv };
  const deps: BotDeps = {
    io: { log: (m) => logged.push(m), warn: (m) => warned.push(m) },
    api: {
      sendMessage: async (o) => { sent.push({ text: o.text, parseMode: o.parseMode }); return sendOk; },
      getUpdates: async () => updatesBody(),
    },
    runFleet: (command, args) => { ran.push([command, ...args]); return { status: 0, output: `ran ${command} ${args.join(' ')}\x1b[32m!\x1b[0m` }; },
    spawnDetached: (command, args) => { detached.push([command, ...args]); },
    runCommand: (argv) => { commands.push([...argv]); return argv[0] === 'false' ? 1 : 0; },
    loadRepo: (_home, name) => { if (name === 't') return cfg(); throw new Error(`unknown repo '${name}'`); },
    now: () => new Date(2026, 8, 25, 10, 6, 8),
  };
  return { fleetHome, env, knobs: readBotKnobs(env), deps };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fleet-bot-'));
  fleetHome = join(tmp, 'fleet'); root = join(tmp, 'repo');
  mkdirSync(join(fleetHome, 'repos'), { recursive: true });
  writeFileSync(join(fleetHome, 'repos', 't.env'), `REPO_PATH=${root}\n`);
  mkdirSync(join(root, '.stories'), { recursive: true });
  mkdirSync(join(root, '.review'));
  mkdirSync(join(root, '.blocked'));
  writeFileSync(join(root, '.stories', '900.md'), '---\nstatus: draft\nround: 0\n---\n\n# Story 900: fixture\n');
  runSync('git', ['init', '-q', '-b', 'base', root]);
  git('config', 'user.name', 'fleet-test'); git('config', 'user.email', 'fleet-test@localhost');
  git('add', '.'); git('commit', '-q', '-m', 'fixture');
  logged = []; warned = []; sent = []; ran = []; detached = []; commands = [];
  updatesBody = () => ({ ok: true, updates: [] });
  sendOk = true;
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

// ── configuration ────────────────────────────────────────────────────────────

describe('configuredFrom', () => {
  it('the environment wins: with the token set, .env.fleet is not read', () => {
    writeFileSync(join(fleetHome, '.env.fleet'), 'TELEGRAM_BOT_TOKEN=file\nTELEGRAM_CHAT_ID=1\n');
    expect(configuredFrom({ TELEGRAM_BOT_TOKEN: 'env', TELEGRAM_CHAT_ID: '2' }, fleetHome, warned)).toEqual({ token: 'env', chatId: '2' });
  });
  it('without a token in the environment, the file supplies both', () => {
    writeFileSync(join(fleetHome, '.env.fleet'), 'TELEGRAM_BOT_TOKEN="123:AA"\nTELEGRAM_CHAT_ID=987\n');
    expect(configuredFrom({ PATH: process.env['PATH'] ?? '', TELEGRAM_CHAT_ID: '2' }, fleetHome, warned)).toEqual({ token: '123:AA', chatId: '987' });
  });
  it('neither: undefined, silently', () => {
    expect(configuredFrom({ PATH: process.env['PATH'] ?? '' }, fleetHome, warned)).toBeUndefined();
    expect(warned).toEqual([]);
  });
  it('a token without a chat id is not configured (both are needed)', () => {
    expect(configuredFrom({ TELEGRAM_BOT_TOKEN: 'x' }, fleetHome, warned)).toBeUndefined();
  });
  it('a file bash cannot source is a warning and not configured', () => {
    writeFileSync(join(fleetHome, '.env.fleet'), 'if\n');
    expect(configuredFrom({ PATH: process.env['PATH'] ?? '' }, fleetHome, warned)).toBeUndefined();
    expect(warned[0]).toMatch(/could not read .*\.env\.fleet/);
  });
});

describe('readBotKnobs', () => {
  it('defaults', () => {
    expect(readBotKnobs({})).toEqual({ base: undefined, timeoutSec: 20, sendMax: 3800, lockWait: 120, queueStartCmd: 'systemctl --user start fleet-queue.service' });
  });
  it('from the environment', () => {
    expect(readBotKnobs({ TELEGRAM_API_BASE: 'http://h', TELEGRAM_TIMEOUT: '5', SEND_MAX: '10', FLEET_LOCK_WAIT: '1', QUEUE_START_CMD: 'true' }))
      .toEqual({ base: 'http://h', timeoutSec: 5, sendMax: 10, lockWait: 1, queueStartCmd: 'true' });
  });
});

// ── send ─────────────────────────────────────────────────────────────────────

describe('send', () => {
  it('plain: one message per chunk, no parse mode', async () => {
    await send(ctx({ SEND_MAX: '9' }), 'aaaa\nbbbb\ncccc', false);
    expect(sent).toEqual([{ text: 'aaaa\nbbbb', parseMode: undefined }, { text: 'cccc', parseMode: undefined }]);
  });
  it('--pre: each chunk escaped, wrapped and sent as HTML', async () => {
    await send(ctx(), 'a <b>', true);
    expect(sent).toEqual([{ text: '<pre>a &lt;b&gt;</pre>', parseMode: 'HTML' }]);
  });
  it('not configured: a warning naming the first line, nothing sent', async () => {
    const c = ctx(); delete c.env['TELEGRAM_BOT_TOKEN'];
    await send(c, 'first line\nsecond', false);
    expect(sent).toEqual([]);
    expect(warned).toEqual(['not configured (.env.fleet) — message not sent: first line']);
  });
  it('a failed send is a warning, and the fleet is fine', async () => {
    sendOk = false;
    await send(ctx(), 'x', false);
    expect(warned).toEqual(['sendMessage failed — the fleet is fine, you just were not told']);
  });
});

// ── the phone's side ─────────────────────────────────────────────────────────

describe('resolveRepo', () => {
  it('a registered name is used as given', () => {
    expect(resolveRepo(ctx(), { verb: '/why', repo: 't', arg: '007', rest: '' })).toEqual({ repo: 't', arg: '007', rest: '' });
  });
  it('one repo: an absent repo, a story id or an epic in its slot shift right', () => {
    expect(resolveRepo(ctx(), { verb: '/why', repo: '007', arg: '', rest: '' })).toEqual({ repo: 't', arg: '007', rest: '' });
    expect(resolveRepo(ctx(), { verb: '/status', repo: '', arg: '', rest: '' })).toEqual({ repo: 't', arg: '', rest: '' });
    expect(resolveRepo(ctx(), { verb: '/merge', repo: 'epic/x', arg: '', rest: '' })).toEqual({ repo: 't', arg: 'epic/x', rest: '' });
    expect(resolveRepo(ctx(), { verb: '/answer', repo: '007', arg: 'yes', rest: 'it is' })).toEqual({ repo: 't', arg: '007', rest: 'yes it is' });
  });
  it('one repo, a misspelt name: told so, not read as a story id', () => {
    expect(resolveRepo(ctx(), { verb: '/why', repo: 'nosuch', arg: '007', rest: '' })).toEqual({ reply: 'unknown repo: nosuch\nknown: t\n/help lists the commands' });
  });
  it('several repos: nothing is guessed', () => {
    writeFileSync(join(fleetHome, 'repos', 'u.env'), 'REPO_PATH=/nowhere\n');
    expect(resolveRepo(ctx(), { verb: '/why', repo: '007', arg: '', rest: '' })).toEqual({ reply: 'unknown repo: 007\nknown: t u\n/help lists the commands' });
    expect(resolveRepo(ctx(), { verb: '/status', repo: '', arg: '', rest: '' })).toEqual({ reply: 'unknown repo: (none given)\nknown: t u\n/help lists the commands' });
  });
});

describe('storyOk', () => {
  it('three digits and a file', () => {
    expect(storyOk(root, '900')).toBe(true);
    expect(storyOk(root, '901')).toBe(false);
    expect(storyOk(root, '90')).toBe(false);
    expect(storyOk(root, '../x')).toBe(false);
  });
});

describe('dispatch', () => {
  it('/help, /start and an unknown verb are the grouped help; one repo adds the footer', () => {
    for (const t of ['/help', '/start', '/nope', '']) {
      const r = dispatch(ctx(), t);
      expect(r).toContain('/status-all <repo>');
      expect(r).toContain('/promote <repo> <id>');
      expect(r).toMatch(/One repo is registered \(t\), so you can leave <repo> out\.$/);
    }
    writeFileSync(join(fleetHome, 'repos', 'u.env'), 'REPO_PATH=/nowhere\n');
    expect(dispatch(ctx(), '/help')).not.toContain('One repo');
  });
  it('/repo lists the registry with its paths; /repos too', () => {
    expect(dispatch(ctx(), '/repo')).toBe(`t  ${root}`);
    writeFileSync(join(fleetHome, 'repos', 'u.env'), 'OTHER=1\n');
    expect(dispatch(ctx(), '/repos')).toBe(`t  ${root}\nu  ?`);
    rmSync(join(fleetHome, 'repos'), { recursive: true }); mkdirSync(join(fleetHome, 'repos'));
    expect(dispatch(ctx(), '/repo')).toBe('no repos registered — add one at repos/<name>.env');
  });
  it('/run starts the queue with QUEUE_START_CMD, word-split', () => {
    expect(dispatch(ctx({ QUEUE_START_CMD: 'systemctl --user start x' }), '/run')).toBe('queue started');
    expect(commands).toEqual([['systemctl', '--user', 'start', 'x']]);
    expect(dispatch(ctx({ QUEUE_START_CMD: 'false' }), '/run')).toBe('could not start the queue');
  });
  it('/status and /status-all go through fleet status --bot, output merged', () => {
    expect(dispatch(ctx(), '/status t')).toBe('ran status t --bot\x1b[32m!\x1b[0m');
    expect(dispatch(ctx(), '/status-all')).toBe('ran status t --bot --all\x1b[32m!\x1b[0m');
    expect(ran).toEqual([['status', 't', '--bot'], ['status', 't', '--bot', '--all']]);
  });
  it('a repo the loader refuses: its message is the reply', () => {
    writeFileSync(join(fleetHome, 'repos', 'u.env'), 'REPO_PATH=/nowhere\n');
    expect(dispatch(ctx(), '/status u')).toBe("unknown repo 'u'");
  });
  it('/why: the machine block, or why there is none', () => {
    expect(dispatch(ctx(), '/why t 900')).toBe('900 has no review yet');
    expect(dispatch(ctx(), '/why t 901')).toBe('no such story: 901');
    expect(dispatch(ctx(), '/why t')).toBe('no such story: ');
    writeFileSync(join(root, '.review', '900.md'), '---\nverdict: FAIL\n---\n### Machine (round 1)\ncomputed: FAIL — x\n\n### Round 1\n');
    expect(dispatch(ctx(), '/why t 900')).toBe('computed: FAIL — x');
  });
  it('/promote: draft → ready, committed and pushed (push failure ignored)', () => {
    expect(dispatch(ctx(), '/promote t 900')).toBe('900 is ready — the next drain will pick it up');
    expect(readFileSync(join(root, '.stories', '900.md'), 'utf8')).toContain('\nstatus: ready\n');
    expect(git('log', '-1', '--format=%s')).toBe('story(900): promoted to ready (telegram)');
    expect(dispatch(ctx(), '/promote t 900')).toBe('900 was already ready');
    expect(dispatch(ctx(), '/promote t 901')).toBe('no such story: 901');
  });
  it('/answer: appended to the blocked file, story back to ready, one commit', () => {
    expect(dispatch(ctx(), '/answer t 900 yes')).toBe('900 is not blocked — nothing is waiting for an answer');
    writeFileSync(join(root, '.blocked', '900.md'), '# Question\n\nwhich?\n');
    expect(dispatch(ctx(), '/answer t 900')).toBe('usage: /answer <repo> <id> <text>');
    expect(dispatch(ctx(), '/answer t 900 the  second one')).toBe('answered — 900 is ready again');
    expect(readFileSync(join(root, '.blocked', '900.md'), 'utf8')).toMatch(/\n## Answer \(telegram, 2026-09-25T10:06:08[+-]\d\d:\d\d\)\n\nthe  second one\n$/);
    expect(readFileSync(join(root, '.stories', '900.md'), 'utf8')).toContain('\nstatus: ready\n');
    expect(git('log', '-1', '--format=%s')).toBe('story(900): answered, back to ready (telegram)');
    expect(git('status', '--porcelain')).toBe('');
  });
  it('/revert reports what fleet revert said, colours stripped, then the verdict', () => {
    expect(dispatch(ctx(), '/revert t 900')).toBe('ran revert t 900!\n900 reverted');
    expect(dispatch(ctx(), '/revert t 901')).toBe('no such story: 901');
  });
  it('/merge: a story is --land, an epic is --epic, anything else is usage; the job is detached', () => {
    expect(dispatch(ctx(), '/merge t 900')).toMatch(/^merging 900 — deps, suite, build and lint run first/);
    expect(dispatch(ctx(), '/merge t epic/x')).toMatch(/^merging epic\/x — /);
    expect(detached).toEqual([['merge', 't', '900', '--land'], ['merge', 't', '--epic', 'epic/x']]);
    expect(dispatch(ctx(), '/merge t nope')).toMatch(/^usage: \/merge <repo> <id>/);
    expect(dispatch(ctx(), '/merge t')).toMatch(/^usage: \/merge/);
    expect(dispatch(ctx(), '/merge t 901')).toBe('no such story: 901');
    expect(detached).toHaveLength(2);
  });
  it('a reply never ends in newlines, as $(…) leaves it', () => {
    expect(dispatch(ctx(), '/help')).not.toMatch(/\n$/);
  });
});

// ── poll ─────────────────────────────────────────────────────────────────────

const upd = (id: number, from: number, text: string) => ({ update_id: id, message: { from: { id: from }, text } });

describe('poll', () => {
  it('not configured: a warning, no request', async () => {
    const c = ctx(); delete c.env['TELEGRAM_BOT_TOKEN'];
    await poll(c);
    expect(warned).toEqual(['not configured (.env.fleet) — nothing to poll']);
  });
  it('starts at 0, acknowledges the highest update before handling any, and asks from there next time', async () => {
    updatesBody = () => ({ ok: true, updates: [upd(500, 42, '/help'), upd(501, 42, '/repo')] });
    await poll(ctx());
    expect(readFileSync(join(fleetHome, '.bot-offset'), 'utf8')).toBe('502\n');
    expect(sent).toHaveLength(2);
    expect(logged).toEqual(['command: /help', 'command: /repo']);
  });
  it('a bad offset file is 0 again', async () => {
    writeFileSync(join(fleetHome, '.bot-offset'), 'junk\n');
    let asked: number | undefined;
    const c = ctx();
    c.deps.api.getUpdates = async (o) => { asked = o.offset; return { ok: true, updates: [] }; };
    await poll(c);
    expect(asked).toBe(0);
    writeFileSync(join(fleetHome, '.bot-offset'), '7\n');
    await poll(c);
    expect(asked).toBe(7);
  });
  it('a stranger is ignored without a reply, and recorded', async () => {
    updatesBody = () => ({ ok: true, updates: [upd(1, 999, '/promote t 900')] });
    await poll(ctx());
    expect(sent).toEqual([]);
    expect(warned).toEqual(['ignored a message from 999']);
    expect(readFileSync(join(root, '.stories', '900.md'), 'utf8')).toContain('status: draft');
  });
  it('an update without text is skipped; a failed or empty poll is a warning', async () => {
    updatesBody = () => ({ ok: true, updates: [{ update_id: 3 }] });
    await poll(ctx());
    expect(sent).toEqual([]);
    updatesBody = () => ({ ok: false, reason: 'failed' });
    await poll(ctx());
    updatesBody = () => ({ ok: false, reason: 'no-result' });
    await poll(ctx());
    expect(warned).toEqual(['getUpdates failed', 'getUpdates returned no result']);
    expect(readFileSync(join(fleetHome, '.bot-offset'), 'utf8')).toBe('4\n');
  });
  it('/status and /status-all replies go as a code block, others plain; an empty reply is (no output)', async () => {
    const c = ctx();
    c.deps.runFleet = () => ({ status: 0, output: '' });
    updatesBody = () => ({ ok: true, updates: [upd(1, 42, '/status t'), upd(2, 42, '/status-all t'), upd(3, 42, '/repo')] });
    await poll(c);
    expect(sent).toEqual([
      { text: '<pre>(no output)</pre>', parseMode: 'HTML' },
      { text: '<pre>(no output)</pre>', parseMode: 'HTML' },
      { text: `t  ${root}`, parseMode: undefined },
    ]);
  });
  it('a die inside a command is that command\'s reply; the poll goes on', async () => {
    const c = ctx();
    c.deps.runFleet = () => { throw new Error('boom'); };
    updatesBody = () => ({ ok: true, updates: [upd(1, 42, '/status t'), upd(2, 42, '/repo')] });
    await poll(c);
    expect(sent[0]!.text).toContain('boom');
    expect(sent[1]!.text).toBe(`t  ${root}`);
  });
});
