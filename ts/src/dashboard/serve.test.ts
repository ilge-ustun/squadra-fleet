import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bundle } from './bundle.ts';
import type { CatalogStory } from './catalog.ts';
import type { Machine } from './machine.ts';
import { ASSETS, bundleFromChild, dashboardServer, loopback } from './serve.ts';

const story: CatalogStory = {
  id: '135', title: 'Title row', status: 'done', landing: 'landed', verdict: 'PASS', reasons: [], base: 'develop', epic: null, round: 1, model: null,
  live: false, blocked: false, acs: [], symptom: 'x'.repeat(2000), question: null, intent: null, history: [{ ts: '2026-10-22T10:00:00.000+02:00', kind: 'draft', msg: 'draft', src: 'git' }],
  rounds: [], readyAt: null, pickedAt: null, queueWaitS: null, draftAt: null, doneAt: null, mergedAt: null, landedAt: null, landedHow: null,
};
const BUNDLE: Bundle = {
  v: 1, generatedAt: '2026-10-22T12:00:00.000+02:00', repos: [{ name: 'khaita', baseBranch: 'develop', stories: [story], epics: [] }],
  events: { khaita: [], qr: [
    { v: 1, ts: '2026-10-22T11:00:00.000+02:00', run_id: 'qr.020.L', span: 'r1.build', repo: 'qr', story: '020', round: 1, pass: 'builder', event: 'start', source: 'log' },
    { v: 1, ts: '2026-10-22T11:10:00.000+02:00', run_id: 'qr.020.L', span: 'r1.build', repo: 'qr', story: '020', round: 1, pass: 'builder', event: 'end', result: 'OK', dur_s: 600, source: 'log' },
    { v: 1, ts: '2026-10-22T11:10:30.000+02:00', run_id: 'qr.020.L', span: 'r1.mut.AC1-x', repo: 'qr', story: '020', round: 1, name: 'AC1-x', pass: 'mutation', event: 'end', result: 'RED', source: 'log' },
    { v: 1, ts: '2026-10-22T11:11:00.000+02:00', run_id: 'qr.020.L', repo: 'qr', story: '020', round: 1, pass: 'verdict', event: 'mark', result: 'PASS', source: 'log' },
  ] }, machine: { khaita: { 135: { 1: 'baseline: test GREEN' } } }, now: { units: {}, locks: {}, testDeploy: null, alive: [] }, errors: [],
};
const MACHINE: Machine = { at: '2026-10-22T12:00:00.000+02:00', cpus: 4, load: [0.5, 0.4, 0.3], memory: { total: 8e9, available: 5e9 }, swap: null, disk: null, units: [] };

let dir: string;
let server: Server | undefined;
let base: string;
let loads: number;
let clock: number;
let fail: boolean;
let machines: number;
const warnings: string[] = [];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-serve-'));
  for (const a of Object.values(ASSETS)) writeFileSync(join(dir, a.file), `/* ${a.file} */`);
  loads = 0;
  clock = 0;
  fail = false;
  machines = 0;
  server = dashboardServer({
    pageDir: dir, ttlMs: 60_000, now: () => clock, warn: (m) => warnings.push(m),
    load: async () => { loads += 1; if (fail) throw new Error('git failed'); return BUNDLE; },
    machine: () => { machines += 1; return MACHINE; },
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => (server === undefined ? r() : server.close(() => r())));
  rmSync(dir, { recursive: true, force: true });
});

describe('dashboardServer', () => {
  it('serves the page\'s files with a strict policy, and nothing else from the disk', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('/* index.html */');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    for (const p of ['/index.html', '/../package.json', '/%2e%2e/package.json', '/dashboard/app.js', '/.env.fleet']) expect((await fetch(`${base}${p}`)).status).toBe(404);
  });

  it('is read-only: any method but GET and HEAD is refused', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(`${base}/api/catalog`, { method });
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('GET, HEAD');
    }
    expect(loads).toBe(0);
  });

  it('answers the catalog, a moment and a story from one bundle', async () => {
    const c = await (await fetch(`${base}/api/catalog`)).json() as Record<string, unknown>;
    expect(Object.keys(c)).toEqual(['generatedAt', 'repos', 'errors']);
    const m = await (await fetch(`${base}/api/moment?at=2026-10-22T10:30:00%2B02:00`)).json() as { now: boolean; repos: Record<string, { states: unknown }> };
    expect(m.now).toBe(false);
    expect(m.repos['khaita']?.states).toEqual({ 135: { state: 'draft', since: '2026-10-22T10:00:00.000+02:00' } });
    expect((await fetch(`${base}/api/moment?at=yesterday`)).status).toBe(400);
    const s = await (await fetch(`${base}/api/story?repo=khaita&id=135`)).json() as { story: { id: string }; life: { entries: unknown[] } };
    expect(s.story.id).toBe('135');
    expect(Array.isArray(s.life.entries)).toBe(true);
    expect((await fetch(`${base}/api/story?repo=khaita&id=999`)).status).toBe(404);
    expect((await fetch(`${base}/api/story?repo=../etc&id=135`)).status).toBe(404);
    expect(loads).toBe(1);
  });

  it('answers the latest events of every repo from the bundle, newest first, cut at a moment', async () => {
    type F = { at: string | null; items: { repo: string; pass: string; state: string }[]; more: boolean };
    const brief = (f: F): string[] => f.items.map((x) => `${x.repo} ${x.pass} ${x.state}`);
    const f = await (await fetch(`${base}/api/feed`)).json() as F;
    expect(f.at).toBeNull();
    expect(brief(f)).toEqual(['qr verdict mark', 'qr builder ended']);
    expect(brief(await (await fetch(`${base}/api/feed?steps=1`)).json() as F)).toEqual(['qr verdict mark', 'qr mutation ended', 'qr builder ended']);
    const then = await (await fetch(`${base}/api/feed?at=2026-10-22T11:05:00%2B02:00`)).json() as F;
    expect(then.at).toBe('2026-10-22T11:05:00+02:00');
    expect(brief(then)).toEqual(['qr builder running']);
    const one = await (await fetch(`${base}/api/feed?limit=1`)).json() as F;
    expect([brief(one), one.more]).toEqual([['qr verdict mark'], true]);
    expect((await fetch(`${base}/api/feed?at=yesterday`)).status).toBe(400);
    expect((await fetch(`${base}/api/feed?limit=all`)).status).toBe(400);
    expect(loads).toBe(1);
  });

  it('answers the machine as it is now, read on each request, without the bundle', async () => {
    const r = await fetch(`${base}/api/machine`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual(MACHINE);
    await fetch(`${base}/api/machine`);
    expect(machines).toBe(2);
    expect(loads).toBe(0);
    fail = true;
    expect((await fetch(`${base}/api/machine`)).status).toBe(200);
  });

  it('compresses a large answer for a client that accepts gzip', async () => {
    const r = await fetch(`${base}/api/catalog`, { headers: { 'accept-encoding': 'gzip' } });
    expect(r.headers.get('content-encoding')).toBe('gzip');
    expect(((await r.json()) as { repos: unknown[] }).repos).toHaveLength(1);
    const raw = await fetch(`${base}/api/catalog`, { headers: { 'accept-encoding': 'identity' } });
    expect(raw.headers.get('content-encoding')).toBeNull();
  });

  it('serves the old bundle while a new one is built, once it is older than its TTL', async () => {
    await fetch(`${base}/api/health`);
    clock = 61_000;
    const h = await (await fetch(`${base}/api/health`)).json() as { age_s: number };
    expect(h.age_s).toBe(61);
    await new Promise((r) => setTimeout(r, 10));
    expect(loads).toBe(2);
  });

  it('a build that fails is a 503 that says why, and a later one recovers', async () => {
    fail = true;
    const r = await fetch(`${base}/api/catalog`);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'the fleet could not be read: git failed' });
    expect(warnings.at(-1)).toBe('dashboard: git failed');
    fail = false;
    expect((await fetch(`${base}/api/catalog`)).status).toBe(200);
  });
});

describe('loopback and bundleFromChild', () => {
  it('only a loopback address may be served on', () => {
    expect(['127.0.0.1', '::1', 'localhost'].every(loopback)).toBe(true);
    expect(['0.0.0.0', '::', '179.237.101.204'].some(loopback)).toBe(false);
  });

  it('parses the child\'s stdout, and says how a child failed', async () => {
    await expect(bundleFromChild([process.execPath, '-e', 'process.stdout.write(JSON.stringify({v:1}))'], process.env)).resolves.toEqual({ v: 1 });
    await expect(bundleFromChild([process.execPath, '-e', 'console.error("no repo"); process.exit(1)'], process.env)).rejects.toThrow('the bundle build exited 1: no repo');
    await expect(bundleFromChild([process.execPath, '-e', 'setTimeout(() => {}, 5000)'], process.env, 100)).rejects.toThrow('was killed (SIGKILL)');
  });
});
