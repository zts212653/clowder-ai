---
feature_ids: [F001]
related_features: []
topics: [config, visibility]
doc_kind: note
created: 2026-02-26
---

# F001: 配置可见性

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26

## Why
- operator洞察 🐬

## What
- **F1**: Phase 3.9 6a671ac — ConfigRegistry + GET /api/config + /config chat command

## Acceptance Criteria
- [x] AC-A1: 本文档已补齐模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

## Key Decisions
- Phase 3.9 `6a671ac` — ConfigRegistry + GET /api/config + `/config` chat command

## Dependencies
- **Related**: F001（保留原始依赖记录见下）
- 无显式依赖声明

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
