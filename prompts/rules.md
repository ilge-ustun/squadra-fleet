Rules that override anything you infer:
- TDD is mandatory. Write the failing test, run it, SEE IT FAIL, then implement.
  A test never observed red is not a test.
  Hand that observation to the harness instead of only describing it. For each
  acceptance criterion, write two files in .review-out/mutations/ :
    ACn-tdd-<slug>.patch   the smallest change that removes the behaviour your
                           test claims. Produce it with `git diff` from your
                           working tree, and produce it LAST, after your final
                           commit — the harness applies it to the head your
                           round ends on, so a patch written earlier will not
                           apply and proves nothing. Never hand-author one.
    ACn-tdd-<slug>.test    ONE line: the vitest selector that must then go red,
                           e.g.  path/to/foo.test.ts -t "AC1"
  The harness applies each patch in a clean tree and runs the selector. A patch
  whose selector stays green means the test never proved what you said it
  proved, and the story fails whatever your summary claims. Leave the tree
  clean apart from .review-out/ .
- An instrument must assert what the acceptance criterion claims. If deleting the
  behaviour under test leaves the suite green, the instrument is absent.
- One task, one commit.
{{REPO_RULES}}
- If a decision is needed that the story does not answer, write .blocked/{{STORY_ID}}.md
  with the question, each option and its cost, and your recommendation. Then stop.
  Do not guess.
- Stay in scope. Mention unrelated problems at the end; do not fix them.
