import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ALLOWED_TOOLS, NO_ATTRIBUTION, builderArgv, builderModelUsed, claudeRefusal, parseBuilderOutput, reviewerArgv, reviewerModelUsed, reviewerMessages, reviewerRefusal, runBuilder, runReviewer,
} from './agents.ts';

const FAKES = resolve(import.meta.dirname, '../../../test/fakes');

/** The suite's shadow_check (L-14): a fake that does not shadow the real
 *  binary is the real binary, so nothing is spawned unless `name` resolves
 *  to the fake on this env's PATH. */
function shadowed(env: NodeJS.ProcessEnv, name: string): NodeJS.ProcessEnv {
  const got = execFileSync('bash', ['-c', `command -v ${name} || true`], { env, encoding: 'utf8' }).trim();
  if (got !== join(FAKES, name)) throw new Error(`'${name}' resolves to '${got}', not the fake — refusing to run it`);
  return env;
}

describe('the argv the CLIs get', () => {
  it('builder: claude -p, the model, the turn ceiling, the tools, JSON out, attribution off (case 147)', () => {
    expect(builderArgv({ model: 'claude-sonnet-4-6', maxTurns: '60' })).toEqual([
      '-p', '--model', 'claude-sonnet-4-6', '--max-turns', '60', '--allowedTools', ALLOWED_TOOLS, '--output-format', 'json',
      '--settings', NO_ATTRIBUTION,
    ]);
    expect(ALLOWED_TOOLS).toBe('Read,Write,Edit,Grep,Glob,Bash');
    expect(JSON.parse(NO_ATTRIBUTION)).toEqual({ attribution: { commit: '', pr: '', sessionUrl: false } });
  });

  it('reviewer: codex exec --json, no sandbox, -m only when a model is named (cases 103, 103b)', () => {
    expect(reviewerArgv({ model: '' })).toEqual(['exec', '--json', '--sandbox', 'danger-full-access']);
    expect(reviewerArgv({ model: 'fleet-test-reviewer' })).toEqual(['exec', '--json', '--sandbox', 'danger-full-access', '-m', 'fleet-test-reviewer']);
  });
});

// The rows as jq 1.7 evaluates them (checked, 23 Sep):
//   isError    = jq -r 'if has("is_error") then (.is_error|tostring) else "parse-failed" end'  (stderr dropped)
//   message    = jq -r '.result // "no result field"'                                             (stderr dropped)
//   evidence   = jq . || the raw text
describe('parseBuilderOutput — the jq rows', () => {
  it.each([
    ['not json {', '', '', 'not json {', 'not JSON: jq fails, both empty, raw kept'],
    ['{"unexpected":"shape"}', 'parse-failed', 'no result field', '{\n  "unexpected": "shape"\n}', 'an object without the key'],
    ['null', 'parse-failed', 'no result field', 'null', 'null has no keys'],
    ['"s"', '', '', '"s"', 'a string: has() errors'],
    ['[1]', '', '', '[\n  1\n]', 'an array: has() errors, pretty evidence'],
    ['42', '', '', '42', 'a number'],
    ['true', '', '', 'true', 'a boolean'],
    ['{"is_error":false,"result":"ok"}', 'false', 'ok', '{\n  "is_error": false,\n  "result": "ok"\n}', 'the CLI object (L-03: false is false)'],
    ['{"is_error":true,"result":null}', 'true', 'no result field', '{\n  "is_error": true,\n  "result": null\n}', 'null result'],
    ['{"is_error":"x","result":false}', 'x', 'no result field', '{\n  "is_error": "x",\n  "result": false\n}', 'false result: // fires'],
    ['{"is_error":null,"result":""}', 'null', '', '{\n  "is_error": null,\n  "result": ""\n}', 'empty string stays'],
    ['{"is_error":{"a":1},"result":{"b":[1,2]}}', '{"a":1}', '{\n  "b": [\n    1,\n    2\n  ]\n}', '{\n  "is_error": {\n    "a": 1\n  },\n  "result": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}', 'tostring is compact, -r of an object is pretty'],
    [' {"is_error":false,"result":"ok"}\n', 'false', 'ok', '{\n  "is_error": false,\n  "result": "ok"\n}', 'surrounding whitespace'],
  ] as const)('%j → is_error %j, message %j (%s)', (out, isError, message, evidence, _why) => {
    expect(parseBuilderOutput(out)).toEqual({ isError, message, evidence });
  });

  it('the fake builder\'s line, as test/fakes/claude prints it', () => {
    expect(parseBuilderOutput('{"is_error":false,"result":"fake builder did: commit (call 1)"}\n')).toEqual({
      isError: 'false', message: 'fake builder did: commit (call 1)', evidence: '{\n  "is_error": false,\n  "result": "fake builder did: commit (call 1)"\n}',
    });
  });
});

// Per line: fromjson? | select(.type=="item.completed" and
// .item.type=="agent_message") | .item.text // empty — and what jq says on
// stderr for JSON that is not an object, kept (no 2>/dev/null).
describe('reviewerMessages — the codex stream', () => {
  const fake = [
    '{"type":"thread.started","thread_id":"fake"}',
    '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \\"npm test\\""}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \\"npm test\\"","exit_code":0}}',
    '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"fake review, call 1.\\nfinding: none.\\nVERDICT: PASS"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ].join('\n');

  it('keeps only the agent_message text', () => {
    expect(reviewerMessages(fake)).toEqual({ text: 'fake review, call 1.\nfinding: none.\nVERDICT: PASS', noise: [] });
  });

  it('joins several messages with a newline and skips lines that are not JSON, null, or without text', () => {
    const s = ['{"type":"item.completed","item":{"type":"agent_message","text":"A"}}', 'not json', 'null', '',
      '{"type":"item.completed","item":{"type":"agent_message"}}', '{"type":"item.completed","item":null}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"B\\nC"}}', ''].join('\n');
    expect(reviewerMessages(s)).toEqual({ text: 'A\nB\nC', noise: [] });
  });

  it('a stream with no message gives an empty text (the reviewer.raw.jsonl path)', () => {
    expect(reviewerMessages(fake.split('\n').filter((l) => !l.includes('agent_message')).join('\n')).text).toBe('');
  });

  it("records jq's stderr line for JSON that is not an object, numbered by input line", () => {
    const s = ['{"type":"thread.started"}', '42', '"str"', '[1]', 'true', '{"type":"item.completed","item":5}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"A"}}'].join('\n');
    expect(reviewerMessages(s)).toEqual({
      text: 'A',
      noise: [
        'jq: error (at <stdin>:2): Cannot index number with string "type"',
        'jq: error (at <stdin>:3): Cannot index string with string "type"',
        'jq: error (at <stdin>:4): Cannot index array with string "type"',
        'jq: error (at <stdin>:5): Cannot index boolean with string "type"',
        'jq: error (at <stdin>:6): Cannot index number with string "type"',
      ],
    });
  });
});

// 21 Sep, khaita 015 round 3: codex's whole stream when OpenAI refused the
// call, verbatim from .review/015/round-3/reviewer.raw.jsonl.
const LIMIT_MSG = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:17 PM.";
const REFUSED = [
  '{"type":"thread.started","thread_id":"01a0c3a2-5a0d-7a33-a3d4-55f3ec6edc49"}',
  '{"type":"turn.started"}',
  JSON.stringify({ type: 'error', message: LIMIT_MSG }),
  JSON.stringify({ type: 'turn.failed', error: { message: LIMIT_MSG } }),
].join('\n');
const line = (o: object): string => JSON.stringify(o);
const said = (text: string): string => line({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } });

describe('reviewerRefusal — the provider refused, so nobody reviewed', () => {
  it('the 21 Sep stream: the error event\'s message', () => {
    expect(reviewerRefusal(REFUSED)).toBe(LIMIT_MSG);
  });
  it('a turn.failed alone: its error.message', () => {
    expect(reviewerRefusal([line({ type: 'turn.started' }), line({ type: 'turn.failed', error: { message: 'Quota exceeded.' } })].join('\n'))).toBe('Quota exceeded.');
  });
  it('an error the turn got past is not a refusal', () => {
    expect(reviewerRefusal([line({ type: 'error', message: 'reconnecting 1/5' }), said('VERDICT: PASS'), line({ type: 'turn.completed' })].join('\n'))).toBeUndefined();
  });
  it('refused mid-turn, after something was said, is still a refusal', () => {
    expect(reviewerRefusal([said('looking at the diff'), line({ type: 'error', message: 'usage limit' }), line({ type: 'turn.failed', error: { message: 'usage limit' } })].join('\n'))).toBe('usage limit');
  });
  it('a turn that completed with nothing said is not a refusal — that is UNPARSEABLE (case 112)', () => {
    expect(reviewerRefusal([line({ type: 'thread.started' }), line({ type: 'turn.completed' })].join('\n'))).toBeUndefined();
  });
  it('empty, or not JSON: not a refusal', () => {
    expect(reviewerRefusal('')).toBeUndefined();
    expect(reviewerRefusal('Reading prompt from stdin...\nnot json')).toBeUndefined();
  });
  it('the message comes back on one line, with no " — " to split the Machine block\'s reasons on', () => {
    expect(reviewerRefusal(line({ type: 'error', message: 'over\n\nthe limit — try later' }))).toBe('over the limit - try later');
  });
  it('a failure that says nothing still refuses', () => {
    expect(reviewerRefusal(line({ type: 'turn.failed' }))).toBe('the provider refused the call and gave no reason');
  });
});

// The two calls end to end, against the suite's own fakes on PATH: the
// prompt arrives on stdin, the argv is recorded, cwd is the worktree.
describe('runBuilder / runReviewer with test/fakes/claude and test/fakes/codex', () => {
  it('builder: prompt on stdin, argv recorded, the JSON object back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-agents-'));
    const trace = join(dir, 'trace'); const wt = join(dir, 'wt');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(trace); mkdirSync(wt);
    const env = shadowed({ ...process.env, PATH: `${FAKES}:${process.env['PATH'] ?? ''}`, FAKE_TRACE_DIR: trace, FAKE_BUILDER: 'nocommit' }, 'claude');
    try {
      // No trailing newline: a rendered prompt never has one ($(…) strips it),
      // and the fake's own `$(cat)` would drop it anyway.
      const prompt = 'build it\n'.repeat(20_000) + 'end';
      const r = await runBuilder({ wt, prompt, model: 'fleet-test-model', maxTurns: '7', timeoutSec: 30, env });
      expect(r.timedOut).toBe(false);
      expect(parseBuilderOutput(r.output).message).toBe('fake builder did: nocommit (call 1)');
      expect(readFileSync(join(trace, 'claude-prompt-1'), 'utf8')).toBe(prompt);
      expect(readFileSync(join(trace, 'claude-args-1'), 'utf8').split('\n')).toContain('fleet-test-model');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reviewer: stderr to the file, the JSONL on stdout, -m when named', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-agents-'));
    const trace = join(dir, 'trace'); const wt = join(dir, 'wt');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(trace); mkdirSync(wt);
    writeFileSync(join(wt, 'unused'), '');
    const env = shadowed({ ...process.env, PATH: `${FAKES}:${process.env['PATH'] ?? ''}`, FAKE_TRACE_DIR: trace, FAKE_REVIEWER: 'PASS', FAKE_MUTATIONS: 'none' }, 'codex');
    try {
      const stderrFile = join(dir, 'reviewer.stderr');
      const r = await runReviewer({ wt, prompt: 'review it', model: 'fleet-test-reviewer', timeoutSec: 30, stderrFile, env });
      expect(r.timedOut).toBe(false);
      expect(reviewerMessages(r.stdout).text).toMatch(/VERDICT: PASS$/);
      expect(readFileSync(stderrFile, 'utf8')).toBe('Reading prompt from stdin...\n');
      expect(readFileSync(join(trace, 'codex-prompt-1'), 'utf8')).toBe('review it');
      expect(readFileSync(join(trace, 'codex-args-1'), 'utf8')).toBe('exec\n--json\n--sandbox\ndanger-full-access\n-m\nfleet-test-reviewer\n');
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Claude's own refusal: `claude -p --output-format json` ends in one object
// whose is_error is true and whose api_error_status is the API's HTTP
// status. No real one has been seen on this machine (25 Sep); the shape is
// the CLI's own schema, and the texts are the ones it carries.
describe('claudeRefusal — Claude refused the call (a usage limit)', () => {
  const obj = (o: object): string => JSON.stringify({ type: 'result', subtype: 'success', ...o });
  it('HTTP 429: the result text', () => {
    expect(claudeRefusal(obj({ is_error: true, api_error_status: 429, result: "You've hit your limit · resets 3pm (Europe/Rome)" }))).toBe("You've hit your limit · resets 3pm (Europe/Rome)");
  });
  it('a limit named in the text, whatever the status', () => {
    expect(claudeRefusal(obj({ is_error: true, api_error_status: null, result: 'Claude AI usage limit reached|1790000000' }))).toBe('Claude AI usage limit reached|1790000000');
    expect(claudeRefusal(obj({ is_error: true, result: "You've reached your Fable limit." }))).toBe("You've reached your Fable limit.");
  });
  it('429 with no text still refuses', () => {
    expect(claudeRefusal(obj({ is_error: true, api_error_status: 429 }))).toBe('Claude refused the call (HTTP 429)');
  });
  it('other errors are not refusals: out of turns, a crash, success', () => {
    expect(claudeRefusal(obj({ subtype: 'error_max_turns', is_error: true, result: 'stopped at max turns' }))).toBeUndefined();
    expect(claudeRefusal(obj({ is_error: true, api_error_status: 500, result: 'Internal server error' }))).toBeUndefined();
    expect(claudeRefusal(obj({ is_error: false, result: 'done; the usage limit reached is a feature name' }))).toBeUndefined();
  });
  it('not JSON, or not an object: not a refusal', () => {
    expect(claudeRefusal('not json {')).toBeUndefined();
    expect(claudeRefusal('[1]')).toBeUndefined();
  });
});

describe('runReviewer keeps the exit status, for the record', () => {
  it('a refused codex: the 21 Sep stream, and the status it exited with', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-agents-'));
    const trace = join(dir, 'trace'); const wt = join(dir, 'wt');
    mkdirSync(trace); mkdirSync(wt);
    const env = shadowed({ ...process.env, PATH: `${FAKES}:${process.env['PATH'] ?? ''}`, FAKE_TRACE_DIR: trace, FAKE_REVIEWER: 'limit', FAKE_REVIEWER_EXIT: '3', CODEX_HOME: join(dir, 'codex') }, 'codex');
    try {
      const r = await runReviewer({ wt, prompt: 'review it', model: '', timeoutSec: 30, stderrFile: join(dir, 'reviewer.stderr'), env });
      expect(r.status).toBe(3);
      expect(r.stdout.trimEnd()).toBe(REFUSED);
      expect(reviewerRefusal(r.stdout)).toBe(LIMIT_MSG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the model each agent actually ran (24 Sep: the fleet names aliases)', () => {
  it('builder: the modelUsage entry that cost the most', () => {
    const out = JSON.stringify({ is_error: false, result: 'x', modelUsage: {
      'claude-haiku-4-5-20251001': { costUSD: 0.01, outputTokens: 50 }, 'claude-sonnet-5': { costUSD: 1.2, outputTokens: 9000 } } });
    expect(builderModelUsed(out)).toBe('claude-sonnet-5');
  });
  it('builder: no modelUsage, not an object, not JSON → empty', () => {
    expect(builderModelUsed('{"is_error":false,"result":"x"}')).toBe('');
    expect(builderModelUsed('[1]')).toBe('');
    expect(builderModelUsed('not json {')).toBe('');
    expect(builderModelUsed(JSON.stringify({ modelUsage: {} }))).toBe('');
  });
  it('reviewer: the newest codex session in the reviewer worktree since the run began', () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    try {
      const day = join(home, 'sessions', '2026', '09', '24');
      mkdirSync(day, { recursive: true });
      const session = (name: string, cwd: string, model: string, mtimeSec: number): void => {
        const f = join(day, name);
        writeFileSync(f, [
          JSON.stringify({ type: 'session_meta', payload: { cwd, base_instructions: { text: '"model":"not-this"' } } }),
          JSON.stringify({ type: 'turn_context', payload: { cwd, model } }),
        ].join('\n') + '\n');
        utimesSync(f, mtimeSec, mtimeSec);
      };
      session('rollout-a.jsonl', '/wt/020-review', 'gpt-old', 1000);   // before the run
      session('rollout-b.jsonl', '/wt/other', 'gpt-other', 3000);       // another worktree
      session('rollout-c.jsonl', '/wt/020-review', 'gpt-6-astra', 2500);
      expect(reviewerModelUsed({ codexHome: home, cwd: '/wt/020-review', sinceMs: 2000 * 1000 })).toBe('gpt-6-astra');
      expect(reviewerModelUsed({ codexHome: home, cwd: '/wt/none', sinceMs: 0 })).toBe('');
      expect(reviewerModelUsed({ codexHome: join(home, 'absent'), cwd: '/wt/020-review', sinceMs: 0 })).toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
