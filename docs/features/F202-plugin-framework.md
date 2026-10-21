---
feature_ids: [F202]
related_features: [F041, F126, F129, F133, F139, F140, F141, F146, F190, F240, F241, F285, F292]
topics: [plugin-framework, plugin-manager, host-inventory, capability-registry, settings, resource-activation, catalog, agent-tools]
doc_kind: spec
created: 2026-05-15
architecture-cell: plugin
tips_exempt: "Generic messaging, Task data and plugin-owned services use existing Settings, conversation and feedback-card entry points. The interface consolidation adds no separate user-discoverable action; the feedback card describes draft creation directly. The consolidated migration scope and incompatible-install diagnostics use the existing Manager. Git marketplace and local-directory discovery are documented by their existing capability tips; shared member avatars add no separate action. Personal Chrome setup is available only after installing an exact trusted candidate; its Manager card provides the installation and extension-loading instructions at the point of use, rather than advertising an unavailable catalog release. Renewal 2026-10-21 keeps publication and home-repair records in Internal Notes while retaining the public product scope and existing Manager discovery; neither the source merge nor these records activate a runtime."
mcp_admission_status: accepted
mcp_admission_ref: "file:docs/features/F202-plugin-framework.md"
mcp_admission_claims:
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_list
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_search
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_get
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_list_tools
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_call
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_install
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_set_enabled
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
  - ref: "file:docs/features/F202-plugin-framework.md"
    toolName: plugin_uninstall
    resourceFamily: plugin-manager
    boundaryKind: resource-entry
    decision: accepted
description: "Defines Host plugin admission, lifecycle authority, shared Settings/Agent management, and the separate Train B/C1/C2 boundaries."
description_source: model
description_author: codex-astra
description_updated_at: 2026-09-19T12:49:07+00:00
description_generated_by: gpt-6-astra
description_generated_at: 2026-09-19T12:49:07+00:00
description_confirmed_by: codex-astra
---

# F202: Plugin Manager and Host Interfaces

> **Status**: in-progress (Train B direction accepted in
> [clowder-ai#1478](https://github.com/zts212653/clowder-ai/issues/1478); formal review and
> published-package integration verified; Train B home intake merged, runtime activation separate) | **Owner**: community @mindfn + Clowder AI maintainers | **Priority**: P1

## Outcome and Scope

One Plugin Manager handles verified package discovery, installation, configuration, grants and lifecycle.
Host supplies ordinary resource APIs; packages own provider connections, routing, business mappings and
private state. Console and Agent management use the same inventory and runtime facts.

C1 packages seven IM connectors, GitHub Operations, media tools, Personal Chrome, enterprise workflow,
Collective, GenOffice and Feishu meeting intake. Dot remains built in; Tripo is excluded. C2 owns plugin
UI embedding and the separately scoped managed-service extensions.

The public interface reference is `clowder-ai-plugins/docs/plugin-development.md`. It contains identity
and Host client, Plugin→Host, and Host→Plugin, including lifecycle. Current PR checks expose validation
status. C1 operator acceptance passed with installed packages and real accounts before the merged-baseline
replay. Replayed Host and package changes require paired validation and renewed acceptance. Soak, distribution
prerequisites and maintainer acceptance remain release requirements; source delivery alone does not
authorize integration or release.

## Source

- Community PR: [clowder-ai #686](https://github.com/zts212653/clowder-ai/pull/686)
- PR author: `mindfn`
- Feature ID assignment: `F202`, assigned by You on 2026-05-15.

## Why

Installing or configuring a plugin should not require users to edit several Host runtime files. A
shared manager makes installation, enablement, configuration and runtime state visible while keeping
plugin business out of the Host implementation.

Clowder AI already has pieces of a capability ecosystem:

- F041 made `.cat-cafe/capabilities.json` the static capability truth source.
- F126 introduced the limb control-plane boundary.
- F129 defined pack/mod direction and rejected unsafe same-power script plugins.
- F146 moved MCP addition toward a managed marketplace/control-plane flow.
- F190 added the settings shell that can host capability and integration controls.

What is still missing is a local plugin framework that lets a plugin declare owned resources in one folder, be configured through the Hub, and activate those resources without manual edits to multiple runtime files.

PR #686 is a concrete Phase 1 implementation proposal for that missing layer. It was originally labeled `F197`, but upstream `F197` is already occupied by ACP tool result event surfacing. This feature spec is the upstream anchor for the plugin framework work.

## User Journey

Scope: one catalog candidate or installed plugin instance.

1. Open Settings → Plugins to search verified catalog entries and installed plugins. Catalog failure
   does not hide installed plugins.
2. Install a published package or explicitly selected development source. Host verifies its manifest,
   dependencies and identity, then creates an immutable installed copy.
3. Configure credentials and grant the declared capabilities. Configuration fields and action buttons
   appear in manifest order. A test or connection action returns a transient result, not persistent health.
4. Enable the plugin. Host invokes its lifecycle; the plugin opens its connections and manages its helpers.
5. Use the declared tools, message subscriptions and actions. Messages and attachments follow the ordinary
   Host APIs. The detail page shows configuration and runtime facts separately.
6. Disable to stop activity while retaining installation and governed data. Uninstall applies the declared
   data policy without deleting unrelated user data. Installing new source explicitly replaces the
   immutable package; a source checkout or Host restart alone does not update it.

Installed packages whose manifests are incompatible with the current contract remain visible in
Plugin Manager with their instance identity, original grant records, configuration and data preserved.
Host and compatible plugins continue to run; incompatible packages cannot start or receive calls.
Without a higher compatible catalog version, Manager reports that no update is available and hides the
update action. A compatible replacement passes normal admission and replaces the package atomically;
failed replacement retains the original installation and data. After replacement, explicitly enable
the plugin. Corrupt inventory structure, inconsistent identities and invalid digests still reject startup.

## Interface and Ownership

Architecture cells: plugin, collective-runtime.
Map delta: local content authority remains behind the activation-fenced module owner port.
Why: moving remote business into a package must preserve local content, review and custody authorization.

Personal Chrome's local Native Messaging registration is a Host-owned setup operation. One exact-package
policy supplies both the Manager field and its execution matcher; it is not a plugin manifest action or
an SDK capability. The authenticated local owner confirms installation/removal, the Host suspends runtime
under a maintenance lock and invokes the verified package's fixed setup protocol with Host-selected paths.
Inspection is read-only. Failed runtime recovery preserves the reported setup outcome and asks the owner
to inspect before retrying; an unknown child outcome never triggers an automatic mutation retry. Installing
the helper does not prove Chrome connection or conversation authorization. Runtime grant reconciliation
adds only requested, allowlisted capabilities (including Collective's ordinary `plugin.config.read`) and
retains installation identity, package, configuration and data.

Host owns package verification, inventory, configuration/secrets, grants, lifecycle and ordinary resource
operations. Packages own provider behavior and their storage. Plugin identity is bound by Host; business
payloads do not supply authorization identity. Plugins use ordinary threads/messages/members without a
second thread-visibility system. Thread creation is ordinary creation; after an uncertain failure the
plugin can create again and update its own mapping.

Host→Plugin delivery carries a message or execution-status update. Its receipt acknowledges that input,
not model completion or an end user's read. Both directions use streams.read; closing a reader preserves
the underlying attachment. Meeting notifications use ordinary messaging and package-private pending state.

Lifecycle hooks are preStart, start, configRefresh, preStop, stop, preUninstall and uninstall. A missing
refresh hook is a no-op. Plugins explicitly refresh cached resources and manage their own helper processes.
Configuration updates keep the current activation usable; stop, package replacement, grant and caller
validity checks still apply. QR challenges and polling state belong to plugin storage; only declared
configuration/credential targets and generic UI step position persist in Host.

Clowder AI keeps a small, stable kernel. Core owns lifecycle stages, typed hook and capability contracts,
Host-side scheduling/ordering/isolation, UI slot policy, authorization, trace, settlement, and complete
revocation on disable or uninstall. The public SDK is the only plugin authoring surface: a plugin registers
handlers and declarative contributions against those bounded contracts, while Core invokes them without
knowing whether the implementation is TTS, translation, an IM provider, or another business feature.

Plugin notifications use the same conversation target resolution, queue admission and drain as user
messages. An unknown, deleted or unavailable mention falls through to ordinary conversation routing,
including the recent available member. The message remains a normal visible thread fact; plugins do not
preflight the member directory or maintain a separate routing/failure protocol.

GitHub operations use `gh` and ordinary plugin actions/MCP capabilities. Review notifications, delegation
and completion use ordinary messaging, mentions and Tasks. Host does not expose custody, deployment,
feedback-draft or browser-service business ports. The feedback card supplies explicit content to the
plugin's owner action and displays its returned draft; draft storage and publication belong to the plugin.
Persisted feedback content is retained independently of GitHub drafts.

Collective owns its HTTP listener, configured port, static client assets and internal requests. Its
start/stop lifecycle opens and closes the listener; changing the port requires an explicit stop/start.
Owner authentication, allowed origins and the GitHub OAuth callback are enforced by the plugin. Host
uses the ordinary declared action to obtain the page URL and does not allocate ports or dispatch its
internal HTTP requests.

The retained local content/review/media/custody owners remain Host authorities behind the narrow,
activation-fenced `collectiveArtifactOwner` module port. Service credentials, routing, polling and
publication relay belong to the package. Retained-media owner actions require current authenticated
Host HTTP context; no local principal is supplied by the plugin. Host message/media facts and plugin
Work receipts jointly authorize document publication without restoring a builtin Work binding.

- Deliver the final single Plugin Manager in Core, including catalog discovery, Host inventory projection,
  local directory/archive admission, installation, configuration/auth visibility, enable/disable,
  uninstall, capability listing, runtime diagnostics, the six Agent management tools, and the two governed
  contribution discovery/invocation tools.
- Catalog publication truth lives in `clowder-ai-plugins`; Core validates configured origin, exact version,
  digest, provenance and trust policy. A catalog row is never installation or activation truth.
- Host inventory owns installed package, instance, grant and activation truth; supervisor/Broker own live
  runtime truth. Aggregate UI status is a pure projection, not another persisted state machine.
- Generic `plugin_update`, `plugin_repair` and `updateAvailable` are not public Console, Agent or canonical
  Manager capabilities. Narrow internal recovery primitives may remain implementation details.
- Existing repository-local and connector implementations may temporarily enter the projection through
  compatibility adapters, but there is still only one user-facing management surface.
- The terminal Console keeps lifecycle actions on the fixed-height list card (Install, or uninstall +
  enable toggle), places offline install at page top-right, and uses the right detail only for manifest
  description, configuration, capabilities and diagnostics.
- Prove the two-repository closed loop with one real `video-analysis` package: publish an exact artifact,
  discover/install/configure/enable/use/restart/disable/uninstall it through the public contract and final
  Manager, without switching the production default path.

### Train C1 — inventory migration and deletion (separate follow-up)

The accepted Train B direction does not approve the aggregate migration or commit to a C1 delivery date.

- `clowder-ai-plugins` delivers one aggregate migration PR containing every remaining in-scope IM provider,
  connector and repository-local business plugin from the frozen inventory.
- Clowder AI delivers one aggregate cutover PR: migrate config/bindings/data, switch the default paths,
  prove no double-run, then remove provider-specific implementation, in-process loader, routes and the old
  IM/plugin management surfaces.
- The Core cutover is deletion-dominant. It may add only the narrow migration/cutover wiring required to
  consume the already-established Host plane; it does not redesign the Manager, add a second Agent contract,
  or introduce business-specific Host branches.

### Train C2 — public hook/UI extensions and managed services

- Open a typed hook or UI slot only with its first real migrated consumer. The contract package defines the
  point, payload/result, ordering, timeout/failure semantics and capability; the SDK exposes registration;
  Host provides business-blind invocation and lifecycle revocation.
- Migrate managed services, including TTS/ASR, through those public seams. For example, Core triggers a
  stable output/render stage and a voice plugin registers the handler; Core does not know the provider or
  synthesis business logic. Message events may remain an internal transport detail rather than the plugin
  author's integration API.
- Declarative UI contributions target only Host-owned registered slots and commands. A slot lands together
  with the acceptance that plugin disable/uninstall removes both its button/icon and command handler.

The detailed state census, invariants, Design Gate and TDD sequence are retained in the
[upstream Train B implementation plan](https://github.com/zts212653/clowder-ai/blob/9ab0eaf287381efcb209781463f38cc5f23870ea/feature-specs/2026-09-01-f202-terminal-plugin-manager.md).

### Historical Train B direction and implementation checkpoint (2026-09-18)

Maintainers accepted the bounded Train B direction in
[clowder-ai#1478](https://github.com/zts212653/clowder-ai/issues/1478): one Host-owned Manager and one
real `video-analysis` package loop, with existing production defaults unchanged. Train C1 and C2 remain
separate follow-ups. This accepts the review scope; it does not prove package publication, final
integration acceptance, or merge readiness.

The feature worktree now contains the shared closed projection contract, one
`PluginManagerService`, safe local directory/archive admission, the six canonical management operations
through REST and Agent, two Host-supervised contribution discovery/invocation operations, a revision-fenced
typed configuration contribution, bounded multipart upload,
and production composition over the existing Host inventory,
Broker, supervisor, official installer and owner-auth port. Focused tests exercise catalog degradation,
revision fences, local path non-persistence, auth fail-closed recovery, uninstall failure, and the full
install → config/auth → enable → Host restart → disable → uninstall journey.

This is an implementation checkpoint, not a Train B completion or merge claim:

- Co-creator approved the Settings list/detail direction on 2026-09-01 and authorized formal wiring to
  continue; the exact wording and architecture evidence are retained in the
  [upstream design record](https://github.com/zts212653/clowder-ai/blob/9ab0eaf287381efcb209781463f38cc5f23870ea/feature-discussions/2026-09-01-f202-terminal-manager-design/README.md). The reported image-icon sizing
  defect is covered by a Red→Green regression. `pluginManagerDemo=1` remains the fixture surface and
  `pluginManagerLive=1` now exercises canonical REST list/detail/install/configure/set-enabled/uninstall
  wiring in the feature checkout. Configure remains a manifest-owned typed detail contribution, not a
  seventh generic Agent management operation. Dynamic plugin tools instead remain behind the governed
  `plugin_list_tools` → `plugin_call` path and the same live contribution authority used by Manager status.
  This historical UI-direction feedback is not evidence that the complete personal hands-on journey was
  accepted. Per #1478, a new personal co-creator signoff is not a prerequisite for formal review;
  maintainers own reproducible end-to-end acceptance against the published exact package. Astra completed
  the Agent/Host and real Settings journeys on 2026-09-18 for source HEAD `4ce3556`; home intake must retain
  those behaviors and its own validation before merging.
- Plugins Train B merged as `clowder-ai-plugins` commit
  `73d77f7efddb7a0b53829e9d88ebab51e03bdb32`. Contract beta.13, SDK beta.9 and
  `video-analysis` alpha.0 are public with the independently sealed integrities. The Core feature worktree
  consumes the canonical machine catalog through the published beta.13 validator while keeping Host grants
  separate and fail-closed. The catalog may contain later packages, but this Train B Host admission scope
  projects only `dev.clowder.video-analysis`; absent Host policy means an entry is not exposed or installable.
  The companion [clowder-ai-plugins#50](https://github.com/zts212653/clowder-ai-plugins/pull/50)
  published the reviewed `video-analysis@0.1.0-alpha.1` package/catalog generation via commit `ae7e4594`;
  publisher run `35366295319` succeeded and independent npm tarball SHA-1/SHA-512 verification matched.
- Core production composition now owns fail-closed builtin dependency materialization: dependency-bearing
  packages must carry a publisher-owned lockfile-v3 `npm-shrinkwrap.json`, every locked package stays on the canonical
  npm registry with canonical sha512 integrity, and the Host runs script-free `npm ci`. It also owns the
  builtin-contribution supervisor, canonical REST registration and authenticated same-origin package-icon
  route. Repository-local and connector manifests remain on their existing Settings journeys rather than
  being presented as migrated package plugins. Earlier paired isolated acceptance exercised catalog →
  install → Host config/secret binding → enable → supervisor-held real `video_analysis` call → Host
  restart/resume → real call → disable → uninstall; the final instance was retired and the secret never
  entered inventory. The current `plugin_list_tools` → `plugin_call` indirection is covered at the
  composition/restart boundary and passed the maintainer-owned published-artifact integration journey.
  `pluginManagerLive=1`
  consumes that composition in the feature checkout. Per the Train B/Train C boundary, production Settings
  still keeps the existing panels as its default until the aggregate Train C1 cutover preserves specialized
  journeys such as Personal Chrome pairing.
- Rejected catalog/local archives now enter a separate durable, path-scrubbed quarantine ledger. Quarantine
  rows have no executable action and may only be removed with a revision fence. A rejection for an older
  catalog digest cannot hide a later replacement release. Package-owned SVG/PNG icons are served only after
  digest, manifest, package-boundary and media validation, with active-content confinement headers.
- Production keeps the legacy Feishu-only `RefreshingOfficialPluginCatalog` for the existing specialized
  routes, while the new Manager independently consumes the bounded HTTPS machine catalog and exact package
  digests. Its list/search projection includes repository-local plugins as read-only compatibility rows;
  connector compatibility remains a Train C1 cutover concern rather than being represented by fixtures. The
  owner Console detail may load a bounded, integrity-verified package-root `README.md` through a direct-local
  route; all six Agent management operations, including `plugin_get`, use only the short manifest description.
  Contribution discovery and invocation expose only live tool schemas/results and never read the README.
  The published video alpha.0 package does not include that README, so the Manager reports the omission
  honestly. The published alpha.1 follow-up in clowder-ai-plugins#50 includes the package-owned guide.
  Maintainers verified install → configure → enable → invoke → restart → disable → uninstall in both
  Agent/Host and Settings paths. The isolated authentication/provider fixtures prove Host/package
  integration, not commercial model quality or a personal co-creator experience claim.

External publication provenance: `[primary | npm registry + clowder-ai-plugins#50 exact artifact |
checked 2026-09-18 | alpha.1 public and digest matched; source integration passed | high confidence]`.
Review: [Astra approval](https://github.com/zts212653/clowder-ai/pull/1477#pullrequestreview-5250628473).
Source PR merged on 2026-09-19 as `9ab0eaf287381efcb209781463f38cc5f23870ea`; home
[intake #4605](https://github.com/zts212653/clowder-ai/issues/4605) completed through
[cat-cafe#4613](https://github.com/zts212653/clowder-ai/pull/4613), merged as
`b96b4d7d5615f8a5b78e97e2bc7a57e26ac7cefc`, after independent review, full-gate evidence,
post-rebase compatibility checks and canonical Guardian approval.

## What

F202 establishes a local plugin framework for trusted, repository-local plugins.

Phase 1 covers:

- Discover plugin manifests from `plugins/<plugin-id>/plugin.yaml`.
- Validate plugin manifests before any runtime activation.
- Expose plugin list/detail/config/enable/disable/test endpoints.
- Persist plugin-owned resources into `.cat-cafe/capabilities.json` with explicit ownership metadata.
- Activate declared skill, MCP, and limb resources through one resource activator.
- Add Settings UI for plugin status, configuration, enable/disable, and test affordances.
- Rehydrate enabled plugin limb resources during API startup.

Phase 2 covers:

- Make `schedule` a first-class plugin resource type with manifest validation, capability metadata, activation, deactivation, and startup rehydration.
- Add a whitelist `ScheduleFactoryRegistry` so repository-local plugins can reference owned task factories without arbitrary script execution.
- Migrate the existing GitHub system pollers (`cicd-check`, `review-feedback`, `conflict-check`, and `repo-scan`) from hardcoded API startup registration into `plugins/github/plugin.yaml`.
- Move GitHub plugin configuration to the F202 plugin config boundary while preserving scoped fallback to existing GitHub CLI / env behavior during migration.
- Add PR/issue tracking ergonomics that naturally belong to the GitHub plugin migration slice: tracking instructions, generic unregister by subject key, and issue comment tracking.
- Bundle plugin manifests/resources into desktop packaging so packaged installs discover the same repository-local plugins as source installs.

The external-package K-2 path currently covers:

- K-2A: contract-native package, installation-instance, activation, and effective-grant inventory.
- K-2B: Host-owned one-use handshake sessions, runtime leases, durable call settlement, and a builtin
  loopback adapter that exercises the same control plane without bypassing it.
- A ready-only `events.publish` handler that reuses F292 signal admission and canonical settlement;
  core imports the published contract validators and wire registry instead of mirroring them.
- K-2D: immutable package-to-process authority, closed-environment child supervision, bounded
  contract-owned stdio transport, and fail-closed restart recovery. Production composition is
  constructed but dormant; installation UI, activation authority, and real co-run remain later slices.

## Non-Goals

- Remote plugin installation, signing, marketplace trust, and network policy are not Phase 1.
- `weixin-mp` migration is a follow-up slice and must not be bundled into Phase 1.
- Arbitrary same-power script execution is not part of the plugin contract.
- Plugin framework does not replace F041/F126/F146; it sits on top of their ownership and activation boundaries.
- The conflicting standalone feature-number anchor from clowder-ai#844/#846 is not valid for GitHub plugin schedule work; GitHub schedule/resource work is F202 Phase 2.
- A full GitHub Issue Inbox / community triage product surface is not Phase 2 unless explicitly split and accepted under F141/F133 follow-up or a new feature anchor.

## Acceptance Criteria

- [x] One verified inventory and management surface serves Console and Agent operations.
- [x] Current C1 provider implementations live in packages and use the shared client and lifecycle.
- [x] Configuration refresh preserves active access while invalid/stopped access is rejected.
- [x] Message delivery, streams and actual package consumers are covered by automated checks.
- [x] Settings preserve manifest order and reject stale action results; retained configuration does not
  restore old receipts.
- [x] Public interfaces and current architecture documentation match the implementation.
- [x] Operator verified Weixin installation, enablement, uninstallation, QR login, phone/Hub message
  exchange, member avatars and Queue/reply identity using installed packages.
- [x] Operator verified that enabling the Weixin public-account plugin mounts its declared `weixin-mp` skill.
- [ ] Complete soak, distribution prerequisites and maintainer acceptance before merge.

## Non-Goals and Limits

C1 does not migrate Dot, add Tripo, introduce arbitrary plugin UI, or open a second event/identity/thread
system. Automated fixtures do not establish provider availability or real-account acceptance. Collective
and Feishu meeting intake remain held outside the current public catalog; their later publication
acceptance is a distribution boundary, not unfinished C1 Host migration. After C1 integration, the
remaining framework development is Dot migration and C2. Runtime restarts remain operator-controlled.

## Follow-up direction: addressable plugins and Dot (2026-10-18)

Dot migration remains assigned to `@mindfn` in the maintainer follow-up workstream. Completion of C1
intake and the initial package publication does not complete the Dot migration; Dot is still built in.

Deferred direction; not implemented in C1. It spans target resolution, dispatch, UI and Dot's external
connection. The intended behavior and remaining implementation are:

- Use the existing stable plugin instance identity as a message target, independently of its
  editable alias and icon. Do not manufacture a protected cat identity for Dot. A package ID
  describes the package; routing must still identify the actual installed instance.
- Plugins explicitly declare support for addressed delivery. Merge those enabled targets with
  members for mention selection and alias uniqueness checks. Generate and persist a unique
  default alias; resolve mentions to stable identities before enqueueing. Renaming or changing
  the icon must not retarget already queued messages. Alias-only edits update the Host projection;
  they need not restart the plugin.
- Reuse ordinary message admission/queueing, then dispatch members to their execution adapters
  and plugin targets through Plugin Manager to the existing delivery handler. A delivery receipt
  acknowledges that input, not completion of an external model response. Plugin replies use
  `messaging.send`; attachments use streams and state uses existing config/secrets/storage.
- Subscription and addressed delivery are separate choices. Current seven IM connectors call
  `messaging.subscribe(threadId, ...)` for threads in their own business mappings, not a global
  subscription. They implement an outbound delivery action and call `messaging.send` for inbound
  platform messages. Having these functions must not automatically place an IM connector in the
  mention target list. Addressability is opt-in; existing IM forwarding remains unchanged.

Inspected boundaries for the follow-up:

| Area | Current evidence and required change |
| --- | --- |
| Target discovery | `cat-target-resolver.ts` resolves only `catRegistry`; `ChatInput.tsx`, `useCatData.ts` and `mention-highlight.ts` consume member data. Add plugin targets without pretending they have a model/client configuration. |
| Dispatch | `route-serial.ts` and `route-parallel.ts` read cat configuration and invoke `invokeSingleCat`. Reuse scheduling but add the plugin delivery exit; do not pass plugin IDs through cat-only execution. |
| Dot runtime | `cloud-invoke-bridge.ts` has a `gpt-dot` branch; `index.ts` assembles Dot services. Move connection/webhook/reply/image behavior into the plugin and remove those dedicated Host branches. |
| External entry and UI | Dot currently has connection/MCP/test/image routes, callback integration and dedicated Settings/receipt/media UI. Verify their migration and ordinary message attribution, not just package startup. |
| Existing user data | Preserve pairing/configuration and historical messages; do not delete data to eliminate old code. Work out the concrete data relocation during the follow-up. |

SDK message, delivery, stream and lifecycle primitives are reusable; no broad SDK redesign is
implied. The missing work is target declaration/configuration and Host routing/UI integration.
Acceptance must cover addressed request/reply, alias collision and rename with queued input,
icon changes, disable/uninstall, existing IM subscriptions and ordinary member dispatch.

### Remaining code and completion checklist

Paths below are relative to the Host repository; they are implementation starting points, not
a promise that every reference can be deleted. Preserve historical messages and user-owned data.

- [ ] Unify addressable target discovery and alias uniqueness: `packages/api/src/domains/cats/services/agents/routing/cat-target-resolver.ts`, `a2a-mentions.ts` and `AgentRouter.ts`; front-end `packages/web/src/components/ChatInput.tsx`, `packages/web/src/hooks/useCatData.ts` and `packages/web/src/lib/mention-highlight.ts`.
- [ ] Route plugin targets from the ordinary queue to Plugin Manager delivery: `packages/api/src/routes/messages.ts`, `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts`, and routing `route-serial.ts` / `route-parallel.ts`. Keep stable target IDs through alias changes and cover disabled/uninstalled targets.
- [ ] Move Dot business ownership out of Host: `packages/api/src/domains/cats/services/cloud-bridge/dot/` (connection, dispatch, ask, return and image services), assembled in `packages/api/src/index.ts`. Replace the `gpt-dot` / `dispatchDot` branch in `cloud-invoke-bridge.ts` and review Dot-specific `cloud-return-grant.ts` / `cloud-bridge-fallback.ts` branches.
- [ ] Replace the built-in identity/package projection: `packages/shared/src/types/builtin-cloud-identity.ts`, `packages/api/src/routes/cats.ts`, `packages/api/src/domains/plugin/chatgpt-dot-manifest.ts` and bundled catalog entries. The new target is the installed plugin identity, not a synthetic cat; retain correct attribution of existing messages.
- [ ] Relocate external protocol and Settings integration: `packages/api/src/routes/chatgpt-dot-{connection,mcp,test,image}-routes.ts`, Dot-specific callback authentication in `callback-auth-prehandler.ts` / `callbacks.ts`, and `packages/web/src/components/settings/plugin-manager/DotConnectionDetail.tsx` plus its Manager call sites. Verify receipt and image presentation (`CloudDotReceipt.tsx`, `Lightbox.tsx`, gallery media URLs) against the replacement.
- [ ] Deliver a real Dot request/reply and attachment journey using the ordinary plugin SDK; verify current pairing/configuration retention, alias collision/rename, icon changes, stop/uninstall, and unchanged member/IM forwarding behavior. Then remove obsolete executable Dot-specific Host branches and their obsolete tests together, with independent review.

The existing IM reference is the plugin repository's seven `packages/connector-*/src/plugin-entrypoint.ts`
files: restore subscriptions from private thread mappings, subscribe only to the selected threads,
and send inbound messages via `messaging.send`. Host subscription behavior lives in
`packages/api/src/domains/plugin/host-surface/plugin-messaging-subscription-host.ts` and
`packages/api/src/domains/messaging/subscription-delivery.ts`. This is not an implicit declaration
of addressability and must not be changed into a global subscription for the Dot migration.

## Agent Tool Admission

The accepted Train B scope in [clowder-ai#1478](https://github.com/zts212653/clowder-ai/issues/1478)
named entry points below as the new `plugin-manager` resource family. The frontmatter binds each
entry to this decision; `resource-entry` records family admission, while the operation policy retains
the independent read/write/destructive risk and callback-owner authority.

| Entry | Boundary retained by the Host |
| --- | --- |
| `plugin_list` | Read the canonical catalog/install projection; no mutation. |
| `plugin_search` | Discover verified metadata through the same read-only projection. |
| `plugin_get` | Inspect one exact plugin and its current lifecycle revision. |
| `plugin_list_tools` | Disclose schemas only for a live, authorized contribution. |
| `plugin_call` | Invoke an exact discovered schema under current live/grant authority; write profile only. |
| `plugin_install` | Admit the exact verified package as a disabled instance; no implicit enablement. |
| `plugin_set_enabled` | Explicit owner lifecycle mutation fenced by the current revision. |
| `plugin_uninstall` | Destructive owner mutation; revoke runtime/grants before retiring the instance. |

This admission does not expose generic update/repair, grant authority to catalog metadata, or register
arbitrary dynamic schemas as canonical tools. Restricted Collective sessions cannot use these entries;
readonly sessions can only use the four read entries. F309 and existing official-plugin lifecycle
policies retain their own authority.

## References

- [Host PR](https://github.com/zts212653/clowder-ai/pull/1487)
- [Package PR](https://github.com/zts212653/clowder-ai-plugins/pull/54)
- [Plugin ownership](../architecture/ownership/cells/plugin.md)

Prior design discussions and acceptance checkpoints are retained in Git history and independent audit
records; they do not define the current public interface.

## C1 migration boundary

Provider-specific IM adapters, GitHub tracking/community backends, video tools, Weixin publishing and
visible-reader tools, personal Chrome companion, enterprise workflows, Collective, document materializers
and meeting intake belong to independent packages. Host retains identity, memory, conversation/task data,
the queue/scheduler, generic package management and granted public primitives. Business moves as a unit;
its Host-facing boundary changes to the common client. Provider-specific public ports and hidden corrective
model turns are not retained as compatibility layers.

Custom pages outside Plugin Manager and managed ASR/TTS/embedding services are outside this C1 UI migration.
C2 moves plugin-owned pages and internal request handling together; Host supplies generic mounting and
management. Plugin configuration and actions inside Manager already use the common manifest-driven UI.
The current public signatures are defined by plugin-contract and the plugin repository's development guide,
not by historical migration plans. See [Plugin Architecture](../architecture/plugin-architecture.md)
for lifecycle, Tasks, Git discovery and local installation boundaries.

Existing user data is retained. Data ownership changes require explicit migration choices; development and
acceptance use isolated stores. Local packages can support acceptance before registry publication, but
release dependency pins must resolve to their intended distributable packages before merge. The real-account
operator journey has passed, including Weixin installation/uninstallation, QR login, message exchange,
member presentation and declared public-account skill activation. Soak, distribution prerequisites and
maintainer acceptance remain; successful CI alone does not satisfy those requirements.
