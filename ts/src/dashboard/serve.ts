// serve.ts — the dashboard's read-only HTTP server (`fleet dashboard serve`,
// systemd/fleet-dashboard.service): the page's files from dashboard/, and
// three JSON answers built from the bundle (bundle.ts) — the catalog, the
// fleet at a moment (moment.ts), and one story's life (life.ts).
//
// Read-only by construction: GET and HEAD only, a fixed list of routes, no
// path from a request ever reaches the disk, and nothing it calls writes.
// It listens on loopback; Caddy publishes it with a password
// (systemd/README.md). The bundle is built in a child process — a build reads
// git for every story and takes seconds — and rebuilt in the background once
// it is older than its TTL, while the old one is served; with nobody
// looking, nothing is built.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Bundle } from './bundle.ts';
import { storyLife } from './life.ts';
import { momentAt } from './moment.ts';

export const HOST_DEFAULT = '127.0.0.1';
export const PORT_DEFAULT = 4300;
/** How old a bundle may be before a request starts a new one. */
export const TTL_MS_DEFAULT = 60_000;
/** A build that takes longer than this is killed. */
export const BUILD_TIMEOUT_MS = 180_000;

/** The page's files, by the path the page asks for: nothing else is read
 *  from the disk. */
export const ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
};

const SECURITY: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export class BuildError extends Error {}

/** `fleet dashboard bundle` in a child: its stdout, parsed. */
export function bundleFromChild(argv: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = BUILD_TIMEOUT_MS): Promise<Bundle> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    if (cmd === undefined) { reject(new BuildError('no command')); return; }
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => { err = `${err}${b.toString()}`.slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new BuildError(e.message)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new BuildError(`the bundle build ${signal !== null ? `was killed (${signal})` : `exited ${code}`}${err !== '' ? `: ${err.trim()}` : ''}`)); return; }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString('utf8')) as Bundle);
      } catch (e) {
        reject(new BuildError(`the bundle is not JSON: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  });
}

export interface ServeOptions {
  /** The directory of the page's files (dashboard/). */
  pageDir: string;
  load: () => Promise<Bundle>;
  ttlMs?: number;
  now?: () => number;
  warn: (msg: string) => void;
}

export function dashboardServer(o: ServeOptions): Server {
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? TTL_MS_DEFAULT;
  // Read once, so the page and the server that answers it are one version;
  // a file that is not there is a 404.
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const [path, a] of Object.entries(ASSETS)) {
    try {
      files.set(path, { body: readFileSync(join(o.pageDir, a.file)), type: a.type });
    } catch {
      /* not there */
    }
  }
  let cache: { at: number; bundle: Bundle } | undefined;
  let inflight: Promise<Bundle> | undefined;
  let lastError: string | undefined;

  const refresh = (): Promise<Bundle> => {
    inflight ??= o.load().then(
      (bundle) => { cache = { at: now(), bundle }; lastError = undefined; return bundle; },
      (e: unknown) => { lastError = e instanceof Error ? e.message : String(e); o.warn(`dashboard: ${lastError}`); throw e; },
    ).finally(() => { inflight = undefined; });
    return inflight;
  };
  /** The bundle to answer from, and when it was read. */
  const bundle = async (): Promise<{ at: number; bundle: Bundle }> => {
    const held = cache;
    if (held === undefined) {
      const b = await refresh();
      return { at: cache?.at ?? now(), bundle: b };
    }
    if (now() - held.at > ttl && inflight === undefined) refresh().catch(() => { /* said by refresh; the old bundle stands */ });
    return held;
  };

  const send = (req: IncomingMessage, res: ServerResponse, status: number, type: string, body: Buffer | string, cache: string): void => {
    let data = typeof body === 'string' ? Buffer.from(body) : body;
    const headers: Record<string, string> = { ...SECURITY, 'Content-Type': type, 'Cache-Control': cache, Vary: 'Accept-Encoding' };
    if (data.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      data = gzipSync(data);
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = String(data.length);
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  };
  const json = (req: IncomingMessage, res: ServerResponse, status: number, value: unknown): void => send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(value), 'no-store');

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      json(req, res, 405, { error: 'read-only: GET and HEAD only' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://dashboard');
    const file = files.get(url.pathname);
    if (file !== undefined) { send(req, res, 200, file.type, file.body, 'no-cache'); return; }
    if (!url.pathname.startsWith('/api/')) { json(req, res, 404, { error: 'not found' }); return; }

    let b: Bundle;
    let age: number;
    try {
      const served = await bundle();
      b = served.bundle;
      age = Math.round((now() - served.at) / 1000);
    } catch {
      json(req, res, 503, { error: `the fleet could not be read: ${lastError ?? 'unknown'}` });
      return;
    }
    switch (url.pathname) {
      case '/api/health':
        json(req, res, 200, { ok: b.errors.length === 0, generatedAt: b.generatedAt, age_s: age, refreshing: inflight !== undefined, errors: b.errors, lastError: lastError ?? null });
        return;
      case '/api/catalog':
        json(req, res, 200, { generatedAt: b.generatedAt, repos: b.repos, errors: b.errors });
        return;
      case '/api/moment': {
        const at = url.searchParams.get('at') ?? undefined;
        if (at !== undefined && Number.isNaN(Date.parse(at))) { json(req, res, 400, { error: `not a time: ${at}` }); return; }
        json(req, res, 200, momentAt({ repos: b.repos, events: b.events, now: b.now, generatedAt: b.generatedAt, at }));
        return;
      }
      case '/api/story': {
        const repo = b.repos.find((r) => r.name === url.searchParams.get('repo'));
        const story = repo?.stories.find((s) => s.id === url.searchParams.get('id'));
        if (repo === undefined || story === undefined) { json(req, res, 404, { error: 'no such story' }); return; }
        const machine = b.machine[repo.name]?.[story.id] ?? {};
        json(req, res, 200, { generatedAt: b.generatedAt, repo: repo.name, story, life: storyLife({ story, events: b.events[repo.name] ?? [], machine, baseBranch: repo.baseBranch, alive: new Set(b.now.alive) }) });
        return;
      }
      default:
        json(req, res, 404, { error: 'not found' });
    }
  };

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      o.warn(`dashboard: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) json(req, res, 500, { error: 'the server failed; see its journal' });
      else res.end();
    });
  });
}

/** Loopback only: Caddy, on this machine, is what the outside reaches. */
export function loopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
