---
cell_id: callback-auth
title: Callback Auth
summary: Invocation credential、persistent agent-key、callback principal 验证、refresh、telemetry 与现场 auth failure 可见性。
canonical_features: [F174, F178]
code_anchors:
  - packages/api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts
  - packages/api/src/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.ts
  - packages/api/src/domains/cats/services/agents/invocation/MemoryAuthInvocationBackend.ts
  - packages/api/src/routes/callback-auth-prehandler.ts
  - packages/api/src/routes/callback-auth-schema.ts
  - packages/api/src/routes/callback-auth-telemetry.ts
  - packages/api/src/routes/callback-auth-system-message.ts
  - packages/api/src/domains/cats/services/agents/agent-key/AgentKeyRegistry.ts
  - packages/api/src/domains/cats/services/agents/agent-key/AgentKeySidecarProvisioner.ts
  - packages/api/src/domains/cats/services/agents/agent-key/AgentKeySidecarRenewalLoop.ts
  - packages/shared/src/types/callback-auth-reasons.ts
doc_anchors:
  - docs/features/F174-callback-auth-lifecycle.md
  - docs/features/F178-persistent-mcp-agent-key-auth.md
static_scan_hints: [InvocationRegistry, AgentKeyRegistry, AgentKeySidecarProvisioner, callbackToken, agent-key, callback-auth, AuthFailureReason, refresh-token, callback auth]
cited_by:
  - {feature: F191, date: 2026-05-07, delta: new cell}
  - {feature: F193, date: 2026-05-07, delta: KD-1 principal-conditioned threadId enforcement (post_message vs cross_post_message contract reconcile)}
  - {feature: F178, date: 2026-08-08, delta: persistent agent-key registry and sidecar lifecycle ownership}
  - {feature: F247, date: 2026-08-08, delta: gpt-pro principal reconciliation and health probe}
---

# Callback Auth

## Canonical Owner

F174 owns invocation callback credential lifecycle: invocation ID, callback token, verification result reasons, Redis-backed registry, refresh endpoint, telemetry, and user-visible callback auth failure surfaces. F178 owns the separate persistent `agent_key` principal, including registry TTL/rotation/revocation and the canonical sidecar reconciliation lifecycle. Provider-specific features such as F247 consume that lifecycle rather than minting or validating credentials ad hoc.

## Use This When

- Changing callback credentials, token TTL, token refresh, registry persistence, auth failure reasons, or callback auth prehandlers.
- Changing persistent agent-key TTL, rotation/revocation, sidecar publication/renewal, or authenticated principal probes.
- Adding a callback route that needs invocation credentials, callback principal extraction, or structured auth failure handling.
- Changing callback auth telemetry, system messages, Hub callback auth panels, or fallback behavior for auth failure.

## Extend By

- Use shared callback auth prehandlers and typed `AuthFailureReason` values instead of local 401 string matching.
- Store invocation credentials through `InvocationRegistry` and auth backends rather than route-local maps.
- Emit structured telemetry/reasons before building UI or fallback behavior.
- Reuse callback principal helpers and scoped callback routes for new tools.
- Reconcile file-backed agent keys through `AgentKeySidecarProvisioner`; file existence alone is not credential health.

## Do NOT Unify With

- Do not treat callback auth as general session identity. It is per-invocation credentialing, not roster identity or connector binding.
- Do not hide callback auth failures behind generic tool errors; failures must keep structured reasons.
- Do not add tool-specific token stores unless F174 cannot represent the lifecycle.
- Do not let provider lifecycle scripts write agent-key sidecars directly or equate a present secret file with a live registry record.
- Do not make retry/outbox a substitute for auth design. Retry handles transient transport/server failures; callback auth failures need explicit reasons and refresh/fallback paths.

## Static Scan Hints

Watch for new or renamed `InvocationRegistry`, `AgentKeyRegistry`, `AgentKeySidecarProvisioner`, `callbackToken`, `x-callback-token`, `x-agent-key-secret`, `callback-auth`, `AuthFailureReason`, `refresh-token`, `verify`, `missing_creds`, `invalid_token`, `agent_key_unknown`, `expired`, and route-local credential checks.
