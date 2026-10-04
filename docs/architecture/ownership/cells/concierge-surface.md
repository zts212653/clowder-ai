---
cell_id: concierge-surface
title: Concierge Surface
summary: Always-on receptionist shell and domain extension (猫猫球 / Cat Ball) — per-user concierge lifecycle, configurable duty-cat, anchor-first岗位 protocol, triage, pet behavior and escalation handoff; conversation plumbing belongs to thread-chat-surface.
canonical_features: [F229, F317]
code_anchors:
  - packages/shared/src/types/concierge.ts
  - packages/api/src/domains/concierge/ConciergeConfigStore.ts
  - packages/api/src/domains/concierge/ConciergeThreadService.ts
  - packages/api/src/domains/concierge/ConciergePromptSection.ts
  - packages/api/src/domains/concierge/concierge-keys.ts
  - packages/api/src/routes/concierge.ts
  - packages/web/src/components/concierge/ConciergeHost.tsx
  - packages/web/src/components/concierge/ConciergePanel.tsx
  - packages/web/src/stores/conciergeStore.ts
  - packages/api/src/domains/concierge/live/LiveCompanionCall.ts
  - packages/api/src/domains/concierge/live/LiveCompanionSessions.ts
  - packages/api/src/domains/concierge/live/CompanionHostBridge.ts
  - desktop/plugin-window/window.cjs
  - desktop/plugin-window/voice-host.cjs
doc_anchors:
  - docs/features/F229-cat-ball-concierge.md
  - docs/features/F317-coactive-companion.md
  - feature-discussions/2026-08-27-f229-chat-surface-convergence.md
  - feature-specs/2026-06-10-f229-phase-a-concierge.md
  - feature-discussions/2026-06-09-f229-design/README.md
static_scan_hints: [concierge, cat ball, 猫猫球, concierge_teleport, concierge_peek, concierge_relay, concierge_go, threadKind concierge, ConciergeConfig, dutyCatProfileId, 前台岗位, ThreadChatSurface, density compact]
cited_by:
  - {feature: F322, date: 2026-10-02, delta: "foreground prefetch consumes the common message query with public-reply admission; its per-invocation handle table remains an adapter, not message/search/navigation authority"}
  - {feature: F229, date: 2026-06-10, delta: new cell}
  - {feature: F229-chat-surface-convergence, date: 2026-08-28, delta: narrow ownership to receptionist shell and domain policy; canonical conversation runtime and UI contract move to thread-chat-surface}
  - {feature: F229-M2-M4, date: 2026-08-29, delta: Cat Ball now adapts the canonical compact ThreadChatSurface; all legacy concierge conversation owners are deleted}
  - {feature: F317, date: 2026-09-17, delta: register the gated native Live Host consumer; persistent conversation and dispatch authority remain with existing owners}
---

# Concierge Surface

## Canonical Owner

F229 owns the always-on receptionist shell (猫猫球 / Cat Ball) and its concierge-domain extensions: per-user concierge thread lifecycle, `ConciergeConfig` persistence, the岗位 prompt section injected into concierge-thread invocations, triage/investigation policy and pet behavior. The canonical browser conversation runtime and timeline/composer contract belong to `thread-chat-surface`.

## Architecture

The concierge cat is an **岗位 (duty post)** not a new agent class:

1. **Dialog carrier** — per-user `concierge` thread (lazy-created, hidden from default sidebar via `threadKind='concierge'`, `createdBy=userId` so the thread lives under the user's own Redis index). Message / invocation / memory facilities are fully reused.
2. **Duty cat** — ordinary cat invocation with `ConciergePromptSection` injected when `thread.threadKind === 'concierge'`.
3. **Surface extension** — AppShell/root-level shell, concierge-thread selection, toolbar/chrome and pet behavior. Its conversation viewport is the canonical `ThreadChatSurface` with compact density.

Backend message / invocation / memory facilities are reused. `ConciergePanel` does not fetch, project, optimistically insert, poll, derive liveness or render messages itself. Clean concierge presentation is persisted once by the domain producer before canonical message projection; full Chat and Cat Ball read the same content and typed action manifest.

## F317 Native Live Consumer

The owner-gated F317 Host extends this shell into an Electron voice surface. `LiveCompanionSessions` tracks active media calls in process; `LiveCompanionCall` attaches each call to an ordinary Host invocation and native session. These objects are not a durable conversation, task or dispatch store. `CompanionHostBridge` keeps the local owner session cookie inside the installing API Host. The Electron kernel holds capture admission. Each audio.connect requires current isolated-preload user activation; the Host then waits at most 60 seconds for the matching preparation generation. Readiness alone cannot authorize microphone capture, and cancellation fences the pending intent before any media document is created. A separate hidden Host media document, containing only fixed Host code, owns the voice peer, microphone and receive-only provider data channel. Its webContents is the only microphone permission principal; the package webContents never receives microphone permission, even while the call is armed. The package page receives bounded events and controls and displays the current call's transient transcript; its explicit screen selection remains scoped by the Host. Canonical transcript persistence remains in MessageStore and Session Chain. Snapshot responses retain strict CSP, and the window session rejects cross-origin HTTP/WebSocket requests; this does not assert filtering of WebRTC ICE traffic.

Live is always composed in the ordinary Host; the installed companion uses the configured duty cat and a real native voice carrier. The verified desktop-window package is rendered by the Host-owned Electron component, prepared from the Host's pinned dependency lock at explicit plugin installation. Household queries use the authenticated configured owner's existing visibility; a loopback origin alone does not authorize a different owner or namespace. A development Host cannot read daily-runtime threads by receiving their IDs. Screen access requires the current user-selected source and exact active native identity, and revocation closes that source.

F167 BallCustody events remain the only adopted-dispatch terminal authority. F264 source custody projects and repairs the exact receipt; F254 remains the unseen/notice owner. Reading a dispatch or cleanly ending a Live call must not consume unfinished work. No Live-specific durable task ledger or parallel queue is introduced.

This consumer does not replace the browser `ThreadChatSurface`. Cat-ball selection/preferences migration, plugin packaging and the complete F317 journey remain separate unfinished delivery requirements; the standalone experimental surface is not evidence that F229 migration is complete.

## Storage

- `concierge:config:{userId}` — `ConciergeConfig` JSON, TTL=0 (LL-048 persistent-by-default iron rule).
- `concierge:thread:{userId}` — concierge `threadId`, TTL=0.
- Thread record: `threadKind?: 'concierge'` on `IThreadStore`, filtered from default sidebar listing.

## 岗位 Protocol (anchor-first)

F322 prefetch uses the common `MessageSearchService` projection for message hits across readable threads, with authenticated source exclusion and public-reply visibility. Multiple messages may share a thread/title. Each R handle still binds its exact source identity and normalized title; the digest does not authenticate snippet text. This adapter neither persists a query-result collection nor grants all cats a rich-card producer; those journey consumers use the common query contract and their existing surface owners.

- Responses must carry 1–3 clickable anchors (feature doc / guide / thread+message / release note).
- Tool whitelist: `search_evidence`, `graph_resolve`, `list_recent`, `get_thread_context`, `feat_index`, `get_available_guides`, `start_guide`, `create_rich_block`.
- Jumps and relays are CardBlock actions (`concierge_teleport` / `concierge_peek` / `concierge_relay` / `concierge_go`); cats do not execute them directly.
- Escalation: send handoff card with user's verbatim request + relevant anchors.

## Use This When

- Adding or changing concierge config (displayName, personaTone, dutyCatProfileId, proactivePolicy, muted).
- Modifying the concierge thread lifecycle (getOrCreate, sidebar filter, threadKind marker).
- Updating the岗位 prompt section (ConciergePromptSection — update SystemPromptBuilder guard test immediately).
- Implementing CardBlock concierge actions (teleport / peek / relay / go) in the frontend.
- Deciding whether a new concierge capability fits in the岗位 whitelist or requires escalation.
- Changing Cat Ball shell, displayed-thread selection, triage/investigation state or pet behavior without changing canonical chat semantics.

## Extend By

- Keep duty toolset whitelist conservative (KD-10): every tool added must have a compelling anchor-first reason.
- Dangerous actions (6399 / runtime / truth-source mutations) must refuse without user confirmation — do not add to whitelist.
- Per-invocation MCP tool hard-trimming: spike result (PR-A4) determines Phase D approach; Phase A uses soft whitelist + confirmation cards.
- New CardBlock concierge action types require: (1) frontend action handler registration, (2) backend route if server-side, (3) guard test update.
- Add conversation behavior only through bounded `thread-chat-surface` chrome/seed/activity extension points. Never reintroduce concierge history, queue polling, optimistic IDs, message DTOs or a surface-local renderer.

## Do NOT Unify With

- Do not merge with `hub-action-surface`. Hub actions are first-party UI side-effects to *all* threads; concierge surface is a dedicated per-user receptionist channel with its own lifecycle and岗位 protocol.
- Do not own message filtering, history fetch, socket, send, liveness, renderer or action runtime. Those are shared `thread-chat-surface` and canonical domain-owner responsibilities even when density is compact.
- Do not create a concierge-local unread/attention truth. Cross-thread attention belongs to `thread-navigation`.
- Do not put concierge business logic in SystemPromptBuilder. The builder only calls `buildConciergePromptLines`; protocol details live in `ConciergePromptSection.ts`.
- Do not allow concierge to bypass escalation cards for destructive operations. The soft whitelist + confirmation card model is the F229 safety boundary.

## Static Scan Hints

Watch for `threadKind`, `concierge`, `ConciergeConfig`, `dutyCatProfileId`, `concierge_teleport`, `concierge_peek`, `concierge_relay`, `concierge_go`, `前台岗位`, `anchor-first`, `/api/concierge/`, `ConciergePromptSection`, and `ConciergeThreadService`.
