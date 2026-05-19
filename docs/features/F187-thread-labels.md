---
feature_ids: [F187]
related_features: [F057, F095]
topics: [thread, navigation, ux, labels]
doc_kind: spec
created: 2026-05-06
---

# F187: Thread Labels — 用户自定义标签 + Sidebar 筛选 + 猫猫辅助分类

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1 | **Completed**: 2026-05-08

## Why

team experience：
> "我发现我们现在置顶都置顶了大几十个！thread！我感觉导致这个问题是我们的收藏夹或者说也没有什么 tag 系统让我没办法分门别类我们的 thread，比如哪些是在拆技术（开源项目），哪些在 thread 开发，哪些是我们一起闲聊共创等等"

F057/F095 解决了"找得到 thread"（搜索、排序、置顶、活跃度），但没有解决"这个 thread 属于哪类事情"。pin 被迫承担分类职责：本来是"我现在要关注"（临时注意力），实际被当成"别丢了"（永久归档）。两个语义叠在一起，置顶只增不减，几十个置顶等于没有置顶。

缺的是 **thread 的用途分类层**。

## What

### Phase A: Label 系统基座 ✅

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

### Phase B: Sidebar 筛选 + 智能视图 ✅

- Sidebar 顶部加标签筛选器（点击标签 → 只显示该标签 thread，再点取消）
- V1 单选筛选；组合筛选（AND）留后续
- **溢出策略**：筛选条内联显示前 5-6 个最常用标签，超出折叠到 "..." 按钮 → 下拉选择器
- **"未分类"智能视图**：显示所有没有任何标签的 thread，作为持续整理的压力入口
- Thread 条目上显示标签色点（不占太多空间，hover 显示标签名）
- 所有图标使用 SVG（禁止 emoji），与现有 sidebar 图标系统一致

### Phase C: 猫猫辅助分类 ✅

- **双入口**：
  1. sidebar "未分类" pill 旁 ✨ 按钮 → 创建/打开专属功能 thread（"Thread 整理助手"） → 猫猫在该 thread 中分析未分类 thread 并建议标签
  2. 用户在任意 thread 中说"帮我整理" → 猫猫加载 organize-threads skill → 当场整理
- **路由**：走现有消息路由（上一只活跃猫 > thread 首选猫 > 全局首选猫），不引入独立 API 端点
- **功能 thread**：专属 thread 承载分类交互，消息只在该 thread 内，不污染其他 thread 的聊天记录
- **展示**：猫猫分析后在 thread 消息中输出建议 + 浮层面板(ThreadOrganizerModal)供用户批量确认/修改
- **流程**：触发 → 猫猫调 MCP 工具获取未分类 thread 标题+标签列表 → 分析标题/元数据 → 输出建议 → 用户确认/修改 → 批量应用标签
- **不做**：不引入 FunctionRun 数据模型；不引入独立 API 端点直接调用 LLM（架构决策：我们家没有 api 只有 cli）

## Architecture Ownership

Architecture cell: thread-navigation
Map delta: new cell required（F191 Phase D 已补 `docs/architecture/ownership/cells/thread-navigation.md`）
Why: F187 改的是用户面向的 thread 组织/分类/Sidebar 筛选语义，不属于 identity、bubble、transport、memory 或 dispatch。

## Acceptance Criteria

### Phase A（Label 系统基座）
- [x] AC-A1: 用户可创建自定义标签（名称 + 颜色）
- [x] AC-A2: 用户可在 thread 右键菜单/详情里给 thread 打多个标签
- [x] AC-A3: 标签数据持久化（Redis），重启不丢失
- [x] AC-A4: Label CRUD API 完整且有类型定义

### Phase B（Sidebar 筛选 + 智能视图）
- [x] AC-B1: Sidebar 有标签筛选器，点击标签后只显示该标签的 thread
- [x] AC-B2: "未分类"视图显示所有无标签 thread
- [x] AC-B3: Thread 条目上有标签色点指示

### Phase C（猫猫辅助分类）
- [x] AC-C1: sidebar "未分类" pill 旁有 ✨ 按钮，点击创建/打开专属功能 thread 触发分类流程
- [x] AC-C2: 猫猫通过现有消息路由分析未分类 thread 并建议标签（不引入独立 API 端点）
- [x] AC-C3: 用户可在 ThreadOrganizerModal 面板中逐条确认/修改建议后批量应用标签
- [x] AC-C4: 用户可在任意 thread 说"帮我整理"触发猫猫加载 skill 整理

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
| KD-5 | 猫猫分类走现有消息路由，禁止独立 API 端点调 LLM | "我们家没有 api 只有 cli"——架构一致性，复用 cat routing（team lead否决独立端点方案） | 2026-05-07 |
| KD-6 | Phase C 用功能 thread 承载分类工作 | 专属 thread 隔离分类交互，不污染用户正在开发的 thread（team lead拍板） | 2026-05-07 |
| KD-7 | 走现有消息路由（上一只猫 > 首选猫 > 全局首选猫） | 复用已有机制，不需要新调度逻辑（team lead确认路由规则） | 2026-05-07 |
| KD-8 | 双入口：✨按钮→功能 thread、对话说"帮我整理"→skill | team lead拍板两条路并行，灵活触发 | 2026-05-07 |

## Review Gate

- Phase A: Maine Coon review 数据模型 + API
- Phase B: 前端 UI → team lead确认后实现
- Phase C: interactive rich block 交互设计 → team lead确认

## 需求点 Checklist

| ID | 来源 | 需求 | AC 映射 | Phase |
|----|------|------|---------|-------|
| R1 | team lead | thread 可按用途分类 | AC-A1, AC-A2 | A |
| R2 | team lead | sidebar 可按分类筛选 | AC-B1, AC-B2, AC-B3 | B |
| R3 | team lead | 猫猫帮忙一键分类 | AC-C1, AC-C2, AC-C3, AC-C4 | C |
| R4 | Ragdoll+Maine Coon | 用 Label 不用 Folder | KD-1 | — |
