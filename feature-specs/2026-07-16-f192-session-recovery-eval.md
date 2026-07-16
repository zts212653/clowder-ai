# F192 Session Recovery Eval Implementation Plan

**Feature:** F192 — `docs/features/F192-socio-technical-harness-eval.md` Phase I
**Goal:** A scheduled `eval:session-recovery` domain can replay real bounded session transitions, prove source→target lineage and provider-boundary delivery, assess recovery semantics, and publish sanitized evidence without a parallel data store or synthetic production writes.
**Acceptance Criteria:** AC-I1 through AC-I10 in the F192 Phase I truth source.
**Architecture cell:** `harness-eval` consuming `identity-session`
**Map delta:** update required
**Map delta why:** Add immutable session transition lineage to `identity-session`, and add the derived session-recovery provider/generator to `harness-eval`; ownership direction remains one-way.
**Architecture:** `buildSessionBootstrap()` is the transition join point. It emits typed, ephemeral recovery metadata; route code carries it with the already-assembled prompt; `invokeSingleCat()` stamps an immutable lineage + delivery receipt onto the target SessionRecord at its first `session_init`. A pure provider later scans a bounded SessionChain window, joins target transcript events, and produces replayable trials. Deterministic structural grading and eval-cat semantic assessment stay separate.
**Tech Stack:** TypeScript, Redis-backed SessionChainStore, TranscriptReader, F192 Eval Domain Registry, Zod, Node test runner.
**前端验证:** No — Eval Hub consumes existing verdict/bundle surfaces; Phase I adds no new UI.

---

## Finish Line

`eval:session-recovery` is live only when a scheduled eval cat can preview bounded trials, inspect evidence, publish a validated `VerdictHandoffPacket`, and round-trip its sanitized bundle through Eval Hub. The implementation must cover automatic threshold/budget/error/manual transitions and F225 cat-initiated handoff without assuming every transition has a `proposalId`.

Not building:

- no `SessionRecoveryStore`, duplicate transcript DB, separate Redis, SQLite, HOME, log, or scheduler;
- no regex pretending to understand task semantics;
- no LLM judge service outside the existing eval-cat workflow;
- no synthetic messages in real user threads during tests;
- no `seq + 1` inference accepted as an audit-grade pass.

## Terminal Schema

```ts
type SessionContinuationKind =
  | 'threshold'
  | 'budget_exhausted'
  | 'max_compressions'
  | 'cat_initiated_handoff'
  | 'resume_failure'
  | 'runtime_rotation'
  | 'manual'
  | 'error'
  | 'other';

interface SessionContinuationOrigin {
  sourceSessionId: string;
  sourceSeq: number;
  kind: SessionContinuationKind;
  sealReason: string;
  proposalId?: string;
}

interface SessionRecoveryDeliveryReceipt {
  sourceSessionId: string;
  providerDispatchAt: number;
  bootstrapContentHash: string;
  bootstrapIncludedInPrompt: true;
  handoffNoteIncluded: boolean;
}

interface SessionRecord {
  readonly openedByInvocationId?: string;
  readonly continuationOrigin?: SessionContinuationOrigin;
  readonly recoveryDelivery?: SessionRecoveryDeliveryReceipt;
}

interface SessionRecoverySourceSelector {
  kind: 'session-recovery-window';
  windowStartMs: number;
  windowEndMs: number;
  catId?: string;
  threadId?: string;
  limit?: number;
  assessments?: SessionRecoveryAssessment[];
}

interface SessionRecoveryTrial {
  trialId: `session-recovery:${string}`;
  source: SessionEvidenceRef;
  target?: SessionEvidenceRef;
  inferredTarget?: SessionEvidenceRef;
  lineage: 'explicit' | 'missing' | 'duplicate' | 'legacy_unlinked';
  transitionIntegrity: 'pass' | 'fail' | 'unknown';
  delivery: 'provider_dispatched' | 'missing_receipt' | 'missing_target' | 'unknown';
  firstInvocationId?: string;
  firstMeaningfulEventRef?: string;
  assessment?: SessionRecoveryAssessment;
}

interface SessionRecoveryAssessment {
  trialId: string;
  stateReconstruction: 'recovered' | 'stale' | 'unknown';
  firstMeaningfulAction: 'aligned' | 'repeated' | 'misaligned' | 'unknown';
  outcome: 'continued' | 'completed' | 'failed' | 'unknown';
  evidenceRefs: string[];
  rationale: string;
}
```

## Stateful Object Census

| Object | Lifecycle owner | New lifecycle? | Rule |
|---|---|---:|---|
| `SessionRecord` | `SessionChainStore` | No | Three immutable creation-time fields extend existing `active → sealing → sealed`; later updates cannot overwrite them. |
| `BootstrapRecoveryMetadata` | invocation stack | No, ephemeral | Exists only between bootstrap assembly and the first provider dispatch. Dropped if no fresh transition is being created. |
| `SessionRecoveryTrial` | pure provider | No, derived | Recomputed from SessionChain + TranscriptReader for every selector; never persisted as an independent truth source. |
| `SessionRecoveryAssessment` | eval cat + publish validator | No independent store | Submitted with replay selector, cross-validated against resolved trial IDs/evidence refs, then archived only in the normal verdict bundle. |
| Eval domain registry entry | F192 registry loader | Existing enabled/disabled lifecycle | Starts `enabled: false`; flips only after preview, generator, publish schema, and runtime wiring are all green. |
| Verdict/bundle | existing publish-verdict pipeline | Existing | Immutable verdictId + isolated worktree/PR path; no new lifecycle semantics. |

## SessionRecord State × Event Table

| Current state | Event | Result | Owner / forbidden bypass |
|---|---|---|---|
| no target record | first `session_init` after a sealed source | create `active` target with `openedByInvocationId + continuationOrigin + recoveryDelivery` in one store create | `SessionChainStore.create`; route/invocation code must not post-hoc guess lineage |
| no target record | provider dispatch fails before `session_init` | no target record; source projects as `missing target` after observation window | provider/invocation lifecycle; eval must not fabricate target |
| active target | duplicate/retry `session_init` | preserve original immutable lineage/receipt; normal cli ID update rules only | no generic update API may overwrite lineage |
| active target | later user invocation | no lineage mutation | `buildSessionBootstrap` must not emit fresh-transition metadata while an active target exists |
| active target | seal | retain lineage/receipt unchanged in sealed record | SessionSealer owns lifecycle transition |
| legacy target without lineage | eval projection | `legacy_unlinked`, optional inferred candidate for diagnosis only | provider; inferred candidate can never grade `transitionIntegrity=pass` |

## Invariants

- **INV-SR1**: A target may name exactly one source; lineage fields are immutable after creation.
- **INV-SR2**: `target.threadId/catId/userId` equals source identity tuple and `target.seq === source.seq + 1` for explicit lineage.
- **INV-SR3**: `continuationOrigin.sourceSessionId` must reference a sealing/sealed record; active sources are invalid.
- **INV-SR4**: `proposalId` exists only when `kind='cat_initiated_handoff'` and must match `source.catHandoffNote.proposalId` when a note exists.
- **INV-SR5**: `recoveryDelivery.sourceSessionId === continuationOrigin.sourceSessionId`.
- **INV-SR6**: `bootstrapIncludedInPrompt=true` is stamped only at the provider-dispatch boundary after exact bootstrap inclusion was checked.
- **INV-SR7**: Repeated `session_init`, retry, resume, or ephemeral provider IDs cannot overwrite target lineage.
- **INV-SR8**: Bounded window enumeration is owner-scoped and enforces `windowStart < windowEnd`, maximum duration, and maximum trial count.
- **INV-SR9**: Missing/duplicate/legacy lineage is evidence, never silently filtered and never counted as pass.
- **INV-SR10**: Semantic assessment IDs and refs must resolve within the selected trial window; unknown/duplicate/foreign refs fail closed.
- **INV-SR11**: Committed bundle contains metadata, hashes, and durable refs only; raw transcript/user text stays in its canonical store.
- **INV-SR12**: Tests and acceptance do not connect to Redis 6399 or write synthetic messages to production user threads.

## Adversarial Matrix

| Scenario | Expected assertion |
|---|---|
| crash after source seal, before provider dispatch | source trial is visible with missing target |
| provider dispatch, no `session_init` | no fake target or delivery pass |
| retry emits two `session_init` events | one target, original origin/receipt preserved |
| two targets claim one source | lineage=`duplicate`, structural fail |
| target points across thread/cat/user | structural fail, excluded from semantic pass rate |
| F225 note exists but threshold stole seal | no proposalId/handoff-note delivery claim |
| F225 approved handoff | proposalId matches note and handoff note receipt is true |
| legacy `seq+1` candidate | diagnostic inference only, never audit-grade pass |
| assessment references another trial/event | publish rejects 400 |
| clean fixture | recovered + aligned + continued/completed |
| stale fixture | stale or corrected-before-action, never false recovered |

## Task 1: Immutable Session Transition Lineage

**Files:**
- Modify: `packages/shared/src/types/session.ts`
- Modify: `packages/api/src/domains/cats/services/stores/ports/SessionChainStore.ts`
- Modify: `packages/api/src/domains/cats/services/stores/redis/RedisSessionChainStore.ts`
- Test: `packages/api/test/session-chain-store.test.js`
- Test: `packages/api/test/redis-session-chain-store.test.js`

1. Write failing tests for creation-time lineage/receipt persistence and immutability on later updates.
2. Run the two tests; expect missing fields / create-input contract failure.
3. Add shared types and creation-only fields; extend in-memory and Redis create/hydrate paths.
4. Add bounded `scanAll()` read port to both stores without a new index/store.
5. Run tests green and commit `feat(F192): persist session transition lineage` with Why + thread provenance.

## Task 2: Bootstrap-to-Provider Delivery Receipt

**Files:**
- Modify: `packages/api/src/domains/cats/services/session/SessionBootstrap.ts`
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-serial.ts`
- Modify: `packages/api/src/domains/cats/services/agents/routing/route-parallel.ts`
- Modify: `packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts`
- Test: `packages/api/test/session-bootstrap.test.js`
- Test: `packages/api/test/session-bootstrap-handoff-note.test.js`
- Test: `packages/api/test/route-serial-parent-invocation-id.test.js`
- Test: `packages/api/test/route-parallel-parent-invocation-id.test.js`

1. Write failing bootstrap metadata tests for automatic and F225 transitions, including stale-note isolation.
2. Write failing route plumbing tests proving metadata exists only when no active target exists.
3. Write failing invocation test proving first `session_init` creates target with receipt and retry cannot overwrite it.
4. Implement `BootstrapRecoveryMetadata`, stable hash, serial/parallel plumbing, and provider-dispatch stamping.
5. Run focused tests green and commit `feat(F192): bind recovery delivery to target session`.

## Task 3: Pure Session Recovery Trial Provider

**Files:**
- Create: `packages/api/src/infrastructure/harness-eval/session-recovery/session-recovery-types.ts`
- Create: `packages/api/src/infrastructure/harness-eval/session-recovery/session-recovery-trial-provider.ts`
- Create: `packages/api/src/infrastructure/harness-eval/session-recovery/session-recovery-grader.ts`
- Create: `packages/api/src/infrastructure/harness-eval/session-recovery/index.ts`
- Test: `packages/api/test/harness-eval/session-recovery-trial-provider.test.js`
- Test: `packages/api/test/harness-eval/session-recovery-grader.test.js`

1. Write clean, stale, missing-target, duplicate-target, cross-identity, and legacy fixtures as in-process objects.
2. Run tests; expect module-not-found red.
3. Implement selector validation, window/owner filters, pure source→target projection, paginated first-event lookup, and deterministic structural grader.
4. Keep semantic fields `unknown` until an explicit assessment is supplied; do not add keyword judging.
5. Run tests green and commit `feat(F192): project session recovery trials`.

## Task 4: Eval-Cat Preview and Assessment Contract

**Files:**
- Create: `packages/api/src/routes/session-recovery-eval.ts`
- Create: `packages/mcp-server/src/tools/session-recovery-eval-tools.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Modify: `packages/api/src/routes/index.ts`
- Modify: `packages/api/src/index.ts`
- Test: `packages/api/test/harness-eval/session-recovery-route.test.js`
- Test: `packages/mcp-server/test/session-recovery-eval-tools.test.ts`

1. Run Convention Graph for the new MCP tool and record fresh source-map output in the review packet.
2. Write failing API/MCP tests for owner scope, window limits, bounded anchor preview, unknown trial IDs, and callback auth.
3. Implement `cat_cafe_preview_session_recovery_trials` with anchor-first summaries and drill refs; no transcript bodies in default output.
4. Make assessments a publish input, not a mutation endpoint.
5. Run tests green and commit `feat(F192): expose recovery trial preview`.

## Task 5: Publish Selector, Generator, and Bundle

**Files:**
- Create: `packages/api/src/infrastructure/harness-eval/session-recovery/eval-session-recovery-live-verdict.ts`
- Create: `packages/api/src/infrastructure/harness-eval/publish-verdict/session-recovery-generator-adapter.ts`
- Modify: `packages/api/src/infrastructure/harness-eval/publish-verdict/types.ts`
- Modify: `packages/api/src/infrastructure/harness-eval/publish-verdict/validation.ts`
- Modify: `packages/api/src/infrastructure/harness-eval/publish-verdict/publish-verdict.ts`
- Modify: `packages/api/src/routes/eval-hub.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/mcp-server/src/tools/publish-verdict-tool.ts`
- Test: `packages/api/test/harness-eval/session-recovery-generator-adapter.test.js`
- Test: `packages/api/test/harness-eval/publish-verdict-session-recovery.test.js`
- Test: `packages/mcp-server/test/publish-verdict-tool-schema.test.js`

1. Write failing schema/adapter/generator tests for forged assessments, evidence refs, duplicate trials, wrong domain/kind, and sanitized bundle round-trip.
2. Implement `session-recovery-window` sourceRefs, cross-validation against provider-resolved trials, and live verdict artifacts.
3. Ensure provenance records hashes/refs/config versions and does not copy transcript text.
4. Run focused tests green and commit `feat(F192): publish session recovery verdicts`.

## Task 6: Domain Registry and Runtime Wire

**Files:**
- Create: `docs/harness-feedback/eval-domains/eval-session-recovery.yaml`
- Modify: `packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `docs/architecture/ownership/cells/harness-eval.md`
- Modify: `docs/architecture/ownership/cells/identity-session.md`
- Modify: `docs/architecture/ownership/README.md`
- Test: `packages/api/test/harness-eval/eval-domain-registry.test.js`
- Test: `packages/api/test/harness-eval/eval-cat-invocation-publish-verdict.test.js`
- Test: `packages/api/test/harness-eval/eval-domain-daily-prereq-gate.test.js`

1. Register the domain disabled and write tests showing scheduled invocation stays honest-unwired.
2. Add domain instructions that require preview → semantic assessment → publish, with separate `capability-wakeup` boundary text.
3. Wire provider/generator/MCP support, then flip `enabled: true` and wired-domain tests together.
4. Update the two ownership cells and generated README map.
5. Run tests green and commit `feat(F192): activate session recovery eval domain`.

## Task 7: Quality Gate and Acceptance Evidence

**Files:**
- Modify: `docs/features/F192-socio-technical-harness-eval.md`
- Create: `docs/harness-feedback/fixtures/session-recovery/clean.json`
- Create: `docs/harness-feedback/fixtures/session-recovery/stale.json`
- Create: `docs/harness-feedback/fixtures/session-recovery/missing-target.json`

1. Run focused API + MCP suites, shared build, `pnpm check`, `pnpm lint`, `pnpm check:dir-size`, and `pnpm check:deps`.
2. Run clean/stale/missing-target fixtures entirely in the feature checkout/test process; assert no Redis 6399 connection and no production thread writes.
3. Load the generated verdict bundle through `loadEvalHubSummary()`.
4. Update AC-I evidence and wire status in F192.
5. Run fresh-context scan, request cross-individual review, fix P1/P2 findings red→green, then enter normal merge-gate.

## Technical Open Questions Resolved During Implementation

- Exact maximum window/limit values are reversible implementation details; default to 7 days and 200 trials, validate fail-closed, adjust from test/perf evidence.
- `firstMeaningfulAction` excludes `session_init`, status/liveness/system-info, empty text, and tool plumbing; the provider returns the first durable evidence ref, while the eval cat decides semantic alignment.
- Legacy sessions remain visible as `legacy_unlinked`; no migration fabricates lineage. A one-time read-only baseline may report how much history is ungradable.
- The preview tool is intentionally bounded/anchor-first because scheduled eval cats otherwise cannot inspect provider-resolved trials before publishing; sourceRefs replay alone is insufficient cognition-path wiring.
