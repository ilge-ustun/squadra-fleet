// A story's frontmatter — the fleet's state; there is no state file
// (lib.sh:84-87). This is lib.sh:89-96 record by record: nothing unless line
// 1 is exactly `---`; read to the second `---`; the first line starting
// `key:`; strip the key and the whitespace after it; keep the rest as is,
// trailing spaces and a carriage return included.
//
// gawk's [[:space:]] under the suite's C.UTF-8 also strips Unicode spaces
// (U+3000, U+2028, …); this strips ASCII whitespace only — a pinned
// non-parity, the one seam 2 chose for the reviewer's verdict line too.
import { readFileSync } from 'node:fs';
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
