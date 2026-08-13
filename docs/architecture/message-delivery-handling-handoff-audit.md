---
title: "消息投递、处理与交接：终态重构 RFC"
description: "从消息发出、入队、被目标读取、执行、责任交接、等待、失败恢复到用户可见回执的端到端状态地图；以 #1354 为入口，定义单一终态模型和一次性切换边界。"
doc_kind: architecture
feature_ids: [F039, F117, F122, F167, F175, F177, F185, F194, F233, F254, F264, F275, F277, F280]
topics: [message, delivery, queue, invocation, handoff, custody, responsibility, work-unit, receipt, lifecycle, observability]
created: 2026-08-13
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

# 消息投递、处理与交接：终态重构 RFC

> **这是什么**：一份先把现有消息链路讲清楚、再定义单一终态模型的重构 RFC；不是另造一套 Queue 或状态机。
> **为什么现在做**：[#1354](https://github.com/zts212653/clowder-ai/issues/1354) 显示了“队列已暂停 · 0 · 当前调用失败”。界面给了用户一个失败结论，却无法指出失败的是谁、影响了哪条工作、现在能做什么。这不是单个提示位置不对，而是投递、执行、责任和展示四层的身份没有被一起守住。
> **本文结论的边界**：下文的“当前事实”由 `main@69f6ef7ad` 的代码、ownership cells 和现有 feature 契约交叉核对；终态设计待 maintainer 内容 review 通过后才授权实现。

## 决策请求：不是热修，而是一次终态切换

本 RFC 请求确认下面四件事：

1. #1354 不以 `QueuePanel` 文案、计数或 `isPaused` 的局部条件修补关闭；它是整个消息生命周期重构的入口证据。
2. 新客户端和服务端同时切到一个**单一目标模型**。不保留 thread-wide pause、宽泛的 `/queue/next` 手工恢复、旧/新双投影或长期 compatibility fallback。
3. 不做历史协议兼容，不等于删除历史。用户消息、已完成回复、责任记录和诊断证据必须保留；已有存量只走一次、可审计的转换或隔离，不让旧字段继续参与运行时裁定。
4. 实现可以拆成便于 review 的提交，但不能把“新旧模型同时写、靠 fallback 猜测”的中间态交付给用户。完成定义是所有入口和用户界面都只消费目标模型。
5. 非终局协作工作一律以 versioned `WorkUnit + Assignment + AuthorityGrant` 契约裁定；消息投递、
   Run 成功、自然语言 ACK 和 thread participants 都不得代替 transfer commit 或责任处置。

这份取舍适合客户端应用：我们控制客户端与服务端的发布节奏，因此不必背负无限期 API / UI 向后兼容；但持久的用户数据仍是产品契约，必须保住而不能借“无兼容”丢弃。

## 目标模型：一条消息有一条可信的因果线

目标不是将每一种协作对象压成一个万能 status，而是让每种对象只拥有一段自己的真相，并以精确 ID 串成同一条因果线。普通消息的交付因果线是：

```text
messageId
  └─ targetCatId
       └─ queueEntryId（一次排队/恢复候选）
            └─ turnExecutionId / invocationId（一次实际执行）
                 ├─ body exposure（是否真正读到正文）
                 └─ typed terminal outcome（该次执行的结果）

wait / action successor 仅通过 source + holder + generation 关联；
它们不成为这条普通消息的 Queue entry。
```

面向**普通消息对象**的客户端消费两个不同的只读视图：

- **Message receipt**：挂在原消息上，回答“哪个目标走到了哪一步、是否读到正文、这次执行结果是什么”。
- **Actionable queue**：只列出可立即操作的精确 Queue candidate；没有 candidate 就没有恢复按钮，也不借 thread-wide 失败显示一块空面板。

`threadId` 只负责把这些对象放进同一个对话，不再被允许把它们归因为同一次失败或同一个可恢复操作。
thread 级协作现场另由下文的 continuation projection 聚合；它不替代这两个对象视图。

## Thread 的完整生命周期：成员是被动唤起的，不是常驻监督者

上一节描述了**一条消息**的因果线，但它不足以说明协作为什么会停住：一只猫结束
invocation 后并不会继续在 thread 中观察；没有被明确唤起的成员也不会因为自己曾经参与过
thread 而自动看到新消息。因此，`Thread.participants` 和“上一条是谁说的”都只能说明历史或
组织信息，**不能说明谁正在工作、谁必须继续、或者下一次该唤起谁**。

这不是模型的缺陷，而是当前产品的执行模型：一个 thread 是持久的共同上下文和事件容器，
不是一组常驻 worker。每一次执行都必须由一个可证明的输入唤起；每一次退出都必须把尚未
终局的责任放进一个可再次唤起的 owner，而不是留在自然语言的尾句里。

### 先拆开四个容易混淆的问题

| 问题 | 权威回答者 | 绝不能用来代答的东西 |
|---|---|---|
| 谁曾参与这个对话？ | `Thread.participants`、消息历史 | 当前是否执行、是否有责任、是否应被唤起 |
| 谁**现在**在运行？ | F194 `getThreadLiveInvocations` / `TurnExecution` | pending message、任务 owner 或最近发言者 |
| 谁拥有一个尚未完成的行动或等待？ | `ActionSuccessor` / `AwaitState` / `BallCustody` 的 exact holder + generation | thread 成员列表、Queue 长度或 `activeInvocations` |
| 谁现在有一条可读、可处理的普通消息？ | `messageId × targetCatId` 的 receipt / Queue custody | “thread 有新消息”、某个猫曾经被 @、同 thread 的别的失败 |

F194 已经把“有没有活着的 invocation”收口为服务端 canonical read model；它是本设计的一个
输入，却不是 thread 协作的总答案。反过来，F233/F167/F280 已各自保存责任、转交和等待的
精确事实；它们也不能凭自己的 holder 推断一个猫已经在运行。终态必须同时保留这些边界。

### 协作的规范坐标：Thread、WorkUnit、Actor、Run、Assignment 与 Authority

普通消息的 receipt 只回答“这条内容是否被特定目标读到”；它**不是**“谁必须把这件事推进到
终局”的通用裁定。因此本 RFC 为全部协作路径补上下面的逻辑契约。它是一个语义层，不预先指定
一张新表或一个新数据库；实现可以让既有 `MessageStore`、Queue、`TurnExecution`、
`ActionSuccessor` 和 `AwaitState` 承载不同 kind 的事实。反之，若既有 owner 不能原子证明某个
字段，实施时必须增加该字段的耐久权威来源，不能用 continuation projection、消息正文或最近参与者
补推。

| 概念 | 严格含义 | 不能混同为 |
|---|---|---|
| **Thread** | 持久事件容器和可读的共同上下文 | 单一工作状态、单一责任人或常驻 worker |
| **WorkUnit** | 一件可独立验证生命周期、可交接/挂起/终局的工作；可由一条消息触发，也可引用多个消息 | 每一条聊天消息、一个 Queue row 或一次 invocation |
| **Actor** | 可被指派或授予权限的长期身份（猫、human participant 或受限系统 disposition actor） | 某一次模型调用 |
| **Run** | Actor 的一次短命执行，即 `TurnExecution` / invocation | Actor 的持续责任，或消息已经处理完毕 |
| **Assignment** | 带版本的“谁有推进义务”关系；非终局 WorkUnit 必须有 holder 或 disposition owner | `@`、已投递、已唤起、`participants` |
| **AuthorityGrant** | 对指定 scope 执行副作用、批准、取消或交接的权限 | Assignment；有责任不自动拥有所有权限，反之亦然 |

最小契约如下（字段可以由 typed owner 分别持久化，但 transition 必须共享同一版本/fence）：

```text
WorkUnit {
  workUnitId, threadId, kind, sourceRefs[], parentWorkUnitId?
  assignment { version, state: unassigned | offered | assigned | transfer_pending | suspended | resolved,
    responsibleActor?, dispositionActor?, nextCheckAt?, policyRef? }
  authorityGrants[], readinessPolicyRef, completionPolicyRef, joinPolicy?
}
```

任何非终局 WorkUnit 在任意时刻必须满足二选一：

```text
有 responsibleActor，承担推进义务
或有 dispositionActor + nextCheckAt + disposition/recovery policy，承担处置义务
```

`unassigned`、`offered` 与 `suspended` 不是“没人管”的同义词：它们都必须有明确的
`dispositionActor` 和检查时间。reconciler 只负责检测、重试已预授权的机械动作或创建证据；它
没有权力从聊天历史挑一只猫、发放新的 AuthorityGrant 或改变业务责任。

这也给“没有明确 @ 的用户消息”一个确定路径：消息先按 thread 的声明式 routing policy 分类。
若不能证明目标或工作类型，就创建一个 `routing` WorkUnit，由指定的 routing disposition actor
在 `nextCheckAt` 前处理；绝不回退到最近发言者、历史 participants 或“看起来最懂的人”。纯信息
消息可以只形成 delivery receipt 而不创建业务 WorkUnit；一旦产品承诺有人推进请求，就必须创建
可追责的 WorkUnit。

### Thread 不是一个标量状态，而是并发工作单元的叠加

同一 thread 可以同时有 A 正在执行、B 的普通消息尚未读、C 持有一个等待 CI 的责任。把它
压成 `active`、`paused` 或 `idle` 任一标签，必然丢失“谁该做什么”。因此不引入
`thread.status` 作为新的裁定账本；服务端只从既有 owner 构造可重建的
**Thread Continuation Projection（thread 续航投影）**：

```text
ThreadContinuationProjection(threadId, observedAt)
  liveExecutions[]       ← F194 canonical liveness + TurnExecution
  deliverableMessages[]  ← per-target receipt + Queue custody
  openWorkUnits[]        ← versioned Assignment, authority scope summary and join/gate phase
  recoverableFailures[]  ← exact failed invocation + exact candidate
  openCustodies[]        ← ActionSuccessor / BallCustody exact holder + generation
  activeWaits[]          ← AwaitState source + holder + generation + expiry
  managedWorkRefs[]      ← only an explicit F275 binding, otherwise absent
  materialTransitions[]  ← typed, attributable changes since a supplied cursor
  reconciliation[]       ← non-terminal object that has lost a safe next carrier
```

它是 read model，不是第二份可写 thread lifecycle 账本：任何一行都必须能回到上表的 source
object 或上述 WorkUnit/Assignment 契约；重建或暂时读不到 source 时必须显示 `unknown` /
`reconciliation_required`，不能把空数组解释为完成。`managedWorkRefs` 只是有明确绑定时的上下文
关联，绝不由 thread、任务、时间邻近或自然语言补推；F275 也不因此变成所有对话的 workflow owner。

投影的聚合结果应使用可并存的旗标，而非单一状态：

| 旗标 | 可证明的含义 | UI / 被唤起成员应得出的结论 |
|---|---|---|
| `executing` | 至少一条 exact live invocation | 显示谁在做什么；不据此把其他人的工作标完成 |
| `deliverable` | 至少一条普通消息仍由一个精确 target 可处理 | 只向那个 target 建立唤起条件 |
| `work_assigned` | 至少一个非终局 WorkUnit 有 responsible/disposition actor | 展示谁负责推进或处置；不把 delivery 或 liveness 当作已经接手 |
| `awaiting_external` | 有未终局的 typed wait | 显示 holder、条件和到期；不是聊天 Queue 的“继续” |
| `custody_open` | 有 action successor / ball custody 尚由 holder 持有 | 明确 holder 和 generation；不因为 holder 当前不运行就丢失 |
| `reconciliation_required` | 存在非终局对象但无法安全证明下一 carrier | 显示系统正在核对；禁止泛化 replay 或把它归给最近说话的人 |
| `quiet` | 上述集合均为空，且没有 unknown / reconciliation | thread 当前没有系统可证明的待行动作；新事件可再次打开它 |

例如 `executing + work_assigned + awaiting_external` 是完全正常的并发现场。只有 `quiet` 可作为
“当前没有可证明的系统责任”的结论；“长时间没新消息”永远不是 completed 的证据。

### 端到端主线：从沉寂到再次沉寂

下图是一个 thread 的运行时生命周期。每一阶段都描述**发生了什么、谁持有下一步、如何让
被动成员重新知道现场**；它不是新的万能状态机，而是既有对象必须共同满足的协议。

```text
                ┌───────────────────────────────┐
                │  0. QUIET / OBSERVED           │
                │  仅历史与可重建投影；无活责任  │
                └──────────────┬────────────────┘
                               │ 外部事件 / 用户消息 / A2A / wait 命中
                               ▼
 [1] ACCEPT ──> [2] ROUTE & ADMIT ──> [3] DURABLE CUSTODY + ASSIGNMENT
 保存原文          决定事件类别            per-target receipt / action / await + versioned duty
                               │
                               │ exact target 或 exact holder 的 carrier
                               ▼
                    [4] WAKE & ORIENT
                    创建 exact invocation，注入当前续航快照
                               │
                               ▼
                    [5] EXECUTE & PUBLISH
                    活性、输出、receipt、Assignment 与 authority 分别落各自 owner
                               │
                               ▼
                    [6] EXIT GATE
          ┌────────────┬──────────────┬──────────────┬──────────────┐
          ▼            ▼              ▼              ▼              ▼
       terminal   committed transfer   await       retry/recover   reconcile
       终局回执    新 holder+version    source+holder    exact candidate  安全性未知
          │            │              │              │              │
          └────────────┴──────────────┴──────────────┴──────────────┘
                               │ 新 carrier / wait event / recovery outcome
                               └──────────────► [4] WAKE & ORIENT

所有并发单元都终局，且无 wait / custody / reconciliation
                               └──────────────► [0] QUIET / OBSERVED
```

逐阶段的不可省略约束如下：

1. **Accept（接纳）**：将用户、connector、A2A 或外部完成信号规范化为一个有来源的事件。
   保存原文不等于交付；接收一个外部事件也不等于应该让所有 thread 成员醒来。
2. **Route & admit（路由与受理）**：区分普通消息的 target、WorkUnit 的 kind、责任交接的
   subject/holder、authority scope，以及 wait 的 source/predicate。多目标的 delivery 必须拆成
   per-target receipt；但“通知了多人”不等于业务工作可并行，join/gate 必须另有显式策略。普通
   通知不能隐式创造 action custody；无 target 的业务请求进入 routing WorkUnit，而非最近发言者。
3. **Durable custody + assignment（耐久托管与责任）**：在真正唤起前，下一步已经有 owner、
   版本、恢复依据与必要 authority：普通消息由 Queue/receipt，行动由 ActionSuccessor/
   BallCustody，等待由 AwaitState，业务推进由 WorkUnit Assignment。只写“我接着做”或“等 CI”
   而没有对应 structured carrier、assignment 或 disposition policy，不算通过本阶段。
4. **Wake & orient（唤起与定向）**：系统只唤起 exact target/holder，不广播给全部
   participants。创建 invocation 时读取同一时刻的续航投影，为这次执行带上可验证的“我为何
   被叫来、其他人此刻在做什么、我是否已有责任”。
5. **Execute & publish（执行与发布）**：该 invocation 只报告自己的 liveness、正文 exposure、
   输出和 terminal outcome；它不能用自己的成功覆盖别人的 receipt 或 custody。其他成员在
   这一阶段仍是休眠的，他们对变化的获知靠下一次精确 wake 时的 snapshot，而不是假定在旁观。
6. **Exit gate（退出闸门）**：每个被本 invocation 接触的非终局 unit 必须有且只能有一条
   明确归宿：`terminal`、已 CAS commit 的 `transfer`、`await`、`recoverable failure`、
   `suspended` 或 `reconciliation_required`。`offer`、消息投递、B 被唤起、B 的自然语言 ACK
   都不是交接终局。没有归宿不能静默退出；但也不能为了“有下一步”凭空创建 Queue item 或转派给
   任意 participant。
7. **Quiet / reopen（安静与重开）**：当所有 unit 均终局，thread 可以静默，历史和最终
   receipt 永久保留。新消息、精确 handoff、匹配的 wait event 或 exact recovery candidate
   重新进入第 1–4 阶段；不是依据“上次是某猫说话”重新唤起。

### 责任交接是提交事务，不是一次消息发送

`A @B`、B 的 delivery receipt 变为 `seen`、B 被唤起、B 回复“我来”、B 真正承担原 WorkUnit，
是五个不同的事实。前四者都不能改变 Assignment。普通 A2A message 仍按普通消息链路处理；
要移交一件有推进义务的工作，必须创建带 `workUnitId`、expected assignment version、scope 和
expiry 的 **TransferIntent**，并走下面的提交协议：

```text
offer ──> admission / readiness ──> prepare ──> accept ──> CAS commit
 A 仍持责          A 仍持责          A 仍持责       A 仍持责       B 才持责
```

| 阶段 | 可写事实与责任 | 失败或过期时必须发生什么 |
|---|---|---|
| `offer` | A 仍是 `assigned` holder；系统仅向 B 投递一个可拒绝的 transfer offer，记录 candidate、expiry 和 A 的 expected version | B 不可达、无 token、无调用额度或 admission 失败时，offer 终局为未接纳；A 的责任从未离开 |
| `admission / readiness` | B 的运行环境、所需 authority、scope 与 policy version 被校验；B 只取得查看/评估 transfer 的最小权限 | 不满足 readiness 就不创建可提交 transfer；写入失败证据和 A 的下一次 carrier |
| `prepare` | 创建 immutable context snapshot + manifest；必要 grant 已被证明。Assignment 可进入 `transfer_pending(A, version)` 来 fence A 的**声明 scope**，但 A 仍承担 recovery/disposition duty | 任一点失败或 expiry 必须 abort：恢复 A 的 source state（`assigned` 则解冻，`suspended` 则保持 suspend），并产生指向 A 的 exact abort carrier |
| `accept` | B 对 prepared digest、snapshot 与 readiness 作有证据的确认；它是“可接管此操作”，不是“我已经理解所有聊天历史” | ACK 丢失、stale generation 或 policy drift 不得猜作 accept；abort 并把证据交给 A |
| `CAS commit` | 单一比较交换同时校验 `workUnitId`、A 的 expected version、prepared digest、expiry、必要 grant；成功后 Assignment 由 A 的 `v` 变为 B 的 `v+1`，fence A，并把 manifest 的 reconciliation duty 归 B | 冲突或失败时不部分换 holder；abort/恢复 source state，给 A 建立 durable re-wake 或 disposition carrier |

所以 **arrival ≠ authority，accept ≠ responsibility，commit 才是 responsibility transferred**。
在 commit 前，B 的 provider/token/admission 故障会通过 transfer abort 留下证据，并自动按 A 的
existing assignment 建立下一次精确唤起（A 已运行时则进入其后继 carrier，绝不静默注入 prompt）。
在 commit 后，B 的 Run 再崩溃，Assignment 仍属于 B；它只能走 B 的 retry、suspend、recovery
或明确的后继 transfer policy，不能因为 A 是 predecessor 就悄悄回滚。默认 RecoveryPolicy 是
`retry_then_return_if_eligible_else_suspend_and_notify`：退回 A 是在 B 的重试耗尽后才可能发生的
**新一笔**带版本 transfer，不是异常处理的隐式 Assignment 回滚。

#### 已提交 B 的 Run 失败：默认恢复策略

`retry_then_return_if_eligible_else_suspend_and_notify` 由配置定义，不把某个 provider 的固定次数或
秒数写死进协议；最少必须有 `retryable` 分类、`maxAttempts`、`maxElapsed`、backoff/jitter 策略和
副作用对账要求。其状态机如下：

```text
B(v) Run failure
  ├─ retryable + budget available + effect reconciled
  │    └─ Retry-After；否则 exponential backoff + jitter → B(v) 的新 Run
  └─ non-retryable / budget exhausted / effect uncertain
       └─ recovery disposition
            ├─ A eligible + reverse-transfer CAS → A(v+1)
            └─ otherwise → suspended + dispositionActor + user notification/decision
```

1. **先分类和对账，后重试。** retryable 的 transient failure 才能在同一 B Assignment 下创建新
   Run；若 provider 给出 `Retry-After`，必须遵守它，否则使用 exponential backoff + jitter。每次
   retry 前都要核对在途副作用、幂等键、外部 receipt 或未知 effect boundary；不能因为 Run 失败就
   盲目重放已经可能提交的动作。non-retryable failure 直接进入 recovery disposition。
2. **重试有双界。** `maxAttempts` 和 `maxElapsed` 任一耗尽即停止 retry；两者是 policy 配置，
   允许按 failure class、风险与 provider 能力不同，但不允许无限重试或用下一次普通消息绕过预算。
3. **默认尝试受限退回。** B 耗尽后，可按预授权 RecoveryPolicy 尝试把同一个 WorkUnit 交回
   immediate predecessor A。原 transfer manifest 必须在 A→B commit 前声明 return policy、允许的
   scope、recovery authority 与 effect reconciliation requirement；没有这些证据就没有 reverse
   transfer 的权限。
4. **资格检查与新 CAS。** 只有 A 的 identity、capability、AuthorityGrant、readiness、policy/version
   和 in-flight effect 对账均仍有效，且不存在 Assignment version conflict 时，才能 CAS commit
   `B(v) → A(v+1)`。B 在该 commit 前仍是 holder；成功后 A 收到包含 B failure、retry history、
   effect evidence 与 original manifest 的 exact carrier。这个 `v+1` 是一次新的 transfer transaction，
   不是把 B 的 commit 擦掉。
5. **不能安全退回时挂起并通知。** A 不可接、reverse CAS 失败、权限/能力失效、effect 状态未知、
   或 policy 禁止退回时，WorkUnit 进入 `suspended`，保留 B failure evidence，指定
   `dispositionActor + nextCheckAt`，并创建用户 notification/decision。系统不得硬退、广播成员或
   再开无限 retry。
6. **只适用于同一 WorkUnit 的 transfer。** delegate、join、approval 和 gate 的 parent/child
   拓扑不机械“退回 A”；它们分别唤起 parent holder 或 disposition actor，并按自己的 join/gate
   recovery policy 处置。

Transfer 与相邻操作必须严格区分：

- **transfer**：同一个 WorkUnit 换 holder，必须经过上述 commit；
- **delegate**：A 保留 parent WorkUnit 的责任，创建一个有自己 Assignment 的 child WorkUnit 给 B；
- **sequential handoff**：当前 WorkUnit 先 resolve，再创建 successor WorkUnit 并 offer；不是篡改
  已终局对象的 holder；
- **resolve**：成功、失败、取消或静默终局都有 completion evidence；一次 B 的 Run 成功不自动
  resolve A 的 parent；
- **approval**：是独立 WorkUnit 或独立 AuthorityGrant 的决策，不因批准消息被投递就等于执行
  权限已经转移。

这份协议要求每一个 transfer attempt 有独立 identity、source snapshot/manifest digest、expected
assignment version、expiry、最终 `committed` 或 `aborted` evidence。它也给 crash recovery 明确
判据：只要 commit record 不存在，恢复 source assignment；commit record 存在，则从 B 的
assignment/recovery policy 继续。

### 多方协作的拓扑与收敛：fan-out 不是 join

“给多个 target 各发一条消息”只定义 delivery fan-out，不定义完成条件。一个 parent WorkUnit
若需要多人协作，必须创建可追溯的 child WorkUnit 或 decision WorkUnit，并在创建时声明
`JoinPolicy`；`parallel` 只说明 child 可以同时执行，不能替代 join：

| 协作语义 | 结构化表达 | 何时允许 parent 前进 |
|---|---|---|
| 独立并行 | 每个 child 各自 Assignment；无共享 join，或声明 `parallel + all_of` | 由显式 join policy，不由“所有消息似乎都回复了” |
| `all_of` | sealed child membership + 每个 child 的 required terminal predicate | 全部 required child 满足 predicate；任一失败的 failure policy 也必须声明 |
| `any_of` / `first_success` | sealed candidate set + 成功 predicate | 第一个满足 predicate 的 child commit 结果；其他 in-flight child 的 cancel/suspend 必须走其自身 authority 与 Assignment，不能消失 |
| `quorum(n)` | sealed membership、n 和 acceptable outcome predicate | 达到 n 个可验证结果；其余 child 的 disposition 同样明确 |
| `gate_then_dispatch` | 先创建 `approval` WorkUnit，再把后续 child 标为 `blocked_by_gate` | 只有 approval commit 为允许时才 offer child；拒绝、超时或未处理时，原 holder/ disposition actor 继续持责并被精确唤起 |
| 顺序协作 | predecessor resolve 后创建 successor WorkUnit | predecessor 的 completion evidence 已满足，才允许 next offer |

例如同时 `@co-creator + @cat`，如果人的决定是执行前置门，human approval 是一个独立的
WorkUnit/AuthorityGrant，猫的 child 只可见为 `blocked_by_gate`，不得提前 queue 或 wake。
人拒绝、等待超时或无响应，不能把责任落到“下一个在线成员”；gate outcome 必须回到 parent 的
responsible/disposition actor，由其 policy 选择修改、取消、再次请求或 suspend。join membership、
policy version 和每个 child 的 assignment version 都必须写入 completion evidence，避免并发旧结果
在新一轮里误触发。

### Run 进行中又收到消息：先持久化，再决定下一次执行

消息抵达 target 时，target 可能有 live Run。目标模型禁止把新正文偷偷拼进该 Run 的 prompt，
也禁止该 Run 的成功把随后抵达的消息误标为已处理。每条新 messageId 按下表取得自己的 delivery
与 WorkUnit 因果：

| 入站意图 | 允许的处理 | 明确禁止 |
|---|---|---|
| 正常定向消息 | 建立新的 per-target receipt / Queue custody；通常成为下一次 Run 的 carrier，或在已声明的 WorkUnit 下成为新 child | 注入正在执行的正文，或复用旧 invocation 的 `handled` outcome |
| 受策略允许的 coalesce | **仅**在目标 envelope 尚未 `body exposure` 前合并；每个 source message 仍保留独立 receipt、causality 与撤回语义 | 在 `seenAt` 后篡改 prompt，或把多条 message receipt 压成一条 |
| 明确 `supersede` | 调用者携带 exact `runId` / `workUnitId`、scope、authority 与取消 policy；旧 Run 的 terminal 写为 preempted，原 WorkUnit 另行 resume/suspend/reconcile | 让“最新一条用户消息”隐式夺走正在执行的责任 |
| 明确 `interrupt` | 只在策略授予 interrupt authority 且能记录安全取消边界时执行；新消息、旧 Run 和未完成 WorkUnit 各有可审计 outcome | 靠 Queue 长度、最近 @ 或 UI Continue 决定抢占 |
| 其他变化 | 只写入 durable `changesSince`；下一次 exact wake 从 packet cursor 读取 | 把变化当作当前模型已知事实，或在 Run 成功后丢弃 |

F167 所要求的“active target 时入队而非打断”是这里的默认安全语义。只有显式的 supersede/
interrupt policy 可以改变它，而且不会消灭被打断 WorkUnit 的 Assignment。这样，一次 Run 的
退出闸门只能终局自己实际处理过的 source identity；稍后抵达的 message receipt 必然仍在
projection 中等待自己的 carrier。

### 被唤起时必须收到什么：Thread Situation Packet

被动唤起的成员不能靠阅读一段过期的 system prompt 或猜聊天尾巴来判断是否应继续。因此
`Wake & orient` 阶段必须向这一次 invocation 提供一个**有界、带版本和 observedAt 的
Thread Situation Packet**。它既是执行时的上下文，也是 UI 控制条的同源输入；不是把全量
内部日志塞给模型。

| 字段组 | 最少内容 | 回答的问题 |
|---|---|---|
| `wake` | carrier kind、source pointer、`messageId`/lease/wait identity、exact `targetCatId`/holder、wake generation | “为什么是我被唤起，而不是某个历史参与者？” |
| `work` | `workUnitId`、kind、parent/join/gate phase、Assignment version、responsible 或 disposition role、completion predicate | “这次 Run 触及哪件工作；它是否仍未终局？” |
| `myStanding` | `handle_delivery` / `continue_assignment` / `accept_transfer` / `decide_approval` / `await_external` / `observe_only` / `no_action`，以及每项的 source identity | “我此刻是否被系统证明需要继续？” |
| `authority` | 当前 actor 的 scoped grants、fence、审批/取消/interrupt 是否被授权 | “我能推进到什么边界，哪些事仍需别的授权？” |
| `liveNow` | 当前 exact live invocations 的 cat、工作单元摘要、startedAt、degraded/unknown 标记 | “谁正在做什么，谁只是历史参与者？” |
| `openElsewhere` | 其他 target 的未读 delivery、open custody、wait 与 `reconciliation_required` 的**类型化摘要** | “是否有并发工作；我不能覆盖什么？” |
| `changesSince` | 自上一个 packet cursor 起的 material typed transitions，附 source reference | “我离开期间发生了什么？” |
| `constraints` | active generation、fence、可否恢复、unknown / stale 原因 | “哪些动作安全，哪些必须 fail closed？” |

`myStanding` 只能从 exact receipt、Assignment/AuthorityGrant、lease、wait 或已认证 wake 产生
正结论。以下情况一律只给 `observe_only` 或 `no_action`：我在 `participants` 中、我最后发过言、
有人在文中提到我的名字、同 thread 有失败、或一个不相关 task 显示我为 owner。这样系统不会把
“知道现场”误做成“获得球权”，也不会把“能看 transfer offer”误做成“已接手责任”。

Packet 要提供工作单元的短摘要和指针，而不是隐藏或改写 canonical 聊天内容；成员需要阅读
原文时仍读 MessageStore 的 canonical messages。内部安全凭据、私有 `workId/attemptId`、
不属于该 invocation 的 prompt 内容也不得泄露进 packet。读面失败时 packet 必须明确
`unknown`，并拒绝依赖它的交接/恢复动作。

### 责任怎么继续，而不是“看起来应该继续”

成员每次被唤起，系统都要给出一个**可行动而不越权**的答案：

| Packet 中的 standing | 当前成员能做什么 | 退出前必须留下什么 |
|---|---|---|
| `handle_delivery` | 读取该 target 的正文并处理 | receipt 的 exact outcome；若相关 WorkUnit 未终局，进入 committed transfer / await / recovery 之一 |
| `continue_assignment` | 在 own Assignment version + authority fence 内推进该 WorkUnit | completion evidence，或新的 exact transfer / child / wait / recovery policy outcome |
| `accept_transfer` | 检查 prepared snapshot、scope、readiness 与 grants；可 accept 或拒绝 | accept/decline evidence；commit 前不得宣称或执行 source holder 的责任 |
| `decide_approval` | 在自己的 grant scope 内做允许/拒绝/要求补充信息的决定 | approval WorkUnit 的 versioned decision；不替执行者吞掉 parent 责任 |
| `await_external` | 不主动重跑；等待被声明的 source | 仅在匹配事件或到期/recovery 流程再次唤起 |
| `observe_only` | 阅读、给建议或做不改变责任的工作 | 不得吞掉别人的 Queue / lease，也不得自行宣称已接手 |
| `no_action` | 无系统要求；可在收到新 carrier 后再运行 | 不从空闲、参与者名单或时间推导“应该继续” |

如果 execution 崩溃、超时或 provider 不可用，`Exit gate` 不能把工作留给“下一位看到 thread
的人”。其 exact `TurnExecution` 先记录失败；普通消息只有在存在 `messageId × target ×
queueEntry × failedInvocation` 的 recovery candidate 时才会重试；责任/等待则由自身 holder、
Assignment version 和 source 的 recovery 流程继续。找不到安全 carrier 的对象进入
`reconciliation_required`，由其**声明的 disposition actor**按 `nextCheckAt`、policy 与 source
证据处理，而不是触发 thread-wide Continue 或唤醒全体成员。

`reconciliation_required` 不是停车场。每条记录至少包含：`workUnitId`/source identity、typed
reason、observed assignment/grant version、`dispositionActor`、`nextCheckAt`、recovery policy、
上一次检查与预期动作。reconciler 可以按预授权规则重试投递、重发 offer、建立恢复 carrier 或
升级为需要人决定的 proposal；它不能自行换 holder、扩大 scope 或把异常塞进普通 Queue。每次
检查要么留下新的 evidence/next check，要么让 WorkUnit resolve/suspend；超过 SLA 的记录仍必须
有同一 disposition owner，而非无限陈列在 thread 顶部。

### 同一投影必须服务成员与用户，但两个面不能越权

用户需要看见“这里没有人静默盯着 thread”，也需要随时知道现在的协作现场。因此 thread
顶部应展示一个可展开的 **协作控制条**，消费同一 Thread Continuation Projection：

```text
协作现场 · 观测于 10:32
  正在执行：砚砚 · 核查队列生命周期（2 分钟）
  待交付：布偶猫 · 1 条消息尚未读
  正在等待：金哥 · CI 回调（到期 10:45）
  需核对：1 项内部责任，尚不能安全恢复
```

- 每行必须指向 exact source/工作单元；用户可展开查看 human-readable reason、阶段和诊断，
  但默认不泄露私有 credential 或 raw managed-work identity。
- 成员获得的是自己的 `myStanding` 和必要的并发边界；用户获得的是可理解的协作状态。两者
  共享事实投影，不共享不必要的执行上下文。
- 控制条只显示事实和 exact action（如存在）。它不能用“有猫在运行”替代消息 receipt，不能
  在没有 recovery candidate 时显示 Continue，也不能把 `quiet` 显示成“项目已完成”。
- F277 的 thread navigation 可以消费这些 flags 做注意力展示，但 navigation 只组织和阅读
  thread；它不创建 custody、不选择 next actor，也不从历史 participants 推断 liveness。

这就是 #1354 的体验归属：若失败是一条原消息的 exact execution，细节在该消息的 receipt；
若是 wait/custody，则在控制条相应工作单元；如果它使整个 thread 无法安全续航，则额外出现
`reconciliation_required`。绝不把这些不同对象折叠成“队列已暂停 · 0 · 当前调用失败”。

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

交接本身也不等于责任已经完成。若消息是在请求 B 接手一个可追责的动作，A 必须以
`workUnitId + expected assignment version + scope + expiry` 建立 TransferIntent；只有 B readiness/
accept 后的 CAS commit 才将 holder 从 A 改为 B。普通协调、通知或回执不能偷渡成新的实施责任。
目标 B 的 execution 结束，同样不能自动证明 A 的原工作已经闭环；commit 前 B 不可调用时，A 仍
持责且必须收到 abort carrier。

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
  [2] MessageStore    协作责任契约
      原文与作者时间线  WorkUnit + Assignment + Authority
          │              + AwaitState / ActionSuccessor / BallCustody（仅适用时）
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
          ├───────── A2A 普通消息（回到 [1]，带来源关联）
          ├───────── transfer offer / accept / CAS commit（更新 WorkUnit Assignment）
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
| 协作责任契约 | typed WorkUnit、versioned Assignment、AuthorityGrant、join/gate policy；其字段由有 CAS 能力的 owner 权威持久化 | 谁必须推进/处置、何时真正交接、谁可批准或执行、child 如何收敛 | 从一条普通消息的 `seen`、某次 Run 成功或历史 participants 猜责任 |
| 等待与责任 carrier | `AwaitState`、ActionSuccessor、`BallCustodyProjection` | 谁在等什么、何时过期、何种事件可以消费、用于 Assignment 的 exact carrier | 普通 Queue entry 是否已读、普通消息是否该展示“已处理” |
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
| `workUnitId` / `assignmentVersion` | 需要推进的工作及其当前责任提交版本；transfer CAS 和 join 不能省略 |
| `authorityGrantId` / scope / policy version | 谁可执行、批准、取消、interrupt 或交接的边界；不得由 Assignment 或消息正文推导 |
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
4. **不复制账本，也不回避责任真相。** 普通 queued message 仍由 Queue custody / per-target
   receipt 负责；A2A responsibility、wait、freshness supplement 各留在其 typed owner。
   WorkUnit/Assignment 是所有 owner 共同遵守的 versioned contract，不是可由投影重建的猜测；
   若现有 owner 无法提供其 CAS/持久化，必须补足权威来源，而不是复制一张 thread summary。
5. **恢复必须窄且幂等。** 一次操作只恢复它声称要恢复的对象；stale / replaced / cross-target action fail closed，并给出可诊断的原因。
6. **输出提交与外部送达分开。** 已提交的回答不能因为 connector 重试或补充回答失败而被撤回、重发或伪装成“还在处理中”。
7. **没有可靠证据，不显示确定语气。** 禁止从正文、日志文本、时间相近或 queue length 猜“已读”“已完成”“需要用户继续”。

## 终态重构：一个模型、一次切换

### 目标状态：五类权威契约，三个严格分工的读视图

实现完成后，运行时保留下面五类权威契约；它们由稳定坐标关联，绝不相互覆写。第五类是本 RFC
补足的**逻辑协调契约**，并不预设新的独立数据库：可复用现有 typed owner 的物理存储，但必须有
单一可 CAS 的 canonical source，不能由 read projection 回填。

| 真相域 | 终态职责 | 运行时明确禁止 |
|---|---|---|
| MessageStore + per-target receipt | 保存原文、作者时间线、每个目标的 admission / child creation / body exposure / terminal receipt | 用 aggregate parent 成功、thread pause 或 provider 文案代替精确目标 receipt |
| InvocationQueue + Queue custody | 排序并接纳仍可调度的普通消息工作；从 durable custody 重建 live queue | 作为聊天历史、等待账本，或跨目标失败的聚合器 |
| TurnExecution ledger | 记录精确 child invocation 的运行、失败、输出和 terminal outcome | 用一次失败推断整条原消息未送达，或替代 receipt 的 body-read witness |
| AwaitState / ActionSuccessor / BallCustody | 记录结构化等待、责任移交、generation 和终局消费 | 伪装成普通用户 Queue entry，或由 thread-wide Continue 处理 |
| WorkUnit / Assignment / Authority contract | 记录业务工作、版本化责任、disposition owner、transfer commit、gate/join 与 scope grants；每条状态回指对应 Message/Queue/Run/wait source | 用 thread summary、自然语言 ACK、delivery receipt 或隐式 fallback 裁定 holder/authority |

在这五类权威契约之上允许三个只读投影；它们都可被重建，不能回写或互相裁定：

1. **消息回执视图**以 `messageId × targetCatId` 为锚。它列出该目标的 child 是否创建、正文是否暴露、最后一次精确 execution 的 typed outcome，以及仍有无后续可用动作。
2. **可操作队列视图**以 `queueEntryId × targetCatId` 为锚。它只包含当前真正可操作的普通 queued work，和由同一对象授权的恢复动作。
3. **Thread 续航视图**以 `threadId + observedAt` 为锚，汇合 live execution、per-target
   delivery、open custody、typed wait、recovery/reconciliation 的当前事实。它为用户提供协作
   控制条，并在 exact wake 时裁剪成该成员的 Thread Situation Packet；它没有独立的 terminal
   字段，也不以 `participants`、最近消息或 task 近邻补齐缺失事实。

系统诊断可以按 thread 聚合，但诊断、控制条和 Queue action 都只能携带其 exact object 的操作，
更不能把一条内部 wait 的异常翻译成“当前调用失败”。

### 目标 API、wake injection 与 UI 契约

除 message receipt 与 actionable queue 外，服务端提供一个由既有 owner 即时构建的
`ThreadContinuationProjection`。初始 history、F5 hydration、socket 增量和 Thread Situation
Packet 必须消费**同一版本化 reader**；不能由浏览器从 `queue.length`、bubble 文本、thread
participants 或多个互相独立的 endpoint 猜出协作现场。

```text
ThreadContinuationProjection
  threadId, observedAt, revision/cursor
  liveExecutions[]        // exact invocation, cat, typed work reference, liveness confidence
  deliveries[]            // only non-terminal per-target receipt/custody
  workUnits[]             // work id, assignment version/role, gate/join phase; scope is redacted for viewer
  custodies[] / waits[]   // source, holder, generation, state, expiry where applicable
  recoveryCandidates[]    // exact, user-actionable candidates only
  reconciliation[]        // identity + owner domain + typed reason; never auto-replayed
  materialTransitions[]   // typed source references since cursor; no generated prose summary
```

每一个列表项必须有 source identity 和 source domain；Reader 漏读、版本不一致或 source
不可用时，返回 explicit `unknown`/`reconciliation_required` 项，而不是删除它。socket 增量需要
带 `revision`，客户端只接受能接续当前 projection 的更新；发生 gap / epoch change 时重新取
完整投影。这与 F194 的 canonical liveness 规则并行：F194 判断某个 invocation 是否 live，
continuation reader 决定如何把它与其他责任单元并列呈现，二者都不能让前端自行再拼一套 truth。

创建 invocation 的入口必须在认证 carrier 已选中 exact target/holder 后调用同一 reader，生成
packet 并绑定其 `observedAt` / cursor 到该次 `invocationId`。它不能在 invocation 结束时倒写
packet，也不能因 packet 中另一个猫正在执行就抢占或取消对方。若生成 packet 失败，依赖它的
handoff/recovery/责任动作 fail closed；普通消息是否可以按既有安全语义运行，必须由该消息的
Queue/receipt owner 显式决定，不能以“读面异常”静默丢弃。

`QueueProcessor` 可以继续为调度器保存 slot 级暂停/失败信息，但对外不得再提供 thread-wide `queuePaused`、裸 `pauseReason` 或由 `/queue/next` 触发的泛化恢复。其对外 read model 必须返回两个互不混淆的集合：

```text
actionableQueueEntries[]
recoveryCandidates[]
  = exact failed invocation + exact target + exact queue entry
    + non-terminal receipt + current custody/generation eligibility
```

每一个 `recoveryCandidate` 至少含 `messageId`、`targetCatId`、`queueEntryId`、`failedInvocationId`、失败类别与授权 generation。缺少其中任一项，就不是 candidate。

客户端与服务端在同一次切换中采取下列契约：

| 旧的宽泛行为 | 目标行为 |
|---|---|
| thread 级 `queuePaused` / `pauseReason` 决定 QueuePanel 是否展示 | QueuePanel 只由 `actionableQueueEntries` 与 `recoveryCandidates` 渲染；两者为空则无 action panel |
| `POST /queue/next` 按 thread 继续 | 用户触发的恢复操作必须请求精确 `recoveryCandidate`；调度器内部 drain 与用户恢复是不同入口 |
| “当前调用失败”悬在 QueuePanel 顶部 | execution failure 归属于原消息 receipt / invocation lineage；内部 wait failure 归属于对应 status card |
| UI 自行从 raw queue + 宽泛 pause 拼状态 | API 提供已绑定身份的 read model；UI 不再从长度、文案或相邻时间猜状态 |
| thread 的 members / 最近气泡被当作“正在协作” | 控制条与 wake packet 只读 continuation projection；历史成员、安静和完成分开表示 |

这不是只改 endpoint 名称：服务器先在同一次原子校验中核验 candidate 仍与 source message、target、failed invocation 和当前 custody generation 相符，才允许恢复。客户端传错、对象已被替换、已终局或跨目标的请求全部 fail closed。

### 失败展示的唯一归属

| 事件 | 归属与展示 | 可用动作 |
|---|---|---|
| 普通消息尚未被目标读到就失败 | 原消息的该目标 receipt：未读 + 失败执行 | 仅当存在 exact recovery candidate 时恢复或撤回 |
| 目标已读，后续 execution 失败 | 原消息 receipt 保留已读事实；invocation lineage 显示失败阶段/原因 | 由 target-bound candidate 或明确的重新发起策略决定 |
| provider 配额、暂时不可用 | execution 状态卡链接回原消息；说明影响范围和系统的确定下一步 | 不能把 thread 内别的 Queue entry 作为“继续” |
| managed hold / wake / action-custody 不匹配 | 等待或工作状态卡；含 source、holder、generation 与 reconciliation 结论 | 无普通 Queue 操作；只走 server-owned reconciliation |

任何空的 Queue action view 都不显示 `0`、失败横幅或继续按钮。没有 exact object 的动作不是“保守”，而是错误动作。

### 一次性数据切换，而非旧新兼容层

切换前做一次只读 preflight，按以下规则生成可复核清单；这不是在线 shadow 双跑：

| 存量对象 | 切换规则 |
|---|---|
| 已终局的消息、receipt 和 execution | 保留为不可变历史；新读模型直接投影，不再执行旧状态分支 |
| 仍活跃且拥有完整 `messageId × targetCatId × queueEntryId` 坐标的普通消息 | 一次性映射到目标 Queue custody / receipt 形状，随后只由新写路径更新 |
| 仍活跃且有精确 invocation / generation 的 wait、action successor 或 ball custody | 映射到带 `workUnitId`、Assignment/disposition version 的 typed contract；保留在其既有责任域，不生成 Queue row |
| 旧 action/wait 缺少可证明的 holder、source 或 policy，但仍未终局 | 映射为带 disposition owner、`nextCheckAt` 与 typed reason 的 `reconciliation_required`；不自动 replay、不伪装为用户待办 |
| 缺少精确身份、无法证明安全 Assignment/disposition 的 in-flight 旧记录 | 隔离并阻断上线；不能用 projection、最近成员或旧路径临时猜测一个 owner |

切换完成后删除旧 API 字段、旧 UI 分支和旧 thread-wide recovery 调用点。不存在“新模型为空就回退旧模型”的读写路径。若 preflight 发现不能安全映射的类别，应阻断上线并把该类别交回设计 review，而不是临时接回旧分支。

### 重构交付顺序

这是一个终态项目，不是向用户逐步暴露的 hotfix；顺序只用于降低 review 风险：

1. **契约冻结与 RED fixtures**：把所有入口的因果链写成黑盒 fixture。每条断言都检查 `messageId × targetCatId × queueEntryId × invocationId × workUnitId × assignmentVersion`，不只检查 HTTP 200。
2. **责任契约与事务边界**：为 WorkUnit/Assignment/Authority 提供 durable CAS，落地 transfer
   prepare/accept/commit/abort、gate/join、disposition owner 与 recovery policy；明确现有 typed
   owner 如何承载它们，不能留给 reader 推断。
3. **后端一次重构**：收口 receipt、Queue custody、TurnExecution、active-run ingress 与 wait 的
   边界；删除 thread-wide recovery API / projection；实现 exact candidate 校验和 server-owned
   reconciliation。
4. **thread 续航 reader 与 wake injection**：实现投影、revision/cursor、F5/socket 收敛和
   Thread Situation Packet；让每次 invocation 都能说明自己的 carrier 和 standing，同时保持
   reader 零写副作用。
5. **客户端同次切换**：删除 pause banner / generic Continue 的消费，改为 receipt/invocation
   status、action queue 与协作控制条三个视图；socket、F5 hydration 与初始 history 同源。
6. **迁移 preflight 与正式切换**：在隔离副本验证上表的全部转换，备份可恢复证据，执行一次性
   切换，确认没有 legacy reader/writer 后才启用。
7. **端到端验收**：跑下面的全矩阵，并对真实 thread 抽样核验。发现遗漏不以兼容 fallback
   掩盖，回到同一个 target model 修正。

提交可以按这七类组织，PR 的 review 以同一个 RFC / acceptance matrix 为准；不得把第 2–6 类各自当作完成的独立产品行为。

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
| A17 | 历史参与者没有被新的 carrier 指向 | 不因 `participants`、最近发言或同 thread 失败而被唤起或得到 `continue_assignment` |
| A18 | exact target 被普通消息、committed transfer 或 wait 唤起 | invocation 收到带 carrier/source、`myStanding`、并发边界与 revision 的 Thread Situation Packet |
| A19 | A 正在执行，B 有未读消息，C 在等 CI | continuation projection 同时列出三项；不压成一个 `active/paused` 标签，也不互相覆盖 |
| A20 | invocation 退出但工作未终局 | exit gate 留下 exact terminal、committed transfer、wait、recovery、suspend 或 reconciliation 之一；纯自然语言“我之后继续”不算闭环 |
| A21 | holder 的 invocation crash / provider 失败 | exact invocation 失败可追溯；只有拥有 exact carrier 的对象重试，失去安全 carrier 的对象进入 reconciliation，不唤醒全体成员 |
| A22 | projection source 暂不可读、socket 有 gap 或 F5 中途进入 | UI / packet 明示 unknown 或重拉同源完整 projection；不能把漏读解释为 quiet/completed |
| A23 | thread 控制条展示并发现场 | 每行指向 exact source；普通消息失败回到 message receipt，wait/custody 异常归对应 status，而没有泛化 Continue |
| A24 | wait / action 触发重新唤起 | 只唤起 exact holder/target + 当前 generation；过期、跨 holder、跨 thread 或 stale event fail closed |
| A25 | A 向 B offer transfer，但 B 无 token、无额度或 admission 失败 | Assignment 仍是 A；attempt 有未接纳/abort evidence，A 得到包含失败原因和 source snapshot 的 exact 后继 carrier |
| A26 | transfer prepare、accept 与 commit 之间 crash、expiry 或 CAS version 冲突 | 不出现部分换 holder；无 commit record 则恢复 A 的 source state（suspended 保持 suspended）并写 abort/reconciliation evidence |
| A27 | transfer 已 commit 给 B 后发生 transient Run failure | Assignment 仍归 B；仅在 effect 对账通过且 `maxAttempts` 与 `maxElapsed` 都未耗尽时，按 provider `Retry-After` 或 exponential backoff + jitter 创建 B 的新 Run |
| A28 | 负责执行的猫、human approver 与 observer 同时在 thread | packet 明示 Assignment 与 AuthorityGrant 的差别；observer/approver 不因看见消息获得执行责任，执行者不因有责任越过审批 scope |
| A29 | 多猫 `parallel + all_of`，其中一个 child 失败或迟到 | parent 只按 sealed membership、required predicate 与 failure policy 收敛；不以“都曾回复”或 arrival order 判完成 |
| A30 | `any_of` / `first_success` / `quorum(n)` 并发返回 | 成功 winner 可证明；其余 child 的取消、挂起或继续由各自 Assignment/authority 终局，旧结果不能污染下一代 join |
| A31 | `@human + @cat`，human approval 是前置门 | approval 是独立 WorkUnit；cat child 在批准前为 `blocked_by_gate`，不得 queue/wake；拒绝、超时或未处理时 parent 的 holder/disposition actor 被精确唤起 |
| A32 | 无明确 @ 的用户请求 | 声明式 routing policy 选定 target，或生成有 disposition owner + `nextCheckAt` 的 routing WorkUnit；绝不选最近发言者/participants |
| A33 | target 有 live Run 时收到普通新消息 | 新 messageId 有独立 receipt/custody，并只在下一次 exact carrier 中读取；已有 Run 成功不会把它标 handled |
| A34 | 在正文 exposure 前按显式 coalesce policy 收到多条同类消息 | 可合并未暴露 envelope，但每条消息保留 receipt、撤回和 causal identity；`seenAt` 后不允许隐式合并 |
| A35 | 用户/系统请求 supersede 或 interrupt | 请求必须携带 exact run/work/scope/authority；旧 Run 被审计为 preempted，未终局 WorkUnit 有 resume/suspend/reconcile 归宿，而非被新消息吞掉 |
| A36 | `reconciliation_required` 被创建 | 记录带 source、typed reason、observed version、disposition owner、`nextCheckAt`、policy 和预期动作；reconciler 不自行换 holder 或产生普通 Queue entry |
| A37 | reconciliation 检查超过 SLA 或需要非预授权业务选择 | 同一 disposition owner 得到升级 carrier/proposal；系统不无限停车、不广播所有成员、不凭历史猜接班人 |
| A38 | B 的 retry 耗尽或遇 non-retryable failure，A 仍 eligible | 原 manifest 的 return policy/authority 和 effect evidence 均通过；以新 CAS 将 `B(v)` transfer 给 `A(v+1)`，A 收到 B failure、retry history 和 effect 对账；绝不抹掉 B 的原 commit |
| A39 | retry 耗尽后 A 不 eligible、reverse CAS 冲突、effect 未知或 policy 禁止退回 | WorkUnit 进入 `suspended`，带 B failure evidence、dispositionActor、`nextCheckAt` 和用户 notification/decision；不得硬退、广播或无限 retry |
| A40 | delegate / join / approval / gate 的 child Run 重试耗尽 | 不机械退回其 predecessor；由 parent holder 或该 child 的 disposition actor 按 typed topology policy 收到 exact recovery carrier |

## 这次审计明确不做什么

- 不把所有消息、所有 A2A、所有 wait 都塞进 `InvocationQueue`；
- 不用新的全局状态机替换已存在的 MessageStore custody、TurnExecution、ActionSuccessor 或 AwaitState；
- 不把 `ThreadContinuationProjection` 物化成新的可写 thread lifecycle ledger，或把它的
  `quiet` / summary 当成 action terminal truth；但也不再允许从 projection 猜 WorkUnit holder；
  WorkUnit/Assignment 的 CAS truth 必须由 typed canonical owner 持久化；
- 不把 `Thread.participants`、最后说话者、thread 标题、任务 owner 或长时间无消息当作当前
  owner、live invocation、完成或下一位被唤起者；
- 不在成员未被 carrier 唤起时假定它看见 thread 后续，也不在 wake 时广播全部历史成员；
- 不保留旧/新 Queue pause、read model、endpoint 或 UI 的长期双轨 compatibility fallback；
- 不因为 UI 难解释，就放宽 invocation-bound completion、transfer commit 或 approval gate 的
  fail-closed 条件；
- 不从 provider 文本、控制台日志或 timestamp proximity 推导业务终局；
- 不把 internal receipt、reconciliation failure 或系统 diagnostic 伪装成某只猫的自然语言回答；
- 不先改一个文案就关闭 #1354。若 exact recovery scope 未得到证明，文案再友好也是误导；若一批存量不能安全映射，也不能用旧路径把它悄悄接回去。

## 剩余的产品决策

本 RFC 不把基础正确性留成产品选择：transfer commit、Assignment/disposition owner、reconciliation
SLA、消息不注入 live Run，以及审批和执行权限分离都是必须实现的契约。剩下只保留两项会改变
用户协作体验的选择，供 maintainer 与 co-creator 在 RFC review 中拍板：

1. **默认 approval gate 的范围**：哪些来自用户的请求（例如外部发布、不可逆操作、显著成本）
   必须先形成 human approval WorkUnit，哪些可由既有 AuthorityGrant 直接推进？
2. **默认 parallel 的范围**：哪些协作意图允许产品默认创建并行 child，哪些必须由发起者显式
   选择 `parallel` 与 join policy？未声明时采用单一 responsible/disposition actor，而不是猜
   `all_of` 或 `any_of`。

UI 呈现、provider recovery、diagnostic disclosure 与 `observe_only` 的消息权限均按前文固定边界
实现：内部异常显示在 exact status card/控制条，普通 Queue 不接管；可见细节最小化且不泄露凭据；
observe-only 若发普通协调消息，仍须重新走 message admission，绝不升级为责任交接。

## 代码与文档来源地图

| 主题 | 现有 owner / 入口 |
|---|---|
| 浏览器消息接纳和 queue admission | `packages/api/src/routes/messages.ts` |
| A2A message append、行首 @ / targetCats 路由 | `packages/api/src/routes/callbacks.ts`、`packages/api/src/routes/callback-a2a-trigger.ts` |
| Queue 排序、暂停、恢复 | `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts`、`QueueProcessor.ts`、`packages/api/src/routes/queue.ts` |
| durable queued-message custody 与 per-target receipt | `QueuedMessageCustodyCoordinator.ts`、`QueuedMessageCustodyStartupReconciler.ts`、`queued-message-custody.ts`、`queued-message-receipt.ts`、`queue-receipt.ts` |
| child execution ledger | `TurnExecutionStore.ts`、`TurnExecutionStartupReconciler.ts`、`invoke-single-cat.ts` |
| canonical invocation liveness | `getThreadLiveInvocations.ts`、`InvocationRecordStore`、`InvocationTracker`、F194 |
| target WorkUnit / Assignment / Authority contract | 本 RFC 的 versioned coordination contract；实施时须指定能提供 CAS 的 typed canonical owner，不能由 continuation reader 物化或补推 |
| Queue action rendering | `packages/web/src/components/QueuePanel.tsx`、`queue-receipt-projection.ts` |
| message bubble / receipt hydration | `MessageReceiptDock.tsx`、`useChatHistory.ts`、`useSocket.ts`、bubble reducer |
| typed wait、action successor、responsibility lifecycle | `docs/architecture/ownership/cells/ball-custody.md`、F167、F280 |
| thread collaboration projection / navigation boundary | F233 projection、F194 liveness reader、F277 `thread-navigation` cell；新 continuation reader 只作组合 read model |
| managed work (optional explicit context only) | F275 `managed-work` cell；不得按 thread / task 近邻推断 |
| output commit and connector transport | `docs/architecture/ownership/cells/transport.md`、ADR-041、ADR-042 |

## 下一步

先由 maintainer 做 RFC 内容 review，重点检查：被动唤起成员的 lifecycle 是否完整、Thread
Situation Packet 是否足以让成员知道“我为什么被叫来 / 谁在做什么 / 我是否必须继续”、transfer
是否只在 CAS commit 后换 holder、join/gate 与 active-run ingress 是否没有偷渡责任、每个
reconciliation 是否有 disposition owner，既有 truth owner 是否被误合并，以及一次性切换能否保住
用户数据。review 通过后，#1354 保持 umbrella，按上面的七个交付单元组织**同一个终态重构 PR**；
任何发现的新持久化真相源、不能安全映射的存量类别或跨 owner 矛盾，都先回到本 RFC 的 architecture
decision，不在 `QueuePanel` 或 `QueueProcessor` 堆兼容分支。
