---
cell_id: mcp-surface-governance
title: MCP Surface Governance
summary: Canonical ownership for Clowder AI MCP semantic identity, resource-lifecycle admission, exposure tiers, and atomic cross-layer cutover without dual exposed surfaces.
description: Governance boundary for deciding which Clowder AI MCP semantics exist and how one complete resource family changes shape.
description_source: human
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: "2026-08-01T09:06:00-07:00"
description_confirmed_by: operator
description_updated_at: "2026-08-04T10:59:42-07:00"
doc_kind: architecture
created: 2026-08-01
canonical_features: [F286]
mcp_selector_status: accepted
mcp_selector_claims:
  - ref: architecture-cell:mcp-surface-governance
    toolName: cat_cafe_search_evidence
    resourceFamily: evidence-navigation
    field: mode
    role: read-strategy
    decision: accepted
code_anchors:
  - packages/mcp-server/src/canonical-server-tools.ts
  - packages/mcp-server/src/tools/native-task-test-tool.ts
  - packages/mcp-server/src/canonical-tool-registry.ts
  - packages/mcp-server/src/server-toolsets.ts
  - packages/mcp-server/src/tool-governance.ts
  - packages/mcp-server/src/tool-governance-cli.ts
  - packages/mcp-server/src/tool-governance-selectors.ts
  - packages/mcp-server/src/tool-governance-string-domain.ts
  - packages/mcp-server/src/tool-governance-evidence.ts
  - packages/mcp-server/src/tool-cutover.ts
  - packages/mcp-server/governance/mcp-surface-baseline.json
  - packages/mcp-server/test/tool-registration.test.js
  - packages/mcp-server/test/server-toolsets-annotations.test.ts
  - packages/api/src/config/capabilities/mcp-constants.ts
  - packages/api/src/config/capabilities/capability-orchestrator.ts
doc_anchors:
  - docs/decisions/044-mcp-resource-lifecycle-and-surface-budget.md
  - docs/features/F286-mcp-surface-lifecycle-governance.md
  - project-research/2026-08-01-f286-mcp-surface-census.md
  - feature-discussions/2026-08-01-f286-mcp-surface-lifecycle/README.md
  - feature-specs/2026-08-04-f286-phase-b-admission-contract.md
static_scan_hints: [resourceFamily, cutoverState, exposureTier, standaloneReason, allowedNextActions, registerFullToolset, EXPECTED_TOOLS, MCP_TOOLS_SECTION, compatibility alias, atomic cutover]
cited_by:
  - {feature: F325, date: 2026-09-29, delta: "P1 admits cat_cafe_run_task_test as one Task-scoped side-effect boundary with host-selected target and no model command/path parameters"}
  - {feature: F286, date: 2026-08-01, delta: "new cell for MCP semantic admission and atomic resource-family cutover"}
---

# MCP Surface Governance

Architecture cell: `mcp-surface-governance`

## Canonical Owner

F286 owns the policy and derived registry that decide which Clowder AI MCP semantic identities exist, which resource lifecycle and authority boundary each identity belongs to, how it is exposed by runtime/profile, and whether a complete resource family is eligible for atomic cutover.

This cell owns the cutover invariant: a runtime/profile must never advertise both replaced and canonical MCP surfaces. A migration bundle moves MCP registration/schema/descriptions, runtime catalogs/profiles/provisioning, L0 prompts, skills/conventions, deterministic fixtures, and any declared eval or observability consumer together. Rollback restores the previous exact release rather than retaining a second exposed surface.

## Use This When

- Adding a Clowder AI-owned top-level MCP tool or a new action to an existing resource lifecycle.
- Consolidating, splitting, lazy-loading, renaming, projecting, or retiring Clowder AI MCP semantics.
- Changing tool descriptions, exposure profiles, standalone boundary reasons, action counts, or allowed-next-action contracts.
- Planning a resource-family cutover that touches MCP code plus prompt/skill/eval consumers.
- Detecting duplicate local/connector projections or stale full-versus-split topology references.

## Extend By

The F286 owner accepted the narrow canonical read-selector seam in coordination
`coord-e2c0b174-954a-4bd8-a4d2-1cd95eef72a3` for PR #5000. `search_evidence.mode`
selects retrieval strategy within one `read` action; it does not select identity,
authority, mutation, or resource transitions. Its optional lexical/semantic/hybrid
schema remains executable truth. Document calls retain the lexical default and
message calls retain the hybrid default. Local-process document reads and
authenticated invocation/agent-key message reads declare their actual separate
authorization paths. This claim admits only this exact tool/family/field/role.

Canonical single read operations may declare a `read-strategy` selector with
subject-bound accepted evidence. The normalized executable schema derives its
literals and the registry reports selector additions/removals separately from
action-count changes. `action`, `operation`, and `decision` cannot be exempted;
undeclared finite `mode`, write/destructive boundaries, invalid declarations,
unresolved claims, and changed migration candidates continue to fail closed.

- Derive registry and guard data from canonical tool definitions; do not maintain a second hand-written inventory.
- Require a birth certificate for every semantic identity: resource family, operation, actor authority, risk, exposure tier, owner, standalone reason, cutover state, cognitive entry, and verification evidence.
- For migration, declare the exact old/new semantic set and every hard/soft/eval asset in one cutover manifest.
- Build the replacement off-registry, verify the complete bundle, then activate the canonical surface and remove all replaced names/references in one reviewed release.
- Report top-level name, per-resource action-count, runtime/profile, and estimated-description deltas without turning numeric budgets into the governing objective.

## Do NOT Unify With

- Do not absorb the business semantics or state machines of task, memory, signal, audio, thread, or other resource owners. This cell governs MCP identity and cutover, not domain truth.
- Do not absorb `hub-action-surface`; that cell owns first-party Hub user-visible side effects.
- Do not absorb `plugin`; that cell owns plugin resource activation and marketplace metadata.
- Do not absorb F153 telemetry or F192 eval ownership. This cell names required consumers and consumes their evidence but does not create a second metrics/eval control plane.
- Do not create a universal `manage(resource, action, payload: any)` tool or use a compatibility alias as rollback infrastructure.

## Static Scan Hints

Watch for `registerFullToolset`, `EXPECTED_TOOLS`, tool registration/annotation arrays, runtime MCP server catalogs, connector projections, `resourceFamily`, `cutoverState`, `exposureTier`, `standaloneReason`, `allowedNextActions`, `MCP_TOOLS_SECTION`, skill references to retired tool names, and any diff that leaves old and new MCP identities visible together.
