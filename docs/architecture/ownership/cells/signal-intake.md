---
cell_id: signal-intake
title: External Signal Intake
doc_kind: architecture
created: 2026-08-08
summary: Host-owned admission, routing, durable workflow intake, source-resolution authority, and repair projection for declared external plugin signals.
canonical_features: [F292]
code_anchors:
  - packages/shared/src/types/signal-ingress.ts
  - packages/shared/src/types/meeting-intake.ts
  - packages/api/src/domains/signal-intake/SignalAdmissionService.ts
  - packages/api/src/domains/signal-intake/RedisMeetingIntakeStore.ts
  - packages/api/src/domains/signal-intake/SourceAccessLeaseService.ts
  - packages/api/src/domains/signal-intake/AsrPersonMemorySceneBuilder.ts
  - packages/api/src/domains/signal-intake/AsrPersonMemoryQueueCarrier.ts
  - packages/shared/src/types/memory-write-opportunity.ts
  - packages/api/src/domains/plugin/host-broker/events-publish-handler.ts
  - packages/api/src/routes/meeting-intake-routes.ts
doc_anchors:
  - docs/features/F292-feishu-meeting-intake-plugin.md
  - feature-specs/2026-08-08-f292-feishu-meeting-intake.md
static_scan_hints: [SignalAdmissionService, SignalRouteStore, MeetingIntakeStore, MeetingIntakeService, SourceAccessLeaseService, EventsPublishBrokerHandler, signal-ingress, meeting-intake]
cited_by:
  - {feature: F292, date: 2026-08-08, delta: "new Host-side cell separates durable external-signal truth from plugin lifecycle and source-specific collectors"}
  - {feature: F292, date: 2026-08-10, delta: "K-2B typed events.publish adapter consumes Host Broker identity while preserving signal-intake settlement authority"}
  - {feature: F276, date: 2026-08-15, delta: "confirmed meeting artifacts may emit one bounded mechanical WriteOpportunity scene and exact owner-message carrier; memory retains all judgment and destination authority"}
---

# External Signal Intake

Architecture cell: signal-intake

## Canonical Owner

F292 owns the first reusable Host path from an admitted external plugin signal to a durable,
recoverable user workflow item. This cell validates Host-bound producer identity, declaration,
effective grant, runtime liveness, payload bounds, privacy/source class, and idempotency before it
creates or reconciles one TTL=0 intake. It also owns Host-configured consumer/filter/wake routes,
short-lived source-access authority, repair states, and the projection predicate that decides whether
human judgment is still required.

The external source remains source truth. This cell persists bounded metadata, source refs,
governance/settlement history, and workflow choices; it does not become a document store or universal
event log.

The merged core slices establish released-contract admission, atomic TTL=0 intake truth, Host route
generation, one-shot source access, typed repair state, Needs Me actions, and owner-scoped recovery.
K-2B adds the typed `events.publish` transport edge: it resolves the current Host route for every
call, invokes this cell's admission service, and uses this cell's canonical settlement receipt to
recover ambiguous Broker dispatch without creating a second intake.

## Use This When

- Adding or changing generic external signal admission, declaration lookup, class/privacy checks,
  idempotent settlement, Host-owned signal routes, or source-access leases.
- Adding a durable workflow intake created by an admitted external signal.
- Changing restart/redelivery/regrant/manual-recovery behavior for those intakes.
- Deciding whether an unresolved intake projects into Needs Me or stays machine-resolved.

## Extend By

- Require one released public contract and exact package digest; never mirror its schema in core.
- Bind producer, provenance, grants, runtime session, liveness, and route generation from Host truth.
- Persist accepted settlement and durable intake atomically before attempting wake or UI fan-out.
- Keep route generation in the per-call Host binding, not in a long-lived runtime lease; route
  changes must take effect without re-authorizing the plugin process.
- Expose a validated canonical-settlement lookup for Broker recovery. It may return an already
  committed receipt, but it cannot create or mutate intake truth.
- Treat delivery as at-least-once and visible work as idempotent; exact retries return the same receipt,
  while same-key/different-input conflicts fail closed.
- Cross the plugin boundary with bounded metadata and opaque source refs. Resolve source content only
  through an exact-purpose, exact-intake, revocable Host lease.
- Keep user-visible workflow/governance state at TTL=0. Payload-free delivery traces are diagnostics
  with bounded retention and cannot recover or delete an intake.
- Project only unresolved judgment or actionable repair into Needs Me; the projection has no second
  writer, lifecycle, or store.

## Shared Touchpoints

- `plugin` owns package admission, runtime/session/grants, and the public official-plugin contract
  seam. This cell consumes admitted identity and contract truth; it does not activate packages.
- `github-signals` owns GitHub-specific collection frontier, snapshots, and wait predicates. GitHub is
  a behavior oracle, not a schema or migration target for this cell.
- `approval-index` renders the Needs Me projection and routes user actions. It never owns the
  `MeetingIntake` record or decides that a source signal was valid.
- `ball-custody` owns actual cat wake/wait custody after a Host route has selected authorized work.
- `human-disposition-feedback` may learn from explicit user choices but cannot mutate intake truth.
- `memory` owns the shared WriteOpportunity lifecycle, cat disposition, deferred lineage, and F276
  destination. This cell may emit only bounded mechanical observations from confirmed meeting
  artifacts and an exact live-owner-message visibility witness; it cannot decide intent,
  importance, transcript truth, or person-memory truth.

## Do NOT Unify With

- Do not turn this cell into a universal event bus, dynamic subscription registry, stream transport,
  or general workflow engine.
- Do not merge it into `plugin`: extension lifecycle and durable user workflow truth have different
  owners, persistence, and recovery invariants.
- Do not merge it into `github-signals`: source-specific collection and generic admitted-signal
  workflow state are separate concerns.
- Do not let plugins name cats, threads, invocations, Channels, consumers, filters, wake targets, or
  authoritative lease expiry.
- Do not persist transcript bodies, household memory, prompts, credentials, or private summaries in
  event payloads or diagnostics.

## Static Scan Hints

Watch for new `SignalAdmissionService`, `SignalRouteStore`, `MeetingIntakeStore`,
`SourceAccessLeaseService`, `events.publish`, `signals.provides`, signal idempotency/settlement keys,
source-handle resolution, or direct plugin-to-thread/cat routing.
