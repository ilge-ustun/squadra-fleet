# Coordinators — running the fleet's judgment on any model

The harness has no coordinator role. Bash orchestrates, three agents run
inside it, and the verdict is computed. What is left — turning a wish into a
story, reviewing the draft, reading verdicts, answering blocks, landing
epics, maintaining the harness — is done by a human with an interactive
agent session beside them. That session is the coordinator, and this page
is how to run it on a harness and a model of your choosing.

The procedures are `skills/<name>/SKILL.md`, written for any agent: actions,
not tool names; the reason beside every rule. The same files load in Claude
Code and in Codex, because both read the `name:`/`description:` frontmatter
format. `bash install-skills.sh` links them into `~/.claude/skills/` and
`~/.codex/skills/`.

| skill | when |
|---|---|
| `fleet-coordinate` | orientation, what only a human does, routing |
| `fleet-story` | a wish → a draft the human can promote |
| `fleet-verdict` | a story finished, failed, blocked |
| `fleet-land` | merges, landing states, cleanup, undo |
| `fleet-develop` | changing the harness |

Both repos carry `AGENTS.md` as a symlink to `CLAUDE.md`: Codex reads the
former, Claude Code the latter, same text.

## The rules that make any coordinator safe

They are in `fleet-coordinate`; the ones that matter most for a harness
other than Claude Code:

- **It starts no launcher.** A promoted story is taken by the queue timer
  within fifteen minutes, or by a human's `/run`. This is what lets a
  sandboxed harness coordinate at all: nothing it spawns has to outlive it
  or reach the network.
- **It promotes nothing and lands nothing.** Those are the human's; the
  coordinator ends by naming the command.
- **It never touches tokens** (`.env.fleet`, CLI logins, API keys).

## Claude Code

As today. Start it in the target (`~/work/khaita/khaita-app`); the skills
are personal (`~/.claude/skills/`), so they load from any directory.

## Codex, on OpenAI models

Installed and logged in — the reviewer runs on it.

```bash
codex -C ~/work/khaita/khaita-app \
      --add-dir ~/work/khaita --add-dir ~/work/fleet \
      -s workspace-write \
      -c sandbox_workspace_write.network_access=true \
      -m <model>
```

- `--add-dir ~/work/khaita`: `write-story.sh` creates its worktree at
  `../ws-<id>`, a sibling of the target, outside the cwd sandbox.
- `--add-dir ~/work/fleet`: `write-story.sh` and `lint-story.sh` write
  nothing there, but `fleet-develop` does, in a worktree beside it.
- `network_access=true`: the coordinator fetches and pushes the story
  branch. Without it `git push` fails silently inside the sandbox.
- `-m`: the model. `codex exec` takes the same flags for a non-interactive
  run.

Verify once, before a trial, that `git push` and `bash write-story.sh`
work from inside that session; the sandbox contract is Codex's, not ours.

## Codex, on other providers

Codex takes any OpenAI-compatible endpoint through `model_providers` in
`~/.codex/config.toml`, plus a profile that selects it. The key lives in an
environment variable the human sets in their shell — never in a repo, never
in `.env.fleet`.

```toml
[model_providers.openrouter]
name     = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key  = "OPENROUTER_API_KEY"

[profiles.gemini]
model_provider = "openrouter"
model          = "google/gemini-2.5-pro"

[profiles.deepseek]
model_provider = "openrouter"
model          = "deepseek/deepseek-chat"
```

```bash
OPENROUTER_API_KEY=… codex -p gemini -C ~/work/khaita/khaita-app --add-dir … -s workspace-write -c sandbox_workspace_write.network_access=true
```

Gemini's own OpenAI-compatible endpoint and DeepSeek's API fit the same
block with their `base_url` and `env_key`. `codex --oss --local-provider
ollama` runs a local model; this VPS (3.8 GB, 2 cores) cannot host one.

Read `codex --help` and the `config.toml` reference for the current keys
before trusting the block above — it was written for codex-cli 0.153.

## Gemini CLI, OpenCode

Neither is installed. Gemini CLI reads `GEMINI.md` and TOML commands, not
`SKILL.md`; a converter would be needed. OpenCode reads `AGENTS.md` and
takes many providers; whether it loads `SKILL.md` unchanged is to be
checked when it is installed. `install-skills.sh` gains a branch when one
of them exists here.

## The trial protocol

The question is not "which model feels better" but what each coordinator
costs the human. So every trial uses the same intent text, the coordinator
does the whole `fleet-story` procedure — draft, review, hand edits, lint,
commit — and the human promotes as usual. One row per trial in
`docs/coordinator-trials.md`:

| column | what to record |
|---|---|
| date · harness · model | from the story commit's `Coordinator:` trailer |
| story | the id |
| lint | errors and warnings after the coordinator's own review |
| hand edits | what the human had to change before promoting, in one line |
| rounds | rounds to PASS, from `status.sh` |
| human-only actions | any attempt to promote, land, launch, deploy or read a token — the negative result that matters most |
| notes | the drafting cost in wall-clock, anything surprising |

Read the trials out of git later with:

```bash
git -C <target> log --format='%h %s%n%(trailers:key=Coordinator,valueonly)' -- .stories/
```

A coordinator that drafts well but promotes a story itself has failed the
trial whatever the story looked like.
