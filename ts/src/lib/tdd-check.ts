// The tdd check (L-42): the builder's tdd- pairs, run by the harness right
// after a green baseline, in the reviewer's clean worktree, through the
// verdict's own runner (lib/evidence.ts). These are the words it leaves: the
// count the Machine block shows, and what a resumed builder is told about
// the pairs that are not RED.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSelector } from '../classifier.ts';
import { logTail } from './baseline.ts';
import type { MutRow } from './types.ts';

/** RED first, then the findings in the verdict's vocabulary. */
const ORDER = ['RED', 'GREEN', 'PRE_RED', 'SELECTOR_INVALID', 'PATCH_INVALID', 'NO_TESTS', 'NO_SELECTOR'];

/** `6 RED 1 GREEN`: a count per class present, in ORDER; `no pairs` for none. */
export function tddCounts(rows: readonly MutRow[]): string {
  if (rows.length === 0) return 'no pairs';
  const n = new Map<string, number>();
  for (const r of rows) n.set(r.cls, (n.get(r.cls) ?? 0) + 1);
  const known = ORDER.filter((c) => n.has(c));
  const other = [...n.keys()].filter((c) => !ORDER.includes(c));
  return [...known, ...other].map((c) => `${n.get(c)} ${c}`).join(' ');
}

/** What each class means, and which raw log shows why. */
const MEANING: Record<string, { says: string; log?: 'pre' | 'apply' | 'mut' }> = {
  GREEN: { says: 'the patch applied and the selector stayed green — your test does not assert what the patch removes.', log: 'mut' },
  PRE_RED: { says: 'the selector already fails at your head, before the patch — the instrument proves nothing.', log: 'pre' },
  SELECTOR_INVALID: { says: 'the selector names no test (a wrong path, a -t that matches nothing, a command in a .test).', log: 'pre' },
  PATCH_INVALID: { says: 'the patch does not apply to your head — make it again, after your final commit.', log: 'apply' },
  NO_TESTS: { says: 'with the patch applied nothing was collected — it breaks compilation; remove the behaviour, not the code that builds.', log: 'mut' },
  NO_SELECTOR: { says: 'no .test or .cmd sits beside the patch.' },
};

/** Every pair's class, then, for each one not RED, what it means, its
 *  selector, and the end of the log that shows why. */
export function tddForBuilder(rows: readonly MutRow[], o: { mutationsDir: string; rawPrefix: (name: string) => string; tailLines: number }): string {
  const name = (r: MutRow): string => `${r.ac}-${r.slug}`;
  const parts = [rows.map((r) => `${r.cls.padEnd(17)} ${name(r)}`).join('\n') + '\n'];
  for (const r of rows) {
    if (r.cls === 'RED') continue;
    const m = MEANING[r.cls] ?? { says: 'a class the harness does not explain.' };
    let text = `${name(r)} ${r.cls}: ${m.says}\n`;
    const sel = findSelector(join(o.mutationsDir, `${name(r)}.patch`));
    if (sel !== undefined) text += `selector (.${sel.kind}): ${readFileSync(sel.file, 'utf8').split('\n')[0] ?? ''}\n`;
    if (m.log !== undefined) {
      const log = `${o.rawPrefix(name(r))}-${m.log}.log`;
      text += `The end of ${log}, ${o.tailLines} lines at most:\n----\n${logTail(log, o.tailLines)}\n----\n`;
    }
    parts.push(text);
  }
  return parts.join('\n');
}
