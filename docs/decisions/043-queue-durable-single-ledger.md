---
decision_id: ADR-043
related_features: [F117, F039, F047, F122, F175, F254, F264]
topics: [queue, delivery, lifecycle, persistence, architecture]
doc_kind: decision
created: 2026-09-02
---

# ADR-043: 消息队列 = 独立持久化的有序工单账本

> **Status**: implemented locally; carrier/replay acceptance follow-up under review | **Decider**: co-creator | **Analysis**: 布偶猫(opus) | **Implementation**: 缅因猫/砚砚 | **Priority**: P1
> **Supersedes (设计层)**: F039 / F122 / F175 / F047 中关于队列状态与 Steer 预留的描述

## 背景

F117 对 A2A 消息投递做了完整重构。收尾阶段的实读审计发现：这个在 RFC 中被定义为「持久化的、有序的消息队列」的组件，实际实现是 **≈15,690 行**，其中 `QueueProcessor.ts` 单文件 **7,004 行**（项目硬上限 350 行的 20 倍）。

## 根因（实读证据）

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

那 15,690 行里的绝大部分——CAS、`-3` lifecycle 冲突码、reconcile、rollback、`restoreDurableEntry`、startup reconciler——**都是维持这两份一致的机器**。

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

- **source message**：内容、结构化 `from`、公开时间线身份；
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

实际 dispatch 跨越 Queue 与 History 两个 owner，提交顺序固定为：

1. 创建/确认 response lifecycle，并把真实 `dispatchRef(targetId, responseMessageId, dispatchedAt)` 写入 History；
2. 从 Queue Entry 的 `targets[]` 删除该 target；
3. 若第 2 步遇到进程故障，重放先 join History，发现 target 已 dispatched 后只做幂等清理，绝不再次唤起。

这个 join 以 exact `sourceRecordId × targetCatId` 为键，并在 Memory/Redis 的 lifecycle terminal + Queue
transaction 中原子判定；不能先做一次易失 read，再凭旧快照 enqueue。A2A、connector 与恢复路径重放一个
已消费 source 时，只允许清理残留 Queue target。multi-mention 也必须先创建正文一致的真实 Agent History
source，再将该 source 与同一 `targets[]` entry 原子 admission；callback response 只是 parent lineage，不能
让它的 id 指向另一段只存在于 Queue 的 synthetic 正文。

因此 all-or-none 只约束**初始 admission**，不约束 provider start。一个 target 投递或启动失败，不回滚已经被 sibling 接受的投递；每个 response bubble 独立终局。

Redis `order` 只索引当前待处理 entry；`messageId → entryId` 只为定位尚待投递的 source，不承担历史 receipt 查询。History 分页与头像投影只读 Message lifecycle。

### D5 — Steer 以实时 pending/dispatched join 为准

Steer 的短 claim 保护“一条 source entry + 本次选择的 pending targets”在跨 I/O cutover 期间不被普通
drain 并发改写。它仍只是 Queue mutation fence，不把 source entry 升格为 processing，也不保存替补 run
的终局证据。中断当前回复需要调用 Agent Client，因此不能塞进 Redis Lua；中断或 admission 前失败时，
claim 按原位置恢复。某 target 一旦完成实际 dispatch，就写 History `dispatchRef` 并从 pending
`targets[]` 删除，之后由 response lifecycle 独立收敛。

消息默认分发与显式 Steer 是两层：默认设置只提供「排队等待」(`next_work`) 与「立即发送，引导回复」
(`continue_current`)；产品默认是「排队等待」，用户可以在全局、thread 或单次作用域显式覆盖。Steer modal
固定提供「立即发送，引导回复」与「立即发送，中断回复」。前者只在该成员的静态 client capability 支持
exact active-turn append、且存在 exact current reply 时可选；能力由服务端随
成员信息逐成员投影，前端不得硬编码或从本地活跃态猜测。不支持时 modal 原位说明「当前成员不支持追加消息
引导回复」；默认 `continue_current` 则诚实保留为 `next_work`，不自动中断。没有 current reply 时也没有可引导
对象，仍由普通 FIFO drain 处理。

targetless input 使用与普通 drain 相同的 fallback resolver；没有显式目标的用户/connector source 不会仅因进入存储就提前离开 Queue。真正选定并投递 target 后，才追加 History dispatchRef 并 materialize source。

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

目标一旦实际 dispatch，就从 pending `targets[]` 离开。`handled / failed / interrupted / canceled` 属于 response lifecycle，不回写 Queue；source withdrawal 则在 source lifecycle 写成 canceled 后删除尚待投递的整条 Queue Entry。

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

> 来源：co-creator 2026-09-03 worktree 验收决策（thread `thread_msr51149hym0i79f`）。取代 F220 Phase 3「force-reset 逃生口」作为用户概念的地位。

用户只有两种状态（在运行 / 未运行）和一种动作（停止：单只猫 / 全部）。**停止的成功判据是投影进入「未运行」**；进程是否真的退出由服务端在后台保证。用户不需要区分「正常停」与「强制重置」，也不需要理解逃生舱。

1. **「在跑」的真相 = 持久 execution/response lifecycle + 活性见证**：TurnExecution `running` 与 response lifecycle 是持久真相；Queue 的 `claimed` 只覆盖 admission 的短可回滚窗口，不能冒充执行态。tracker 槽位、`processingSlots`、session 锁只是内存缓存与活性见证，**单独不能构成 busy**。
2. **停止阶梯（服务端自动升级，用户不选机制）**：exact 活候选 → 现有取消链（abort / `terminateExact` / 释放本猫锁与槽位 / 写终态）；无活候选但目标仍投影为在跑 → 同一请求就地对账（退 pre-start 预留、running 记录置 canceled、释放孤儿锁与槽位、广播终态）并返回 `reconciled`；**对自己拥有的执行永不 409**。进程快照不完整（`ps` 失败 / owner manifest 目录损坏）时，服务端有界重试快照后仍不可用 → 走普通 dispatch terminal：该 exact execution 及其 response 行按 `failed`（reason `control_plane_unavailable`）终局，投影进入未运行，并沿 F117 Phase C「失败传播」回溯上游：源消息 dispatchRef settle 到该失败 response（`settleLifecycleResponseInputs`），猫来源按 A2A 自动报回 source 成员（由它重分发或上报），origin 来源呈现可见失败终态；pre-start 尚无 response 行时走 `delivery_failure`。重做只来自新的用户意图（INV-C7），系统不替用户重新拉起。只有持久层不可用（终态写不进去）才 503。**不做平台兼容分支**：Windows 没有 `ps`、子进程不可观测，同样落入这条 fail 分支收敛（快照不可用 = 无法确认 = failed 终局 + 失败传播）；本 ADR 唯一保留的兼容是旧 chat message 的 `from` 读取（A.5 `messageFrom`）。
3. **没有任何确认弹窗**：用户只关心运行态与终态，不需要理解「无法确认进程状态」。`ForceResetDialog` 退役；`/force-reset` 只作为服务端内部 thread 级对账实现，没有用户入口。终态行不复活（D7）保证迟到输出无法回写已终局的气泡；detached host 由 supervisor 收敛（F220 KD-8），有界。
4. **同一段对账三处复用**：启动（`StartupReconciler`）、投影读取（read-repair：running 记录 + 无 tracker + 进程快照 complete 且无 owner + 超出 pre-start 窗口 → 以 `execution_owner_lost` 终态化；快照不 complete 时不动）、停止（第 2 条）。已离开 Queue 但从未安装 provider tracker 的 pre-start attempt 超时，以 `prestart_timeout` 正常失败终局；父 InvocationRecord 只有在没有 sibling tracker / process-owner 活性见证时才随 child 终局。
5. **前端**：权威投影稳定即信；旧 socket busy 标记自愈，不再有「运行状态待确认」死角与基于卡死的强制重置入口。

历史根因：F220 Phase 2 报告（#972）已定性为「多 liveness SoT 无收敛点」；F194 读模型、TurnExecution 持久子真相与本 ADR 的账本已关闭进程内的绝大部分分叉，剩余只有基础设施故障（Redis / API 进程）一类，归 reconciler，不归用户。

## 不会简化的部分（诚实边界）

`prestartRetirement` **不消失**。窗口是 `invocationRecordStore.create` → `invocationTracker.startAll`，中间包含 routing/visibility 预检、前缀吸收、session 准入。这个「已经 admission、但 tracker 里还没有」的空档由 **I/O 本身**造成，不是 Queue 持久状态，进不了 Lua。

它会从 Steer 专用标记收敛为同一次原子 Queue claim 的通用 `retiringGroupId`，用于关联一起进入 pre-start 窗口的 FIFO prefix entries；它不表示多目标 fan-out。

## 顺带删除的死码

1. **`PREEMPT_PENDING_PRESTART` 分支不可达**：`preemptSteerTarget` 三个成功出口（queue.ts:442/451/472）全部 `deferred: false` → `:902` 与 `:1062` 的 `if (preemption.deferred)` 恒假。
2. **`freshnessRequiredFrontierMessageId`**：见 D6。

## 预期结果

- 持久 `QueueLedgerEntry` 一条 source 一行；`targets[]` 与 `authorIntentByTarget` 只覆盖尚待投递成员，`delivery` 不保存执行/终态回执
- 删除模块：`QueuedMessageCustodyStartupReconciler` + `StartupQueueEntry` + `CarrierProjection`（436 行）、`queue-entry-settlement.ts`（49 行）、`convergeZombieQueue.ts`（87 行）、`exactSteerBatch` 预留 Map 与三段式 API，以及依赖 Message custody 复活 terminal attempt 的 Gate 5 retry bridge
- `QueueProcessor` 中的同步/CAS/rollback/restore 大部分消失

## 迁移

Redis Queue schema v2 在每个 thread 首次访问时原子升级：

- v1 `queued` 与遗留短 `claimed` 行按 `sourceRecordId` 合并为一个 v2 entry，保留最早顺序、pending targets 与逐目标作者意图；
- v1 `processing/terminal` 不重新入队，避免把已经 admission/终局的工作复活；
- `order` 与 `messageId → entryId` 索引在同一 CAS 脚本中重建；并发写导致快照变化时重读重试，不能在半迁移状态继续运行。

## 一致性代价

`deliveryStatus` 与队列条目状态分处两地，但 `deliveryStatus` 只有 3 态且**单调**（queued → delivered/canceled），出队时一次写回即可，不需要持续同步。

---

## 附录 A：设计评审修订（2026-09-02，co-creator 逐条 push back）

RFC 是「没看代码、不拘泥实现的理论目标」，因此不能照搬。以下为逐条评估结论。

### A.1 字段数不是目标函数：43 个扁平/镜像字段 → 约 20 个顶层字段 + 3 个职责命名空间

实现后复核确认：RFC 的 11 字段是概念模型，不应被当作 TypeScript interface 的行数 KPI。`QueueLedgerEntry` 把载荷与运行参数放入 `payload` / `execution`，把 pending-only 作者意图放入 `delivery`。真正必须消灭的是重复 lifecycle 真相，而不是为了数字把仍有运行语义的字段藏起来。

**RFC 漏掉的 3 条运行时约束（必须保留）**

| 字段 | 为什么 RFC 没看到 |
|---|---|
| `owner` | RFC 引入 `from` 治好了 author 一侧，但 grep `ownerUserId` / `owner principal` / `owner scope` 在 RFC 中**零命中**——它想的是「谁发的」，没想「这是谁的队列」 |
| `status` 的 `claimed` 态 | RFC 认为「仍在 Queue 就表示尚未 dispatch」，隐含出队即离开。但 Steer 必须先 `cancel` 正在跑的 invocation，**cancel 是 I/O 进不了 Lua**，失败必须原位回滚 → 需要可回滚的中间态 |
| `claimedAt` | 出队到起跑之间存在异步窗口；进程内的重复工作/活跃性判定用它识别 stale claim。当前不做进程内 sweep：重启恢复会无条件把遗留 `claimed` 行恢复为 `queued`，因此这是观测与 restart-only 恢复证据，不是后台回收租约 |

**RFC 建议但评估后不采纳的 2 条**

- **freshness 4 字段搬进 payload metadata**：RFC 原意是「不要扩张 `from` 或 lifecycle `kind`」。这 4 个是独立顶层字段，未扩张二者，不违反该条。而 `QueueProcessor.ts:4951/5163` 起跑时直接读取，搬家只换访问路径、读法不变——纯形式主义，收益 0、需改 payload schema。
- **删 `sourceCategory`**：RFC 反对的是「把 ci/review/a2a 当成与 user/Agent 并列的**身份类型**」。它当前不是 `from` 的一部分，只是独立来源标记，F175 用于视觉分组。RFC 反对的形态与现状不是一回事。

### A.2 `owner` 必须是判别 union，不是裸 id

co-creator 在评审中发现的 RFC 空缺。裸 `userId` 已被塞入伪用户命名空间：

```ts
export const SYSTEM_USER_IDS: ReadonlySet<string> = new Set(['scheduler', 'system']);  // visibility.ts:13
return SYSTEM_USER_IDS.has(msg.userId) && (msg.catId === 'system' || msg.catId === null);  // :23
```

加上 25 处硬编码 `userId: 'system'`。**这正是 `from` 判别 union 要治的病，只治了 author 一侧。**

```ts
type QueueOwner =
  | { kind: 'user'; userId: string }
  | { kind: 'system'; service: string }   // 复用 RFC `from` 已有的 system 变体形状
```

职责分离：`from` 回答「谁发的」，`owner` 回答「这条工单在谁的 scope」。两者正交，不得互相代替（否则违反 L1）。

收益：删除 `SYSTEM_USER_IDS` 集合与 `visibility.ts:23` 的字符串反推；消除「真实用户恰好叫 system」的命名空间碰撞。

### A.3 entry.id 只由来源持久 id 确定性派生，持久行不再保存 `idempotencyKey` / `continuationKey`

现状：`id: randomUUID()`（`InvocationQueue.ts:449`）与来源持久 id 完全脱钩，因此另开 `idempotencyKey` 字段 + `:411-414` 线性扫描去重。

三种 kind 都有天然确定性 id：

| kind | 确定性 id | 现状 |
|---|---|---|
| `conversation_input` | `sourceRecordId` | 统一采用 |
| `message_wake` | `messageId` 对应的 source identity | 统一采用 |
| `private_input` | 生产者持久 id（`action:{leaseId}:{gen}:{cat}`、closure/supplement id） | **已在用**，但塞进了 `idempotencyKey` |

**决策**：推广确定性 id 到所有来源：`queueEntryId(sourceId)` 只由来源持久 id 派生；target 是行内 pending set，不参与主键。`idempotencyKey` / `continuationKey` 仍可作为生产者命令输入来确定 `sourceId`，但不再进入持久 Queue row。去重从应用层线性扫描降级为存储层主键冲突。

### A.4 §6.4 前缀批处理拼正文违反 RFC（真 bug）

RFC §6.4 写「一次 dispatch，**不合并消息**」，而 `QueueProcessor.ts:5391` 在做 `content = content + '\n' + be.content`。`mergedMessageIds` 随之删除，但必须同时修正 §6.4 实现：一次 dispatch 可取多条 entry，但每条消息的身份、正文与顺序保持独立。

### A.5 author 身份统一由 resolver 读取；存储 owner userId 不冒充 author

**初版结论「本轮只治内核内 188 个签名、内核外 734 个不动」已作废——分母用错了。**

`packages/api/src` 共 922 个 `userId: string` 签名，但其中绝大多数是**真实用户 id，本来就该是 string**，改成 union 反而引入错误。真实缺陷面只有伪用户污染那条路径：

| 缺陷面 | 数量 |
|---|---:|
| 硬编码 `userId: 'system' / 'scheduler'` 写入点 | 25 |
| `SYSTEM_USER_IDS` / `isSystemUserMessage` 消费点 | 56 |
| 裸 userId 与 `'system' / 'scheduler'` 比较 | 28 |
| **合计** | **≈ 109** |

上述统计混合了两种不同语义：消息作者身份与存储 owner/tenant/thread ownership。后者本来就是 user id，不能机械替换成 `MessageFrom`。

**前置条件**：这些站点多数已是双分支形态——

```ts
msg.from ? msg.from.kind === 'system' : msg.userId === 'scheduler' && msg.catId === null
//         ↑ 新路径（首选）              ↑ legacy fallback
```

`from` 已是首选路径，裸比较只是 legacy 记录兜底。但 `MessageStore.ts:228` 为 `from?: MessageFrom`（可选），且全仓无通用回填（仅 `requireCanonicalMessageFrom` 会抛错，只用于 fanout）。因此直接删 legacy 分支会误判历史记录。

**方案（co-creator 提出，取代初版「回填 → 必填 → 删分支」三步）：单一 resolver，不动数据。**

```ts
from?: MessageFrom;              // 兼容旧 Redis row，读模型暂时可选
messageFrom(msg): MessageFrom;   // 作者身份的统一访问路径，返回必填 union
queueOwner(entry): QueueOwner;   // Queue scope 的统一访问路径
```

`messageFrom` 内部：有 `from` 直接返回；缺失则按 legacy 字段（`source` / `userId` / `catId` / `origin`）推导并封装。推导规则不是新发明——是把历史读取逻辑收进一处：

- `source?.connector` → `{ kind: 'external', connectorId }`
- `SYSTEM_USER_IDS.has(userId) && (catId === 'system' || catId === null)` → `{ kind: 'system', service }`（依据 `visibility.ts:23/50`、`:272` 的 `origin === 'briefing'`）
- `catId` 非空 → `{ kind: 'agent', catId }`
- 其余 → `{ kind: 'user', userId }`

新 Message 写入必须携带 `from`；author 判定统一调用 `messageFrom`。`SYSTEM_USER_IDS` 仅保留在 thread/tenant owner 的兼容边界，不再用于反推消息作者。同样形状套用于 Queue scope：持久行必须带 `owner` 判别 union，`queueOwner` 只为旧的进程内调用形状提供集中 fallback。

**为何优于初版三步**：初版试图在**存储层**达成不变量（全量回写 message），本方案在**访问层**达成。类型强度相同（调用方拿到的永远是必填 union），但没有不可逆写操作的风险；存量数据自然老化，新写入均带 `fromRaw`，将来 fallback 分支自然成为死码，届时删除为零风险。

**关于门禁**：不新增字符串扫描 gate。新写边界要求 `from`，持久 Queue row 要求 `owner: QueueOwner`，Redis hydrate 再做运行时 shape 校验；兼容只留在 resolver。存储 owner 的 `userId` 仍是合法且必要的，不应被 lint 误报。

**Scheduled trigger 契约（R4 裁定，sol adjudication / Fable 三审）**：scheduler 模板（reminder / web-digest browser path）写出的 trigger message，`from = { kind: 'system', service: 'scheduler' }` 表达作者身份；存储 `userId` 必须是**已验证的 trigger owner（`triggerUserId`）**，Queue owner 与之一致。`userId: 'scheduler'` 会在 canonical ingress fence（`ConnectorInvokeTrigger` 的 source owner vs queue owner 强校验）处被拒，不会进入 ledger。行为回归由 `test/scheduler/scheduled-trigger-owner-fence.test.js`（真实 template + createDeliverFn + ConnectorInvokeTrigger 组合）钉住。
