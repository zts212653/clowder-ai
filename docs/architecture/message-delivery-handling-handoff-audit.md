---
title: "消息投递、执行与协作 Custody 因果模型"
description: "以 #1354 立模、以 #1371 反向验算，复用 Message receipt、Queue custody、TurnExecution 与 ActionSuccessor/AwaitState 四个既有真相源，通过精确引用、reserve-first 操作与 owner fence 同时闭合 safety 和 liveness。"
doc_kind: architecture
feature_ids: [F039, F055, F078, F117, F122, F167, F175, F177, F185, F194, F233, F254, F264, F275, F277, F280]
topics: [message, delivery, execution, custody, a2a, wait, recovery, reconciliation, observability, liveness, atomicity]
created: 2026-08-13
updated: 2026-08-18
status: proposed
author: "砚砚/cat-eqdvbcxw@gpt-5.6-sol"
contributors:
  - "砚砚/codex@gpt-5.6-terra"
  - "宪宪/Fable@claude-opus-4-8"
  - "宪宪/opus@claude-opus-4-6"
related_issue: 1354
related_docs:
  - docs/features/F055-a2a-mcp-structured-routing.md
  - docs/features/F078-smart-routing-group-mentions.md
  - docs/features/F117-message-delivery-lifecycle.md
  - docs/features/F167-a2a-chain-quality.md
  - docs/features/F194-invocation-liveness-canonical-read-model.md
  - docs/features/F233-ball-custody-observability.md
  - docs/features/F254-side-effect-freshness-gate.md
  - docs/features/F275-managed-work-admission-identity.md
  - docs/architecture/ownership/cells/dispatch.md
  - docs/architecture/ownership/cells/bubble-pipeline.md
  - docs/architecture/ownership/cells/ball-custody.md
  - docs/architecture/ownership/cells/managed-work.md
---

# 消息投递、执行与协作 Custody 因果模型

## 结论

Issue #1354 暴露的不是“缺一个统一 WorkItem”，而是四个既有真相源之间缺少精确、可验证、可原子消费的因果连接：

1. Message receipt 记录每个目标的投递、尝试与失败；
2. Queue custody 决定某个目标的哪一次 attempt 可以进入执行；
3. TurnExecution 记录一次真实 invocation 看过什么、如何结束；
4. ActionSuccessorLease / AwaitState 持有行动交接或外部等待期间的责任。

本设计不建立第五本生命周期总账。它只补三类能力：

- 不可变因果引用：把 Message target、queue entry、attempt、invocation、successor lease 和 wait generation 连成一条链；
- owner fence 与 generation CAS：任何推进或终局只可由当前 owner 消费；
- 派生读模型：把四个真相源联结成用户可理解、可恢复的状态，但读模型不得反向成为写入真相源。

核心不变量是：

> 任一可执行 continuation，在一个 custody version 内只能有一个 owner、一个 admitted carrier、至多一个 live TurnExecution；普通 Queue 以 attemptId 作为 fence，lease / wait 以 generation 作为 fence。终局必须消费同一 source 与 owner fence。失败只属于该 target / attempt，不得扩大到其他 target 或整个 thread。

### Safety 与 liveness 必须分别证明

#1354 主要暴露 custody safety：不能由错 owner、错 source 或错 generation 推进。#1371 进一步证明，只有 safety 不够：系统可以每次都 fail closed，却在已产生副作用后返回冲突、让一个终态 entry 永久占住队头，或让调度器在没有 live execution 时无状态返回。

因此本文同时要求：

- **Safety**：不可逆副作用前必须先在事实 owner 内提交唯一 reservation；CAS loser 不得执行副作用；terminal 不得跨 source、target、attempt、invocation 或 generation。
- **Liveness**：没有 live execution 且存在 eligible work 时，一次调度判定必须 admission、明确 park，或持久化 owner + next check；不得 bare-return 后等待无关新消息碰巧解锁。
- **Monotonicity**：exact child 已提交的 terminal truth 不得被 parent aggregate、later retry 或投影写回降级。
- **Non-interference**：一个 custody domain 的 hold、wait、failure 或 recovery 不得改写另一个 dispatch / target attempt 的 owner fence。

这四项都是协议契约，不是 UI 或实现优化。

## #1354 暴露的三条断裂

### R1：失败有事实，却没有精确可见、可授权的恢复入口

现状同时存在 QueueProcessor 的 slot pause、QueuePanel 的“暂停 · 0”和不带 target 的 /queue/next。它们无法回答：

- 哪条 Message；
- 哪个 target；
- 哪个 queue entry / attempt；
- 哪次 invocation；
- 谁有权重试；
- 重试会消费哪一代 custody。

结果是失败被投影成 thread-wide pause，而不是一个 target attempt 的终态。

### R2：managed hold 跨层提交不是同一事务

某次 managed hold 可能已经创建 TurnExecution，但 receipt 结算因等待身份或 generation 不匹配而拒绝。随后系统恢复通用正文、阻塞 sibling target，或者把一次局部失败解释成整个 thread 无法继续。

根因不是缺一列 status，而是：

- admitted carrier 没有携带完整 wait outcome 与 owner fence；
- Run admission 和 receipt terminal 没有消费同一 generation；
- 失败后恢复逻辑改写了不属于它的事实。

### R3：外部事件被误当成新 agent 工作

PR、CI、人类批准、定时器或 webhook 的到达，只能推进已有 AwaitState / ActionSuccessor predicate。它们本身不是“给某只猫新增一条普通消息”，更不能在没有授权 successor 的情况下创建 Run。

## #1371 反向验算：不是一个根因

#1371 汇总了同一用户表象下的多条独立故障，不能用一个 Queue hotfix 宣称闭环。本文逐条落到既有 owner 与验收：

| #1371 分支 | 协议归属 | 本文闭环 |
|---|---|---|
| A. unrelated hold 改写 thread-global holder，A2A child 无法 terminal | dispatch / successor / wait 各自的 exact owner fence | Custody domain 非干扰；A25 |
| B. failed primary 或 fairness gate 阻塞后续工作 | Queue custody 的 eligible selector 与 runnable head | progress obligation；A26–A27 |
| C. Steer 在状态 CAS 前已 preempt | Queue custody reservation + provider 副作用 | reserve-first fenced saga；A28–A29 |
| D. parent aggregate 把 succeeded child 写成 failed | per-target receipt terminal writer | child terminal 单调性；A30 |
| E. busy-target 静默丢失、foreign occupancy 隐形、timeline/Queue 似重复 | receipt 持久化 + TurnExecution / UI 联结投影 | A31–A33 |

这张表验证的是目标模型能否解释和防止 incident，而不是声称本文已经实现这些修复。

## 四个真相源，不是一个总账本

| 真相源 | 唯一回答的问题 | 不得承担 |
|---|---|---|
| MessageStore + QueueReceiptTarget / Attempt | 这条消息对这个 target 投递到哪一步，历经哪些 attempt | agent 是否真正启动、责任当前归谁 |
| Queue custody / queue entry | 哪个 target attempt 获得一次 admitted carrier | 长期任务状态、外部等待状态 |
| TurnExecutionStore | 哪次 invocation 启动、暴露了哪些输入、是否结束 | 消息投递重试策略、下一棒责任 |
| ActionSuccessorLeaseStore / AwaitState | 当前行动责任或外部等待由谁、哪一代 fence 持有 | 复制 Message/Run 的生命周期 |

QueuePanel、消息气泡、thread 摘要和运维查询都是这些真相源的联结投影。投影可以缓存，但必须可丢弃重建；投影写入不能推进业务状态。

### 为什么不引入 WorkItem

旧稿中的 WorkItem 同时保存 status、responsible、activeRunId、blockedBy、waitingFor、recovery 和输入集合。每一项都复制了既有 owner 的事实：

- status 复制 receipt、TurnExecution、lease 和 wait 的组合；
- responsible 复制 action successor holder 或 wait owner；
- activeRunId 复制 TurnExecutionStore 的 live execution；
- blockedBy / waitingFor 复制 successor / AwaitState；
- recovery 复制 exact failed attempt 的派生能力。

这会产生无法原子维护的双写，并迫使每轮 review 为新总账与旧总账重新划边界。

因此本方案明确不新增：

- WorkItem 表或 workItemId；
- thread 级统一 status；
- blockedBy / waitingFor 依赖图；
- 独立 recovery ledger；
- 另一套 scheduler 或 lifecycle reducer。

## 跨层因果坐标

下列坐标是既有真相源间的外键或 CAS 条件，不是新领域对象。部分已存在于 receipt、carrier 或 execution；缺失的跨层绑定应补进它所描述的既有事实，不另建总账：

| 坐标 | 作用 |
|---|---|
| messageId | 用户可见消息与 source input |
| targetCatId | 每目标隔离边界 |
| entryId | queue custody carrier |
| attemptId | 一次 append / delivery 尝试 |
| invocationId | 一次 TurnExecution |
| parentInvocationId | agent 触发 agent 时的执行因果 |
| triggerMessageId | 本次 execution 的触发输入 |
| coveredMessageIds | 本次 execution 实际覆盖的已成熟输入 |
| freshnessSupplementId | 独立 supplement execution 的因果身份 |
| subjectRef | PR、issue 或其他行动对象 |
| leaseId / waitId | 行动交接或外部等待身份 |
| generation | owner fence 的版本 |
| outcomeId / evidenceRef | 可幂等消费的终局证据 |
| operationId | steer 等跨副作用操作的幂等 reservation 身份 |
| outputMessageId / replyTo | child 成功结果与 source 的 durable 输出因果 |

threadId 只是容器，单独不能授权 terminal、retry、Continue、handoff 或 Run admission。

因果脊柱为：

    Message
      → per-target Receipt / Attempt
      → Queue custody carrier
      → TurnExecution
      → terminal outcome
        或 ActionSuccessor / AwaitState
      → 下一代精确 carrier

每一条边都必须由下一层持久化上一层的精确标识；只凭“当前 thread”“最近消息”“当前猫”推断均不构成结算证据。

## 路由：先决定目标与 effect，再谈执行

### 用户输入

无 @ 的用户输入继续遵循 F078 的服务端路由策略：

1. 明确结构化目标优先；
2. 否则使用当前对话偏好或最近有效回复者；
3. 再退到服务端默认猫；
4. 路由结果持久化为 per-target receipt。

composer 可以展示或建议目标，但不能成为唯一真相源；绕过 composer 的合法客户端也必须获得同样的服务端路由结果。本文不改变 F078 的产品行为。

### agent 输出与 A2A

agent 输出先分类 effect：

- publish_only：只进入用户时间线，不创建其他猫的 Run；
- admit_exact_target：结构化 targetCats 生成对应 per-target receipt / carrier；
- advance_existing_custody：结构化 action、returnToPredecessor、hold 或 registered event wait 推进现有 owner fence。

正文中的 @ 只是可读运输提示。它不能代替 targetCats，不能凭文本产生行动责任，也不能结算 lease。

普通 A2A 投递使用 targetCats；需要下一棒责任和可验证终局时使用 ActionSuccessor lease。两者都必须落到 exact target，不能用 thread 最近说话者猜测。

### 人类、PR、CI 与 callback

外部事件必须先匹配 proposal / AwaitState / terminal predicate：

- 匹配成功：消费 exact wait generation，生成一次 continuation carrier；
- 重复事件：幂等返回已消费结果；
- 过期或不匹配：记录 reconciliation，不创建 Run；
- 没有已注册 owner：只作为外部事实展示，不派发给 agent。

GitHub、CI、timer 和 webhook 不是本地猫，不能被投射成一个隐式 target。

## Message 投递与正文暴露

### 每目标 receipt

每条需要 agent 处理的 Message，为每个 target 建立独立 QueueReceiptTarget。attempt 只追加，不覆盖历史；appended 是 continue_current / 已覆盖输入的分支，不是每次 next_work 的必经状态：

    queued
      ├─→ starting ─┬─→ handled
      │             └─→ failed
      ├─→ appended ─┬─→ handled
      │             └─→ failed
      └─→ cancelled

- retry 新增 attemptId，不复活旧 attempt；
- entryId 与 messageId + targetCatId + attemptId 绑定；
- 一个 target 的 failed / retry 不改写 sibling target；
- receipt 的 handled 只能由绑定的 terminal execution 或授权 terminal action 结算。

QueueReceiptTarget.state 不是第二个可独立写入的状态机。receipt owner 只写 QueuedMessageCustody 中的 target custody facts 与 append-only attempts；projectQueueReceiptTarget 再从这些事实派生 target 级 queued / notified / awakened / seen / steering / failed / withdrawn / handled。attempt 保存每次尝试的线性审计史，target state 保存用户此刻应看到的聚合投影，两者不得由不同 writer 分别推进。

### 每个 child 的终局真相单调推进

per-target receipt 的 terminal writer 只能读取 exact resolved child，而不是 parent aggregate 的汇总状态：

- child `succeeded` 且存在 durable `outputMessageId / replyTo / evidenceRef` 时，绑定 attempt 必须单调提交为 handled / consumed；
- child `failed` 或 `cancelled` 时，只有该 child 的 attempt 保持 actionable，并生成精确 RecoveryCandidate；
- parent aggregate 可以读取多个 child outcome 计算自己的结果，但不是 child receipt 的 writer；
- handled / consumed 一旦由 exact child terminal 提交，不得被 later aggregate failure、retry、restart 或 projection 降级为 failed / queued；
- terminal execution 已提交而 receipt 尚未结算时，只能由 receipt reconciler 按同一 attemptId + invocationId 补齐，不能重跑 child。

因此“一个 sibling 使 aggregate 失败”与“另一个 child 是否已成功处理”是两个独立事实。

### Queue custody 语义

队列操作按 target 和 entry 精确解释：

- next_work：目标没有 live execution 时，以一个 admitted entry 作为 trigger carrier，并冻结本次 execution 的 coverage snapshot；
- continue_current：仅在 execution adapter 支持增量暴露时，把输入附着到该 live invocation；
- steer：先在 Queue custody owner 内提交绑定 exact attempt + invocation 的唯一 reservation；只有 reservation winner 才可 interrupt，并用同一 operationId 完成 replacement；
- cancel：只取消尚未 admitted 的 exact target attempt。

continue_current 表示“允许向该 invocation 暴露”，不等于 agent 已看见，更不等于 handled。若 adapter 不支持 supplement，必须回退到 next_work，不得悄悄把 receipt 标成完成。

### Queue admission 的 progress obligation

删除 thread-wide pause 只消除错误状态，不自动保证队列继续前进。所有 new-arrival、execution-terminal、retry 和 restart 扫描必须调用同一 eligible selector；当目标没有 live execution 时，每次判定必须产生以下一种 durable 结果：

1. admission 一个 eligible entry，并冻结 coverage snapshot；
2. 因更高优先级 entry 延后当前 entry，同时在同一轮 admission 被保护的 entry；
3. 把当前 entry 明确 park 到 runnable head 之外，并记录 reason、recovery owner、allowed action 与 next check；
4. 证明没有 eligible entry。

禁止在“存在 eligible work 且没有 live execution”时 bare-return。failed、cancelled、withdrawn 或 paused-awaiting-advance 的不可执行 attempt 保留在审计史和用户投影中，但不得继续占用 runnable FIFO head；同一 target 后到的独立 eligible attempt 必须仍可 admission。

fairness gate 也受同一约束：如果 agent entry 因待处理 user entry 被延后，调度器必须启动该 user entry，或持久化它为何尚不可启动以及谁、何时再检查；不能同时阻塞两类工作，等待无关新消息触发下一次扫描。

### Steer 的 reserve-first fenced saga

Steer 跨越 Queue 状态写入和 provider preempt 副作用，不能用“先 preempt、后 CAS”实现。协议固定为：

1. 读取 exact target attempt、live invocation 与各自 revision；
2. 在既有 Queue custody fact 上 CAS 提交 steering reservation，写入 operationId、attemptId、invocationId 与 captured revisions；该 reservation 同时 fence void-ack、requeue、restart 和其他 steer；
3. 只有 reservation winner 才以 operationId 作为幂等键调用 preempt；CAS loser 在任何副作用前返回 stale；
4. preempt 结果先写回同一 Queue reservation；随后 receipt owner 以 operationId 幂等追加 replacement attempt，Queue owner 再物化 carrier；跨 owner 的中间缺边由该 operationId 精确 reconciliation，不能由第二套汇总状态推进；
5. reservation 后、preempt 前失败时可安全释放或重试同一 operationId；preempt 后、replacement commit 前失败时进入 exact reconciliation，由 operationId 续完，不允许用户盲重试或再次 preempt。

对调用方而言，冲突只允许发生在 preempt 之前；若 preempt 已发生，系统必须返回 committed 或 reconciliation_required 的可追踪结果，不能把它包装成无副作用的 409。

### 合并唤醒的 coverage snapshot

一次 next_work admission 仍然只有一个 trigger carrier 和一个 TurnExecution，但可以覆盖该 target 在快照时全部 eligible、已成熟的 queued attempts：

1. admission 先以 trigger entry 取得执行权，再在 provider dispatch 前冻结 coveredMessageIds 与 covered attempts；
2. 每个 covered attempt 用自身 attemptId + 绑定 invocationId 做 CAS，从而不会被第二个 carrier 重复 claim；
3. terminal 只用同一个 execution 的终局逐项 CAS 这些 covered attempts 为 handled；若跨记录提交中断，reconciler 依据该 terminal execution 幂等补齐剩余项；
4. coverage snapshot 之后到达或当时尚未成熟的输入不属于本次 execution，保持 queued，等待下一次 carrier。

因此“一次唤醒读多条消息”不等于“一条 attempt 代表多条消息”：Run 的 coverage 可以是一组，投递、失败、重试和结算仍按每条 Message 的 target attempt 隔离。

### “看过、运行过、处理过”的证据

| 问题 | 真相 |
|---|---|
| 输入是否排入某个 target | QueueReceiptTarget |
| 某次 append 是否成功 | QueueTargetAttempt |
| 哪次 invocation 取得 carrier | TurnExecution 的 entryId / attemptId |
| invocation 启动时看过什么 | triggerMessageId + coveredMessageIds |
| live turn 后到输入是否实际暴露 | QueueTargetAttempt 的 invocationId + seenAt；独立 supplement 使用 freshnessSupplementId |
| agent 是否真正执行 | TurnExecution startedAt |
| 消息是否处理完成 | terminal execution / authorized action 对 receipt 的 CAS |

## A2A 行动责任

### 普通投递与结构化行动

普通 targetCats 投递的终局生产者只能是：

- agent 对该 dispatch 的结构化 complete；
- 结构化 successor action；
- 结构化 wait / hold；
- returnToPredecessor 或 transfer。

命令退出码、普通文本 ACK、消息已发布或“看起来回答了”都不是行动终局。

### Custody domain 非干扰

threadId 只能分组，不能作为跨 domain 的 holder 或 terminal authority。普通 A2A dispatch、ActionSuccessor lease 与 AwaitState 各自以 exact subject 和 owner fence 推进：

- 普通 A2A terminal 校验 source dispatch、target attempt、执行 child 与可选 successor lease；不得读取“当前 thread holder”作为替代证据；
- hold_ball 只能写入其 source invocation 创建的 AwaitState / wait generation，不能覆盖另一个普通 dispatch 或 successor lease 的 holder；
- successor terminal 只能消费自己的 leaseId + generation；另一个 wait、hold 或 sibling action 的 generation 变化与它无关；
- 只有显式跨 domain transition 才能关联两者，例如 successor holder 消费当前 lease generation 后创建绑定该 lease 的 AwaitState；关联必须同时持久化双方 identity；
- unrelated hold 与 A2A child 并发时，child 仍可凭自己的 attempt / invocation / lease fence 结算，不得产生 ambient `holder_mismatch`。

这不是新增映射账本，而是禁止各 owner 用 thread-global 可变状态替代精确外键。

### ActionSuccessor lease

需要 A → B 的下一棒责任时，ActionSuccessorLeaseStore 持有：

- subjectRef 与 actionFamily；
- predecessor / holder；
- successorSlot；
- terminalPredicate；
- generation；
- source invocation / dispatch 引用；
- completion evidence 或 return path。

admission 必须携带 leaseId + generation；terminal 必须对同一 identity、holder、predicate 和 generation 做 CAS。stale、错 holder、错 subject 或错 predicate 均 fail closed。

returnToPredecessor 消费当前 generation，并为 predecessor 创建下一代精确 carrier；它不是发一条普通 @ 消息。

### 扇出不需要父 WorkItem

A 同时派给 B、C 时：

- B、C 分别有 receipt / attempt；
- 需要行动责任时分别有 successor lease；
- 各自 TurnExecution 独立；
- B 的失败或等待不阻塞 C；
- B/C 的终局通过 predecessor 引用回到 A；
- A 的下一次 Run 只由已成熟且已授权的 outcome carrier 唤醒。

并行与 join 是 lease / outcome 的关系，不需要父 WorkItem 或 blockedBy 图。

## Wait、managed hold 与外部 gate

### AwaitState

AwaitState 至少持有：

- waitId 与 subjectRef；
- owner fence，可解析到 containing task 或 action-successor holder；
- expected signal / predicate；
- generation；
- source invocation / action lease；
- status 与 terminal outcome；
- 可幂等的 evidenceRef。

event-driven wait 与轮询 hold 是互斥 carrier。已有结构化 callback 且已注册 AwaitState 时，不得再创建重叠定时 hold。

### Wait outcome 与 continuation carrier

wait terminal 先形成不可变 WaitOutcome，再由 admission 把它转换成一次性 WaitContinuationCarrier。

WaitContinuationCarrier 只投影不可变的 waitId、outcomeId 与 ownerFence；subject、generation 和 predicate 留在 WaitOutcome / AwaitState，target 与 source message 留在承载它的 Message / Queue carrier。消费方联结这些既有真相后校验同一 fence，不能从正文反推，也不能复制出另一份可漂移的等待记录。

carrier 只能消费一次。

### Managed hold 的原子契约

一次 managed hold 恢复按以下顺序执行：

1. 读取 AwaitState，并校验 owner、predicate、generation；
2. 对 outcomeId 做幂等占位；
3. 创建绑定 waitId + generation + outcomeId 的 queue carrier；
4. TurnExecution admission 写入同一组引用；
5. execution terminal 与 receipt terminal 在同一 owner fence 上 CAS。

若第 3 步前失败，不得出现 Run；若第 4 步后失败，必须保留已创建的 execution 证据，并把 exact target attempt 投影为 reconciliation_required。不得：

- 恢复成丢失 wait 身份的通用消息正文；
- 把 sibling target 一并暂停；
- 使用更新后的 wait generation 结算旧 Run；
- 重复消费同一 outcome。

## 精确恢复，而不是 thread-wide Continue

### RecoveryCandidate 是派生能力

恢复入口由既有事实派生，至少包含：

- messageId；
- targetCatId；
- entryId；
- failed attemptId；
- invocationId（若已创建）；
- custody kind 与 owner id；
- generation；
- allowedAction；
- reason。

它不是持久化 lifecycle ledger。只要底层事实变化，旧 candidate 即失效。

### Retry 的 CAS

用户或系统触发 retry 时：

1. 读取 candidate；
2. 校验 exact failed attempt 仍是可恢复终态；
3. 校验调用者权限和 owner generation；
4. 原子创建新的 attempt / carrier；
5. 记录旧 attempt 到新 attempt 的 retryOf 引用。

同一请求重复提交返回同一结果；过期 candidate 返回 stale，不得退化成 no-target /queue/next。

### Reconciliation 的归属

| 不一致 | 修复 owner |
|---|---|
| receipt queued 但 queue entry 缺失 | Queue / receipt reconciler |
| execution terminal 但 receipt 未结算 | TurnExecution / receipt reconciler |
| successor completed 但 continuation 未创建 | ActionSuccessor recovery |
| wait outcome 已有但 carrier 缺失 | Await recovery |
| UI 与底层事实不符 | 重建投影 |

reconciliation 只修复原 owner 管辖的边，不能用一个统一 reducer 重算全 thread。

## 重启恢复

进程启动后按稳定顺序恢复：

1. 恢复未终局 QueueTargetAttempt 与 queue entry；
2. 校验 starting / appended attempt 是否有绑定 TurnExecution；
3. 对 live TurnExecution 运行 canonical liveness 判定；
4. 恢复 active ActionSuccessorLease 和 AwaitState；
5. 重新注册未终局 event wait，不重复消费已记录 outcome；
6. 对缺边状态生成 item-scoped reconciliation；
7. 从四个真相源重建 UI 投影。

不允许通过“扫描 thread 最近一条消息”恢复 custody，也不允许把未知状态统一改成 paused。无法证明 owner 的 carrier 必须 fail closed，等待 reconciliation 或明确授权。

## 用户可见模型

### 消息气泡

一条消息对多个目标分别显示：

- queued；
- starting；
- running；
- paused-awaiting-advance，并显示 recovery owner / next check；
- waiting / handed_off；
- handled；
- failed，可恢复时带 exact retry；
- superseded / withdrawn，并显示 supersededBy；
- cancelled；
- reconciliation_required。

气泡状态来自 per-target receipt 与其绑定 execution / custody 的联结。timeline 与 Queue 必须复用同一个 source message identity：Queue 展示的是该 source 的 target lifecycle，不是第二条消息。诊断视图必须能从 source 展开到 targetCatId → attemptId → child invocationId → output / terminal evidence，避免“目标是谁、哪只 child 真正运行”只能靠日志猜测。

busy target 的新输入也必须先建立 durable per-target receipt / attempt。它可以进入 live supplement，也可以保持 queued 等下一 carrier，但不能以 dedup_active 或“已有 Run”为由静默丢失责任。

### 执行占用与控制权限分离

canonical TurnExecution 仍 live 时，Queue / thread 投影必须显示 occupancy，即使执行由 scheduler 或其他 foreign principal 启动。可见不等于可取消：

- owner 可控制的 execution 显示真实、可授权的 control handle；
- foreign-principal execution 显示 `not_cancelable / foreign_principal` 与合成 occupancy identity；
- 不得把可用于读取或取消的 raw task id 暴露为 foreign row identity；
- 权限判断只能决定谁能 Steer / Cancel，不能把 live occupancy 从 owner 视图中删除。

### 内部等待

外部 gate、agent successor 和普通 queue backlog 分开显示。用户看到“在等 PR”“球在 B”“排队等待 A”，而不是一个含义不明的 thread paused。

### 删除 thread-wide pause 语义

- QueueProcessor 的 slot backoff 可以保留为运行时限流，但不是 durable 用户状态；
- QueuePanel 不再把 slot pause 渲染成“暂停 · 0”；
- Continue 必须带 exact RecoveryCandidate；
- 不再提供无 target、无 attempt、无 generation 的 /queue/next 恢复路径。

## 一次性切换

本变更采用一次性切换，不运行新旧双轨：

1. 为现有 QueueReceiptTarget 补齐 append-only attempt；
2. 把可证明的 queue entry 与 attempt 绑定；
3. 把可证明的 TurnExecution 写入 entryId / attemptId 因果引用；
4. 把 active successor / wait 连接到其 source invocation 与 generation；
5. 无法唯一证明的历史记录只进入 legacy_unknown 投影，不猜测归属；
6. 切换读模型与 exact retry 后，删除 thread-wide pause / no-target Continue 路径；
7. 验证完成后移除旧运行分支。

切换不删除 Message、receipt、execution、lease、wait 或用户历史。本文禁止为了迁移方便新增 WorkItem，也禁止长期双 runtime。

## 验收矩阵

| ID | 场景 | 必须观察到 |
|---|---|---|
| A1 | 用户无 @ 发消息 | F078 服务端解析 target，并建立 per-target receipt |
| A2 | 用户显式指定 target | 只为指定目标建立 receipt |
| A3 | queued 前取消 | exact target attempt cancelled，无 Run |
| A4 | next_work | 一个 trigger carrier 只创建一个 Run；所有 covered entries 保留各自 attempt |
| A4a | 同 target 多条消息已成熟 | 一次唤醒冻结 coverage，所有 covered attempts 绑定同一 invocation 并由其逐项结算 |
| A4b | coverage snapshot 后又到消息 | 后到 attempt 保持 queued，不进入本次 coveredMessageIds |
| A5 | adapter 支持 continue_current | QueueTargetAttempt 记录 exact invocationId 与 seenAt |
| A6 | adapter 不支持 supplement | 回退 next_work，不提前 handled |
| A7 | steer | 先 CAS steering reservation；只有 winner preempt，并以同一 operationId 创建 replacement |
| A8 | 普通 A2A 完成 | 结构化 complete 结算 exact receipt |
| A9 | A 创建 successor 给 B | B 仅凭 exact lease generation admission |
| A10 | B returnToPredecessor | 当前 generation 被消费，A 获得下一代 carrier |
| A11 | A 同时派 B/C | 两套 receipt / lease / Run 可并行 |
| A12 | PR/CI callback | 只推进匹配 AwaitState，不创建无主 Run |
| A13 | human approval | 仅授权 actor 可消费 exact predicate |
| A14 | managed hold 全匹配 | wait outcome、carrier、Run、receipt 同一 generation |
| A15 | managed hold mismatch | exact item reconciliation；sibling 继续 |
| A16 | exact retry | 新 attempt 带 retryOf，旧历史不变 |
| A17 | 重复 retry | 幂等返回，不创建第二个 attempt |
| A18 | queued receipt 缺 carrier | Queue reconciler 修复该 target |
| A19 | execution terminal、receipt pending | receipt reconciler 以绑定 execution CAS |
| A20 | stale generation terminal | fail closed，不改新 owner |
| A21 | B 失败、C 正常 | C 不被暂停，A 可见两个独立 outcome |
| A22 | 输入已暴露但 Run 失败 | receipt 不伪装 handled，保留 execution 证据 |
| A23 | 消息无 source / authority | 只 publish 或拒绝推进，不隐式派工 |
| A24 | 一次性切换 | 无双 runtime，无持久数据删除，投影可重建 |
| A25 | unrelated cat 在 A2A child 运行时 hold_ball | hold 只推进自己的 AwaitState；child 仍可按 exact fence terminal，无 ambient holder_mismatch |
| A26 | failed primary 后同 target 又有 eligible entry | failed attempt 离开 runnable head；后到 entry 在无 live execution 时继续 admission |
| A27 | fairness gate 因 user entry 延后 agent entry | 同轮启动被保护的 user entry，或持久化 owner + next check；不得 bare-return 双向死锁 |
| A28 | void-ack / requeue / restart 与 Steer 竞争 | reservation CAS loser 从未调用 preempt；winner 至多创建一个 replacement |
| A29 | preempt 后 replacement commit 中断 | 返回 reconciliation_required，并由同一 operationId 幂等续完；不得盲重试或再次 preempt |
| A30 | parent aggregate 失败，但一个 child 已 succeeded 且有 durable output | 该 child 单调 handled / consumed，不可重醒；只有 failed / cancelled child actionable |
| A31 | busy target 在 coverage snapshot 后收到新消息 | 新 source 有 durable receipt / attempt，保持 queued 或走显式 supplement，不得 silent dedup |
| A32 | scheduler / foreign principal 占用 execution slot | owner 可见 not_cancelable occupancy，但拿不到 raw capability handle |
| A33 | 同一 source 同时出现在 timeline 与 Queue | UI 显示一个 source 的 per-target lifecycle 与 child lineage，不呈现为原因不明的重复消息 |

## 实施顺序

1. 先把 #1354 与 #1371 的真实失败做成红测试，覆盖 A14–A22 与 A25–A33；
2. 为 receipt / queue / TurnExecution 补齐精确因果引用，并让 exact child terminal 成为唯一单调 writer；
3. 统一 new-arrival、terminal、retry、restart 的 eligible selector，落实 progress obligation 与 fairness self-consistency；
4. 把 Steer 改为 reserve-first fenced saga，在任何 preempt 前赢得 operationId；
5. 让普通 dispatch、ActionSuccessor 与 AwaitState 使用 exact domain fence，删除 ambient thread-holder 校验；
6. 从底层事实派生 RecoveryCandidate，删除 no-target Continue；
7. 统一入口 effect 分类并保持 F078 server-side 路由；
8. 用联结投影替换 QueuePanel 的 thread-wide pause，并补 foreign-principal occupancy；
9. 完成一次性 backfill、切换和旧路径删除。

每一步必须先证明单 owner、单 carrier、单 live execution；不得以新增统一状态字段来掩盖跨源原子性尚未闭合。

## 不变量与非目标

以下状态必须不可能：

- 一个 target attempt 同时被两个 carrier admission；
- 同一 custody generation 同时存在两个 live TurnExecution；
- terminal 消费与 admission 不同的 source 或 generation；
- 未提交 steering reservation 就执行 preempt，或一个 operationId 执行两次 preempt；
- CAS loser 在返回冲突前已经产生 interrupt / cancel 副作用；
- 没有 live execution 且存在 eligible work 时，selector 无状态 bare-return；
- failed / parked attempt 永久占住 runnable head，阻止同 target 后续独立工作；
- parent aggregate 把 exact child 已提交的 handled / consumed 降级为 failed / queued；
- unrelated hold / wait 改写普通 A2A dispatch 或 successor lease 的 holder fence；
- agent 正文、命令退出码或普通 ACK 结算行动责任；
- 一个 target 的失败暂停 sibling 或整个 thread；
- 外部 callback 在没有已注册 owner 时创建 Run；
- UI 投影反向写入业务真相；
- foreign-principal live execution 因不可控制而从 occupancy 投影消失；
- retry 覆盖或删除旧 attempt；
- 重启时凭最近消息猜测 owner。

本文非目标：

- 不新增 WorkItem / LifecycleRecord；
- 不改变 F078 的无 @ 产品路由；
- 不把全部业务编排成 DAG；
- 不用 TTL 清理用户可见历史；
- 不删除任何 durable user data；
- 不在本 RFC 中规定每个 UI 像素或队列调度算法。

## 实现锚点

- QueueReceiptTarget / QueueTargetAttempt：packages/shared/src/types/queue-receipt.ts
- TurnExecution causal refs：packages/api/src/domains/cats/services/stores/ports/TurnExecutionStore.ts
- ActionSuccessor lease：packages/api/src/domains/ball-custody/ActionSuccessorLeaseStore.ts
- AwaitState owner fence：packages/shared/src/types/github-wait.ts
- 入口与 queue callbacks：packages/api/src/routes/callbacks.ts
- Issue：<https://github.com/zts212653/clowder-ai/issues/1354>
- Reverse test：<https://github.com/zts212653/clowder-ai/issues/1371>
