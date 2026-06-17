---
feature_ids: [F081]
related_features: [F069, F072]
topics: [audit, state-machine, write-path, unread, catStatuses, messages, bubble]
doc_kind: audit
created: 2026-03-10
status: done
completed: 2026-03-10
---

# F081 Appendix — Bubble/Thread State Write-Path Audit

> **Status**: done | **Owner**: Ragdoll
> 起因：operator 2026-03-09 "别让operator发现什么你们修什么？修了一个另一个又出现问？"
> gpt52 提议系统级全量审计，opus 对齐到 F081 scope。

## Why

F081 附录文档用于把“消息/未读/猫状态”的写路径一次性摸清，避免继续头痛医头脚痛医脚，形成可追溯的状态机真相源。

## What

1. 盘点 `messages/catStatuses/unreadCount/hasActiveInvocation` 的写入入口
2. 建立 thread lifecycle 场景矩阵，标记已修与剩余风险
3. 输出固定的风险清单与后续 TODO，作为回归基线

## Acceptance Criteria

### Phase A（写路径审计）
- [x] AC-A1: 四类关键状态字段的写入点完成全量盘点并可定位到文件/行号。
- [x] AC-A2: thread lifecycle 场景矩阵覆盖 active/background/F5/切换/超时关键路径。

### Phase B（风险与闭环）
- [x] AC-B1: 已知风险与已修复项形成映射表（风险→修复→PR）。
- [ ] AC-B2: Remaining Gaps 列表逐项关闭（当前仍在进行）。

## Dependencies

- **Evolved from**: F069（线程已读状态）/ F072（批量已读）
- **Blocked by**: 无
- **Related**: F081（Bubble continuity observability）/ 前端状态机一致性治理

## Risk

| 风险 | 缓解 |
|------|------|
| 写路径分散导致修复互相覆盖 | 固定 write-path inventory + 场景矩阵，变更必须回填 |
| catStatuses 与 hasActiveInvocation 脱节引发幽灵状态 | 追加联动断言与 E2E 生命周期测试 |

## 1. State Fields Under Audit

| Field | 类型 | 真相源 | 存储 |
|-------|------|--------|------|
| `messages` | `ChatMessage[]` | 混合（server persisted + local synthetic） | Zustand flat (active) / threadStates map (bg) |
| `catStatuses` | `Record<string, CatStatus>` | 前端派生 | Zustand flat (active) / threadStates map (bg) |
| `unreadCount` | `number` | **服务端**（RedisThreadReadStateStore） | Zustand threadStates + API hydration |
| `hasUserMention` | `boolean` | **服务端** | Zustand threadStates + API hydration |
| `hasActiveInvocation` | `boolean` | 前端派生（socket 事件驱动） | Zustand flat (active) / threadStates map (bg) |

## 2. Write-Path Inventory

### 2.1 `messages` — 56 个写入点

#### Active Thread (flat state)

| # | Action | File | Trigger | 操作 |
|---|--------|------|---------|------|
| 1 | `addMessage()` | chatStore:553 | socket/user | 去重追加 |
| 2 | `removeMessage()` | chatStore:567 | message_deleted | 按 ID 删除 |
| 3 | `prependHistory()` | chatStore:572 | 滚动分页 | 头部插入 |
| 4 | `replaceMessages()` | chatStore:579 | replace hydration | 整体替换 |
| 5 | `replaceMessageId()` | chatStore:585 | 乐观 → 真实 ID | ID 替换 |
| 6 | `appendToLastMessage()` | chatStore:593 | 流式追加 | 尾部追加内容 |
| 7 | `appendToMessage()` | chatStore:603 | 流式追加 | 指定 ID 追加 |
| 8 | `appendToolEvent()` | chatStore:608 | tool_use/result | 工具事件追加 |
| 9 | `appendRichBlock()` | chatStore:613 | MCP callback | rich block 追加 |
| 10 | `setStreaming()` | chatStore:624 | 流开始/结束 | 标记 isStreaming |
| 11 | `setMessageMetadata()` | chatStore:656 | agent 响应 | provider/model/usage |
| 12 | `setMessageThinking()` | chatStore:665 | F045 thinking | 追加 thinking 内容 |
| 13 | `setMessageStreamInvocation()` | chatStore:672 | invocation_created | 绑定 invocationId |
| 14 | `clearMessages()` | chatStore:687 | thread 切换 | 清空全部 |

#### Multi-Thread (active 或 background)

| # | Action | File | Trigger | 操作 |
|---|--------|------|---------|------|
| 15 | `addMessageToThread()` | chatStore:760 | socket 消息 | 追加 + unread++ |
| 16 | `replaceThreadMessageId()` | chatStore:799 | 异步发送确认 | ID 替换 |
| 17 | `appendToThreadMessage()` | chatStore:827 | 后台流式 | 内容追加 |
| 18 | `appendToolEventToThread()` | chatStore:836 | 后台工具事件 | 工具事件追加 |
| 19 | `setThreadMessageMetadata()` | chatStore:872 | 后台 agent | metadata |
| 20 | `setThreadMessageUsage()` | chatStore:881 | usage 事件 | token 用量 |
| 21 | `setThreadMessageThinking()` | chatStore:889 | 后台 thinking | thinking 追加 |
| 22 | `setThreadMessageStreamInvocation()` | chatStore:897 | 后台 invocation | invocationId |
| 23 | `setThreadMessageStreaming()` | chatStore:909 | 后台流 | isStreaming |
| 24 | `batchStreamChunkUpdate()` | chatStore:1091 | **HOT PATH** | 批量更新 |

#### Hook Callers (主要入口)

| Hook | 写入 Action | 场景 |
|------|------------|------|
| `useSendMessage.ts` | addMessage/addMessageToThread/replaceThreadMessageId | 用户发消息 |
| `useAgentMessages.ts` | addMessage/appendToMessage/appendToolEvent/etc | 活跃 agent 流 |
| `useChatHistory.ts` | replaceMessages/prependHistory/clearMessages | 历史加载 |
| `useChatSocketCallbacks.ts` | addMessage/removeMessage | summary/删除 |
| `useSocket.ts` | addMessageToThread | connector 消息 |
| `useSocket-background.ts` | addMessageToThread/batchStreamChunkUpdate/appendToolEventToThread | 后台 agent 流 |

### 2.2 `catStatuses` — 28 个写入点

#### Active Thread

| # | Action | File:Line | Trigger | 值 |
|---|--------|-----------|---------|---|
| 1 | `setTargetCats(cats)` | chatStore:635 | 用户选猫 | `{cat: 'pending'}` 全部预置 |
| 2 | `setCatStatus(id, s)` | chatStore:637 | 单猫更新 | 直接设置 |
| 3 | `clearCatStatuses()` | chatStore:639 | 发送/取消 | `{}` 清空 |
| 4 | `setThreadIntentMode()` | chatStore:960 | intent 切换 | `{}` 清空 |
| 5 | `batchStreamChunkUpdate()` | chatStore:1106 | HOT PATH | 批量设置 |
| 6-13 | `setCatStatus()` calls | useAgentMessages | text/tool/done/error 事件 | streaming/done/error |
| 14 | `clearCatStatuses()` | useAgentMessages | isFinal=true / Stop | `{}` 清空 |
| 15 | `setTargetCats()` | useChatSocketCallbacks:52 | intent_mode 事件 | `{cat: 'pending'}` |

#### Background Thread

| # | Action | File:Line | Trigger | 值 |
|---|--------|-----------|---------|---|
| 16 | `setThreadTargetCats()` | chatStore:982 | intent_mode 事件 | `{cat: 'pending'}` ← **PR #335 修复** |
| 17 | `setThreadIntentMode()` | chatStore:969 | intent 切换 | `{}` 清空 |
| 18 | `updateThreadCatStatus()` | chatStore:1075 | 单猫更新 | 直接设置 |
| 19 | `batchStreamChunkUpdate()` | chatStore:1118 | HOT PATH | 批量设置 |
| 20 | `resetThreadInvocationState()` | chatStore:1151 | 超时/完成 | `{}` 清空 |
| 21-28 | `updateThreadCatStatus()` | useSocket-background | text/done/error/tool/status 事件 | streaming/done/error |

**关键发现**：
- `setThreadIntentMode()` 在 `setThreadTargetCats()` **之前**调用 → 先清空 `{}`，再预置 `pending`
- PR #335 之前 background `setThreadTargetCats` 没有预置 pending → 黄色猫不出现

### 2.3 `unreadCount` / `hasUserMention` — 8 个写入点

| # | Action | File:Line | Trigger | 方向 | Scope |
|---|--------|-----------|---------|------|-------|
| 1 | `addMessageToThread()` | chatStore:791 | socket 新消息 | +1 / OR mention | BG only |
| 2 | `incrementUnread()` | chatStore:1005 | (未使用) | +1 | BG only |
| 3 | `clearUnread()` | chatStore:1018 | 进入 thread | → 0 + 10s 抑制 | Any |
| 4 | `clearAllUnread()` | chatStore:1036 | 全部已读按钮 | → 0 + 10s 抑制 | All |
| 5 | `initThreadUnread()` | chatStore:1054 | API hydration | 直接设值 | BG only |
| 6 | `GET /api/threads` | threads.ts:221 | 页面加载 | 服务端计算 | Server |
| 7 | `POST /read/latest` | threads.ts:465 | thread 进入 | ack cursor | Server |
| 8 | `POST /read/mark-all` | threads.ts:392 | 全部已读 | ack all | Server |

**关键发现**：
- Active thread `snapshotActive()` 硬编码 `unreadCount: 0`（永远不显示 badge）
- 10s 抑制窗口防止 `initThreadUnread` 回写 stale count
- 服务端用 Lua CAS 保证 cursor 单调前进

### 2.4 `hasActiveInvocation` — 12 个写入点

| # | Action | File:Line | Trigger | 值 | Scope |
|---|--------|-----------|---------|---|-------|
| 1 | `setHasActiveInvocation(v)` | chatStore:630 | 直接调用 | param | Active |
| 2 | `setThreadHasActiveInvocation()` | chatStore:937 | 直接调用 | param | Both |
| 3 | `resetThreadInvocationState()` | chatStore:1148 | 超时/完成 | false | Both |
| 4 | intent_mode 事件 | useSocket:278 | server 事件 | true | Any |
| 5 | queue_updated(processing) | useSocket:355 | 队列恢复 | true | Any |
| 6 | markThreadInvocationActive | useSocket-bg:164 | BG 消息到达 | true | BG |
| 7 | markThreadInvocationComplete | useSocket-bg:173 | isFinal=true | false | BG |
| 8 | 5min 超时 | useAgentMessages:122 | 无 final | false | Active |
| 9 | done + isFinal | useAgentMessages:353 | done 事件 | false | Active |
| 10 | error + isFinal | useAgentMessages:615 | error 事件 | false | Active |
| 11 | BG 超时 | useAgentMessages:666 | 5min 无响应 | false | BG |
| 12 | Stop 按钮 | useAgentMessages:672 | 用户操作 | false | Active |

## 3. State Matrix — Thread Lifecycle Scenarios

| Scenario | messages | catStatuses | unreadCount | hasActiveInvocation |
|----------|----------|-------------|-------------|---------------------|
| **进入 active thread** | clearMessages → replaceMessages (API) | 保持 / 被 intent_mode 重置 | clearUnread → 0 + 10s 抑制 | 保持 |
| **离开 active thread** | snapshotActive → threadStates map | snapshotActive 保存 | snapshotActive: 0 | snapshotActive 保存 |
| **BG thread 收到新消息** | addMessageToThread +1 | updateThreadCatStatus → streaming | +1 | markInvocationActive → true |
| **BG thread 完成** | addMessageToThread(final) | updateThreadCatStatus → done | +1 | markInvocationComplete → false |
| **F5 刷新** | 清空 → GET /api/messages hydrate | 清空 → `{}` | GET /api/threads hydrate | false (重新从 socket 驱动) |
| **切走再切回 (cached)** | 从 threadStates 恢复 | 从 threadStates 恢复 | clearUnread → 0 | 保持 threadStates 值 |
| **切走再切回 (unread>0)** | force fetchHistory(replace) | 保持 | clearUnread → 0 + POST /read/latest | 保持 |
| **Stream placeholder → real msg** | replaceMessageId (乐观→真实) | 不变 | 不变 | 不变 |
| **Mark all read** | 不变 | 不变 | clearAllUnread → 0 + POST mark-all | 不变 |
| **Done + isFinal** | addMessage(system) | clearCatStatuses → `{}` | 不变 | → false |
| **Error + isFinal** | addMessage(error) | setCatStatus → error → clear | 不变 | → false |
| **5min 超时** | addMessage(timeout) | 不变 (active) / reset (bg) | 不变 | → false |
| **用户 Stop** | 不变 | clearCatStatuses → `{}` | 不变 | → false |

## 4. Known Risks & Fixed Bugs

| Risk | 根因 | 修复 | PR |
|------|------|------|---|
| Badge 点不掉 (R1-R3) | ack 到 synthetic ID → 400 | sortable ID 白名单 | #279, #282, #295 |
| Badge 点不掉 (R4) | cached thread 不刷新 → ack 旧 ID | force fetchHistory when unread>0 | #327 |
| Badge 点不掉 (R5) | 前端猜 ID 竞态 | POST /read/latest 后端真相源 | #331 |
| 黄色猫不出现 | BG setThreadTargetCats 没预置 pending | 对称预置 pending | #335 |
| Stale API 回写 badge | initThreadUnread 在 ack 前触发 | 10s 抑制窗口 | #279 |
| F5 后 badge 爆炸 | 无 cursor = 全 unread | 冷启动: 无 cursor = 0 unread | #267 |

## 5. Remaining Gaps (TODO)

- [ ] `incrementUnread()` (chatStore:1005) 在生产代码中未被调用，可考虑删除
- [ ] `_unreadSuppressedUntil` 无清理策略，长会话可能累积 key
- [ ] `catStatuses` 与 `hasActiveInvocation` 分离 → ThreadCatStatus 只看 catStatuses，如果 catStatuses 被清空但 hasActiveInvocation 仍为 true，就会出现"还在跑但显示 idle"
- [ ] `batchStreamChunkUpdate()` 的 catStatus 参数如果传 undefined 会保持原值，但 done/error 事件不走 batch path → 可能存在竞态
- [ ] 缺少 E2E 测试覆盖完整 thread lifecycle（进入→消息到达→切走→切回→badge/cat 状态一致性）
