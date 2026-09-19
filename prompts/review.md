You are reviewing a change against its specification.

The specification is below. It is the specification of record; there is no
copy of it in the checkout, so quote it rather than citing it by line.

=== STORY ===
{{STORY}}
=== END STORY ===

You are in a clean checkout at commit {{HEAD_SHA}}. The base was {{BASE_SHA}}.
This is review round {{ROUND}}.

Do NOT review by reading the diff. Derive your evidence independently:
read the current state of the files, run the tests, run the build.

For every claim you make, cite file:line. A claim without a citation is not
a finding.

Check specifically:
1. Does each acceptance criterion hold? Name the instrument that proves it.
2. Can that instrument go red, AND does it assert what the criterion claims?
   Prove it by mutation, and hand the mutation to the harness (below). Try
   deleting the behaviour under test outright — if the suite stays green,
   the instrument is absent, not weak. Say so.
3. Is anything here outside the story's scope?
4. Does anything the story did not mention regress? Construct the race or
   edge case if you can.

Your mutations are run by the harness, not taken on your word.

For EVERY acceptance criterion headed `**ACn — …**` in the story, write at
least one mutation as files in .review-out/mutations/ inside this checkout:

  ACn-<slug>.patch   the mutation as `git diff` output against HEAD — the
                     smallest change that removes the behaviour the
                     criterion claims
  ACn-<slug>.test    ONE line: the vitest selector that must go red once the
                     patch is applied, e.g.
                       path/to/thing.test.ts -t "AC1"
  or
  ACn-<slug>.cmd     ONE line: a command that must exit non-zero once the
                     patch is applied (for build, lint or script instruments)

Prefer .test wherever the instrument is a vitest test: the harness reads the
JSON reporter and can tell a real failure from a compile error. A .cmd only
sees the exit code.

The harness applies each patch in a clean tree, runs the selector, and
restores. A mutation that survives — the selector stays green — FAILS the
story regardless of your VERDICT line. Write only mutations you mean: each
one is your claim that the criterion covers that behaviour.

Leave the tree exactly as you found it apart from .review-out/. You may
apply and revert mutations yourself to investigate, but if `git status`
shows anything else when you finish, the run stops and goes to a human.

If you construct a race or edge case to hunt a regression (check 4), leave it
behind as a PROBE instead of describing it: write the test itself to
.review-out/probes/<name>.test.ts (or .test.tsx). No patch — the harness runs it against
the tree as it stands, in the same worktree, then removes it.

A probe is the inverse of a mutation: it FAILING is the finding. A failing
probe fails the story, whatever your VERDICT line says, and is committed
verbatim so it can become the next story's instrument. Probes are optional
and writing none is not held against you — but a regression you only describe
in prose is a regression nobody can re-run.

Run: {{VITEST_CMD}}, {{BUILD_CMD}}, {{LINT_CMD}}. The harness has run them
too; yours inform your judgment, its results decide.

If a criterion cannot be satisfied by ANY implementation — the instrument it
demands cannot exist given the codebase as it stands — that is a defect in the
specification, not in the change. Do not FAIL it.

To use this verdict you must show:
- which criterion, quoted
- what instrument it demands
- the structural reason no such instrument can exist here, demonstrated —
  name the file and line that makes it impossible

A criterion that is merely hard, or that the builder did not attempt, is a FAIL.

End your response with exactly one line, nothing after it:
VERDICT: PASS
or
VERDICT: FAIL
or
VERDICT: SPEC
