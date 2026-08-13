---
title: "消息投递、处理与交接：全链路审计与整改输入"
description: "从消息发出、入队、被目标读取、执行、交接、等待、失败恢复到用户可见回执的端到端状态地图；以 #1354 的队列暂停错配为审计样本。"
doc_kind: architecture
feature_ids: [F039, F117, F122, F167, F175, F177, F185, F254, F264, F280]
topics: [message, delivery, queue, invocation, handoff, custody, receipt, lifecycle, observability]
created: 2026-08-13
status: draft
author: "砚砚/codex@gpt-5.6-terra"
related_issue: 1354
related_docs:
  - docs/features/F117-message-delivery-lifecycle.md
  - docs/features/F167-a2a-chain-quality.md
  - docs/features/F254-side-effect-freshness-gate.md
  - docs/architecture/ownership/cells/dispatch.md
  - docs/architecture/ownership/cells/bubble-pipeline.md
  - docs/architecture/ownership/cells/ball-custody.md
  - docs/architecture/ownership/cells/transport.md
---

# 消息投递、处理与交接：全链路审计与整改输入

> **这是什么**：一份把现有消息链路讲清楚的架构审计，不是另造一套 Queue 或状态机。
> **为什么现在做**：[#1354](https://github.com/zts212653/clowder-ai/issues/1354) 显示了“队列已暂停 · 0 · 当前调用失败”。界面给了用户一个失败结论，却无法指出失败的是谁、影响了哪条工作、现在能做什么。这不是单个提示位置不对，而是投递、执行、责任和展示四层的身份没有被一起守住。
> **本文结论的边界**：下文的“当前事实”由 `main@4155d65a1` 的代码、ownership cells 和现有 feature 契约交叉核对；“整改方向”是待评审的设计输入，尚未授权实现。

## 先看一条消息实际经历了什么

用户向一个正在工作的猫发送“请帮我检查这个改动”。从用户的角度，这是一件事；从系统角度，它是几件互相有关、但不能互相代替的事。

1. **消息被保存**。用户应该能在自己的时间线看到自己发出的原文；这不等于目标猫已经看到了它。
2. **系统承诺把它交给特定目标**。如果目标正忙，消息进入该目标的候选工作队列；这时可以排队、撤回、重启恢复。
3. **一次执行被创建**。目标可执行时，系统创建一个有身份的子执行；“被唤醒”不等于已经读到了正文。
4. **正文被真正暴露给目标**。只有这里发生后，消息才可以进入该猫的上下文、prompt 和待处理清单。
5. **目标处理并产出结果**。结果可能是普通回复、明确的静默终局、失败、取消，或把后续责任交给另一位成员。
6. **用户看到与这条消息相称的回执**。回执要说明哪一步已经发生、哪一步没有发生；绝不能用“调用失败”猜测成“你的消息没有收到”，也不能让一条内部等待凭据伪装成用户的待办。

这六步必须共享可追溯的关联身份，但它们不是同一个状态字段。把它们压成一个 `paused` 或 `delivered` 布尔值，就会出现“0 条可操作工作，却要求继续”的界面。

## 三个常见场景

### 1. 用户在目标忙碌时发送消息

消息先作为用户原文持久化，并为每个目标建立可恢复的交付责任。目标空闲后，Queue 选择该目标的条目，创建子执行；该子执行确实获得正文时，receipt 记录 `seenAt`。之后才谈“已处理”或“失败”。

这里最重要的边界是：**用户可见的原始气泡，不等于猫的认知上下文**。F117/F264 已把二者拆开：已接纳的 queued message 可以留在作者时间线上，并附带真实 receipt；在 exact delivery 之前，不能进入目标的 callback、thread context、prompt 或 pending-mentions。撤回后，原消息仍必须从作者时间线和 F5 history 中消失。

### 2. 猫 A 把一件事交给猫 B

猫 A 的 `post_message` 或 cross-post 先持久化消息，再根据显式 `targetCats` 或行首 `@` 解析出每一个 B。每一个目标各有自己的交付结果：A 写给 B 和 C，不可因 B 已读而把 C 也标成已读。

交接本身也不等于责任已经完成。若消息是在请求 B 接手一个可追责的动作，责任转移由 ball-custody 的 action-successor / generation 机制裁定；普通的协调、通知或回执不能偷渡成新的实施责任。目标 B 的 execution 结束，同样不能自动证明 A 的原工作已经闭环。

### 3. 系统在等待外部条件后唤醒一位猫

`hold_ball`、受管命令完成、定时器、CI 或结构化外部事件会形成 wake。它们有来源、等待条件、持有者和 generation，不是普通用户消息。只有与当前 callback 身份精确匹配的终局处置，才可以消费这一次 wake；过期、跨 thread、跨持有者或任务不匹配的请求必须 fail closed，留在可恢复的协调/等待领域。

因此，“一个旧的 managed hold 没有完成”不能借用一条普通用户消息的 Queue 行为；反过来，用户也不该看到它像一条可以随意“继续”的聊天待办。

## 一张全链路图

```text
用户 / 连接器 / 猫 A / 结构化等待
          │
          ▼
  [1] 规范化的原始事件或消息
          │  messageId / source / origin
          ├───────────────┐
          ▼               ▼
  [2] MessageStore    等待或责任账本
      原文与作者时间线  AwaitState / ActionSuccessor /
          │              BallCustody（仅适用时）
          ▼
  [3] 每目标交付责任与 Queue custody
      messageId + targetCatId + queueEntryId
          │
          ▼
  [4] InvocationQueue 选择 + TurnExecution 创建
      queueEntryId + targetCatId + invocationId
          │
          ▼
  [5] 正文暴露 / 目标处理 / 输出提交
      seenAt / handledAt / typed terminal outcome
          │
          ├───────── 普通回复、静默终局、失败、取消
          ├───────── A2A 交接（回到 [1]，带来源关联）
          └───────── 外部等待（回到等待账本，不伪装为普通消息）
          ▼
  [6] receipt + invocation lifecycle + bubble projection
      原消息旁的精确回执；执行失败只归属于其精确执行
```

箭头表示因果关系，不表示这些组件可以互相读写任意状态。每层只拥有自己需要的真相：Queue 不拥有聊天气泡，bubble reducer 不拥有交付裁定，transport 不拥有责任转移，等待账本也不拥有用户消息的正文生命周期。

## 现有对象各自回答什么问题

| 层 | 权威对象 / owner | 回答的问题 | 不能拿来回答什么问题 |
|---|---|---|---|
| 原始内容 | `MessageStore` | 原文是什么、谁在何时发出、作者时间线是否应保留 | 某个目标是否已读、一次 provider 调用是否成功 |
| 普通消息交付责任 | MessageStore-backed Queue custody + F264 per-target receipt | 对哪个目标，哪条原消息处于 queued / notified / seen / failed / handled 等状态 | A2A action 是否完成、任意 provider 失败是否需要重试 |
| 工作排序 | `InvocationQueue` / `QueueProcessor` | 此刻哪些候选工作可运行、优先级、公平性、busy gate | 重启后的唯一消息真相、用户气泡的最终状态 |
| 子执行生命周期 | `TurnExecutionStore`、`InvocationTracker` | 一个精确 child invocation 是否创建、运行、结束及其执行类型 | 用户原文应不应该复制为另一条气泡 |
| 等待与责任 | `AwaitState`、ActionSuccessor、`BallCustodyProjection` | 谁在等什么、何时过期、何种事件可以消费或转移责任 | 普通 Queue entry 是否已读、普通消息是否该展示“已处理” |
| 外部传输 | Connector router / outbound delivery | 外部平台消息如何规范化、已提交输出如何投递和重试 | 前端气泡 identity，或重开一次已提交的答案 |
| 展示 | bubble reducer、`MessageReceiptDock`、Queue action projection | 原消息与 invocation lineage 如何稳定展示；此刻用户可操作什么 | 从文案、日志或时间邻近关系猜测真实执行状态 |

“有同一个 threadId”只说明它们发生在同一对话中，**不能**证明它们是同一条消息、同一目标、同一次执行或同一个责任单元。

## 必须贯穿的身份坐标

排障和后续设计都应至少带着下列坐标；没有坐标的“状态”只能当诊断线索，不能直接驱动用户操作。

| 坐标 | 作用 |
|---|---|
| `threadId` | 对话归属与界面聚合范围；不是交付或执行的唯一键 |
| `messageId` | 原始消息、作者时间线和 receipt 的锚点 |
| `targetCatId` | per-target delivery 的必要维度；多目标时不可省略 |
| `queueEntryId` | 某次 Queue 排队 / 重放候选的身份 |
| `invocationId` / `turnExecutionId` | 某次 child execution 的身份；失败、取消、provider 输出必须落在这里 |
| `sourceInvocationId` / coordination identity | A2A 或结构化 relay 的来源关联，防止把回执再当新工作 |
| `waitSourceRef`、holder、generation | 外部等待或责任转移的精确消费凭据 |

同一个逻辑消息重试时可能出现多个 queue entry 或 invocation；它们都应回指同一个原消息，但不能被 UI 简化成“同一个失败”。反过来，一个 invocation 可以协助一条原回复而不产生第二个可见猫回答；这时 bubble-pipeline 通过 typed auxiliary execution 表示它，而不是复制文本。

## 用户看到的状态，应该如何说真话

F264 的 receipt 已给出正确的基本词汇：

| 用户可见阶段 | 事实含义 | 不应被写成 |
|---|---|---|
| 已接纳 / 排队 | 原消息已被系统接收，交付给某目标尚未发生 | “猫已收到” |
| 已唤醒 | 精确 child execution 已创建 | “猫已读” |
| 已读正文 | exact `seenAt` 已写入 | “已处理完成” |
| 已处理 | exact `handledAt` 或受支持的 typed terminal outcome 已写入 | “只是模型开始调用” |
| 已取消 | 作者撤回，且不再可被目标认知 | “失败后会自动继续” |
| 执行失败 | 精确 invocation 有可分类的失败结局，receipt 仍可说明原消息是否已读 | “你的消息投递失败”——除非交付本身确实失败 |
| 等待 / 需协调 | 某个外部条件或责任转移仍未终局 | “队列里有一条普通可继续消息” |

这张表也回答了最初的体验问题：“报错为什么不在上面的消息气泡？”

- 如果失败的是把**这条用户消息交给特定目标**的过程，回执必须附在这条原始消息上，并指向目标和精确执行。
- 如果失败的是目标已经读过消息后的**一次执行**，原消息 receipt 与 execution failure 必须并存：前者保留“已读/未完成”的事实，后者说明处理为什么没有成功、是否可重试。
- 如果失败的是**内部等待或责任处置**，它不应占用普通 Queue action surface；应在可展开的系统状态或相关工作/等待卡上显示，并精确指出该等待对象。
- 任何“继续”“重试”“取消”按钮都必须有其所操作的 exact object；没有对象，就不展示动作。

## #1354 暴露出的断裂

这次 UI 显示“队列已暂停 · 0 · 当前调用失败”的直接机制已在当前代码中复核：

1. `QueueProcessor` 将暂停记录在 `(threadId, catId)` slot 上，但 thread 级 `isPaused(threadId)` 判断只要求“这个 thread 存在某个暂停 slot”加“该 thread 存在任意可调度 Queue 工作”。它没有证明那条工作属于该暂停目标，也没有证明它是这次失败可恢复的对象。
2. `QueuePanel` 以 receipt action projection 过滤掉已经 handled、withdrawn，或已 seen 且目标仍活跃的条目；这个过滤是对的——它防止 QueuePanel 变成第二份历史记录。
3. 但面板外层仍以原始 `queue.length` 和 thread 级 `queuePaused` 决定显示。因此，所有原始条目都被正确隐藏后，仍可能显示暂停框与 `0`。
4. 一旦用户点击“继续”，入口按 thread 处理 Queue，而不是先确认“这个暂停 slot 是否有与之匹配、仍可恢复的 entry”。这会把“解释一个失败”错误地变成“尝试推进同 thread 的别的工作”。

所以它不是“错误没有显示在聊天气泡”这么窄：**失败的归属范围、可操作工作的归属范围、UI 展示范围使用了不同键，随后被 threadId 粗暴汇合。**

本次样本还表明，受管等待的 invocation-bound disposition 与普通 Queue message 共享了一部分运行时管线。F167 的明确边界是正确的：受管 hold 只能由 callback-authenticated、精确来源/任务/thread/holder 坐标匹配的 disposition 终局；任务不匹配必须 fail closed。需要整改的是 fail-closed 后的可观察性和 UI 隔离，而不是放宽匹配条件，或让一个泛化的 Queue “继续”替它做恢复。

## 设计原则：先保持层次，再改善体验

1. **一条状态只服务一个问题。** 不让 Queue active/paused 同时表示 provider failure、用户待办、A2A 责任和内部 wake 异常。
2. **所有投影都保留 exact identity。** thread 可作分组，不能作归因；恢复动作至少必须绑定 target、entry 和失败执行。
3. **回执说明事实，行动说明权限。** “已读”“失败”“等待”是事实；“重试”“继续”“取消”是可用动作，两者不能相互推导。
4. **不新增第二份持久账本。** 普通 queued message 仍由 Queue custody / per-target receipt 负责；A2A responsibility、wait、freshness supplement 各留在既有 owner。整改应增加 derived read model 和投影契约，而不是复制数据。
5. **恢复必须窄且幂等。** 一次操作只恢复它声称要恢复的对象；stale / replaced / cross-target action fail closed，并给出可诊断的原因。
6. **输出提交与外部送达分开。** 已提交的回答不能因为 connector 重试或补充回答失败而被撤回、重发或伪装成“还在处理中”。
7. **没有可靠证据，不显示确定语气。** 禁止从正文、日志文本、时间相近或 queue length 猜“已读”“已完成”“需要用户继续”。

## 分阶段整改建议

### 阶段 0：先把现有契约变成可测的端到端事实

不改数据模型，不引入新 Queue。先为每种入口建立同一份 trace fixture：

- 浏览器用户消息：闲置目标、忙碌目标、撤回、重启后恢复；
- connector 消息：规范化、已提交输出的 transport retry；
- 同 thread / 跨 thread A2A：单目标、多目标、终局 ACK 不再重新 enqueue；
- managed hold / command wake：成功消费、stale、跨 task、跨 holder、重启恢复；
- provider failure：正文未暴露、已暴露未完成、terminal silent、可重试与不可重试；
- 一个 thread 同时有多个目标、多个 queue entry 和一个暂停 slot。

每份 fixture 的断言不是“接口返回 200”，而是：每一个 `messageId × targetCatId × queueEntryId × invocationId` 的状态变化可解释；F5 hydration、socket live update 和 action projection 得到同一结论。

### 阶段 1：补一个只读的“精确恢复资格”投影

把 Queue 面板需要的事实收敛为一个 derived projection，例如 `QueueRecoveryCandidate`；它不是新的 canonical store。最少字段为：

```text
threadId, targetCatId, queueEntryId, messageId,
failedInvocationId, failureClass, retryEligibility,
receiptState, pauseSlotKey, updatedAt
```

生成条件必须是交集，而非并集：

```text
同一 thread
AND 同一 target slot
AND 该 entry 仍可调度
AND receipt 未终局
AND 失败 / 暂停确实由该 candidate 的精确 invocation 造成
AND 当前 generation / custody 仍允许恢复
```

若交集为空，thread 可以有一条诊断记录，但不得产生“队列已暂停”或“继续”动作。这样既解决 `0` 计数矛盾，也避免全局/同 thread 误重放。

### 阶段 2：把三种不同的失败放回正确界面

| 失败类别 | 主展示位置 | 用户看到的最少信息 | 允许动作 |
|---|---|---|---|
| 普通消息的 delivery / execution failure | 原消息的 receipt / lineage | 目标、发生阶段、是否读到正文、可否自动恢复 | 仅 exact retry / cancel（若契约允许） |
| provider 配额、暂时不可用等 invocation failure | 该 invocation 的状态卡，并由原消息 receipt 链接 | 可读的失败类别、影响范围、下次自动恢复或替代路径 | 不把无关 Queue item 当重试对象 |
| managed hold / wait / action-custody mismatch | 对应等待或工作状态卡 | 等待的对象、为何不能消费、是否需系统 reconciliation | 不显示普通 Queue “继续” |

QueuePanel 保持“可采取动作的排队工作”这一职责：`visibleEntries.length === 0` 时，应整体隐藏 action panel，或显示一个没有主操作的、明确标为系统诊断的状态条；绝不能显示 `0` 与可恢复动作并列。

### 阶段 3：为受管等待增加受控 reconciliation

对于 invocation-bound disposition 不匹配的对象，保持 fail-closed，但增加一条 server-owned reconciliation 路径：

- 重新读取 source / task / thread / holder / generation，不信任调用方传入的宽泛定位；
- 区分“旧 wake 已被新 generation 取代”“来源任务已终局”“存储不确定，等待启动恢复”“真正缺少终局 producer”；
- 只在前两类能被权威记录证明时终局或退役；不确定时保留隔离状态并上报；
- 不通过 `processNext(threadId)`、自由文本或任意 task 完成去清除它。

这是对 F167 已有精确边界的可观察性补足，不是给 managed hold 增加一条旁路消息或第二个 receipt ledger。

### 阶段 4：逐步切换与回归门槛

1. 先在只读 shadow projection 中计算 candidate，与现有 `isPaused` 对比，记录 disagreement；不改变 dispatch 行为。
2. 为 `QueuePanel` 加 fixture：raw queue 非空、action projection 为空、存在无关 paused slot 时，面板不显示可恢复态，计数和动作一致。
3. 在 API 层拒绝缺少 exact candidate 的 manual continue；前端同一时间只操作来自 API projection 的 candidate。
4. 等端到端 fixture 和生产样本都证明无误后，再替换 thread 级 UI pause 聚合。旧投影保留短期 telemetry，不同时保留两套写入真相。

## 验收矩阵

| 编号 | 场景 | 必须成立的结果 |
|---|---|---|
| A1 | queue 条目被撤回 | 作者与猫的视图都不再把它当可交付工作；不进 prompt |
| A2 | queued message 仍未被目标读到 | 原消息可见但 receipt 不称“已读”；cat context 不含正文 |
| A3 | 一个目标已读，多目标中的另一个未读 | 两个 receipt 独立；不聚合为“已处理” |
| A4 | provider 在正文暴露前失败 | 原消息明确未被该目标读取；无伪造的猫回复 |
| A5 | provider 在正文暴露后失败 | 原消息保留“已读”；精确 invocation 显示失败，不能说投递失败 |
| A6 | terminal silent | 在原消息/lineage 显示 typed system outcome，不生成空猫气泡 |
| A7 | 同 thread 有失败 slot 和无关 queue entry | 不产生 `0 + 当前调用失败`；继续不会推进无关 entry |
| A8 | 同 slot 有精确可恢复 entry | action 精确绑定 entry / target / generation，幂等 |
| A9 | 条目已 handled 或目标仍在处理 | Queue action projection 不把它再显示为待处理历史 |
| A10 | API 重启 | Queue 从 durable custody 确定性恢复；不可用 aggregate success 冒充 per-target read |
| A11 | A2A 同一来源发给多目标 | 每目标投递/失败/终局独立，且终局 ACK 不二次 enqueue |
| A12 | stale managed hold disposition | fail closed，停留在等待/reconciliation 域，不污染普通 queue |
| A13 | 跨 task / holder / thread completion | 被拒绝且有可追踪 reason；不得清除别人的等待 |
| A14 | connector 对已提交回答重试投递 | 重试 delivery，不重新生成/撤回原回答 |
| A15 | F5 与 socket 同时更新 | receipt、bubble、Queue action 结论收敛，不靠文本猜测 |
| A16 | 无 candidate 的暂停诊断 | 无“继续”按钮；状态说明不归咎于用户消息 |

## 这次审计明确不做什么

- 不把所有消息、所有 A2A、所有 wait 都塞进 `InvocationQueue`；
- 不用新的全局状态机替换已存在的 MessageStore custody、TurnExecution、ActionSuccessor 或 AwaitState；
- 不因为 UI 难解释，就放宽 invocation-bound completion 的 fail-closed 条件；
- 不从 provider 文本、控制台日志或 timestamp proximity 推导业务终局；
- 不把 internal receipt、reconciliation failure 或系统 diagnostic 伪装成某只猫的自然语言回答；
- 不先改一个文案就关闭 #1354。若 exact recovery scope 未得到证明，文案再友好也是误导。

## 需要在实现前做出的产品决定

以下不是技术 A/B 题，需在本审计经内容评审后，用用户体验与责任边界来拍板：

1. provider 配额/不可用时，用户要看到“系统将自动在何时重试”，还是必须显式选择继续？前者降低打扰，后者给予控制；两者都不能牺牲 exact object binding。
2. 无 action 的内部协调异常，是默认收在可展开的“系统状态”中，还是在当前 thread 顶部展示一个非阻塞摘要？前者更安静，后者更可发现；无论选择哪一种，都不应占用 Queue action panel。
3. 当原消息已读但一次执行失败时，原气泡下的状态应显示到什么粒度？建议默认是阶段 + 可读原因 + 下一步，精确 invocation ID 留给“查看诊断”，避免把内部术语推给用户。

## 代码与文档来源地图

| 主题 | 现有 owner / 入口 |
|---|---|
| 浏览器消息接纳和 queue admission | `packages/api/src/routes/messages.ts` |
| A2A message append、行首 @ / targetCats 路由 | `packages/api/src/routes/callbacks.ts`、`packages/api/src/routes/callback-a2a-trigger.ts` |
| Queue 排序、暂停、恢复 | `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts`、`QueueProcessor.ts`、`packages/api/src/routes/queue.ts` |
| durable queued-message custody 与 per-target receipt | `QueuedMessageCustodyCoordinator.ts`、`QueuedMessageCustodyStartupReconciler.ts`、`queued-message-custody.ts`、`queued-message-receipt.ts`、`queue-receipt.ts` |
| child execution ledger | `TurnExecutionStore.ts`、`TurnExecutionStartupReconciler.ts`、`invoke-single-cat.ts` |
| Queue action rendering | `packages/web/src/components/QueuePanel.tsx`、`queue-receipt-projection.ts` |
| message bubble / receipt hydration | `MessageReceiptDock.tsx`、`useChatHistory.ts`、`useSocket.ts`、bubble reducer |
| typed wait、action successor、responsibility lifecycle | `docs/architecture/ownership/cells/ball-custody.md`、F167、F280 |
| output commit and connector transport | `docs/architecture/ownership/cells/transport.md`、ADR-041、ADR-042 |

## 下一步

先对这份审计做一次跨家族、零上下文内容 review：检查它是否漏掉入口、把 historic 契约当成现状，或把三种责任对象错误合并。通过后，以 #1354 为第一条 implementation issue，按“阶段 0 → shadow projection → UI / API gate → rollout”推进；任何阶段若发现需要新持久化真相源，应暂停并单独开 architecture decision，而不是在 QueuePanel 或 QueueProcessor 里堆一层兼容分支。
