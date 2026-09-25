// A bin's `trap cleanup EXIT`: the hooks run once, in order, each failure
// swallowed (cleanup is best effort), on SIGTERM, SIGINT or SIGHUP, and the
// process ends with 128+signal. The normal-exit and the die path are the
// caller's `finally`; a signal is the one path a `finally` cannot see, and
// the one this covers. runSync blocks the event loop, so a signal during a
// child runs the hooks after the child exits.
import { constants } from 'node:os';

export interface ExitHooks {
  register: (fn: () => void) => void;
  run: () => void;
}

/** The hook list alone, for a test; installExitHooks wires it to the signals. */
export function makeExitHooks(): ExitHooks {
  const hooks: Array<() => void> = [];
  return {
    register: (fn) => {
      hooks.push(fn);
    },
    run: () => {
      for (const h of hooks.splice(0)) {
        try {
          h();
        } catch {
          /* best effort */
        }
      }
    },
  };
}

/** Wires the three signals; returns the register function for the bin to hand its module. */
export function installExitHooks(): (fn: () => void) => void {
  const { register, run } = makeExitHooks();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
      run();
      process.exit(128 + constants.signals[sig]);
    });
  }
  return register;
}
