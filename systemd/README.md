# Running the queue unattended

Four units, in two pairs, and the queue's is a template. **`fleet-queue@<repo>`**
— a timer every 15 minutes and a oneshot service that drains whatever is
`ready` in that one repo; one instance per registered repo (`repos/<repo>.env`),
so two repos drain side by side. **`fleet-bot`** — a timer
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

The service is `Type=oneshot`, so while a repo's drain is running that repo's
timer's next firing is **skipped rather than queued**. Two drains of one repo
can never overlap, and nothing in the fleet has to know about it; the
repo's launch lock (`<repo>/.git/fleet-launch.lock`) is the second guard.
Drains of different repos are different units and do run at the same time.

## Two repos at once

Each instance is capped at `MemoryHigh=3000M`: about 1.4 GB is resident outside
the units, which leaves ~6.5 GB of the 7.9 GB box, split between two drains.
One lane peaked at 1.8 GB (25 Sep), so a lane is slowed, never killed, well
above its own peak. And before each launch a drain reads `MemAvailable`: below
`LAUNCH_MIN_FREE_MB` (default 2500) it launches nothing, says so in the
journal, and leaves the repo to its next drain. A third repo is a third share:
revisit `MemoryHigh` then, or give one instance its own with
`systemctl --user edit fleet-queue@<repo>.service`. A Rust or Tauri repo
whose builds peak above 1.8 GB sets a larger `LAUNCH_MIN_FREE_MB` the same
way (`Environment=LAUNCH_MIN_FREE_MB=4000`).

## What happens after the machine restarts

Each repo's first drain of a boot starts two minutes after the user
manager does (`OnStartupSec=2min`), however long the boot took. That is also
the crash-recovery path: the first thing
`fleet run-queue` does is reap orphans, so a story stranded at `in_progress` by a
power cut is returned to the queue and resumed — its worktree reused, the
builder's existing commits intact, rounds continuing from the frontmatter
rather than restarting at one. `test/suite.sh` case 42 covers exactly that
state.

Not `OnBootSec`, and no `Persistent=true` (L-45): after a maintenance the
user manager came up six minutes after the kernel, `OnBootSec=2min` was
already past, and systemd dropped that late firing because `Persistent=true`
had left a stamp file. The queue did not run for ten hours; the bot, with no
`Persistent`, fired every minute. After any reboot,
`systemctl --user list-timers 'fleet-*'` shows the queue's next firing — a
`-` there with nothing in `journalctl --user -u 'fleet-queue@*' -b` is this
failure, and `systemctl --user start --no-block fleet-queue@<repo>.service` is the
cure. (`fleet run-queue --all` still walks every repo in `repos/` in turn,
each in its own process: a by-hand command now, not a unit.)

## Install

As the `fleet` user:

```bash
mkdir -p ~/.config/systemd/user
ln -sf ~/work/fleet/systemd/'fleet-queue@.service' ~/.config/systemd/user/
ln -sf ~/work/fleet/systemd/'fleet-queue@.timer'   ~/.config/systemd/user/
ln -sf ~/work/fleet/systemd/fleet-bot.service   ~/.config/systemd/user/
ln -sf ~/work/fleet/systemd/fleet-bot.timer     ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fleet-queue@khaita.timer     # one per repos/<repo>.env
systemctl --user enable --now fleet-bot.timer
```

### Adding a repo

Register it (`repos/<name>.env`, in its own parent directory), then
`systemctl --user enable --now fleet-queue@<name>.timer`. Nothing else: the
bot's `/run <name>` and `/promote <name> <id>` start `fleet-queue@<name>.service`.

### Migrating from the single `--all` unit

A box that ran `fleet-queue.timer` and `fleet-queue.service` (every repo, one
after another) moves to one instance per repo. After the merge, with the
live checkout fast-forwarded (both queue and bot inactive), and once, as the
`fleet` user:

```bash
systemctl --user disable --now fleet-queue.timer     # a drain in flight is not stopped; it ends by itself
rm ~/.config/systemd/user/fleet-queue.service ~/.config/systemd/user/fleet-queue.timer
ln -sf ~/work/fleet/systemd/'fleet-queue@.service' ~/.config/systemd/user/
ln -sf ~/work/fleet/systemd/'fleet-queue@.timer'   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fleet-queue@khaita.timer     # and one for each other repo in repos/
systemctl --user list-timers 'fleet-*'                     # each repo's NEXT shows a time
```

### The agent updater (a third pair)

The fleet names models by alias (`sonnet`, `opus`, `fable`, codex's own
default), and an alias is only as new as the CLI resolving it. Claude Code
updates itself; codex, an npm global under nvm, does not.
`fleet-agents-update.timer` runs `fleet update-agents` on Sundays at 04:30: it
runs `claude update` and `npm install -g @openai/codex@latest`, and does
nothing (exit 0) while any `fleet-queue@*.service` is active.

```bash
ln -sf ~/work/fleet/systemd/fleet-agents-update.service ~/.config/systemd/user/
ln -sf ~/work/fleet/systemd/fleet-agents-update.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fleet-agents-update.timer
```

### The coordinator's Remote Control server (a service, no timer)

`fleet-remote-control.service` runs `fleet remote-control`: a Claude Code
Remote Control server in `~/work`, so a coordinator's session can be opened
from claude.ai/code or the Claude app after any reboot, with nobody at a
terminal. It starts with the user manager and again 30 s after any exit;
the server keeps one session open and starts a second on demand
(`--capacity 2`, about 400 MB for the server and one session).

```bash
ln -sf ~/work/fleet/systemd/fleet-remote-control.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fleet-remote-control.service
```

Before it will stay up: `claude` must have been trusted in `~/work` once
(run `claude` there and accept). The home directory will not do — Remote
Control never saves trust for it and the server exits at once. A session
keeps the memory of its directory's project; to keep the one a session
started in `~` had, `~/work/.claude/settings.local.json` names it:

```json
{ "autoMemoryDirectory": "/home/fleet/.claude/projects/-home-fleet/memory" }
```

`systemctl --user restart fleet-remote-control` ends every open session.

The server's stdout is its screen, drawn again every second; in the journal
it was 96% of the lines and pushed the queue's history out, so both units
send it nowhere (`StandardOutput=null`). Its errors, on stderr, stay in the
journal. To see the screen, run `fleet remote-control [repo]` in a terminal.

#### One coordinator per project

`fleet-remote-control@<repo>.service` runs `fleet remote-control <repo>`: a
second server whose sessions work in the repo's checkout (`REPO_PATH` in
`repos/<repo>.env`), so they keep that directory's memory apart from the
fleet's, and which the app lists under the repo's name. `claude` must have
been trusted in that checkout once (run `claude` there and accept).

```bash
ln -sf ~/work/fleet/systemd/'fleet-remote-control@.service' ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fleet-remote-control@<repo>.service
```

Each server is about 150 MB and each session about 250 MB; on the 7.9 GB box
keep to two servers.

The models each round actually ran on are in the review's Machine block
(`builder:  sonnet → claude-sonnet-5`, `reviewer: codex → gpt-6-astra`), so
a release that changes behaviour shows up in the verdicts' history.

### The dashboard (a service, no timer)

`fleet-dashboard.service` runs `fleet dashboard serve --port 4300`: the
read-only dashboard (`README.md`, "The dashboard") on `127.0.0.1:4300`, and
only there.

```bash
ln -sf ~/work/fleet/systemd/fleet-dashboard.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fleet-dashboard.service
curl -s 127.0.0.1:4300/api/health    # {"ok":true,…} after its first read, about 10 s
```

The outside reaches it through Caddy, with a password. That is root's edit,
once, as `ubuntu`: a site of its own, so the test URL's site and the song
service's routes stay as they are. Caddy 2.6 calls the directive
`basicauth`; `caddy hash-password` makes the hash.

```
fleet.179-237-101-204.sslip.io {
	basicauth {
		<user> <hash>
	}
	reverse_proxy 127.0.0.1:4300
}
```

Then `sudo caddy validate --config /etc/caddy/Caddyfile` and `sudo
systemctl reload caddy`. A reload lets every request in flight finish, and
Caddy refuses a file with an error and keeps the old one running. It gets
the new name's certificate by itself.

The server keeps the code and the page it loaded: after the live checkout
moves, `systemctl --user restart fleet-dashboard`. Nothing waits for it, and
a restart loses nothing.

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
journalctl --user -u fleet-queue@khaita -f              # live (a repo's drains)
journalctl --user -u 'fleet-queue@*' --since today      # what every repo's drain did
journalctl --user -u fleet-bot --since today     # what was asked of it
journalctl --user -u fleet-remote-control -b     # the Remote Control server's starts, exits and errors since boot
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
systemctl --user stop fleet-queue@<repo>.timer     # re-enable with `start`
```

## Settings worth knowing

| where | what | why |
|---|---|---|
| `.timer` | `OnUnitActiveSec=15min` | how soon a promoted story is picked up |
| `.timer` | `OnStartupSec=2min`, no `Persistent` | the first drain of every boot, however late the user manager starts (L-45) |
| `.service` | `--all --max 5` | every registered repo, at most 5 stories each per drain; a ceiling against looping unattended |
| `.service` | `AGENT_TIMEOUT=3600` | wall clock per agent call (the launcher's own default is 1800; an hour since khaita 072's browser-test builder was killed at 1800 s); a hung agent's whole process group is killed by the launcher's own timer and the story goes to `needs_human` |
| `.service` | `MemoryHigh=2500M` | throttles rather than kills. ~1.4 GB is in use before the fleet starts (`free -m` on an idle box) and a Next build peaks near 1.4 GB (`docs/operations.md`) |
| `.service` | `TimeoutStartSec=6h` | a full drain is long; `AGENT_TIMEOUT` already bounds the part that can hang |
| `fleet-bot.service` | `TimeoutStartSec=2min` | a poll is one request and a few git commands. `/run` starts the queue with `--no-block`: a plain `systemctl start` on a oneshot waits for the whole drain, and the poll was killed at two minutes with its reply unsent and the bot deaf meanwhile. `/merge`'s job is a transient unit of its own (`fleet-merge-<ms>`, `DETACH_CMD`): a child left in this oneshot's cgroup is killed when the poll ends (L-34) |
| `fleet-bot.timer` | `OnUnitActiveSec=1min` | how long a phone waits for an answer |
| transient | `fleet-test-deploy` | the test server, started by `fleet test-deploy` with `systemd-run --user`; no unit file, gone after a reboot. `fleet-test-deploy-build` is `/testdeploy`'s build, one at a time by its fixed name |
| `fleet-remote-control.service` | `Restart=always`, `StartLimitIntervalSec=0` | the server is there whenever the app is opened, whatever ended it, and a long network outage does not leave the unit failed |
| `bin/remote-control.sh` | `--capacity 2` | each session took ~250 MB beside the server's ~150 MB, on a box where a drain may take 2.5 GB |
| `fleet-dashboard.service` | `--port 4300`, loopback only | Caddy publishes it with a password; the server refuses any other address |
| `fleet-dashboard.service` | `OOMScoreAdjust=500` `CPUWeight=20` `IOWeight=20` `Nice=10` `MemoryHigh=400M` `MemoryMax=512M` | last in line beside the drains, the test server and the song service. Measured 26 Oct: the server ~120 MB; ~210 MB more while a child builds the next bundle |
| `fleet-dashboard.service` | `GIT_OPTIONAL_LOCKS=0` | its git never holds the index lock that a launcher's or the bot's commit needs |
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
