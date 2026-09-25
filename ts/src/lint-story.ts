// lint-story.ts — mechanical checks on a story, before any agent spends
// quota on it. No model, no network, no git writes. Errors exit 1; warnings
// print and exit 0 unless --strict. Every check exists because something
// cost rounds:
//
//   citations      a story cited a diagnosis file and a symptom that no
//                  longer existed. A story is read as fact by two agents; a
//                  stale file:line is a false premise (L-09). Resolved
//                  against the story's base, not the checkout.
//   AC headings    the launcher extracts AC ids from `**ACn` at column 0. A
//                  story whose ACs are a table is invisible to it and dies at
//                  "declares no acceptance criteria".
//   unbounded ACs  L-20. "every stub in the worker global" cost a story two
//                  rounds. An unquantified every/all/any in an AC heading is
//                  a scope declaration that outranks Out of scope.
//   baseline ACs   the harness runs test/build/lint unconditionally, so an AC
//                  asserting them is noise that cannot fail independently.
//   base, model    a base is the integration branch or epic/*; a model is
//                  one of the live aliases, never a pinned id.
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Die } from './lib/die.ts';
import { frontmatterField } from './lib/frontmatter.ts';
import { catFileExists, refExists, showLineCount } from './lib/git.ts';
import type { RepoConfig } from './lib/config.ts';

export const USAGE = 'usage: fleet lint-story <repo> <story-id|path> [--strict]';

const RED = '\x1b[31m';
const YLW = '\x1b[33m';
const GRN = '\x1b[32m';
const RST = '\x1b[0m';

// ── acceptance criteria (lint-story.sh:72-97) ────────────────────────────────

/** lint-story.sh:74: unique AC ids, in numeric order (`sort -u -V`). */
export function extractAcs(text: string): string[] {
  const ids = [...text.matchAll(/^\*\*AC([0-9]+)/gm)].map((m) => `AC${m[1] ?? ''}`);
  return [...new Set(ids)].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
}

/** lint-story.sh:78-83: the first gap from AC1, or undefined when contiguous. */
export function firstAcGap(acs: readonly string[]): string | undefined {
  let n = 1;
  for (const ac of acs) {
    if (ac !== `AC${n}`) return ac;
    n += 1;
  }
  return undefined;
}

/** lint-story.sh:89: every line starting with `**ACn` — the same prefix the
 *  launcher's own AC extraction (and extractAcs above) uses. */
export function acHeadingLines(text: string): string[] {
  return text.split('\n').filter((l) => /^\*\*AC[0-9]+/.test(l));
}

const TEMPORAL = /\b(?:every|each|any|all)\s+(?:time|run|round)s?\b/i;
const DOMAIN = /\b(?:every|all|any)\b/i;

/** lint-story.sh:86-91 (L-20): an unquantified every/all/any in an AC
 *  heading — "every time/run/round" is exempted, checked first since a line
 *  with both a temporal phrase and an unbound one is exempted whole, as the
 *  bash's `grep -v` piped into `grep` was. */
export function isUnboundedDomain(line: string): boolean {
  return !TEMPORAL.test(line) && DOMAIN.test(line);
}

const SUITE = /suite|npm (?:test|run (?:build|lint))|stay green/i;

/** lint-story.sh:94-97: an AC heading mentioning the baseline suite/build/lint. */
export function mentionsBaseline(line: string): boolean {
  return SUITE.test(line);
}

// ── frontmatter fields (lint-story.sh:52-70) ─────────────────────────────────

export const MODEL_ALIASES = ['sonnet', 'opus', 'fable'] as const;

/** lint-story.sh:67-70: '' (the default) or one of the live aliases — haiku
 *  stays rejected, case_116's regression guard. */
export function isValidModel(model: string): boolean {
  return model === '' || (MODEL_ALIASES as readonly string[]).includes(model);
}

/** lint-story.sh:56: a base is the integration branch or an epic/* branch —
 *  whether either actually exists is a separate, git-backed check. */
export function isValidBaseName(base: string, baseBranch: string): boolean {
  return base === baseBranch || base.startsWith('epic/');
}

// ── citations (lint-story.sh:105-176) ────────────────────────────────────────

// lint-story.sh:175: a backticked `path/to/x.ext[:N[-M]]` token.
const CITE_RE = /`[A-Za-z0-9_./@-]*\[?[A-Za-z0-9_.-]*\]?[A-Za-z0-9_./-]*\.[a-z]+(?::[0-9]+(?:-[0-9]+)?)?`/g;

/** lint-story.sh:175-176: every backticked candidate in the story, deduped
 *  and sorted — the `grep -oE | tr -d '\`' | sort -u` pipeline. */
export function extractCitations(text: string): string[] {
  return [...new Set((text.match(CITE_RE) ?? []).map((c) => c.slice(1, -1)))].sort();
}

export interface Citation {
  path: string;
  /** '' when the citation named no line or range. */
  lines: string;
}

/** lint-story.sh:145: split on the FIRST ':' — the path's own character
 *  class never includes one. */
export function splitCitation(cite: string): Citation {
  const i = cite.indexOf(':');
  return i === -1 ? { path: cite, lines: '' } : { path: cite.slice(0, i), lines: cite.slice(i + 1) };
}

/** lint-story.sh:146-153: a candidate that looks like a path but is not one
 *  worth checking — a URL, an @-mention, node_modules, a URL path (leading
 *  `/`), a runtime `.blocked/` file, or too plain to be a citation (no
 *  directory, no extension: a bare filename in prose). */
export function skipCitation(path: string): boolean {
  if (path.startsWith('http') || path.includes('@') || path.startsWith('node_modules/')) return true;
  if (path.startsWith('/')) return true;
  if (path.startsWith('.blocked/')) return true;
  if (!path.includes('/')) return true;
  if (!path.includes('.')) return true;
  return false;
}

/** lint-story.sh:171: `${lines%%-*}` / `${lines##*-}` — the first and last
 *  number of a `N` or `N-M` spec (equal for a bare `N`). */
export function citationRange(lines: string): { first: number; last: number } {
  const dash = lines.indexOf('-');
  const lastDash = lines.lastIndexOf('-');
  return {
    first: Number(dash === -1 ? lines : lines.slice(0, dash)),
    last: Number(lastDash === -1 ? lines : lines.slice(lastDash + 1)),
  };
}

function localLineCount(path: string): number {
  try {
    return (readFileSync(path, 'utf8').match(/\n/g) ?? []).length;
  } catch {
    return 0;
  }
}

// ── the walk ──────────────────────────────────────────────────────────────

export interface LintStoryOptions {
  /** After the repo name: `[story-id|path, --strict?]`. */
  argv: readonly string[];
}

/** lint-story.sh's own err()/warn() (lines 36-39): these count, so they
 *  replace lib.sh's warn deliberately — not ../lib/log.ts's. */
function makeCounters(): { err: (msg: string) => void; warn: (msg: string) => void; errors: () => number; warnings: () => number } {
  let errors = 0;
  let warnings = 0;
  return {
    err: (msg) => {
      writeSync(2, `${RED}ERROR${RST}   ${msg}\n`);
      errors += 1;
    },
    warn: (msg) => {
      writeSync(1, `${YLW}warning${RST} ${msg}\n`);
      warnings += 1;
    },
    errors: () => errors,
    warnings: () => warnings,
  };
}

export function lintStory(cfg: RepoConfig, o: LintStoryOptions): number {
  const [arg, strictFlag] = o.argv;
  if (arg === undefined) throw new Die(USAGE);
  const strict = strictFlag === '--strict';

  const storyFile = existsSync(arg) ? arg : join(cfg.root, '.stories', `${arg}.md`);
  if (!existsSync(storyFile)) {
    writeSync(2, `lint-story: no such story: ${arg}\n`);
    return 1;
  }

  const { err, warn, errors, warnings } = makeCounters();
  const text = readFileSync(storyFile, 'utf8');
  const lines = text.split('\n');
  const field = (key: string): string => frontmatterField(storyFile, key);

  // ── frontmatter ────────────────────────────────────────────────────────
  if (lines[0] !== '---') err('no frontmatter — the launcher reads status/round/base/scope_deny from it');
  if (field('status') === '') err('frontmatter has no status:');
  if (field('round') === '') warn('frontmatter has no round: — the launcher will treat it as 0');

  const base = field('base');
  if (base !== '') {
    if (!isValidBaseName(base, cfg.baseBranch)) {
      err(`base: ${base} — a base is ${cfg.baseBranch} or epic/<name> (fleet new-epic), nothing else`);
    }
    if (!refExists(cfg.root, `origin/${base}`) && !refExists(cfg.root, base)) {
      err(`base: ${base} — no such branch locally or on origin`);
    }
  }
  if (field('scope_deny') === '') warn('no scope_deny: — nothing is forbidden to the builder');

  const model = field('model');
  if (!isValidModel(model)) {
    err(`model: ${model} — name an alias, sonnet, opus or fable (the CLI resolves it to the newest release)`);
  }

  // ── acceptance criteria ────────────────────────────────────────────────
  const acs = extractAcs(text);
  if (acs.length === 0) {
    err("no acceptance criteria the launcher can see — they must be headed '**ACn — …' at column 0");
  } else {
    const gap = firstAcGap(acs);
    if (gap !== undefined) warn(`acceptance criteria are not contiguous from AC1 (found ${gap} where AC${acs.indexOf(gap) + 1} was expected)`);
  }

  const headings = acHeadingLines(text);
  for (const line of headings) {
    if (isUnboundedDomain(line)) warn(`unquantified domain in an AC heading — name the set it ranges over (L-20):\n          ${line.slice(0, 100)}`);
  }
  for (const line of headings) {
    if (mentionsBaseline(line)) warn(`an AC about the suite/build/lint — the harness runs those as the baseline:\n          ${line.slice(0, 100)}`);
  }

  // ── sections the conventions require ──────────────────────────────────
  for (const section of ['## Acceptance criteria', '## Known weakness', '## Out of scope']) {
    if (!lines.some((l) => l.startsWith(section))) warn(`no '${section}' section`);
  }

  // ── citations ─────────────────────────────────────────────────────────
  let citeRef = '';
  for (const ref of [`origin/${base || cfg.baseBranch}`, base || cfg.baseBranch]) {
    if (refExists(cfg.root, `${ref}^{commit}`)) {
      citeRef = ref;
      break;
    }
  }
  const citeExists = (path: string): boolean => (citeRef !== '' ? catFileExists(cfg.root, citeRef, path) : existsSync(join(cfg.root, path)));
  const citeLines = (path: string): number => (citeRef !== '' ? showLineCount(cfg.root, citeRef, path) : localLineCount(join(cfg.root, path)));

  let checked = 0;
  for (const cite of extractCitations(text)) {
    const { path, lines: linesSpec } = splitCitation(cite);
    if (skipCitation(path)) continue;
    checked += 1;

    if (!citeExists(path)) {
      if (linesSpec !== '') err(`cites ${path}:${linesSpec} but that file does not exist`);
      else warn(`cites a file that does not exist — new instrument, or rot? ${path}`);
      continue;
    }
    if (linesSpec === '') continue;
    const total = citeLines(path);
    const { first, last } = citationRange(linesSpec);
    if (first > total || last > total) err(`cites ${path}:${linesSpec} but the file has ${total} lines`);
  }

  // ── verdict ───────────────────────────────────────────────────────────
  writeSync(1, `\n${basename(storyFile)}: ${errors()} error(s), ${warnings()} warning(s), ${checked} citation(s) checked against ${citeRef || 'the checkout'}, ${acs.length} AC(s)\n`);

  if (errors() > 0) return 1;
  if (strict && warnings() > 0) {
    writeSync(2, '--strict: warnings are fatal\n');
    return 1;
  }
  writeSync(1, `${GRN}ok${RST}\n`);
  return 0;
}
