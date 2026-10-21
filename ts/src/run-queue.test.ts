import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Die } from './lib/die.ts';
import { busyLine, formatRanLine, launchMinFreeMb, lowMemoryLine, readMax, registeredRepos } from './run-queue.ts';

// The pure parts of `fleet run-queue`; the drain loop itself is proven by
// test/suite.sh (cases 41, 69-71, 87, 91d, 99, 128-131), as the launcher's is.

describe('readMax', () => {
  it('the default, MAX from the environment, and --max as argv[0]', () => {
    expect(readMax([], {})).toBe(20);
    expect(readMax([], { MAX: '5' })).toBe(5);
    expect(readMax(['--max', '3'], {})).toBe(3);
    expect(readMax(['--max', '3'], { MAX: '5' })).toBe(3); // --max wins
  });

  it('--max elsewhere in argv (not argv[0]) is not recognised', () => {
    expect(readMax(['story/1', '--max', '3'], {})).toBe(20);
  });

  it('--max with no number dies', () => {
    expect(() => readMax(['--max'], {})).toThrow(Die);
  });
});

describe('formatRanLine', () => {
  it('the id, status, verdict and exit code; ? and — for the empty ones', () => {
    expect(formatRanLine({ id: '900', status: 'done', verdict: 'PASS', rc: 0 })).toBe('900 done PASS exit=0');
    expect(formatRanLine({ id: '901', status: '', verdict: '', rc: 1 })).toBe('901 ? — exit=1');
  });
});

describe('busyLine — the launch lock\'s holder, as the drain reports it', () => {
  it('names the pid and what the holder is doing', () => {
    expect(busyLine('4242 story 900')).toBe('a launch is already running (pid 4242, story 900) — leaving the queue to the next drain');
    expect(busyLine('17 reap')).toBe('a launch is already running (pid 17, reap) — leaving the queue to the next drain');
  });
  it('a holder line it cannot read still gives a line', () => {
    expect(busyLine('')).toBe('a launch is already running (pid ?, unknown) — leaving the queue to the next drain');
  });
});

describe('registeredRepos — sorted as a shell glob is', () => {
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

describe('launchMinFreeMb — the free memory a launch needs (LAUNCH_MIN_FREE_MB)', () => {
  it('2500 MB by default: one more lane\'s 1.8 GB peak and a margin', () => {
    expect(launchMinFreeMb({})).toBe(2500);
  });
  it('the environment sets it; 0 turns the guard off', () => {
    expect(launchMinFreeMb({ LAUNCH_MIN_FREE_MB: '4000' })).toBe(4000);
    expect(launchMinFreeMb({ LAUNCH_MIN_FREE_MB: '0' })).toBe(0);
  });
  it('a value that is not a whole number is the default, not zero', () => {
    expect(launchMinFreeMb({ LAUNCH_MIN_FREE_MB: 'lots' })).toBe(2500);
    expect(launchMinFreeMb({ LAUNCH_MIN_FREE_MB: '' })).toBe(2500);
  });
});

describe('lowMemoryLine — what the drain says when it leaves the repo to the next one', () => {
  it('names the free memory, the knob and the threshold', () => {
    expect(lowMemoryLine(1200, 2500)).toBe('only 1200 MB of memory is available (LAUNCH_MIN_FREE_MB=2500) — leaving the queue to the next drain');
  });
});
