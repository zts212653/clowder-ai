---
feature_ids: [F008]
related_features: []
topics: [token, budget, observability]
doc_kind: note
created: 2026-02-26
---

# F008: Token 预算 + 深度可观测性

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26

## Why

## What
- **F8**: 全部完成：char→token 迁移 (js-tiktoken, 16 files) + 三猫 CLI usage/cost/cache 捕获 + 前端 RightStatusPanel per-cat token 显示 + ParallelStatusBar 聚合 + inputTokens 归一化 (da75aaf) + review fix (e8d1dbd)。commits: 66a59e4→6f25a2b→e8d1dbd

## Acceptance Criteria
- [x] AC-A1: 本文档已补齐模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

## Key Decisions
- 历史记录未单列关键决策

## Dependencies
- **Related**: F008（保留原始依赖记录见下）
- F025

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
