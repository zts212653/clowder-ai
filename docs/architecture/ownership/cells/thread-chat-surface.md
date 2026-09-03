---
cell_id: thread-chat-surface
title: Thread Chat Surface
summary: Browser 端唯一 thread chat runtime consumer 与 timeline/composer surface 契约；full Chat 和 compact Cat Ball 只能改变布局与密度，不得复制 socket、history、send、liveness、renderer 或 action runtime。
description: Browser 端唯一 thread chat runtime consumer 与 timeline/composer surface 契约；full Chat 和 compact Cat Ball 只能改变布局与密度，不得复制核心 conversation runtime。
description_source: model
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: 2026-08-29T08:00:00Z
description_confirmed_by: codex-sol
description_updated_at: 2026-08-29T02:55:00-07:00
doc_kind: reference
created: 2026-08-28
updated: 2026-08-29
canonical_features: [F229]
code_anchors:
  - packages/web/src/components/thread-chat/ThreadChatRuntimeProvider.tsx
  - packages/web/src/components/thread-chat/ThreadChatSurface.tsx
  - packages/web/src/components/thread-chat/ThreadChatExport.tsx
  - packages/web/src/components/thread-chat/thread-chat-runtime-registry.ts
  - packages/web/src/components/thread-chat/thread-chat-history-admission.ts
  - packages/web/src/components/AppShell.tsx
  - packages/web/src/components/ChatContainer.tsx
  - packages/web/src/components/concierge/ConciergePanel.tsx
  - packages/web/src/hooks/useChatHistory.ts
  - packages/web/src/hooks/useSendMessage.ts
  - packages/web/src/hooks/useConnectionStatus.ts
doc_anchors:
  - docs/features/F229-cat-ball-concierge.md
  - feature-discussions/2026-08-27-f229-chat-surface-convergence.md
  - feature-specs/2026-08-27-f229-chat-runtime-owner-m1.md
  - feature-specs/2026-08-29-f229-chat-history-admission-m1b.md
  - feature-specs/2026-08-29-f229-chat-surface-vertical-m2-m4.md
static_scan_hints: [ThreadChatRuntimeProvider, useThreadChatRuntime, ThreadChatSurface, ThreadChatDensity, useSocket, useChatHistory, useSendMessage, useThreadLiveness, splitPaneThreadIds]
cited_by:
  - {feature: F229-M1a, date: 2026-08-28, delta: AppShell-scoped provider becomes the sole browser socket and visible-thread room owner; ChatContainer consumes the runtime registration while later history/send/surface migration remains explicit}
  - {feature: F229-M1b, date: 2026-08-29, delta: the AppShell runtime admits one bootstrap and one equal-key history request per thread while each mounted surface retains independent viewport state}
  - {feature: F229-M2-M4, date: 2026-08-29, delta: one ThreadChatSurface now owns the normal full and compact conversation path; Cat Ball is a density adapter and the legacy mini-chat core is deleted}
---

# Thread Chat Surface

## Canonical Owner

F229 owns the browser's single thread-chat consumer boundary. Every interactive conversation surface must consume the same runtime, message semantics, history admission, send lifecycle, liveness, renderer and action behavior. Full Chat and compact Cat Ball may supply different layout, density and product chrome only.

`bubble-pipeline` remains the semantic message identity and projection owner. `thread-navigation` remains the thread discovery, route and cross-thread attention owner. `hub-action-surface` and the corresponding domain cells remain the typed action owners. This cell composes those owners for an interactive thread; it does not absorb their policy.

## Current Migration State

M1a–M4 now establish the canonical full/compact path end to end:

- `ThreadChatRuntimeProvider` is mounted once at `AppShell` scope and owns `useAgentMessages`, `useChatSocketCallbacks` and the sole browser `useSocket` invocation for normal chat routes.
- Consumers declare visible thread IDs through `useThreadChatRuntime`; the provider derives one deterministic room union without exposing `joinRoom`, `leaveRoom`, `syncRooms` or the socket instance.
- `ChatContainer` consumes `socketConnected`, agent-message ref reset and the generation-safe index-event registration from the provider. It no longer constructs a parallel socket runtime or normal-mode send/timeline/composer core.
- `ThreadChatRuntimeProvider` also owns one ephemeral per-thread history admission coordinator. Multiple canonical history consumers for the same thread share initial messages/tasks/task-progress/queue hydration and equal request keys; each hook instance keeps its own scroll refs and anchor memory.
- `ThreadChatSurface` owns canonical history, thread-scoped messages/liveness, send admission, timeline/renderer/actions, viewport-local scroll/selection and composer behavior. `density='full'|'compact'` changes geometry and chrome only.
- `ChatContainer` is the full-page adapter. `ConciergePanel` is the compact Cat Ball adapter and retains only bubble chrome, resize, displayed-thread selection, prompt seeding and read-only pet activity observation.
- `useConciergeMessages`, `useConciergeQueue`, `useConciergePanelLiveness`, `ConciergePanelConversation` and `ConciergeMessageContent` are deleted. Concierge content hygiene is produced once before canonical persistence; both densities consume the same stored projection.
- M5 cross-thread attention / Peek & Reply remains separate and must consume `thread-navigation` truth rather than recreate an unread store below Cat Ball.

## Contract Invariants

- One mounted `AppShell` owns one chat socket lifecycle.
- Room membership is the normalized union of mounted consumers' visible thread IDs; duplicate consumers cannot duplicate a join or cause an early leave.
- A consumer replacement changes its registration atomically, and cleanup is idempotent.
- A stale index-handler cleanup cannot remove a newer handler.
- One thread has at most one running history-bootstrap owner registration generation. Every effect registration receives a fresh generation token, so stale completion, cleanup or owned-request invalidation from an earlier registration of the same consumer cannot mutate its successor. Only a successful history fetch becomes ready; failed hydration stays retryable when a survivor takes ownership or a late consumer joins. Ready ownership transfers without rehydrating, and the last consumer cleanup forgets ephemeral readiness.
- Equal `(threadId, requestKey)` history work returns the same Promise while the originating consumer remains valid. Catch-up keys include the observed stream version so a response issued before a gap cannot acknowledge it; an origin that unmounts marks the shared result abandoned so live consumers re-enter admission instead of accepting its stale/no-op result.
- Different threads, cursors and freshness keys remain independent, and stale settlement cannot delete replacement work.
- History admission never owns viewport state: scroll containers, message-end refs, pointer intent and anchor restoration remain surface-local.
- A surface cannot gain a second history, socket, send, liveness, renderer or action pipeline by calling itself compact, embedded or concierge.
- Full and compact instances for the same `threadId` expose the same durable message IDs, ordering, variants, diagnostics and typed actions. Interactive action sends are instance-scoped; an action rendered by one density cannot be admitted twice by another mounted density.
- Product adapters may provide bounded chrome, empty-state, composer seed/placeholder and read-only activity callbacks. They cannot supply alternate fetch/send/socket/liveness inputs or filter/map/reorder canonical messages.
- Missing provider context fails closed. Tests that mount `ChatContainer` or `useChatHistory` directly must include the real provider boundary.

## Use This When

- Adding an interactive thread surface, embedded conversation or compact chat layout.
- Changing browser socket lifetime, visible-room registration, reconnect or catch-up admission.
- Extracting canonical history, send, timeline, composer, renderer, diagnostics, cancel or action behavior from `ChatContainer`.
- Defining parity fixtures between full and compact thread chat.

## Extend By

- Add product-specific behavior through typed extension points and layout adapters; keep the shared runtime and semantic projection unchanged.
- Add characterization tests before migrating each owner out of `ChatContainer`, then prove both full and compact consumers against the same fixtures.
- Keep the public registration contract narrow: consumers declare visible thread IDs and observe runtime state; membership mutation remains provider-owned.

## Explicit Non-Surface Sends

- `SplitPaneView` owns the existing shared composer for a selected split-pane target. Its cells are bounded recent-thread previews, not a second full/compact renderer, and this exception must not be copied into Cat Ball.
- `PlanBoardPanel` emits a domain-authored thread message from a plan action. It is not a conversation surface.

## Do NOT Unify With

- Do not move bubble identity, reducer single-writer rules or structured payload visibility out of `bubble-pipeline`.
- Do not move concierge lifecycle, duty prompt, triage policy or pet behavior out of `concierge-surface`.
- Do not derive cross-thread unread/attention from visible-room subscriptions or a concierge-local store; consume `thread-navigation` truth.
- Do not fork typed action behavior by density or surface; consume `hub-action-surface` and domain-owned actions.

## Static Scan Hints

Watch for new production calls to `useSocket`, `useChatSocketCallbacks`, `useAgentMessages`, `useChatHistory`, `useSendMessage` or message renderers under a product-specific surface; a second production `ThreadChatHistoryAdmissionProvider`; new room-membership APIs exposed to consumers; and compact/embedded components that filter canonical message types or infer liveness independently.
