---
feature_ids: [F142]
related_features: [F051, F075]
topics: [observability, analytics, api]
doc_kind: spec
created: 2026-03-28
---

# F142: Tool / Skill / MCP Usage Statistics API

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P2

## Why

铲屎官需要看到猫猫们日常工作中 skill、tool、MCP 工具的使用频次，以了解哪些工具被高频使用、哪些闲置。现有 F051/F128 只统计 token 消耗和费用，缺少"工具调用频次"维度。数据已存在于 session transcript 的 `tool_use` 事件中，但没有聚合层。

铲屎官原话：
> "我想做一个统计，skill 的历史使用次数、tool 的历史使用次数、mcp 的历史使用次数"

## What

### Phase A: Redis 实时计数 + API 端点

**分类逻辑**（基于 `toolName` 字段）：

| 类别 | 判定规则 | 示例 |
|------|---------|------|
| **skill** | `toolName === 'Skill'`，具体名从 `toolInput.skill` 提取 | `Skill` → `{skill: "tdd"}` |
| **mcp** | `toolName.startsWith('mcp__')` | `mcp__cat-cafe__cat_cafe_post_message` |
| **native** | 其余 | `Read`, `Write`, `Edit`, `Bash` |

**埋点**：在 `route-helpers.ts` 加分类函数 `classifyTool()`，在 `route-serial.ts` / `route-parallel.ts` 的 `tool_use` 事件处理点加 fire-and-forget Redis INCR。

**Key pattern**: `tool-stats:{YYYY-MM-DD}:{catId}:{category}:{toolName}` — TTL 90 天。

**API 端点**: `GET /api/usage/tools?days=30&catId=opus&category=all`

返回按天×猫×类别聚合的使用次数 + top tools 排行。

### Phase B: Hub UI（由其他猫完成 UX 设计后实施）

复用 Usage 页面加 tab，展示趋势图 + 排行榜。本 Phase 不在 F142 scope 内，待 Phase A 完成后由前端猫接手。

## Acceptance Criteria

### Phase A（Redis 实时计数 + API）
- [ ] AC-A1: `classifyTool(toolName, toolInput)` 函数正确分类 native/mcp/skill 三类，有单元测试
- [ ] AC-A2: `route-serial.ts` 和 `route-parallel.ts` 在 `tool_use` 事件时 fire-and-forget 写入 Redis 计数
- [ ] AC-A3: `GET /api/usage/tools` 返回 `{period, summary, topTools, daily, byCat}` 结构
- [ ] AC-A4: Redis key 自动 90 天 TTL 过期
- [ ] AC-A5: API 支持 `days`/`catId`/`category` 查询参数筛选

## Dependencies

- **Evolved from**: F051（猫粮看板 — 共享 usage 路由模式和 Redis 存储层）
- **Related**: F075（猫猫排行榜 — 未来可集成 tool 使用维度）
- **Related**: F009（tool_use 事件显示 — 前端已能展示单条 tool 事件）

## Risk

| 风险 | 缓解 |
|------|------|
| Redis INCR 高频写入影响性能 | fire-and-forget，不 await；INCR 是 O(1) 微秒级操作 |
| tool 名变化导致统计碎片 | 分类函数统一归一化，MCP 额外提取 serverName |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 从今天起计，不做历史回填 | 铲屎官拍板：回填复杂度高，价值有限 | 2026-03-28 |
| KD-2 | 按天粒度，不需要按小时 | 铲屎官确认够用 | 2026-03-28 |
| KD-3 | Phase A 只做 API，Hub UI 交其他猫 | 铲屎官拍板：先 API 端点 | 2026-03-28 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-03-28 | 立项，铲屎官确认 scope |
