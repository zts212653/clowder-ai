---
feature_ids: [F108]
related_features: [F086, F039, F048, F052]
topics: [runtime, invocation, concurrency, orchestration]
doc_kind: spec
created: 2026-03-12
---

# F108: Side-Dispatch — 同一 Thread 多猫并发执行

> **Status**: spec | **Owner**: TBD | **Priority**: P1

## Why

team lead作为 CVO，需要在**任何时刻**向**任何猫**派活，且**不打断**正在工作的猫。

当前架构的限制：InvocationTracker 对每个 thread 持有单一执行锁——当Ragdoll在 thread 里修 bug 时，team lead无法同时派Maine Coon在同一 thread 里做架构反思。只能开新 thread（信息孤岛）或等当前猫完成（阻塞 CVO）。

team experience（2026-03-12）：

> "赶紧开 worktree 修了他 记住只有Ragdoll去修这个问题！@opus"
> "@gpt52 你Maine Coon反思你为什么给Ragdoll过了？你回答我这个不要碰代码"

> "这样的情况我会需要一直和不同的你们交流 甚至我可能就是给Maine Coon一直发悄悄话避免影响你的修复。我会想要 1. 让你修复问题 2. 并发让Maine Coon反思为什么他做的不好 然后如何从架构上改进"

**核心诉求**：同一 feat、同一 thread，team lead并发派不同的猫干相关但不同的事——一边修 bug 一边反思，互不干扰，结果都在同一 thread 可见。

## What

### 核心概念：ExecutionSlot

引入 `ExecutionSlot(threadId, catId)` 作为并发执行的基本单元。这不是新增第三套并发路径，而是**统一收编现有两套并发模型**（InvocationTracker 单锁 + F086 MultiMentionOrchestrator 独立 AbortController）。

### Phase A: 运行时并发基座（Slot-Aware Runtime）

**核心改动**：所有 thread 级单活跃假设改为 slot 级。

1. **ExecutionSlot 模型**：一个 thread 可以有多个并发 slot，每个 slot = `(threadId, catId)`
   - 同一 catId 在同一 thread 仍禁止并发（保留串行语义）
   - Phase A 只允许 **单目标 side-dispatch**（不做多目标原子占用）
2. **InvocationTracker → SlotTracker**：`start(threadId)` → `start(threadId, catId)`；cancel/abort 改为 slot 级
3. **WorklistRegistry 改绑**：从 `threadId` 改为 `parentInvocationId`，防止 A2A callback 在并发 invocation 间串台
4. **QueueProcessor slot-aware**：`processingThreads` / `pausedThreads` / `onInvocationComplete` 改为 slot 粒度
5. **AgentMessage 补 invocationId**：WebSocket 事件补 `invocationId` 维度，前端可安全区分多 invocation
6. **F086 MultiMention 收编**：独立 AbortController 统一到 SlotTracker，不再维护两套并发模型
7. **消息可见性**：旁路执行的消息在同一 thread 可见（所有参与者看到完整对话）
8. **安全硬约束**：
   - Phase A **不承诺**两只会写代码的猫在同一 workspace 并发改文件
   - Phase A 的目标用例：一只猫写代码 + 另一只猫做只读任务（反思/review/调研）

### Phase B: 双模发送 UX（team lead 2026-03-12 定义）

#### 模式 A：悄悄话（Whisper） — 锁头按钮

交互流：
1. team lead点击输入框旁的锁头按钮 → 进入悄悄话模式
2. 出现猫选择器（正在执行的猫灰掉不可选）
3. 选择目标猫 → 输入消息 → 发送
4. 目标猫开始旁路执行（不打断当前执行猫）
5. 当前执行猫看不到这条消息（whisper 可见性）

#### 模式 B：广播（默认） — 不点锁头直接发

交互流：
1. team lead直接在输入框打字 → 发送
2. 消息对所有猫可见（广播）
3. 当前正在执行的猫不被打断，下一次拉起 CLI 时收到这条广播
4. 如果消息里 @ 了特定猫，那只猫开始旁路执行

#### 执行状态 & 控制

5. **Thread 执行状态面板**：显示当前 thread 有哪些猫在活跃执行
6. **Per-cat Stop**：每只执行中的猫有独立 Stop 按钮
7. **Slot-aware 输入框**：输入框感知当前 slot 状态，提示哪些猫在执行

#### 技术实现

8. **前端状态模型重构**：`hasActiveInvocation` / `intentMode` / `targetCats` 从 thread 单值改为 `activeInvocations[threadId]` Map，derived state
9. **Stop 语义**：UI 面向 cat/slot 发 stop，后端 cancel 最小单元 = 当前 active invocation + 其挂载的 parentInvocation worklist（不遗留 worklist 继续回流）
10. **Whisper Mode**：复用现有 `visibility='whisper' + whisperTo` 消息可见性模型，不另发明 transport

#### UX 线框图

→ `designs/f108-side-dispatch-ux.pen`（三场景：默认/悄悄话输入、猫选择器、并发执行状态）

## Acceptance Criteria

### Phase A（运行时并发基座）
- [ ] AC-A1: 同一 thread 中，两只不同的猫可以有并发 invocation，互不 abort
- [ ] AC-A2: 旁路 invocation 的消息在 thread 中对所有参与者可见
- [ ] AC-A3: 同一 catId 在同一 thread 仍保持单锁语义（不能自己和自己并发）
- [ ] AC-A4: InvocationRecord runtime consumers（recovery/retry/queue）改为 slot-aware（存储结构本身已支持多条并发，无需 schema 迁移）
- [ ] AC-A5: 现有 multi_mention 等编排工具继续正常工作（向后兼容）
- [ ] AC-A6: WorklistRegistry 按 parentInvocationId 绑定，A2A callback 不串台
- [ ] AC-A7: QueueProcessor slot-aware，一个 slot 完成不误推另一个 slot 的队列
- [ ] AC-A8: AgentMessage 携带 invocationId，前端可区分多 invocation 事件
- [ ] AC-A9: F086 MultiMention 的独立 AbortController 收编到统一 SlotTracker

### Phase B（双模发送 UX）
- [ ] AC-B1: 锁头 → 猫选择器 → whisper 发送，完整悄悄话流程可用
- [ ] AC-B2: 猫选择器中正在执行的猫灰掉不可选
- [ ] AC-B3: 广播消息不打断执行中的猫，下次 CLI 拉起时收到
- [ ] AC-B4: @ 特定猫的消息触发旁路执行（side-dispatch）
- [ ] AC-B5: 执行状态面板显示所有活跃猫 + 当前任务
- [ ] AC-B6: per-cat Stop 按钮精确停止目标猫的执行
- [ ] AC-B7: Slot-aware 输入框感知 slot 状态

## Dependencies

- **Evolved from**: F086（多猫并行编排——F086 解决了猫发起的并行，F108 解决team lead发起的并行）
- **Related**: F039（消息排队——需要适配多槽模型）
- **Related**: F048（Restart Recovery——InvocationRecord 存储结构已支持多条并发，但 recovery/retry/queue 等 runtime consumers 需改为 slot-aware）
- **Related**: F052（跨线程身份隔离——同 thread 多 cat 的身份隔离复用）

## Risk

| 风险 | 缓解 | 证据（Maine Coon安全评审 2026-03-12） |
|------|------|------|
| A2A WorklistRegistry 串台 | worklist 绑定从 `threadId` 改为 `parentInvocationId` | `WorklistRegistry.ts:37-55,84-125`; `callback-a2a-trigger.ts:64-66` |
| InvocationTracker thread 级 cancel 误杀并发 invocation | 改为 slot 级 cancel | `InvocationTracker.ts:29-47,70-100`; `messages.ts:214-218,297-319` |
| QueueProcessor 误推队列 | `onInvocationComplete` 改为 slot-aware | `QueueProcessor.ts:61-66,88-109,145-195` |
| 前端 `done(isFinal)` 清零整 thread | `activeInvocations` Map + derived state | `chatStore.ts:214-219,677-682,978-1037`; `useSocket.ts:268-296` |
| 两只猫并发改同一文件 | Phase A 硬约束：不承诺双写，只允许一写一读 | team lead用例（修 bug + 反思）天然一写一读 |
| F086 MultiMention 独立并发路径未收编 | 统一到 SlotTracker | `callback-multi-mention-routes.ts:135-170`; `MultiMentionOrchestrator.ts:212-257` |
| 向后兼容 | Phase A AC-A5/A9 强制兼容测试 | 5 处单活跃假设已全部定位 |

## Design Gate Checklist（替代 Open Questions）

> Maine Coon(GPT-5.4) 安全评审 2026-03-12 提出：必须在 Design Gate 前把这些写死。

| # | 检查项 | 状态 | 决议 |
|---|--------|------|------|
| DG-1 | ExecutionSlot 模型定义 | ✅ 已定 | `ExecutionSlot(threadId, catId)`，同 cat 同 thread 禁止并发 |
| DG-2 | WorklistRegistry 绑定主键 | ✅ 已定 | 从 `threadId` 改为 `parentInvocationId` |
| DG-3 | 前端 `activeInvocations` 状态结构 | ✅ 已定 | `Map<threadId, Map<invocationId, SlotState>>`，derived `hasActiveInvocation` |
| DG-4 | Stop 语义 | ✅ 已定 | UI 面向 cat/slot 发 stop；后端 cancel 最小单元 = active invocation + 其挂载的 parentInvocation worklist |
| DG-5 | F086 MultiMention 收编策略 | ⬜ 待定 | 统一到 SlotTracker（方向确定，实现方案待 writing-plans） |
| DG-6 | Phase A 写冲突安全约束 | ✅ 已定 | 不承诺双写，Phase A = 一写一读 |
| DG-7 | Queue scopeKey 设计 | ⬜ 待定 | Tracker slot: `threadId:catId`；Queue ownership: `threadId:userId:slotCatId`（待验证） |
| DG-8 | AgentMessage invocationId 维度 | ✅ 已定 | 顶层补 `invocationId` 字段 |
| DG-9 | 旁路执行的 system prompt 感知 | ⬜ 待定 | 待 Phase A 实现时确认是否需要 |
| DG-10 | 前端消息渲染——交错还是分栏 | ⬜ 待定 | Phase B UX，team lead确认 |
| DG-11 | Phase B 双模发送 UX | ✅ 已定 | 锁头悄悄话 + 广播模式，线框图 `designs/f108-side-dispatch-ux.pen` |

## 单活跃假设全景图（Maine Coon排查结果）

> 以下 5 处是现有代码中"一个 thread 只有一个活跃 invocation"的硬编码假设，Phase A 必须全部改为 slot-aware：

| # | 位置 | 假设 | 影响 |
|---|------|------|------|
| SA-1 | `InvocationTracker.ts:29-100` | `start(threadId)` abort 同 thread 所有 | side-dispatch 会误杀主执行 |
| SA-2 | `WorklistRegistry.ts:37-125` | `threadId -> worklist` 单键 | A2A callback 串台 |
| SA-3 | `QueueProcessor.ts:61-239` | `processingThreads` / `onInvocationComplete(threadId)` | slot 完成误推队列 |
| SA-4 | `messages.ts:214-576` + `invocations.ts:114-244` + `ConnectorInvokeTrigger.ts:96-445` + `SocketManager.ts:92-108` | thread 级 cancel/start/complete | 新消息/retry/connector 全是 thread 粒度 |
| SA-5 | `chatStore.ts:214-1198` + `useSocket.ts:268-296` + `useAgentMessages.ts:119-370` + `ChatInputActionButton.tsx:79-155` | `hasActiveInvocation` / `intentMode` / `targetCats` thread 单值 | 前端 `done(isFinal)` 清零整 thread |

## 现成基座（可复用，不需要重写）

| 组件 | 为什么可复用 | 证据 |
|------|-------------|------|
| `InvocationRegistry` | 已经是 `thread+cat -> latest invocation` 粒度的 stale guard | `InvocationRegistry.ts:47-48,88-89,123-131` |
| `InvocationRecord` | per-invocation 记录，结构上支持多条并发 | `InvocationRecordStore.ts:21-38,109-143` |
| `DraftStore` | 用 `invocationId` 做主键，天然支持并发流式草稿 | `DraftStore.ts:7-10,15-19,57-63` |
| `whisper` 可见性 | 已有 `visibility='whisper' + whisperTo` + 防泄漏过滤 | `messages.ts:204-209`; `route-helpers.ts:262-283` |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 引入 `ExecutionSlot(threadId, catId)` 概念，同 cat 同 thread 禁止并发 | 保留串行语义，避免自己和自己竞争；比"per-thread-per-cat 多槽"更精确 | 2026-03-12 |
| KD-2 | WorklistRegistry 从 `threadId` 改为 `parentInvocationId` 绑定 | 防止 A2A callback 在并发 invocation 间串台（Maine Coon安全评审） | 2026-03-12 |
| KD-3 | F086 MultiMention 独立 AbortController 统一收编到 SlotTracker | 不维护两套并发模型，终态统一 | 2026-03-12 |
| KD-4 | Phase A 不承诺两只写代码的猫同 workspace 并发改文件 | Phase A 目标用例是一写一读（修 bug + 反思），不在安全基座未就绪时开放双写 | 2026-03-12 |
| KD-5 | Whisper Mode 复用现有 `visibility='whisper' + whisperTo`，不新建 transport | 已有防泄漏过滤机制，复用比重造安全 | 2026-03-12 |
| KD-6 | Phase B 双模发送 UX：锁头悄悄话 + 广播默认 | team lead 2026-03-12 亲自定义的交互流 | 2026-03-12 |

## Review Gate

- Phase A: 跨家族 review（架构级改动），Maine Coon review 运行时安全性

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "让你修复问题，并发让Maine Coon反思" — 同一 thread 同时派两只猫干不同的事 | AC-A1 | integration test: 两猫并发 invocation 互不 abort | [ ] |
| R2 | "给Maine Coon一直发悄悄话避免影响你的修复" — 旁路消息不中断主执行 | AC-A2, AC-B1 | test: 主执行猫不被 abort | [ ] |
| R3 | 相关但不同的任务在同一 feat/thread 里，结果都可见 | AC-A2 | test: 旁路消息在 thread 中可见 | [ ] |
| R4 | 涉及 A2A 并发调整，安全性需要强评估 | AC-A5, AC-A6 | 向后兼容测试 + A2A 不串台测试 | [ ] |
| R5 | 不能在安全基座未就绪时让两只猫同时写代码 | KD-4 | Phase A 约束：一写一读 | [ ] |
| R6 | 锁头悄悄话 + 广播双模发送 | AC-B1~B7 | UX 线框图已确认 | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（Phase B 适用）

## team lead用例示例

```
场景：Ragdoll修 bug 中，team lead同时想让Maine Coon反思架构

当前（F108 之前）：
  team lead → @opus 修这个 bug
  team lead → @gpt52 你反思一下为什么过了
  ❌ @gpt52 的消息 abort 了 @opus 正在进行的修复
  ❌ 或者team lead被迫开新 thread，结果分散在两个地方

期望（F108 之后）：
  team lead → @opus 修这个 bug       → Ragdoll在主执行流修 bug
  team lead → 🔒 悄悄话 @gpt52       → Maine Coon在旁路执行流反思（不打断Ragdoll）
  ✅ 两只猫并发执行，消息都在同一 thread
  ✅ team lead可以随时和任一只猫交流
  ✅ 每只猫有独立 Stop 按钮
```
