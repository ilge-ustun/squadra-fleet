// What a target's git history says about a story, for the event log: the
// times the fleet's own commits record. Read-only; a git that fails is an
// unknown, never a die — a reader of the past must not stop the present.
import { fieldOfText } from './frontmatter.ts';
import { runSync } from './proc.ts';

/** `git show <sha>:<path>`; undefined when the commit has no such file. */
function showAt(root: string, sha: string, path: string): string | undefined {
  const r = runSync('git', ['-C', root, 'show', `${sha}:${path}`]);
  return r.status === 0 ? r.stdout : undefined;
}

/** When the story became ready: the oldest commit of the unbroken run of
 *  commits, newest first from HEAD, whose story file says `status: ready`.
 *  Undefined when HEAD's story is not ready — a status edited and not yet
 *  committed, say — or nothing can be read. At most `max` commits are read. */
export function readySince(root: string, id: string, max = 30): Date | undefined {
  const path = `.stories/${id}.md`;
  const r = runSync('git', ['-C', root, 'log', `-n${max}`, '--format=%H %ct', 'HEAD', '--', path]);
  if (r.status !== 0) return undefined;
  let since: Date | undefined;
  for (const line of r.stdout.split('\n')) {
    const [sha, ct] = line.split(' ');
    if (sha === undefined || sha === '' || ct === undefined) continue;
    const text = showAt(root, sha, path);
    if (text === undefined || fieldOfText(text, 'status') !== 'ready') break;
    since = new Date(Number(ct) * 1000);
  }
  return since;
}
