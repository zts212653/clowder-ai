---
cell_id: harness-eval
title: Harness Eval Control Plane
summary: Harness contract、runtime eval、measurement validity、verdict handoff、domain registry、durable verdict lifecycle、F278 disposition responsibility，以及 F257 Objective/Metric、TraceAnnotation、可重放评估与 harness ledger 生命周期。
canonical_features: [F192, F257, F266, F267, F278]
code_anchors:
  - packages/api/src/infrastructure/harness-eval/f167-eval.ts
  - packages/api/src/infrastructure/harness-eval/cross-thread-coordination-eval.ts
  - packages/api/src/infrastructure/harness-eval/attribution.ts
  - packages/api/src/infrastructure/harness-eval/domain/eval-domain-registry.ts
  - packages/api/src/infrastructure/harness-eval/verdict-handoff.ts
  - packages/api/src/infrastructure/harness-eval/publish-verdict/lifecycle-root-artifact.ts
  - packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts
  - packages/api/src/infrastructure/harness-eval/legacy-task-cleanup.ts
  - packages/api/src/infrastructure/harness-eval/reeval-closure.ts
  - packages/api/src/infrastructure/harness-eval/reeval-closure-schema.ts
  - packages/api/src/infrastructure/harness-eval/reeval-closure-event-log.ts
  - packages/api/src/infrastructure/harness-eval/reeval-closure-service.ts
  - packages/api/src/infrastructure/harness-eval/reeval-closure-reconciler.ts
  - packages/api/src/infrastructure/harness-eval/reeval-closure-task-spec.ts
  - packages/api/src/infrastructure/harness-eval/reeval-case.ts
  - packages/api/src/infrastructure/harness-eval/reeval-case-cycle-order.ts
  - packages/api/src/infrastructure/harness-eval/reeval-case-types.ts
  - packages/api/src/infrastructure/harness-eval/reeval-case-guards.ts
  - packages/api/src/infrastructure/harness-eval/reeval-case-root.ts
  - packages/api/src/infrastructure/harness-eval/reeval-case-service.ts
  - packages/api/src/infrastructure/harness-eval/reeval-case-responsibility.ts
  - packages/api/src/infrastructure/harness-eval/reeval-case-reevaluation.ts
  - packages/api/src/infrastructure/harness-eval/legacy-reeval-case-migration.ts
  - packages/api/src/infrastructure/harness-eval/eval-release-truth-resolver.ts
  - packages/api/src/infrastructure/harness-eval/freshness/freshness-replay-types.ts
  - packages/api/src/infrastructure/harness-eval/freshness/freshness-replay-fixtures.ts
  - packages/api/src/infrastructure/harness-eval/freshness/freshness-replay-provider.ts
  - packages/api/src/infrastructure/harness-eval/freshness/eval-freshness-live-verdict.ts
  - packages/api/src/infrastructure/harness-eval/freshness/freshness-eval-cat-instructions.ts
  - packages/api/src/infrastructure/harness-eval/publish-verdict/freshness-generator-adapter.ts
  - packages/api/src/infrastructure/harness-eval/publish-verdict/source-ref-handler-validation.ts
  - packages/api/src/infrastructure/harness-eval/a2a/eval-a2a-adapter.ts
  - packages/api/src/infrastructure/harness-eval/hub/eval-hub-read-model.ts
  - packages/api/src/infrastructure/harness-eval/hub/eval-hub-lifecycle-projection.ts
  - packages/api/src/infrastructure/harness-eval/hub/eval-hub-lifecycle-debt.ts
  - packages/api/src/infrastructure/harness-eval/hub/eval-hub-operator-narrative.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-signal-source.ts
  - packages/api/src/infrastructure/harness-eval/friction/paw-feel-marker.ts
  - packages/api/src/infrastructure/harness-eval/friction/paw-feel-adapter.ts
  - packages/api/src/infrastructure/harness-eval/friction/cancel-adapter.ts
  - packages/api/src/infrastructure/harness-eval/friction/user-feedback-adapter.ts
  - packages/api/src/infrastructure/harness-eval/friction/eval-domain-adapter.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-aggregator.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-clusterer.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-rollup-input.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-rollup-report.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-measurement-pilot.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-measurement-report.ts
  - packages/api/src/infrastructure/harness-eval/measurement/measurement-bundle-schema.ts
  - packages/api/src/infrastructure/harness-eval/measurement/measurement-bundle-validation.ts
  - packages/api/src/infrastructure/harness-eval/measurement/measurement-bundle-census.ts
  - packages/api/src/infrastructure/harness-eval/measurement/friction-measurement-bundle.ts
  - packages/api/src/infrastructure/harness-eval/measurement/measurement-replay.ts
  - packages/api/src/infrastructure/harness-eval/publish-verdict/local-artifact-publisher.ts
  - scripts/guarded-bin/gh
  - packages/shared/src/types/friction-signal.ts
  - packages/api/src/routes/eval-hub.ts
  - packages/api/src/routes/eval-verdict-lifecycle.ts
  - packages/api/src/routes/feature-thread-resolver.ts
  - packages/mcp-server/src/tools/eval-lifecycle-tools.ts
  - packages/web/src/components/HubEvalTab.tsx
  - packages/web/src/components/HubEvalLifecycleSummary.tsx
  - packages/web/src/components/eval-workspace/EvalWorkspaceEventCard.tsx
  - sop-definitions/development.yaml
  - sop-definitions/stubs/video-cocreation.yaml
  - sop-definitions/stubs/tech-article.yaml
  - sop-definitions/stubs/family-office.yaml
  - scripts/sop-definitions.mjs
  - scripts/lib/sop-definition-codegen.mjs
  - packages/shared/src/types/sop-definition.generated.ts
  - packages/api/src/infrastructure/harness-eval/GuardRejectionEventLog.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/EvaluationIndexer.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/EvaluationScheduler.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/EvaluationSnapshotStore.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/MetricResultStore.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/evaluation-catalog.ts
  - packages/api/src/infrastructure/harness-eval/evaluation/evaluator-runner.ts
  - packages/api/src/infrastructure/harness-eval/trace-annotation/PendingTraceMarkerStore.ts
  - packages/api/src/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.ts
  - packages/api/src/infrastructure/harness-eval/trace-annotation/SemanticSweepCoordinator.ts
  - packages/api/src/infrastructure/harness-eval/trace-annotation/SemanticSweepJobStore.ts
  - packages/api/src/infrastructure/harness-eval/trace-annotation/submit-semantic-sweep.ts
  - packages/api/src/infrastructure/harness-eval/guard-threshold-escalation.ts
  - packages/api/src/infrastructure/harness-eval/objective-registry.ts
  - packages/api/src/routes/callback-docs-routes.ts
  - packages/mcp-server/src/tools/list-objectives-tool.ts
  - packages/api/src/infrastructure/harness-eval/publish-verdict/harness-ledger-generator-adapter.ts
  - packages/api/src/domains/prompt-hooks/InjectionTraceStore.ts
  - packages/api/src/routes/prompt-injection-overrides.ts
  - packages/api/src/routes/segment-lifeline.ts
  - packages/api/src/routes/segment-lifeline-chain.ts
  - packages/shared/src/types/segment-lifecycle.ts
  - packages/web/src/components/settings/SegmentLifelineModal.tsx
doc_anchors:
  - docs/features/F192-socio-technical-harness-eval.md
  - docs/features/F266-eval-verdict-closure-control-plane.md
  - docs/features/F245-friction-signal-eval.md
  - docs/features/F248-eval-hub-human-readability.md
  - docs/features/F254-side-effect-freshness-gate.md
  - docs/features/F267-eval-measurement-validity.md
  - docs/features/F278-paw-feel-disposition-inbox.md
  - feature-discussions/2026-07-26-f278-paw-feel-disposition-inbox/README.md
  - docs/harness-feedback/fixtures/f254/
  - docs/harness-feedback/certificates/
  - docs/harness-feedback/measurement-results/
  - docs/harness-feedback/replays/
  - docs/features/F257-harness-ledger.md
  - feature-specs/2026-08-04-f257-objective-eval-redesign.md
  - docs/features/assets/F257/
  - docs/harness-feedback/objectives/registry.yaml
  - docs/harness-feedback/eval-domains/eval-harness-ledger.yaml
  - docs/harness-feedback/
  - docs/harness-feedback/migrations/f266-legacy-reeval-cases.yaml
  - docs/harness-feedback/eval-domains/eval-freshness.yaml
  - docs/harness-feedback/registry/measurement-bundles.yaml
  - feature-discussions/2026-05-21-f192-phase-e-eval-hub-kickoff/README.md
  - sop-definitions/README.md
static_scan_hints: [harness-eval, VerdictHandoffPacket, lifecycle-root.json, eval:verdict-lifecycle, reeval-closure, reeval-case, legacy_case_migrated, legacy-reeval-case-migration, repairDebtStatus, reevalDebtStatus, eval-case-v1, eval-domain, reeval, harness-fit-digest, Eval Hub, freshness-closure-replay, f254-freshness-replay, FreshnessReplayProvider, evalFreshnessLiveVerdict, no_data, rawArtifactSha256, SopDefinition, sop-definitions, predicate, friction, paw-feel, PawFeelDisposition, paw-feel-inbox, FrictionSignal, measurement-validity, measurement-certificate, measurement-bundle-result, same-version-replay, prospective_paired_capture, harness-ledger, TraceEpisode, TraceAnnotation, EvaluationSnapshot, MetricResult, EvaluationIndexer, SemanticSweep, segment-lifeline, ObjectiveRegistry, objective-registry, list_objectives, objectiveId, metricId]
cited_by:
  - F192 Phase E-pilot
  - F245 Phase A (paw-feel friction collector) + Phase B (cancel/user-feedback/eval-domain adapters + aggregator + clusterer + rollup input; domain registration + rollup sink land in Phase C)
  - F248 Phase A (Eval Hub human-readability: registry descriptionForHuman + Hub display + state/verdict badge disambiguation)
  - F248 Phase B design (registry-driven metricGlossary / metricGlossaryRef explainability; frontend renders, does not hardcode metric semantics)
  - F248 Phase B2 (structured operator narrative from registry + verdict bundle; machine wording stays drill-down only)
  - F167 Phase R (terminal coordination ACK suppression counter + Claim/Release/ACK regression fixture)
  - F254 AC-E9 (server-owned eight-fixture / durable-closure replay selector, normalized evidence bundle, live verdict generator, and explicit no-data verdict)
  - F267 Phase A (frozen canonical cancel join, four-channel opportunity-to-action funnel, and measurement-validity artifact)
  - F267 Phase B (real bundle census, strict measurement certificate/result contract, versioned decision procedure, same-version frozen replay, insufficient hard check, and intervention gate)
  - F266 Phase B-C (immutable lifecycle root, append-only Redis event log, authenticated owner writeback, idempotent SLA reconciler, and F248 Settings / Workspace projections)
  - F266 production operational acceptance (stable finding/case lineage, durable TaskStore + F167 responsibility, and server-verified main/live/re-evaluation truth)
  - F278 Design Gate (per-signal source-ref disposition ledger, system-thread duty, and Workspace live inbox)
  - F257 Phase A (invocation tracing + annotation) + Phase C (Objective/Metric evaluation) + Phase D (segment lifeline + governance operations)
  - F257 #3 (objective registry definition layer + list_objectives discovery; canonical objectiveId source for report_harness_signal)
---

# Harness Eval Control Plane

## Canonical Owner

F192 owns the socio-technical harness evaluation contract: harnesses declare expected behavior, runtime eval observes actual behavior, attribution explains gaps, verdict packets hand off evidence to feature owners, and later eval verifies closure. F266 owns the durable lifecycle control plane after an actionable verdict is published: the immutable bundle seeds identity, an append-only Redis event log records authenticated state transitions, a reconciler resurfaces overdue work, and F248 surfaces project canonical state for humans. Its operational acceptance layer also migrates audited legacy v1 roots into stable in-memory cases without rewriting artifacts, binds repair and cadence work to separate TaskStore + F167 responsibilities, and turns `nextEvalAt` into executable re-evaluation work. F254 extends this control plane with one domain adapter: `freshness-closure-replay` resolves only server-owned fixtures or durable closure identity, normalizes raw/snapshot/attribution/provenance evidence, and generates an `eval:freshness` verdict without moving control-plane ownership out of F192/F266. F278 owns the distinct pre-verdict responsibility object for each canonical cat-authored paw-feel signal: MessageStore remains body truth, F245 remains read-only analysis truth, and one append-only source-ref ledger projects duty into `thread_eval_friction`, Workspace「评估」live view, Settings Eval Hub history and the original message without copying marker prose. All four surfaces read the same F278 event projection; none owns a second disposition writer. F257 owns the per-unit ledger lifecycle and the exact path from closed `TraceEpisode` through append-only `TraceAnnotation`, immutable `EvaluationSnapshot`, and append-only `MetricResult` to the segment-lifeline projection. An Objective is a static definition plus unit attachments and Metric rules; it has no lifecycle state machine.

## Use This When

- Adding or changing an Eval Contract for a harness, skill, MCP tool, SOP, or shared rule.
- Adding or changing a SOP stage definition or predicate-backed hard rule.
- Adding an eval domain registry entry such as `eval:a2a` or `eval:memory`.
- Adding or changing F254 freshness replay selectors, fixture truth, durable closure normalization, derived metrics/samples, or live verdict generation.
- Adding or changing a decision-bearing measurement bundle, opportunity join, uncertainty/insufficient state, or withdrawal condition.
- Producing or validating Verdict Handoff Packets.
- Publishing immutable verdict bundles into the durable runtime artifact store.
- Recording owner acknowledgement, action plans, landed fixes, re-evaluation, reasoned operator suppression, or SLA escalation for an actionable verdict.
- Recording or projecting per-paw-feel `new / seen / route_pending / routed / closed / duplicate / no_action` responsibility.
- Migrating legacy scheduled tasks into unified eval runtime.
- Deciding whether a harness should `fix`, `build`, `keep_observe`, or `delete_sunset`.
- Adding a structured rule, MCP marker, or asynchronous semantic classifier that annotates an exact F257 trace episode.
- Adding or changing Objective/Metric definitions, unit/clause attachments, trigger rules, or code/LLM/replay evaluators.
- Extending the segment lifeline read model or its governance operations.

## Extend By

- Add domain-specific adapters under `packages/api/src/infrastructure/harness-eval/`.
- Keep raw telemetry ownership in F153; this cell consumes telemetry and produces derived verdicts.
- Keep domain thread text as working context only; registry, snapshots, verdicts, and closure records are the state source of truth.
- Keep finding truth immutable in the verdict bundle. Persist only lifecycle identity in `lifecycle-root.json` and authenticated transition deltas in the append-only event log.
- Publish verdict artifacts atomically outside the product Git checkout; duplicate artifact IDs fail closed and post-publish side-effect failure rolls the exposed artifact back.
- Cover the manifest's explicit `reviewedThrough` legacy-v1 snapshot with audited completeness/freshness review. Synthesize stable v2 roots and recovered owner/action/re-evaluation continuity only at read/reconcile time; never rewrite historical verdict artifacts or let a later unknown v1 root take down reviewed cases.
- Resolve current repair ownership from eval-domain registry truth, then bind repair and due re-evaluation work to separate deterministic TaskStore subjects and active F167 leases.
- Treat `nextEvalAt` as a work trigger. A due monitor or live cycle must create durable re-evaluation responsibility before the lifecycle can claim `reeval_pending`.
- Project repair debt separately from cadence/re-evaluation debt, and consume trusted later verdicts in the same stable case stream.
- Reopen failed monitoring cadence as an owner-bindable repair state; derive repair debt from lifecycle state and cadence debt from the current main/live activation rather than the immutable verdict label or a superseded result.
- Treat Eval Hub lifecycle state as a projection of the immutable root plus canonical events; never add a second mutable finding or attention store.
- Put human-facing domain / metric explanations in the eval-domain registry or its sidecar; Eval Hub frontend must render these projections rather than hardcoding domain-specific semantics.
- Resolve replay selectors on the server, cap windows/IDs, derive metrics and sample refs from the normalized artifact, and carry raw/snapshot/attribution/provenance hashes through publish. Treat zero eligible data as `no_data`, never as healthy.
- Freeze canonical opportunity rows at a closed window boundary, reconcile adapter output per ID, and keep adapter recall separate from downstream aggregation/clustering/ranking exclusions.
- Issue one measurement certificate per decision bundle, keep context/diagnostic metrics non-decision-bearing, bind every result to a frozen cohort and exact decision-procedure version set, and require an intervention card before fix/build/delete_sunset.
- Require dry-run evidence before disabling or redirecting legacy scheduled tasks.
- Reuse `extractPawFeelMarkers`; persist source refs, digest identity and cat-signed disposition only. Keep system-thread notices content-free and let Workspace resolve previews from the canonical source on read.
- Derive Workspace live and Settings history from the same F278 event log/projection. Their different presentation and retention views must not introduce separate status stores, cache authority or mutation endpoints.
- Keep raw invocation tracing independent from evaluation. Tracing records what happened from invocation start through terminal closure; it does not choose an Objective, Metric, or verdict.
- Producers only append the unified `TraceAnnotation` schema. `report_harness_signal` creates a pending marker for the authenticated invocation; terminal resolution binds it to the exact episode. Structured rules append the same shape. Unclassified episodes enter a bounded asynchronous semantic sweep.
- Keep `EvaluationIndexer` deterministic: validate the annotation coordinates against the registry/manifest, deduplicate by incident key, and project query indexes. It must not perform semantic judgment.
- Keep `EvaluationScheduler` semantic-free: freeze immutable snapshots and trigger evaluators by cadence/threshold only.
- Keep Metric calculation replayable: code evaluators consume stored facts, LLM evaluators consume frozen evidence with persisted prompt/model metadata, and every outcome appends a `MetricResult` rather than mutating prior facts.

## Do NOT Unify With

- Do not move canonical trace storage out of F153 into this cell.
- Do not replace F188 Health Dashboard or F200 memory recall metrics here; consume them as domain inputs.
- Do not treat Eval Hub as a metrics dashboard. A surfaced item must have verdict, owner ask, and re-eval plan.
- Do not infer owner or action backlinks from filenames, branches, commit text, or chat. Owner continuity and refs change only through authenticated lifecycle commands.
- Do not use a legacy artifact's frozen owner text as current task ownership, mutate v1 artifacts during migration, or let one legacy finding render multiple actionable case cards.
- Do not mark cadence complete because repair landed, let stale UI substitute for an executable re-evaluation task, or mint a new case for a trusted follow-up verdict.
- Do not give reconciliation automation fix, merge, or suppression authority; it may only open, project, remind, and escalate.
- Do not accept caller-authored freshness metrics/sample evidence or arbitrary fixture paths, and do not let an empty replay window produce a healthy verdict.
- Do not infer source coverage from `droppedChannels=[]`, convert unavailable observations into zero, or publish a decision-bearing friction rollup without its measurement-validity artifact.
- Do not infer a verdict PR target from the current directory, publish from a checkout missing the canonical census, or use a manual PR fallback to bypass domain/window collision checks.
- Do not accept point-only results as usable, compare replay outputs across different cohort/version identities, or let an unissued/thin certificate unlock a gated eval domain.
- Do not let clustering, embedding, Top-N, degradation or source-preview availability gate per-signal visibility.
- Do not reuse F266 verdict identity for raw paw-feel signals, and do not present F278 `routed` as “fixed”.
- Do not let Workspace, Settings, the duty thread or the original-message annotation become a second F278 control plane; they are projections, not owners.

## Static Scan Hints

Watch for new `eval:*` domains, `VerdictHandoffPacket`, `lifecycle-root.json`, `eval:verdict-lifecycle`, `reeval-closure`, `harness-fit-digest`, `delete_sunset`, `reeval`, `legacy scheduled task`, `harness-feedback`, `freshness-closure-replay`, `f254-freshness-replay`, `FreshnessReplayProvider`, `evalFreshnessLiveVerdict`, `no_data`, `rawArtifactSha256`, `SopDefinition`, `sop-definitions`, `predicate`, `measurement-validity`, `measurement-certificate`, `measurement-bundle-result`, `same-version-replay`, and `prospective_paired_capture` artifacts.
