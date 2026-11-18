---
title: Microduck Show projection and media
doc_kind: reference
created: 2026-11-17
---

# Microduck Show

These four existing modules project the stage presentation manifest and resolve scene media at request time. They form the read-only presentation/delivery group, separate from the parent owner/control execution adapter and slot state machine.

- `microduck-show-contract.ts`: stage manifest and state contracts.
- `microduck-show-manifest.ts`: canonical stage truth and manifest projection.
- `microduck-show-media-contract.ts`: scene capture/media descriptors.
- `microduck-show-media.ts`: owner-authorized media resolution and byte validation.

The parent `microduck-owner-contract.ts` keeps its existing public re-export; callers enter through the same owner adapter/contracts. No new barrel, compatibility shim, owner assignment, store, permission or API contract is introduced.

The parent retains 21 direct TypeScript files for the existing owner/control lifecycle and adapter registry. This remains above the warning threshold, with that cohesive lifetime boundary documented rather than adding an unrelated group merely to reduce counts.
