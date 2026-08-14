---
title: "Thread 消息、处理与协作闭环：终态重构 RFC"
description: "定义消息路由、排队、成员处理、父责任、并行分支、失败回归与用户可见回执的完整 thread 生命周期；以 #1354 为入口，先定流程再定实现。"
doc_kind: architecture
feature_ids: [F039, F117, F122, F167, F175, F177, F185, F194, F233, F254, F264, F275, F277, F280]
topics: [message, delivery, routing, queue, invocation, handoff, responsibility, receipt, lifecycle, observability]
created: 2026-08-13
updated: 2026-08-14
status: proposed
author: "砚砚/codex@gpt-5.6-terra"
related_issue: 1354
related_docs:
  - docs/features/F117-message-delivery-lifecycle.md
  - docs/features/F167-a2a-chain-quality.md
  - docs/features/F194-invocation-liveness-canonical-read-model.md
  - docs/features/F233-ball-custody-observability.md
  - docs/features/F254-side-effect-freshness-gate.md
  - docs/features/F275-managed-work-admission-identity.md
  - docs/features/F277-thread-attention-navigation.md
  - docs/architecture/ownership/cells/dispatch.md
  - docs/architecture/ownership/cells/bubble-pipeline.md
  - docs/architecture/ownership/cells/ball-custody.md
  - docs/architecture/ownership/cells/managed-work.md
  - docs/architecture/ownership/cells/thread-navigation.md
  - docs/architecture/ownership/cells/transport.md
---

# Thread 消息、处理与协作闭环：终态重构 RFC

> **这是什么**：一份先定义 thread 如何推进、再约束实现的 RFC。它回答“消息是谁发的、谁处理、谁仍对结果负责、何时唤起、失败怎么办、多人如何收敛”，不是给现有 Queue 再叠一层状态机。
>
> **为什么现在做**：[#1354](https://github.com/zts212653/clowder-ai/issues/1354) 中出现“队列已暂停 · 0 · 当前调用失败”以及“队列有消息但无人执行”。这不是一个提示位置问题；它说明消息、队列、正在执行的 Run 和协作责任没有被同一条可追溯因果线约束。
>
> **本文边界**：本文先固定产品生命周期与现有对象的职责。实施设计必须从这份流程反推，不能以当前某个 `Projection`、fallback 或短路分支为前提倒推流程。

## 决策

1. #1354 不以 `QueuePanel` 文案、计数或 `isPaused` 的局部修补关闭；它是完整 thread 生命周期重构的入口证据。
2. 一位成员 A 请求 B 或 B/C 处理，并不让 A 的闭环责任消失。B/C 是 A 创建的处理分支；A 只在所需分支给出可接受结果，或 A 自己明确处置失败后，才算结束。
3. 所有新消息先持久化、再按目标排队。某位成员正在执行，绝不是丢弃、短路或“已经处理了”随后到消息的理由。
4. `@co-creator` 先经过 durable intent 判定：只有可行动的 `handoff` / 请求 / gate 才建立 human branch；`fyi` 与 `done-notify` 只是可见通知，不建立 human inbox，也不阻塞父责任。human branch 与猫分支使用同一套可观察的生命周期；差别只是 human 不经历 provider Run，而是等待回复、确认、批准、拒绝或超时。
5. 不新增一个抽象的 `WorkUnit / Assignment / AuthorityGrant / ThreadContinuationProjection` 总账本。现有消息、Queue entry、invocation/TurnExecution、`ActionSuccessor`、`AwaitState`、F233 custody 的精确事实仍各自归其 owner；需要补的只是它们之间的**父责任与分支关联**及其原子状态转换。
6. 这是客户端应用的一次目标模型切换，但绝不把仍在处理的已接纳工作直接降为历史：发布门必须先让旧运行时 quiescent drain；只要仍有 queued、processing、wait 或 custody record，切换就中止并保留旧 executor 继续处理。只有所有旧记录终局后，后续**新消息**才按本 RFC 建立新链路。无需为终局历史构造运行时兼容、迁移或猜测性补链。

## 先分清五件不同的事

一个 thread 是持久上下文和事件容器，不是一组常驻 worker。成员是被消息或精确恢复候选被动唤起的；成员结束一次 Run 后，不会继续在后台观察 thread。

| 问题 | 权威事实 | 不能替代它的东西 |
|---|---|---|
| 消息是谁发的、内容何时可见？ | `MessageStore` 的 message、author、visibility、时间线 | queue 计数、最近参与者 |
| 这条消息要由谁处理？ | 该消息的解析目标与每目标 receipt / Queue entry | thread 有成员、某猫曾经说过话 |
| 某位成员现在是否正在执行？ | F194 live invocation / `TurnExecution` | 一条 queued message、历史回复 |
| 谁仍须保证一件协作事有结果？ | 父消息/父处理链的责任人和未结算分支 | B 已被 @、自然语言 ACK、`participants` |
| 谁可以恢复一个具体等待或动作？ | `ActionSuccessor` / `AwaitState` / F233 custody 的 exact holder + generation | thread-wide Continue、任意最近发言者 |

“可见”“被路由”“已入队”“已开始”“给出结果”“父责任已结算”是六个不同状态；UI 和恢复入口不能把它们合并成一个 thread-wide `blocked`。

## 最小语义：消息链、处理分支和父责任

本文只定义三层关系，实施可复用既有耐久对象承载它们，不预设新表、新数据库或新的权限系统。

```text
Message
  └─ 每个 target 的 delivery receipt / Queue entry
       └─ 一次或多次 Run（真实读取和执行）

父消息或父处理链（A 负责闭环）
  └─ Branch B（B 的处理、结果或失败）
  └─ Branch C（C 或 human participant 的处理、结果或失败）
       └─ branch result 回写为父链的结算证据
```

### Message 与 receipt

一条消息可有多个显式 target。每个 `messageId × targetId` 都有独立 receipt：`accepted → queued → processing → responded | failed | canceled`，并连到精确 `queueEntryId` 与 `invocationId / turnExecutionId`。它只回答“这个 target 是否处理了这条消息”，不回答整个协作是否结束。

`processing` 只证明 child Run 已创建，**不证明正文已被读到**。正文暴露是 receipt 上独立、append-only 的事实：`bodyExposure(messageId, targetId, invocationId, seenAt)`。因此同一个 `processing → failed` 可以是暴露前失败或暴露后失败；前者必须显示未读，后者保留已读事实。不得从 Run 创建、provider error 或最终结果倒推 `seenAt`。

### 父责任（closure responsibility）

当 A 对用户消息开始处理时，A 是该处理链的父责任人。A 可以直接答复，也可以发出 A2A/human 请求建立分支。父责任始终带着：

```text
rootMessageId / parentMessageId
responsibleActor = A
completionPolicy = direct | all_of(children) | explicit policy
open branch ids
latest disposition evidence
```

这是**关系和最小字段**，不是另一个万能业务对象：

- 普通投递仍由 Message receipt 和 `InvocationQueue` 裁定；
- 正在运行仍由 F194 / `TurnExecution` 裁定；
- 等待和外部动作仍由 `ActionSuccessor`、`AwaitState`、F233 custody 裁定；
- 只有“此结果属于哪个父处理、它是否已满足父处理的结束条件”必须成为耐久、可 CAS 的关联。

### 分支（branch）

一个分支记录 A 请求某个 target 做什么、它关联哪条消息、当前是否已被接纳、以及结果是否可用于结算父责任。最小状态为：

```text
planned → queued → processing → responded | failed | rejected | expired
                                         └─ settled into parent
```

`queued` 表示已经有精确候选但 target 尚未开始；`processing` 只在该 target 的 Queue entry 被取走并创建 Run 后出现；`responded` 必须带可引用的结果/回复 message 或 human decision。自然语言“我来看看”和 target 被 `@` 都不是 `responded`。

分支的 target 可以是猫、co-creator 或其他 human participant。human 分支只由持久化为可行动 `handoff` / request / gate 的意图建立；现有消息模型不足以可靠区分时，不能凭一个 `@co-creator` 猜出待办。`fyi` 和 `done-notify` 保留为消息/receipt 事实，但不创建 pending-human inbox、不参与 join、也不让父链等待。真正的 human 分支不创建 provider Run，但一样经历 `planned → queued/pending_human → responded | rejected | expired`，也一样向父责任提供可观察结果。

## 输入路由和入队

### 用户没有明确 @：保持现有“继续上一位”的策略

本文撤回此前“没有明确 @ 的用户消息必须新建 routing work、绝不回退到最近发言者”的表述。现有 `AgentRouter` 的实际次序应被保留并由测试覆盖：

1. 当前消息有有效 `@`：路由到这些显式 target；
2. 没有 `@`：在最近五条、且一小时内的**用户消息**中，继承最近一次有效 @ 的第一个可路由成员；
3. 仍无该候选：选择 thread 中最近的健康回复者——即用户通常理解的“刚才在和谁说话”；
4. 再不具备历史时，才落到已有 `preferredCats` / 默认成员策略。

这条规则只解决“新的用户输入初始交给谁”。它不使该成员成为所有未结协作的责任人，也不把 thread participants 当运行时 owner。

### 所有新消息默认入队

对每个解析出的 target，系统先写 message 与 receipt，再创建可追踪的 Queue entry。执行器只从 Queue entry 取得工作；不能因为 target 已在运行、thread 有活跃 invocation、或某项旧工作正在等待，就丢弃、合并为“已覆盖”、或直接判为完成。

```text
new message
  → persist message + target receipts
  → create Queue entry per target / branch
  → target slot 空闲时 dequeue
  → create Run and mark processing
```

同一 thread 中不同成员可并行执行；同一成员在同一 thread 的 processing slot 只有一个。故 B 正在处理时，新投给 B 的消息保持 queued；投给 C 的消息可在 C 的 slot 空闲时执行。当前 A2A 的“所有目标正 active 就直接 skip”必须删除，改为同样的持久入队语义。

### 猫消息与 human 消息的区别

- A 发给 B/C 的明确 @ 消息，既是可见消息，也是由 A 创建的一个或多个分支；各 branch 各自入队。
- B 的结果消息首先结算 B branch，并作为 A 父链的结算证据；它不是一条无 @ 用户消息，因此不走“最近回复者”回退。
- co-creator 的确认/批准/拒绝同样结算对应 human branch。它不自动唤起模型，但需要给 A 父链产生可追踪的状态变化。单纯 `@co-creator` 的 FYI 或完成通知只交付为可见消息，不制造一个虚假的人类待办。

## 父责任的完整生命周期

### 1. A 开始处理

用户消息入队后，A 的 Queue entry 取走并创建 Run。A 成为该条处理链的父责任人，直到其直接回答、所有必要分支结算，或 A 明确把它置入一个有 owner 的等待/升级状态。

### 2. A 请求 B、C 或 co-creator

A 的输出中出现猫 target，或 human target 已被判定为可行动 `handoff` / request / gate 时，系统原子地：

1. 持久化 A 的请求消息及其 source/parent 关系；
2. 为每个 target 创建一个 branch 和对应 target receipt；
3. 把 branch 放入该 target 的 Queue（human 则进入 pending-human inbox）；
4. 把分支 ID 写回 A 的父处理链。

此时 A 的 Run 可以正常结束，但 A 的**父责任不结束**。它进入 `waiting_for_children`，由这个父链和 branch 状态被动地再次唤起，而不是让 A 常驻观察。

若 human mention 是 `fyi` 或 `done-notify`，只持久化/投递该通知及其 intent provenance；不执行上述第 2–4 步。若 intent 无法可靠判定，也不能先建 branch 再以 timeout 修正：必须保留为非行动通知或要求发送者显式标明 intent。

### 3. B/C 接受并处理

target 的分支只有在从 Queue dequeue 后才是 `processing`。B/C 完成时必须产生可引用结果：回复、结构化 outcome，或 human 的确认/批准/拒绝。结果先写 branch，再作为父链的结算证据。

provider 的短暂错误可在 B branch 内按配置进行、带幂等/副作用核对的退避重试；这只是同一分支的 Run retry，不是 A→B 的责任转移。达到次数或时间上限、不可重试错误、结果不可对账或 admission 被拒后，branch 进入 `failed`。

### 4. 父链收敛

默认的多个 @ 是 `all_of`：A 同时请求 B 和 C，只有 B、C 都以可接受结果结算，A 的父责任才完成。已成功的 B branch 保持成功证据；C 失败不抹掉 B 的结果，也不能让 A 自动结束。

分支的 join policy 必须由消息意图或产品策略显式表达：

| policy | 父责任的结算条件 |
|---|---|
| `direct` | A 自己给出最终回复/结果 |
| `all_of`（多个普通 @ 的默认） | 每个必需 branch 都 responded 且结果可接受 |
| `any_of` / `first_success` | 首个合格 branch 后，取消或明确处置其余 branch |
| `gate_then_dispatch` | human gate 成功才创建/释放 child branch；拒绝或超时回到 A |
| `quorum(n)` | 达到 n 个合格结果，余项仍需明确取消或保留其继续理由 |

不需要 A 再跑一次模型才能结算“所有 branch 已按既定条件成功”的机械事实；但只要结果需要解释、选择、验证、替换目标或升级，系统须创建 A 的精确 continuation，让 A 用已带齐的 branch 证据继续处理。

### 5. 失败回到父责任，而不是倒转 transfer

此前版本写的 `B(v) → A(v+1)` reverse transfer 不再成立：A 从未把闭环责任移交给 B。

```text
B retry exhausted / rejected / expired / result indeterminate
  → B branch = failed
  → parent A = actionable continuation (with exact evidence)
  → A reroute to D, request co-creator decision, revise scope, or suspend with a named disposition owner
```

若 A 选择 D，创建的是新的 D branch；B 的失败和已完成的其他 branch 保留审计。A 若无权或无法继续，只能进入带 `dispositionActor + nextCheckAt + policy` 的明确等待/升级，绝不能留下 thread-wide `blocked` 或无对象 Continue。

### 6. A 的责任何时结束

A 只在下列任一条件成立时结束：

1. A 直接发布了与原请求相匹配的可见结果；
2. 父链的明确 join policy 已由所有必要 branch 的结果满足；
3. A 用可见、可恢复的处置把工作交给一个已定义的外部流程，并记录了确切 holder、下一检查时间和用户可见状态。

“B 已开始”“B 被唤起”“B 的 Run 成功但未提交结果”“队列暂时为空”均不能结束 A。

## 新消息到达时的策略

### 默认：独立消息，独立排队

无论 thread 是否有人 processing，新消息都是新的 durable message，并按正常路由建立自己的 receipt/Queue entry/父责任。它不会偷偷注入正在执行的 prompt，也不会因为某位成员 active 就被吞掉或视作已处理。

### 仅用户可选的 append

`append` 是用户输入策略，不是 A2A 的隐式便利。用户可以明确将一条新消息附加到一个**自己正在等待的同一处理链**；系统必须记录 `appendMessageId → root/branch id`，且：

1. 这条输入仍是完整、持久的用户消息；
2. 它不单独路由给其他成员，也不创建他们可独立消费的 receipt；
3. 它只属于被选中的当前 target/处理链；
4. 若该 Run 尚未建立不可变的输入快照，append 可组成同一批输入；
5. 若 Run 已开始读取，绝不把正文静默注入模型。append 留在该处理链的 pending input，在当前 Run 结束后由**同一 target**以该链的下一次 Queue entry 处理；父链在 append 被消费前不得按旧输入终局结算；
6. append 失败、取消或 target 不再可用时，回到该父链的责任人处置，不能扩散给其他 participants。

现有 `MessageStore` 的 `merge: 'append'` 是 composer draft recall，不是运行中处理链 append；它不能被误用来声称这项语义已经实现。

## 每次唤起必须带什么，退出必须留下什么

成员不是常驻监督者，所以每个 Queue entry/continuation 都要能自己说明为何现在轮到它：

```text
trigger: messageId / branchId / await successor
parent responsibility: rootMessageId, responsibleActor, join policy
target task: 目标、所需结果、输入快照与 append 状态
branch ledger: 同级 branch 的 terminal evidence 与仍待事项
failure evidence: retry/outcome/side-effect reconciliation
allowed action: reply, create branch, reroute, ask human, suspend, cancel
```

这是一份从现有耐久事实组成的 Situation Packet，不是新的真相库。相反，每次 Run 正常退出必须原子留下以下之一：

- 对自己的 message/branch 的可引用结果；
- 创建的 child branch 及仍由自己承担的父责任；
- 精确 `ActionSuccessor` / `AwaitState` / custody holder；
- 失败及已安排的 retry；
- 父责任人的 continuation。

任何 exit path 都不得只把 Queue item 标记成功而没有对应 branch/parent 结算；这正是 #1354 中“模型跑完但后文消失”的类问题。

## 现有对象怎么承载，不怎么叠层

| 现有对象 | 保留职责 | 本次需要的连接/改造 |
|---|---|---|
| `MessageStore` + Queue custody receipt | 正文、作者、时间线、可见性、消息关系；child creation 与精确 `bodyExposures.seenAt` | message 与 parent/root/append 的明确关联；receipt 将 body exposure 作为独立事实，历史消息不补链 |
| `AgentRouter` | 显式 @、最近用户 @ 继承、最近健康回复者、preferred/default 的初始目标选择 | 路由决策输出可引用的 target 与来源；不再以“无 @ 无 owner”替代既有回退 |
| `InvocationQueue` | 每 target 的 queued/processing candidate 与单成员 slot | 所有 active-target 新消息仍入队；删除 “active target 已覆盖所以 skip” 语义 |
| F194 invocation / `TurnExecution` | 真实 live Run 与 terminal execution outcome | Run outcome 只更新自己的 receipt/branch，不能直接判父责任完成 |
| `ActionSuccessor` / `AwaitState` / F233 custody | 精确等待、动作 holder、generation、human handoff intent 与恢复 | 父责任/branch 的 pending state 必须引用 exact holder 和 `handoff` intent，而非 thread pause 或裸 mention |
| UI projection | 从上述事实汇总现场 | 仅为可重建 read model；不成为责任、队列或恢复权威 |

因此不保留 `ThreadContinuationProjection` 作为新增 canonical contract，也不引入通用 `AuthorityGrant`。执行副作用所需权限继续由既有 freshness/approval/custody 契约决定；本 RFC 只要求其 outcome 能回写相应 branch 和父责任。

## 用户界面应当显示什么

| 用户的问题 | 正确归属 |
|---|---|
| “我这条消息被谁处理、有没有读到？” | 原消息的 per-target receipt / invocation lineage |
| “A 正在等 B 和 C，谁完成了？” | A 的父消息/协作状态卡：branch 名称、状态、join 条件、下一位责任人 |
| “B 失败后现在谁该动？” | A 的 exact continuation，含 B 的失败证据和可操作的 reroute/escalate/suspend |
| “我被请求确认或批准什么？” | human branch 的待办卡；确认/拒绝后回写 A 的父链 |
| “队列里什么能继续？” | 只列精确 queued candidate；没有 candidate 就没有 Continue |
| “这个 thread 为什么看起来停住？” | 派生现场摘要，可链接到具体 message/branch/await；不得显示无对象的泛化 `blocked` |

故最初截图中“队列已暂停 0”与“当前调用失败”不能并列制造一个无法行动的 Continue。失败必须挂回原 receipt、具体 branch 或 exact await；队列只显示可以真实取得的 item。

## #1354 证明的当前断裂

已记录到 issue 的证据至少包括：

1. Queue 已停、候选数为 0，UI 仍给 thread-wide “当前调用失败”和 Continue；
2. Kimi 的 Run 看似结束，但 managed-hold disposition 与 QueueProcessor 的成功提交彼此冲突，entry 恢复 queued 后 thread 被标记失败；
3. 外部 PR approval 被错误地当作给 Kimi 的可执行输入；
4. A2A 回调在 target 已 active 时存在直接 skip 的路径。

它们有共同根因：用 thread 或 live slot 的泛化状态替代了“哪条消息、哪个 target、哪个 branch、哪个父责任”的精确状态。实施前必须用这份模型把入口、运行、退出、恢复和 UI 一起重建。

## 切换与实施顺序

### 运行时切换边界

这不是“部署时把所有旧对象归档”。发布 preflight 必须列出每个非终局的旧 message target、Queue entry、Run、wait 和 custody record，并先关闭旧模型的新 ingress。只要清单非空，旧 executor 继续按旧语义 drain；release 不切换，且不得删除其恢复入口或把它交给新模型猜测处理。若 drain 超时或遇到不能安全终局的记录，取消本次切换、保留旧运行时和诊断，待既有 owner/recovery 流程完成后再重新 preflight。

只有清单为空时，才允许原子切到新入口并让后续消息以本文的 root/branch/receipt 关系建立新链路。终局旧消息、旧回复和诊断保持历史可读，但不被猜测性迁移或双模型运行时解释；因此没有 hot update，也没有旧/新并行裁定期。

### 建议实现顺序

1. 写纯状态转换测试：无 @ 路由、父责任、branch join/failure、active target 入队、append fence；
2. 为 Message/receipt/Queue 与父/branch 关联补最小耐久字段和 CAS transition；
3. 重做 Router/Queue/A2A callback：所有新输入入队，A2A 分支永不因 active 而 skip；
4. 将 Run 终局接到 branch result 与父责任 continuation，而非 thread-wide pause；
5. 将 human approval/confirm 接成相同 branch；
6. 最后替换 QueuePanel、气泡 receipt 和协作状态卡，删除无对象 Continue；
7. 在隔离数据环境跑并发、重试、重启、append 与 quiescent-drain 验收；只有 preflight 对全部旧记录给出零非终局清单，才移除旧 thread-level 运行时裁定。

## 验收矩阵

| ID | 场景 | 必须证明 |
|---|---|---|
| L1 | 用户无 @ 继续对话 | 先继承最近有效用户 @；否则到最近健康回复者；不会落入无 owner |
| L2 | B 正 processing，用户又 @B | 新 message/receipt/Queue entry 存在且保持 queued；不会被 active 短路 |
| L3 | A @B | B dequeue/processing 不让 A 结束；B 的可引用结果才可结算 A |
| L4 | A 同时 @B、@C | B/C 可并行；默认 `all_of`，二者成功才结算 A |
| L5 | B 成功、C provider retry 耗尽 | B 证据保留；C failed；A 获得 exact continuation，能换 D 或升级 human |
| L6 | A 以 `handoff` / request / gate @co-creator | human branch 有 pending、approve/reject/timeout；其状态和 A 的责任可见，不创建 provider Run |
| L6a | A `@co-creator` FYI 或完成通知 | intent 被持久化为 `fyi` / `done-notify`；消息可见，但不产生 human inbox、open branch 或父链等待 |
| L7 | B 结果需要 A 判断 | B responded 后 A 被唤起，不由 B 的 Run 成功偷关父链 |
| L8 | `any_of` 首个成功 | 父链按政策结算，其余 branch 有显式 cancel/continue disposition |
| L9 | 用户在 active chain 选择 append，快照尚未建立 | 新消息持久化但只成为同 target 的同批输入，不路由给其他成员 |
| L10 | 用户在 active chain 选择 append，Run 已读输入 | 不注入当前 prompt；同 target 的后续 Queue entry 消费 append，父链不得提前终局 |
| L11 | Queue/Run/hold 任一退出竞态 | 每个 terminal path 要么写 exact branch/parent outcome，要么保留可恢复 candidate；不会出现“队列 0 + 无对象失败” |
| L12 | 进程重启 | 从 message、receipt、Queue、branch、await/custody 重建现场；不依赖内存 projection 或最近参与者猜测 |
| L13 | Run 在正文暴露前或后失败 | 两个 receipt 都连到同一精确 invocation，但只有暴露后有 `bodyExposure.seenAt` / 已读；UI 不从 `processing` 或 failed 猜测 |
| L14 | 切换 preflight 遇到旧 in-flight work | 切换被阻断，旧 executor 与恢复入口继续服务并 drain；只有零非终局清单才允许新入口启用，绝不把 admitted work 降为历史 |

## 非目标

- 不是实现授权，不在本 RFC 中增加数据库表或重写每个 feature 的存储；
- 不是让所有成员常驻监听 thread；
- 不是把历史消息重新解释成新的协作 branch；
- 不是允许运行中的模型接收未审计的正文注入；
- 不是以 UI “继续”掩盖没有精确工作候选的后端状态。

## 代码与文档来源

- `packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts`：当前无 @ 的用户 @ 继承、最近健康回复者和默认 target 顺序；
- `packages/api/src/routes/messages.ts`：用户消息的 target 解析与 busy 时 queue 决策；
- `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts`：同 thread、同成员 processing slot 与 queued entries；
- `packages/api/src/routes/callback-a2a-trigger.ts`：当前 target active 时 skip 的待替换短路；
- `packages/api/src/domains/cats/services/stores/ports/queued-message-custody.ts`：child creation 与 append-only `bodyExposures(targetCatId, invocationId, seenAt)` 的独立耐久事实；
- `docs/features/F233-ball-custody-observability.md`：human `handoff` / `fyi` / `done-notify` intent 是 inbox/ball-custody 的必要区分；
- `packages/api/src/domains/cats/services/stores/ports/MessageStore.ts` 与 `RedisMessageStore.ts`：现有 composer-draft recall `merge: 'append'`，它不是本 RFC 的运行中 append；
- [#1354](https://github.com/zts212653/clowder-ai/issues/1354)：用户可见故障和运行时证据登记。

## 下一步

本文修订后，先由 maintainer 按这两个问题 review：

1. “父责任保留、branch 收敛”是否准确表达协作责任，而不是重新发明 ownership ledger；
2. “所有消息入队 + 仅用户显式 append”是否覆盖客户端的实际输入心智模型。

确认流程后，才基于本文做现有对象的最小实现映射、测试计划与拆分 PR；不回退到单点 hotfix。
