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
| story on an epic | its epic | the queue, on a computed PASS | `fleet merge <repo> <id>` |
| story on the integration branch | the integration branch | a human | `fleet merge <repo> <id> --land` · `/merge <repo> <id>` |
| epic | the integration branch | the coordinator (delegated) or a human | `fleet merge <repo> --epic epic/<name>` · `/merge <repo> epic/<name>` |
| `main` / `master` | — | nobody | refused |

Landing an epic is delegated to you (`fleet-coordinate`, 20 Oct 2026):
the full e2e on its tip, then the merge, detached. Landing a single story on
the integration branch stays the human's; tell them the state and the
command.

## Reading the state

```bash
./fleet status <repo>            # the epic block first: "N stories, N merged, N ahead of <base>"
./fleet status <repo> --epics
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

`MERGE_MODE=pr` in `.fleet/config` makes `fleet merge` push the branch and
open a request with `PR_CMD` instead of merging; the reply is the URL. It
needs the host CLI logged in (`glab auth status`) — a human's step.

## When a merge fails or is interrupted

A merge runs `INSTALL_CMD`, the suite, build and lint on the merged tree,
so it takes minutes. From the phone it runs detached and answers on its
own. If it dies part way — killed, or the box rebooted — it leaves
`merge-<name>` and sometimes `wt-<id>` worktrees behind and nothing landed.
Recovery:

```bash
git -C <target> worktree list
git -C <target> worktree remove --force ../merge-<name>     # only when nothing runs in it
git -C <target> worktree prune
./fleet merge <repo> --epic epic/<name>                      # delegated for an epic; run detached, never inside a session
```

Check that nothing is still running in a worktree before removing it.
`fleet status <repo>` shows `RUNNING` on the story's row while anything is;
to see the processes, find them by cwd — the worktree path never appears
in an agent's command line (L-04):

```bash
wt="$(readlink -f <target>/../wt-<id>)"
for p in /proc/[0-9]*; do c="$(readlink "$p/cwd" 2>/dev/null)"; [[ "$c" == "$wt" || "$c" == "$wt"/* ]] && echo "${p#/proc/}"; done
```

## Undo

- `fleet revert <repo> <id>` · `/revert <repo> <id>` — reverts the merge
  commit recorded in the story's `merged:`, exactly what was merged, even if
  the epic moved on. No baseline is re-run; the next merge into that epic
  runs one.
- `fleet reset <repo> <id> [--force] [--draft]` — a story back to the queue:
  removes its worktree and branch, resets the frontmatter, deletes the
  review. Refuses while something runs in the worktree, and refuses to
  drop unmerged commits without `--force`.
- A landed integration-branch story or a landed epic is reverted by a
  human in git.
