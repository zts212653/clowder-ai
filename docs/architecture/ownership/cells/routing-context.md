---
cell_id: routing-context
title: Live Routing Context
summary: 在决策时组合 F208 applied capability revision、owner 条件偏好与带 freshness 的 cat/provider/provable-pool availability，并向 Workspace Team、invocation cognition 与 dispatch preflight 提供可解释 projection；不拥有 capability 更新、成员/runtime 配置、quota collection、provider telemetry、identity/session 或 dispatch execution。
description: F293 路由决策组合边界：持久 signal、版本化 preference、applied capability revision、Team/ledger read model、动态 cognition 与发送前 preflight；不接管 Workspace host、事实采集、画像更新或 dispatch。
description_source: model
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: 2026-08-09T06:14:42Z
description_confirmed_by: codex-sol
description_updated_at: 2026-09-02T04:45:00Z
doc_kind: architecture
created: 2026-08-08
canonical_features: [F293]
code_anchors:
  - packages/shared/src/types/routing-context.ts
  - packages/api/src/domains/routing-context/routing-context-reducer.ts
  - packages/api/src/domains/routing-context/RedisRoutingSignalEventStore.ts
  - packages/api/src/domains/routing-context/RedisRoutingPreferenceStore.ts
  - packages/api/src/domains/routing-context/DossierCapabilityProfileRevisionSource.ts
  - packages/api/src/domains/routing-context/RoutingContextResolver.ts
  - packages/api/src/domains/routing-context/RoutingPreflightService.ts
  - packages/api/src/domains/routing-context/RoutingSignalObservation.ts
  - packages/api/src/domains/routing-context/AutomaticRoutingSignalService.ts
  - packages/api/src/domains/routing-context/F051QuotaRoutingSignalAdapter.ts
  - packages/api/src/domains/routing-context/F153HealthRoutingSignalAdapter.ts
  - packages/api/src/domains/routing-context/RoutingDispatchSignalAdapter.ts
  - packages/api/src/domains/routing-context/RoutingDispatchSignalContract.ts
  - packages/api/src/domains/routing-context/RoutingContextRuntime.ts
  - scripts/lib/f293-routing-ownership-guard.mjs
doc_anchors:
  - docs/features/F293-live-routing-context.md
  - feature-discussions/2026-08-08-f293-live-routing-context-design/README.md
  - feature-discussions/2026-08-08-f293-live-routing-context-design/architecture-contract.md
  - docs/features/F051-real-quota-dashboard.md
  - docs/features/F153-observability-infra.md
  - docs/features/F203-native-system-prompt-l0.md
  - docs/features/F208-capability-profile-routing.md
  - docs/features/F248-eval-hub-human-readability.md
  - docs/features/F254-side-effect-freshness-gate.md
  - docs/features/F264-per-target-message-receipt.md
  - docs/features/F284-contextual-workspace-shell.md
  - feature-specs/2026-09-01-f293-phase-c-source-adapters.md
static_scan_hints: [CapabilityProfileRevisionRef, RoutingSignalEvent, RoutingPreference, RoutingContextSnapshot, RoutingPreflightDecision, RoutingContextResolver, RoutingContextPromptProjector, RoutingPreflightService, AutomaticRoutingSignalService, F051QuotaRoutingSignalAdapter, F153HealthRoutingSignalAdapter, RoutingDispatchSignalAdapter, routingDispatchPreflightDecision, routing_context_unavailable, review_due]
cited_by:
  - {feature: F293, date: 2026-08-08, delta: new cell candidate for owner-scoped live availability, versioned preference, dynamic cognition projection and per-target dispatch preflight}
  - {feature: F293, date: 2026-09-02, delta: Phase C adds narrow quota and health translation, durable dispatch feedback and shared owner-revision cache without moving source or execution ownership}
boundaries:
  owns:
    - owner-scoped immutable routing signal events and active projection semantics
    - versioned owner routing preferences with provenance
    - candidate explanation, alternatives and allowed/warned/rejected preflight decisions
    - sparse per-invocation cognition projection and shared F284 Team-mode/ledger/contextual routing view model
    - translation of canonical typed observations into immutable routing assertions and causal recoveries
    - routing signal owner-revision coherence and immutable timeline cache invalidation
  consumes:
    - F208 applied capability revisions and relevant evidence-backed signals
    - F051 canonical quota refresh evidence only when stable pool identity is present; route impact still requires a provable binding
    - F153 typed provider/runtime health observations with explicit subject authority
    - canonical durable dispatch terminals paired with the exact actual-send preflight decision
    - runtime catalog cat/provider bindings and thread-local routing overrides
  does_not_own:
    - capability dossier prose, proposal/apply lifecycle or model benchmark truth
    - member roster, account, model, carrier, alias or session/runtime configuration
    - quota collection or hidden account placement
    - provider telemetry collection
    - identity, session, queue, invocation or message delivery execution
    - TurnExecution terminal ownership, failure text classification beyond the closed stable routing classes, or delivery outcome mutation
    - Workspace host/chrome, current-thread Now surface or background focus navigation
    - silent target selection or opaque routing scores
last_reviewed: 2026-09-02
---

# Live Routing Context

F293 owns the decision-time composition layer between canonical source facts and existing dispatch execution.

Signals and global preferences are owner-scoped. They are not partitioned by project path because provider health and quota scarcity do not become healthy in another repository. The resolver intersects that truth with the current runtime catalog and candidate set.

The native L0 remains a stable, cached identity/governance surface. Dynamic routing exceptions are injected through a per-invocation cognition projection adjacent to the ADR-038 staging path, then independently re-read at the actual dispatch boundary.

Automatic source adapters do not own their input facts. They validate and translate only canonical F051 refreshes, explicitly scoped F153 observations and persisted TurnExecution terminals through `AutomaticRoutingSignalService`. They cannot append the event store directly, import another domain store, derive scope from hidden account identity or instantiate another resolver. The architecture guard ratchets those seams mechanically.

The resolver caches only immutable owner timelines under `RedisRoutingSignalEventStore.getOwnerRevision()`. A newly appended event increments the shared revision atomically; replay does not. Every resolve still re-runs time-sensitive reduction, so cache reuse never freezes expiry or derived availability.

`unavailable` may reject only when subject scope and active validity are proven. Advisory states never silently reroute. Resolver/store failure returns warned fail-open and an audit event so routing context cannot become a dispatch availability single point of failure.

The user-facing Team surface is a canonical F284 Workspace mode, not a sibling host or an expansion of the current-thread Now surface. Background routing changes update the shared read model and needs-you Activity only; explicit user navigation is required to open Team list or detail.
