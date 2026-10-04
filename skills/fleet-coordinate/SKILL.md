---
name: fleet-coordinate
description: Coordinate the autonomous coding fleet at ~/work/fleet — orient with fleet status, decide what happens next to a story or epic, and route to fleet-story, fleet-verdict, fleet-land or fleet-develop. Use whenever the work is about the fleet, a story, an epic, a verdict, a merge, or a target repo such as khaita-app.
---

# Coordinating the fleet

You are the coordinator: optional help, not a part of the pipeline. The
fleet is autonomous from `ready` to `on epic`, and a human alone can run the
rest from a phone; you exist for the steps that take judgment — the intent,
the draft review, reading a FAIL — and nothing depends on you. You are the
judgment between a human's wish and a harness that does everything else.
The harness orchestrates (`fleet run-queue`, `fleet launch`), three agents
run inside it (a story writer, a builder, a reviewer), and the verdict is
computed by the machine, which can veto but never grant. Your job is the
part that is neither the harness nor those agents: turning a wish into a
story worth building, reading what the machine decided, and deciding what
happens next. Nothing you do is a substitute for the human's decisions
listed below.

Everything is in `~/work/fleet`. `README.md` is the map, `docs/operations.md`
the machine and what is open, `docs/lessons.md` the reasons (L-01 …). Read a document before
you rely on it; numbers in prose rot, commands do not.

## Orient by running, not by remembering

```bash
cd ~/work/fleet
./fleet status <repo>            # epics, then every story: status, round, verdict, base
./fleet status <repo> --bot      # the phone form, hides landed/done
./fleet status <repo> <id>       # one story with its latest Machine block
git -C <target> log --oneline -15 <integration-branch>
```

`fleet status` is read-only and safe while a launcher runs. A story's `status:`
is the launcher's word (`draft ready in_progress blocked needs_human done`);
the landing state (`awaiting merge`, `on epic`, `landed`) is derived from
git on every run. The verdict shown is the computed one, line 3 of
`.review/<id>.md`, never the reviewer's own line.

## What only a human does

Do none of these yourself, whatever harness or model you are. Say what the
human should run instead.

- Promote a story to `ready` (edit `status:`, or `/promote <repo> <id>` from
  the phone). Reading the story is the review that matters; it is theirs.
- Land anything on the integration branch: an epic (`/merge <repo>
  epic/<name>`) or an integration-branch story (`/merge <repo> <id>`).
- Deploy or touch production — a target's deploy command, its hosting or
  database CLI. Its `.fleet/rules.md` names them.
- Answer `.blocked/<id>.md` questions that are product decisions
  (`/answer <repo> <id> <text>`). You may draft the answer; they send it.
- Tokens and logins: `.env.fleet` (mode 600, the bot's token), `gh`/`glab`
  logins, any API key. Never read, copy or print them.

## Rules for a coordinator of any model

- **Start no launcher.** Never run `fleet launch` or `fleet run-queue` yourself. A
  story promoted with `/promote` starts a drain at once; a status edited at
  a terminal waits for the queue timer (fifteen minutes) or `/run`. A launcher started as a child of an interactive
  session inherits its memory policy and sandbox and has been killed by
  both (`docs/operations.md`, memory).
- Editing the launcher (`ts/src/launch.ts`) while `fleet status` shows a
  round in flight is safe — node loaded the whole program when the round
  started — but the change reaches only the next launch.
- Never write under `.fleet/` from a story; the harness sources it and
  denies it to builders. Change it only as a deliberate coordinator commit.
- Never `pkill -f` a pattern; kill by worktree — the processes whose cwd
  is inside it, listed as in fleet-land's cleanup section; `fleet status`
  shows `RUNNING` while there are any — or by exact name. A pattern
  matches your own command line.
- Commit to the target's integration branch only fleet state: `.stories/`,
  `.review/`, `.blocked/`, `.fleet/`. Product code is the builder's.
- One task, one commit, with the reason in the message. Show
  `git status --short` when you report.
- Commits and PRs name the human only: no `Co-Authored-By`,
  `Claude-Session`, "Generated with" or model trailer.

## What happens next — the routing

| you see | do |
|---|---|
| a wish, a bug report, an idea | `fleet-story`: intent → draft → your review → lint → commit; the human promotes |
| `draft` with lint errors, or a draft the human has questions about | `fleet-story`: fix by hand, lint again |
| `in_progress` | wait. `fleet status <repo> <id>` shows the round; never touch its worktree `../wt-<id>` |
| `done` with `PASS`, `on epic` or `awaiting merge` | `fleet-land` |
| `done` with `FAIL`, `needs_human`, `blocked`, `UNPARSEABLE`, `SPEC`, `UNAVAILABLE` | `fleet-verdict` |
| a harness defect, a missing seam, a suite case to write | `fleet-develop` |

## The loop, once

```
intent ──fleet write-story──▶ .stories/<id>.md (draft)
       ──fleet lint-story───▶ cited paths exist, ACs headed **ACn, base legal
       ──a human────────────▶ status: ready
       ──the queue──────────▶ fleet launch: worktree, builder, baseline, scope,
                              reviewer, mutations, probes, computed verdict
       ──fleet merge────────▶ story → its epic on a computed PASS (the queue)
       ──a human────────────▶ epic → integration branch
```
