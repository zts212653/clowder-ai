---
feature_ids: [F202]
related_features: [F041, F126, F129, F146, F190]
topics: [plugin-framework, capability-registry, settings, resource-activation, community-pr]
doc_kind: spec
created: 2026-05-15
---

# F202: Plugin Framework — local discovery, config, and resource activation

> **Status**: review | **Owner**: community @mindfn + Cat Cafe maintainers | **Priority**: P1

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

## Non-Goals

- Remote plugin installation, signing, marketplace trust, and network policy are not Phase 1.
- `weixin-mp` migration is a follow-up slice and must not be bundled into Phase 1.
- Arbitrary same-power script execution is not part of the plugin contract.
- Plugin framework does not replace F041/F126/F146; it sits on top of their ownership and activation boundaries.

## Acceptance Criteria

### AC-A: Manifest Discovery and Validation

- [ ] AC-A1: Plugin IDs must match folder names.
- [ ] AC-A2: Reserved builtin plugin IDs are rejected.
- [ ] AC-A3: Manifest schema rejects unknown or unsafe resource declarations before activation.
- [ ] AC-A4: Config env names use strict identifiers and reject reserved prefixes, system names, and cross-plugin collisions.

### AC-B: Resource Ownership and Activation

- [ ] AC-B1: Plugin-owned capability records include stable plugin ownership metadata.
- [ ] AC-B2: Enable/disable only mutates resources owned by the target plugin.
- [ ] AC-B3: Cross-plugin ownership collisions are rejected.
- [ ] AC-B4: Skill, MCP, and limb declarations go through a shared activation path rather than three ad hoc writers.
- [ ] AC-B5: Startup rehydrate loads only validated enabled plugin resources.

### AC-C: API and Security Boundary

- [ ] AC-C1: Write endpoints require local loopback and request identity.
- [ ] AC-C2: Config writes go through the existing connector secret/update boundary; secrets are not written into git-tracked manifests.
- [ ] AC-C3: Enable/disable/config/test actions emit audit events.
- [ ] AC-C4: Test endpoints do not advertise unsupported MCP probe execution as healthy/testable.

### AC-D: Hub UX

- [ ] AC-D1: Settings can list plugins and show status/config state.
- [ ] AC-D2: Users can configure, enable, disable, and test supported plugin resources from the Settings surface.
- [ ] AC-D3: Plugin-owned disabled/error states are visible in capability UI without confusing them with built-in capabilities.

### AC-E: Review and Intake Gate

- [ ] AC-E1: PR #686 title, branch/body/docs are renamed from `F197` to `F202` before merge.
- [ ] AC-E2: The upstream source of truth is this F202 spec, not the old `docs/features/F197-plugin-framework.md` filename in the PR.
- [ ] AC-E3: Phase 1 must pass API build/lint and focused plugin manifest/config tests.
- [ ] AC-E4: Before merge, maintainers explicitly decide whether Phase 1 is accepted as an implementation slice or should be split further.

## Current Maintainer Position

Welcome directionally. The feature is large enough to need an upstream feature anchor before merge. Phase 1 is reviewable under F202 if the PR removes the stale `F197` identifier and stays within the local, trusted plugin scope above.

[Maine Coon/GPT-5.5🐾]
