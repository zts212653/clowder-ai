---
description: "定义 F117 的唯一持久 Queue、History dispatch 与 response 边界，记录普通投递、停止、回放与恢复的现行设计。"
description_source: model
description_author: codex-astra
description_updated_at: 2026-10-15T06:58:00Z
description_generated_by: codex-astra@gpt-6-astra
description_confirmed_by: codex-astra
description_generated_at: 2026-10-15T06:40:00Z
decision_id: ADR-043
related_features: [F117, F039, F047, F122, F175, F254, F264]
topics: [queue, delivery, lifecycle, persistence, architecture]
doc_kind: decision
created: 2026-09-02
source_ref: https://github.com/zts212653/clowder-ai/blob/7fca378fa010a288484e909446a2faeee5a7fbe2/docs/decisions/043-queue-durable-single-ledger.md
---

# ADR-043: 消息队列 = 独立持久化的有序工单账本

Architecture cell: dispatch, bubble-pipeline, ball-custody

> **Status**: accepted | **Decider**: co-creator | **Analysis**: Ragdoll(opus) | **Implementation**: Maine Coon/Maine Coon | **Priority**: P1
> **Supersedes (设计层)**: F039 / F122 / F175 / F047 中关于队列状态与 Steer 预留的描述

## 背景

F117 将消息投递收敛到持久 Queue、实际 dispatch 与固定 response。旧实现将待投递工作、运行终局和回执混在 Message custody 与内存 Queue 两处，导致恢复与调度重复裁决同一事实；本决策为这些事实划定独立 owner。

## 历史问题（决策背景，非当前实现）

### 1. 队列不持久，真相寄生在 message 上

```ts
private queues = new Map<string, QueueEntry[]>();   // InvocationQueue.ts:263 — 纯内存
```

持久的那一份是 `message.queueCustody`，被序列化成 JSON 塞进 message 的 Redis hash：

```lua
redis.call('HSET', KEYS[1], 'queueCustody', ARGV[1], 'queueCustodyRevision', ARGV[2])
-- RedisMessageStore.ts:189
```

而 `QueuedMessageCustody` 的形状本身就是一个队列条目：

```ts
interface QueuedMessageCustody {
  entryId: string;                                  // 队列条目 ID
  revision: number;                                 // 乐观并发版本
  status: 'queued' | 'processing' | 'terminal';     // 队列条目状态机
}
```

**结论：持久队列条目已经存在，只是存错了地方。**

### 2. 双写：13 个字段逐一镜像

| QueueEntry（内存） | message.queueCustody（持久） |
|---|---|
| `queuedNotifiedByCatIds` | `notifiedByCatIds` |
| `queuedAwakenedInvocationIdByCatId` | `awakenedInvocationIdByCatId` |
| `queuedSeenByCatIds` | `seenByCatIds` |
| `queuedSeenInvocationIdByCatId` | `seenInvocationIdByCatId` |
| `queuedBodyExposures` | `bodyExposures` |
| `queuedFailedByCatIds` | `failedByCatIds` |
| `queuedHandledByCatIds` | `handledByCatIds` |
| `allTargetCats` | `allTargetCats` |
| `steerRequestedByCatIds` | `steerRequestedByCatIds` |
| `steeredInvocationIdByCatId` | `steeredInvocationIdByCatId` |
| `authorIntentByCatId` | `authorIntentByCatId` |
| `queuedFailure*ByCatId` | `targetAttempts` |
| `queuedAttemptIdByCatId` | `targetAttempts` |

旧实现中相应的——CAS、`-3` lifecycle 冲突码、reconcile、rollback、`restoreDurableEntry`、startup reconciler——**都是维持这两份一致的机器**。

### 3. 旧实现把多目标拆行，导致 UI 与账本身份不一致

```ts
// retired shape
return admission.targetCats.map((targetCatId) => createQueueRow(sourceId, targetCatId));
```

这会让同一条用户消息在 Queue UI 中看起来像发了 N 次，同时又迫使 agent/user/connector 走不同数据模型。正确边界不是“把所有来源都拆行”，而是：**一条 source message 始终只有一条 Queue Entry；目标差异只存在于这条 entry 的 pending target set 与 History 的实际 dispatch records 中。**

## 决策

### D1 — 队列条目独立持久化

按 thread 建持久队列：入队即持久化，重启直接反序列化。**不再寄生在 message hash 上。**

### D2 — Queue 只拥有尚待投递的工作；History 拥有实际投递与响应终局

职责边界：

- **source message**：内容、结构化 `from`、稳定 source identity，以及在 actual dispatch 后取得的公开时间线身份；
- **Queue Entry**：尚未投递的 `targets[]`、顺序、默认/单目标作者意图和短暂可回滚 claim；
- **History lifecycle**：每个实际 source→target 投递的 `dispatchRefs[]`，以及对应 response bubble 的 processing/completed/failed/canceled 终局。

Queue 不再保存或投影 `notified/awakened/seen/handled/failed/terminal` 回执，也不保留 terminal tombstone。`deliveryStatus` 只描述 source message 的粗粒度可见性；逐目标事实只能从 History lifecycle 读取。

用户与外部 connector 的 inline source 在尚未发生任何实际投递时不进入公开 History。第一次成功投递会把同一 source materialize 到 History，并追加第一个 `dispatchRef`；后续目标复用同一条 source bubble。Agent source 本来就在 History，不需要重复发布。

公开 History message 的自身执行终态与它能否成为下一跳 source 正交：
`completed / failed / canceled / interrupted` response 均可记录新的下游 `dispatchRef`，且不得改变自身终态。
失败传播因此直接引用原 failed response；不复制正文，也不创建第二条失败通知。

### D3 — 一条 source message 只有一条 Queue Entry

`QueueLedgerEntry.id = queueEntryId(sourceRecordId)`，不含 target。`targets: string[]` 是**仍待投递**的集合：投递一个成员只删除该成员；最后一个 target 离开后才删除整条 Queue Entry。多目标不会复制 source message，也不会在 UI 产生多个输入气泡。

`payload.sourceRecordId` 回答“这条 Queue Entry 代表哪一条持久 source record”；`from` 回答“谁写了它”。两者正交，任何一方都不能替代另一方。

### D4 — 单行原子 mutation + 跨 store 单调收敛

Queue 自身由 Lua/CAS 转换保证：`enqueue`、按 target 的 `claim/commit/restore`、整 source withdrawal、以及 `reconcileTargets`。初次多目标 admission 在**同一行的一次写入**中全有或全无；不会留下半组 target 或 ghost row。

实际 dispatch 跨越 Queue 与 History 两个 owner。drain 先按唯一 comparator 领取 source entry；同一 source 本轮
冻结一个 exact target set，并按以下顺序提交：

1. 为 target set 中每个成员并发创建/确认独立 response lifecycle，并把真实
   `dispatchRef(targetId, responseMessageId, dispatchedAt)` 写入 History；
2. 每个 target 的 receiver/ref 持久化后，在同一 source claim 内原子删除自己的 target 并启动自己的 provider；
   未完成 handoff 的 siblings 仍由原 claim 保护，最后一个 target 删除后才关闭该 row；
3. 某 target 在第 2 步前失败，只恢复尚未退役的 targets；健康 sibling 已有的 receiver/ref、provider run 与 Queue
   退役不回滚。若进程故障，重放先 join History，发现 target 已 dispatched 后只做幂等清理，绝不再次唤起。

这个 join 以 exact `sourceRecordId × targetCatId` 为键，并在 Memory/Redis 的 lifecycle terminal + Queue
transaction 中原子判定；不能先做一次易失 read，再凭旧快照 enqueue。A2A、connector 与恢复路径重放一个
已消费 source 时，只允许清理残留 Queue target。multi-mention 也必须先创建正文一致的真实 Agent History
source，再将该 source 与同一 `targets[]` entry 原子 admission；callback response 只是 parent lineage，不能
让它的 id 指向另一段只存在于 Queue 的 synthetic 正文。

一次 try-drain 最多启动一条 source：按 comparator 顺序找第一条「完整 pending target set 此刻都可 admission」的
source。等待中的 source（目标被 Active Run 占用、被取消 fence 压住，或重试尚在等待）不满足条件，原样留在原位，
但不再挡住它后面的 source：只挡住后面与它有共同目标的 source，所以每个目标仍按 comparator 顺序收到 source；等待
空闲 thread 的 targetless 输入挡住其后全部 source，因为它的目标还未知。只有 comparator head 在解析不出目标时原位
失败，后面的 source 解析不出目标时等待，并占住其请求的目标。领取不再要求被选 source 是 comparator head；Lua 领取
本就只校验 row 仍 queued 与 target 匹配。扫描读的是一份快照，并在解析目标时 await，owner 可能在此期间重排；所以
领取前（中间没有 await）按当前 comparator 复核：排在被选 source 前面的 queued source 必须都是本次扫描已经越过、且
请求目标未变的，否则本次不领取，重新扫描。该 source 的共享 claim 在所有 targets 已退役，或失败 target 已恢复
pending 时关闭并发出下一次普通 drain 信号，因此后一 source 不必等待健康 target 的 provider terminal；等待中的
source 由既有执行终局事件再次触发 drain。

尝试结束时仍留在 Queue 的 source 不立即重试：交接前失败（actual-send preflight 拒绝目标、admission 失败），或
actual-send 拒绝了其中部分目标（其余目标已交接）。为了不在同一失败上空转，该 source 等到它的重试时间：取本次尝试中
routing 对被拒目标给出的 `automaticRetryAt`（由 route 在拒绝时回报，因为 targetless source 恢复后不再记得它解析到的
目标）与逐次翻倍的退避（10 秒起，最长 60 分钟）两者中较晚的时刻，到点由定时器触发 drain；等待期间其余 source 照常
drain。这个等待是进程内状态，重启后直接在启动 drain 里重试。
同一 source 的 target set 是一次 fan-out，不以“第一个 target 完成 handoff 后再次 drain sibling”拼成并发。一个 target
进入 provider 后失败，不回滚已经被 sibling 接受的投递；每个 response bubble 独立终局。

Redis `order` 只索引当前待处理 entry；`messageId → entryId` 只为定位尚待投递的 source，不承担历史 receipt 查询。History 分页与头像投影只读 Message lifecycle。

### D5 — Steer 以实时 pending/dispatched join 为准

Steer 的短 claim 保护“一条 source entry + 本次选择的 pending targets”在跨 I/O cutover 期间不被普通
drain 并发改写。它仍只是 Queue mutation fence，不把 source entry 升格为 processing，也不保存替补 run
的终局证据。中断当前回复需要调用 Agent Client，因此不能塞进 Redis Lua；中断或 admission 前失败时，
claim 按原位置恢复。某 target 一旦完成实际 dispatch，就写 History `dispatchRef` 并从 pending
`targets[]` 删除，之后由 response lifecycle 独立收敛。

消息默认分发与显式 Steer 是两层：默认设置只提供「排队等待」(`next_work`) 与「引导当前回复」
(`continue_current`)；产品默认是「排队等待」，用户可以在输入框左侧 `+` 菜单按全局、thread 或单次作用域显式
覆盖，不依赖当前是否有成员回复。active 时输入区右侧只保留 Stop；有正文时再显示一个普通 Send。Send 只做一次
Queue admission，不在客户端 admission 后追加第二次 Steer。Steer modal
固定提供「立即发送，引导回复」与「立即发送，中断回复」。前者只由该成员的静态 client capability 判定是否可选，不从 Web 当前活跃快照猜测；确认后由服务端重读 exact active parent，有父 invocation 时做非中断追加，无父 invocation 时诚实降级为普通 Queue 新运行。`exact_active_turn` 和
`queued_internal_turn` 都可以表示这种引导能力；前者表示精确当前 provider turn 的承载，不自动证明模型已读。读取证据由可选 `dispatchRef.inputRead` 单独记录。能力由服务端随
成员信息逐成员投影，前端不得硬编码或从本地活跃态猜测。不支持时 action 禁用，原因只在 hover/focus tooltip
呈现，不增加常驻解释行；默认 `continue_current` 与显式 Steer 在无 active parent 时都诚实保留为 `next_work`，不自动中断，并由普通 FIFO drain 处理。

普通公开输入在共同 send、原子 Message + Queue 准入前解析有效成员 mention，缺少有效可用目标时，预览、共同 send 与公开 Queue recovery 共用既有隐式会话规则（最近用户 mention、健康回话者、首选成员、默认成员，并保留 concierge / #ideate / thread policy）；未匹配的 @ 原样留在正文并忽略，不产生 warning 或特殊等待。目标与显式意图或 thread/global/product 默认策略一起持久快照；同 ID 重放复用首次接纳事实。A2A、whisper 和其他授权绑定输入保持 exact 收件人，不扩大私密可见性。历史/恢复 targetless 工作由正常 Queue recovery 处理。

Steer modal 可多选，成员候选为 thread participants、路由目标与 fallback 的并集去重；fallback 直接读取 Queue admission 使用的同一 resolver 投影，Web 不另算。每位成员可以分别选择 guide 或 interrupt。

打开 modal 只读取快照，不写状态。确认时客户端提交“打开时 pending targets + 当前选择”；服务端重新读取：

- 当前 Queue `targets[]`；
- History 中已存在的 `dispatchRefs[]`；
- 当前 membership/availability。

已经被未读接管或其他 dispatch 投递的成员直接跳过，不能复活；用户从旧快照取消一个已投递成员也没有副作用。仍 pending 的 remove/add 在同一 source row 上合并，新加入成员只在确认时加入 thread。普通状态变化不是整批 revision conflict；每个仍可执行 target 随后独立 guide/interrupt，失败不回滚 sibling。

### D6 — 副作用出口不再承担 freshness 门卫；专用 continuation 仍是显式载荷

F254 Phase A HELD、B1 MCP-result piggyback 与 B2 hold-ball reminder 已由 #1398 退役。callback/MCP 写工具
是纯发送原语：不在 `post_message` 时检查 inbox、不阻止发送、不接受 `acknowledgeHeld`，也不在工具结果中
注入读取教学。运行中正文由所选 carrier 的真实能力承接：live carrier 可向 exact active session append 或
interrupt；单轮 CLI 不谎报 append，消息继续 pending 并由正常 FIFO drain 开下一轮。

这不等于删除独立的 scheduled/freshness/continuation 工作。它们若由自己的 owner 显式创建，仍以 typed Queue
payload 写一次、起跑读一次，并由对应 store 重建；这些字段是任务输入，不是 `post_message` 的隐藏状态机，
也不得重新生长成 Queue receipt。已证明纯写不读的 `freshnessRequiredFrontierMessageId` 继续删除。

成员接入方式只有顶层 canonical `carrier`。兼容读取只在配置边界执行
`carrier → legacy top-level transport → cli`；下游 provider/capability/UI 不得再读旧字段或全局环境开关，
且一个 carrier 的失败不得静默 fallback 到另一个。

### D7 — Queue 没有 terminal row；重做是新的用户意图

目标一旦实际 dispatch，就从 pending `targets[]` 离开。`handled / failed / interrupted / canceled` 属于 response lifecycle，不回写 Queue。Queue 的「停止后续处理」删除尚待投递的整条 Queue Entry；只有未公开且没有实际 dispatch 的 source 才将其可见性投影置为 canceled。已公开的猫消息、原 dispatchRef、response membership 与未知送达记录保留，不因停止未来工作而撤回历史正文。

原生 Append 仍在交接或等待原生内部 turn 完成时，短 claim 与 pending handoff 继续保护原 Queue。一次交接已返回但送达结果仍 unknown 时，禁止自动重发，不禁止主人停止其后续处理；迟到回执仍更新原 History，不重建已撤出的 Queue。批量 Clear 若还有在途条目，返回明确的未完成/部分完成及剩余队列，不把空操作报成全部清空。

用户若要重做失败事项，应发送新消息或执行明确的新动作，由生产者产生新的 source/attempt。旧 response、dispatchRef 与 wait carrier 只保留原 attempt 的终态证据，不能充当 retry token。

### D8 — 完整正文读取就是一次真实投递

无 filter 的完整 thread-context 读取若要返回一个带持久 Message 的 same-target `conversation_input` queued
正文，服务端必须先验证 exact running `TurnExecution` 与同一个 `LifecycleActiveRun`，再把该 source 的 exact target 接管到现有 response：

1. claim exact row；
2. 在 live Active Run 预留 source/entry，并将 source Message 单调推进到 `delivered`；
3. 把 source message/entry 持久写入该 response lifecycle；
4. 从 Queue Entry 的 `targets[]` 删除该 target；不写 Queue `seen/handled` 镜像。

History publication 失败时必须撤销 live 预留、restore claim。`active_run_missing` / `state_changed` / `lifecycle_conflict`
都是良性竞争：只从本次 payload 剔除尚未接管的 queued 正文并照常返回其余 History，不把整次读取变成
409。只有持久层不可用才返回 503。接管一旦写入 History，后续失败不得把同一 target 放回 Queue；重放通过 dispatchRef 幂等收敛。`queued_seen` / `queued_handled` 仅可保留为兼容 telemetry 名称，不能成为 Queue 字段或恢复 authority。

A 读取只从同一 entry 删除 A，B 继续留在 `targets[]`；B 后续读取再删除 B。第一只猫接管后
Message 已进入成员可见 History，其他 target 的 Queue 责任仍由同一 entry 追踪。无 Message 的行以及
带 `actionSuccessorFence` / `waitContinuationCarrier` / scheduled/freshness/continuation custody 的行保留 read→seen
语义，不由 History 读取接管；稀疏读取、跨 thread 读取、oversized anchor 或无法证明 exact active child
的请求都不得接管。

本决策取代 F254 D1.2 的旧“两阶段 seen，成功后 handled”实现约束；旧段落只保留为历史设计记录。

### D9 — 停止是对持久执行真相的权威终态化，投影不能反过来卡住它

> 来源：co-creator 2026-09-03 worktree 验收决策（thread `[thread-id]`）。取代 F220 Phase 3「force-reset 逃生口」作为用户概念的地位。

用户只有两种状态（在运行 / 未运行）和一种动作（停止：单只猫 / 全部）。**停止的成功判据是投影进入「未运行」**；进程是否真的退出由服务端在后台保证。用户不需要区分「正常停」与「强制重置」，也不需要理解逃生舱。

1. **「在跑」的真相 = 持久 execution/response lifecycle + 活性见证**：TurnExecution `running` 与 response lifecycle 是持久真相；Queue 的 `claimed` 只覆盖 admission 的短可回滚窗口，不能冒充执行态。tracker 槽位、`processingSlots`、session 锁只是内存缓存与活性见证，**单独不能构成 busy**。
2. **停止阶梯（服务端自动升级，用户不选机制）**：exact 活候选 → 现有取消链（abort / `terminateExact` / 释放本猫锁与槽位 / 写终态）；无活候选但目标仍投影为在跑 → 同一请求就地对账（退 pre-start 预留、running 记录置 canceled、释放孤儿锁与槽位、广播终态）并返回 `reconciled`；**对自己拥有的执行永不 409**。进程快照不完整（`ps` 失败 / owner manifest 目录损坏）时，服务端有界重试快照后仍不可用 → 走普通 dispatch terminal：该 exact execution 及其 response 行按 `failed`（reason `control_plane_unavailable`）终局，投影进入未运行，并沿 F117 Phase C/H 收敛：源消息 dispatchRef settle 到该失败 response（`settleLifecycleResponseInputs`）；exact A2A caller 由引用该 response 的幂等 Queue control edge 及时唤起，其他观察仍在 dispatching member 下一次 invocation 反查该 exact 终态；pre-start 尚无 response 行时走 `delivery_failure`。重做只来自新的用户意图（INV-C7），系统不替用户重新拉起。只有持久层不可用（终态写不进去）才 503。**不做平台兼容分支**：Windows 没有 `ps`、子进程不可观测，同样落入这条 fail 分支收敛（快照不可用 = 无法确认 = failed 终局 + 后续 History observation）；本 ADR 唯一保留的兼容是旧 chat message 的 `from` 读取（A.5 `messageFrom`）。
3. **没有任何确认弹窗**：用户只关心运行态与终态，不需要理解「无法确认进程状态」。`ForceResetDialog` 退役；`/force-reset` 只作为服务端内部 thread 级对账实现，没有用户入口。终态行不复活（D7）保证迟到输出无法回写已终局的气泡；detached host 由 supervisor 收敛（F220 KD-8），有界。
4. **同一段对账三处复用**：启动（`StartupReconciler`）、投影读取（read-repair：running 记录 + 无 tracker + 进程快照 complete 且无 owner + 超出 pre-start 窗口 → 以 `execution_owner_lost` 终态化；快照不 complete 时不动）、停止（第 2 条）。已离开 Queue 但从未安装 provider tracker 的 pre-start attempt 超时，以 `prestart_timeout` 正常失败终局；父 InvocationRecord 只有在没有 sibling tracker / process-owner 活性见证时才随 child 终局。
5. **前端**：权威投影稳定即信；旧 socket busy 标记自愈，不再有「运行状态待确认」死角与基于卡死的强制重置入口。

历史根因：F220 Phase 2 报告（#972）已定性为「多 liveness SoT 无收敛点」；F194 读模型、TurnExecution 持久子真相与本 ADR 的账本已关闭进程内的绝大部分分叉，剩余只有基础设施故障（Redis / API 进程）一类，归 reconciler，不归用户。

## 不会简化的部分（诚实边界）

`prestartRetirement` **不消失**。窗口是 `invocationRecordStore.create` → `invocationTracker.startAll`，中间包含 routing/visibility 预检、前缀吸收、session 准入。这个「已经 admission、但 tracker 里还没有」的空档由 **I/O 本身**造成，不是 Queue 持久状态，进不了 Lua。

它会从 Steer 专用标记收敛为同一次原子 Queue claim 的通用 `retiringGroupId`，用于关联一起进入 pre-start 窗口的 FIFO prefix entries；它不表示多目标 fan-out。

### D10 — 公开结果、失败控制边与普通 continuation 分工

canonical response / `delivery_failure` 是唯一公开结果，source `dispatchRef` 是其逐目标关联。不得复制 failed
正文或另造 system result。A2A target 进入 **failed** terminal 时，同一持久事务额外提交一条引用该 response、
指向 exact caller 的幂等 Queue-only `a2a_failure` 控制载体；它只负责及时触发 caller 消费权威结果，消费 route
必须禁止递归 fail-back。completed/canceled/interrupted 不自动创建 caller work；target 显式发给 caller 的新消息
仍是普通 dispatch，其他自动 continuation 必须由 hold/eventWait/action-successor 等显式 owner 创建。控制载体
不登记为失败方新发起的 outbound business dispatch，也不进入失败方 caller view。

本约束的根因教训：Queue-only 控制载体不是第二条结果。曾把“失败只公开一次”错误推广为“失败不产生任何
predecessor Queue work”，导致 canonical failed response 已落 History、caller 却没有触发器。单一真相源约束复制
状态，不禁止引用权威状态的幂等调度边。

同理，系统诊断不能因为使用 `system_info` envelope 就自动成为 History message。未分类 warning 与 routing
fail-open `warned` 留在 telemetry；只有要求用户采取具体动作的 warning 显式声明 `user_action_required` 后才能
持久呈现，自动重试等短暂状态只进入 live provider status。route-syntax、verdict-without-pass、void-hold 等
Agent protocol correction 走私有 feedback / 下一 turn prompt / telemetry，不向用户对话追加提示气泡。这样
“对话消息”由用户行动价值决定，而不是由入口类型或字符串 if/else 决定。

客户端单 runtime 在 caller 串行 slot 中维护一份**该成员自己的 outbound dispatch view**。它以
`(owner, thread, caller, sourceMessageId, targetId)` 为 item key。每个 item 保存严格单调的 `revision`、最近一次
成功进入 caller prompt 的 `presentedRevision`，以及当前 Queue/History 已无法反查的最小解释事实：
`firstAddedBy(initial|steer|unknown)`、`selectionChange(added|removed)` 与
`selectionChangedBy(initial|steer|queue_withdrawal|unknown)`。这些字段不参与执行裁决；当前进程首次
看到重启前遗留 target 的 remove/actual 事件时，最初来源不可证明，必须写 unknown 而不是猜 initial：

这里的 source identity 不能被执行优化抹平。`M1→B` 与 `M2→B` 永远是两个 view items、两条分别属于
M1/M2 的 dispatchRefs；Queue admission 逐 source 处理，即使其它显式机制让一个 response 反向引用两条 source，
也不能把 source lifecycle 合并成一次 attempt。相同 source 的 B/C 则共享一个 Queue row，但各有独立 ref/result。

- 一条 Agent source 成功提交 Queue admission 时，把当时的 exact targets 加入 view；同一 caller 随后发送新的
  source，只追加新 source×target items，不覆盖前一条仍 open 的 dispatch；
- Steer 对尚未 actual dispatch 的 target 做 remove/add 时，按已经提交的 Queue mutation 更新同一 item revision 与
  selectionChange；C 离开 Queue 后仍可说明“由 Steer 移除”，E 可说明“由 Steer 新增”；
  已 actual dispatch 的 target 仍由 History ref 裁决，不能被旧 Steer snapshot 改写为未投递；
- actual admission、direct `delivery_failure` 与 response terminal 只触发对应 item 的 revision 更新；dispatchRef
  关联已经发生的投递或投递失败事实，不代表 target 预期，也不能仅凭 ref 存在断言 provider 已收到消息；实际状态和
  response identity仍在读取时从 Queue + source `dispatchRefs[]` + canonical response 反查，view 不复制它们。

因此 `A→B/C/D` 进入 durable Queue 后，Steer 移除 C、保留 D、加入 E，可以在 A 的 view 中表达为：C 未投递且已移除，D 已实际
投递，E 是新增待投递/已投递；B 随后在 actual admission 前失效时通过 canonical `delivery_failure` 表达。无法解析出 canonical
targetId 的 mention 只进入 routing diagnostic；durable Queue admission 前被 routing preflight 拒绝的 canonical target
由本次发送结果立即返回 typed fail-back，二者都不伪造 view item。初始 admission、Steer 与 actual result 都调用同一
view update primitive，不为各入口建立平行状态机。

caller 下一次自然 invocation 先对所有保留 items 逐项反查：Queue 仍含 target 表示 pending，History ref 为 open
表示 executing，settled ref 读取 canonical terminal response；最近一次已提交 view mutation 为 remove 且没有 actual
ref 时表示 not_delivered/withdrawn。校验候选快照仍有效后，以 canonical fingerprint 变化推进 revision，再只把
`revision > presentedRevision` 的未呈现变化加入 prompt。投影开始时冻结 `includedRevision`，最终正文必须绑定该快照；异步查询期间 revision
变化时必须重读或保留待核对，不能读取最新 revision 给旧正文补标签。item 清理后同 key 重建也必须分配严格更大
的 revision/epoch，不能复用已确认身份。

caller invocation 成功 completed 后，pending/open item 只把 `presentedRevision` 推进到 `includedRevision`，item
继续保留但未变化时不再重复注入；terminal/withdrawn 仅在 current revision 仍匹配时 compare-and-clear。若 prompt
已包含 C removed@rev2，而完成前 C 又被重新加入为 rev3，旧 invocation 只能确认 rev2，不能清掉 rev3。预算裁剪、
prompt 建成后的新 revision、失败或取消都不确认。

这份 view 是可丢弃的客户端运行时派生状态，不持久化，不改变 source message 或 `dispatchRefs` 的既有语义，也
不成为第四本账；Queue 仍是 pending truth，History 仍是 actual result truth。它的生命周期天然由“入口追加/更新
revision → caller 成功观察 terminal/withdrawn revision 后清理 → 新 source 或新 mutation 再追加”闭合。

runtime restart 后不自动重建这份进程内观察集合，也不扫描 History。actual result 仍可从 canonical History
查询；旧 runtime 独有的 firstAddedBy、Steer 增删说明与 presentedRevision 不保证恢复。每个 caller scope 在下一次自然 invocation
获得一条固定大小的 `process_start` 说明：当前 observation 只覆盖本进程登记的 dispatch，更早结果仍可按需从
canonical History 读取。说明不推断旧状态、不创建 Queue work、不清理当前指针；只有实际进入最终 prompt 且
caller 成功 completed 后才确认，失败或取消后重试，同一 process generation 成功交付后不重复。多 worker/跨节点
部署若要自动观察跨进程结果，必须另行建立可重建查询或持久交付证据，不能把当前进程缓存升级为第四本账。

## 当前结果

- 持久 `QueueLedgerEntry` 一条 source 一行；`targets[]` 与作者意图只覆盖尚待投递成员，不保存执行／终态回执。
- 入口不再维护平行的追加、等待或恢复编排；Message＋Queue 原子准入、exact claim、commit、restore 与必要拒收补偿仍保留。
- 自动追加与新回合共享同目标顺序；准备中的 exact 父执行在 ready 后重新通知 drain。native ACK 只占对应 target，不阻塞无关成员。
- 读取回执与 provider presentation 不成为 Queue membership 或第二次 admission 条件。

## 迁移

Redis Queue schema v2 在每个 thread 首次访问时原子升级：

- v1 `queued` 与遗留短 `claimed` 行按 `sourceRecordId` 合并为一个 v2 entry，保留最早顺序、pending targets 与逐目标作者意图；
- v1 `processing/terminal` 不重新入队，避免把已经 admission/终局的工作复活；
- `order` 与 `messageId → entryId` 索引在同一 CAS 脚本中重建；并发写导致快照变化时重读重试，不能在半迁移状态继续运行。

## 一致性代价

`deliveryStatus` 与队列条目状态分处两地，但 `deliveryStatus` 只有 3 态且**单调**（queued → delivered/canceled），出队时一次写回即可，不需要持续同步。

---

## 身份与兼容读取

新 Queue entry 的 id 由持久 source identity 确定性派生，不为每个 target 分配独立身份。`owner` 使用 user/system 判别 union；消息作者的 `from` 是独立的 user/agent/external/system union，存储 tenant/userId 不冒充作者。

历史 Message 的 `from` 可以缺失；`messageFrom` 在唯一读取边界按 legacy source/userId/catId/origin 推导。新 Message 必须携带 `from`，不为强化类型全量回写历史数据。`queueOwner` 集中处理旧进程内调用形状，持久行仍验证明确 owner。

scheduler source 使用 `{kind:'system', service:'scheduler'}`，存储 userId 与 Queue owner 使用已验证的 trigger owner。各 producer 通过共同 send 提交 envelope；旧 `ConnectorInvokeTrigger` 和 producer 自行推进的调用链已退役。

共同准入保存显式意图或 thread/global/product 默认偏好与 exact parent。相同 ID 重放复用已提交的目标和策略，偏好后改只作用于新消息；原 envelope 不一致仍冲突。Lua/内存转换保持空数组形状，不把无目标数组编码为对象。
