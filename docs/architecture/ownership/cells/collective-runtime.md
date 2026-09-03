---
cell_id: collective-runtime
title: Collective Runtime
summary: Independent Collective Service identity, Human auth binding and membership, endpoint pairing, canonical client, durable ordered Channel events, Host ingress, replay/ACK and verifiable Clowder AI Agent provenance boundary.
description: Independent Collective Service, auth-bound Humans, canonical client, official Connector, Host ingress, durable order/replay/ACK, and Agent provenance.
description_source: model
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: 2026-08-29T07:06:24Z
description_confirmed_by: codex-sol
description_updated_at: 2026-08-29T18:45:00-07:00
doc_kind: architecture
created: 2026-08-28
canonical_features: [F290]
code_anchors:
  - packages/shared/src/types/collective.ts
  - packages/collective-service/src/store.ts
  - packages/collective-service/src/identity-store.ts
  - packages/collective-service/src/github-human-auth-provider.ts
  - packages/collective-service/src/http-server.ts
  - packages/collective-service/src/http-router.ts
  - packages/collective-client/src/CollectiveClient.tsx
  - packages/collective-connector/src/connector.ts
  - packages/collective-connector/src/persistence.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-connector-runtime.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-ingress-dispatcher.ts
  - packages/api/src/domains/plugin/builtin-runtime/collective-agent-verifier.ts
  - packages/api/src/routes/collective-connector-routes.ts
  - packages/web/src/components/collective/CollectiveLaunchSurface.tsx
doc_anchors:
  - docs/features/F290-ai-native-collective.md
  - feature-specs/2026-08-28-f290-collective-runtime-vertical.md
  - feature-specs/2026-08-29-f290-collective-vision-correction.md
static_scan_hints: [CollectiveServiceStore, HumanAuthBinding, serviceInstanceId, collectiveId, connectionId, CollectiveConnector, CollectiveIngressDispatcher, pairingIntent, endpointCredential, canonical order, lastAckedSequence, Agent provenance, CollectiveLaunchSurface]
cited_by:
  - {feature: F290, date: 2026-08-28, delta: new cell — first independent Service + canonical Client + official Connector runtime vertical}
---

# Collective Runtime

## Canonical Owner

F290 owns the cross-Café world truth implemented by the independent Collective Service: immutable Service
identity, one-time owner bootstrap, Human auth bindings/sessions, memberships and invitations, endpoint connection authority,
per-Collective ordered events, delivery cursor/ACK validation, and the canonical browser client served from the
Service origin. The Service persists these objects without Redis and remains independently deployable from Cat
Café runtime ports and lifecycle.

Bootstrap creates an identity-limited initial owner session that may establish only the first Collective and
steward, breaking the self-host provider-configuration cycle. A provider-authenticated Human binding is required
before invitations, pairing or ordinary messaging. Provider subjects remain adapter keys; the stable domain
identity is the Service-generated `humanId`.

The official Collective Connector is the Clowder AI endpoint adapter. It owns Host-side endpoint credential
custody, durable outbox/inbox, reconnect, replay, ACK, Host-route disposition and revoke. It may turn a Clowder AI
Agent into a structured extension of the connection-bound Human only after Host verification of a known `catId`
and a durable invocation execution receipt. Agent targets are mapped explicitly to local Cats/Threads; their
Collective Agent IDs need not equal local Cat IDs. It does not grant Agent/tool permissions, authenticate Humans,
or start the Service.

Clowder AI `/collective` is a launch surface around the Service client, not a second Collective product. Direct
Web and embedded entry share the same Service build and state. The launch surface may show redacted Host
connection health and pairing/revoke controls; Channel, identity and membership remain Service-owned.

## Use This When

- Changing Service/Collective/connection stable identifiers or coordinate-bearing DTOs.
- Adding Human bootstrap/auth binding, membership, invite, endpoint pairing/revocation or Service session behavior.
- Changing Channel event order, idempotency, delivery replay, inbox/outbox durability or ACK semantics.
- Changing direct/embedded canonical client behavior or Clowder AI Collective launch/pairing controls.
- Adding a Service-routed Cat Agent signal, typed target, Host ingress route or endpoint/session provenance.

## Extend By

- Preserve `serviceInstanceId`, `collectiveId` and `connectionId` across wire, store and projection even when a
  v1 UI presents one connection.
- Let the Service construct actors from authenticated Human or endpoint context; reject caller-nominated
  provenance and cross-coordinate payloads.
- Keep endpoint credential, provider subject and `humanId` as separate authorities. Agent Service permission is
  the bound Human membership; Agent identity adds provenance and Host routing, never a second login.
- Persist event acceptance/order atomically, outbox before send and inbox before ACK. Retry using the same
  scoped client event ID and never equate delivery with Agent action.
- Keep Service, Host Connector and browser client auth subjects separate. Route typed targets only through
  owner-authored Host config; never infer a local Cat or Thread from a remote identifier. Remove endpoint credentials locally
  only after Service revoke succeeds or returns canonical already-revoked truth.
- Add future multi-Service/federation or production identity behind these stable boundaries; do not retrofit UI
  route identity into stored coordinates.

## Do NOT Unify With

- Do not merge Service lifecycle into the `plugin` cell. Plugin inventory controls Connector installation and
  activation only; the Service is not a plugin child process.
- Do not merge with F307 Workbench layout/tab/restore or create a second Collective Workbench inside Clowder AI.
- Do not absorb F309 content anchors, annotation/patch mechanics, Office/media editors or canonical content.
- Do not let Service signals invoke Clowder AI Agents/tools or treat an ACK as evidence that an Agent acted.
- Do not use Clowder AI Redis `6399`, runtime ports `3003/3004`, fixture-only pages or prompt-derived fake Agents.

## Static Scan Hints

Watch new/renamed `CollectiveServiceStore`, `CollectiveConnector`, `CollectiveLaunchSurface`, pairing intent and
endpoint credential code, coordinate DTOs, event sequence allocation, `lastAckedSequence`, outbox/inbox state,
Agent provenance construction, Service child-process launch, Redis imports and duplicated Channel clients.
