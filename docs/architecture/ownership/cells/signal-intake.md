---
cell_id: signal-intake
title: External Signal Intake
doc_kind: architecture
created: 2026-08-08
summary: Host-owned admission, routing, durable workflow intake, source-resolution authority, and repair projection for declared external plugin signals.
canonical_features: [F292]
code_anchors: []
doc_anchors:
  - docs/features/F292-feishu-meeting-intake-plugin.md
  - feature-specs/2026-08-08-f292-feishu-meeting-intake.md
static_scan_hints: [SignalAdmissionService, SignalRouteStore, MeetingIntakeStore, MeetingIntakeService, SourceAccessLeaseService, signal-ingress, meeting-intake]
cited_by:
  - {feature: F292, date: 2026-08-08, delta: "new Host-side cell separates durable external-signal truth from plugin lifecycle and source-specific collectors"}
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

The cell is frozen before implementation, so its code-anchor list is intentionally empty. PR 2 must
replace that empty list with the exact landed shared/API anchors before it can claim completion.

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
