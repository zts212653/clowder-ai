---
doc_kind: architecture
description: "Frozen RecallFrame v0 contract for reconstructable memory projections and episodes."
description_source: original
description_author: codex-sol
description_updated_at: 2026-08-28T13:00:00Z
feature_ids: [F200, F209, F221, F263, F276, F287]
topics: [memory, recall, projection, episode, derived-view]
created: 2026-08-28
status: active
---

# RecallFrame v0

`RecallFrame.v0` is the frozen reconstruction envelope for one query-triggered or typed-event-triggered
memory projection/episode. Its executable schema is
`packages/shared/src/types/memory-architecture-closure.ts#memoryRecallFrameV0Schema`.

It is a receipt-shaped projection, not a new memory authority. It carries references and revisions, never the
raw query, source payload, profile body, or Taste content.

## Required shape

| Field | Contract |
|---|---|
| `trigger` | Exactly one of `query { queryRef, queryRevision }` or `typed_event { eventKind, eventRef, eventRevision }`. |
| `predicateRevision` | Frozen eligibility predicate revision used for this construction. |
| `constructorRef` + `constructorRevision` | Projection builder identity and version. |
| `sourceRefs[]` | Each entry binds `sourceRef`, `sourceRevision`, `authorityRef`, and `eligibilityRef`. |
| `asOf` | Millisecond timestamp at which eligibility and source revisions were evaluated. |
| `delivery` | `eligible_only`, `omitted`, `presented`, or `drilled`, with evidence refs. |
| `application` | `not_observed`, `applied`, `dismissed`, or `mixed`, with refs when observed. |
| `outcome` | `not_observed` or `observed`, with refs when observed. |
| `invalidation` | `none_observed` or `invalidated`, with refs when invalidated. |
| `materialization` | `ephemeral`, or `persisted` with `viewRef` and literal `MemoryDerivedViewContract.v1`. |

## Invariants

1. The frame can be reconstructed at `asOf` from its trigger revision, predicate revision, constructor revision,
   and source revision tuples.
2. Delivery does not imply application; application does not imply a good outcome; a good outcome does not
   transfer authority to this frame.
3. Duplicate `sourceRef` + `sourceRevision` pairs fail validation.
4. Observed application, outcome, and invalidation states require evidence refs; unobserved states carry none.
5. Persisting a frame makes it a derived view. It must obey lineage, ACL, freshness, and fail-closed invalidation
   from `docs/architecture/memory-derived-view-contract.md`.

## Non-goals

- No central cue engine or mutable surface registry.
- No replacement for Taste, Profile, Person, Entity, Event, Diary, or provider authority.
- No production adapter for lanes whose generated closure declaration remains `missing`.
