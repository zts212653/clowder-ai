---
cell_id: thread-navigation
title: Thread Navigation / Metadata
summary: Thread labels、pins、favorites、sidebar filters 与用户面向的 thread 组织语义。
canonical_features: [F057, F095, F187]
code_anchors:
  - packages/api/src/routes/labels.ts
  - packages/api/src/routes/threads.ts
  - packages/api/src/domains/cats/services/stores/ports/ThreadStore.ts
  - packages/api/src/domains/cats/services/stores/redis/RedisLabelStore.ts
  - packages/api/src/domains/cats/services/stores/redis-keys/label-keys.ts
  - packages/api/src/domains/cats/services/stores/factories/LabelStoreFactory.ts
  - packages/web/src/stores/label-store.ts
  - packages/web/src/components/ThreadSidebar/ThreadSidebar.tsx
  - packages/web/src/components/ThreadSidebar/LabelFilterBar.tsx
  - packages/web/src/components/ThreadSidebar/ThreadLabelPicker.tsx
  - packages/web/src/components/ThreadSidebar/thread-navigation.ts
doc_anchors:
  - docs/features/F057-thread-discoverability.md
  - docs/features/F095-sidebar-collapse-memory.md
  - docs/features/F187-thread-labels.md
static_scan_hints: [ThreadLabel, ILabelStore, LabelStore, labels, pin, favorite, ThreadSidebar, LabelFilterBar]
cited_by:
  - {feature: F187, date: 2026-05-07, delta: new cell}
  - {feature: F191, date: 2026-05-07, delta: trial result}
---

# Thread Navigation / Metadata

## Canonical Owner

F057 / F095 / F187 own user-facing thread organization: search/sort/navigation affordances, pins/favorites, labels, sidebar filters, and uncategorized views.

This cell is about how a user finds, groups, and revisits threads. It is not the source of message identity, connector binding, memory evidence, or dispatch priority.

## Use This When

- Adding or changing thread labels, folders, categories, pins, favorites, read/filter state, or sidebar navigation filters.
- Changing thread metadata fields that exist to organize or retrieve threads for the user.
- Adding assistant-assisted thread organization flows, such as suggesting labels for uncategorized threads.
- Changing the sidebar's thread grouping, visibility, filtering, or thread list navigation behavior.

## Extend By

- Reuse `IThreadStore` thread metadata methods and `ILabelStore` for label CRUD instead of creating parallel label/category stores.
- Route label changes through `/api/labels` and `/api/threads/:id/labels` so Redis persistence and frontend stores stay aligned.
- Extend `ThreadSidebar`, `LabelFilterBar`, `ThreadLabelPicker`, and `thread-navigation` helpers for user-facing navigation behavior.
- Keep new organization semantics explicit: pin = attention, label = category, favorite = durable interest, filter = current view.

## Do NOT Unify With

- Do not fold thread labels or sidebar filters into `identity-session`. User organization metadata does not decide cat identity, connector ownership, or bubble identity.
- Do not push thread labels into `bubble-pipeline`. Labels classify the whole thread; bubbles own per-message rendering and identity.
- Do not treat connector thread binding as a user label. External chat/thread mapping belongs to `transport` / `identity-connector`.
- Do not use `memory` as the label source of truth. Evidence and summaries can inform classification, but labels are user-facing thread metadata.
- Do not use labels to steer `dispatch` priority or busy-gate fairness without a separate dispatch design decision.

## Static Scan Hints

Watch for new or renamed `ThreadLabel`, `ILabelStore`, `RedisLabelStore`, `LabelStore`, `labels`, `LabelFilterBar`, `ThreadLabelPicker`, `ThreadSidebar`, `thread-navigation`, `pin`, `favorite`, `uncategorized`, and `category` code.
