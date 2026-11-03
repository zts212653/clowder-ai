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
  - packages/mcp-server/governance/cutovers/f325-native-task-test-retirement.json
  - packages/mcp-server/src/canonical-tool-registry.ts
  - packages/mcp-server/src/server-toolsets.ts
  - packages/mcp-server/src/managed-mcp-config.ts
  - packages/api/src/config/capabilities/codex-managed-mcp-migration.ts
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
  - packages/api/src/config/config-event-bus.ts
  - packages/api/src/config/capabilities/invocation-plugin-mcp-view.ts
  - packages/api/src/config/capabilities/plugin-mcp-environment.ts
  - packages/api/src/domains/cats/services/agents/providers/provider-mcp-config.ts
  - packages/api/src/domains/cats/services/agents/providers/kimi-mcp-surface.ts
  - packages/api/src/domains/cats/services/agents/providers/kimi-mcp-config.ts
  - packages/api/src/domains/cats/services/agents/providers/opencode-config-writer.ts
  - packages/api/src/domains/cats/services/agents/providers/codex-mcp-input.ts
  - packages/api/src/config/capabilities/plugin-mcp-exposure.ts
doc_anchors:
  - docs/decisions/044-mcp-resource-lifecycle-and-surface-budget.md
  - docs/features/F286-mcp-surface-lifecycle-governance.md
  - project-research/2026-08-01-f286-mcp-surface-census.md
  - feature-discussions/2026-08-01-f286-mcp-surface-lifecycle/README.md
  - feature-specs/2026-08-04-f286-phase-b-admission-contract.md
static_scan_hints: [resourceFamily, cutoverState, exposureTier, standaloneReason, allowedNextActions, registerFullToolset, EXPECTED_TOOLS, MCP_TOOLS_SECTION, compatibility alias, atomic cutover]
cited_by:
  - {feature: F327, date: 2026-10-27, delta: "Projects verified Host installation policy for new local plugin MCP contributions only into the Host-owned project; ordinary discovery and diagnostics share one nonpersistent view"}
  - {feature: F325, date: 2026-10-14, delta: "Atomically retires cat_cafe_run_task_test; normal Native uses canonical MCP discovery and the existing managed hold/status/cancel lifecycle"}
  - {feature: F325, date: 2026-09-29, delta: "P1 admits cat_cafe_run_task_test as one Task-scoped side-effect boundary with host-selected target and no model command/path parameters"}
  - {feature: F286, date: 2026-08-01, delta: "new cell for MCP semantic admission and atomic resource-family cutover"}
---

# MCP Surface Governance

Architecture cell: `mcp-surface-governance`

## Canonical Owner

F286 owns the policy and derived registry that decide which Clowder AI MCP semantic identities exist, which resource lifecycle and authority boundary each identity belongs to, how it is exposed by runtime/profile, and whether a complete resource family is eligible for atomic cutover.

This cell owns the cutover invariant: a runtime/profile must never advertise both replaced and canonical MCP surfaces. A migration bundle moves MCP registration/schema/descriptions, runtime catalogs/profiles/provisioning, L0 prompts, skills/conventions, deterministic fixtures, and any declared eval or observability consumer together. Rollback restores the previous exact release rather than retaining a second exposed surface.

F325 removes the temporary `cat_cafe_run_task_test` surface and exact-file coding grants. Ordinary Native members use canonical capability discovery and their accepted ToolExecutionPolicy. Durable execution extends the existing hold/status/cancel resource lifecycle, including explicit retry lineage; no parallel job tool family is added.

An isolated Host may project its current declared plugin MCP launch into an ordinary
member invocation. Existing canonical entries retain their original access-policy resolver.
For a new contribution absent from canonical, the same Host-generated installation policy
that normal activation would publish can supply a temporary entry, only in the trusted
calling project that matches this Host's capability root. A fallback global config does not
prove project ownership. Launch descriptors alone never authorize new entries.

The plugin cell owns verified installation, explicit enablement, activation and invalidation.
Ordinary CLI/ACP discovery and read-only diagnostics consume this same derived view; they
do not write canonical or shared CLI configuration. Existing refusals and overrides remain
effective. Missing, stale, colliding or ambiguous local activations stay unavailable rather
than selecting another instance or deployment.

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

## F333 direct native transport cutover

operator 948 retires the MCP secret-protection wrapper for both first-party and third-party servers.
`managed-mcp-config.ts` binds genuine installed first-party entrypoints to native HTTP headers from
the admitted turn; foreign command/URL configurations remain direct. The canonical gateway,
registrars, per-family policy, and callback identity remain their existing owners. There is no
replacement proxy, tool registry, credential store, or third-party backend-sharing change.

The persistent configuration owner migrates only proven first-party Codex project entries before
HTTP admission, preserving full backups and an explicit stdio profile. Preview/Alpha reads cannot
publish this migration. Six server names and tool schemas remain unchanged. Nonresident shell/
`gh`/`curl`/pre-push checks remain; third-party MCP per-call inspection is deliberately retired.

Invocation admission consumes the same verified local activation and member exposure scope before
ACP pool waits and Claude carrier launch. It captures transport descriptors using the existing resolver; the current-turn
credential binder remains responsible for callback authority. This introduces no new MCP identity
or exposure tier, and does not make a deployment's stored plugin launch a fallback for a missing
activation in an isolated Host view.

Claude print, SDK, background and PTY consume the admitted native MCP plan. Ordinary plugin environment
references resolve during capture; the existing transport binder supplies current-turn credentials
without re-expanding that environment. Read-only admission continues to skip unused tool discovery.
This shares the existing native resolver and credential owners, without changing native schema or launch authority.

Kimi consumes that same admitted native server plan through its existing project-file lease.
Its native HOME and member MCP switch are captured before launch. Because Kimi still discovers
lower native layers, a later read can only deny newly unapproved names; it cannot add permissions
or replace the admitted server settings. A changed native project root is rejected before lending
the project file. The original credential lease and conflict-preserving restoration remain owners.

OpenCode runtime configuration stays with its existing Host writer. Admission captures that
writer's native MCP plan and binary entrypoint separately from model/auth/instruction fields;
the writer consumes its owned copy after waits, retaining its existing configuration format,
user-merge rules, Pencil resolution and credential guard. This does not introduce another
provider or require native carriers to move their launch ownership into AgentService.

Codex captures resolved server inputs through the same admission hook. Its native TOML renderer
retains disabled shapes and per-launch credential binding; one-shot environment wrappers are
created for each launch rather than cached in the admitted plan. Live and public native launches
retain their own admitted MCP boundary, while read-only invocations skip unused tool discovery.

Committed capability-registry writes notify the existing config event bus from the two atomic
write owners, covering direct async writes, synchronous member inheritance and delegated project
sync. The domain event identifies the resolved project root; it contains no configuration or
credential values and does not trigger unrelated environment-key subscribers. Reads and failed
writes do not publish commits. This adds no cache, revision service or new configuration authority.

During admission, the existing invocation MCP reader records private versions of the formal global/project files it actually reads. The Host validates those versions after its last asynchronous capture and rejects a changed source before sending. Reads still resolve through the original owners; this introduces no cross-invocation configuration cache. Client-native files and plugin activation currentness keep their separate ownership boundaries.
