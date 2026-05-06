---
feature_ids: [F187]
related_features: [F057, F095]
topics: [thread, navigation, ux, labels]
doc_kind: spec
created: 2026-05-06
---

# F187: Thread Labels — 用户自定义标签 + Sidebar 筛选 + 猫猫辅助分类

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1

## Why

team experience：
> "我发现我们现在置顶都置顶了大几十个！thread！我感觉导致这个问题是我们的收藏夹或者说也没有什么 tag 系统让我没办法分门别类我们的 thread，比如哪些是在拆技术（开源项目），哪些在 thread 开发，哪些是我们一起闲聊共创等等"

F057/F095 解决了"找得到 thread"（搜索、排序、置顶、活跃度），但没有解决"这个 thread 属于哪类事情"。pin 被迫承担分类职责：本来是"我现在要关注"（临时注意力），实际被当成"别丢了"（永久归档）。两个语义叠在一起，置顶只增不减，几十个置顶等于没有置顶。

缺的是 **thread 的用途分类层**。

## What

### Phase A: Label 系统基座

数据模型：
- `ThreadLabel` 表：`id`, `name`, `color`, `sortOrder`, `createdBy`, `createdAt`
- Thread 增加 `labels: string[]` 字段（label id 数组）
- 预置标签可选，用户可自定义

API：
- Label CRUD：`POST/GET/PATCH/DELETE /api/labels`
- Thread 打标签：`PATCH /api/threads/:id/labels`（覆盖式，传完整 label 数组）

UI：
- Thread 右键菜单 / 详情面板：打标签（多选 checkbox + 颜色圆点）
- Label 管理入口：创建/编辑/删除/排序标签

### Phase B: Sidebar 筛选 + 智能视图

- Sidebar 顶部加标签筛选器（点击标签 → 只显示该标签 thread，再点取消）
- V1 单选筛选；组合筛选（AND）留后续
- **溢出策略**：筛选条内联显示前 5-6 个最常用标签，超出折叠到 "..." 按钮 → 下拉选择器
- **"未分类"智能视图**：显示所有没有任何标签的 thread，作为持续整理的压力入口
- Thread 条目上显示标签色点（不占太多空间，hover 显示标签名）
- 所有图标使用 SVG（禁止 emoji），与现有 sidebar 图标系统一致

### Phase C: 猫猫辅助分类

- 用户触发的一键操作（按钮 / 命令），不是静默自动分类
- 流程：用户点击 → 猫猫扫描未分类 thread 的标题/内容摘要 → 批量建议标签 → 用户逐条确认/修改 → 批量应用
- 当前 session 猫直接做（不起无头 CLI），调 `list_threads` MCP 获取未分类 thread 标题+元数据
- 猫在自身上下文分析标题/关联 feature ID，生成标签建议
- 建议结果用 interactive rich block 展示（card-grid，每个 thread 一张卡，可修改建议标签）

## Acceptance Criteria

### Phase A（Label 系统基座）
- [ ] AC-A1: 用户可创建自定义标签（名称 + 颜色）
- [ ] AC-A2: 用户可在 thread 右键菜单/详情里给 thread 打多个标签
- [ ] AC-A3: 标签数据持久化（Redis），重启不丢失
- [ ] AC-A4: Label CRUD API 完整且有类型定义

### Phase B（Sidebar 筛选 + 智能视图）
- [ ] AC-B1: Sidebar 有标签筛选器，点击标签后只显示该标签的 thread
- [ ] AC-B2: "未分类"视图显示所有无标签 thread
- [ ] AC-B3: Thread 条目上有标签色点指示

### Phase C（猫猫辅助分类）
- [ ] AC-C1: 用户可触发"猫猫帮我分类"操作
- [ ] AC-C2: 猫猫基于 thread 元数据建议标签，用 interactive rich block 展示
- [ ] AC-C3: 用户可逐条确认/修改建议后批量应用

## Dependencies

- **Evolved from**: F057（Thread 可发现性 — 排序 + 搜索）、F095（Thread Sidebar 导航体验升级）
- **Related**: F099（Hub Navigation Scalability）

## Risk

| 风险 | 缓解 |
|------|------|
| 标签越贴越多变成新噪音 | V1 限制标签数上限（如 10-15 个）；"未分类"视图提供整理压力 |
| 历史 thread 太多难以一次性整理 | Phase C 猫猫辅助分类降低整理门槛；渐进式不强制 |
| 标签筛选与现有 pin/搜索交互复杂 | 标签筛选独立于 pin（pin 是注意力，标签是分类），搜索结果也显示标签 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Label 而非 Folder | thread 天然跨类别，互斥文件夹不够灵活 | 2026-05-06 |
| KD-2 | 不做自动分类，做用户触发的猫猫建议 | 自动分类会变成新噪音；用户触发+确认保证可控 | 2026-05-06 |
| KD-3 | 图标用 SVG，禁止 emoji | team lead Design Gate 反馈；与现有 sidebar 图标系统一致 | 2026-05-06 |
| KD-4 | 筛选条溢出策略：inline 5-6 个 + "..." 下拉 | 标签数可能 10+，全部内联会挤爆筛选条 | 2026-05-06 |
| KD-5 | 猫猫分类不起无头 CLI，当前 session 猫直接做 | list_threads MCP + 标题分析，成本 = 一次普通对话 | 2026-05-06 |

## Review Gate

- Phase A: Maine Coon review 数据模型 + API
- Phase B: 前端 UI → team lead确认后实现
- Phase C: interactive rich block 交互设计 → team lead确认

## 需求点 Checklist

| ID | 来源 | 需求 | AC 映射 | Phase |
|----|------|------|---------|-------|
| R1 | team lead | thread 可按用途分类 | AC-A1, AC-A2 | A |
| R2 | team lead | sidebar 可按分类筛选 | AC-B1, AC-B2, AC-B3 | B |
| R3 | team lead | 猫猫帮忙一键分类 | AC-C1, AC-C2, AC-C3 | C |
| R4 | Ragdoll+Maine Coon | 用 Label 不用 Folder | KD-1 | — |
