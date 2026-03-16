---
feature_ids: [F117]
related_features: [F039]
topics: [message, queue, delivery, lifecycle, context]
doc_kind: spec
created: 2026-03-14
---

# F117: Message Delivery Lifecycle — 消息投递生命周期真相源

> **Status**: done | **Owner**: Ragdoll + Maine Coon | **Priority**: P1
> **community_issue**: [#20](https://github.com/zts212653/clowder-ai/issues/20)

## Why

team lead 2026-03-14 实测发现：queue 模式发送消息后立即取消，该消息仍出现在聊天流、进入猫猫 prompt context。社区 issue #20 也报告了同样问题。

根因：当前架构下 queue send 在 enqueue 阶段就持久化 user message 并做乐观插入，但没有 delivery status 概念。History API 和 ContextAssembler 不区分 queued/delivered/canceled，导致未送达甚至已取消的消息污染聊天历史和猫猫上下文。

**核心 invariant**：`undelivered user messages MUST NOT appear in timeline, history API, or prompt context.`

team experience：
> "前端不应该显示你们真正没有收到的消息，对吧？"
> "当我发了一个正在队列的消息的时候，我的用户气泡这里先不显示，等到你们真的收到这个消息的那一刻，再在正确的地方插入这个气泡"

## 已确认的 Bug 现象（team lead实测 2026-03-14）

### Bug 1: 队列消息提前显示气泡
- **复现**：猫猫正在回复中 → 用户发消息（自动进队列）→ 消息还在"排队中"面板 → 聊天流里气泡已经出现
- **期望**：队列面板显示即可，聊天气泡等到消息真正"送达"（dequeue 执行）时才插入
- **截图**：同一条消息同时出现在聊天气泡和排队面板（`1773488348921-03899885.png`）

### Bug 2: 取消后消息仍在气泡 + 仍进入猫猫上下文
- **复现**：用户在队列面板按 X 取消消息 → 气泡仍然留在聊天流 → 猫猫下次回复时 prompt context 里有这条已取消的消息
- **期望**：取消后气泡消失，猫猫永远不应该"看到"这条消息
- **实测证据**：team lead发送 `嘿嘿大猫猫喵` → 取消 → 猫猫对话上下文中仍出现该消息

### Bug 3a: queued 用户 @mention 提前进入 pending-mentions（F117 scope）
- **复现**：用户发带 @gpt52 的消息 → 消息进入队列（排队中）→ `pending-mentions` 已包含该条目
- **期望**：queued/canceled 的用户 @mention 不应出现在 `pending-mentions`；delivered 后才进入
- **根因**：mention inbox 读取时只看 `msg.mentions`，不看 `deliveryStatus`

### Bug 3b: `cat_cafe_post_message` 的 @mention 路由异常（F117 out of scope）
- **复现**：猫猫用 `cat_cafe_post_message` 发带 `@gpt52` 的消息 → Maine Coon session 未收到
- **截图**：`1773488607773-f4b34f0a.png`
- **不属于 F117**：`post_message` 走 callback 路由（`callbacks.ts` → `messageStore.append` + `enqueueA2ATargets`），不经过前端 queue send，不依赖 delivery lifecycle
- **处置**：单开 callback @mention 路由 bug，F117 仅标记 `related`

### 根因链路（Maine Coon + Ragdoll调查确认）
1. `useSendMessage.ts:95-100` — 无条件乐观插入，不区分 queue/immediate
2. `messages.ts:249` — enqueue 阶段就持久化 user message，无 delivery status 标记
3. `messages.ts:700` — History API 不过滤 delivery status
4. `ContextAssembler.ts:99` — 不过滤 delivery status，未送达/已取消消息直接进 prompt
5. `queue.ts:99,249` — withdraw/clear 只删 queue entry，不处理已持久化的 message

## What

### Phase A: deliveryStatus 字段 + 后端收口

1. Message 模型新增 `deliveryStatus?: 'queued' | 'delivered' | 'canceled'`（老数据缺省 `delivered` 兼容）
2. enqueue 时 message 持久化带 `deliveryStatus: 'queued'`
3. History API（`GET /api/messages`）默认只返回 `delivered`（或无 deliveryStatus 的历史消息）
4. ContextAssembler 只组装 `delivered` 消息
5. Mention surfaces（`pending-mentions` 等）只返回 `delivered` 消息的 @mention
6. QueueProcessor dequeue 执行时：将 message 标为 `delivered`，扩展 `messages_delivered` 事件携带完整 user message payload
6. withdraw 单条：同步将 message 标 `canceled`，发 `message_deleted` 给前端
7. clear 队列：批量标 `canceled`，发批量 `message_deleted`

### Phase B: 前端适配

1. queue send 时**不做乐观插入**到主时间线（QueuePanel 仍通过 `queue_updated` 展示）
2. 收到扩展版 `messages_delivered` 事件时，将 user message 插入主时间线
3. 收到 `message_deleted` 时，从 store 中移除对应 message
4. F5 hydration 路径：history API 已过滤，无需额外处理

## Acceptance Criteria

### Phase A（后端 — deliveryStatus 真相源） ✅
- [x] AC-A1: Message 模型支持 `deliveryStatus` 字段，老数据兼容
- [x] AC-A2: enqueue 持久化 message 时 `deliveryStatus='queued'`
- [x] AC-A3: History API 默认排除 `queued` 和 `canceled` 消息
- [x] AC-A4: ContextAssembler 只组装 `delivered` 消息（含无 deliveryStatus 的历史兼容）
- [x] AC-A5: dequeue 执行时 message 标为 `delivered` + 扩展 `messages_delivered` 事件
- [x] AC-A6: withdraw 将 message 标 `canceled` + 发 `message_deleted`
- [x] AC-A7: clear 队列批量标 `canceled` + 发批量 `message_deleted`
- [x] AC-A8: 回归测试——queue send → cancel → history API 不返回、ContextAssembler 不组装
- [x] AC-A9: queue send 带 @mention 的消息 → delivered 前 `pending-mentions` 不返回；delivered 后才出现

### Phase B（前端适配） ✅
- [x] AC-B1: queue send 不做乐观插入到主聊天流
- [x] AC-B2: `messages_delivered` 事件触发 user bubble 插入主时间线
- [x] AC-B3: `message_deleted` 事件触发 store 移除
- [x] AC-B4: F5 刷新后 queued/canceled 消息不出现在聊天流
- [x] AC-B5: QueuePanel 功能不受影响（仍通过 `queue_updated` 正常展示）
- [x] AC-B6: queue send 多行消息（Shift+Enter）时不出现 optimistic bubble；delivered 后只出现一次

## Scope Boundary

- **In scope**: undelivered user message 对 `timeline / history API / prompt context / pending-mentions` 的一切泄漏
- **Out of scope but related**: `cat_cafe_post_message` callback 路由的 @mention 解析/路由异常（走 `callbacks.ts`，不经过 queue/delivery lifecycle）

## Dependencies

- **Evolved from**: F039（消息排队投递 — 三模式已完成，但缺 delivery lifecycle 概念）
- **Related**: F047（Queue Steer）、community issue [#20](https://github.com/zts212653/clowder-ai/issues/20)、PR [#25](https://github.com/zts212653/clowder-ai/pull/25)

## Risk

| 风险 | 缓解 |
|------|------|
| 老数据无 deliveryStatus 字段，查询可能误伤 | 缺省按 `delivered` 兼容，过滤条件 `WHERE deliveryStatus IS NULL OR deliveryStatus='delivered'` |
| `messages_delivered` payload 变更影响现有消费者 | 扩展而非重构，新增 `userMessage` 字段，现有字段不变 |
| withdraw/clear 新增 `message_deleted` 事件可能与现有删除逻辑冲突 | 复用现有 `message_deleted` handler，确认幂等 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 用显式 `deliveryStatus` 字段而非 `deliveredAt` | `deliveredAt` 老数据没有，过滤会误伤即时消息和历史消息（Maine Coon提出） | 2026-03-14 |
| KD-2 | 不 merge 社区 PR #25 作为 quick fix | 只修渲染层是脚手架不是终态，withdraw resurfacing 未闭合（P1铁律）| 2026-03-14 |
| KD-3 | 修完后走全量 sync 而非 hotfix | 有多个已完成 F 待同步，hotfix 增加后续同步难度（team lead决定）| 2026-03-14 |
| KD-4 | Bug 3 拆分：queued @mention 泄漏 in scope / post_message callback 路由 out of scope | post_message 走 callback 路由不经 queue，硬塞进 F117 会混 scope（Maine Coon Design Gate 提出）| 2026-03-14 |

## Review Gate

- Phase A: 跨家族 review（Maine Coon review 后端 delivery lifecycle 改动）
- Phase B: 跨家族 review（Maine Coon review 前端适配）
