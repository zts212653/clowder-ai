---
cell_id: managed-work
title: Managed Work Identity
summary: F275-owned canonical admission and attempt identity plus explicit server-private attribution, without creating a workflow or user-facing work-management surface.
description: Thin ownership boundary for managed-work admission identity and explicit attribution.
description_source: model
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: "2026-08-01T00:00:00-07:00"
description_confirmed_by: landy
description_updated_at: "2026-08-01T00:00:00-07:00"
doc_kind: architecture
created: 2026-08-01
canonical_features: [F275]
code_anchors:
  - packages/shared/src/types/managed-work.ts
  - packages/api/src/domains/cats/services/stores/ports/WorkflowSopStore.ts
  - packages/api/src/domains/cats/services/stores/redis-keys/managed-work-keys.ts
  - packages/api/src/domains/cats/services/stores/redis/RedisWorkflowSopStore.ts
  - packages/api/src/domains/cats/services/stores/redis/managed-work-attempt-binding.ts
  - packages/api/src/domains/cats/services/agents/invocation/managed-work-invocation-binding.ts
  - packages/api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts
  - packages/api/src/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.ts
  - packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts
  - packages/api/src/domains/cats/services/stores/ports/TaskStore.ts
  - packages/api/src/domains/cats/services/stores/ports/TaskManagedWorkBinding.ts
  - packages/api/src/domains/cats/services/stores/redis/RedisTaskStore.ts
  - packages/api/src/domains/cats/services/stores/redis/RedisTaskManagedWorkBindingStore.ts
doc_anchors:
  - docs/decisions/044-managed-work-admission-identity.md
  - feature-discussions/2026-07-25-f275-managed-work-design-gate.md
  - docs/features/F275-managed-work-admission-identity.md
static_scan_hints: [WorkAdmission, WorkAttempt, workId, attemptId, managed_attributed, managed_unattributed, unmanaged_not_applicable, workflow_sop_v1]
cited_by:
  - {feature: F275, date: 2026-08-01, delta: "new thin identity cell for SOP admission, attempt 1, and explicit invocation/PR/Episode attribution"}
---

# Managed Work Identity

Architecture cell: managed-work

## Canonical Owner

F275 owns the canonical fact that a delivery work was admitted and the opaque identities that connect its work root and execution attempts. In v1 this is limited to TTL-0 `WorkAdmission`, an unbound attempt 1, authenticated bind-once executor attribution, and explicit propagation to internal invocation, PR, and TaskOutcome evidence.

The cell does not create a new user or cat workflow. Admission is a server-side side effect of the existing eligible development WorkflowSop first-persist path. Ordinary chat, questions, and open exploration remain `unmanaged_not_applicable` and acquire no identity.

## Adjacent Ownership Boundaries

- **WorkflowSop** remains the mutable execution bulletin board and the sole v1 admission trigger; it is not the work identity root.
- **TaskStore / TaskItem** owns task and PR-tracking projections. A live PR-tracking task may key private binding metadata, but shared TaskItem fields and every public projection contain no raw work identity.
- **Ball custody** owns who must act on an action subject; it may reference a work/attempt but cannot mint or infer either identity.
- **GitHub signals** own PR and CI source truth. A merge is bound candidate evidence, not automatic whole-work completion.
- **Harness eval / F267** consume attribution and validity truth read-only. They cannot create identity, repair missing bindings by thread recency, or write work terminal state.

## Durable Invariants

1. `(ownerUserId, producerKind, producerRef)` admits at most one `workId`; admission reserves exactly one Phase B `attemptId` without claiming an executor.
2. Only the closed `workflow_sop_v1` first-persist predicate may admit v1 work. Raw prose, TaskItem creation, thread/time proximity, PR registration, and eval inference are never producers.
3. Authenticated admitted invocation identity binds attempt 1 exactly once. Caller-supplied IDs, `batonHolder`, and persistence actor fields are not executor proof.
4. Missing identity never blocks the delivery workflow. It fails closed only for attribution as `managed_unattributed`; no latest-by-thread fallback is permitted.
5. Raw `workId/attemptId` remain server-private and never enter REST, socket, callback, web-store, community-board, or other user-facing task projections.
6. Phase B records no whole-work terminal state, terminal policy, reopen command, generic event ledger, repair subsystem, second producer, or multi-attempt mutation.

## Extend By

- Add a producer only through a new Design Gate backed by a stable typed business commit and its own idempotent admission anchor.
- Add Phase C attempt or terminal behavior only for a named consumer, with an explicit owner, transition contract, evidence requirements, and deterministic tests.
- Preserve the current zero-ceremony boundary: propagation is internal plumbing, not a form, card, approval, or extra cat step.

## Do NOT Unify With

- Do not use a thread, latest Episode, branch, timestamp, TaskItem ID, or action lease as the work identity root.
- Do not place raw bindings in `TaskItem.automationState` or any shared/public DTO.
- Do not let merge, test, review, task status, operator prose, or an eval verdict terminalize work.
- Do not expand this identity kernel into a generic workflow engine or user-facing management surface.

## Static Scan Hints

Watch for `WorkAdmission`, `WorkAttempt`, `workId`, `attemptId`, `workflow_sop_v1`, `managed_attributed`, `managed_unattributed`, `unmanaged_not_applicable`, TaskStore-private PR binding metadata, and any fallback that joins task outcome through the latest Episode in a thread.
