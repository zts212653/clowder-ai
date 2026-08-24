---
feature_ids: [F220]
related_features: [F216, F175, F153, F118, F194, F215, F224]
topics: [a2a, observability, liveness, invocation, queue, interrupt, recovery, ux]
doc_kind: spec
created: 2026-06-02
tips_exempt: automatic zombie-ownership and queue-publication hardening; no new user action or standalone capability surface
---

# F220: A2A 协作的可观测 · 可靠 · 可恢复

> **Status**: in-progress | **Owner**: 小太阳·Maine Coon (Sol/GPT-5.6-sol；2026-08-04 operator 重分配) | **Priority**: P1 | **Source**: internal
>
> **Thread legend**：`[thread-id]` = 驱动/owner thread（Layer 1 现场调查 + 落地，Ragdoll Opus-4.8）｜`[thread-id]` = 立项 thread（平行 opus-48：立项 + 设计沉淀 + 交接，已收工）。

Architecture cell: `dispatch` + `bubble-pipeline` + `action-plane`
Map delta: none（复用现有 dispatch queue、frontend message/liveness chrome、force-reset action 边界，不改 ownership map）
Why（一句话）: A2A 触发与卡死恢复都落在既有 invocation/queue/tracker 生命周期里，本 feat 补它的"可见性+可恢复性"，不新造 store/queue。

## User Journey

**Scope unit**: 用户（operator/operator）在 thread 里 @ 猫触发猫间协作（A2A 传球 / serial continuation）

**Flow**:
1. 用户在 thread 里 @ 一只猫，或猫 @ 猫接力，触发 A2A 传球
2. **可观测**：目标猫"启动中/排队中"占位及时出现在主聊天 chrome（复用 F118 D2 `spawn_started`）——用户看得见"猫在路上"，不是空等一片
3. 猫正常跑完 → 回复出现；若在排队，用户看到队列占位而非"消失"
4. **可靠**：即使上一棒猫被判僵尸清理，它残留的 stale `processing` 队列条目也被一并收敛（clowder-ai#972）——用户后发的消息不会卡在一具"尸体"后面永远不跑
5. **可恢复**：若猫真卡死（补一刀仍不进 running），thread 出现情境化 force-reset 逃生口（带确认弹窗，**只清运行态、绝不动消息/历史/记忆**，LL-048）；用户点确认 → thread 解放
6. 全程用户对"谁在跑 / 卡没卡 / 能不能自救"有一致、可信的感知——猫间协作**看得见、信得过、能恢复**

---

## Why

operator要"**信得过的猫间协作**"。但今天 A2A（猫@猫）协作在三个维度同时漏，叠在一起让人**分不清猫到底在跑还是卡死**：

1. **看不见**：human→猫发消息，"启动中/排队中"占位**秒显示**；但猫→猫传球，前端**长时间一片空白**，没有任何"X 收到了/启动中/排队中"。用户传球出去后是一片静默。
2. **会真卡**：那条 invocation 可能真 hang（队列/session），补一刀还停"排队中"不进 running。
3. **卡了没法自救**：真卡死时正常的停止/中断点不动，用户没有逃生口。

**最要命的是 1+2 叠加**：因为缺可见性（1），前端把"猫在正常思考还没出字"和"猫卡死了"画成**同一个静默画面**——用户根本无法区分。这是operator 2026-06-02 在 `[thread-id]` 截图反映的体感来源。

> 价值锚：让用户**看得见**猫间协作在进行（不是黑盒静默）、**信得过**它不会无声卡死、**卡了能自救**。

## Current State / 现状基线（带证据，不美化）

组件层面**很多已经修好且在 main 上**——真问题更深，是"数据没产生"和"卡了没出口"：

- ✅ `ThinkingIndicator.tsx` 已 `useThreadLiveness` thread-scoped（main），有完整 `spawning → "{name} 启动中"` 渲染（~L84-120）。
- ✅ `#2050`（已 merge）：排队中显示等待原因（A2A queue-visibility）。
- ✅ `#2053`（已 merge 2026-06-02）：steer 立即中断 race-safe tombstone 修复（"卡住怎么点都中断不了"的 sound 部分）。
- ✅ `POST /api/threads/:id/force-reset` 端点**已存在**（2026-05-29 bug-report 加的）：cancelAll + 清 slot/record + 广播 done，user-scoped。
- 🔧 **Layer 1 缺口（Phase 1 implementation in `feat/f220-a2a-liveness-signal`）**：组件能渲染 spawning，但现代 InvocationQueue 路径缺少与 direct `/api/messages` 对等的 `spawn_started`。QueueProcessor 开始 processing 后只发 `queue_updated`，`intent_mode` 又按 #768 延迟到 CLI 第一条事件；CLI 冷启动/首事件延迟期间，主聊天 chrome 拿不到"目标猫正在启动"信号。修复：`QueueProcessor.executeEntry` 在 `startAll` + running record 后、`intent_mode` 前广播既有 `spawn_started`。
- ⚠️ **Layer 2**：has()=false 占用 slot 的真 hang（dead-Redis create 等病态）；#2053 已证 steer 无法 sound force-recover，只能靠 75min sweep / force-reset。
- ⚠️ **Layer 3**：force-reset 端点有，**前端无 UI 入口**——用户卡死时没有可点的逃生口。

## What

三个 Phase，对应三个维度：

### Phase 1 — 可观测：A2A 启动中/排队占位可见（Layer 1）
补上"A2A 触发后用户看得见猫在路上"。Phase 1 第一刀定位为 InvocationQueue 执行路径缺 `spawn_started`；复用 F118 D2 既有事件，不新造前端协议。
> 起点：驱动 thread `[thread-id]` 的 Layer 1 调查（已到根因层）。
> **现场校准（实测截图时间线）**：传球那刻Maine Coon大概率**空闲**（46/我 18:34 结束、Maine Coon 18:32 早结束），故候选 (a)"目标猫忙→排队不 spawn"**可能不成立**；live 取证**优先验 (b) `invocation_created` 事件丢/延迟、(c) `targetCats` 未更新成单目标 `[Maine Coon]`**。
> **实现校准（2026-06-02 Maine Coon review）**：runtime preflight 显示截图环境不在当前 main（runtime HEAD `65530c6a6`；target `2f433838b` 不在 history），截图不能单独证明 main 状态。main 代码对照显示 direct path 有 `spawn_started`，QueueProcessor path 没有；测试钉死后修 QueueProcessor。

### Phase 2 — 可靠：invocation 卡死根因（Layer 2）
定位"补一刀仍停排队不进 running"的真 hang（队列没消费 / session hang / 锁）。可能与 #2053 收敛的"slot/tracker/entry 生命周期解耦"相关。Maine Coon roadmap：是否统一 cancel/preempt 状态机、slot 升级带 invocation-identity ownership。
> **Scope 闸门（KD-3）🔴**：Phase 2 **先出根因报告（5 件套）+ 复现，不直接动手大改**。若根因需架构级重构（统一 cancel/preempt 状态机 + slot ownership 模型）→ 出报告 + Decision Packet 交 **operator 拍板是否拆独立 feat**，不在 F220 内硬扛。防 Phase 2 无底洞拖垮 Phase 1+3 的已交付价值。

#### Phase 2 根因报告：#972 split-brain（2026-06-17 Ragdoll opus-48，接 Maine Coon routing）

**输入**：社区 [`clowder-ai#972`](https://github.com/zts212653/clowder-ai/issues/972)（吴浪 @mindfn 报，Maine Coon maintainer triage+accept+route 到 F220 Phase 2）。runtime 证据见 issue（thread `[thread-id]`；parent inv `b23ee98a`/opus；serial child `b24dbf21`/codex；stale queue 条目 `b949b024`/processing；被卡住的 user `@codex` 条目 `e4af49ae`/queued）。**= AC-2.1 的 concrete 输入**。

**根因（单一根 = 多 liveness SoT 无收敛点）**：同一 thread 的"谁在跑"被 4 套独立状态各自表述、互不收敛——
1. canonical liveness（`InvocationRecord`+tracker+draft → `getThreadLiveInvocations` → `/queue.activeInvocations`）
2. `InvocationQueue` 条目（processing/queued → QueueProcessor）
3. `agentPaneRegistry` bg carrier（→ `/active-pane`，`terminal.ts:319` **只查这个**）
4. serial-continuation session（continuityCapsule，**F224 轴**，创建 child invocation）

bug 链：opus parent 结束本轮 → tracker 没了/无 fresh draft → 过 grace → 判 zombie → `reconcileZombies` 标 failed。**但 `reconcileZombies` 只动 `InvocationRecord`+`TaskProgress`（已读码确认 `reconcileZombies.ts`），不碰 queue 条目/slot** → 旧 `processing` 条目残留 → 卡住后到的 user `@codex`。同时 serial codex child 真活着（进程+session）却：非 bgCarrier → `/active-pane=false`；canonical liveness 返回 `[]` → 用户看不到 codex 在跑。**这正是本 thread 开篇operator两张截图（"Maine Coon像卡住了、消息没同步"）的后端根因。**

**关键架构发现**🔴：#972 是 **F220↔F224 轴接缝**的 bug——continuation child 在 F224 轴创建，liveness/queue 却在 F220 轴跟踪，两轴在此 seam 不收敛。这是对本 feat 序言"两轴只共享 `QueueProcessor` 文件、不共享根因"假设的**反例证据**：轴在 #972 这个 failure mode 下确实**交互**。

**决策（答 Maine Coon [ACTION] implement-vs-operator + AC-2.1/2.2 + 架构 OQ；遵 KD-3 闸门）**：不是非黑即白的"直接实现 / operator packet"，按 seam 切两层——
- **Phase 2a（局部修，自决实现，不上 operator）**：① ~~`/active-pane` 改查 canonical liveness~~ **→ 已证伪，撤销，见 KD-6**；② `reconcileZombies` 收敛匹配 queue 条目 ✅ **merged via PR #2917 (`83962deb3`)**（messageId join + processing-only exact-id remove；两个 production caller 均已接线）；③ tracker / in-memory slot recovery 已由 F194 PR #2928 合入；④ clowder-ai#1150 的 intake hardening 增加 TaskProgress owner-CAS 删除与同 scope 全量 queue snapshot 有序/有界发布；⑤ 2026-08-04 closure audit 补齐 TTL-only pre-start 边界：reservation 明确记录 tracker 是否安装，只把从未进入 provider ownership 的 exact row 回滚到 `queued`，已启动过的 row 仍只接受 #2917/#2928 lifecycle proof。
- **Phase 2b（后续证据已决，不再需要 operator 二选一）**：PR #3047 (`d1b5a978c`, 2026-07-18) 已在既有 F194 canonical read model 内接入 `TurnExecutionStore.listByParent()`：child 在 provider 启动前先持久化 `running`，finally 写终态；`/messages` 与 `/queue` 都把同 parent/thread/user 的 running child 作为 parent 正向 liveness，store 读取失败则 fail-open、绝不制造 zombie。2026-08-04 核验公开 `clowder-ai/main` 的 read model 与两 route blob 均与家里一致，公开 `invoke-single-cat` 也包含 `createRunning` / `transitionTerminal`。因此旧 Decision Packet 的两个选项已由后续事故修复塌缩：**复用现有 F194 + TurnExecutionStore 边界，不新立 feat、不重画 F220/F224 ownership**。

#### Phase 2a Stateful Object Gate（✅ merged @ main 7563c9be0，PR #1150；高轮次 review 收敛）

| 对象 | 所有权 | 允许的 zombie 转换 | 禁止跨越的不变量 |
|------|--------|--------------------|------------------|
| `processingSlots[(thread, cat)]` | 精确 queue `entry.id` | 仅 stale entry owner 可 compare-and-release；随后 dispatch replacement | A 的迟到 callback / retry / immediate convergence 都不能释放 B 的 reservation |
| batch sibling `QueueEntry` | `batchParentId=primary.id` | zombie primary 移除时只 rollback 仍归 A 的 siblings；rollback 同时断开 owner | A 的迟到 finalizer 不能 remove/rollback 已由 B 重领的 sibling |
| `TaskProgress[(thread, cat)]` | `lastInvocationId` | Redis Lua / memory 原子 compare-and-delete，仅删除 zombie invocation 自己的 snapshot | A 的延迟 cleanup 不能删除同 cat replacement B 的 snapshot；非原子 read→delete 不合规 |
| `queue_updated` 全量快照 | `(SocketManager instance,threadId,userId)` publication tail（唯一入口=`emitQueueUpdated`） | **所有** publisher 在 mutation 后调用唯一入口；入口同步冻结 snapshot，等待 predecessor 后进入有 deadline 的 enrichment；deadline 内成功则发 enriched snapshot，超时/读取失败则发 frozen raw snapshot，再推进 tail | zombie / route / messages / connector / callback / processing / completed 任一路径都不能越过同 scope 较早快照；每个 publisher 成为 head 后必须在一个 enrichment deadline 内释放 tail，不能因 MessageStore stall 永久阻塞；最终到达顺序等于 mutation 后的调用顺序；不同 scope / runtime instance 不互相阻塞 |

收敛顺序固定为：`InvocationRecord CAS failed` → 精确移除 stale queue row / rollback owned siblings → owner-guarded slot release → snapshot 进入 `emitQueueUpdated` 的 `(socket,thread,user)` publication tail → predecessor settled → **在 enrichment deadline 内按调用顺序发布 enriched 或 frozen raw removal snapshot** → dispatch replacement；所有其他 queue publisher 也必须进入同一 tail，queue mutation、record/slot 收敛与其他 scope 不等待 enrichment，任何单次 enrichment stall 不能无限保留 tail，TaskProgress cleanup 与后续 zombie 的关键收敛解耦并行执行，但自身必须按 invocation owner 原子删除。

### Phase 3 — 可恢复：force-reset 逃生口 UI（Layer 3）
把已有的 `force-reset` 端点接到一个**情境化、带确认弹窗**的 UI 入口。**设计稿见下方 §设计稿（operator 2026-06-02 已审过概念 + 确认要弹窗确认）**。

## Acceptance Criteria

> 每条 AC 指得回 Why；非作者可复核（命令/截图/复现）。

**Phase 1（可观测）✅ code done @ main #2064（54aabde54）；runtime 截图验收 → operator quickpath**
- [x] AC-1.1: A2A 传球后目标猫"启动中"占位及时出现。→ QueueProcessor mark running 后 broadcast `spawn_started`（与 direct path 对齐）。复核（录屏占位秒级出现）→ operator quickpath runtime 验。
- [x] AC-1.2: 根因有 live 证据。→ Maine Coon runtime preflight + main 代码对照定位 callback/queue 路径缺 `spawn_started`（截图环境不在当前 main、改用代码对照）。
- [x] AC-1.3: human 路径占位不回归。→ 只改 QueueProcessor 队列路径，未动 direct/route-serial；全 web 测试无回归。

**Phase 2（可靠）**
- [x] AC-2.1: 根因报告（5 件套）✅ from #972 runtime evidence + 代码确认（`reconcileZombies.ts` / `terminal.ts:319` active-pane / `getThreadLiveInvocations` 模型），见上方「Phase 2 根因报告：#972 split-brain」。PR #2917（`83962deb3`）锁住 parent zombie queue-row convergence；PR #3047（`d1b5a978c`）以 durable child truth 关闭跨轴 liveness 根因。
- [x] AC-2.2: 修复按 seam 收敛——F194 PR #2928 的 tracker/slot recovery + F220 PR #2917 的 queue-row convergence + PR #3047 的 serial-child parent liveness + clowder-ai#1150 的 owner-CAS/publication fence 均已合入；`/active-pane` no-op 已删除；pre-start slot↔row TTL slice 已由 PR #3415（`e76dec000`）合入。

**Phase 3（可恢复）✅ code+test done @ main 4e80ec889（PR #2065 squash）；runtime 截图验收 → operator quickpath**
- [x] AC-3.1: 卡死/有活跃调用时 thread 出现情境化 force-reset 入口（非常驻）。→ `ThreadExecutionBar` 内 `ForceResetEntry`，有猫在跑才显示，`suspected_stall`/`alive_but_silent` 时上浮升级（`data-escalated`）。测试 4 绿。
- [x] AC-3.2: 点击弹**确认弹窗**（做什么/保留什么/何时用），确认才执行。→ `ForceResetDialog`（取消默认 focus / 强制重置危险红）。测试 4 绿。
- [x] AC-3.3: 确认 → force-reset → thread 解放；消息/历史**不丢**（LL-048 只清运行态）。→ `apiFetch POST force-reset` + toast「已重置」。复核（截图前后 + 消息条数不变）→ operator quickpath runtime 验。
- [x] AC-3.4: force-reset 对 record-present hung 和 **recordless canonical Queue owner** 都能清。后者从 user/thread-scoped `processingSlots` 发现 exact Queue group，在首个终态 await 前安装 replacement barrier，完成 durable row/custody terminalization 后才释放；迟到 cleanup 无法删除 replacement owner。真实 route + QueueProcessor 回归并验证 `queue_updated` 发布。2026-08-19 新 runtime（revision `1d1e774d4`，包含 PR #3782 merge `e240a8183`）live acceptance：exact cancel 后 Queue/active 归零，180 秒 foreground tree 与其 exact app-server host 消失，无关 host 存活；同 thread 后继在新 host 完成 exact token，未续跑旧指令；随后 Queue-backed 120 秒 invocation 经 force-reset 再次收敛至 queue=0、active=0、无 marker/host 残留。

## Dependencies
- force-reset 端点（`queue.ts`，已存在）。
- #2053 steer 修复（已 merge）——本 feat 是其完整产品故事的延续。
- Phase 间无硬依赖，可独立推进；建议序：可观测(1) → 可恢复(3) → 可靠(2)（1/3 直接缓解体感，2 是根因攻坚）。

## Risk
- Phase 1 改前端 liveness 写入时机，可能影响 human 路径占位——回归测守住。
- Phase 2 是 invocation lifecycle 雷区（F216 同域），改动需 race-safe + 跨族 review。
- Phase 3 force-reset 是强动作——确认弹窗 + user-scoped + **只清运行态（LL-048：绝不碰消息/历史/记忆等持久化数据）** 是安全前提。

## Key Decisions
- KD-1（2026-06-02 operator）：F220 reframe 成"A2A 协作可观测·可靠·可恢复"theme-feat，三层一起解决，不只 force-reset 逃生口。
- KD-2（2026-06-02 operator）：feat 由**干净 thread 的平行 opus-48 完整 own + 驱动**（带该 thread 的Maine Coon落地）；本 thread 负责立项 + 沉淀设计 + 跨线程交接。
- KD-3（2026-06-02 Ragdoll，接 own 时定）：**Phase 2 设 scope 闸门**——先出根因报告，需架构级重构则 operator 拍板拆独立 feat，不在 F220 内硬扛（见 Phase 2 段）。接手 5 点调整（Phase 2 闸门 / force-reset 守 LL-048 / force-reset vs orphaned slot 实测 / Phase 1 取证优先级校准 / thread legend）经立项方平行 opus-48 确认（thread `[thread-id]`）。
- KD-4（2026-06-02 Maine Coon）：Phase 1 不用新前端协议、不滥用 `a2a_handoff`。`a2a_handoff` 会迁移 active slot，适合 serial handoff；callback/queue path 应补 F118 D2 既有 `spawn_started`，表达"启动中"且保留 #768 的 `intent_mode` 延迟语义。
- KD-6（2026-07-13 Ragdoll opus-48，实现 Phase 2a 时**证伪 issue 的建议修法**）：**撤销 Phase 2a ①（`/active-pane` 改查 canonical liveness）——它是 no-op 补丁。** 证据（grep 消费方，不是推断）：`/active-pane` 的**唯一**消费者是 `ChatContainerHeader.tsx:114`，它 **完全忽略 `active` 字段**，只取 `daemonShortId`；`:134` `if (!daemonShortId) return null` → 无 daemonShortId 就什么都不渲染；`:141` 标题是「Daemon X 运行中 · 点击查看后台会话」。**所以 `/active-pane` 驱动的是 tmux daemon 附着徽章，不是"猫在跑"的 liveness chrome。** serial child 是 `-p` provider 进程、没有 daemonShortId → 就算让它返回 `active:true`，前端仍 `setDaemonShortId(null)` → **零用户可见变化**；若伪造一个 daemonShortId 让徽章出现，点击会跳到不存在的后台会话 = **制造新 bug**。真正的"猫在跑"信号是 `chatStore.activeInvocations`（源自 `/queue.activeInvocations` canonical liveness）。**教训**：issue 里的 suggested fix（连同 maintainer 接受的 scope + 吴浪的实施计划）三方都照抄了这条错误前提——**改契约前先 grep 消费方**（LL `feedback_grep_consumers_before_contract_change`）。Maine Coon"别当成纯 active-pane 显示补丁"的直觉是对的，且比他自己知道的更对。
- KD-5（2026-06-17 Ragdoll opus-48，接 Maine Coon routing #972）：Phase 2 答案按 **F220↔F224 轴接缝**切两层——**2a 局部修**（active-pane canonical-liveness SoT / reconcileZombies→queue 收敛 / slot↔queue 一致 / 回归）= F220 已祝福方向内、可逆 → **自决实现，不上 operator**；**2b 架构 seam**（serial-continuation-child ↔ parent/queue liveness 桥接，牵动"统一 liveness SoT"+ 轴边界重画）= 架构级 → 出 Decision Packet 交 **operator 拍板拆 feat**。遵 KD-3：2b 不在根因报告+repro 前动手大改。**#972 是"两轴不共享根因"假设的反例**（轴在此 failure mode 交互）——若 2b operator 决定重画边界，序言断言需同步修订。
- KD-7（2026-08-04 小太阳·Maine Coon，operator 接管后 closure audit）：KD-5 的 Decision Packet 前提已被 2026-07-18 PR #3047 的后续事实消解。child lifecycle 继续由既有 `TurnExecutionStore` 持有，F194 canonical read 只消费它；没有新增 store、extension point 或 ownership cell。结论是 **不拆新 feat、不改 `/active-pane`、不再向 operator提交过期的架构 A/B 题**，直接按已合入证据同步 truth。
- KD-8（2026-08-18 小太阳·Maine Coon）：#1371 live acceptance 暴露的两个 residual 按确定契约分治。Queue reset 复用既有 pre-start exact-group retirement barrier，不新造 slot 恢复机制；Codex 取消一旦被 lease 观察就永久污染 exact host，cooperative close 和 timeout 都只能走 host eviction 与既有 supervisor owner-token/PID-start-identity 收敛。裸 `@target` 仍是 composer 语法，literal 日志/示例用反引号或代码块，不修 runtime parser。

## 设计稿（Phase 3 — force-reset 逃生口 UI，operator 2026-06-02 已审概念）

**它 reset 什么**：reset 这个 thread 的**执行状态**——取消你在这个 thread 里所有在跑的猫调用 + 清掉卡住的"正在回复中"/"队列繁忙"状态 → thread 重新能用。**不删消息/历史/thread，不碰别人的调用，不碰记忆数据**。只擦"谁在跑"的临时态。

**触发 & 位置**：挂「当前调用/执行中」面板，只在有猫在跑时存在。
- 默认：面板里除正常「停止」外，一行**低调次级入口** `⚠ 卡住了？强制重置`（灰、不抢眼）。
- 升级（疑似卡死：调用异常久 / 点过停止没生效）→ 这行**变亮上浮**。

**确认弹窗（核心，operator点名要）** — 点击不立即执行，先弹窗：
- 标题：`强制重置这个对话？`
- 正文三段：🛑 会做什么（取消本对话所有在运行的猫 + 清"正在回复中"）/ ✅ 会保留什么（消息历史全保留，只清运行态）/ 💡 何时用（猫卡死、点停止也没反应时的最后手段）
- 按钮：`取消`（默认 focus）/ `强制重置`（危险色 red）

**弹窗 ASCII 草图**：
```
┌─────────────────────────────────────────┐
│  强制重置这个对话？                    ✕ │
├─────────────────────────────────────────┤
│  🛑 会取消这个对话里所有正在运行的猫，    │
│     清掉卡住的"正在回复中"状态。          │
│  ✅ 消息和历史全部保留——只清运行状态。    │
│  💡 仅在猫卡死、点「停止」也没反应时用。   │
├─────────────────────────────────────────┤
│              [ 取消 ]   [ 强制重置 ]🔴   │
└─────────────────────────────────────────┘
```

**流程**：有猫在跑 → 显示低调入口 →（卡死时升级显眼）→ 点击 → 确认弹窗 → 取消(什么都不动) / 确认(调 `POST /force-reset` → 清运行态 → toast「已重置，对话已解放」→ 面板恢复空闲)。

> 实现前走 Design Gate「在地设计检查」+「现场可感知性自检」（本 feat 属 observability/recovery 类，必填 in_context_observability 字段）。前端像素稿可用 Pencil 渲染再过operator。

### 高保真像素稿（2026-06-02 operator Design Gate 通过 → 实现真相源，勿走样）

- **渲染稿**：[`assets/F220/force-reset-mock.html`](assets/F220/force-reset-mock.html)（浏览器打开看三态实样）。
- **实现锚点**（Phase 3 实现对照这条，避免"写歪"）：
  - **tokens**：用真实 cat-cafe tokens——`--semantic-critical`（危险红）/ `--semantic-warning`（升级警告）/ `--cafe-surface` / `--border`，**不要 hardcode 颜色**。
  - **两态对比**：① 默认入口 = `dashed-top` 分隔线 + 灰 + 小字（藏面板底、不抢眼）；② 升级态（疑似卡死：异常久 / 停止失效）= `--semantic-critical-surface` 底 + 上浮居中 + 警告色填充。
  - **弹窗**：标题「强制重置这个对话？」+ 三行（ban / check / info 三个 lucide icon → 会做什么 / 会保留什么 / 何时用）+ 按钮 `取消`(默认 focus) / `强制重置`(危险红填充)。
  - **icon**：全 lucide 线性 SVG，**不用 emoji**（`🐾` paw 例外——品牌元素，同 `ThinkingIndicator`）。
