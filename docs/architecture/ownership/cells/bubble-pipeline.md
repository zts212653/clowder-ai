---
cell_id: bubble-pipeline
title: Bubble Pipeline
summary: 前端消息气泡 identity、reducer single-writer、hydration、诊断与 cache invalidation。
canonical_features: [F183]
code_anchors:
  - packages/shared/src/types/bubble-pipeline.ts
  - packages/web/src/stores/bubble-reducer.ts
  - packages/web/src/stores/chatStore.ts
  - packages/web/src/hooks/useAgentMessages.ts
  - packages/web/src/debug/bubbleIdentity.ts
  - packages/web/src/debug/bubbleInvariantDiagnostics.ts
doc_anchors:
  - docs/features/F183-bubble-pipeline-architecture-consolidation.md
  - docs/decisions/033-bubble-pipeline-identity-contract.md
  - docs/features/assets/F183/fixture-schema.md
static_scan_hints: [BubbleEvent, bubbleKind, bubbleIdentity, BubbleReducer, useAgentMessages, chatStore, hydration, IndexedDB]
cited_by:
  - {feature: F191, date: 2026-05-07, delta: new cell}
---

# Bubble Pipeline

## Canonical Owner

F183 / ADR-033 own bubble identity and the single-writer reducer contract for frontend message rendering. This cell is the owner for `(catId, canonicalInvocationId, bubbleKind)` identity, BubbleEvent ingress, hydration merge, IDB fallback, and runtime invariant diagnostics.

## Use This When

- Adding a provider/origin that creates, streams, finalizes, hydrates, or restores frontend message bubbles.
- Changing `BubbleEvent`, `bubbleKind`, canonical invocation ID handling, placeholder upgrade, or hydration merge behavior.
- Touching `useAgentMessages`, `bubble-reducer`, `chatStore` message mutation paths, IDB message cache, or bubble diagnostics.

## Extend By

- Declare which `BubbleEvent` types a new provider emits, where canonical ID comes from, and which `bubbleKind` each event lands in.
- Route message mutations through the reducer/single-writer path before adding new direct store writes.
- Add replay fixtures or invariant tests when extending event kinds, placeholder recovery, or hydration behavior.
- Keep runtime diagnostics structured enough to identify duplicate stable identities and phase regression.

## Do NOT Unify With

- Do not put connector transport policy or platform-specific formatting in bubble identity. Transport owns delivery; bubble pipeline owns rendering identity.
- Do not let provider lifecycle IDs become frontend bubble identity. OUTER/canonical invocation ID wins; provider IDs are lifecycle metadata.
- Do not create new `messages` write entrances without a reducer event and invariant coverage.
- Do not use IndexedDB as online merge authority. It is a provisional/offline cache.

## Static Scan Hints

Watch for new or renamed `BubbleEvent`, `BubbleKind`, `bubbleKind`, `bubbleIdentity`, `BubbleReducer`, `useAgentMessages`, `chatStore`, `mergeReplaceHydrationMessages`, `IndexedDB`, `placeholder`, and direct `messages` mutations.
