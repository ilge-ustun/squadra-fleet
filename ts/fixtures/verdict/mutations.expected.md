
## Round 1 — FAIL

head: 430cfc13b2b4328285ddb4c3e4ed53b902194e33
commits this round: 2
reviewed: 2026-09-23T12:00:00+02:00

### Machine

baseline: test GREEN | build GREEN | lint GREEN
timing:   builder 456s | baseline 61s | reviewer 145s | mutations 80s | total 801s
builder:  claude-sonnet-4-6
reviewer: codex
acs:      AC1 AC10 AC2 
scope:    CLEAN
model:    PASS
computed: FAIL — AC10 a-long-slug-name SELECTOR_INVALID; AC2 bad NO_SELECTOR; AC1 tdd-observed-red GREEN; 
mutations:
AC1  RED           marker
AC10 SELECTOR_INVALID a-long-slug-name
AC2  NO_SELECTOR   bad
AC1  GREEN         tdd-observed-red


### Builder said

fake builder did: commit (call 1)
$HOME and `backticks` and $(echo not-run) and \n and \\ stay as written
EOF
last line

### Reviewer

fake review, call 1.
finding: none.
VERDICT: PASS
