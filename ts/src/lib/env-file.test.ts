import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEnvFile } from './env-file.ts';

// `set -a; . "$FLEET_HOME/.env.fleet"; set +a`: the file is sourced bash, so
// a value may be quoted or expand; only bash can read it.
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-env-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const env = (): NodeJS.ProcessEnv => ({ PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' });

describe('readEnvFile', () => {
  it('reads the named keys as bash would source them', () => {
    const f = join(dir, '.env.fleet');
    writeFileSync(f, 'TELEGRAM_BOT_TOKEN="123456:AA b"\nTELEGRAM_CHAT_ID=987\nOTHER=x\n');
    const m = readEnvFile(f, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], env());
    expect([...m]).toEqual([['TELEGRAM_BOT_TOKEN', '123456:AA b'], ['TELEGRAM_CHAT_ID', '987']]);
  });

  it('leaves out a key the file does not set', () => {
    const f = join(dir, '.env.fleet');
    writeFileSync(f, 'TELEGRAM_CHAT_ID=987\n');
    expect([...readEnvFile(f, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], env())]).toEqual([['TELEGRAM_CHAT_ID', '987']]);
  });

  it('a file that cannot be sourced is an Error, with bash\'s reason', () => {
    const f = join(dir, '.env.fleet');
    writeFileSync(f, 'TELEGRAM_CHAT_ID=987\nif\n');
    expect(() => readEnvFile(f, ['TELEGRAM_CHAT_ID'], env())).toThrow(/syntax error|unexpected/);
  });

  it('a missing file is an Error', () => {
    expect(() => readEnvFile(join(dir, 'nope'), ['X'], env())).toThrow();
  });
});
