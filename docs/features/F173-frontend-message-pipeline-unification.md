---
feature_ids: [F173]
related_features: [F081, F123, F164, F047, F117]
topics: [frontend, thread-runtime, message-pipeline, liveness, cancel-button, queue-gating, state-machine, ghost-bubble, cli-resolve, hydration]
doc_kind: spec
created: 2026-04-22
---

# F173: 前端 Thread-Runtime State 统一（消除 dual write-path & liveness fragmentation）

> **Status**: done (realized → closed 2026-04-26 23:14) | **Owner**: Ragdoll + Maine Coon GPT-5.5 | **Priority**: P0
>
> **Closure 2026-04-26 23:14**: AC-E1/E2/E3 真闭环。Phase E (KD-1 handler unification) 做完 — useSocket-background.ts (634 行) + useSocket-background.types.ts (111 行) + useSocket-background-system-info.ts (341 行) 全部删除，业务逻辑 inline 进 useAgentMessages.ts (+1038 行)。drift risk 结构性消除 (active+bg 同一份实现)。9 PR 闭环：#1347 Phase A → #1379 hotfix3 → #1391 Phase B-3 → #1399 → #1400 → #1405 PR-A → #1411 PR-B → #1413 PR-B-2 → #1416 PR-C → #1417 Phase D → #1421 Phase E Task 1+2 → #1423 Phase E Task 6 fixture → #1426 Phase E Task 3-5 (Maine Coon GPT-5.5)。
>
> **Reopen-then-closed history**: 04-26 07:30 第一次 close 时 AC-B2 deferred 开 F177 stub 被team lead识破"虚假闭环"，11:30 reopen + 删 F177 stub，重新做 Phase E Task 3-5（Maine Coon GPT-5.5 接手实施）。23:14 真闭环：F177 stub 删除 + handler 业务逻辑真 inline + bg 文件真删除。两次反复后真闭环。教训沉淀：`feedback_no_anchor_as_followup_disguise.md` (P0 铁律)。gpt52 守护 vote 3/3 通过 (2026-04-26 第二次 close)。
>
> **Phase A merged 2026-04-23 (PR #1347, squash 3feae9563)**：mirror invariant + 单指针 routing + deterministic bubble id + invocation-driven suppression cleanup（含 fail-open）。Phase B/C/D 留 follow-up PR。
>
> **Phase A hotfix merged 2026-04-23 (PR #1352, squash b4e46761d)**：close ea0973e7 ghost — explicit invocationId threaded through all event entry points (text/tool_use/tool_result/done/error/web_search/thinking/rich_block/invocation_created). Maine Coon LGTM-6 cycles + 9 cloud Codex P1 fix cycles. CVO 2026-04-23 拍板将剩余 multi-failure race scenarios (lost done + lost invocation_created + reconnect/hydration) defer 进 Phase B (AC-B5..B10) — thread-scoped runtime consolidation 会从结构上消除这些场景。
>
> **Phase A hotfix2 merged 2026-04-24 (PR #1364, squash da928015e)**：close clowder-ai#573 dup-bubble — stream + callback + persistence 三条路径在同一逻辑响应的 invocation identity 上收口（统一用 OUTER `parentInvocationId ?? ownInvocationId`）。Hotfix 后 1352 的前端 dedup 把 dup 从偶发暴露为 100% 复现，根因是 QueueProcessor:761 broadcast 用 OUTER、route-serial/callbacks 持久化用 INNER 的 split-brain。Codex P1（A→B→A re-enqueue cross-turn merge）实测验证为 broadcast-layer pre-existing 行为，本 PR 不引入新 regression — 真要分 turn 显示需另立 Feature 改 broadcast 契约 + bubble identity。
>
> **Scope 扩展（2026-04-22 22:05 team lead指示）**：原 scope 仅 message pipeline；新事故诊断把 cancel 按钮缺失 / queue gating 失效 / spawn ENOENT 三个症状同源到 **liveness truth source fragmentation**，与 message dual-write 是同一个病。team experience："不要小修小改"——一锅端。

## Why

### 触发事故（同 thread / 同 day / 同根因家族）

| 时间 | 现象 | 当时归因 |
|------|------|---------|
| 4-22 21:42 | F5 后基本每个气泡都裂 | message pipeline dual write（active vs background handler） |
| 4-22 21:55 | Maine Coon正在 streaming 但前端 cancel 按钮没出 + 同时发消息走 normal send 不是 queue+steer | 前端 `hasActiveInvocation` 与"视觉上Maine Coon在流式输出"不是同一真相源 |
| 4-22 21:55 | 后端走 immediate spawn 而不是 queue → spawn `/opt/homebrew/bin/codex` ENOENT | 后端 `invocationTracker` 无 entry 判 hasActive=false；同时 `cli-resolve.ts` 进程内永久 resolvedCache 命中 stale 路径（codex 软链 21:54 被 brew/npm 重建） |
| 4-21 | stuck-after-cancel | 同类 liveness 漂移 |

### 根因：thread-runtime state 没有 single source of truth

**前端至少 5 处并行存 liveness**：
- `chatStore.hasActiveInvocation` (flat) — `ChatInputActionButton` 读这个判 cancel/queue
- `threadStates[tid].hasActiveInvocation` — per-thread 拷贝，`snapshotActive`/`flattenThread` 双向搬运
- `catStatuses[catId]` / `catInvocations[catId]`
- `activeInvocations` (per-invocation map)

**后端 2 处**：
- `invocationTracker`（进程内 Map，`messages.ts:404-413` 判 hasActive 用这个）
- `invocationRecordStore`（Redis，跨进程真相）

**Socket event 任一 drop / 乱序 / F5 hydration race** → 5 个前端字段各自漂移。"视觉看到Maine Coon在流" ≠ "store 认 hasActiveInvocation=true" ≠ "invocationTracker 有 entry"，三者独立可以同时不一致。

### 不能只修 message pipeline

F173 v1 只管 message bubble pipeline → cancel 按钮 / queue gating 这条链不会被自动修好——它读的是 `hasActiveInvocation`，不是 message 字段。同一类 dual write-path 病，要一锅端。

### 历史证据 + 反复修复

F081 Risk #1 早已预言："**写路径分散导致修复互相覆盖**"。
- F164（IndexedDB cache，2026-04-16）→ ghost bubble 涌现
- #1261（2026-04-19）修 IDB 占位过滤
- #1310（2026-04-21）修 watchdog 清 ghost stream
- Maine Coon 4-21 修 active-handler callback 不收 invocationless rich placeholder
- F39 force-send（2026-02-27）也是同源 liveness 漂移

team experience（2026-04-22 21:44）："有问题你为什么不直接走 p2？呢？ 你是不是又在绕路和做脚手架了呢？"
team experience（2026-04-22 22:05）："不要小修小改！！"

**P0 = 消除 thread-runtime state 双轨制**——messages + liveness 一起，不是再加 dedup 补丁。

## What

### 现状（dual write-path + liveness fragmentation）

| 维度 | Active 路径 | Thread-scoped 路径 | 真相源问题 |
|------|------------|-------------------|----------|
| messages | flat state.messages, `activeRefs`, `catInvocations` (active handler) | `threadStates[tid].messages`, `bgStreamRefs` (background handler) | dual handler 双指针 race → ghost bubble |
| hasActiveInvocation | flat `chatStore.hasActiveInvocation` | `threadStates[tid].hasActiveInvocation` | snapshotActive/flattenThread 双向搬运不原子 |
| catStatuses / catInvocations | flat | per-thread copy | 同上 |
| activeInvocations | flat | per-thread copy | 同上 |
| 后端 hasActive | `invocationTracker`（进程 Map） | `invocationRecordStore`（Redis） | tracker 无 entry 但 record 存在/反之 → gating 误判 |
| spawn 路径解析 | `cli-resolve.ts` `resolvedCache: Map<string,string>` | — | 永久缓存，从不清空；软链/二进制 rebuild 后 ENOENT |

> **设计校准（Maine Coon push back 2026-04-22）**：chatStore 中 `threadStates[currentThreadId]` 只是 thread switch 时的 snapshot，不是持续真相源；大量 `addMessageToThread`/`setThreadCatInvocation`/`setThreadLoading`/`addThreadActiveInvocation`/`setThreadIntentMode`/`setThreadTargetCats` 都内置 `threadId === currentThreadId` 分叉，仍然把 active 写到 flat（`chatStore.ts:53,1365,1390,1572,1645,1683,1746,1768,1843`）。F123 也已拍过 "shared helper + invariant 渐进，不把统一 MessageWriter 当前置" 路线（`F123:45,140`）。所以 P0 的直线是**先把所有 thread-runtime 写入收口到一个 thread-scoped writer**，flat 降级 compatibility mirror。**不**在 Phase A 把"删 flat"和"统一 writer"绑成一刀。

### Phase A: ThreadRuntimeWriter 收口（messages + liveness） + socket routing 统一

1. **统一 ThreadRuntimeWriter**（前端核心）：
   - **Messages 通道**：`writeThreadMessage / patchThreadMessage / appendThreadStreamChunk / appendThreadToolEvent / setThreadStreaming / replaceThreadMessageId`
   - **Liveness 通道**：`setThreadCatInvocation / addThreadActiveInvocation / removeThreadActiveInvocation / setThreadHasActiveInvocation / setThreadLoading / setThreadIntentMode / replaceThreadTargetCats / setThreadCatStatus`
   - 所有写入只走 thread-scoped 路径，flat state 在同一 `set()` 内由 writer 同步镜像（compatibility mirror）
2. **Socket routing 收口**：`agent_message` / `intent_mode` / `spawn_started` 都改用单一 handler，决策只看 `msg.threadId`，删除 `routeThread` (ref) vs `storeThread` (zustand) 双指针 guard（race 根因）
3. **Handler 合并**：`handleAgentMessage` + `handleBackgroundAgentMessage` 合为单一入口，按 `msg.threadId` dispatch 给 ThreadRuntimeWriter；background system info / toast / 进度等"非 writer 副作用"继续保留
4. flat state.messages / hasActiveInvocation / catStatuses / activeInvocations 等**保留**作 compat mirror，不在本 phase 删；读侧组件继续读 flat 不动

### Phase B: refs 全量纳入 thread-scoped runtime + background 瘦身

1. `useAgentMessages` 里所有 runtime refs 整体收口为 `Map<threadId, ThreadRuntimeRefs>`，每个 entry 至少含：`active / finalized / replaced / sawStreamData / pendingTimeoutDiag / timeoutHandle / lastTouched`。**保持 runtime-only，不进 zustand**。
2. `useSocket-background.ts` 瘦身为 ≤ 30 行 shim（仅做 toast/进度等非 writer 副作用），message creation 路径全部走 Phase A 的 ThreadRuntimeWriter。
3. GC 策略：① thread delete 硬删；② `done/error/callback replace/resetThreadInvocationState/reconnect reconcile` 后若该 thread 无 active slots 且 refs 全空 → 立刻删；③ `setCurrentThread`/reconnect 时 sweep 一次长 idle entry。**不引入后台定时器**。

### Phase C: 读侧 selector 迁移 + hydration 简化 + 前后端 liveness 对齐

1. **读侧组件迁移**：从 flat state 切换到 thread-scoped selector（`useThreadMessages(threadId)` / `useThreadLiveness(threadId)` 等），用 zustand `subscribeWithSelector + shallow` 控制重渲染。**`ChatInputActionButton`** 必须从 selector 读 hasActiveInvocation，禁止读 flat 字段。
2. **`mergeReplaceHydrationMessages`** 删除 ghost-tolerance 分支（来源不再产生 ghost）。
3. **前后端 liveness reconcile**：`fetchQueue` 拿到的 `activeInvocations` 必须直接覆盖 thread-scoped state，不再"if currentThread 才写"分叉；socket reconnect 触发的 `reconcileInvocationStateOnReconnect` 与 backend `invocationTracker.list()` 对齐，单一 reconcile 路径。
4. 跨场景回归测试（F5 / thread switch / socket reconnect / cross-post / 并发多猫 / cancel-during-stream / queue+steer）全绿。
5. F081 AC-B2 关闭。

### Phase D: 环境/缓存防腐（cli-resolve）

> 与 thread-runtime state 是不同 layer，但同事故现场 + team lead"不要小修小改"指示 → 一锅端。

1. **`cli-resolve.ts` cache invalidation**：spawn ENOENT 时 `resolvedCache.delete(command)` 让下次重解析；可叠加 file mtime 校验（每次命中前 stat 一下，mtime 变了重解析）。
2. 加单测覆盖"软链/二进制 rebuild 后 ENOENT 必须自愈"。

### Phase E（可选 / TD）: flat compat layer 退休

如果 Phase C 完成后 flat state 已无独立读者，开一个轻量 TD 移除 flat mirror。**不在 F173 主路径强制做**。

## Acceptance Criteria

### Phase A（ThreadRuntimeWriter + Routing）— ✅ Merged PR #1347 (squash 3feae9563, 2026-04-23)
- [x] AC-A1: ThreadRuntimeWriter helpers (`mirrorActiveToThreadStates` + `mirrorActiveFlat`) 收口所有 thread runtime 写入
- [x] AC-A2: `agent_message` / `intent_mode` / `spawn_started` 走单指针 routing（删 `routeThread` vs `storeThread` 双指针 guard）
- [x] AC-A3: flat state 由 writer 在同一 `set()` 内同步镜像（compatibility mirror）
- [x] AC-A4: chatStore 所有 `setThreadX` + flat `setX` active 分支全部走 mirror helper
- [x] **A.3 deterministic bubble id**: `deriveBubbleId(invocationId, catId)` 让两个 handler 创建同一 bubble id 一致 → hydration merge 自然 dedup
- [x] **A.6 shared replaced-invocations module**: 双向 suppression handoff（process-singleton Map）
- [x] **A.12 invocation-driven cleanup**: navigation 不清，invocationless flow fail-open 防永久 drop

### Phase B（runtime refs 收口 + background 瘦身）
- [ ] AC-B1: 所有 runtime refs 合并为 `Map<threadId, ThreadRuntimeRefs>`（active/finalized/replaced/sawStreamData/pendingTimeoutDiag/timeoutHandle/lastTouched），保持 runtime-only
- [ ] AC-B2: ~~`useSocket-background.ts` 缩为 ≤ 30 行 shim~~ ~~**重新规划 2026-04-25**: end-state 是 0 行（删除整文件），不留 shim~~ ~~**再次重新规划 2026-04-26 (deferred / re-scoped → F177 接棒)**~~ — **2026-04-26 11:30: F177 stub 撤销，handler unification 直接做，归到 Phase E (AC-E1/E2)**。PR-D 开工实地审计揭示 `handleBackgroundAgentMessage` (~500 行) 不是 dead code，是 active live runtime path；删整文件等价于 KD-1 handler unification。把它抽到 F177 stub 是话术包装，team lead push back: debt = never。归到 Phase E 直接做。`recoverStreamingMessage` / `ensureBackgroundAssistantMessage` / `shouldSuppressLateBackgroundStreamChunk` / `markThreadInvocationActive/Complete` 不是 Phase C 后才 dead 的，它们是 `handleBackgroundAgentMessage` 的内部 helper，被 ~500 行 live business logic（active→bg stream 恢复 / callback replacement / late chunk suppression / tool placeholder / toast/status）调用。Phase C 关闭了 **writer 端**双路径（KD-2 mirror invariant），但 **event handler 端**（active 走 useAgentMessages.onMessage / background 走 handleBackgroundAgentMessage）仍是双实现。删整文件需要把 background handler 业务逻辑迁到 thread-aware useAgentMessages，是真正的 KD-1 handler unification 改动，不是 cleanup，单独立项再做。Phase C 主线（read 收口 + writer 收口 + hydration 收口 + liveness 收口）至此完成。
- [ ] AC-B3: GC 三规则就位（delete 硬删 / done+empty 立刻删 / setCurrentThread+reconnect sweep idle）
- [ ] AC-B4: thread switch 不再触发 ghost bubble（fixture 验证）— **重新规划 2026-04-25**: fixture 抽出作为 pre-Phase C 独立小 PR（B-3 fixture）由Ragdoll own，给 Phase C 大改动提供回归基础设施。**Fixture 已 merged via PR #1391 (squash `94180b490`, 2026-04-25 09:42)**：3 条 invariant 锁定（routing isolation / concurrent isolation / terminal correctness），Phase C 改 hydration 时此 fixture 必须保持绿。AC-B4 完整闭合（含真实 race window 修复）等 Phase C。

#### Phase B Backlog: 双失/三失场景 race（hotfix PR #1352 cloud Codex 累积发现）

`fix/f173-phase-a-hotfix` 是 Phase A merge 后的 ea0973e7 ghost hotfix。修了 8 处 fix（4-piece + 4 cloud P1）后云端 Codex 仍持续发现"done lost + invocation_created lost + reconnect/hydration"等多失场景的 race。team lead 2026-04-23 拍板：hotfix 现在 ship（原 ea0973e7 已修），剩余 race 进 Phase B 与 ledger consolidation 一并解决（thread-scoped runtime refs 会从结构上消除这些场景）。

下表是 Phase B 必须覆盖的 follow-up backlog（来自 PR #1352 cloud Codex review 的真实 finding）：

- [ ] **AC-B5**: invocationless 终端事件（legacy `done`/`error` 无 `msg.invocationId`）在 `activeRefs` 已 clear（thread switch / hydration）后必须能 finalize 已 bound 的 streaming bubble；当前 hotfix 的 Loop 2 unbound fallback 拒绝 bound bubble，导致 stuck-streaming 状态（cloud P1#10）。
- [ ] **AC-B6**: `invocation_created` boundary 路径下 `markReplacedInvocation` 已升级为 `Set<invocationId>`，但旧 invocationId 只在 thread-level cleanup 时整体清掉；长会话下应在"该 invocation 真正 terminal + confirm-no-late-window"后用 `removeReplacedInvocation` 做细粒度回收，避免内存/维护债（Maine Coon LGTM-5 非阻塞观察 + cloud P2 multi-value）。
- [ ] **AC-B7**: 多个 stale unbound bubble 共存（reconnect / hydration）时，`invocation_created` 只 rebind 最新一个；其他 unbound bubble 应被 finalize 或 GC，不能继续作为"unbound 抽奖池"被 callback / late event 误捕。
- [ ] **AC-B8**: callback path 的 strict-callback 契约（clowder-ai#305 absorb）与 stream→callback 关联机制需要在 thread-scoped runtime 重写，目前依赖 `extra.stream.invocationId` 严格匹配 + activeInvocations fallback 兜底，结构脆弱。
- [ ] **AC-B9**: `shouldSuppressLateStreamChunk` 当前用"explicit `msg.invocationId` 优先 / 无则 catInvocations 兜底"+"surgical clean stale catInvocations"组合（cloud P1#6）。Phase B thread-scoped runtime 应直接用 `lastObservedExplicitInvocationId` 替代 catInvocations 兜底，消除 surgical clean。
- [ ] **AC-B10**: 终端 permissive fallback 的 binding policy 现在用 slot-fresh 信号差异化（slot-fresh confirmed → 任何 streaming bubble；否则 → 仅 binding 匹配 / unbound）。Phase B 应让 `isStaleTerminalEvent` 显式返回 confirmation source，避免在 callsite 重新计算 slot-fresh。

**Phase B 不需要逐条修这 6 条 AC**——thread-scoped runtime + ledger consolidation 完成后，这些 race 应该从结构上消失（每个 thread 单独的 runtime entry，不再共享可变 refs）。AC-B5..B10 是验收清单，不是单独修复任务。

### Phase C（读侧迁移 + hydration 简化 + liveness 对齐）
- [ ] AC-C1: 关键读侧组件（ChatContainer/MessageList/RightStatusPanel/MissionHub/**ChatInputActionButton**）改为 thread-scoped selector
- [ ] AC-C2: F5 后 0 ghost bubble（fixture 含 race window）
- [ ] AC-C3: socket reconnect 期间收的 events 在重连后正确合并到现有 bubble，不裂
- [ ] AC-C4: cross-post + 当前 thread stream 同时进行不裂
- [ ] AC-C5: `mergeReplaceHydrationMessages` 简化（移除 ghost-tolerance 分支）
- [ ] AC-C6: **cancel 按钮一致性**：只要后端 `invocationTracker` 有 entry，前端 `hasActiveInvocation` 必为 true（fixture 验证 socket-drop / F5 / reconnect 三场景）
- [ ] AC-C7: **queue gating 一致性**：发消息时前端门禁与后端门禁判定结果一致（fixture 验证）
- [ ] AC-C8: F081 AC-B2 (Remaining Gaps) 关闭

### Phase D（cli-resolve 防腐）
- [x] AC-D1: `cli-resolve.ts` 双管齐下：缓存命中时 `existsSync(cached)` 自维护 + 导出 `invalidateCliCommand(commandOrPath)` 显式信号（cli-spawn 的 ENOENT handler 自动调用，by-key 和 by-resolved-path 都支持） — PR #1417
- [x] AC-D2: 单测覆盖"binary 删除后自愈" + "invalidate by absolute path"（双路径都钉） — PR #1417

### Phase E（KD-1 handler unification — reopen 后新增）
- [x] AC-E1: `useSocket-background.ts:handleBackgroundAgentMessage` 业务逻辑 (~500 行) 迁到 thread-aware `useAgentMessages`；`useSocket.ts:485-534` 双路径合并为单一 thread-aware handler 调用 — PR #1421 (single dispatch) + PR #1426 (handler inline + 3 个 bg 文件真删除)
- [x] AC-E2: 5 场景 fixture 复用 PR #1391/#1413/#1416 + cross-thread handoff fixture (PR #1423)。PR #1418 a2a_handoff hotfix 的 marker-gated insert 仍保留作可选语义标签（unified handler 不再依赖 marker 路由）
- [x] AC-E3: thread_mo6 复现的"前端渲染裂气泡"消失 — Phase E single dispatch + handler unification 后单一 bubble id 创建路径，此类 race 从结构上消失。`useAgentMessages-cross-thread-handoff.test.ts` 3 测试钉 active→bg→active 切换 deterministic id 不变量 (PR #1423)

## Dependencies

- **Evolved from**: F081（write-path audit 已识别 dual-pipeline 风险，AC-B2 未闭合）
- **Related**:
  - F123（bubble runtime correctness fixture matrix）
  - F164（IndexedDB cache，ghost bubble 涌现源头之一）
  - F047（Queue Steer，liveness 漂移导致 queue gating 失效）
  - F117（Delivery Lifecycle，invocation 生命周期一致性）

## Risk

| 风险 | 缓解 |
|------|------|
| Scope 扩太大（messages + liveness + cli-resolve）回归面广 | Phase A/B/C/D 分阶段合入，每段独立 alpha 验收；fixture matrix 跑全；cli-resolve 是独立 sidecar 可以单 PR 先合 |
| zustand selector 派生 flat state 性能下降 | subscribeWithSelector + shallow equal；benchmark 关键 hook 渲染次数 |
| 删 background handler 路径影响 multi-thread split-pane / mission-hub | split-pane / mission-hub 监听本就用 threadStates，路径统一后更一致；保留 background 行为（toast/进度），删的是 message creation 路径 |
| ChatInputActionButton 改 selector 后 cancel/queue/normal 三态切换有边缘 case | 先把现状 fixture 化（F123 matrix 扩 cancel/queue/normal 矩阵），改完跑全 |
| 后端 invocationTracker ↔ Redis record 也存在分裂（不在 F173 直接修） | 留 Open Question OQ-3，后端 liveness 收口可能需要独立 feat（隔壁诊断 #2 路径） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不在 hydration merge 加 dedup 补丁 | team lead magic word "脚手架" + "绕路了"；F081 已预言写路径分散 = 反复出 bug | 2026-04-22 |
| KD-2 | flat state 降级 compatibility mirror，**不**在 Phase A 删 | Maine Coon push back：直接 selector-only 把"统一 writer"和"删 flat"绑成一刀，scope 过大；F123 已拍 shared helper + invariant 渐进路线。先收口写入，flat 由 writer 同步，读侧迁完后再决定退休（Phase E / TD） | 2026-04-22 |
| KD-3 | runtime refs 保持 runtime-only（不进 zustand），用 `Map<threadId, ThreadRuntimeRefs>` 单一聚合 entry；GC 三规则（delete 硬删 / done+empty 立刻删 / switch+reconnect sweep idle），不引入后台定时器 | refs 是过程性数据不该污染 store；聚合 entry 避免散成多张 top-level Map；GC 由 lifecycle 事件驱动比定时器更可预测 | 2026-04-22 |
| KD-4 | socket routing 一并收口 `intent_mode` / `spawn_started`，不只 `agent_message` | Maine Coon指出 race 不只在 message 路径；只收 message 路径，invocation owner 注册仍会双写，ghost 根因换壳回来 | 2026-04-22 |
| KD-5 | **F173 scope 扩展为 thread-runtime state（messages + liveness）一起统一，不只 message pipeline** | 4-22 21:55 事故诊断把 cancel 按钮缺失 / queue gating 失效 / spawn ENOENT 同源到 liveness fragmentation；team experience"不要小修小改"——一锅端，避免 F173 v1 修完 cancel/queue 这条链还得另开 feat | 2026-04-22 |
| KD-6 | cli-resolve cache invalidation 作 Phase D sidecar 一起合，不单独 hot fix | 同事故现场 + team lead"不要小修小改"指示；3-5 行代码 + 单测，独立 PR 即可，不污染 thread-runtime 主架构 | 2026-04-22 |
| KD-7 | 后端 `invocationTracker` ↔ Redis record 收口暂不纳入 F173 | 后端 liveness audit 是 layer 不同的工作（涉及跨进程一致性），独立立项更清晰；F173 已经覆盖前端 + 环境层 | 2026-04-22 |

## Review Gate

- Phase A: Maine Coon（架构 review，writer + routing 正确性） + Siamese（视觉回归守护）
- Phase B: Maine Coon（refs 迁移 + GC 策略） + Codex（测试覆盖）
- Phase C: 跨家族 review（read-path migration） + team lead愿景守护（cancel/queue UX 一致性）
- Phase D: Maine Coon / Codex（cli-resolve 单测）

## 需求点 Checklist

- [ ] dual handler 合并为单入口（messages + liveness）
- [ ] thread-scoped runtime refs Map
- [ ] socket routing 收口 agent_message + intent_mode + spawn_started
- [ ] hydration merge 简化
- [ ] ChatInputActionButton + queue gating 走 selector，前后端 liveness 对齐
- [ ] cli-resolve cache invalidation
- [ ] F081 AC-B2 闭合
