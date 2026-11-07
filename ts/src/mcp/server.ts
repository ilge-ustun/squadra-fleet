// server.ts — the part of the Model Context Protocol this server needs, with
// no SDK: JSON-RPC 2.0, one message a line (the stdio transport,
// bin/mcp.ts), and four methods.
//
//   initialize   the client names a protocol version; the answer is that
//                version when it is known here, else PROTOCOL_DEFAULT, with
//                the capabilities (tools only) and the instructions
//   ping         {}
//   tools/list   every tool: its name, a description for the model, a JSON
//                Schema for its arguments, and the read-only annotations
//   tools/call   the arguments checked against that schema, then the tool;
//                its text is the answer
//
// A notification (no id) and a response from the client get no answer.
//
// Two kinds of failure. A protocol error (a line that is not JSON, a method
// or a tool this server does not have) is a JSON-RPC error: the client's
// problem. A tool error (an argument the schema refuses, a repo or a story
// that is not there) is a result with isError: the model reads why and
// can ask again.
//
// Pure: a line in, a line out. Nothing here reads stdin, writes stdout or
// touches the disk.

/** The versions this server speaks. The newest one it is sure of answers a
 *  client that asks for one it does not know. */
export const PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const PROTOCOL_DEFAULT = '2025-06-18';

/** An answer longer than this is cut: an agent's context is not a log.
 *  Claude Code warns from about 10,000 tokens; this is near that. */
export const TEXT_MAX = 40_000;

export type Prop =
  | { type: 'string'; description: string; enum?: readonly string[] }
  | { type: 'integer'; description: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description: string };

/** The JSON Schema of a tool's arguments, as tools/list sends it. */
export interface InputSchema {
  type: 'object';
  properties: Readonly<Record<string, Prop>>;
  required?: readonly string[];
  additionalProperties: false;
}

export type Args = Readonly<Record<string, string | number | boolean>>;

export interface Tool {
  name: string;
  title: string;
  /** What the model reads to decide when to call the tool. */
  description: string;
  inputSchema: InputSchema;
  /** The arguments, already checked against inputSchema. Throws ToolError. */
  call: (args: Args) => string;
}

/** A failure the model should read: a bad argument, a thing not there. */
export class ToolError extends Error {}

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
  /** Sent once, at initialize: what the client should know of every tool. */
  instructions: string;
}

export interface Server {
  info: ServerInfo;
  tools: readonly Tool[];
  /** Where a tool's bug goes with its stack: stderr, the client's log. The
   *  model gets the message only. */
  warn?: (msg: string) => void;
}

type Id = string | number | null;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The arguments as the schema allows them. Throws ToolError. */
export function checkArgs(schema: InputSchema, args: unknown, tool: string): Args {
  if (args === undefined) args = {};
  if (!isObject(args)) throw new ToolError(`the arguments of ${tool} are an object`);
  const names = Object.keys(schema.properties);
  for (const k of Object.keys(args)) {
    if (!names.includes(k)) throw new ToolError(`'${k}' is not an argument of ${tool}; it takes ${names.length > 0 ? names.join(', ') : 'none'}`);
  }
  for (const k of schema.required ?? []) {
    if (args[k] === undefined) throw new ToolError(`'${k}' is required`);
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [k, p] of Object.entries(schema.properties)) {
    const v = args[k];
    if (v === undefined) continue;
    if (p.type === 'string') {
      if (typeof v !== 'string') throw new ToolError(`'${k}' must be a string`);
      if (p.enum !== undefined && !p.enum.includes(v)) throw new ToolError(`'${k}' must be one of ${p.enum.join(', ')}`);
    } else if (p.type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new ToolError(`'${k}' must be an integer`);
      if (p.minimum !== undefined && v < p.minimum) throw new ToolError(`'${k}' must be ${p.minimum} at least`);
      if (p.maximum !== undefined && v > p.maximum) throw new ToolError(`'${k}' must be ${p.maximum} at most`);
    } else if (typeof v !== 'boolean') throw new ToolError(`'${k}' must be true or false`);
    out[k] = v as string | number | boolean;
  }
  return out;
}

function cut(text: string): string {
  if (text.length <= TEXT_MAX) return text;
  return `${text.slice(0, TEXT_MAX)}\n… cut at ${TEXT_MAX} characters of ${text.length}: ask for less (one story, one round, a smaller limit)`;
}

function callTool(s: Server, params: Record<string, unknown>): Record<string, unknown> | { error: { code: number; message: string } } {
  const name = params['name'];
  const tool = s.tools.find((t) => t.name === name);
  if (tool === undefined) return { error: { code: INVALID_PARAMS, message: `Unknown tool: ${String(name)}` } };
  const text = (t: string, isError: boolean): Record<string, unknown> => ({ content: [{ type: 'text', text: cut(t) }], ...(isError ? { isError: true } : {}) });
  try {
    return text(tool.call(checkArgs(tool.inputSchema, params['arguments'], tool.name)), false);
  } catch (e) {
    if (e instanceof ToolError) return text(e.message, true);
    s.warn?.(`${tool.name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return text(`${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

/** One message: its result, its error, or nothing for a notification. */
function answer(s: Server, msg: Record<string, unknown>): { result: unknown } | { error: { code: number; message: string } } {
  const params = isObject(msg['params']) ? msg['params'] : {};
  switch (msg['method']) {
    case 'initialize': {
      const asked = params['protocolVersion'];
      return {
        result: {
          protocolVersion: typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_DEFAULT,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: s.info.name, title: s.info.title, version: s.info.version },
          instructions: s.info.instructions,
        },
      };
    }
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return {
        result: {
          tools: s.tools.map((t) => ({
            name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
            annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          })),
        },
      };
    case 'tools/call': {
      const r = callTool(s, params);
      return 'error' in r ? r as { error: { code: number; message: string } } : { result: r };
    }
    default:
      return { error: { code: METHOD_NOT_FOUND, message: `Method not found: ${String(msg['method'])}` } };
  }
}

const reply = (id: Id, body: { result: unknown } | { error: { code: number; message: string } }): string => JSON.stringify({ jsonrpc: '2.0', id, ...body });

/** One line from the client; the line to send back, or undefined. */
export function handleLine(line: string, s: Server): string | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return reply(null, { error: { code: PARSE_ERROR, message: `Parse error: ${e instanceof Error ? e.message : String(e)}` } });
  }
  if (Array.isArray(msg)) return reply(null, { error: { code: INVALID_REQUEST, message: 'Invalid Request: batches are not supported' } });
  if (!isObject(msg)) return reply(null, { error: { code: INVALID_REQUEST, message: 'Invalid Request: not an object' } });
  const id = msg['id'];
  const hasId = typeof id === 'string' || typeof id === 'number';
  if (msg['jsonrpc'] !== '2.0' || (msg['method'] === undefined && !hasId)) {
    return reply(hasId ? id : null, { error: { code: INVALID_REQUEST, message: 'Invalid Request: not JSON-RPC 2.0' } });
  }
  // A response to a request: this server sends none, so there is nothing to match.
  if (typeof msg['method'] !== 'string') return undefined;
  // A notification: initialized, cancelled. Nothing to answer.
  if (!hasId) return undefined;
  return reply(id, answer(s, msg));
}
