---
cell_id: bubble-pipeline
title: Bubble Pipeline
summary: 前端消息气泡 identity、reducer single-writer、hydration、诊断、cache invalidation、typed ordinary/routing-guard/supplement execution projection、F254 freshness/supplement 投影，以及 F264 原消息上的 durable per-target receipt 与整条 lineage 导航。
canonical_features: [F177, F183, F254, F264]
code_anchors:
  - packages/shared/src/types/bubble-pipeline.ts
  - packages/shared/src/types/turn-execution.ts
  - packages/web/src/stores/bubble-reducer.ts
  - packages/web/src/stores/chatStore.ts
  - packages/web/src/hooks/useAgentMessages.ts
  - packages/web/src/hooks/useChatHistory.ts
  - packages/web/src/debug/bubbleIdentity.ts
  - packages/web/src/debug/bubbleInvariantDiagnostics.ts
  - packages/web/src/hooks/useSocket.ts
  - packages/web/src/components/ChatMessage.tsx
  - packages/web/src/components/MessageReceiptDock.tsx
  - packages/web/src/components/ConnectorBubble.tsx
doc_anchors:
  - docs/features/F295-cancelable-execution-projection.md
  - docs/features/F177-harness-update.md
  - docs/features/F183-bubble-pipeline-architecture-consolidation.md
  - docs/decisions/033-bubble-pipeline-identity-contract.md
  - docs/features/assets/F183/fixture-schema.md
  - docs/features/F254-side-effect-freshness-gate.md
  - docs/decisions/041-freshness-catch-closure-output-commit.md
  - docs/decisions/042-glass-box-delivery-semantics.md
  - docs/features/F264-per-target-message-receipt.md
  - docs/features/F278-paw-feel-disposition-inbox.md
  - feature-specs/2026-07-16-f177-f254-f264-child-execution-truth.md
  - feature-specs/2026-07-31-f264-terminal-consumption-receipt.md
  - feature-specs/2026-08-04-f264-author-declared-message-disposition.md
  - feature-specs/2026-08-13-1291-gate6-live-terminal-receipt-consumption.md
static_scan_hints: [BubbleEvent, bubbleKind, bubbleIdentity, BubbleReducer, useAgentMessages, useChatHistory, useSocket, queue_updated, QueueMessageReceipt, QueueMessageReceiptProjection, messageReceipts, TurnExecutionMessageProjection, executionKind, routing_guard, freshness_supplement, auxiliaryTurnExecutions, system-routing-guard, freshness_closure, MessageReceiptDock, seenAt, handledAt, evidenceRef, lineage, closureId, supplementId, originalMessageId, sourceInvocationId, chatStore, hydration, IndexedDB]
cited_by:
  - {feature: F295, date: 2026-08-13, delta: a managed-command hold bubble consumes the same execution projection and exact taskId cancel target as thread/workspace running chrome; message identity and hold lifecycle ownership remain unchanged}
  - {feature: F177-F254-F264-child-execution-truth, date: 2026-07-16, delta: live and F5 consume one typed child identity projection; routing guards render as system-assisted execution without copied prose, supplements remain distinct replies, and receipt timing separates body-read from terminal handling}
  - {feature: F191, date: 2026-05-07, delta: new cell}
  - {feature: F254-Phase-E, date: 2026-07-09, delta: explicit freshness_closure projection removes the stale source bubble by identity and exposes one catching-up/blocked state until the fresh final commits}
  - {feature: F254-v1.2, date: 2026-07-11, delta: projection keys exact turnInvocationId + originTriggerMessageId and exposes typed formal outcome so live draft visibility cannot impersonate commit}
  - {feature: F254-ADR-042, date: 2026-07-12, delta: original bubble is never removed; exact supplement lifecycle projects onto it, while produced supplements render as normal timestamped replies with lineage provenance}
  - {feature: F264, date: 2026-07-15, delta: the original user bubble renders persistent per-target receipt truth; evidence navigation highlights the whole loaded invocation lineage including supplements without moving messages or copying replies}
  - {feature: F278, date: 2026-07-26, delta: the exact original cat message may render a source-ref disposition projection while the marker body remains canonical and is never copied into the control-plane ledger}
  - {feature: F264-terminal-consumption, date: 2026-07-31, delta: the original cross-thread message renders delivered, exact-child awakened, body-read, unsettled, and typed terminal-silent per-target states; an empty final stays system receipt only and never creates a cat bubble}
  - {feature: F264-author-disposition, date: 2026-08-04, delta: composer exposes inherited current-work/next-work intent only while a live target makes the choice meaningful; the original message receipt distinguishes requested current work, durable fallback, exact exposure, and outcome without moving or copying bodies}
  - {feature: F280-Gate-6, date: 2026-08-13, delta: the existing queue_updated store transition consumes dispatch-owned messageReceipts beside the Queue snapshot, so an exact authored bubble reaches terminal withdrawn truth immediately even when no actionable row survives; history hydration remains the same canonical DTO}
---

# Bubble Pipeline

## Canonical Owner

F183 / ADR-033 own bubble identity and the single-writer reducer contract for frontend message rendering. This cell owns `(catId, canonicalInvocationId, bubbleKind)` identity, BubbleEvent ingress, hydration merge, IDB fallback, and diagnostics. Each visible cat body may carry one immutable `TurnExecutionMessageProjection`: ordinary replies remain visually ordinary, `routing_guard` is labeled “系统补路由”, and `freshness_supplement` is labeled as a later-message supplement. When a guard only assists preserved first-pass prose, it is attached as `auxiliaryTurnExecutions` to that original bubble and never creates or copies a second body. Terminal lifecycle remains in the ledger glass-box API. Under ADR-042, the published original remains ordinary MessageStore truth. A supplement lifecycle projection is attached by exact `originalMessageId`; pending/running/declined/failed/budget states decorate that original, and a produced supplement is a separate timestamped reply carrying `extra.supplement`. F264 attaches `QueueMessageReceipt` to the original user bubble. It shows carrier admission as delivered, exact child creation as awakened, exact `seenAt` as body read, and `handledAt` as terminal handling, never collapsing those events or calling the latter “received”. The existing `queue_updated` store transition consumes both receipts embedded in surviving Queue rows and additive dispatch-owned `messageReceipts`, keyed only by exact message ID; therefore a terminal withdrawal remains live when the actionable Queue is empty, without a second receipt store or message writer. A typed `terminal_silent` outcome renders a system-owned explanation under the original cross-thread message; empty provider text never creates a cat body or second identity. Its evidence action selects every loaded message in the exact invocation lineage, including supplements, while retaining each message's own timeline identity and position. Live socket and F5 hydration must converge without content/timestamp or log-text guessing.

## Use This When

- Adding a provider/origin that creates, streams, finalizes, hydrates, or restores frontend message bubbles.
- Changing `BubbleEvent`, `bubbleKind`, canonical invocation ID handling, placeholder upgrade, or hydration merge behavior.
- Touching `useAgentMessages`, `bubble-reducer`, `chatStore` message mutation paths, IDB message cache, or bubble diagnostics.
- Adding or changing legacy closure projections or ADR-042 freshness annotation, supplement status, budget, decline/failure, or reply-chain rendering.
- Adding or changing F264 receipt rendering, handled-disposition copy, reminder state copy, or lineage focus navigation.
- Adding or changing message-disposition selector/onboarding, preference-source labels, one-shot override, or author-intent/fallback receipt copy.
- Adding or changing ordinary/routing-guard/freshness-supplement execution identity, auxiliary execution badges, or ledger hydration links.

## Extend By

- Declare which `BubbleEvent` types a new provider emits, where canonical ID comes from, and which `bubbleKind` each event lands in.
- Route message mutations through the reducer/single-writer path before adding new direct store writes.
- Add replay fixtures or invariant tests when extending event kinds, placeholder recovery, or hydration behavior.
- Keep runtime diagnostics structured enough to identify duplicate stable identities and phase regression.
- Attach supplement projections only to exact `originalMessageId`; keep the original in the normal timeline and render committed supplement content as a separate reply. UI grouping must never merge original and supplement truth.
- Attach queue receipts only to the exact original message. Navigate evidence by canonical invocation identities and supplement provenance, highlighting the loaded lineage as a set rather than relocating or duplicating bubbles.
- Render disposition as an author request, not execution fact. Hide the selector when no relevant invocation is live; show exact exposure/fallback/outcome from custody after send, and clear one-shot state without mutating inherited preferences.
- Persist and hydrate execution identity through the shared typed projection. A child that owns a visible body uses `turnExecution`; a bodyless assisting child uses `auxiliaryTurnExecutions`. Read terminal status from the ledger API rather than copying mutable status into message text.

## Do NOT Unify With

- Do not put connector transport policy or platform-specific formatting in bubble identity. Transport owns delivery; bubble pipeline owns rendering identity.
- Do not let provider lifecycle IDs become frontend bubble identity. OUTER/canonical invocation ID wins; provider IDs are lifecycle metadata.
- Do not create new `messages` write entrances without a reducer event and invariant coverage.
- Do not use IndexedDB as online merge authority. It is a provisional/offline cache.
- Do not remove or replace a completed original because freshness advanced. Do not discover supplement parents by text/timestamp proximity when exact identity exists.
- Do not copy handled replies under the receipt, move the original message, or label `seen` as `handled`.
- Do not keep a meaningless disposition chip visible while all targets are idle, or let composer preference overwrite hydrated message truth.
- Do not parse prompt text, logs, labels or rendered prose to infer execution kind. Do not render a bodyless routing guard as a second ordinary cat answer.

## Static Scan Hints

Watch for new or renamed `BubbleEvent`, `BubbleKind`, `bubbleKind`, `bubbleIdentity`, `BubbleReducer`, `useAgentMessages`, `useChatHistory`, `TurnExecutionMessageProjection`, `executionKind`, `routing_guard`, `freshness_supplement`, `auxiliaryTurnExecutions`, `freshness_closure`, `QueueMessageReceipt`, `MessageReceiptDock`, `seenAt`, `handledAt`, `evidenceRef`, `lineage`, `closureId`, `supplementId`, `originalMessageId`, `turnInvocationId`, `originTriggerMessageId`, `turnOutcome`, `sourceInvocationId`, `chatStore`, `mergeReplaceHydrationMessages`, `IndexedDB`, `placeholder`, and direct `messages` mutations.
