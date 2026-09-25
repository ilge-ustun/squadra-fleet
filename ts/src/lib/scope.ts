// Scope. The story's `scope_deny:` frontmatter, space-separated bash globs,
// names files the builder must not touch. Deny-only, by decision. A hit is a
// machine veto. Two paths the rules themselves require are always allowed,
// and .fleet/ is always denied: the harness sources .fleet/config, so a
// builder that could change it could change what runs.

const SYNTAX = /[\\^$.*+?()[\]{}|/]/;
const escapeRe = (c: string): string => (SYNTAX.test(c) ? `\\${c}` : c);

const POSIX_CLASSES: Record<string, string> = {
  alpha: '\\p{L}', digit: '0-9', alnum: '\\p{L}\\p{N}', upper: '\\p{Lu}', lower: '\\p{Ll}', space: '\\s',
  blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e',
};

/** A `[…]` at position i, or undefined when it is unmatched (then bash
 *  takes the `[` literally). */
function bracket(chars: readonly string[], i: number): { re: string; end: number } | undefined {
  let j = i + 1;
  let negate = false;
  if (chars[j] === '!' || chars[j] === '^') { negate = true; j++; }
  let body = '';
  let first = true;
  for (; j < chars.length; j++) {
    const c = chars[j] as string;
    if (c === ']' && !first) return { re: `[${negate ? '^' : ''}${body}]`, end: j };
    first = false;
    if (c === '[' && chars[j + 1] === ':') {
      const close = chars.indexOf(']', j + 2);
      if (close !== -1 && chars[close - 1] === ':') {
        const name = chars.slice(j + 2, close - 1).join('');
        const cls = POSIX_CLASSES[name];
        if (cls !== undefined) { body += cls; j = close; continue; }
      }
    }
    if (c === '\\' && j + 1 < chars.length) { j++; body += `\\${chars[j]}`; continue; }
    if (c === '-' && body !== '' && chars[j + 1] !== ']' && chars[j + 1] !== undefined) { body += '-'; continue; }
    body += /[\\\]\[^-]/.test(c) ? `\\${c}` : c;
  }
  return undefined;
}

/** bash's `[[ "$s" == $pattern ]]` with extglob off: `*` and `?` match any
 *  character including `/`, `[…]` classes with ranges, `!`/`^` negation and
 *  POSIX names, `\` quotes the next character, an unmatched `[` is literal.
 *  Proven row by row against bash in scope.test.ts. */
export function bashGlobMatch(s: string, pattern: string): boolean {
  const chars = [...pattern];
  let re = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (c === '\\') { i++; re += i < chars.length ? escapeRe(chars[i] as string) : '\\\\'; continue; }
    if (c === '*') { re += '[\\s\\S]*'; continue; }
    if (c === '?') { re += '[\\s\\S]'; continue; }
    if (c === '[') {
      const b = bracket(chars, i);
      if (b !== undefined) { re += b.re; i = b.end; continue; }
      re += '\\['; continue;
    }
    re += escapeRe(c);
  }
  return new RegExp(`^${re}$`, 'u').test(s);
}

export interface ScopeInput {
  /** The story's scope_deny line, whitespace-separated globs; '' for none. */
  deny: string;
  /** `git diff --name-only BASE..HEAD`, one path per line. */
  changed: string;
  storyId: string;
}

export interface ScopeResult {
  scope: 'CLEAN' | 'VIOLATION';
  hits: string[];
  /** round-N/scope.txt — note the space after the scope word is
   *  unconditional (pinned in scope.test.ts). */
  fileText: string;
  /** The `scope: …` log line, the same unconditional space. */
  logLine: string;
}

export function checkScope(i: ScopeInput): ScopeResult {
  const globs = i.deny.split(/[ \t\n]+/).filter((g) => g !== '');   // read -ra: IFS whitespace
  const hits: string[] = [];
  for (const raw of i.changed.split('\n')) {
    const f = raw.replace(/^[ \t]+|[ \t]+$/g, '');                 // read -r strips IFS whitespace
    if (f === '') continue;
    if (f === `.blocked/${i.storyId}.md` || f === `.stories/${i.storyId}.md`) continue;
    if (bashGlobMatch(f, '.fleet/*')) { hits.push(f); continue; }
    for (const g of globs) {
      if (bashGlobMatch(f, g)) { hits.push(f); break; }
    }
  }
  const scope = hits.length > 0 ? 'VIOLATION' : 'CLEAN';
  const hitsText = hits.map((h) => `${h} `).join('');
  return {
    scope,
    hits,
    fileText: `deny:    ${i.deny === '' ? '<none>' : i.deny}\nscope:   ${scope} ${hitsText}\nchanged:\n${i.changed}\n`,
    logLine: `scope: ${scope} ${hitsText}`,
  };
}
