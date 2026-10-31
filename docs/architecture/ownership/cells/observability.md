---
cell_id: observability
title: Observability — Runtime Telemetry and Invocation Trajectory
doc_kind: architecture
created: 2026-09-07
summary: Raw OTel telemetry (traces, metrics, health, redaction) owned by F153; the single human-facing invocation trajectory surface owned by F299; F150 tool-usage counters and F130 Pino logs keep their own independent stores and redaction and join only through existing correlation keys, never by copying events.
description: F153 OTel telemetry/health; F299 sole invocation surface; F150/F130 keep independent stores and redaction; join only by existing keys, never copy.
description_source: model
description_author: fable-5
description_generated_by: fable-5@claude-fable-5-1
description_generated_at: 2026-09-07T21:44:44Z
description_confirmed_by: fable-5
description_updated_at: 2026-09-07T21:44:44Z
canonical_features: [F153, F299, F150, F130]
code_anchors:
  - packages/api/src/infrastructure/telemetry/init.ts
  - packages/api/src/infrastructure/telemetry/instruments.ts
  - packages/api/src/infrastructure/telemetry/redactor.ts
  - packages/api/src/infrastructure/telemetry/metric-allowlist.ts
  - packages/api/src/infrastructure/telemetry/local-trace-store.ts
  - packages/api/src/infrastructure/telemetry/hydrate-traces.ts
  - packages/api/src/infrastructure/telemetry/tool-span-tracker.ts
  - packages/api/src/infrastructure/telemetry/metrics-snapshot-store.ts
  - packages/api/src/infrastructure/logger.ts
  - packages/api/src/routes/telemetry.ts
  - packages/api/src/routes/invocation-trajectory-routes.ts
  - packages/api/src/routes/tool-usage.ts
  - packages/web/src/components/HubObservabilityTab.tsx
  - packages/web/src/components/HubTraceTree.tsx
  - packages/web/src/components/workspace/trajectory/TrajectoryPanel.tsx
  - packages/web/src/components/workspace/trajectory/InvocationTrajectoryDetail.tsx
  - packages/web/src/components/workspace/RecentTrajectoryRecall.tsx
doc_anchors:
  - docs/features/F153-observability-infra.md
  - docs/features/F299-workspace-invocation-trajectory.md
  - docs/features/F150-tool-usage-stats.md
  - docs/features/F130-api-log-governance.md
  - feature-discussions/2026-09-07-architecture-consolidation/adjudication-draft.md
static_scan_hints: [TelemetryRedactor, MetricAttributeAllowlist, local-trace-store, hydrate-traces, tool-span-tracker, otel-logger, HubObservabilityTab, TraceBrowser, HubTraceTree, TrajectoryPanel, InvocationTrajectoryDetail, invocation-trajectory, "inv:", ToolUsageCounter, tool-stats, ToolEventLog, REDACT_PATHS]
cited_by:
  - {feature: F153, date: 2026-04-09, delta: raw telemetry, redaction, metrics, health and operator tab foundation}
  - {feature: F299, date: 2026-08-17, delta: invocation trajectory as the single human-facing surface; inv:<invocationId> join key}
  - {feature: F150, date: 2026-04-08, delta: independent tool-usage counter store; listed for owner visibility, no store or redaction transfer}
  - {feature: F130, date: 2026-03-20, delta: independent Pino log store and redaction; listed for owner visibility, no store or redaction transfer}
---

# Observability — Runtime Telemetry and Invocation Trajectory

## Canonical Owner

F153 owns raw runtime telemetry: OTel SDK init, instruments, the metric attribute
allowlist, four-class redaction, local trace store and hydration, tool span tracking,
metrics snapshots, `/ready`, the `/api/telemetry/*` routes, and the operator-facing
Hub observability tab (overview / traces / health / callback-auth diagnostics host).

F299 owns the single human-facing invocation surface: the Workspace `trajectory`
mode, the canonical-transcript projection with semantic cards, entry anchors in the
conversation, the trajectory inspector evidence adapter used by eval, and the only
cross-owner key `inv:<invocationId>`.

F150 tool usage statistics and F130 structured log governance are **independent
persistence paths with their own retention and redaction**, not projections of
F153: F150 writes Redis `tool-stats:{date}:{catId}:{category}:{toolName}` counters
from `ToolUsageCounter.recordToolUse()` (called on `tool_use` by `route-serial.ts`
and `route-parallel.ts`) and F188 keeps an append-only `ToolEventLog`; F130's
`infrastructure/logger.ts` is a Pino dual-write (stdout + rolling `api.log`) with its
own `REDACT_PATHS`, and `telemetry/otel-logger.ts` states that OTel emission does
not replace Pino. They are listed in this cell so their owner relation is visible,
not to move their stores; nobody may assume these facts are traceable from F153
alone. Raw telemetry, redaction policy, and health semantics never move into a
surface, and no surface stores copies of events.

Before this cell existed (2026-09-07), F153 was referenced by `harness-eval` and
`capability-evolution-control` as the raw telemetry owner without a cell of its own;
this cell records that owner relation. It was created by adjudication card 1 of the
2026-09-07 architecture consolidation and does not change any feature's scope.

## Use This When

- Adding or changing OTel instruments, spans, metric allowlist entries, redaction
  classes, trace storage or hydration, or `/ready` semantics.
- Adding or changing how a human reads what a cat did in one invocation: transcript
  projection, semantic cards, drill-down, `originRef` return.
- Adding a new observation surface that needs invocation- or trace-keyed evidence.
- Deciding where something belongs between Settings 运维监控 and Workspace 轨迹:
  operator configuration and service health belong to the F153 tab; per-invocation
  reading belongs to F299.

## Extend By

- Join, do not copy: new consumers read F153 traces/metrics or the F299 transcript
  projection by `inv:<invocationId>` or traceId. `TraceBrowser` already accepts
  `initialInvocationId`; reuse it for trajectory → trace drill-down instead of a new
  store.
- Keep redaction (classes A–D) at the F153 boundary; no surface re-derives raw prompt
  or credential content.
- Join F150 counters, F188 `ToolEventLog` entries or F130 log lines only where an
  existing correlation key (invocationId, traceId, threadId) is already present on
  both sides; do not backfill keys, re-emit their events through OTel, or route their
  redaction through the telemetry redactor to fake a single source.
- Trajectory changes preserve F299's disciplines: ledger before page, semantic before
  raw, entry at the conversation site.
- Operator-only concerns (OTel enablement, HMAC salt, `PROMPT_CAPTURE`, Prometheus /
  OTLP) stay in Settings 运维监控; per-invocation reading stays in Workspace.
- Historical features F008, F013 and F045 are referenced here for discovery only;
  their remaining code keeps its existing owners, and they are not reopened as new
  surfaces.

## Do NOT Unify With

- `ball-custody`: responsibility and custody ledgers are not telemetry. F233's feat
  trajectory failed-close (LL-099); do not rebuild a trajectory from a non-canonical
  ledger.
- `callback-auth`: credentials, principal and refresh. The Hub tab may host the
  diagnostics panel but does not own it.
- `harness-eval`: verdicts, measurement validity, Eval Hub. This cell provides evidence
  keys and never publishes verdicts. The `eval` sub-tab inside `HubObservabilityTab`
  is a duplicated entry slated for removal by adjudication card 2.
- `memory`: F188 memory health dashboard and F200 recall metrics stay in memory.
- `dispatch` and `bubble-pipeline`: the execution ledger and bubble projection are
  sources; trajectory reads them and does not replace them.
- `identity-session`: the `thread-access-policy` authority decides who may read
  sessions and transcripts; trajectory consumes it and never widens it.
- F150 `tool-stats` counters / F188 `ToolEventLog` and F130 Pino logs: independent
  stores, retention and redaction. They are not F153 projections and must not be
  re-homed into telemetry stores or redaction.

## Static Scan Hints

Watch for new trace or metric stores outside `packages/api/src/infrastructure/telemetry`,
transcript copies outside the F299 projection, surfaces minting their own invocation
ids, redaction bypasses, observability pages added under Settings without an `inv:` or
trace join, and Eval verdict rendering inside this cell. Also watch for prose or code
claiming that tool-usage counters or Pino logs derive from OTel telemetry,
`ToolUsageCounter` / `logger.ts` events re-emitted into telemetry stores, and
`REDACT_PATHS` changes routed through the telemetry redactor.
