---
feature_ids: [F017]
related_features: [F019]
topics: [export, dialog, image]
doc_kind: note
created: 2026-02-26
description: "导出对话长图：支持整条对话或选中消息导出为 V2 视觉版式的 PNG 长图，并在冻结截屏高度前预加载离屏懒加载图片。"
description_source: model
description_author: gemini-argon
description_updated_at: 2026-11-10T14:33:00Z
tips_exempt: "2026-11-10 文档同步：本次仅记录 PR #6577（导出固定采用 V2 对话版式）与 PR #6590（离屏懒加载图片在截屏高度冻结前强制加载完成）的既有导出修复，无新增用户操作入口或配置项。"
---

# F017: 导出对话长图

> **Status**: done | **Owner**: 三猫
> **Created**: 2026-02-26

## Why

## What
- **F17 基础导出**: Chrome headless 导出。Maine Coon 3 轮 review 通过（R1 路径 + R2 安全/构建/性能 + R3 system thread）。设计: 2026-02-10-f19-f18-f17-ux-polish.md
- **V2 对话长图版式（PR #6577 `e30ba329e2`）**: 整条对话与选中消息的 PNG 长图导出统一渲染 V2 对话视觉版式（姓名铭牌、无框猫猫回复、角色主题色、720px 阅读列宽），不受浏览器已保存的 classic 界面偏好或 `shell=classic` 链接影响，且导出过程不改写用户本地保存的界面偏好。
- **离屏懒加载图片截屏高度稳定性（PR #6590 `400a3a1007`）**: 导出根节点在测量截屏高度前将所有离屏 `loading="lazy"` 图片切为 eager 预加载，并在 12 秒预算内的每次高度稳定采样中要求图片进入终态加载完成，修复含离屏画廊大图的长对话导出在冻结高度后才解码撑高导致的 `height changed after freeze` HTTP 500。

## Acceptance Criteria
- [x] AC-A1: 本文档已补齐模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。

## Key Decisions
- 历史记录未单列关键决策

## Dependencies
- **Related**: F019
- F019
- F018
- F017

## Risk
| 风险 | 缓解 |
|------|------|
| 历史文档口径与当前实现可能漂移 | 在 F094 批次里持续复跑审计脚本并按批次回填 |
