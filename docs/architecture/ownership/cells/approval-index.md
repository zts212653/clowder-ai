---
cell_id: approval-index
title: Approval Index
summary: operator approval aggregation layer — one shared producer catalog and exhaustive runtime registry project canonical stores with honest provenance and feature-owned decisions.
canonical_features: [F246]
code_anchors:
  # API — adapters + routes
  - packages/api/src/domains/approval-hub/ApprovalIngress.ts
  - packages/api/src/domains/approval-hub/ApprovalLifecycleEpochAuthority.ts
  - packages/api/src/domains/approval-hub/ApprovalProducerRegistry.ts
  - packages/api/src/domains/approval-hub/projectApprovalNavigation.ts
  - packages/api/src/domains/approval-hub/requireAnchoredPublication.ts
  - packages/api/src/domains/approval-hub/ports/ApprovalPublicationStore.ts
  - packages/api/src/domains/approval-hub/adapters/F128ApprovalAdapter.ts
  - packages/api/src/domains/approval-hub/adapters/F139ApprovalAdapter.ts
  - packages/api/src/domains/approval-hub/adapters/F193ApprovalAdapter.ts
  - packages/api/src/domains/approval-hub/adapters/F221ApprovalAdapter.ts
  - packages/api/src/domains/approval-hub/adapters/F225ApprovalAdapter.ts
  - packages/api/src/domains/approval-hub/adapters/F231ApprovalAdapter.ts
  - packages/api/src/domains/approval-hub/adapters/F260ApprovalAdapter.ts
  - packages/api/src/domains/approval-hub/adapters/F266ApprovalAdapter.ts
  - packages/api/src/domains/approval-hub/adapters/F306ApprovalAdapter.ts
  - packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts
  - packages/api/src/domains/cats/services/agents/providers/CodexRuntimeInteractionRun.ts
  - packages/api/src/domains/approval-hub/ports/IApprovalAdapter.ts
  - packages/api/src/domains/approval-hub/stores/ports/IDispatchProposalStore.ts
  - packages/api/src/domains/approval-hub/stores/redis/RedisDispatchProposalStore.ts
  - packages/api/src/domains/approval-hub/stores/factories/DispatchProposalStoreFactory.ts
  - packages/api/src/domains/cats/services/stores/redis/RedisApprovalPublication.ts
  - packages/api/src/routes/approval-hub-routes.ts
  - packages/api/src/routes/eval-repair-approval-routes.ts
  - packages/api/src/routes/schedule-mutation-principal.ts
  - packages/api/src/routes/schedule-mutation-proposal.ts
  - packages/api/src/routes/schedule-proposal-decision-routes.ts
  - packages/api/src/infrastructure/scheduler/ScheduleMutationProposalStore.ts
  # Shared types
  - packages/shared/src/approval-producer-catalog.ts
  - packages/shared/src/types/approval-hub.ts
  - packages/shared/src/types/approval-lifecycle.ts
  - packages/shared/src/types/entity-proposal.ts
  - packages/shared/src/types/schedule-mutation.ts
  # MCP — governed schedule mutation entrypoint
  - packages/mcp-server/src/tools/schedule-tools.ts
  - packages/mcp-server/src/server-toolsets.ts
  # Web — workspace integration (Phase C)
  - packages/web/src/lib/approval-features.ts
  - packages/web/src/components/ApprovalPanel.tsx
  - packages/web/src/components/workspace/WorkspaceTabBar.tsx
  - packages/web/src/components/ApprovalItemCard.tsx
  - packages/web/src/components/ApprovalProvenanceLinks.tsx
  - packages/web/src/components/EntityConflictResolutionPanel.tsx
  - packages/web/src/stores/approvalHubStore.ts
  - packages/web/src/hooks/useApprovalHub.ts
  # Deprecated (Phase C — retained but no longer rendered)
  - packages/web/src/components/ApprovalHubDrawer.tsx  # deprecated: replaced by ApprovalPanel
doc_anchors:
  - docs/features/F246-approval-hub.md
  - feature-specs/2026-06-20-f246-phase-a-approval-hub.md
  - feature-specs/2026-06-20-f246-phase-b-f193-dispatch-adapter.md
  - feature-specs/2026-06-21-f246-phase-c-workspace-integration.md
  - feature-specs/2026-06-21-f246-phase-d-approval-hub-maturation.md
  - feature-specs/2026-07-20-f246-phase-i-approval-ingress-provenance.md
  - docs/features/F139-unified-schedule-abstraction.md
  - docs/features/F260-write-side-autopsy-entity-deref.md
  - docs/features/F306-codex-app-capability-parity.md
  - feature-specs/2026-07-18-f260-entity-conflict-resolution.md
static_scan_hints: [approval hub, approval ingress, approval envelope, approval provenance, producer catalog, producer registry, pending approval, approval adapter, approval item, inline approve, explicit resolution, entity conflict, batch approve, approval filters, ApprovalPanel, ApprovalItemCard, ApprovalProvenanceLinks, EntityConflictResolutionPanel, WorkspaceTabBar, workspace approval, runtime interaction, auto_review, approvalsReviewer, F306ApprovalAdapter, dispatch proposal, DispatchProposalStore, F139ApprovalAdapter, ScheduleMutationProposalStore, schedule proposal, F193ApprovalAdapter, F260ApprovalAdapter]
cited_by:
  - {feature: F246, date: 2026-06-20, delta: new cell}
  - {feature: F246, date: 2026-06-20, delta: "Phase B — F193 E3 adapter + DispatchProposalStore"}
  - {feature: F246, date: 2026-06-21, delta: "Phase C — drawer→workspace tab + WorkspaceTabBar"}
  - {feature: F246, date: 2026-06-21, delta: "Phase D planned — maturation tests, filters, batch actions, adapter admission gates"}
  - {feature: F260, date: 2026-07-19, delta: "refresh-safe entity conflict projection plus before/after and surface-ownership decision UI"}
  - {feature: F246, date: 2026-07-21, delta: "Phase I Wave 0 — runtime registry, publication ingress, dual-anchor provenance, truthful navigation, and fan-out instrumentation"}
  - {feature: F246, date: 2026-07-23, delta: "Phase I Wave 1 — F139 strict principals, anchored schedule proposals, audited direct mutations, and crash-safe effects"}
  - {feature: F246, date: 2026-07-26, delta: "Phase I Wave 2 — F193/F221/F260 producer ingress hardening: non-optional ingress, stable retry identity, staged recovery, anchored fanout replay, F193 supersede rollback, card actions deferred to Wave 3"}
  - {feature: F306, date: 2026-08-27, delta: "Phase B read-through projection — only anchored pending approval-kind runtime interactions enter the Hub; inline decisions stay disabled and navigate to the exact canonical thread card."}
  - {feature: F306, date: 2026-08-28, delta: "operator permission-funnel correction — production command/file approvals use upstream auto_review and never create routine human script cards; explicit user-reviewed canonical records remain projection-compatible."}
  - {feature: F306, date: 2026-08-28, delta: "Danger coordinate correction — authorized cross-directory capability does not enter Approval Hub; irreversible/sanctuary effects belong to structural target guards and recoverability, not a Codex-only workspace jail. No current Clowder AI guard intercepts Codex native shell; AC-C7 remains open."}
  - {feature: F313, date: 2026-09-02, delta: "Phase C — canonical Resolution × Materialization projection, durable per-producer writer epoch, and F266 ref-only Approval/dispatch extension with production cutover fail-closed."}
---

# Approval Index

## Canonical Owner

F246 — Approval Hub (unified operator approval center).

## Architecture

Phase I keeps query aggregation: the shared producer catalog defines product metadata,
an exhaustive `ApprovalProducerRegistry` supplies each runtime adapter binding, and each
`IApprovalAdapter` reads from its
canonical store (F128 `IProposalStore`, F225 `ISessionHandoffProposalStore`,
F193 `IDispatchProposalStore`, F231 `IProfileUpdateProposalStore`, F221 `ITasteProposalStore`,
F260 `IEntityProposalStore`, F139 `ScheduleMutationProposalStore`, F306 `RuntimeInteractionStore`) and maps results to the unified `ApprovalItem`
DTO at read time. No materialized index, no CQRS — fresh read-through on every
Hub load (KD-3). Pre-Phase-I records without provable dual anchors project as
`legacy_unanchored`; staged or tombstoned publications never enter the Hub.

Healthy producers publish through one composition-root `ApprovalIngress`: the
feature store first creates a staged canonical record, the ingress appends one
rich approval card, then immutably commits an `ApprovalEnvelope` containing the
exact message/event origin and card reference. Only that anchored state is
Hub-visible or decidable. Card append failure aborts the staged record; envelope
commit failure remains recoverable by idempotently reusing the persisted card.
Feature-owned approve/reject routes call `requireAnchoredPublication()` before
their first business CAS. `ApprovalIngress` exclusively owns the publication
transaction: before-card failures call the producer store's `abortStaged()`,
whose atomic cleanup removes retry identity and restores direct lineage
custody; after-card commit failures retain the staged record for idempotent
recovery. A staged dispatch holder cannot be superseded until it anchors, and
F221/F260 dedup release is conditional on the canonical proposal not existing,
so ambiguous Redis acknowledgements retain their retry identity. Producer
routes do not run a second compensation path. Ingress is non-optional for all
three producers (fail-closed). Card blocks are
informational only — Hub-panel actions deferred to Wave 3. The Hub remains a
projection over feature stores, not a second proposal database.

Every binding declares lifecycle contract version 1 and a writer generation. Before API fan-out returns, the registry
normalizes legacy vocabulary into the only renderer contract:
`open / accepted / rejected / closed_without_decision` plus dependent materialization state. A legacy `approved` row
without canonical effect proof is `accepted + outcome_unknown`, never “executed”. The durable per-producer epoch is a
TTL=0 CAS with the sole path `legacy_active → draining → fenced → v1_active`; missing/corrupt/read failure closes both
writers. Draining admits only legacy in-flight decision/materialization/recovery, fence admits no operation, and v1
requires a cutover receipt after quiescence.

F266 is the first lifecycle-v1 owner-backed producer. Its canonical state remains the F266 append-only event stream;
the shared adapter and Hub only project it. Proposal and dispatch snapshots carry opaque owner, authorization, exact
target-version and dispatch refs. Until a canonical owner resolver/repair dispatcher and explicit production epoch
migration are supplied, the complete v3 composition stays inactive and the route returns
`approval_route_unavailable` without creating a case, card, Task or F167 lease.

### Data Flow

```
ActivityBar (bell icon + badge count)
  → click → setWorkspaceMode('approval') + fetchPending()
  → WorkspacePanel renders ApprovalPanel
  → useApprovalHubSync (fetch on mount + proposal_updated events)
  → Zustand store (useApprovalHubStore)
  → GET /api/approval-hub/pending
  → ApprovalProducerRegistry.listAdapters()
  → measured fan-out across adapters (whole request fails on any adapter error)
  → F128ApprovalAdapter  → proposalStore.listPending(userId)
  → F139ApprovalAdapter  → scheduleMutationProposalStore.listPendingByOwner(userId)
  → F193ApprovalAdapter  → dispatchProposalStore.listPendingByUser(userId)
  → F225ApprovalAdapter  → handoffStore.listPendingByUser(userId)
  → F260ApprovalAdapter  → entityProposalStore.listPending(userId)
                         → memory inspector derives current conflict context
  → F266ApprovalAdapter  → F266 eval-repair event projection
                         → canonical Resolution × Materialization; ref-only decision/dispatch lineage
  → F306ApprovalAdapter  → runtimeInteractionStore.listPendingByOwner(userId)
                         → explicit user-reviewed approval-kind only; decisionSurface=origin_card
                         → production auto_review command/file requests never enter this store
                         → navigation to the canonical card; no Hub decision route/history copy
  → merge + sort by createdAt desc → { items, count }
```

### Frontend

- `ApprovalPanel` — workspace-inline panel (Phase C, replaces deprecated `ApprovalHubDrawer`)
- `WorkspaceTabBar` — responsive tab bar with three modes (full/overflow/icon-only) driven by ResizeObserver
- `ApprovalItemCard` (per-item: ordinary inline approve/reject, recovery, jump, or a feature-owned explicit decision surface)
- `EntityConflictResolutionPanel` — F260 before/after or surface-candidate comparison; submits merge/replace/correction/transfer/polysemy and preserves typed stale/error context in place
- Stale detection: client-side `expiresAt < Date.now()` (pure projection, no store mutation)
- The producer catalog owns `decisionSurface`. `approval_hub` producers use their feature decision endpoint; F306 is `origin_card` with no Hub endpoint. Its TTL=0 projection has no `expiresAt`, and terminal/invalidated records leave `listPending`, so the Hub never fabricates a stale-clear mutation or a second settled-history row.
- Bell icon in ActivityBar: badge count always visible, click opens workspace→approval tab (toggle: re-click closes workspace)

### F193 Dispatch (Phase B)

- `DispatchProposalStore` (Redis-backed, CAS approve/reject, TTL=0 persistent)
- Effect-class boundary: only `assign_work` produces ApprovalItem; `fyi`/`coordinate`/`investigate` auto-deliver without Hub involvement
- Target validation + delivery rollback on approve failure

### F139 Schedule Mutations (Phase I Wave 1)

- A strict server-side principal resolver distinguishes authenticated operator
  sessions from verified callback/agent-key cats; request claims never decide
  the role.
- Cat create/permanent-delete writes an immutable SQLite proposal first, then
  publishes its event origin and approval card through `ApprovalIngress`.
  Staged/tombstoned proposals remain invisible and undecidable.
- Feature-owned approve/reject routes call `requireAnchoredPublication()`
  before CAS. Create and fingerprint-bound delete couple the dynamic task
  mutation with an effect checkpoint for crash-safe exactly-once recovery.
- Authenticated operator create/delete and direct pause/resume append TTL-free audit
  records; pause/resume is not widened into a new approval gate.
- The agent-key MCP surface exposes permanent removal as a non-destructive
  proposal write. It requires an owned `sourceThreadId`; the destructive effect
  remains unavailable until the operator settles the Hub item.

### F260 Entity Conflicts

- Pending items derive conflict context on every Hub read; the adapter does not persist a second copy of registry truth.
- A first plain-approve or batch-approve 409 also patches the same typed context into the current card, so candidates and reason are never collapsed to an error code or result string.
- Conflict items stay out of approve/reject batches. The operator must choose a named mutation or reject the proposal individually.
- A stale fingerprint or invalid canonical replacement keeps the card pending and replaces its context with current truth.
- Conflict context is viewer-scoped: private candidates are visible only to their owner; hidden collisions expose no candidate snapshot and fail closed to reject.

### F306 Runtime Interaction

- `RuntimeInteractionStore` is the canonical TTL=0 request lifecycle; Approval Hub owns no copy and no response waiter.
- Production app-server invocations set `approvalsReviewer=auto_review`; routine command/file permission review therefore stays upstream and does not publish a human card or Hub item. Sandbox and `approvalPolicy` remain independent controls.
- Authorized work does not become an Approval Hub item merely because its filesystem path is outside the current workspace. Capability, task authority, and high-consequence effect guards are separate dimensions; F306 adds no workspace path jail.
- Approval Hub is not a substitute for execution safety. Current runtime-sanctuary and governed-shell fixtures cover Claude PreToolUse and MCP `shell_exec` respectively; neither intercepts Codex app-server native shell. AC-C7 owns the missing provider-neutral effect/target guard. main/Alpha accepted the no-human-prompt contract; production runtime revision `69cdd42b7` predates #4047 and is `live=pending restart`.
- If a machine-review host nevertheless emits a raw command/file request, the runtime adapter returns a fail-closed decline without calling the human interaction port. Only a separately authorized explicit `user` reviewer may create an approval-kind runtime interaction; no current production writer selects it.
- The adapter projects only anchored, pending, explicitly user-reviewed approval-kind records owned by the current user. Question and elicitation records never become `ApprovalItem` values.
- `inlineApprovable=false`: Hub is discovery/navigation only. Every decision is submitted from the exact canonical thread card, whose card ref is preserved in the item.
- Terminal, stale, restarted, transport-lost, and provider-cancelled records disappear from pending reads while remaining readable in their source thread.

## Evolution Path

- ~~Phase B: add F193 E3 adapter~~ ✅ merged PR #2454
- ~~Phase C: workspace integration~~ ✅ merged PR #2463
- Phase D planned: AC-C8 intercept pruning, WorkspaceTabBar/ApprovalPanel web regressions, batch approve/reject, filtering (by feature/thread/时效)
- v2 接入: F231 propose_profile_update, F168 direction-decision subcell, Knowledge Feed, Limb pair_approve
- v2+ architecture: materialized CQRS index only after adapter count > 5 and measured pending fetch p95 crosses the Phase D gate
