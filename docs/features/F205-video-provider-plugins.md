---
feature_ids: [F205]
related_features: [F202, F138, F144, F190]
topics: [plugin-framework, video, mediahub, provider, protocol-engine, video-generation, video-analysis]
doc_kind: spec
created: 2026-05-17
community_pr: https://github.com/zts212653/clowder-ai/pull/1144
---

# F205: MediaHub Video Provider Plugins — 视频生成/分析插件

> **Status**: in-review | **Owner**: community @mindfn + Cat Cafe maintainers | **Priority**: P1

## Source

- Current PR: [clowder-ai #1144](https://github.com/zts212653/clowder-ai/pull/1144) (supersedes #689)
- PR author: `mindfn`
- Depends on: [F202 Plugin Framework](./F202-plugin-framework.md)
- Related: [F138 Video Studio](./F138-video-studio.md)

## Why

F138 is Cat Cafe's end-to-end video production pipeline: spec, assets, narration, Remotion rendering, and publishing workflow.

PR #689 is a different layer: pluginized provider access for video generation and video analysis. It can become an upstream capability that F138 consumes, but it is not the whole Video Studio. It deserves its own feature anchor so provider protocols, credentials, MCP tools, and MediaHub UI can be reviewed without overloading F138 or F202.

## What

F205 introduces video provider plugins and a declarative protocol engine for external video/image generation and video analysis services.

Expected scope:

- `video-gen` and `video-analysis` plugin manifests/resources.
- Declarative YAML protocol templates for providers.
- Runtime protocol engine for submit/poll/execute flows.
- Provider-independent auth strategies such as API key, JWT, HMAC, and query param signing.
- Config storage via the F202 plugin config boundary.
- MCP tools or API surface for invoking configured providers.
- MediaHub UI only where needed to configure providers, inspect jobs, and show generated media state.

## Non-Goals

- Do not replace the F138 video-spec / voice-script / Remotion production pipeline.
- Do not bundle Weixin MP article publishing; that is F204.
- Do not bundle F202 framework Phase 1 implementation.
- Do not introduce provider SDK code paths that bypass the declared protocol engine unless explicitly reviewed as an extension point.

## User Journey

**Scope unit**: Plugin settings → MCP tool invocation

1. User enables the `video-gen` or `video-analysis` plugin in the Plugin settings tab.
2. User configures provider credentials (API key, base URL, model) via the plugin config form.
3. Plugin activates its MCP resource — the protocol-server registers provider-specific tools (e.g. `video_generate`, `video_analyze_url`).
4. Cats invoke the registered MCP tools during conversations to generate videos or analyze video content.
5. User can view MCP connection status in the MCP management page (the plugin MCP appears with a "由插件管理" badge, toggle/per-cat controls available, delete blocked).

## Acceptance Criteria

> AC-A1 was written for PR #689; #1144 supersedes it with a clean branch already anchored on F205.

- [x] AC-A1: ~~PR #689~~ PR #1144 title/body/branch use `F205` as the primary feature anchor. (Superseded: #1144 is a clean rewrite, not the original #689 branch.)
- [x] AC-A2: Stale or unrelated anchors (`F139`, `F171`, `F197`) are removed. #1144 is a focused protocol-engine delivery.
- [x] AC-A3: Weixin MP files are not present in #1144.
- [x] AC-B1: Protocol templates are schema-validated via `ProtocolTemplateSchema` (Zod) before runtime execution.
- [x] AC-B2: Auth strategies do not leak configured secrets — credential scrubbing applied to all error messages and tool output; `raw` provider responses are not exposed.
- [x] AC-B3: Async submit → poll providers have bounded polling (maxAttempts), retry with backoff for transient HTTP errors, timeout, and terminal failure states (succeeded/failed).
- [x] AC-B4: Provider config is stored through F202 plugin config storage (plugin manifest + capabilities.json), not ad hoc env mutations.
- [x] AC-C1: Focused tests cover template rendering, JSONPath extraction, schema validation, auth signing, and representative provider templates (zhipu, jimeng).
- [ ] AC-C2: End-to-end proof shows enable plugin → configure one provider → invoke generation or analysis → inspect resulting media/job state. (Pending: requires live provider credentials.)

## Current Maintainer Position

PR #1144 is a clean rewrite addressing #689's scope concerns. Protocol engine, auth strategies, plugin manifests, and MCP integration are in review. Security hardening (credential scrubbing, plugin ownership guards, redaction) applied per maintainer R7 feedback.

[Updated 2026-07-15 per maintainer review on #1144]
