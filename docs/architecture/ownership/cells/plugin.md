---
cell_id: plugin
title: Plugin Framework
summary: Repository-local plugin activation plus Host-governed external official-plugin contracts, grants, runtime isolation, and owned resource adapters.
canonical_features: [F202, F285]
code_anchors:
  - packages/api/src/domains/plugin/PluginRegistry.ts
  - packages/api/src/domains/plugin/PluginResourceActivator.ts
  - packages/api/src/domains/plugin/ScheduleFactoryRegistry.ts
  - packages/api/src/domains/plugin/plugin-manifest.ts
  - packages/api/src/domains/plugin/plugin-config-store.ts
  - packages/api/src/routes/plugin-routes.ts
  - packages/shared/src/types/plugin.ts
doc_anchors:
  - docs/features/F202-plugin-framework.md
  - docs/features/F285-stackchan-physical-limb-plugin.md
static_scan_hints: [PluginRegistry, PluginResourceActivator, ScheduleFactoryRegistry, plugin.yaml, pluginId, plugin-owned, factoryId, schedule, PluginConfigPanel]
cited_by:
  - {feature: F202, date: 2026-05-31, delta: new cell}
  - {feature: F202, date: 2026-06-08, delta: schedule resources}
  - {feature: F285, date: 2026-08-01, delta: external official-plugin and physical-limb contribution boundary}
---

# Plugin Framework

## Canonical Owner

F202 owns the trusted, repository-local plugin layer: plugin manifest discovery,
manifest validation, configuration persistence, plugin-owned capability records,
and activation of declared skill, MCP, limb, and schedule resources.

F285 adds the external **official-plugin** seam without moving authority out of
the Host. `clowder-ai-plugins` owns public contribution schemas, SDK/runtime
primitives, conformance assets, and official plugin source. Clowder AI owns
package admission, artifact identity, effective grants, runtime isolation,
resource adapters, and the existing domain control planes that those adapters
invoke. A plugin-declared contribution is a candidate resource, never proof of
identity, installation, permission, health, or execution authority.

## Use This When

- Adding or changing `plugins/<plugin-id>/plugin.yaml` manifest semantics.
- Changing plugin enable/disable, config persistence, resource activation, or
  plugin ownership metadata in `.cat-cafe/capabilities.json`.
- Adding plugin-facing Settings UI that configures, tests, enables, disables, or
  explains plugin-owned resources.
- Adding an external official contribution such as `physical-limb`, or changing
  the Host adapter that admits such a contribution into an existing control plane.
- Deciding whether a new capability belongs in the local plugin framework,
  the MCP marketplace/control plane, or a built-in integration surface.

## Extend By

- Keep plugin manifests declarative and repository-local unless a later feature
  defines remote package trust, signing, and network policy.
- Route skill, MCP, limb, and schedule declarations through `PluginResourceActivator`
  instead of adding parallel writers.
- Keep schedule factories behind `ScheduleFactoryRegistry`; plugin manifests may
  name a whitelisted `factoryId`, not arbitrary executable code.
- Preserve explicit plugin ownership metadata and reject cross-plugin ownership
  collisions.
- Keep config writes inside the existing secret/update boundary; manifests do
  not store user secrets.
- Keep external official plugin source and its conformance fixtures in
  `clowder-ai-plugins`; core consumes a versioned contribution contract through
  a reusable Host-owned adapter rather than adding product-specific branches.
- Bind package digest, installation instance, runtime session, grants, and
  resource identity from Host-owned state. External runtimes cannot choose or
  widen those identities through self-report.
- Route physical actions through F126 Registry / Policy / Lease / Action Log.
  Physical observations may enter only through a typed, grant-checked Host seam;
  raw sensor media and plugin-originated user identity are not admissible.

## Do NOT Unify With

- Do not merge this cell into `action-plane`: plugin activation may expose
  actions, but this cell owns the local extension lifecycle, not vendor action
  execution.
- Do not merge this cell into `transport`: plugin MCP resources are tools, not
  message transport adapters.
- Do not treat remote marketplace install/signing as already solved by F202
  Phase 1. That trust boundary needs a separate design slice.
- Do not load external executable plugins into the API process or treat the
  existence of a public SDK as proof that the production Host Broker has landed.
- Do not let an external physical plugin register a parallel Limb registry,
  bypass F126 for actions, or turn device observations directly into cat intent.

## Static Scan Hints

Watch for new or renamed `PluginRegistry`, `PluginResourceActivator`,
`ScheduleFactoryRegistry`, `PluginConfigStore`, `plugin.yaml`, `pluginId`,
`plugin-owned`, `factoryId`, `schedule`, `PluginConfigPanel`, and direct writers
to plugin-owned capability records.
