---
cell_id: plugin
title: Plugin Framework
summary: Repository-local plugin manifests, configuration, owned resource activation, schedule factory registration, and plugin-facing Settings surfaces.
canonical_features: [F202]
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
static_scan_hints: [PluginRegistry, PluginResourceActivator, ScheduleFactoryRegistry, plugin.yaml, pluginId, plugin-owned, factoryId, schedule, PluginConfigPanel]
cited_by:
  - {feature: F202, date: 2026-05-31, delta: new cell}
  - {feature: F202, date: 2026-06-08, delta: schedule resources}
---

# Plugin Framework

## Canonical Owner

F202 owns the trusted, repository-local plugin layer: plugin manifest discovery,
manifest validation, configuration persistence, plugin-owned capability records,
and activation of declared skill, MCP, limb, and schedule resources.

## Use This When

- Adding or changing `plugins/<plugin-id>/plugin.yaml` manifest semantics.
- Changing plugin enable/disable, config persistence, resource activation, or
  plugin ownership metadata in `.cat-cafe/capabilities.json`.
- Adding plugin-facing Settings UI that configures, tests, enables, disables, or
  explains plugin-owned resources.
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

## Do NOT Unify With

- Do not merge this cell into `action-plane`: plugin activation may expose
  actions, but this cell owns the local extension lifecycle, not vendor action
  execution.
- Do not merge this cell into `transport`: plugin MCP resources are tools, not
  message transport adapters.
- Do not treat remote marketplace install/signing as already solved by F202
  Phase 1. That trust boundary needs a separate design slice.

## Static Scan Hints

Watch for new or renamed `PluginRegistry`, `PluginResourceActivator`,
`ScheduleFactoryRegistry`, `PluginConfigStore`, `plugin.yaml`, `pluginId`,
`plugin-owned`, `factoryId`, `schedule`, `PluginConfigPanel`, and direct writers
to plugin-owned capability records.
