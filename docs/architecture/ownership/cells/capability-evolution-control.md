---
cell_id: capability-evolution-control
title: Capability Evolution Control
summary: F311-owned thin, durable, production-only control plane for Evolution Program identity/lifecycle, refs-only preparation submissions, certificate and owner references, stage/schedule projections, and keep/tune/rollback/sunset/no-change orchestration; named domain owners retain all domain truth.
description: Thin ownership boundary for production Evolution Program and preparation orchestration without a duplicate content store, inbox, ledger, state machine, or UI.
description_source: model
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: "2026-09-09T12:17:08Z"
description_confirmed_by: codex-sol
description_updated_at: "2026-09-09T12:17:08Z"
doc_kind: architecture
created: 2026-08-28
canonical_features: [F311]
code_anchors:
  - packages/shared/src/types/capability-evolution.ts
  - packages/shared/src/types/capability-evolution-preparation.ts
  - packages/shared/src/types/capability-evolution-metabolism.ts
  - packages/api/src/infrastructure/capability-evolution/program-event-log.ts
  - packages/api/src/infrastructure/capability-evolution/program-event-appender.ts
  - packages/api/src/infrastructure/capability-evolution/program-service.ts
  - packages/api/src/infrastructure/capability-evolution/program-preparation-service.ts
  - packages/api/src/infrastructure/capability-evolution/program-preparation-projection.ts
  - packages/api/src/infrastructure/capability-evolution/program-owner-surface-resolvers.ts
  - packages/api/src/infrastructure/capability-evolution/change/program-change-bridge.ts
  - packages/api/src/infrastructure/capability-evolution/change/program-change-owner-contract.ts
  - packages/api/src/infrastructure/capability-evolution/change/program-change-owner-event.ts
  - packages/api/src/infrastructure/capability-evolution/change/program-change-snapshot.ts
  - packages/api/src/infrastructure/capability-evolution/change/program-lineage.ts
  - packages/api/src/infrastructure/capability-evolution/adapters/request-review/request-review-owner-adapter.ts
  - packages/api/src/infrastructure/capability-evolution/adapters/request-review/request-review-owner-ledger.ts
  - packages/api/src/infrastructure/capability-evolution/adapters/request-review/request-review-owner-ledger-contract.ts
  - packages/api/src/infrastructure/capability-evolution/adapters/request-review/request-review-owner-port.ts
  - packages/api/src/infrastructure/capability-evolution/adapters/request-review/request-review-owner-projection.ts
  - packages/api/src/infrastructure/capability-evolution/adapters/request-review/request-review-use-receipt.ts
  - packages/api/src/infrastructure/capability-evolution/adapters/request-review/request-review-version-attestor.ts
  - packages/api/src/infrastructure/capability-evolution/change/request-review-canonical-dispatcher.ts
  - packages/api/src/infrastructure/capability-evolution/change/request-review-decision-owner.ts
  - packages/api/src/infrastructure/capability-evolution/change/request-review-eval-repair-owner-provider.ts
  - packages/api/src/infrastructure/capability-evolution/change/request-review-eval-repair-owner-binding.ts
  - packages/api/src/infrastructure/capability-evolution/change/request-review-lineage-binding-resolver.ts
  - packages/api/src/infrastructure/capability-evolution/change/request-review-owner-actions.ts
  - packages/api/src/infrastructure/capability-evolution/change/request-review-owner-fact-authority.ts
  - packages/api/src/infrastructure/capability-evolution/change/request-review-owner-receipt-support.ts
  - packages/api/src/infrastructure/capability-evolution/change/request-review-owner-receipts.ts
  - packages/api/src/infrastructure/capability-evolution/change/request-review-owner-version-verifier.ts
  - packages/api/src/routes/callback-request-review-owner-routes.ts
  - packages/api/src/routes/callback-skill-consumption-routes.ts
  - packages/api/src/routes/capability-evolution-program-routes.ts
  - packages/api/src/routes/capability-evolution-program-preparation-routes.ts
  - packages/api/src/routes/capability-evolution-program-change-handler.ts
  - packages/mcp-server/src/tools/capability-evolution-tools.ts
  - packages/mcp-server/src/tools/capability-evolution-preparation-tools.ts
  - packages/mcp-server/src/tools/capability-evolution-round-tools.ts
  - packages/mcp-server/src/tools/capability-evolution-change-tools.ts
  - packages/mcp-server/src/tools/request-review-owner-fact-schema.ts
  - packages/mcp-server/src/tools/skill-consumption-tools.ts
  - packages/web/src/components/capability-evolution/EvolutionProgramSurface.tsx
  - packages/web/src/components/capability-evolution/preparation/EvolutionPreparationWorkspace.tsx
  - packages/web/src/components/capability-evolution/EvolutionChangePanel.tsx
doc_anchors:
  - docs/features/F311-capability-evolution-workspace.md
  - docs/features/F299-workspace-invocation-trajectory.md
  - docs/features/F192-socio-technical-harness-eval.md
  - docs/features/F266-eval-verdict-closure-control-plane.md
  - docs/features/F267-eval-measurement-validity.md
  - docs/features/F278-paw-feel-disposition-inbox.md
  - docs/features/F117-message-delivery-lifecycle.md
  - docs/features/F167-a2a-chain-quality.md
  - docs/features/F246-approval-hub.md
  - docs/features/F307-composable-workbench.md
  - docs/features/F309-collaborative-content-plane.md
  - docs/features/F281-feedback-channel-first-class.md
  - docs/features/F300-self-sensing-home-state-awareness.md
  - docs/features/F100-self-evolution.md
  - docs/features/F314-development-episode-alignment-experiment.md
  - feature-specs/2026-09-12-f314-f100-owner-loop-closure.md
  - docs/harness-feedback/measurement-sources/capability-evolution/owner-inputs/evolution-program-ba0f4524e49cc879279164d5b272cf8c-eval-repair-owner-binding-v1.yaml
  - docs/decisions/045-runtime-promise-durability.md
  - feature-discussions/2026-08-28-f311-gate-0a-ownership-contract-census.md
static_scan_hints: [capability-evolution-control, Evolution Program, inv:<id>, dual certificate, Goal/claim, measurement certificate, keep/tune/rollback/sunset, Program demo]
cited_by:
  - {feature: F311, date: 2026-08-28, delta: "Gate 0A freezes a thin production-only Program control cell and its owner-reference join contract"}
  - {feature: F314, date: 2026-09-12, delta: "F100 request-review owner adds exact version/use/action receipts; F311 still consumes refs only"}
---

# Capability Evolution Control

Architecture cell: capability-evolution-control

## Canonical Owner

F311 owns one durable **Evolution Program** control object: its Program identity and lifecycle, stable preparation-section identities and exact dependency refs, named value/asset/domain owner references, references to the two required proof chains, schedule and stage projections, and the orchestration record that reaches `keep`, `tune`, `rollback`, `sunset`, or `no_change`.

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
| Direct owner message | F117 / canonical MessageStore | Resolve only `F117/message:<messageId>` + `thread:<threadId>` + `F117/instrumentation:owner-message-v1` when the message is a delivered, live, publicly visible, non-connector owner-authored row in that owner-owned thread; malformed connector provenance fails closed | Message text, correction classification, feedback lifecycle, generic sensing, or a second message/feedback store; F267/source-owner measurement still decides whether the referenced message is relevant evidence |
| Preparation submission body | F117 / canonical MessageStore protected `evolutionPreparationSubmissionV1` carrier | Append only an exact revision ref, dependency refs, source identity, and materialization intent to the Program log; join the one immutable F117 body after workspace/thread/author/delivery/digest validation | Preparation body copies in the Program log, browser storage, rich block, or a new notebook/content store; a submitted draft is not a certificate, owner verdict, or measured outcome |
| Preparation work liveness | F167 invocation registry | Retain an invocation activity ref and derive active/terminal/unknown at read time; show a spinner only while the exact authenticated invocation remains active | Caller-authored cat/thread/invocation identity, `running` booleans, leases, timeout-completion guesses, or a second task/runtime state machine |
| Human approval | F246 through the F266/F313 producer | An authenticated cat invocation may submit only the owner-backed intervention ref plus an idempotency key; retain the resulting canonical references | Browser-authored proposal creation, caller-authored owner/origin/authorization, ApprovalEnvelope state, proposal database, decision authority, or a second approval inbox |
| Asset mutation and rollback | The named canonical asset owner | Ask the owner port to act only after the canonical approval/target snapshot is eligible; retain its opaque version and receipt references | Permission payloads, mutation/rollback execution, asset content, deployment state, or inferred owner authority |
| F100 request-review asset | F100 Git owner plus its TTL=0 exact-ref ledger and exact Program/cycle binding input | Read semantic anchor history/parent/diff with separate Git source proof; fence every proposal-bound ledger writer through the same exact Program/cycle/intervention/target/case-action resolver; admit use reservation only from a strict author invocation with a real origin; join receipts through the existing F266/F167/F299 seams | Skill bytes, Approval/Task/lease copies, target-scanned case actions, ambient callback identity, non-strict reservations, F299 trajectory, review-message body, owner payload, or an F311-owned action/use ledger |
| Working surface | F307 | Supply a typed Program surface descriptor when a real Program has a named consumer | Workbench layout, tab topology, user-facing object state, or a new UI surface |
| Content and feedback context | F309, F281, F300, and each content/source owner | Link canonical anchors, patches, feedback/episode evidence, and owner-backed sensing reads | Content versions, patch/writeback receipts, feedback/episode truth, memory truth, or a replacement self-sensing system |

The value owner is accountable for the Program decision; the named asset/domain owner remains accountable for mutations and their receipts. F311 may coordinate the sequence, but it cannot turn a missing source-owner receipt into a positive Program outcome.

Architecture cell: `capability-evolution-control`
Map delta: register the F100 request-review owner ledger, exact Program/cycle/case-action binding input, and federation join as an external owner boundary; no F311 store or lifecycle is added.
Why: Git, F266 and F167 prove source bytes, approval and custody respectively, but none can derive the Cycle-1 semantic version, authorize an arbitrary callback, select a case action by target alone, or prove F100 load/rollback and exact request-review consumption; F100 retains only those exact refs and F311 consumes them without copying truth.
Canonical source: `request-review-owner-ledger.ts` + `request-review-eval-repair-owner-binding.ts` + `request-review-owner-fact-authority.ts` + `request-review-eval-repair-owner-provider.ts` + `request-review-owner-adapter.ts`.
Consumer evidence: `request-review-*.test.js`, `capability-evolution-asset-review-routes.test.js`, and the existing F307 capability-evolution component/browser suites.
Claim guard: wrong Program/cycle/case action, unrelated target, non-holder callback, non-strict/originless consumption author, immutable-scope drift, rollback without its changed receipt, self or mismatched reviewer/HEAD/source, unattested runtime mount, missing fresh outcome and restart replay all fail closed before the F100 ledger changes or F311 can advance.

Architecture cell: `capability-evolution-control`
Map delta: none — F117/MessageStore retains direct-message lifecycle and body truth; F311 adds one read-only owner-surface resolver and stores only the caller-supplied canonical refs after validation.
Why: a natural operator correction can be source evidence without being an F281 disposition; validating its existing message identity must not create an F300 substitute or a centralized feedback ledger.
Canonical source: `packages/api/src/domains/cats/services/stores/ports/MessageStore.ts#IMessageStore.getById` + `docs/features/F117-message-delivery-lifecycle.md#Phase-A-deliveryStatus-字段--后端收口`
Consumer evidence: `rg -n "createEvolutionOwnerSurfaceResolvers|sourceResolvers" packages/api/src/index.ts packages/api/src/infrastructure/capability-evolution packages/api/test/capability-evolution-owner-surface-resolvers.test.js`
Claim guard: “only a live, publicly visible direct owner message in the exact owner thread resolves” → `capability-evolution-owner-surface-resolvers.test.js` → red when owner, thread, source provenance, visibility, deletion, delivery, instrumentation, or read-port truth is absent.

## Preparation Submission Boundary

The four stable F311 coordinates are `object_map`, `success_contract`, `measurement_plan`, and `baseline_diagnosis`. They are cross-progress reading identities inside an already bound single-target Program; they neither change Program stage nor widen `objectRef` authority. `preparation_work_registered` stores only an F167 activity ref and bounded focus. `preparation_submission_committed` stores only the exact submission ref and exact upstream revision refs.

The F117 message is the sole preparation-body carrier. A submit first wins Program CAS, then materializes that immutable message through a persistent idempotency key. A crash in between projects `materializing`; retrying the same command heals the body without adding a second event or message. A losing CAS writes no orphan body. Current/history and `needs_update` are replayed from exact refs, while source deletion, recall, author/workspace mismatch, malformed payload, or digest drift fail closed as unavailable/invalid.

The read projection joins F167 every time. Only the exact invocation still reported active may render as working; terminal or unknown work stops animation and remains resumable. Browser persistence contains only section, GT-source, version, view, and scroll coordinates—never owner content or a liveness claim.

Architecture cell: `capability-evolution-control`
Map delta: F311 now owns preparation identities, refs-only events, CAS/materialization orchestration, and the joined read projection; F117 still owns the one body and F167 still owns runtime liveness.
Canonical source: `program-preparation-service.ts` / `program-preparation-projection.ts` / `MessageStore.ts#appendIdempotent,getByIdempotencyKey` / `EvolutionPreparationWorkspace.tsx`.
Consumer evidence: `rg -n "preparation_submission_committed|evolutionPreparationSubmissionV1|EvolutionPreparationWorkspace|capabilityEvolutionPreparationTools" packages/shared/src packages/api/src packages/mcp-server/src packages/web/src` covers the shared reducer/schema, F117 carrier, API service/projection, canonical MCP toolset registration, and F307 reader. A fresh `convention-graph:code-consumers` query returns no target for the two new actions because the current MCP extractor recognizes literal tool-array objects, while this surface uses governed `defineMcpCanonicalFactory(...)` wrappers; the explicit registry references plus MCP surface-governance tests therefore carry this boundary until that extractor supports canonical factories.
Claim guard: “a durable exact submission is readable without copied truth or fake work” → preparation shared/API/MCP/Web tests plus `f311-preparation-workspace.test.mjs` → red on stale CAS/dependency, crash gap, source/identity drift, non-active spinner, collection-validity conflation, or browser owner-body persistence.

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
- Revise preparation through the dedicated invocation-authenticated action with Program sequence, exact current-section ref, and exact current dependency refs. Preserve old revisions; derive staleness instead of writing a second invalidation flag.
- Treat every owner status before a fresh outcome as non-decisive. Changed interventions require merged+loaded truth and a post-load outcome; owner no-change receipts require an unchanged exact version and post-receipt outcome, with no fabricated mutation or deployment. Pending, rejected, withdrawn, superseded, target drift, accepted Approval, Task/lease custody, and merge-only evidence cannot advance a Program into `deciding`.
- If a source owner is unavailable or incorrect, project only an exact join blocker and source reference. Repair the owner capability in that owner's thread; resume this join after its durable receipt is available.
- Add a F307 descriptor only for a real, authorized Program with a named in-context consumer. The descriptor remains an integration boundary, not a second UI or state root.

## Do NOT Unify With

- Do not turn this cell into a universal database for rubric text, raw trajectories, verdicts, asset versions, writeback results, feedback, memory, content, or source evidence.
- Do not create a Program demo, sample Harness, fixture-only adapter, temporary control plane, second inbox, ledger, state machine, or UI to demonstrate object neutrality.
- Do not add a PreparationStore, GT database, browser body cache, caller-authored activity state, or multi-target write permission. The preparation map can discuss many candidates while the Program remains bound to one canonical target.
- Do not make F299 anything other than the sole invocation-trajectory product surface, even when a Program has many `inv:<id>` references.
- Do not copy F278's five-state responsibility projection or durable receipt into a Program-owned responsibility workflow; `routed` and `terminal` keep the source owner's meaning.
- Do not implement F266 or F278 defects in this cell, hide them behind orchestration, or classify a deterministic defect as uncertain evolutionary utility.
- Do not treat approval, a Git merge, an unloaded mutation receipt, a schedule tick, or a surface projection as a substitute for the source owner's canonical fresh outcome.
- Do not create a new generic Program lifecycle schema until a direct user-facing consumer, an owner, a transition contract, and deterministic verification require it.

## Static Scan Hints

Watch for `capability-evolution-control`, Evolution Program stores, copied trajectory or verdict payloads, caller-authored owner/origin/authorization, browser proposal creation, a second F278 inbox/ledger/state machine, F266/F313 lifecycle writes, F246 approval state, mutation/outcome payloads, F307 layout state, `Program demo`, fixture-only Harnesses, temporary adapters, and `inv:<id>` handling outside F299/source-owner boundaries.
