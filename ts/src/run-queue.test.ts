import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Die } from './lib/die.ts';
import { formatRanLine, readMax, registeredRepos } from './run-queue.ts';

// The pure parts of run-queue.sh; the drain loop itself is proven by
// test-lib.sh (cases 41, 69-71, 87, 91d, 99, 128-131), as the launcher's is.

describe('readMax — run-queue.sh:32,37', () => {
  it('the default, MAX from the environment, and --max as argv[0]', () => {
    expect(readMax([], {})).toBe(20);
    expect(readMax([], { MAX: '5' })).toBe(5);
    expect(readMax(['--max', '3'], {})).toBe(3);
    expect(readMax(['--max', '3'], { MAX: '5' })).toBe(3); // --max wins, as the bash order did
  });

  it('--max elsewhere in argv (not argv[0]) is not recognised, as the bash only checked $1', () => {
    expect(readMax(['story/1', '--max', '3'], {})).toBe(20);
  });

  it('--max with no number dies', () => {
    expect(() => readMax(['--max'], {})).toThrow(Die);
  });
});

describe('formatRanLine — run-queue.sh:135', () => {
  it('the id, status, verdict and exit code; ? and — for the empty ones', () => {
    expect(formatRanLine({ id: '900', status: 'done', verdict: 'PASS', rc: 0 })).toBe('900 done PASS exit=0');
    expect(formatRanLine({ id: '901', status: '', verdict: '', rc: 1 })).toBe('901 ? — exit=1');
  });
});

describe('registeredRepos — run-queue.sh:44, sorted as a shell glob is', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-queue-registry-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('lists the .env files by name, extension stripped; ignores everything else', () => {
    const registry = join(dir, 'repos');
    mkdirSync(registry, { recursive: true });
    for (const f of ['b.env', 'a.env', 'notes.txt', '.hidden.env']) writeFileSync(join(registry, f), '');
    // *.env as a shell glob would not match a dotfile.
    expect(registeredRepos(dir, {})).toEqual(['a', 'b']);
  });

  it('no registry directory: empty, not a throw', () => {
    expect(registeredRepos(join(dir, 'nowhere'), {})).toEqual([]);
  });

  it('FLEET_REGISTRY_DIR overrides the default, as lib.sh does', () => {
    const other = join(dir, 'elsewhere');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'x.env'), '');
    expect(registeredRepos(dir, { FLEET_REGISTRY_DIR: other })).toEqual(['x']);
  });
});
