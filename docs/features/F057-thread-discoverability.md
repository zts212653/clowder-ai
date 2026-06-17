---
feature_ids: [F057]
related_features: [F052, F056]
topics: [thread, search, sorting, mcp, ux]
doc_kind: feature-spec
created: 2026-03-04
---

# F057: Thread 可发现性 — 排序 + 搜索 + 猫猫工具

> **Status**: done | **Owner**: Ragdoll
> **Priority**: P1
> **Completed**: 2026-03-05
> **Evolved from**: F052（跨线程消息暴露了"找不到 thread"的痛点）
> **Related**: F056（设计语言猫猫化 — UI 应用新设计标准）

## 愿景

> **一句话**：Thread 多了不可怕，找得到、猫猫也找得到才行。

### operator experience（2026-03-04）

> "现在 thread 太多了！希望活跃的 thread 自己跑到前面"
> "比如置顶的 有猫猫回复我 他也要能跳到上面去"
> "通过 thread id 搜索？不然我找不到！"
> "你们也要有 list_threads MCP 工具 不然如何回答我哪些 thread 举办过猫猫杀？"
> "你们都不会 at 我呀！其实也应该增加 at operator"

### 期望体验

operator打开 Cat Café Hub 侧边栏：
1. **置顶区**里最近有猫回复的 thread 自动浮到最前面，不用翻
2. **非置顶区**也按活跃度排序，刚有动静的在上面
3. 想找特定 thread 时，**搜索框**输入名字或 ID 就能找到
4. 问猫猫"哪个 thread 做过 X"，猫猫能用 `list_threads` 工具查到并回答
5. 跨线程消息的"转发自"badge 显示 **thread ID + 名称**，可点击跳转

## Why

### 当前痛点（截图证据：2026-03-04 operator侧边栏）

| 问题 | 影响 |
|------|------|
| 置顶 thread 太多，活跃的和沉寂的平级排列 | operator翻不到正在活跃的 thread |
| 没有搜索功能 | 只能肉眼滚动找 |
| 猫猫没有 list_threads 工具 | 无法回答"哪个 thread 做过 X" |
| 跨线程 badge 只显示 hash 前 8 位 | 认不出来源 thread |
| 猫猫不会 @ operator | operator不知道哪个 thread 有新动态 |

## What

### Phase A：Thread 排序（前端）

#### A1: 置顶区按活跃排序
- 置顶 thread 内部按**最后一条消息时间**降序排列
- 有新消息的 thread 自动浮到置顶区顶部

#### A2: 非置顶区按活跃排序
- 非置顶 thread 同样按最后一条消息时间降序
- 未读 thread 优先排在活跃 thread 前面

#### A3: 未读标记增强
- thread 有未读消息时显示未读计数 badge
- 未读 thread 排在已读前面（同组内）

### Phase B：Thread 搜索

#### B1: 前端搜索框
- 侧边栏顶部加搜索框，支持：
  - 按 thread 名称模糊搜索
  - 按 thread ID 精确搜索
  - 实时过滤（keyup debounce）

#### B2: 跨线程 badge 增强（F052 Phase C）
- badge 显示 `转发自 {threadId前8位} | {thread名称}`
- badge 可点击，跳转到来源 thread
- API 需要返回 thread 名称（或前端 lookup）

### Phase C：猫猫 MCP 工具

#### C1: `list_threads` MCP 工具
- 参数：`keyword`（名称搜索）、`status`（active/pinned/all）、`limit`
- 返回：thread ID、名称、最后活跃时间、置顶状态、消息数
- 猫猫可以用来回答"哪个 thread 做过 X"

#### C2: 猫 @ operator能力
- MCP `post_message` 支持 `@user` mention
- 前端 thread 列表对有 `@user` 未读的 thread 加强高亮

## Acceptance Criteria

### Phase A
- [x] AC-A1: 置顶 thread 按最后消息时间排序
- [x] AC-A2: 非置顶 thread 按最后消息时间排序
- [x] AC-A3: 未读 thread 在同组内优先排在前面

### Phase B
- [x] AC-B1: 侧边栏搜索框支持名称模糊搜索 + ID 精确搜索
- [x] AC-B2: 跨线程 badge 显示 thread ID + 名称，可点击跳转

### Phase C
- [x] AC-C1: `list_threads` MCP 工具可用，猫猫能按名称搜索 thread
- [x] AC-C2: 猫猫能 @ operator，operator在 thread 列表看到未读高亮

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "活跃的 thread 自己跑到前面" | AC-A1, AC-A2 | 截图对比排序 | [x] |
| R2 | "有猫猫回复他也要能跳到上面去" | AC-A1 | 发消息后观察排序变化 | [x] |
| R3 | "未读要在前面" | AC-A3 | 截图对比 | [x] |
| R4 | "通过 thread id 搜索" | AC-B1 | 搜索框输入 ID 验证 | [x] |
| R5 | "你们也要有 list_threads MCP 工具" | AC-C1 | 猫猫调用工具回答问题 | [x] |
| R6 | "应该增加 at operator" | AC-C2 | 猫猫 @ user + 高亮验证 | [x] |
| R7 | "转发自 badge 显示不全" | AC-B2 | badge 显示 ID+名称 | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 排序用最后消息时间，不用 @ 优先 | operator说"猫猫不会 at 我"，目前 @ user 不存在 | 2026-03-04 |
| KD-2 | 搜索做在前端（过滤已加载的 thread 列表） | thread 数量有限（< 100），不需要后端搜索 | 2026-03-04 |
| KD-3 | badge 增强归入 F057 而非 F052 | F052 done，badge 增强本质是 thread 可发现性问题 | 2026-03-04 |

## Dependencies

- **Evolved from**: F052（跨线程消息暴露 thread 找不到的痛点）
- **Related**: F056（设计语言 — UI 遵循猫猫化设计标准）

## Risk

| 风险 | 缓解 |
|------|------|
| 排序频繁跳动干扰视觉 | 用动画过渡 + debounce，不是每条消息都重排 |
| list_threads 工具被滥用占带宽 | 加 rate limit + cache |

## Review Gate

- 跨家族 review（Maine Coon codex 或 gpt52）
- Phase B2 的 badge 设计需Siamese视觉确认

## 签收表

| 猫猫 | 读了哪些文档 | 三问结论 | 签收 |
|------|-------------|---------|------|
| Ragdoll (opus) | F057 spec, thread-utils.ts, ThreadSidebar.tsx, ChatMessage.tsx, callback-tools.ts, user-mention.ts | 7/7 AC 代码已实现，operator体验路径完整 | ✅ |
| Maine Coon (codex) | F057 spec, thread-utils.ts:42, ThreadSidebar.tsx:220, ChatMessage.tsx:385, callbacks.ts:230+551, ThreadCatStatus.tsx:45, chatStore.ts:592 | 7/7 AC 独立核实，operator体验完整 | ✅ |
