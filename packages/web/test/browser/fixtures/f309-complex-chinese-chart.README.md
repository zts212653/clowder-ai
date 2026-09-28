# F309 complex DOCX fixture

`f309-complex-chinese-chart.docx` is the synthetic document used by the published GenOffice
desktop and 390px acceptance journeys. It contains no user document data.

- Frozen SHA-256: `2b1eedeb4b15236ee654e84a726702f2e3d5d07fc4df100babe7bbc27b37701e`.
- Generated with the native `buildDocx`, `kitchenSinkBody`, and chart fixtures in
  `genspark-ai/genoffice` `v0.8.1039`, commit `e833fff87f5628cc681e0fd1a063ce64fde5baa4`,
  `packages/docx-engine/tests/helpers/build-docx.ts`.
- Clowder AI modifications (2026-09-06): Chinese pagination paragraphs, an explicit page break,
  an existing comment by `fixture-reviewer`, an ignorable custom paragraph property, and a
  custom XML part. The upstream table, image, numbering, formatting and chart are retained.
- This is a frozen test document, not an Office engine or a substitute owner implementation.
  Tests load, edit, save and reopen it using the actual published GenOffice artifact.
- The canonical browser lane uses this file when `GENOFFICE_DOCX_FIXTURE` is absent. Explicit
  alternate fixtures remain supported and are not silently replaced when unreadable.

The source fixture material is Copyright 2026 Mainfunc, Inc., licensed under Apache-2.0.
The exact frozen source license and notice accompany this document as
`f309-genoffice-LICENSE.txt` and `f309-genoffice-NOTICE.txt`. Those source notices also describe
other upstream application components; this fixture does not bundle their fonts or executables.
