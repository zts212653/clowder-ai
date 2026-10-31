---
cell_id: portable-governance
title: Runtime-First Portable Governance
doc_kind: architecture
created: 2026-08-22
summary: Zero-write external dispatch plus explicit preview/confirm/undo for minimal project governance materialization and safe F070 legacy cleanup.
description: Runtime-first external workspace governance with zero-write dispatch, opt-in preview and confirmation, reversible materialization, and safe F070 legacy cleanup.
description_source: model
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: 2026-08-22T10:45:03Z
description_confirmed_by: codex-sol
description_updated_at: 2026-08-22T10:45:03Z
canonical_features: [F070, F302]
code_anchors:
  - packages/api/src/config/governance/governance-bootstrap.ts
  - packages/api/src/config/governance/governance-bootstrap-plan.ts
  - packages/api/src/config/governance/governance-registry.ts
  - packages/api/src/routes/governance-status.ts
  - packages/api/src/routes/projects-setup.ts
  - packages/web/src/components/GovernanceInstaller.tsx
  - packages/web/src/components/HubGovernanceTab.tsx
  - packages/web/src/components/ProjectSetupCard.tsx
doc_anchors:
  - docs/features/F070-portable-governance.md
  - docs/features/F302-runtime-first-portable-governance.md
  - feature-specs/2026-08-21-f302-runtime-first-portable-governance.md
static_scan_hints: [GovernanceBootstrapService, GovernancePreviewConflictError, GovernanceSelection, GovernanceInstaller, governance-bootstrap-report, governance-registry, portable-governance]
cited_by:
  - {feature: F070, date: 2026-03-06, delta: historical bootstrap foundation}
  - {feature: F302, date: 2026-08-22, delta: new cell; runtime-first zero-write default and opt-in materialization}
---

# Runtime-First Portable Governance

## Canonical Owner

F302 owns the product boundary for optional project governance: exact-action
preview, checksum-fenced confirmation, undo from Clowder AI-owned ledgers, and
safe cleanup of F070 legacy generated files and symlinks. External dispatch is
ready without any project marker and must not write governance files.

## Use This When

- Changing whether an external project can be dispatched without prior setup.
- Adding or changing project governance selection, preview, confirmation, or
  undo behavior.
- Changing the Clowder AI-owned governance registry or F070 legacy cleanup rules.
- Changing the blank-repo setup prompt or Hub governance installer.

## Extend By

- Keep runtime instructions, HOME-mounted Skills, and invocation-resolved MCPs
  as the default carry-on layer; do not materialize them merely to establish
  readiness.
- Treat every target-repo write as explicit, previewed, selected, and
  checksum-fenced. Existing files are skip-only.
- Keep generated provenance in the Clowder AI registry. The target repository is
  project truth, not a second Clowder AI state store.
- Generate commands only from the target repository's manifests and CI facts;
  absence remains `unknown`.
- Delete legacy files only when the old report names them and their current
  content hash or symlink target still matches. Never recursively delete target
  directories or mutate `.cat-cafe/capabilities.json`.

## Do NOT Unify With

- F203 prompt/L0 compilation and carrier delivery.
- F228/F301 Skill mount and fleet-repair topology.
- F249 MCP capability resolution or `.cat-cafe/capabilities.json` ownership.
- F293 routing context or dispatch execution.
- F152 knowledge indexing, F251 public sync policy, or F289 canonical data-root
  migration.

## Static Scan Hints

Watch for governance readiness markers, implicit bootstrap calls, target-side
governance reports, recursive cleanup, writes to `capabilities.json`, action
execution without a matching preview checksum, and UI copy that promises
automatic synchronization.
