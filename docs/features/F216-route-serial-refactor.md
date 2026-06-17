---
feature_ids: [F216]
topics: [architecture, refactor, routing]
doc_kind: spec
created: 2026-05-30
---

# F216: routeSerial 决策层/执行层分离重构

> **Status**: done ✅ (PR #1987/#1991/#1997/#2002/#2003/#2008/#2010 已全部合入，F216-c3 抢占重启与 Steer UX 加固均通过 alpha 验收与 review；未竟复杂度重构已作为独立技术债挂载) | **Owner**: @opus48（设计 from F215-thread handoff + 执行 owner） | **Priority**: P1 | **Source**: internal (F215 引爆点)
>
> **最终 close 口径（2026-06-02 第三方愿景守护 @gemini25 signoff）**：F216 交付的是 **last-wins/supersede 用户价值 + routing decision 可测性**，**不是 routeSerial 瘦身**。complexity 255 未降已确认为独立技术债条目（不是 F216 尾巴），由 [Siamese/Gemini 3.5 Flash (High)🐾] 完成最终愿景守护 signoff。

Architecture cell: `routing`
Map delta: routeSerial 从 2302 行单函数拆为决策层(纯函数) + 执行层(for-await yield)

## Why

routeSerial 是 Cat Cafe 的核心路由引擎——所有 A2A 串行调度、mention 路由、callback、F215 relay 都经过这个函数。当前状态：

- **2302 行单函数**，cognitive complexity 255（biome noExcessiveCognitiveComplexity 报 warning 但被豁免）
- **5 套并行路由路径**（inline mention / deferred mention / callback A2A / F215 malformed relay / executed-relay dedup）共享同一个可变 `worklist`
- **15+ 可变状态变量**（`attemptHasContentOutput`、`suppressedMalformedError`、`shouldRetryWithoutSession` 等）在同一个作用域互相影响
- 加任何路由决策都笛卡尔积式炸 edge case——F215 relay 是引爆点（r5→r6→r7 补丁引补丁，7 轮 review）

**不重构的代价**：后续每个路由相关 feature 都会重演 F215 的 7 轮 review 循环。脆弱度已 6/10。

## What

### Phase A: 执行单元化（降脆弱度）

把 routeSerial 的 for-await 循环中的每个路由决策（mention / relay / deferred / callback）抽成独立函数，各自返回"worklist 扩展清单"而非直接 mutate worklist。

**Before**: 5 处 `worklist.push(...)` 散落在 for-await 循环的不同分支里
**After**: `resolveNextCats(signal, context) → CatId[]`，for-await 循环只负责 `worklist.push(...resolved)`

### Phase B: 决策/执行分离

将路由决策逻辑提取为**纯函数**（输入：当前 signal + context + config → 输出：routing decision），可独立单测。执行层（for-await invokeSingleCat + yield）保持不变。

### Phase C: 状态机化（如需）

如果 Phase B 后状态变量仍然耦合过深，考虑显式状态机（state enum + transition table）。这是 Phase C 是否需要做的判断依据——Phase B 后如果够了就不做。

## 硬约束（F215 踩坑知识，必须遵守）

1. **F215 relay 行为零回归**——有 16 测试 + 真实 runtime 守护过的兜底链（seal→fresh→46 接力 + partial-output 诚实文案），重构不能破任何一个
2. **坐标变换不是堆补丁**——这正是 F215 栽进雷区处（r5→r6→r7 都是局部补丁，最后 sonnet 开干了 route-serial 的真接力才解决）；routeSerial 重构必须做到"一次改对坐标系"
3. **真实 runtime 验证（LL-064）**——routeSerial 比 F215 更核心，merge 前必须真 runtime + 真截图 + 刻意触发多路由场景，绝不只信单测
4. **跨族 review 强制**——5 套路由耦合最易出 edge case，必须Maine Coon族 review

## Context 卫生安排（operator directive）

> ⚠️ "fresh" 的语义（operator 2026-05-30 纠正，防后人重蹈）：**fresh = 相对 F215 的纯粹，NOT 再开空白 thread**。
> handoff 的初心是「接 F216 的猫不背 F215 重构的 context 包袱」——F215-thread 的 opus-48 立项后把 spec
> 交给一只 **context 是 F216 而非 F215** 的 opus-48。**承接 coalesce bug 的本 thread 就是那只 fresh 猫**：
> 从头到尾 context 都是 F216（coalesce bug = Phase D 引爆现象），零 F215 污染。再开 thread = fresh 到失忆，
> 丢掉 F216 自己积累的宝贵上下文（abort-resume 雷区 / 3 个回归教训 / reviewer nit）= 违背初心。
> **owner 持续是承接它的 opus-48，不换猫。**

- **立项**：F215 thread 的 opus-48（亲历 F215 踩坑知识最全 → spec 最准）→ handoff 给 context 纯 F216 的 opus-48
- **执行**：context 纯 F216、无 F215 污染的 opus-48（= 初心所指的 "fresh"；coalesce bug 的全部上下文是 routeSerial 重构的资产，不是污染）
- **双向防污染**：F215 回归时不被 routeSerial 重构 context 干扰，反之亦然

## Risk

- **高风险**：改比 F215 更核心的路由路径
- **缓解**：Phase A 先降脆弱度（不改行为），Phase B 再分离（有 Phase A 保护），渐进式不一步到位
- **兜底**：16 个 F215 测试 + 全量 route 测试 + LL-064 真实 runtime 验证

## Dependencies

- F215 close 后开始（runtime 守护验证完）
- 不依赖其他 feature

## AC（验收标准）

### Phase A — superseded by design change (不是 F216 close 的验收目标)
> Phase A 的"执行单元化 / worklist.push 收敛一处"路线，在 Phase B/D 落地时被"决策层(纯函数返回
> RoutingDecision[]) + 执行层局部 apply + supersede"路线**取代/de-scoped**。Phase A 是早期设计草案，
> **不是已完成**——下面三条不作为 F216 close 验收目标，剩余风险（routeSerial 本体仍多处 push/可变状态）
> 转入 routeSerial complexity 技术债（见 AC-B2 备注）。
- [~] AC-A1: ~~每个路由决策点提取为独立函数~~ → superseded（决策抽成单个 `resolveRoutingDecisions` 纯函数，非"每点独立函数"）
- [~] AC-A2: ~~worklist.push 只出现在一处~~ → superseded（执行层逐 cat apply，push 未收敛到单点；转技术债）
- [~] AC-A3: ~~F215 16 测试 + 全量 route 测试零回归~~ → 由 Phase B/D 的零回归验证覆盖（330 + alpha 22/22 全绿）

### Phase B
- [x] AC-B1: 路由决策是纯函数，可独立单测（无 side effect）— c1.2 `resolveRoutingDecisions`（`routing-decision.ts`）+ `routing-decision.test.js` / `routing-decision-streak.test.js`（PR #1987）
- [ ] AC-B2: **NOT ACHIEVED** — cognitive complexity 未下降。实测（2026-06-02，`pnpm exec biome lint`）routeSerial 仍是 **complexity 255**，与立项时完全相同。B1 达成的是**可测性**（决策逻辑抽成纯函数可单测），不是 complexity reduction。routeSerial 本体 255→瘦身**转独立技术债**（见 Links），不作为 F216 close 阻塞项（operator scope 判定：F216 = bug 修复价值，瘦身另记）。
- [~] AC-B3: F216 touched paths（inline-mention c1.3 + queue-pending/deferred c2）已 runtime/alpha 验证（330 单测 + alpha a2a-coalesce 22/22）。**relay 路径有意保留独立 battle-tested block，不接入统一决策层（de-scoped）**——relay no-change 由 F215 relay regression 覆盖。不是"三路都接统一层"。

> **PR #1987（c0–c1.3）已合入 main（squash `32f88814e`，2026-05-31）**。Maine Coon GPT-5.5 跨族 review 两轮（R1 三个 P1 全修 red→green：caller-scope 生产 lookup 漏接 / multi-target streak 陈旧快照 / pnpm check import-sort；R2 Findings: none 放行）+ 云端 codex review（1 个 P2 docs frontmatter，已修）。
> **本 PR 落地**：c0 caller-scope（`findInFlightAgentEntry` 第 3 参）+ c1.1 `peekStreakOnPush` 纯读预判 + c1.2 `resolveRoutingDecisions` 纯决策函数 + c1.3 inline-mention 接线（副作用留执行层）。
> **PR #1991（c2）已合入 main（squash `d3966c85d`，2026-05-31）**：queue-pending（deferred）A2A 路径接入 `resolveRoutingDecisions`（逐 cat resolve+apply，非 batch，避免 P1-2 stale-streak），三条路径（inline/relay/queue-pending）统一决策层。Maine Coon跨族 review 三轮（R1 3 P1：followup-tails subject / defer_queue 未计 depth / P2 fix 漏提交；R2-3 Findings: none 放行）+ 云端 codex review（0 findings）。
> **剩余**：c3（supersede 执行层 = Phase D processing 主场景 — operator报的"at 两次同猫，第一条已 processing 时 abort 重启"那个 bug 的主场景）。

### Phase C（conditional）
- [~] AC-C1: **不做** — Phase B 后评估：routeSerial 本体的可变状态耦合**未解**（complexity 仍 255，见 AC-B2），但显式状态机化（state enum + transition table）属于"routeSerial 瘦身技术债"范畴，不在 F216 bug-fix scope 内。Phase C 转入技术债，不单独做。

### Phase D: A2A same-turn handoff supersede（driven by 2026-05-30 coalesce bug）
> 来源：operator报 bug「post msg at 了两次同一只猫 → 第一条先执行（可能错误行动），第二条又独立执行」。
>
> **已独立交付（不依赖 F216）**：queued-merge —— 第一条还 queued（没开跑）时，同 turn 重复 handoff
> 合并进同一 entry（`coalesceContentIntoQueuedAgent`），并把后续 handoff coalesce 进 queued follow-up，
> 不再丢 caller 真实意图。见 `InvocationQueue.findInFlightAgentEntry/coalesceContentIntoQueuedAgent`
> + `callback-a2a-trigger.ts` Guard 2。
>
> **为何 supersede 归 F216**：主场景（第一条已 `processing`）唯一正确解是 abort 正在跑的 handoff +
> 用 follow-up 重启。这条 abort→slot cleanup→pause→resume 时序与 routeSerial / QueueProcessor 的
> abort-resume 坐标系同源，独立硬接会和后台 `executeEntry` cleanup 抢 `processingSlots` mutex
> = 硬约束 #2 警告的 LL-064 式堆补丁。在干净坐标系上一次做对。

- [x] AC-D1: processing 中的 target 收到同 turn follow-up → abort 正在跑的 + 用 follow-up（last-wins）重启，不重跑被 supersede 的第一条（PR #1997）
- [x] AC-D2: abort+restart 不引入 `processingSlots` mutex race（复用 force-send 的 cancelInvocation+clearPause+releaseSlot 已验证模式 + tombstone guard）（PR #1997）
- [x] AC-D3: 真实 runtime 验证——猫连发两条矛盾 handoff 给同一只猫，目标猫只执行最终意图，不先跑错第一步（正式 alpha 验收 PASS：`pnpm alpha:start` 隔离环境，a2a-coalesce 22/22 + process-liveness 15/15）
- [x] AC-D4: queued-merge（已交付）零回归——22 个 a2a-coalesce + 85 queue-processor 测试全绿（PR #1997）

#### Review nits 收口（PR #1971 已交付后的 reviewer 建议，归 Phase D 一并清理）
> 来源：antig-opus（Bengal Opus，云端 codex 额度耗尽替补）completed review of `3654ea9d9`，3 个 non-blocking。
- [x] AC-D5: vote 路径 `missed` check 排除 `coalesced` voters（PR #2002）
- [x] AC-D6: `MessageDeliveryService` 在 coalesce（enqueued=[] + coalesced>0）时不误报 warn（PR #2002）
- [x] AC-D7: `callback-a2a-trigger.ts` emit `queue_updated` action='coalesced' 语义准确（PR #2002）

## Review Gate

- Phase A/B: 跨族 review（Maine Coon族 reviewer，改核心路由路径强制）
