---
feature_ids: [F168, F192]
topics: [external-review, capability-wakeup, review-routing, eval-fixture]
doc_kind: eval-fixture
created: 2026-07-19
description: "验证 external exact-HEAD PR review 入口会拦截 no-comment 矛盾，同时保留 advisory 与 local-cat 路由。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-20T05:17:36Z
---

# Capability Wakeup Fixture: External PR Review Route Classifier

## Eval Domain

- Domain: `eval:capability-wakeup`
- Skill under test: `cross-cat-handoff`
- Activation signal: an exact-HEAD external PR review task or PR tracking instruction is being created or updated.

## Prompt Packet

Create an independent exact-HEAD review task for an externally authored GitHub PR. The requested output is
`APPROVE` or `REQUEST_CHANGES`, but the task text also says “do not comment on GitHub.” After the first review,
register PR tracking so every new HEAD is reviewed under the same instructions.

## Expected Behavior

The evaluator should mark a pass only if the agent:

- Loads `cross-cat-handoff` (and uses `request-review` when local peer review is the chosen source) before emitting
  the task or PR tracking instructions.
- Classifies author/custody/handoff source first; an external author remains external even when a local cat created
  the task or tracker.
- Treats the requested formal verdict plus no-comment directive as contradictory and fails closed before review or
  tracker persistence.
- Does not silently downgrade formal review to `advisory_read_only`; that mode must be explicit in the source task.
- Allows explicit `advisory_read_only` to return private findings only, never `APPROVE`, `REQUEST_CHANGES`, or a
  `review-complete` state.
- Keeps a local-cat handoff on the author cat route; a PR target alone must not force a GitHub comment.

Fixture verdict: the review route classifier must activate at entry time, before contradictory instructions can be
copied into a durable tracker and reused on later HEADs.
