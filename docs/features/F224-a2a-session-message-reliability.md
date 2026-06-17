---
feature_ids: [F224]
related_features: [F220, F216, F118]
topics: [a2a, session, continuation, message, bubble, dedup, reliability, queue, intake]
doc_kind: spec
created: 2026-06-04
community_issue: clowder-ai#834 (含 #813 #814 #815 #836)
---

# F224: A2A 协作的会话/消息状态可靠性（会话延续协调器 + 消息去重 + 触发合并 + 重生会话）

> **Status**: spec | **Owner**: Ragdoll (Opus-4.8) | **Priority**: P1 | **Source**: community [clowder-ai#834](https://github.com/zts212653/clowder-ai/pull/834)
>
> **F220 姊妹 feat**：F220 管"看得见 + 卡死能自救 + invocation 卡死根因"；F224 管"会话/消息状态可靠（不丢/不重/不乱）"。两者同属"信得过的猫间协作"愿景，**分属不同架构轴**——F220 = invocation-hang / slot 轴，F224 = session-continuation / message 轴。两轴只共享 `QueueProcessor` 文件，**不共享根因**（之前一直被缠在一起，导致"又 intake 又改"的错觉）。
>
> **命名注意**🔴：本 feat 引用的 `clowder-ai#813/#814/#815/#836` 是**开源仓 issue 号**，与 cat-cafe 自己的 PR 号（PR #813=F137 / PR #834=F108 / PR #836=F136 等）**纯数字撞车、毫无关系**。引用一律带 `clowder-ai#` 前缀，防 phantom-anchor 投毒。

## Why

operator要"**信得过的猫间协作**"。F220 解决了"看得见猫在跑 + 卡死能自救"，但猫@猫协作还有另一摊"信不过"——**会话状态和消息显示会出错**，让协作结果不可靠：

1. **会话延续会丢**（clowder-ai#813）：A2A 传球触发下一棒猫时，上一轮的会话上下文没被正确封存/恢复，猫"断片"。
2. **消息会重复显示**（clowder-ai#814）：猫主动 `post_message` 的气泡，被随后的 invocation stream 当成同一条匹配替换/重影，用户看到消息重复。
3. **触发会冗余执行**（clowder-ai#815）：同一次 A2A 传球被重复入队/执行，浪费算力 + 状态乱。
4. **重生会话没策略**（clowder-ai#836）：某些猫该"每次叫醒从头开始"（不延续上下文），系统却没有机制表达这个意图，被迫走延续逻辑。

> 价值锚：让用户**信得过**猫间协作的会话与消息状态——**不丢**（延续不断片）、**不重**（消息不重影）、**不乱**（触发不冗余、会话策略明确）。这是 F220"信得过的猫间协作"愿景在"会话/消息状态"维度的补齐。

## Current State / 现状基线（带证据，不美化）

社区贡献者**吴浪（GitHub @mindfn）**在 `clowder-ai#834` 已**发现 4 个 bug 并出了初版修复**（+1215/-65，24 文件，lint + biome + 4 套测试全绿）：

- 4 个 bug **都是真的**——cat-cafe maintainer 侧（平行 opus-47 在 #834 公开回复）确认 "the four bugs you identified are real (we feel them too)"。
- 吴浪的实现是 **inline 风格**：passive seal / reborn guard 织进 `QueueProcessor.executeEntry` 的 finally 块（散落 4 处）、A2A 在**出队时 filter**、前端用 `isExplicitPost` flag 串联多个文件。
- **终态架构倾向**（opus-47 在 #834 提出，吴浪同意）：continuation lifecycle 抽成 **SessionContinuationCoordinator 服务**、A2A 改 **enqueue-time 合并**（而非 dequeue filter），不再 inline 织入 finally。
- **不属于本 feat 的深水区**：invocation 卡死（has()=false slot / cancel-preempt / slot ownership）是 F220 Phase 2 + `#2053` 的 territory，**吴浪 #834 没碰**，本 feat 也不碰。

协作现状：**吴浪同意不 as-is merge #834**，开放协作（原话 "No further pushes from our side unless you request coordination"），#834 保持 OPEN 作 reference。**球在 cat-cafe 侧**。

## What

四个 Phase 对应 4 个 bug + 架构收口。**Phase 的精确切分（尤其 coordinator 形态）待 Design Gate 出设计图后定**（见 OQ-1）；下列先按 bug 自然边界组织。

### Phase A: 会话延续 + 重生策略（clowder-ai#813 + #836）
会话延续被动封印（passive seal：lazy write thread metadata `pendCont:<catId>:<userId>`，下次同猫 invocation 开始时 consume；多猫安全限 `targetCats.length===1`；跨用户 userId-scoped field；Redis Lua 原子 HGET+HDEL 防并发双消费）+ 重生会话策略（`memberSessionStrategy: Record<CatId,'resume'|'reborn'>`，reborn 强制新 session + 跳过 bootstrap digest + 跳过 continuation consume/enqueue）。终态收口到 SessionContinuationCoordinator。

### Phase B: 消息去重（clowder-ai#814）
explicit `post_message` 气泡无 stream identity（不带 `canonicalInvocationId`）→ 不被 invocation stream 按 stable key 匹配替换/重影。前后端一致（client `useAgentMessages` + server `callbacks.ts` persistence path 都 strip stream block）。

### Phase C: A2A 触发合并（clowder-ai#815）
同一 A2A 传球 **enqueue-time 合并**（不是 dequeue filter）；批量执行失败不丢数据（成功路径才 consume）。

### Phase D: 架构收口 + 社区一致
continuation lifecycle（seal / consume / reborn）从 `QueueProcessor.executeEntry` finally 块收口到 **SessionContinuationCoordinator**（形态见 OQ-1）+ 社区不分叉（吴浪按设计图改 #834 merge **或** cat-cafe 实现 + full-sync 覆盖，二选一，避免双源）。

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC ① trace 回 Why 的某诉求 ② 非作者可复核（命令/数字/截图）。 -->

### Phase A（会话延续 + 重生策略）
- [ ] AC-A1: A2A 传球后会话延续正确封存 + 下次 invocation 恢复；多猫安全、跨用户隔离、原子消费（Redis-backed 红测，非纯 in-memory——LL feedback_inmemory_store_tests_miss_redis_behavior）。→ Why#1
- [ ] AC-A2: reborn 猫每次新 session + 跳过 continuation/bootstrap；resume 猫保持延续；断言下游元数据（`session_init.sessionLifecycle` 等），不只 prompt。→ Why#4

### Phase B（消息去重）
- [ ] AC-B1: explicit post_message 气泡不被 invocation stream 匹配/替换/重复显示（前后端一致，含 hydration 后场景）。→ Why#2

### Phase C（A2A 触发合并）
- [ ] AC-C1: 同一 A2A 传球不冗余执行；批量失败不丢数据。复核：invocation-queue 红测（enqueue-time 合并 + 失败重试）。→ Why#3

### Phase D（架构收口 + 社区一致）
- [ ] AC-D1: continuation lifecycle 收口（不再散落 finally 块）——具体形态以 Design Gate 设计图为准（coordinator service 或等价收口层）。→ Why（可维护性，支撑 #1/#4 不再 inline 脆裂）
- [ ] AC-D2: 社区与 cat-cafe **不分叉**——终态落地后二选一（吴浪 #834 按图改 merge / cat-cafe 实现 + full-sync 覆盖）；吴浪 commit 留痕、4 bug 在 canonical timeline 到达社区用户。→ Why（信得过协作 = 社区版也一致）

## Dependencies

- **Related**: F220（姊妹 feat，同 dispatch cell 不同架构轴）；F216（route-serial / invocation lifecycle 同域）；F118（A2A spawn signal）
- **Blocked by**: 无硬阻塞；终态架构设计（OQ-1）是 Phase A 动手前置。

## Risk

| 风险 | 缓解 |
|------|------|
| in-memory store 测试掩盖 Redis 索引/分页行为（LL-feedback_inmemory_store_tests） | store-backed 查询模式改动用 Redis-backed 或模拟索引/分页的 stub red 测 |
| 改 continuation/生命周期路径漏断言下游元数据 | 断言所有输出维度（session_init.sessionLifecycle 等），不只 prompt |
| 让社区贡献者实现还没定型的核心架构 | 先 Design Gate 出设计图，再 request 吴浪按图改；图未定不丢活给社区（OQ-2） |
| 与 F220 共享 `QueueProcessor` 文件 → 并行改冲突 | 两轴改动 cross-thread 协调；coordinator 抽取与 F220 Phase 2 invocation-hang 解耦 |
| intake 改动耦合 docs/skills 品牌名（sanitizer-invariance） | sync 前查 sanitizer-invariance（LL-feedback_sanitizer_coupling），锚定用不含品牌名段 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 从 F220 拆出独立 feat（不塞进 F220 Phase 2） | F220 Phase 2 = invocation-hang 深水区（#2053 unsound 边界）；本 feat = session/message 轴，吴浪 #834 没碰深水区。缠在一起才有"又 intake 又改"错觉；拆开后会话延续这摊干净的活可让吴浪按图改，不重复不分叉。operator 2026-06-04 signoff 立项（判为 feat 非 issue：有内聚 Why + 架构终态 + +1215 行体量）。 | 2026-06-04 |
| KD-2 | 不 intake #834 回 cat-cafe 再改 | operator 2026-06-04："intake 回来再改怕一团糟 + 版本分叉"。正路：maintainer 出设计图 → contributor 按图改 → merge，或 cat-cafe 实现 + full-sync，**二选一避免双源分叉**。 | 2026-06-04 |
| KD-3 | 协作方式 = **hybrid + 全量同步归一**（OQ-2 拍板） | operator 2026-06-04 Design Gate 拍 A，5 步：①worktree 落 coordinator skeleton + red tests（钉四象限第一刀）②merge main ③**全量同步 cat-cafe→clowder-ai**（skeleton 进开源仓——operator补的关键衔接，否则吴浪基于 #834 旧 base 改又分叉）④吴浪 rebase 到含 skeleton 的 main 接 Phase A 局部 + #814/#815 窄 PR ⑤归一。Maine Coon技术判断：跨 7 文件 + hard edge（failure restore / 多 capsule / sourceCategory 隔离）不宜纯外包，maintainer 钉核心坐标系。 | 2026-06-04 |
| KD-4 | Coordinator skeleton 先落 main，wire 留 Phase A | PR #2104 落地 `SessionContinuationCoordinator` 三接口 contract + 20 个单测，钉死 continuation lifecycle owner 与 F220 slot/cancel 边界；不提前 wire，因为 passive seal 真实接入绕不开 threadStore Redis Lua / 原子 pending store，按 hybrid 分工留给吴浪 Phase A 或后续窄 PR。 | 2026-06-05 |

## Architecture cell

Architecture cell: `dispatch` + `bubble-pipeline`
Map delta: update required（SessionContinuationCoordinator 收口层；是否升格 new cell 待 OQ-1 设计定）
Why: 复用现有 invocation / queue / session / bubble 生命周期，本 feat 补"会话/消息状态可靠性"；coordinator 是 continuation lifecycle 的收口，而非新造 store/queue。
