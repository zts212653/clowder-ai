---
cell_id: transport
title: Transport Plane
summary: Raw transport 规范化之后的平台/设备消息入口、出口与对话语义；F254 在此边界保证 completed original 立即交付，supplement 作为后续 additive reply，未完成 legacy closure 才使用 catching-up/blocked。
canonical_features: [F088, F124, F254]
code_anchors:
  - packages/api/src/infrastructure/connectors/ConnectorRouter.ts
  - packages/api/src/infrastructure/connectors/ConnectorMessageFormatter.ts
  - packages/api/src/infrastructure/connectors/ConnectorCommandLayer.ts
  - packages/api/src/infrastructure/connectors/ConnectorThreadBindingStore.ts
  - packages/api/src/infrastructure/connectors/OutboundDeliveryHook.ts
  - packages/api/src/infrastructure/connectors/StreamingOutboundHook.ts
  - packages/shared/src/types/connector.ts
  - packages/shared/src/types/cross-thread-coordination.ts
  - packages/api/src/routes/cross-thread-coordination.ts
  - packages/api/src/routes/callbacks.ts
  - packages/api/src/infrastructure/websocket/SocketManager.ts
  - packages/web/src/hooks/useSocket-cancel-provenance.ts
  - packages/mcp-server/src/tools/callback-tools.ts
doc_anchors:
  - docs/features/F088-multi-platform-chat-gateway.md
  - docs/features/assets/F124/f124-f088-architecture-unification-draft.md
  - docs/features/F254-side-effect-freshness-gate.md
  - docs/decisions/041-freshness-catch-closure-output-commit.md
  - docs/decisions/042-glass-box-delivery-semantics.md
static_scan_hints: [ConnectorRouter, MessageEnvelope, Adapter, BindingStore, OutboundDeliveryHook, StreamingOutboundHook, onClosureCatchingUp, onClosureBlocked, published_with_unseen, supplement_declined, OutputCommitDecision]
cited_by:
  - {feature: F191, date: 2026-05-07, delta: new cell}
  - {feature: F193, date: 2026-05-07, delta: cross_post_message becomes first-class with targetCats routing + AC-A4 cross-post fail-closed when no routing creds}
  - {feature: F193, date: 2026-06-03, delta: "Phase E defines SuggestedCrossPostAction as the structured affordance contract for discovery tools"}
  - {feature: F254-Phase-E, date: 2026-07-09, delta: connector output is receipt-only before commit; known-stale drafts are withheld and one placeholder is reused for catching-up, blocked, or fresh-final projection}
  - {feature: F167-Phase-R, date: 2026-07-10, delta: cross_post_message carries stable coordination identity and explicit terminal phase; direct terminal ACK is persisted without A2A enqueue}
  - {feature: F254-v1.2, date: 2026-07-11, delta: reject unattributed/duplicate cancel packets and stratify cross-thread freshness by typed causal overlap instead of destination unseen alone}
  - {feature: F254-ADR-042, date: 2026-07-12, delta: committed_fresh, degraded_unknown, and published_with_unseen are all deliverable; freshness never turns a completed connector answer back into a receipt/catching-up placeholder}
---

# Transport Plane

## Canonical Owner

F088 owns third-party chat platform transport: adapter parsing, platform-neutral command semantics, sender/thread binding, message formatting, and outbound delivery.

F124 clarifies the first-party device boundary: native clients should reuse normalized conversation semantics, not the third-party connector adapter shape.

F254 / ADR-042 constrains answer delivery at this boundary: a connector may acknowledge receipt while an answer is still incomplete, but every completed answer decision (`committed_fresh`, `committed_degraded_unknown`, `published_with_unseen`) is deliverable immediately. Freshness metadata never demotes it to catching-up. A produced supplement is delivered later as another committed reply; declined/failed status remains Hub/history metadata. ADR-041 catching-up/blocked hooks survive only for unfinished legacy closures. Post-commit transport retries remain F088 responsibility and never reopen either lifecycle.

F254 v1.2 also owns two transport attribution guards: browser cancel must carry connected-client provenance (`origin`, `actionId`, `clientInstanceId`) and the server rejects unattributed or duplicate packets; cross-thread freshness catch-up is stratified by `effectClass` and typed causal overlap (`coordinationId` / reply lineage), so a FYI messenger is not forced to read an unrelated destination backlog.

F167 Phase R owns the internal cross-thread coordination lifecycle at this boundary: invocation-token relays may carry `{id, phase, hop}` in message provenance. Active hops inherit identity; terminal is delivered once; a direct courtesy ACK after terminal is stored without creating another A2A invocation. This guard is structural and must not infer Claim/Release/ACK from free text.

## Use This When

- Adding or changing an IM connector such as Feishu, Telegram, WeChat, Slack, or a similar external chat platform.
- Changing `MessageEnvelope`, connector command semantics, connector dedup, connector thread binding, or outbound delivery behavior.
- Adding first-party device metadata such as `source` or `deviceContext` after raw input is normalized into a canonical user message.
- Changing connector receipt/catching-up/blocked projection, published-with-unseen delivery, supplement reply delivery, or filtering by `OutputCommitDecision`.
- Changing `cross_post_message` coordination identity, terminal transition, or terminal ACK enqueue suppression.
- Changing cancel provenance/dedup or cross-thread effect-class freshness behavior.

## Extend By

- Add or update an adapter under `packages/api/src/infrastructure/connectors/adapters/` for platform-specific protocol work.
- Reuse `ConnectorRouter` for platform-neutral routing, binding, dedup, command handling, and invocation handoff.
- Reuse `ConnectorMessageFormatter` and outbound hooks for replies instead of writing connector-specific final delivery paths.
- For first-party clients, align request fields and canonical message semantics with this cell without forcing the request through `ConnectorRouter`.
- Keep incomplete provider output receipt-only. Deliver every completed published decision; reserve `onClosureCatchingUp` / `onClosureBlocked` for unfinished legacy closure work, never for `published_with_unseen`.
- Emit browser cancel only from an explicit connected-client action with stable action/client IDs; do not rely on reconnect-buffered Socket.IO delivery as user intent.
- Use typed causal identity for cross-thread catch-up. Keyword/entity similarity may inform a warning but cannot decide HOLD.

## Do NOT Unify With

- Do not fold Action Plane operations into connector adapters. Enterprise actions belong to `action-plane`.
- Do not treat raw device transport as connector transport. Watch/iOS audio capture, local haptics, and native REST state are device edge concerns until normalized.
- Do not rename first-party active-thread state as F088 Session Binding. F088 binding is `externalChatId <-> internalThreadId`; native clients do not have that external mapping problem.
- Do not push bubble identity or frontend rendering hints into `MessageEnvelope`; bubble ownership belongs to `bubble-pipeline`.
- Do not regenerate an answer after a committed message merely because transport delivery failed; F088 retries delivery of the existing message truth.
- Do not suppress a completed original while waiting for, declining, or failing an automatic supplement.
- Do not use free-text intent classification to decide whether a cross-thread relay is terminal; callers select phase explicitly and the server reads persisted provenance.

## Static Scan Hints

Watch for new or renamed `ConnectorRouter`, `MessageEnvelope`, `Adapter`, `BindingStore`, `OutboundDeliveryHook`, `StreamingOutboundHook`, `CrossThreadCoordination`, `resolveCrossThreadCoordination`, `cancel_invocation`, `clientInstanceId`, `actionId`, `coordinationId`, `effectClass`, `onClosureCatchingUp`, `onClosureBlocked`, `published_with_unseen`, `supplement_declined`, `OutputCommitDecision`, `sendReply`, `sendFormattedReply`, and `sendMedia` implementations.
