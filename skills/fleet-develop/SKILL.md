---
name: fleet-develop
description: Change the fleet harness itself (~/work/fleet) — worktree, a test/suite.sh case observed red first, one task one commit, suite green before every commit, launch.sh diff shown before applying, fast-forward main only when both systemd units are inactive. Use when fixing or extending launch.sh, merge.sh, telegram.sh, status.sh, lint-story.sh, prompts or the tests.
---

# Changing the harness

The checkout at `~/work/fleet` is **live**: two systemd user timers run it
every minute (`fleet-bot`) and every fifteen (`fleet-queue`). Never edit it
in place.

```bash
cd ~/work/fleet
git worktree add ../fleet-wt-<topic> -b <topic> main
cd ../fleet-wt-<topic>
```

`test/suite.sh` tests the working tree it lives in, with fake agents from
`test/` (`claude`, `codex`, `vitest`, `npm`) put first on PATH, the bot
pointed at `test/fakes/telegram-api.mts` by `TELEGRAM_API_BASE`, and
re-executed under `env -i`. No network, no model.

## The rules, each with its reason

- **A case is observed red before the change.** Most cases characterise
  behaviour a script already has, so red means running the case against a
  copy with the block deleted: `FLEET_LIB_OVERRIDE=<file>`
  substitutes a copy of `lib.sh` into the fixture;
  `FLEET_TS_OVERRIDE=<dir>` lays a directory over `ts/src/` (one file or
  many), or the case writes a stub into the fixture's `ts/src/lib/` after
  `fixture` (cases 106-110, 113). A new feature is red because it is absent. A case
  never seen red is not a case; it has passed by accident before.
- **`bash test/suite.sh` green before every commit**; the count is on the
  last line. `bash test/suite.sh <substring>` runs a subset while iterating.
- **The TypeScript side too:** `cd ts && npm ci && npm run check && npm test`
  green before every commit that touches `ts/`, its unit tests red first.
  `npm test` goes through esbuild, which accepts syntax Node's type
  stripper rejects — `npm run check` (tsc, `erasableSyntaxOnly`) and the
  suite (real `node`) are the proofs. `ts/node_modules` is for tsc and
  vitest in a worktree only; nothing needs it at run time and the live
  checkout never runs `npm`. The rules for the TypeScript are in
  `CLAUDE.md`.
- **One task, one commit**, the reason in the message, `git status --short`
  shown. A commit carrying three concerns cannot be extracted later (L-10).
- **Show the `ts/src/launch.ts` diff before applying it.** `launch.sh` is a
  wrapper that execs node, which loads the whole program before it starts,
  so a running launcher keeps the code it loaded; editing the bash launcher
  mid-run was never safe, editing the TypeScript is.
- **`die` over `warn`.** A warning assumes a human is watching; nobody is.
- **Prompts go to agents on stdin, never argv** — argv has a 128 KB ceiling
  and a round-2 prompt exceeded it (L-18).
- **Placeholders in `prompts/*.md` are `{{NAME}}`**, substituted by
  `ts/src/lib/render.ts`'s `renderPrompt`; a new one needs the
  substitution, the empty-guard list, and the table in `prompts/README.md`.
- **Fakes must shadow the real binaries** (`shadow_check`), or a case runs
  the real agent on real quota — it happened (L-14).
- **Never run the fleet against itself**; a target is another repo.

## Landing the change

```bash
systemctl --user is-active fleet-bot.service fleet-queue.service   # both must print inactive
cd ~/work/fleet && git merge --ff-only <topic> && git push
git worktree remove ../fleet-wt-<topic> && git branch -d <topic>
```

Fast-forward only: the live checkout must be exactly a commit that passed
the suite. If a unit is `active` or `activating`, wait for the next minute;
the bot is a one-minute oneshot, the queue is idle unless a story is ready.
Then run `bash test/suite.sh` once more in `~/work/fleet` — the tree the
timers execute.

Document the seam or command you added: `README.md` (the map),
`docs/FLEET-HANDOFF.md` §0 (seams), `docs/lessons.md` (why, as L-NN) when
the change came from a failure.
