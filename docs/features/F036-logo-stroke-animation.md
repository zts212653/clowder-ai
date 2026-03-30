---
feature_ids: [F036]
related_features: []
topics: [logo, stroke, animation]
doc_kind: note
created: 2026-02-26
---

# F036: Logo 一笔画动画（Stroke Drawing Animation）

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26

## Why
- 2026-02-22 视频 Logo 讨论

## What
- **F36**: 视频 Logo 用 stroke-dashoffset 做真正的"笔尖游走"线条生长效果。当前阻塞：(1) AI（Pencil MCP）画出来像"发芽土豆+球星飞船"🥔🚀，完全不能用；(2) autotrace -centerline 输出太杂乱（~13 段分离路径 + 内部交叉线）。需要：人工 Inkscape 手动描摹干净 stroke 路径，或等 AI 绘画能力提升。当前替代方案：clip-path reveal 动画（circle/wipe/bottom-up），见 assets/icons/logo-animation-demo.html。

## Acceptance Criteria
- [ ] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
## Key Decisions
- 历史记录未单列关键决策

## Dependencies
- **Related**: 无
- 无显式依赖声明

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
