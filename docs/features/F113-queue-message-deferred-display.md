---
feature_ids: [F113]
related_features: [F039, F047]
topics: [message, queue, UX]
doc_kind: spec
created: 2026-03-13
---

# F113: 排队消息延迟显示 — 队列中的消息不应进入聊天流

> **Status**: spec | **Owner**: opus | **Priority**: P1

## Why

当猫猫正在回复时，用户新发的消息会被排入队列（deliveryMode: 'queue'）。当前实现中，排队消息会**同时**出现在聊天消息流和队列面板中，造成视觉混乱——用户看到同一条消息出现了两次（截图证据：`1773392665674-dd01e0a4.png`）。

正确的行为：排队中的消息应**只在队列面板中可见**，直到消息被实际处理（dequeued）时才进入聊天消息流。

**Team experience**: 2026-03-13 owner 反馈"队列中的消息实际发出去后才会进入的"。

## What

### Phase A: 延迟乐观消息插入

**根因**：`useSendMessage.ts` 第 95-100 行，无论 `deliveryMode` 是否为 `'queue'`，都会立即通过 `addMessage()` 将用户消息乐观地添加到聊天流中。

**修复方案**：

1. **前端 `useSendMessage.ts`**：当 `isQueueSend === true` 时，跳过乐观消息插入（不调用 `addMessage` / `addMessageToThread`），仅发送 API 请求
2. **后端队列处理**：当队列消息被实际 dequeue 并开始处理时，通过现有 WebSocket 事件（`message_created` 或 `queue_updated` with `action: 'processing'`）将用户消息推送到聊天流
3. **队列面板**：已有消息预览能力，无需改动

**需要验证**：后端 dequeue 时是否已经广播用户消息到聊天流。如果是，前端只需跳过乐观插入即可。如果不是，需要在后端 dequeue 时补发 `message_created` 事件。

## Acceptance Criteria

### Phase A（延迟乐观消息插入）
- [ ] AC-A1: 当 `deliveryMode === 'queue'` 时，用户消息不立即出现在聊天消息流中
- [ ] AC-A2: 排队消息在队列面板中正常显示（含内容预览）
- [ ] AC-A3: 当排队消息被 dequeue 并开始处理时，用户消息出现在聊天消息流中
- [ ] AC-A4: 非排队消息（正常发送、force 发送）行为不变
- [ ] AC-A5: 队列面板的撤回、重排序、steer 功能不受影响

## Dependencies

- **Evolved from**: F039（消息排队投递基础设施）
- **Related**: F047（Queue Steer — 队列管理交互）

## Risk

| 风险 | 缓解 |
|------|------|
| 后端 dequeue 时可能没有广播用户消息事件 | 先验证后端行为，按需补发 |
| 撤回队列消息后消息流中残留消息 | 排队时不插入消息流，所以不会残留 |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | 后端 dequeue 开始处理时是否已经广播 `message_created` 事件？ | ⬜ 未定 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-03-13 | 立项（owner 反馈 UX 问题） |
