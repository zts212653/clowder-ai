---
cell_id: cat-life-settings
title: Cat Life Settings and Diary Feedback
summary: F255-owned per-owner/per-cat life configuration, stable Present Loop projection, diary reading/engagement APIs, and adjacent `/starry` home surface; F139 executes projections, F258 only hosts the doorway, and F229 only previews/asks for confirmation.
description: F255-owned cat-life configuration, stable Present Loop projection, diary reading and reactions, with `/starry` as the adjacent product surface.
description_source: human
description_author: codex-sol
description_updated_at: "2026-07-20T08:14:56Z"
canonical_features: [F255]
code_anchors:
  - packages/shared/src/types/auto-dream.ts
  - packages/api/src/domains/auto-dream/CatLifeSettingsService.ts
  - packages/api/src/domains/auto-dream/cat-life-operations.ts
  - packages/api/src/domains/auto-dream/cat-life-schedule.ts
  - packages/api/src/domains/auto-dream/engagement-operations.ts
  - packages/api/src/routes/auto-dream.ts
  - packages/api/src/routes/callback-auto-dream-routes.ts
  - packages/mcp-server/src/tools/auto-dream-tools.ts
  - packages/web/src/components/visible-cafe/cat-home/
doc_anchors:
  - docs/features/F255-auto-dream.md
  - feature-specs/2026-07-19-f255-phase-a1-cat-life-and-diary-loop.md
static_scan_hints: [CatLifeSettingsService, cat_life_configs, cat_life_previews, diary_engagement_events, f255-cat-life, preview_cat_life_settings, CatHomePanel, CatDiaryShelf, CatLifeSettingsPanel, life-settings/decision]
cited_by:
  - {feature: F255, date: 2026-07-20, delta: "Phase A.1 establishes the product-owned life configuration and diary feedback boundary beside the F258 render cell"}
  - {feature: F272, date: 2026-07-22, delta: "Phase A consumes the confirmed F255 bedroomThreadId and quiet hours as server-derived landing policy without adding F272 home/config state"}
---

# Cat Life Settings and Diary Feedback

## Canonical Owner

F255 owns the durable `(ownerUserId, catId)` life configuration, preview/confirmation state, diary engagement events, and public product APIs. The configuration describes how a cat lives; it is not a serialized scheduler form.

The same cell owns the adjacent `/starry` cat-home panel because that panel reads and writes F255 product state. The existing `visible-cafe-render` cell remains a display-only consumer of presence truth; opening the panel from `StarryRoom` does not give render state write authority.

## Projection Boundary

- `CatLifeSettingsService` derives an internal cron and stable bedroom/task identity from worldview-level settings.
- Exactly one F139 Present Loop projection may be active for each `(ownerUserId, catId, 'present-loop')` identity.
- Reconciliation upserts or disables that stable projection. Pausing retains the F255 configuration and bedroom identity.
- F139 owns execution and generic schedule lifecycle. Its task row is a repairable projection, not configuration truth.
- F229 may create a bounded preview and attach a fixed confirm/cancel callback. Only the user-confirmed F255 decision endpoint commits configuration.
- F272 may read the confirmed `bedroomThreadId`, timezone, and quiet hours to choose one proactive landing, but it cannot accept replacements for those values from callback or MCP payloads.

## Diary Feedback Boundary

Diary pages remain immutable F255 product records. The `/starry` list renders only headline and summary; full body retrieval is an explicit read state. `open` and light `reaction` events are owner-scoped, idempotent by client event ID, persistent, and feed the AC-E1 telemetry numerator without ranking cats or changing diary eligibility.

## Use This When

- Changing cat-life settings, rhythm presets, quiet hours, preview/confirm behavior, or projection reconciliation.
- Adding an F255 settings consumer while preserving one configuration truth source.
- Changing diary bookshelf/full-page reading or lightweight engagement telemetry.
- Auditing why generic Schedule cannot create or mutate an F255-managed Present Loop.

## Extend By

- Add product-level settings to the shared strict schema, derive execution values in `cat-life-schedule.ts`, and persist them through versioned `AutoDreamStore` migrations.
- Keep public responses free of cron, task IDs, thread IDs, and owner identity.
- Add new surfaces as consumers of the same APIs; do not duplicate configuration in frontend stores or tool payloads.
- Add new engagement kinds only with explicit user action semantics and AC-E1 metric provenance.

## Do NOT Unify With

- Do not move configuration into `visible-cafe-presence`; that store is display-only and in-memory.
- Do not let generic Schedule create, patch, or delete an F255-managed Present Loop.
- Do not let F229 write a raw schedule or commit without the fixed confirmation callback.
- Do not let F272 create another bedroom, choose a work/decision thread as home, or persist a shadow life configuration.
- Do not turn diary engagement into a score, prompt input, scheduling input, or display ranking.

## Static Scan Hints

Watch for `CatLifeSettingsService`, `cat_life_configs`, `cat_life_previews`, `diary_engagement_events`, `f255-cat-life`, `life-settings/decision`, `preview_cat_life_settings`, and the `/visible-cafe/cat-home/` component boundary.
