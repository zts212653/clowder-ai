---
feature_ids: [F150]
related_features: [F051, F009, F075]
topics: [observability, analytics, hub, redis]
doc_kind: spec
created: 2026-04-01
---

# F150: Tool/Skill/MCP Usage Statistics — 工具使用可观测看板

> **Status**: done | **Owner**: Community (bouillipx) + Ragdoll | **Priority**: P2

## Why

Cat Cafe 的猫猫们每天调用大量 tool、skill、MCP 能力，但目前没有一个统一的地方回答：

- 哪些工具被用得最多？哪些几乎没人碰？
- 各只猫的工具使用分布有什么差异？
- 使用趋势是什么样的？

F051 解决了"猫粮还剩多少"（quota），F075 解决了"谁干了多少活"（cat leaderboard），但**"哪些工具被用了多少次"**这个维度一直缺失。这条 feature 补齐工具侧的可观测性。

## What

### Phase A: 计数层 + 聚合 API

在 `route-serial` / `route-parallel` 的 `tool_use` 事件处埋点：

- **分类引擎** `classifyTool()`：把工具名归入 `builtin` / `skill` / `mcp` 三类，覆盖 Claude Code (`mcp__`) 和 Codex (`mcp:`) 两种 MCP 命名格式
- **Fire-and-forget 计数**：Redis INCR，O(1) 不阻塞请求路径，key 按 `tool:{toolName}:cat:{catId}:day:{YYYYMMDD}` 结构化
- **聚合 API** `GET /api/usage/tools`：支持 `days` / `catId` / `category` 筛选，60 秒内存缓存

### Phase B: Hub UI 看板 + 冷存档

- **Hub 面板**：总览卡片（总调用数 / 活跃工具数 / 最热工具）、三列分类排行榜、每日趋势折线图、按猫分布
- **冷存档** `ToolUsageArchiver`：JSONL append-only 归档 + 每日 sweep（Redis 90 天 TTL 过期前持久化）
- **全时段查询** `days=0`：Redis 热数据 + archive 合并

## Acceptance Criteria

### Phase A（计数层 + API）

- [x] AC-A1: `classifyTool()` 正确区分 builtin / skill / mcp，覆盖 `mcp__` 和 `mcp:` 两种前缀
- [x] AC-A2: tool_use 事件触发 Redis INCR，fire-and-forget 不阻塞请求路径
- [x] AC-A3: `GET /api/usage/tools` 返回按工具名聚合的调用次数，支持 `days` / `catId` / `category` 筛选
- [x] AC-A4: 分类逻辑 + 计数器 + API 路由有自动化测试覆盖

### Phase B（Hub UI + 存档）

- [x] AC-B1: Hub 面板展示总览卡片、分类排行榜、每日趋势、按猫分布
- [x] AC-B2: UI 筛选器（天数 / 猫 / 分类）与 API 参数对齐
- [x] AC-B3: JSONL 冷存档在 Redis TTL 过期前完成 sweep
- [x] AC-B4: `days=0` 全时段查询正确合并 Redis 热数据和 archive 冷数据
- [x] AC-B5: archive merge / sweep 路径有自动化测试

## Dependencies

- **Related**: F051（Quota Board — 同属 usage analytics 方向，共享 Hub 看板入口）
- **Related**: F009（tool_use 事件显示 — Phase A 在同一事件点埋点）
- **Related**: F075（猫猫排行榜 — 可作为 cat 维度的数据消费方）

## Origin

社区贡献者 `bouillipx` 在 `clowder-ai` 提交 PR #286（Phase A）和 #295（Phase B），
经 maintainer review 后从错误的 F142 改挂为 F150。

- 社区 issue 锚点：`clowder-ai#339`
- Phase A PR：`clowder-ai#286`
- Phase B PR：`clowder-ai#295`

## Risk

| Risk | Mitigation |
|------|------------|
| Redis key 膨胀（工具数 x 猫数 x 天数） | 90 天 TTL + 冷存档 sweep |
| JSONL archive 无 compaction | Phase C backlog：定期压缩或迁移到 SQLite |
| 核心路由文件改动（AgentRouter 等）的 intake 风险 | Intake 类型定为 manual-port，逐文件审查 |

## Vision Guard

> **Guardian**: 金渐层 (opencode/Opus-4.6) — 非作者、非 reviewer 独立验收
> **Date**: 2026-04-04
> **Verdict**: ✅ PASS

### AC 逐项验证

| AC | 验证方式 | 结果 |
|----|----------|------|
| AC-A1: classifyTool 区分 native/mcp/skill | 代码审查 `classify.ts` + `tool-usage-classify.test.js` 覆盖 `mcp__`/`mcp:` 两种前缀 | ✅ |
| AC-A2: fire-and-forget Redis INCR | `ToolUsageCounter.recordToolUse()` 调用 `redis.incr().then().catch()` 不 await；`route-serial.ts:494` + `route-parallel.ts:436` 确认埋点 | ✅ |
| AC-A3: GET /api/usage/tools 支持 days/catId/category | `tool-usage.ts` 路由实现 + `tool-usage-routes.test.js` 6 个用例 | ✅ |
| AC-A4: 分类 + 计数器 + API 有自动化测试 | 4 个测试文件，35/35 pass | ✅ |
| AC-B1: Hub 面板展示总览卡片、排行榜、趋势、分布 | `HubToolUsageTab.tsx` 含 SummaryCards / DailyTrend / TopToolsTable / ByCatSection 四组件 | ✅ |
| AC-B2: UI 筛选器与 API 参数对齐 | `days`/`catId`/`category` 三个 select + URLSearchParams 构造 | ✅ |
| AC-B3: JSONL 冷存档 sweep | `ToolUsageArchiver` + `index.ts:899-939` 定时 sweep（30s 首次 + daily） | ✅ |
| AC-B4: days=0 全时段合并 Redis + archive | `ToolUsageCounter.aggregate()` 在 `allTime` 分支做 entry-level dedup merge | ✅ |
| AC-B5: internal-archive/sweep 有自动化测试 | `tool-usage-archive.test.js` 存在并通过 | ✅ |

### 交付证据

- Intake PR: `cat-cafe#954` → `6accff30e` (MERGED)
- 社区 PR: `clowder-ai#286` + `clowder-ai#295` (MERGED)
- 社区 Issue: `clowder-ai#339` (CLOSED)
- Intent Issues: `cat-cafe#952` + `cat-cafe#953` (CLOSED)
- Test: `35/35 pass`（classify × 7 + counter × 8 + routes × 6 + archive × 14）
- Static check: `pnpm check` ✅
- Web build: `pnpm --filter @cat-cafe/web build` ✅
