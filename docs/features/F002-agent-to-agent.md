---
feature_ids: [F002]
related_features: []
topics: [agent]
doc_kind: note
created: 2026-02-26
---

# F002: Agent-to-Agent 调用 (A2A)

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26

## Why
- operator洞察 🐬

## What
- **F2**: Phase 3.9 7a519b9 — worklist 链式调用 + parseA2AMentions + a2a_handoff 前端显示

## Acceptance Criteria
- [x] AC-A1: 本文档已补齐模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

## Key Decisions
- Phase 3.9 `7a519b9` — worklist 链式调用 + parseA2AMentions + a2a_handoff 前端显示

## Dependencies
- **Related**: F002（保留原始依赖记录见下）
- 无显式依赖声明

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
