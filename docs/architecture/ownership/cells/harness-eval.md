---
cell_id: harness-eval
title: Harness Eval Control Plane
summary: Harness contract、runtime eval、measurement validity/owner-backed issuance、verdict handoff、domain registry、durable verdict lifecycle、F313 immutable finding/repair-target artifacts，以及 F278 每条爪感差的 duty/issue 双轴、source-exact owner-backed direct-repair、可恢复 blocker poller 与 refs-only legacy census。
canonical_features: [F192, F266, F267, F278, F313]
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
  - packages/api/src/infrastructure/harness-eval/eval-repair-approval-contracts.ts
  - packages/api/src/infrastructure/harness-eval/eval-repair-approval-projection.ts
  - packages/api/src/infrastructure/harness-eval/eval-repair-approval.ts
  - packages/api/src/infrastructure/harness-eval/eval-repair-case-action-resolver.ts
  - packages/api/src/infrastructure/harness-eval/eval-repair-cutover.ts
  - packages/api/src/infrastructure/harness-eval/eval-repair-reconciliation.ts
  - packages/api/src/infrastructure/harness-eval/eval-repair-outcome.ts
  - packages/api/src/infrastructure/harness-eval/eval-repair-fresh-outcome.ts
  - packages/api/src/infrastructure/harness-eval/eval-repair-evolution-owner-port.ts
  - packages/api/src/infrastructure/harness-eval/eval-repair-owner-runtime.ts
  - packages/api/src/infrastructure/capability-evolution/change/f311-e0-eval-repair-owner-binding.ts
  - packages/api/src/infrastructure/capability-evolution/change/f311-e0-eval-repair-owner-provider.ts
  - packages/api/src/infrastructure/capability-evolution/change/f311-e0-eval-repair-owner-runtime-registration.ts
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
  - packages/api/src/infrastructure/harness-eval/friction/friction-finding-artifact.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-finding-child-artifact.ts
  - packages/api/src/infrastructure/harness-eval/friction/friction-repair-target-resolver.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/read-model.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/service.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/service-blocker-reopen.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/continuation/follow-up-resolver.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-federation.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/continuation/source-case-action-resolver.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/blocker-reconciler.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/signal-scan.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/legacy-blocker-census.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/legacy-blocker-recovery.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/providers/memory-cue-owner-provider.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/providers/memory-cue-git-truth.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/providers/task-workflow-owner-provider.ts
  - packages/api/src/infrastructure/harness-eval/paw-feel-disposition/providers/task-workflow-git-truth.ts
  - packages/api/src/infrastructure/harness-eval/measurement/measurement-bundle-schema.ts
  - packages/api/src/infrastructure/harness-eval/measurement/measurement-bundle-validation.ts
  - packages/api/src/infrastructure/harness-eval/measurement/measurement-bundle-census.ts
  - packages/api/src/infrastructure/harness-eval/measurement/friction-measurement-bundle.ts
  - packages/api/src/infrastructure/harness-eval/measurement/measurement-replay.ts
  - packages/api/src/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source.ts
  - packages/api/src/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source-validation.ts
  - packages/api/src/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-source-store.ts
  - packages/api/src/infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-issuer.ts
  - packages/api/src/infrastructure/harness-eval/measurement/measurement-artifact-files.ts
  - packages/api/src/infrastructure/harness-eval/measurement/measurement-decision-proof-owner-object-spec.ts
  - packages/api/src/infrastructure/harness-eval/measurement/measurement-decision-proof-resolver.ts
  - packages/api/src/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.ts
  - scripts/check-verdict-publish-contract.mjs
  - scripts/guarded-bin/gh
  - packages/shared/src/types/friction-signal.ts
  - packages/shared/src/types/paw-feel-continuation.ts
  - packages/api/src/routes/eval-hub.ts
  - packages/api/src/routes/eval-verdict-lifecycle.ts
  - packages/api/src/routes/eval-repair-outcome-routes.ts
  - packages/api/src/routes/paw-feel-legacy-census.ts
  - packages/api/src/routes/capability-evolution-measurement-issuance-route.ts
  - packages/api/src/routes/feature-thread-resolver.ts
  - packages/mcp-server/src/tools/eval-lifecycle-tools.ts
  - packages/mcp-server/src/tools/capability-evolution-tools.ts
  - packages/mcp-server/src/tools/paw-feel-disposition-tools.ts
  - packages/web/src/components/HubEvalTab.tsx
  - packages/web/src/components/HubEvalLifecycleSummary.tsx
  - packages/web/src/components/eval-workspace/EvalWorkspaceEventCard.tsx
  - packages/web/src/components/eval-workspace/PawFeelInboxRow.tsx
  - packages/web/src/components/paw-feel/PawFeelDispositionDock.tsx
  - sop-definitions/development.yaml
  - sop-definitions/stubs/video-cocreation.yaml
  - sop-definitions/stubs/tech-article.yaml
  - sop-definitions/stubs/family-office.yaml
  - scripts/sop-definitions.mjs
  - scripts/lib/sop-definition-codegen.mjs
  - packages/shared/src/types/sop-definition.generated.ts
doc_anchors:
  - docs/features/F192-socio-technical-harness-eval.md
  - docs/features/F266-eval-verdict-closure-control-plane.md
  - docs/features/F245-friction-signal-eval.md
  - docs/features/F248-eval-hub-human-readability.md
  - docs/features/F254-side-effect-freshness-gate.md
  - docs/features/F267-eval-measurement-validity.md
  - docs/features/F278-paw-feel-disposition-inbox.md
  - docs/features/F313-analysis-to-outcome-closure-command.md
  - feature-discussions/2026-07-26-f278-paw-feel-disposition-inbox/README.md
  - docs/harness-feedback/migrations/f266-legacy-reeval-cases.yaml
  - docs/harness-feedback/eval-domains/eval-freshness.yaml
  - docs/harness-feedback/registry/measurement-bundles.yaml
  - docs/harness-feedback/measurement-sources/capability-evolution/owner-inputs/evolution-program-bcc336788a7df9d6075b1efb4c0a7e68-eval-repair-owner-binding-v1.yaml
  - feature-discussions/2026-05-21-f192-phase-e-eval-hub-kickoff/README.md
  - sop-definitions/README.md
static_scan_hints: [harness-eval, VerdictHandoffPacket, lifecycle-root.json, eval:verdict-lifecycle, reeval-closure, reeval-case, legacy_case_migrated, legacy-reeval-case-migration, repairDebtStatus, reevalDebtStatus, eval-case-v1, eval-domain, reeval, harness-fit-digest, Eval Hub, freshness-closure-replay, f254-freshness-replay, FreshnessReplayProvider, evalFreshnessLiveVerdict, no_data, rawArtifactSha256, SopDefinition, sop-definitions, predicate, friction, paw-feel, PawFeelDisposition, PawFeelIssueProjection, direct-repair-binding, repair_outcome_linked, blocker_reopened, paw-feel-inbox, paw-feel-legacy-blocker-census, FrictionSignal, measurement-validity, measurement-certificate, measurement-bundle-result, measurement-issuance, measurement-proof, same-version-replay, prospective_paired_capture]
cited_by:
  - F192 Phase E-pilot
  - F245 Phase A (paw-feel friction collector) + Phase B (cancel/user-feedback/eval-domain adapters + aggregator + clusterer + rollup input; domain registration + rollup sink land in Phase C)
  - F248 Phase A (Eval Hub human-readability: registry descriptionForHuman + Hub display + state/verdict badge disambiguation)
  - F248 Phase B design (registry-driven metricGlossary / metricGlossaryRef explainability; frontend renders, does not hardcode metric semantics)
  - F248 Phase B2 (structured operator narrative from registry + verdict bundle; machine wording stays drill-down only)
  - F248 publish target hardening (owner-repo, canonical census, domain/window uniqueness, and automatic/manual transport fences)
  - F167 Phase R (terminal coordination ACK suppression counter + Claim/Release/ACK regression fixture)
  - F254 AC-E9 (server-owned eight-fixture / durable-closure replay selector, normalized evidence bundle, live verdict generator, and explicit no-data verdict)
  - F267 Phase A (frozen canonical cancel join, four-channel opportunity-to-action funnel, and measurement-validity artifact)
  - F267 Phase B (real bundle census, strict measurement certificate/result contract, versioned decision procedure, same-version frozen replay, insufficient hard check, and intervention gate)
  - F266 Phase B-C (immutable lifecycle root, append-only Redis event log, authenticated owner writeback, idempotent SLA reconciler, and F248 Settings / Workspace projections)
  - F266 production operational acceptance (stable finding/case lineage, durable TaskStore + F167 responsibility, and server-verified main/live/re-evaluation truth)
  - F278 Design Gate (per-signal source-ref disposition ledger, system-thread duty, and Workspace live inbox)
  - F313 Phase B (one immutable finding/child/root per actionable friction candidate, canonical repair-target resolution, and schema-v3 quarantine before atomic Phase C cutover)
  - F313 Phase C (F266 immutable Approval lineage, owner-backed exact refs, drift supersession, and exactly-once canonical repair custody behind one fail-closed v3 cutover)
  - F313 Phase D (owner-backed changed/no-change receipts, loaded-runtime freshness, typed outcomes, dormant ref-only F311 owner port, plus F278 continuing-responsibility/direct-repair/blocker-recovery integration)
  - F313 Phase D7 (exact F287 direct-repair provider, bounded typed-blocker polling, and authenticated stateless legacy census; legacy mutation remains separately authorized)
  - F313 Phase D8 (exact F160 task-workflow provider and live bounded feature-query outcome verification; TaskStore remains the projection owner)
---

# Harness Eval Control Plane

## Canonical Owner

F192 owns the socio-technical harness evaluation contract: harnesses declare expected behavior, runtime eval observes actual behavior, attribution explains gaps, verdict packets hand off evidence to feature owners, and later eval verifies closure. F313 Phase B extends the friction publisher without activating action custody: each actionable candidate receives one immutable finding artifact, deterministic child packet/bundle and schema-v3 root, while the server derives a separate repair target from canonical feature/thread-owner truth. Schema v3 is known but quarantined until Phase C can cut over atomically, so it creates no F266 case, Approval proposal/card, Task or F167 lease. F266 owns the durable lifecycle control plane after an actionable verdict is admitted: the immutable bundle seeds identity, an append-only Redis event log records authenticated state transitions, a reconciler resurfaces overdue work, and F248 surfaces project canonical state for humans. Its operational acceptance layer also migrates audited legacy v1 roots into stable in-memory cases without rewriting artifacts, binds repair and cadence work to separate TaskStore + F167 responsibilities, and turns `nextEvalAt` into executable re-evaluation work. F254 extends this control plane with one domain adapter: `freshness-closure-replay` resolves only server-owned fixtures or durable closure identity, normalizes raw/snapshot/attribution/provenance evidence, and generates an `eval:freshness` verdict without moving control-plane ownership out of F192/F266. F278 owns the distinct pre-verdict responsibility object for each canonical cat-authored paw-feel signal: MessageStore remains body truth, F245 remains read-only analysis truth, and one append-only source-ref ledger projects duty into `thread_eval_friction`, Workspace「评估」live view, Settings Eval Hub history and the original message without copying marker prose. All four surfaces read the same F278 event projection; none owns a second disposition writer.

F313 Phase C replaces the schema-v3 quarantine exit with one compatibility/epoch cutover. F266 stores immutable
proposal, Approval decision, owner/target/authorization snapshot, drift supersession and custody receipt refs in its
existing event log; F246 owns the shared lifecycle/epoch/projection contract; the canonical repair owner alone creates
Task/F167 custody. A proposal and an accepted dispatch each re-resolve exact owner-backed truth. Without every binding
and an explicit production `v1_active` migration receipt, v3 remains side-effect-free and the action route returns a
typed unavailable blocker.

F313 Phase D keeps the same F266 event log and adds no mutation or outcome store. The asset owner resolves an opaque
receipt and remains the only mutation writer; F266 verifies exact case/proposal/Approval/authorization/target/
intervention bindings, main containment, loaded runtime identity/time, then appends one immutable changed or no-change
event. Fresh outcome evidence must cite that receipt, follow the Approval decision and loaded runtime, and carry an
uncontaminated freshness proof. The F311-facing owner port exposes refs/status/times only. Its value decision verifier
accepts a direct owner user session or exact callback source and resolves the authority ref inside the owner boundary;
agent-key identity cannot sign keep/tune/rollback/sunset/no-change. Terminal rejection, withdrawal and supersession
snapshots expose an owner-backed decision ref, while pending remains append-free. Missing any port binding leaves every
production effect false. The API composes the F266 cutover, Phase D outcome service and F311-facing port from one
read-only canonical-owner binding snapshot, then connects the outcome service and F311 port only through registered
consumer seams. The F311 E0 fix-forward registers one real provider plus both consumers through the same bootstrap used
by the API and official Alpha: it cross-validates the Program charter, economic authorization certificate, measurement
roles, F267 measurement source, and the explicit owner binding for
`F311:capability:f311-investor-roadshow-expression`. That source currently says `insufficient + keep_observe`, has no
owner objects, and the owner binding has no authorization, lineage, intervention receipt, outcome receipt, or decision
receipt. Consequently Alpha can prove the composition is reachable while every business command remains typed
fail-closed; production remains wholly dormant until an independently authorized F266 `v1_active` epoch exists.

The Phase D continuing-responsibility correction keeps F278's append-only signal ledger as the sole writer and projects
two orthogonal read truths: `validExit` remains the duty-review receipt, while issue `open|resolved`, age and continuation
come from the same F278 projection joined to exact Task/F167 and F245/F266 owner refs. A direct fix rereads and
digest-verifies the source, selects exactly one non-overlapping provider from a frozen process-local registration
snapshot, and stores only server-derived route/authority/target/outcome refs. Task/F167 proves custody, never action
authority. D7 registers exactly one concrete F287 route for `cat_cafe_record_memory_cue_outcome`: its provider rereads
the immutable operator authorization message, binds the canonical F287 owner and loaded Git baseline, then accepts only the
named outcome-lifecycle action. Outcome linking rereads the exact F287 append-only event and requires a relevant owner
surface delta that is both loaded and contained by current main; it never copies cue content.

D8 adds a separate exact route for `cat_cafe_list_tasks`; it cannot borrow the F287 provider or select by caller-authored
`actionRef`. The provider rereads the immutable source marker and operator authorization, requires active Task/F167 custody,
binds the loaded tool revision, and verifies a relevant loaded/current-main Git delta plus the same bounded,
`ownerUserId`-scoped F299 query derived from canonical TaskStore truth. Missing/foreign task ownership fails closed even
inside the shared default thread, and the owner scope participates in the content-free query identity. The provider
returns refs only and adds no task writer, outcome store, or alternate work identity.

New blockers freeze a canonical task/event or bounded-time condition and can produce one CAS-safe
`blocker_reopened`; stable conditions write nothing. The existing F139 reconciliation task now invokes a bounded F278
poller first: one tick consumes one SSCAN cursor page of at most 50 signal logs, with process-local continuation and no
new lifecycle authority. Legacy unbound blockers remain visible debt. Cats may traverse them through the authenticated
`cat_cafe_census_legacy_paw_feel_blockers` reader: every request reads at most 50 logs, partial pages expose only counts
plus an HMAC-signed stateless cursor, and only a complete traversal emits the digest-bound ≤50-row manifest. The
separately authorized recovery helper remains absent from API, scheduler and startup registration. Any later mutation
still flows through `PawFeelDispositionService`, which re-derives event identity, actor and legacy blocker digest before
the sole event-log append.

## Use This When

- Adding or changing an Eval Contract for a harness, skill, MCP tool, SOP, or shared rule.
- Adding or changing a SOP stage definition or predicate-backed hard rule.
- Adding an eval domain registry entry such as `eval:a2a` or `eval:memory`.
- Adding or changing F254 freshness replay selectors, fixture truth, durable closure normalization, derived metrics/samples, or live verdict generation.
- Adding or changing a decision-bearing measurement bundle, opportunity join, uncertainty/insufficient state, or withdrawal condition.
- Producing or validating Verdict Handoff Packets.
- Publishing or refreshing verdict evidence branches and PRs, including manual fallback paths.
- Recording owner acknowledgement, action plans, landed fixes, re-evaluation, reasoned operator suppression, or SLA escalation for an actionable verdict.
- Recording or projecting per-paw-feel `new / seen / route_pending / routed / closed / duplicate / no_action` responsibility.
- Changing the orthogonal paw-feel issue continuation, source-to-F266 join, direct-repair provider binding/outcome, or blocker-resume contract.
- Migrating legacy scheduled tasks into unified eval runtime.
- Deciding whether a harness should `fix`, `build`, `keep_observe`, or `delete_sunset`.

## Extend By

- Add domain-specific adapters under `packages/api/src/infrastructure/harness-eval/`.
- Keep raw telemetry ownership in F153; this cell consumes telemetry and produces derived verdicts.
- Keep domain thread text as working context only; registry, snapshots, verdicts, and closure records are the state source of truth.
- Keep finding truth immutable in the verdict bundle. Persist only lifecycle identity in `lifecycle-root.json` and authenticated transition deltas in the append-only event log.
- For friction breakout, preserve F245 under `harnessUnderEval`, resolve feature/component/owner/version only on the server as `repairTarget`, and fail closed to a blocked finding artifact when canonical target truth is unavailable or ambiguous.
- Treat schema-v3 friction roots as read-only, known-but-quarantined artifacts until the complete Phase C cutover exists. Do not open a legacy/stable case or call proposal, card, Task or F167 custody paths from Phase B readers.
- For Phase C, require one stable `v1_active` producer epoch snapshot plus all loader/adapter/ingress/route/owner-dispatch bindings before activating schema v3. Re-resolve opaque owner authorization and exact target version before proposal and accepted dispatch; supersede drift and never reuse an old Approval.
- For Phase D, resolve change/no-change and re-evaluation receipts from their canonical owners; reject caller-authored
  payload, mismatched lineage, missing main/live/no-change truth, merge-only claims, stale/pre-load evidence and replay
  collisions before appending F266 events. Compose the F266 cutover, outcome service and F311 adapter from one atomic
  owner-provider snapshot, and require registered outcome-owner plus F311 consumer seams before checking the v1 epoch;
  keep the whole runtime dormant until every producer/consumer binding exists. A registered pilot provider may expose
  canonical missing truth, but must not convert a target string, chat text, agent-key identity, zero-sample measurement,
  or empty owner-object list into authorization, lineage, or a receipt.
- Fail verdict publication closed unless the Git remote matches the configured owner repo, the candidate contains and refreshes the canonical measurement census, and its `{domainId,startMs,endMs}` identity is unique against base plus candidate. Automatic publisher, pre-push, and agent-shell PR fallback must reuse one executable guard.
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
- For capability-evolution issuance, accept only Program identity through the authenticated callback. Re-read the target owner's exact source manifest on origin/main; independently bind the Program value owner to the authenticated workspace user and bind the measurement consumer either to that legacy value-owner seat or to the certificate's exact `{consumerFeatureId, consumerOwnerCatId}` cat seat. Hash-bind every owner object and role artifact, never let the consumer inherit value-verdict authority, and publish through the measurement-only worktree allowlist; leave Program advancement to F311.
- Require dry-run evidence before disabling or redirecting legacy scheduled tasks.
- Reuse `extractPawFeelMarkers`; persist source refs, digest identity and cat-signed disposition only. Keep system-thread notices content-free and let Workspace resolve previews from the canonical source on read.
- Derive Workspace live and Settings history from the same F278 event log/projection. Their different presentation and retention views must not introduce separate status stores, cache authority or mutation endpoints.
- Keep duty `validExit` and issue resolution separate. Only a reasoned terminal no-action or owner-verified outcome may resolve an issue; duplicate rows follow their ultimate canonical signal.
- For direct paw-feel repair, derive provider selection from the verified source-tool ref before exposing opaque `actionRef`; bind source, route/version, action scope, existing authorization, target, owner and outcome verifier, then revalidate the same binding at outcome.
- Require every new explicit blocker to carry a server-resolved task/event condition or future bounded recheck. Derive condition/reopen identities server-side, append reopen under expected-sequence CAS, and keep legacy recovery bounded and manually authorized.
- Register typed-condition polling as bounded read/reconcile work only. Keep its cursor process-local, keep legacy census continuation signed and stateless, and never pass a partial census to the recovery writer.

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
- Do not accept certificate/result/proof payloads through the capability-evolution action, manufacture owner objects from prose, or treat proof `verified` as measurement `usable` or Program advancement.
- Do not let clustering, embedding, Top-N, degradation or source-preview availability gate per-signal visibility.
- Do not reuse F266 verdict identity for raw paw-feel signals, and do not present F278 `routed` as “fixed”.
- Do not let Workspace, Settings, the duty thread or the original-message annotation become a second F278 control plane; they are projections, not owners.
- Do not infer issue closure from duty `validExit`, Task done, lease terminal, merge, Approval, routed receipt or legacy `closed` alone.
- Do not let caller `actionRef` choose a direct-repair provider or let generic Task/F167 custody mint authorization/outcome truth.
- Do not register the legacy recovery writer before its explicit production-data authorization. The bounded typed-condition poller and refs-only census reader are not mutation authority; Phase E may verify the resulting pre-E receipt but cannot create it.

## Static Scan Hints

Watch for new `eval:*` domains, `VerdictHandoffPacket`, `lifecycle-root.json`, `eval:verdict-lifecycle`, `reeval-closure`, `harness-fit-digest`, `delete_sunset`, `reeval`, `legacy scheduled task`, `harness-feedback`, `freshness-closure-replay`, `f254-freshness-replay`, `FreshnessReplayProvider`, `evalFreshnessLiveVerdict`, `PawFeelIssueProjection`, `direct-repair-binding`, `repair_outcome_linked`, `blocker_reopened`, `no_data`, `rawArtifactSha256`, `SopDefinition`, `sop-definitions`, `predicate`, `measurement-validity`, `measurement-certificate`, `measurement-bundle-result`, `same-version-replay`, and `prospective_paired_capture` artifacts.
