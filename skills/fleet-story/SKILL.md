---
name: fleet-story
description: Turn a wish into a fleet story — write the intent, run fleet write-story, review the draft as the human would, hand-edit, lint with fleet lint-story, commit the draft. Use when asked to prepare, write, draft, fix or review a story for a fleet target such as khaita-app.
---

# From a wish to a story a human can promote

A story is the only specification the builder and the reviewer get; neither
can ask anything. `fleet write-story` has an agent draft it from the code,
and `fleet lint-story` checks it mechanically. Your part is the intent going in and
the review coming out. Promoting it is yours too, under the human's delegation
(`fleet-coordinate`).

## 1. The intent

Write the intent as a file first (a scratch file, not in the repo), then pass
its contents. A good intent is a report, not a diagnosis — the writer
verifies the premise against the code — but it states every product
decision the human has already made, in the human's words, so the writer
does not invent one. If a decision is still open, say so in the intent; the
writer will surface it under Evidence and the story waits for the answer.

State what is out of scope when you know it. Name the previous story when
this one continues it. Do not paste code into an intent.

Point the writer at the code: name the files, and the `path:line`s you
already found. Tell it to read the code, not to build, run or measure. A
writer that sets out to measure, or is given a wide brief, runs out of turns
before it writes the file (L-43). One concern per intent: a wish with three
concerns is three stories.

## 2. The draft

```bash
cd ~/work/fleet
./fleet new-epic <repo> <name>                                   # only if the epic does not exist
./fleet write-story <repo> <id> "$(cat intent.txt)" --base epic/<name>
```

Ids are three digits and ascend in the order the stories should run — the
queue takes the lowest `ready` id first. A story on the integration branch
itself takes no `--base`. Draft the next story only after the previous one
reads `on epic`: the writer reads the epic's tip, and until then the code
it would cite still has the previous story's defect.

The writer runs in a throwaway worktree at the epic's tip and writes
`.stories/<id>.md` at `status: draft`. The command lints it and prints the
result. Its exit code is the lint's.

## 3. The review — this is the work

Read the whole draft. Then check, against the base branch (not the
checkout, which is usually `develop`):

1. **Premise.** Does the Evidence section show the symptom in the files as
   they are on the base? A story written on a premise that stopped being
   true costs rounds before anyone notices.
2. **Bounded domain.** Every acceptance criterion ranges over a set it
   names. An unquantified *every*, *all* or *any* in an AC heading is a
   scope declaration the reviewer will read literally (L-20).
3. **One named mutation per AC.** Each `**ACn — …**` says which instrument
   proves it and which change to which file turns that instrument red. An
   AC whose instrument cannot go red is worse than none: the machine vetoes
   a surviving mutation.
4. **Citations.** `path:line` must exist on the base at that line. The lint
   checks this against the base; a hand edit can rot one.
5. **Known weakness** states what the criteria do not establish — what is
   mocked, what only a browser shows, which scenario was never observed. A
   reviewer that finds an unstated weakness fails the story for it.
6. **scope_deny** names the files the builder must not touch, with the
   reason under Out of scope. `.fleet/*` is always denied by the harness.
7. **No AC says "suite/build/lint stays green"** — the baseline is run
   unconditionally.
8. **Product decisions.** If Evidence raises a question and you have a
   recommended option, take it and record it in the story as the
   coordinator's choice under the human's delegation (`fleet-coordinate`);
   put it to the human only when you have none. Either way add the AC by
   hand — that has been the right move before.
9. **model:** in the frontmatter names the builder's model, as an alias
   only (`fleet lint-story` refuses anything else), so a new release is
   picked up with no edit: omit it for the default (`sonnet`) on a bounded
   story; `opus` for design-heavy or diagnose-first stories (service-worker
   rewrites, state machines, an unknown cause). `fable` only after a trial
   is recorded in `docs/COORDINATORS.md` (Trials). `haiku` is retired: in
   both of its trials the cheap tier cost a round instead of saving one.

10. **Red on the base, for the reason stated.** For each AC, would its
   instrument fail on the base, in the environment it runs in? Headless
   Chromium is not a phone's Safari, and jsdom has no layout. If the base
   already passes, the AC proves nothing: rewrite it to require the
   structural property that makes it right everywhere. Check every
   "Goes red when" that rests on a third party's behaviour (an audit rule
   firing, a browser quirk): measure it yourself, or have the AC assert the
   thing directly. Each has cost a round (L-43).

Hand-edit what the review found. Keep the writer's citations unless you
verified a replacement. After any edit:

```bash
./fleet lint-story <repo> <id> --strict     # 0 errors before you commit
```

## 4. Commit and hand over

```bash
git -C <target> add .stories/<id>.md
git -C <target> commit -m "story(<id>): draft"
git -C <target> push
```

The commit carries the human's name only — no trailer naming a harness or
a model.

Then promote it, and tell the human: the story id, its title, what it
asks, any choice you made for them, any question still open, the harness and model that drafted it (the trials in
`docs/COORDINATORS.md` are recorded from this message), and that you
promoted it. Do not start a launcher.

## Signs the story is wrong, not the build

A story with five criteria over a whole file took eight rounds; two bounded
criteria passed first time. If the draft is wide, split it: ids are cheap.
If the writer says the request is already true on the base, believe the
Evidence, check it, and tell the human the story is not needed — that is a
result, not a failure.

If instead the writer finds the *premise* was wrong — not "already fixed"
but "never a defect" (khaita 049: the flagged lookup was deliberate,
load-bearing design; narrowing it broke 9 of 64 tests) — tell the human;
declining is theirs (`ts/src/status.ts`). On their word, set `status:
declined` rather than leaving it `draft`. It stays in `.stories/` for its
Evidence and citations, is never picked up by the queue (it isn't
`ready`), and `fleet status --bot` hides it by default like `landed`/`done`
(squadra-fleet PR #25). Commit it declined; do not promote it.
