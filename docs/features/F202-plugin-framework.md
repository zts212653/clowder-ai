---
feature_ids: [F202]
related_features: [F041, F126, F129, F133, F139, F140, F141, F146, F190, F241]
topics: [plugin-framework, capability-registry, settings, resource-activation, schedule-resource, github, community-pr]
doc_kind: spec
created: 2026-05-15
architecture-cell: plugin
---

# F202: Plugin Framework — local discovery, config, resource activation, and schedule resources

> **Status**: in-progress (Phase 1 merged 2026-05-31 via cat-cafe#1999; Phase 2 scoped 2026-06-08) | **Owner**: community @mindfn + Cat Cafe maintainers | **Priority**: P1

## Architecture Ownership

Architecture cell: plugin
Map delta: new cell required
Why: F202 introduces the first repository-local plugin lifecycle boundary: manifest discovery, config persistence, plugin-owned resource activation, and Settings controls.

## Source

- Community PR: [clowder-ai #686](https://github.com/zts212653/clowder-ai/pull/686)
- PR author: `mindfn`
- Feature ID assignment: `F202`, assigned by You on 2026-05-15.

## Why

Cat Cafe already has pieces of a capability ecosystem:

- F041 made `.cat-cafe/capabilities.json` the static capability truth source.
- F126 introduced the limb control-plane boundary.
- F129 defined pack/mod direction and rejected unsafe same-power script plugins.
- F146 moved MCP addition toward a managed marketplace/control-plane flow.
- F190 added the settings shell that can host capability and integration controls.

What is still missing is a local plugin framework that lets a plugin declare owned resources in one folder, be configured through the Hub, and activate those resources without manual edits to multiple runtime files.

PR #686 is a concrete Phase 1 implementation proposal for that missing layer. It was originally labeled `F197`, but upstream `F197` is already occupied by ACP tool result event surfacing. This feature spec is the upstream anchor for the plugin framework work.

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

## Intake Timeline

| Date | Event |
|------|-------|
| 2026-05-31 | clowder-ai#686 absorbed into cat-cafe via cat-cafe#1999 (squash `11b24d60334789a3f95d12be355d3ddbd196309c`). Intake ledger advanced to clowder-ai merge `60d1dbbfcbf84954000fcfcdbd645fd20948aa5d`. |
| 2026-05-31 | Post-merge follow-ups opened: cat-cafe#2000 for P2 deferral re-ranking, cat-cafe#2001 for `eval:capability-wakeup` with the new limb/plugin surface. Architecture ownership cell `plugin` added in this doc sync. |
| 2026-06-08 | Maintainer decision: clowder-ai#844/#846 is re-anchored from its conflicting standalone feature number to F202 Phase 2. The source-truth plan lives here; the open PR must retitle/rewrite body/docs/roadmap before merge review continues. |

## Current Maintainer Position

Phase 1 is accepted and absorbed as the trusted, repository-local plugin framework slice.

Phase 2 is accepted as the correct home for schedule resources and the existing GitHub integration migration. The clowder-ai#844/#846 direction is welcome only after the conflicting standalone anchor is removed and replaced with `F202 Phase 2` in title, body, feature docs, roadmap text, and commits that would enter source truth.

Concrete product plugins such as Weixin MP (F204) and MediaHub providers (F205) keep their own feature anchors because they add new user-visible capabilities on top of F202. GitHub schedule migration is different: it moves an existing core integration into the F202 lifecycle boundary and therefore belongs under this feature.

[Maine Coon/GPT-5.5🐾]
