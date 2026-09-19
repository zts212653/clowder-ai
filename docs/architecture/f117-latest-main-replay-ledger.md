---
title: "F117 latest-main replay migration ledger"
description: "Accounts for every latest-main source deletion, MCP surface change, and deleted test family when replaying F117 onto main 9ab0eaf28."
doc_kind: architecture
feature_ids: [F117, F167, F247, F254, F264]
topics: [message, queue, delivery, replay, migration, testing]
created: 2026-09-19
updated: 2026-09-19
status: review
architecture_cell: "dispatch + ball-custody + bubble-pipeline"
architecture_map_delta: "none — records the F117 cutover from legacy custody and receipt projections to existing canonical owners"
author: "Maine Coon/cat-eqdvbcxw@gpt-5.6-sol"
related_docs:
  - docs/features/F117-message-delivery-lifecycle.md
  - docs/decisions/043-queue-durable-single-ledger.md
  - docs/architecture/ownership/cells/dispatch.md
  - docs/architecture/ownership/cells/bubble-pipeline.md
source_pr: "zts212653/clowder-ai#1398"
replay_base: "9ab0eaf28"
reviewed_pre_replay_head: "be84940fe"
---

# F117 latest-main replay migration ledger

This ledger closes the continuity audit for replaying the reviewed F117 tree onto
`main=9ab0eaf28`. It distinguishes an intentional semantic cutover from a main regression. The
normative rule is **main first, then F117 delta**: a missing latest-main declaration is acceptable
only when its old owner is retired here and its replacement owner and regression evidence are
named.

The final base advance from `d8bf77403` to `9ab0eaf28` is the F202 terminal Plugin Manager
landing. Its 96-path delta is preserved in full. Only three paths overlap the F117 patch
(`packages/api/src/index.ts`, `packages/mcp-server/src/tools/index.ts`, and
`packages/shared/src/types/index.ts`); Git merged their additive composition/export changes without
conflict. The durable final-tree comparison
`git range-diff d8bf77403..5b7723dd9 9ab0eaf28..HEAD` reports the implementation commit as
patch-equivalent (`=`) and the documentation commit as intentionally changed (`!`): this ledger
updates its replay-base annotation and adds this F202 continuity paragraph. Focused post-replay
verification covers the API composition root, F202 Plugin Manager routes/composition, MCP
registration/governance, shared exports, and the F117 message/Queue lifecycle.

## 1. Deleted latest-main source files

All twelve files below are also absent from the reviewed pre-replay F117 tree `be84940fe`; none was
silently lost by the latest-main replay.

| Deleted latest-main source | Why it is retired | Canonical replacement and evidence |
|---|---|---|
| `A2ADispatchDispositionService.ts` | Ordinary A2A no longer closes a second Ball disposition after message delivery. | `source → Queue admission → response terminal`; `message-lifecycle-*`, `queue-processor.test.js`, and the F167 MCP cutover manifest. |
| `ManagedHoldDispositionService.ts` | A managed-hold wake is an urgent Queue source, not a hold-specific completion protocol. | `callback-hold-ball-*.test.js`, `managed-command-wake-carrier-adapter.test.js`, and the canonical response lifecycle. |
| `ManagedHoldSourceSelection.ts` | Wake source selection is fenced at registration and Queue admission instead of re-selected at terminal disposition. | Hold-ball route tests plus `QueueLedgerAdmission` / `QueueProcessor`. |
| `record-managed-hold-disposition.ts` | The retired terminal disposition writer would duplicate the response terminal. | Hold-ball registration tests and the F167 completion-tool cutover manifest. |
| `TurnCustodyAdoptionRegistry.ts` | Queue admission and action-successor responsibilities now keep their own typed owners; there is no generic turn-adoption side ledger. | QueueLedger claim/commit tests and action-successor recovery tests. |
| `TypedWaitCustodyGuard.ts` | Typed waits are admitted once through their registration identity rather than a parallel custody guard. | `typed-wait-registration.test.js` and `typed-wait-registration-redis.test.js`. |
| `RedisTypedWaitCustodyGuard.ts` | Redis parity moved with the same typed-registration cutover. | `typed-wait-registration-redis.test.js`. |
| `QueueCarrierSourceProjection.ts` | Queue rows identify one canonical source directly; a carrier-source projection is no longer a second identity. | `QueueLedgerEntry.sourceRecordId`, `queue-ledger*.test.js`, and `invocation-queue.test.js`. |
| `QueuedMessageCustodyCoordinator.ts` | Queue custody is owned by the durable QueueLedger instead of a second coordinator/store. | `QueueLedger`, `QueueProcessor`, `StartupReconciler`, and their Memory/Redis tests. |
| `QueuedMessageCustodyStartupQueueEntry.ts` | Startup reconstructs canonical QueueLedger entries and executions directly. | `queue-ledger*.test.js`, `queue-processor*.test.js`, and startup reconciler tests. |
| `queued-message-custody.ts` | The legacy custody port duplicated QueueLedger state. | `QueueLedgerStore` with in-memory and Redis parity tests. |
| `MessageReceiptDock.tsx` | The standalone receipt dock was a second user-visible delivery model. | Source-bubble dispatch avatars plus the canonical processing/terminal response; `message-dispatch-avatars.test.tsx` and `assistant-message-renderability.test.ts`. |

## 2. MCP surface ledger

The current source surface differs from latest main by exactly two names:

| Tool | Disposition | Reason / evidence |
|---|---|---|
| `cat_cafe_complete_a2a_dispatch` | retired | Ordinary A2A completion is the canonical response terminal. |
| `cat_cafe_complete_managed_hold` | retired | Managed-hold recovery is an urgent Queue source with the same response lifecycle. |
| `cat_cafe_get_hold_status` | retained | It remains registered in `callback-tools.ts` and in `mcp-surface-baseline.json`; the replay restored it. |

The exact retirement is governed by
`packages/mcp-server/governance/cutovers/f167-message-lifecycle-completion-sunset.json`; there is no
alias or dual-write fallback.

## 3. Tests added on latest main after the old F117 base

These ten main-new tests were deliberately superseded rather than accidentally omitted:

| Deleted main-new test | Replacement coverage |
|---|---|
| `a2a-dispatch-disposition-contention.test.js` | QueueLedger claim/commit contention and per-target QueueProcessor convergence. |
| `collective-queue-recovery.test.js` | `collective-ingress-dispatcher.test.js` and `collective-persistent-authority.test.js`. |
| `f247-first-message-admission.test.js` | `cloud-delivery-retry.test.js`, message-lifecycle ingress, and QueueProcessor admission tests. |
| `f247-first-message-recovery.test.js` | `cloud-delivery-retry.test.js`, QueueLedger recovery, and startup reconciliation. |
| `f247-queued-cloud-receipt-provenance.test.js` | Canonical source/response lifecycle plus cloud-delivery retry provenance. |
| `helpers/f247-first-message-harness.js` | Retired together with the three F247 scenario tests above. |
| `issue1371-direct-witness.test.js` | Queue source identity, response lifecycle, and persisted Queue integration tests. |
| `helpers/issue1371-direct-witness-harness.js` | Retired with the direct-witness test above. |
| `typed-wait-queue-authority.test.js` | `typed-wait-registration.test.js` plus QueueLedger authority tests. |
| `typed-wait-queue-redis.test.js` | `typed-wait-registration-redis.test.js` plus `queue-ledger-redis.test.js`. |

## 4. Complete deleted-test family ledger

The remaining deleted tests are exhaustively accounted for by the path sets below. A path set is a
semantic family, not a claim that one replacement test preserves the old implementation shape.

| Deleted test family (exact files or exhaustive globs) | Why the old assertions are invalid | Replacement suites |
|---|---|---|
| `a2a-*.test.js`; `callback-a2a-pingpong.test.js`; `coordination-terminal-dispatch-retirement.test.js`; `f167-a2a-replacement-queue-preflight.test.js`; `integration/a2a-chain.test.js`; `pingpong-reset.test.js`; `post-message-disposition-settlement.test.js`; `route-serial-a2a-tracker.test.js`; `route-serial-pingpong.test.js`; `routing-decision*.test.js`; `turn-custody-stop-gate-route.test.js`; `worklist-registry*.test.js`; `helpers/a2a-dispatch-disposition-harness.js` | These assert Ball disposition, ping-pong/streak, or Worklist completion after delivery. F117 makes source/Queue/response the only delivery lifecycle. | `message-lifecycle-*`, `queue-ledger*`, `invocation-queue.test.js`, `queue-processor*.test.js`, and lifecycle response-context tests. |
| `callback-complete-managed-hold-route.test.js`; `managed-command-wake-queue-adapter.test.js`; `managed-force-queue-autoexecute.test.js`; `managed-hold-*.test.js`; `typed-wait-queue-*.test.js`; `wait-continuation-retry-*.test.js` | Hold-specific completion/custody and retry-commit protocols are replaced by typed registration plus a normal urgent Queue wake. | `callback-hold-ball-*.test.js`, `managed-command-wake-carrier-adapter.test.js`, `typed-wait-registration*.test.js`, QueueLedger, and QueueProcessor tests. |
| `cursor-deferred-ack.test.js`; `f254-queue-*.test.js`; `f264-queue-*.test.js`; `queue-entry-settlement.test.js`; `queue-gate-thread-level.test.js`; `queue-liveness-incidents.test.js`; `queue-processor-delivered-at.test.js`; `queue-processor-pause-epoch.test.js`; `queue-steer-*.test.js`; `helpers/queued-message-custody.js` | Legacy Queue custody, receipt, pause, and settlement stores were competing owners. | `queue-ledger*.test.js`, `redis-queue-ledger-reader.test.js`, `invocation-queue.test.js`, `queue-integration*.test.js`, and `queue-processor*.test.js`. |
| `issue1371-*.test.js`; `helpers/issue1371-*.js` | Direct-witness and retirement harnesses encoded the old custody/receipt pipeline. | Canonical Queue source identity, message lifecycle, Queue integration, and lifecycle response-context tests. |
| `messages-decision-notification-route.test.js`; `messages-delivery-mode.test.js`; `messages-f108b-whisper-dispatch.test.js`; `messages-intent-mode.test.js`; `messages-parallel-slot-release.test.js`; `web-outbound-delivery.test.js`; `invocations-retry.test.js` | Message admission, target intent, and retry are now expressed by per-target author intent, Queue admission, and canonical execution lifecycle. | `message-lifecycle-ingress.test.js`, `message-lifecycle-queue-order.test.js`, disposition preference tests, QueueProcessor, and TurnExecution tests. |
| `ForceResetDialog.test.tsx`; `ThinkingIndicator-liveness.test.ts`; `thread-execution-bar-unverified-recovery.test.tsx`; `true-recall-action-button.test.tsx`; `parallel-status-bar-usage.test.ts` | Force-reset/unverified recovery and duplicate parallel status controls are retired; Stop and canonical execution projection are the only control/read model. | `useLiveExecutionCancelControl.test.tsx`, active-execution projection tests, and processing response presentation tests. |
| `chat-message-cross-thread-receipt.test.tsx`; `f264-turn-absorption-*.test.*`; `message-receipt-dock.test.tsx`; `queue-message-receipt-normalizer.test.ts`; `useSocket-queue-exact-live.test.tsx`; `chatStore-a2a-handoff-order.test.ts` | Standalone receipt/dock and socket-derived Queue receipt projections are retired. | `message-dispatch-avatars.test.tsx`, `appended-input-receipts.test.ts`, `assistant-message-renderability.test.ts`, and canonical lifecycle store tests. |
| `pending-member-*.test.*`; `queue-panel-processing.test.ts`; `useExecutionRecoveryVerification.test.tsx` | Pending targets remain Queue-only; processing is proven by response plus exact execution, not a pending-member bubble or client recovery heuristic. | `queue-panel-steer.test.ts`, message dispatch avatar tests, and active/turn execution tests. |

The path families above cover every test deleted by `origin/main..F117` at this replay. The unrelated
latest-main test `memory/f287-explicit-taste-consumption.test.js`, which the earlier replay had
accidentally dropped, is restored unchanged.

## 5. Mechanical continuity audit interpretation

The audit scripts intentionally compare exact added lines, so renamed/refactored canonical owners
remain as heuristic hits. The exact A1 differences (files untouched by the intervening main delta)
are accounted for below; none is an accidental replay edit.

| A1 residual | Attribution |
|---|---|
| `env-registry.ts` | Restores the legacy `CAT_CAFE_CODEX_CARRIER` compatibility input consumed by the canonical carrier resolver; new member configuration still uses `carrier`. |
| `CallerDispatchObservationIndex.ts` and `CallerDispatchObservationRegistry.ts` | Mechanical extraction of the bounded process-local index from the registry after the reviewed head exceeded the repository size gate; canonical observation behavior is unchanged and remains covered by caller-observation tests. |
| `memory/f287-explicit-taste-consumption.test.js` | Unrelated latest-main regression test that the earlier replay dropped; restored unchanged as continuity evidence. |
| `scheduled-trigger-owner-fence.test.js` | Updates the fixture for the strict trigger-store API and asserts that an ordinary reminder cannot claim private managed-hold provenance. |
| `typed-wait-registration-redis.test.js` | Redis parity coverage for the replacement typed-registration authority named in section 1. |
| `cancel-scope-guard.test.js` | Supplies the current QueueProcessor processing-slot reservation probe and includes the response body in the existing scope-guard assertion; the cancellation boundary is unchanged. |
| `multi-mention-b6-queue-dispatch.test.js` | Aligns the serial router fixture with one multi-target route execution and its single Queue parent invocation while retaining per-target lifecycle terminals. |
| Four `ChatInput` test files | Removes the retired one-shot disposition argument from fixtures; production `ChatInput` now sends only persistent preference plus per-entry Steer. |
| This ledger and the F117 link | New replay-review evidence requested by the continuity audit. |
| `F233-ball-custody-observability.md` | Keeps the tips exemption explicit after the F117 cutover; it changes no runtime contract. |

The A2 missing-declaration heuristic is fully partitioned as follows:

| Heuristic residual | Canonical disposition |
|---|---|
| `QueueCustodyLifecycleRecord`, `QueueAccumulator`, and its window helpers | Renamed/rebuilt as `FreshnessQueueLifecycleRecord` over the canonical replay provider; no custody store is restored. |
| `ManagedHold*`, `HoldSource`, `completeSource`, `recordManagedHoldDisposition`, `completeLatestInvocation` | Intentional F167 completion/disposition retirement; the hold wake enters QueueLedger and finishes through the canonical response lifecycle. |
| `TypedWaitCustodyGuard`, Redis guard helpers/Lua, and coordinator guard imports | Intentional typed-registration cutover; `TypedWaitRegistration` plus Task CAS and QueueLedger admission own authority. |
| `AdoptionCommit`, `AdoptionHandler`, `AdoptedManagedHold`, `TurnCustodyAdoptionReservation` | Intentional generic adoption-registry retirement; typed action-successor/managed-wake owners remain. |
| `QueueCustodyLifecycleRecord` in MessageStore/Redis | Intentional custody record retirement; QueueLedger is the only pending-work truth. |
| `parsePawFeelSourceOrigin`, `projectPawFeelSourcePresence`, `PersistedHostMessageExtra`, `projectPawFeelSourceStream`, `projectPawFeelSourceCrossPost` | Main capability retained under the composed `projectPawFeelSourceMessage`, `projectPawFeelSourceTiming`, `safeParsePawFeelSourceExtra`, and hydration helpers. |
| `TimelineOrderMessage`, `isQueuedUserTimelineMessage`, `isQueuedOwnerConnectorTimelineMessage` | Replaced by the single lifecycle-aware visibility predicates in `visibility.ts`; queued work is not a second timeline message type. |
| `PromptExposureAdoptionReservation`, `PromptMessagesSeenOptions` | Replaced by QueueLedger claim plus durable body-exposure/`queued_seen` evidence in QueueProcessor. |
| `readCompleteCarrier` | Replaced by claimed-target validation and per-target commit/restore against the durable Queue row. |
| `hasUnsettledQueueReceipt` | Intentional receipt-model retirement; Web reconciles canonical lifecycle plus active execution instead of socket-local receipt state. |
| `preflightRejectedCatIds` / `routing_preflight_rejected` collector state | Replaced by per-target Queue admission outcomes and durable target terminal state. Routing preflight rejection no longer needs a second in-process collector set: rejected targets are recorded on the canonical Queue/message lifecycle and excluded before provider launch. |

These groups account for every absent identifier printed by
`/tmp/fable-replay-audit2.mjs`; the twelve absent source owners themselves are enumerated in
section 1 rather than repeated here.

The final replay gate also runs two symmetric composition audits rather than relying on missing-line
counts alone:

- `/tmp/fable-replay-audit-new.mjs` reports main-added declarations absent from the candidate by
  file, so every high-residual composition root is reviewed against this ledger.
- `/tmp/fable-unwired.mjs` finds exported `register*` / `create*` owners that have a production
  caller on latest main but only their own definition in the candidate. The final candidate keeps
  the request-review owner callbacks, named-cat content callbacks, and Claude carrier factory
  reachable from their production composition roots; the callback registration regression injects
  both HTTP endpoints and proves they are registered behind callback authentication.

`packages/api/src/index.ts` has no remaining missing-main-line hit. Latest-main runtime registration,
provider-native freshness, bootstrap trace, MCP hold-status, and Paw Feel projections are all wired
in the replayed tree.

## 6. Main-new test cases removed inside retained files

A file-level deletion audit cannot see a test file that remains while individual latest-main cases
inside it disappear. `/tmp/fable-infile-tests.mjs` therefore compares declared `test` / `it` names
across `c0cf29f0a → d8bf77403 → F117`. It finds 42 main-new names across the 16 retained files
below. This table accounts for all 42; renamed cases preserve their assertion, while retired cases
name the canonical replacement owner and evidence.

| Retained test file (main-new names absent) | Disposition | Replacement evidence / explicit choice |
|---|---|---|
| `persisted-queue-delivery.test.ts` (14) | Retired with the process-local producer recovery owner, including pause epochs, force-reset suppression, partial-carrier restoration, cross-user live custody, and producer-return priority. | `queue-ledger*.test.js`, `invocation-queue.test.js`, `queue-message-admission.test.js`, and `queue-processor.test.js` cover atomic Message+Queue admission, exact source replay, target-scoped restore, busy-slot retry, withdrawal, and durable priority without a second `PersistedQueueDelivery` owner. |
| `f254-windowed-signal-report.test.js` (4) | Renamed in place after Queue/Supplement custody became History dispatch lifecycle. | The same file retains four corresponding cases: fail-closed structural maturity, retry-success terminal time, pre-window terminal isolation, and untimed History/Supplement overlap. |
| `managed-command-wake-recovery-sweep.test.js` (3) | Renamed in place around canonical urgent Queue ingress. | Its first three cases still assert strict provenance restoration, legacy `unknown` provenance, and rejection of compatibility-provenance promotion. |
| `issue1371-redis-convergence.test.js` (3) | Old adopted-receipt/direct-completion scenarios retired with message receipt custody and hold-specific completion. | The retained Redis suite proves bounded terminal recovery plus HTTP pre-start Queue recovery; `queue-ledger-redis.test.js`, `queue-processor.test.js`, and managed-command wake recovery cover exact child/source convergence and crash repair. |
| `redis-message-store.test.js` (3) | Renamed in place from queue-custody HMGET vocabulary to narrow source-provenance reads. | The same file retains bounded source-only HMGET, per-source failed outcomes on batch rejection, and isolation of one malformed provenance row from later batches. |
| `connector-invoke-trigger.test.js` (2) | Old A2A slot-claim and legacy custody-upgrade cases migrated to canonical Queue admission. | The retained suite proves one atomic Queue row, exact wait-continuation copying, verified managed-command generation fencing, strict provenance only from verified carriers, and `unknown` for ordinary connector ingress. |
| `callback-routes.test.js` (2) | Deliberate exact-drill boundary: `get-message` remains a read-only drill and does not adopt Queue custody. | Full `thread-context` remains the sole read-and-adopt surface (`full thread-context adopts published A2A custody` and `queued body adoption binds the exact child response`). A very large queued cat-authored message can therefore be shown by exact drill and later delivered normally; this can repeat content but cannot lose or steal custody. |
| `ball-custody-ingest-redis.test.js` (2) | Direct/managed completion heartbeat-CAS cases retired with the two completion disposition services. | Redis QueueLedger transition tests now own CAS contention and replay; `issue1371-redis-convergence.test.js` covers restart recovery against the canonical message and Queue stores. |
| `per-cat-terminal-disposition-collector.test.js` (2) | Collector custody/adopted-source tracking retired; this collector now classifies provider terminals only. | `queue-processor.test.js` retains exact child/source dispatch refs and independent multi-target convergence; QueueLedger stores the durable target ownership instead of event-payload inference. |
| `queue-processor.test.js` (1) | F293 source-versus-replay provenance moved from transient processor assertions into the Queue row. | `invocation-queue.test.js` and `queue-message-admission.test.js` assert deterministic source identity and replay without duplication; connector ingress asserts `sourceCategory` independently from replay/idempotency identity. |
| `messages-endpoint.test.js` (1) | Pending-target retry projection retired from browser History. | The same file now asserts that untouched/pre-admission queued user work is hidden until delivery and that another owner cannot gain queued body access; retry authority stays on the Queue endpoint. |
| `useSocket-thread-guard.test.ts` (1) | Socket-local sibling clearing no longer owns execution liveness. | The retained tests re-read canonical active-execution truth after lifecycle change and reconcile newer background cleared/completed events without letting stale hydration revive slots. |
| `CloudBindingRecoveryCard-races.test.tsx` (1) | Renamed to immutable retry-fence vocabulary. | `surfaces a stale immutable retry fence without duplicating the message` preserves the stale-response race assertion. |
| `CloudBindingRecoveryCard-state.test.tsx` (1) | Retry authority is carried by the exact immutable attempt rather than replaced by a client projection. | `retries only the immutable attempt carried by the recovery notice` preserves current-authority behavior without a second message. |
| `CloudBindingRecoveryCard-title-refresh.test.tsx` (1) | Pending-delivery polling was retired with the client-owned retry projection. | `does not poll retired retry authority or start title observation` fixes the read-only boundary explicitly. |
| `cloud-binding-recovery.test.ts` (1) | Waiting-state wording was replaced by exact retryable source/target projection. | The retained tests keep one exact recovery source, suppress only its linked notice, retain a standalone notice when the source is absent, and reject forged/cross-source metadata. |

Counts: `14 + 4 + 3 + 3 + 3 + 2 + 2 + 2 + 2 + 1 + 1 + 1 + 1 + 1 + 1 + 1 = 42`.
