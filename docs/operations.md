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

**Git identity and attribution:** each repo's `.git/config` `[user]` is
the human's, as each host knows them: `ilge ustun` with the GitHub noreply
address in this repo, `turrandott` with the GitLab noreply address
(`5645500-turrandott@users.noreply.gitlab.com`) in khaita-app. A host
always links its own noreply address to the account. There is no global
gitconfig, and a harness commit with no identity is fatal, so change the
`[user]`, never unset it.
`~/.claude/settings.json` sets `attribution` to
`{"commit": "", "pr": "", "sessionUrl": false}`; `builderArgv` passes the
same with `--settings` to every claude the fleet starts.

**Memory, measured:** an interactive Claude Code session is ~530 MB; a Next
build peaks near 1.4 GB. **Never run a launcher as a child of the session
driving it** — the session's low-memory policy killed one mid-builder.
Detached, always:

```bash
cd ~/work/fleet && setsid nohup bash -c './fleet launch <repo> <id>; echo "exit=$?"' > log 2>&1 < /dev/null &
```

A coordinator on any harness starts no launcher at all: a human promotes,
and the queue timer or `/run` does the rest.

**The test URL.** `fleet test-deploy <repo> <branch>` and `/testdeploy`
serve a branch as the user unit `fleet-test-deploy` on `127.0.0.1:4100`.
Caddy publishes it at `https://179-237-101-204.sslip.io` and holds a Let's
Encrypt certificate, which it renews on its own. sslip.io is a public DNS
service that resolves a name to the IP written inside it, so no DNS record
of ours is involved. `.env.fleet` names the URL:
`TEST_DEPLOY_URL=https://179-237-101-204.sslip.io`. The site is open, with
no password: it is the same app as production, reading the same Firestore.
When nothing is deployed, Caddy answers 502.

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

- **The test URL's web server, once, as `ubuntu`.** The fleet user has no
  sudo. Install Caddy, open 80 and 443 (Let's Encrypt checks port 80; the
  site is on 443), and hand it the name:

  ```bash
  sudo apt install -y caddy
  printf '179-237-101-204.sslip.io {\n\treverse_proxy 127.0.0.1:4100\n}\n' | sudo tee /etc/caddy/Caddyfile
  sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
  sudo systemctl reload caddy
  ```

  Then `curl -sI https://179-237-101-204.sslip.io` from anywhere should show
  a 502 (nothing deployed yet) with a valid certificate. If it times out, the
  provider's firewall (the Infomaniak manager) may need 80 and 443 opened too.
  sslip.io is not on the Public Suffix List, but Let's Encrypt has raised its
  limit to 250,000 certificates (sslip.io, 27 Sep). If issuance is still
  refused, the same Caddyfile with `179-237-101-204.nip.io`, and that URL in
  `.env.fleet`, is the fallback.

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

- **Pre-commit hooks in the builder session** were the open answer to a
  round lost on a RED baseline. The baseline fix loop (below, 15 Oct) now
  sends a RED back to the builder inside the round; a hook is only worth
  weighing again if fixes keep running out.
- **`.blocked/` has never fired from a builder**; the writer escalates
  instead. The mechanism is tested (case 3), never exercised by a real agent
  (L-24).
- **Lanes.** One, and enforced: the launch lock is the lane (L-31). The
  trigger for a second, stated in advance: ≥3 stories `ready` for a day and
  peak RSS under 1.2 GB per lane (one lane peaked at 1.8 GB on 25 Sep). A
  second lane needs a second slot in the lock and a claim under the fleet
  lock — two launchers could then pass the status check together.
  Lanes across repos are planned (15 Oct 2026, a second project, a Tauri
  app): `docs/handoff-parallel-tauri.md` is the brief.
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
- **E2E_CMD runs in khaita's baselines** since story 062 (cases 152, 153):
  063–071 ran it green, 39–97 s a run on this box. Each run is bounded by
  `E2E_TIMEOUT` (default 900 s) and swept for leftover processes, because
  khaita 062's writer saw a leaked server hang a run (case 154). A builder
  whose instruments are browser tests runs e2e for every TDD check; 072's
  was killed at 1800 s mid-work, so the queue unit gives agents 3600 s.
  Still open: a suite run against the `/testdeploy` URL after a test
  deploy, the live-data smoke, is not built.

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
- **A refused status push follows origin; it never rewrites.** When origin's
  integration branch moved without the checkout — an epic landed from the
  phone while a launcher had the tree dirty, so landing could not
  fast-forward it — a status or merge-record push is refused. The fleet then
  merges the upstream in, the way the queue's refresh always has, and pushes
  once more; a checkout with uncommitted changes is not merged into, and a
  conflict is aborted and warned. A rebase was declined: the status commits
  may already be on a phone's view of origin, and pre-run HEAD stays an
  ancestor of every new HEAD (case 43). The drain's refresh pushes what its
  merge left ahead (L-36).
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
  makes the start a no-op; the reply is still true. `/promote` starts one the same way
  after its commit, so a promoted story does not wait for the timer.
- **Re-run only what could have changed (L-39).** khaita 071, one round,
  46 min from pickup to merged: builder 11 min, baseline 5¾, reviewer 10,
  mutations 11½, merge 6½. The merge re-checked the tree the round had just
  checked, the reviewer re-ran the baseline the harness had just run, and
  one full-suite pre-run ran twice. Now: a story merged into an unmoved
  epic reuses its round's GREEN baseline when the tree and the recorded
  commands match (`baseline/commands.json`); a selector's GREEN pre-run is
  made once per round; the reviewer is given the baseline (`{{BASELINE}}`)
  and runs only what its judgment needs. What stays: fresh worktrees and
  installs (L-01, L-09) and one thing at a time on a 2-CPU, 3.8 GiB box
  (L-37). The builder's own baseline runs, kept here for 025's
  `next build`-only failure, went on 15 Oct (the next entry).
- **A RED baseline goes back to the builder, inside the round (15 Oct).**
  Measured on khaita 089–096: a round took 45–60 min — builder 25–40 (only
  4–13 of it model time), baseline ~11½, mutations 5–14, reviewer ~2. The
  rules told the builder to run the whole baseline before it finished, so in
  most rounds 10–22 of its minutes were the very commands the harness ran
  again straight after, on a clean tree; and in 44 rounds since khaita 062
  the harness's baseline was never once RED. The human approved replacing
  the duplicate with a loop in the harness. Now the builder runs only the
  tests it wrote or changed and a spec or two its change could break; when
  the harness's baseline is RED after a builder call, the launcher resumes
  that builder's own session (`claude -p --resume <session_id>`) with
  `prompts/baseline-fix.md` — which runs were RED, their commands and the
  last 150 lines of each log — before scope, reviewer or mutations, and runs
  the baseline again on the head the fix leaves, `BASELINE_FIXES` times at
  most (default 2; 0 is the fleet before the loop). Why a harness loop beats
  the builder's own run: the harness's run is the only one that counts,
  clean tree and fresh install, so the builder's copy proved less and cost
  every round, where the loop costs only in a RED one; the resumed session
  already holds the code and the story, so a fix is minutes, not a new
  round; and the fix comes before the reviewer and the mutations, so a RED
  costs a call and a baseline instead of a whole 45–60 min round. A fix
  that commits nothing ends the loop and the RED fails the round as before.
  The record is the round's evidence — `baseline-red-<n>/` beside
  `baseline/`, `builder-fix-<n>.json`, the fix's words after the builder's
  in `builder.md` — and the log; the Machine block's lines are unchanged,
  its builder and baseline seconds summing every call and every run (case
  155).
- **The builder's tdd- pairs are run once, by the harness (L-42).** The
  builder used to run `fleet check-mutation` over its pairs before handing
  over, and the mutation phase ran them again: the duplicate averaged 67 s a
  round over khaita 097–115 and reached 251–288 s on 113, whose pairs are
  browser specs. Now the launcher runs them right after a GREEN baseline —
  the tdd check — and hands any that is not RED back to the builder's
  session with `prompts/tdd-fix.md`, `TDD_FIXES` times (default 2); the
  mutation phase reuses each class by digest. Measured before the change:
  in 12 of 25 builder sessions since 097 the first check-mutation call was
  not all RED, and every one was fixed by redoing the evidence, never by a
  commit — so a hand-back costs a resumed call and a re-run of the changed
  pairs, not another baseline. The saving is the duplicate less that resumed
  call: about 45 s a round on average, about 4 min on a round of browser
  pairs (case 159).
- **A bot job that outlives the poll is a unit of its own.** `/merge`
  starts its job with `DETACH_CMD` (`systemd-run --user --collect …`). A
  child forked inside the poll was killed with the poll's cgroup, seconds
  after the acknowledgement (L-34).
- **One test slot on the machine, served by Caddy, without Cloudflare.** The
  human chose HTTPS on the VPS itself (27 Sep): Caddy and Let's Encrypt under
  the sslip.io name, with no tunnel and no third party in the path, and no
  password. HTTPS matters here because the app's service worker, offline mode
  and install run only in a secure context. There is one slot because a
  second one needs a second name and port, and a 3.8 GB machine should not
  hold two Next servers beside a story's build. The build takes the target's
  launch lock and waits up to an hour for a running launch. The server is a
  transient unit, gone after a reboot: `/testdeploy` brings it back.
- **Commits and PRs name the human only.** No `Co-Authored-By`,
  `Claude-Session`, "Generated with" or model trailer, from the builder, a
  coordinator or an interactive session (the human's decision, 26 Sep). The
  model that built or reviewed a story is recorded in the Machine block and
  the round evidence, where it is read; a coordinator names its own in the
  hand-over message, which is what the Trials table is filled from. History
  from before is left as it is.
- **What stays bash:** `./fleet` itself, `bin/lib.sh`'s `load_repo` (a
  target's `.fleet/config` is sourced bash), the two chores in `bin/`, and
  the suite, which runs every command end to end with fake agents.
