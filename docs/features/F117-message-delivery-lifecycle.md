---
feature_ids: [F117]
related_features: [F039, F086, F122, F167, F173, F183, F233, F254, F264, F280]
related_decisions: [043]
topics: [message, queue, delivery, lifecycle, context]
doc_kind: spec
created: 2026-03-14
tips_exempt: 2026-09-10 Phase G moves managed-hold recovery onto the existing History/Queue/response lifecycle and retires two internal completion tools; it adds no user-invokable capability to teach
---

# F117: Message Delivery Lifecycle — 消息投递生命周期真相源

> **Status**: implementing — PR #1398 已收敛单 source Queue Entry、History actual-dispatch lifecycle、carrier 能力真相、managed-hold 统一恢复与 caller runtime outbound dispatch view；exact-HEAD 本地跨族代码复审已通过，co-creator 已完成基础旅程 1–5 验收，剩余完整 worktree UAT、fork soak 与上游 owner gates | **Owner**: Ragdoll + Maine Coon | **Priority**: P1
> **community_issue**: [#20](https://github.com/zts212653/clowder-ai/issues/20)

## Why

operator 2026-03-14 实测发现：queue 模式发送消息后立即取消，该消息仍出现在聊天流、进入猫猫 prompt context。社区 issue #20 也报告了同样问题。

根因：当前架构下 queue send 在 enqueue 阶段就持久化 user message 并做乐观插入，但没有 delivery status 概念。History API 和 ContextAssembler 不区分 queued/delivered/canceled，导致未送达甚至已取消的消息污染聊天历史和猫猫上下文。

**2026-03-14 原始 invariant**：`undelivered user messages MUST NOT appear in timeline, history API, or prompt context.`

**2026-09-07 最终契约**：F264 曾把 operator publication 与 cat delivery 分开，但仍让同一 queued user message 同时占有 Queue 与 owner-only History，造成两套顺序与 receipt 双写。ADR-043 最终退役这层兼容：

- durable queued user/external message 只在 Queue Panel；第一次 actual dispatch 后才以同一 `sourceRecordId` 进入 History；
- 一条 source message 永远只有一个 Queue Entry，`targets[]` 只保存尚未投递的成员；
- target 已发生的投递或投递失败事实只由 History `dispatchRefs` 表达；ref 不是预期 target receipt，且仅凭 ref
  存在不能断言 provider 已收到消息；Queue 不保存 processing/terminal/seen/handled/receipt；
- Agent caller 在单 runtime 内维护自己的 outbound dispatch view，汇总该成员发出的 source×target 预期、Steer 变更与实际结果；它不改写 Queue/History，也不持久化为第四本账；
- canceled 且从未 actual dispatch 的输入不会进入 History 或 cat context。

operator experience：
> "前端不应该显示你们真正没有收到的消息，对吧？"
> "当我发了一个正在队列的消息的时候，我的用户气泡这里先不显示，等到你们真的收到这个消息的那一刻，再在正确的地方插入这个气泡"

## User Journey

**Scope unit：一条 source message 从进入 Queue 到所有目标各自取得终局。**

1. 用户、Connector 或成员发送一条消息；若它尚未实际交给任何成员，Queue Panel 只显示一条可恢复的 source entry，Chat History 不复制未投递的用户/外部消息。
2. `targets[]` 只列仍待投递的成员。Agent caller 成功提交 source Queue admission 后，把 source×target 加入自己的 runtime dispatch view；Steer 已提交的增删更新同一 view item revision。
3. 第一次实际投递让同一 `sourceRecordId` 进入 History；每个实际目标得到独立 `dispatchRef`、固定 response bubble 与执行终局，尚未投递的 sibling 仍留在原 Queue entry。
4. caller 下一次自然 invocation 从 view 反查 Queue/History：仍 pending、已实际投递、已终局、投递前失败或由 Steer 移除分别诚实呈现；不靠 target 回复语义，也不为普通观察另造消息。failed 的 exact Queue control edge 只负责及时调度，见第 6 步。
5. 已终局或未投递移除的 exact revision 成功进入 caller prompt 并由该 invocation completed 后，从 view 精确清理；open/pending 与期间新增 revision 继续保留。所有 pending targets 离开后 Queue entry 删除；用户若要重试，通过新消息或新动作产生新的 source，不复活旧工单。

## Unified State Model：一条 source、逐 target 生命周期、caller 变化视图

完整模型只有三个持久事实 owner，加一个可丢弃的 caller 视图：

| 问题 | 唯一 owner | 更新时机 |
|---|---|---|
| 这条 source 还等哪些 target | Queue entry 的 `targets[]` | 初始入队；Steer/Cancel；actual admission 从 exact target 出队 |
| 这条 source 对哪些 target 已产生投递或投递失败事实 | source message 的 `dispatchRefs[]` | target 获得持久 processing response receiver，或投递前失败已持久形成 `delivery_failure` 后，写一条 exact source×target ref |
| target 最终怎样 | canonical response / `delivery_failure` | provider terminal 或投递前失败；随后把对应 source ref settle 到该 response |
| caller 下一 turn 需要知道哪些变化 | process-local outbound dispatch view | 在 Queue mutation 提交后 touch；actual 状态在投影时对比 canonical ref/response fingerprint 后 touch |

**source message 是隔离单位，provider invocation 不是。**A 连续发送 `M1→B`、`M2→B`，A 的 view 中是
`M1×B`、`M2×B` 两个 item，两条 source 也各自拥有一条 dispatchRef。Queue admission 不把 M1/M2 合并；即使其它
显式机制让同一 response 引用了两条 input，也不能把两条 source 或两条 caller observation 合并。反过来，
一条 `M1→B/C` 也仍是一个 Queue entry、两个逐目标生命周期；B 的完成不覆盖 C 的 pending/failed。

一次完整流转固定为：

1. **解析与入队**：先得到 canonical targets，再原子提交 source Queue entry。若 source 作者是 Agent，提交成功后
   为每个 exact target 初始化 caller view item；解析不出 canonical target 的文本只产生 routing diagnostic。已解析但
   在 durable Queue admission 前被 routing preflight 拒绝的 target，由本次发送结果立即返回 typed fail-back，不登记 view；
2. **Queue 修改**：Steer add/remove、整条撤回等先提交 durable Queue mutation，再 touch 对应 view item。未提交或
   输掉并发的操作不能留下 view 变化。尚未 actual dispatch 的 remove 由 view 保留 `withdrawn` 说明；
3. **actual admission**：per-thread drain 按 comparator 顺序领取 source entry；普通 drain 的领取单位是完整 source
   entry，只有本轮完整 pending target set 都可 admission 时才一次并发 fan-out。任一 sibling 忙碌时，本次尝试
   无副作用返回，entry 的 `targets[]` 与顺序均不变；enqueue/cutover/执行终局会再次触发 try-drain。领取成功后，
   每个 target 先建立自己的持久 processing response receiver，并给实际输入 source 写 exact dispatchRef，再独立从
   `targets[]` 退役并启动 provider。Steer 或未读接管是显式 singleton cutover，可以只领取一个 exact target；
   它们不把普通 drain 改成空闲子集循环。不同 source 不在 Queue admission 中合并；view 只 touch 对应
   source×target；
4. **terminal**：response 进入 completed/failed/canceled/interrupted，或 pre-admission failure 建立 canonical
   `delivery_failure`，再 settle 所有关联 source refs。view 不复制 outcome；caller 下次投影时对比 ref/response
   fingerprint，发现变化便分配新 revision；
5. **caller 自然唤起**：先对所有仍保留的 view items 反查 canonical facts；事实 fingerprint 变化时推进
   revision，再仅注入相对 `presentedRevision` 尚未成功呈现的状态。
   成功 completed 后，pending/open 只推进呈现基线并保留；terminal/withdrawn 按 includedRevision 精确删除；
6. **失败 fail-back 与普通观察分工**：completed/canceled/interrupted 不自动续跑 caller；failed terminal 则与
   canonical response 原子提交一条指向 exact caller 的幂等 Queue-only `a2a_failure` 控制载体。它不新增公开
   result message，只驱动 caller 读取已有 failed response，且自身失败时不得递归生成下一条 fail-back。

因此 view 不是第四套 lifecycle，也不需要 `attemptId`：它的 key 已包含 sourceMessageId；同一 target 的两条消息
天然是两个 item。view 只保存 canonical owners 无法在事后重建的最小选择事实和“上次成功呈现到哪个 revision”，
执行裁决始终回到 Queue/History。

## 已确认的 Bug 现象（operator实测 2026-03-14）

### Bug 1: 队列消息提前显示气泡
- **复现**：猫猫正在回复中 → 用户发消息（自动进队列）→ 消息还在"排队中"面板 → 聊天流里气泡已经出现
- **期望**：队列面板显示即可，聊天气泡等到消息真正"送达"（dequeue 执行）时才插入
- **截图**：同一条消息同时出现在聊天气泡和排队面板（`1773488348921-03899885.png`）

### Bug 2: 取消后消息仍在气泡 + 仍进入猫猫上下文
- **复现**：用户在队列面板按 X 取消消息 → 气泡仍然留在聊天流 → 猫猫下次回复时 prompt context 里有这条已取消的消息
- **期望**：取消后气泡消失，猫猫永远不应该"看到"这条消息
- **实测证据**：operator发送 `嘿嘿大猫猫喵` → 取消 → 猫猫对话上下文中仍出现该消息

### Bug 3a: queued 用户 @mention 提前进入 pending-mentions（F117 scope）
- **复现**：用户发带 @gpt52 的消息 → 消息进入队列（排队中）→ `pending-mentions` 已包含该条目
- **期望**：queued/canceled 的用户 @mention 不应出现在 `pending-mentions`；delivered 后才进入
- **根因**：mention inbox 读取时只看 `msg.mentions`，不看 `deliveryStatus`

### Bug 3b: `cat_cafe_post_message` 的 @mention 路由异常（F117 out of scope）
- **复现**：猫猫用 `cat_cafe_post_message` 发带 `@gpt52` 的消息 → Maine Coon session 未收到
- **截图**：`1773488607773-f4b34f0a.png`
- **不属于 F117**：`post_message` 走 callback 路由（`callbacks.ts` → `messageStore.append` + `enqueueA2ATargets`），不经过前端 queue send，不依赖 delivery lifecycle
- **处置**：单开 callback @mention 路由 bug，F117 仅标记 `related`

### 根因链路（Maine Coon + Ragdoll调查确认）
1. `useSendMessage.ts:95-100` — 无条件乐观插入，不区分 queue/immediate
2. `messages.ts:249` — enqueue 阶段就持久化 user message，无 delivery status 标记
3. `messages.ts:700` — History API 不过滤 delivery status
4. `ContextAssembler.ts:99` — 不过滤 delivery status，未送达/已取消消息直接进 prompt
5. `queue.ts:99,249` — withdraw/clear 只删 queue entry，不处理已持久化的 message

## What

### Phase A: deliveryStatus 字段 + 后端收口

1. Message 模型新增 `deliveryStatus?: 'queued' | 'delivered' | 'canceled'`（老数据缺省 `delivered` 兼容）
2. enqueue 时 message 持久化带 `deliveryStatus: 'queued'`
3. MessageStore 默认读只返回 `delivered`（或无 deliveryStatus 的历史消息）；F264 后 owner-facing
   `GET /api/messages` 显式 opt-in durable queued user publication，cat cognition readers 不 opt-in
4. ContextAssembler 只组装 `delivered` 消息
5. Mention surfaces（`pending-mentions` 等）只返回 `delivered` 消息的 @mention
6. QueueProcessor dequeue 执行时：将 message 标为 `delivered`，扩展 `messages_delivered` 事件携带完整 user message payload
6. withdraw 单条：同步将 message 标 `canceled`，发 `message_deleted` 给前端
7. clear 队列：批量标 `canceled`，发批量 `message_deleted`

### Phase B: 前端适配

> 以下是 2026-03-14 的历史交付。F264 于 2026-07-21 仅 supersede “queued user bubble 何时对operator
> 可见”：显式 queue send 在 202 成功并拿到 durable message id 后插入；smart-default queued 保留并
> reconcile optimistic bubble。取消与 cat-context 隔离仍完全沿用 F117。

1. queue send 时**不做乐观插入**到主时间线（QueuePanel 仍通过 `queue_updated` 展示）
2. 收到扩展版 `messages_delivered` 事件时，将 user message 插入主时间线
3. 收到 `message_deleted` 时，从 store 中移除对应 message
4. F5 hydration 路径：history API 已过滤，无需额外处理

### Phase C: Dispatch 可视化唯一规范（normative，2026-08-31）

> **状态**：co-creator 已定稿；实现已在 PR #1398 的 feature worktree 完成，待跨家族 review 与体验验收。
>
> **权威边界**：本节是聊天前端 dispatch 可视化的唯一规范。F117 早期阶段、F173/F183、
> 架构审计或现有组件若与本节冲突，以本节为准；其他文档只能引用本节，不能再定义第二套
> UI 状态机。本节只投影已有生命周期事实，不新增 receipt ledger。

#### 一句话

**只表达两件事：谁正在处理或处理过这条消息，以及每条成员回复在回复哪条源消息。**

#### 统一领域模型

- 每条公开 History 消息都可以是 dispatch source，可被派给 `0..N` 个成员；发送者是 user、cat、
  IM connector、GitHub 通知或其他系统来源，都不改变渲染规则。
- 是否显示处理成员，只由这条消息是否存在可验证的 actual-target lifecycle 决定；没有 dispatch
  就自然没有头像，不按消息分类设例外。
- 前端只消费同一 domain snapshot：source 上的 `dispatchRefs`、其 `statusMessageId` 关联的 canonical
  response status，以及 response 上指回 source 的 `messageRef`。Queue pending、caller runtime view、carrier、
  source owner、文本内容和旧 dock 都不能补猜 actual dispatch。
- multi-target source 为每个成员独立投影状态；一个成员的终局不能覆盖、删除或代表 sibling。

#### 源消息头像：pending 无投影，actual dispatch 两阶段

| canonical fact | 视觉状态 | 含义 |
|---|---|---|
| 没有 actual dispatch；target 仅存在于 Queue `targets[]` 或 caller view | 无头像 | 没有成员正在处理 |
| `dispatched` + exact active run | 头像闪烁 | 该成员正在处理 |
| `settled` + linked terminal response | 头像静止保留 | 该成员本跳已经结束 |

- `completed / failed / canceled / interrupted` 在头像层都只是“结束”，统一为静止保留。
- 成功不显示 badge、勾号、额外文案或“已随本轮完成”。
- 失败或取消不在头像上新增符号；复用 canonical response 已有的轨迹/状态提示表达结果。
- 头像 hover 显示 `MM/dd HH:mm:ss 已投递`，时间取 `dispatchRef.dispatchedAt`（实际投递时刻，不是完成时刻）；点击头像跳到 `statusMessageId` 指向的 exact response bubble，并使用与「查看消息」相同的临时 lineage focus 标记目标。
- 任一 canonical read 不完整或映射多义时，不显示未经证明的动态头像，也不退回旧 receipt、消息 kind、
  文本或 carrier 推断。

#### 回复与引用

- 任一作为 dispatch result 的公开成员 response 都必须携带 `messageRef`，精确引用触发它的 source；
  引用呈现为现有 `↩ @源作者: 源正文…` 语义。
- source 是否需要引用由 lineage 决定，不由 author kind 决定。root source 没有上游就不造引用；completed
  response 若继续 dispatch 给下一跳，它同时成为新的 source，并在自身气泡上承载下一跳头像。
- processing 阶段只渲染 admission 已创建的**同一 response lifecycle 行**：成员脉冲头像加
  `CapabilityTipStrip`（无 tip 时为最小处理中动效）。它不是另造的 system/provider 状态消息；正文开始
  stream 后原位升级为 response 气泡，terminal 仍更新同一 identity。消息操作 dock 归真实气泡所有；只有
  lifecycle tip、尚无正文气泡时不得在作者行旁悬浮引用/复制按钮。
- 成功、失败、取消和中断都必须有一个可关联的 terminal response 气泡；不得另追加 system row、
  provider notice 或第二条状态消息表达同一结果。
- 结构化 `system_info warning` 默认是 provider/routing 诊断，留在日志/telemetry，不进入对话。只有显式标记
  `presentation=user_action_required` 的可操作提示可持久化；自动重试等短暂状态使用
  `provider_signal + presentation=transient_status`，只在 live 状态面显示。routing preflight `warned` 是 fail-open
  telemetry，只有实际改变投递的 `rejected` 才显示一次 receipt。Agent 自身的 route-syntax、
  verdict-without-pass、void-hold 纠正只进入下一 turn prompt、私有 feedback 与 telemetry，不追加公开 History 气泡。

截至 2026-09-15，生产代码中的 `warning` producer 已逐项核对，不按文案做黑名单：

| producer | 事实 | presentation / 用户呈现 |
|---|---|---|
| ACP capacity signal | 服务端容量不足，adapter 正在重试 | `transient_status`；仅 live 状态 |
| Antigravity retry signal | 已安排下一次自动重试 | `transient_status`；仅 live 状态 |
| Antigravity transient upstream error | 上游短暂错误，重试链仍在运行 | `transient_status`；仅 live 状态 |
| Codex item-level error | provider item 诊断；最终失败另由 response terminal 承载 | 未分类；仅内部诊断 |
| OpenCode missing token usage | adapter 缺少自动 handoff 所需遥测 | 未分类；仅日志/telemetry |

当前没有生产者声明 `user_action_required`；它是以后新增“用户必须采取动作”提示的显式 opt-in 契约，而不是默认值。
F296 的 oversized native rollover 生产者发出的是 `session_rollover_lifecycle`，不是 warning：透明 rollover 继续执行时
不需要气泡，rollover 失败时由同一 response terminal 承载，不另造“内容被截断”系统消息。

#### 失败传播

- **成员唤起的 dispatch 失败**：failed response 原位终局，source 消息上该成员头像转静止（失败终态）。
  同一终局事务为 exact source caller 提交一条幂等 Queue-only `a2a_failure` 控制载体；它引用该 failed response，
  不复制正文、不形成第二条 History/system failure，并在 route 层标记为 failure report 以禁止递归。caller 被唤起后
  读取同一 canonical failed response，再决定重分发、放弃或上报用户；这些后续决定才是新的显式普通消息。
- **未形成 provider response 的直接投递失败**（例如 target 在 actual admission 前失效）：投影为
  `delivery failure result` 的用户可见 system message "唤起 xxx 失败"；不伪造 response 气泡、不挂动态头像。
- 判据：**已进入 provider 的 → 原位 response 终局；未形成 provider response 的直接投递失败 → 才写
  `delivery_failure` system result。** 两者都只更新 source 的 exact dispatch ref，不另造回报消息。
- **失败正文必须完整且原样（2026-09-08 验收修正）**：failed terminal response 正文直接使用实际
  client/provider 调用返回的错误 message；同一 logical dispatch 有多次底层错误时，按发生顺序合并在同一
  response 正文。lifecycle 层不得翻译、概括、追加成员 id、来源消息 id、错误码说明或处置建议。成员由气泡
  header 表达，source 由既有 reply 引用表达，终态由既有 trajectory 表达。失败正文与其它终态回复一样进入
  可见性索引；不得另放进 system/provider notice、独立 live error 或只写日志。

#### 重试与默认信息密度

- terminal response 气泡只表达本次执行的完成、失败、取消或中断，不把历史 attempt 伪装成仍可执行的
  retry token。用户要重做时发送新的消息或发起明确的新动作，由生产者生成新的 source 与 Queue row；
  任何终态都不原位复活旧 Queue 工单。
- 默认界面不展示“普通执行”“查看本轮”“处理完成时间”、attempt aggregate 或独立
  “处理回执”区块。回复引用与头像三态已经完整覆盖用户需要理解的事实。

#### 必须删除的旧坐标

实现 Phase C 时必须删除，而不是继续修改：

- 独立 `MessageReceiptDock` / “处理回执”展示模型；
- `primary_trigger` suppression 与任何 user-vs-cat、kind/scope/channel 的 dispatch 渲染分叉；
- 与 canonical response identity 无关的 processing 空气泡、假 `Thinking...` 和 system/provider rows；
- 从旧 receipt、carrier、source owner、消息正文或当前成员身份补猜头像/终态的 fallback；
- 成功 badge、头像结果符号、完成时间戳、“普通执行”和“查看本轮”；actual dispatch tooltip 与 exact-response 跳转保留。

历史兼容只能在 READ 边界把旧记录规范化为同一 domain snapshot；不能在 React 渲染层保留第二条
legacy 路径。若规范化后仍没有唯一事实，就 fail closed，而不是添加分类分支或 fallback。

#### Phase C 不变量

1. **INV-C1 — 一条渲染路径**：user、cat、connector、GitHub/系统来源共用同一 projection；零分类例外。
2. **INV-C2 — 头像投影守恒**：pending/无 actual dispatch = 无；active = 闪；terminal = 静止保留。
3. **INV-C3 — exact lineage**：每个 dispatch-result response 必须引用 exact source；不得用当前 thread、
   当前成员或相邻消息猜引用。
4. **INV-C4 — 单一 processing 行**：processing 只显示 canonical response lifecycle 行（脉冲头像 +
   capability tip/最小动效）；stream 与 terminal 原位升级，不另造 placeholder 或 system row。
5. **INV-C5 — 单一终局**：一个成员一次 execution 只有一个原位 terminal response，不附加第二条状态消息。
6. **INV-C6 — 成功静默**：成功只有静止头像与正常回复；失败/取消只复用 terminal 轨迹提示，不加头像 badge。
7. **INV-C7 — 终态不复活**：failed/cancelled/interrupted response 只保留终态证据；重做来自新的用户意图。
8. **INV-C8 — 无展示 fallback**：legacy 只在 READ 边界规范化；渲染层不以 fallback 或 kind/scope 分支补事实。

### Phase D: 队列内核收敛（normative，2026-09-02）

> **权威决策**：[ADR-043 — 消息队列 = 独立持久化的有序工单账本](../decisions/043-queue-durable-single-ledger.md)
> **RFC 依据**：[A2A 消息投递、处理与交接生命周期架构](../architecture/message-delivery-handling-handoff-audit.md)（PR #1356）
>
> **本节是队列内核设计的单一真相源。** F039 / F122 / F175 / F047 中与本节冲突的描述以本节为准。

#### D.1 职责边界

```
queue entry = 一条尚待投递的 source message（完整 payload + pending targets[] + 顺序）
history message = 已发生至少一次 actual dispatch 的公开内容 + dispatchRefs
response bubble = 每个 actual target 的 processing / terminal 结果
caller dispatch view = 单 runtime 内该成员自己发出的 source×target 变化索引
```

Queue 只拥有 pending，不保存 actual dispatch、processing、seen/handled、terminal 或 retry receipt。每个 target 的实际投递与结果归 History lifecycle。caller dispatch view 只保存“需要在后续自然 turn 重新核对哪些 source×target revision”，不成为持久 truth。

#### D.2 根因（实读证据）

1. **同一 source 被拆成多条 Queue rows**：用户只发送一次 `@B @C`，存储与 Queue UI 却出现 B/C 两个工单身份，无法自然表达“这是一条消息、还有哪些目标未投递”。
2. **Queue 与 Message 双写 lifecycle**：processing/terminal/seen/handled 同时出现在 Queue delivery、message receipt 与 response bubble，违反 RFC L1。
3. **History 提前 publication**：queued user message 在共同 History 中占位，又由 Queue 维护另一套顺序；Steer/reorder 后两者天然分叉。
4. **正常并发被 stale CAS 放大**：Steer 弹窗打开后某目标已由未读接管，本应跳过该目标继续，却被整批 conflict 拦截。

#### D.3 收敛决策（详见 ADR-043）

| # | 决策 |
|---|---|
| D1 | QueueEntry 按 thread 独立持久化；一条 source message 只有一条 entry |
| D2 | `targets[]` 只保存 pending targets；actual dispatch 后删除 exact target，空数组时删 entry |
| D3 | `sourceRecordId` 是消息 identity；`from` 是结构化作者/provenance，两者正交 |
| D4 | 用户/external inline source 第一次 actual dispatch 才进入 History；Agent/completed source 已在 History，只建立 message-ref wake |
| D5 | `dispatchRefs` 没有 `assigned`；actual dispatch 直接创建 `dispatched`，terminal 推进 `settled` |
| D6 | Queue mutation 由 Lua/CAS 原子维护 payload、targets、revision 与 order；schema v1 per-target rows 幂等聚合为 v2 source row |
| D7 | Steer 打开只读；确认时重读 Queue+History，跳过已 dispatch targets并原子刷新 pending set，不把正常并发当整批 stale；提交成功后更新 caller runtime view revision |
| D8 | Queue 不保存 processing/terminal/seen/handled/attempt receipt；Retry 只能创建新的 source/attempt |

实现边界：Queue row 只回答“哪条 source 还在等谁”；History 只回答“实际投给了谁、结果是什么”；caller runtime view 回答“这个成员下一 turn 还需核对哪些自己发出的 dispatch 变化”。一条 `@B @C` 在 UI 和存储中始终是一条 source message，B 已投递时 entry 原位只剩 `targets=[C]`。

#### D.4 一并修正的实现偏离

- **§6.4 一次 try-drain 一条 source**：相同 target 也不合并相邻 entry；每条消息的 identity、正文、History 顺序与 dispatchRefs 保持独立。
- **author 与 owner 解耦**：新 Message 写入携带判别式 `from`；读取旧 row 统一经 `messageFrom`。Queue scope 使用判别式 `owner` 并经 `queueOwner` 访问。存储 owner/tenant 的真实 `userId` 不属于 author 污染，继续保留。

#### D.5 不会简化的部分（诚实边界）

Queue 的短暂 claimed 状态仍可存在于“原子取出 pending target → provider admission”窗口，但它只是可恢复的 mutation snapshot，不是 durable processing truth。公开 processing 只由 response bubble + exact Active Run 表达；启动失败也原位终局该 bubble。

### Phase E: 验收修正（normative，2026-09-03）

> 来源：co-creator 在 #1398 worktree（验收实例 Redis 6388，thread `thread_mtkx52e4rmlvopk5`）的体验验收；根因由 Ragdoll(Fable) 数据 + 代码双证，实施由 Maine Coon(sol)。
> **权威决策**：ADR-043 D8（完整读取即接管）、ADR-043 D9（停止阶梯）。

| # | 验收现象 | 定性 | 修正 |
|---|---|---|---|
| E1 | 猫的历史回复不进入其他猫的未读 / `get_thread_context`（codex resume 只见 co-creator 消息） | 实现回归：退役 custody 脚本时丢掉了 terminal commit 的 visibility 分配 | 两个 terminal commit Lua 恢复 validate-before-write 的 `visibilitySeq` 分配；隔离 Redis 测试断言「猫回复对其他猫 cursor 可见」；存量数据 repair |
| E2 | 被 @ 的成员头像不再脉冲，回复气泡固定「正在回复…」没有 tips | 设计取舍被验收否决：`833aa0587` 删除了 `PendingMemberBubble` / `CapabilityTipStrip` 消费者 | processing 态 lifecycle 回复行即新的 pending bubble：头像 `streaming` 脉冲 + `CapabilityTipStrip`；message 下小头像与回复气泡共用同一 `activeRun` 状态 |
| E3 | 猫通过未读读到 queued wake 后，该 target 仍留在队列 | 设计修正 | 无 filter 完整读取 = exact active child 实际接管该 target：从同一 source entry 的 `targets[]` 删除该成员并创建 History dispatch ref；siblings 留在原 entry；Queue 不另存 seen/handled |
| E4 | 狸花猫 Steer 无「立即发送，引导回复」；旧设置把 append 能力与排队/立即意图混为一项 | UI 与契约错误 | 默认发送策略收敛为「排队等待 / 引导当前回复」，放在输入框左侧 `+` 菜单并可在 idle/active 任意时刻调整；设置只保留持久的「本 Thread / 全局默认」，不再提供与 Steer 重复的「仅这一次」或「恢复继承」。active 时右侧只保留 Stop，输入正文后增加一个普通 Send，发送只 admission 一次，再由 Queue 按策略处理；无 `@` 时该 admission 由服务端绑定最近 completed responder/default，但不伪造 source mention。Queue Steer 固定为「立即发送，引导回复 / 立即发送，中断回复」，多选成员并逐成员选策略；静态 client capability 随成员信息投影，不支持 guide 时才禁用引导并在 disabled action 的 hover/focus tooltip 说明原因；是否已有 active reply 不参与弹窗能力判断，出队时无 active parent 则由 canonical admission 降级为新 invocation；历史 targetless 绑定与新增 targets 在同一 source entry 原子完成 |
| E5 | 失败正文与系统提示重复成两个公开气泡；dispatching member 没有及时处理失败的 exact control edge | 实现 | 失败细节合并进唯一 terminal failed response；exact A2A failed 同事务创建引用该 response 的幂等 Queue-only `a2a_failure` carrier；Phase H 也可在 dispatching member 下一次自然 invocation 反查 exact source×target History 终态 |
| E6 | 「执行中」与 QueuePanel「等待 xxx 当前回合」重复；气泡浮窗「查看轨迹」冗余；首个轨迹 chip 位置 | UI 冗余 | 去横幅、去按钮、轨迹 chip 置于引用 chip 之后 |
| E7 | 「卡住了？强制重置」常驻 / 「运行状态待确认」红横幅 | 设计（补丁化逃生舱） | ADR-043 D9：停止是唯一动作；无活候选时服务端就地对账；进程快照不可用时按 failed 终局并沿 Phase C 失败传播回溯上游；无任何确认弹窗 |
| E8 | Agent 把导航中的「最近活跃」误读成成员仍在执行，且无法从现有 `get_thread_context` 核验 | A79 实现缺口：UI 已有 exact lifecycle 投影，Agent 侧仍只有发言新近性 | `dispatched` source ref + processing response + 唯一 `LifecycleActiveRun` 组成共享 exact predicate；同一投影注入新 invocation 导航并由 `get_thread_context.situation` 只读返回；任一 join 不完整即 `complete=false`，不按最近发言猜运行态；D12 改名「最近发言」 |
| E9 | fail-open 路由 preflight 每次发送都产生「需注意」聊天提示，且同一次发送重复 | 可见性边界错误 | `warned` 只进入结构化 routing evidence / telemetry；只有确实改变投递结果的 `rejected` 才生成用户可见 receipt |
| E10 | History 仍提供旧「撤回并编辑」，并同时存在直接分支 / 编辑分支两个入口 | 旧模型残留 | terminal History 不再撤回 Queue 工单；只保留一个「创建分支」入口，打开预填正文的编辑确认，正文未改也可直接确认创建 |

### Phase F: Carrier 能力真相与副作用出口收敛（normative，2026-09-09）

#### F.1 配置只有一个 canonical 坐标

成员配置统一使用顶层 `carrier`，Hub 文案统一为「接入方式」。兼容只允许存在于成员配置读取边界：

```text
carrier → legacy top-level transport → cli
```

读取完成后，所有 registry、provider、route、capability 与 Web 代码只接收 canonical `carrier`；不得继续读取
`transport`、`cli.carrier`、`codexCarrier`、`adapterMode` 或全局 `CAT_CAFE_CODEX_CARRIER`。兼容层不替换无效值、
不跨 provider 猜测，也不静默切到另一种接入方式。

| client | 合法 carrier | 能力边界 |
|---|---|---|
| Claude | `cli`, `sdk` | `sdk` 是 live session，可在执行中接收新增正文与显式中断；`cli` 是单轮进程 |
| Codex | `cli`, `app_server` | `app_server` 是 live session；`cli` 是单轮进程 |
| Kimi | `cli`, `acp` | 本轮不新增 Kimi live adapter；只保留既有显式选项 |
| OpenCode | `cli`, `acp` | 本轮不新增 server carrier；OpenCode 1.17.3 的 `/config` 是 directory-scoped 持久配置，不能承载 invocation-scoped MCP 凭据 |
| Gemini | `cli`, `acp` | 由显式配置选择 |
| generic ACP | `acp` | 不允许伪装成 CLI |
| 其他 client | `cli` | 只有单轮能力 |

这些选项彼此平级，不是 fallback 链。选择的 carrier 启动、鉴权或协议失败时，本次 response 原位 failed；
不得偷偷改用另一 carrier 后继续执行。

#### F.2 `post_message` 是纯发送，不是 inbox 门卫

F254 Phase A HELD、B1 MCP-result piggyback、B2 hold-ball reminder，以及 Queue 行上的人工「提醒」旁路在本轮退役。Queue
只展示 pending targets 与 History `dispatchRefs` 推导出的已读状态；用户要改变一条 Queue 消息的投递方式时只使用 Steer，
不再另外持久化 reminder attempt 或通过另一条 endpoint 向 active turn 注入提示。`post_message`、
`cross_post_message`、`multi_mention` 只执行调用方明确请求的写入/分发：

- 不顺便检查调用猫的 inbox 或 freshness；
- 不因存在 unseen message 拒绝本次发送；
- 不返回 `Message NOT sent (HELD)`；
- 不提供 `acknowledgeHeld` 绕过参数；
- 不在工具结果里教育模型调用另一个 MCP 工具补救。

这不是放弃运行中消息，而是把责任放回 delivery/carrier：支持 live input 的 carrier 由 QueueProcessor 对 exact
active invocation 执行 append 或 interrupt；单轮 CLI 对 append 诚实报告不支持，消息继续作为 pending Queue
工作，待当前执行结束后由正常 FIFO drain 启动下一轮。MCP 工具不再代偿 provider transport 的能力差异。

`guide_reply` 的保证边界是：正文进入同一 active client session/execution，并在该 session 的下一次模型输入边界
参与推理；它不声称能改写一个已经发出的底层 LLM HTTP 请求。`interrupt_reply` 则先对 exact active run 发协议
中断，再把正文交给同一成员的新一轮处理。

Codex `app_server` 的 native thread 所有权属于 provider 状态，而 HostPool lease 只能证明本进程内的占用。Queue 与
invocation 即使完全串行，前一轮 WebSocket 在本地 close 并释放 lease 后，provider 仍可能尚未完成 writer detach；同一
warm affinity host 上紧接着建立的新连接因此会在 `resume` 暂时收到 active writer。进程重启遗留或另一客户端也可能形成
同样的 provider 状态，但都不是第二条 Queue dispatch。该冲突不是消息或任务失败，也不得成为公开错误 bubble。运行时
只在首次冲突时淘汰可能陈旧的本地 affinity host，随后保持同一 native thread、同一 invocation 与同一 History lineage
做可取消的退避等待；不得新建替代 session、不得重放用户消息，也不得把被丢弃 probe 的 failed/closed lifecycle 投影
给用户。只有用户显式 Stop/取消才结束这段等待。

#### F.3 source × target replay 必须在持久真相上 fail closed

任何 Queue admission、A2A、multi-mention、connector wait continuation 或恢复路径，在唤起 target 前都必须以
History `dispatchRefs` 对 exact `sourceRecordId × targetCatId` 做原子 join/CAS：

1. 若该 target 已有 actual dispatch（无论 response 正在执行还是已终局），只清理残留 pending target，绝不再次唤起；
2. multi-mention 必须先创建一条正文完全一致、可引用的真实 Agent History source，再将它与同一 `targets[]`
   Queue entry 原子提交；callback response 只作为父 lineage，不能拿它的 id 指向另一段 synthetic Queue 正文；
3. wait/connector carrier 必须同时匹配 canonical task 的 thread、owner、当前 outcome identity、fence 与 generation，
   且 outcome 尚未 delivery terminal；历史 generation、已送达 outcome 或旧 connector message 不得重新准入；
4. 重放可以幂等清理脏 Queue index，但不能生成第二个 response、第二条 source message或第二次 provider side effect。

Queue pending 与 History actual dispatch 仍是两个 owner；一致性依赖固定提交顺序和单调幂等 join，不新增第三套
“已消费 connector”receipt ledger。

### Phase G: Managed hold 统一恢复（normative，2026-09-10）

`hold_ball` 只负责声明一个跨 invocation 的持久等待，并把等待原因、条件和下一步写成一条 owner-bound
History system message。该消息对 operator 与 thread 中所有成员使用同一份持久投影：人通过消息气泡理解等待，
成员通过正常 History/context 读取同一事实；不得另造仅某只猫或仅 UI 可见的 hold 状态。

条件满足后的恢复复用完整消息生命周期：

1. producer 以 exact task/thread/owner/target fence 幂等创建一条 `deliveryStatus='queued'` 的
   `managedHold:true, phase:'wake'` system source；
2. source 进入同一成员的 canonical Queue，priority 为 `urgent`。排队阶段不出现在 History，也不进入任何成员
   context；只有实际 Queue admission/dequeue 后才以同一 message identity 进入 History；
3. admission 创建唯一 response bubble，processing、正文、成功、失败、取消和中断均原位更新该 bubble；provider
   唤起失败同样归这条 response，不新增 hold-specific error row；
4. 其他成员与 operator 在 History 中看到同一等待、唤醒和 response 终局，因此后继成员可直接续上，无需读取
   BallCustody 或解释隐藏 disposition。

普通 A2A 和 managed hold 的完成由 `source → Queue admission → response terminal` 自然闭环。它们不再写
`ball.handed / ball.dispatch_dispositioned / ball.hold_dispositioned`，不再要求
`cat_cafe_complete_a2a_dispatch` 或 `cat_cafe_complete_managed_hold`，也不进入 F167 turn stop gate。Ball/lease
只保留给真正独立于消息投递的 durable action-successor responsibility；`hold_ball` 自身仍保留等待条件、取消和
跨 invocation 恢复状态，但它不是第二套消息完成账本。

历史 Ball events 与旧 task 字段只读兼容，不参与新写入或执行裁决。新路径不得根据旧 disposition 缺失重试、
escalate 或阻止 provider 输出提交。

### Phase H: 发出者自有逐目标生命周期观察（normative，2026-09-14）

普通 A2A dispatch 建立一条 source→target delivery lifecycle。terminal observation 不依赖 target 回复正文的
`@caller`、完成声明或传球措辞；合法的显式 `@caller` 仍按普通 dispatch 路由。completed/canceled/interrupted
不会自动续跑 caller；failed terminal 是例外：它必须原子提交 exact、幂等、Queue-only 的 `a2a_failure` 控制载体，
让 caller 处理既有 canonical failed response。该载体不是第二条结果或新的责任账本，也不得递归 fail-back。

客户端单 runtime 在每个 caller 自己的串行 slot 中维护一个**进程内、可丢弃的 outbound dispatch view**。
source message、Queue 与 `dispatchRefs` 的持久语义保持不变。每个 view item 保存
`(ownerId, threadId, callerCatId, sourceMessageId, targetId, revision, presentedRevision)`，以及无法从当前
Queue/History 反查的最小变更事实：`firstAddedBy = initial | steer | unknown`、最近一次已提交的
`selectionChange = added | removed`，以及 `selectionChangedBy = initial | steer | queue_withdrawal | unknown`。
这些字段只用于向 caller 解释变化，不参与调度或 actual-result 裁决：

1. Agent caller 的 source Queue admission 成功提交后，以当时解析出的 exact targets 初始化 view items；同一 caller
   随后发送另一条 source，只追加新的 source×target items，不覆盖先前尚未观察完成的记录。无法解析出 canonical
   targetId 的 mention 只保留 routing diagnostic；
2. Steer 对尚未 actual dispatch 的 target 做 remove/add 后，用已经提交成功的 Queue mutation 更新同一 view item
   revision 与 selectionChange。C 被移除后即使已不在 Queue，view 仍能说明 not-delivered/withdrawn；E 被加入时
   firstAddedBy=steer。若本进程首次看到的是重启前遗留 target 的 remove/actual 事件，无法证明最初加入来源时必须
   记为 unknown，不能猜 initial。若 actual admission 已赢得并发，History ref 优先，旧 Steer snapshot 不能把 target 改写为未投递；
3. 已进入 durable Queue、但在 actual admission 前变为不可用的 target 不能在 caller view 中静默消失；canonical
   `delivery_failure` 作为它的 actual result。若 target 在 durable Queue admission 前就被 routing preflight 拒绝，
   则由本次发送结果立即返回 typed fail-back，不能伪造 view item。actual admission 与 response terminal 也只刷新对应 view revision，真实 result/status/response
   identity 始终从 source `dispatchRefs[]` 与 canonical response 反查，不缓存成第二份权威状态；
4. caller 下一次因正常 Queue/user/member/continuation 原因启动时，pre-prompt projection 先对**所有仍保留的
   items**逐项 join 当前 Queue 与 History：Queue 仍含 target = pending，History ref open = executing，settled ref =
   canonical terminal，最近一次
   已提交 view mutation 为 remove 且没有 actual ref = not-delivered/withdrawn。scope 不符或映射多义时显式 unknown
   并保留，不能从 Active Run 消失、消息未读 cursor 或回复语义推断。projection 校验候选快照仍有效，以
   canonical fingerprint 变化推进 revision，然后才筛选 `revision > presentedRevision` 的未呈现变化进入 prompt；
5. projection 在读取 item 时冻结 `includedRevision`；最终 prompt 中的文字与这个快照绑定。异步 Queue/History
   查询期间发现 item revision 已变化时，必须重读或保留为待核对，不能把旧正文事后标成新 revision。item 删除后
   同 key 重建也必须获得严格更大的 revision/epoch，不能复用已确认身份；
6. caller invocation 成功提交 `completed` 后，pending/open item 只把 `presentedRevision` 推进到
   `includedRevision` 并继续保留，未变化时后续 turn 不重复注入；terminal/withdrawn item 仅在 current revision
   仍等于 `includedRevision` 时 compare-and-clear。若 prompt 包含“C 已移除@rev2”，但完成前 C 又被重新选择为
   rev3，rev2 的确认不得清除 rev3。token budget 裁剪、启动失败、provider 失败、取消、终局提交失败或 current
   turn 新增的 source/revision 都不确认；
7. completed/canceled/interrupted 只刷新 History lifecycle 与 caller 的下次观察结果，不创建 `a2a_result` wake；
   failed terminal 则把 canonical response terminalization 与一条 exact caller `a2a_failure` Queue control carrier
   原子提交。控制载体不新增 History/system message，重放按 response identity 幂等，且消费它的 route 禁止再次
   生成 fail-back；它也不登记为失败方新发起的 outbound business dispatch 或 caller-view item。target 主动
   `@caller` 仍是一条新的普通 dispatch；非失败结果若要求自动续跑，必须显式注册 continuation；
8. `activeRuns` 继续独立回答「当前 thread 中谁确实正在执行」，供 operator 与所有成员共享；caller observation
   回答「我发出的 source 对各 target 已提交了哪些选择变化和实际结果」，不能从 active run 消失、消息未读 cursor
   或最近发言推断；
9. 进程内待观察索引不持久化，也不在 API runtime 启动后扫描 History 重建。每个
   `(ownerId, threadId, callerCatId, processGeneration)` scope 在下一次自然 invocation 获得一条固定大小的
   `process_start` 说明：当前 observation 仅覆盖本进程登记的 dispatch；更早的结果仍在 canonical History，
   需要时按需读取。说明不推断旧 dispatch 状态、不声称指针丢失、不创建 Queue work 或隐藏 wake，也不清理
   当前进程 observation。它只有在实际进入最终 prompt 且 caller invocation 成功提交 `completed` 后才确认；
   裁剪、启动失败、provider 失败或取消后必须在下一次自然 invocation 重试，同一 process generation 成功交付后
   不重复。普通 cold/binding mismatch 不重置确认状态。

runtime restart 后，actual dispatch/result 仍可从 canonical History 查询；`firstAddedBy`、Steer remove/add 与
`presentedRevision` 这些只存在于旧 runtime view 的说明不保证恢复。`process_start` 必须诚实说明这一边界，不能
把新进程里无法证明的旧选择变化重新推断出来。

这份 view 专门解决“Agent caller 下一次被唤起时如何知道自己先前发出的多条 dispatch 后来怎样了”。operator
不需要 prompt 注入：用户表面继续直接读取当前 Queue Panel、source `dispatchRefs` 与 canonical responses；两者共享
同一底层事实，但不能为了统一称呼而把 Agent runtime view 持久化成用户 receipt ledger。

这条观察链只优化同一客户端 runtime 内的连续体验；若未来支持多 API worker、滚动切换或跨节点 caller slot，
必须改为从 History 的可重建 caller-dispatch 索引逐 turn 查询，不能把当前进程内集合升级为第二份权威状态。

## Acceptance Criteria

### Phase A（后端 — deliveryStatus 真相源） ✅
- [x] AC-A1: Message 模型支持 `deliveryStatus` 字段，老数据兼容
- [x] AC-A2: enqueue 持久化 message 时 `deliveryStatus='queued'`
- [x] AC-A3: History API 默认排除 `queued` 和 `canceled` 消息
- [x] AC-A4: ContextAssembler 只组装 `delivered` 消息（含无 deliveryStatus 的历史兼容）
- [x] AC-A5: dequeue 执行时 message 标为 `delivered` + 扩展 `messages_delivered` 事件
- [x] AC-A6: withdraw 将 message 标 `canceled` + 发 `message_deleted`
- [x] AC-A7: clear 队列批量标 `canceled` + 发批量 `message_deleted`
- [x] AC-A8: 回归测试——queue send → cancel → history API 不返回、ContextAssembler 不组装
- [x] AC-A9: queue send 带 @mention 的消息 → delivered 前 `pending-mentions` 不返回；delivered 后才出现

### Phase B（前端适配） ✅
- [x] AC-B1: queue send 不做乐观插入到主聊天流
- [x] AC-B2: `messages_delivered` 事件触发 user bubble 插入主时间线
- [x] AC-B3: `message_deleted` 事件触发 store 移除
- [x] AC-B4: F5 刷新后 queued/canceled 消息不出现在聊天流
- [x] AC-B5: QueuePanel 功能不受影响（仍通过 `queue_updated` 正常展示）
- [x] AC-B6: queue send 多行消息（Shift+Enter）时不出现 optimistic bubble；delivered 后只出现一次

### F264 owner-timeline 演进（2026-07-21，已由 Phase D supersede）

以下四项是历史验收记录，不再描述 live contract；当前模型的 queued input 只在 Queue Panel，第一次 actual dispatch 后才进入 History。

- [x] AC-B7: durable queued user message 从 Queue admission 起可由 owner-facing history/F5 水合，仍不被 cat callback/context 读取
- [x] AC-B8: explicit queue send 等 202 durable id 后插入；smart-default queued 不删除 optimistic bubble
- [x] AC-B9: terminal delivery 更新同一 bubble 的 receipt/deliveredAt 并保留 authoring-time 顺序，不复制正文
- [x] AC-B10: canceled 消息继续由 `message_deleted` 移除，owner history/F5 也不返回

### Phase C（Dispatch 可视化重建，2026-08-31）

- [x] AC-C1: user、cat、IM connector、GitHub/系统来源在同一 renderer 中只按 actual dispatch facts 投影头像
- [x] AC-C2: pending/无 actual dispatch、active、terminal 分别稳定呈现为无头像、闪烁头像、静止保留头像
- [x] AC-C3: 每个 dispatch-result response 都带 exact `messageRef`；completed response 可作为下一跳 source
- [x] AC-C4: processing 只渲染 canonical response lifecycle 行（脉冲头像 + capability tip/最小动效）；
  不创建独立空气泡、假 `Thinking...` 或状态 system row，stream/terminal 原位升级
- [x] AC-C5: 成功不加 badge/文案；失败与取消复用 terminal 轨迹提示，头像不加结果符号
- [x] AC-C6: terminal response 不提供旧 Queue attempt 的原位重试；旧 dock、完成时间戳、“普通执行”“查看本轮”删除；头像保留 actual-dispatch 时间与 exact-response 跳转
- [x] AC-C7: React 渲染层没有 `primary_trigger`、author/kind/scope/channel 分叉或 legacy receipt fallback
- [x] AC-C8: F5 hydration 与 live socket 对同一 source/target lifecycle 产生相同头像、引用与 terminal 投影

### Phase D（队列内核单账本，2026-09-02；2026-09-07 canonical 修订）

- [x] AC-D1: Queue row 独立持久化并可在启动时 hydrate；一 source 一 entry，Message 不镜像 Queue pending 状态
- [x] AC-D2: multi-target 使用同一 `targets[]`；普通 drain 一次领取本轮完整 exact target set 并并发 fan-out，Steer/未读接管可领取 singleton；每个 target 在 receiver/ref durable 后独立删除，未完成或未领取 siblings 原位保留，空数组删 entry
- [x] AC-D3: `enqueue` / `claim` / target mutation / `restore` / reorder 均由 Redis Lua 原子转换，Memory/Redis 语义同构
- [x] AC-D4: 第一次实际投递 materialize History；后续 target 复用同一 message；`dispatchRefs` 直接从 `dispatched` 到 `settled`
- [x] AC-D5: Steer 确认时重读 live Queue+History，跳过已投递成员；用户增删 pending targets 不撤销既有 dispatch
- [x] AC-D6: processing/terminal/seen/handled/attempt 不持久化到 Queue；失败、取消、中断均不回队
- [x] AC-D7: 一次 try-drain 只领取一条 source；相同 target 不合并 Queue admission，每条 source 保持独立 message identity、顺序、ref 与 invocation
- [x] AC-D8: Redis hydrate 对旧/损坏 row fail closed；**同一 QueueLedger key family 内**的 schema v1 per-target rows 幂等迁移为 v2 source row，canonical terminal 不导入 Queue。该迁移不宣称覆盖 live `main` 的 MessageStore `queueCustody*` 基线；跨 owner 的历史切换见 replay ledger §9。
- [x] AC-D9: terminal work 不可复活；重做必须由新用户意图产生新 source/attempt
- [x] AC-D10: targetless 队首（历史无目标 row 或带无效显式 `@` 的 warning-bearing row）在 thread 有活跃执行时原位等待，不绕过、不猜目标；thread 空闲后才走 canonical resolver。无 `@` 的普通新输入则在 source+Queue admission 前绑定最近 completed responder/default；只有 resolver 最终仍无可用目标时才 terminal failure

### Phase E（验收修正，2026-09-03）— 代码与跨族复审完成，完整 worktree UAT / fork soak 待完成

- [x] AC-E1: 隔离 Redis 下，猫的 terminal 回复获得 `visibilitySeq` 并进入 `msg:visibility` index；另一只猫的 cursor 读（prompt 增量 / `get_thread_context`）返回该回复
- [x] AC-E2: processing 态 lifecycle 回复行显示脉冲头像 + capability tip；message 下小头像与回复气泡由同一 `activeRun` 驱动；恢复 capability-tip 组件测试
- [x] AC-E3: 无 filter 完整读取实际接管 exact target，并从同一 source entry 的 `targets[]` 删除；siblings 独立保留；无 Queue seen/handled row；读取仍 200；原消息保持 authored 顺序
- [x] AC-E4: 默认设置只表达「排队等待 / 立即发送，引导回复」；普通用户输入没有 `@` 时，服务端在 source+Queue 原子 admission 前用 canonical resolver 选择最近 completed response target、再退全局默认，并持久化为 Queue target，source mentions 仍保持空；ChatInput / QueuePanel Steer 对 participants、路由目标与同一 fallback 投影的去重并集提供多选，不在 Web 猜测，并为每个 pending target 独立选择「立即发送，引导回复 / 立即发送，中断回复」；静态 client capability 随成员信息返回，UI 不硬编码；引导只对 exact active parent invocation 生效，并由 adapter 的独立 `activeInvocationGuidance` 声明授权，不能从 `deliverySemantics` 推断；`exact_active_turn` 只证明当前可见 provider turn 精确读取，`queued_internal_turn` 只证明下一内部轮次读取；不支持则禁用并说明；打开弹窗不写 membership，确认时重读 live Queue+History，跳过已投递/不可用成员并加入新选成员；历史 targetless recovery 的首目标与新增 targets 在同一 source entry 原子完成，后续各 target 独立终局
- [x] AC-E5: 失败 response 只呈现一次；正文逐字采用实际 client/provider error message，同一 logical dispatch 的多次错误按发生顺序合入同一气泡，不由 lifecycle 层追加成员/source/error-code/建议；另一只猫的 cursor 读能读到同一 failed response 并可把它作为下游 source，无需用户转达；live 与 hydration 不生成第二条 system/provider error；成功的 `runtime_replacement` 不生成 source-less continuation；A2A failed terminal 与 exact caller 的幂等 Queue-only `a2a_failure` 控制载体原子提交，控制载体引用 canonical response、不进入 History且禁止递归
- [x] AC-E6: QueuePanel 横幅、浮窗轨迹按钮移除；轨迹 chip 位置符合验收描述
- [x] AC-E7: 对已确认死亡的 exact execution，Stop 返回 200 `reconciled` 而非 409；进程快照不完整时服务端有界重试后按 failed（reason `control_plane_unavailable`）终局并返回 200，失败沿 Phase C/Phase H 收敛（源 dispatchRef settle、exact A2A caller 由 Queue control edge 及时唤起、其他观察反查 History、pre-start 走 `delivery_failure`）；不做平台兼容分支，Windows 子进程不可观测时同样走 fail 收敛；确认无 owner 的 read-repair 使用 `execution_owner_lost`，pre-start processing 超时使用 `prestart_timeout`；单个 child 失败不终局仍有 tracker/process-owner 见证的 sibling parent；`ForceResetDialog` 退役，`ThreadExecutionBar` 无常驻/卡死触发的强制重置入口、无「运行状态待确认」横幅；投影 read-repair 落地，pre-start 预留 TTL 收窄到 create→startAll 窗口
- [x] AC-E8: UI 消息头像、Agent invocation 导航和 `cat_cafe_get_thread_context.situation` 共用 A79 exact predicate；返回 target/source/response/invocation，完整空集明确表示无其他成员执行，证据失配返回 `complete=false`；发言新近性只标「最近发言」，不得成为运行态 fallback
- [x] AC-E9: routing preflight 的 fail-open `warned` 只进入 evidence / telemetry，串行、并行和 A2A admission 均不生成聊天消息；`rejected` 仍生成一次可见 receipt
- [x] AC-E10: terminal History 无「撤回并编辑」；只保留一个「创建分支」入口，以原正文预填编辑框，正文不变也可确认创建
- [ ] AC-E11: co-creator 在 feature worktree 完成上述完整旅程体验验收，随后合入 fork 并通过 soak；在这两道硬门前不得推进上游 merge
- [x] AC-E12: 空 processing lifecycle 只有头像/tip、没有 message action dock；未分类 provider warning、routing `warned` 与 Agent protocol correction 不生成聊天气泡，只有显式 `user_action_required` warning 可持久化，`transient_status` 只走 live provider status

### Phase F（carrier 与副作用出口，2026-09-09）— UAT 修订中

- [x] AC-F1: 成员配置只向下游暴露 canonical `carrier`；唯一兼容读取顺序为 `carrier → transport → cli`，非法 client/carrier 组合 fail closed
- [x] AC-F2: Claude `sdk` 与 Codex `app_server` 在 exact active session 上支持 guide/interrupt；OpenCode `server` 因 directory-scoped 持久配置无法隔离 invocation MCP 凭据而退役，OpenCode 仅保留 `cli` / `acp`；单轮 `cli` 不谎报 append 能力，且任何 carrier 失败都不静默 fallback
- [x] AC-F3: `post_message` / `cross_post_message` / `multi_mention` 不检查 inbox、不 HELD、不接受 `acknowledgeHeld`、不附加 freshness/hold-ball 教学；F254 Phase A/B1/B2 active wiring 退役
- [x] AC-F4: A2A 与 response terminal admission 在 exact `sourceRecordId × targetCatId` 已有 History dispatch 时幂等 no-op；已消费 Queue source replay 不产生第二次唤起
- [x] AC-F5: multi-mention 的 Queue source 是一条真实、正文一致、可引用的 Agent History message；callback response 只作 parent lineage，不能充当 synthetic source identity
- [x] AC-F6: connector wait continuation 在准入前验证 canonical task 的 exact outcome、fence、generation 与 delivery terminal；历史或已交付 carrier fail closed
- [ ] AC-F7: co-creator 在 feature worktree 验证 live carrier append/interrupt、单轮排队、multi-mention lineage 与 connector replay；随后进入 fork soak
- [x] AC-F8: terminal coordination 后，只有**不带任何显式路由凭据**的礼貌回复可记为 quiet ACK；显式行首 `@` 与 structured `targetCats` 都是新的 active routing hop，必须入 Queue 唤醒目标，且继续受统一 loop-streak 防乒乓约束

### Phase G（managed hold 统一恢复，2026-09-10）— 代码与测试完成，待体验

- [x] AC-G1: hold registration 只持久化一条 owner-bound waiting History message；operator 与所有 thread 成员读取同一内容
- [x] AC-G2: timer/command condition 只创建一条 exact fenced、urgent、queued wake source；actual Queue admission 前不进入 History/context
- [x] AC-G3: wake dequeue 后复用普通 response lifecycle，唯一 response bubble 原位承载 processing 与任意终态
- [x] AC-G4: ordinary A2A/managed-hold 新路径不写 Ball disposition，不要求 completion MCP，也不触发 turn stop gate；action-successor gate 保留
- [x] AC-G5: completion MCP 从 callback/API/tool registry/governance baseline 同批删除，且不存在可调用别名或双轨 fallback
- [ ] AC-G6: co-creator 在 feature worktree 验证「等待可见 → 条件满足进入优先 Queue → 出队后单一 response 终局 → 其他成员可读」完整旅程

### Phase H（caller outbound dispatch view，2026-09-14）— 实现与跨族复审完成，完整 UAT 待完成

- [x] AC-H1: Agent source Queue admission 成功后，按 exact `(owner, thread, caller, sourceMessageId, targetId)` 初始化 runtime view；item 保存 monotonic revision/presentedRevision、firstAddedBy、最近 selectionChange 与 selectionChangedBy；若当前进程首次观察到的是遗留 remove/actual 事件，firstAddedBy 必须为 unknown；同一 caller 的后续新 source 只追加 items，不覆盖旧 source；无 canonical targetId 的解析失败只记 routing diagnostic
- [x] AC-H2: Steer remove/add 只在对应 Queue mutation 成功后更新同一 view item revision 与最小变更事实；actual admission 赢得并发时 History ref 优先，旧 snapshot 不得制造假的 withdrawn；重启不承诺恢复 runtime-only 增删说明
- [x] AC-H3: 已进入 durable Queue、随后在 actual admission 前失效的 target 不从 view 静默消失，关联 canonical `delivery_failure`；durable Queue admission 前被 routing preflight 拒绝的 target 则在本次发送结果中立即返回 typed fail-back，不登记 view；dispatchRef 只关联已经发生的投递或投递失败事实，不能仅凭 ref 存在断言 provider 已收到消息；真实状态与 response identity 始终从 Queue + source `dispatchRefs[]` + canonical response 反查
- [x] AC-H4: caller 下一自然 invocation 先反查所有保留 items，以 canonical fingerprint 变化推进 revision，再只注入 `revision > presentedRevision` 的变化；能表达 pending、executing、completed/failed/canceled/interrupted、delivery_failure 与 not-delivered/withdrawn；pending/open 成功呈现后仍保留 item但不重复推送未变化版本；executing 已确认且无 Queue mutation 时，response 单独转 terminal 仍必须被下一 turn 发现
- [x] AC-H5: projection 冻结生成正文时的 includedRevision；查询期间再次 Steer 必须重读或保留待核对，不能用最新 revision 标记旧正文。成功后 pending/open 推进 presentedRevision，terminal/withdrawn 仅在 current revision 匹配时 compare-and-clear；失败、裁剪、取消与本 turn 新 revision 均不确认
- [x] AC-H6: active-runs 共享快照与 caller 私有 dispatch view 职责分离；completed/canceled/interrupted 的自动 continuation 只来自显式 owner；failed terminal 只创建一条 exact、幂等、Queue-only `a2a_failure` 控制载体，不创建第二条 status message且不得递归
- [x] AC-H7: runtime view 不持久化、不扫描 History 重建；每个 caller scope 获得一次成功交付的有界 `process_start` 说明，失败后重试、成功后同 generation 不重复，且确认说明不清理当前 view items
- [x] AC-H8: 回归覆盖 A 发 M1→B/C/D 后 B unavailable、C 被 Steer 移除再重新加入、D actual terminal、E 由 Steer 新增，以及 M1 未终结时 A 再发 M2→B/D；另锁住 pending 连续两轮不变不重复、投影查询期间再次 Steer、terminal 清理后同 key 重建不会复用旧 revision

## Scope Boundary

- **In scope**: undelivered user message 对 cat cognition (`callback / thread context / prompt / pending-mentions`) 的泄漏，以及 canceled message 对 owner timeline/history 的 resurfacing
- **Phase C in scope**: 所有公开 History source 的统一 dispatch 头像、response lineage、terminal 与 retry 投影
- **Phase F in scope**: canonical member carrier、live append/interrupt、MCP 发送工具去门卫化，以及 A2A / multi-mention / connector 的 exact source×target replay 防线
- **Phase G in scope**: managed hold 的共享等待消息、queued urgent wake、统一 response 终局，以及 ordinary A2A/hold completion MCP 与 Ball disposition 双轨退役
- **Phase H in scope**: caller 自有 outbound dispatch 的进程内 revision view、预期 target 与 Steer 增删更新、caller invocation 对 Queue/History 的反查/注入/compare-and-clear，以及有界 process-start 说明；不改变 source `dispatchRefs` 语义，不自动重建旧 view；failed terminal 保留 exact 幂等 fail-back，其他普通终态不自动回唤
- **Phase F callback boundary**: 显式行首 `@` 与 structured `targetCats` 都是不可被 terminal ACK 投影吞掉的路由指令；礼貌 ACK 与新 active hop 在 Queue admission 前分流

## Dependencies

- **Evolved from**: F039（消息排队投递 — 三模式已完成，但缺 delivery lifecycle 概念）
- **Related**: F047（Queue Steer）、community issue [#20](https://github.com/zts212653/clowder-ai/issues/20)、PR [#25](https://github.com/zts212653/clowder-ai/pull/25)

Architecture cell: `dispatch` + `bubble-pipeline`
Map delta: dispatch cell 仍拥有 Queue pending；bubble-pipeline 仍拥有 History materialization、dispatchRefs 与 response lifecycle；caller outbound view 只是单 runtime 的变化索引。
Why: 持久真相边界不变；view 只让成员在自己的后续自然 turn 核对自己发出的多条 source×target，不复制或裁决 Queue/History 状态。

## Risk

| 风险 | 缓解 |
|------|------|
| 老数据无 deliveryStatus 字段，查询可能误伤 | 缺省按 `delivered` 兼容，过滤条件 `WHERE deliveryStatus IS NULL OR deliveryStatus='delivered'` |
| `messages_delivered` payload 变更影响现有消费者 | 扩展而非重构，新增 `userMessage` 字段，现有字段不变 |
| withdraw/clear 新增 `message_deleted` 事件可能与现有删除逻辑冲突 | 复用现有 `message_deleted` handler，确认幂等 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 用显式 `deliveryStatus` 字段而非 `deliveredAt` | `deliveredAt` 老数据没有，过滤会误伤即时消息和历史消息（Maine Coon提出） | 2026-03-14 |
| KD-2 | 不 merge 社区 PR #25 作为 quick fix | 只修渲染层是脚手架不是终态，withdraw resurfacing 未闭合（P1铁律）| 2026-03-14 |
| KD-3 | 修完后走全量 sync 而非 hotfix | 有多个已完成 F 待同步，hotfix 增加后续同步难度（operator决定）| 2026-03-14 |
| KD-4 | Bug 3 拆分：queued @mention 泄漏 in scope / post_message callback 路由 out of scope | post_message 走 callback 路由不经 queue，硬塞进 F117 会混 scope（Maine Coon Design Gate 提出）| 2026-03-14 |
| KD-5 | owner timeline publication 与 cat delivery 分成两个 typed read option | F264 receipt 必须让operator持续看见原消息；复用全局 `isTimelinePublished` 会把未投递正文泄给猫 | 2026-07-21 |
| KD-6 | Phase C 以 actual dispatch facts 建立单一 UI projection，不按消息来源分类 | user/cat/connector/GitHub 通知都可能成为 source；分类例外会再次制造多套生命周期 | 2026-08-31 |
| KD-7 | 删除旧 dock/占位/fallback，而不是继续收敛到 dock | dock 自身表达了第二套 receipt 模型，且增加用户无需理解的时间、执行类型与跳转信息 | 2026-08-31 |
| KD-8 | 成功静默、终态头像统一静止；结果只由 canonical terminal response 表达 | 头像只回答“谁在处理/处理过”，不复制 outcome；终态不携带旧 Queue attempt 的 retry 能力 | 2026-08-31 |
| KD-9 | 验收否决 `833aa0587` 对 pending bubble / tips 的删除：processing 回复行承接脉冲头像与 tips，两个尺寸共用一份 `activeRun` 状态 | co-creator：用户要看见被触发成员在动，且不需要两套定制 | 2026-09-03 |
| KD-10 | 停止是唯一用户动作；投影与真相不一致由服务端对账，不由用户「强制重置」 | co-creator：用户只有在运行/未运行两态；force-reset 是对多 SoT 分叉的补丁（F220 KD-3 曾推迟根因），根因已由 F194 / TurnExecution / ADR-043 关闭，剩余归 reconciler（ADR-043 D9） | 2026-09-03 |
| KD-11 | Agent 与 UI 共享 A79 exact lifecycle predicate；扩展现有 `get_thread_context`，不新增执行状态 MCP | co-creator：人和猫应看到、理解同一生命周期；工具数量不应因同一只读事实增加。最近发言与运行态必须在文案和证据层彻底分开 | 2026-09-04 |
| KD-12 | `carrier` 是唯一接入方式配置；兼容只在配置读取边界，选项彼此平级且不 fallback | client 能力必须由实际 transport 决定，不能让 UI、provider 与全局 env 各维护一套真相 | 2026-09-09 |
| KD-13 | 退役 MCP side-effect freshness gate；运行中正文由 live carrier 接住，单轮 carrier 继续排队 | `post_message` 顺便查 inbox、阻止发送并教学补救把 transport 缺口转嫁给工具，制造 Agent/用户视图分叉 | 2026-09-09 |
| KD-14 | 重放防线以 History exact source×target dispatch 与 wait outcome generation 为准 | 已处理 connector source 被旧 Queue/回调重新准入时，只有持久 execution truth 能阻止重复 side effect | 2026-09-09 |
| KD-15 | managed hold 的恢复是普通优先 Queue 消息，不是 Ball disposition 协议 | 跨 invocation 等待需要持久 task/condition；条件满足后的执行已经由 source/Queue/response 完整表达，再加 completion tool 与 stop gate只会制造第二套终局 | 2026-09-10 |
| KD-16 | completed/canceled/interrupted 不自动回唤 caller；failed terminal 保留 exact 幂等 Queue-only fail-back，caller view 在任何后续 invocation 补充未呈现变化 | canonical response 是唯一公开结果；`a2a_failure` 仅负责及时驱动 caller 处理失败，不能被误判为第二条结果。客户端单 runtime view 优化连续体验，重启后回到持久 History | 2026-09-15 |
| KD-17 | source `dispatchRefs` 只关联已发生的投递或投递失败事实；caller 另有单 runtime、按 revision 更新的 outbound dispatch view | 发出者要在后续自然 turn 同时核对预期目标、Steer 增删和 actual result，但不应为此改写持久 Queue/History 模型或新增 attemptId；view 只索引变化，状态仍反查 canonical owners；ref 存在本身不等于 provider 已收到消息 | 2026-09-14 |
| KD-18 | 「能否引导当前 invocation」与「当前可见 provider turn 是否精确读取」是两个独立声明 | `activeInvocationGuidance` 只回答 concrete adapter 能否非中断地追加到当前 invocation；`deliverySemantics` 只回答 provider 何时读取。Claude Agent SDK 显式声明前者 `supported`、后者 `queued_internal_turn`：允许「引导回复」，但绝不冒充当前可见同轮已读取。API admission、catalog 与 Web 只消费前者决定可用性，展示层消费后者说明精度 | 2026-09-20 |
| KD-19 | 内部协议诊断只进入 telemetry/private evidence，不先写 History 再由 API/Web 隐藏 | 展示层屏蔽不能修复错误的生产边界；新代码停止生成 `routing-guard-failure`，API 读取过滤只保留为旧版本存量兼容 | 2026-09-20 |
| KD-20 | terminal 后的任何显式路由凭据永远开启新 active hop；只有无行首 `@`、无 structured `targetCats` 的礼貌文本可 quiet ACK | 文本与结构化目标都是明确路由指令，生命周期投影不能静默吞掉；新的 generation 与统一 loop-streak 足以防止 ACK 乒乓 | 2026-09-20 |

### Phase I（producer 统一登记表，2026-09-21）— 已收口

Phase I 之前的迁移是「搜到一个改一个」：两次宣称"所有 producer 已迁移、旧 trigger 已空"，随后又
不断发现活路径。根因不是哪一处改错，而是**没有先把生产者数完**。这张表就是那份清单——它是
normative 的：新增任何唤醒猫的入口，必须先在这里登记，再写实现。

#### I.1 两条接缝

| | 旧 seam | 新 seam |
|---|---|---|
| 入口 | `ConnectorInvokeTrigger.trigger(…, messageId, …)` | `deliverConnectorMessage({ delivery }, …)` → `PersistedQueueDeliveryPort` |
| 形状 | 调用方**先** `messageStore.append({deliveryStatus:'queued'})`，**再**入队 | 一次事务内同时写 Message + Queue row |
| 失败模式 | 两次写之间崩溃 ⇒ 半提交：消息已持久化、无 Queue row、无人重投 | 无中间态：要么都成立，要么都不成立 |
| 幂等身份 | `coalesceKey`（常缺省）→ 回退 `messageId` | `idempotencyKey` 必填 |

#### I.2 登记表：旧入口 → 新入口 → 幂等键 → red/green

**已在新 seam（无需迁移，勿重复发现）**

| 生产者 | 幂等键 |
|---|---|
| `ConnectorRouter.route` / `/thread` / `/ask`（IM 入站主路径） | `im:${connectorId}:${chatId}:${messageId}[:thread\|:ask]` |
| `GitHubWaitLifecycleService.publishPending`（所有 GitHub wait outcome） | `outcome.outcomeId` |
| `IssueCommentRouter.route` | `issue-comment:${repo}#${n}:${frontier}` |
| `GitHubRepoWebhookHandler`（webhook 入站） | `github-repo-event:${deliveryId}` |
| `RepoScanTaskSpec`（对账扫描） | `github-repo-event:${signal.deliveryId}` |
| scheduler `createDeliverFn` / `createDeliverPrivateFn` 全体消费者 | 调用方提供（强制必填） |
| 手动 eval 触发 / artifact review return / paw-feel duty / ball-custody wake / main-health / eval domain trigger | 各自 dedupe key |

> `CiCdRouter`、`ConflictRouter`、`ReviewFeedbackRouter` 不自行 admit——它们经
> `GitHubWaitLifecycleService.observe` → `publishPending`，已计入上表。

**本轮收口（Phase I 已完成）**

| # | 生产者 | 旧入口 | 新入口 | 幂等键 | red/green |
|---|---|---|---|---|---|
| 1 | Repo Scan 生产装配 | `index.ts` 传 `deliveryDeps:{messageStore}`，类型被 `Record<string,unknown>` 擦除 | `{ delivery: persistedQueueDelivery }`；`rehydrateGitHubSchedules`/`repoScanDeps` 改 `Partial<GitHubScheduleDeps>` | `github-repo-event:${deliveryId}` | `1398-connector-delivery-composition.test.js`（red 复现生产 `TypeError: …reading 'deliver'`） |
| 2 | Conflict check 第二次 admission | `ConflictCheckTaskSpec` 在 `route()` 已 admit 后再 `invokeTrigger.trigger(messageId)` | 删除该分支；`route()` 的 admission 即唤醒 | `outcome.outcomeId`（route 内） | `1398-conflict-check-single-admission.test.js` |
| 3 | Limb transcript | `append(deliveryStatus:'queued')` + `trigger.trigger` | `deliverConnectorMessage` 原子 admission | `limb:${nodeId}:${observationId}` | `limb-transcript-cat-delivery.test.js` |
| 5 | Re-eval carrier（F266 stable-case） | `reeval-case-task-dispatch.ts` 先 `append(deliveryStatus:'queued')`（键 `f266-task-carrier:…`）再 `deliver` 入队（键 `action:${leaseId}:${gen}`） | dispatcher 只造信封不落盘；`appendA2ASourceWithLedgerAdmission` 一次事务提交 Message + Queue row | `f266-task-carrier:${taskId}:${generation}`（两半合一） | `1398-reeval-carrier-atomic-admission.test.js` |
| 4 | Managed hold wake | `message-fence.ts:137` append queued + `RecoveryEngine.ts:218` trigger（中间隔一次 return、re-parse、两次 store 查询、15s 宽限、一次 CAS） | fence 先验 lease，再 `InvocationQueue.appendAndEnqueueDurable` 一次事务；`condition_met` 直落 `enqueued`，信封逐字节不变 | `hold-ball-completion:${taskId}`（Message/Queue 同值） | `managed-command-wake-recovery-sweep` / `-exactly-once` / `callback-hold-ball-wakewhen` 三份按新契约重写 |
| 6 | `ConnectorInvokeTrigger` 整条旧链 | 类本身 + `ScheduleInvokeTrigger` 类型 + `TaskRunnerV2.setInvokeTrigger` + `execute-pipeline` 取消感知包装 + 6 处 composition 透传 | 全部删除——`src/` 下 `ConnectorInvokeTrigger` 零引用 | — | `connector-invoke-trigger.test.js` 随类删除；`task-runner-v2` 相应用例收窄到仍存在的副作用 |

关于 #2 的诚实修正（两层，第二层推翻了第一层的一半）：

其一，该双唤醒分支**从未在生产触发**——`github-schedule-factories.ts` 根本没把 `invokeTrigger`
传进这个 spec（零个 github factory 读它）。它不是「正在重复唤醒」，而是「离重复唤醒只差一行接线」。

其二，我最初据此判定「删除属零行为变更」，**这是错的**，`1392-expiry-consumer.test.js` 当场红给我看。
那段代码不只是第二次入队，它还**独占携带 conflict 的 priority 与 sourceCategory**
（`urgent` + `'conflict'` vs `normal` + `'scheduled'`）。结论比删除本身更重要：既然 trigger 从未接线，
**R5 要求的 conflict 标记在生产里本来就没生效**——一条 matched conflict 与一条普通到期通知，对 owner
是同样的优先级和分类。删除只是让这个长期缺口第一次可见。

正确收敛不是恢复两阶段 trigger，而是把标签放到真正发生 admission 的地方：
`GitHubWaitLifecycleService.publishPending` 现在从 outcome 自身推导（`reason === 'matched'` 且
matched 含 `pr_became_conflicting` ⇒ urgent + `conflict`）。这是唯一同时知道「是否 matched」与
「matched 了什么」的位置——`route()` 拿到 outcome 时投递已经发生，生产者无从预先判断。符合 INV-I4。

同一根因还波及测试：`1392-expiry-consumer.test.js` 原本观察测试自己注入的 `ConnectorInvokeTrigger`
——一个生产从未接线的接缝，于是断言描述的是一个从未运行过的配置，而真正唤醒 owner 的 admission
无人观察。现已改为观察 harness 的 Queue 入队与 drain（「admitted entry reaching progress IS the wake」）。

同一批测试还有第二处、更贵的同类：`conflict-auto-executor.test.js` 与 `conflict-check-spec.test.js`
一共 7 处断言都在观察它们自己注入的 `invokeTrigger`——而 `github-schedule-factories.ts` 的
`conflictCheckFactory` 只传 `taskStore/checkMergeable/conflictRouter/autoExecutor/log`，从不传它。
删掉那条分支后，其中 4 处直接变红，另外 3 处**变成了假绿**：它们断言 `triggered.length === 0`，而
现在永远是 0，于是继续「通过」地描述一个已经不存在的行为。只修红的那 4 处正是补锅匠做法——7 处
同源，必须一起重锚到生产真实拥有的接缝（`conflictRouter.route` 的 admission 即唤醒）。

重锚之后暴露出一个**真实语义变更，必须显式记账**：Phase C 的 AC-C1「auto-resolve 成功就不要吵醒 owner」
已经不成立了。原因不是疏忽，而是 #1392 R5 的授权模型：只有 `matched` outcome 才授权写仓库，而这个
outcome 正是 admission 产出的——所以修复只能发生在「owner 的 wait 已经投递」之后。现在的语义是：
owner 注册了 wait、wait matched，他就会被告知；自动修复成功与否作为后续结果汇报，而不是把一次已经
matched 的 wait 悄悄吞掉。我认为这比 AC-C1 更正确（注册过的 wait 不该静默不响），但这是产品语义变更，
不是纯重构，需要 reviewer 明确放行。`tryAutoResolveBeforeWake` 也已改名 `tryAutoResolveAfterWake`——
它跑在唤醒之后，旧名字在说谎。

关于 #2 的 auto-resolve 排序：`tryAutoResolveBeforeWake` 确实跑在 admission 之后，但这是 **#1392 R5
授权模型强制的**，不是疏忽——auto-resolve 只允许在 `matched` outcome 上写仓库，而该 outcome 正是
`route()` 那一次调用产出的。把它提到 admission 之前，等于放弃这条授权检查。此处不改，改需先改授权模型。

关于 #5 的两点结论：

其一，**三个 `blocked` reasonCode 塌缩成一个**。`carrier_delivery_failed` / `carrier_not_enqueued` 命名的是
「Message 已落盘、Queue row 没跟上」的两种半提交态；原子 admission 之后这两种态不存在了。现在唯一可能的
blocked 是「什么都没写」，而 `reeval-case.ts` 的 `custody_dispatch_blocked` 不变量本来就规定：只有
`carrier_persist_failed` 允许不带 `carrierMessageId`。所以不需要新增枚举值——正确的那个早就在那里。
两个旧码保留在 `reeval-closure-schema.ts` 里**只为历史事件可重放**（closure event log 是 append-only），
不再有任何生产者产出它们。

其二，**路由拒绝必须发生在落盘之前**。carrier 是纯粹为了携带工作而存在的消息；如果 owner 被 routing
preflight 拒绝，旧路径会留下一条 queued Message 当作垃圾。新装配先 preflight + plan，空 plan 直接返回
`not_admitted`，一个字节都不写。另外 publication（`enqueueA2ATargets` 的 socket/drain 侧效应）失败不再
翻转成 blocked——Queue commit 才是持久边界，行已经在了就不能反悔说没投递（INV-I2）。

#### I.5 `publishClaimedAt` 的混合版本边界（迁移/soak 必须照此描述）

claim 走独立字段、`delivery` 保持 `pending`，这解决的是**回滚**：旧 binary 只认识
`delivery === 'pending'`，把 claim 编码进枚举会让降级后的旧节点判定为终态，从而永久搁浅
owner wake——而那正是 claim 本身要拯救的崩溃窗口。

但要说清楚它**没有**解决什么。**新旧 writer 同时在跑**时，旧 writer 不认识 claim，仍可能在新
writer 已经 suppress 之后发出通知；结果是持久状态写着 `suppressed`、owner 却收到了消息。

所以准确的说法是：

- **单活跃 writer（升级、回滚、崩溃恢复）**：AC-C1 严格成立——修好的冲突不打扰 owner。
- **混合版本窗口**：降级为「不丢工作，但审计不精确」。不得描述成严格 AC-C1。

方向是安全的（失败方向是 owner 被告知，不是工作丢失），但 soak 与迁移证据必须写明这条边界，
而不是笼统地声称 AC-C1 成立。

#### I.3 仍未收口 —— **已清空（2026-09-21）**

Phase I 登记表上的六个生产者全部收口。`src/` 下 `ConnectorInvokeTrigger` 零引用，两阶段
「先 append 再入队」在生产路径上不再存在。

#### I.3a #4 Managed hold wake — 实现前登记（按「旧入口 → 新入口 → 幂等键 → red/green」）

> 冻结流程要求登记先于实现。这一条比 #1–#3 都重，所以先把账算完再动手。

**两半与中间的洞**

| | 位置 |
|---|---|
| 旧入口（append） | `managed-command-wake-message-fence.ts:137` `messageStore.append({deliveryStatus:'queued'})` |
| 旧入口（enqueue） | `ManagedCommandWakeRecoveryEngine.ts:218` `trigger.trigger(...)` → `ConnectorInvokeTrigger.ts:97` `enqueueExistingMessageDurable` |
| 两者之间 | `Engine:80→218`：一次 return、一次 re-parse、`getEventCarrier` 异步回读、`findInvocationCarrier` 两次 store 查询、**15s `lastDispatchAt` 宽限窗**、`dispatch_pending` CAS、`getInvokeTrigger()` 可能为 undefined |
| 新入口 | `InvocationQueue.appendAndEnqueueDurable`（一次事务 Message + Queue row） |

**幂等键**：旧的两半用不同的键——Message 是 `hold-ball-completion:${taskId}`（按 task），Queue 侧
`ConnectorInvokeTrigger.ts:88` 用 `action-successor:${leaseId}:${generation}:${catId}`（按 lease 代）或
**完全没有键**。新入口统一为 `hold-ball-completion:${taskId}`，Message/Queue `sourceId`/`idempotencyKey` 同值。

**登记自纠（实现前发现，这正是先登记的用处）**：上一版登记把新入口写成
`PersistedQueueDeliveryPort.deliver`，并据此认为要给端口补 `actionSuccessorFence` /
`waitContinuationCarrier` 两个字段。动手前核对发现这条是错的——

`PersistedQueueDelivery.deliver` 把 `mentions: [targetCat]` 和 `extra.targetCats` 写死
（`PersistedQueueDelivery.ts:126`、`:131`），而且 `matchesPersistedEnvelope`（`:293`）**要求**这条
mention 存在，否则判 conflict。managed wake 的信封是 `mentions: []`（`message-fence.ts:141`）。
所以走这道端口，等于给每一条 `[定时任务]` 唤醒消息都加上一个 @提及——一个用户可见的改动，而且是
为了迁就 API 形状去改产品表现。今天已经因为同一类错误（AC-C1）被打回一次，不再犯第二次。

正确入口是 `InvocationQueue.appendAndEnqueueDurable`：同样一次事务、同样满足 INV-I1，但生产者保留
自己**逐字节不变**的信封。F266 carrier 的 `appendA2ASourceWithLedgerAdmission` 已经是这个先例。
端口不需要加字段——`QueueEnqueueInput` 本来就有 `actionSuccessorFence` 与 `waitContinuationCarrier`
（`InvocationQueue.ts:89`、`:91`），缺的只是一条把它们带进去的直连调用。

**lease 校验必须前移**：`resolveManagedCommandWakeActionLeaseAdmission` 现在跑在
`ConnectorInvokeTrigger.ts:79`，即 Message **已经持久化之后**。它只读 `message.threadId` 与
`message.source`——而这两者正是 fence 自己构造的，所以可以在落盘前拿待发信封直接校验，函数本身不用改。

**补偿状态裁决**（每一条都必须给出「迁移后还剩什么职责」）

| 状态 | 现在的读者 | 原子化之后 |
|---|---|---|
| `dispatchAttemptCount` | 只有它自己 `+1` 和 `managedCommandDispatchRetryTotal` 计数器；全仓无其它读者 | 作为可靠性状态**无职责**。`recovery-sweep.test.js:548` 已经认定「durable Queue `attemptSequence` 才是权威」 |
| `lastDispatchOutcome` | **无任何读者**（只有 `state` 跟着一起写） | 无职责。但它捎带的 `state:'dispatch_pending'` 仍然在 `isDispatchableManagedCommandWakeState` 里当闸门，需要替代而不是直接删字段 |
| `lastDispatchAt` 15s 宽限 | `Engine:113` | 无职责。它存在的唯一理由是「易失 enqueue 还没变成持久 carrier」——原子化之后不存在这个窗口 |
| SLA breach | 自身幂等守卫 + 计数器，无分支依赖 | 仍有诊断职责（它量的是 `conditionMetAt → consumed`，比投递缺口更宽），但它本来要抓的「条件满足 60s 还没派发」经由此缺口不再可达 |
| retire-on-lease-error（`markCanceled` + `retireTask`） | `Engine:233` | **无职责**。它唯一的工作是撤销「lease 校验之前就已经 append 的消息」；校验前移后交易整体被拒，没有东西要撤销。`messageStore.markCanceled` 也因此可以退出 `ManagedCommandWakeRecoveryDeps` |
| 消息内容 claim（`messageClaimGeneration` / `messageClaimedAt` / 30s stale） | `message-fence.ts:41–119` | 无职责。它是围绕「append 与 `message_written` 回执是两次写」手搓的租约；原子 admission 下同键并发直接收敛为 deduped |

**契约变更（需要 reviewer 明确放行）**：现有测试把两阶段写成了**规格**，不是实现细节——
`callback-hold-ball-wakewhen.test.js:1151` 断言 `_appendedMessages.length >= 2`
（「completion message should be durable before dispatch」）、
`recovery-sweep.test.js:372`「restart after volatile enqueue re-dispatches the same wake until a
durable carrier exists」直接把分叉当成期望行为、`exactly-once.test.js:124` 的「stale 代被 cancel 恰好
一次」只在「消息可以先于被拒绝的 admission 存在」时才成立。所以 #4 不是机械迁移，而是**重定义
managed wake 的投递契约**，影响面是每只猫的 `hold_ball(wakeWhen)`。约 2700 行测试要按新契约重写。

**实现试做后的两条新发现（2026-09-21，已做过一遍、未合入）**

试做证明入口选择是对的：fence 先验 lease、再用 `appendAndEnqueueDurable` 一次提交 Message + Queue row，
`condition_met` 直接落到 `enqueued`，全仓 typecheck 通过，生产装配（index.ts）也接好了。但收尾还差两块，
都不是"再改一行"的量级：

1. **hold-ball 路由没有 Queue 句柄**。`callback-hold-ball-routes.ts` 的 `HoldBallRouteDeps` 里没有
   `invocationQueue`，而 `deps.managedCommandWakeRecovery ?? new ManagedCommandWakeRecoverySweep({...})`
   这条 fallback 正是测试走的那条。所以 admission port 必须**作为依赖注入**进路由（像其它生产者一样），
   否则 fallback sweep 永远 admit 不了——试做时我用空实现占位，直接导致一条用例 90s 超时挂死。

2. **约 20 条测试仍写着两阶段契约**，分布在
   `managed-command-wake-recovery-sweep.test.js`(1055) / `managed-command-wake-exactly-once.test.js`(477) /
   `callback-hold-ball-wakewhen.test.js`(1260)。它们不是断言值要换，而是**建模了两阶段机器本身**：
   偷走过期 message-content claim、in-flight append 与 receipt 不得分叉、并发 sweep 不得重复 dispatch、
   `_appendedMessages.length >= 2`（"completion message 必须先于 dispatch 持久"）。每一条都要按原子契约
   重新表达意图，属于逐条理解后重写，不是机械替换。

试做代码已 `git stash` 保留（`wip/F117-#4-managed-hold-atomic-admission`），不是丢弃重来；
下一轮从"路由注入 admission port"开始，再逐个重写上面三份测试。

**red/green 计划**：先写一条生产形状的红测——在 append 与 enqueue 之间注入崩溃，断言不存在
「queued Message 但无 Queue row」的中间态；当前实现必然红。再迁移到 `deliver`，该测试转绿，
并补一条「lease 代已过期 ⇒ 什么都没写」的用例替代 retire-on-lease-error。

#### I.3b 本轮发现、但**不在**冻结范围的既存缺口（记录，不顺手修）

| 现象 | 证据 | 归因 |
|---|---|---|
| `1392-registration-atomicity.test.js` 的 redis 变体 `concurrent registrations publish exactly one coherent owner…` 失败，抛 `TASK_MANAGED_WORK_BINDING_CONFLICT` | 栈全程在 `RedisTaskStore.replaceAutomationStateIfGeneration` → `buildTaskWaitReplacement` → `assertTrackingRegistration`；memory 变体同用例通过 | Redis/memory 在并发注册上的行为分叉，与投递无关；本轮改动文件不在该栈内 |
| `audit-cc-system-prompt`、`capability-evolution-exploration-record-failures` 等 redis 轮失败 | 域与消息投递无交集 | 既存 |
| `tmux-early-receipt-cancellation.test.js` 的 `fresh` 变体偶发失败（期望 `AbortError`，实得 `Error`） | 本分支从未改动任何 tmux 代码（`git log` 对 tmux 路径为空）；本地首跑失败后连续 3 次通过；该用例用真实 tmux、真实进程与 barrier 轮询，对时序敏感 | 既存 flake，非本轮回归 |

这些之所以长期无人发现，是同一个结构性原因：**CI 没有 Redis job**，`config/public-test-exclusions.json`
把 `redis-*` 归为 `source_only`。Redis 是生产实际运行的后端，却是唯一不被门禁执行的后端。

#### I.4 不变量

- **INV-I1** 任何唤醒猫的输入只经过一次原子 Message + Queue admission；不存在「先 append 再入队」。
- **INV-I2** 生产者不得自带 outbox 或半提交补偿状态；Queue commit 就是持久边界。
- **INV-I3** `ConnectorDeliveryDeps` 不得以 `Record<string, unknown>`、可选字段或 `as` 断言传递——
  装配错误必须在编译期或装配期暴露，不能推迟到投递时。
- **INV-I4** 信封自述事实（priority、timestamp、provenance）；admission 不得从载荷推断。

## Review Gate

The latest-main replay continuity and retirement account is recorded in
[`f117-latest-main-replay-ledger.md`](../architecture/f117-latest-main-replay-ledger.md). Review of
the replay must use that ledger together with the mechanical A1/A2 audits; compilation alone is not
evidence that main composition roots survived.

- Phase A: 跨家族 review（Maine Coon review 后端 delivery lifecycle 改动）
- Phase B: 跨家族 review（Maine Coon review 前端适配）
- Phase C spec: co-creator 定稿；Ragdoll Opus 做内容一致性 review 后，实现才可开始
- Phase C implementation: Opus 按 INV-C1..C8 逐条 review，并额外审计新增 fallback 与 kind/scope 分支；
  co-creator worktree 体验验收仍是 fork/上游前硬门
- Phase E: Fable 做 exact-HEAD delta 复审，硬门为 AC-E1、AC-E3 的「typed custody 行存在时仍 200」与 AC-E7 的 `reconciled` / pre-start TTL 收窄；
  co-creator worktree 体验验收与 fork soak 仍是上游前硬门
- Phase G: 跨族 reviewer 核验等待可见性、queued-before-admission、唯一 response 终局、MCP/route/Ball writer 全链 absence；co-creator 验证 AC-G6 后才进入 fork soak
- Phase I: 登记表（I.2）必须先于实现更新；跨族 reviewer 核验 INV-I1..I4 与 I.3 三项剩余收口，
  co-creator worktree 体验验收与 fork soak 仍是上游前硬门
- Phase H: 「source dispatchRefs 语义不变 + caller runtime view + revision compare-and-clear + failed-only exact fail-back」实现与跨族复审已完成；co-creator 的完整 worktree UAT 仍覆盖初始多目标、Steer 增删、不可用目标、连续新 source、正常终局与 runtime restart
