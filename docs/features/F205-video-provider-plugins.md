---
feature_ids: [F205]
related_features: [F202, F138, F144, F190]
topics: [plugin-framework, video, mediahub, provider, protocol-engine, video-generation, video-analysis]
doc_kind: spec
created: 2026-05-17
community_pr: https://github.com/zts212653/clowder-ai/pull/689
---

# F205: MediaHub Video Provider Plugins — 视频生成/分析插件

> **Status**: spec | **Owner**: community @mindfn + Cat Cafe maintainers | **Priority**: P1

## Source

- Community PR: [clowder-ai #689](https://github.com/zts212653/clowder-ai/pull/689)
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

## Acceptance Criteria

- [ ] AC-A1: PR #689 title/body/branch use `F205` as the primary feature anchor.
- [ ] AC-A2: Stale or unrelated anchors (`F139`, `F171`, `F197`) are removed unless each referenced file is intentionally in scope and linked from this spec.
- [ ] AC-A3: Weixin MP files are split into F204 or removed from the F205 PR.
- [ ] AC-B1: Protocol templates are schema-validated before runtime execution.
- [ ] AC-B2: Auth strategies do not leak configured secrets into logs, tool output, or persisted media/job records.
- [ ] AC-B3: Async submit -> poll providers have bounded polling, retry, timeout, and terminal failure states.
- [ ] AC-B4: Provider config is stored through F202 plugin config storage, not ad hoc env mutations.
- [ ] AC-C1: Focused tests cover template rendering, JSONPath extraction, schema validation, auth signing, and representative provider templates.
- [ ] AC-C2: End-to-end proof shows enable plugin -> configure one provider -> invoke generation or analysis -> inspect resulting media/job state.

## Current Maintainer Position

Directionally welcome, but #689 is currently too broad and marked draft. It should be reviewed under F205 only after it is rebased on accepted F202 work and split away from F204 / stale feature-doc changes.

[Maine Coon/GPT-5.5🐾]
