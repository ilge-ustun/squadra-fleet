You handed over. The harness's baseline at your head is GREEN, and it then
ran the tdd- pairs you handed over, in a clean worktree of its own, through
the classifier the verdict uses. Not every pair is RED. Nobody has reviewed
the round yet: the reviewer runs once every pair is RED, or once these fixes
are spent, and a pair that is not RED then fails the round.

=== THE HARNESS'S RUN OF YOUR PAIRS ===
{{TDD_RED}}
=== END ===

Fix only those pairs, within the story's scope and under the same rules as
before. Nothing else: no new work, no clean-ups.

1. Find which side is wrong. A SELECTOR_INVALID or PATCH_INVALID pair is
   wrong evidence: fix the selector, or make the patch again from your
   committed head. A GREEN pair is a test that does not assert what its
   patch removes: fix the test and commit, or, if the patch removes
   something no criterion claims, make the patch remove the behaviour the
   test asserts. A PRE_RED selector fails before any patch; a NO_TESTS
   patch breaks compilation: remove the behaviour, not the code that builds.
2. Then hand over EVERY pair again into .review-out/mutations/, made after
   your final commit: the set you hand over replaces the one before, and a
   pair you leave out is gone.
3. Do not run the classifier over all of them, nor the whole baseline. The
   harness runs the pairs again as soon as you finish — after its baseline,
   on your new head, if you committed — and hands you what is still not
   RED, in this session, until its fixes are spent.

If a pair cannot go red with the instrument the story prescribes, the story
claims more than that instrument can show: that is a decision the story does
not answer. Write .blocked/{{STORY_ID}}.md as the rules say, and stop.
