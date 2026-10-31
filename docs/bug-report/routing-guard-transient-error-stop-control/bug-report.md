---
feature_ids: [F167, F295]
topics: [routing-guard, cancellation, invocation-tracker, transient-errors]
doc_kind: bug-report
created: 2026-08-18
---

# Routing guard loses Stop control after a transient error

## Bug diagnosis capsule

| Field | Evidence |
| --- | --- |
| Symptom | A durable `routing_guard` child remained `running`, while the active-execution projection returned `not_cancelable / control_plane_unavailable`. The member-level Stop control therefore could not abort work that was visibly still running. |
| Evidence | Incident parent `af77854e-f795-4a4e-9281-4937e3a1fd9e`: the ordinary child succeeded at 14:32:08.498; a `routing_guard` child started about 35 ms later for `missing_routing_exit` and remained live until about 14:48. The stream contract marks recoverable diagnostics as `errorDisposition: 'transient'`, but every route consumer released its `InvocationTracker` slot on any `error` frame. A regression test reproduced the empty active-slot projection immediately after a transient diagnostic. |
| Root cause | Durable child status and Stop ownership used different terminal predicates. `PerCatTerminalDispositionCollector` correctly ignored transient errors, but seven route consumers treated `done || error` as slot-terminal. A recoverable diagnostic therefore deleted the exact AbortController before the durable child reached its terminal frame. |
| Diagnostic strategy | Trace one execution from `InvocationTracker.startAll` through `routeSerial` and the outer stream consumer; compare durable `routing_guard` creation/terminal ordering with every `completeSlot` call; reproduce with a gated generator that yields a transient error before `done`. |
| Timeout strategy | If the gated reproduction did not fail, inspect the exact incident build and child event stream rather than adding timing delays or widening controller retention. |
| Warning strategy | A fix is invalid if it keeps terminal errors active, changes durable execution status to hide the mismatch, or special-cases only `routing_guard` while leaving the same terminal predicate in other route entry points. |
| User-visible correction | A running member—including a stop-gate remedial child—remains visible and exactly stoppable after a recoverable provider diagnostic. Terminal errors and `done` still release the slot immediately. |
| Acceptance | RED: `keeps a cat cancelable after a transient diagnostic until its done frame` projected no active slot. GREEN before review: message and QueueProcessor regressions pass; all route entry points use one terminal predicate; routing-guard durable-child and F295 exact-cancel suites remain green. Final acceptance additionally requires the pushed exact-HEAD full gate. |

## Report

1. **Reporter**: co-creator, from a live #1314 Stop incident.
2. **Reproduction**: start a tracked execution, yield an `error` event with `errorDisposition: 'transient'`, hold the provider open, then query active executions or invoke member Stop. Before the fix the controller is already absent.
3. **Root cause**: outer route consumers conflated diagnostic `error` frames with terminal dispositions, despite the shared stream type and terminal collector distinguishing transient errors.
4. **Fix**: centralize the slot-terminal predicate as `done` or non-transient `error`, and use it at every `completeSlot` boundary.
5. **Verification**: message-route RED→GREEN, QueueProcessor ownership regression, routing-guard lifecycle tests, F295 active projection tests, then the repository full gate on the pushed PR head.
