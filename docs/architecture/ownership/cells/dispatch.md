---
cell_id: dispatch
title: Dispatch / Queue
summary: Invocation queue、busy gate、fairness、priority、外部 wake 执行、durable per-child execution ledger、普通 queued user message 的 MessageStore-backed restart custody 与 F264 durable per-target receipt、F254 legacy closure preflight / non-Queue supplement carrier，以及 F167 action successor generation fence、durable wake recovery 与 turn-scoped wake provenance。
canonical_features: [F167, F175, F177, F185, F254, F264]
code_anchors:
  - packages/shared/src/types/turn-execution.ts
  - packages/api/src/domains/cats/services/stores/ports/TurnExecutionStore.ts
  - packages/api/src/domains/cats/services/stores/redis/RedisTurnExecutionStore.ts
  - packages/api/src/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.ts
  - packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts
  - packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts
  - packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts
  - packages/api/src/domains/ball-custody/ManagedCommandWakeRecoverySweep.ts
  - packages/api/src/domains/ball-custody/ActionSuccessorRecoverySweep.ts
  - packages/api/src/domains/ball-custody/turn-custody-wake-provenance.ts
  - packages/api/src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts
  - packages/api/src/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.ts
  - packages/api/src/domains/cats/services/agents/invocation/InvocationTracker.ts
  - packages/api/src/domains/cats/services/stores/ports/queued-message-custody.ts
  - packages/api/src/domains/cats/services/stores/ports/queued-message-receipt.ts
  - packages/shared/src/types/queue-receipt.ts
  - packages/api/src/infrastructure/email/ConnectorInvokeTrigger.ts
  - packages/api/src/routes/messages.ts
  - packages/api/src/routes/invocations.ts
  - packages/api/src/routes/queue.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessClosureStore.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessClosurePreflight.ts
  - packages/api/src/domains/cats/services/freshness/FreshnessRelevancePolicy.ts
  - packages/api/src/domains/cats/services/freshness/glass-box/FreshnessSupplementStartupReconciler.ts
  - packages/api/src/routes/callback-a2a-trigger.ts
  - packages/api/src/routes/callback-multi-mention-routes.ts
  - packages/api/src/routes/callbacks.ts
doc_anchors:
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
static_scan_hints: [TurnExecutionRecord, TurnExecutionStore, RedisTurnExecutionStore, TurnExecutionStartupReconciler, executionKind, auxiliaryTurnExecutions, InvocationQueue, QueueProcessor, QueuedMessageCustody, QueueBodyExposure, QueueMessageReceipt, QueueReceiptTarget, QueueReminderAttempt, QueuedMessageCustodyCoordinator, QueuedMessageCustodyStartupReconciler, projectQueueReceipt, transitionQueueCustody, restoreDurableEntry, InvocationTracker, ConnectorInvokeTrigger, actionSuccessorFence, actionLeaseId, actionGeneration, freshnessClosureId, freshnessRequiredFrontierMessageId, freshnessSupplementId, readOnlyToolPolicy, busy, priority, autoExecute]
cited_by:
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

F175 owns the unified message queue and priority ordering. F185 / ADR-034 own entry-level busy-gate stratification. `TurnExecutionStore` is the TTL=0 lifecycle owner for every real child invoke: provider dispatch starts only after an idempotent `running` create, one immutable terminal wins, and startup interrupts pre-process orphaned running records. `InvocationRecordStore` remains parent/Queue aggregate truth; `InvocationRegistry` remains callback authentication and cannot serve as history. An ordinary queued user message has exactly one carrier here: `InvocationQueue` is its live ordering view, while the revisioned TTL=0 custody embedded in the same MessageStore record is restart truth. F264 projects that same truth into six per-target UI states without creating a second lifecycle. A best-effort notice may set `notified`; a manual reminder records independent `requested / delivered / seen / missed` attempts; exact body exposure binds `seen` to `(messageId, targetCat, childInvocationId, seenAt)`; only that exact child's successful terminal may record either `responded` or `completed_with_turn`, and `handledAt` must follow `seenAt`. Failure/cancel/restart-crash preserves exposure history, sets `failed`, and restores the same entry. Startup reconstructs the exact `messageId / entryId / position / target` owner and closes transient reminder/Steer attempts honestly; it does not convert pending execution into delivered-only visibility. Steer means cancel current + restart that exact entry once; reorder is a separate control. F254 keeps ADR-041 typed closure carriers only for unfinished/legacy work. ADR-042 supplement queue rows are allowed only for non-Queue unseen sources and project a distinct durable sequence: `QueueProcessor` resolves current aggregate truth, claims the exact ID, reloads original + required messages, seeds seenCursor, and passes a harness-enforced read-only policy before model start. F167 Phase S keeps action uniqueness in ball-custody and projects `leaseId + generation + dispatchId` onto QueueEntry. S.1-c leaves terminal command/return truth durable until dispatch is positively recoverable. Phase T adds a read-only wake provenance carrier into direct user and queued execution. An explicit A2A `sourceCategory` selects the current thread-ball dispatch, but only after `ball.handed` is durably recorded for the target holder; an exact `hold-ball:*` source selects its hold subject. Generic connectors, missing source records, and failed lookups remain `unknown_legacy` and fail closed through the structured stop gate rather than being guessed from prose. For cross-thread messages, one stored body may bind multiple immutable per-target Queue carriers. Carrier admission records delivered; child ledger creation records awakened before body exposure; startup restores each nonterminal carrier independently. A typed Phase T terminal-silent witness may be committed only with the same target's exact body-exposing successful child and successful aggregate.

## Use This When

- Changing invocation enqueue/dequeue behavior, priority, queue visibility, queue full handling, or auto-execution.
- Changing busy-gate semantics for users, A2A, connectors, CI/PR/review tasks, scheduled tasks, or generic external wakes.
- Adding fairness rules such as "non-agent entries must not be starved by agent chains".
- Changing F254 legacy successor or supplement enqueue, exact body reconstruction, claim/lease, read-only policy, failure terminalization, sequence budget, or startup carrier recovery.
- Changing ordinary queued-message persistence, custody CAS, same-invocation handled evidence, restart reconciliation, legacy custody backfill, or exact Queue owner reconstruction.
- Changing child invocation create/terminal/restart lifecycle, execution kind, parent index, glass-box API, or callback-auth cleanup boundary.
- Changing F264 receipt projection, handled disposition, lineage evidence, reminder attempts, or Steer-in-progress persistence.
- Changing author-declared current-work/next-work intent, exact parent exposure eligibility, preference resolution, or terminal fallback.
- Changing action-scoped multi-mention/cross-post admission order, queue idempotency projection, generation preflight, or stale structured response suppression.
- Changing managed-command/return recovery dispatch, or the wake provenance passed into the turn-scoped custody stop gate.

## Extend By

- Reuse `InvocationQueue` for queued work and `QueueProcessor` for execution order.
- Add source/category/priority metadata to queue entries instead of bypassing queue ordering.
- Route external automated wakes through `ConnectorInvokeTrigger.trigger()` unless a new architecture decision says otherwise.
- Keep thread-level vs slot-level busy gates explicit in docs and tests.
- Treat `freshnessClosureId` as a typed custody carrier. Before model execution, resolve immutable origin, scan through the latest raw frontier, CAS-merge relevant bodies, and then claim the running lease. Missing/terminal closure cancels; incomplete evidence blocks before model execution.
- Treat `freshnessSupplementId` as a projection-only carrier. Resolve the durable aggregate, require one target + exact lineage/seq, claim before launch, rebuild input from MessageStore, and fail before provider start if `readOnlyToolPolicy` is absent or unsupported.
- Persist ordinary queued-message responsibility on the same MessageStore record with immutable identity, revisioned CAS, stable ordering, and independent `notified / seen / failed / handled` target sets. Rebuild `InvocationQueue` from that truth on startup and reconcile only exact InvocationRecord evidence.
- Derive `QueueMessageReceipt` from custody for both live Queue and F5 history. Keep reminder attempts additive and idempotent per exact message/target/invocation; keep `responded` and `completed_with_turn` as distinct terminal dispositions.
- Persist author disposition on the existing per-target custody. Bind `continue_current` to the exact active parent at admission; only a matching full-body read may expose it, and parent terminal must append a fallback to `next_work` for every still-pending target.
- Create every child in `TurnExecutionStore` before provider start, pass `executionKind` explicitly, and transition `running` through the store's one-way terminal CAS. Reconcile abandoned running children from the durable ledger, never from logs or callback auth.
- Treat `actionSuccessorFence` as a typed projection from `ActionSuccessorLeaseStore`. Admission happens before request/message/timer/queue persistence; start and commit both preflight the exact generation.
- Derive stop-gate wake provenance from typed Queue/action/message-source fields only. User/cron/freshness can be obligation-free; action fences, explicit A2A dispatches, and exact hold sources select one custody truth. Persist the A2A `ball.handed` transition before opening its projection; missing/failed lookups stay legacy unknown.

## Do NOT Unify With

- Do not collapse user side-dispatch and external automated events into one busy-gate rule. ADR-034 explicitly keeps them stratified.
- Do not add a second queue for a feature-specific wake path without proving `InvocationQueue` cannot express the priority/fairness requirement.
- Do not create a supplement carrier for an ordinary queued user message, or treat notice delivery as seen/handled evidence.
- Do not infer `responded` from invocation success alone, collapse reminder delivery into body-read evidence, or turn `seen` into `handled`.
- Do not add child arrays or kind enums to the parent InvocationRecord, and do not retain callback-auth registry entries as historical execution truth.
- Do not treat the in-memory `InvocationQueue` Map as restart truth, and do not call `markDelivered` merely because a queued owner was absent after process restart.
- Do not use Steer as a synonym for promote/reorder; Steer cancels current work and restarts the exact durable entry once.
- Do not treat preference or `continue_current` as seen/handled evidence, leave it unbound to a parent, or let a replacement/same-cat successor inherit the old exposure window.
- Do not use `urgent` priority for agent-to-agent continuation except the explicit continuation exception. Urgent is for user/system blocking work, not agent chatter.
- Do not model transport delivery retries here; connector delivery belongs to `transport`.
- Do not infer catch closure from an untyped existing invocation. Scheduling coverage is not semantic closure and cannot suppress a required successor.
- Do not let queue removal silently delete supplement responsibility, or let a stale carrier launch after its aggregate became terminal.
- Do not let ordinary A2A coalesce absorb action-fenced work, and do not let queue state decide action uniqueness or replace eligibility.
- Do not classify a generic connector or provenance-free historical text mention as `covered_empty`; absence of a typed carrier must remain legacy fail-closed during migration. An explicit A2A source category is typed dispatch provenance, not a text guess.

## Static Scan Hints

Watch for new or renamed `TurnExecutionRecord`, `TurnExecutionStore`, `executionKind`, `routing_guard`, `freshness_supplement`, `TurnExecutionStartupReconciler`, `Queue`, `QueueProcessor`, `InvocationQueue`, `QueuedMessageCustody`, `QueueBodyExposure`, `QueueMessageReceipt`, `QueueReceiptTarget`, `QueueReminderAttempt`, `QueuedMessageCustodyCoordinator`, `QueuedMessageCustodyStartupReconciler`, `projectQueueReceipt`, `transitionQueueCustody`, `restoreDurableEntry`, `ConnectorInvokeTrigger`, `ManagedCommandWakeRecoverySweep`, `ActionSuccessorRecoverySweep`, `TurnCustodyWakeProvenance`, `actionSuccessorFence`, `actionLeaseId`, `actionGeneration`, `FreshnessClosurePreflight`, `FreshnessRelevancePolicy`, `freshnessClosureId`, `freshnessSupplementId`, `freshnessSupplementSeq`, `readOnlyToolPolicy`, `originTriggerMessageId`, `freshnessRequiredFrontierMessageId`, `tryAutoExecute`, `autoExecute`, `busy`, `priority`, `sourceCategory`, `urgent`, and `enqueue` code.
