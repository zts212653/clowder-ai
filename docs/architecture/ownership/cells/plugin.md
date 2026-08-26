---
cell_id: plugin
title: Plugin Framework
summary: Repository-local plugin activation plus Host-governed external package inventory, Broker sessions, supervised stdio execution, grants, durable call settlement, owned resource adapters, and narrow receipt-bearing Host capabilities.
canonical_features: [F202, F247, F285, F292]
code_anchors:
  - packages/api/src/domains/plugin/PluginRegistry.ts
  - packages/api/src/domains/plugin/PluginResourceActivator.ts
  - packages/api/src/domains/plugin/ScheduleFactoryRegistry.ts
  - packages/api/src/domains/plugin/plugin-manifest.ts
  - packages/api/src/domains/plugin/plugin-config-store.ts
  - packages/api/src/domains/plugin/host-inventory/index.ts
  - packages/api/src/domains/plugin/host-broker/index.ts
  - packages/api/src/domains/plugin/host-broker/events-publish-handler.ts
  - packages/api/src/domains/plugin/external-runtime/index.ts
  - packages/api/src/domains/plugin/runtime-composition.ts
  - packages/api/src/domains/plugin/official-catalog.ts
  - packages/api/src/domains/plugin/official-catalog-provider.ts
  - packages/api/src/domains/plugin/official-package-installer.ts
  - packages/api/src/routes/plugin-official-routes.ts
  - packages/api/src/routes/plugin-routes.ts
  - packages/shared/src/types/plugin.ts
  - packages/api/src/domains/cats/services/cloud-bridge/conversation-host-adapter.ts
  - packages/api/src/domains/cats/services/cloud-bridge/personal-chrome-host/personal-chrome-host-adapter.ts
  - packages/api/src/plugins/cloud-cat-personal-host/native-host/native-host.mjs
  - packages/api/src/plugins/cloud-cat-personal-host/native-host/conversation-binding.mjs
  - packages/api/src/plugins/cloud-cat-personal-host/extension/manifest.json
doc_anchors:
  - docs/features/F202-plugin-framework.md
  - docs/features/F285-stackchan-physical-limb-plugin.md
  - docs/features/F247-cloud-cat-family.md
static_scan_hints: [PluginRegistry, PluginResourceActivator, ScheduleFactoryRegistry, PluginInventoryStore, HostBrokerControlPlane, HostBrokerStore, BrokerMethodHandler, IConversationHostAdapter, append_message, plugin.yaml, pluginId, plugin-owned, factoryId, schedule, PluginConfigPanel]
cited_by:
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

K-2A through K-2D make that Host authority executable without loading community
code into the API process. The inventory owns admitted package, installation,
grant, and activation truth. The Broker owns one-use handshake sessions,
runtime leases, and a durable call ledger whose recovery consults the owning
domain's canonical settlement before it can redispatch. Builtin loopback and a
supervised child-process stdio bridge exercise the same state machine. Production
composition constructs and restart-recovers these boundaries, but exposes no
activation route and starts no package, so live runtime remains dormant.

F292 keeps official-plugin policy and release metadata on opposite sides of the
trust boundary. Clowder AI statically owns catalog identity, package name, plugin
identity, grants, owner-auth runner/domains, and the permitted release channel.
Only a newer exact version, fixed-registry tarball, SHA512 integrity, and npm
provenance may refresh from that channel. Refresh is a bounded process-local
projection with monotonic last-known-good fallback, not installation truth.
Package update remains an explicit owner mutation fenced to the version+digest
that Settings displayed, and enable remains a later explicit lifecycle action.

F247 owns the first narrow conversation Host capability seam:
`append_message(conversationId, text, idempotencyKey)` returns a durable Host
message ID. The seam is an admission point, not proof that a provider exposes
the capability. A missing adapter fails closed; foreground browser/composer
automation is a separate, explicitly enabled legacy transport.

The personal Chrome path is one concrete, explicitly user-installed adapter
behind that seam. Clowder AI owns the authenticated local socket and pairing;
the Native Messaging helper owns native framing, durable idempotency settlement,
and ambiguous-effect recovery; the extension owns the minimum-permission page
operation and may settle success only from a DOM-provided Host message ID. The
adapter may be composed explicitly from a validated socket path and pairing
secret, but that operator-only seam neither installs into a user's normal Chrome
profile nor makes fixture selectors evidence of the live ChatGPT contract. Missing
or partial configuration fails closed and cannot silently enable foreground control.
Clowder AI's owner-only `cloudCatBindings(threadId, catId)` remains route truth; it is
not copied into the extension/helper. Separately, the extension may authorize one
exact open conversation only from the user's explicit “绑定此会话” action, and the
helper persists that authorization in its private Host root. Append admission
requires the routed ID to match the authorization before ledger/browser effects.
Missing authorization is typed `NEEDS_BINDING`; health checks, gates, retries, and
delivery may inspect/reuse Host state but may not select, focus, navigate, reload,
close, or restore owner tabs/windows.

## Use This When

- Adding or changing `plugins/<plugin-id>/plugin.yaml` manifest semantics.
- Changing plugin enable/disable, config persistence, resource activation, or
  plugin ownership metadata in `.cat-cafe/capabilities.json`.
- Adding plugin-facing Settings UI that configures, tests, enables, disables, or
  explains plugin-owned resources.
- Adding an external official contribution such as `physical-limb`, or changing
  the Host adapter that admits such a contribution into an existing control plane.
- Adding a provider Host capability such as background conversation append, or
  changing its receipt/idempotency contract.
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
- Keep official catalog policy static in Host code. Refresh only exact release
  coordinates from a fixed registry/channel, require SemVer monotonicity plus
  tarball/SHA512/provenance validation, retain last-known-good metadata on
  failure, and reject rollback or same-version equivocation.
- Fence an explicit official package update to the version and digest the owner
  confirmed. A refresh must never auto-install, auto-update, auto-start, or
  widen identity, grants, auth runners, domains, or release channels.
- Bind package digest, installation instance, runtime session, grants, and
  resource identity from Host-owned state. External runtimes cannot choose or
  widen those identities through self-report.
- Admit only methods marked ready by the exact published wire registry. Validate
  every frame with contract-owned validators and never mirror public wire
  schemas or method registries in core.
- Launch external packages only from Host-owned immutable digest paths, through
  the supervised process adapter, with the closed non-secret bootstrap environment.
- Persist dispatch intent before invoking a domain handler. Recovery may return
  a domain's canonical receipt, but must not blindly replay an ambiguous effect.
- Keep domain adapters narrow: the Broker owns transport settlement, while the
  receiving domain owns authorization, idempotency, and durable product truth.
- Keep C-2 signal declaration, wire, generated types, SDK helpers, conformance,
  and official input-source plugin code in the public plugin seam. Route
  admission, idempotent settlement, durable workflow intake, source access,
  and Needs Me eligibility belong to `signal-intake`, not this cell.
- Keep Host capability interfaces narrow and receipt-bearing. Do not synthesize
  provider success or silently substitute a more invasive transport.
- Keep personal browser adapters user-installed and origin-pinned. Authenticate
  the local caller before dispatch, strip local secrets before Native Messaging,
  persist intent before browser effects, and fail closed on missing or ambiguous
  Host receipts.
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
- Do not load external executable plugins into the API process. Do not treat a
  constructed/recovered dormant supervisor as proof that any package was started
  or that an external plugin runtime is live.
- Do not let an external physical plugin register a parallel Limb registry,
  bypass F126 for actions, or turn device observations directly into cat intent.
- Do not absorb K-3a routes, `MeetingIntake`, source-resolution authority, or
  Needs Me state into plugin activation merely because the producer is a plugin.
- Do not treat ChatGPT conversation visibility in a desktop host as proof of an
  arbitrary-conversation append API, and do not use private endpoints to fill
  a missing official adapter.

## Static Scan Hints

Watch for new or renamed `PluginRegistry`, `PluginResourceActivator`,
`ScheduleFactoryRegistry`, `PluginInventoryStore`, `HostBrokerControlPlane`,
`HostBrokerStore`, `ExternalPluginRuntimeSupervisor`, `PluginRuntimePersistencePaths`,
`BrokerMethodHandler`, `PluginConfigStore`, `plugin.yaml`, `pluginId`,
`plugin-owned`, `OfficialPluginCatalog`, `RefreshingOfficialPluginCatalog`,
`OfficialPluginPackageInstaller`, `factoryId`, `schedule`, `PluginConfigPanel`, and direct writers
to plugin-owned capability records. Also watch `IConversationHostAdapter`,
`append_message`, provider receipts, and implicit browser/composer fallbacks.
For the personal Chrome path also watch `PersonalChromeHostAdapter`,
`createNativeHostBridge`, Native Messaging manifests, extension host permissions,
and any browser API that can activate, focus, navigate, or inspect credentials.
