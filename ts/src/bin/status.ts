// fleet status <repo> [--json|--epics|--bot] [--all] [story-id] — what the
// fleet is doing and what it decided.
//
//   <repo>              the epics, then every story of the repo
//   <repo> 007          one story, with the latest round's machine block
//   <repo> --json       the same values as JSON, for the bot and merge
//   <repo> --epics      only the epic block — what a human decides to merge
//   <repo> --bot        the phone form: a <pre> block wraps at ~40 columns
//                       there, so no table — per story: id and title, then
//                       base | state | round | verdict, between rules;
//                       newest first; no colour. Hides `landed` and `done`,
//                       which ask nothing of anyone; --all turns that off. A
//                       story named by id is always shown.
//
// Read-only: safe to run while a launcher is working. The walk and the
// landing rule are src/status.ts; the views src/status-views.ts.
//
// Exit codes: the repo is loaded before the flags are read, so an unknown
// repo is 1 whatever follows; an unknown flag is 2 with the usage on stderr;
// everything else 0. lib.sh's die line for a bad repo or config reaches
// stderr from the child bash itself — nothing is added, and on success
// nothing at all goes to stderr (the bot merges it into the reply).
import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { dieMessage, out } from '../lib/log.ts';
import { statusOf } from '../status.ts';
import { renderStatus } from '../status-views.ts';

const USAGE = 'usage: status.sh <repo> [--json|--epics|--bot] [--all] [story-id]';
const FLEET_HOME = resolve(import.meta.dirname, '../../..');

class UsageError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(USAGE);
    this.code = code;
  }
}

function main(argv: readonly string[]): number {
  const [repo, ...rest] = argv;
  if (repo === undefined) throw new UsageError(1);
  const cfg = loadRepo(FLEET_HOME, repo);
  const o = { json: false, epics: false, bot: false, all: false, one: undefined as string | undefined };
  for (const a of rest) {
    if (a === '--json') o.json = true;
    else if (a === '--epics') o.epics = true;
    else if (a === '--bot') o.bot = true;
    else if (a === '--all') o.all = true;
    else if (a.startsWith('-')) throw new UsageError(2);
    else o.one = a;
  }
  const st = statusOf(cfg, o.one === undefined ? {} : { one: o.one });
  out(renderStatus(st, { ...o, repoName: cfg.name, baseBranch: cfg.baseBranch }));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError) {
    if (e.code === 2) writeSync(2, `${USAGE}\n`);
    else dieMessage(USAGE);
    process.exitCode = e.code;
  } else if (e instanceof ConfigError) {
    if (!e.alreadyReported) dieMessage(e.message);
    process.exitCode = 1;
  } else {
    dieMessage(`status.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exitCode = 1;
  }
}
