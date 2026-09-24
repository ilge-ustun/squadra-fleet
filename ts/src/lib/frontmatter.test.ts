import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from './proc.ts';
import { frontmatterField, setStoryField, storyField } from './frontmatter.ts';

const FLEET_HOME = join(import.meta.dirname, '../../..');

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

// The writer, lib.sh:102-113, sourced in a child bash as the oracle: the
// same file bytes out for every branch — the key present, absent, present
// but empty (bash inserts a second line: `story_field | grep -q .` sees
// nothing), present twice (the first is replaced), no frontmatter (the file
// is wrapped, trailing newlines collapsed), and a CRLF first line, which
// neither the writer's grep nor the reader's awk takes for `---`.
describe('setStoryField — lib.sh:102-113, byte for byte', () => {
  function bashWrite(text: string, key: string, value: string): string {
    const root = mkdtempSync(join(dir, 'ssf-sh-'));
    mkdirSync(join(root, '.stories'));
    writeFileSync(join(root, '.stories/s.md'), text);
    const r = runSync('bash', ['-c', 'source "$1/lib.sh"; REPO_ROOT="$2"; set_story_field s "$3" "$4"', '_', FLEET_HOME, root, key, value],
      { env: { PATH: process.env['PATH'] ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
    if (r.status !== 0) throw new Error(`set_story_field: ${r.stderr}`);
    return readFileSync(join(root, '.stories/s.md'), 'utf8');
  }
  function tsWrite(text: string, key: string, value: string): string {
    const root = mkdtempSync(join(dir, 'ssf-ts-'));
    mkdirSync(join(root, '.stories'));
    writeFileSync(join(root, '.stories/s.md'), text);
    setStoryField(root, 's', key, value);
    return readFileSync(join(root, '.stories/s.md'), 'utf8');
  }
  it.each([
    ['key present', '---\nstatus: ready\nround: 0\n---\n\n# S\n', 'status', 'done', '---\nstatus: done\nround: 0\n---\n\n# S\n'],
    ['key absent: inserted after line 1', '---\nround: 1\n---\n', 'status', 'done', '---\nstatus: done\nround: 1\n---\n'],
    ['present but empty: a second line is inserted (the :364 case)', '---\nstatus:\n---\n', 'status', 'ready', '---\nstatus: ready\nstatus:\n---\n'],
    ['present twice: the first is replaced', '---\nstatus: a\nstatus: b\n---\n', 'status', 'c', '---\nstatus: c\nstatus: b\n---\n'],
    ['trailing spaces on the old value go', '---\nstatus: ready  \n---\nx\n', 'status', 'done', '---\nstatus: done\n---\nx\n'],
    ['no frontmatter: wrapped, trailing newlines collapsed to one', '# T\n\n\n', 'status', 'ready', '---\nstatus: ready\n---\n\n# T\n'],
    ['no frontmatter, no final newline', '# T', 'status', 'ready', '---\nstatus: ready\n---\n\n# T\n'],
    ['empty file', '', 'status', 'ready', '---\nstatus: ready\n---\n\n\n'],
    ['CRLF first line: not frontmatter to the writer either — wrapped, the CR before the last newline kept', '---\r\nstatus: ready\r\n---\r\n', 'status', 'done', '---\nstatus: done\n---\n\n---\r\nstatus: ready\r\n---\r\n'],
    ['round, numeric', '---\nstatus: in_progress\nround: 1\n---\n', 'round', '2', '---\nstatus: in_progress\nround: 2\n---\n'],
  ])('%s', (_name, text, key, value, expected) => {
    expect(tsWrite(text, key, value)).toBe(expected);
    expect(bashWrite(text, key, value)).toBe(expected);
  });

  it('a value sed would expand or choke on is refused here (never reachable: statuses and round numbers only)', () => {
    for (const v of ['a/b', 'a&b', 'a\\b', 'a\nb']) {
      expect(() => tsWrite('---\nstatus: ready\n---\n', 'status', v)).toThrow(/set_story_field/);
    }
  });
});
