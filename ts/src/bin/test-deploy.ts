// fleet test-deploy <repo> <branch>   build a branch and serve it at the test URL
// fleet test-deploy <repo> --status   what the test URL serves, and whether it is up
// fleet test-deploy <repo> --stop     stop serving it, and remove its tree
//
// The slot, the tree, the lock and the unit are src/test-deploy.ts. Every
// die is 1 with an XX line on stderr. When a launch holds the repo for longer
// than TEST_DEPLOY_LOCK_WAIT the exit is 75 and nothing was touched. --status
// and --stop are 0 whatever they find. lib.sh's die line for a bad repo or
// config reaches stderr from the child bash itself.
import { resolve } from 'node:path';
import { ConfigError, loadRepo } from '../lib/config.ts';
import { Die } from '../lib/die.ts';
import { dieMessage, out } from '../lib/log.ts';
import { deploy, readKnobs, status, stop } from '../test-deploy.ts';

const USAGE = 'usage: fleet test-deploy <repo> <branch>|--status|--stop';
const FLEET_HOME = resolve(import.meta.dirname, '../../..');

async function main(argv: readonly string[]): Promise<number> {
  const [repo, what, ...extra] = argv;
  if (repo === undefined || what === undefined || extra.length > 0) throw new Die(USAGE);
  const cfg = loadRepo(FLEET_HOME, repo);
  if (what === '--status') {
    out(`${status(FLEET_HOME, cfg.name)}\n`);
    return 0;
  }
  if (what === '--stop') {
    out(`${stop(FLEET_HOME)}\n`);
    return 0;
  }
  if (what.startsWith('-')) throw new Die(USAGE);
  return deploy(cfg, { fleetHome: FLEET_HOME, branch: what, knobs: readKnobs(process.env, FLEET_HOME) });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof Die) dieMessage(e.message);
    else if (e instanceof ConfigError) {
      if (!e.alreadyReported) dieMessage(e.message);
    } else dieMessage(`test-deploy.ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exitCode = 1;
  },
);
