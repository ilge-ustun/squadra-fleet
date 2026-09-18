# Running the queue unattended

Two units: a **timer** that fires every 15 minutes and a **oneshot service**
that drains whatever is `ready`. Nothing here is installed by an agent —
installing a unit and enabling lingering are a human's calls.

## What happens when there is nothing to do

`fleet/launch.sh --reap` scans `.stories/` and `/proc` and exits. Measured:
**0.08 seconds**. No `git fetch`, no model call, no cost. So an idle fleet
polling every 15 minutes is free, and the interval is a question of how soon
you want a promoted story picked up — not of load.

The service is `Type=oneshot`, so while a drain is running the timer's next
firing is **skipped rather than queued**. Two drains can never overlap, and
nothing in the fleet has to know about it.

## What happens after the machine restarts

`Persistent=true` makes a firing missed while the box was off run shortly
after boot. That is also the crash-recovery path: the first thing
`run-queue.sh` does is reap orphans, so a story stranded at `in_progress` by a
power cut is returned to the queue and resumed — its worktree reused, the
builder's existing commits intact, rounds continuing from the frontmatter
rather than restarting at one. `fleet/test-lib.sh` case 42 covers exactly that
state.

## Install

As the `fleet` user:

```bash
mkdir -p ~/.config/systemd/user
ln -sf ~/work/khaita/khaita-app/fleet/systemd/fleet-queue.service ~/.config/systemd/user/
ln -sf ~/work/khaita/khaita-app/fleet/systemd/fleet-queue.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fleet-queue.timer
```

**As an admin, once** — without this the units stop the moment your ssh
session ends, which defeats the point:

```bash
sudo loginctl enable-linger fleet
```

`loginctl show-user fleet` should then say `Linger=yes`.

## Watching it

```bash
systemctl --user list-timers fleet-queue.timer   # when it next fires
journalctl --user -u fleet-queue -f              # live
journalctl --user -u fleet-queue --since today   # what it did
./fleet/status.sh                                # where every story stands
```

`run-queue.sh` prints a per-story summary and then `status.sh`, so the tail of
each journal entry is the whole picture.

## Running one story by hand while the timer is enabled

Safe. The launcher refuses to touch a story whose worktree has live processes,
and a `oneshot` service will not start a second drain. If you want to be sure
the timer stays out of the way:

```bash
systemctl --user stop fleet-queue.timer     # re-enable with `start`
```

## Settings worth knowing

| where | what | why |
|---|---|---|
| `.timer` | `OnUnitActiveSec=15min` | how soon a promoted story is picked up |
| `.service` | `--max 5` | stories per drain; a ceiling against looping unattended |
| `.service` | `AGENT_TIMEOUT=1800` | wall clock per agent call; a hung agent is killed and the story goes to `needs_human` |
| `.service` | `MemoryHigh=2500M` | throttles rather than kills. ~1.4 GB is committed before the fleet starts (`docs/fleet/FLEET-HANDOFF.md` §2) and a Next build peaks near 1.4 GB |
| `.service` | `TimeoutStartSec=6h` | a full drain is long; `AGENT_TIMEOUT` already bounds the part that can hang |

## Not done, and needed before this is useful remotely

The units run whatever is `ready` **in the local checkout**. Promoting a story
from elsewhere — editing frontmatter in the GitLab web UI from a phone, say —
will not be seen until someone pulls.

Adding `git pull --ff-only` to the start of `run-queue.sh` is the obvious
bridge, and it is deliberately not here yet: the launcher makes its own status
commits and pushes them, so a pull has to cope with divergence rather than
assume a fast-forward. That is the first piece of a control plane, and it
wants its own story and its own test rather than a line added quietly.
