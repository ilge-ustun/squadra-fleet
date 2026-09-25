---
name: fleet-land
description: Landing in the fleet — what awaiting merge, on epic and landed mean, which merges the queue does and which a human does, how an epic lands with /merge, what a failed merge leaves behind and how to clean it, revert and reset. Use when asked to merge, land, revert, or when status shows worktrees or branches that should be gone.
---

# Landing stories and epics

Every merge runs the suite, build and lint on the **merged** result in a
throwaway worktree and pushes only if that is green. Nothing in the fleet
lands anything on the integration branch by itself.

| what | to | by whom | command |
|---|---|---|---|
| story on an epic | its epic | the queue, on a computed PASS | `merge.sh <repo> <id>` |
| story on the integration branch | the integration branch | a human | `merge.sh <repo> <id> --land` · `/merge <repo> <id>` |
| epic | the integration branch | a human | `merge.sh <repo> --epic epic/<name>` · `/merge <repo> epic/<name>` |
| `main` / `master` | — | nobody | refused |

Landing is the human's decision; you tell them the state and the command.

## Reading the state

```bash
bash status.sh <repo>            # the epic block first: "N stories, N merged, N ahead of <base>"
bash status.sh <repo> --epics
git -C <target> worktree list    # should be only the checkout when nothing is in flight
```

- `awaiting merge` — done, PASS, branch still there, nobody merged it. On
  an epic this means the queue's auto-merge did not run (AUTO_MERGE off, or
  the merge's post-merge baseline was red — read `.runs/`).
- `on epic` — merged into its epic; the epic has not landed. When every
  story of the epic reads `on epic`, the epic is ready: `/merge <repo>
  epic/<name>`.
- `landed` — in the integration branch. Nothing to do.
- `done` — a FAIL nobody merged, or a hand merge with no `merged:` sha.

`MERGE_MODE=pr` in `.fleet/config` makes `merge.sh` push the branch and
open a request with `PR_CMD` instead of merging; the reply is the URL. It
needs the host CLI logged in (`glab auth status`) — a human's step.

## When a merge fails or is interrupted

A merge runs `INSTALL_CMD`, the suite, build and lint on the merged tree,
so it takes minutes. From the phone it runs detached and answers on its
own. If it dies part way (it did on 22 Sep, killed at a systemd timeout
before that was fixed), it leaves `merge-<name>` and sometimes `wt-<id>`
worktrees behind and nothing landed. Recovery:

```bash
git -C <target> worktree list
git -C <target> worktree remove --force ../merge-<name>     # only when nothing runs in it
git -C <target> worktree prune
bash merge.sh <repo> --epic epic/<name>                       # the human's call; run detached, never inside a session
```

Check that nothing is still running in a worktree before removing it.
`status.sh <repo>` shows `RUNNING` on the story's row while anything is;
to see the processes, find them by cwd — the worktree path never appears
in an agent's command line (L-04):

```bash
wt="$(readlink -f <target>/../wt-<id>)"
for p in /proc/[0-9]*; do c="$(readlink "$p/cwd" 2>/dev/null)"; [[ "$c" == "$wt" || "$c" == "$wt"/* ]] && echo "${p#/proc/}"; done
```

## Undo

- `revert.sh <repo> <id>` · `/revert <repo> <id>` — reverts the merge
  commit recorded in the story's `merged:`, exactly what was merged, even if
  the epic moved on. No baseline is re-run; the next merge into that epic
  runs one.
- `reset.sh <repo> <id> [--force] [--draft]` — a story back to the queue:
  removes its worktree and branch, resets the frontmatter, deletes the
  review. Refuses while something runs in the worktree, and refuses to
  drop unmerged commits without `--force`.
- A landed develop story or a landed epic is reverted by a human in git.
