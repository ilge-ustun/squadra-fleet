# Coordinators — running the fleet's judgment on any model

**A coordinator is optional.** The fleet is autonomous from `ready` to
`on epic`, and a human alone runs the rest from a phone: `fleet write-story`
drafts, they promote, the queue builds and judges, `/merge` lands. A
coordinator only helps with what takes judgment — the intent, the draft
review, reading a FAIL. Nothing in the pipeline depends on one.

The harness has no coordinator role. The TypeScript harness orchestrates,
three agents run inside it, and the verdict is computed. What is left —
turning a wish into a story, reviewing the draft, reading verdicts,
answering blocks, landing epics, maintaining the harness — is done by a
human with an interactive agent session beside them. That session is the
coordinator, and this page is how to run it on a harness and a model of
your choosing.

The procedures are the five skills in `skills/<name>/SKILL.md` (`README.md`
lists them), written for any agent: actions, not tool names; the reason
beside every rule. The same files load in Claude Code and in Codex, because
both read the `name:`/`description:` frontmatter format.
`./fleet install-skills` links them into `~/.claude/skills/`, where Claude
Code finds them from any directory. Codex reads them from this repo's
`.agents/skills` (a symlink to `skills/`) — only when it is started inside
the fleet repo, which keeps them away from the reviewer, a codex in a
target's worktree.

Both the fleet and a target carry `AGENTS.md` as a symlink to `CLAUDE.md`:
Codex reads the former, Claude Code the latter, same text.

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

Start it where the work is — usually the target. The skills are personal
(`~/.claude/skills/`), so they load from any directory.

## Codex, on OpenAI models

Installed and logged in — the reviewer runs on it.

```bash
codex -C ~/work/fleet \
      --add-dir ~/work \
      -s workspace-write \
      -c sandbox_workspace_write.network_access=true \
      -m <model>
```

- `-C ~/work/fleet`: Codex loads the fleet skills from `.agents/skills`
  only here.
- `--add-dir ~/work`: what a coordinator writes lies outside the fleet
  checkout — the target, the story writer's `../ws-<id>` worktree beside
  it, and `fleet-develop`'s `../fleet-wt-<topic>` beside the fleet.
- `network_access=true`: the coordinator fetches and pushes the story
  branch. Without it `git push` fails silently inside the sandbox.
- `-m`: the model. `codex exec` takes the same flags for a non-interactive
  run.

Verify once, before a trial, that `git push` in the target and
`./fleet write-story` work from inside that session, and that the session
lists the five skills; the sandbox contract is Codex's, not ours.

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
OPENROUTER_API_KEY=… codex -p gemini -C ~/work/fleet --add-dir ~/work -s workspace-write -c sandbox_workspace_write.network_access=true
```

Gemini's own OpenAI-compatible endpoint and DeepSeek's API fit the same
block with their `base_url` and `env_key`. `codex --oss --local-provider
ollama` runs a local model; this VPS (3.8 GB, 2 cores) cannot host one.
Read `codex --help` and the `config.toml` reference for the current keys
before trusting the block above.

## Gemini CLI, OpenCode

Neither is installed. Gemini CLI reads `GEMINI.md` and TOML commands, not
`SKILL.md`; a converter would be needed. OpenCode reads `AGENTS.md` and
takes many providers; whether it loads `SKILL.md` unchanged is to be
checked when it is installed. `bin/install-skills.sh` gains a branch when
one of them exists here.

## The trial protocol

The question is not "which model feels better" but what each coordinator
costs the human. So every trial uses the same intent text, the coordinator
does the whole `fleet-story` procedure — draft, review, hand edits, lint,
commit — and the human promotes as usual. One row per trial, below:

| column | what to record |
|---|---|
| date · harness · model | from the story commit's `Coordinator:` trailer |
| story | the id |
| lint | errors and warnings after the coordinator's own review |
| hand edits | what the human had to change before promoting, in one line |
| rounds | rounds to PASS, from `fleet status` |
| human-only actions | any attempt to promote, land, launch, deploy or read a token — the negative result that matters most |
| notes | the drafting cost in wall-clock, anything surprising |

Read the trials out of git later with:

```bash
git -C <target> log --format='%h %s%n%(trailers:key=Coordinator,valueonly)' -- .stories/
```

A coordinator that drafts well but promotes a story itself has failed the
trial whatever the story looked like.

## Trials

| date | harness | model | story | lint | hand edits | rounds | human-only actions | notes |
|---|---|---|---|---|---|---|---|---|
| 2026-09-22 | claude-code | claude-fable-5-1 | 016–019 | 0 errors each | 016: AC6 added by hand after a product decision; 018: AC6 likewise; 019: one brittle count removed, two L-20 headings reworded | 4, 2, 2, 2 | none | the baseline: the sessions the skills were written from |
