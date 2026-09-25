// A sourced env file — .env.fleet, the bot's token and chat id
// (`set -a; . "$FLEET_HOME/.env.fleet"; set +a`). The file is bash: a value
// may be quoted or expand, so the one program that can read it is bash, the
// same way lib/config.ts reads .fleet/config.
// The named keys come back as NUL-separated pairs; a key the file leaves
// unset is absent from the map.
import { runSync } from './proc.ts';

const SCRIPT = [
  'set -uo pipefail',
  'set -a; . "$1" || exit 1; set +a',
  'shift',
  'for k; do',
  '  if [[ -v $k ]]; then printf \'%s\\0%s\\0\' "$k" "${!k}"; fi',
  'done',
  'exit 0',
].join('\n');

/** Throws an Error carrying bash's stderr when the file cannot be sourced. */
export function readEnvFile(file: string, keys: readonly string[], env?: NodeJS.ProcessEnv): Map<string, string> {
  const r = runSync('bash', ['-c', SCRIPT, '_', file, ...keys], { ...(env !== undefined ? { env } : {}) });
  if (r.status !== 0) throw new Error(`could not read ${file}: ${r.stderr.trim()}`);
  const parts = r.stdout.split('\0');
  const m = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) m.set(parts[i] ?? '', parts[i + 1] ?? '');
  return m;
}
