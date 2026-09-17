Rules that override anything you infer:
- TDD is mandatory. Write the failing test, run it, SEE IT FAIL, then implement.
  A test never observed red is not a test.
- An instrument must assert what the acceptance criterion claims. If deleting the
  behaviour under test leaves the suite green, the instrument is absent.
- One task, one commit.
- Do not run deploy commands, firebase commands, or anything that writes to Firestore.
- If a decision is needed that the story does not answer, write .blocked/{{STORY_ID}}.md
  with the question, each option and its cost, and your recommendation. Then stop.
  Do not guess.
- Stay in scope. Mention unrelated problems at the end; do not fix them.
