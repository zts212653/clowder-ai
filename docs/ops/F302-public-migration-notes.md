---
title: F302 Runtime-First Portable Governance — Public Migration Notes
doc_kind: ops-report
created: 2026-08-22
date: 2026-08-22
status: draft
feature: F302
audience: clowder-ai maintainers and operators
description: Migration guidance for F302's zero-write external dispatch, opt-in governance installer, safe legacy cleanup, and public package behavior changes.
description_source: model
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: 2026-08-22T10:45:03Z
description_confirmed_by: codex-sol
description_updated_at: 2026-08-22T10:45:03Z
---

# F302 Public Migration Notes

## Behavior change

- Dispatching a cat into an external repository no longer requires a governance
  marker and no longer writes governance files automatically.
- Project Setup handles only the selected clone / Git-init action. It does not
  install `AGENTS.md`, provider entry files, Skills, or documentation templates.
- Governance installation is now an explicit three-group selection with an
  exact-action preview. Execution requires confirmation of that preview's
  checksum.
- The canonical generated project guide is `AGENTS.md`. Optional `CLAUDE.md`
  and `GEMINI.md` files are thin imports; no `KIMI.md` is generated.

## Existing installations

Existing generated files remain untouched during upgrade. Operators may open
the Governance section, preview cleanup, and confirm only the actions they can
see. Cleanup deletes a legacy file or symlink only while it still matches its
generation evidence. Edited files are skipped, directories are never removed
recursively, and `.cat-cafe/capabilities.json` is never modified.

## Account resolution and target sidecars

External-workspace dispatch resolves provider accounts from the Clowder AI runtime
data root. It does not create or migrate a target-side
`.cat-cafe/cat-catalog.json`. If an earlier or experimental build created that
file, F302 leaves it untouched: neither installation nor legacy cleanup claims
ownership of user or provider account state.

## New and existing repositories

- Existing repository: no setup prompt and no target-repository write. Cats can
  work immediately with runtime-provided instructions, Skills, and MCPs.
- Blank repository: an optional Git setup card may appear. After that choice,
  minimal governance can be previewed separately; every group remains optional.
- Headless and background operation: no automatic governance materialization.

## Outbound sync reconciliation

The public-delta gate must remain fail-closed for this migration. Against the
current public baseline, a sync that includes F302 has four expected
manual-review paths:

- `governance-preflight.ts` and its three readiness-only tests are intentional
  removals. They retire the old marker gate rather than replace it with another
  compatibility path.

The validated export reports no conflict candidates and requires no operator
approval. The sync operator must still review the four deletion candidates and
record the fresh F251 disposition in the sync PR. Do not predeclare overrides,
use a whole-file replacement, or skip the public-delta gate.

## Rollback

Reverting the Clowder AI release restores the previous application behavior but
does not recreate files already removed through a confirmed cleanup. Before
confirming cleanup, preserve the preview and use source control or a repository
backup for any generated files that must be recoverable outside Clowder AI.
