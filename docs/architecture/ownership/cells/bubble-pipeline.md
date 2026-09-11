---
cell_id: bubble-pipeline
title: Bubble Pipeline
summary: Provider-normalized semantic event 到用户可见 bubble 的单一投影边界；覆盖气泡 identity、reducer single-writer、live/hydration convergence、typed execution/freshness projection，以及 MessageStore dispatchRefs 驱动的实际投递头像与响应终态。
canonical_features: [F177, F183, F254, F264]
code_anchors:
  - packages/api/src/domains/cats/services/types.ts
  - packages/shared/src/types/bubble-pipeline.ts
  - packages/shared/src/types/turn-execution.ts
  - packages/api/src/domains/cats/services/stores/ports/MessageStore.ts
  - packages/web/src/stores/bubble-reducer.ts
  - packages/web/src/stores/chatStore.ts
  - packages/web/src/hooks/useAgentMessages.ts
  - packages/web/src/hooks/bubble-event-adapter.ts
  - packages/web/src/hooks/system-info-visible.ts
  - packages/web/src/hooks/useChatHistory.ts
  - packages/web/src/debug/bubbleIdentity.ts
  - packages/web/src/debug/bubbleInvariantDiagnostics.ts
  - packages/web/src/hooks/useSocket.ts
  - packages/web/src/components/ChatMessage.tsx
  - packages/web/src/components/MessageDispatchAvatars.tsx
  - packages/web/src/components/ConnectorBubble.tsx
doc_anchors:
  - docs/decisions/043-queue-durable-single-ledger.md
  - docs/features/F117-message-delivery-lifecycle.md
  - docs/features/F306-codex-app-capability-parity.md
  - feature-discussions/2026-08-26-f306-provider-neutral-semantic-events/README.md
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
static_scan_hints: [AgentMessageType, system_info, provider_signal, BubbleEvent, bubbleKind, bubbleIdentity, BubbleReducer, bubble-event-adapter, formatVisibleSystemInfo, useAgentMessages, useChatHistory, useSocket, queue_updated, dispatchRefs, dispatchedAt, statusMessageId, TurnExecutionMessageProjection, executionKind, routing_guard, freshness_supplement, auxiliaryTurnExecutions, MessageDispatchAvatars, lifecycleStatus, evidenceRef, lineage, originalMessageId, sourceInvocationId, chatStore, hydration, IndexedDB]
cited_by:
  - {feature: F117-canonical-source-entry, date: 2026-09-08, delta: the source bubble is materialized once at first actual delivery; MessageStore dispatchRefs own per-target delivery identity and time, while each exact response bubble owns processing and terminal state without Queue receipt projection}
  - {feature: F264-author-intent-steer-ui, date: 2026-09-03, delta: the Steer modal offers non-interrupting send as author intent for every selectable target; admission appends to an exact accepting run or preserves the same row for ordinary drain when the carrier is unavailable or already stopped}
  - {feature: F254-ADR-043-read-adoption, date: 2026-09-03, delta: full queued-body adoption links the original source dispatchRef to the already-processing response so its member avatar and processing bubble appear on the original timeline message without copying or moving the body}
  - {feature: F117-ADR-043, date: 2026-09-03, delta: live queue updates and F5 history project the same QueueMessageReceipt from exact QueueLedger rows while MessageStore retains only body, coarse delivery state, and immutable timeline publication fact}
  - {feature: F306, date: 2026-08-26, delta: provider raw streams remain adapter-specific but converge into a provider-neutral semantic event contract; one projector registry serves live, background, hydration, callback, and replay, while unknown structured payloads fail closed instead of rendering raw JSON}
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

F143 provider adapters own raw wire parsing and normalize into the shared AgentService event port; this
cell owns the next boundary from provider-neutral semantic event to `BubbleEvent` and human-facing
projection. Provider provenance is diagnostic metadata, not the renderer's primary switch. Foreground,
background, hydration/F5, callback, and replay consume the same semantic projector registry. Unknown or
invalid structured payloads retain diagnostics and fail closed rather than rendering raw protocol JSON.

F183 / ADR-033 own bubble identity and the reducer single-writer contract. Visible cat bodies key by
`(catId, canonicalInvocationId, bubbleKind)`; provider IDs remain lifecycle metadata. Typed child
projections distinguish ordinary replies, routing guards, and freshness supplements without copying prose
or creating duplicate bodies. Supplement state attaches only by exact `originalMessageId`, while a
produced supplement remains its own timestamped reply.

F264 delivery presentation now reads actual delivery truth from MessageStore `dispatchRefs[]`. A ref appears
only after one exact source-to-target cutover and carries `dispatchedAt`, target identity, and the exact
`statusMessageId`; later settlement updates that same ref from the canonical response lifecycle. Queue owns
only pending targets and contributes no receipt, processing, exposure, or terminal projection.

The first actual delivery of a user or external inline source materializes its one History bubble. Additional
targets append refs to the same source message, so a multi-target send never renders duplicate user bubbles.
Agent-authored sources already in History reuse their existing bubble. A running member that adopts a complete
queued body through thread context performs the same transition and links the source to its existing response;
other targets remain pending in the single Queue entry.

`MessageDispatchAvatars` is the two-stage projection of those refs: a dispatched target shows the member avatar,
hover reveals the actual delivery timestamp, and activation navigates to the exact response bubble. The response
bubble itself owns `processing`, streamed content, `completed`, `failed`, and `canceled`; a failure retains any
partial content and appends its structured diagnostic. The source ref never manufactures a second response.

Live socket updates and F5 hydration read the same MessageStore lifecycle. They must converge without content,
timestamp, Queue receipt, or log-text guesses. A targetless user/external entry remains outside History until
some real dispatch occurs; a source already in History does not need to be moved or copied.

A bodyless processing response renders a lifecycle tip; once content streams, that same response identity
becomes the bubble. Empty terminal responses use their typed lifecycle notice and remain available to peer
context. Dispatch navigation follows exact persisted identities without moving the original message or
copying handled replies beneath it.

## Use This When

- Adding or changing provider-neutral semantic events, bubble identity, placeholder upgrade, hydration, or
  replay behavior.
- Touching `useAgentMessages`, `bubble-reducer`, `chatStore`, `useSocket`, IndexedDB hydration, or
  bubble diagnostics.
- Changing F254 supplement projection, typed child execution badges, or lifecycle tips.
- Changing dispatch-avatar rendering, delivery timestamps, response terminal outcomes, reminders, or exact
  response navigation.
- Changing first-delivery source materialization or delivery-order hydration.

## Extend By

- Normalize provider wire events before they reach the shared semantic projector; add positive and
  fail-closed fixtures for every new structured kind.
- Route all message mutations through the reducer/single-writer boundary.
- Attach supplements and dispatch refs only by exact persisted identity, never by text or timestamp proximity.
- Project delivery avatars from MessageStore `dispatchRefs` for both live socket and F5 history; keep the
  frontend normalizer structural and idempotent.
- Add paired live/hydration tests whenever dispatch state, lifecycle notice, or timeline ordering changes.
- Preserve one bubble identity as processing tip upgrades to streamed or terminal content.

## Do NOT Unify With

- Do not put connector transport policy or provider wire names into bubble identity.
- Do not render unknown protocol envelopes with `JSON.stringify` or infer semantics with an LLM.
- Do not let provider lifecycle IDs replace the canonical bubble identity.
- Do not use IndexedDB as online merge authority.
- Do not copy Queue lifecycle into MessageStore or derive delivery from pending Queue targets.
- Do not remove or move an original message when freshness or target lifecycle changes.
- Do not label Queue admission as delivery, or provider success as handled without exact lifecycle evidence.
- Do not use content/timestamp proximity to merge supplements, dispatch refs, or terminal notices.

## Static Scan Hints

Watch for new or renamed `BubbleEvent`, `bubbleKind`, `bubbleIdentity`, `BubbleReducer`,
`bubble-event-adapter`, `useAgentMessages`, `useChatHistory`, `useSocket`, `queue_updated`,
`dispatchRefs`, `dispatchedAt`, `statusMessageId`, `TurnExecutionMessageProjection`, `executionKind`,
`freshness_supplement`, `MessageDispatchAvatars`, `lifecycleStatus`,
`originalMessageId`, `sourceInvocationId`, `chatStore`, hydration, IndexedDB, placeholder recovery,
provider-specific render switches, raw JSON fallbacks, and direct message mutations.
