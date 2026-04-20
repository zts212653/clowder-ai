---
feature_ids: [F038]
related_features: [F100]
topics: [skills, discovery]
doc_kind: note
created: 2026-02-26
---

# F038: Skills 梳理 + 按需发现机制

> **Status**: parked (方向 A 已落地，方向 B 待 skill 数量增长后再做) | **Owner**: 三猫
> **Created**: 2026-02-26

## Why

## What
- **F38**: 当前：方向 A（分类标记），skill bug 已修（项目级 .claude/skills/ symlinks 5257e1c）。未来：方向 B（类 ToolSearch 延迟加载，BM25/regex，触发条件 skills 50+）。ToolSearch 不用向量数据库，用 BM25 词频排序。team lead决策：simple is better, build when you need。

## Acceptance Criteria
- [ ] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
## Key Decisions
- simple is better, build when you need

## Dependencies
- **Related**: 无
- F038

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
