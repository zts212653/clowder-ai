---
feature_ids: [F257]
topics: [harness-ledger, hold-ball, action-liveness, routing-guard]
doc_kind: implementation-plan
created: 2026-07-15
tips_exempt:
  reason: Automatic server-side completion enforcement has no operator action or discoverable capability to teach.
---

# F257 LI-001 Action Liveness Implementation Plan

## Delivery Status

LI-001 已由 PR #38 合入 `develop_base`（merge `0cdd17f68`，reviewed head `4154e316`）。合入后 `29533ccbb` 进一步关闭 hold_ball 429 的秒级自动重试，避免 retry noise 被误计为三次独立 guard 事件；`729509e35` 补齐 clean-env 与逐 endpoint 回归断言。LI-005 仍是独立 durable A2A trigger/ack 状态机，不属于本计划交付边界。

## Scope

Implement LI-001 only: every invocation woken by `hold_ball` must finish with at least one real tool action or an explicit routing exit. A text-only acknowledgement and an empty successful response each receive one bounded inline remedial invoke. LI-005 remains out of scope because it needs a separate durable A2A trigger state machine.

The invocation policy is explicit and opt-in:

```ts
completionRequirement: 'action-or-routing-exit'
```

Architecture cell: dispatch

Map delta: none

Why: This extends metadata and completion validation inside the existing connector -> queue -> router dispatch path; it adds no Store, Queue, Router, Adapter, or ownership boundary.

## QueueEntry propagation

| Stage | Direct dispatch | Busy/queued dispatch | Required state |
| --- | --- | --- | --- |
| `hold_ball` wake producer | Pass policy to `invokeTrigger.trigger` | Same call reaches connector busy gate | `completionRequirement = action-or-routing-exit` |
| `ConnectorInvokeTrigger.trigger` | Forward into `executeInBackground` | Forward into `enqueueWhileActive` | Policy is never inferred from free text |
| `InvocationQueue.enqueue` | n/a | Persist on `QueueEntry` and preserve during queued dedupe/coalescing | Queueing must not erase the requirement |
| Execution | Pass to `AgentRouter.routeExecution` | `QueueProcessor.executeEntry` passes stored field to `routeExecution` | Direct and queued paths are behaviorally equivalent |
| Routing | `AgentRouter` copies into `RouteOptions` | Same | `routeSerial` is the single enforcement point |

## State transitions

| Path | Transition | Expected result |
| --- | --- | --- |
| Direct dispatch | trigger -> acquired slot -> route | Requirement reaches `routeSerial` unchanged |
| Queued dispatch | trigger -> queue entry -> processing -> route | Requirement survives enqueue/dequeue unchanged |
| First pass has tool use | running -> satisfied | No remedial invoke |
| First pass has valid route exit | running -> satisfied | No remedial invoke |
| First pass is text-only or empty success | running -> remedial (once) | First-pass text is buffered; one inline remedial invoke runs |
| Remedial satisfies contract | remedial -> satisfied | Persist/broadcast the effective response normally |
| Remedial still violates contract | remedial -> guard-failed terminal | Persist an action-liveness guard failure notice; never retry again |
| Provider error | running -> failed | No action-liveness remedial |
| Abort/cancel | running -> canceled | No action-liveness remedial |

## Invariants

1. The policy is structural metadata, never detected from scheduler prompt text.
2. Only `hold_ball` wake paths opt in; ordinary user and connector invocations retain current behavior.
3. Any completed tool call attempt represented by a `tool_use` event satisfies the action side; existing line-start mention, routing tool, structured target, and co-creator exits satisfy the routing side.
4. The action-liveness guard and existing Codex routing guard share one per-cat remedial budget.
5. Errors and aborts never spend that budget.
6. A second violation produces one visible failure notice and no recursive invocation.
7. Queue coalescing may upgrade a queued entry to carry the requirement but may not downgrade or discard it.
8. The wake-only requirement applies to the original `hold_ball` target; downstream A2A recipients do not inherit it.

## TDD matrix

| Layer | Adversarial case | Assertion |
| --- | --- | --- |
| Pure guard | empty/text-only success | remediate |
| Pure guard | arbitrary tool call | satisfied |
| Pure guard | line-start mention / hold / structured target / co-creator | satisfied |
| Pure guard | provider error / abort / already attempted | no remedial |
| `routeSerial` | plain acknowledgement then tool action | exactly two invokes; no failure notice |
| `routeSerial` | empty response twice | exactly two invokes; one action-liveness failure notice |
| `routeSerial` | existing server routing guard plus completion policy | one shared remedial invoke, not two |
| `routeSerial` | target routes to downstream A2A cat | downstream recipient does not inherit wake-only completion policy |
| `routeSerial` | partial text then provider error / abort | no remedial invoke |
| `routeSerial` | bounded remedial ends in provider error | preserve provider error; do not emit action-liveness failure notice |
| Connector direct | policy on free slot | `routeExecution` receives requirement |
| Connector queued | policy while busy | `QueueEntry` stores requirement |
| Queue processor | queued policy execution | `routeExecution` receives stored requirement |
| `hold_ball` wakeWhen | command completion | invoke trigger policy opts in |
| `hold_ball` timer reminder | scheduled task fire | invoke trigger policy opts in based on hold-ball task identity |

## Verification

Run the new pure-guard and route-serial tests first, then connector/queue/hold-ball tests. Finish with API typecheck/build, shared build if required by the test harness, `git diff --check`, and the repository quality gate relevant to this branch.
