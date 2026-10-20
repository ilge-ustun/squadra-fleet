import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memAvailableMb, readMemAvailableMb } from './meminfo.ts';

const MEMINFO = 'MemTotal:        8120000 kB\nMemFree:          300000 kB\nMemAvailable:    5242880 kB\nBuffers:           10000 kB\n';

describe('memAvailableMb — the kernel\'s own estimate of what a new process can have', () => {
  it('MemAvailable, in whole MB', () => {
    expect(memAvailableMb(MEMINFO)).toBe(5120);
    expect(memAvailableMb('MemAvailable:       2047 kB\n')).toBe(1);
  });
  it('MemFree is not it: page cache is counted free in MemAvailable and not in MemFree', () => {
    expect(memAvailableMb('MemFree: 1048576 kB\n')).toBeUndefined();
  });
  it('a text without the line is unknown, not zero', () => {
    expect(memAvailableMb('')).toBeUndefined();
  });
});

describe('readMemAvailableMb', () => {
  it('reads the file; a file that is not there is unknown', () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-meminfo-'));
    try {
      writeFileSync(join(d, 'meminfo'), MEMINFO);
      expect(readMemAvailableMb(join(d, 'meminfo'))).toBe(5120);
      expect(readMemAvailableMb(join(d, 'nothing'))).toBeUndefined();
    } finally {
      rmSync(d, { recursive: true });
    }
  });
});
