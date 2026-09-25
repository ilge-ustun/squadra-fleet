import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from './proc.ts';
import { deleteFrontmatterField, frontmatterField, recordMergedSha, replaceFrontmatterField, setStoryField, storyField } from './frontmatter.ts';


// The reader's oracle: the same rule as one awk program.
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
/** What the awk prints for the file, minus its trailing newline. */
function awk(path: string, key: string): string {
  const r = runSync('awk', ['-v', `k=${key}`, AWK, path], { env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
  return r.stdout.replace(/\n$/, '');
}

describe('frontmatterField — row by row against the awk', () => {
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

  it('gawk strips U+3000 after the colon under C.UTF-8; this reader strips ASCII whitespace only', () => {
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

// The story writer, byte for byte: the key present, absent, present but
// empty (a second line is inserted: the reader finds no value, so nothing
// is replaced), present twice (the first is replaced), no frontmatter (the
// file is wrapped, trailing newlines collapsed), and a CRLF first line,
// which neither the writer nor the reader takes for `---`.
describe('setStoryField — byte for byte', () => {
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
    ['present but empty: a second line is inserted (the launcher defaulting an empty status)', '---\nstatus:\n---\n', 'status', 'ready', '---\nstatus: ready\nstatus:\n---\n'],
    ['present twice: the first is replaced', '---\nstatus: a\nstatus: b\n---\n', 'status', 'c', '---\nstatus: c\nstatus: b\n---\n'],
    ['trailing spaces on the old value go', '---\nstatus: ready  \n---\nx\n', 'status', 'done', '---\nstatus: done\n---\nx\n'],
    ['no frontmatter: wrapped, trailing newlines collapsed to one', '# T\n\n\n', 'status', 'ready', '---\nstatus: ready\n---\n\n# T\n'],
    ['no frontmatter, no final newline', '# T', 'status', 'ready', '---\nstatus: ready\n---\n\n# T\n'],
    ['empty file', '', 'status', 'ready', '---\nstatus: ready\n---\n\n\n'],
    ['CRLF first line: not frontmatter to the writer either — wrapped, the CR before the last newline kept', '---\r\nstatus: ready\r\n---\r\n', 'status', 'done', '---\nstatus: done\n---\n\n---\r\nstatus: ready\r\n---\r\n'],
    ['round, numeric', '---\nstatus: in_progress\nround: 1\n---\n', 'round', '2', '---\nstatus: in_progress\nround: 2\n---\n'],
  ])('%s', (_name, text, key, value, expected) => {
    expect(tsWrite(text, key, value)).toBe(expected);
  });

  it('a value with / & \\ or a newline is refused (never reachable: statuses and round numbers only)', () => {
    for (const v of ['a/b', 'a&b', 'a\\b', 'a\nb']) {
      expect(() => tsWrite('---\nstatus: ready\n---\n', 'status', v)).toThrow(/set_story_field/);
    }
  });
});

// The writers landing needs, each against a sed line as the oracle — on
// inputs where the key lives in the frontmatter, the same bytes out. The
// last rows of each pin where they differ: the sed lines search the whole
// file (`0,/^merged:.*/`, `/^merged:/d`), so a `merged:` or `status:` in the
// story's body is edited too; these touch the record between the `---`
// lines only.
describe('the frontmatter writers of merge, revert and reset', () => {
  function withFile(text: string, f: (p: string) => void): string {
    const p = join(mkdtempSync(join(dir, 'w-')), 's.md');
    writeFileSync(p, text);
    f(p);
    return readFileSync(p, 'utf8');
  }
  const sed = (p: string, expr: string): void => {
    const r = runSync('sed', ['-i', expr, p], { env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  // recordMergedSha's oracle: record only when line 1 is `---`; replace the
  // first `merged:` anywhere, else insert after line 1.
  const bashRecord = (p: string, sha: string): void => {
    const r = runSync('bash', ['-c',
      'f="$1"; sha="$2"; if awk \'NR==1 && $0=="---"\' "$f" | grep -q .; then if grep -q "^merged:" "$f"; then sed -i "0,/^merged:.*/s//merged: $sha/" "$f"; else sed -i "1a merged: $sha" "$f"; fi; fi',
      '_', p, sha], { env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
    if (r.status !== 0) throw new Error(r.stderr);
  };

  describe('replaceFrontmatterField — `0,/^key:.*/s//key: v/`, first line in the record, nothing inserted', () => {
    it.each([
      ['present', '---\nstatus: needs_human\nround: 2\n---\n\n# S\n', 'status', 'ready', true],
      ['the second key', '---\nstatus: needs_human\nround: 2\n---\n\n# S\n', 'round', '0', true],
      ['present twice: the first', '---\nround: 2\nround: 3\n---\n', 'round', '0', true],
      ['present but empty: replaced in place', '---\nmerged:\n---\n', 'merged', 'abc1234', true],
      ['absent: nothing written', '---\nstatus: x\n---\n', 'round', '0', false],
      ['no final newline', '---\nstatus: x\n---', 'status', 'y', true],
    ])('%s', (_name, text, key, value, changed) => {
      let ret = false;
      const ts = withFile(text, (p) => { ret = replaceFrontmatterField(p, key, value); });
      const sh = withFile(text, (p) => sed(p, `0,/^${key}:.*/s//${key}: ${value}/`));
      expect(ts).toBe(sh);
      expect(ret).toBe(changed);
      expect(ts !== text).toBe(changed);
    });
    it('a key in the body is not the record; line 1 not --- is no record', () => {
      const body = '---\nround: 1\n---\nstatus: done\n';
      expect(withFile(body, (p) => expect(replaceFrontmatterField(p, 'status', 'ready')).toBe(false))).toBe(body);
      expect(withFile(body, (p) => sed(p, '0,/^status:.*/s//status: ready/'))).toBe('---\nround: 1\n---\nstatus: ready\n');
      const bare = 'status: x\n';
      expect(withFile(bare, (p) => expect(replaceFrontmatterField(p, 'status', 'y')).toBe(false))).toBe(bare);
    });
  });

  describe('deleteFrontmatterField — `/^merged:/d`, within the record', () => {
    it.each([
      ['one line', '---\nstatus: done\nmerged: abc\n---\n\n# S\n', 'merged', 1],
      ['absent', '---\nstatus: done\n---\n', 'merged', 0],
      ['twice in the record: both go', '---\nmerged: a\nmerged: b\nstatus: done\n---\n', 'merged', 2],
      ['present but empty', '---\nmerged:\n---\n', 'merged', 1],
    ])('%s', (_name, text, key, n) => {
      let ret = -1;
      const ts = withFile(text, (p) => { ret = deleteFrontmatterField(p, key); });
      const sh = withFile(text, (p) => sed(p, `/^${key}:/d`));
      expect(ts).toBe(sh);
      expect(ret).toBe(n);
    });
    it('a merged: line in the body survives', () => {
      const text = '---\nmerged: a\n---\n\nmerged: in the prose\n';
      expect(withFile(text, (p) => expect(deleteFrontmatterField(p, 'merged')).toBe(1))).toBe('---\n---\n\nmerged: in the prose\n');
      expect(withFile(text, (p) => sed(p, '/^merged:/d'))).toBe('---\n---\n\n');
    });
  });

  describe('recordMergedSha — replace the record\'s merged:, else insert after line 1, only under a --- first line', () => {
    it.each([
      ['absent: inserted after line 1', '---\nstatus: done\nround: 1\n---\n\n# S\n', true],
      ['present: replaced', '---\nmerged: 0000000\nstatus: done\n---\n', true],
      ['present but empty: replaced in place, not doubled as setStoryField would', '---\nmerged:\n---\n', true],
      ['no frontmatter: nothing recorded', '# S\n', false],
      ['empty file', '', false],
    ])('%s', (_name, text, changed) => {
      let ret = false;
      const ts = withFile(text, (p) => { ret = recordMergedSha(p, 'abc1234'); });
      const sh = withFile(text, (p) => bashRecord(p, 'abc1234'));
      expect(ts).toBe(sh);
      expect(ret).toBe(changed);
    });
    it('a merged: in the body is not the record — inserted in the record, the body untouched', () => {
      const text = '---\nstatus: done\n---\n\nmerged: in the prose\n';
      expect(withFile(text, (p) => expect(recordMergedSha(p, 'abc1234')).toBe(true))).toBe('---\nmerged: abc1234\nstatus: done\n---\n\nmerged: in the prose\n');
      expect(withFile(text, (p) => bashRecord(p, 'abc1234'))).toBe('---\nstatus: done\n---\n\nmerged: abc1234\n');
    });
  });
});
