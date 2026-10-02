import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSync } from './proc.ts';
import { ConfigError, loadRepo } from './config.ts';

// The real lib.sh: the loader runs load_repo, it does not imitate it.
const FLEET_HOME = resolve(import.meta.dirname, '../../..');

// L-27: the loader hands the whole environment on, so a BASE_BRANCH exported
// in the shell running vitest would win over the file. The tests pass an
// allowlist, as test/suite.sh:57-63 does, plus the override under test.
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { FLEET_REGISTRY_DIR: registry, ...extra };
  for (const k of ['PATH', 'HOME', 'LANG']) if (process.env[k] !== undefined) e[k] = process.env[k];
  return e;
}

const CONFIG = [
  'BASE_BRANCH=base',
  "INSTALL_CMD='true'",
  "VITEST_CMD='fake vitest'",
  'BUILD_CMD=true',
  'LINT_CMD=true',
  "SEED_FILES='.env.local extra.env'",
  'PROBE_DIR=src',
  '',
].join('\n');

let dir: string;
let registry: string;
let target: string;

function writeConfig(text: string): void {
  writeFileSync(join(target, '.fleet/config'), text);
}

function load(name = 't', env: Record<string, string> = {}): ReturnType<typeof loadRepo> {
  return loadRepo(FLEET_HOME, name, { env: cleanEnv(env), captureStderr: true });
}

function failure(name = 't', env: Record<string, string> = {}): ConfigError {
  try {
    load(name, env);
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('loadRepo did not throw');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-config-'));
  registry = join(dir, 'repos');
  target = join(dir, 'a', 'target');
  mkdirSync(registry);
  mkdirSync(join(target, '.fleet'), { recursive: true });
  const r = runSync('git', ['init', '-q', target]);
  if (r.status !== 0) throw new Error(r.stderr);
  writeFileSync(join(registry, 't.env'), `REPO_PATH=${target}\n`);
  writeConfig(CONFIG);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadRepo — load_repo, run by bash, read back', () => {
  it('returns every key the file sets, typed, with the defaults lib.sh adds', () => {
    const c = load();
    expect(c).toEqual({
      name: 't',
      root: target,
      baseBranch: 'base',
      installCmd: 'true',
      vitestCmd: 'fake vitest',
      buildCmd: 'true',
      lintCmd: 'true',
      seedFiles: ['.env.local', 'extra.env'],
      probeDir: 'src',
      mergeMode: 'direct',
    });
    expect(c.repoRules).toBeUndefined();
    expect(c.prCmd).toBeUndefined();
  });

  it('a variable in the environment wins over the file', () => {
    const c = load('t', { VITEST_CMD: 'from env', BASE_BRANCH: 'fromenv' });
    expect(c.vitestCmd).toBe('from env');
    expect(c.baseBranch).toBe('fromenv');
  });

  it('SEED_FILES= is allowed and gives an empty list', () => {
    writeConfig(CONFIG.replace(/SEED_FILES=.*/, 'SEED_FILES='));
    expect(load().seedFiles).toEqual([]);
  });

  it('MERGE_MODE=pr with PR_CMD, and REPO_RULES, come through', () => {
    appendFileSync(join(target, '.fleet/config'), "MERGE_MODE=pr\nPR_CMD='gh pr create'\nREPO_RULES=.fleet/rules.md\n");
    const c = load();
    expect(c.mergeMode).toBe('pr');
    expect(c.prCmd).toBe('gh pr create');
    expect(c.repoRules).toBe('.fleet/rules.md');
  });

  it('START_CMD comes through when set, and is absent when not', () => {
    expect(load().startCmd).toBeUndefined();
    appendFileSync(join(target, '.fleet/config'), "START_CMD='npx next start -H 127.0.0.1'\n");
    expect(load().startCmd).toBe('npx next start -H 127.0.0.1');
  });

  it('E2E_CMD comes through when set, and is absent when not', () => {
    expect(load().e2eCmd).toBeUndefined();
    appendFileSync(join(target, '.fleet/config'), "E2E_CMD='npx playwright test'\n");
    expect(load().e2eCmd).toBe('npx playwright test');
  });

  it('E2E_TIMEOUT: absent is undefined, a positive integer comes through as seconds, anything else dies', () => {
    expect(load().e2eTimeoutSec).toBeUndefined();
    appendFileSync(join(target, '.fleet/config'), "E2E_TIMEOUT=600\n");
    expect(load().e2eTimeoutSec).toBe(600);
    appendFileSync(join(target, '.fleet/config'), "E2E_TIMEOUT=10m\n");
    expect(() => load()).toThrow(/E2E_TIMEOUT/);
  });

  it('a value with quotes, a dollar and a newline round-trips byte for byte', () => {
    const odd = 'say "hi" $HOME `x`\\ and\nmore';
    writeConfig(`${CONFIG}BUILD_CMD=${JSON.stringify(odd).replace(/^"|"$/g, "'").replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')}\n`);
    expect(load().buildCmd).toBe(odd);
  });

  it.each([
    ['nope', {}, "unknown repo 'nope'"],
    ['../t', {}, 'not a repo name'],
  ])("%s → die '%s'", (name, env, text) => {
    const e = failure(name, env);
    expect(e.alreadyReported).toBe(false);
    expect(e.message).toContain(text);
  });

  it('a missing required key is the die lib.sh has for it', () => {
    writeConfig(CONFIG.replace(/PROBE_DIR=.*\n/, ''));
    expect(failure().message).toContain('sets no PROBE_DIR');
  });

  it('MERGE_MODE=pr without PR_CMD dies', () => {
    appendFileSync(join(target, '.fleet/config'), 'MERGE_MODE=pr\n');
    expect(failure().message).toContain('PR_CMD');
  });

  it('a config that reads an unset variable dies under set -u', () => {
    writeConfig(`${CONFIG}LINT_CMD="$FLEET_NO_SUCH_VARIABLE"\n`);
    expect(failure().message).toContain('unbound variable');
  });

  it('with stderr inherited the error is marked as already reported and carries no text', () => {
    // The bins use this form: lib.sh's die line has reached the terminal.
    try {
      loadRepo(FLEET_HOME, 'nope', { env: cleanEnv() });
      throw new Error('did not throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).alreadyReported).toBe(true);
    }
  });

  it('a lib.sh that hands back no value for a required key is an error, not an undefined field', () => {
    // A broken lib.sh (the FLEET_LIB_OVERRIDE seam) must not produce a half config.
    const home = join(dir, 'home');
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin/lib.sh'), 'FLEET_REPO_KEYS=""\nload_repo() { REPO_NAME=$1; REPO_ROOT=/x; }\n');
    expect(() => loadRepo(home, 't', { env: cleanEnv(), captureStderr: true })).toThrow(/handed back no [A-Z_]+/);
  });
});
