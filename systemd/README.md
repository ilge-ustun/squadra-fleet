# Running the queue unattended

Four units, in two pairs. **`fleet-queue`** — a timer every 15 minutes and a
oneshot service that drains whatever is `ready`. **`fleet-bot`** — a timer
every minute and a oneshot service that reads Telegram commands and answers
them. Nothing here is installed by an agent — installing a unit and enabling
lingering are a human's calls.

The bot is a separate pair on purpose: a drain runs for hours, and `/status`
has to answer while one is running.

## What happens when there is nothing to do

`fleet launch <repo> --reap` scans the target's `.stories/` and `/proc` and exits quickly. A
`git fetch` runs before each scan to pick up remote promotions, and `git merge`
follows if the fetch advanced the upstream. Both are fast on an idle repo. No
model call, no story processing. So an idle fleet polling every 15 minutes is
cheap, and the interval is a question of how soon you want a promoted story
picked up — not of load.

The service is `Type=oneshot`, so while a drain is running the timer's next
firing is **skipped rather than queued**. Two drains can never overlap, and
nothing in the fleet has to know about it.

## What happens after the machine restarts

`Persistent=true` makes a firing missed while the box was off run shortly
after boot. That is also the crash-recovery path: the first thing
`fleet run-queue` does is reap orphans, so a story stranded at `in_progress` by a
power cut is returned to the queue and resumed — its worktree reused, the
builder's existing commits intact, rounds continuing from the frontmatter
rather than restarting at one. `test/suite.sh` case 42 covers exactly that
state.

The queue unit runs `fleet run-queue --all`: every repo in `repos/` is drained in
turn, each in its own process, and `--max` is a per-repo ceiling.

## Install

As the `fleet` user:

```bash
mkdir -p ~/.config/systemd/user
ln -sf ~/work/fleet/systemd/fleet-queue.service ~/.config/systemd/user/
ln -sf ~/work/fleet/systemd/fleet-queue.timer   ~/.config/systemd/user/
ln -sf ~/work/fleet/systemd/fleet-bot.service   ~/.config/systemd/user/
ln -sf ~/work/fleet/systemd/fleet-bot.timer     ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fleet-queue.timer
systemctl --user enable --now fleet-bot.timer
```

### The agent updater (a third pair)

The fleet names models by alias (`sonnet`, `opus`, `fable`, codex's own
default), and an alias is only as new as the CLI resolving it. Claude Code
updates itself; codex, an npm global under nvm, does not.
`fleet-agents-update.timer` runs `fleet update-agents` on Sundays at 04:30: it
runs `claude update` and `npm install -g @openai/codex@latest`, and does
nothing (exit 0) while `fleet-queue.service` is active.

```bash
ln -sf ~/work/fleet/systemd/fleet-agents-update.service ~/.config/systemd/user/
ln -sf ~/work/fleet/systemd/fleet-agents-update.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fleet-agents-update.timer
```

The models each round actually ran on are in the review's Machine block
(`builder:  sonnet → claude-sonnet-5`, `reviewer: codex → gpt-6-astra`), so
a release that changes behaviour shows up in the verdicts' history.

### Before the bot pair will do anything

Create the bot with **@BotFather** on Telegram (`/newbot`), then send it any
message and read your own numeric id from
`https://api.telegram.org/bot<TOKEN>/getUpdates` — the `message.from.id`.
Both values go in `.env.fleet` **at the root of this fleet repo** (gitignored
here):

```
TELEGRAM_BOT_TOKEN=123456:AA…
TELEGRAM_CHAT_ID=987654321
```

Never in a target: a target's `SEED_FILES` are copied into every builder and
reviewer worktree, so a token there is a token handed to every agent.
`.env.fleet` is read by `fleet telegram` alone.

The token is write access to every registered repo, through `/promote` and
`/answer`. What
stands between it and a stranger: the bot acts only on messages whose sender
is `TELEGRAM_CHAT_ID`, answers nobody else at all, has a fixed command set
with no grammar, passes no message text to a shell, and can touch neither
`main` nor the integration branch.

**As an admin, once** — without this the units stop the moment your ssh
session ends, which defeats the point:

```bash
sudo loginctl enable-linger fleet
```

`loginctl show-user fleet` should then say `Linger=yes`.

## Watching it

```bash
systemctl --user list-timers 'fleet-*'           # when they next fire
journalctl --user -u fleet-queue -f              # live
journalctl --user -u fleet-queue --since today   # what it did
journalctl --user -u fleet-bot --since today     # what was asked of it
./fleet status <repo>                            # where every story of one repo stands
```

Or `/status <repo>` on the phone, which is the same table.

`fleet run-queue` prints a per-story summary and then `fleet status`, so the tail of
each journal entry is the whole picture.

## Running one story by hand while the timer is enabled

Safe. A launcher holds the repo's launch lock for its whole life: a drain
that starts meanwhile finds it held at its reap, says so in the journal and
leaves the repo to the next drain, and a `oneshot` service will not start a
second drain. The other way round, a hand launch while a drain is running
exits 75 and touches nothing — wait for the drain. If you want to be sure the
timer stays out of the way:

```bash
systemctl --user stop fleet-queue.timer     # re-enable with `start`
```

## Settings worth knowing

| where | what | why |
|---|---|---|
| `.timer` | `OnUnitActiveSec=15min` | how soon a promoted story is picked up |
| `.service` | `--all --max 5` | every registered repo, at most 5 stories each per drain; a ceiling against looping unattended |
| `.service` | `AGENT_TIMEOUT=1800` | wall clock per agent call; a hung agent's whole process group is killed by the launcher's own timer and the story goes to `needs_human` |
| `.service` | `MemoryHigh=2500M` | throttles rather than kills. ~1.4 GB is in use before the fleet starts (`free -m` on an idle box) and a Next build peaks near 1.4 GB (`docs/operations.md`) |
| `.service` | `TimeoutStartSec=6h` | a full drain is long; `AGENT_TIMEOUT` already bounds the part that can hang |
| `fleet-bot.service` | `TimeoutStartSec=2min` | a poll is one request and a few git commands. `/run` starts the queue with `--no-block`: a plain `systemctl start` on a oneshot waits for the whole drain, and the poll was killed at two minutes with its reply unsent and the bot deaf meanwhile. `/merge`'s job is a transient unit of its own (`fleet-merge-<ms>`, `DETACH_CMD`): a child left in this oneshot's cgroup is killed when the poll ends (L-34) |
| `fleet-bot.timer` | `OnUnitActiveSec=1min` | how long a phone waits for an answer |
| transient | `fleet-test-deploy` | the test server, started by `fleet test-deploy` with `systemd-run --user`; no unit file, gone after a reboot. `fleet-test-deploy-build` is `/testdeploy`'s build, one at a time by its fixed name |
| `fleet-bot.timer` | `Persistent=false` | a missed poll is not worth catching up; the offset means nothing is lost by being late |

## Promoting stories remotely

`fleet run-queue` fetches from origin and merges before each scan. A story
promoted from anywhere — editing frontmatter in the host's web UI from a phone,
say — is picked up on the next timer firing without anyone pulling manually.

If the fetch fails (no network, bad credentials) the drain continues on local
state and logs `refresh failed`. If the merge conflicts, it is aborted cleanly
and the drain continues on the pre-refresh checkout; local work is never lost.

The other route is the bot: `/promote <repo> <id>` writes the frontmatter,
commits and pushes for you, under the same lock the launcher's status commits
take. Every command but `/run` names its repo first.
