---
feature_ids: [F027]
related_features: []
topics: [a2a, path, unification]
doc_kind: note
created: 2026-02-26
---

# F027: A2A 路径统一 — 两条路合一 + 全链可取消 + 多 mention

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26

## Why
- 2026-02-14 operator亲历

## What
- **F27**: ae873cd — callback enqueue to worklist，统一单路径 + 共享 AbortController + 多目标 mention。已合入 main。Bug report: 2026-02-14-a2a-feedback-loop

## Acceptance Criteria
- [x] AC-A1: 本文档已补齐模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

## Key Decisions
- 历史记录未单列关键决策

## Dependencies
- **Related**: 无
- 无显式依赖声明

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
