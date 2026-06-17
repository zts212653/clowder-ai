---
feature_ids: [F069]
related_features: [F039]
topics: [unread, read-state, thread, hub, reliability]
doc_kind: spec
created: 2026-03-06
status: spec
---

# F069 — Thread Read State (Unread Badge Persistence)

> **Status**: spec | **Owner**: 三猫

## Why

F5 刷新后，线程列表的未读 badge（绿色/橙色猫猫标签）全部消失。operator报告："一按 F5 没读过的消息也都消失了，比如原本有 5 条没读，现在就会变成空的。"

根因：`unreadCount` / `hasUserMention` 是纯前端内存状态（Zustand `threadStates` map），无持久化，无后端真相源。`GET /api/threads` 不返回未读数据。

## What

后端建立 per-user/per-thread 的已读游标，前端刷新时从 API 恢复未读状态。

### 后端

- **ThreadReadStateStore**：新建 store，key = `thread-read:{userId}:{threadId}`，value = `{ lastReadMessageId, updatedAt }`
- **单调前进**：ack 只允许前进（新 messageId > 旧 messageId），防止回退
- **`PATCH /api/threads/:id/read`**：接收 `{ upToMessageId }`，更新已读游标
- **`GET /api/threads` hydrate**：返回 `unreadCount` + `hasUserMention`（基于 read cursor vs 该线程后续消息计算）

### 前端

- **初始化恢复**：页面加载时从 `GET /api/threads` 恢复 `unreadCount` / `hasUserMention`
- **打开线程 ack**：进入线程时自动调用 `PATCH /api/threads/:id/read`
- **Optimistic 更新**：保留 WebSocket 消息到达时的即时 unread 累加（现有行为）

## Acceptance Criteria

- [ ] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [ ] F5 刷新后未读 badge 正确恢复
- [ ] 打开线程后 badge 清零，服务端同步更新已读游标
- [ ] 多标签页打开同一用户：一个标签页 ack 后，另一个刷新也能看到已读状态
- [ ] ack 单调性：不能把已读游标往回移
- [ ] 线程删除时清理对应 read state
- [ ] 不影响现有 DeliveryCursorStore 行为

## Key Decisions

- **否决 localStorage**：跨标签/跨设备不一致，不可审计，治标不治本
- **不复用 DeliveryCursorStore**：语义不匹配（投递游标 + 7 天 TTL），生命周期不对
- **后端真相源**：read state 由服务端持久化，前端只做 optimistic 展示

## Dependencies

- **Evolved from**: F039（前端队列 UI 与 threadStates 模型）
- `Evolved from`: F039（前端队列 UI，建立了 threadStates / unreadCount / hasUserMention 内存模型）

## Risk

- **性能**：`GET /api/threads` 需要为每个线程计算 unreadCount，线程多时可能慢 — 可用 Redis 缓存摘要
- **并发**：多标签页同时 ack 需要 CAS 或 last-writer-wins — 单调前进天然安全

## Review Gate

- 后端：ThreadReadStateStore + API route + threads hydrate + 测试
- 前端：初始化恢复 + ack 调用 + optimistic 保持 + 测试
- ADR：拒绝 localStorage 作为未读真相源
