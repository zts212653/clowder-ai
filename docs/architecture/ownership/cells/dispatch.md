---
cell_id: dispatch
title: Dispatch / Queue
summary: 按 thread 持久化的 source Queue Entry、未投递 targets 集合、有序 active index、短时 claim、原子 admission/target 更新、逐成员 Steer、外部 wake 执行，以及 durable child/execution 投影。
canonical_features: [F047, F117, F167, F175, F177, F185, F247, F254, F264, F280, F295]
code_anchors:
  - packages/shared/src/types/active-execution.ts
  - packages/shared/src/types/turn-execution.ts
  - packages/api/src/domains/cats/services/stores/ports/TurnExecutionStore.ts
  - packages/api/src/domains/cats/services/stores/redis/RedisTurnExecutionStore.ts
  - packages/api/src/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.ts
  - packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts
  - packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts
  - packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts
  - packages/api/src/domains/cats/services/agents/invocation/StartupReconciler.ts
  - packages/api/src/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.ts
  - packages/api/src/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.ts
  - packages/api/src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.ts
  - packages/api/src/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.ts
  - packages/api/src/domains/cats/services/agents/invocation/queue-ledger/queue-ledger-redis-scripts.ts
  - packages/api/src/domains/cats/services/stores/ports/InvocationRecordStore.ts
  - packages/api/src/domains/cats/services/stores/redis/RedisInvocationRecordStore.ts
  - packages/api/src/domains/cats/services/agents/invocation/CollaborationContinuityCapsule.ts
  - packages/api/src/domains/ball-custody/ManagedCommandWakeRecoverySweep.ts
  - packages/api/src/domains/ball-custody/ActionSuccessorRecoverySweep.ts
  - packages/api/src/domains/ball-custody/turn-custody-wake-provenance.ts
  - packages/api/src/domains/ball-custody/wait-continuation-carrier.ts
  - packages/api/src/domains/cats/services/agents/invocation/InvocationTracker.ts
  - packages/api/src/domains/cats/services/stores/ports/MessageStore.ts
  - packages/api/src/domains/cats/services/stores/redis/RedisMessageStore.ts
  - packages/shared/src/types/queue-receipt.ts
  - packages/api/src/utils/queue-enrichment.ts
  - packages/api/src/infrastructure/email/ConnectorInvokeTrigger.ts
  - packages/api/src/routes/messages.ts
  - packages/api/src/routes/invocations.ts
  - packages/api/src/routes/queue.ts
  - packages/api/src/routes/active-execution-routes.ts
  - packages/api/src/domains/cats/services/session/thread-access-policy.ts
  - packages/web/src/stores/activeExecutionStore.ts
  - packages/web/src/hooks/useActiveExecutionProjection.ts
  - packages/web/src/hooks/useLiveExecutionCancelControl.ts
  - packages/web/src/components/ThreadExecutionBar.tsx
  - packages/web/src/components/MessageDispatchAvatars.tsx
  - packages/web/src/components/workspace/WorkspaceNowSurface.tsx
  - packages/api/src/domains/cats/services/freshness/FreshnessClosureStore.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessClosurePreflight.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessRelevancePolicy.ts
  - packages/api/src/domains/cats/services/freshness/glass-box/FreshnessSupplementStartupReconciler.ts
  - packages/api/src/routes/callback-a2a-trigger.ts
  - packages/api/src/routes/callback-multi-mention-routes.ts
  - packages/api/src/routes/callbacks.ts
doc_anchors:
  - docs/decisions/043-queue-durable-single-ledger.md
  - docs/features/F117-message-delivery-lifecycle.md
  - docs/features/F047-queue-steer.md
  - docs/features/F295-cancelable-execution-projection.md
  - docs/features/F177-harness-update.md
  - docs/features/F167-a2a-chain-quality.md
  - feature-specs/2026-07-11-f167-phase-s-action-successor-single-flight.md
  - docs/features/F175-unified-message-queue.md
  - docs/features/F185-dispatch-busy-gate-unification.md
  - docs/decisions/034-dispatch-busy-gate-unification.md
  - docs/features/F254-side-effect-freshness-gate.md
  - docs/decisions/041-freshness-catch-closure-output-commit.md
  - docs/decisions/042-glass-box-delivery-semantics.md
  - feature-specs/2026-07-12-f254-glass-box-publish-supplement.md
  - feature-specs/2026-07-13-f254-post-merge-durability-migration-eval.md
  - docs/features/F264-per-target-message-receipt.md
  - feature-specs/2026-07-15-f264-per-target-message-receipt.md
  - feature-specs/2026-07-16-f177-f254-f264-child-execution-truth.md
  - feature-specs/2026-07-31-f264-terminal-consumption-receipt.md
  - feature-specs/2026-08-04-f264-author-declared-message-disposition.md
  - feature-specs/2026-08-12-1291-gate3-terminal-receipt-publication.md
  - feature-specs/2026-08-12-1291-gate4-wait-carrier-integration.md
  - feature-specs/2026-08-12-1291-gate5-retry-revalidation.md
static_scan_hints: [QueueLedgerEntry, QueueLedgerStore, QueueLedgerAdmission, RedisQueueLedgerStore, InMemoryQueueLedgerStore, queueEntryId, sourceRecordId, targets, authorIntentByTarget, expandTargets, InvocationQueue, QueueProcessor, StartupReconciler, TurnExecutionRecord, TurnExecutionStore, executionKind, InvocationRecordStore, WaitContinuationCarrierV1, waitContinuationCarrier, QueueReminderAttempt, claimPrefix, claimExactSteerEntryDurable, restoreClaimedEntries, ConnectorInvokeTrigger, actionSuccessorFence, actionLeaseId, actionGeneration, freshnessClosureId, freshnessSupplementId, readOnlyToolPolicy, priority, sourceCategory, autoExecute, reconcileInactiveLiveInvocation, EXECUTION_CONTROL_UNAVAILABLE]
cited_by:
  - {feature: F117-canonical-source-entry, date: 2026-09-08, delta: Queue owns one source entry with only pending targets, order, author intent and a short reversible claim; actual delivery moves exact targets into MessageStore dispatchRefs while response and TurnExecution records own processing and terminal truth}
  - {feature: F117-steer-per-target, date: 2026-09-07, delta: default delivery copy separates queueing from immediate guidance; static configured-client guide capability is projected per member; composer and Queue Steer support multi-select with per-target guide or interrupt; targetless binding plus sibling fan-out is one atomic ledger mutation}
  - {feature: F220-KD9-stop-ladder, date: 2026-09-03, delta: Stop is the only user-facing termination; an exact live cancel escalates server-side to per-target reconciliation of durable running truth instead of 409, an incomplete process-owner snapshot terminalizes the execution as failed instead of prompting, and force-reset is demoted to an internal thread-scoped reconciler}
  - {feature: F254-ADR-043-read-adoption, date: 2026-09-03, delta: an exact full same-thread read adopts only that target from the one source Queue Entry into the current lifecycle response, records its History dispatchRef, and leaves sibling targets pending on the same entry}
  - {feature: F117-ADR-043, date: 2026-09-03, delta: QueueLedger becomes the only durable Queue truth; deterministic source-by-target rows atomically admit Messages, retain terminal receipt tombstones outside active order, and drive live/history receipt projection through an exact message index}
  - {feature: F295-post-close-thread-admission, date: 2026-08-22, delta: active-execution read and exact-cancel reuse canonical owner/default/user-index/external-anchor thread admission before liveness lookup while retaining masked shared occupancy and execution-principal control fences}
  - {feature: F295, date: 2026-08-13, delta: one project-scoped read projection joins canonical live invocation truth with existing managed-command receipts; every displayed execution carries thread, kind, exact identity and an identity-fenced cancel target or an explicit non-cancelable reason}
  - {feature: issue-1291-gate6-batch-steer, date: 2026-08-13, delta: Batch Steer accepts only an exact allowlist of compatible ordinary-user entries for one cat; Queue reserves the complete set before one preempt and QueueProcessor creates one replacement invocation without F175 absorbing unselected neighbors}
  - {feature: F280-Gate-5, date: 2026-08-12, delta: MessageStore custody keeps append-only target attempts; Queue projects only the current accepted ordinary/wait attempt ID and Invocation uses it as restart-stable idempotency, while coalesced legacy A2A carriers carry no guessed single-message attempt identity}
  - {feature: F280-Gate-4, date: 2026-08-12, delta: direct and queued github-wait admission copy the exact server-authored wait/outcome/owner-fence carrier into InvocationRecord; restart reconstructs it from MessageStore and different outcomes cannot coalesce}
  - {feature: F167-S.1-c-gate3, date: 2026-08-12, delta: successful Queue API delete and clear withdrawals publish exact message-bound receipt deltas beside the ordered queue_updated snapshot even after actionable rows disappear; history hydration and live publication derive the same QueueMessageReceipt from MessageStore custody}
  - {feature: F167-S.1-c-gate2, date: 2026-08-12, delta: one Queue settlement seam maps success, explicit user cancel, system failure, action fences, and verified replacement custody to consume, rollback, retain, or transfer; recovery may rebind an absent carrier only through exact source-message CAS}
  - {feature: F167-post-disposition-continuation, date: 2026-08-11, delta: an exact handled-dispatch terminal witness settles only its source receipt and schedules one source-free same-cat continuation through the existing capsule and Queue path; completed and same-invocation progress schedule none}
  - {feature: F247, date: 2026-08-12, delta: cloud-only invocations create a durable child, await only the bounded Host transport outcome, publish one readable status, and complete the exact A2A source so unavailable transport cannot become Queue replay}
  - {feature: F167-Phase-T-readiness, date: 2026-07-23, delta: explicit A2A source categories bind the current thread-ball dispatch after durable ball.handed evidence, while exact hold-ball sources keep their hold identity and generic or missing provenance remains legacy unknown}
  - {feature: F167-Phase-T-shadow, date: 2026-07-20, delta: direct user and queued execution paths attach mechanical wake provenance so route-serial can shadow the legacy text guard against one turn-scoped custody projection}
  - {feature: F167-Phase-T-cutover, date: 2026-07-30, delta: route settle now enforces the wake-scoped custody projection; the retired text predicate remains observation-only and F177 provider/hook authority is removed}
  - {feature: F167-S.1-c, date: 2026-07-20, delta: managed-command completion and action return delivery recover through boot/periodic idempotent sweeps; message persistence alone no longer counts as a successful holder wake}
  - {feature: F177-F254-F264-child-execution-truth, date: 2026-07-16, delta: a TTL-0 per-child ledger owns ordinary routing-guard and freshness-supplement lifecycle; exact child prompt exposure and terminal success drive per-target receipt truth while parent records remain aggregate-only}
  - {feature: F167-Phase-S, date: 2026-07-11, delta: multi-mention and cross-post share pre-persistence admission; QueueEntry carries the action lease generation and QueueProcessor checks it before start and structured commit}
  - {feature: F191, date: 2026-05-07, delta: new cell}
  - {feature: F254-Phase-E, date: 2026-07-09, delta: typed closure successors adopt durable custody at queue preflight; stale queued successors self-cancel against current closure truth}
  - {feature: F254-v1.2, date: 2026-07-11, delta: preflight scans current raw truth before claim/model, CAS-merges target-relevant updates, and uses one running lease without collapsing pending lineages}
  - {feature: F254-ADR-042, date: 2026-07-12, delta: ordinary queued user messages remain single-owned Queue entries with per-target notified/seen/failed/handled truth; only non-Queue unseen sources may create a projection carrier for an exact supplement sequence}
  - {feature: F254-post-merge-durability, date: 2026-07-13, delta: ordinary queued MessageStore records carry revisioned TTL-0 custody; startup deterministically reconstructs the exact Queue owner and independent per-target lifecycle instead of degrading responsibility to delivered-only visibility}
  - {feature: F264, date: 2026-07-15, delta: durable custody projects six honest per-target UI states, distinct responded vs completed-with-turn outcomes, exact invocation-lineage evidence, idempotent reminder requested/delivered/seen/missed attempts, and persisted Steer-in-progress truth}
  - {feature: F264-terminal-consumption, date: 2026-07-31, delta: cross-thread messages bind immutable per-target Queue carriers; exact child creation records awakened separately from body exposure, and only exact-child plus aggregate success may commit a typed Phase T terminal-silent witness into the existing receipt}
  - {feature: F264-author-disposition, date: 2026-08-04, delta: ordinary queued sources persist per-target author disposition with an exact parent exposure fence; next-work remains the default, and an unconsumed current-work request falls back to the same Queue custody instead of leaking into a successor turn}
---

# Dispatch / Queue

## Canonical Owner

ADR-043 / F117 own one durable Queue ledger per thread. One source message has one `QueueLedgerEntry`, whose
`targets[]` is exactly the set of members still awaiting delivery. The entry owns source identity
(`sourceId` plus `sourceRecordId`), ordering, immutable launch fences, per-target author intent, reminder
attempts, revision, and a short reversible claim. It does not own response processing, terminal outcomes,
body-exposure receipts, or handled state. `InvocationQueue` is only the in-process scheduling adapter over
that ledger, never restart truth.

Redis stores source entries in one thread-scoped hash and active entry IDs in the order list. Durable Queue
state is `queued` plus a bounded `claimed` cutover. A claim is fenced by `claimId`: a failed pre-dispatch
cutover restores the same entry and position; an actual delivery removes only that target; and an empty
`targets[]` deletes the entry. Queue retains no processing/terminal tombstone. Retry is a new attempt in the
owning lifecycle store, not resurrection of finished Queue state. Startup validates persisted rows and
restores abandoned short claims before scheduling.

MessageStore owns the source body and its actual delivery projection. `dispatchRefs[]` records only real
source-to-target deliveries, including `dispatchedAt`, response identity, and later settled outcome. A user
or external inline source remains absent from History while it has no actual dispatch; its first delivered
target materializes the one source bubble, and later targets extend the same message. Agent-authored sources
already in History reuse that message. Queue and History therefore meet by exact source identity without
copying the body or rendering one user message per target.

A complete same-thread unread adoption is the same delivery transition as ordinary dispatch: prove the
exact running child, remove that exact target from the Queue entry, and append one `dispatchRef` tied to the
existing response. Other pending targets remain in the same entry. Sparse, cross-thread, oversized-anchor,
or unproven-child reads do not consume a target. There is no separate Queue `seen`, `handled`, or receipt
writer.

Routing preflight is not a second chat-message producer. A fail-open `warned` decision remains available in
structured routing evidence and telemetry while leaving the requested target unchanged; only a `rejected`
decision may emit a user-visible receipt. When a cat-authored A2A response fails, the failed response and one
exact-predecessor `a2a_failure` row commit atomically. That row bypasses inferred mentions and ping-pong/depth
heuristics, and cannot recursively create another failure report.

Stop is the only user-facing termination. Running truth is the durable `TurnExecution` record plus a
liveness witness (tracker slot or process owner); in-memory slots, tracker tombstones, and session
locks are caches and cannot pin a thread busy by themselves. An exact Stop first cancels a live candidate; when
the durable execution still says running but no controllable candidate exists, the same request reconciles that
target (retire the pre-start reservation, cancel the running record, release the orphaned lock and slot,
publish terminal) and returns `reconciled` rather than 409. An incomplete process-owner snapshot (`ps` failure,
unreadable owner manifests, or a platform without `ps`; no platform compatibility branch) is
retried server-side and then terminalizes the exact execution as failed through the ordinary dispatch terminal
path, so ordinary failure propagation runs (source dispatchRef settlement, A2A report back to a cat source,
`delivery_failure` for pre-start); no confirmation dialog exists, and `force-reset` remains only an internal thread-scoped reconciler. The
same reconciliation is reused at startup, on projection read, and on Stop (ADR-043 D9).

Steer is the only preemption path. The modal projects current participants plus routed/fallback members and
joins pending Queue targets with already-dispatched History refs. Confirmation rereads live truth: targets
delivered while the modal was open are skipped, additions/removals update the source entry, and each remaining
selected target receives its chosen guide-or-interrupt strategy. Stale presentation state is not itself a
business conflict. The short claim fences the exact server-side cutover; pre-dispatch failure restores Queue
state, while provider outcomes after actual delivery settle independently in History.

The default disposition is `next_work` (排队等待) or `continue_current` (立即发送，引导回复). Guide support is
a static per-member client capability projected by the server; the UI must not hard-code it or infer it from
local activity. Queue and composer Steer show both guide and interrupt actions, allow a per-target strategy for
multi-select, and enable guide only for a supporting member with an exact current reply. Unsupported default
guide preserves the target as `next_work` and never cancels the current execution. Targetless binding and
multi-target updates mutate the one source entry atomically; after actual delivery each target proceeds
independently. A successful
`runtime_replacement` already completed its recovered attempt and must not enqueue a second source-less
continuation.

F175 owns comparator/order policy and F185 / ADR-034 own busy-gate stratification. `TurnExecutionStore`
owns each real child lifecycle; `InvocationRecordStore` owns parent/aggregate execution truth;
`InvocationRegistry` remains callback authentication only. F254 closure and supplement stores retain
their own authority while Queue rows carry typed launch metadata. F167 action leases and F280 wait
continuations remain owned by ball-custody stores; Queue may transport their exact immutable fences but
cannot mint, retry, or reinterpret them. The retired Gate-5 bridge may not recreate completed Queue work.
F247 cloud-only execution still creates a normal child and settles the exact source without turning a
transport failure into Queue replay.

## Use This When

- Changing Queue admission, target-set mutation, priority, ordering, capacity, claim/commit/restore, withdrawal, or
  restart behavior.
- Adding a producer that persists Message and Queue work, or changing one of the three cross-record atomic
  admission transactions.
- Changing Steer, append-without-stop, prestart retirement, or the `ENTRY_PROCESSING` conflict boundary.
- Changing the Queue-to-History dispatch cutover, unread adoption, reminders, or source materialization.
- Changing F254 freshness carriers, F167 action-successor fences, F280 wait carriers, or other typed launch
  metadata transported by Queue.
- Changing child execution lifecycle, busy-gate policy, wake provenance, or external connector admission.

## Extend By

- Create entries through `QueueLedgerAdmission` and use the deterministic source identity; never allocate
  one independent Queue identity per target.
- Use `appendAndEnqueueDurable`, connector adoption, or terminal-response fan-out transactions whenever
  Message and Queue facts must appear together.
- Add state transitions to `QueueLedgerStore` with Redis Lua that validates every precondition before its
  first write, plus matching in-memory and isolated-Redis tests.
- Keep active-order scans bounded to the order list and join actual dispatch state from MessageStore only
  when a caller needs it.
- Project public Queue DTOs from pending source entries; project dispatch avatars and terminal truth from
  MessageStore/response lifecycle, not Queue fields.
- Keep source authority in its owner store. Queue fields may transport an immutable fence, but start and
  terminal commit must revalidate it at the owning boundary.
- Create every child in `TurnExecutionStore` before provider start and settle child plus response lifecycle
  truth monotonically.

## Do NOT Unify With

- Do not reintroduce `message.queueCustody`, per-target Queue rows, a second receipt ledger, or startup reconstruction
  by scanning MessageStore.
- Do not persist Queue processing/terminal tombstones, body-exposure facts, or handled outcomes. Those facts
  belong to TurnExecution, MessageStore dispatch refs, and response messages.
- Do not restore failed, cancelled, interrupted, handled, or withdrawn attempts to Queue. A retry is a new
  lifecycle attempt; pending targets remain pending only until actual dispatch or withdrawal.
- Do not concatenate adjacent Queue bodies or let one row absorb another row's message identity.
- Do not preempt before winning the durable claim, and do not turn Steer into promote/reorder.
- Do not let Queue decide action uniqueness, wait ownership, freshness closure, connector transport policy,
  or callback authentication.
- Do not infer delivery/handled state from notices, provider success, log text, or rendered prose.
- Do not render fail-open routing warnings as chat messages, recursively report an `a2a_failure`, or enqueue a
  new `runtime_replacement` continuation after the recovered attempt succeeded.
- Do not return a full queued body before its exact active-child adoption is durable, and do not retire
  sibling targets when another target adopts the same source.
- Do not gate Stop on an in-memory live candidate or answer a user's Stop with 409 while the durable row still
  says running; reconcile or terminalize the exact target instead, and reserve 503 for persistence failure only.
- Do not let an in-memory slot, tracker tombstone, or session lock pin a thread busy without a durable
  `TurnExecution` and a liveness witness, and do not surface force-reset as a standing or stall-triggered user entry.
- Do not use the in-memory Queue cache as persistence or accept an unvalidated Redis row into scheduling.
- Do not collapse user side-dispatch and external automated wakes into one busy-gate policy.

## Static Scan Hints

Watch for new or renamed `QueueLedgerEntry`, `QueueLedgerStore`, `QueueLedgerAdmission`,
`RedisQueueLedgerStore`, `InMemoryQueueLedgerStore`, `queueEntryId`, `sourceRecordId`, `targets`,
`authorIntentByTarget`, `InvocationQueue`, `QueueProcessor`,
`StartupReconciler`, `claimPrefix`, `claimExactSteerEntryDurable`, `restoreClaimedEntries`,
`dispatchRefs`, `dispatchedAt`, `statusMessageId`, `TurnExecutionStore`,
`InvocationRecordStore`, `actionSuccessorFence`, `waitContinuationCarrier`,
`freshnessClosureId`, `freshnessSupplementId`, `sourceCategory`, `priority`, and `autoExecute`.
