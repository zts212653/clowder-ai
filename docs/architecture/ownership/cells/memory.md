---
cell_id: memory
title: Memory / Evidence
summary: Evidence indexing、retrieval、scanner selection、bootstrap、library memory 与 execution-time cue orchestration。
canonical_features: [F102, F152, F209, F255, F260, F263, F271, F276, F282, F287]
code_anchors:
  - packages/api/src/domains/memory/interfaces.ts
  - packages/api/src/domains/memory/IndexBuilder.ts
  - packages/api/src/domains/memory/SqliteEvidenceStore.ts
  - packages/api/src/domains/memory/EntityRegistry.ts
  - packages/api/src/domains/memory/entity-registry-mutation.ts
  - packages/api/src/domains/memory/entity-conflict-resolution.ts
  - packages/api/src/domains/memory/entity-conflict-mutation.ts
  - packages/api/src/domains/memory/CatCafeScanner.ts
  - packages/shared/src/scanner-discovery-pure.ts
  - packages/api/src/domains/memory/GenericRepoScanner.ts
  - packages/api/src/domains/memory/ExpeditionBootstrapService.ts
  - packages/api/src/domains/memory/KnowledgeResolver.ts
  - packages/api/src/domains/memory/PerspectivePlanLoader.ts
  - packages/api/src/domains/memory/PerspectiveRunner.ts
  - packages/api/src/domains/memory/reflection-extractor.ts
  - packages/api/src/domains/memory/pull-only-ranking.ts
  - packages/api/src/domains/memory/MemoryReflectionStore.ts
  - packages/api/src/domains/memory/SessionReflectionProducer.ts
  - packages/api/src/domains/memory/DailyContextReflectionProducer.ts
  - packages/api/src/domains/memory/DailyContextReflectionTaskSpec.ts
  - packages/api/src/routes/perspectives.ts
  - packages/mcp-server/src/tools/perspective-tools.ts
  - packages/api/src/domains/auto-dream/AutoDreamStore.ts
  - packages/api/src/domains/auto-dream/DiaryEvidenceProjector.ts
  - packages/api/src/domains/auto-dream/AutoDreamServices.ts
  - packages/api/src/domains/auto-dream/private-seed-contract.ts
  - packages/api/src/domains/auto-dream/private-seed-operations.ts
  - packages/api/src/routes/auto-dream.ts
  - packages/api/src/routes/callback-auto-dream-routes.ts
  - packages/mcp-server/src/tools/auto-dream-tools.ts
  - packages/api/src/domains/memory/f263-lifecycle-types.ts
  - packages/api/src/domains/memory/LifecycleTraceStore.ts
  - packages/api/src/domains/memory/f263-lifecycle-collector.ts
  - packages/api/src/domains/memory/ProactiveMemoryCandidateDetector.ts
  - packages/api/src/domains/memory/ProactiveMemoryNudgeService.ts
  - packages/api/src/domains/memory/ProactiveMemoryOpportunityEvaluator.ts
  - packages/api/src/domains/memory/proactive-memory-cold-start-contract.ts
  - packages/api/src/domains/memory/proactive-memory-opportunity-ref.ts
  - packages/api/src/domains/memory/people/PersonMemorySourceBundleResolver.ts
  - packages/api/src/domains/memory/people/PersonMemoryInformedEvidence.ts
  - packages/api/src/domains/memory/people/person-memory-provenance.ts
  - packages/api/src/domains/memory/people/person-memory-proposal-forget.ts
  - packages/api/src/domains/memory/people/AsrPersonMemoryContractTrial.ts
  - packages/api/src/domains/memory/people/AsrPersonMemoryOpportunityPromptService.ts
  - packages/shared/src/types/memory-write-opportunity.ts
  - packages/mcp-server/src/tools/person-memory-lifecycle-tools.ts
  - packages/api/src/routes/person-memory-proposal-preflight.ts
  - packages/api/src/scripts/f282-proactive-memory-phase-d-replay.ts
  - packages/mcp-server/src/tools/proactive-memory-opportunity-tool.ts
  - cat-cafe-skills/proactive-memory-judgment/SKILL.md
  - packages/shared/src/types/memory-cue.ts
  - packages/api/src/domains/memory/cue/RecallOpportunityCatalog.ts
  - packages/api/src/domains/memory/cue/MemoryCuePlaneService.ts
  - packages/api/src/domains/memory/cue/MemoryCueResolverRegistry.ts
  - packages/api/src/domains/memory/cue/MemoryCueInvocationPromptService.ts
  - packages/api/src/domains/memory/cue/MemoryCueEpisodeStore.ts
  - packages/api/src/domains/memory/cue/MemoryCueDrillHandleService.ts
  - packages/api/src/domains/memory/cue/MemoryCueSourceReader.ts
  - packages/api/src/domains/memory/cue/MemoryCueTrustedConnector.ts
  - packages/api/src/domains/memory/cue/createMemoryCueRuntime.ts
  - packages/api/src/routes/callback-memory-cue-routes.ts
  - packages/mcp-server/src/tools/memory-cue-tools.ts
doc_anchors:
  - docs/decisions/020-f102-memory-system-architecture.md
  - docs/features/F102-memory-adapter-refactor.md
  - docs/features/F152-expedition-memory.md
  - docs/features/F209-evidence-recall-optimization.md
  - docs/features/F211-cross-runtime-session-transparency.md
  - docs/features/F255-auto-dream.md
  - docs/features/F260-write-side-autopsy-entity-deref.md
  - docs/features/F271-pragmatic-memory-reflection.md
  - docs/features/F276-people-relationship-memory.md
  - docs/features/F282-proactive-memory-pipeline.md
  - docs/eval/f282-phase-d-cold-start-opportunity.md
  - project-evidence/F282/phase-d/README.md
  - feature-specs/2026-07-18-f260-entity-conflict-resolution.md
  - docs/features/F263-memory-lifecycle-repair-and-metrics.md
  - docs/features/F287-memory-cue-plane.md
  - docs/architecture/memory-cue-source-map.md
  - docs/features/evidence/F287/README.md
  - docs/eval/memory-cue-person-v1.md
  - docs/eval/memory-cue-operational-precedent-v1.md
  - docs/eval/memory-cue-taste-v1.md
  - feature-discussions/2026-08-02-f287-close-gate/close-gate-report.md
static_scan_hints: [IEvidenceStore, IIndexBuilder, RepoScanner, EvidenceStore, IndexBuilder, Scanner, Memory, passage_vectors, entity_id, entity conflict, EntityRegistry, EntityConflictContext, Perspective, searchEvidence, search_evidence, AutoDreamStore, DreamDiaryEntry, SleepPosture, PrivateCue, OwnedSeed, F255PendingCueSink, DiaryEvidenceProjector, world:diary, LifecycleTraceStore, lifecycle_traces, VerificationEvent, ThreeAxisSnapshot, MemoryReflectionStore, SessionReflectionProducer, DailyContextReflectionProducer, DailyContextReflectionTaskSpec, reflection_outputs, pull_only, applyPullOnlyDownrank, ProactiveMemoryOpportunityEvaluator, ProactiveMemoryColdStartConfig, proactive-memory-judgment, opportunityRef, RecallOpportunityCatalog, MemoryCuePlaneService, MemoryCueResolverRegistry, MemoryCueInvocationPromptService, MemoryCueEpisodeStore, MemoryCueDrillHandleService, MemoryCueSourceReader, memory_cue_events]
cited_by:
  - {feature: F191, date: 2026-05-07, delta: new cell}
  - {feature: F209, date: 2026-05-22, delta: "passage-level semantic recall, entity registry as retrieval anchors, typed evidence drill-down readers, and Perspective query-plan surface"}
  - {feature: F211, date: 2026-05-24, delta: "boundary note — F211 produces runtime session transcript/digest evidence; memory consumes and retrieves that evidence without owning runtime binding"}
  - {feature: F211, date: 2026-05-25, delta: "Phase B keeps external runtime registration/list/read in identity-session; memory remains a consumer after transcript/digest materialization"}
  - {feature: F193, date: 2026-06-03, delta: "Phase E adds read-side cross-post affordance hints to search_evidence and list_recent result envelopes"}
  - {feature: F243, date: 2026-06-30, delta: "Phase B-0 extracts CatCafeScanner docs discovery into a shared pure function for profile scope resolution"}
  - {feature: F255, date: 2026-07-17, delta: "Phase A adds an owner-scoped diary and sleep-posture product store plus a rebuildable private world:diary evidence projection"}
  - {feature: F260, date: 2026-07-19, delta: "entity proposal conflicts become fingerprinted, atomic registry decisions with append-only revisions instead of a terminal 409"}
  - {feature: F263, date: 2026-07-20, delta: "Phase C adds append-only lifecycle trace substrate (storable:false/indexable:false shadow table), verification events schema, unmet demand three-state bucketing, and three-axis dashboard in RecallLedger"}
  - {feature: F272, date: 2026-07-22, delta: "Phase A adds F255-owned private cue and owned-seed tables plus a receipt-only F255PendingCueSink; F272 consumes them without creating a second private-memory truth"}
  - {feature: F271, date: 2026-07-20, delta: "session-close and F139 daily typed-delta producers, owner-day supply ledger, exact source anchors, and pull-only public candidates; downstream lane truth remains with each lane owner"}
  - {feature: F276, date: 2026-07-25, delta: "new private-person-relationship subcell proposal — per-user third-party person claims, first-class You↔person relationships, append-only interaction truth, and bounded authorized relationship cards; physical substrate remains open until Design Gate census"}
  - {feature: F276, date: 2026-07-27, delta: "identity-root amendment — F260 workspace person Entity remains the single shared identity root; F276 materializes only an owner-private extension with server-derived one-way linkage, owner/entity reverse uniqueness, convergent recall, and private-only forget"}
  - {feature: F276, date: 2026-08-15, delta: "ASR contract trial consumes signal-intake mechanical observations through a shared WriteOpportunity contract; memory owns disposition, deferred lineage, destination outcome, and fail-closed invalidation"}
  - {feature: F281, date: 2026-07-30, delta: "F276 exact-proposal lifecycle closes the pure-unbound terminal deletion gap without inventing a hidden person identity; person-bound proposals continue to require whole-person forget"}
  - {feature: F282, date: 2026-07-30, delta: "lane-neutral cross-thread detection, typed server-resolved F276 source bundles, same-request preflight, informed source-to-field cards, and immutable complete-snapshot pending replacement"}
  - {feature: F282, date: 2026-07-30, delta: "versioned cold-start constraint vector, opaque invocation-derived opportunity refs, ToolEventLog proposal/abstention projection, proactive-memory judgment skill, and compact L0 wakeup"}
  - {feature: F287, date: 2026-08-01, delta: "execution-time memory cue ownership: closed typed opportunities, lane-specific resolvers, bounded cue projection, content-free consumption episodes, and canonical-source invalidation without a second MemoryStore"}
  - {feature: F287, date: 2026-08-02, delta: "Phase E closes the v1 catalog with owner-authenticated Person, operational-precedent, and Taste journeys; exact source coordinates, drill revalidation, content-free lifecycle evidence, per-family keep decisions, and explicit main/Alpha/production truth remain separated"}
---

# Memory / Evidence

## Canonical Owner

F102 owns the memory system contract: `IIndexBuilder`, `IEvidenceStore`, indexing, retrieval modes, local SQLite evidence, and resolver boundaries.

F287 owns the execution-time cue projection boundary: a closed catalog admits server-bound typed
opportunities, lane-specific resolvers produce bounded cues or zero, and consumption/invalidation
episodes remain content-free. Person, Entity, Taste, Profile, operational evidence and project
knowledge keep their existing canonical owners; F287 may revalidate and project them but cannot
copy, correct, forget or restore their truth. The full source/consumer/lifecycle census is
`docs/architecture/memory-cue-source-map.md`.

F152 extends that architecture by adding scanner strategies and bootstrap orchestration for non-Cat-Cafe repositories. New sources should extend the scanner/indexing contract instead of creating parallel stores.

F209 extends the evidence retrieval surface: passage-level semantic recall, entity registry / aliases as retrievable anchors, typed evidence drill-down readers, and Perspective live query plans. F209 `entity_id` is a memory/evidence doorway with provenance; it does not replace roster truth owned by `identity-agent` / F032.

F260 extends the entity registry write side. Conflict inspection is a viewer-scoped pure projection of a pending proposal plus current registry truth; private candidates are visible only to their owner and hidden collisions fail closed without returning candidate snapshots. Approved merge/replace/correction/transfer/polysemy decisions revalidate a fingerprint and atomically update `entity_registry` / `entity_aliases`, append `entity_revision_events`, and refresh `entity_mentions` in one outer transaction. `entity_aliases` already permits the same normalized surface on multiple entities, so explicit polysemy does not require a second relationship store.

F263 extends the observation substrate: `lifecycle_traces` is an append-only, shadow table (`storable:false / indexable:false`) that records harmful consumption events (stale-pointer, identity-misbinding), unmet demand traces (true-zero vs noise bucketing), verification events (target/claim/check/verdict), and attention cost signals. These traces feed the three-axis dashboard in `RecallLedger` but MUST NOT enter evidence search, ranking, or indexing — the table enforces this structurally via separate storage and append-only triggers. The collector hooks into `RecallEventCorrelator` output to classify zero-hit queries into four buckets and produce first verification events.

F211 is an upstream evidence source for Antigravity/runtime sessions. The runtime session binding, IDE-direct registration, hidden anchor threads, and runtime-session list/read APIs belong to `identity-session`; once F211 materializes transcript/digest files, Memory / Evidence can index and retrieve them through the normal evidence path.

F255 owns a private product source inside this cell: `AutoDreamStore` is canonical for immutable diary pages, Present Loop runs, and cat-authored sleep postures. `world:diary` is only an owner-private, rebuildable evidence projection; deleting or rebuilding that index must never delete or rewrite the product page. F139 continues to own schedule lifecycle—F255 merely consumes its template contract.

F272 Phase A extends that same F255 private product store with pending cues and cat-owned seeds. Producers may append a typed cue and receive only `{cueId}`; only the matching live Present Loop cat may adopt, rewrite, reject, or originate a seed. Cue claims, reasons, and seed claims are private product state, not searchable evidence or F263 trace bodies.

F271 extends the write side with session-close and F139-triggered daily reflection producers. The daily producer batches owner/cat sessions from the previous household day and reuses the same `reflection_outputs` ledger and adapters; F139 retains schedule lifecycle ownership. `reflection_outputs` is canonical only for F271 supply-budget claims, replay dedupe, source lineage, and adapter delivery state. Public outputs project into evidence as explicit `candidate` / `pull_only` rows; private desire cues remain an idempotent outbox item until the F255-owned typed cue port acknowledges them. F271 never owns downstream approved truth and cannot create an F255 `owned seed`.

F276 owns the `private-person-relationship` subcell. It owns owner-private third-party
person claim versions, You↔person relationship identity, append-only interaction truth, and
the bounded authorized relationship-card projection. F209/F260 workspace `person` entities are
the single shared identity root: when one unique active workspace Entity exists, F276 may only
materialize an owner-private extension with a server-derived one-way link. No Entity match permits
a private-only identity; ambiguity, resolver failure, or identity-path disagreement fails closed.
The private link and owner-scoped reverse index must not expose dossier existence to a workspace
reader. In v1, F276 identifiers, aliases, source refs, and payload MUST NOT project
into F227/F263/F200: F227 is only an explicit single-source teleport reader, while F263/F200
may receive non-linkable aggregate counters. Reopening cross-cell projection requires a new
privacy design and the target owner sign-off.
F276's logical owner boundary does not authorize a parallel database: its Phase 0 Design Gate
must first prove why existing user-data and memory contracts cannot carry the required
invariants.
Pure-unbound terminal proposal lineages remain F276-owned even though they have no person identity:
their proposal-scoped binding is created only with terminal disposition, and owner-authenticated
exact-`proposalId` forget purges candidate, suppression, producer disposition, and attached F281
receipt/index truth in one fenced lifecycle. Person-bound or mixed lineages fail closed on that
surface and continue to require whole-person forget.

F282 extends F276's producer boundary without creating a second memory truth. Cross-thread
candidate detection is a per-invocation, lane-neutral projection of the canonical owner message
timeline; only a hash-only delivery receipt is operationally durable. Person-memory proposal
evidence is resolved server-side into typed message, attachment, confirmed-transcript, or
allowlisted private-artifact sources. A proposal card remains in the authenticated invocation
thread while each source keeps its true owner-visible thread/message ref for drill; card origin and
evidence origin are distinct coordinates. Assertion bindings preserve epistemic role per selected
draft/field; `agent_inference`, source drift, cross-owner coordinates, connector laundering, and
relayed-quote event laundering fail before card publication. Pending and canonical typed provenance remain
owner-private and are purged with terminal candidates, redaction, or hard forget.
Before the first durable stage, the exact eventual card is checked for source/materializability,
informed-approval, and token-budget constraints; actionable failures preserve legacy top-level
errors while adding bounded machine-readable repair guidance. A pending correction is a complete
new snapshot: the corrected card must be anchored before the superseded candidate is atomically
withdrawn, and omitted items never carry over. Approval Hub projects per-source bounded excerpts,
target fields, epistemic roles, confirmation scope, and owner-safe drill refs without artifact
locators.
Phase D adds no opportunity store. Its versioned cold-start config and pure evaluator consume an
externally frozen, human-adjudicated exposure cohort plus bounded `ToolEventLog` events. Only
recognized result-merged F276 proposal or enum-only calibrated-abstention results become episodes;
unmatched, provisional, failed, contradictory, or older-than-seven-day traces cannot improve the
vector. Opaque opportunity refs are derived from invocation identity and contain no owner,
person, message, thread, source, or reasoning payload. The cat-side judgment funnel lives in
`proactive-memory-judgment`; compiled L0 carries only its compact wakeup. The evaluator exposes
separate coverage, false-positive/pollution, and Approval Hub burden constraints, never a total
score, acceptance KPI, cat ranking, automatic tuning, or prompt feedback loop.

## Use This When

- Adding a new evidence source, scanner, retrieval mode, index state, bootstrap path, or memory UI/API backed by evidence search.
- Changing `IEvidenceStore.search()`, index rebuild behavior, collection/library search, semantic rerank, or provenance handling.
- Adding external-project memory support, repository scanners, or cold-start memory bootstrap behavior.
- Adding or changing passage-level vectors, entity aliases / mentions used for retrieval, typed drill-down hints, or Perspective query-plan execution.
- Changing entity proposal conflict detection, surface ownership decisions, or registry revision semantics.
- Indexing or retrieving materialized session transcripts/digests emitted by external runtime session registration.
- Adding or changing F255 diary pages, sleep-posture continuity, Present Loop observability, private diary projection, or diary drill-down reads.
- Changing F271 session-close/daily typed-delta extraction, reflection supply budgets, source anchors, pull-only visibility, or adapter delivery semantics.
- Adding or changing owner-private third-party person claims, You↔person relationship
  lifecycle, interaction truth, authorized relationship cards, or private/workspace entity
  linkage.
- Changing lane-neutral proactive candidate detection, typed person-memory source resolution,
  assertion-role ceilings, or canonical private provenance.
- Changing proactive-memory opportunity refs, calibrated abstention, cold-start constraints,
  ToolEventLog episode projection, or the judgment-skill/L0 wakeup boundary.
- Adding or changing a typed execution-time recall opportunity, cue family, resolver admission,
  prompt projection, opaque drill handle, consumption outcome, or source invalidation path.

## Extend By

- Implement or extend a scanner strategy such as `RepoScanner`, `CatCafeScanner`, or `GenericRepoScanner`.
- Keep storage changes behind `IEvidenceStore` and indexing changes behind `IIndexBuilder` / `IndexBuilder`.
- Add provenance and resolver behavior as structured fields rather than splitting evidence into a new store family.
- Use `KnowledgeResolver` / collection abstractions for cross-project or library search instead of bypassing evidence search.
- Treat entity registry records as evidence anchors with provenance and scope controls, not as an authority for who a cat is.
- Route every approved entity conflict mutation, revision write, and mention refresh through one registry transaction; treat a stale fingerprint, invalid canonical replacement, revision failure, or refresh failure as a zero-side-effect rejection.
- Treat F211 runtime session output as evidence after transcript/digest materialization; do not reach back into live runtime binding state, external runtime registration, or agent-key auth from memory indexing code.
- Keep F255 diary product writes invocation-authenticated and owner-scoped; project them into `world:diary` after product commit, with startup reconciliation for repair.
- Keep F255 cue ingestion receipt-only and cat seed decisions invocation-authenticated; expose bounded private context only to the matching Present Loop wake.
- Keep F271 writes source-anchored and idempotent. Treat `reflection_outputs` as a producer ledger/outbox, project public candidates with `pull_only`, and hand private cue ownership to F255 only through its canonical typed port.
- Keep F276 canonical truth owner-scoped and outside workspace/global evidence. Treat a uniquely
  resolved active workspace person Entity as the shared identity root and F276 as an owner-private
  extension; allow private-only identity only when no Entity matches. Project only authorized
  bounded cards, forbid person-addressable
  cross-cell telemetry, and make hard forget purge canonical payload plus every derived private
  surface. Keep in-turn detection ephemeral; only a successfully presented owner-private proposal
  may persist as pending approval state, and only deterministically authorized claims may enter
  canonical truth or recall. Pending/rejected proposals must never hydrate context. Keep
  detect/proposal telemetry aggregate-only even inside the owning cell: no person-linkable
  identifiers, source refs, raw values, or hashes. Enforce owner/entity reverse uniqueness and
  require private-alias / Entity-alias recall paths to converge; never silently link a legacy
  private row by display name.
- Keep F282 source inputs as untrusted locators. Re-resolve owner/authorship, the actual source
  thread, visibility, connector absence, lifecycle state, and digest before stage and before
  publication; project only selected draft provenance into
  canonical truth, and keep `sourceRefs` as a compatibility coordinate rather than authority.
  Preflight the exact card before durable stage; treat pending correction as immutable
  complete-snapshot replacement, never as in-place mutation or a synthetic correction event.
- Keep F282 opportunity evaluation exposure-first and content-free. Freeze the external
  adjudicated cohort before reading tool traces; derive the same opaque ref from invocation
  identity on both sides; treat no recognized result as `uninformed_silence`; preserve raw vector
  dimensions and explicit sample floors. Config, rubric, selector, tool, skill, or F276 contract
  changes require a new cohort revision.
- Extend F287 only through a versioned `(producer, kind)` catalog pair and an existing canonical
  source reader. Keep server-owned scope binding, strict payload admission, zero-cue as a normal
  result, per-family budgets, invocation dedupe, source revision revalidation, and append-only
  content-free episodes. New source truth or write-side correction belongs to the source lane.

## Shared Touchpoints

- `signal-intake` owns admitted meeting truth, mechanical ASR scene construction, and binding to an
  exact live owner message. `memory` consumes only the shared typed WriteOpportunity, owns its
  disposition/defer/destination lifecycle, and never lets the producer decide intent, importance,
  transcript truth, or canonical person-memory truth.

## Do NOT Unify With

- Do not turn session transcript storage, invocation logs, or chat history into evidence store APIs just because they are searchable.
- Do not create a second `EvidenceStore`, `MemoryStore`, or bootstrap database for a new feature without explaining why F102/F152 contracts cannot express it.
- Do not mix private project data into global/library memory. Global methods can receive distilled methodology, not raw project content.
- Do not treat callback auth/session credentials as memory; those belong to `callback-auth` and `identity-session`.
- Do not let F209 `entity_id` / aliases override `cat-config.json`, roster, model, role, or reviewer eligibility truth.
- Do not resolve an entity surface collision by route-level SQL, silently stealing aliases, or turning the fail-closed 409 into a permanent product dead end.
- Do not let evidence indexing decide which Antigravity cascade/conversation is active. Active runtime binding and identity history belong to `identity-session`.
- Do not materialize F255 diary products into Git-backed docs, make evidence rows canonical, or let an agent-key/system summary author a diary or sleep posture.
- Do not index private cue reasons or seed claims, and do not let a cue producer return or imply an owned seed.
- Do not turn F271 into a daily-summary store, expose private desire cues through project search, inject candidates into bootstrap/nudge/proactive push, or let a reflection adapter mint an `owned seed`.
- Do not turn F231 primers into a third-party contact database, treat F260 alias registration as
  dossier authorization, push whole person dossiers into context, or let agent inference occupy
  a reported-fact slot.
- Do not create an unlinked F276 person when one unique active workspace person Entity already
  resolves, leak the private reverse index into F260, or let hard forget delete the shared Entity.
- Do not let caller-supplied owner IDs, digests, arbitrary paths, transcript-accuracy
  confirmations, third-party quotes, or agent inference become event truth.
- Do not use free-text intent, connector prose, caller-supplied scope, a process-global envelope
  cache, or whole-library search as an F287 opportunity. Do not persist cue prose, ranking scores,
  or canonical source payloads in `memory_cue_events`, and do not let cue tools mutate source
  lanes.

## Static Scan Hints

Watch for new or renamed `Store`, `EvidenceStore`, `MemoryStore`, `IndexBuilder`, `Scanner`, `RepoScanner`, `BootstrapService`, `Resolver`, `searchEvidence`, `search_evidence`, `passage_vectors`, `entity_id`, `entity registry`, `message window`, `Perspective`, `AutoDreamStore`, `DreamDiaryEntry`, `SleepPosture`, `DiaryEvidenceProjector`, `world:diary`, `MemoryReflectionStore`, `SessionReflectionProducer`, `reflection_outputs`, `pull_only`, `applyPullOnlyDownrank`, `PersonMemorySourceBundleResolver`, `PersonMemoryInformedEvidence`, `PersonMemoryProposalPreflight`, `ProactiveMemoryOpportunityEvaluator`, `ProactiveMemoryColdStartConfig`, `proactive-memory-judgment`, `opportunityRef`, `typedProvenance`, `assertionBindings`, `RecallOpportunityCatalog`, `MemoryCuePlaneService`, `MemoryCueEpisodeStore`, `MemoryCueDrillHandleService`, and `memory_cue_events` code.
