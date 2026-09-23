// The target's configuration, as lib.sh loads it. `.fleet/config` is sourced
// bash — a value may be quoted, may expand, may span lines — so the one
// program that can read it is bash. load_repo runs in a child bash with the
// same lib.sh every script sources, and hands the values back as
// NUL-separated key/value pairs: nothing is quoted, nothing is parsed beyond
// one split. The environment goes through unchanged, so a variable the
// caller set still wins over the file (lib.sh:14-15), and FLEET_REGISTRY_DIR
// and a substituted lib.sh (the FLEET_LIB_OVERRIDE seam) keep working.
//
// lib.sh's `die` writes its line to stderr and exits 1. By default the child
// inherits our stderr, so that line reaches the terminal exactly as it did
// when the caller was bash; the ConfigError then says only that it was
// already reported, and a bin exits 1 without a second message.
import { runSync } from './proc.ts';

export type MergeMode = 'direct' | 'pr';

export interface RepoConfig {
  /** The registry name, `REPO_NAME`. */
  name: string;
  /** `REPO_ROOT`: the top of the target's checkout. */
  root: string;
  baseBranch: string;
  installCmd: string;
  vitestCmd: string;
  buildCmd: string;
  lintCmd: string;
  /** `SEED_FILES` split on whitespace, as `read -ra` did; may be empty. */
  seedFiles: string[];
  probeDir: string;
  /** A markdown file relative to the target, rendered into the prompts. */
  repoRules?: string;
  mergeMode: MergeMode;
  /** Required by lib.sh when mergeMode is 'pr'. */
  prCmd?: string;
}

export class ConfigError extends Error {
  /** True when lib.sh's die line has already gone to stderr (inherited). */
  readonly alreadyReported: boolean;
  constructor(message: string, alreadyReported: boolean) {
    super(message);
    this.name = 'ConfigError';
    this.alreadyReported = alreadyReported;
  }
}

export interface LoadOptions {
  /** The environment for the child bash; absent means this process's. */
  env?: NodeJS.ProcessEnv;
  /** Capture stderr into the error instead of inheriting it (tests). */
  captureStderr?: boolean;
}

// $1 = FLEET_HOME, $2 = the repo name. set -uo pipefail: every bash caller of
// load_repo runs under it, so a config that reads an unset variable dies here
// as it dies there. The loop's own status would be that of the last `[[ -v ]]`
// — PR_CMD, usually unset — hence the explicit exit 0.
const SCRIPT = [
  'set -uo pipefail',
  'source "$1/lib.sh" || exit 1',
  'load_repo "$2" || exit 1',
  'for k in REPO_NAME REPO_ROOT $FLEET_REPO_KEYS; do',
  '  if [[ -v $k ]]; then printf \'%s\\0%s\\0\' "$k" "${!k}"; fi',
  'done',
  'exit 0',
].join('\n');

function required(m: Map<string, string>, k: string): string {
  const v = m.get(k);
  if (v === undefined) throw new ConfigError(`lib.sh handed back no ${k}`, false);
  return v;
}

/** load_repo <name>, through bash, as a typed value. Throws ConfigError. */
export function loadRepo(fleetHome: string, name: string, o: LoadOptions = {}): RepoConfig {
  const r = runSync('bash', ['-c', SCRIPT, '_', fleetHome, name], {
    ...(o.env !== undefined ? { env: o.env } : {}),
    ...(o.captureStderr ? {} : { stderr: 'inherit' as const }),
  });
  if (r.status !== 0) {
    if (o.captureStderr) throw new ConfigError(r.stderr.replace(/\n$/, ''), false);
    throw new ConfigError(`load_repo ${name} failed (status ${r.status}); its message is above`, true);
  }
  const parts = r.stdout.split('\0');
  const m = new Map<string, string>();
  // "k\0v\0k\0v\0" splits into pairs plus one trailing ''.
  for (let i = 0; i + 1 < parts.length; i += 2) m.set(parts[i] ?? '', parts[i + 1] ?? '');

  const mergeMode = required(m, 'MERGE_MODE');
  if (mergeMode !== 'direct' && mergeMode !== 'pr') throw new ConfigError(`lib.sh handed back MERGE_MODE=${mergeMode}`, false);
  const repoRules = m.get('REPO_RULES');
  const prCmd = m.get('PR_CMD');
  return {
    name: required(m, 'REPO_NAME'),
    root: required(m, 'REPO_ROOT'),
    baseBranch: required(m, 'BASE_BRANCH'),
    installCmd: required(m, 'INSTALL_CMD'),
    vitestCmd: required(m, 'VITEST_CMD'),
    buildCmd: required(m, 'BUILD_CMD'),
    lintCmd: required(m, 'LINT_CMD'),
    seedFiles: required(m, 'SEED_FILES').split(/[ \t\n]+/).filter((s) => s !== ''),
    probeDir: required(m, 'PROBE_DIR'),
    ...(repoRules !== undefined ? { repoRules } : {}),
    mergeMode,
    ...(prCmd !== undefined ? { prCmd } : {}),
  };
}
