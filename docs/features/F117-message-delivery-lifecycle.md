---
feature_ids: [F117]
related_features: [F039, F086, F122, F167, F173, F183, F233, F254, F264, F280]
related_decisions: [043]
topics: [message, queue, delivery, lifecycle, context]
doc_kind: spec
created: 2026-03-14
updated: 2026-10-11
tips_exempt: 2026-10-11 documentation aligns existing delivery, guidance and receipt contracts; no additional user-facing action or capability
---

# F117: Message Delivery Lifecycle — 消息投递生命周期真相源

> **Status**: done | **Owner**: Ragdoll + Maine Coon | **Priority**: P1
> **community_issue**: [#20](https://github.com/zts212653/clowder-ai/issues/20)

Architecture cell: dispatch, ball-custody, bubble-pipeline, routing-context
Map delta: none — existing owners retain their facts; common admission and Queue execution replace duplicated ingress scheduling.
Why: pending delivery, accepted inputs, response outcomes and optional read evidence must have distinct, recoverable owners.

## Why

排队输入与已经投递的消息不能共享一组模糊的“收到／处理中／完成”状态。取消待投递输入不能让它进入成员上下文；一个来源也不能因目标数、入口或重试而复制消息、调度或结果。

本特性把消息形成、持久准入、出队、执行与可见反馈连接起来。详细投递协议见 [RFC](../architecture/message-delivery-handling-handoff-audit.md)，存储与转换决策见 [ADR-043](../decisions/043-queue-durable-single-ledger.md)。

## User Journey

1. 用户、成员、IM、邮件、插件或通知提交内容、来源、目标、幂等身份与可选发送策略；入口完成自身协议解析和鉴权后调用共同 `send`。
2. 共同准入解析目标与发送策略，原子提交 source Message 和一条 Queue entry，再通知唯一 drain。未投递的用户／外部输入显示在 Queue Panel。
3. 排队策略等待目标空闲；引导策略在 exact 当前回复支持追加时进入原回复。客户端尚在准备时保留请求，就绪事件自动推进，不需要用户点击 Stop 解堵。
4. 每个实际目标拥有固定 response 与因果 `dispatchRef`。同一输入可有多个目标；同一回复也可接收多条输入，双方身份与顺序都保留。
5. 成员完成、失败或取消后，原回复原位终局，等待消息自然出队。Steer、撤回与 Stop 是明确用户操作；刷新读取同一持久事实。

## Unified State Model

旧版 A2A 前端的 develop_base 对照、已保留能力与 classic／v2 分阶段补齐，见 [前端迁移清单](../plans/2026-10-13-f117-classic-a2a-frontend-parity.md)。该清单不改变下面的单一 Queue／History 契约。

| 事实 | Owner |
|---|---|
| 内容、作者身份、可见性、原始消息身份 | MessageStore source record |
| 尚待投递或追加结果待核对的目标、顺序、策略与短 claim | 一条 source Queue entry |
| 实际 source×target 投递及 optional read receipt | source `dispatchRefs[]` |
| 输入与 exact 执行的关联、正文与终局；接纳另有证据 | 固定 response lifecycle 与 TurnExecution |
| action／wait 的责任、权限与 generation | 各自 structured owner |
| caller 尚需观察的 outbound 变化 | 可丢弃的 process-local view；不裁决执行 |

Queue 保存待投递工作及追加尚未确认的原目标责任，不保存 processing／terminal／seen／handled 的第二套账。普通投递完成后退役对应 target；追加须等 exact 接纳证据落稳后才退役，明确未接纳则恢复原目标下一轮工作，结果未知则保留原目标等待核对。最后一个 target 离开后删除 entry；History 保留结果。新消息不复活旧终局。

## What

### Phase A: deliveryStatus 与持久准入

一条 source 对应一条 Queue entry；多目标保存在 `targets[]` 中。source Message 与初始完整 target set 原子写入，不允许“正文已存、没有 Queue work”的半提交。来源身份与存储 owner 分开，所有新消息携带结构化 `from`。

用户／外部 source 在实际投递前不取得共同 History membership；第一次实际投递复用原 identity 发布，后续目标追加同一 source 的 refs。Agent `post_message` 已是 History message，Queue 只保存引用；completed final 原位更新既有 response，下一跳引用该 response，不复制正文。

### Phase B: 前端投影

Queue Panel 展示 pending 工作，聊天面板展示 History 与固定 response。live、刷新与重连消费同一 Message lifecycle；时间线位置、回执与引用不能从日志、正文相似度或本地偏好推断。

### Phase C: Dispatch 可视化

源消息的成员头像来自实际 `dispatchRefs`，导航到 exact response；pending target 不制造假 processing 头像。bodyless processing response 承载头像和 tip，正文到达后原位升级，不另建等待气泡。失败保留 partial body 与完整诊断，只呈现一份结果。

Append 的 `inputMessageIds` 保存输入与 exact response 的持久关联，单凭该关联不能证明 provider 已接纳或模型已读。`dispatchRef.appendAcceptance` 区分待确认与已接纳；支持读取回执的 adapter 另在 `dispatchRef.inputRead` 上保存 `pending` 或 `{ status: 'read', at }`。原 ID 在 exact native thread／turn 的记录中出现，只能证明已接纳，不能标成已读；查询缺项、失败或不可用也不能证明未接纳。没有读取回执能力时不伪造已读，缺少已读证据不自动重派。

追加结果未知时，系统先核对原消息 ID、首次 handoff 和原生证据，界面显示“正在核对 [成员] 收到没…”且不提供操作按钮；确认接纳后恢复正常回执，仍未知才展示“再发一次”与“如果它其实收到了，会再回一遍”。迟到的接纳／已读证据会撤掉过时操作。普通待发送输入在已知目标空闲、自动执行且无同目标积压时显示“发送中”，忙碌、积压或手动队列才显示“排队中”；保留的未知追加不计为待发送新输入前面的普通队列项。

### Phase D: Queue 内核

所有来源进入同一 ledger 与 `requestDrain`。唯一 comparator 为 position、urgent/normal、FIFO、稳定 id；source category 不暗中改变顺序或能力判断。

普通 drain 按 comparator 扫描，后来的自动追加和新回合都不能越过同目标的旧等待项。等待项只阻挡与它有共同目标的工作，不阻挡无关成员。普通新回合领取一条 source 的本轮完整 pending target set，再并发提交独立 receiver／ref；显式 Steer 或 exact unread adoption 可领取 singleton target。不同 source 不合并正文或身份。

每 target 的 durable handoff 后，其 native ACK 只占该 target；不阻塞无关 target 或让 HTTP 等待整条回复。追加结果核对独立读取原证据，不占住 admission drain，也不重发正文。取消 fence、重试时刻、owner、可见性与 exact parent 仍在执行时复验。`requestDrain` 的 dirty bit 保留并发信号；入队、handoff、客户端就绪、终局、重排及 owner evidence 变化均可推进同一 owner。

### Phase E: 用户操作

- 默认策略为 `next_work`；`continue_current` 是可选的非中断引导。全局、thread 与单次选择使用同一契约。
- Steer 读取当前 pending／dispatched join；确认时重读资格和 exact run，逐成员选择引导或中断。已投递目标不被旧快照复活。
- 引导在 exact 支持的当前回复追加；无当前父执行或不支持时保留普通 Queue 工作，不暗中中断。准备中的父执行保留引导意图，ready 回调重新通知 drain。
- 追加明确未被接纳时，保留原 source、首次 Queue admission 和原收件人，在权限与路由资格仍成立时自动进入下一轮；结果未知先核对，不能自动按原输入重发。
- 核对后仍未知时，只有原人类作者通过严格 owner 校验才能选择“再发一次”。它为同一收件人创建新消息 ID 和新 admission，并显示可能重复回复的警告；保留私密可见域、附件及回复引用，不改写原消息与原回执。并发点击或丢失 HTTP 响应后的同一操作重试复用这个新 admission。
- 已确认接纳或已读、原目标已撤掉等资格变化会拒绝过时的新发请求，即使旧 Queue 清理尚未完成；已经创建的新输入仍按自己的身份处理。
- 中断先取得精确 claim，再取消该目标执行；失败恢复未投递工作，不回滚已接收的 sibling。
- Stop 控制 exact 执行。没有可控活候选时按既有 reconciliation 收敛真实运行状态，不删除消息、历史或其他目标的运行。
- 已出队后的跟进请求可能返回 `ENTRY_NOT_FOUND`；前端刷新 canonical snapshot 收敛，不重复执行，也不把完成后的竞争当作新的业务失败。

### Phase F: Carrier 与副作用边界

成员顶层 canonical `carrier` 决定接入方式。旧 transport 兼容只在配置边界读取，不在运行路径按全局开关改派 carrier。一个 carrier 的故障不能静默换成另一个。

`activeInvocationGuidance`、`deliverySemantics` 与 `inputReadReceipt` 分别表示能否引导、承载精度和读取证据。引导能力不等于模型已读；`queued_internal_turn` 不冒充 `exact_active_turn`。MCP/callback send 是发送原语，不在出口检查 inbox、HELD 或注入强制读取教学。 所有调用（包括 Live 语音）均不装配 provider-native freshness：工具断点或 idle 均不扫描全线程未读来要求读取增量。消息可公开检索不代表投递给该成员；新输入只经 Queue 的实际目标进入 exact append／新回合。Live 语音的正常输入、结果返回和实际投递引用沿已有明确来源机制推进，不保留 freshness 例外或另一条未读提醒路径。

### Phase G: Managed hold 与 structured continuation

hold 命令结果保存在原 task；需要唤醒时提交幂等的 source/Queue work，并由 response 表达本次处理。结果、责任与 message delivery 不复制到 Ball disposition 或 Queue receipt。

action／wait／callback 的 private input 保留 exact owner、principal、generation、predicate 与 expiry；共同 Queue 运输这些约束，不签发权限，也不把它们变成普通 fallback。

### Phase H: Caller outbound view 与失败回流

caller 的运行时观察以 exact source×target 为单位，记录已提交的选择变化与呈现 revision。实际 pending、dispatch、delivery failure 与 terminal 都从 Queue／History 反查。成功呈现 terminal／withdrawn revision 后 compare-and-clear，期间新增 revision 不被旧 invocation 清掉。

正常 completed／canceled／interrupted 不自动重启 caller。exact A2A failed 与原失败 response 原子提交幂等 `a2a_failure` message-ref control wake，唤醒 exact caller 读取原结果；不复制失败正文，不登记新的业务 handoff，不递归 fail-back。重启不自动重建旧进程的观察集合；历史结果仍可查询。

### Phase I: 共同 send 与目标、策略快照

入口只提交 envelope；普通消息的目标解析、默认策略解析、持久化和 drain 通知属于共同准入。新增一种普通来源不需要新增调度分支。

普通正文只把匹配现有成员的 mention 当作目标；未匹配的 `@` 原样留在正文，不新增 warning、错误卡或等待状态。没有有效可用目标时，预览与共同接纳使用同一 resolver：普通会话从完整持久历史中找到最后一条含点名的真人输入，按原始发送时间、同刻消息 ID 确定先后，选择其中第一个可路由成员；不设时间或消息条数过期窗口，刚持久入队的真人点名也立即生效。A2A、系统消息和旧输入的晚投递不改变这次选择；成员忙碌不等于不可用，仍等待原成员。没有可用的最后点名对象时，才继续最近健康回复者、首选／可用参与者与默认成员；保留 concierge、显式 #ideate 和 routing policy 的既有覆盖规则。已知成员确实不可用而改投时，收件人预览显示不可用对象与实际收件人的说明；旧格式历史不因缺少新 response lifecycle 而被一律排除。普通公开目标不可用时允许 fallback；入队后的已绑定目标不扩大，晚失效沿原目标失败或恢复。显式协议 ID 的身份校验不适用正文忽略规则。

A2A 的行首路由或指定 ID 是 exact 目标：目标不存在／不可执行走已有 delivery failure 回报，不改投默认成员。whisper 与其他授权绑定输入也保持精确收件人；公开 fallback 不扩大其可见性。排队后和追加前都复验 source/receiver 的权限。

策略在共同准入、持久入队前解析：单次显式意图优先，否则 thread override → global → product default。按每个实际目标保存意图与 exact parent；来源不参与默认选择，不增加 per-cat 设置。

同幂等 ID 重放复用首次赢得提交的目标与策略，包括已退役 Queue row 的持久接纳事实。后续偏好变化作用于新消息；同 ID 不同 envelope 保留冲突校验。不同 ID 同正文是不同消息，不按正文或时间窗口去重。

### Phase J: 执行活性、启动与超时

durable invocation／child／response 是执行事实，tracker／process owner 是活性见证。草稿不作为 TTL 或更新时间意义上的运行判据。重启保留数据并收敛旧运行；不重建 provider client 或自动重放已经接管的输入。

每成员的无输出超时使用 `CLI_TIMEOUT_MS`，默认 `0`（禁用）。启用时 text／tool／thinking 等真实输出刷新计时；仍占 CPU 的进程可有界顺延至两倍。触发走 exact Stop／failed timeout 终局；不取消无关 sibling。启动前无首帧的既有重试与运行后无输出超时分开。

### Phase K: SDK 结果身份

provider 自发 task/channel/peer 通知的 result 不能在缺少对应输入身份时核销用户输入。支持权威压缩的 SDK 通过实际 PreCompact/seal 接线证明边界；不能从正文或单个不完整事件猜测压缩完成。

### Phase M: 追加、读取与执行归属

调用 provider 前，先在原 Queue 记录该 target 的待确认 handoff，再持久绑定 source、exact response 和输入身份；发起 native 调用不先删除原目标责任。确认接纳先落 source 证据，再清理该 target；已读证据独立单调更新，并可先于接纳确认到达。

恢复在既有 source、response 与 Queue 三条记录上原子提交：明确未接纳时清除该次输入关联并保留原 admission 的下一轮工作；结果未知时保留原关联与待核对目标。失败原因按原分类保留，异常不一律解释成“客户端已关闭”或“确定没收到”。恢复写入失败或进程重启仍从这些持久记录继续，不能丢掉首次责任、复制正文或自动重放未知输入。

迟到的接纳／已读证据优先于失败补偿；补偿只修改仍存在的 exact 目标并保留其他成员的 claim，不从旧快照重建已退役目标。系统自动恢复和同 ID 幂等重放复用原输入；用户明确“再发一次”则是另一条新输入，不能承诺模型绝不重复回复。成功接纳后，缺少模型读取证据本身不能成为第二次 admission。

## Acceptance Criteria

- 相同条件的用户、成员、IM、邮件、插件与通知入口汇入同一准入和 Queue 决策；不同协议仍保留各自鉴权。
- Message＋Queue 原子性、同 ID 并发／重载与 target／policy 快照同时覆盖内存和真实隔离 Redis；空 target 数组不变为对象。
- 普通与 A2A 路由、混合有效／无效 mention、公开 fallback、whisper/private 授权和 late invalidation 互不混淆。
- 同目标 FIFO、跨目标进度、慢 native ACK、取消／重试 fence 及一次 source 的 fan-out 均保持幂等。
- 延迟客户端就绪后自动出队；HTTP Steer、自动追加与自然 next-work 均走真实产品装配。确认接纳后清理对应 Queue work；明确未接纳恢复原输入下一轮，仍未知则保留可追溯的核对责任，不伪造完成。
- 普通会话的最后真人点名不因时间、消息条数、成员忙碌或 A2A 变化而丢失；刚入队的新点名立即参与选择，旧输入晚投递不覆盖它；实际不可用改投时预览有可见说明。
- 未知追加先核对原 ID，核对中无操作按钮；明确新发保留原回执、使用新 ID、严格校验原人类作者与私密边界。迟到接纳／已读、恢复写入失败、重启及 sibling claim 均不丢责任或复活已退役目标。
- Console 点击、原气泡归属、读取回执、刷新、Stop／恢复与成员交接覆盖实际使用；provider 能力结论只覆盖真实验证的配置。
- 故障与重启只收敛原 owner，不删除用户数据、不复制失败结果、不自动恢复已终局工单。

## Scope Boundary

本特性拥有共同 message admission、Queue execution、response ownership 与反馈。它不拥有 connector 协议、structured task 责任、权限签发、provider 内部 session/compact 状态机或 GitHub 插件 CI 批量采集。显式 article API 与历史消息读取保留；隐式 Signal-library context injection 不属于普通发送。

## Dependencies

- [ADR-043](../decisions/043-queue-durable-single-ledger.md)：持久 Queue、claim/commit/restore 与逐目标转换。
- [RFC](../architecture/message-delivery-handling-handoff-audit.md)：入口、执行、授权、失败、恢复与不变量。
- F167／F280：action/wait exact 责任与授权；F177／F183／F264：响应气泡、投递投影与 UI identity。

## Risk

跨 Message／Queue cutover、native readiness 和真实存储转换必须联合验证；局部 mock 通过不能替代产品装配。新增入口不得保留平行调度。可选回执不能变成 admission 或责任门禁。公开 fallback 必须守住私密收件人边界。

## Delivery Status

实现已进入 fork；运行验收与持续观察属于发布状态，不能由这份规范自行宣告完成。上游 #1398 的 Draft／review／merge 状态以 GitHub 和维护者决策为准。

## Code Anchors

- `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts`：共同 send 与持久目标／策略。
- `packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts`：唯一 drain、追加、ready、Steer、Stop 与执行。
- `packages/api/src/domains/cats/services/agents/invocation/PersistedQueueDelivery.ts`：外部持久投递适配。
- `packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts`、`last-user-mentions.ts`：普通 fallback、最后真人点名与 exact recipient 解析。
- `packages/api/src/domains/cats/services/stores/lifecycle-append-recovery.ts`：source／response／Queue 的追加恢复准备与并发守卫。
- `packages/api/src/domains/cats/services/agents/invocation/repeat-uncertain-append.ts`：严格原作者的新输入；`queue-routing-recovery-policy.ts`：当前资格校验。
- `packages/shared/src/types/message-lifecycle.ts`：source／response／dispatchRef 与 optional read receipt。
