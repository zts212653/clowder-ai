---
cell_id: capability-evolution-control
title: Capability Evolution Control
summary: F311-owned thin, durable, production-only control plane for Evolution Program identity/lifecycle, certificate and owner references, stage/schedule projections, and keep/tune/rollback/sunset/no-change orchestration; named domain owners retain all domain truth.
description: Thin ownership boundary for production Evolution Program orchestration without a duplicate domain store, inbox, ledger, state machine, or UI.
description_source: model
description_author: codex-terra
description_generated_by: codex-terra@gpt-5.6-terra
description_generated_at: "2026-08-28T00:00:00-07:00"
doc_kind: architecture
created: 2026-08-28
canonical_features: [F311]
code_anchors:
  - packages/shared/src/types/capability-evolution.ts
  - packages/shared/src/types/capability-evolution-metabolism.ts
  - packages/api/src/infrastructure/capability-evolution/program-event-log.ts
  - packages/api/src/infrastructure/capability-evolution/program-event-appender.ts
  - packages/api/src/infrastructure/capability-evolution/program-service.ts
  - packages/api/src/infrastructure/capability-evolution/change/program-change-bridge.ts
  - packages/api/src/infrastructure/capability-evolution/change/program-change-owner-contract.ts
  - packages/api/src/infrastructure/capability-evolution/change/program-change-owner-event.ts
  - packages/api/src/infrastructure/capability-evolution/change/program-change-snapshot.ts
  - packages/api/src/infrastructure/capability-evolution/change/program-lineage.ts
  - packages/api/src/routes/capability-evolution-program-routes.ts
  - packages/api/src/routes/capability-evolution-program-change-handler.ts
  - packages/mcp-server/src/tools/capability-evolution-tools.ts
  - packages/mcp-server/src/tools/capability-evolution-round-tools.ts
  - packages/mcp-server/src/tools/capability-evolution-change-tools.ts
  - packages/web/src/components/capability-evolution/EvolutionProgramSurface.tsx
  - packages/web/src/components/capability-evolution/EvolutionChangePanel.tsx
doc_anchors:
  - docs/features/F311-capability-evolution-workspace.md
  - docs/features/F299-workspace-invocation-trajectory.md
  - docs/features/F192-socio-technical-harness-eval.md
  - docs/features/F266-eval-verdict-closure-control-plane.md
  - docs/features/F267-eval-measurement-validity.md
  - docs/features/F278-paw-feel-disposition-inbox.md
  - docs/features/F246-approval-hub.md
  - docs/features/F307-composable-workbench.md
  - docs/features/F309-collaborative-content-plane.md
  - docs/features/F281-feedback-channel-first-class.md
  - docs/features/F300-self-sensing-home-state-awareness.md
  - docs/decisions/045-runtime-promise-durability.md
  - feature-discussions/2026-08-28-f311-gate-0a-ownership-contract-census.md
static_scan_hints: [capability-evolution-control, Evolution Program, inv:<id>, dual certificate, Goal/claim, measurement certificate, keep/tune/rollback/sunset, Program demo]
cited_by:
  - {feature: F311, date: 2026-08-28, delta: "Gate 0A freezes a thin production-only Program control cell and its owner-reference join contract"}
---

# Capability Evolution Control

Architecture cell: capability-evolution-control

## Canonical Owner

F311 owns one durable **Evolution Program** control object: its Program identity and lifecycle, named value/asset/domain owner references, references to the two required proof chains, schedule and stage projections, and the orchestration record that reaches `keep`, `tune`, `rollback`, `sunset`, or `no_change`.

The control object holds relationships, not copies. It may retain a reference to the goal/claim certificate issued by the named goal or asset owner and a reference to the measurement-validity certificate issued through F267 and the relevant source owner. It does not author, reissue, reinterpret, or cache either certificate's subject, cohort, version, evidence, decision procedure, or conclusion.

Program identity and its own lifecycle are durable user-visible coordination truth: active and terminal Program records have no expiry and must recover after restart. This does not authorize a generic event log or a second state machine. A Program's stage/schedule projection is a read-oriented orchestration view over its named joins and receipts; source-owner lifecycle, duty, approval, version, and trajectory state remain at their source.

## Production Join Contract

| Join | Canonical owner and accepted reference | What this cell may do | What this cell must not own or reproduce |
|---|---|---|---|
| Invocation trajectory | F299; the only cross-owner key is `inv:<invocationId>` | Retain the reference and link the user to F299/source-owner inspection | `TraceStore`, trajectory IDs, transcript/payload copies, evidence manifests, trajectory resolver/inspector, or another trajectory surface |
| Runtime health evidence | F153 and the named source owner | Retain an evidence reference needed by the Program claim | Raw logs, metrics, traces, health interpretation, or a health dashboard |
| Harness evaluation and verdict | F192 | Retain registry/trigger/verdict references and orchestrate the named next owner | Eval registry, rubric content, raw evaluation data, attribution, verdict lifecycle, or a second Eval Hub |
| Measurement validity | F267 and the named measurement/source owner | Require and retain the issued measurement-certificate reference; honor its `insufficient`, cohort, version, holdout, and intervention constraints | A certificate issuer, frozen cohort, decision procedure, exposure calculation, or intervention-card authority |
| Verdict lifecycle and re-evaluation | F266 / F313 | Retain case, proposal, decision, intervention-receipt, exact asset-version, freshness-proof, and outcome references; a changed intervention additionally retains loaded-runtime and enters deciding only after a fresh post-load outcome, while an owner no-change receipt retains the unchanged exact version and requires a fresh post-receipt outcome without inventing a deployment | Case/proposal identity, Approval lifecycle, dispatch custody, TaskStore subjects, F167 leases, mutation records, verdicts, re-evaluation scheduling, or an outcome ledger |
| Paw-feel responsibility | F278 | Federate the five-state responsibility projection, denominator, evidence references, and durable receipt as an owner-backed join | Signal body, disposition writer, inbox, duty ledger, responsibility state machine, or a second durable receipt |
| Human approval | F246 through the F266/F313 producer | An authenticated cat invocation may submit only the owner-backed intervention ref plus an idempotency key; retain the resulting canonical references | Browser-authored proposal creation, caller-authored owner/origin/authorization, ApprovalEnvelope state, proposal database, decision authority, or a second approval inbox |
| Asset mutation and rollback | The named canonical asset owner | Ask the owner port to act only after the canonical approval/target snapshot is eligible; retain its opaque version and receipt references | Permission payloads, mutation/rollback execution, asset content, deployment state, or inferred owner authority |
| Working surface | F307 | Supply a typed Program surface descriptor when a real Program has a named consumer | Workbench layout, tab topology, user-facing object state, or a new UI surface |
| Content and feedback context | F309, F281, F300, and each content/source owner | Link canonical anchors, patches, feedback/episode evidence, and owner-backed sensing reads | Content versions, patch/writeback receipts, feedback/episode truth, memory truth, or a replacement self-sensing system |

The value owner is accountable for the Program decision; the named asset/domain owner remains accountable for mutations and their receipts. F311 may coordinate the sequence, but it cannot turn a missing source-owner receipt into a positive Program outcome.

## Use This When

- A real user goal has passed F311 E0: one object, one uncertain-utility claim, one value owner, one named consumer, and a concrete `keep`/`tune`/`rollback`/`sunset` decision.
- The work needs a durable Program identity that connects already-owned evidence and decision references without relocating their truth.
- A cross-owner sequence needs a truthful stage or schedule projection, including an owner-specific join blocker with its exact source reference.
- A completed action needs an orchestration outcome that links, rather than duplicates, the owner mutation, approval, evaluation, and re-evaluation receipts.

## Extend By

- Add a new join only after its source owner, stable reference key, named Program consumer, and no-copy boundary are explicit in a Design Gate.
- Keep the two proof chains separately referenced: goal/claim proof belongs to its named owner; measurement proof belongs to F267 plus the named source owner. A missing or `insufficient` proof blocks only the affected Program decision.
- Keep source-specific incidents source-specific. A deterministic bug goes to its canonical owner with a test/guard; a runtime-health issue goes to its owner telemetry/logs/traces. Neither becomes an Evolution Program merely because F311 can later consume its receipt.
- Keep change proposal authority source-bound. A browser may inspect lineage, refresh canonical owner state, and make the value-owner metabolism decision after a fresh outcome; only a verified callback invocation with an exact origin message may request the F266/F246 proposal.
- Treat every owner status before a fresh outcome as non-decisive. Changed interventions require merged+loaded truth and a post-load outcome; owner no-change receipts require an unchanged exact version and post-receipt outcome, with no fabricated mutation or deployment. Pending, rejected, withdrawn, superseded, target drift, accepted Approval, Task/lease custody, and merge-only evidence cannot advance a Program into `deciding`.
- If a source owner is unavailable or incorrect, project only an exact join blocker and source reference. Repair the owner capability in that owner's thread; resume this join after its durable receipt is available.
- Add a F307 descriptor only for a real, authorized Program with a named in-context consumer. The descriptor remains an integration boundary, not a second UI or state root.

## Do NOT Unify With

- Do not turn this cell into a universal database for rubric text, raw trajectories, verdicts, asset versions, writeback results, feedback, memory, content, or source evidence.
- Do not create a Program demo, sample Harness, fixture-only adapter, temporary control plane, second inbox, ledger, state machine, or UI to demonstrate object neutrality.
- Do not make F299 anything other than the sole invocation-trajectory product surface, even when a Program has many `inv:<id>` references.
- Do not copy F278's five-state responsibility projection or durable receipt into a Program-owned responsibility workflow; `routed` and `terminal` keep the source owner's meaning.
- Do not implement F266 or F278 defects in this cell, hide them behind orchestration, or classify a deterministic defect as uncertain evolutionary utility.
- Do not treat approval, a Git merge, an unloaded mutation receipt, a schedule tick, or a surface projection as a substitute for the source owner's canonical fresh outcome.
- Do not create a new generic Program lifecycle schema until a direct user-facing consumer, an owner, a transition contract, and deterministic verification require it.

## Static Scan Hints

Watch for `capability-evolution-control`, Evolution Program stores, copied trajectory or verdict payloads, caller-authored owner/origin/authorization, browser proposal creation, a second F278 inbox/ledger/state machine, F266/F313 lifecycle writes, F246 approval state, mutation/outcome payloads, F307 layout state, `Program demo`, fixture-only Harnesses, temporary adapters, and `inv:<id>` handling outside F299/source-owner boundaries.
