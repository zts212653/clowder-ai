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

> **Status**: implementing — PR #1398 已按 2026-09-10 co-creator 验收反馈收敛为单 source Queue Entry + History actual-dispatch lifecycle、carrier 能力真相、去副作用门卫与 managed-hold 统一恢复；待本轮 exact-HEAD review、worktree 体验与 fork soak | **Owner**: Ragdoll + Maine Coon | **Priority**: P1
> **community_issue**: [#20](https://github.com/zts212653/clowder-ai/issues/20)

## Why

operator 2026-03-14 实测发现：queue 模式发送消息后立即取消，该消息仍出现在聊天流、进入猫猫 prompt context。社区 issue #20 也报告了同样问题。

根因：当前架构下 queue send 在 enqueue 阶段就持久化 user message 并做乐观插入，但没有 delivery status 概念。History API 和 ContextAssembler 不区分 queued/delivered/canceled，导致未送达甚至已取消的消息污染聊天历史和猫猫上下文。

**2026-03-14 原始 invariant**：`undelivered user messages MUST NOT appear in timeline, history API, or prompt context.`

**2026-09-07 最终契约**：F264 曾把 operator publication 与 cat delivery 分开，但仍让同一 queued user message 同时占有 Queue 与 owner-only History，造成两套顺序与 receipt 双写。ADR-043 最终退役这层兼容：

- durable queued user/external message 只在 Queue Panel；第一次 actual dispatch 后才以同一 `sourceRecordId` 进入 History；
- 一条 source message 永远只有一个 Queue Entry，`targets[]` 只保存尚未投递的成员；
- actual delivery 只由 History `dispatchRefs` 表达；Queue 不保存 processing/terminal/seen/handled/receipt；
- canceled 且从未 actual dispatch 的输入不会进入 History 或 cat context。

operator experience：
> "前端不应该显示你们真正没有收到的消息，对吧？"
> "当我发了一个正在队列的消息的时候，我的用户气泡这里先不显示，等到你们真的收到这个消息的那一刻，再在正确的地方插入这个气泡"

## User Journey

**Scope unit：一条 source message 从进入 Queue 到所有目标各自取得终局。**

1. 用户、Connector 或成员发送一条消息；若它尚未实际交给任何成员，Queue Panel 只显示一条可恢复的 source entry，Chat History 不复制未投递的用户/外部消息。
2. `targets[]` 只列仍待投递的成员。成员通过正常 drain、用户选择「立即发送，引导回复 / 中断回复」，或运行中的成员通过完整未读读取接住正文时，服务端从同一 entry 删除 exact target。
3. 第一次实际投递让同一 `sourceRecordId` 进入 History；每个实际目标得到独立 `dispatchRef`、固定 response bubble 与执行终局，尚未投递的 sibling 仍留在原 Queue entry。
4. 用户从源消息的小头像看到谁正在处理或已经结束，hover 看到实际投递时间，点击跳到 exact response；失败、取消与成功都在同一 response bubble 原位收敛。
5. 所有 pending targets 离开后 Queue entry 删除；用户若要重试，通过新消息或新动作产生新的 source/attempt，不复活旧工单。

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
  response status，以及 response 上指回 source 的 `messageRef`。Queue pending、carrier、source owner、
  文本内容和旧 dock 都不能补猜 actual dispatch。
- multi-target source 为每个成员独立投影状态；一个成员的终局不能覆盖、删除或代表 sibling。

#### 源消息头像：pending 无投影，actual dispatch 两阶段

| canonical fact | 视觉状态 | 含义 |
|---|---|---|
| 没有 actual dispatch；target 仅存在于 Queue `targets[]` | 无头像 | 没有成员正在处理 |
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
  stream 后原位升级为 response 气泡，terminal 仍更新同一 identity。
- 成功、失败、取消和中断都必须有一个可关联的 terminal response 气泡；不得另追加 system row、
  provider notice 或第二条状态消息表达同一结果。

#### 失败传播

- **成员唤起的 dispatch 失败**：failed response 与一条只投递给 exact source 成员的
  `a2a_failure` Queue row 原子提交；source 消息上该成员头像转静止（失败终态）。该 row 是失败传播边，
  不是新的模型 mention；它不走 ping-pong/depth 推断，且自身失败时不得递归生成第二条失败回报。
  failed response 已经是公开 History message；它自身的失败终态不限制它作为下一跳 source。source 成员
  读取 `a2a_failure` 时消费的就是该 exact response，不生成第二条可见失败通知。
  source 成员随后重分发给其他成员、或放弃并上报一条普通消息给用户——两者都是普通 History
  消息，走同一套头像+引用投影，不新增 UI。
- **origin 唤起的 dispatch 失败**（source 为 user/GitHub/IM connector 等无上游、无法报回的来源）：投影为 `delivery failure result` 的用户可见 system message "唤起 xxx 失败"；不伪造 response 气泡、不挂动态头像。
- 判据：**能报回 cat source 的 → 报回 + 普通消息；报不回的 origin → 才降级 system message。**
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
```

Queue 只拥有 pending，不保存 actual dispatch、processing、seen/handled、terminal 或 retry receipt。每个 target 的实际投递与结果归 History lifecycle。

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
| D7 | Steer 打开只读；确认时重读 Queue+History，跳过已 dispatch targets并原子刷新 pending set，不把正常并发当整批 stale |
| D8 | Queue 不保存 processing/terminal/seen/handled/attempt receipt；Retry 只能创建新的 source/attempt |

实现结果：Queue row 只回答“哪条 source 还在等谁”；History 只回答“实际投给了谁、结果是什么”。一条 `@B @C` 在 UI 和存储中始终是一条 source message，B 已投递时 entry 原位只剩 `targets=[C]`。

#### D.4 一并修正的实现偏离

- **§6.4 前缀批处理不拼消息身份**：一次 dispatch 可覆盖多条相邻 entry，但每条消息的 identity、正文与 History 顺序保持独立。
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
| E4 | 狸花猫 Steer 无「立即发送，引导回复」；旧设置把 append 能力与排队/立即意图混为一项 | UI 与契约错误 | 默认设置收敛为「排队等待 / 立即发送，引导回复」；Steer 固定为「立即发送，引导回复 / 立即发送，中断回复」，多选成员并逐成员选策略；静态 client capability 随成员信息投影，不支持或无 current reply 时禁用引导；targetless 绑定与新增 targets 在同一 source entry 原子完成 |
| E5 | 失败正文与系统提示 / 恢复 continuation 重复成两个气泡；成员失败没有报回 source 成员 | 实现 | 失败细节合并进唯一 terminal failed response；成功的 `runtime_replacement` 不再续排 source-less continuation；成员来源的失败 response 与 exact `a2a_failure` 回报 row 原子提交，回报 row 禁止递归回报 |
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

F254 Phase A HELD、B1 MCP-result piggyback 与 B2 hold-ball reminder 在本轮退役。`post_message`、
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
- [x] AC-D2: multi-target 使用同一 `targets[]`；actual dispatch 删除 exact target，siblings 原位保留，空数组删 entry
- [x] AC-D3: `enqueue` / `claim` / target mutation / `restore` / reorder 均由 Redis Lua 原子转换，Memory/Redis 语义同构
- [x] AC-D4: 第一次实际投递 materialize History；后续 target 复用同一 message；`dispatchRefs` 直接从 `dispatched` 到 `settled`
- [x] AC-D5: Steer 确认时重读 live Queue+History，跳过已投递成员；用户增删 pending targets 不撤销既有 dispatch
- [x] AC-D6: processing/terminal/seen/handled/attempt 不持久化到 Queue；失败、取消、中断均不回队
- [x] AC-D7: 前缀批处理不拼正文；每条 source 以独立 message identity、原顺序进入同一次 invocation
- [x] AC-D8: Redis hydrate 对旧/损坏 row fail closed；schema v1 per-target rows 幂等迁移为 v2 source row，canonical terminal 不导入 Queue
- [x] AC-D9: terminal work 不可复活；重做必须由新用户意图产生新 source/attempt

### Phase E（验收修正，2026-09-03）— 代码与测试完成，待跨族复审 / worktree 体验

- [x] AC-E1: 隔离 Redis 下，猫的 terminal 回复获得 `visibilitySeq` 并进入 `msg:visibility` index；另一只猫的 cursor 读（prompt 增量 / `get_thread_context`）返回该回复
- [x] AC-E2: processing 态 lifecycle 回复行显示脉冲头像 + capability tip；message 下小头像与回复气泡由同一 `activeRun` 驱动；恢复 capability-tip 组件测试
- [x] AC-E3: 无 filter 完整读取实际接管 exact target，并从同一 source entry 的 `targets[]` 删除；siblings 独立保留；无 Queue seen/handled row；读取仍 200；原消息保持 authored 顺序
- [x] AC-E4: 默认设置只表达「排队等待 / 立即发送，引导回复」；ChatInput / QueuePanel Steer 对 participants、路由目标与 fallback 的去重并集提供多选，fallback 读取 Queue admission 同一个 head-time resolver 的只读投影（最近 completed response target，否则全局默认），不在 Web 猜测，并为每个 pending target 独立选择「立即发送，引导回复 / 立即发送，中断回复」；静态 client capability 随成员信息返回，UI 不硬编码；引导只对 exact current reply 生效，不支持则禁用并说明；打开弹窗不写 membership，确认时重读 live Queue+History，跳过已投递/不可用成员并加入新选成员；targetless 首目标与新增 targets 在同一 source entry 原子完成，后续各 target 独立终局
- [x] AC-E5: 失败 response 只呈现一次；正文逐字采用实际 client/provider error message，同一 logical dispatch 的多次错误按发生顺序合入同一气泡，不由 lifecycle 层追加成员/source/error-code/建议；另一只猫的 cursor 读能读到同一 failed response 并可把它作为下游 source，无需用户转达；live 与 hydration 不生成第二条 system/provider error；成功的 `runtime_replacement` 不生成 source-less continuation；cat source 的失败与 exact predecessor `a2a_failure` row 原子提交且不递归回报
- [x] AC-E6: QueuePanel 横幅、浮窗轨迹按钮移除；轨迹 chip 位置符合验收描述
- [x] AC-E7: 对已确认死亡的 exact execution，Stop 返回 200 `reconciled` 而非 409；进程快照不完整时服务端有界重试后按 failed（reason `control_plane_unavailable`）终局并返回 200，失败沿 Phase C 失败传播回溯（源 dispatchRef settle、猫来源 A2A 报回、pre-start 走 `delivery_failure`）；不做平台兼容分支，Windows 子进程不可观测时同样走 fail 收敛；确认无 owner 的 read-repair 使用 `execution_owner_lost`，pre-start processing 超时使用 `prestart_timeout`；单个 child 失败不终局仍有 tracker/process-owner 见证的 sibling parent；`ForceResetDialog` 退役，`ThreadExecutionBar` 无常驻/卡死触发的强制重置入口、无「运行状态待确认」横幅；投影 read-repair 落地，pre-start 预留 TTL 收窄到 create→startAll 窗口
- [x] AC-E8: UI 消息头像、Agent invocation 导航和 `cat_cafe_get_thread_context.situation` 共用 A79 exact predicate；返回 target/source/response/invocation，完整空集明确表示无其他成员执行，证据失配返回 `complete=false`；发言新近性只标「最近发言」，不得成为运行态 fallback
- [x] AC-E9: routing preflight 的 fail-open `warned` 只进入 evidence / telemetry，串行、并行和 A2A admission 均不生成聊天消息；`rejected` 仍生成一次可见 receipt
- [x] AC-E10: terminal History 无「撤回并编辑」；只保留一个「创建分支」入口，以原正文预填编辑框，正文不变也可确认创建
- [ ] AC-E11: co-creator 在 feature worktree 完成上述完整旅程体验验收，随后合入 fork 并通过 soak；在这两道硬门前不得推进上游 merge

### Phase F（carrier 与副作用出口，2026-09-09）— UAT 修订中

- [x] AC-F1: 成员配置只向下游暴露 canonical `carrier`；唯一兼容读取顺序为 `carrier → transport → cli`，非法 client/carrier 组合 fail closed
- [x] AC-F2: Claude `sdk` 与 Codex `app_server` 在 exact active session 上支持 guide/interrupt；OpenCode `server` 因 directory-scoped 持久配置无法隔离 invocation MCP 凭据而退役，OpenCode 仅保留 `cli` / `acp`；单轮 `cli` 不谎报 append 能力，且任何 carrier 失败都不静默 fallback
- [x] AC-F3: `post_message` / `cross_post_message` / `multi_mention` 不检查 inbox、不 HELD、不接受 `acknowledgeHeld`、不附加 freshness/hold-ball 教学；F254 Phase A/B1/B2 active wiring 退役
- [x] AC-F4: A2A 与 response terminal admission 在 exact `sourceRecordId × targetCatId` 已有 History dispatch 时幂等 no-op；已消费 Queue source replay 不产生第二次唤起
- [x] AC-F5: multi-mention 的 Queue source 是一条真实、正文一致、可引用的 Agent History message；callback response 只作 parent lineage，不能充当 synthetic source identity
- [x] AC-F6: connector wait continuation 在准入前验证 canonical task 的 exact outcome、fence、generation 与 delivery terminal；历史或已交付 carrier fail closed
- [ ] AC-F7: co-creator 在 feature worktree 验证 live carrier append/interrupt、单轮排队、multi-mention lineage 与 connector replay；随后进入 fork soak

### Phase G（managed hold 统一恢复，2026-09-10）— 代码与测试完成，待体验

- [x] AC-G1: hold registration 只持久化一条 owner-bound waiting History message；operator 与所有 thread 成员读取同一内容
- [x] AC-G2: timer/command condition 只创建一条 exact fenced、urgent、queued wake source；actual Queue admission 前不进入 History/context
- [x] AC-G3: wake dequeue 后复用普通 response lifecycle，唯一 response bubble 原位承载 processing 与任意终态
- [x] AC-G4: ordinary A2A/managed-hold 新路径不写 Ball disposition，不要求 completion MCP，也不触发 turn stop gate；action-successor gate 保留
- [x] AC-G5: completion MCP 从 callback/API/tool registry/governance baseline 同批删除，且不存在可调用别名或双轨 fallback
- [ ] AC-G6: co-creator 在 feature worktree 验证「等待可见 → 条件满足进入优先 Queue → 出队后单一 response 终局 → 其他成员可读」完整旅程

## Scope Boundary

- **In scope**: undelivered user message 对 cat cognition (`callback / thread context / prompt / pending-mentions`) 的泄漏，以及 canceled message 对 owner timeline/history 的 resurfacing
- **Phase C in scope**: 所有公开 History source 的统一 dispatch 头像、response lineage、terminal 与 retry 投影
- **Phase F in scope**: canonical member carrier、live append/interrupt、MCP 发送工具去门卫化，以及 A2A / multi-mention / connector 的 exact source×target replay 防线
- **Phase G in scope**: managed hold 的共享等待消息、queued urgent wake、统一 response 终局，以及 ordinary A2A/hold completion MCP 与 Ball disposition 双轨退役
- **Out of scope but related**: `cat_cafe_post_message` callback 路由的 @mention 解析/路由异常（走 `callbacks.ts`，不经过 queue/delivery lifecycle）

## Dependencies

- **Evolved from**: F039（消息排队投递 — 三模式已完成，但缺 delivery lifecycle 概念）
- **Related**: F047（Queue Steer）、community issue [#20](https://github.com/zts212653/clowder-ai/issues/20)、PR [#25](https://github.com/zts212653/clowder-ai/pull/25)

Architecture cell: `dispatch` + `bubble-pipeline`
Map delta: dispatch cell 只拥有 Queue pending；bubble-pipeline 拥有 History materialization、dispatchRefs 与 response lifecycle。
Why: actual dispatch/terminal 已从 Queue receipt 完整迁出，避免两个 cells 共同裁决同一 target。

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

## Review Gate

- Phase A: 跨家族 review（Maine Coon review 后端 delivery lifecycle 改动）
- Phase B: 跨家族 review（Maine Coon review 前端适配）
- Phase C spec: co-creator 定稿；Ragdoll Opus 做内容一致性 review 后，实现才可开始
- Phase C implementation: Opus 按 INV-C1..C8 逐条 review，并额外审计新增 fallback 与 kind/scope 分支；
  co-creator worktree 体验验收仍是 fork/上游前硬门
- Phase E: Fable 做 exact-HEAD delta 复审，硬门为 AC-E1、AC-E3 的「typed custody 行存在时仍 200」与 AC-E7 的 `reconciled` / pre-start TTL 收窄；
  co-creator worktree 体验验收与 fork soak 仍是上游前硬门
- Phase G: 跨族 reviewer 核验等待可见性、queued-before-admission、唯一 response 终局、MCP/route/Ball writer 全链 absence；co-creator 验证 AC-G6 后才进入 fork soak
