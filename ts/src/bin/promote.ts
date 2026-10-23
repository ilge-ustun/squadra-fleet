// fleet promote <repo> <id> [--by <who>] — a story to ready, committed and
// pushed, and the repo's drain started: what /promote does from the phone
// (src/promote.ts), at a terminal. --by names who promoted it in the commit
// and the event (`fleet promote` when absent): the coordinator's is
// `coordinator, delegated by the human`.
//
// Under the fleet lock, as the bot's commands are. QUEUE_START_CMD starts
// the drain (`systemctl --user start --no-block fleet-queue@{repo}.service`
// when unset); it returns at once and never runs a launcher here. A promoted
// story is 0, and so is one already ready (nothing to do); a story that does
// not exist, one a launcher has, or a commit that fails is 1, with the reason.
import { writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { withFleetLock } from '../lib/lock.ts';
import { dieMessage, warn } from '../lib/log.ts';
import { runSync } from '../lib/proc.ts';
import { QUEUE_START_DEFAULT, USAGE, promote, queueStartArgv } from '../promote.ts';

const FLEET_HOME = resolve(import.meta.dirname, '../../..');

function main(argv: readonly string[]): number {
  const [repo, id, flag, who, ...extra] = argv;
  if (repo === undefined || id === undefined || extra.length > 0) throw new Die(USAGE);
  if (flag !== undefined && (flag !== '--by' || who === undefined || who === '')) throw new Die(USAGE);
  const cfg = loadRepo(FLEET_HOME, repo);
  const lockWait = Number(process.env['FLEET_LOCK_WAIT'] || '120');
  const startQueue = (): boolean => {
    const [cmd, ...args] = queueStartArgv(process.env['QUEUE_START_CMD'] ?? QUEUE_START_DEFAULT, cfg.name);
    return cmd !== undefined && runSync(cmd, args).status === 0;
  };
  const r = withFleetLock(cfg.root, lockWait, () => warn('waited for the fleet lock — going ahead'), () =>
    promote(cfg, id, { by: who ?? 'fleet promote', startQueue, warn }));
  writeSync(1, `${r.reply}\n`);
  return r.promoted || r.reply.endsWith('was already ready') ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof Die) dieMessage(e.message);
  else if (e instanceof ConfigError) {
    if (!e.alreadyReported) dieMessage(e.message);
  } else dieMessage(`promote.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
