---
cell_id: plugin
title: Plugin Framework
summary: Terminal Plugin Manager plus Host-governed package inventory, repository-local and builtin activation, Broker sessions, supervised execution, grants, resource adapters, Console and Agent management surfaces.
canonical_features: [F202, F247, F285, F290, F292]
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
  - packages/api/src/domains/plugin/content-editor-runtime/runtime.ts
  - packages/api/src/domains/plugin/host-broker/static-feature-authority.ts
  - packages/api/src/domains/plugin/content-materializer-runtime/runtime.ts
  - packages/api/src/domains/plugin/content-materializer-runtime/browser-runner.ts
  - packages/api/src/domains/plugin/runtime-composition.ts
  - packages/api/src/domains/plugin/builtin-runtime/hybrid-supervisor.ts
  - packages/api/src/domains/plugin/plugin-manager-service.ts
  - packages/api/src/domains/plugin/plugin-manager-projection.ts
  - packages/api/src/domains/plugin/official-catalog.ts
  - packages/api/src/domains/plugin/official-catalog-provider.ts
  - packages/api/src/domains/plugin/official-package-installer.ts
  - packages/api/src/routes/plugin-official-routes.ts
  - packages/api/src/routes/plugin-routes.ts
  - packages/api/src/routes/plugin-manager-routes.ts
  - packages/shared/src/types/plugin.ts
  - packages/mcp-server/src/tools/plugin-management-tools.ts
  - packages/web/src/components/settings/plugin-manager/PluginManagerContent.tsx
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
  - {feature: F290, date: 2026-08-28, delta: bundled official Connector distribution and hybrid builtin/external lifecycle seam; Collective Service truth stays in collective-runtime}
  - {feature: F309, date: 2026-09-06, delta: archive-bound static editor admission and a separately declared private semantic worker reuse the same inventory and Broker feature authority}
  - {feature: F202, date: 2026-09-01, delta: terminal unified Manager projection, external catalog ownership, and same-source Console/Agent operations}
---

# Plugin Framework

## Canonical Owner

F202 owns the terminal Plugin Manager and Host plugin control plane: manifest
validation, package admission, installation inventory, configuration readiness,
authorization projection, activation intent, supervised runtime state, plugin-owned
capability records, and activation of declared resources. Console, REST and Agent
management tools are consumers of one `PluginManagerService`; they are not separate
registries or authorities.

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
supervised child-process stdio bridge exercise the same state machine. F292's
official lifecycle composes package installation and explicit activation routes
onto these boundaries. Train B unifies their product projection; it does not build
a second supervisor.

F309's DOCX consumer adds a zero-effect static editor class: an exact public archive and
contribution are admitted by the official installer, explicitly enabled by the owner, and
connected through the existing Broker hello/ready/runtime lease. Static feature authority
stores its lease in the Broker ledger. It does not import package code into the Host.
The optional public `semanticMaterializer` declares a separate closed browser worker. F202
owns its verified private package snapshot, bundle SRI, sandboxed process, no-egress request
boundary, input/output/resource limits, cancellation and disposal. It receives only bounded
document bytes and typed operations; it cannot access a Host credential, owner-write API,
configuration, state API, raw lease or human browser. F202 revalidates installation/grant/
runtime/package authority before and after computation, and joins cancellation on disable.
F309 owns authenticated editor sessions and semantic intent identity; F138 retains the final
content CAS and receipts. Production composition stays dormant until explicit installation
and enablement; the public worker declaration does not authorize activation.

F292 keeps official-plugin policy and release metadata on opposite sides of the
trust boundary. Clowder AI statically owns catalog identity, package name, plugin
identity, grants, owner-auth runner/domains, and the permitted release channel.
Only a newer exact version, fixed-registry tarball, SHA512 integrity, and npm
provenance may refresh from that channel. Refresh is a bounded process-local
projection with monotonic last-known-good fallback, not installation truth.
Package update remains an explicit owner mutation fenced to the version+digest
that Settings displayed, and enable remains a later explicit lifecycle action.

Verified plugin presentation metadata follows the same ownership split. The plugin
manifest/package owns the default and localized capability description plus its icon
declaration and package-relative SVG/PNG asset. Core validates package paths and media,
then projects one description/icon truth to catalog search, Agent tools and Console.
Console must not infer visuals from package source or keep a private metadata map.

Dynamic contribution tools remain owned by the Host supervisor rather than becoming ungoverned canonical
registry entries or agent-owned MCP processes. The canonical Agent surface exposes two statically governed
indirections: `plugin_list_tools(pluginId)` returns schemas only for a currently active, authorized
contribution, and `plugin_call(pluginId, contributionId, toolName, arguments)` rechecks live package/grant
authority before delegating to the supervisor-held MCP client. Secrets and child-process lifecycle never
cross into the Agent provider.

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

- Changing Plugin Manager list/search/detail/install/enable/disable/uninstall semantics,
  or the status/capability projection shown to Console and Agent consumers.
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

- Keep `plugin.yaml` declarative and contract-owned for repository-local and
  published packages. Fixed lifecycle actions may carry structured command/args/mode;
  they do not admit arbitrary shell strings or become a second SDK.
- Join catalog candidates to Host inventory by verified identity. Persist package,
  instance, grant and activation truth only in Host inventory; keep config, auth,
  intent and live runtime as explicit orthogonal axes in the Manager projection.
- Route Console, REST and Agent operations through one application service. Public
  management verbs are list/search/get/install/set-enabled/uninstall.
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
- Keep the published catalog machine truth in `clowder-ai-plugins`; keep trust
  policy, configured origins, allowed registries/channels and admission in Host.
  Refresh must never imply install, enable, health or broader grants.
- Keep generic update/repair out of public Console, Agent and canonical Manager
  surfaces. If later required, define typed release replacement or integrity
  recovery journeys with explicit data migration and revision fences.
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
- Do not merge catalog discovery with installation inventory. Published availability
  is plugin-repository truth; installed/verified/running is Host truth.
- Do not keep repository-local, official and connector plugin managers as separate
  terminal product surfaces. Compatibility adapters may feed the Manager only until
  Train C deletes the old business paths.
- Do not load external executable plugins into the API process. Do not treat a
  verified package, configured instance or desired enabled flag as proof that a
  runtime is live; only the current supervisor/Broker lease proves live state.
- Do not expose `plugin_update`, `plugin_repair` or `updateAvailable` merely because
  an internal official lifecycle primitive exists.
- Do not let an external physical plugin register a parallel Limb registry,
  bypass F126 for actions, or turn device observations directly into cat intent.
- Do not absorb K-3a routes, `MeetingIntake`, source-resolution authority, or
  Needs Me state into plugin activation merely because the producer is a plugin.
- Do not treat ChatGPT conversation visibility in a desktop host as proof of an
  arbitrary-conversation append API, and do not use private endpoints to fill
  a missing official adapter.

## Static Scan Hints

Watch for new or renamed `PluginManagerService`, `PluginManagerProjection`,
`plugin_list`, `plugin_search`, `plugin_get`, `plugin_install`, `plugin_set_enabled`,
`plugin_uninstall`, `PluginRegistry`, `PluginResourceActivator`,
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
