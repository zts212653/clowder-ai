---
feature_ids: [F297]
related_features: [F069, F081, F095, F164, F183, F194, F277, F295, F304]
topics: [sidebar, projection, state-convergence, write-path, authority, thread-list]
doc_kind: spec
created: 2026-08-17
description: "把 Sidebar 收敛为服务端权威快照、前端单一 canonical writer 与非持久化命令 overlay，终结 cache/socket/局部 writer 反复覆盖真相。"
description_source: human
description_author: opus5
description_updated_at: 2026-08-17T01:20:00-07:00
tips_exempt: "内部状态收敛与写入面重构；不新增用户可操作的独立能力入口，用户可见变化是既有 Sidebar 状态终于正确。"
---

# F297: Sidebar Projection Convergence — 服务端权威快照，前端单一写入

> **Status**: done | **Completed**: 2026-08-21 | **Evolved from**: F081 | **Renewed CloseGate**: PASS by 小团团·Maine Coon (@codex-terra)，P1 deferred = 0（`0001787371427031-000209-64cae1d3`）；prior Luna verdict remains superseded by the working-order runtime counterexample | **Phase D author**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Phase D reviewer**: 小团团·Maine Coon (@codex-terra, GPT-5.6 Terra) | **Priority**: P1
>
> **operator kickoff**: `0001786949883267-000007-1c4fc745`（“回到数学之美和第一性原理”“可以立项一下”“你主导，他辅助 review”；并授权 F081 AC-B2 处置由 owner 自决）+ `0001786950276392-000031-c800463d`（“立项直接 commit push，不需要提 PR，Maine Coon re 出来的问题当场改”）。
>
> **Phase C operator authorization**: `0001787125999181-000083-03fb3f46`（Phase C 改由 @codex-sol 主写；exact-HEAD reviewer 优先 @kimi；Phase D / 合入后 alpha acceptance 另行闭环）。
>
> Ownership boundary：独立窄 Sidebar projection store/DTO、刷新/缓存边界与用户侧消费归 `thread-navigation`。运行态输入继续由 `dispatch` 的 F295 active-execution projection 与 F194 liveness classifier 持有；F297 只组合并切断 Sidebar 的 legacy read，不复制或全局禁写其生命周期状态。Map delta: **updated in this AC-A3 review**。

Architecture cell: thread-navigation # Phase C authority-boundary update

## Why

### operator experience

2026-03-09（F081 起因，逐字记录于该 feature 开头）：

> “别让operator发现什么你们修什么？修了一个另一个又出现问？”

2026-08-17（本 feature 起因）：

> “这个问题 n 次了 每次都没完全修复清楚，你要不也来一次根因诊断，而不是每次都在补锅”

**同一个抱怨，隔了五个多月。** 这是同一病灶反复发作，不应继续当成互不相关的 UI bug。

### 症状史（可核查）

- 11 个关联 PR 已核对为 merged：#1538、#1640、#3325、#3365、#3459、#3582、#3588、#3653、#3665、#3687、#3690。
- 回归链实证：**#3687 → #3690**（前者在 reorder effect 中做首行 reveal，后者因手动滚动反向跳动移除这次二次规范化）。
- 最新一例：#3665 只 single-flight 服务器刷新，没有约束晚到 IndexedDB 读；旧的 3-thread cache 可在 canonical refresh 后覆盖完整列表，F5 才自愈。
- #3582 的 bug report 已写下“canonical 对账完成后，迟到 IDB snapshot 不得覆盖”的状态转移，但该 PR 的测试没有构造“cache 在 canonical 完成后才 resolve”的确定性顺序；所以这是**记录过但未被判别测试锁住**的不变量，不是“已有测试后来被违反”。

值得单列的观察：#3459 / #3653 / #3665 / #3365 没有各自 bug report。跨修复继承的不变量越薄，下一位作者越容易只看到局部 writer。

## Current State / 现状基线

### Sidebar 自己的状态切片没有 authority boundary

当前 Sidebar 同时从以下来源拼装一行：

- `chatStore.threads`：ThreadStore 元数据的前端副本；cache、HTTP、socket 和本地操作都能替换或 patch。
- `threadStates[threadId].unreadCount/hasUserMention`：F069 服务端 read cursor 的前端投影，同时又被本地消息事件增量更新。
- `threadStates[threadId]` 中的 liveness 子字段：socket、queue hydration、terminal selector、IDB first paint 都能写或影响展示。
- pin / favorite / rename / label 等用户命令的 optimistic patch。

`threadStates` 还承载 messages、intent、target cats 等非 Sidebar 状态。F297 **不拥有、也不迁移整个 `threadStates`**；立项时的“60+ writer”是 wider thread-runtime census，不能直接当 Sidebar writer 数。AC-A3 必须从实际 render/sort 读链路反推 projection boundary，并把赋值 primitive 与 caller/trigger 分开。

### 既有 read models 已经覆盖大半真相，但没有被组合

- F069 已有批量 unread read model。
- F194 已有单 thread 的 canonical liveness classifier，但其依赖是 per-thread `listRunningByThread/getDrafts/getActiveSlots`，不能循环 1760 个 thread 冒充批量接口。
- F295 已有 execution-scoped server projection、精确 cancel fence 与前端 snapshot store；当前 project-wide endpoint 仍线性遍历 project threads，每 4 秒刷新。F297 应**抽取并复用这条 server composition service**，而不是在 `thread-navigation` 再写一份 4-store liveness 算法。
- ThreadStore 的 `participantActivity.lastResponseHealthy` 只证明“历史上有猫回过话”，**不是 invocation 终态证据**。把它当 done/error 正是 2026-08-19 批量假绿 ✓ 回归的根因；Sidebar 只能从 InvocationRecord lifecycle 取真实 terminal witness。
- F164 的 IndexedDB 是 first-paint cache，不是 authority。当前代码没有统一规则限制它只能在本轮首次 canonical apply 之前生效。

### 写入普查是迁移输入，不是定理

2026-08-17 lexical census 给出的 wider baseline 是：`chatStore.threads` 约 20 个调用点、`threadStates` 约 40+ 调用点，另有 7 个局部仲裁机制。该数字说明需要机器化 source-map，但它混有消息/runtime writer。

**AC-A3 已于 2026-08-17 产出并经 review 修正（见「Sidebar render-input source-map」节）。W1–W57 是包含 mutation primitive、caller/trigger 与 alternate read 的迁移 path nodes，不再发布为“57 个 writer”。稳定 KPI 是新 `sidebarProjectionStore.rows` 的 canonical writer 数 = 1。**

## 第一性原理：把论证放回正确适用域

Sidebar 是多个服务端 owner truth 的读投影。对一个**latest-value、非交换、允许完整重读**的投影，常见的收敛策略有三族：

| 策略族 | 需要的契约 | 当前 Sidebar |
|---|---|---|
| 有序应用 | canonical sequencer / revision；所有 state-bearing 更新按同一顺序应用 | ✗ 各 writer 没有共同顺序 |
| 可交换 merge | 更新有明确的幂等、结合、交换代数（例如 CRDT/lattice） | ✗ “latest replacement” 与 optimistic rollback 不交换 |
| 权威重算 | 边缘事件只声明 invalidation；客户端从同一权威边界完整重读 | ✗ 事件 payload 仍直接 patch 本地副本 |

这张表是**本系统的设计分类，不是对所有分布式系统的穷尽数学定理**。多 writer 也可以被同一 sequencer 序列化；理论上，覆盖所有 writer pair 的完整仲裁同样可能正确。

F297 的可证明结论是更窄的一条：

> 当前 writer 集既没有共同顺序、也没有 merge algebra、也没有统一重算边界；因此现有 7 个 pairwise guard **不能建立**全局收敛证明。继续增加 writer 时，逐对 guard 的证明面随组合增长，且任何未登记 writer 都会使证明失效。

所以不是“坐标系里绝对无解”，而是**当前方案没有一个有界、可继承的 correctness boundary**。F297 选择权威重算，把 correctness 从“记住所有 writer pair”降为“只有一个 canonical apply 能替换 Sidebar snapshot”。

### F183 类比的边界

F183 的 `lastSeq/lastSeqEpoch` 证明了一个可复用原则：**ordering authority 在服务端，客户端发现不连续时回到权威重读**。但 message 流是单一有序事件流；Sidebar 是多源聚合快照。F297 只复用“不要让 edge event 成为状态真相”的原则，**不复制 F183 的 seq/epoch 协议**。

首期 Sidebar event 不携带 delta，只触发重读，所以 correctness 不依赖 gap-by-gap replay，也不要求服务端 monotonic version。可选的 opaque `snapshotId/ETag` 只能用于缓存去重和 conditional GET，不能替代本轮 client request generation。

## What

### 目标形状

| | 现状 | F297 |
|---|---|---|
| Sidebar canonical writer | cache / HTTP / socket / local patch 多入口 | **1 个**：`applySidebarSnapshot` |
| optimistic UX | 直接 patch canonical store，再靠 rollback 猜顺序 | 非持久化 `pendingThreadCommands` overlay |
| edge event | 携带 payload 并直接更新状态 | 只调用 `invalidateSidebarProjection` |
| cache | 任意时刻可回写 | 每轮 canonical apply 前的 bootstrap-only 输入 |
| liveness composition | Sidebar/browser 自己拼 | 复用 F295/F194 server service，按 sparse active candidates 组合 |
| structural proof | 手写 inventory + 示例测试 | projection store 的类型/模块/读写边界 guard + fixture mutation canary |

### Canonical projection contract

服务端返回一个完整的 `SidebarSnapshot`：

- thread identity / title / project / pin / favorite / labels / participants；
- unread count / mention；
- per-thread Sidebar presence：active execution（来自 F295/F194）优先；done/error 只来自 InvocationRecord 的真实 terminal transition，并仅在 unread/mention 表明“待用户注意”时展示；
- 可选 opaque `snapshotId/ETag`，仅用于 dedup/cache validation；
- 不包含 messages、Chat viewport、intent、target cats、tab/collapse/scroll 等非 Sidebar 状态。

客户端新增独立、窄类型的 `sidebarProjectionStore`，有且只有一个 canonical replacement：`applySidebarSnapshot(snapshot, requestGeneration)`。它必须同时更新内存与 Sidebar 专用 IDB snapshot；旧 `chatStore.threads/threadStates` 继续服务各自 owner，但不再是 Sidebar 的替代读源。

### OQ-1 决议：按 active candidate 稀疏对账，不按 thread 全表乘四个 store

1. 把 F295 route-local `buildActiveExecutionList` 抽成 `dispatch` owner 的可复用 service；F297 只 join 结果。
2. candidate thread 集合来自 canonical owner 的**可重建二级索引**：running InvocationRecord、active Tracker slot、running child execution、running managed command。缺索引的 store 可增加 user-scoped running index，但索引不拥有 lifecycle，必须可由 owner truth rebuild/校验。
3. 只对 candidate threads 调 F194 classifier；inactive thread 不做 Draft/Tracker/TurnExecution 四路读取。
4. Thread metadata / unread 使用 batch；terminal InvocationRecord pointer 使用 MGET + pipeline；禁止 per-thread sequential round trip。
5. 结构预算：服务器工作量 `O(T + A)`（T 是本来就要返回的 thread rows；A 是 active candidate threads），liveness reconciliation `O(A)`；Redis round trips 是常数个 pipeline stage，不是 `O(T)`。用 1760 threads / 300 pinned / 20 active fixture 锁调用次数；真实延迟属于运行健康，另记 metrics/traces，不拿任意毫秒阈值冒充设计证明。

### OQ-2 决议：首期只有 invalidation + full snapshot，不做 delta

- 复用既有 user-room `thread_updated`、`queue_updated`、read/delivery 等事件作为 invalidation trigger；payload 不直接写 Sidebar canonical store。
- refresh single-flight 必须带 **dirty-while-flight trailing refresh**：请求在飞时又收到 invalidation，当前请求完成后至少再拉一次，保证最后一次变更后有一次观察。
- mount、online、visibility regain、Socket.IO reconnect 都触发 refresh；它们是丢事件后的恢复边界。
- 首期不定义 `applyDelta`。如果未来真实 metrics 证明 full snapshot 带宽不可接受，delta 必须另立 contract：统一 sequencer、base snapshot identity、gap recovery 与 replay parity；不能作为本 feature 的“顺便优化”。

### OQ-3 决议：optimistic command 是 render overlay，不是 canonical writer

pin / favorite / rename / label 命令进入非持久化 `pendingThreadCommands`：

1. row 以 `render(snapshotRow, pendingCommandsForRow)` 呈现预期值；不修改 canonical snapshot，也不写 IDB。
2. command 成功只触发 invalidation；直到新 snapshot 观察到预期值后 retire overlay。
3. command 失败移除 overlay 并显示错误；timeout 触发一次权威 refresh，不能用闭包 `prev` 回滚 canonical store。
4. overlay 只允许声明 field-scoped command intent，不携带整行/整表 replacement；tab、collapse、scroll 等纯 UI state 继续独立存在，不计入 Sidebar canonical writer。

## Sidebar render-input source-map (AC-A3)

> 初始普查生成于 2026-08-17，code HEAD `fc20d19de`；review 在 `9b282cf9e` 复核。
> 本节是迁移检查单，不是长期真相源；Phase C 的类型/模块边界与 guard 才是长期执行者。

### 先分三层，禁止再用一个“Sidebar-owned field”桶混装

**A. 目标 canonical DTO：`SidebarSnapshotRow`**

| | 字段 | 呈现语义 |
|---|---|---|
| C0 | row membership + `id` | 列表成员、React key、导航、搜索、default/system 判定；只能由完整 snapshot 增删 |
| C1 | `title` | 标题、搜索、tooltip |
| C2 | `participants` | 参与猫头像 |
| C3 | `pinned` / `favorited` | tab、排序、图标；`pinnedAt/favoritedAt` 当前不参与 Sidebar 呈现，不进 DTO |
| C4 | `labels` | filter、label dots、整理器 |
| C5 | `preferredCats` | 默认猫提示 |
| C6 | `projectPath` | 搜索、分组、项目排序 |
| C7 | `lastActiveAt` | thread/message recency 与排序；客户端不再 bump；working elapsed 不得用无标签 C7 冒充 |
| C8 | `systemKind` + presentation-safe hub discriminator | system tab / badge；不得把完整 `connectorHubState` 当 Sidebar DTO |
| C9 | `unreadCount` / `hasUserMention` | badge、tab count、排序 |
| C10 | presentation-ready `presence` | `working` 来自 canonical active classifier，并为执行中文案提供 owner-truth `activeSince`（缺失时只显示“执行中”）；`done/error` 来自 InvocationRecord terminal witness 且受 unread/mention attention gate 约束；不暴露 raw `activeInvocations/catInvocations` 给 render 再仲裁 |

**B. 显式 local decoration（可改变一行，但不是 canonical truth）**

- `pendingThreadCommands`：field-scoped optimistic overlay，不持久化、不回写 snapshot。
- `hasDraft`：composer-owned local decoration；Sidebar 只通过一个命名 adapter 读取，不把它塞进 snapshot。
- `currentThreadId`、search/label filter、tab、collapse、scroll、project pin/name：导航或视图状态，明确不进 DTO。

**C. 当前 legacy alternate sources（要从 Sidebar 读链路断开，不等于全局删除 writer）**

- `chatStore.threads`：仍被 ChatInput、ThreadIndicator、RightStatusPanel、MiniThreadSidebar 等非本消费面使用；F297 新建窄
  `sidebarProjectionStore`，不把全局 `chatStore.threads` 冒充新的单写真相。
- `threadStates[*].unreadCount/hasUserMention`：Sidebar 改读 C9；旧字段可按其 owner 的迁移节奏存活。
- `threadStates[*].lastActivity`：Chat runtime 可以继续 stamp；只删除 `mergeLiveActivityIntoThreads` 这条 Sidebar override。
- `threadStates[*]` raw liveness：`projectTerminalLiveness` 与 runtime actions 继续归 `dispatch` / Chat runtime；Sidebar 改读 C10。
- `reconcileActiveThreadOrder(...threadStates.hasActiveInvocation...)`：初始普查漏掉的第二条 presence 读路径；必须与
  `useThreadLiveness` 一起断开，不能只修状态图标却继续让 legacy presence 改变排序。

### Census 口径修正

初始 W1–W57 清单有价值，但 **57 不是“store-level writer 数”**：它混合了 mutation primitive 与 caller/trigger。
例如 `updateThreadPin` 是赋值 primitive，`pinToggle`、reconcile、`ProposalCard` 是三条 fan-in path；四者不能再被算成
四个 writer。稳定、可验证的 KPI 只有一个：目标 `sidebarProjectionStore.rows` 的 canonical writer 数 = **1**。

迁移期用三种 disposition：

| legacy path | disposition |
|---|---|
| Sidebar 的 cache / HTTP / socket / command 对 `chatStore.threads` 的写入 | **DETACH**：snapshot 进新 store；事件 invalidate；命令进 overlay |
| unread 的本地 delta / rollback | **DETACH**：Sidebar 改读 C9；read command 用 overlay + snapshot confirm |
| presence actions、timer、IDB hydration、`projectTerminalLiveness` | **KEEP runtime / DETACH Sidebar**：不改 dispatch 语义，只移除 Sidebar 读依赖 |
| 21 处 `lastActivity` stamp | **KEEP runtime / DETACH Sidebar**：删除 read-side merge，不跨 owner 批量删 writer |
| `hasDraft` | **KEEP LOCAL**：命名 adapter 是唯一允许的 legacy decoration |
| `useChatStore.setState({threads})` | 只有仍能影响 Sidebar 时才违规；Sidebar 与新 store 解耦后，不把全仓 legacy `threads` 写入误杀 |

### Guard 形状（AC-C3/C4）

guard 保护**新边界**，不把 57 条旧路径永久编码进规则：

1. **Write boundary**：只有 `applySidebarSnapshot(snapshot, requestGeneration)` 能替换
   `sidebarProjectionStore.rows`；overlay actions 不能写 rows。
2. **Persistence boundary**：`saveSidebarSnapshot` 仅能由 canonical apply 调用；cache load 只能走 bootstrap gate。
3. **Read boundary**：`ThreadSidebar` render tree / `thread-utils` 不能读取 `chatStore.threads`、unread、`lastActivity`
   或 raw runtime liveness；唯一 legacy 例外是命名的 draft-decoration adapter。
4. **DTO boundary**：`SidebarSnapshotRow` 不含 `pinnedAt/favoritedAt`、完整 `connectorHubState`、
   `activeInvocations/catInvocations`、messages/queue/intent/viewport。

AC-C4 fixtures 必须同时证明：合法 Chat runtime fixture 写 `messages + catStatuses` 仍 GREEN；非法 fixture
绕过 `applySidebarSnapshot` 写 rows 时 RED；另一个非法 fixture 在 Sidebar render path 读取 legacy liveness 时 RED。
原“同一对象中 messages 合法、catStatuses 非法”的 canary 已撤销——拆 store 后这两个字段都仍是合法 Chat runtime state。

### AC-D2 预判（立项时的 6 个预测 race）

| # | 预测 | source-map 判定 |
|---|---|---|
| 1 | 快照吞掉在途乐观写 | **确认在 scope** — W2 无条件整表替换，W17/W20 在途写丢失 |
| 2 | 不同字段集的全量 fetch 互相覆盖 | **结构性确认** — W2 `?view=sidebar` vs W5/W7 裸 `/api/threads` |
| 3 | `ProposalCard` pin 绕过 reconcile | **确认** — `ProposalCard.tsx:150` 直调 `updateThreadPin`，无 seq map |
| 4 | 本地超时定时器覆盖新 runtime 真相 | **确认** — `invocation-timeout-reconciliation.ts:309,364` |
| 5 | `QueuePanel` `prevQueue` 回滚 | **不在 F297 scope** — `queue` 不属 C0–C10，退回 `dispatch` owner |
| 6 | `syncThreadState` 迟到写回 | **部分在 scope** — 消息/队列部分属 Chat runtime；`syncLocalBootcampState.ts:13` 行注入与 `useChatHistory.ts:1558-1578` 迟到 IDB active 恢复属 F297 |

## User Journey

### Primary Journey: Sidebar 不再靠 F5 才恢复真相

- **Scope unit**: 一个 Sidebar snapshot generation
- **Actor**: operator
- **Entry**: 长驻页面中的 Sidebar；无需先打开目标 thread。
- **Flow**:
  1. 页面先从 IndexedDB 显示上次 snapshot；服务器 truth 到达后整体替换。
  2. 后台 thread 被 @、开始运行、完成、产生未读或被 pin/改名时，既有事件只让 Sidebar 失效并重读。
  3. 请求在飞时继续发生变化，页面完成 trailing refresh，不会让较早响应或晚到 cache 重新覆盖。
  4. 用户快速 pin/改名时先看到 pending overlay；成功后由下一份 snapshot 确认，失败则诚实撤销并提示。
  5. 断网、socket 丢事件或 runtime 重启后，online/visibility/reconnect 重新读取同一 projection；F5 前后结果一致。
- **Success evidence**: deterministic race tests + 1760-thread cost fixture + alpha 浏览器旅程；participants、working/done/error、unread 同时核对。
- **Non-goals**: message timeline/bubble merge；Chat viewport state；F277 双 thread 阅读 UX；新 lifecycle ledger；新 status enum；delta protocol。

## Acceptance Criteria

### Phase A — Design Gate

- [x] AC-A1: reviewer 已把“三条路径”收窄为本 latest-value projection 的策略分类；结论改为“现状不能建立有界收敛证明”，不再声称所有多 writer 系统数学上无解。
- [x] AC-A2: OQ-1/2/3 已收敛：F295 sparse composition；invalidation-only full snapshot；non-canonical pending-command overlay。
- [x] AC-A3: Sidebar render-input source-map 已生成并 review（见同名章节与 appendix）。目标 canonical DTO 为 C0–C10，补入 row membership/`id`；`hasDraft`、command overlay 与 navigation/view state 作为显式 local decoration。W1–W57 被重分类为 mutation primitive、caller/trigger 与 alternate read path，不再冒充 writer 数；目标 `sidebarProjectionStore.rows` writer = 1。

### Phase B — 服务端投影

- [x] AC-B1: `SidebarSnapshot` 一次返回 metadata + participants + unread/mention + lifecycle presence；working 优先，active 消失不得推断 done。**2026-08-19 纠正**：历史 participant activity 不得进 C10；terminal 只读 edge-maintained InvocationRecord pointer，旧数据不 backfill（缺证据的安全方向是 `idle`）。
- [x] AC-B2: liveness 组合抽自 F295/F194 owner service；无第二份 classifier；1760/300/20 fixture 证明 liveness 调用随 A 而非 T 增长。**闭合 2026-08-18**：composition 收口到 `active-execution-service.ts`，三 consumer 共用，`getThreadLiveInvocations` 未被复制；`f297-sparse-scale.test.js` 补齐 AC 写死的规模 fixture —— 1760 threads / 300 pinned / 20 active 下断言 **per-thread 定性调用 == 20（非 1760）**、**owner-truth 全局物化 == 1 次**（锁 R4 P1-1 的 O(A²) 回归）。刻意只锁**调用计数**这一确定契约，不设毫秒阈值——真实延迟属运行健康，另记 metrics/traces，不拿任意阈值冒充设计证明。
- [x] AC-B3: metadata/unread/terminal 走 batch/pipeline，无 per-thread sequential Redis round trip。**2026-08-19 纠正**：terminal 从 per-thread+user pointer 一次 MGET，命中 record 一次 pipeline HGETALL；删除 Sidebar 对 participant activity batch 的整条依赖。
- [x] AC-B4: RED 先行：当前 server endpoint 不能独立回答“所有 Sidebar rows 的参与猫、未读和当前/最近运行呈现”。**对账 2026-08-18**：RED 已实际观察并单独提交（`test(F297): AC-B4 RED` → `row … is missing C10 presence`），GREEN 随后落地；后续多轮又用 mutation 复验测试判别性（把被测逻辑退化后测试转红）。

#### Phase B slice 1 review 收敛（PR #3748，reviewer @codex-sol 三轮）

- **AC-B2 的语义补正**：“无第二份 classifier” 不等于“只有一条定性通道”。系统里“正在跑”有三张执行面
  （live invocation / managed command(F295) / running child(F194)），旧实现把三源都塞进**候选发现**、
  却统一交给只认识 live invocation 的 classifier **定性**，于是 managed command 与 standalone running child
  候选进来、定性落空、`presence=null` → 终态回落 → **working 被显示成 done/error**。
  收敛为 **positive working projection：谁提名，谁定性**——每张脸自己既贡献候选、也贡献 working catId。
  这仍然只有一份 liveness 算法（`getThreadLiveInvocations` 未被复制），补的是另外两个执行面的 owner truth。
- **domain-owned composition**：`resolveActiveInvocations` 与 registry 端口从 `routes/queue.ts` 迁到
  `domains/.../invocation/active-execution-service.ts`，queue / active-execution / Sidebar 三 consumer 共用；
  managed command 判别式也只剩一份（此前 route 与 candidate 各一份，漂移即产生“执行列表说在跑、Sidebar 说 done”）。
- **fail-closed 铁律**：`active` 缺席不得推断为 `done`。候选发现、逐面定性、以及 GET /queue 的 fail-open 降级
  三处的“知识不完整”都必须显式记账；Sidebar 遇到不完整一律封 `idle`，绝不进入终态回落。
  为此 `resolveActiveInvocationsStrict`（抛错）与 `resolveActiveInvocations`（fail-open，保 GET /queue 不 500）分离——
  沿用 fail-open 版本做 Sidebar 定性会把“读失败”伪装成“确实没有 active”。
- **owner truth 每请求只读一次**（R4 P1-1）：managed / child 两张脸是 user-scoped **全局枚举**
  （Redis 侧 = `SMEMBERS + pipeline HGETALL`），成本与 candidate 数无关，因此不能放进 per-candidate
  定性——否则 A 个候选形成 1+A 次全局枚举，最坏 O(A²)，也不满足 spec 的常数 pipeline stage 要求。
  收敛为 `buildSnapshot`：候选 union 与 owner-truth 物化在同一次读里完成，摊平成 `threadId -> catIds`；
  per-thread 提问只留给真正需要它的 live classifier。
  ~~未新建 per-user Redis 索引。~~ **⚠️ 已被 cloud R7 P2 推翻（superseded）**：`listRunningThreadIds`
  的 `SCAN MATCH` 实测随 keyspace 线性增长（200k → 201ms），后续改为 per-user 候选索引
  `invoc:running-threads:{userId}`。R4 这句只对 **child ledger** 仍然成立——它复用既有全局
  running child set，可直接 SMEMBERS 寻址。
- **模块职责边界**（R4 P1-2）：`live-invocation-projection.ts`（单执行面 projection + registry port
  + strict/fail-open adapter）与 `active-execution-service.ts`（三面 candidate/working composition）
  分离，两者均在 350 行硬线内，owner 仍在 domain。fallback 聚集随 live 面一起搬走而消散，不申请例外。
- **判别式单一 owner**（R4 P2-1）：`isRetiredWakeWithRunningManagedCommand` 收口到 ball-custody domain。
  此前投影侧用 `parseRetiredManagedCommandWakeTask` 顶替，在**两个维度**上更宽（不校验任务身份、
  不要求 `holdLifecycle.createdBy`），会把非 hold task 宣称成 cancelable managed command，
  而 DELETE cancel path 仍拒绝它——**用户点了取消却取消不掉**。刻意不收紧 parser 本身：
  它还有 `RetiredManagedCommandTerminalRecovery` 等 consumer，改通用语义会外溢到终态恢复路径。
- **投影 ↔ 取消路径 parity**（R5 P1-1）：判别裂缝在本 PR 出现过三次，方向全是**投影比取消路径宽**——
  retired 分支不校验任务身份、不要求 `holdLifecycle.createdBy`；active 分支两者都缺。
  后果不是"少显示"，而是 active-execution 列表无条件标 `cancelable`、DELETE 路径却拒绝：
  **用户点了取消却取消不掉**。
  根因是参照系选错了：R4 时把"与旧 predicate 等价"当成目标，但旧代码的 active 分支本来就不校验。
  判据应是**取消路径认不认**。lifecycle 判读（`readHoldLifecycleProjection`）与两条 predicate
  （pending / retired）全部收口到 ball-custody domain 单一 owner，route 侧只保留 re-export；
  投影两支各过对应 predicate。parity 表 active / retired 共用，并锁结构性不变量
  **“投影出来的执行，取消路径必须认”**。
- **判别层与 lifecycle 分模块**（R6 P1-1）：判别收口到 ball-custody 之后，
  `managed-command-wake-lifecycle.ts` 被从基线 323 行推到 403 跨线——收口没错，但把硬线压力
  换了个地方。按 read-model 职责拆出 `managed-command-wake-task-projection.ts`
  （task identity / hold lifecycle 判读 / active·retired predicates / parsers），
  lifecycle 从它 import 并对外 re-export，既有 consumer 的 import 路径不变、判别仍只有一份。
  **依赖方向单向**：判别层是底座，不 import lifecycle（否则成环）。
- **sidebar 读路径必须直接寻址**（cloud R7 P2）：`listRunningThreadIds` 原用
  `SCAN MATCH invoc:running:*:{userId}`，但 Redis 的 SCAN **仍遍历整个 keyspace**，MATCH 只过滤
  返回值。于是每次 `GET /api/threads?view=sidebar` 的成本随库里所有持久化键增长，而不是随
  在跑的 thread 数——也违反本 feature 自己 spec 的「常数 pipeline stage」。
  实测（本地无网络延迟）：dbsize 3→0.3ms / 10k→13ms / 50k→56ms / **200k→201ms**。
  改为 per-user 候选索引 `invoc:running-threads:{userId}`（1×SMEMBERS + 1×pipeline），
  同规模实测 **0.28–0.40ms 恒定**。
  **一致性方向刻意设计成安全侧**：索引 SADD 与 running set 在**同一原子 Lua** 内完成 ⇒ 不会漏报
  （漏报 = false terminal）；写侧终态 SREM + 读侧 SCARD 校验消除多报；backfill 同步 seed，
  使 pre-deploy 记录不漏。三层各有独立测试（mutation 验证过：任一层退化都会转红）。
  这推翻了 R2「不新建索引」的取舍——当时没有成本实测数据，新证据支持改判。
  **索引读故障同样 fail-closed**（local R8 P1）：SCARD 的 pipeline entry error / 缺条目 / 非数字回复
  都是 owner-truth read failure，必须抛出让 completeness 记账封 idle；只有权威的空集合
  （`error == null && size === 0`）才算可清理 stale。否则一次瞬时读故障会被 fire-and-forget
  SREM **固化成持久漏报**，而方法仍正常 resolve、调用方误记 complete → false terminal。
  这与本 PR 的 strict/fail-open 分拆是同一条铁律：**未知不得当成「没在跑」**。
- **同类失败模式 audit**（cloud R9 P1）：「读失败被当成空集合」在本 PR 里出现了**四次**
  （strict/fail-open 分拆、record 候选索引 SCARD、child ledger pipeline、record 明细 pipeline）。
  第四次是 audit 主动扫出来的既有代码——它喂给新加的 `resolveActiveInvocationsStrict`，
  store 层若先吞掉错误，strict 路径永远拿不到异常，整条 fail-closed 链就是假的。
  统一判据：**权威的空（`{}` / `size===0`）才是空；缺条目 / entry error / 类型异常一律抛出**。
- **presence 投影从路由抽出**（cloud R9 P1）：`threads.ts` 基线已 1392 行，本 PR 又加了一个独立
  read-model 职责。抽到 `routes/sidebar-presence-projection.ts`，路由只做 orchestration，
  本 PR 对该文件净增从 +91 降到 +29。
- **pipeline 回复判据收口到单一来源**（R10 P1-1 / cloud R11 P1）：「读失败被当成空集合」在本 PR
  出现了**六次**。前几次都在各自 store 手写判断，于是每次漏一两种形态——`null` 被 `!hash` 吞掉、
  `typeof [] === 'object'` 让数组通过、非空但 hydrate 不出来的损坏 hash 被当 stale 并**永久 SREM**。
  判据抽到 `redis-pipeline-reply.ts` 只写一遍，三个 store 共用：
  缺 entry / entry error / `null` / 非 plain object / 非空不可 hydrate → **throw（未知）**；
  plain `{}`（或 SMEMBERS 空数组）→ **权威空**；合法 terminal / scope 不符 → **权威非 live**。
  终态投影侧由 `createSidebarPresenceSource` / `composeSidebarPresence` 显式 catch 封 idle——
  不 500，也不让 store 静默返回空冒充权威生命周期结论。各 store 的 direct negative table
  覆盖全部异常形态，并锁住「未知不得 SREM」。
- **「权威」的判据要判到底**（R11 P1-1 / cloud R12 P1）：抽出 helper 还不够——`isPlainObject`
  没查 prototype（`new Date(0)` 被判成权威空）、hash value / set member 没验类型、consumer 又用
  「有没有 id」代替「能否权威 hydrate」（`status="banana"` 被当 stale 并 SREM、`d.id` 与索引不符
  仍返回、坏 JSON 的 `targetCats` 被 `safeParseArray` 静默变 `[]`）。补齐后判据才真正兑现：
  prototype + 内层类型 + id 与索引一致 + status 属合法 union + owner-truth 字段严格 decode。
  backfill 同样收口，且**失败不置位 backfilled flag**，下次读 API 自动重试（否则一次部分失败
  = 本进程永久漏报 pre-deploy running thread）。
- **fail-closed 当场抓到一个真实缺陷**：改完 backfill 不再吞错后，既有 F194 测试立刻红——
  新增的 `invoc:running-threads:{userId}` 是 SET，却匹配 backfill 的 `invoc:*` SCAN，
  而既有 filter 只排除 `invoc:running:`（`running-threads` ≠ `running:`），于是对 SET 发
  HGETALL → WRONGTYPE。**这个 bug 之前一直被静默 continue 吞掉**。它是「吞掉读错误会掩盖
  真实缺陷」的活证据，不只是理论风险。
- **验证纪律**：定性通道禁止 stub。前两轮测试把 classifier stub 成固定返回，只证明了“候选能到达一个假定性器”，
  恰好绕开真正坏掉的一段。本轮每条断言由真实 store / 真实 task / 真实 helper 驱动，并逐条做 mutation 自验
  （退化实现必须转红），另加 in-memory + Redis 两侧的 `listRunningByUser` 直接测试
  （service 侧的冗余 user 过滤会掩盖 store 自身的 scoping 缺陷）。
- **transport validity ≠ record validity**（R12 P1）：envelope helper 收敛的只是「这是不是一条真实的
  HGETALL 回复」；hash → `InvocationRecord` 的业务判据仍散在四个消费点各自手写（helper 只验 id+status、
  `assertStrictJsonArray` 不验成员、backfill 谁都不调、`scanAll` 还在吞 err）。修复不是再加三个 if，
  而是 `invocation-record-redis-codec.ts`：hash → domain truth 的**唯一路径**
  （`absent | running | not_running | throw`），严格集显式定义（id/threadId/userId/status ∈
  `ALL_STATUSES`/targetCats 严格 string[]/有限时间戳）且 **lenient 分界也显式声明**（遥测字段不参与
  liveness，扩集走显式决策）。消费点全收口后 store -150 行；表驱动定义合法空间时连 codec 自己的
  第一版实现都被表抓出一个漏（targetCats 缺失被宽容成 `[]` = 伪造「没有目标猫」的记录）。
  枚举损坏形态是无限工作；定义合法空间是有限工作——R7 起的 malformed-shape review 循环到此关闭。
- **registry bridge 失败是未知，不是「draft 不存在」**（cloud R5 P1-A，封板轮）：`resolveDraftToTurn`
  的 `catch { return null }` 把 `getTurnInvocation` 瞬时失败降成合法 skip。running parent 超过
  record-only grace、唯一 live 证明是 fresh child draft 时，一次瞬时失败 → strict 权威空 →
  `complete:true` → sidebar 落历史 done/error。null（registry 权威「无 turn info」）与 throw（未知）
  是两个真相位面；修复后传播链无中间吞点，`collect` 记账 `complete:false` → 封 idle。
- **cloud 封板收口**（LL-072）：cloud 第 5 轮覆盖 exact HEAD 后封板；其 P1-B（backfill 静默 skip）
  已被 R12 codec 覆盖，P1-A 单独修复。此后不再 re-trigger，转本地有状态 final review。
- **rebase 合流 #3763**（foreign-principal occupancy）：main 前进带来 managed 面新语义——trigger
  ownership 只决定「能不能停」不决定「能不能看见」。合流原则：底层枚举器 principal-blind（route
  列表显示 foreign 占用 + 合成不可解析 `occupied:` id），service 消费面（Sidebar 定性/候选发现）
  **保持 per-user 语义不变**——是否把 foreign 占用算进 working 是独立设计决策，不在 rebase 冲突
  解决里夹带。#3763 的 foreign-principal regression 7/7 在新结构下全绿。

### Phase C — 前端 authority boundary + structural guard

- [x] AC-C1: 新建窄类型 `sidebarProjectionStore`，其 `rows` canonical writer 收敛到 `applySidebarSnapshot`；cache 只在本轮首次 canonical apply 前可用；late cache / late HTTP generation 均被丢弃。旧 `chatStore.threads/threadStates` 不作为 Sidebar fallback。
- [x] AC-C2: invalidation single-flight 有 trailing-dirty 语义；测试覆盖 request 乱序、飞行中 invalidation、丢事件后的 reconnect/visibility recovery。
- [x] AC-C3: structural guard 保护新 boundary：只有 canonical apply 可写 `sidebarProjectionStore.rows`、只有 canonical apply 可持久化 Sidebar snapshot、Sidebar render/sort tree 不得读取 legacy `chatStore.threads` 或 unread/`lastActivity`/raw liveness。**不得全局禁写 `chatStore.threads/threadStates`**；它们仍有 Chat runtime owner。
- [x] AC-C4: guard checker 自带独立 fixture canary：合法 Chat runtime fixture 同时写 `messages + catStatuses` 仍 GREEN；绕过 canonical apply 写 rows 的 fixture RED；Sidebar render path 读取 legacy liveness 的 fixture RED；overlay/draft adapter fixture GREEN。先观察 checker 缺失时的 mutation RED，禁止污染生产源码。
- [x] AC-C5: optimistic command overlay 测试覆盖成功确认、失败撤销、并发同字段 last-command-wins、canonical snapshot 不被闭包 rollback 覆盖。
- [x] AC-C6: AC-A3 的高危 race 按结构归类为“不可能”或保留 owner contract，并对 authority 边界抽样测试；不再逐对新增 pairwise guard。
- [x] AC-C8: **`lastActivity` 覆盖服务端排序真相的读路径拆除**（AC-A3 新发现）。`mergeLiveActivityIntoThreads` 让任意本地 `lastActivity` 压过服务端时间，是排序抖动的结构性来源。要求：Sidebar 删除这条 read-side merge，服务端 C7 成为排序权威；21 个 runtime stamp 点可在其 owner 下继续存在，不把“移除 Sidebar consumer”扩大成“删除 Chat runtime writer”。

#### Phase C implementation evidence（2026-08-19，feature worktree）

- **C1 / C2**：`sidebarProjectionStore.test.ts` 与 `sidebar-thread-snapshot-phase-c.test.ts` 锁定 cache bootstrap gate、server generation、single-flight + trailing-dirty；`thread-sidebar-online-recovery.test.ts` 与 `useSocket-reconnect-catchup.test.ts` 锁 online / visibility / Socket reconnect 恢复边界。
- **C3 / C4**：`check:sidebar-projection-boundary` 同时运行 checker 自测与真实源码检查；除既有 Web writer/read/DTO canary，2026-08-19 起还结构性禁止 API presence projection import `ThreadParticipantActivity` 或调用 `getParticipantsWithActivityBatch`，防止聊天历史再次冒充 lifecycle。
- **C5**：`sidebar-commands.test.ts` 与 `sidebarProjectionStore.test.ts` 覆盖成功观察后 retire、失败撤销、同字段并发 last-command-wins、timeout 后权威刷新，以及“canonical snapshot 永不被闭包旧值回滚”。Proposal pin 同样改走共享 field command。
- **C7 / C8**：Sidebar render/sort 完全消费 snapshot `presence` / `lastActiveAt`。固定同一 snapshot 后，任意修改 legacy unread、raw liveness 或 `lastActivity` 均不能改变 row、图标或排序；Chat runtime 的既有 messages / cat status writer 仍保留。
- **旧 Chromium 自证已被 runtime 反例推翻**：受控 fixture 只验证了 DTO 能显示 `working/done/error`，没有验证 done/error 的**来源真是 lifecycle**。用户现场 `0001787165232870-000010-bdadf699` 证明历史聊天被批量投成绿 ✓；旧证据不得用于 AC-D4/CloseGate。
- **浏览器反哺的 RED → GREEN**：Chromium 首轮把 snapshot reorder 期间的 `scrollTop 706 → 0` 暴露出来；`use-scroll-anchor.test.tsx` 随后构造“最后一次用户滚动为 200、浏览器瞬时归零、内容偏移 +84”的 RED（实际得到 0），修复后断言恢复到 284，真实浏览器复验保持 `706 → 706`。

#### AC-C6 race disposition（Phase C boundary view）

| # | Phase C 判定 | 结构证据 / owner contract |
|---|---|---|
| 1 | **Sidebar 内不可能** | command overlay 与 canonical rows 分离；snapshot 只能 retire 已观察到同字段预期值的 command，不能吞掉在途 intent |
| 2 | **Sidebar 内不可能** | Sidebar 只有 `GET /api/threads?view=sidebar` 一种 DTO 写入；late response 由 request generation 丢弃 |
| 3 | **消除绕路** | `ProposalCard` pin 改走与 Sidebar 相同的 `executeSidebarFieldCommand`，不再直接 patch legacy store |
| 4 | **保留 dispatch owner contract** | invocation timeout 仍归 Chat runtime；Sidebar 不读取其 raw liveness，下一份 server snapshot 才能改变 C10 |
| 5 | **保留 dispatch owner contract** | queue 不在 C0–C10；`QueuePanel` 语义不计入 Sidebar canonical writer |
| 6 | **Sidebar 内不可能；Chat runtime contract 保留** | late `syncThreadState` 可继续更新 messages/runtime state，但 Sidebar 已与 `chatStore.threadStates` 解耦 |

以上是 AC-C6 对 authority boundary 的结构归类与抽样证明；Phase D 的全 feature 账目核验仍由 AC-D2 收口，故 AC-D2 不在本阶段提前勾选。

### Phase D — 收口与账目

- [x] AC-D1: F081 保留历史 provenance，标 `superseded_by: F297`；AC-B2 以“作废（非完成）”结算。
- [x] AC-D2: 当前诊断预测的 6 个未报告 race 已逐条核验：1/2/3/4/6 由 canonical snapshot、overlay 与 owner boundary 消除或隔离；5 明确归还 dispatch queue owner，不冒充 F297 修复。修复 merge `878181270` 上 boundary guard 7/7、API F297 5 suites / 37 tests、Web 10 files / 82 tests 通过。后续 #1371 PR5 暴露的 restart owner 错配同样按边界收口：producer 在 Queue custody 中持久化 server-derived `ownerUserId`，startup reconstruction 不再把 scheduler message authorship 当 execution owner；F297 的 `ActiveExecutionService` 仍按 user 隔离，未放宽 foreign-user scan。author 在 latest-main `08b6ea756` 重跑 restart discriminating test，owner presence=`working + activeSince`、scheduler/foreign 均无 row；隔离 Redis custody parity 14/14。
- [x] AC-D3: F295 的现有 4s project scan 与 F297 refresh 做重复读取审计；保留一个 server composition service，不留两份 liveness 算法。**闭合 2026-08-18**：审计结论是「两份**读法**」而非两份算法——`active-execution-routes.ts` 的 project scan 仍 `threads.map(resolveLiveExecutions)`，每 4 秒 O(T)。已改为消费同一个 composition service 的 **live/child candidate view** 收窄候选：O(T) → O(A)；managed-command 不参与 live 定性，仍由完整投影枚举器读取，且同一请求只读一次 SQLite task 表。service 提前创建，queue / active-execution / Sidebar 注入同一实例，但两个 HTTP consumer 各自建立请求内 snapshot，不宣称跨请求共享物化结果。**降级方向与 Sidebar 相反且刻意**：Sidebar 漏报 → 显示 `idle`（用户无损）⇒ fail-closed；本列表漏报 → 正在跑的执行不在可取消列表里、用户停不掉（功能损坏）⇒ **fail-open**，未接线 / 读失败 / `complete=false` 一律退回全量扫描。三种降级路径各有 regression。
- [x] AC-D4: **终态 attention/read 旅程闭合（#3817 / `c66ded63b`）**。#3798 的 lifecycle witness 与 attention gate 保留；修复归 F069 visibility/read-state owner，F297 未新增 `needsAttention` 或第二份 unread。`read/latest`、mark-all 与 direct `PATCH /read` 都以同一 durable-owner-read predicate 拒绝未 settled 的 mutable stream；最终 delivery 后，仅当前选中且 document visible 的消费面才 ACK。RED→GREEN 覆盖离开后完成 → `unread + done/error`、停留看到完成 → `idle`、hidden document 不提前 ACK，以及同一 bubble 的 final-delivery retry。fresh alpha 用真实 Redis 6398 验证 direct PATCH 在 partial 时为 `{advanced:false,caughtUp:false}`，同一 message final 后为 `{advanced:true,caughtUp:true}`；Memory/Redis parity 4/4，F5/reconnect 前后采用同一 durable evidence 规则。

### CloseGate User Visibility Disclosure（2026-08-21 final）

| Surface | 用户能做什么（达成态） | latest-main 实际行为 | 缺失/退化 | 处置 |
|---|---|---|---|---|
| Sidebar 背景行 | 不打开 thread 也能看 participants、working/done/error 与独立 unread/mention；pin 边界内 working 整体越过 idle | C0–C10 由 `GET /api/threads?view=sidebar` 一次返回；真实 Alpha 历史行不再假绿/假红；受控 canonical Alpha 证明 pin idle → working 20m → working 5m → newest unread idle → idle | 无 F297-owned 缺失 | author Alpha + API lifecycle regression + Terra renewed CloseGate PASS |
| Restart owner visibility | managed hold 在 API restart 后仍只对原 user 显示 working，不泄漏到 scheduler/foreign owner | #3829 将 Queue custody 的 server-derived `ownerUserId` 用于 startup reconstruction；F297 consumer 保持 user-scoped | 无；scheduler 仅保留 authorship/provenance | restart RED→GREEN + 隔离 Redis parity；不在 F297 增加 fallback |
| 命令即时反馈 | pin/favorite/rename/labels/preferredCats/read 有即时反馈，失败不覆盖较新的 server truth | 非持久化 field overlay；canonical snapshot 仍是唯一 row writer | 无 | Phase C command/overlay regression + boundary guard |

**Out-of-scope disclosure**：Workspace“状态与会话”入口、Session Chain/Session ID 的信息架构属于 F299/F284，不作为 F297 已修或未修的证据；F277 的注意力导航只消费 F297 row，不拥有 C10 lifecycle。F297 没有用户可见 deferred surface。

## Dependencies

- **Supersedes**: F081（write-path audit；诊断保留，约定式 enforcement 作废）
- **Reuses**: F295（active execution projection service）、F194（liveness classification）、F069（batch unread）、F164（cache-only contract）、F183（server authority + recovery 原则，不复用 seq 协议）
- **Related**: F095/F277（Sidebar 导航与注意力消费）
- **Previously blocked by — resolved in #3817**: F069 的流式消息 read-evidence 修复（只修既有 visibility cursor/read-state，未扩 F297 C0–C10）

## Risk

| 风险 | 缓解 |
|---|---|
| 稀疏 active index 漂移，漏掉真实 running | index 仅作 candidate source、可 rebuild；tracker/running child/record 多源 union；reconnect/visibility refresh + parity test |
| 多 store snapshot 不是数据库级原子 cut | edge invalidation + dirty-while-flight trailing refresh；不把 snapshotId 宣称为跨 store transaction |
| 迁移期新旧两套同时影响 Sidebar | 新 `sidebarProjectionStore` 一次切换 canonical read；guard 同时锁 write/persistence/read boundary，禁止 legacy fallback |
| optimistic overlay 变成隐形第二真相 | 不持久化、不写 canonical、不携带整行；只到 snapshot 确认或失败/timeout |
| F295/F194 被复制进 thread-navigation | ownership map + import/service boundary guard；F297 只能组合 projection，不拥有 execution lifecycle |
| 路径数再次冒充 writer 数 | W1–W57 仅作 migration path nodes；发布指标只看 `sidebarProjectionStore.rows` writer = 1 |

### 当前诊断预测的、尚未作为独立报告验证的 race

1. Sidebar snapshot 静默吞掉在途 optimistic write。
2. 不同字段集的全表 fetch 互相覆盖。
3. `ProposalCard` pin 路径绕过 toggle reconcile。
4. invocation-timeout 本地定时器覆盖新到运行 truth。
5. `QueuePanel` 闭包 `prevQueue` rollback 覆盖服务器新队列（若不影响 Sidebar-owned fields，AC-D2 应归还 dispatch owner）。
6. `syncThreadState` 迟到回写旧 thread（若只影响 Chat runtime，同样不计入 F297 writer 收敛）。

这 6 条不是待逐点修补清单，而是用来验证 scope 与 authority boundary 是否诚实：不属 Sidebar 的必须明确移出，不能为了凑“根因全治”偷扩 scope。

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| KD-1 | “三条路”是本 projection 的策略分类，不是分布式系统穷尽定理 | total order 不要求单 writer；完整仲裁理论上可行 | 2026-08-17 |
| KD-2 | 首期一个 canonical writer，删除 `applyDelta` | state-bearing delta 会重新引入 merge/order protocol | 2026-08-17 |
| KD-3 | correctness 用 client request generation + cache bootstrap gate；server revision 仅可选优化 | full snapshot/invalidation 不需要复制 F183 seq/epoch | 2026-08-17 |
| KD-4 | active liveness 复用 F295/F194 sparse service | 不在 thread-navigation 复制 4-store classifier | 2026-08-17 |
| KD-5 | optimistic command 是非持久化 render overlay | 保留即时反馈而不增加 canonical writer | 2026-08-17 |
| KD-6 | guard 锁新 projection 的 write/persistence/read/DTO boundary，mutation RED 用 fixture | `chatStore.threads/threadStates` 仍承载其他 owner 状态；不能用全局字段禁写越权 | 2026-08-17 |
| KD-7 | 新建窄类型 `sidebarProjectionStore`，不复用 `chatStore.threads` 作为 canonical 容器 | 分离后 guard 只需约束一个 store；旧 Chat runtime writer 不必被 F297 扫除 | 2026-08-17 |
| KD-8 | W1–W57 只作为迁移 path nodes，不发布为“57 个 writer” | primitive 与 caller/trigger 不可重复计数；稳定 KPI 是目标 store 的单写边界 | 2026-08-17 |
| KD-9 | Sidebar terminal 只认 InvocationRecord transition；participant activity / session-open 均不是终态证据 | 聊天历史没有 invocation 边界，会把所有旧 thread 永久染绿/红 | 2026-08-19 |
| KD-10 | terminal witness 持久，可见性由 unread/mention attention gate 管理；working 不受该 gate 影响 | “真的结束”与“用户还需要看”是两个不可混合的问题；对齐读后徽标消失的产品语义 | 2026-08-19 |
| KD-11 | C7 thread recency 与 C10 working elapsed 是两个时间轴；不得靠 heartbeat bump C7 伪造“刚刚” | 轮询更新时间会扰乱 canonical 排序；active duration 应由 lifecycle owner truth 显式呈现 | 2026-08-20 |
| KD-12 | C9/F069 继续是 terminal attention 的唯一真相；不在 F297 新增 completion-unread/needs-attention。流式 placeholder 不能在 final delivery 前充当 durable human-read 证据 | 当前反例不是缺 terminal witness，而是既有 visibility cursor 过早前进；在 Sidebar 再补一层状态只会制造两套未读语义 | 2026-08-20 |

## Review Gate

- Architecture reviewer: Sol（本 Design Gate）；Phase C implementation author 依 operator 授权改为 Sol，exact-HEAD reviewer 为 Kimi。
- 实现触及 API/Web、read model 与缓存 authority，必须用隔离 worktree + TDD + 非作者 exact-HEAD review。
- 性能 claim 分成两类：结构成本用 call-count/load fixture；真实延迟/稳定性用 metrics/traces，不挂 Eval Hub。
