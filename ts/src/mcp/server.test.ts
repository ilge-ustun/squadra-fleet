import { describe, expect, it } from 'vitest';
import { PROTOCOL_DEFAULT, TEXT_MAX, ToolError, checkArgs, handleLine, type Server, type Tool } from './server.ts';

const echo: Tool = {
  name: 'echo',
  title: 'Echo',
  description: 'says the word back',
  inputSchema: {
    type: 'object',
    properties: {
      word: { type: 'string', description: 'the word' },
      times: { type: 'integer', description: 'how often', minimum: 1, maximum: 3 },
      loud: { type: 'boolean', description: 'in capitals' },
    },
    required: ['word'],
    additionalProperties: false,
  },
  call: (a) => {
    if (a['word'] === 'missing') throw new ToolError('no such word');
    if (a['word'] === 'bug') throw new Error('a bug');
    if (a['word'] === 'long') return 'x'.repeat(TEXT_MAX + 10);
    const w = a['loud'] === true ? String(a['word']).toUpperCase() : String(a['word']);
    return Array.from({ length: Number(a['times'] ?? 1) }, () => w).join(' ');
  },
};
const S: Server = { info: { name: 'test', title: 'Test', version: '1', instructions: 'read only' }, tools: [echo] };

/** One request in, its answer out, parsed. */
const ask = (msg: unknown): Record<string, unknown> => {
  const out = handleLine(JSON.stringify(msg), S);
  if (out === undefined) throw new Error('no answer');
  expect(out).not.toContain('\n');
  return JSON.parse(out) as Record<string, unknown>;
};
const call = (args: unknown, name = 'echo'): Record<string, unknown> => ask({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
const result = (r: Record<string, unknown>): { content: { type: string; text: string }[]; isError?: boolean } => r['result'] as never;

describe('initialize', () => {
  it('answers the version the client asked for when it knows it, with tools only and the instructions', () => {
    const r = ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '0' } } });
    expect(r).toEqual({
      jsonrpc: '2.0', id: 1,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'test', title: 'Test', version: '1' }, instructions: 'read only' },
    });
  });
  it('answers its own version for one it does not know', () => {
    const r = ask({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect((r['result'] as { protocolVersion: string }).protocolVersion).toBe(PROTOCOL_DEFAULT);
    expect(r['id']).toBe('a');
  });
});

describe('the other methods', () => {
  it('answers a ping with an empty result', () => {
    expect(ask({ jsonrpc: '2.0', id: 2, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });
  it('lists each tool with its schema, every one marked read-only', () => {
    const r = ask({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const tools = (r['result'] as { tools: Record<string, unknown>[] }).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      name: 'echo', title: 'Echo', description: 'says the word back', inputSchema: echo.inputSchema,
      annotations: { title: 'Echo', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
  });
  it('answers no notification, whatever its method', () => {
    expect(handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}', S)).toBeUndefined();
    expect(handleLine('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":3}}', S)).toBeUndefined();
  });
  it('answers a response from the client with nothing: this server asks nothing', () => {
    expect(handleLine('{"jsonrpc":"2.0","id":9,"result":{}}', S)).toBeUndefined();
  });
  it('refuses a method it does not have', () => {
    expect(ask({ jsonrpc: '2.0', id: 4, method: 'resources/list' })['error']).toEqual({ code: -32601, message: 'Method not found: resources/list' });
  });
  it('refuses a line that is not JSON, a batch, and a message that is not JSON-RPC 2.0', () => {
    expect(JSON.parse(handleLine('{oops', S) ?? '')).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
    expect(JSON.parse(handleLine('[{"jsonrpc":"2.0","id":1,"method":"ping"}]', S) ?? '')).toMatchObject({ id: null, error: { code: -32600 } });
    expect(ask({ id: 5, method: 'ping' })).toMatchObject({ id: 5, error: { code: -32600 } });
  });
});

describe('tools/call', () => {
  it('runs the tool and answers its text', () => {
    expect(result(call({ word: 'hi', times: 2 }))).toEqual({ content: [{ type: 'text', text: 'hi hi' }] });
  });
  it('answers a ToolError as a tool error, so the agent reads why', () => {
    expect(result(call({ word: 'missing' }))).toEqual({ content: [{ type: 'text', text: 'no such word' }], isError: true });
  });
  it('answers a bug as a tool error too, named as one, its stack to the log only', () => {
    const r = result(call({ word: 'bug' }));
    expect(r).toEqual({ content: [{ type: 'text', text: 'echo failed: a bug' }], isError: true });
    const logged: string[] = [];
    handleLine(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'echo', arguments: { word: 'bug' } } }), { ...S, warn: (m) => logged.push(m) });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^echo: Error: a bug\n +at /);
  });
  it('refuses a tool it does not have as a protocol error', () => {
    expect(call({}, 'rm')['error']).toEqual({ code: -32602, message: 'Unknown tool: rm' });
  });
  it('refuses arguments its schema does not allow, before the tool runs', () => {
    expect(result(call({})).content[0]?.text).toBe("'word' is required");
    expect(result(call({ word: 3 })).content[0]?.text).toBe("'word' must be a string");
    expect(result(call({ word: 'a', times: 1.5 })).content[0]?.text).toBe("'times' must be an integer");
    expect(result(call({ word: 'a', times: 9 })).content[0]?.text).toBe("'times' must be 3 at most");
    expect(result(call({ word: 'a', path: '/etc' })).content[0]?.text).toBe("'path' is not an argument of echo; it takes word, times, loud");
    expect(result(call('word')).isError).toBe(true);
  });
  it('cuts a long answer and says how to ask for less', () => {
    const text = result(call({ word: 'long' })).content[0]?.text ?? '';
    expect(text.length).toBeLessThan(TEXT_MAX + 200);
    expect(text).toMatch(/cut at 40000 characters of 40010/);
  });
});

describe('checkArgs', () => {
  it('takes no arguments at all as none', () => {
    expect(checkArgs({ type: 'object', properties: {}, additionalProperties: false }, undefined, 't')).toEqual({});
  });
  it('checks an enum', () => {
    const s = { type: 'object' as const, properties: { k: { type: 'string' as const, description: '', enum: ['a', 'b'] } }, additionalProperties: false as const };
    expect(() => checkArgs(s, { k: 'c' }, 't')).toThrow("'k' must be one of a, b");
  });
});
