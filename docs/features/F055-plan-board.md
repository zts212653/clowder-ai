---
feature_ids: [F055]
related_features: [F045]
topics: [plan-board, task-progress, multi-cat, right-panel, ux]
doc_kind: spec
created: 2026-03-03
---

# F055 — 猫猫祟祟（Plan Board）

> **Status**: done | **Owner**: Ragdoll (Opus)
> **Reviewer**: Maine Coon (Codex) — local + cloud
> **Created**: 2026-03-03
> **Completed**: 2026-03-03
> **PR**: #202 (`71a18914`)
> **Evolved from**: F045（计划看板 stale bug）→ 发现设计层问题 → 新立项

## Why

右上角"当前调用"板块把**路由意图**（targetCats）和**执行进度**（task_progress）耦合在一起。单猫串行还勉强能用，但 8 只猫并发时：

- targetCats 只反映最新一次 intent_mode，丢失其他猫
- 猫 A 完成后 targetCats 没清，面板不刷新（F045 修过但治标不治本）
- completed 快照被 hydration 恢复时塞回 targetCats（PR #201 补丁）
- "当前调用"区混了 cat status + invocation info + task progress，职责不清

**team experience**："不建议做最小，而是按照一个新的 feat 那样对齐需求搞……和 session chain 类似新增一个 mission / plan 的板块，多少只猫不同的 plan 各自管各自的。"

## What

在右侧状态栏新增独立的 **「猫猫祟祟」** 板块（类似 SessionChainPanel 的独立 section），专门展示每只猫的执行计划/任务进度，与"当前调用"板块解耦。

### 设计要点

1. **独立板块**：不修改现有"当前调用"section，新增 `<PlanBoardPanel />` 作为独立 section
2. **显示范围**：只显示当前 thread 中有过 invocation 的猫（不论 running / completed / interrupted）
3. **每猫独立卡片**：每只猫一张计划卡，各管各的，互不影响
4. **完成态折叠**：completed 的计划折叠到底部（类似 session chain 的 sealed sessions），可展开查看
5. **实时刷新**：基于 `catInvocations` 变化自动刷新，不依赖 targetCats
6. **名字来源**："猫猫祟祟"= 猫猫鬼鬼祟祟执行计划

### 信息架构

```
「猫猫祟祟」(N 只猫有计划)
├─ 🟢 执行中的猫（按 startedAt desc）
│  ├─ [opus] ██████░░░░ 3/7 任务
│  └─ [codex] ████░░░░░░ 2/8 任务
├─ 🟡 已中断（有"继续"按钮）
│  └─ [gemini] ████████░░ 5/6 任务 [继续]
└─ ▼ 已完成 (2)   ← 折叠，点击展开
   ├─ [opus] ✓ 7/7 · 2分钟前
   └─ [sonnet] ✓ 4/4 · 5分钟前
```

### 数据来源

- **唯一数据源**：`catInvocations: Record<string, CatInvocationInfo>` — 已有的 store 数据
- **分类依据**：`taskProgress.snapshotStatus` (`running` / `completed` / `interrupted`)
- **不再依赖**：`targetCats`（路由意图归路由意图，执行进度归执行进度）

### 与"当前调用"的关系

- "当前调用"保留原有职责：显示 cat status、invocation ID、时间、token 用量
- 从"当前调用"**移除** `CatTaskProgress` 组件（任务 checklist 部分）
- 任务 checklist 全部交给「猫猫祟祟」板块

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- **AC-1**: 右侧状态栏出现独立的「猫猫祟祟」section，位于 SessionChainPanel 附近
- **AC-2**: 只显示当前 thread 中有过 invocation 且有 taskProgress 的猫
- **AC-3**: 每猫独立卡片，卡片显示：猫名（带颜色标识）+ 进度条 + 任务数
- **AC-4**: running 的猫排在最上面，completed 的折叠到底部可展开
- **AC-5**: interrupted 的猫显示"继续"按钮，点击可恢复执行
- **AC-6**: 新 invocation 开始时（invocation_created 事件），对应猫的卡片自动重置为新计划
- **AC-7**: 8 只猫同时有计划时面板不溢出（合理的 scroll / 紧凑布局）
- **AC-8**: "当前调用"section 不再显示 task progress checklist（职责迁移）
- **AC-9**: 切换 thread 时面板正确切换到新 thread 的计划数据
- **AC-10**: hydration 恢复时，completed 计划直接出现在折叠区，不污染 running 区

## 需求点 Checklist

| ID | 需求点 | AC 编号 | 验证方式 | 状态 |
|----|--------|---------|----------|------|
| R1 | 新增独立「猫猫祟祟」section | AC-1 | test + screenshot | [x] |
| R2 | 只显示有 invocation+taskProgress 的猫 | AC-2 | test | [x] |
| R3 | 每猫独立卡片带颜色+进度 | AC-3 | test + screenshot | [x] |
| R4 | running 排顶部，completed 折叠底部 | AC-4 | test | [x] |
| R5 | interrupted 显示"继续"按钮 | AC-5 | test | [x] |
| R6 | invocation_created 自动重置 | AC-6 | test | [x] |
| R7 | 8 猫并发不溢出 | AC-7 | manual + screenshot | [x] |
| R8 | 从"当前调用"移除 task progress | AC-8 | test | [x] |
| R9 | 切 thread 正确切换 | AC-9 | test | [x] |
| R10 | hydration completed 不污染 running | AC-10 | test | [x] |

## Dependencies

- **Evolved from**: F045（计划看板 stale bug 修复，PR #186/#187/#188/#191/#201）
- **Related**: F026（Task progress checklist 原始实现）
- **Related**: SessionChainPanel（UI pattern 参考）

## Risk

| 风险 | 缓解 |
|------|------|
| 从"当前调用"移除 task progress 可能影响用户习惯 | 位置接近，且新板块更清晰 |
| 8 猫同时有计划时右栏太长 | 紧凑布局 + 完成态折叠 + 整个 aside 已有 overflow-y-auto |

## Review Gate

- 跨 family 首选（Maine Coon/Maine Coon）
- 前端 UI：需要截图 + "需求→截图"映射表

## 开发故事：笨蛋猫猫调试乌龙 🐾

> F054 预热素材 — 真实开发过程中的猫猫趣事

### 背景

F055 合入后team lead安排了一次链式冒烟测试：opus → codex → sonnet 依次写计划，验证猫猫祟祟面板能正确显示三只猫的执行进度。

### 翻车过程

1. **opus 先写**：TodoWrite 发了 7 个任务，猫猫祟祟板块立刻出现 opus 的进度卡片。正常。
2. **codex 接力**：Maine Coon收到传话后开始执行，team lead切到面板一看——只有两只猫（opus + sonnet），**Maine Coon不见了**。
3. **Ragdoll紧急排查**：我（opus）立刻开始调查，读了 `codex-event-transform.ts`、`invoke-single-cat.ts`、`extractTaskProgress` 等后端代码，分析了 Claude 路径（tool_use 拦截）vs Codex 路径（native todo_list 事件转换）的差异。

   我的结论是："Codex 的 `todo_list` 事件走 `codex-event-transform.ts:41` 转换，但转换后的 `system_info(task_progress)` 可能没被正确发到前端。" 信誓旦旦地给出了一个后端 adapter 问题的诊断。

4. **Maine Coon反驳**：team lead让Maine Coon自辩。Maine Coon淡定回复：

   > "我没有用 TodoWrite 工具，我只是在消息里写了一个文字列表。文字列表不是 tool_use，不会触发 task_progress 事件。"

   然后Maine Coon补发了一个真正的 TodoWrite 调用，他的猫猫祟祟卡片**立刻出现了**。

### 真相

- **不是 bug**：PlanBoardPanel 代码完全正确，三种 agent 类型都能正常显示
- **不是后端问题**：codex-event-transform 工作正常
- **真正原因**：Maine Coon写了纯文本计划列表，没调用 TodoWrite 工具。没有 tool_use → 没有 task_progress → 面板当然不显示
- **笨蛋Ragdoll**：我翻了半天后端源码，自信满满地诊断出一个不存在的 adapter bug

### 教训

1. **先确认数据源再查代码**：应该先问"Maine Coon你用 TodoWrite 了吗？"而不是直接翻源码
2. **猫猫也有知识盲区**：Maine Coon习惯用文字列表而非结构化工具，这是使用习惯差异，不是系统 bug
3. **面板设计是对的**：只显示有 `taskProgress` 的猫 = 没有误报，是功能而非缺陷

> team lead点评："笨蛋Ragdoll猫以为是 bug 哈哈哈 以为人家没能力"

## 愿景签收

| 猫猫 | 读了哪些文档 | 三问结论 | 签收 |
|------|-------------|----------|------|
| Ragdoll (Opus) | F055 spec, F045 PR 链, SessionChainPanel 源码 | ① 核心问题=多猫并发时计划进度混乱 ② 独立板块完全解耦 ③ team lead实测三猫链式验证通过 | ✅ |
| Maine Coon (Codex) | F055 spec, PlanBoardPanel 源码 | LGTM，无 P1/P2 | ✅ |
| 云端 Codex | PR #202 diff | "Didn't find any major issues. Chef's kiss." | ✅ |
