---
cell_id: identity-session
title: Identity / Session
summary: Agent identity、connector session binding、bubble identity 三个 subcell 的边界。
canonical_features: [F032, F088, F183]
code_anchors:
  - cat-config.json
  - packages/api/src/config/cat-config-loader.ts
  - packages/shared/src/types/cat.ts
  - packages/api/src/infrastructure/connectors/ConnectorThreadBindingStore.ts
  - packages/api/src/infrastructure/connectors/connector-binding-keys.ts
  - packages/api/src/routes/thread-cats-core.ts
  - packages/web/src/debug/bubbleIdentity.ts
doc_anchors:
  - docs/features/F032-agent-plugin-architecture.md
  - docs/features/F088-multi-platform-chat-gateway.md
  - docs/decisions/033-bubble-pipeline-identity-contract.md
static_scan_hints: [catId, AgentRegistry, cat-config, roster, ConnectorThreadBindingStore, bubbleIdentity, session]
cited_by:
  - {feature: F191, date: 2026-05-07, delta: new cell}
  - {feature: F193, date: 2026-05-08, delta: Phase B — typed crossThreadReplyHint field on InvocationContext + render block in buildInvocationContext (receiver-side reply hint hydrated from trigger message id)}
  - {feature: F209, date: 2026-05-22, delta: "boundary note — F209 entity_id is a retrievable entity doorway, not roster truth"}
---

# Identity / Session

## Canonical Owner

This is a top-level routing cell with three subcells. It exists to prevent identity concerns from becoming a garbage bin.

- `identity-agent`: F032 owns dynamic CatId, roster, AgentRegistry, roles, and reviewer matching.
- `identity-connector`: F088 owns connector principal link and external chat/thread binding.
- `identity-bubble`: F183 / ADR-033 own frontend bubble identity within a thread.

F209's entity registry is adjacent but not canonical for agent identity. Its `entity_id` / aliases are retrievable memory anchors with provenance; they may point to cats, humans, features, or external concepts, but they do not decide roster membership, current model, role, reviewer eligibility, or who a cat is.

## Use This When

- Changing who a cat is, how cats are loaded from roster/config, or how cat IDs are validated.
- Changing connector user/chat/thread binding, connector permission ownership, or external sender mapping.
- Changing frontend bubble identity, canonical invocation ID, or bubble kind identity rules.

## Extend By

- For agent identity, update roster/config/schema contracts and keep CatId runtime-dynamic.
- For connector binding, use `ConnectorThreadBindingStore` and connector binding keys instead of ad hoc thread maps.
- For bubble identity, follow ADR-033 and route through `bubble-pipeline` contracts and tests.
- When a feature touches more than one subcell, declare each one in the feature's Architecture cell note and explain the boundary.
- If a feature consumes F209 `entity_id`, keep the direction one-way: identity/session truth may be referenced as provenance for entity aliases, but entity aliases must not rewrite roster or connector bindings.

## Do NOT Unify With

- `identity-agent` is not `identity-connector`. A roster cat ID does not prove an external user owns a connector binding.
- `identity-connector` is not `identity-bubble`. External chat/thread binding does not decide frontend bubble grouping.
- `identity-bubble` is not `identity-agent`. Bubble identity uses `(catId, canonicalInvocationId, bubbleKind)` inside a thread; it is not the source of roster truth.
- F209 `entity_id` is not `identity-agent`. Entity aliases such as `landy` / `CVO` / `铲屎官` or `gemini` / `Siamese` are retrieval anchors, not roster truth.
- `ConnectorThreadBindingStore` is an intentional shared touchpoint with `transport`: transport uses it for routing, while `identity-connector` uses it as the binding contract. Shared file ownership does not merge the cells.
- Do not add a generic `IdentityStore` to cover all three. Shared vocabulary is not shared ownership.

## Static Scan Hints

Watch for new or renamed `catId`, `CatId`, `AgentRegistry`, `cat-config`, `roster`, `ReviewerMatcher`, `ConnectorThreadBindingStore`, `Binding`, `bubbleIdentity`, `canonicalInvocationId`, `session`, and agent-facing `entity_id` code.
