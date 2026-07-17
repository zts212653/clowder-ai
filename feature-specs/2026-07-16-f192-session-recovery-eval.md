# F192 Session Recovery Eval — Contracted Implementation Plan

**Feature:** F192 — `docs/features/F192-socio-technical-harness-eval.md` Phase I
**Goal:** Evaluate whether an observed fresh Session actually reconstructs state, takes the right first meaningful action, and continues or completes the work.
**Architecture cells:** `identity-session` supplies minimal canonical provenance; `harness-eval` derives read-only semantic trials.
**Frontend verification:** No new UI; existing Eval Hub verdict/bundle surfaces are reused.

## Decision Record — 2026-07-17

The first implementation tried to make the live eval prove the transition machinery itself. It introduced source-side `SessionContinuationAttempt`, provider-delivery receipts, bootstrap hashes, missing/duplicate-target projections, and two structural labels (`transitionIntegrity`, `delivery`).

That is the wrong boundary. Starting a fresh continuation and assembling its bootstrap are deterministic runtime behavior. A receipt written by the same code only proves that the code claims it ran; it does not prove that the model recovered. Paying a permanent runtime and indexing cost for that self-attestation does not improve the semantic verdict.

Final decision:

- Do not persist `SessionContinuationAttempt` or mutate the source Session for eval bookkeeping.
- Do not persist bootstrap hashes, prompt-delivery receipts, seal classifications, proposal IDs, or provider dispatch timestamps.
- Do not schedule `transitionIntegrity` or `delivery` as live eval dimensions.
- Keep only the target Session's canonical identity facts:
  - `openedByInvocationId`
  - `continuedFromSessionId`
- Define `continuedFromSessionId` narrowly: it marks only a cross-invocation continuation selected by `SessionBootstrap`. Same-invocation self-heal and provider/runtime replacement Sessions retain `openedByInvocationId` but do not enter the F192 population.
- Test bootstrap delivery, seal→target linkage, retry/rotation behavior, and immutability deterministically in runtime contract/integration tests.
- Build live trials only for observed targets carrying an explicit backlink. Missing targets are intentionally unobservable by this eval.

This is a deliberate observability trade: weekly eval will not report “continuation attempted but no target appeared.” Timeout/error telemetry and runtime tests own that failure mode.

## Finish Line

`eval:session-recovery` is complete when a scheduled eval cat can:

1. preview an owner-scoped bounded window of observed continuation targets;
2. use a callback-authenticated, trial-anchored evidence reader to inspect another cat's source and opening invocation without weakening generic per-cat transcript access;
3. submit evidence-grounded assessments for the three semantic dimensions;
4. publish a sanitized `VerdictHandoffPacket` that round-trips through Eval Hub.

The implementation must not create a second lifecycle store, copy transcript bodies, infer a backlink from sequence, or write synthetic data to real user threads.

## Terminal Runtime Schema

```ts
interface SessionRecord {
  /** Invocation whose first session_init created this Session. */
  readonly openedByInvocationId?: string;
  /** Explicit causal predecessor when this Session continues earlier work. */
  readonly continuedFromSessionId?: string;
}
```

Both fields are creation-time only. Generic Session updates cannot overwrite them.

## Terminal Eval Schema

```ts
interface SessionRecoverySourceSelector {
  kind: 'session-recovery-window';
  /** Half-open target Session creation window. */
  windowStartMs: number;
  windowEndMs: number;
  catId?: string;
  threadId?: string;
  limit?: number;
  assessments?: SessionRecoveryAssessment[];
}

interface SessionRecoveryTrial {
  trialId: `session-recovery:${string}`; // target Session id
  source: SessionEvidenceRef;
  target: SessionEvidenceRef;
  firstInvocationId?: string;
  terminalEventRef?: string;
  transcriptEvidenceStatus: 'available' | 'missing_invocation' | 'not_found' | 'read_failed';
  evidenceRefs: string[];
  assessment?: SessionRecoveryAssessment;
}

interface SessionRecoveryAssessment {
  trialId: string;
  stateReconstruction: 'recovered' | 'stale' | 'unknown';
  firstMeaningfulAction: 'aligned' | 'repeated' | 'misaligned' | 'unknown';
  /** Eval-cat-selected target opening-invocation event; required unless firstMeaningfulAction is unknown. */
  firstMeaningfulEventRef?: string;
  outcome: 'continued' | 'completed' | 'failed' | 'unknown';
  evidenceRefs: string[];
  rationale: string;
}
```

There is no optional target and no missing/duplicate/legacy trial shape. Trial identity is target-centric.

## Canonical Chain

```text
sealed/sealing source Session
  → SessionBootstrap carries source Session id while no active target exists
  → first session_init atomically creates target with openedByInvocationId + continuedFromSessionId
  → owner-scoped continuation-target index finds observed targets
  → provider validates source/backlink identity and reads target opening invocation anchors
  → registry/override evaluator authorization gates the eval evidence reader
  → reader re-resolves selector + trialId inside the callback principal's owner scope
  → eval cat assesses stateReconstruction + firstMeaningfulAction + outcome
  → publish-verdict writes sanitized metadata/refs
```

## Stateful Object Census

| Object | Lifecycle owner | Rule |
|---|---|---|
| `SessionRecord` | `SessionChainStore` | Existing lifecycle. Two immutable creation fields extend the target identity record. |
| owner continuation-target index | `RedisSessionChainStore` | Derived lookup index written atomically only when a target has a backlink; not a second truth store. |
| `SessionRecoveryTrial` | pure provider | Recomputed for every selector; never persisted independently. |
| `SessionRecoveryAssessment` | eval cat + publish validator | Submitted with the selector and stored only inside the normal sanitized verdict bundle. |
| verdict/bundle | existing publish pipeline | Existing immutable verdict lifecycle; no new Session lifecycle semantics. |

## Runtime State × Event Contract

| State | Event | Required result |
|---|---|---|
| sealed/sealing source, no active target | first `session_init` | atomically create target with opening invocation and source backlink |
| active target | later invocation or repeated same-session init | retain original creation fields unchanged |
| active target | same-invocation runtime replacement emits a new session id | seal old target and create replacement with opening invocation only; no F192 backlink |
| stale resume | same-invocation fresh retry is accepted | seal source; if retry emits `session_init`, create target with opening invocation only; no F192 backlink |
| provider fails before `session_init` | no target exists | write no fake target and create no live eval trial |
| `reborn` / ordinary first Session | `session_init` | create Session without continuation backlink |

## Invariants

- **INV-SR1:** A target names at most one source; `openedByInvocationId` and `continuedFromSessionId` are immutable after creation.
- **INV-SR2:** An eval-eligible source is `sealing` or `sealed` and has the same `(userId, catId, threadId)` as the target.
- **INV-SR3:** An eval-eligible target has `target.seq === source.seq + 1` and was not created before its source.
- **INV-SR4:** Owner scope is derived from authenticated runtime context, not caller-supplied spoofable data.
- **INV-SR5:** Target enumeration is bounded by a validated half-open creation window and result limit.
- **INV-SR6:** Filtered Redis scans paginate until the result limit or index exhaustion; if 1,000 candidates are insufficient while more remain, preview fails with `window_too_broad` instead of returning an incomplete population.
- **INV-SR7:** Unknown targets, foreign/forged evidence refs, duplicate assessments, and semantic claims without transcript anchors fail closed.
- **INV-SR8:** The eval cat—not an event-type heuristic—selects `firstMeaningfulEventRef`; a known first-action label requires a selected target opening-invocation anchor included in `evidenceRefs`.
- **INV-SR9:** Semantic fields remain `unknown` until an eval cat submits an explicit assessment; missing or conflicting evidence makes only the affected field unknown.
- **INV-SR10:** Verdict artifacts contain bounded metadata and durable refs, never transcript or rationale plaintext.
- **INV-SR11:** No `seq + 1` inference is written back or admitted as a trial.
- **INV-SR12:** Tests and acceptance use isolated stores/fixtures and never write synthetic messages into production user threads.
- **INV-SR13:** Cross-cat drill-down is available only through the F192 reader. It accepts a selector, trial anchor, and fixed evidence kind; source/target Session IDs and the opening invocation are resolved server-side. Generic transcript routes retain their per-cat 403 boundary.
- **INV-SR14:** Missing transcript anchors and target transcript refs are correctable assessment errors (`400 invalid_assessment`), not harness-internal 500s.
- **INV-SR15:** The F192 reader admits only the domain evaluator selected by the static registry or active OQ-20 override; non-evaluator invocation/agent-key principals fail with 403 before trial resolution.
- **INV-SR16:** Target opening-invocation reads and publish validation use one shared 100-event selector, so every exposed opening-event ref is publishable and later refs remain unavailable.

## Evaluation Dimensions

Only these three dimensions belong to live evaluation:

1. `stateReconstruction`: Did the fresh Session understand the live worktree, branch, task state, completed work, and remaining work?
2. `firstMeaningfulAction`: Was the eval-cat-selected first substantive action or conclusion aligned with live truth, or did it repeat, re-ask, or act on stale state? Status narration is not automatically substantive.
3. `outcome`: Did the opening invocation continue/complete the work, or fail/run off course?

The final semantic grade is:

- pass only for `recovered + aligned + (continued | completed)`;
- fail for stale state, repeated/misaligned first action, or failed outcome;
- unknown otherwise.

## Test Ownership Boundary

Deterministic runtime tests own:

- fresh bootstrap source selection and active-target suppression;
- serial and parallel source-id plumbing;
- atomic field persistence and immutability in memory and Redis;
- stale-resume source seal while the same-invocation retry target remains outside the F192 backlink population;
- same-invocation self-heal/replacement Sessions not receiving a continuation backlink;
- `reborn` and ordinary first Session not receiving a backlink.

Scheduled live eval owns only model-level recovery semantics. It must not restate deterministic code behavior as an LLM judgment.

## Adversarial Matrix

| Scenario | Expected assertion |
|---|---|
| target backlink points to missing source | provider fails closed |
| source is active or identity tuple differs | provider fails closed |
| target sequence is not source + 1 | provider fails closed |
| target transcript cannot be read | trial remains previewable but semantic claim is rejected |
| assessment references another trial/event | publish rejects input |
| status text precedes a substantive tool action | eval cat selects the tool event; provider does not preselect the status text |
| >1,000 filtered owner candidates | preview reports `window_too_broad`; it does not return an incomplete zero/sample |
| clean fixture | recovered + aligned + continued/completed → semantic pass |
| stale fixture | stale/repeated/misaligned/failed → semantic fail |
| source with no observed target | no trial is fabricated |

## Implementation Slices

### 1. Minimal target provenance

- Shared Session type and in-memory/Redis store accept creation-only `openedByInvocationId` and `continuedFromSessionId`.
- Redis atomically adds linked targets to an owner-scoped sorted set scored by target creation time.
- `SessionBootstrap` returns only `continuedFromSessionId` for a fresh continuation.
- Serial/parallel routing passes the id to `invokeSingleCat()`.
- `invokeSingleCat()` always stamps the opening invocation on create, and stamps the source backlink only on the first target created from route-supplied `SessionBootstrap` provenance.
- Same-invocation self-heal and runtime replacement create ordinary Sessions without an F192 backlink.

### 2. Target-centric trial provider

- Selector window applies to target creation time.
- Provider scans explicit target backlinks, resolves their source, validates deterministic eligibility, and reads only opening-invocation anchors.
- No missing-target, duplicate-target, legacy inference, transition receipt, or structural grade is produced.

### 3. Semantic assessment and verdict

- Preview remains anchor-first and returns no transcript bodies.
- `cat_cafe_read_session_recovery_evidence` provides only `source_digest`, `source_events`, and `target_opening_invocation`. It first verifies the registry/override evaluator identity, then re-resolves the target within the authenticated owner/window/filter scope and never accepts arbitrary `sessionId` or `invocationId` input. Source transcript events are read-only context and advertise only the canonical source Session as submit-ready evidence; opening events are bounded by the same selector used to build the publish allowlist.
- Assessments must resolve to selected trial/evidence refs and include target transcript evidence for semantic claims. The eval cat selects `firstMeaningfulEventRef`; the provider only validates that it belongs to the target opening invocation.
- Domain instructions define live-truth priority, source/target drill-down, positive/negative cases, and independent per-field `unknown` rules.
- Grader produces one semantic pass/fail/unknown rollup from the three labels.
- Live verdict sanitizer emits metadata/hash/ref provenance only.

### 4. Fixtures and acceptance

- Keep `clean.json` and `stale.json` only, with frozen source outstanding intent, target current-state check (or its absence), selected first substantive action, and terminal evidence.
- Delete `missing-target.json`; absence is not an observable trial in the contracted design.
- Run focused API, MCP, registry, generator, route, Session store, bootstrap, and invocation tests in the feature checkout.
- Include a cross-cat preview → trial-anchored drill-down → publish acceptance proving the eval principal can assess another cat without opening generic transcript access.
- Run shared/API/MCP builds and repository quality gates proportionate to touched surfaces.

## Explicit Non-Goals

- No `SessionContinuationAttempt`, attempt commit API, source-side attempt index, or source mutation for eval.
- No `SessionRecoveryDeliveryReceipt`, bootstrap hash, provider dispatch timestamp, prompt inclusion flag, or handoff-note delivery flag.
- No scheduled `transitionIntegrity` or `delivery` label.
- No missing/duplicate-target live trial or special index.
- No parallel recovery store, transcript copy, LLM sidecar judge, regex semantic classifier, or synthetic production thread.
- No legacy backfill. Historical Sessions without target backlinks are outside this eval's observable population.

## Success and Sunset

Activation is the count of observed linked targets and semantically assessable trials in the selected window. Friction is stale reconstruction, repeated/misaligned first action, failed outcome, or unavailable opening transcript evidence. Low target volume alone is not a regression.

Sunset remains evidence-driven: the domain may be merged into a broader task-outcome eval only when that eval preserves all three semantic dimensions and source/target/invocation evidence anchors. Deterministic runtime contract tests remain even if the scheduled domain is sunset.
