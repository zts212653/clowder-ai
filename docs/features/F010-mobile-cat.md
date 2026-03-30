---
feature_ids: [F010]
related_features: [F020, F022, F034]
topics: [mobile, cat]
doc_kind: note
created: 2026-02-26
---

# F010: 手机端猫猫

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26

## Why

## What
- **F10**: 路线图：2026-02-20-mobile-cat-roadmap.md。决策：PWA 先行（两猫独立思考共识 + team lead确认）。Phase A PWA 手机化 → B TTS/Voice Block → C 推送 → D 原生壳（如需要）。关联：F20/F22/F34。参考 Happy + OpenClaw

## Acceptance Criteria
- [ ] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

## Key Decisions
- Phase A PWA 手机化 → B TTS/Voice Block → C 推送 → D 原生壳（如需要）

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
