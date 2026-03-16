---
feature_ids: []
topics: [conversation, mutability, invocation]
doc_kind: decision
created: 2026-02-26
---

# ADR-008: 对话可变性与调用生命周期

> 日期: 2026-02-09
> 状态: **草案 — 待Maine Coon review + 铲屎官拍板**
> 参与者: Ragdoll (Opus) + Maine Coon (Codex) + 铲屎官
> 背景: 铲屎官要求类似 Google AI Studio 的删除/编辑能力；重复消息 + ENOENT 问题

---

## 问题

铲屎官提出三个互相关联的诉求：

1. **消息可删可编辑** — 否则"会出现可怕的事情"（误发消息、敏感内容无法删除）
2. **删改不能破坏 resume/cursor** — 删了消息后，增量上下文投递不能乱
3. **重复消息 + ENOENT** — `spawn claude ENOENT` 后消息重复叠加

现有系统的三个结构性缺陷：

| 缺陷 | 现状 | 后果 |
|------|------|------|
| 无幂等性 | POST /api/messages 没有去重机制 | 网络重试或用户重发 → 重复消息 |
| 无执行状态 | 消息写入 + 猫调用在同一 background async 中 | 调用失败时无法单独重试执行 |
| 消息不可变是全局假设 | cursor 单调递增依赖消息 ID 链不变 | 一旦允许删除，cursor 可能指向"空洞" |

---

## 决策概览

五个子决策形成一个完整的设计：

```
  InvocationRecord (D1)          IdempotencyKey (D2)
  ┌──────────────────┐          ┌──────────────────┐
  │ queued → running  │◄─────────│ 防重复写入        │
  │ → succeeded/failed│          │ (threadId,userId) │
  │ → canceled        │          └──────────────────┘
  └────────┬─────────┘
           │ succeeded 才推进 cursor
           ▼
  ┌──────────────────┐          ┌──────────────────┐
  │ Soft/Hard Delete  │          │ Edit → Branch     │
  │ (D3)              │          │ (D4)              │
  │ tombstone 保护    │          │ 新 thread 从编辑点 │
  │ cursor 不断裂     │          │ fork，原 thread    │
  └──────────────────┘          │ 不可变             │
                                └──────────────────┘
           │
           ▼ (Level 2, 后续)
  ┌──────────────────┐
  │ gitRef 消息元数据  │
  │ (D5)              │
  └──────────────────┘
```

---

## D1: InvocationRecord — 轻量调用状态机

### 决策

引入 `InvocationRecord`，将"消息写入"与"猫调用执行"解耦。

### 状态定义

```typescript
type InvocationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

interface InvocationRecord {
  id: string;                    // 唯一 ID
  threadId: string;
  userId: string;
  userMessageId: string | null;   // 关联的用户消息 ID（null = 消息尚未写入，需补偿）
  targetCats: CatId[];           // 路由目标
  intent: 'execute' | 'ideate';  // 执行意图
  status: InvocationStatus;
  idempotencyKey: string;         // 幂等 key（客户端提供或后端自动生成，始终有值）
  error?: string;                // failed 时的错误信息
  createdAt: number;
  updatedAt: number;
}
```

### 新的消息处理流程

**当前流程**（问题根源）：
```
POST /api/messages
  → reply 202
  → background:
      → 写入用户消息 + 调用猫 (耦合在一起)
      → 失败 = 无法单独重试
```

**新流程**：
```
POST /api/messages
  ① Lua 原子操作: 幂等占位 + InvocationRecord 创建（见 D2 详述）
     → 已存在: 返回 { status: 'duplicate', invocationId }
     → 新建成功: 返回 { status: 'created', invocationId }
     → (此时 Record 已存在，status='queued', userMessageId=null)
  ② 写入用户消息 (messageStore.append)
  ③ 回填 InvocationRecord.userMessageId = storedMessage.id
  ④ reply 202 { invocationId }
  ⑤ background:
      → InvocationRecord.status = 'running'
      → 执行猫调用 (routeSerial/routeParallel)
      → 成功: InvocationRecord.status = 'succeeded', ackCursor()
      → 失败: InvocationRecord.status = 'failed', error = ...
      → 取消: InvocationRecord.status = 'canceled'
```

**关键设计：① 是单个 Lua 脚本的原子操作**。

幂等 key 占位和 InvocationRecord 创建在同一个 Redis EVAL 中完成，不存在"key 在但 Record 不在"的窗口。彻底消除 stale key 问题和并发误判。

可能的失败场景与补偿：

| 失败点 | 状态 | 补偿 |
|--------|------|------|
| ① 之后、② 之前 | Record 存在 (queued)，无消息 | retry 端点: 补写消息 → 回填 → 执行 |
| ② 之后、③ 之前 | Record 存在，消息存在，但 Record.userMessageId=null | retry 端点: 根据 idempotencyKey 查找消息 → 回填 → 执行 |
| ③ 之后、⑤ 之前 | Record + 消息都完整 | retry 端点: 直接执行 |

`userMessageId: null` 是 InvocationRecord 的"未完成"标记。重试端点检测到此状态时，先补完消息写入再执行猫调用。

**注意**：① 失败（Lua 脚本执行出错）= 什么都没创建，请求直接返回 500。无需补偿——原子性保证要么全部成功要么全部不做。

关键变化：
- 用户消息写入和猫调用执行彻底解耦
- 重试只需重新执行 ⑤，不会重复写入用户消息
- cursor 只在 `succeeded` 时推进，`failed`/`canceled` 不推进

### 重试端点

```
POST /api/invocations/:id/retry
  → 检查 InvocationRecord 存在
  → 允许重试条件: status == 'failed' OR status == 'queued'
  → 拒绝重试: status == 'running' | 'succeeded' | 'canceled'
  → 补偿: 若 userMessageId == null，先补写用户消息并回填
  → 更新 status = 'queued' (若已是 queued 则不变)
  → 执行猫调用
```

**为什么 `queued` 整体可重试（不细分 `userMessageId`）**：`queued` 的语义是"还没开始运行"。无论 `userMessageId` 是否有值，重试都是安全的——endpoint 内部根据 `userMessageId` 是否为 null 决定是否需要先补写消息。三种 `queued` 崩溃态全部覆盖：

| 崩溃点 | userMessageId | retry 行为 |
|--------|---------------|-----------|
| ②~③ 之间 | null | 补写消息 → 回填 → 执行 |
| ③~④ 之间 | null（消息已写但未回填）| 根据 internalIdempotencyKey 查找消息 → 回填 → 执行 |
| ⑤~⑥ 之间 | 有值 | 直接执行 |

### 与现有 InvocationTracker 的关系

`InvocationTracker`（per-thread abort + delete guard）保持不变。`InvocationRecord` 是**新增的持久化层**，记录调用的完整生命周期。两者协作：

- `InvocationTracker.start()` 返回 `AbortController`（运行时控制）
- `InvocationRecord` 记录状态变迁（持久化审计）
- `InvocationTracker.cancel()` → `InvocationRecord.status = 'canceled'`

### 存储

- Redis: `cat-cafe:invocation:{id}` Hash，TTL 7 天
- 内存 fallback: bounded Map，MAX 500

### Why

1. **语义干净** — 每个调用有明确的生命周期状态，不存在"消息写了但调用状态不明"的灰区
2. **统一底座** — 后续的 Edit→Branch、软硬删除、cursor 推进都可以引用 InvocationRecord 状态
3. **不上线所以一步到位** — 铲屎官明确"这是我们自己的项目"，优先长期正确

### Tradeoff

- 改动面包括：POST /api/messages 路由、AgentRouter.route()、route-strategies.ts 的 cursor 推进逻辑
- 新增存储：InvocationRecordStore（Redis + 内存双实现）
- 新增端点：GET/POST /api/invocations
- 回归测试范围：消息发送全链路 + cursor 增量投递

---

## D2: IdempotencyKey — 消息去重

### 决策

POST /api/messages 支持可选的 `idempotencyKey` 字段。

### 设计

```
Redis key: cat-cafe:idemp:{threadId}:{userId}:{clientKey}
Value: invocationId (D1 的 InvocationRecord ID)
TTL: 300 秒 (5 分钟)
```

### 行为（Lua 原子语义）

1. 前端每次发送消息时生成 UUID 作为 `idempotencyKey`
2. 后端生成 `invocationId`，执行 **单个 Lua 脚本** 完成以下操作：

```lua
-- KEYS[1] = cat-cafe:idemp:{threadId}:{userId}:{clientKey}
-- KEYS[2] = cat-cafe:invocation:{invocationId}
-- ARGV = invocationId, threadId, userId, targetCats, intent, idempotencyKey, now
local existing = redis.call('GET', KEYS[1])
if existing then
  return {'duplicate', existing}
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', 300)
redis.call('HSET', KEYS[2],
  'id', ARGV[1], 'threadId', ARGV[2], 'userId', ARGV[3],
  'targetCats', ARGV[4], 'intent', ARGV[5],
  'idempotencyKey', ARGV[6], 'status', 'queued',
  'userMessageId', '', 'createdAt', ARGV[7], 'updatedAt', ARGV[7])
redis.call('EXPIRE', KEYS[2], 604800)  -- 7 天 TTL
return {'created', ARGV[1]}
```

3. Lua 返回 `{'duplicate', existingId}` → 返回 `{ status: 'duplicate', invocationId }`
4. Lua 返回 `{'created', newId}` → 正常流程（Record 已创建，进入 ② 写消息）

**为什么用 Lua 而不是 SET NX + 后续 HSET**：两步操作之间存在并发窗口——"key 在但 Record 还没创建完"会被其他请求误判为 stale key 并 DEL，导致重复创建。Lua 脚本在 Redis 内原子执行，要么 key+Record 同时存在，要么都不存在，消除所有中间态。

**内存 fallback（无 Redis 时）**：在内存实现中，用同步 Map 操作（单线程 Node.js 不存在并发问题），等效于原子语义。

### Schema 变化

```typescript
// messages.schema.ts 变更
const sendMessageSchema = z.object({
  content: z.string().min(1).max(10000),  // 与现有 messages.schema.ts 一致
  userId: z.string().min(1).max(100).default('default-user'),
  threadId: z.string().min(1).max(100).optional(),
  idempotencyKey: z.string().uuid().optional(),  // 新增
});
```

### 作用域: `(threadId, userId, key)`

理由：
- 整个数据模型是 thread-scoped，幂等 key 应保持一致
- 不同 thread 中的相同 key 不冲突（理论上不可能，UUID 碰撞概率极低，但语义上正确）
- 与现有 Redis key pattern（`cat-cafe:msg:thread:{threadId}`）一致

### 向后兼容 + 内部强制保证

- **对外**：`idempotencyKey` 是可选字段（向后兼容旧客户端）
- **对内**：服务端在路由层保证每次请求都有幂等键。客户端未传时，**后端自动生成 UUID 作为 `internalIdempotencyKey`** 并写入 InvocationRecord
- 补偿路径始终可用：无论客户端是否传 key，③→④ 的"根据 key 查找已写消息"路径都能走通
- 区别：客户端传的 key 防**网络重试**（同一 key 命中去重），后端生成的 key 只防**崩溃补偿**（retry 时用于回填关联）

### Why

- 防止网络重试、用户快速双击导致重复消息
- 实现成本极低（一个 Redis GET/SET）
- 与 D1 InvocationRecord 天然整合

---

## D3: 软删除 / 硬删除 — Tombstone 模型

### 决策

消息级删除分两种语义，使用 tombstone 模型保护 cursor 连续性。

### 软删除（默认）

```typescript
// StoredMessage 新增字段
interface StoredMessage {
  // ... 现有字段 ...
  deletedAt?: number;     // 软删除时间戳（存在即为"已删除"）
  deletedBy?: string;     // 删除者 userId
}
```

行为：
- 设置 `deletedAt` + `deletedBy`，内容保留
- 前端过滤：`deletedAt` 存在时不渲染内容，显示"此消息已删除"占位
- 可撤销：清除 `deletedAt` 即恢复
- cursor 无需任何变动 — 消息 ID 仍然存在于时间线中

### 硬删除（危险操作）

行为：
- 清空 `content`、`contentBlocks`、`metadata`、`mentions`
- 保留 tombstone 骨架：`{ id, threadId, deletedAt, deletedBy, _tombstone: true }`
- **不可撤销** — 内容永久消失
- cursor 无需变动 — tombstone 保留了 ID 在时间线中的位置

二次确认：
- 前端弹窗：输入对话标题确认
- API 请求需携带 `confirmTitle` 字段，后端校验与实际标题匹配

### Tombstone 对 cursor 的影响

```
消息时间线: [msg-A] [msg-B(tombstone)] [msg-C] [msg-D]
                     ↑ cursor 指向 B

getByThreadAfter(cursor='B') → 返回 [C, D]  ← 正确！tombstone 的 ID 仍有效
```

- `getByThreadAfter()` 照常工作 — 它比较的是 ID 字典序，tombstone 的 ID 没变
- `getByThread()` / `getByThreadBefore()` 返回时跳过 `_tombstone: true` 和 `deletedAt` 的记录
- **无需迁移任何现有 cursor**

### API 端点

```
DELETE /api/messages/:id
  body: { mode: 'soft' | 'hard', confirmTitle?: string }

  soft: 设置 deletedAt/deletedBy
  hard: 校验 confirmTitle → 清空内容 → 保留 tombstone

PATCH /api/messages/:id/restore
  清除 deletedAt/deletedBy（仅软删除可用）
```

### 批量删除

暂不实现。单条删除覆盖 90% 需求。如需清理整段对话，已有 thread 级联删除。

### Why

1. Tombstone 保护 cursor 单调性 — 不需要任何 cursor 迁移逻辑
2. 软删可撤销满足"手滑"场景
3. 硬删满足"敏感内容必须消失"场景
4. 二次确认防误操作

### Tradeoff

1. 软删增加 `StoredMessage` 两个字段 — 影响极小
2. 硬删的 tombstone 是永久数据（直到 thread 级联删除或 TTL 过期）— 可接受
3. 读取路径需要过滤已删除消息 — 已有 `userId` 过滤逻辑，加一个 `deletedAt` 判断几乎无成本

---

## D4: Edit → Branch — 编辑即分支

### 决策

编辑消息 = 从该消息创建新对话分支。**不做原地编辑。**

### 语义

```
原 Thread #abc:
  [user] msg-1: "你好"
  [opus] msg-2: "你好！有什么可以帮你？"
  [user] msg-3: "帮我写个登录页"    ← 用户想编辑这条
  [opus] msg-4: "好的，已创建..."

用户编辑 msg-3 → "帮我写个注册页"

结果:
  原 Thread #abc: 保持不变（msg-1~4 都在）

  新 Thread #abc-branch-1:
    [user] msg-B1: "你好"           ← 复制自 msg-1
    [opus] msg-B2: "你好！有什么..." ← 复制自 msg-2
    [user] msg-B3: "帮我写个注册页"  ← 编辑后的新消息（最新一条）
```

### API

```
POST /api/threads/:id/branch
  body: {
    fromMessageId: string;      // 分支起点（包含此消息之前的所有消息）
    editedContent?: string;     // 如果是编辑触发，提供编辑后的内容
  }

  response: {
    threadId: string;           // 新 thread ID
    messageCount: number;       // 复制的消息数
  }
```

### 流程

1. 获取 `fromMessageId` 之前（含）的所有消息
2. 创建新 thread：`title = "{原标题} (分支)"`，`participants` 复制自原 thread
3. 按顺序复制消息到新 thread（生成新 ID，保留原始 content/catId/metadata）
4. 如果有 `editedContent`：最后一条消息用编辑后的内容替换
5. 新 thread 的 cursor 从零开始（无 cursor = 下次调用发送全部历史）
6. 前端跳转到新 thread

### UX 强制提示

**必须弹窗确认**：
> "编辑将从此消息创建一个新的对话分支。原对话保留不变。是否继续？"

不允许静默创建分支。理由：
- 其他聊天产品都是原地编辑，用户有强烈惯性预期
- 分支创建有副作用（新 thread、新 cursor）
- 不提示会导致"我怎么到了新对话？"的困惑

### 原 thread 处理

原 thread 完全不变。不标记"已分支"，不在 UI 上显示分支关系（MVP 阶段）。

后续可增强：
- 分支树可视化（thread 之间的 parent/child 关系）
- 原消息上显示"已从此处创建分支"标记

### Why

1. **保护 cursor 一致性** — 原 thread 消息序列不变，cursor 不受影响
2. **保护多 agent 上下文** — 猫的 session 绑定原 thread，不会因编辑而"穿越"
3. **可审计** — 原始对话完整保留，分支是独立的新记录

### Tradeoff

1. 不如原地编辑直觉 — 需要用户理解"分支"概念
2. 消息复制增加存储 — 可接受（Redis 7 天 TTL 自然清理）
3. 分支后的新 thread 没有 cat session resume — 是 feature（从干净状态开始）

---

## D5: gitRef 消息元数据 — 代码状态绑定（Level 2）

### 决策

在 `MessageMetadata` 中增加 `gitRef` 字段，记录消息关联的 git commit。

```typescript
interface MessageMetadata {
  provider: string;
  model: string;
  sessionId?: string;
  gitRef?: string;       // 新增: git commit SHA
}
```

### 时机

仅在检测到 git commit 时填充。不是每条消息都有 `gitRef`。

### 与 Branch 的协作

当用户从某条消息 Branch 时，如果该消息（或其之前最近的消息）有 `gitRef`，前端可提示：
> "是否同时切换到该消息对应的代码状态？（git checkout {gitRef}）"

### 优先级

**Level 2 — 暂缓实施**。

理由：
1. 需要 `git worktree` 支持，增加系统复杂度
2. 需要 worktree 生命周期管理（清理、并发、磁盘空间）
3. D1~D4 已经有很大用户价值，gitRef 是锦上添花

### 预留设计

- `MessageMetadata.gitRef` 字段可以现在加上类型定义（开销为零）
- 实际写入逻辑延后

## 否决理由（P0.5 回填）

- **备选方案 A**：原地编辑消息（不分支）
  - 不选原因：会破坏 cursor 单调假设与多猫 session 一致性，重放和审计链条会断裂（对应 D3/D4 约束）。
- **备选方案 B**：只加幂等键去重，不引入 InvocationRecord
  - 不选原因：只能缓解重复消息，无法表达调用生命周期、失败补偿与可重试边界（对应 D1/D2 设计目标）。
- **备选方案 C**：优先做强一致删除，再讨论 Tombstone
  - 不选原因：跨 Store 强一致改造成本高且收益不匹配当前阶段，违背“先交付可用”的分期策略（对应 D3 Tradeoff）。
- **备选方案 D**：本轮同时落地 gitRef + worktree 自动切换
  - 不选原因：属于 Level 2 能力，需额外治理复杂度，不应与 D1-D4 MVP 范围混做（对应 D5 优先级）。

**不做边界**：本轮仅做 why 回填索引，不变更 ADR-008 既有实施阶段、端点和代码方案。

---

## 实施阶段

| 阶段 | 内容 | 改动范围 | 预计测试增量 |
|------|------|----------|-------------|
| S1 | InvocationRecord + InvocationRecordStore | 新增 Store + 改 messages.ts 路由 + 改 AgentRouter.route() | ~20 tests |
| S2 | IdempotencyKey | 改 sendMessageSchema + messages.ts 路由 | ~8 tests |
| S3 | cursor 推进绑定 InvocationRecord.succeeded | 改 route-strategies.ts | ~10 tests |
| S4 | 重试端点 POST /api/invocations/:id/retry | 新增路由 | ~8 tests |
| S5 | 软删除 (deletedAt/deletedBy) | 改 StoredMessage + MessageStore + RedisMessageStore + 新端点 | ~15 tests |
| S6 | 硬删除 (tombstone) | 改 delete 端点 + 确认逻辑 | ~8 tests |
| S7 | Edit → Branch | 新增 branch 端点 + 消息复制逻辑 | ~12 tests |
| S8 | 前端：删除/编辑/重试 UI | web 组件改动 | ~5 tests |
| -- | gitRef (Level 2, 暂缓) | MessageMetadata 字段 + 写入逻辑 | 后续 |

总计：~86 tests（567 → ~653）

S1~S4 是基础设施层，S5~S7 是功能层，S8 是前端层。可以按顺序推进。

---

## 对现有系统的影响

### StoredMessage 变更

```typescript
interface StoredMessage {
  id: string;
  threadId: string;
  userId: string;
  catId: CatId | null;
  content: string;
  contentBlocks?: readonly MessageContent[];
  metadata?: MessageMetadata;
  mentions: readonly CatId[];
  timestamp: number;
  // ---- 新增 ----
  deletedAt?: number;        // 软删除时间戳
  deletedBy?: string;        // 删除者
  _tombstone?: true;         // 硬删除标记
}
```

### IMessageStore 接口变更

```typescript
interface IMessageStore {
  // ... 现有方法不变 ...

  // ---- 新增 ----
  softDelete(id: string, deletedBy: string): StoredMessage | Promise<StoredMessage>;
  hardDelete(id: string, deletedBy: string): StoredMessage | Promise<StoredMessage>;
  restore(id: string): StoredMessage | Promise<StoredMessage>;
  getById(id: string): StoredMessage | null | Promise<StoredMessage | null>;
}
```

### 读取路径过滤

所有 `getByThread*` 和 `getRecent` 方法默认跳过 `deletedAt` 和 `_tombstone` 消息。新增 `includeDeleted?: boolean` 选项供管理/审计使用。

### WebSocket 事件新增

```typescript
// 前端需要处理的新事件
type SocketEvent =
  | { type: 'message_deleted'; messageId: string; mode: 'soft' | 'hard' }
  | { type: 'message_restored'; messageId: string }
  | { type: 'invocation_status'; invocationId: string; status: InvocationStatus }
  | { type: 'thread_branched'; sourceThreadId: string; newThreadId: string };
```

---

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| S1 改 messages.ts 引入新 bug | 中 | 高 | 现有 567 tests 回归 + S1 新增 ~20 tests |
| InvocationRecord 存储增加 Redis 内存 | 低 | 低 | 7 天 TTL 自动清理 |
| 软删消息被猫的 session resume 拉回 | 中 | 中 | session resume 时也过滤 deletedAt |
| Branch 复制大量消息影响性能 | 低 | 低 | 限制单次复制上限 200 条 |
| 硬删后 EventAuditLog 仍有原始内容摘要 | 低 | 中 | 审计日志不存原文，只存 prompt-digest hash |

---

## 附录：与 ADR-007 (Cascade Delete) 的关系

ADR-007 定义的 thread 级联删除保持不变。新增的消息级删除（D3）是更细粒度的操作：

- **Thread 删除** = 物理删除所有消息（现有行为，不变）
- **消息软删** = 标记隐藏，可恢复
- **消息硬删** = 内容清空，tombstone 保留

两者不冲突。Thread 删除时，tombstone 也一并物理删除。

---

*起草: Ragdoll 🐾 (2026-02-09)*
*讨论基础: Maine Coon开放邀请 + 铲屎官裁决*
*待: Maine Coon review → 铲屎官拍板 → 开始实施*
