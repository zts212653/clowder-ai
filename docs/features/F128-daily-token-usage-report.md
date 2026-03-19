---
feature_ids: [F128]
related_features: [F051, F008]
topics: [token, usage, reporting, aggregation, observability]
doc_kind: spec
created: 2026-03-19
community_issue: "#144"
---

# F128: 每日 Token 消耗聚合报表 API

> **Status**: spec | **Owner**: Ragdoll (Opus) | **Priority**: P1

## Why

铲屎官需要知道"今天每只猫花了多少 token"。现有基础设施（F008）已经在每次 invocation 完成时把 `usageByCat`（inputTokens / outputTokens / cacheReadTokens / costUsd）写入 Redis InvocationRecord（TTL 7 天），但缺少按"日期 × 猫"维度的聚合查询端点。

F051（猫粮看板）关注**剩余额度百分比**（"还剩多少"），本 Feature 关注**历史消耗绝对值**（"今天花了多少"），是互补的两个维度。

## What

### Phase A: 聚合 API

1. **`RedisInvocationRecordStore` 扩展**：新增 `scanAll()` 方法，SCAN 所有 invocation records
2. **聚合纯函数**：`aggregateUsageByDay(records, options)` — 按 `createdAt` 分天、按 cat 汇总 token，纯函数便于测试
3. **API 路由** `GET /api/usage/daily`：
   - 参数：`days`（可选，默认 7，最大 7）、`catId`（可选，过滤特定猫）
   - 返回：按日 × 猫的聚合结构（见 issue #144）

## Acceptance Criteria

### Phase A（聚合 API）
- [ ] AC-A1: `GET /api/usage/daily` 返回正确的按日 × 猫聚合数据
- [ ] AC-A2: 聚合逻辑有单元测试（含空数据、单猫、多猫场景）
- [ ] AC-A3: 空数据时正常返回空结构，不报错

## Dependencies

- **Evolved from**: F008（Token 捕获基础设施，已 done）
- **Related**: F051（猫粮看板，额度剩余维度）

## Risk

| 风险 | 缓解 |
|------|------|
| Redis SCAN 大量 key 性能问题 | 7 天 TTL 限制了数据量；SCAN 分批 + COUNT 参数控制 |
| InvocationRecord TTL 7 天，无法看更久 | Phase A 先做 7 天；未来可扩展到 SQLite 持久化 |
