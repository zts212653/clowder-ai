---
cell_id: visible-cafe-render
title: Visible Café Render Layer
summary: Frontend-only render surface for F258 "看得见的猫咖" — state bridge adapter consumes existing server truth (agent_message socket / queue API) and feeds CatPresenceSnapshot to pure-function render components on /starry page.
description: Frontend render surface for F258 Visible Café — adapter + zustand store + pure-function render components on /starry page. Zero backend, self-owned assets.
description_source: human
description_author: opus
description_updated_at: "2026-07-17T00:00:00Z"
canonical_features: [F258]
code_anchors:
  - packages/web/src/lib/visible-cafe/asset-config.ts
  - packages/web/src/lib/visible-cafe/presence-types.ts
  - packages/web/src/lib/visible-cafe/event-mapping.ts
  - packages/web/src/lib/visible-cafe/render-log.ts
  - packages/web/src/stores/visible-cafe-presence.ts
  - packages/web/src/hooks/useVisibleCafePresence.ts
  - packages/web/src/components/visible-cafe/StarryRoom.tsx
  - packages/web/src/components/visible-cafe/CatSprite.tsx
  - packages/web/src/components/visible-cafe/StarWindow.tsx
  - packages/web/src/app/starry/page.tsx
  - packages/web/public/visible-cafe/
doc_anchors:
  - docs/features/F258-visible-cafe.md
  - feature-specs/2026-07-17-f258-phase-a-implementation.md
static_scan_hints: [visible-cafe, visible cafe, starry, CatPresenceSnapshot, pickPosture, VISIBLE_CAFE_ASSET_BASE, render-log, StarryRoom, CatSprite, StarWindow]
cited_by:
  - {feature: F258, date: 2026-07-17, delta: new cell}
  - {feature: F255, date: 2026-07-20, delta: "Phase A.1 keeps render state display-only and mounts the separately owned cat-home product panel beside it"}
---

# Visible Café Render Layer

## Canonical Owner

F258 owns the visible café render surface — a frontend-only layer that visualizes cat presence state on the `/starry` page. Zero new backend services.

F255 may mount its adjacent cat-home panel from this page, but those settings and diary components belong to `cat-life-settings`. `StarryRoom` only emits the doorway action; it does not store or project F255 configuration.

## Architecture

Three layers, strict separation:

1. **Adapter** (`useVisibleCafePresence`) — subscribes to existing `agent_message` socket + reconcile poller against thread/queue APIs. Sole writer to CatPresenceSnapshot store.
2. **Store** (`visible-cafe-presence`) — zustand store holding `CatPresenceSnapshot`. State machine: `live → stale → unknown` with event-driven transitions. Initial state = `unknown`.
3. **Render** (`StarryRoom` / `CatSprite` / `StarWindow`) — pure consumers. Posture = `pickPosture(snapshot, now)` pure function (Defense Line 1: no-state render). Zero write access to store.

Self-owned assets in `packages/web/public/visible-cafe/` — copied from source, never referencing `/concierge/skins/*` (F229 boundary, 07-09 judgment).

## Consumes (read-only, zero modification)

- `agent_message` socket events (existing transport cell)
- Thread list / activity APIs (existing thread-navigation cell)
- Queue API for reconciliation (existing action-plane cell)

## Storage

Frontend-only. No Redis keys, no API routes, no backend persistence.
- `CatPresenceSnapshot` — zustand in-memory store (page-scoped, no persistence needed)
- Render log — ring buffer 512 entries, in-memory, append-only

## Use This When

- Adding or changing cat presence state transitions
- Modifying render behavior on `/starry` page
- Adding new sprite states or animation behaviors
- Changing asset deployment structure under `public/visible-cafe/`
- Implementing new star window / star light behaviors

## Extend By

- Phase B: pixel-office tile engine replaces simple background
- Phase C: multi-cat main star, Live2D upgrade path
- F255 integration: staged_thought state activation (currently gated INV-3)

## Do NOT Unify With

- `concierge-surface`: F229 猫猫球 is a separate interaction surface with its own backend lifecycle. Visible café is display-only.
- Do not add backend persistence for render state. "不给可视化另造事实库" (spec C3).
- Do not place cat-life settings, previews, diary engagement, or their API state in `visible-cafe-presence`; route them through the adjacent `cat-life-settings` cell.
- Do not reference `/concierge/skins/*` runtime paths. Assets are self-owned copies.

## Static Scan Hints

Watch for `visible-cafe`, `CatPresenceSnapshot`, `pickPosture`, `VISIBLE_CAFE_ASSET_BASE`, `StarryRoom`, `CatSprite`, `StarWindow`, `render-log`, `/starry`, and `skin.json` under `public/visible-cafe/`.
