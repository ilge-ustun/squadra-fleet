# Fleet: readable status, `/merge`, and an explicit story/epic model

Repo: `/home/fleet/work/fleet` (+ one commit in khaita's `develop`). The
extraction plan that used to live in this file is done and shipped.

**Status, 20 Sep evening:** steps 1–7 landed (cases 90–94, suite at 530).
Step 8 waits for the human's `glab auth login`; the config lines it needs
are in `README.md` under `PR_CMD`. Two details differ from the design
below, both found in the field: `status.sh` reads ancestry from
`origin/<branch>` (merge.sh pushes; a checked-out local branch stays
behind), and a `done` story with no branch and no `merged:` sha shows
`done`, not `awaiting merge` — nothing could be merged. `PR_CMD` also gets
`PR_SOURCE`/`PR_TARGET` in its environment, because a story on an epic
targets the epic, not the integration branch. And decision 1's horizontal
scroll does not exist: Telegram wraps a `<pre>` block at about 40 columns
on a phone, so `--bot` is not the table — per story, between rules: the
id and title, then `→ epic/offline-pwa | on epic | R1 | PASS`, then any
notes; newest story first, every story shown (the user's call on 20 Sep,
shape included). The terminal table is unchanged.

## Context

Story 013 was the first round run from the new home and the first
auto-merge. Watching it from a phone showed three gaps:

- `/status` arrives as proportional text, so the table falls apart, and it
  shows no title, so an id means nothing on the phone.
- There is no way to land a finished story or epic on the integration branch
  from the phone. `merge.sh` refuses the integration branch by design, because
  the *queue* must never do it; a human's word from the phone is a different
  thing, and today it has no command.
- Story versus epic is real but invisible: an epic is only a branch name a
  story's `base:` points at, `done` covers three different situations, and
  nothing enforces the naming at creation.

Decisions made with the user on 20 Sep 2026:

1. **Table**: one line per story, `ID  TITLE  STATUS  R  VERDICT  INTO`, full
   titles, no ellipsis, horizontal scroll inside a Telegram code block.
2. **`/merge <repo> <id>`** lands a story whose base is the integration
   branch; **`/merge <repo> epic/<name>`** lands an epic. A story that lives
   on an epic is refused with the epic command named. No cherry-pick.
3. **Per-repo landing mode** in `.fleet/config`: `MERGE_MODE=direct` (merge
   with the post-merge baseline, push) or `MERGE_MODE=pr` (push the branch,
   run `PR_CMD`, reply with the URL it prints). `gh` and `glab` get installed
   as binaries under `~/.local/bin`; tokens and auth logins are the human's.
   khaita goes to `pr` with a `glab mr create` command.
4. **Extras**: a `README.md`; a derived landing state and an INTO column;
   the epic summary above the table by default; naming enforced at creation
   (`write-story.sh --base` must be `epic/*`, `lint-story.sh` rejects any
   other base, `new-epic.sh` creates and pushes an epic branch).

Working rules unchanged: TDD with a case observed red first, one task one
commit, `bash test-lib.sh` green before every commit, show the `launch.sh`
diff before applying (launch.sh is not touched by this plan), `die` over
`warn`.

## Design

### status.sh — the one renderer

`status.sh <repo> [--json|--epics|--bot] [id]`

- **Title**: first `# ` heading of the story file, with a leading
  `Story NNN:` stripped. `TEMPLATE.md` is skipped as today.
- **Landing state**, computed, never stored; frontmatter `status:` is
  untouched:
  - anything but `done` → shown as is (`draft ready in_progress blocked needs_human`)
  - `done`, merged, and the base is `BASE_BRANCH` or an ancestor of it → `landed`
  - `done`, merged into an epic that is not in `BASE_BRANCH` → `on epic`
  - `done`, computed PASS, not merged → `awaiting merge`
  - `done` otherwise (a FAIL nobody merged, like 004) → `done`
- **INTO** column: the story's base (`develop`, `epic/offline-pwa`).
- **Epic summary first**, in the default output, one line per epic:
  `epic/offline-pwa  2 stories, 2 merged, 2 ahead of develop  → merge.sh khaita --epic epic/offline-pwa`.
  `--bot` prints the phone form of the hint (`/merge khaita epic/offline-pwa`)
  and no colour codes. `--epics` keeps printing only that block.
- Column widths are computed from the rows (title width = longest title),
  so columns align and long lines simply scroll.
- `--json` gains `title` and `landing`. Existing keys unchanged; `merge.sh`
  keeps reading `status`, `verdict`, `base`, `live`, `merged`, `branch`.

### telegram.sh

- `send` takes an optional `--pre`: the text goes as `parse_mode=HTML` inside
  `<pre>…</pre>` with `& < >` escaped. Messages over ~3800 chars are split on
  line boundaries into several `sendMessage` calls (Telegram's limit is 4096).
- `cmd_status` = `status.sh <repo> --bot`, sent with `--pre`.
- New verb `/merge <repo> <id|epic/name>`: a three-digit id → `merge.sh <repo> <id> --land`;
  `epic/…` → `merge.sh <repo> --epic <name>`; anything else → usage. Runs
  under `with_lock` like `/promote`. The reply is the script's output with
  colours stripped, so in `pr` mode the PR/MR URL is the reply. Help line
  updated.

### merge.sh

- **`--land`** on a story: lifts the "integration branch is a human's" refusal
  for this invocation only. The queue never passes it (`run-queue.sh` is not
  changed), so auto-merge stays story → epic only. `main`/`master` stay
  refused even with `--land`.
- **`MERGE_MODE`** (from config; `load_repo` defaults it to `direct`,
  requires `PR_CMD` when `pr`):
  - `direct`: today's path — throwaway worktree, merge, post-merge baseline,
    push, record `merged:` for a story.
  - `pr`: push the source branch to origin (story branches are never pushed
    by the launcher, so this is the first push of `story/<id>`), then run
    `cd $REPO_ROOT && $PR_CMD <branch>` and print its stdout. Nothing is
    merged, nothing recorded in the story: the merge happens on the host and
    lands in `origin/<base>` like any human merge. Refusals (status, verdict,
    live worktree, already merged) apply the same in both modes.
- `PR_CMD` contract, documented in README and the config comments: run in the
  target checkout with the source branch appended; must be non-interactive;
  must print the request URL. Examples:
  `glab mr create --source-branch <appended> …` for GitLab,
  `gh pr create --head <appended> …` for GitHub. The exact flags are taken
  from `glab mr create --help` / `gh pr create --help` at install time, not
  from memory.

### lib.sh

`FLEET_REPO_KEYS` gains `MERGE_MODE PR_CMD`. After sourcing:
`MERGE_MODE="${MERGE_MODE:-direct}"`; `[[ direct|pr ]] || die`;
`pr` requires a non-empty `PR_CMD`.

### Naming enforced at creation

- `write-story.sh`: `--base` must match `^epic/`; otherwise die naming
  `new-epic.sh`.
- `lint-story.sh`: `base:` must be absent, equal to `BASE_BRANCH`, or
  `epic/*`; anything else is an error (today only "exists on origin" is checked).
- `new-epic.sh <repo> <name>`: name must be plain (`[A-Za-z0-9_-]+`),
  `epic/<name>` must not exist locally or on origin, created from
  `origin/<BASE_BRANCH>` and pushed. Sources `lib.sh`, takes the repo first.

### README.md (fleet repo)

About 150 lines, written from the existing five documents, not new
knowledge: what the fleet is; the loop from intent to landed code; story
versus epic, how each is created and how each lands; the commands at a
terminal and on the phone (a table of both forms); what a target provides
(`.fleet/config` with every key, `.stories/TEMPLATE.md`); adding a repo
(registry entry, config, seed files, PROBE_DIR); what needs a human; where
the other documents are. `docs/FLEET-HANDOFF.md` §0 and `CLAUDE.md` get the
new keys and `/merge`; khaita's `.stories/TEMPLATE.md` gets one line on
landing.

### Installing gh and glab (no repo change, no sudo)

Latest release tarballs for linux amd64 from `github.com/cli/cli` and
`gitlab.com/gitlab-org/cli`, verified against their published checksums,
binaries into `~/.local/bin` (already on the units' PATH). Then, human:

- GitHub: fine-grained token limited to chosen repos, Pull requests
  read/write + Contents read; `gh auth login --with-token`.
- GitLab: project access token on khaita-app, `api` scope, Developer role;
  `glab auth login --hostname gitlab.com --token`.

Tokens live in the CLIs' own config files (mode 600), not in `.env.fleet`.

## Order of work — one commit each, red first

1. **Install `gh` and `glab`** into `~/.local/bin`; print both `--help` for
   the create commands. No commit.
2. **status.sh: title, INTO, landing state, epic summary, `--bot`** — case 90:
   a develop story after a PASS shows `awaiting merge` with its title and
   `base`; an epic story after `merge_run` shows `on epic`; after
   `merge_epic` it shows `landed`; the epic line carries the hint in both
   forms; `--json` has `title` and `landing`. Red: no title, bare `done`.
3. **telegram: `<pre>` status and chunking** — case 93a: `/status t` produces
   a `sendMessage` whose argv carries `parse_mode=HTML` and `<pre>`; a table
   over 3800 chars (fixture with many stories) arrives as two sends. Red: no
   `parse_mode`, one send.
4. **lib.sh + merge.sh: `--land` and `MERGE_MODE`** — case 91: a develop story
   with `--land` merges with the baseline and moves `origin/base`; without
   `--land` the existing refusal (case 59) still holds; the queue still does
   not land it (existing case 70's sibling, assert on a PASS develop story).
   Case 92: `MERGE_MODE=pr PR_CMD="bash $FX/fake-pr.sh"` pushes `story/900`,
   calls the fake with the branch name, prints its URL, leaves `origin/base`
   unchanged, records nothing; `pr` without `PR_CMD` dies in `load_repo`
   (extend case 82). Red: `--land` unknown; `MERGE_MODE` ignored.
5. **telegram `/merge`** — case 93b: `/merge t 900` runs `merge.sh t 900 --land`
   and replies with its output; `/merge t epic/test` runs `--epic`;
   `/merge t nope` is usage. Red: unknown verb.
6. **Naming at creation** — case 94: `write-story.sh t 901 "x" --base feat/x`
   dies before any agent runs; `lint-story.sh` errors on `base: feat/x` and
   accepts `base: epic/test`; `new-epic.sh t search` creates
   `origin/epic/search` and refuses a second time and refuses `bad name`.
   Red: each accepted.
7. **README.md and doc updates** (handoff §0, CLAUDE.md, TEMPLATE line). No case.
8. **khaita `.fleet/config`**: `MERGE_MODE=pr` and the `glab` `PR_CMD`, on
   `develop`, only after the human's `glab auth status` is green; until then
   khaita stays `direct` (the default).

Not changed: `launch.sh`, `run-queue.sh`, `revert.sh` (a landed develop
story is reverted by a human in git, as today; the refusal stands).

## Verification

```bash
cd ~/work/fleet && bash test-lib.sh                          # green
bash status.sh khaita; bash status.sh khaita --bot; bash status.sh khaita --json 013 | jq '.[0]|{title,landing,base}'
bash merge.sh khaita 013 --land                              # refused: 013 is on an epic; names the epic command
bash new-epic.sh khaita search && git -C ~/work/khaita/khaita-app branch -r | grep epic/search   # if the user wants that epic
bash lint-story.sh khaita 012
gh --version; glab --version; glab auth status                # after the human's login
```

End to end from the phone: `/status khaita` arrives as a code block with
titles; `/merge khaita epic/ui-polish` lands the epic that has been waiting
since 18 Sep (direct mode, post-merge baseline, `develop` moves) — a human's
decision, made by sending the command. With khaita on `pr` mode later,
`/merge` on a develop story replies with a GitLab merge-request URL.
