---
feature_ids: [F031]
related_features: []
topics: [two, layer, process]
doc_kind: note
created: 2026-02-26
---

# F031: PR 双层 Review 流程（本地猫 + 云端猫）

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26

## Why
- 2026-02-14 operator提议

## What
- **F31**: ✅ 已完成：本地猫 review（cat-cafe-requesting-review/cat-cafe-receiving-review skill）+ 云端 Codex review（requesting-cloud-review skill）+ SOP.md Step 5 阻塞规则。双层 Review 流程已在 PR #6/#8 中实践，SOP 已修正remote review 为阻塞守护（非异步）。

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
