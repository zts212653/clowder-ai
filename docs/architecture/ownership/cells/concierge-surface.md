---
cell_id: concierge-surface
title: Concierge Surface
summary: Always-on frontend receptionist entry point (猫猫球 / Cat Ball) — per-user concierge thread, configurable duty-cat, anchor-first岗位 protocol, and escalation handoff.
canonical_features: [F229]
code_anchors:
  - packages/shared/src/types/concierge.ts
  - packages/api/src/domains/concierge/ConciergeConfigStore.ts
  - packages/api/src/domains/concierge/ConciergeThreadService.ts
  - packages/api/src/domains/concierge/ConciergePromptSection.ts
  - packages/api/src/domains/concierge/concierge-keys.ts
  - packages/api/src/routes/concierge.ts
doc_anchors:
  - docs/features/F229-cat-ball-concierge.md
  - feature-specs/2026-06-10-f229-phase-a-concierge.md
  - feature-discussions/2026-06-09-f229-design/README.md
static_scan_hints: [concierge, cat ball, 猫猫球, concierge_teleport, concierge_peek, concierge_relay, concierge_go, threadKind concierge, ConciergeConfig, dutyCatProfileId, 前台岗位]
cited_by:
  - {feature: F229, date: 2026-06-10, delta: new cell}
---

# Concierge Surface

## Canonical Owner

F229 owns the always-on frontend concierge entry point (猫猫球 / Cat Ball). This cell owns the backend infrastructure: per-user concierge thread lifecycle, ConciergeConfig persistence, and the岗位 prompt section injected into SystemPromptBuilder for concierge-thread invocations.

## Architecture

The concierge cat is an **岗位 (duty post)** not a new agent class:

1. **Dialog carrier** — per-user `concierge` thread (lazy-created, hidden from default sidebar via `threadKind='concierge'`, `createdBy=userId` so the thread lives under the user's own Redis index). Message / invocation / memory facilities are fully reused.
2. **Duty cat** — ordinary cat invocation with `ConciergePromptSection` injected when `thread.threadKind === 'concierge'`.
3. **Surface** — AppShell/root-level host component (PR-A2 frontend, follows F226 KD-1 lesson).

Zero parallel infrastructure — all concierge conversations flow through existing message / invocation / memory pipelines.

## Storage

- `concierge:config:{userId}` — `ConciergeConfig` JSON, TTL=0 (LL-048 persistent-by-default iron rule).
- `concierge:thread:{userId}` — concierge `threadId`, TTL=0.
- Thread record: `threadKind?: 'concierge'` on `IThreadStore`, filtered from default sidebar listing.

## 岗位 Protocol (anchor-first)

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

## Extend By

- Keep duty toolset whitelist conservative (KD-10): every tool added must have a compelling anchor-first reason.
- Dangerous actions (6399 / runtime / truth-source mutations) must refuse without user confirmation — do not add to whitelist.
- Per-invocation MCP tool hard-trimming: spike result (PR-A4) determines Phase D approach; Phase A uses soft whitelist + confirmation cards.
- New CardBlock concierge action types require: (1) frontend action handler registration, (2) backend route if server-side, (3) guard test update.

## Do NOT Unify With

- Do not merge with `hub-action-surface`. Hub actions are first-party UI side-effects to *all* threads; concierge surface is a dedicated per-user receptionist channel with its own lifecycle and岗位 protocol.
- Do not put concierge business logic in SystemPromptBuilder. The builder only calls `buildConciergePromptLines`; protocol details live in `ConciergePromptSection.ts`.
- Do not allow concierge to bypass escalation cards for destructive operations. The soft whitelist + confirmation card model is the F229 safety boundary.

## Static Scan Hints

Watch for `threadKind`, `concierge`, `ConciergeConfig`, `dutyCatProfileId`, `concierge_teleport`, `concierge_peek`, `concierge_relay`, `concierge_go`, `前台岗位`, `anchor-first`, `/api/concierge/`, `ConciergePromptSection`, and `ConciergeThreadService`.
