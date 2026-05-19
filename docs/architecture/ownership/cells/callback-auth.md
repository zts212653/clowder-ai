---
cell_id: callback-auth
title: Callback Auth
summary: Invocation credential、callback token 验证、refresh、telemetry 与现场 auth failure 可见性。
canonical_features: [F174]
code_anchors:
  - packages/api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts
  - packages/api/src/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.ts
  - packages/api/src/domains/cats/services/agents/invocation/MemoryAuthInvocationBackend.ts
  - packages/api/src/routes/callback-auth-prehandler.ts
  - packages/api/src/routes/callback-auth-schema.ts
  - packages/api/src/routes/callback-auth-telemetry.ts
  - packages/api/src/routes/callback-auth-system-message.ts
  - packages/shared/src/types/callback-auth-reasons.ts
doc_anchors:
  - docs/features/F174-callback-auth-lifecycle.md
static_scan_hints: [InvocationRegistry, callbackToken, callback-auth, AuthFailureReason, refresh-token, callback auth]
cited_by:
  - {feature: F191, date: 2026-05-07, delta: new cell}
  - {feature: F193, date: 2026-05-07, delta: KD-1 principal-conditioned threadId enforcement (post_message vs cross_post_message contract reconcile)}
---

# Callback Auth

## Canonical Owner

F174 owns callback credential lifecycle: invocation ID, callback token, verification result reasons, Redis-backed registry, refresh endpoint, telemetry, and user-visible callback auth failure surfaces.

## Use This When

- Changing callback credentials, token TTL, token refresh, registry persistence, auth failure reasons, or callback auth prehandlers.
- Adding a callback route that needs invocation credentials, callback principal extraction, or structured auth failure handling.
- Changing callback auth telemetry, system messages, Hub callback auth panels, or fallback behavior for auth failure.

## Extend By

- Use shared callback auth prehandlers and typed `AuthFailureReason` values instead of local 401 string matching.
- Store invocation credentials through `InvocationRegistry` and auth backends rather than route-local maps.
- Emit structured telemetry/reasons before building UI or fallback behavior.
- Reuse callback principal helpers and scoped callback routes for new tools.

## Do NOT Unify With

- Do not treat callback auth as general session identity. It is per-invocation credentialing, not roster identity or connector binding.
- Do not hide callback auth failures behind generic tool errors; failures must keep structured reasons.
- Do not add tool-specific token stores unless F174 cannot represent the lifecycle.
- Do not make retry/outbox a substitute for auth design. Retry handles transient transport/server failures; callback auth failures need explicit reasons and refresh/fallback paths.

## Static Scan Hints

Watch for new or renamed `InvocationRegistry`, `callbackToken`, `x-callback-token`, `callback-auth`, `AuthFailureReason`, `refresh-token`, `verify`, `missing_creds`, `invalid_token`, `expired`, and route-local credential checks.
