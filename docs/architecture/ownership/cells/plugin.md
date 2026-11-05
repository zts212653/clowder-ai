---
cell_id: plugin
title: Plugin Framework
summary: Plugin Manager, verified package inventory, Host-bound clients, module lifecycle, ordinary actions/messages/streams and Console/Agent management; plugin business stays in packages.
canonical_features: [F202, F247, F285, F290, F292]
code_anchors:
  - packages/api/src/domains/plugin/chatgpt-dot-manifest.ts
  - packages/api/src/domains/cats/services/cloud-bridge/dot/DotConnectionService.ts
  - packages/api/src/domains/cats/services/cloud-bridge/dot/DotConnectionStore.ts
  - packages/api/src/domains/cats/services/cloud-bridge/dot/DotConnectionTestService.ts
  - packages/api/src/domains/cats/services/cloud-bridge/dot/DotConnectionRuntime.ts
  - packages/api/src/domains/cats/services/cloud-bridge/dot/DotPluginStateProjection.ts
  - packages/api/src/routes/chatgpt-dot-connection-routes.ts
  - packages/api/src/routes/chatgpt-dot-test-routes.ts
  - packages/web/src/components/settings/plugin-manager/DotConnectionDetail.tsx
  - packages/api/src/domains/plugin/plugin-config-store.ts
  - packages/api/src/domains/plugin/host-inventory/index.ts
  - packages/api/src/domains/plugin/builtin-runtime/carriers/module-plugin-runtime.ts
  - packages/api/src/domains/plugin/host-surface/plugin-neutral-host.ts
  - packages/api/src/domains/plugin/host-surface/collective-artifact-owner.ts
  - packages/api/src/domains/plugin/carrier/plugin-response-stream.ts
  - packages/api/src/domains/plugin/host-broker/index.ts
  - packages/api/src/domains/plugin/external-runtime/index.ts
  - packages/api/src/domains/plugin/content-editor-runtime/runtime.ts
  - packages/api/src/domains/plugin/host-broker/static-feature-authority.ts
  - packages/api/src/domains/plugin/runtime-composition.ts
  - packages/api/src/domains/plugin/desktop-window-runtime/runtime.ts
  - packages/api/src/domains/plugin/desktop-window-runtime/desktop-component.ts
  - packages/api/src/routes/concierge-desktop.ts
  - packages/api/src/domains/plugin/manager/plugin-manager-service.ts
  - packages/api/src/domains/plugin/manager/plugin-manager-projection.ts
  - packages/api/src/domains/plugin/official-catalog.ts
  - packages/api/src/domains/plugin/manager/official-catalog-provider.ts
  - packages/api/src/domains/plugin/official-package-installer.ts
  - packages/api/src/routes/plugin-manager-routes.ts
  - packages/shared/src/types/plugin.ts
  - packages/mcp-server/src/tools/plugin-management-tools.ts
  - packages/web/src/components/settings/plugin-manager/PluginManagerContent.tsx
  - packages/api/src/domains/cats/services/cloud-bridge/conversation-host-adapter.ts
doc_anchors:
  - docs/features/F202-plugin-framework.md
  - docs/features/F285-stackchan-physical-limb-plugin.md
  - docs/features/F247-cloud-cat-family.md
static_scan_hints: [PluginManagerService, PluginInventoryStore, ModulePluginRuntime, createPluginNeutralHost, NativePluginActions, PluginConfigPanel, plugin.yaml]
cited_by:
  - {feature: F247, date: 2026-10-10, delta: dot G1 source-bound Events and private original image consumer}
  - {feature: F202, date: 2026-05-31, delta: new cell}
  - {feature: F202, date: 2026-06-08, delta: schedule resources}
  - {feature: F285, date: 2026-08-01, delta: external official-plugin and physical-limb contribution boundary}
  - {feature: F292, date: 2026-08-08, delta: C-2 signal declaration/wire contribution boundary; durable intake stays in signal-intake}
  - {feature: F247, date: 2026-08-08, delta: narrow conversation Host Adapter seam with no implicit UI fallback}
  - {feature: F247, date: 2026-08-12, delta: isolated personal Chrome adapter, Native Messaging trust boundary, and receipt-bearing extension spike}
  - {feature: F247, date: 2026-08-12, delta: operator-only socket and pairing-secret composition activates the personal Chrome adapter without implying installation or browser consent}
  - {feature: F247, date: 2026-08-21, delta: explicit extension-originated exact conversation authorization persisted by Host; route binding remains ThreadStore-owned and all later gates are zero-focus}
  - {feature: F202, date: 2026-08-10, delta: K-2B contract-native Broker sessions, durable call ledger, and typed signal-intake edge}
  - {feature: F202, date: 2026-08-11, delta: K-2D supervised stdio runtime and dormant production composition}
  - {feature: F292, date: 2026-08-15, delta: Host-policy-pinned hot official release discovery with explicit release-fenced update}
  - {feature: F290, date: 2026-08-28, delta: bundled official Connector distribution and hybrid builtin/external lifecycle seam; Collective Service truth stays in collective-runtime}
  - {feature: F309, date: 2026-09-06, delta: archive-bound static editor admission and a separately declared private semantic worker reuse the same inventory and Broker feature authority}
  - {feature: F202, date: 2026-09-01, delta: terminal unified Manager projection, external catalog ownership, and same-source Console/Agent operations}
---

# Plugin Framework

## Current C1 Ownership

F202 owns verified package admission, installation/configuration/grant inventory, the Host-bound
client, lifecycle invocation, declared action routing, message delivery and stream access. Console,
REST and Agent management tools use the same Plugin Manager. Package-specific collection, business
mappings, external connections, helpers and retry state belong to each plugin.

The canonical public baseline is `clowder-ai-plugins/docs/plugin-development.md`: identity/Host
client, Plugin→Host, and Host→Plugin including lifecycle. Module lifecycle is
`preStart/start/configRefresh/preStop/stop/preUninstall/uninstall`. An absent refresh hook is a no-op;
config changes do not imply restart or invalidate the same activation. Stop, package replacement,
revoked grants and expired calls still invalidate access. The plugin manages its own helper process.

Host→Plugin `delivery` carries either a message or execution-status update; its receipt acknowledges
one delivery, not successful model execution. Both directions read bytes through `streams.read`;
ending a reader does not delete its source. Actions are ordinary declared handlers with transient
results. Host persists declared configuration and credentials, not QR challenges or old receipts.

Plugin→Host uses ordinary threads/messages/members and existing granted capabilities. Business
bindings live in package storage; there is no plugin-specific thread visibility registry. Meeting
notifications use `messaging.send` and package-owned pending state. Static signal declarations do
not expose a runtime publication API. The `signal-intake` cell records the retained Host message
consumer and the superseded historical intake boundary.

## Extend By

- Keep `plugin.yaml` the static contribution truth and use the activation's handler map; do not add
  a second dynamic registration surface.
- Join catalog candidates to verified inventory; installation, desired enablement and live runtime
  state are distinct facts. Catalog refresh cannot install or enable a plugin.
- Keep package schemas, SDK and source in `clowder-ai-plugins`; reuse ordinary Host capabilities
  instead of adding package-specific Host models or compatibility routes.
- Keep secrets/configuration in the existing Manager boundary and package business state private.
- Use the existing Host runtime validity checks; configuration revision is not activation identity.
- Keep public interface documentation synchronized with actual SDK types and consumers.

## Retained Specialized Consumers

Dot remains a built-in exception in this C1; its deferred alias/addressable-plugin proposal and
remaining Host-specific dispatch are recorded in F202. This does not authorize a Dot migration.
The installed personal Chrome companion owns its browser/native-helper business; Host provides
its existing generic conversation-host capability. Plugin-local HTTP services and their assets are
owned by the plugin lifecycle; they do not require a Host browser-service binding.

## F317 Desktop Consumer


The desktop companion is a verified declarative `desktop-window` contribution with
an explicit `windows.create` grant. It uses existing inventory, Broker and static
feature leases. The Host loads package HTML in a sandboxed Electron window; package
code cannot supply an executable, preload, credentials or conversation identity.
Explicit installation prepares the Host's pinned desktop component in a private
cache. The installing API retains its owner cookie and invokes existing conversation
routes through a closed bridge. Window creation does not grant media capture.

Presence is an expiring observation of the actual window process under its current
feature lease. The owner-local projection suppresses only the duplicate Hub body;
the canonical chat panel remains available. Failed, expired or revoked observations
restore the Hub entry without rewriting durable preferences or installation truth.

## Historical Checkpoints

The dated `cited_by` entries retain feature provenance. Earlier repository-local registries,
Host-owned personal Chrome adapters and K-2 signal-publication wiring are superseded by the current
C1 boundary above. Removed code is available in Git history, not in the current anchor list.
Internal carrier transport and retained declarative editor/desktop mechanisms are implementation
references, not additional public SDK interfaces or permission to supervise a plugin's own helper.
