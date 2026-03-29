---
feature_ids: [F147]
related_features: [F041]
topics: [i18n, hub, locale, ui]
doc_kind: spec
created: 2026-03-29
---

# F147: i18n — Hub 界面中英文切换

> **Status**: idea | **Owner**: 待定 | **Priority**: 待定

## team lead愿景

Hub 界面支持中英文切换。

## Why

Hub 界面目前只有中文，海外用户和社区贡献者无法理解界面内容。国际化是社区友好度的基础设施。

## What

- Hub 前端 UI 支持中/英双语切换
- 语言偏好持久化（localStorage 或用户配置）
- 翻译覆盖关键交互路径（导航、设置、消息面板）

## Acceptance Criteria

- [ ] AC-A1: Hub 支持中文/英文语言切换

## Dependencies

- F041（能力看板）— Hub 框架已成型

## Risk

- 翻译维护成本：每个新 Feature 增加 UI 文案时需同步双语
