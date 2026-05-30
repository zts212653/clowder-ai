---
feature_ids: [F023]
related_features: [F214]
topics: [directory, corrosion, defense]
doc_kind: note
created: 2026-02-26
---

# F023: 目录结构防腐化 + 重构 + 代码检查工具链

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26

## Why
- team lead 2026-02-13

## What
- **F23**: PR #21 (d366ad5) — 5 WT 全部合入 main。87 files → 7 子目录 + ~690 imports 迁移 + 5 大文件拆分。防腐化门禁 pnpm check:dir-size + pnpm check:deps。Biome v2.4 + LSP + JetBrains MCP 全部启用。routes 目录有 .dir-exceptions.json 例外到 2026-04-01。ADR: 010-directory-hygiene-anti-rot.md

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
