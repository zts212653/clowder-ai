---
title: "消息投递、执行与协作 Custody 因果模型"
description: "以 #1354 为入口，复用 Message receipt、Queue custody、TurnExecution 与 ActionSuccessor/AwaitState 四个既有真相源，通过精确引用和 generation CAS 闭合投递、执行、交接、等待、恢复与重启。"
doc_kind: architecture
feature_ids: [F039, F055, F078, F117, F122, F167, F175, F177, F185, F194, F233, F254, F264, F275, F277, F280]
topics: [message, delivery, execution, custody, a2a, wait, recovery, reconciliation, observability]
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

每条需要 agent 处理的 Message，为每个 target 建立独立 QueueReceiptTarget。attempt 只追加，不覆盖历史：

    queued → starting → appended → handled
                      ↘ failed
              queued → cancelled

- retry 新增 attemptId，不复活旧 attempt；
- entryId 与 messageId + targetCatId + attemptId 绑定；
- 一个 target 的 failed / retry 不改写 sibling target；
- receipt 的 handled 只能由绑定的 terminal execution 或授权 terminal action 结算。

### Queue custody 语义

队列操作按 target 和 entry 精确解释：

- next_work：目标没有 live execution 时，取得下一个 admitted entry；
- continue_current：仅在 execution adapter 支持增量暴露时，把输入附着到该 live invocation；
- steer：先对 exact invocation 提交可验证 interrupt，再为新工作创建新 attempt；
- cancel：只取消尚未 admitted 的 exact target attempt。

continue_current 表示“允许向该 invocation 暴露”，不等于 agent 已看见，更不等于 handled。若 adapter 不支持 supplement，必须回退到 next_work，不得悄悄把 receipt 标成完成。

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
- waiting / handed_off；
- handled；
- failed，可恢复时带 exact retry；
- cancelled；
- reconciliation_required。

气泡状态来自 per-target receipt 与其绑定 execution / custody 的联结。

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
| A4 | next_work | 一个 carrier 绑定一个 entry / attempt / Run |
| A5 | adapter 支持 continue_current | QueueTargetAttempt 记录 exact invocationId 与 seenAt |
| A6 | adapter 不支持 supplement | 回退 next_work，不提前 handled |
| A7 | steer | exact live invocation 先被中断，新 attempt 后创建 |
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

## 实施顺序

1. 先把 #1354 的三个失败做成红测试，并覆盖 A14–A21；
2. 为 receipt / queue / TurnExecution 补齐精确因果引用；
3. 让 ActionSuccessor / AwaitState admission 与 terminal 共用 owner fence CAS；
4. 从底层事实派生 RecoveryCandidate，删除 no-target Continue；
5. 统一入口 effect 分类并保持 F078 server-side 路由；
6. 用联结投影替换 QueuePanel 的 thread-wide pause；
7. 完成一次性 backfill、切换和旧路径删除。

每一步必须先证明单 owner、单 carrier、单 live execution；不得以新增统一状态字段来掩盖跨源原子性尚未闭合。

## 不变量与非目标

以下状态必须不可能：

- 一个 target attempt 同时被两个 carrier admission；
- 同一 custody generation 同时存在两个 live TurnExecution；
- terminal 消费与 admission 不同的 source 或 generation；
- agent 正文、命令退出码或普通 ACK 结算行动责任；
- 一个 target 的失败暂停 sibling 或整个 thread；
- 外部 callback 在没有已注册 owner 时创建 Run；
- UI 投影反向写入业务真相；
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
- 入口与 queue callbacks：packages/api/src/routes/cats/callbacks.ts
- Issue：<https://github.com/zts212653/clowder-ai/issues/1354>
