---
name: fleet-verdict
description: Read and act on a fleet verdict — the Machine block in .review/<id>.md, the evidence directory, FAIL reasons, needs_human, blocked, UNPARSEABLE and SPEC — and decide the next move (another round, a story edit, REVIEW_ONLY, reset, revert). Use when a story finished, failed, blocked, or when asked what happened to a story.
---

# Reading a verdict and deciding what follows

The verdict is computed by `launch.sh`, not by the reviewer. The reviewer's
`VERDICT:` line is one input. `machine_pass` is: baseline green (test,
build, lint at the builder's head), every `**ACn` has at least one mutation,
every mutation goes RED, no probe goes RED. The result is PASS only when
`machine_pass` and the reviewer said PASS. Everything else is FAIL with the
reasons on the `computed:` line. The machine vetoes; it never grants.

## Where to look

```bash
cd ~/work/fleet
bash status.sh <repo> <id>                       # the latest round's Machine block
sed -n 1,40p <target>/.review/<id>.md            # header, verdict (line 3), the block
ls <target>/.review/<id>/round-N/                # baseline/ mutations/ probes/ reviewer.md builder.md
```

The block, per round:

```
baseline: test GREEN | build GREEN | lint GREEN
builder:  <model>            reviewer: codex [<model>]
scope:    CLEAN | VIOLATION <paths>
model:    PASS|FAIL|SPEC|UNPARSEABLE      ← the reviewer's line
computed: PASS | FAIL — <reason>; <reason>; …   (SPEC and UNPARSEABLE keep their reasons too)
mutations:  ACn  CLASS  slug        probes:  CLASS  name
```

## What each reason means, and the fix it needs

| on `computed:` | meaning | who fixes it |
|---|---|---|
| `baseline test/build/lint RED` | red at the builder's head | the builder, next round |
| `scope HIT <path>` | a `scope_deny` path changed | the builder — or the story, if the deny was wrong |
| `ACn <slug> GREEN` | the mutation survived: no instrument asserts that behaviour | the builder: a real test |
| `ACn <slug> PRE_RED` | the selector fails before the mutation | the builder's test is broken, or the base is |
| `ACn <slug> SELECTOR_INVALID` | the selector names no test (wrong path, wrong `-t`, a shell command in a `.test`) | whoever wrote it; a `.cmd` if it is not vitest |
| `ACn <slug> PATCH_INVALID` | the patch does not apply to the head | the patch was made before the last commit |
| `ACn <slug> NO_TESTS` | the mutation broke compilation | the mutation is wrong, not the test (L-08) |
| `ACn has no mutation` | no patch for that AC at all | the reviewer — or the AC cannot be instrumented: a story defect |
| `probe <name> RED` | the reviewer's edge case fails on the head | the builder; the probe is committed and becomes the instrument |

`prompts/README.md` is the contract; `ts/src/classifier.ts` is the classifier
(`check-mutation.sh` runs it by hand).

## The decision tree

- **FAIL, round < MAX_ROUNDS.** The launcher already started the next round
  with the review text in the builder's prompt. Wait.
- **FAIL at the ceiling → `needs_human`.** Read the reasons. Then:
  - the reasons are the builder's (GREEN, probe RED, baseline) and the
    story is sound → say so, and let the human decide between `reset.sh
    <repo> <id>` (back to the queue, fresh worktree) and a story edit.
  - the reasons come from the story (an AC no instrument can satisfy, a
    domain that turned out unbounded, a wrong `scope_deny`) → edit the
    story by hand, `lint-story.sh --strict`, commit, and tell the human it
    needs `/promote` again. Fold a probe's finding into the AC it belongs
    under; never add an AC for it — that becomes another branch nobody
    stated (see `prompts/review.md`).
  - the head is good and only the evidence was wrong (a `.test` that should
    have been a `.cmd`, a stale patch) → `REVIEW_ONLY=1` re-reviews the head
    without a builder; the human runs it, or the queue does after a reset.
- **`SPEC`.** The reviewer showed a criterion no implementation can
  satisfy. It is immune to the veto and stops the rounds. Read its
  structural reason; fix the story or drop the AC.
- **`UNPARSEABLE`.** The reviewer ended without a `VERDICT:` line. Read
  `reviewer.md`; if the prose is a review, the round was wasted, not wrong.
  Twice on one story: try `REVIEWER_MODEL=<other model>` (a launcher
  environment variable; recorded as `reviewer:` in the block).
- **`blocked`.** `.blocked/<id>.md` holds the question, the options and the
  builder's recommendation. Draft the answer; the human sends `/answer
  <repo> <id> <text>`. A product question is theirs; a technical one you
  can answer from the code, say so and let them send it.
- **`in_progress` for longer than `AGENT_TIMEOUT` (default 30 min per
  agent call) with no new round** → the launcher may be dead. Check
  `ps`, the `.runs/` log, and report; do not start another.
- **A PASS you doubt.** Read `Known weakness` in the story and the probes
  the reviewer left. What the criteria did not instrument is not verified;
  say so to the human before they land it. Human verification steps are in
  the story.

## What to report

The story id, the computed verdict and its reasons in plain words, who owns
the fix, and the one command the human should send. Not the reviewer's
prose, which they can read in `.review/<id>.md`.
