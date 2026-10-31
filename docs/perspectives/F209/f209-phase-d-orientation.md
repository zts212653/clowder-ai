---
schemaVersion: 1
id: F209/f209-phase-d-orientation
title: F209 Phase D Orientation
featureIds: [F209]
ownerCatId: codex
intent: Orient a fresh cat on F209 Phase D evidence without storing a result set or conclusion.
steps:
  - id: search-f209-phase-d-spec
    type: search_evidence
    query: F209 Phase D Perspective runtime contract AC-D0 AC-D7
    scope: docs
    mode: hybrid
    depth: raw
    limit: 5
    dimension: project
  - id: search-f209-d0-unblock
    type: search_evidence
    query: F209 D.0 Phase D UNBLOCK raw hybrid degraded file-slice entity expansion
    scope: docs
    mode: hybrid
    depth: raw
    limit: 5
    dimension: project
  - id: open-top-orientation-anchors
    type: open_anchor
    source: previous_step
    selector: top
    maxOpen: 3
outputPolicy:
  storesResults: false
  returnsConclusion: false
  requiresAnchors: true
---

# F209 Phase D Orientation Perspective

This Perspective is the first dogfood plan for Phase D. It should help a fresh cat reopen the F209 Phase D trail by running bounded recall steps and opening the highest-signal anchors.

The runner must treat this file as a query route. It must not cache the result set, write conclusions, or replace the cat's own reading and judgment.
