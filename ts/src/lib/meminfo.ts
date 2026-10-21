import { readFileSync } from 'node:fs';

/** `MemAvailable` from a /proc/meminfo text, in whole MB: the kernel's own
 *  estimate of what a new process can have without swapping, page cache that
 *  can be dropped included. MemFree is not it — a box that has read its
 *  repos reports MemFree near zero and is not short. Absent (a kernel
 *  without the line, or no text) is unknown, never zero. */
export function memAvailableMb(text: string): number | undefined {
  const m = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
  return m === null ? undefined : Math.floor(Number(m[1]) / 1024);
}

/** memAvailableMb of a file; one that cannot be read is unknown. */
export function readMemAvailableMb(path: string): number | undefined {
  try {
    return memAvailableMb(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}
