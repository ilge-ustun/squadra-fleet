You handed over. The harness ran its baseline on your final commit, in a
clean worktree of its own, and it is RED. Nobody has reviewed the round yet:
the reviewer runs once the baseline is green, or once these fixes are spent,
and a RED baseline then fails the round however good the rest is.

=== THE HARNESS'S BASELINE AT YOUR HEAD ===
{{BASELINE_RED}}
=== END BASELINE ===

Fix only that — the RED runs above — within the story's scope and under the
same rules as before. Nothing else: no new work, no clean-ups.

1. Reproduce it in your worktree with the narrowest command that shows the
   failure (one test file, the type check, the one lint rule), find the
   cause, fix it, and commit.
2. Then regenerate EVERY ACn-tdd-<slug>.patch and .test pair after your
   final commit into .review-out/mutations/, as the rules say: the harness
   applies them to the head this fix ends on, and the pairs you handed over
   before were made against a head that no longer exists. Do not run the
   classifier over them: the harness runs them on your new head as soon as
   its baseline there is green, and hands back any that is not RED.
3. Do not run the whole baseline yourself. The harness runs it again on your
   new head as soon as you finish, and if a run is still RED it hands you
   the log again, in this session, until its fixes are spent.

If the run is RED on the story's base as well and the cause lies outside the
story's scope, commit nothing: say so in your final message and stop. The
round then fails on the baseline, and a human reads why. If the fix needs a
decision the story does not answer, write .blocked/{{STORY_ID}}.md as the
rules say, and stop.
