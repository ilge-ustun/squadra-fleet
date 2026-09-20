# fleet

An autonomous coding fleet: a bash harness that turns a one-sentence intent
into a story, has a builder agent implement it, has a reviewer agent attack
it, computes the verdict itself, and merges what passes. It runs against
**other** repositories — its first target is `khaita-app` — and is never a
target itself. It is driven from a terminal or from a phone through a
Telegram bot.

The principle that shapes everything: **the machine can veto, never grant.**
A story passes only when the baseline is green, every acceptance criterion
has a test the reviewer proved goes red, no probe found anything, and the
reviewer said PASS. Any one of those missing is a FAIL with the reason named.

Read `docs/FLEET-HANDOFF.md` for the current state and `docs/lessons.md`
(L-01 …) for why things are the way they are. This file is the map.

## The loop

```
intent ──write-story.sh──▶ .stories/<id>.md (draft)
       ──lint-story.sh───▶ cited paths exist, ACs are **ACn headed, base: is legal
       ──a human────────▶ status: ready   (at a terminal, or /promote from the phone)
       ──launch.sh───────▶ worktree from origin/<base>; builder; baseline; scope;
                           reviewer; mutation runner; probe runner; computed verdict
                           → .review/<id>.md, committed with the status
       ──merge.sh────────▶ story → its epic, on a computed PASS (the queue does this)
       ──a human────────▶ epic → integration branch, or a develop story → develop
                           (merge.sh --epic / --land, or /merge from the phone)
```

`run-queue.sh` drains every `ready` story of a repo and calls `merge.sh` on
each computed PASS. Two systemd timers (`systemd/`) run the queue every
15 minutes and the bot every minute; nothing in the fleet lands anything on
the integration branch by itself.

## Story versus epic

A **story** is one file, `.stories/<id>.md`, with frontmatter (`status`,
`round`, optional `base`, `scope_deny`, `model`; `merged:` is written by
`merge.sh`) and acceptance criteria headed `**ACn — …**`, each naming the
instrument that proves it and the mutation that turns it red. Its branch is
`story/<id>`, cut by the launcher from `origin/<base>`.

An **epic** is a branch named `epic/<name>` and nothing more: no file, no
record. Stories name it with `base:`; `status.sh` derives everything else
from git. The name is enforced where a story is born: `write-story.sh --base`
takes only `epic/*`, `lint-story.sh` rejects any other base, and
`new-epic.sh` is the one way an epic branch is created.

How each lands:

| what | to | by whom | command |
|---|---|---|---|
| story on an epic | its epic | the queue, on a computed PASS | `merge.sh <repo> <id>` |
| story on the integration branch | the integration branch | a human | `merge.sh <repo> <id> --land` · `/merge <repo> <id>` |
| epic | the integration branch | a human | `merge.sh <repo> --epic epic/<name>` · `/merge <repo> epic/<name>` |
| main / master | — | nobody, ever | refused with or without `--land` |

Every merge runs the suite, build and lint on the **merged** result in a
throwaway worktree and pushes only if that is green (`MERGE_MODE=direct`).
A repo can instead ask for a request on its host (`MERGE_MODE=pr`, below).

`status.sh` shows a story's landing state, derived on every run: `awaiting
merge` (PASS, nobody merged), `on epic` (merged into an epic not yet in the
integration branch), `landed`, or its frontmatter status as is.

## Commands

Every entry point names the repo first. The phone forms go through
`telegram.sh poll`; only messages from `TELEGRAM_CHAT_ID` are acted on.

| at a terminal | from the phone | what |
|---|---|---|
| `status.sh <repo> [id]` | `/status <repo>` | the epics, then every story: title, landing state, round, verdict, base |
| `status.sh <repo> --json` · `--epics` · `--bot` | | for machines · the epic block only · the phone form |
| `write-story.sh <repo> <id> "<intent>" [--base epic/<name>]` | | intent → draft story |
| `lint-story.sh <repo> <id> [--strict]` | | mechanical checks |
| `new-epic.sh <repo> <name>` | | `origin/epic/<name>`, cut from the integration branch |
| edit `status: ready` | `/promote <repo> <id>` | into the queue |
| `launch.sh <repo> <id>` | | one story, one round at a time (detached, see the handoff) |
| `run-queue.sh <repo>` · `--all` | `/run` | drain the queue |
| `status.sh <repo> <id>` | `/why <repo> <id>` | the latest round's machine block |
| answer in `.blocked/<id>.md`, set ready | `/answer <repo> <id> <text>` | unblock a story |
| `merge.sh <repo> <id> --land` | `/merge <repo> <id>` | a develop story → the integration branch |
| `merge.sh <repo> --epic epic/<name>` | `/merge <repo> epic/<name>` | an epic → the integration branch |
| `revert.sh <repo> <id>` | `/revert <repo> <id>` | undo a story's merge into its epic |
| `reset.sh <repo> <id>` | | back to the queue |

Run a launcher detached, never as a child of an interactive agent session:

```bash
cd ~/work/fleet && setsid nohup bash -c 'bash launch.sh khaita 0NN; echo "exit=$?"' > log 2>&1 < /dev/null &
```

## What a target provides

`repos/<name>.env` here holds `REPO_PATH=/abs/path` and nothing else. The
target itself carries, on its integration branch:

```
.fleet/config        sourced by lib.sh:load_repo — every key below
.fleet/rules.md      optional, REPO_RULES: rules rendered into the agents' prompts
.stories/TEMPLATE.md the shape a story takes; write-story.sh gives it to the agent
.stories/ .review/ .blocked/   committed fleet state
.runs/ .review-out/            machine-local, gitignored
```

`.fleet/config` is env-style and sourced; a variable already in the caller's
environment wins over the file; a missing required key is a `die`.

| key | required | meaning |
|---|---|---|
| `BASE_BRANCH` | yes | the integration branch (`develop`); fleet state lives only here |
| `INSTALL_CMD` | yes | run in every fresh worktree (`npm ci`) |
| `VITEST_CMD` | yes | must accept `<selector> --reporter json --outputFile <f>` and write vitest's JSON shape |
| `BUILD_CMD` `LINT_CMD` | yes | the rest of the baseline |
| `SEED_FILES` | stated, may be empty | untracked files copied into every worktree (`.env.local`) — never a token |
| `PROBE_DIR` | yes | where a reviewer's probe lands, inside the suite's include glob |
| `REPO_RULES` | no | markdown file rendered into the agent prompts |
| `MERGE_MODE` | no, default `direct` | `direct`: merge, post-merge baseline, push. `pr`: push the branch, run `PR_CMD` |
| `PR_CMD` | with `pr` | see below |

### `PR_CMD`

Run by `merge.sh` in the target checkout, non-interactive, with the source
branch **appended** as the last argument and `PR_SOURCE` / `PR_TARGET` in
its environment; whatever it prints — the request's URL — is the reply.
Nothing is merged and nothing recorded: the host merges, and `status.sh`
derives `landed` from origin afterwards. The flags come from
`glab mr create --help` / `gh pr create --help` (gh 2.101, glab 1.118):

```bash
MERGE_MODE=pr
PR_CMD='glab mr create --fill --yes --remove-source-branch --target-branch "$PR_TARGET" --source-branch'
# or, on GitHub:
PR_CMD='gh pr create --fill --base "$PR_TARGET" --head'
```

`gh` and `glab` live in `~/.local/bin`; their tokens are the human's, kept in
the CLIs' own config files, never in `.env.fleet` or a target.

## Adding a repo

1. `repos/<name>.env` with `REPO_PATH`. Two repos may not share a parent
   directory (their `../wt-<id>` worktrees would collide); `load_repo` refuses.
2. In the target, on its integration branch: `.fleet/config` with every key
   above, `.stories/TEMPLATE.md`, `.gitignore` entries for `.runs/`,
   `.review-out/` and the seed files, and a `PROBE_DIR` the suite collects.
3. `bash status.sh <name>` — it loads or says which key is missing.
4. `bash new-epic.sh <name> <epic>`, then `write-story.sh … --base epic/<epic>`.

## What needs a human

- Promoting a story to `ready` — reading it is the review that matters.
- Landing an epic, or a develop story, on the integration branch.
- Answering `.blocked/<id>.md` and `needs_human` stops; the notification
  carries the command that answers it.
- Installing the systemd units and enabling lingering (`systemd/README.md`).
- Tokens: the bot's in `.env.fleet` (mode 600), `gh`/`glab` logins.

## Tests and working rules

`bash test-lib.sh` runs the suite (fake agents in `test/`, re-executed under
`env -i`); its last line is the count. Green before every commit; a case
that has never been observed red is not a case. Never edit `launch.sh`
while a launcher is running it. `die` over `warn`. Prompts on stdin, never
argv. One task, one commit. `docs/lessons.md` holds the rest.

## Where things are

```
lib.sh          load_repo, the frontmatter reader, procs_in_worktree, log/warn/die
launch.sh       the launcher              run-queue.sh   the drain
write-story.sh  intent → story            lint-story.sh  mechanical checks
new-epic.sh     an epic branch            status.sh      what the fleet is doing
merge.sh        story → epic, --land, --epic, MERGE_MODE
revert.sh       undo a story's merge      reset.sh       back to the queue
telegram.sh     send | poll — the notifications and the phone commands
render.sh       render_prompt()           prompts/       the agents' prompts, README = the verdict contract
test-lib.sh     the suite                 test/          fake claude, codex, vitest, curl
systemd/        the two timer pairs       docs/          handoff, lessons, plans
```
