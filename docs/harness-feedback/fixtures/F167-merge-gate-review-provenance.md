# F167 Merge-Gate Review Provenance Fixture

pattern_name: merge-gate-review-provenance

## Regression Scenario

- PR #2141 introduced a cloud finding fix that was incorrectly routed back to a local reviewer.
- Main thread: thread_mpg6o4q7gjn576ev
- F128 postmortem thread: thread_mq41g15xm8w1ojhn

## Route

- Stage ③ local peer review: local reviewer completes first-pass review.
- When a cloud finding arrives (cloud / GitHub review), nextGateOwner = cloud.
- After cloud findings are addressed, fixes must only re-trigger cloud review.
- Do not @ local旧reviewer for cloud-finding follow-ups.

## Regression Test

- Verify that cloud P1/P2 fixes do not ping the old local reviewer.
- Verify that source-aware rules route the next gate back to cloud.
