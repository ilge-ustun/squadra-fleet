// A story's frontmatter — the fleet's state; there is no state file. A field
// is read record by record: nothing unless line 1 is exactly `---`; read to
// the second `---`; the first line starting `key:`; strip the key and the
// whitespace after it; keep the rest as is, trailing spaces and a carriage
// return included.
//
// The whitespace stripped is ASCII only, not Unicode spaces (U+3000,
// U+2028, …) — pinned in frontmatter.test.ts, and the same choice as for the
// reviewer's verdict line (verdict.ts).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** awk's records: split on \n, and a final newline ends the last record
 *  rather than starting an empty one. */
export function records(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function frontmatterField(file: string, key: string): string {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const lines = records(text);
  if (lines[0] !== '---') return '';
  const prefix = `${key}:`;
  for (const line of lines.slice(1)) {
    if (line === '---') return '';
    if (line.startsWith(prefix)) return line.slice(prefix.length).replace(/^[ \t\n\v\f\r]*/, '');
  }
  return '';
}

/** `story_field <id> <key>`: the field of .stories/<id>.md under the root. */
export function storyField(root: string, id: string, key: string): string {
  return frontmatterField(join(root, '.stories', `${id}.md`), key);
}

/** `set_story_field <id> <key> <value>`, byte for byte as pinned in
 *  frontmatter.test.ts. Line 1 exactly `---` (a `---\r` is not): when the
 *  reader finds the key with a non-empty value, the first `key:` line of the
 *  file is replaced; else a `key: value` line is inserted after line 1 — so
 *  a present-but-empty key gets a second line above it. No frontmatter: the
 *  file is wrapped, its trailing newlines collapsed to one. The values that
 *  arrive here are statuses and round numbers; one with `/ & \` or a newline
 *  is refused. */
export function setStoryField(root: string, id: string, key: string, value: string): void {
  if (/[/&\\\n]/.test(value)) throw new Error(`set_story_field: a value with / & \\ or a newline would corrupt the file: '${value}'`);
  const f = join(root, '.stories', `${id}.md`);
  const text = readFileSync(f, 'utf8');
  const lines = text.split('\n');
  if (lines[0] === '---') {
    if (frontmatterField(f, key) !== '') {
      const i = lines.findIndex((l) => l.startsWith(`${key}:`));
      lines[i] = `${key}: ${value}`;
    } else {
      lines.splice(1, 0, `${key}: ${value}`);
    }
    writeFileSync(f, lines.join('\n'));
  } else {
    writeFileSync(f, `---\n${key}: ${value}\n---\n\n${text.replace(/\n+$/, '')}\n`);
  }
}

// ── the writers landing needs ────────────────────────────────────────────────
//
// These three touch the record only — the lines between a `---` on line 1
// and the next `---` — so a `merged:` or `status:` in a story's prose is
// never edited; pinned in frontmatter.test.ts.

/** The index range of the record's lines: [1, end), end being the closing
 *  `---` or the file's end; undefined when line 1 is not `---`. */
function recordRange(lines: readonly string[]): number | undefined {
  if (lines[0] !== '---') return undefined;
  const close = lines.indexOf('---', 1);
  return close === -1 ? lines.length : close;
}

/** sed's first-match substitution (`0,/^key:.*\/s//key: value/`) within the
 *  record: the first `key:` line becomes `key: value`; nothing is inserted
 *  when there is none. True when the file was written. */
export function replaceFrontmatterField(file: string, key: string, value: string): boolean {
  const lines = readFileSync(file, 'utf8').split('\n');
  const end = recordRange(lines);
  if (end === undefined) return false;
  const i = lines.slice(0, end).findIndex((l, n) => n > 0 && l.startsWith(`${key}:`));
  if (i === -1) return false;
  lines[i] = `${key}: ${value}`;
  writeFileSync(file, lines.join('\n'));
  return true;
}

/** `sed -i "/^key:/d"` within the record: every `key:` line goes. Returns
 *  how many went; the file is written only when one did. */
export function deleteFrontmatterField(file: string, key: string): number {
  const lines = readFileSync(file, 'utf8').split('\n');
  const end = recordRange(lines);
  if (end === undefined) return 0;
  const kept = lines.filter((l, n) => !(n > 0 && n < end && l.startsWith(`${key}:`)));
  const n = lines.length - kept.length;
  if (n > 0) writeFileSync(file, kept.join('\n'));
  return n;
}

/** Under a `---` first line, the record's first `merged:` line becomes
 *  `merged: <sha>` (an empty one replaced in place, not doubled as
 *  set_story_field would), else `merged: <sha>` is inserted after line 1.
 *  No frontmatter: nothing recorded, false — merge.ts then finds nothing
 *  staged and warns. */
export function recordMergedSha(file: string, sha: string): boolean {
  if (replaceFrontmatterField(file, 'merged', sha)) return true;
  const lines = readFileSync(file, 'utf8').split('\n');
  if (recordRange(lines) === undefined) return false;
  lines.splice(1, 0, `merged: ${sha}`);
  writeFileSync(file, lines.join('\n'));
  return true;
}
