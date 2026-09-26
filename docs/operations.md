# Operations

What the fleet runs on, what runs it unattended, what is still open, and the
decisions that shaped it. `README.md` is the map, `docs/lessons.md`
(L-01 …) the reasons. A target's state — its epics, stories, rounds and
verdicts — is never written down here: `./fleet status <repo>` computes it,
and numbers in prose rot (L-11).

## Orient by running things

```bash
cd ~/work/fleet
./fleet status <repo> --bot --all     # every story: landing state, round, computed verdict
bash test/suite.sh                    # the harness's own suite; the count is on its last line
git log --oneline -15
systemctl --user is-active fleet-bot.service fleet-queue.service
systemctl --user list-timers 'fleet-*'
```

## The machine

**VPS:** Ubuntu 24.04, 2 CPU / 3.8 GB / 60 GB + 8 GB swap. Users `ubuntu`
(admin), `fleet` (the agents and every checkout under `~/work`), `hermes`.

**Installed under `fleet`:** Claude Code (it updates itself), Codex (an npm
global under nvm; `fleet update-agents` updates it weekly), Node under nvm
(the version in `.nvmrc`, which the units carry on `PATH`), flock
(util-linux), jq (the suite only), `gh` and `glab` in `~/.local/bin`. `gh`
is logged in to github.com (the fleet's own PRs); `glab` is not. No Gemini
CLI, no OpenCode, no local models — the RAM rules them out.

**Remotes and keys:** this repo pushes to `github.com/ilge-ustun/squadra-fleet`
through a write-enabled deploy key bound to the host alias
`github.com-squadra-fleet`. Each target keeps its own deploy key. Deploy keys
push; they cannot open a request — that is what the `gh`/`glab` logins are
for.

**Memory, measured:** an interactive Claude Code session is ~530 MB; a Next
build peaks near 1.4 GB. **Never run a launcher as a child of the session
driving it** — the session's low-memory policy killed one mid-builder.
Detached, always:

```bash
cd ~/work/fleet && setsid nohup bash -c './fleet launch <repo> <id>; echo "exit=$?"' > log 2>&1 < /dev/null &
```

A coordinator on any harness starts no launcher at all: a human promotes,
and the queue timer or `/run` does the rest.

## Unattended

`systemd/` holds three timer/service pairs, installed as user units with
lingering on (`systemd/README.md`):

- `fleet-queue` — `fleet run-queue --all --max 5` every 15 minutes: reaps
  orphans, runs every `ready` story lowest id first, merges each computed
  PASS into its epic. A stopped story does not stop the queue; crash resume
  is tested (case 42). `AGENT_TIMEOUT` wraps both agent calls.
- `fleet-bot` — `fleet telegram poll` every minute:
  `/status /status-all /why /promote /answer /merge /revert /run /repo /help`;
  only `TELEGRAM_CHAT_ID` is answered. `/merge` detaches and reports when
  the post-merge baseline ends. Nothing in the notifier can fail a run.
- `fleet-agents-update` — `fleet update-agents` weekly, only while the
  queue is idle: the model aliases mean "the newest this CLI knows", and
  codex never updates itself.

## What needs a human, fleet-wide

- **Log `glab` in** before a GitLab target switches to `MERGE_MODE=pr`:
  `glab auth login --hostname gitlab.com --token` with a project token
  (`api` scope, Developer role), then `MERGE_MODE=pr` and the `PR_CMD` from
  `README.md` in that target's `.fleet/config`, and one `/merge` to see the
  URL come back.
- **The first coordinator trial on Codex.** Before it, from inside the
  session `docs/COORDINATORS.md` gives (`codex -C ~/work/fleet --add-dir
  ~/work …`), check once that it lists the five skills and that `git push`
  and `./fleet write-story` work. Then the protocol on the same page.

What a target needs from a human — epics to land, stories to order,
deploys — belongs to that target, not here.

## Harness gaps still open

- **Pre-commit hooks in the builder session.** A `PreToolUse` hook on
  `git commit` running `VITEST_CMD` would have saved at least one round
  (baseline test and build RED). Decide once enough stories show whether
  giving the builder the reviewer's checks already brought rounds down.
- **`.blocked/` has never fired from a builder**; the writer escalates
  instead. The mechanism is tested (case 3), never exercised by a real agent
  (L-24).
- **Lanes.** One, and enforced: the launch lock is the lane (L-31). The
  trigger for a second, stated in advance: ≥3 stories `ready` for a day and
  peak RSS under 1.2 GB per lane (one lane peaked at 1.8 GB on 25 Sep). A
  second lane needs a second slot in the lock and a claim under the fleet
  lock — two launchers could then pass the status check together.
- **`fleet reset` and `fleet status` look only at `wt-<id>`.** `reset
  --force` during a review removes the branch under a live launcher, and
  `RUNNING` misses the review phase. `reset` should take the launch lock.
- **The queue's own merge takes no fleet lock.** The bot holds it around
  `/merge`; the queue's `fleet merge`, after its launch has exited and let
  go of the launch lock, commits the `merged:` record without it.
- **The runner contract.** `VITEST_CMD` must accept
  `<selector> --reporter json --outputFile <f>` and write vitest's JSON
  shape. Another runner needs an adapter in `ts/src/lib/vitest-json.ts`,
  the one place a runner's JSON becomes a class.

## Decided, and why

- **TypeScript, run as is.** Node strips the types as it loads
  `ts/src/**/*.ts`: no build, no `dist/`, nothing stale to deploy. `tsc`
  only type-checks. The human's language, and one toolchain across the
  harness and its web-app targets.
- **Zero runtime dependencies.** A call from a systemd timer or a builder's
  session must work whether or not `npm ci` ever ran; the suite proves it on
  every run.
- **The agent CLIs, not the SDKs.** `ts/src/lib/agents.ts` spawns `claude`
  and `codex` from `PATH`. The SDKs were weighed and declined:
  `@anthropic-ai/claude-agent-sdk` runs a CLI it bundles (234 MB) over its
  own protocol and needs three peer packages, `@openai/codex-sdk` pins its
  own codex, both would put `node_modules` in the live checkout and every
  fixture, and the suite's fakes could no longer shadow the real binaries
  (L-14). Switching would first have to show the fakes standing in through
  the SDKs' executable-path options, subscription login working through the
  bundled CLIs, and what `npm ci` in the live checkout costs.
- **A refused agent: pause, and the human chooses.** When the reviewer's
  provider refuses the call, the round is not counted, the story waits at
  `needs_human` with line 3 `UNAVAILABLE`, the queue starts nothing, and
  one message offers `/wait` (hold until the reset, then review this story
  first) or `/fallback` (Claude reviews it). Nothing falls back on its
  own: builder and reviewer on different vendors is the check, and giving
  that up is the human's call, per story (L-32). When Claude refuses the
  builder, a message is all that follows — no retry, no fallback, no hold
  (the human's decision, 25 Sep).
- **One launch per repo: a lock, not a claim.** `fleet launch` holds
  `<target>/.git/fleet-launch.lock` for its whole life; another launch —
  a drain's `--reap` included — says who holds it, exits 75 and touches
  nothing, and the queue leaves the repo to its next drain (L-31). A
  check-and-set claim under the fleet lock was weighed and left out: with
  one launcher per repo nothing else writes a `ready` story's status
  (`/promote` and `/answer` refuse `in_progress`), so it would guard
  against a writer that does not exist. A second lane needs it.
- **`/run` enqueues, never waits.** `QUEUE_START_CMD` defaults to
  `systemctl --user start --no-block fleet-queue.service`. A oneshot's
  `start` waits for the whole unit, and the poll's two-minute timeout
  killed it mid-drain with its reply unsent (L-33). A drain already running
  makes the start a no-op; the reply is still true.
- **What stays bash:** `./fleet` itself, `bin/lib.sh`'s `load_repo` (a
  target's `.fleet/config` is sourced bash), the two chores in `bin/`, and
  the suite, which runs every command end to end with fake agents.
