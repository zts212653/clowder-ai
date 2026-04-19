---
feature_ids: [F166]
related_features: []
topics: [ux, config, drag-and-drop]
doc_kind: spec
created: 2026-04-17
---

# F166: Cat Order Customization — 猫猫排序自定义

> **Status**: done | **Owner**: Ragdoll | **Priority**: P2 | **Completed**: 2026-04-17

## Why

team experience："总揽这里你这只 47 在太下面了！我希望把你拉到最上面！"

当前猫猫顺序完全由 `cat-template.json` 的 `roster` 字段声明顺序决定，前后端均不排序。team lead无法按自己的使用习惯调整猫猫展示顺序。@ picker 和总揽页面都受影响。

## What

### Phase A: 拖拽排序 + 持久化 + 联动

**数据层**：
- `/api/config` 新增 `catOrder: string[]` 字段，存储 catId 排序列表
- 列表外的猫按 `cat-template.json` 原始顺序追加（新猫上线不丢失）
- 无 `catOrder` 时保持现有顺序（零破坏性）

**UI 层（总揽页面）**：
- `CatOverviewTab` 每张猫卡片添加拖拽把手（`grip-vertical` 图标）
- 原生 HTML5 Drag & Drop（不引入外部依赖）
- 松手后 PUT `/api/config` 持久化新顺序

**联动层**：
- `useCatData` hook 在导出 `cats` 前按 `catOrder` 排序
- @ mention picker（`buildCatOptions`）自动跟随 → 一处排序，两处生效

## Acceptance Criteria

### Phase A（拖拽排序 + 持久化 + 联动）✅
- [x] AC-A1: 总揽页面猫卡片可拖拽重新排序
- [x] AC-A2: 排序结果通过 `/api/config` 持久化，刷新后保持
- [x] AC-A3: @ mention picker 排序与总揽页面一致
- [x] AC-A4: 新增猫（catOrder 中不存在的 catId）自动追加到末尾
- [x] AC-A5: 无 catOrder 配置时保持现有 cat-template.json 顺序

## Dependencies

- **Related**: 无（独立功能）

## Risk

| 风险 | 缓解 |
|------|------|
| HTML5 DnD 在移动端体验差 | Cat Cafe 主要在桌面使用；移动端后续可加 touch 事件 |
| catOrder 与 roster 不同步（删猫后残留 ID） | 排序时 filter 掉 roster 中不存在的 catId |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 原生 HTML5 DnD，不引入 @dnd-kit | ~30 行实现，避免新依赖 | 2026-04-17 |
| KD-2 | 整张列表自由排序，非 pin-top 机制 | team lead明确要"拖到最上面"的自由度 | 2026-04-17 |
| KD-3 | 复用 `/api/config` 偏好框架 | 已有持久化基础设施，不造新轮子 | 2026-04-17 |

## Reflection
