---
feature_ids: [F122]
related_features: [F108, F117, F027]
topics: [a2a, queue, dispatch, steer, multi_mention, architecture]
doc_kind: spec
created: 2026-03-14
---

# F122: 执行通道统一 — A2A/multi_mention 入 Dispatch Queue

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1 | **Completed**: 2026-03-18

## Why

team experience（2026-03-14 19:25）：

> "你们在 a2a 按道理我发的消息进 channel 然后我点 steer 才能强制推送 现在整个系统乱七八糟的"
> "原本的行为是就算你们在 a2a 我看到的也是这个界面！现在是你们 a2a 我看到的是另一个我可以发消息的界面！"

**核心问题**：当前系统有三套执行分发平面并存，语义不统一：

1. **用户/connector 消息**走 `InvocationQueue`（有 queue/steer 语义）
2. **callback A2A**（post_message + targetCats/@mention）走 `WorklistRegistry` 自动推进，不受 steer 管控
3. **multi_mention** 有自己的 dispatch 系统（`MultiMentionOrchestrator`），热修前连 `InvocationTracker` 都没接

team lead期望的行为很简单：**猫猫在忙（不管怎么忙起来的），我发的消息就排队，只有我点 steer 才能强推。** 这要求所有执行路径都接入统一的 active/queue 状态语义。

## 现状分析（基于代码审查 2026-03-14）

### 五条消息入口的真实行为

| # | 入口 | 走 InvocationQueue? | steer 管得到? | 代码位置 |
|---|------|---------------------|---------------|----------|
| ① | 用户/前端 POST `/api/messages` | ✅ smart-default queue | ✅ | `messages.ts:306-307` |
| ② | Connector（飞书/GitHub/iMessage） | ⚠️ 条件入队（同 cat slot 活跃才 queue） | ✅（入队后受 steer 管） | `ConnectorInvokeTrigger.ts:106-112` |
| ③ | 猫 post_message A2A（worklist） | ❌ 直接 pushToWorklist | ❌ | `callback-a2a-trigger.ts:67-116` |
| ④ | 猫 multi_mention | ❌ 直接 dispatchToTarget | ❌ | `callback-multi-mention-routes.ts:138-184` |
| ⑤ | Steer（用户手动） | — | 它就是控制入口 | `queue.ts:199-225` |

### 热修后已解决的问题（不在 F122 scope 内）

- `parentInvocationId` 链路断裂 → A2A worklist key 不匹配 → targets 掉裂缝（commit `a95e02ef`）
- multi_mention 没接 InvocationTracker → 前端不锁输入 → 用户消息 immediate 打断 A2A（commit `1d2b2ce6`）
- QueueProcessor queued execution 不发 `intent_mode`（commit `1d2b2ce6`）
- 前端乐观 bubble 与 server queued 回包不对齐（commit `1d2b2ce6`）

### 仍存在的问题

#### P1: 执行平面分裂

callback A2A（③）和 multi_mention（④）虽然热修后接了 InvocationTracker，但执行本身不走 InvocationQueue，steer 管不到。

**用户视角的影响**：猫猫 A2A 自动接力时，你只能看着等，不能 steer 插队。如果你要的是"猫猫之间 handoff 也能被我 steer 管到"，当前做不到。

#### P1: pushToWorklist 返回空时无结构化 reason

`hasWorklist=true && pushToWorklist=[]` 时只有一行日志（`callback-a2a-trigger.ts:107-114`），没有区分是 depth limit / duplicate / caller 不匹配 / key 找不到，排查困难。

#### P2: multi_mention 没传 parentInvocationId

`dispatchToTarget` 调用 `routeExecution` 时只传了 `{ signal }`，没有 `parentInvocationId`（`callback-multi-mention-routes.ts:163`）。如果 multi_mention 目标猫在回复中 @mention 发起猫，A2A push 可能进错 worklist。

#### P1: multi_mention target 崩溃导致 caller slot 不释放

**现象**（team lead 2026-03-14 22:54 截图）：Maine Coon干完活用 multi_mention @ opencode，opencode 上下文超限崩溃（`prompt token count of 158302 exceeds the limit of 128000`），但Maine Coon的 InvocationTracker slot 没有释放 → 系统一直显示"猫猫正在回复中"→ team lead发的消息只能排队，除非手动 steer 强推。

**根因推测**：`callback-multi-mention-routes.ts` 的 `dispatchToTarget` 在 target 执行失败时，caller 的 tracker slot 没有正确 complete。热修加的 `tracker.start()` / `tracker.complete()` 只管 target 自己的 slot，但 caller（Maine Coon）的 slot 可能在等 multi_mention 完成才释放——target 崩了就永远等。

**用户视角的影响**：猫 @ 了一个挂掉的猫后，team lead被锁死在排队状态，只能手动 steer。

#### P2: QueuePanel 不显示 processing 状态

QueuePanel 只显示 `status='queued'` 的条目（`QueuePanel.tsx:142`），条目进入 processing 后从面板消失，体感像"没进队列直接跑了"。

### 可靠的部分（不需要改）

- **用户消息** → smart-default queue ✅
- **Connector 消息** → `ConnectorInvokeTrigger.enqueueWhileActive()` ⚠️ slot 级条件入队（`invocationTracker.has(threadId, catId)` 才 queue，否则直接 `executeInBackground`）
- **Worklist 内部串行 A2A** → route-serial 的 while 循环 + depth limit ✅
- **Anti-cascade guard** → multi_mention 不能互相回环（`callback-multi-mention-routes.ts:331-336`）✅
- **Slot-aware InvocationTracker** → 不同猫在同一 thread 不互相 abort（`InvocationTracker.ts:50-54`）✅

## What

### team lead期望的行为

1. **猫猫在忙时（不论原因），我发的消息必须排队** — 已实现 ✅
2. **只有 steer 才能强推** — 对用户/connector 消息已实现 ✅；A2A/multi_mention 是否也需要被 steer 管控待决策（见 OQ-1）
3. **前端必须正确显示"忙/排队"状态** — 热修后基本 OK，QueuePanel processing 可见性待改善
4. **Connector 来的消息和用户消息一样可靠** — ⚠️ 部分实现：同 cat slot 活跃时走 queue ✅，但判忙是 slot 级（`has(threadId, catId)`）而非 thread 级，与"猫猫在忙就排队"的全局语义可能不一致（见 OQ-4）

### Phase A: 可靠性加固（最小闭环）

**不改架构，只补漏洞和可观测性。**

1. **multi_mention parentInvocationId 透传**
   - `dispatchToTarget` 的 `routeExecution` 调用补传 `parentInvocationId: createResult.invocationId`
   - 防止 A2A @mention 回路进错 worklist

2. **pushToWorklist 结构化 reason**
   - 返回值从 `CatId[]` 扩展为 `{ added: CatId[], reason?: 'depth_limit' | 'duplicate' | 'caller_mismatch' | 'not_found' }`
   - `enqueueA2ATargets` 基于 reason 决定是否降级 fallback
   - `reason: 'not_found'` 时降级到 standalone invocation（防御性）

3. **QueuePanel 显示 processing 态**
   - QueuePanel filter 从 `status === 'queued'` 改为 `status === 'queued' || status === 'processing'`
   - processing 条目显示为"正在处理中"（灰色/动画区分）

### Phase B: 语义收敛（待讨论，见 OQ-1）

**如果产品确认 A2A handoff 也要受 steer 管控**：

1. callback targetCats 改为产出 queue entry（`source: 'agent'`），不直接 pushToWorklist
2. multi_mention 改为产出 queue entry，不直接 dispatchToTarget
3. QueueProcessor 统一处理 user / connector / agent 三种 source
4. steer 可以管控所有 queue entry（含 agent-sourced）

**如果产品确认 A2A 是自动接力、用户只管自己的消息**：

1. Phase A 就是终态
2. UI 明确区分"猫猫自动接力中"和"有排队消息"两种状态
3. steer 只管用户/connector 消息，A2A 继续走 worklist

## Acceptance Criteria

### Phase A（可靠性加固）✅
- [x] AC-A1: multi_mention 的 routeExecution 传递 parentInvocationId
- [x] AC-A2: pushToWorklist 返回结构化 reason，不再只返回空数组
- [x] AC-A3: reason='not_found' 时降级到 standalone invocation
- [x] AC-A4: QueuePanel 显示 processing 态条目
- [x] AC-A5: 回归测试覆盖：A2A 期间用户发消息 → 必须 queued；steer → 必须 immediate
- [x] AC-A6: 回归测试覆盖：connector 消息在 active slot 下 → 必须 queued；steer → 必须 immediate
- [x] AC-A7: multi_mention target 崩溃/超时时，caller 的 InvocationTracker slot 必须正确释放，不能锁死team lead

### Phase A.1（TOCTOU 竞态修复）✅
> team lead 2026-03-15 反馈：用户消息能打断 A2A 链。三猫（opus+codex+gpt52）独立排查确认为 P1 竞态。
> 必须先修，否则 OQ-1/2/4 的产品讨论基础不稳。

**根因 1（P1）：`messages.ts` TOCTOU**
`messages.ts:306` 先 `has(threadId)` 判忙，`messages.ts:434` 才 `start()` 占槽。中间跨 `invocationRecordStore.create()` 等异步步骤。窗口期若 A2A 已占槽，用户消息仍走 immediate 路径，且 `start()` 的 preempt 会 `abort('preempted')` 打断 A2A。

**根因 2（P1）：`multi_mention` 启动窗口**
`callback-multi-mention-routes.ts` 先 create invocation record（line 113），后 `tracker.start()`（line 139）。窗口期 `messages.ts` 看到 `has()=false` → immediate → 并发穿透。

**修复方案（三猫对齐）：**
1. `InvocationTracker` 新增 `tryStartThread(threadId, catId, ...)` — thread 级 busy gate + slot 级占位，一个同步操作。thread 内任一猫活跃 → 返回 null（不 preempt）。
2. `messages.ts` 所有非 force 的 immediate 路径改用 `tryStartThread()`，返回 null → 降级 queue。`tryStartThread()` 在 `create()` 之前调用。force/steer 不变（仍用 `start()`）。
3. `multi_mention` 占位前移：`start()` 在 `create invocation record` 之前，全路径包在 outer try/finally。
4. duplicate 路径：`tryStartThread()` 成功但 `create()` 返回 duplicate → 必须 `complete()` 回收占位。

- [x] AC-A8: `messages.ts` 非 force immediate 路径使用 `tryStartThread`，TOCTOU 窗口穿透时降级 queue
- [x] AC-A9: `multi_mention` 占位前移到 create 之前，全路径 outer try/finally 保证释放
- [x] AC-A10: 回归测试：`has()=false` 后 thread 变 busy → 用户消息必须 queued
- [x] AC-A11: 回归测试：`tryStartThread` 成功但 create 返回 duplicate → slot 必释放
- [x] AC-A12: 回归测试：multi_mention create/update 抛错 → slot 必释放

### Phase B（语义收敛 — 后端核心）✅
> OQ-1/2/4 已由team lead拍板（ADR-018），Phase B 后端核心已合入。

**已完成（PR #499 merged）：**
- [x] AC-B1: QueueEntry 支持 `source: 'agent'` + `autoExecute` + `callerCatId`
- [x] AC-B2: QueueProcessor `tryAutoExecute` — agent 条目入队后目标猫 slot 空闲时立即执行
- [x] AC-B3: A2A callback (`enqueueA2ATargets`) 通过 InvocationQueue 产出 agent entry（替代 pushToWorklist）
- [x] AC-B4: steer 可以管控 agent-sourced queue entries（promote + immediate 均验证通过）
- [x] AC-B5: `invocationQueue` dep 注入到 callback routes → 生产环境激活 F122B 路径

**Phase B.1 follow-up（全部完成）：**
- [x] AC-B6: multi_mention dispatch 改走 InvocationQueue（MultiMentionOrchestrator 的 response 聚合需要 QueueProcessor 回调机制，PR #536 merged `646d6aa4`）
- [x] AC-B6-P1: **A2A 消息上下文可见性修复**（PR #502 merged）— 详见下方「已知问题」
- [x] AC-B7: QueuePanel 前端渲染 agent-sourced entries（PR #504 merged）— 设计稿 `designs/F122-queue-panel-agent-entries.pen`
- [x] AC-B8: Thread 执行状态指示（PR #508 merged）— ThreadExecutionBar per-cat 活跃状态 + 经过时间
  - ✅ 打磨完成：猫名使用 `useCatData()`+`formatCatName()` 动态中文显示，颜色从 cat-config 动态读取（`feat/f122-remaining` branch）
- [x] AC-B9: Per-cat Stop 按钮（PR #510 merged）— cancel API + ThreadExecutionBar × 按钮
  - ✅ 同上打磨：猫名 + 颜色随 B8 一起修完
- [x] AC-B10: 双模发送 UX — whisper 模式下执行中猫 chip 禁用（灰色+⏳），auto-select 跳过活跃猫，reconcile 移除新活跃 targets（`feat/f122-remaining` branch）

#### 观察到的现象：A2A agent entry 卡在队列（runtime 环境，待验证）

> team lead 2026-03-17 00:00 报告（runtime 环境，非最新 main）：
> "小金 at 了缅因，消息进入队列。小金早干完了，但队列里的消息永远到不了。"

**现象**：opencode @ codex 的 A2A agent entry 在 QueuePanel 里排队，"猫猫正在回复中" 持续显示，但实际上 opencode 已完成执行。entry 不会被自动出队。

**可能根因**（待新 session 用 debugging skill 验证）：
1. `tryAutoExecute` 在 enqueue 时调了一次，目标猫 slot 忙 → 跳过。之后没有重试机制
2. `onInvocationComplete` 的链式调度（`tryExecuteNextAcrossUsers`）可能没有覆盖 agent entry
3. `activeInvocations` 前端残留（和 PR #470 修的 steer stuck loading 同类）

**注意**：此现象在 runtime 环境观察到，runtime 可能未同步最新 main（含 PR #499/#502 等 F122B 改动）。需要先确认 runtime 代码版本再定位。

#### 观察到的现象：Steer agent entry 后气泡显示为team lead发的（runtime 环境）

> team lead 2026-03-17 00:05 报告：Steer 推送 agent entry 后，小金的消息气泡显示成team lead发的。F5 刷新后纠正。

**可能根因**：agent entry 的 `userId` 继承了触发用户的 userId。Steer 推送后 QueueProcessor 用 entry 的 userId 广播 → 前端用 userId 判断气泡方向 → 误显示为team lead。刷新后从 messageStore 读的是正确的 catId 所以纠正。

**同上注意**：runtime 环境观察到，待确认代码版本。

#### 已知问题：A2A 消息上下文提前可见（P1，AC-B6 前置修复）

> team lead 2026-03-16 17:07 提出：
> "我怕你这个发生了，你的这条消息还在队列里，但是你的历史上下文里面已经把别人的这条消息给塞进去了。"

**现象**：A2A callback 消息（`post_message` with @mention）入库后 `deliveryStatus` 为 `undefined`，`isDelivered()` 返回 true → ContextAssembler 立即将其纳入猫的上下文 → 猫在处理其他任务时就"看到了"排队中的 A2A 消息。

**代码证据**（codex 2026-03-16 核实确认）：
- `callbacks.ts:408` — A2A 消息 `messageStore.append()` 未设 `deliveryStatus`
- `MessageStore.ts:16-21` — `isDelivered()` 对 `undefined` 返回 true（向后兼容）
- `ContextAssembler.ts:109` — `messages.filter(isDelivered)` → 未标记的 A2A 消息通过过滤

**安全部分**：用户取消（`markCanceled`）的消息 ContextAssembler 已正确过滤。

**修复方案**（opus + codex 共识）：
1. A2A/multi_mention callback 消息入库时写 `deliveryStatus: 'queued'`
2. enqueue 后 `backfillMessageId` 绑定 queue entry 和 messageId
3. `QueueProcessor.executeEntry` 时沿用 `markDelivered` 使消息对上下文可见
4. 被 depth/dedup/full 拒绝时 `markCanceled` + `system_info` 通知（防悬挂）
5. 回归测试：「排队中不可见」「执行后可见」「拒绝路径不悬挂」

## Roadmap（F108 × F122 统一执行计划）

> 三猫（opus+gpt52+opencode）独立分析后的共识 + team lead 2026-03-14 拍板。
> 负责：Ragdoll主写 + Maine Coon review，同一 thread 按节奏推进。

### 关系定位

- **F108 = capability（能力）**：让同一 thread 多猫并发成为可能。Phase A 已合入，是基座。
- **F122 = policy（策略）**：在 F108 能力之上，统一所有执行通道的调度治理。

### 三猫共识

| 共识点 | opus | gpt52 | opencode |
|--------|:----:|:-----:|:--------:|
| F108 Phase A 是基座，已完成，冻结 | ✅ | ✅ | ✅ |
| F108 Phase B 和 F122 Phase B 不能各做各的 | ✅ | ✅ | ✅ |
| F122 Phase A（补漏洞）可以先做，风险低 | ✅ | ✅ | ✅ |
| 判忙粒度 + A2A 是否入 queue 必须先拍板 | ✅ | ✅ | ✅ |

### 冲突点（F108 Phase B × F122 Phase B）

1. **入队粒度之争**：F108 Phase B 的 side-dispatch（悄悄话/锁头）是"绕过 queue 直接派给空闲猫"；F122 Phase B 的目标是"所有执行都进 queue"。语义矛盾。
2. **判忙语义之争**：F108 Phase B 需要 slot 级（`has(threadId, catId)`）区分"猫A忙猫B空闲"；F122 OQ-4 在讨论是否改为 thread 级。
3. **WorklistRegistry 生死**：F122 Phase B 终局可能弱化 worklist 改走 queue entry；但 F108 Phase A 刚加强了 worklist 的 parentInvocationId 隔离。

### 执行阶段

```
阶段 1: F122 Phase A — 补漏洞（可以马上动手，和 F108 Phase B 无冲突）
  ├── AC-A1: multi_mention parentInvocationId 透传
  ├── AC-A2/A3: pushToWorklist 结构化 reason + not_found 降级
  ├── AC-A4: QueuePanel 显示 processing 态
  ├── AC-A7: multi_mention target 崩溃时释放 caller slot ← team lead截图的 bug
  └── AC-A5/A6: 回归测试

阶段 2: 产品决策（team lead拍板，阻塞后续所有工作）
  ├── OQ-1: A2A handoff 走 queue？（好处：聊歪了能 steer 纠正）
  ├── OQ-2: multi_mention 走 queue？
  ├── OQ-4: 判忙 slot 级 vs thread 级？
  └── F108 Phase B 的 side-dispatch 和 F122 queue 如何共存？

阶段 3: F108 Phase B + F122 Phase B — 合并设计 + 实现
  ├── 在同一个 spec 里讨论（不分两条线）
  ├── 统一判忙语义、统一入队策略
  └── 一组猫一起实现，避免改到同一堆文件打架
```

### 不做的事

- ❌ 不再把新的产品语义塞回 F108（F108 Phase A 冻结，只修 bug）
- ❌ 不同时开两条分支各做各的（`messages.ts`/`InvocationTracker`/`QueueProcessor`/`callback-a2a-trigger.ts` 会打架）
- ❌ 阶段 2 产品决策没拍之前，不动阶段 3

## Dependencies

- **Evolved from**: F108（slot-aware InvocationTracker 是 F122 的基础设施）
- **Evolved to**: F175（消息队列统一 — 消除最后的 urgent bypass，executor unification: complete）
- **Related**: F117（message delivery lifecycle — 用户消息的投递生命周期）
- **Related**: F027（A2A worklist pattern 的原始设计）

## Risk

| 风险 | 缓解 |
|------|------|
| Phase B 如果把 A2A 入 queue，猫猫自动接力会变慢（每步要过 queue） | 可以给 agent-source entry 设置 auto-execute（跳过排队，但在 queue 里有记录） |
| pushToWorklist API 变更影响现有调用方 | 返回值做 backward-compatible 扩展（`{ added, reason }` 兼容原 `CatId[]`） |
| multi_mention parentInvocationId 引入新的 worklist key 冲突 | 用 multi_mention 自己的 invocationId 作为 parentInvocationId，和主 invocation 的 worklist 天然隔离 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 热修优先，架构统一后做 | team lead现场 bug 需要立即止血 | 2026-03-14 |
| KD-2 | Connector 消息走 slot 级条件入队，Phase A 需评估是否改为 thread 级 | `ConnectorInvokeTrigger` 用 `has(threadId, catId)` 判忙，只对同 cat slot 入队（Maine Coon review 指出） | 2026-03-14 |
| KD-3 | Phase A 不改 A2A 调度模型，只补漏洞 | 降低风险，先稳后收敛 | 2026-03-14 |

## Review Gate

- Phase A: 跨家族 review（Maine Coon优先，codex 或 gpt52）✅
- Phase A.1: 跨家族 review（codex 或 gpt52）✅
- Phase B: 跨家族 review（codex R5→R6 放行）✅
- Phase B.1 (B6): 跨家族 review（codex R3→R4→R5 放行）✅
- Phase B.1 (B8/B9/B10): 跨家族 review（codex R1→R2 放行）✅
