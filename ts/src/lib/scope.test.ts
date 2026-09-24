import { describe, expect, it } from 'vitest';
import { runSync } from './proc.ts';
import { bashGlobMatch, checkScope } from './scope.ts';

// launch.sh:197-223 — the story's scope_deny globs against the round's
// changed paths, judged with bash's own `[[ "$f" == $g ]]`.
describe('bashGlobMatch — [[ $s == $pattern ]], extglob off, against bash itself', () => {
  const rows: Array<[string, string, boolean]> = [
    ['src/a/b.ts', 'src/*', true],           // * crosses /
    ['src/a/b.ts', 'src/*.ts', true],
    ['src/a/b.ts', 'lib/*', false],
    ['a.ts', '?.ts', true],
    ['ab.ts', '?.ts', false],
    ['a/b', 'a?b', true],                    // ? matches / too
    ['b', '[a-c]', true],
    ['d', '[a-c]', false],
    ['x', '[!a-c]', true],
    ['a', '[!a-c]', false],
    ['x', '[^a-c]', true],
    ['5', '[[:digit:]]', true],
    ['a', '[[:digit:]]', false],
    ['a', '[[:alpha:]_]', true],
    ['_', '[[:alpha:]_]', true],
    ['*', '\\*', true],
    ['a', '\\*', false],
    ['a.b', 'a.b', true],
    ['axb', 'a.b', false],                   // . is literal
    ['src/x', 'src/x', true],
    ['src/x', 'src/y', false],
    ['.fleet/config', '.fleet/*', true],
    ['', '*', true],
    ['a', '', false],
    ['abc', 'a*c', true],
    ['abbbc', 'a*b*c', true],
    ['a[', 'a[', true],                      // an unmatched [ is literal
    ['ab', 'a[', false],
    ['a]', 'a[]]', true],                    // ] first in a class is literal
    ['a-', 'a[x-]', true],                   // - last is literal
    ['src/deep/er/file.tsx', 'src/**/*.tsx', true],
    ['README.md', '*.md', true],
    ['docs/README.md', '*.md', true],
    ['a b', 'a b', true],
    ['λ', '?', true],
    ['λ', '[α-ω]', true],
  ];
  it.each(rows)('%j == %j → %s', (s, pattern, expected) => {
    expect(bashGlobMatch(s, pattern)).toBe(expected);
    const r = runSync('bash', ['-c', '[[ "$1" == $2 ]]', '_', s, pattern], { env: { PATH: process.env['PATH'] ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
    expect(r.status === 0, `bash says ${r.status}`).toBe(expected);
  });
});

// check_scope's body, copied from launch.sh:206-221, as the oracle for the
// file and the hits string.
const BASH_CHECK_SCOPE =
  'STORY_ID="$1"; deny="$2"; changed="$3"\n' +
  'set -f; read -ra globs <<< "$deny"; set +f\n' +
  'SCOPE_HITS=""\n' +
  'while read -r f; do\n' +
  '  [[ -n "$f" ]] || continue\n' +
  '  [[ "$f" == ".blocked/$STORY_ID.md" || "$f" == ".stories/$STORY_ID.md" ]] && continue\n' +
  '  [[ "$f" == .fleet/* ]] && { SCOPE_HITS+="$f "; continue; }\n' +
  '  for g in "${globs[@]}"; do\n' +
  '    [[ "$f" == $g ]] && { SCOPE_HITS+="$f "; break; }\n' +
  '  done\n' +
  'done <<< "$changed"\n' +
  '[[ -n "$SCOPE_HITS" ]] && SCOPE=VIOLATION || SCOPE=CLEAN\n' +
  'echo "deny:    ${deny:-<none>}"\n' +
  'echo "scope:   $SCOPE ${SCOPE_HITS}"\n' +
  'echo "changed:"; printf \'%s\\n\' "$changed"\n' +
  'echo "--"; echo "scope: $SCOPE ${SCOPE_HITS}"';

function bashScope(storyId: string, deny: string, changed: string): { fileText: string; logLine: string } {
  const r = runSync('bash', ['-c', BASH_CHECK_SCOPE, '_', storyId, deny, changed], { env: { PATH: process.env['PATH'] ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
  const [fileText, logLine] = r.stdout.split('--\n');
  return { fileText: fileText ?? '', logLine: (logLine ?? '').replace(/\n$/, '') };
}

describe('checkScope — launch.sh:197-223', () => {
  it.each([
    ['nothing denied, nothing hit: CLEAN, <none>, a trailing space after CLEAN', '', 'src/a.ts\nREADME.md', 'CLEAN', []],
    ['a hit', 'src/*', 'src/a.ts\nREADME.md', 'VIOLATION', ['src/a.ts']],
    ['several globs, whitespace-split, each file once', 'lib/*\tdocs/*  *.md', 'src/a.ts\ndocs/x.md\nREADME.md', 'VIOLATION', ['docs/x.md', 'README.md']],
    ['the story file and the blocked file are always allowed', '.stories/* .blocked/*', '.stories/900.md\n.blocked/900.md\n.stories/901.md', 'VIOLATION', ['.stories/901.md']],
    ['.fleet/ is always denied', '', '.fleet/config\nsrc/a.ts', 'VIOLATION', ['.fleet/config']],
    ['no changed paths', 'src/*', '', 'CLEAN', []],
    ['blank lines skipped', 'src/*', '\nsrc/a.ts\n\n', 'VIOLATION', ['src/a.ts']],
  ])('%s', (_name, deny, changed, scope, hits) => {
    const r = checkScope({ deny, changed, storyId: '900' });
    expect(r.scope).toBe(scope);
    expect(r.hits).toEqual(hits);
    const b = bashScope('900', deny, changed);
    expect(r.fileText).toBe(b.fileText);
    expect(r.logLine).toBe(b.logLine);
  });

  it('the bytes: deny padded to the column, the unconditional space, the changed list', () => {
    const r = checkScope({ deny: 'src/*', changed: 'src/a.ts\nb.ts', storyId: '900' });
    expect(r.fileText).toBe('deny:    src/*\nscope:   VIOLATION src/a.ts \nchanged:\nsrc/a.ts\nb.ts\n');
    expect(r.logLine).toBe('scope: VIOLATION src/a.ts ');
    const c = checkScope({ deny: '', changed: '', storyId: '900' });
    expect(c.fileText).toBe('deny:    <none>\nscope:   CLEAN \nchanged:\n\n');
    expect(c.logLine).toBe('scope: CLEAN ');
  });
});
