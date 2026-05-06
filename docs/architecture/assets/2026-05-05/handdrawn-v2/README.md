---
title: "Cat Cafe Architecture Diagrams — Handdrawn v2"
created: 2026-05-06
doc_kind: asset-note
source_snapshot: 2026-05-05
generator: "mixed: Codex image_gen drafts + deterministic SVG/PNG anchor-detail overlay"
---

# Cat Cafe Architecture Diagrams — Handdrawn v2

This directory contains the 2026-05-06 handdrawn bitmap variants of the 2026-05-05 Cat Cafe architecture diagram set.

The originals in `../` are preserved and remain the precise layout/text reference. These v2 images are presentation assets: warmer, cat-themed, and easier to scan visually. When exact small text matters, use the anchored SVG/PNG detail versions instead of pure raster image-generation output.

## Files

| File | Source |
|---|---|
| `01-hero-overview-handdrawn.png` | `../01-hero-overview.png` |
| `02-harness-engineering-map-handdrawn.png` | `../02-harness-engineering-map.png` |
| `02-harness-engineering-map-anchored.png` | anchor-detail version of `../02-harness-engineering-map.png` with exact OAI / ANT / FOW concept anchors |
| `02-harness-engineering-map-anchored.svg` | editable source for `02-harness-engineering-map-anchored.png` |
| `03-a2a-ball-ownership-flow-handdrawn.png` | `../03-a2a-ball-ownership-flow.png` |
| `04-dual-flywheel-handdrawn.png` | `../04-dual-flywheel.png` |
| `04.1-flywheel-expansion-handdrawn.png` | `../04.1-flywheel-expansion.png` |
| `05-runtime-stack-handdrawn.png` | `../05-runtime-stack.png` |

## Notes

- Most handdrawn variants began as Codex `image_gen` raster drafts. Diagram 2 additionally has an anchored detail version built as SVG/PNG so the external concept anchors stay exact and readable.
- F172 publication context: native tool-call image outputs land under `$CODEX_HOME/generated_images/...`; selected outputs were copied into this project directory as durable assets.
- Do not treat `codex exec --image <source-png>` as the native F172 image publication path. It creates a nested CLI session and will not publish into the current Cat Cafe message bubble.
- The Hero image received a small local text correction for the `暹罗 / Gemini` label after visual review.
