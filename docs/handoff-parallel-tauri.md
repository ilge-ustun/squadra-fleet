# Handoff: a second project in parallel — a Tauri app for macOS

Decided with the human on 15 Oct 2026, in the coordinator session that ran
khaita's epic/playlists. Nothing below is built yet. This is the brief for
the session that builds it. Check every pointer against the code first:
line numbers rot (L-11), commands do not.

## What the human decided

- **The fleet works on a second, unrelated project in parallel with
  khaita.** The human runs a separate coordinator session for it.
- **A bigger VPS rather than a second one**, so there is one fleet, one bot
  and one place to look. The human resizes the box. The coordinator
  recommended 8 vCPU / 16 GB RAM / ~160 GB disk for a Next build and a Rust
  build at once; 4 vCPU / 8 GB is the floor, and only with a shared Rust
  cache. Today the box is 2 CPU / 3.8 GB / 60 GB (`docs/operations.md`,
  "The machine").
- **The project is a fresh Tauri app** (Rust backend, React + TypeScript
  frontend). It will live on GitHub. Name, owner and visibility are still
  open, as is who creates the repo (the human, or the coordinator with `gh`
  once the human says so).
- **Stories touch everything**: frontend and Rust alike.
- **No test deploy.** `fleet test-deploy` and `/testdeploy` stay khaita's.
- **CI builds for macOS only; there is no Linux support.** A GitHub Actions
  macOS runner builds the real `.app`/`.dmg`.

## What follows from it (the coordinator's analysis, not yet the human's word)

- **The VPS is Linux, so the fleet can only test what compiles on Linux.**
  Recommended shape for the app from its first commit:
  - a plain `core` crate holding the app's logic, with no Tauri and no
    macOS APIs, so `cargo test` covers it on the VPS;
  - a thin `src-tauri` shell. It must still compile on Linux (`cargo check`
    or `clippy` in the baseline), with any macOS-only code behind
    `#[cfg(target_os = "macos")]`.

  That Linux build is never shipped; it exists so the fleet can test. Code
  under `cfg(target_os = "macos")` is tested only by CI on macOS: a known
  gap to state in each such story.
- **CI is outside the verdict.** The fleet's computed verdict does not see a
  GitHub check today. At first the human reads CI before landing an epic.
  Making the fleet wait for, or read, a check on the story branch is a later
  PR (item 3 below).
- **The human owns:**
  - macOS runner minutes, which are free on a public repo and billed at a
    multiple on a private one;
  - Apple Developer signing and notarisation certificates, kept as GitHub
    secrets.
- **On the VPS:**
  - the Rust toolchain (rustup) and Tauri v2's Linux build dependencies
    (`libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`,
    `libxdo-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` — check
    Tauri's current list);
  - a shared compile cache: sccache, or one `CARGO_TARGET_DIR` per repo.
    Every round builds in fresh worktrees (builder, reviewer, each
    mutation), so without a cache each one recompiles from scratch: minutes
    and 2–5 GB of disk each.

## Fleet work, in order (each a PR the human merges; `fleet-develop` skill)

1. **Parallel projects (lanes per repo).**
   - Today `fleet run-queue --all` drains registered repos one after another
     in one oneshot (`ts/src/run-queue.ts`, `runAll`), up to `--max 5`
     stories each, under the single `fleet-queue` unit
     (`systemd/fleet-queue.service`).
   - The launch lock is already per repo (`<target>/.git/fleet-launch.lock`,
     `ts/src/lib/lock.ts`), so two repos can launch at once without a new
     claim. A second lane *within* one repo is the harder problem
     `docs/operations.md` ("Lanes") describes, and it is not needed here.
   - Likely shape:
     - a templated unit `fleet-queue@<repo>` (timer and service) per
       registered repo;
     - the bot's `/run` and `/promote` start that repo's unit
       (`QUEUE_START_CMD` in `ts/src/telegram.ts`);
     - `fleet status` and the reaper per repo;
     - a free-memory guard before a launch, so two Rust and Next builds do
       not swap the box to death.
   - `fleet test-deploy` stays a single slot (khaita only).
   - Update `docs/operations.md` "Lanes" and the systemd README.
2. **A `cargo test` runner beside vitest.**
   - Today the machine's evidence — mutations, probes, the builder's
     `ACn-tdd-*.test` selectors, `fleet check-mutation` — speaks only
     vitest's JSON (`docs/operations.md`, "The runner contract";
     `ts/src/lib/vitest-json.ts` is the one place a runner's output becomes
     a class).
   - Stories touching Rust need selectors such as
     `cargo:<package>::<path>::tests::<name>`, run as `cargo test -p <pkg>
     <filter> -- --exact`, and classified into the same classes:
     - `RED`, `GREEN`, `PRE_RED`;
     - `SELECTOR_INVALID` (no test matched);
     - `NO_TESTS` (it did not compile);
     - `PATCH_INVALID`.
   - Parse libtest's plain output on stable (`test … ok|FAILED`, `running N
     tests`, `test result:`), or use cargo-nextest's JUnit. libtest's
     `--format json` is nightly-only.
   - Rust probes need a probe directory the reviewer can write into
     (`PROBE_DIR` is one directory today).
   - `prompts/rules.md`'s TDD paragraph and `prompts/review.md` must name
     both selector forms.
3. **Later:** the verdict reads the macOS CI check on the story branch
   (`gh run`/checks API), or the queue waits for it before merging to the
   epic.

## Onboarding the repo (after 1 and 2, or with Rust held to "must compile and pass" until 2)

- **A skeleton by hand.** A fresh repo has nothing for a baseline to run. It
  needs:
  - Tauri v2 with React + TS (Vite), vitest with at least one test, eslint;
  - the `core` crate with one test;
  - the macOS GitHub Actions workflow;
  - on its integration branch, `.fleet/config` with every key `README.md`
    lists ("What a target provides"), `.fleet/rules.md`,
    `.stories/TEMPLATE.md`, and `.gitignore` entries for `.runs/`,
    `.review-out/` and the seed files.
- **Commands.** Until item 2, an example:
  - `VITEST_CMD='npx vitest run'`;
  - `BUILD_CMD='npm run build && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace'`
    (Rust is a gate, not an instrument);
  - `LINT_CMD='npm run lint && cargo fmt --check'`.
- **Registration and checks.** `repos/<name>.env` with `REPO_PATH`, in its
  own parent directory (`load_repo` refuses a shared one). Then `./fleet
  status <name>`, then `./fleet new-epic <name> <epic>`.
- **Access.** A deploy key for the GitHub repo, as khaita has its own.

## Context from the same day (khaita), for the numbers

- Rounds took 45–60 min. The builder re-ran the whole baseline before every
  hand-over (10–22 min a round), then the harness ran it again (~11.5 min),
  and in 44 rounds since khaita 062 it was never RED.
- Two changes followed:
  - khaita's `E2E_CMD` became smoke plus the specs a branch changed against
    develop (khaita `fbec886`), and the full e2e moved to the epic's tip;
  - PR #32 (`BASELINE_FIXES`, live at `bbdb4d6`) hands a RED baseline back
    to the builder's own session, and the builder no longer runs the
    baseline itself.
- Since then khaita rounds have run 12–49 min, all PASS in round 1.

## Open, for the human

- The VPS resize: when, and to what size.
- The repo: name, owner, visibility, and who creates it.
- A go on fleet PRs 1 and 2.
