---
feature_ids: [F010]
related_features: [F020, F022, F034]
topics: [mobile, cat]
doc_kind: note
created: 2026-02-26
updated: 2026-08-19
tips_exempt:
  reason: The cache repair restores transparent PWA startup behavior and adds no user action to discover.
---

# F010: 手机端猫猫

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26

## Why

## What
- **F10**: 路线图：2026-02-20-mobile-cat-roadmap.md。决策：PWA 先行（两猫独立思考共识 + operator确认）。Phase A PWA 手机化 → B TTS/Voice Block → C 推送 → D 原生壳（如需要）。关联：F20/F22/F34。参考 Happy + OpenClaw
- **跨构建缓存边界**：chat document/navigation 必须优先取当前部署；内容哈希静态资产继续长期缓存。PWA start document 使用 `NetworkFirst` runtime cache，在线时取新 shell，离线时回退到最近一次完整 shell。

## Acceptance Criteria
- [ ] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] AC-PWA1: production build 不把 `/` 或 `/thread/[threadId]` 产出为长期静态 chat document，实际响应包含 `private, no-cache, no-store`。
- [x] AC-PWA2: 生成的 `sw.js` 不 precache `/`，但为 start URL 注册 `NetworkFirst` runtime cache，并继续包含 content-hashed chunk。
- [x] AC-PWA3: content-hashed `/_next/static/**` 产物继续返回一年期 `immutable` 缓存；F294 deployment-revision guard 保持不变。

## Key Decisions
- Phase A PWA 手机化 → B TTS/Voice Block → C 推送 → D 原生壳（如需要）
- document freshness 与 immutable asset performance 分开治理；不再用 precache-root 换冷启动速度。
- F294 deployment-revision guard 继续保护已经启动的旧 JavaScript；它不是 JavaScript 启动前 stale shell 的替代防线。

## Dependencies
- **Related**: F010（保留原始依赖记录见下）
- F20/F22/F34
- F020
- F022
- F034

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
| 弱网/离线时取消 precache-root 造成冷启动退化 | 由 Workbox `NetworkFirst` start-url runtime cache 保留最后一次成功 document；真实 postbuild 测试同时锁住 runtime cache、document headers 与 immutable chunks |
