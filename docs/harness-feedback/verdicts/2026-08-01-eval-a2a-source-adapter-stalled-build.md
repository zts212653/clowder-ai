---
feature_ids: [F192, F167]
topics: [harness-eval, eval-a2a, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: 2026-08-01-eval-a2a-source-adapter-stalled-build
source_snapshot: "snapshot:bundle/2026-08-01-eval-a2a-source-adapter-stalled-build/snapshot"
---

# Live Verdict — 2026-08-01-eval-a2a-source-adapter-stalled-build

- Verdict: `build`
- Phenomenon: Live F167 metrics, history, traces, process-info, and grounding endpoints are now reachable with a 36.17h counter window, but four delivered eval:a2a cycles since 2026-07-28 produced no automatic snapshot/attribution source pair or verdict. The same window also shows two of two route spans failing on the stale opus-47 cat ID, while grounding shadow telemetry has zero observations and cannot support fail-closed escalation.
- Harness: F167/f167-runtime-eval-source-adapter (F167 daily runtime eval source adapter)
- Owner ask: Build the eval:a2a source-adapter stage into eval-domain-daily: collect live telemetry, generate and persist the sanitized F167 snapshot/attribution pair, pass their basenames into the invocation context, and validate publish from a git-backed repo. In the same ownership cell, replace stale opus-47 evalCat/ownerCatId registry entries with an active cat.
- Re-eval: The next scheduled eval:a2a cycle automatically creates one matched snapshot/attribution source pair before cat invocation, supplies both basenames in context, publishes a clean evidence PR from a git-backed repo, records no Unknown cat ID route failure, and reports grounding counters/samples or an explicit no-stateful-call observation without treating zero mismatches as healthy distribution evidence. at 2026-08-02T03:00:00Z

Evidence:
- snapshot:bundle/2026-08-01-eval-a2a-source-adapter-stalled-build/snapshot
- attribution:bundle/2026-08-01-eval-a2a-source-adapter-stalled-build/AR-2026-08-01-001
- metric:counter_window.duration_hours=36.170368095405
- metric:scheduled_cycle_count=4
- metric:source_pair_count=0
- metric:grounding.check_total=0
- metric:grounding.verdict_total=0
- metric:grounding.mismatch_sample_count=0
- metric:route.error_count=2
- metric:route.total_cats_invoked=0
- metric:legacy_scheduled_task_count=0
- trace:metadata/thread_eval_a2a/2026-08-01T03:00:00Z/route-spans-2

Counterarguments:
- The A2A behavioral counters themselves are quiet and show no L1/C1/C2 friction in the available 5.99h history, so this is a source-pipeline build finding rather than evidence that those guards are malfunctioning.
- The two opus-47 trace errors were emitted by sibling eval-domain routes and are secondary evidence of registry drift, not the sole cause of eval:a2a source generation failure.
- A manually produced source pair can unblock this publication once, but it does not satisfy the daily harness contract or day-over-day persistence requirement.
