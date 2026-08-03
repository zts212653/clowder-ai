---
cell_id: human-disposition-feedback
title: Human Disposition Feedback
summary: F281-owned structured human why, Approval Hub capture adapters, content-free durable receipt index, authenticated episode hydration, and exact-subject direct-owner reflow.
description: Strict human-disposition feedback contract for server identity, atomic producer binding, durable episodes, and bounded exact-subject context.
description_source: model
description_author: codex-terra
description_generated_by: codex-terra@gpt-5.6-terra
description_generated_at: "2026-07-30T05:20:00-07:00"
description_confirmed_by: codex-sol
description_updated_at: "2026-07-30T14:50:00-07:00"
doc_kind: architecture
created: 2026-07-30
canonical_features: [F281]
code_anchors:
  - packages/shared/src/types/human-disposition-feedback.ts
  - packages/shared/src/approval-producer-catalog.ts
  - packages/shared/src/types/index.ts
  - packages/shared/src/__tests__/human-disposition-feedback.test.ts
  - packages/shared/vitest.config.js
  - packages/web/src/components/HumanDispositionFeedbackDialog.tsx
  - packages/web/src/components/MobileApprovalSheet.tsx
  - packages/web/src/components/ApprovalItemCard.tsx
  - packages/web/src/components/ChatContainer.tsx
  - packages/web/src/stores/approvalHubStore.ts
  - packages/api/src/routes/session-handoff-approve-routes.ts
  - packages/api/src/domains/cats/services/stores/redis/RedisSessionHandoffProposalStore.ts
  - packages/api/src/routes/person-memory-decision-routes.ts
  - packages/api/src/domains/memory/people/RedisPersonMemoryStore.ts
  - packages/api/src/domains/human-disposition/HumanDispositionLedger.ts
  - packages/api/src/domains/human-disposition/human-disposition-adapters.ts
  - packages/api/src/domains/human-disposition/HumanDispositionFeedbackContextService.ts
  - packages/api/src/domains/memory/people/PersonMemoryDispositionProofResolver.ts
  - packages/api/src/domains/memory/people/PersonMemoryDispositionSubjectProofResolver.ts
  - packages/api/src/domains/memory/people/person-memory-proposal-disposition-reject-lua.ts
  - packages/api/src/domains/memory/people/person-memory-proposal-disposition-reject-support.ts
  - packages/api/src/domains/memory/people/person-memory-proposal-forget.ts
  - packages/api/src/routes/human-disposition-feedback-routes.ts
  - packages/api/src/domains/cats/services/agents/routing/human-disposition-invocation-origin.ts
  - packages/api/src/domains/cats/services/agents/routing/route-serial.ts
  - packages/api/src/domains/cats/services/agents/routing/route-parallel.ts
  - packages/api/test/human-disposition-ledger.test.js
  - packages/api/test/human-disposition-feedback-context.test.js
  - packages/api/test/human-disposition-feedback-routing.test.js
doc_anchors:
  - docs/features/F281-feedback-channel-first-class.md
  - feature-specs/2026-07-30-f281-phase-a-feedback-contract.md
  - feature-specs/2026-07-30-f281-phase-b-feedback-capture.md
  - feature-specs/2026-07-30-f281-phase-c-episode-ledger-bounded-reflow.md
  - feature-discussions/2026-07-30-f281-feedback-surface-census.md
  - project-evidence/F281/phase-b/README.md
  - project-evidence/F281/phase-c/README.md
static_scan_hints: [HumanDispositionFeedbackInput, HumanDispositionDecisionEpisode, HumanDispositionEnvelope, HumanDispositionLedgerReceipt, HumanDispositionEligibilityContext, HumanDispositionLedger, HumanDispositionFeedbackContextService, HumanDispositionInvocationOrigin, buildHumanDispositionEnvelope, isHumanDispositionEnvelopeEligible, validateHumanDispositionFeedbackForProducer, HUMAN_DISPOSITION_REASON_CODES]
cited_by:
  - {feature: F281, date: 2026-07-30, delta: "Phase A introduces the shared strict contract and a verified interaction-surface census; producer routes and durable ledger remain unchanged"}
  - {feature: F281, date: 2026-07-30, delta: "Phase B adds optional structured feedback capture for F225 and F276 while their canonical producer stores remain the decision owners"}
  - {feature: F281, date: 2026-07-30, delta: "Phase C adds producer-atomic content-free receipts, authenticated producer hydration, exact-subject direct-owner context, and person-bound F276 hard-forget closure; unbound F276 remains excluded"}
  - {feature: F281, date: 2026-07-30, delta: "Phase C closure adds pure-unbound F276 proposal-scoped disposition truth plus owner-authenticated exact-proposal purge; mixed/person-bound lineages remain in their canonical person lifecycle"}
  - {feature: F280-Phase-B0, date: 2026-07-31, delta: "wait cancellation why is built only from the canonical F280 user_cancel event plus optional strict feedback; F280 owns termination, while F281 owns the wait_cancel episode/envelope and content-free ledger projection"}
---

# Human Disposition Feedback

Architecture cell: human-disposition-feedback

## Canonical Owner

F281 owns the meaning and boundary of a human's structured **why** after a cat-originated candidate is rejected, cancelled, deferred, or withdrawn. It owns the six-code taxonomy, strict public feedback input, server-bound binding/envelope shape, decision-episode model, source replay classification, and the pure exact-subject eligibility predicate.

Phase B adds one shared Approval Hub dialog plus producer-aware admission and atomically attaches optional feedback to F225/F276 canonical reject state. Those producer stores continue to own the decision transition.

Phase C adds TTL=0 owner-scoped receipt/index truth and an authenticated query, but keeps complete disposition entries physically producer-owned. F281 receipts contain only random opaque references, timestamps, interaction kind, and exact subject handles; query hydration must revalidate the canonical producer entry and every exact index. A dedicated direct-owner invocation segment consumes only verified current exact-subject feedback. Queue replay, A2A, callback, connector, system, and unknown origins fail closed.

## Adjacent Ownership Boundaries

- **F246 Approval Index** owns approval-card projection, producer catalog, and each feature's approve/reject action. F281 cannot decide or mutate a proposal's business status; an adapter may only bind a reason after that feature's canonical decision commits.
- **F280 Unified Wait Contract** owns hold_ball/wait termination state and canonical user-cancel event.
  F281 owns the explanatory `wait_cancel` episode/envelope adapter built from that event, never the
  cancellation state machine or its legacy route.
- **F272 Proactive Relationship Loop** owns visits, seeds, echoes, and the lifecycle effect of its existing `not_now` / `wrong` echo. F281 reuses those two code names and does not create a parallel echo taxonomy.
- **F192 permission/task outcome** owns authorization and task-execution episodes. Its structured permission cancel remains a positive input/episode precedent, not a general proposal-feedback consumer.
- **F276 and each memory producer** own candidate, materialization, not-now, reject, withdraw, lineage binding, opaque lineage-handle uniqueness, locators, and hard-forget reachability. F281 owns only the attached human disposition feedback; it cannot withdraw a candidate or infer a producer decision. Person-bound F276 feedback joins the producer's existing hard-forget closure. Pure-unbound terminal lineages use F276-owned proposal-scoped bindings and an owner-authenticated exact-`proposalId` purge; mixed lineages remain excluded from Phase C.

## Contract Flow

```text
optional public { reasonCode, detail? }
  -> strict parse (identity/subject/decision/source fields rejected)
  -> producer capability validates the reason for this lane
  -> producer atomically commits its own canonical decision + optional feedback snapshot
  -> Phase C adapter builds server binding from authenticated principal + canonical decision
  -> no feedback: decision episode only; no envelope
  -> feedback: server-bound envelope with required feedback and sourceRef
  -> producer transition atomically writes content-free F281 receipt/index truth
  -> authenticated query rehydrates the complete entry from canonical producer state
  -> direct-owner invocation resolves current subject + lineage + invalidator proof
  -> exact-subject + verified root + current proof => dedicated prompt-segment injection
```

`classifyHumanDispositionSourceReplay()` supplies the Phase A pure comparison needed by a later append-only ledger: same `sourceRef` plus equal parsed payload is a replay; a changed payload is a conflict; a different source is distinct. It never overwrites history itself.

## Phase B Capture Adapters

- Web owns presentation only: `HumanDispositionFeedbackDialog` exposes the global taxonomy filtered by the producer catalog, keeps feedback optional, and returns the public input without identity fields.
- F225 Session Handoff and F276 Person Memory routes authenticate the owner, strict-parse the public body, validate the producer capability, and delegate the decision to their canonical stores.
- F225 Redis CAS and F276's dedicated snapshot-checked Lua path attach feedback in the same atomic transition as rejection. Replays return success only for the exact decision plus exact feedback; changed payloads conflict.
- F276 rejection preserves the F282 subject-suppression registry, `personArtifacts`, and hard-forget fence semantics. F281 does not take ownership of candidate discovery, materialization, or forget cleanup.
- F280 Phase B0 supplies the canonical runtime `user_cancel` event and a separate owner-authenticated
  route. `buildWaitCancellationDispositionLedgerEntry` binds optional strict feedback to server-owned
  event identity; the event remains feedback-free. F280 atomically stores the producer entry plus
  content-free F281 receipt/index, and the old hold route remains unchanged.

## Phase C Durable Query and Bounded Reflow

- F225, person-bound F276, and pure-unbound terminal F276 reject paths write their canonical full entry plus content-free F281
  receipt/owner/subject indexes in one two-pass-preflighted Redis transition. Every existing and new
  key type, JSON/plan operation, key index, and score is validated before the first mutation.
- `HumanDispositionLedger` provides owner-authenticated exact get/list/query. Its compound cursor
  binds `decidedAt + sourceRef + filters`, and every result is hydrated through a producer adapter
  before it becomes API or context truth.
- F276 keeps opaque lineage binding, one-to-one lineage-handle locator, decision locator, and full
  entry outside F281 persistence. Replacement reuses one handle only inside one mechanically
  enumerable person closure; hydration compares the current chain, both locators, binding, and
  receipt rather than trusting handle equality.
- Person hard forget preflights and removes the person-bound candidate closure, F276
  mappings/locators/full entry, and exact F281 receipt/index members atomically. Pure-unbound
  terminal lineages have an equivalent owner-authenticated exact-proposal purge with equalized
  missing/foreign-owner results and a content-free receipt. Mixed lineages and person-bound
  proposals fail closed on the proposal surface; a malformed proof causes no partial purge.
- `HumanDispositionFeedbackContextService` extracts bounded lexical candidates, resolves exact
  current subject proof, selects at most one current correction per lineage, and emits at most
  three enum-only corrections. Only the independent `direct_owner` invocation origin may call it;
  all other ingress origins and legacy unknown callers make zero consumer calls.

## Durable Invariants

1. Public feedback only accepts `reasonCode` and, for `other`, a nonblank 1..500-character `detail`. It rejects owner, cat, subject, decision, and source fields rather than trusting callback payload identity.
2. A feedbackless decision is valid but creates no `HumanDispositionEnvelope`; an envelope always has feedback. `other` may be retained for human review but never auto-injects.
3. Automatic eligibility first requires exact `subjectRef`. Proposal lineage is only an additional predicate: it must have a verified root equal to the envelope root. Lane, interaction kind, cat, and a matching root alone cannot widen scope.
4. Eligibility is a pure projection of an explicit finite `now` and typed invalidator truth. Unknown, kind/key mismatch, revision mismatch, superseded source, and expiry fail closed; no selector reads a store or wall clock.
5. Producer decision state, wait termination, proactive visit lifecycle, and permission outcome remain with their current canonical owners. This cell may reference those truths but never duplicates their stores or CAS.
6. Supported envelope/episode receipt/index history is TTL=0. Expiry and invalidation suppress injection only; they do not delete the decision or feedback record. Producer-owned hard forget is the explicit deletion boundary.
7. The contract contains no acceptance rate, cat score, lane score, or automatic cross-subject policy field.
8. Pre-Phase-C terminal decisions are not silently backfilled or accepted as ordinary replay. Legacy missing-ledger truth remains explicit until a producer-owned migration exists.

## Use This When

- Adding a structured why to a cat-originated proposal, hold cancellation, or comparable human disposition.
- Building a producer adapter from an authenticated principal plus a canonical decision to an F281 feedback envelope.
- Extending the durable ledger/query or exact-match consumer to another producer after its lifecycle and deletion closure are proven.
- Auditing a proposed feedback flow for spoofed identity, missing source idempotency, incorrect lineage expansion, or implicit TTL.

## Extend By

- Keep the six base reason codes global. A surface may hide inapplicable choices, but may not invent a synonym without a distinct correction direction and compatibility test.
- Add a producer adapter only after its own CAS commits, and construct `HumanDispositionServerBinding` from canonical state—not a request-body spread or cast.
- Extend the ledger only through a producer-owned atomic transition with `sourceRef` replay/conflict handling, TTL=0 history, content-free F281 receipts, and authenticated producer hydration.
- Pass consumer-side proof through `HumanDispositionEligibilityContext`; a resolver that cannot prove root/revision/supersession must return no candidate.

## Do NOT Unify With

- Do not turn F246 into a second feedback store or treat an Approval Hub reject button as evidence of a captured reason.
- Do not add reason handling to F280's old hold_ball API or claim wait termination ownership.
- Do not fold F272 echo lifecycle, F192 task outcomes, or F276/F282 candidate lifecycle into this envelope ledger.
- Do not convert `other` text, a single rejection, or an unverified lineage match into lane-wide or cat-wide behavioral policy.

## Static Scan Hints

Watch for `HumanDispositionFeedbackInput`, `HumanDispositionDecisionEpisode`, `HumanDispositionEnvelope`, `HumanDispositionEligibilityContext`, `buildHumanDispositionEnvelope`, `isHumanDispositionEnvelopeEligible`, `classifyHumanDispositionSourceReplay`, `validateHumanDispositionFeedbackForProducer`, and `HUMAN_DISPOSITION_REASON_CODES`. Any new route that parses owner/cat/subject/decision/source from public feedback, any selector that queries its own store or `Date.now()`, or any consumer that matches by lane/cat rather than exact subject requires an ownership review.
