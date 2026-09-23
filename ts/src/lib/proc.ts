// Subprocesses, synchronously. The harness's glue is git, the target's test
// runner and a few shell lines; each is one call here. Named runSync so an
// async run — with the timeout and kill-after-grace the agent calls need —
// can arrive later without renaming anything.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

export interface RunResult {
  /** The exit status; -1 when the process could not be started or was killed
   *  by a signal, so `status !== 0` always means "did not succeed". */
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Text for the child's stdin; absent means /dev/null. */
  input?: string;
  /** The child's whole environment; absent means this process's. */
  env?: NodeJS.ProcessEnv;
  /** 'inherit' passes the child's stderr through to ours (a bash `die` that
   *  should reach the terminal unchanged); the result's stderr is then ''. */
  stderr?: 'inherit';
}

/** Run a program with an argument array (no shell), capturing both streams. */
export function runSync(cmd: string, args: readonly string[], o: RunOptions = {}): RunResult {
  const r = spawnSync(cmd, args, {
    ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
    ...(o.env !== undefined ? { env: o.env } : {}),
    encoding: 'utf8',
    stdio: [o.input !== undefined ? 'pipe' : 'ignore', 'pipe', o.stderr ?? 'pipe'],
    ...(o.input !== undefined ? { input: o.input } : {}),
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

export interface BashToOptions {
  cwd: string;
  /** Created or truncated before the line runs, as bash's `> "$log" 2>&1`
   *  would, so a log exists even when the command never starts. */
  logFile: string;
}

/** `bash -c <line>` with stdout and stderr both appended to the log file.
 *  Always bash, never /bin/sh: a selector line is a bash contract
 *  (mutation.sh:21-23) and /bin/sh here is dash. Returns the exit status,
 *  -1 when the process could not be started or died of a signal. */
export function runBashTo(line: string, o: BashToOptions): number {
  const fd = openSync(o.logFile, 'w');
  try {
    const r = spawnSync('bash', ['-c', line], { cwd: o.cwd, stdio: ['ignore', fd, fd] });
    return r.status ?? -1;
  } finally {
    closeSync(fd);
  }
}
