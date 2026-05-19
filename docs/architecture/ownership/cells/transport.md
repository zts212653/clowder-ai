---
cell_id: transport
title: Transport Plane
summary: Raw transport 规范化之后的平台/设备消息入口、出口与对话语义。
canonical_features: [F088, F124]
code_anchors:
  - packages/api/src/infrastructure/connectors/ConnectorRouter.ts
  - packages/api/src/infrastructure/connectors/ConnectorMessageFormatter.ts
  - packages/api/src/infrastructure/connectors/ConnectorCommandLayer.ts
  - packages/api/src/infrastructure/connectors/ConnectorThreadBindingStore.ts
  - packages/api/src/infrastructure/connectors/OutboundDeliveryHook.ts
  - packages/api/src/infrastructure/connectors/StreamingOutboundHook.ts
  - packages/shared/src/types/connector.ts
doc_anchors:
  - docs/features/F088-multi-platform-chat-gateway.md
  - docs/features/assets/F124/f124-f088-architecture-unification-draft.md
static_scan_hints: [ConnectorRouter, MessageEnvelope, Adapter, BindingStore, OutboundDeliveryHook]
cited_by:
  - {feature: F191, date: 2026-05-07, delta: new cell}
  - {feature: F193, date: 2026-05-07, delta: cross_post_message becomes first-class with targetCats routing + AC-A4 cross-post fail-closed when no routing creds}
---

# Transport Plane

## Canonical Owner

F088 owns third-party chat platform transport: adapter parsing, platform-neutral command semantics, sender/thread binding, message formatting, and outbound delivery.

F124 clarifies the first-party device boundary: native clients should reuse normalized conversation semantics, not the third-party connector adapter shape.

## Use This When

- Adding or changing an IM connector such as Feishu, Telegram, WeChat, Slack, or a similar external chat platform.
- Changing `MessageEnvelope`, connector command semantics, connector dedup, connector thread binding, or outbound delivery behavior.
- Adding first-party device metadata such as `source` or `deviceContext` after raw input is normalized into a canonical user message.

## Extend By

- Add or update an adapter under `packages/api/src/infrastructure/connectors/adapters/` for platform-specific protocol work.
- Reuse `ConnectorRouter` for platform-neutral routing, binding, dedup, command handling, and invocation handoff.
- Reuse `ConnectorMessageFormatter` and outbound hooks for replies instead of writing connector-specific final delivery paths.
- For first-party clients, align request fields and canonical message semantics with this cell without forcing the request through `ConnectorRouter`.

## Do NOT Unify With

- Do not fold Action Plane operations into connector adapters. Enterprise actions belong to `action-plane`.
- Do not treat raw device transport as connector transport. Watch/iOS audio capture, local haptics, and native REST state are device edge concerns until normalized.
- Do not rename first-party active-thread state as F088 Session Binding. F088 binding is `externalChatId <-> internalThreadId`; native clients do not have that external mapping problem.
- Do not push bubble identity or frontend rendering hints into `MessageEnvelope`; bubble ownership belongs to `bubble-pipeline`.

## Static Scan Hints

Watch for new or renamed `ConnectorRouter`, `MessageEnvelope`, `Adapter`, `BindingStore`, `OutboundDeliveryHook`, `StreamingOutboundHook`, `sendReply`, `sendFormattedReply`, and `sendMedia` implementations.
