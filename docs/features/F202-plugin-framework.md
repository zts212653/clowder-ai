---
feature_ids: [F202]
related_features: [F041, F126, F129, F133, F139, F140, F141, F146, F190, F240, F241, F285, F292]
topics: [plugin-framework, plugin-manager, host-inventory, capability-registry, settings, resource-activation, catalog, agent-tools]
doc_kind: spec
created: 2026-05-15
architecture-cell: plugin
tips_exempt: "The historical Phase 1 and K-2 acceptance records are retained below. The terminal direction supersedes their product ordering: Train B completes the Manager and one real package loop; Train C1 migrates existing plugins and removes compatibility paths; Train C2 opens bounded public hook/UI seams with real consumers."
---

# F202: Terminal Plugin Manager and Host-governed Plugin Framework

> **Status**: in-progress (Train B direction accepted in
> [clowder-ai#1478](https://github.com/zts212653/clowder-ai/issues/1478); formal review and
> published-package integration pending) | **Owner**: Clowder AI maintainers | **Priority**: P1

## Architecture Ownership

Architecture cell: plugin
Map delta: required in Train B; tracked by `feature-specs/2026-09-01-f202-terminal-plugin-manager.md`.
Why: F202 owns the terminal Plugin Manager, Host-governed package/instance/config/activation/runtime
projection, and its Console/Agent management surfaces. The plugin repository owns published catalog,
contract, SDK and business packages. Product-domain effects remain in their canonical cells.

## Source

- Community PR: [clowder-ai #686](https://github.com/zts212653/clowder-ai/pull/686)
- PR author: `mindfn`
- Feature ID assignment: `F202`, assigned by You on 2026-05-15.

## Why

Clowder AI already has pieces of a capability ecosystem:

- F041 made `.cat-cafe/capabilities.json` the static capability truth source.
- F126 introduced the limb control-plane boundary.
- F129 defined pack/mod direction and rejected unsafe same-power script plugins.
- F146 moved MCP addition toward a managed marketplace/control-plane flow.
- F190 added the settings shell that can host capability and integration controls.

What is still missing is a local plugin framework that lets a plugin declare owned resources in one folder, be configured through the Hub, and activate those resources without manual edits to multiple runtime files.

PR #686 is a concrete Phase 1 implementation proposal for that missing layer. It was originally labeled `F197`, but upstream `F197` is already occupied by ACP tool result event surfacing. This feature spec is the upstream anchor for the plugin framework work.

## User Journey

### Terminal Plugin Manager Journey (2026-09-01)

**Scope unit:** one catalog candidate or one Host-owned installation instance, joined into one Plugin
Manager row without exposing repository-local, official-package and connector implementation silos.

1. A user opens Settings → Plugins and searches the machine-readable published catalog together with
   plugins already installed on this Host. Installed plugins remain in the first section; up to three
   uninstalled catalog candidates appear below as recommendations, while an active search returns every
   matching candidate instead of applying that recommendation cap.
2. Selecting a plugin opens the existing expanded-card presentation in the right pane. The left card
   only adds installed/uninstalled truth; an installed detail keeps its existing configuration and resource
   content with uninstall plus one enable/disable toggle, while an uninstalled detail exposes only Install.
   A temporarily blocked toggle remains visible and disabled with its reason, and destructive confirmation
   uses the shared Console dialog rather than a browser-native prompt.
   Full orthogonal state remains available to Agent/API and deep diagnostics rather than becoming a new
   default UI dashboard. Installation state is expressed by the available action set (Install versus enable/disable +
   uninstall), not by a redundant installed/uninstalled badge.
3. A catalog candidate can be installed from npm. A local development directory/archive uses the same
   verification, digest, immutable package and Host inventory admission instead of loading code into the
   API process.
4. The user configures and authorizes the plugin through typed contributions, then explicitly enables it.
   The Host starts its supervised process or executes the contract-declared builtin/no-op lifecycle path,
   with grants and effects bound to an activation revision.
5. The user can disable or uninstall it. Disable revokes live authority while preserving installation and
   governed data. Uninstall revokes authority before removing the instance and applies the manifest data
   policy without deleting unrelated or default-persistent user data.
6. Agents can inspect and operate the same state through exactly six management tools:
   `plugin_list`, `plugin_search`, `plugin_get`, `plugin_install`, `plugin_set_enabled`, and
   `plugin_uninstall`. For an enabled builtin contribution, `plugin_list_tools` exposes the exact
   runtime-discovered schemas and `plugin_call` invokes one selected tool through the existing Host
   supervisor. They do not receive a separate registry, process launcher, secret path, or stronger authority
   than the Console.

The detail capability explanation is derived from package-owned contributions, grouped by contribution
kind (for example MCP, Scheduler, and Skill). Once an MCP contribution is live, the Manager replaces its
placeholder with the runtime-discovered tool names and descriptions. Host permission grants are never
relabeled as user-facing tools; before package admission the Manager says that exact tools become available
after installation. A package-root README remains the separate, package-owned long-form explanation.

**Failure journey:** catalog failure never hides an installed plugin; a rejected package is quarantined
and never becomes enableable; config, auth, desired activation and live runtime failures remain separate
states; stale revision writes and ambiguous runtime transitions fail closed without old/new double-run.

`plugin.yaml` remains the canonical static format and admission protocol. The contract may define a fixed
set of lifecycle actions using structured `command + args + mode`; an absent action is a no-op. It does not
grant arbitrary shell execution, and Core must consume rather than mirror that schema.

The same verified manifest/package also owns plugin presentation metadata. Descriptions carry one default
plus locale-keyed translations so Agent, Console and catalog search share the capability/use explanation.
Icons are either legacy Host icon names or package-relative SVG/PNG assets; the Host validates and serves
package assets from a same-origin URL. Console source categories never select a placeholder icon.

## Stable kernel and public extension boundary

Clowder AI keeps a small, stable kernel. Core owns lifecycle stages, typed hook and capability contracts,
Host-side scheduling/ordering/isolation, UI slot policy, authorization, trace, settlement, and complete
revocation on disable or uninstall. The public SDK is the only plugin authoring surface: a plugin registers
handlers and declarative contributions against those bounded contracts, while Core invokes them without
knowing whether the implementation is TTS, translation, an IM provider, or another business feature.

This is not arbitrary Core patching. Plugins cannot reach private Host objects, invent unreviewed hook names,
or mutate Console DOM/layout. Each newly opened hook or UI slot must be driven by a real migrated consumer,
review its public data shape, and prove that disabling or uninstalling the plugin removes both the visible
entry and its handler. Existing in-process prompt `HookRegistry` behavior is an internal implementation,
not the public plugin hook protocol.

## Train B / Train C Boundary

### Train B — terminal management plane

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

The detailed state census, invariants, Design Gate and TDD sequence live in
`feature-specs/2026-09-01-f202-terminal-plugin-manager.md`.

### Train B direction and implementation checkpoint (updated 2026-09-18)

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
  continue; the exact wording and architecture evidence are recorded in
  `feature-discussions/2026-09-01-f202-terminal-manager-design/README.md`. The reported image-icon sizing
  defect is covered by a Red→Green regression. `pluginManagerDemo=1` remains the fixture surface and
  `pluginManagerLive=1` now exercises canonical REST list/detail/install/configure/set-enabled/uninstall
  wiring in the feature checkout. Configure remains a manifest-owned typed detail contribution, not a
  seventh generic Agent management operation. Dynamic plugin tools instead remain behind the governed
  `plugin_list_tools` → `plugin_call` path and the same live contribution authority used by Manager status.
  This historical UI-direction feedback is not evidence that the complete personal hands-on journey was
  accepted. Per #1478, a new personal co-creator signoff is not a prerequisite for formal review;
  maintainers own the still-pending reproducible end-to-end acceptance against the published exact package
  and final integration before approval/merge.
- Plugins Train B merged as `clowder-ai-plugins` commit
  `73d77f7efddb7a0b53829e9d88ebab51e03bdb32`. Contract beta.13, SDK beta.9 and
  `video-analysis` alpha.0 are public with the independently sealed integrities. The Core feature worktree
  consumes the canonical machine catalog through the published beta.13 validator while keeping Host grants
  separate and fail-closed. The catalog may contain later packages, but this Train B Host admission scope
  projects only `dev.clowder.video-analysis`; absent Host policy means an entry is not exposed or installable.
  The companion [clowder-ai-plugins#50](https://github.com/zts212653/clowder-ai-plugins/pull/50)
  carries the reviewed `video-analysis@0.1.0-alpha.1` package/catalog generation, but that exact version must
  still be published and publicly consumable before this Core PR may merge.
- Core production composition now owns fail-closed builtin dependency materialization: dependency-bearing
  packages must carry a publisher-owned lockfile-v3 `npm-shrinkwrap.json`, every locked package stays on the canonical
  npm registry with canonical sha512 integrity, and the Host runs script-free `npm ci`. It also owns the
  builtin-contribution supervisor, canonical REST registration and authenticated same-origin package-icon
  route. Repository-local and connector manifests remain on their existing Settings journeys rather than
  being presented as migrated package plugins. Earlier paired isolated acceptance exercised catalog →
  install → Host config/secret binding → enable → supervisor-held real `video_analysis` call → Host
  restart/resume → real call → disable → uninstall; the final instance was retired and the secret never
  entered inventory. The current `plugin_list_tools` → `plugin_call` indirection is covered at the
  composition/restart boundary and remains part of the pending maintainer-owned final integration
  acceptance.
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
  honestly. The alpha.1 follow-up in clowder-ai-plugins#50 includes the package-owned guide, but its public
  npm availability and the digest-matched final Manager journey remain pending. Maintainers must record the
  reproducible install → configure → enable → invoke → restart → disable → uninstall result before final
  approval/merge.

External publication provenance: `[primary | npm registry + clowder-ai-plugins#50 exact artifact |
checked 2026-09-18 | alpha.0 public; alpha.1 npm lookup 404; final Train B integration pending | high
confidence]`.

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

### AC-A: Manifest Discovery and Validation

- [x] AC-A1: Plugin IDs must match folder names.
- [x] AC-A2: Reserved builtin plugin IDs are rejected.
- [x] AC-A3: Manifest schema rejects unknown or unsafe resource declarations before activation.
- [x] AC-A4: Config env names use strict identifiers and reject reserved prefixes, system names, and cross-plugin collisions.

### AC-B: Resource Ownership and Activation

- [x] AC-B1: Plugin-owned capability records include stable plugin ownership metadata.
- [x] AC-B2: Enable/disable only mutates resources owned by the target plugin.
- [x] AC-B3: Cross-plugin ownership collisions are rejected.
- [x] AC-B4: Skill, MCP, and limb declarations go through a shared activation path rather than three ad hoc writers.
- [x] AC-B5: Startup rehydrate loads only validated enabled plugin resources.

### AC-C: API and Security Boundary

- [x] AC-C1: Write endpoints require local loopback and request identity.
- [x] AC-C2: Config writes go through the existing connector secret/update boundary; secrets are not written into git-tracked manifests.
- [x] AC-C3: Enable/disable/config/test actions emit audit events.
- [x] AC-C4: Test endpoints do not advertise unsupported MCP probe execution as healthy/testable.

### AC-D: Hub UX

- [x] AC-D1: Settings can list plugins and show status/config state.
- [x] AC-D2: Users can configure, enable, disable, and test supported plugin resources from the Settings surface.
- [x] AC-D3: Plugin-owned disabled/error states are visible in capability UI without confusing them with built-in capabilities.

### AC-E: Review and Intake Gate

- [x] AC-E1: PR #686 title, branch/body/docs are renamed from `F197` to `F202` before merge.
- [x] AC-E2: The upstream source of truth is this F202 spec, not the old `docs/features/F197-plugin-framework.md` filename in the PR.
- [x] AC-E3: Phase 1 must pass API build/lint and focused plugin manifest/config tests.
- [x] AC-E4: Before merge, maintainers explicitly decide whether Phase 1 is accepted as an implementation slice or should be split further.

### AC-F: Phase 2 Schedule Resource Contract

- [ ] AC-F1: `parsePluginManifest` validates `type: schedule` resources with `name` and `factoryId`, and rejects unsafe names or unknown resource shapes before activation.
- [ ] AC-F2: Schedule capabilities carry stable plugin ownership metadata and a deterministic runtime task id that cannot collide across plugins.
- [ ] AC-F3: Enable/disable is transactional: failed schedule activation does not persist a misleading enabled state, and failed disable does not silently leave ghost tasks running.
- [ ] AC-F4: Startup rehydration registers only enabled, validated schedule resources and validates factory-owned task ids before registering them.
- [ ] AC-F5: Schedule factories are whitelist-owned by plugin id; no plugin can bind another plugin's factory or load arbitrary same-power scripts.

### AC-G: Phase 2 GitHub Plugin Migration

- [ ] AC-G1: `plugins/github/plugin.yaml` declares the GitHub schedule resources and config fields for the existing GitHub integration.
- [ ] AC-G2: GitHub CI/review/conflict/repo-scan pollers are registered through F202 schedule resources, not hardcoded in API startup.
- [ ] AC-G3: Disabling the GitHub plugin stops its plugin-owned pollers; re-enabling restores them without losing scheduler governance overrides.
- [ ] AC-G4: GitHub token/noise/MCP config resolves through plugin config first, with scoped fallback to existing env / GitHub CLI auth and no broad token leakage into unrelated child processes.
- [ ] AC-G5: Migration handles optional repo-scan runtime dependencies explicitly, using disabled/pending state rather than reporting an enabled poller that is not running.
- [ ] AC-G6: Desktop builds include plugin manifests/resources and verify the plugin mirror on first launch.

### AC-H: Phase 2 Tracking Ergonomics

- [ ] AC-H1: PR tracking can store user-provided task instructions without overriding system/developer/harness instructions.
- [ ] AC-H2: `unregister_tracking` can remove PR and issue trackers by subject key without deleting unrelated tasks.
- [ ] AC-H3: Issue tracking routes new issue comments to the owning thread, seeds cursors at registration/reactivation, and auto-closes tracking when the GitHub issue closes.
- [ ] AC-H4: GitHub PR/issue bodies and comments are explicitly marked or delimited as untrusted external content before they are routed to cats.
- [ ] AC-H5: Existing PR tracking tasks remain backward compatible after the migration.

### AC-I: K-2A through K-2D External Package and Runtime Boundary

- [x] AC-I1: Host inventory binds admitted package digest, installation instance, activation, and
  effective grants to exact published contract truth without a core-local manifest mirror.
- [x] AC-I2: Candidate hello is validated against Host inventory; nonce/session binding is one-use,
  deadline-bound, and cannot widen plugin identity, package digest, wire version, or grants.
- [x] AC-I3: Runtime sessions and leases normalize closed/stopped after restart while durable calls,
  package identity, installation state, and grants survive atomically.
- [x] AC-I4: Every call rechecks current grants/lease and is recorded before domain dispatch;
  concurrent retries have one winner and ambiguous recovery consults canonical domain settlement.
- [x] AC-I5: Only contract registry methods with `ready: true` can dispatch. `events.publish` flows
  through F292 Host authorization/idempotency without copying C-2 schema into core.
- [x] AC-I6: Builtin loopback and external stdio traverse the same Host Broker state machine;
  production composition constructs and restart-recovers the supervisor but never calls `start`
  or exposes an activation route.
- [x] AC-I7: External start copies the exact Host-owned archive into a private stage, verifies its
  admitted SRI, atomically publishes and re-hashes the launchable tree, contains the entrypoint,
  launches without a shell or inherited credentials, and accepts only bounded
  contract/SDK-classified frames.
- [x] AC-I8: Process, protocol, deadline, stop, crash, and Host-restart terminal paths close Broker
  authority and normalize runtime state without trusting a persisted PID or blindly redispatching
  an ambiguous effect.

## Intake Timeline

| Date | Event |
|------|-------|
| 2026-05-31 | clowder-ai#686 absorbed into cat-cafe via cat-cafe#1999 (squash `11b24d60334789a3f95d12be355d3ddbd196309c`). Intake ledger advanced to clowder-ai merge `60d1dbbfcbf84954000fcfcdbd645fd20948aa5d`. |
| 2026-05-31 | Post-merge follow-ups opened: cat-cafe#2000 for P2 deferral re-ranking, cat-cafe#2001 for `eval:capability-wakeup` with the new limb/plugin surface. Architecture ownership cell `plugin` added in this doc sync. |
| 2026-06-08 | Maintainer decision: clowder-ai#844/#846 is re-anchored from its conflicting standalone feature number to F202 Phase 2. The source-truth plan lives here; the open PR must retitle/rewrite body/docs/roadmap before merge review continues. |
| 2026-08-05 | K-2A Host inventory merged via cat-cafe#3422 (`a6b38ac53`); package/install/grant truth landed with runtime dormant. |
| 2026-08-10 | K-2B production-transport state machine merged via cat-cafe#3555 (`f7fe82303`): contract-native handshake, durable call ledger, restart normalization, builtin loopback, and typed F292 `events.publish`; external runtime activation remains dormant. |
| 2026-08-11 | K-2D implemented on cat-cafe#3558: immutable package verification, supervised stdio transport, closed bootstrap environment, and current-main project persistence composition; startup remains dormant with no activation route. |

## Current Maintainer Position

Phase 1 is accepted and absorbed as the trusted, repository-local plugin framework slice.

Phase 2 is accepted as the correct home for schedule resources and the existing GitHub integration migration. The clowder-ai#844/#846 direction is welcome only after the conflicting standalone anchor is removed and replaced with `F202 Phase 2` in title, body, feature docs, roadmap text, and commits that would enter source truth.

Concrete product plugins such as Weixin MP (F204) and MediaHub providers (F205) keep their own feature anchors because they add new user-visible capabilities on top of F202. GitHub schedule migration is different: it moves an existing core integration into the F202 lifecycle boundary and therefore belongs under this feature.

K-2A through K-2D are accepted as the Host-owned external-package foundation. The Host now has a
supervised stdio process boundary and a production composition object, but startup only performs
fail-closed persistence recovery. No package is installed or started by that wiring, no activation
route exists, and real plugin co-run remains separately gated. Core must continue importing the
exact public contract rather than growing a private wire registry.

[小太阳·Maine Coon/GPT-5.6 Sol🐾]
