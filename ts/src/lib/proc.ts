// Subprocesses. The harness's glue is git, the target's test runner and a
// few shell lines; each is one synchronous call here. The two agent calls
// are the exception: `run` is asynchronous, with the timeout and the
// kill-after-grace that `timeout -k 30 N` gave the bash launcher.
import { spawn, spawnSync } from 'node:child_process';
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
 *  (mutation.sh@8fe954a:21-23) and /bin/sh here is dash. Returns the exit status,
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

export interface ToFileOptions {
  cwd?: string;
  /** Created or truncated before the program runs, as `> "$log" 2>&1` would. */
  logFile: string;
}

/** The argv form of runBashTo: a program (no shell) with both streams to the
 *  log file — `git merge … > log 2>&1` (merge.sh:167, revert.sh:51). Returns
 *  the exit status, -1 when it could not start or died of a signal. */
export function runToFile(cmd: string, args: readonly string[], o: ToFileOptions): number {
  const fd = openSync(o.logFile, 'w');
  try {
    const r = spawnSync(cmd, args, { ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), stdio: ['ignore', fd, fd] });
    return r.status ?? -1;
  } finally {
    closeSync(fd);
  }
}

export interface AsyncRunOptions {
  cwd?: string;
  /** Text for the child's stdin (the prompt — on stdin, never argv, L-18). */
  input?: string;
  /** The child's whole environment; absent means this process's. */
  env?: NodeJS.ProcessEnv;
  /** Seconds before the whole process group gets SIGTERM; 0 or absent means
   *  no timeout, as `timeout 0` did. */
  timeoutSec?: number;
  /** Seconds after SIGTERM before SIGKILL (`timeout -k`); default 30. */
  graceSec?: number;
  /** 'merge' folds stderr into stdout in arrival order (the bash `2>&1`);
   *  a descriptor is the bash `2> file`. */
  stderr: 'merge' | number;
}

export interface AsyncRunResult {
  /** The exit status; -1 when the process could not be started or died of
   *  a signal. */
  status: number;
  signal: NodeJS.Signals | null;
  /** The timer fired: SIGTERM went to the group, and SIGKILL after the
   *  grace if it was still there. True on both, where `timeout` said 124
   *  or 137. */
  timedOut: boolean;
  /** UTF-8; an invalid sequence becomes U+FFFD. */
  stdout: string;
}

/** Run a program with an argument array (no shell), asynchronously, as the
 *  leader of its own process group — so that, like `timeout`, the timeout
 *  reaches every descendant (a fake's `sleep 999`, a real agent's shells)
 *  and none is left in the worktree for procs_in_worktree to find. The
 *  result arrives on 'close', when every pipe has drained: a grandchild that
 *  still holds stdout is read to the end, as `$(…)` did. A child that exits
 *  without reading its stdin is a status, not an EPIPE (bash's printf died
 *  of SIGPIPE quietly). Killing the launcher does not kill the group — bash
 *  left the agent running too (L-04). */
export function run(cmd: string, args: readonly string[], o: AsyncRunOptions): Promise<AsyncRunResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let timedOut = false;
    let done = false;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(cmd, args, {
      ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
      ...(o.env !== undefined ? { env: o.env } : {}),
      detached: true,
      stdio: ['pipe', 'pipe', o.stderr === 'merge' ? 'pipe' : o.stderr],
    });
    const signalGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      }
    };
    const finish = (status: number, signal: NodeJS.Signals | null): void => {
      if (done) return;
      done = true;
      if (termTimer !== undefined) clearTimeout(termTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({ status, signal, timedOut, stdout: Buffer.concat(chunks).toString('utf8') });
    };
    if (o.timeoutSec !== undefined && o.timeoutSec > 0) {
      termTimer = setTimeout(() => {
        timedOut = true;
        signalGroup('SIGTERM');
        killTimer = setTimeout(() => signalGroup('SIGKILL'), (o.graceSec ?? 30) * 1000);
      }, o.timeoutSec * 1000);
    }
    child.stdout?.on('data', (c: Buffer) => chunks.push(c));
    if (o.stderr === 'merge') child.stderr?.on('data', (c: Buffer) => chunks.push(c));
    child.stdin?.on('error', () => { /* EPIPE: the child went away before reading */ });
    child.stdin?.end(o.input ?? '');
    child.on('error', () => finish(-1, null));          // could not be started
    child.on('close', (code, signal) => finish(code ?? -1, signal));
  });
}
