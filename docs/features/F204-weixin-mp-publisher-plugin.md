---
feature_ids: [F204]
related_features: [F202, F137, F132, F190]
topics: [plugin-framework, weixin-mp, wechat, official-account, publishing, content-channel]
doc_kind: spec
created: 2026-05-17
community_pr: https://github.com/zts212653/clowder-ai/pull/688
---

# F204: Weixin MP Publisher Plugin — 微信公众号文章发布插件

> **Status**: review | **Owner**: community @mindfn + Cat Cafe maintainers | **Priority**: P1

## Source

- Community PR: [clowder-ai #688](https://github.com/zts212653/clowder-ai/pull/688)
- PR author: `mindfn`
- Depends on: [F202 Plugin Framework](./F202-plugin-framework.md)
- Related, not replacement: [F137 WeChat Personal Gateway](./F137-weixin-personal-gateway.md), [F132 DingTalk + WeCom Chat Gateway](./F132-dingtalk-wecom-gateway.md)

## Why

F202 establishes the local plugin framework. Weixin MP is a concrete, user-visible publishing integration on top of that framework, not the framework itself.

This must be separate from F137 and F132:

- F137 is personal WeChat iLink Bot messaging.
- F132 covers DingTalk and WeCom chat gateways.
- F204 is WeChat Official Account article publishing, with app credentials, access-token management, markdown-to-HTML conversion, and outbound article submission.

Treating this as only "F202" would hide a new product capability inside framework work and make review/intake too coarse.

## What

F204 adds a trusted repository-local plugin for publishing article content to WeChat Official Accounts.

Expected scope:

- `plugins/weixin-mp/` manifest, limb declaration, and skill documentation.
- Weixin MP API client and access-token manager.
- Redis-backed token cache with expiry handling.
- Markdown to WeChat-compatible HTML conversion.
- URL and content-safety validation for outbound article payloads.
- Health check and configuration surface for `APP_ID` / `APP_SECRET`.
- Platform-aware limb adapter only where the F202 generic limb contract cannot express Weixin MP behavior.

## Non-Goals

- Do not reopen personal WeChat iLink Bot messaging from F137.
- Do not implement WeCom/enterprise WeChat from F132.
- Do not bundle F202 framework Phase 1 implementation into this PR.
- Do not add remote plugin installation, marketplace trust, or same-power arbitrary script execution.

## Acceptance Criteria

- [ ] AC-A1: PR #688 title/body/branch use `F204`, not `feat(F202)` as the primary feature anchor.
- [ ] AC-A2: Any stale `F197` plugin-framework docs/files are removed from the PR or moved back to the F202 source branch.
- [ ] AC-B1: Weixin MP credentials are configured through F202 config boundaries and are not committed into manifests.
- [ ] AC-B2: Access tokens are cached with explicit expiry and invalidated on Weixin API auth failures.
- [ ] AC-B3: Markdown/HTML conversion rejects unsafe URLs and unsupported embed forms before publish.
- [ ] AC-B4: Publish/health-check failures surface actionable errors in the plugin UI and logs.
- [ ] AC-C1: Focused API tests cover token caching, API error handling, URL safety, and manifest validation.
- [ ] AC-C2: Manual validation proves enable plugin -> configure credentials -> health check -> publish sample article.

## Current Maintainer Position

Welcome as a separate feature under F204. The current PR should keep F202 as a dependency and remove stale framework anchors before merge review.

[Maine Coon/GPT-5.5🐾]
