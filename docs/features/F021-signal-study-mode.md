---
feature_ids: [F021]
related_features: []
topics: [signal, study, mode]
doc_kind: note
created: 2026-02-26
---

# F021: Signal Hunter 集成

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26
> **Completed**: 2026-03-10

## Why

## What
- **F21**: 每日自动抓取 AI 技术信源 + 邮件日报 + 和猫猫深度学习。合并 Signal Hunter 到 Clowder AI，launchd 定时 + 50+ 信源 + on/off 开关 + Hindsight 洞察存储。计划: 2026-02-12-signal-hunter-integration.md，Maine Coon调研: signal-hunter.md。S1~S6 全部完成，Maine Coon多轮 review 放行。信源补全 3→45 源 + 手动 Fetch 端点 + GitHub PAT 自动注入。已全部合入 main。
- **F21++**: F21 从 RSS 阅读器升级为学习伴侣：双入口触发 Study + 文章上下文自动注入 + 深度笔记归档 + 播客生成（复用 F34 TTS）+ 多猫研究（复用 F-Swarm-1）+ Signal Hunter 迁移。10 个需求 (R1-R10)，11 轮 feat 采访确认。设计: 2026-02-26-f21-study-mode-design.md

## Acceptance Criteria
- [ ] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

## Key Decisions
- 历史记录未单列关键决策

## Dependencies
- **Related**: 无
- F021
- F034

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
