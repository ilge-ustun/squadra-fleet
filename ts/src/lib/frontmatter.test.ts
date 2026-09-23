import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from './proc.ts';
import { frontmatterField, storyField } from './frontmatter.ts';

// lib.sh:91-95, verbatim: the reader every bash script uses.
const AWK =
  'NR==1 && $0!="---" { exit }\n' +
  '/^---$/ { if (++d==2) exit; next }\n' +
  'd==1 && $0 ~ "^"k":" { sub("^"k":[[:space:]]*",""); print; exit }';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fleet-fm-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function file(name: string, text: string): string {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}
/** What `frontmatter_field` prints for the file, minus awk's trailing newline. */
function awk(path: string, key: string): string {
  const r = runSync('awk', ['-v', `k=${key}`, AWK, path], { env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
  return r.stdout.replace(/\n$/, '');
}

describe('frontmatterField — lib.sh:89-96', () => {
  it.each([
    ['plain', '---\nstatus: ready\nround: 2\n---\n\n# Story 1\n', 'status', 'ready'],
    ['second key', '---\nstatus: ready\nround: 2\n---\n', 'round', '2'],
    ['no space after the colon', '---\nstatus:done\n---\n', 'status', 'done'],
    ['trailing space kept', '---\nstatus: done  \n---\n', 'status', 'done  '],
    ['CRLF keeps the CR', '---\r\nstatus: done\r\n---\r\n', 'status', ''],
    ['CR only on the value line', '---\nstatus: done\r\n---\n', 'status', 'done\r'],
    ['first match wins', '---\nstatus: a\nstatus: b\n---\n', 'status', 'a'],
    ['a key after the closing --- is not frontmatter', '---\nround: 1\n---\nstatus: done\n', 'status', ''],
    ['line 1 not --- means no frontmatter', '\n---\nstatus: done\n---\n', 'status', ''],
    ['unterminated frontmatter still reads', '---\nstatus: done\n', 'status', 'done'],
    ['a prefix of the key is not the key', '---\nstatus_old: x\nstatus: y\n---\n', 'status', 'y'],
    ['the key must start the line', '---\n  status: x\n---\n', 'status', ''],
    ['empty file', '', 'status', ''],
    ['no newline at the end', '---\nstatus: done\n---', 'status', 'done'],
    ['tab after the colon is stripped', '---\nstatus:\tdone\n---\n', 'status', 'done'],
  ])('%s', (name, text, key, expected) => {
    const p = file(`${name.replace(/[^a-z]/g, '_')}.md`, text);
    expect(frontmatterField(p, key)).toBe(expected);
    expect(frontmatterField(p, key)).toBe(awk(p, key));
  });

  it('a missing file is an empty value, not an error', () => {
    expect(frontmatterField(join(dir, 'nope.md'), 'status')).toBe('');
  });

  it('non-parity, pinned: gawk strips U+3000 after the colon under C.UTF-8; this reader strips ASCII whitespace only', () => {
    const p = file('u3000.md', '---\nstatus:　done\n---\n');
    expect(awk(p, 'status')).toBe('done');
    expect(frontmatterField(p, 'status')).toBe('　done');
  });

  it('storyField reads .stories/<id>.md under the root', () => {
    const root = join(dir, 'root');
    runSync('mkdir', ['-p', join(root, '.stories')]);
    writeFileSync(join(root, '.stories/900.md'), '---\nstatus: ready\n---\n');
    expect(storyField(root, '900', 'status')).toBe('ready');
    expect(storyField(root, '901', 'status')).toBe('');
  });
});
