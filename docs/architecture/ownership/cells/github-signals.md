---
cell_id: github-signals
title: GitHub Work Item Signals
doc_kind: architecture
created: 2026-07-29
summary: GitHub PR/issue 外部事实采集、source frontier、snapshot、typed wait predicate resolver 与 matched-delta renderer；采集事实不直接裁决责任或投递。
canonical_features: [F133, F140, F280]
code_anchors:
  - packages/shared/src/types/task.ts
  - packages/api/src/infrastructure/github/comment-cursors.ts
  - packages/api/src/infrastructure/email/ReviewFeedbackTaskSpec.ts
  - packages/api/src/infrastructure/email/ReviewFeedbackRouter.ts
  - packages/api/src/infrastructure/email/CiCdCheckTaskSpec.ts
  - packages/api/src/infrastructure/email/CiCdRouter.ts
  - packages/api/src/infrastructure/email/ConflictCheckTaskSpec.ts
  - packages/api/src/infrastructure/email/ConflictRouter.ts
  - packages/api/src/infrastructure/email/IssueCommentTaskSpec.ts
  - packages/api/src/infrastructure/email/IssueCommentRouter.ts
  - packages/api/src/domains/plugin/github-schedule-factories.ts
doc_anchors:
  - docs/features/F133-cicd-tracking.md
  - docs/features/F140-github-pr-automation.md
  - docs/features/F280-unified-wait-contract.md
  - feature-discussions/2026-07-29-f280-unified-wait-contract/README.md
static_scan_hints: [ReviewFeedbackTaskSpec, ReviewFeedbackRouter, CiCdCheckTaskSpec, CiCdRouter, ConflictCheckTaskSpec, ConflictRouter, IssueCommentTaskSpec, IssueCommentRouter, comment-cursors, github-schedule-factories, GitHubWaitPredicate, GitHubWaitBaseline, AwaitPredicateCatalog, matchedDelta]
cited_by:
  - {feature: F280-Phase-A, date: 2026-07-29, delta: "new cell closes the previously ownerless PR tracking and source projection pipeline; wait lifecycle remains in ball-custody"}
---

# GitHub Work Item Signals

Architecture cell: github-signals

## Canonical Owner

F133/F140 own the existing GitHub CI/review/conflict collection lineage. F280 makes the boundary
explicit: this cell owns external GitHub fact collection, collector frontier/cursor, baseline snapshot,
typed GitHub wait predicate resolution, and compact matched-delta rendering for PR/issue sources.

GitHub remains external truth. Stored cursors, fingerprints and event rows are durable observation
state and provenance; they do not decide who owns work, whether a cat should wake, or whether a PR
may merge.

## Use This When

- Adding or changing GitHub PR/issue collection sources, cursor/frontier semantics, fingerprints,
  snapshot readers, schedule task specs, or source fact normalization.
- Adding a typed GitHub wait predicate resolver or its compact matched-delta renderer.
- Changing review, CI, conflict or issue source adapters without changing community case semantics.
- Classifying external-infrastructure GitHub jobs separately from executable CI truth.

## Extend By

- New source facts must define canonical subject/revision identity, collection idempotency and
  provenance before they can be exposed to a wait predicate.
- New wait predicates implement schema, canonicalizer, baseline reader, truth resolver, compact
  renderer and runtime-readiness registration. A shared type without a live producer/resolver remains
  fail-closed.
- Cursor/frontier advances when source facts are durably collected. Delivery failure never rewinds
  collection; delivery has its own generation-fenced lifecycle.
- Raw bodies stay behind source refs. Wake projection returns only matched typed deltas.

## Shared Touchpoints

- `ball-custody` owns generic `AwaitState` admission, owner generation, expiry and consume; this cell
  provides GitHub predicate capabilities.
- `community-ops` owns community case/external-review lifecycle and may request an explicit await
  after handing custody back; it does not own GitHub predicate semantics.
- `plugin` owns GitHub schedule resource registration/activation, not the task spec's signal meaning.
- `dispatch` and `transport` consume an already matched wake; they do not re-filter GitHub actors
  or comments.

## Do NOT Unify With

- Do not turn collector cursor into notification baseline. Registration history is bounded by a live
  snapshot; cursor exists for collection idempotency only.
- Do not infer actionability from `Bot` versus `User`, repo visibility, author role, or comment prose.
- Do not put owner/custody truth in this cell. It may carry an owner generation fence supplied by
  `ball-custody`, but it never mints a second owner.
- Do not move `CommunityEventLog` or external-review case state here. Community events consume
  GitHub facts but remain `community-ops` truth.
- Do not let a zero-step billing/spending-limit job count as code pass or code failure.

## Static Scan Hints

Watch for new `ReviewFeedbackTaskSpec`, `CiCdCheckTaskSpec`, `ConflictCheckTaskSpec`,
`IssueCommentTaskSpec`, `comment-cursors`, `GitHubWaitPredicate`, `GitHubWaitBaseline`,
`AwaitPredicateCatalog`, `matchedDelta`, review/CI/conflict fingerprints, or GitHub schedule source
code.
