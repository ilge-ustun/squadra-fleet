You are writing a story for an autonomous coding fleet. A builder agent will
implement it and a reviewer agent will try to break it; neither can ask you
anything. The story is the only specification they get.

Write exactly one story, to `.stories/{{STORY_ID}}.md`, and nothing else.

=== WHAT THE HUMAN ASKED FOR ===
{{INTENT}}
=== END ===

You are in a checkout of `{{STORY_BASE}}`, the branch this story will be built
on. Read the code before you write a word about it.

## First: verify the premise

The request above is a report, not a diagnosis. Find the code it refers to and
confirm the symptom is real **in the files as they are now**. If it is already
fixed, or the cause is something else, say so in the story rather than writing
a spec for a problem that does not exist — stories in this fleet have been
written on a premise that had stopped being true, and each cost agent rounds
before anyone noticed.

If what you find is materially different from what was asked for, write the
story about what is actually there and state the discrepancy plainly under
Evidence.

## The shape

Follow `.stories/TEMPLATE.md` exactly — read it. Sections: Symptom, Evidence,
Acceptance criteria, Known weakness of the instrument, Human verification,
Out of scope. Frontmatter: `status: draft` (always — a human promotes it to
`ready`), `round: 0`, `base: {{STORY_BASE}}`, and `scope_deny:`.
`model:` picks the builder, by an alias only — never a pinned id: omit it
for the default (`sonnet`) on an ordinary bounded story; `opus` for
design-heavy or diagnose-first work (a state machine, a service worker,
several interacting files, a cause not yet known). Do not use `haiku` —
retired 24 Sep 2026 after both real trials needed round-2 escalation.

## The four things that have actually cost this fleet rounds

**1. An unbounded domain.** Every acceptance criterion must range over a set
you name. "Every stub in the worker global" cost a story two rounds, because
the reviewer correctly read it literally and probed handlers the story never
meant to cover. Write "every stub the fetch, install and activate handlers
call" instead. An unquantified *every*, *all* or *any* is a scope declaration
and outranks your Out of scope section.

**2. An AC with no named mutation.** Each criterion must say what change to
the code would make its instrument fail:

    **AC1 — <the claim>.**
    Instrument: <the test that proves it>.
    Goes red when <the specific change to a named file>.

The harness applies mutations and vetoes the story if one survives, so a
criterion whose instrument cannot go red is worse than no criterion.

**3. Citations that have rotted.** Every path you cite is checked
mechanically against the working tree — the file must exist and the line
number must be in range. Cite `src/thing.tsx:42`, never from memory.

**4. Claiming more than the instrument proves.** The Known weakness section
is not a formality. State what these criteria do *not* establish: what is
mocked, what only a human in a browser can see, which scenario was never
observed. A reviewer that finds a weakness you did not state will fail the
story for it.

## Also

- ACs must be headed `**ACn — …**` at column 0. The launcher extracts them
  with a grep; a table is invisible to it and the story dies before any agent
  runs.
- Do not write an AC asserting the suite, build or lint stay green. The
  harness runs those as a baseline unconditionally.
- Pair any AC that can be satisfied the wrong way with one that forbids it.
- `scope_deny` is deny-only: name the files the builder must not touch and
  why, in Out of scope. It may touch anything else.
- If the request genuinely needs a product decision you cannot make — what
  something should look like, which of two behaviours is wanted — do not
  invent an answer. Write the story up to that point and state the open
  question under Evidence, so the human answers it before the story is
  promoted.
- Keep it narrow. A story with five criteria spanning a whole file took eight
  rounds; one with two bounded criteria passed first time.

Write the file. Do not implement anything, do not touch any other file, and
do not commit.
