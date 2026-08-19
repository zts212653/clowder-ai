---
cell_id: community-ops
title: Community Ops Engine
summary: 社区事件 Log（append-only canonical）、CommunityObject 投影/状态机、closure invariant、activity-signal 双游标交付，以及 external case current-HEAD review/delivery/custody-return workflow；GitHub wait predicate 由 F280 github-signals 提供。
canonical_features: [F168]
code_anchors:
  - packages/shared/src/types/community-event.ts
  - packages/api/src/domains/community/CommunityEventLog.ts
  - packages/api/src/domains/community/community-projector.ts
  - packages/api/src/domains/community/external-review-aggregate.ts
  - packages/api/src/domains/community/external-review-projector.ts
  - packages/api/src/domains/community/community-state-machine.ts
  - packages/api/src/domains/community/CommunityObjectStore.ts
  - packages/api/src/domains/community/community-bootstrap.ts
  - packages/api/src/domains/community/community-keys.ts
  - packages/api/src/domains/community/community-delivery-policy.ts
  - packages/api/src/domains/community/community-auto-tracking.ts
  - packages/api/src/domains/community/CommunityRepoConfigStore.ts
  - packages/api/src/routes/community-repo-config.ts
  - packages/shared/src/types/community-role.ts
  - packages/api/src/domains/community/RoleResolver.ts
  - packages/api/src/domains/community/community-closure-checklist.ts
  - packages/api/src/domains/community/CommunityReconciler.ts
  - packages/api/src/domains/community/CommunityReconciliationFindingStore.ts
  - packages/api/src/infrastructure/connectors/github-repo-event/CommunityReconcilerTaskSpec.ts
  - packages/api/src/domains/community/community-decision-queue.ts
  - packages/api/src/routes/community-decision-queue.ts
  - packages/web/src/components/community/ClosureChecklistCard.tsx
  - packages/web/src/components/community/ReconciliationFindingCard.tsx
  - packages/web/src/components/community/DecisionQueuePanel.tsx
  - packages/web/src/components/community/DecisionQueueItem.tsx
doc_anchors:
  - docs/features/F168-community-ops-board.md
  - feature-discussions/2026-06-09-f168-community-ops-final-design.md
  - docs/features/F280-unified-wait-contract.md
  - feature-discussions/2026-07-29-f280-unified-wait-contract/README.md
static_scan_hints: [CommunityEvent, CommunityObject, CommunityEventLog, community-projector, community-state-machine, external-review-aggregate, ExternalReviewAggregate, reviewMode, cloudReviewPolicy, currentHeadSha, headGeneration, lastReviewedHeadSha, lastDeliveredHeadSha, closure_invariant, community-bootstrap, community-delivery-policy, community-auto-tracking, awaiting_external, decideDelivery, CommunityRole, RoleResolver, RoleBinding, ClosureChecklistCard, ReconciliationFindingCard, WaiverAuditForm]
cited_by:
  - {feature: F168, date: 2026-06-10, delta: new cell}
  - {feature: F168-Phase-B, date: 2026-06-10, delta: "dual-cursor delivery + case.awaiting_external + delivery-policy + auto-tracking"}
  - {feature: F168-Phase-C, date: 2026-06-13, delta: "RoleResolver binding layer — engine routes by CommunityRole via injected resolver (fail-closed), INV-6 engine-zero-catname grep guard"}
  - {feature: F168-Phase-D, date: 2026-06-17, delta: "Closure UX + Reconciler plan — closureChecklist selector, GitHub⇄Case diff task, reconciliation finding store, SLA/dead-letter queue"}
  - {feature: F168-Phase-D-PR3, date: 2026-06-19, delta: "D5 Closure UX web components — ClosureChecklistCard, ReconciliationFindingCard, WaiverAuditForm, CommunityPanel integration"}
  - {feature: F168-Phase-E-PR2, date: 2026-06-19, delta: "Decision Queue UX — CommunityPanel renders prioritized queue above raw Issues/PRs/Findings and wires queue actions"}
  - {feature: F168-Phase-F-Step3, date: 2026-07-14, delta: "External review aggregate — current HEAD readiness, independent review/delivery heads, repo review policy, and durable delivery responsibility"}
  - {feature: F280-Phase-A, date: 2026-07-29, delta: "external review may explicitly request a typed await after custody returns; review start auto-tracking and actor-policy wake inference move out"}
---

# Community Ops Engine

## Canonical Owner

F168 owns the community operations event-sourcing infrastructure: append-only Event Log as the single internal-canonical truth for case state, CommunityObject as a rebuildable projection, and closure invariants enforced by the state machine. External-review workflow decides when review custody has returned to an external author and may then request one explicit typed await. The await lifecycle belongs to `ball-custody`; GitHub source predicates and compact deltas belong to `github-signals`.

## Use This When

- Adding new community event types (GitHub webhook events, scan-derived events, internal decision events).
- Changing case state transition rules or closure guard logic.
- Building narrator / triage roles that read case projections.
- Extending the community board aggregation endpoint.
- Adding reconciler logic (GitHub truth ⇄ Case projection diff).
- Adding closure UX / closureChecklist / SLA dead-letter behavior.
- Adding decision queue selectors, route adapters, or CommunityPanel decision actions.
- Extending external-review current-HEAD generation, readiness, terminal, verdict-custody, or eval behavior.
- Changing when an external-review workflow explicitly establishes or replaces an await after
  verdict delivery/custody return.

## Extend By

- Append new `CommunityEventKind` values to the shared type and add transition rules to the state machine's explicit table.
- Implement new projection side-effects as pure functions inside `community-projector.ts`.
- Extend external-review lifecycle facts through `CommunityEventKind` plus the pure `external-review-projector.ts` / `external-review-aggregate.ts` reducers. `ExternalReviewCoordinator` may orchestrate IO, while verdict custody and eval adapters consume the same projection.
- Request waits through the F280 typed contract only after the workflow is actually blocked.
  Workflow defaults may fill typed predicates, but actor/repo role must not become a hidden wake mode.
- The Role Registry (`RoleResolver` interface) must remain engine-agnostic — no cat names, no roster imports in core packages.

## Do NOT Unify With

- Do not add a second canonical store for community case state. `CommunityEventLog` is the only truth source; `CommunityObjectStore` is a rebuildable projection.
- Do not add a parallel external-review store. `ExternalReviewAggregate` is a projection slice on `CommunityObjectProjection`; current HEAD generation, readiness, wake, terminal, and delivery proof all rebuild from the canonical event log.
- Do not import `getRoster()` or any cat-name constant from core engine code (multi-tenant boundary — Phase C RoleResolver migration point).
- Do not move delivery/wake-up logic here; that belongs to the `dispatch` cell. Phase A only appends events as side-effects; it does not change invocation paths.
- Do not auto-register tracking when formal review starts; the reviewer still has executable custody.
  Establish an await only after verdict/findings are delivered and custody leaves the reviewer.
- Do not own GitHub collector cursor, predicate matching, Bot/User filters, or compact signal rendering;
  those belong to `github-signals`.
- Do not store GitHub facts as canonical; GitHub is external truth verified by the Reconciler (Phase D).
- Do not make the Decision Queue a second canonical workflow store; it is a read-model selector over projections, findings, and closureChecklist.

## Static Scan Hints

Watch for new `CommunityEvent`, `CommunityObject`, `community:events:`, `community:object:`, `closure_invariant`, `case.bootstrap`, `projector`, `ExternalReviewAggregate`, `headGeneration`, `ExternalReviewCoordinator`, `RoleResolver`, `CommunityDecisionQueue`, or `DecisionQueuePanel` code.
