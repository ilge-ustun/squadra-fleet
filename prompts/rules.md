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
  Before you finish, run the harness's own classifier on your evidence:
    {{CHECK_MUTATION}} .review-out/mutations/AC*-tdd-*.patch
  It refuses an uncommitted tree, applies each patch, runs its selector,
  undoes the patch, and prints the class the verdict will print. Anything
  but RED is a finding you still own — fix the test, the patch or the
  selector, commit, regenerate the patch, run it again.
- An instrument must assert what the acceptance criterion claims. If deleting the
  behaviour under test leaves the suite green, the instrument is absent.
- Before you hand over, attack your own work the way the reviewer will. It
  does not read your diff; it reads the files, runs the suite, and asks of
  every criterion which instrument proves it and whether that instrument
  asserts what the criterion claims. It answers the second by deleting the
  behaviour under test outright: if the suite stays green the instrument is
  absent, not weak, and the story fails. Do that deletion yourself, for every
  criterion, before you write its tdd- patch. Then construct the case the
  reviewer will construct — the second click, the remount, the teardown
  while a request is in flight, the second tab, the trailing slash, the
  wrong key, whichever this story's code has — and cover it with a test in
  the suite, not a comment. The reviewer leaves such a case behind as a
  PROBE, a test the harness runs against your head; a probe that fails
  fails the story whatever else passed, and a case you could think of and
  did not cover is a round you will spend.
  The verdict's vocabulary, so a FAIL reads as a fact:
    baseline test|build|lint RED   red at your head, whatever the story says
    scope                          a path the story denies was changed
    ACn <slug> GREEN               the mutation survived: no instrument for it
    ACn <slug> PRE_RED             the selector fails before the mutation
    ACn <slug> SELECTOR_INVALID    the selector names no test (path, -t)
    ACn <slug> PATCH_INVALID       the patch does not apply to your head
    ACn <slug> NO_TESTS            the mutation broke compilation
    ACn has no mutation            no patch at all for that criterion
    probe <name> RED               the reviewer's probe found a regression
- One task, one commit.
- Before branching on a value to decide which of two mechanisms delivers an
  outcome, check the value tells the cases apart. One that is absent both when
  something has finished and while it is still in flight does not, and no
  guard added afterwards will separate them: guard and the other case appears.
  Find the value that differs between them and branch on that.
{{REPO_RULES}}
- If a decision is needed that the story does not answer, write .blocked/{{STORY_ID}}.md
  with the question, each option and its cost, and your recommendation. Then stop.
  Do not guess.
- Stay in scope. Mention unrelated problems at the end; do not fix them.
