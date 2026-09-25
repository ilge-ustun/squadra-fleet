// new-epic.ts — new-epic.sh in TypeScript (seam 7). The one way an epic
// branch comes into being: cut from ORIGIN's integration branch, not the
// local one, and pushed at once — the launcher cuts every worktree from
// origin, so the next story can use it. The checkout is never touched: no
// checkout, no switch.
import { Die } from './lib/die.ts';
import { branchExists, fetch, fetchRef, pushRef, refExists, revParseShort } from './lib/git.ts';
import { log, warn } from './lib/log.ts';
import type { RepoConfig } from './lib/config.ts';

export const USAGE = 'usage: fleet new-epic <repo> <name>   (a plain name: letters, digits, _ and -; epic/ is added)';

export interface NewEpicOptions {
  /** After the repo name: exactly `[name]`. */
  argv: readonly string[];
}

export function newEpic(cfg: RepoConfig, o: NewEpicOptions): number {
  if (o.argv.length !== 1) throw new Die(USAGE);
  const name = o.argv[0] ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Die(`'${name}' is not a plain name — ${USAGE}`);
  const epic = `epic/${name}`;

  if (fetch(cfg.root, 'origin') !== 0) throw new Die('fetch failed');
  if (refExists(cfg.root, `origin/${epic}`)) throw new Die(`${epic} already exists on origin`);
  if (branchExists(cfg.root, epic)) throw new Die(`${epic} already exists locally — push or delete it first`);
  if (!refExists(cfg.root, `origin/${cfg.baseBranch}`)) throw new Die(`origin has no ${cfg.baseBranch} to cut from`);

  if (pushRef(cfg.root, `origin/${cfg.baseBranch}`, epic) !== 0) throw new Die(`could not push ${epic}`);
  if (fetchRef(cfg.root, 'origin', epic) !== 0) warn(`pushed, but could not fetch ${epic} back`);
  log(`${epic} created on origin from origin/${cfg.baseBranch} (${revParseShort(cfg.root, `origin/${epic}`)})`);
  log(`next: fleet write-story ${cfg.name} <id> "<intent>" --base ${epic}`);
  return 0;
}
