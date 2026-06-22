---
cell_id: community-ops
title: Community Ops Engine
summary: 社区事件 Log（append-only canonical）、CommunityObject 投影/状态机、closure invariant、activity-signal 双游标交付、awaiting_external 状态流转与交付策略。
canonical_features: [F168]
code_anchors:
  - packages/shared/src/types/community-event.ts
  - packages/api/src/domains/community/CommunityEventLog.ts
  - packages/api/src/domains/community/community-projector.ts
  - packages/api/src/domains/community/community-state-machine.ts
  - packages/api/src/domains/community/CommunityObjectStore.ts
  - packages/api/src/domains/community/community-bootstrap.ts
  - packages/api/src/domains/community/community-keys.ts
  - packages/api/src/domains/community/community-delivery-policy.ts
  - packages/api/src/domains/community/community-auto-tracking.ts
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
static_scan_hints: [CommunityEvent, CommunityObject, CommunityEventLog, community-projector, community-state-machine, closure_invariant, community-bootstrap, community-delivery-policy, community-auto-tracking, awaiting_external, decideDelivery, CommunityRole, RoleResolver, RoleBinding, ClosureChecklistCard, ReconciliationFindingCard, WaiverAuditForm]
cited_by:
  - {feature: F168, date: 2026-06-10, delta: new cell}
  - {feature: F168-Phase-B, date: 2026-06-10, delta: "dual-cursor delivery + case.awaiting_external + delivery-policy + auto-tracking"}
  - {feature: F168-Phase-C, date: 2026-06-13, delta: "RoleResolver binding layer — engine routes by CommunityRole via injected resolver (fail-closed), INV-6 engine-zero-catname grep guard"}
  - {feature: F168-Phase-D, date: 2026-06-17, delta: "Closure UX + Reconciler plan — closureChecklist selector, GitHub⇄Case diff task, reconciliation finding store, SLA/dead-letter queue"}
  - {feature: F168-Phase-D-PR3, date: 2026-06-19, delta: "D5 Closure UX web components — ClosureChecklistCard, ReconciliationFindingCard, WaiverAuditForm, CommunityPanel integration"}
  - {feature: F168-Phase-E-PR2, date: 2026-06-19, delta: "Decision Queue UX — CommunityPanel renders prioritized queue above raw Issues/PRs/Findings and wires queue actions"}
---

# Community Ops Engine

## Canonical Owner

F168 owns the community operations event-sourcing infrastructure: append-only Event Log as the single internal-canonical truth for case state, CommunityObject as a rebuildable projection, and closure invariants enforced by the state machine.

## Use This When

- Adding new community event types (GitHub webhook events, scan-derived events, internal decision events).
- Changing case state transition rules or closure guard logic.
- Building narrator / triage roles that read case projections.
- Extending the community board aggregation endpoint.
- Adding reconciler logic (GitHub truth ⇄ Case projection diff).
- Adding closure UX / closureChecklist / SLA dead-letter behavior.
- Adding decision queue selectors, route adapters, or CommunityPanel decision actions.

## Extend By

- Append new `CommunityEventKind` values to the shared type and add transition rules to the state machine's explicit table.
- Implement new projection side-effects as pure functions inside `community-projector.ts`.
- The Role Registry (`RoleResolver` interface) must remain engine-agnostic — no cat names, no roster imports in core packages.

## Do NOT Unify With

- Do not add a second canonical store for community case state. `CommunityEventLog` is the only truth source; `CommunityObjectStore` is a rebuildable projection.
- Do not import `getRoster()` or any cat-name constant from core engine code (multi-tenant boundary — Phase C RoleResolver migration point).
- Do not move delivery/wake-up logic here; that belongs to the `dispatch` cell. Phase A only appends events as side-effects; it does not change invocation paths.
- Do not store GitHub facts as canonical; GitHub is external truth verified by the Reconciler (Phase D).
- Do not make the Decision Queue a second canonical workflow store; it is a read-model selector over projections, findings, and closureChecklist.

## Static Scan Hints

Watch for new `CommunityEvent`, `CommunityObject`, `community:events:`, `community:object:`, `closure_invariant`, `case.bootstrap`, `projector`, `RoleResolver`, `CommunityDecisionQueue`, or `DecisionQueuePanel` code.
