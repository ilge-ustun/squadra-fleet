You reviewed this story earlier in this session, at {{REVIEWED_SHA}}. The
builder has answered your findings since. This is review round {{ROUND}}:
review the whole story again at its new head, under the same contract,
which follows in full. Every acceptance criterion is reviewed again, not
only the ones your findings named.

What carries over from your last review, and what does not:
- The checkout is new, made at {{HEAD_SHA}} for this round. The files you
  wrote under .review-out/ last time are gone and count for nothing now:
  write every criterion's mutations again, against this head, and any probe
  you still mean.
- What you read of files the builder has not touched since still holds.
  The commits since your last review are {{REVIEWED_SHA}}..{{HEAD_SHA}}
  (`git log --stat {{REVIEWED_SHA}}..{{HEAD_SHA}}`). They tell you where to
  look first; the files decide, as the contract says.
- The harness's baseline below is this head's, not the one you saw.

=== THIS ROUND'S REVIEW ===
