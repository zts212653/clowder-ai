---
cell_id: dispatch
title: Dispatch / Queue
summary: Invocation queue、busy gate、fairness、priority 与外部 wake 执行。
canonical_features: [F175, F185]
code_anchors:
  - packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts
  - packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts
  - packages/api/src/domains/cats/services/agents/invocation/InvocationTracker.ts
  - packages/api/src/infrastructure/email/ConnectorInvokeTrigger.ts
  - packages/api/src/routes/messages.ts
doc_anchors:
  - docs/features/F175-unified-message-queue.md
  - docs/features/F185-dispatch-busy-gate-unification.md
  - docs/decisions/034-dispatch-busy-gate-unification.md
static_scan_hints: [InvocationQueue, QueueProcessor, InvocationTracker, ConnectorInvokeTrigger, busy, priority, autoExecute]
cited_by:
  - {feature: F191, date: 2026-05-07, delta: new cell}
---

# Dispatch / Queue

## Canonical Owner

F175 owns the unified message queue and priority ordering. F185 / ADR-034 own entry-level busy-gate stratification: user broadcast, user @mention, external connector wake, A2A, and hold wake are not the same kind of dispatch.

## Use This When

- Changing invocation enqueue/dequeue behavior, priority, queue visibility, queue full handling, or auto-execution.
- Changing busy-gate semantics for users, A2A, connectors, CI/PR/review tasks, scheduled tasks, or generic external wakes.
- Adding fairness rules such as "non-agent entries must not be starved by agent chains".

## Extend By

- Reuse `InvocationQueue` for queued work and `QueueProcessor` for execution order.
- Add source/category/priority metadata to queue entries instead of bypassing queue ordering.
- Route external automated wakes through `ConnectorInvokeTrigger.trigger()` unless a new architecture decision says otherwise.
- Keep thread-level vs slot-level busy gates explicit in docs and tests.

## Do NOT Unify With

- Do not collapse user side-dispatch and external automated events into one busy-gate rule. ADR-034 explicitly keeps them stratified.
- Do not add a second queue for a feature-specific wake path without proving `InvocationQueue` cannot express the priority/fairness requirement.
- Do not use `urgent` priority for agent-to-agent continuation except the explicit continuation exception. Urgent is for user/system blocking work, not agent chatter.
- Do not model transport delivery retries here; connector delivery belongs to `transport`.

## Static Scan Hints

Watch for new or renamed `Queue`, `QueueProcessor`, `InvocationQueue`, `ConnectorInvokeTrigger`, `tryAutoExecute`, `autoExecute`, `busy`, `priority`, `sourceCategory`, `urgent`, and `enqueue` code.
