---
feature_ids: [F175]
related_features: [F039, F047, F117, F122, F133, F167]
topics: [queue, dispatch, priority, invocation, connector, architecture]
doc_kind: spec
created: 2026-04-24
---

# F175: 消息队列统一设计 — 优先级排序 + 用户可控编排

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1

## Why

issue #564 现场案例：opus 在 A2A round 2 执行中，CI failure 通知以 `priority: 'urgent'` 到达 → `handleUrgentTrigger()` 直接抢占 → `signal.abort()` → opus 回复中的 `@gpt52` mention 被检测但路由被 `signal.aborted` 门控阻止 → 静默丢弃。用户无任何提示。

根因不是单个 bug，而是三个设计债务的叠加：

1. **Urgent connector 消息绕过队列**：4 个来源（Review / CI failure / PR conflict）走 `handleUrgentTrigger()` 旁路，直接抢占活跃 invocation，绕过队列
2. **队列只有 FIFO，没有优先级**：纯时间排序，urgent 消息无法跳队，只能绕过队列（抢占旁路）
3. **用户消息强制合并，无法单条管理**：merge 逻辑将连续消息拼成一条 QueueEntry，无法单条删除/重排

F133 KD-4 记录了 urgent 抢占的原始设计意图："失败消息应抢占避免在队列中长时间堆积"。当时队列是纯 FIFO，抢占是唯一保证及时处理的手段。**设计意图正确，但 F122B 统一 A2A 进队列后，基础设施已足以用 priority ordering 替代 preemption。**

## What

### Phase A: 后端统一 — 消除 bypass + priority ordering + user-message batching

**1. 消除 urgent bypass**

- 删除 `ConnectorInvokeTrigger.handleUrgentTrigger()` 和 urgent 分支（L105-118, L228-234）
- active-slot 时所有消息（user / connector / agent）走 `enqueueWhileActive()`，透传 `priority` 和 `sourceCategory`；idle slot 保留 fast path 直接执行
- 4 个 urgent 调用方不改（仍设 `priority: 'urgent'`），语义从"抢占"变为"优先出队"

**2. QueueEntry 扩展**

```typescript
interface QueueEntry {
  // ...existing fields...
  priority: 'urgent' | 'normal';
  sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a';
  position?: number;  // 用户手动排序位置
}
```

**3. 出队多维排序**

```
peekOldestAcrossUsers(threadId):
  1. 显式 position（用户手动拖动）— 同 userId 内最高优先（跨用户不干扰）
  2. priority（urgent > normal）
  3. sourceCategory 同优先级内 FIFO
  4. createdAt 兜底
```

只有显式手动 position 的 entry 才覆盖 priority（仅同 userId 条目间比较；shared thread 中不同用户的拖动互不干扰）；未手动排序的 entry 仍按 `priority → createdAt` 默认出队。

**4. 取消用户消息强制 merge + 出队时 user-message batching**

取消 `enqueue()` 的 merge 逻辑（每条消息独立 QueueEntry），但保持现有执行语义：

```
QueueProcessor 出队时：
  if entry.source === 'user':
    收集队列中紧随其后的连续 entries，满足：
      - source === 'user'
      - 同 userId
      - 同 intent
      - 同完整 targetCats 集合（Set equality）
    → 一起作为一次 invocation 的上下文

  if entry.source === 'connector' or 'agent':
    单条处理（当前行为不变）
```

用户可通过拖动排序打断连续性，从而控制汇聚边界。

**5. 队列容量按 source 分别限制**

- user 消息：保留 `MAX_QUEUE_DEPTH`（防刷屏）
- connector / agent 消息：不加硬上限，靠现有 guard 组合（CiCdCheckPoller lastCiFingerprint / ReviewRouter ProcessedEmailStore / route-serial maxDepth + STALE_QUEUED / InvocationTracker TTL 75min）

**6. 新增 reorder API**

- `PATCH /api/threads/:threadId/queue/reorder` — 批量设置 position
- 现有 `move up/down` 保留作为 position 的快捷操作

### Phase B: 前端编排 — QueuePanel 升级

**7. QueuePanel 升级**

- 拖动排序（drag & drop）
- 每条消息独立显示、独立可删除（不再合并显示）
- 视觉分组：按 sourceCategory + urgent 标记
- 收起/折叠（消息多时不挤占聊天窗口）

**8. SteerQueuedEntryModal 适配**

- 适配新排序语义
- steer 强推路径不变

### Phase C: Spec + ADR 更新

**9. 历史 Spec 更新**

- F133 KD-4 修正：urgent 语义从"抢占"改为"队首优先级"
- F122 spec 标 "executor unification: complete"
- F047 spec 加 reorder

**10. 新 ADR：消息队列终态设计**

- 设计决策记录
- Guard story（connector/agent 深度护栏现有组合 + runaway 告警方案）

## 实现不变量（maintainer review 要求）

1. **User-message batching 判定条件须等价现有 merge 语义**：source=user + 同 userId + 同 intent + 同完整 targetCats 集合（Set equality）
2. **Drag > priority 的精确边界**：只有显式手动 position 的 entry 才覆盖 priority
3. **Batching 不重新推断 target**：用 entry 上已解析好的 targetCats，不在 batching 逻辑里重新推断

## Acceptance Criteria

### Phase A（后端统一）
- [ ] AC-A1: `handleUrgentTrigger()` 和 urgent 分支已删除，active-slot 时所有 connector 消息走 `enqueueWhileActive()`（idle slot 保留 fast path）
- [ ] AC-A2: QueueEntry 有 `priority` 字段，4 个 urgent 调用方正确透传
- [ ] AC-A3: 出队逻辑 priority-first — urgent 消息在 normal 前面被处理
- [ ] AC-A4: 用户手动 position 覆盖 priority 排序（仅显式设置时）
- [ ] AC-A5: 用户消息不再强制 merge — 每条独立 QueueEntry
- [ ] AC-A6: 出队时 user-message batching — 连续同 userId + 同 intent + 同 targetCats 的 user entries 汇聚为一次 invocation
- [ ] AC-A7: connector/agent 消息不受 MAX_QUEUE_DEPTH 限制
- [ ] AC-A8: reorder API 可用（`PATCH /queue/reorder`）
- [ ] AC-A9: 回归：urgent connector 不打断 A2A 链（#564 原始场景修复）
- [ ] AC-A10: 回归：跨优先级自动 dequeue — urgent 处理完后自动继续 normal

### Phase B（前端编排）
- [ ] AC-B1: QueuePanel 支持拖动排序
- [ ] AC-B2: 每条消息独立显示、独立可删除
- [ ] AC-B3: 视觉分组（sourceCategory + urgent 标记）
- [ ] AC-B4: QueuePanel 收起/折叠

### Phase C（Spec + ADR）
- [ ] AC-C1: F133 KD-4 修正完成
- [ ] AC-C2: F122 spec 标 "executor unification: complete"
- [ ] AC-C3: F047 spec 加 reorder
- [ ] AC-C4: 新 ADR 创建，含 guard story

## Dependencies

- **Evolved from**: F122（执行通道统一 — 本次补齐 connector urgent 这最后一条未统一的通道）
- **Related**: F039（消息排队投递原始设计）
- **Related**: F047（Queue Steer — 增强拖动排序）
- **Related**: F117（Message Delivery Lifecycle — deliveryStatus 机制不变）
- **Related**: F133（CI/CD Tracking — urgent priority 语义变更）
- **Related**: F167（A2A Chain Quality — #564 是 A2A 链断裂的具体案例）

## Risk

| 风险 | 缓解 |
|------|------|
| 取消 merge 后用户消息 batching 判定条件遗漏 | 严格对齐现有 merge 条件（userId + intent + targetCats Set equality），不能少不能多 |
| priority ordering 改变出队顺序可能影响现有用户体验 | urgent 消息本来就走 bypass 不在队列里，现在进队列但排前面，用户可见性反而提高 |
| connector/agent 队列无硬上限可能 runaway | 现有 guard 组合覆盖主要场景（去重 + depth limit + stale 清理），实践中监控 |
| 前端拖动排序和后端 position 的一致性 | position 是 optional number，未设置时走默认排序，设置时同 userId 内优先（跨用户不干扰） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 存储独立，用户消息处理时汇聚 | 队列中每条消息独立入队可单条管理；出队时收集连续同条件的 user entries — 兼顾控制权和执行效率 | 2026-04-23 |
| KD-2 | Priority 是排序维度不是旁路 | urgent 消息自动置顶但在队列内，用户可见可控；不再有绕过队列的抢占路径 | 2026-04-23 |
| KD-3 | 队列容量按 source 分别限制 | user 消息有上限（防刷屏），connector/agent 不限制 — 系统消息不应因队列满而丢弃 | 2026-04-23 |
| KD-4 | 跨优先级自动 dequeue | "猫猫不主动停"的协作语义；用户要停可以 steer/cancel | 2026-04-24 |
| KD-5 | 拖动排序覆盖 priority（仅同 userId 内显式 position） | CVO 用户意图至上；跨用户不干扰，未手动排序的 entry 仍按 priority 排序 | 2026-04-24 |
| KD-6 | 不做通用 targetCat batching | 跨 source 的 batching 是新执行语义，回归面不可控，留作独立 design issue | 2026-04-24 |
| KD-7 | signal.aborted 安全门控保留 | 正确的并发保护，修复的是 signal 被错误 abort，不是门控本身 | 2026-04-24 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-23 | #564 issue 创建，根因分析 + 设计调查 |
| 2026-04-24 | Maintainer review 完成，设计共识达成，立项 F175 |

## Review Gate

- Phase A: maintainer review（zts212653 家的猫）+ 跨家族 review
- Phase B: 跨家族 review
- Phase C: 铲屎官确认 spec 变更

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Issue** | [#564](https://github.com/zts212653/clowder-ai/issues/564) | 原始 issue + 设计讨论 |
| **Feature** | `docs/features/F122-unified-dispatch-queue.md` | F122 执行通道统一（本次收尾） |
| **Feature** | `docs/features/F133-cicd-tracking.md` | F133 CI/CD Tracking（urgent 语义来源） |
| **Feature** | `docs/features/F039-message-queue-delivery.md` | F039 消息排队投递原始设计 |
| **Feature** | `docs/features/F047-queue-steer.md` | F047 Queue Steer |
