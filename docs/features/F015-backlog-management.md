---
feature_ids: [F015]
related_features: []
topics: [backlog, management]
doc_kind: note
created: 2026-02-26
---

# F015: Backlog 管理

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26
> **Completed**: 2026-02-27

## Why
- F040：`docs/` 真相源重构 + 聚合体系落地（本 Feature 的机制落盘）

## What
- **F015（机制层）**：确保功能想法不散落在手机备忘录，能在 `docs/` 真相源中被持续管理与追溯。
- 本需求的机制落地由 **F040** 完成（`docs/ROADMAP.md` + `docs/features/` 聚合文件 + skills）。

## Acceptance Criteria
- [x] AC-A1: 本文档已补齐模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

## Key Decisions
- “BACKLOG 管理”拆成两层：
  - `docs/` 真相源与追溯链（F040）：已完成
  - 产品内调度与任务池（见 F049）：另立项

## Dependencies
- **Related**: F015（保留原始依赖记录见下）
- 无显式依赖声明

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
