---
feature_ids: [F254]
related_features: [F233, F167, F069, F193]
topics: [freshness, held-draft, inbox-notice, runtime-descriptor, side-effect-gate, ax]
doc_kind: spec
created: 2026-06-27
tips_exempt: true
---

# F254: Side-Effect Freshness Gate — 副作用出口 freshness 拦截

> **Status**: in-progress (Phase A+B+C done, Phase D planning) | **Owner**: Ragdoll (Opus-4.6) | **Priority**: P1

## Why

**猫猫发消息的时候，不知道世界在它思考期间变了。**

猫猫被 invoke 后开始思考 + 写代码 + 准备回复，这个过程几分钟到十几分钟不等。期间 thread 里可能发生：
- operator改了主意（"算了不要做了"）
- 另一只猫已经完成了同一件事
- 新的 review 意见推翻了猫正在做的假设
- 球权已经转移（猫准备传球给 A，但 B 已经接了）

猫猫不知道这些变化就调 `post_message` 发出回复 → **答非所问 / 重复劳动 / 球权混乱**。

operator experience（2026-06-26，Raft teardown 讨论）：

> "这里我们也想做，早想做了但是我一直没做只是一个 steer。为什么？这你得好好看看家里的架构设计了，你们是 -p 启动的，这你要如何感知？如果你们能想办法做到 我会抱着你喊Ragdoll宝贝爱死你了！"

**核心洞察（回答operator的"如何感知"问题）**：猫猫不需要"感知"——gate 在 MCP 工具层（`post_message` 调用时），不在 agent 感知层。`-p` 模式完全不是障碍。

## Current State / 现状基线

**现有 freshness 检查（invocation 级，非消息级）**：

| 机制 | 位置 | 检查什么 | 局限 |
|------|------|----------|------|
| `isLatest()` | InvocationRegistry | 这个 invocation 是不是被新 invocation 取代了？ | 只检查"同一只猫有没有被重新 invoke"，不检查"thread 有没有新消息" |
| `stale_ignored` | callback-tools.ts:608-621 | 同上，客户端侧处理 | 同上 |
| F177-G 路由守卫 | stop hook | 传球格式是否合法 | 只检查格式，不检查 freshness |

**缺失的：消息级 freshness**——"你准备发消息的时候，thread 里有没有你还没看过的消息？"

**现有可复用原语**：

| 原语 | 位置 | 能力 |
|------|------|------|
| `DeliveryCursorStore` | `packages/api/.../stores/ports/DeliveryCursorStore.ts` | per-(user,cat,thread) 单调游标，lexicographically sortable message ID，Redis Lua CAS。**注意**：此游标追踪 harness 在 invoke 时 DELIVERED 了哪些消息到猫的 context（驱动 `route-helpers.ts:710 fetchAfterCursor` 增量注入），**不是**猫 mid-turn 看了什么。仅在 `route-serial.ts:3420` / `route-parallel.ts:1485` 推进，MCP 工具层（list_recent 等）**不推**此游标 |
| `mentionAckCursor` | 同 `DeliveryCursorStore` 文件 | 独立 key 前缀的第二命名空间（`getMentionAckCursor` / `ackMentionCursor`），证明同一 store 基础设施可承载多种语义游标 |
| `ThreadReadStateStore` | `packages/api/.../stores/ports/ThreadReadStateStore.ts` | per-(user,thread) 已读游标 + `getUnreadSummaries` 批量查询 |
| `MessageStore.generateId()` | MessageStore | 16 位 timestamp + 6 位 seq + 8 位 UUID 后缀，字符串比较 = 时间序 |
| F233 BallCustodyEventLog | `packages/api/src/domains/ball-custody/` | append-only 事件流 + projector + projection store（`BallCustodyEvent` 是**封闭联合类型**，freshness 事件不应加入此联合——见 Phase A4） |

**F254 新增原语：`seenCursor`**

`seenCursor` 是 per-(user,cat,thread) 的**独立**单调游标，追踪"猫在本轮 turn 中实际看过的最新消息"。与 `deliveryCursor` 语义不同、生命周期不同、互不影响：

| 维度 | `deliveryCursor` | `seenCursor`（F254 新增） |
|------|------------------|--------------------------|
| **追踪什么** | harness invoke 时 DELIVERED 到猫 context 的消息边界 | 猫在 turn 中实际 READ 过的消息边界 |
| **谁推进** | route-serial / route-parallel（路由层） | MCP 工具层（list_recent / get_thread_context / get_message / post_message 成功时） |
| **驱动什么** | 下次 invoke 的增量消息注入（fetchAfterCursor） | F254 freshness gate + content-free notice |
| **推错了的后果** | 下次 invoke 跳过消息（**不可接受**） | 漏一次 hold（fail-open，可接受） |
| **实现** | 复用 `DeliveryCursorStore` 基础设施，独立 key 前缀（如 `mentionAckCursor` 先例） | 同左 |
| **初始化** | invoke 时由路由层设置 | invoke 开始时从 delivery 边界拷贝（seed），mid-turn 由读工具推进 |

**关键教训（opus-48 源码核验 + BLOCKING review B1）**：

用 `getMessagesSince(invocation.createdAt)` （时间戳窗口）会**大量误 hold**——猫 turn 中途读了新消息再发，照样被 hold，因为那些消息的 timestamp > createdAt，跟"猫看没看过"无关。**正确的判据是独立 seen 游标**：`threadLatestMessageId > seenCursor[cat][thread]` = 有猫没看过的消息 → hold。

⚠️ **不能直接用 `deliveryCursor` 做 freshness 判据**（B1 blocker 根因）：`deliveryCursor` 驱动下次 invoke 的增量消息注入，MCP 层的 `list_recent` 等工具**不推也不应推** `deliveryCursor`（推了会导致下次 invoke 跳过消息）。必须用独立的 `seenCursor`——可复用 `DeliveryCursorStore` 的 Redis Lua CAS 基础设施 + 独立 key 前缀（`mentionAckCursor` 已是先例）。

## What

### 设计哲学

三个 surface，一个子系统——不是三个独立 feature：

```
Runtime Descriptor（Phase C）
  ↓ 参数化
  "这个 mode 能接受 held 返回吗？能收 content-free notice 吗？"
  ↓
Content-Free Notice（Phase B）          Freshness Gate（Phase A）
  "你有 N 条未读，自己选时机看"          "你要发消息，但有未读 → hold"
  ↓                                     ↓
  共用 seenCursor 边界（独立于 deliveryCursor，F254 新增）
  共用 freshness 事件流记录（独立于 F233 BallCustodyEventLog）
```

Phase A 先落地（价值最高 + 基础设施最成熟），Phase B 扩展通知面，Phase C 结构化运行模式能力。gate 行为本身是 runtime-invariant 的（MCP 工具层拦截 + seq 比较，不依赖 agent 感知通道），且现有 runtime 的 busyDelivery 行为同质，Descriptor 可在 Phase A/B 中硬编码，Phase C 再抽象为 (driver, mode) 矩阵。

---

## User Journey（🐾 猫猫旅程）

> operator说"有猫猫旅程，记得设计清楚"。以下从猫猫第一人称视角，描述每个 surface 的完整体验。

### 旅程 1: Freshness Gate（"我要发消息，但世界变了"）

```
场景：Ragdoll被 invoke，花了 8 分钟写了一段 review 回复。
期间Maine Coon在同一个 thread 里发了一条新消息。

① Ragdoll不知道Maine Coon发了消息（-p 模式，没有推送通道）
② Ragdoll写完了，调用 cat_cafe_post_message("我 review 完了，LGTM...")
③ MCP server 收到调用 →
   检查: seenCursor[opus][thisThread] < thread.latestMessageId ?
   → 是！Maine Coon的消息在游标之后 → 这是Ragdoll没看过的
   （排除自己发的消息：unseen 中全是自己的 → 不 hold）
④ MCP server 返回 held 信封（不执行发送）：

   ⚠️ 消息未发送（HELD）
   ━━━━━━━━━━━━━━━━━━━━━━━━━
   原因：你有 1 条未读消息（来自Maine Coon）
   
   [Maine Coon]: "等一下，我发现了一个 bug，这个 PR 先别合…"
   
   你的选择：
   1. 调 cat_cafe_list_recent 看完整内容，再决定怎么回
   2. 修改你的回复后重新调 post_message
   3. 调 post_message 时加 acknowledgeHeld: true 强制发送原文

⑤ Ragdoll看到 held → 去读Maine Coon的消息 → 发现自己的 LGTM 已经过时
⑥ Ragdoll改写回复："收到Maine Coon的 bug report，暂停 merge，先看 bug"
⑦ Ragdoll调 post_message（此时游标已更新，无新未读）→ 正常发送 ✅
```

**如果Ragdoll已经看过了呢？**

```
场景：Ragdoll turn 中途调了 list_recent，已经读过Maine Coon的消息。

① Ragdoll调 list_recent → 读到Maine Coon的消息 → seenCursor 推进到最新
② Ragdoll继续写回复，综合Maine Coon的信息
③ Ragdoll调 post_message →
   检查: seenCursor[opus][thisThread] < thread.latestMessageId ?
   → 否！seenCursor 已经追上 → Ragdoll看过了所有消息
④ 正常发送 ✅ （不误 hold）
```

**如果查不到可靠的 seen 边界呢？**

```
场景：新 thread 第一次 invoke，seenCursor 无记录。

① 检查 seenCursor → undefined（没有记录）
② Fail-open：放行，不 hold（宁漏 hold 不错 hold）
③ 正常发送 ✅
④ 发送成功时顺便初始化游标 = 当前 latestMessageId
```

### 旅程 2: Content-Free Notice（"有新消息但不打断你"）

```
场景：Ragdoll正在写一段复杂的代码重构。
operator在 thread 里发了一条消息。

① Ragdoll正在 Edit 文件（纯专注状态，没调副作用工具）
② Ragdoll接下来调了一个只读工具（比如 search_evidence）
③ MCP server 在返回值里附上 notice：

   📬 提醒：你有 1 条新消息（in 当前 thread）
   来自：operator
   内容未展示 — 在自然断点时调 list_recent 查看

④ Ragdoll看到提醒 → 判断当前改到一半不适合停 →
   继续完成 Edit → 跑测试 → 测试通过
⑤ Ragdoll在自然断点调 list_recent → 读到operator说"方向改了"
⑥ Ragdoll调整方案 → 发回复
```

**如果Ragdoll无视了 notice，直接跑完退出呢？**

```
场景：Ragdoll收到 notice 但选择继续干活，最终 hold_ball 退出。

① Ragdoll调 hold_ball →
   MCP server 检查：这个 turn 有 1 条未读 notice
② 返回 hold_ball 正常结果 + 附加提醒：

   ⚠️ 你这轮有 1 条未读消息未查看（来自operator）
   建议调 list_recent 先看看再退出。

③ Ragdoll看到提醒 → 决定先看 → 读消息 → 回复
   或
   Ragdoll判断当前任务优先 → 仍然 hold → 退出
   （但 notice 记录在案——harness 知道这只猫选择了延期）
```

**最狠的兜底：harness re-invoke（Phase B.c）**

```
场景：Ragdoll整个 turn 都没看 notice，直接退出了。

① Ragdoll invocation 结束（exit）
② Harness 检查：invocationRecord.unacknowledgedNoticeCount > 0
③ 触发新 invocation（限一次，防循环）：

   "你上一轮的 turn 中有来自operator的消息你没查看。
    请调 list_recent 查看并回应。"

④ 新 invocation 启动 → Ragdoll读消息 → 回复
```

### 旅程 3: Runtime Descriptor（系统视角 —— 猫猫不直接感知）

```
场景：系统决定怎么给不同模式的猫送 notice / 做 hold。

① Ragdoll被 invoke（-p headless mode）
② invoke-single-cat.ts 注入 CAT_CAFE_RUNTIME_MODE=headless-p
③ MCP server 查 descriptor：
   headless-p → {
     canReceiveHeldResponse: true,    // 能处理 held 返回
     canReceiveContentFreeNotice: true, // 能收 notice
     busyDeliveryMode: 'gated',       // 不能 mid-turn 注入内容
     backgroundBashReliable: false,   // background 通知可能丢
   }
④ 系统据此决定：
   - hold: 在 post_message 时做 seq 比较 → 返回 held 信封
   - notice: 在只读工具返回时附加 notice（不是 mid-turn 注入）
   - 不尝试 steer（不是 SDK session，不支持 mid-turn push）
```

---

### Phase A: Freshness Gate（副作用出口拦截 MVP）

**最高价值 + 基础设施最成熟 → 先做。**

#### A1: Held 信封（服务端）

在 callback routes 的副作用工具中加 freshness check：

1. 获取 `seenCursor[cat][thread]`（调 `SeenCursorStore.getCursor`——复用 `DeliveryCursorStore` 基础设施 + 独立 key 前缀）
2. 获取 `thread.latestMessageId`（调 `MessageStore` 或 thread metadata）
3. 比较：`latestMessageId > seenCursor` 且 unseen 消息不全是自己发的（**显式排除 `from === currentCatId` 的消息**，M1）
4. 如果有 unseen → 返回 held 信封（不执行副作用）
5. 如果无 unseen 或 cursor 不存在 → **fail-open, 放行**

Held 信封结构：
```typescript
interface HeldEnvelope {
  status: 'held';
  reason: 'newer_messages_available';
  unseenCount: number;
  // 最多 3 条摘要（DEFAULT_HELD_CONTEXT_LIMIT，学 Raft）
  previews: Array<{
    from: string;     // catId 或 'user'
    messageId: string;
    preview: string;  // 前 200 字符
  }>;
  omittedCount: number;  // 超过 3 条时的省略数
  actions: ['read_latest', 'revise', 'send_with_acknowledge'];
}
```

**覆盖的副作用工具**（按优先级）：

| 工具 | 优先级 | 理由 |
|------|--------|------|
| `post_message` | P0 | 最高频副作用，答非所问的主战场 |
| `cross_post_message` | P0 | 跨 thread 同理（**目标 thread** 的 seenCursor，不是源 thread；目标 thread 无 cursor 时 fail-open，M2） |
| `multi_mention` | P1 | 传球+内容，stale 传球危害大 |
| `publish_verdict` | P2 | 评审结论过期风险 |

#### A2: Held 客户端处理（MCP server）

在 `callback-tools.ts` 的 `_executePostMessage` 等函数中处理 `held` 返回：
- 检测 `data.status === 'held'` → 返回可读的提示文本给猫
- 提示包含：原因、新消息摘要、可选动作说明
- 猫读完 held 信封后可以：
  - 调 `list_recent` / `get_thread_context` 读新消息（自动推进游标）
  - 修改内容后重新调 `post_message`
  - 加 `acknowledgeHeld: true` 参数强制发送原文

#### A3: seenCursor 推进时机

> ⚠️ 以下全部是 **seenCursor**（F254 新增），**不是** deliveryCursor。deliveryCursor 由路由层管理，F254 不触碰。

| 动作 | seenCursor 推进 | 理由 |
|------|-----------------|------|
| **invoke 开始**（路由层） | ✅ 从 deliveryCursor 拷贝初始值 | seed：invoke 时 delivered 的消息 = 猫的初始 seen 边界（**net-new 工作项**） |
| `list_recent` / `get_thread_context` / `get_message` 读了消息 | ✅ 推进到读到的最新 | 猫看过了（**net-new**：MCP 工具层 `ackSeenCursor` 调用） |
| `post_message` 成功发送 | ✅ 推进到当前 latest | 发消息 = 隐含"我知道当前状态" |
| `post_message` 被 held | ❌ 不推进 | 猫还没看新消息 |
| `search_evidence` 等非 thread 只读工具 | ❌ 不推进 | 不代表猫看了 thread 消息 |

**回归防护**：推进 seenCursor **不得** 触碰 deliveryCursor / 增量注入逻辑（AC-A9 回归测试）。

#### A4: Freshness 事件流（独立于 F233 BallCustodyEventLog）

> ⚠️ `BallCustodyEvent` 是封闭联合类型（ball/task/invocation 生命周期事件），freshness decision **不应**加入此联合——语义不同类。
>
> **正确做法**：freshness 决策写入**独立的 append-only 事件流**（`FreshnessDecisionEventLog`），F233 projector 可选择性读取此流用于报告聚合。

每次 held / forward 决策记录为独立 freshness 事件：

```typescript
type FreshnessDecisionEvent = {
  kind: 'freshness_decision';
  threadId: string;
  catId: CatId;
  invocationId: string;
  decision: 'forward' | 'held';
  reason: string;  // 'no_unseen' | 'unseen_available' | 'cursor_missing_fail_open' | 'all_self_messages'
  unseenCount: number;
  toolName: string;  // 哪个工具触发的检查
  timestamp: number;
};
```

F233 的 `BallCustodyProjector` 可读取 freshness 事件流做统计聚合（哪些猫经常被 hold、hold 后选择 revise 还是 force-send），但 freshness 事件**不是** `BallCustodyEvent` 联合的成员。

### Phase B: Content-Free Inbox Notice + 防无视（三层重设计）

> **三层协同（ADR-031）**：Phase B 设计经过 opus + opus-47 + codex 独立讨论收敛（2026-06-28 Mode B）。核心变化：AC-A7 从"审计日志"升级为 B1/B2（工具层）和 B3/B4（harness 层）之间的**通信基础设施**——没有它，两层是断开的系统。
>
> 设计还分离了 **hot path（per-invocation Redis state）** 和 **cold path（append-only event log）**（opus-47 洞察）：每次 B3 判断不应 query 全 log。

#### B0: FreshnessAttentionEventLog + Per-Invocation Operational State（基础设施先行）

**Phase B 的第一步不是 B1——是基础设施。** operator的 push back 指出 B1+B2 做完但 B3+B4 无基础设施 = 断开的系统。

**(a) FreshnessAttentionEventLog**（cold path / audit / eval）：

独立 append-only 事件流（不是 F233 `BallCustodyEvent` 联合成员），封闭联合类型 + kind discriminator：

```typescript
// 共享 base
type FreshnessEventBase = {
  threadId: string;
  catId: CatId;
  invocationId: string;
  timestamp: number;
};

type FreshnessAttentionEvent = FreshnessEventBase & (
  | { kind: 'held_decision'; toolName: string; unseenCount: number; reason: string }
  | { kind: 'forward_decision'; toolName: string; reason: string }
  | { kind: 'notice_attached'; toolName: string; unseenSenders: string[]; noticeId: string; maxMessageId: string }
  | { kind: 'notice_implicit_acked'; noticeIds: string[]; ackedVia: 'seenCursor_advance' }
  | { kind: 'notice_deferred'; noticeIds: string[] }
  | { kind: 'reinvoke_triggered'; triggeredInvocationId: string; sourceNoticeIds: string[] }
  | { kind: 'reinvoke_skipped'; reason: 'quota_exhausted' | 'already_handled' | 'low_priority' | 'cursor_caught_up' | 'newer_invocation' }
);
```

F233 projector 可选读取此流做聚合报告（通过 `FreshnessAttentionEventLog.query({ invocationId })` 接口）。

**(b) Per-Invocation Operational State**（hot path / 决策）：

Redis-backed per-invocation counters（TTL = invocation timeout，如 30min，自动清理）：

```typescript
// key: `freshness:state:{invocationId}`
interface FreshnessInvocationState {
  toolCallCount: number;          // 本 invocation 工具调用计数
  noticeDeliveredCount: number;   // 已投递 notice 次数
  lastNoticeToolCallNum: number;  // 上次 notice 在第几次工具调用时投递
  ackedNoticeIds: string[];       // 已被 seenCursor 推进 ack 的 noticeId
  reinvokeTriggered: boolean;     // 是否已触发 re-invoke
}
```

**为什么拆两层**（opus-47 洞察）：事件流是冷路径（审计/eval/溯源），不应在每次 B3 判断时 query 全 log。操作状态是热路径（per-invocation counters），TTL 自动清理，不积累。

#### B1: 只读工具附加 notice（修订）

猫调只读 MCP 工具时，如果**当前 thread** 有未读消息（`latestMessageId > seenCursor`），在工具返回值尾部附加 content-free notice：

```
📬 提醒：你有 N 条未读消息（当前 thread）
来自：{senders}
调 list_recent 查看完整内容
```

**约束**：
- **Target-scoped**（告诉猫"谁发的"），**content-free**（不含消息内容）
- **频率限制**：每 N 次工具调用最多 1 次（N 初始值 = 5，可调参数 M4）+ **max-per-invocation cap = 3**（防 long invocation 噪声，opus-47 建议）
- **messageFilter 复用**（P0）：必须复用 Phase A 的 callback-tools messageFilter（visibility/play-mode/delete/briefing/undelivered），不能泄露 hidden 消息
- **Scope**：仅当前 thread（KD-10）。跨 thread notice 不在 Phase B scope 内
- **持久化**：每次 notice 投递写 `notice_attached` 事件到 FreshnessAttentionEventLog
- **时序**：只读工具执行完可能的 seenCursor ack 后再计算（`get_thread_context` 会推进 seenCursor，notice 检查在 ack 之后，避免"刚读过又 notice"，codex 洞察）

#### B2: Turn 结束 notice（hold_ball 提醒 + 延期记录，修订）

猫调 `hold_ball` 时，如果有 unresolved notices（投递过但未 ack）：

- 在 `hold_ball` 返回中附加提醒：`⚠️ 你这轮有 N 条未读消息未查看`
- **不阻塞 hold_ball**（OQ-1 已关闭：hold 被 hold 语义矛盾；与 F167 单槽持球语义不冲突，codex 洞察）
- 如果猫选择继续 hold（不先读消息）→ 记录 `notice_deferred` 事件

**`post_message` 不在 B2 scope**：Phase A 已经 gate 了 post_message；成功 post 后再附 notice 会语义打架（codex 洞察）。

#### B3: Harness re-invoke（防无视兜底，修订）

猫 invocation 结束后，harness（`invoke-single-cat.ts` 的 terminal event hook）检查是否需要 re-invoke：

**触发四件套**（全部满足才触发）：
1. `seenCursor < threadLatestMessageId`（seenCursor 是真相源，不是 counter，opus-47 洞察）
2. 有 unresolved **高优先级** notice（见下方定义）
3. 此 invocation 未触发过 re-invoke（`reinvokeTriggered === false`）
4. parent invocation chain 未触发过 re-invoke（防递归）

**高优先级 notice 定义**（v1，codex 建议，保守起步可扩展）：
- operator/人类消息
- 显式 @ 当前猫的消息
- 球权 / 任务责任变化

普通猫猫 chatter 只 notice（B1），不 re-invoke。高并发 thread 的尾递归式唤醒风险太大。

**Rate limit**：per (cat, thread) per hour 最多 N 次（N 初始值 = 3，eval 后调整）。

**Re-invoke prompt**：只含 sender 信息 + threadId + noticeId，不含消息内容。
```
你上一轮 turn 中有来自 {senders} 的 N 条未读消息，请调 list_recent 查看并回应。
```

**挂钩位置**：`invoke-single-cat.ts` 的 terminal invocation event 后统一决策（codex 建议：不在每个工具自己触发）。

#### B4: Skip re-invoke 客观判据（修订）

定义**可测试的客观 skip 判据**（不写"消息已被其他猫处理"这种不可测试语义，codex 洞察）：

1. `seenCursor` 已追上 `threadLatestMessageId`（另一个工具调用已推进）
2. 同 (cat, thread) 已有 newer invocation queued 或 running（`InvocationRegistry` 查询）
3. 球权已转移（`BallCustodyProjector` 查询——**dependency: F233**）
4. 所有 unseen 消息均为 self-message（Phase A 已有此排除）
5. per (cat, thread) per hour re-invoke quota exhausted

每次 skip 记录 `reinvoke_skipped` 事件（含 reason）到 FreshnessAttentionEventLog。

### Phase C: Runtime Capability Descriptor

#### C1: Descriptor 数据结构

```typescript
interface RuntimeCapabilityDescriptor {
  // 运行模式
  carrier: string;           // 'headless-p' | 'interactive' | 'bg-cron' | 'cloud' | 'connector'
  driver: string;            // 'claude' | 'codex' | 'gemini' | etc.
  
  // Freshness Gate 能力
  canReceiveHeldResponse: boolean;
  canReceiveContentFreeNotice: boolean;
  
  // 交互能力
  busyDeliveryMode: 'gated' | 'direct' | 'steer';  // -p=gated, SDK=steer
  canAskHumanSync: boolean;    // interactive only
  backgroundBashReliable: boolean;
  
  // 安全
  permissionMode: string;
}
```

**Descriptor 从 driver 定义派生**（`descriptorFromDriver(driver, mode)`），不手维护查表——P4 单一真相源。

#### C2: Descriptor 驱动 Phase A/B 行为

- `canReceiveHeldResponse = false` → freshness check 返回 warning 而非 held（不阻塞）
- `canReceiveContentFreeNotice = false` → 不在只读工具附加 notice
- `busyDeliveryMode = 'steer'` → 可以 mid-turn 注入 notice 内容（未来 SDK session 场景）

#### C3: 注入方式

在 `invoke-single-cat.ts` 的 `callbackEnv` 中加 `CAT_CAFE_RUNTIME_MODE`，MCP server 据此查 descriptor。

### Phase D: Stream Output Freshness Gate（猫的文本回复路径）

> **根因（operator 实测 2026-06-30）**：Phase A gate 只覆盖 `cat_cafe_post_message` MCP callback 路径。猫的普通文本回复（CLI stdout stream）走 `route-serial.ts` 的 `messageStore.append({ origin: 'stream' })` 直存路径，**完全没有 freshness check**。这是猫的**主要输出通道**（绝大多数回复走这里），Phase A gate 实际只保护了侧通道（显式 `post_message` 工具调用）。

**两猫独立验证闭合**（Ragdoll + Maine Coon 2026-06-30）：
- Maine Coon查 runtime transcript 确认测试轮次（invocation `d2748bf3`）的 tool_use 只有 `ToolSearch`，无 `cat_cafe_post_message`
- Ragdoll查 API 日志确认该轮无 `checkFreshnessForPostMessage` 调用记录
- operator质疑"你也调了 MCP"精确化：猫确实调了 MCP（ToolSearch），但 ToolSearch 是 Claude Code 内置工具，不走 Cat Café MCP 回调层，不触发 B1 notice 也不经过 A 的 freshness gate

**三层缺口叠加**：

| 层 | 机制 | 现状 | 影响 |
|----|------|------|------|
| Phase A | stream output freshness check | ❌ 不存在 | 文本回复直接存，不拦 |
| Phase B1 | 调 MCP 时附未读提醒 | ⚠️ 只覆盖 Cat Café MCP | ToolSearch/Bash/Read 等 harness 内置工具不触发 |
| Phase B3 | invocation 结束 re-invoke | ⚠️ cursor_caught_up | MCP read 工具推了 seenCursor，掩盖了未读 |

#### D1: Stream output freshness check

在 `route-serial.ts` 的 `messageStore.append({ origin: 'stream' })` 之前，加入 freshness check：

- 复用 seenCursor + threadLatestMessageId 比较逻辑（与 Phase A `checkFreshnessForPostMessage` 同源）
- stream output 已生成（不像 MCP callback 可以返回 held envelope），因此行为是：
  - **仍然存储**（fail-open，不丢失猫的工作产出）
  - 标记 `freshness: 'stale'` metadata（audit 可追溯）
  - **强制触发 re-invoke**（覆盖 B3 的 cursor_caught_up skip，因为此时已确认有 stream output + unseen messages 共存）
  - re-invoke prompt 告知猫"你的上轮回复可能基于过时信息"

#### D2: Non-Cat-Café MCP 工具的 notice 覆盖（stretch goal）

B1 notice 只覆盖 Cat Café MCP server 的 read-only 工具。ToolSearch / Bash / Read / Edit 等 Claude Code 内置工具不经过 Cat Café 回调层。
- 这些工具占猫 mid-turn 调用的大多数（尤其写代码时）
- 覆盖方式需研究：hook 层 / agent router 层 / 独立 freshness polling

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC trace 回 Why（猫发消息时不知道世界变了 → 拦住让猫知道）-->

### Phase A（Freshness Gate MVP）

- [x] AC-A1: 猫调 `post_message` 时，如果 thread 有猫未看过的消息（`latestMessageId > seenCursor`），返回 held 信封而非执行发送——**用独立 seenCursor seq 游标判断，不用 timestamp，不用 deliveryCursor**
- [x] AC-A2: 猫 turn 中途通过 `list_recent` / `get_thread_context` 读过新消息后，seenCursor 推进，再调 `post_message` 不被 hold（**零误 hold 验证**）
- [x] AC-A3: `seenCursor` 不存在时 fail-open 放行（不因缺数据卡死副作用）
- [x] AC-A4: held 信封最多展示 3 条摘要 + omittedCount（防 context 膨胀）
- [x] AC-A5: 猫加 `acknowledgeHeld: true` 可强制发送（escape hatch）
- [x] AC-A6: `cross_post_message` 和 `multi_mention` 同样受 freshness gate 保护（cross_post 检查**目标 thread** 的 seenCursor；目标 thread 无 cursor 时 fail-open）。`callbacks.ts` 传 `isCrossThread ? 'cross_post_message' : 'post_message'` toolName；`callback-multi-mention-routes.ts` 加 freshness gate（含 play-mode visibility filter）+ fail-open + `deliveryCursorStore` DI
- [x] AC-A7: 每次 held/forward 决策记录为**独立 freshness 事件流**（不是 F233 `BallCustodyEvent` 联合成员；F233 projector 可选读取此流做聚合报告）。`checkFreshnessForPostMessage` 新增 optional `eventLog` param，6 条决策路径写 `held_decision`/`forward_decision` 事件，fail-open；route 层（post_message + multi_mention）接入 FreshnessAttentionEventLog。15 新测试
- [x] AC-A8: Redis-backed 测试覆盖游标读写 + held 决策（不用纯 in-memory 假绿）
- [x] AC-A9: **seenCursor 隔离回归**：推进 seenCursor **不得**影响 deliveryCursor 或 `fetchAfterCursor` 增量注入逻辑（回归测试：push seenCursor → 验证 deliveryCursor 不变 → 验证下次 invoke 增量注入不跳消息）

### Phase B（Content-Free Notice + 防无视，三层重设计）

- [x] AC-B0: FreshnessAttentionEventLog（封闭联合类型 + kind discriminator，独立于 F233）+ Redis per-invocation operational state（TTL = invocation timeout）+ F233 projector 可选读取接口
- [x] AC-B1: 猫调只读工具时，如果当前 thread 有未读消息，返回值附加 content-free notice。频率限制：每 5 次工具调用最多 1 次 + max-per-invocation cap=3。messageFilter 复用 Phase A（P0）。scope = 当前 thread only。notice 持久化到事件流。时序：seenCursor ack 后再检查
- [x] AC-B2: 猫调 hold_ball 时，如果有 unresolved notices，返回值附加提醒。不阻塞 hold_ball。选择延期退出时记录 `notice_deferred` 事件
- [x] AC-B3: 猫 invocation 结束时，seenCursor < threadLatestMessageId AND 有 unresolved 高优先级 notice → 触发一次 re-invoke。高优先级 = 人类消息 / 显式 @ / 球权变化。Rate limit: per (cat, thread) per hour cap=3。挂钩 invoke-single-cat terminal event。**merged**: PR #2650 — routing wiring（`route-serial` 消费 `metadata.freshnessReinvoke` + 队列 invocation + cursor-based notice filter + score-aware seenCursorCaughtUp）
- [x] AC-B4: Skip re-invoke 客观判据（5 项可测试条件）：seenCursor 已追上 / newer invocation queued / 球权转移(F233 dep) / self-message only / quota exhausted。每个 skip 记录 `reinvoke_skipped` 事件。**merged**: PR #2650 — `reinvoke_triggered` + `reinvoke_skipped` 事件写入 FreshnessAttentionEventLog（fail-open）
- [x] AC-B5: Eval 指标：notice→ack 转化率（seenCursor 同 invocation 内推进）、notice→defer 率、re-invoke 触发率+有效性（re-invoke 后有回复？）、误唤醒率、token 成本。**merged**: PR #2668 — 7 OTel counters (gate_held/forward, notice_attached/acked/deferred, reinvoke_triggered/skipped) with per-notice granularity alignment. Token cost + reinvoke effectiveness correlation deferred to Phase C eval adapter.
- [x] AC-B6: Privacy/visibility invariant：notice content-free、messageFilter 复用 Phase A、unseen sender list 尊重 visibility rules
- [x] AC-B7: L0 soft layer：staging 加 1-2 行 notice 处理行为约定（不开新 skill，eval 后再定）。`l0-staging-content.md` 新增 `freshness-notice-handling` item（~35 tokens）：自然断点响应未读

### Phase C（Runtime Descriptor）

> **Entry gate:** Phase C 不应吞掉 Phase B.c。默认顺序是先补 AC-B3/B4 routing wiring（dispatch/queue 领域）让 Phase B 真闭环，再开 Phase C descriptor。只有 operator 明确重排优先级时，才允许先做 C。

- [x] AC-C1: Descriptor 从 driver 定义派生（`descriptorFromDriver`），不手维护查表
- [x] AC-C2: `CAT_CAFE_RUNTIME_MODE` 环境变量注入到 callbackEnv + Redis per-invocation carrierTier persistence
- [x] AC-C3: Phase A/B 的 held/notice 行为由 descriptor 参数化（`canReceiveHeldResponse` / `canReceiveContentFreeNotice`）+ `applyDescriptorOverride` held→forward + `descriptorFromProviderFallback` for non-Claude providers

### Phase D（Stream Output Freshness Gate）

- [ ] AC-D1: `route-serial` 的 stream text output 存储路径（`messageStore.append({ origin: 'stream' })`）在存储前检查 freshness（seenCursor vs threadLatestMessageId），发现 unseen 消息时标记 `freshness: 'stale'` metadata 并强制触发 re-invoke（无视 B3/B4 的 cursor_caught_up skip）
- [ ] AC-D2: re-invoke prompt 明确告知猫"你的上轮回复可能未反映最新消息，请查看并回应"
- [ ] AC-D3: stale 标记的 stream output 仍然正常存储和投递（fail-open，不丢失工作产出）
- [ ] AC-D4: stream output freshness check 记录 `stream_stale_detected` / `stream_fresh` 事件到 FreshnessAttentionEventLog
- [ ] AC-D5: 猫的 stream output 是自回复（thread 中最新消息是自己发的）→ 不标 stale（self-message 排除，与 Phase A 一致）

## Dependencies

- **Evolved from**: F233（Ball Custody Observability）— 事件流**架构模式**的地基（append-only log + projector）。F254 的 freshness 事件是**独立事件流**（不是 `BallCustodyEvent` 联合成员），F233 projector 可选读取做聚合报告
- **Related**: F167（A2A Chain Quality）— 上游传球质量；F254 是"传球那一刻的 freshness 检查"
- **Related**: F069（Thread Read State）— ThreadReadStateStore 可复用
- **Related**: F193（Message Routing）— post_message 路由守卫

## Risk

| 风险 | 缓解 |
|------|------|
| 误 hold 导致猫猫体验退化（被频繁拦截） | seq 游标（不是 timestamp）+ fail-open + `acknowledgeHeld` escape hatch + 显式排除自己发的消息 |
| held 信封撑爆 context（大量未读时） | DEFAULT_HELD_CONTEXT_LIMIT=3 + omittedCount |
| seenCursor 性能（每次副作用工具多一次 Redis 查询） | 复用 DeliveryCursorStore 基础设施（已有内存缓存层），独立 key 前缀，单 key GET |
| **seenCursor 误推 deliveryCursor 导致消息跳过**（B1 blocker 根因） | seenCursor 独立 key 前缀，AC-A9 回归测试；代码 review 重点检查项 |
| re-invoke 循环（notice → re-invoke → 又有 notice → 再 re-invoke） | 每 invocation 最多 1 次 re-invoke，parentInvocationId 去重 |
| 跨 thread cross_post_message 的 freshness 判据不清 | 检查**目标 thread** 的 seenCursor（猫要发到的地方），不是源 thread；目标 thread 无 cursor 时 fail-open |
| **排队中消息对 gate 不可见**（2026-06-29 实测发现，**已修复** PR #2664） | ~~F117 设计冲突~~ → 已通过 `QueuedMessageChecker` interface 解决：gate 在 delivered-message check 无结果或全 self-message 时 fallback 查 `InvocationQueue.list()`，三条 freshness 路径全部 wired。合成 `maxMessageId` 用 `generateSortableId(Date.now())` 确保 notice 可 resolve |
| **operator消息 vs 猫消息优先级未区分** | 当前 gate 对所有 unseen 消息一视同仁；B3 re-invoke 已区分高优先级（人类消息 > 猫 chatter，KD-9），但 gate 本身没有。operator消息（"算了不做了"）的时效性高于猫间 chatter，可能需要 gate 层也引入优先级——例如operator消息即使 queued 也 hold，猫消息只 notice |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | **用独立 seenCursor（不是 deliveryCursor，不是 timestamp 窗口）** | timestamp 会误 hold（猫看过的消息仍然 > createdAt）；deliveryCursor 驱动增量注入不可混用（B1 blocker）；独立 seenCursor 复用同一基础设施 + 独立 key 前缀（mentionAckCursor 先例），精准区分"看过/没看过"（opus-48 源码核验 Raft `modelSeenSeq` 机制） | 2026-06-27 |
| KD-2 | **Fail-open（cursor 不可信时放行不 hold）** | 宁漏 hold 不错 hold——错 hold 卡死副作用比偶尔漏 hold 严重得多（Raft `inboxTrustState` 同策略） | 2026-06-27 |
| KD-3 | **三个 surface 合一个 feature，不是三个独立 feature** | 它们共享 seen 边界（seenCursor）+ 共享 freshness 事件流 + descriptor 参数化 notice/hold 行为；独立拆会导致三套基础设施 | 2026-06-27 |
| KD-4 | **Phase A 先做（不是 Descriptor 先做）** | gate 行为本身 runtime-invariant（MCP 工具层拦截 + seq 比较，不依赖 agent 感知通道），现有 runtime 的 busyDelivery 行为同质，Descriptor 可在 Phase A/B 中硬编码；价值最高的 held draft 不应等 descriptor 就绪。48 建议 descriptor 先行的理由（异构 runtime 参数化）在我们有多模式时再生效 | 2026-06-27 |
| KD-5 | **Raft 有 prompt 级防无视（L2334/L2641），不是"什么都没有"** | 修正 seed 的事实错误。我们的优势是 harness 级（re-invoke）不是"他们没有我们造"。避免过度造轮子 | 2026-06-27 |
| KD-6 | **Phase B 基础设施先行（B0 → B1 → B2 → B3/B4）** | AC-A7 事件流是 B1/B2（工具层）和 B3/B4（harness 层）的通信通道，不是审计日志。没有它两层断开（opus/opus-47/codex 三猫共识） | 2026-06-28 |
| KD-7 | **操作状态(hot) 和事件流(cold) 分层** | 事件流 query 全 log 太重用于 hot path 决策；per-invocation Redis counters + TTL = hot path（opus-47 洞察） | 2026-06-28 |
| KD-8 | **ack = implicit（seenCursor 推进）** | Phase A 已走 implicit 路线，对齐；显式 ack 增加猫认知负担（KISS）；事件流记录 `notice_implicit_acked` 便于 audit（opus-47 + codex 共识） | 2026-06-28 |
| KD-9 | **Re-invoke 只对高优先级 notice 触发** | 人类消息/显式@/球权变化才 re-invoke；普通猫 chatter 只 notice 不 re-invoke（codex 建议，防高并发 thread 尾递归式唤醒；保守起步可扩展） | 2026-06-28 |
| KD-10 | **Phase B scope = 当前 thread only** | 跨 thread notice 膨胀 scope，延后处理（opus-47 建议） | 2026-06-28 |

## Eval / Tracking Contract

### Primary Users + Activation Signal
- **Primary users**: 所有猫猫（通过 MCP 工具发消息时自动触发）
- **Activation signal**: 猫调副作用 MCP 工具 + thread 有 unseen 消息 → held 信封

### Friction Metric
- **误 hold 率**：猫已看过消息但仍被 hold 的比例（目标：趋近 0%——独立 seenCursor 应消除大部分此类，但跨 thread cursor 初始化等边缘场景可能残留极少数）
- **acknowledgeHeld 使用率**：猫选择强制发送的比例（高 = held 信息不够有用，或 hold 太频繁）
- **re-invoke 触发率**：Phase B.c 自动 re-invoke 的频率（高 = 猫经常无视 notice，notice 设计需改进）

### Regression Fixture
1. 猫 invoke 后 thread 有新消息 → 猫调 post_message → 收到 held（不是正常发送）
2. 猫 invoke 后 thread 有新消息 → 猫先 list_recent 读了 → 再 post_message → 正常发送（seenCursor 已推进，不 hold）
3. 新 thread 首次 invoke，无 seenCursor → post_message → 正常发送（fail-open）
4. held 信封 preview 不超过 3 条（context cap）
5. **seenCursor 隔离**：推进 seenCursor → 验证 deliveryCursor 值不变 → 验证下次 invoke 增量注入不跳消息（AC-A9）
6. unseen 消息全部是自己发的 → 不 hold（self-message 排除）
7. **stream output 路径**：operator发消息 → 猫 invocation 启动 → operator又发一条 → 猫 stream 输出文本 → 检测到 unseen → 标记 stale + 触发 re-invoke（不只靠 B3 cursor 判断）
8. stream output 路径：所有 unseen 消息是自己发的 → 不标 stale（self-message 排除）

### Sunset Signal
- 如果 3 个月内 held 决策事件中 `decision: 'held'` 占比 < 1%（几乎没有 stale 场景发生），说明这个 feature 的价值不大，考虑简化或移除
- 如果 `acknowledgeHeld` 使用率持续 > 50%（猫总是强制发送），说明 hold 机制打扰大于帮助，需要重新审视判据

## 需求点 Checklist

| # | 需求 | Phase | AC | 测试 | 状态 |
|---|------|-------|-----|------|------|
| R1 | seq 游标 freshness check | A | AC-A1 | Redis-backed | ✅ |
| R2 | 零误 hold（看过不 hold） | A | AC-A2 | 游标推进验证 | ✅ |
| R3 | fail-open | A | AC-A3 | null cursor 测试 | ✅ |
| R4 | held context cap=3 | A | AC-A4 | 多消息场景 | ✅ |
| R5 | acknowledgeHeld escape | A | AC-A5 | force send 测试 | ✅ |
| R6 | cross_post 覆盖 | A | AC-A6 | 跨 thread + multi_mention 测试 | ✅ |
| R7 | FreshnessAttentionEventLog（独立事件流） | B | AC-B0 | 封闭联合 + kind discriminator + projector 接口 | ✅ |
| R8 | content-free notice | B | AC-B1 | 只读工具附加 + 频率限制 + messageFilter 复用 | ✅ |
| R9 | turn-end notice | B | AC-B2 | hold_ball 附加 + defer 记录 | ✅ |
| R10 | re-invoke 兜底 | B | AC-B3/B4 | 高优先级触发 + 客观 skip 判据 + audit events | ✅ |
| R14 | per-invocation operational state | B | AC-B0 | Redis-backed counters + TTL | ✅ |
| R15 | eval 指标 | B | AC-B5 | 转化率/defer率/触发率/成本 | ✅ |
| R16 | privacy/visibility invariant | B | AC-B6 | content-free + messageFilter | ✅ |
| R17 | L0 soft layer | B | AC-B7 | staging 1-2 行 | ✅ |
| R11 | descriptor 派生 | C | AC-C1 | 派生一致性 | ✅ |
| R12 | runtime mode 注入 | C | AC-C2 | env 验证 | ✅ |
| R13 | seenCursor 隔离回归 | A | AC-A9 | push seen ≠ push delivery | ✅ |
| R18 | stream output freshness check | D | AC-D1 | stream 存储前 freshness 验证 | ⬜ |
| R19 | stale output re-invoke | D | AC-D2 | 强制 re-invoke 绕过 cursor_caught_up | ⬜ |
| R20 | stale audit trail | D | AC-D4 | 事件流记录 | ⬜ |

## Review Gate

- Phase A: 跨族 review（优先 @gpt52，性价比；Maine Coon太贵留安全/跨族/连续性场景）
- Phase B: 跨族 review
- Phase C: 猫猫讨论（`collaborative-thinking`）→ 跨族 review
- Phase D: 跨族 review（@gpt52 优先）
