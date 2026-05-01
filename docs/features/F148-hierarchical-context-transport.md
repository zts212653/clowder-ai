---
feature_ids: [F148]
related_features: [F102, F042, F024]
topics: [context-engineering, multi-agent, memory]
doc_kind: spec
created: 2026-03-31
---

# F148: Hierarchical Context Transport — 分层上下文传输

> **Status**: done | **Owner**: Ragdoll + Maine Coon | **Priority**: P1 | **Phase A-E Completed**: 2026-04-02 | **Reopened**: 2026-04-19（导航轴优化）| **Phase F-H Completed**: 2026-04-21 | **Closed**: 2026-04-25

## Why

当一只猫被 @-mention 冷启动进入一个活跃 thread 时，当前的 `assembleIncrementalContext` 会以 flat 方式投喂最多 200 条 × 10K chars 的原始消息，消耗 160K-216K tokens 的 context 预算，**在猫猫开始思考前就耗尽了大部分上下文窗口**。信噪比极低——绝大多数是中间往返讨论，不是关键决策。

这是team lead当前最大的痛点："增量上下文的传输太胖了"。

team experience（2026-03-31）：
> "我觉得感觉最重要的，增量上下文的传输"
> "最便宜的 haiku 把它带到沟里面去了"（关于 cheap-model summarization 的失败实验）

## What

将 flat incremental delivery 改为分层 context packet，大幅提升信噪比，同时容忍现有基建（threadMemory）覆盖率不足的现实。

### Phase A: Smart Window + Tombstone + Evidence Recall

改造 `assembleIncrementalContext()`（route-helpers.ts），从 flat N=200 改为：

1. **Recent burst**（不是固定 last-N）：从 cursor 尾部向前取最近一个完整交互 burst（默认 4-8 条，按 silence gap ≥15min 切分，不切断 question→answer / tool-call→result 语义链）
2. **Coverage tombstone**：被跳过的消息区间生成结构化摘要（~40 tokens，零 LLM 成本）：
   - omitted count + time range
   - active participants
   - 2-4 个零成本提取关键词（TF-IDF from omitted messages, query = composite: thread.title + user message + recent 1-2 non-system msgs）
   - 1-2 条 retrieval hints（指向 search_evidence）
3. **Evidence recall**：用 composite query（thread.title + 当前 user message + 最近 1-2 条非系统消息）跑 evidence.sqlite BM25，best-effort 500ms timeout，top 2-3 hits 注入为外部知识
4. **Tool payload scrub**：非最后一跳的 tool-call 结果压缩为 digest line（`<tool_result truncated: search_evidence returned 45 rows>`）

**预期效果**：context 从 160K-216K tokens → 25K-40K tokens（降 80%+），不依赖 threadMemory 覆盖率。

### Phase B: Self-Serve Retrieval Enhancement

增强猫猫的主动检索能力，让 L4（self-service）成为真承诺：

1. **`search_evidence` 加 `threadId` 过滤**：猫可以说"在这个 thread 里搜 Redis CAS"
2. **`get_thread_context` keyword 升级**：从 substring match 升级为有排序/相关性的检索
3. **工具边界明确**：search_evidence 负责"找"，get_thread_context 负责"看"

### Phase C: Importance Scoring + Anchors

在 Phase A tombstone 基础上，从 omitted 消息中选出高价值 anchors：

1. **零成本 importance scoring**：structural signals（code blocks, @-mentions, reactions）+ positional signals（burst boundaries）+ BM25 with composite query（同 Phase A KD-3：thread.title + user message + recent msgs）
2. **Anchor injection**：top 2-3 highest-scoring omitted messages 作为 anchors 注入 tombstone 和 hot tail 之间
3. **Thread opener / primacy anchor**：首条消息或 thread title 作为 primacy anchor

### Phase D: Structured State

1. **threadMemory 升级**：从活动日志（工具+文件）升级为产物导向（区分 read/write，列出创建的文档）
2. **Coverage map JSON**：GPT Pro 提出的 coverage 对象（omitted ranges, freshness, retrieval hints）

### Phase E: Context Briefing Surface

team lead愿景（2026-04-02）：
> "让 You 在 @ 完猫后的那几秒，立即看见系统给这只猫喂了什么、略过了什么、下一步该怎么查；同时不把这张卡再反向污染猫的上下文。"

系统自动生成、线程内就地展示的 context briefing 卡片：

1. **系统自动注入**：routing layer（route-serial/route-parallel）在 smart window 触发时，自动往 thread 插入 briefing 卡片，猫无感知、无额外 token 消耗
2. **UI-only / non-routing**：briefing 不进入后续 `assembleIncrementalContext` 投喂，不参与 evidence 索引，不污染猫的上下文
3. **默认折叠**：折叠态一行（看到 N 条 / 省略 N 条 / 锚点 N 条 / 记忆 N sessions / 证据 N 条），展开态显示 participants、time range、anchor 文本、threadMemory 摘要
4. **数据来源**：直接复用 `CoverageMap` 对象（Phase D 已产出），零后端改动

## Acceptance Criteria

### Phase A（Smart Window + Tombstone + Evidence Recall）✅
- [x] AC-A1: cold-mention 场景下 context tokens 降低 ≥70%（对比现有 flat delivery）
- [x] AC-A2: recent burst 不切断语义链（question→answer, tool-call→result 保持完整）
- [x] AC-A3: tombstone 包含 omitted count、time range、participants、keywords、retrieval hints
- [x] AC-A4: evidence recall 用 composite query，500ms timeout，fail-open
- [x] AC-A5: tool payload scrub 对非最后一跳的 tool 结果生效
- [x] AC-A6: 现有热路径（warm mention，cursor gap 低于可配置阈值）行为不变

### Phase B（Self-Serve Retrieval Enhancement）✅
- [x] AC-B1: search_evidence 支持 threadId 过滤参数
- [x] AC-B2: get_thread_context keyword 有排序/相关性能力
- [x] AC-B3: 两个工具边界清晰（找 vs 看），无功能重叠

### Phase C（Importance Scoring + Anchors）✅
- [x] AC-C1: zero-cost importance scoring 实现（不调用 LLM）
- [x] AC-C2: top 2-3 anchors 注入到 context packet
- [x] AC-C3: primacy anchor（thread opener 或 title）始终包含

### Phase D（Structured State）✅
- [x] AC-D1: buildThreadMemory 区分 read/write，产出产物清单
- [x] AC-D2: coverage map JSON 对象随 context packet 投递

### Phase E（Context Briefing Surface）✅
- [x] AC-E1: smart window 触发时系统自动插入 context briefing 到 thread（猫无感知）
- [x] AC-E2: briefing 不进入后续 assembleIncrementalContext 投喂（non-routing 硬约束）
- [x] AC-E3: 折叠态一行显示核心指标（看到/省略/锚点/记忆/证据数量）
- [x] AC-E4: 展开态显示 participants、time range、anchor 文本、threadMemory 摘要

### Phase F（Intent + Baton Context）✅
- [x] AC-F1: `extractBatonContext` 从消息历史提取最后一个 @-mention 的传球上下文（谁传的、什么时候、原文摘要）
- [x] AC-F2: 优先使用 canonical `mentions` 元数据匹配，regex 仅作 legacy fallback（`safeParseMentions` 返回 `[]` 时正确降级）
- [x] AC-F3: 同一说话者先说"别动/等等"再 @-mention → `staleHoldWarning: true`（矛盾检测，KD-7 球权死锁案例）
- [x] AC-F4: `origin: 'stream'` 消息的 excerpt 清空（思考内容不可见），stale-hold 检测跳过 stream 消息
- [x] AC-F5: `summarizeActiveTasks` 返回 top 3 活跃 task（非 done，按 updatedAt 排序）
- [x] AC-F6: `formatNavigationHeader` 渲染 `[导航]...[/导航]` 块（baton + tasks，KD-8：给数据不给结论，无 intent 分类标签）
- [x] AC-F7: 导航 header 在所有路径注入（cold + warm + empty-return，KD-7：独立于 smart window）

### Phase H（Artifact Deterministic Tracking）✅
- [x] AC-H1: `RecentArtifact` 类型 — `{ type: 'pr' | 'file' | 'plan' | 'feature-doc', ref: string, label: string, updatedAt: number, updatedBy: string }`，ThreadMemoryV2 新增 `recentArtifacts: RecentArtifact[]`（max 5，向后兼容）
- [x] AC-H2: SessionSealer 落盘时从 `filesTouched`（已有）+ PR tracking tasks 提取 artifacts 写入 ThreadMemory.recentArtifacts（确定性，不靠 regex）
- [x] AC-H3: 导航 header `[导航]` 新增"最近产物"行（有 artifacts 时显示 top 3，无则不显示——不加噪音）
- [x] AC-H4: Briefing 卡片展开态新增"产物"section（复用 AC-H1 数据，AC-E4 扩展）
- [x] AC-H5: 原 regex artifact 提取（`extractDecisionSignals` 的 `ARTIFACT_PATTERN`）保留作为 fallback，确定性 > regex 优先级
- [x] AC-H6: 测试覆盖：artifact 录入（SessionSealer 路径）/ 导航渲染（有/无 artifacts）/ ThreadMemory 向后兼容（v1→v2 读入无 recentArtifacts = []）

### Phase G（Goal & Grounding — 真相源定位 + best-next-source）✅

> **设计来源**：GPT-5.4 作为 Phase H 用户的反馈（2026-04-20）："H 回答'最近有什么'，G 要回答'猫第一眼该看哪个真相源'"
> **核心原则**：排序层，不是摘要层。确定性规则，不用 LLM/classifier（KD-8）。

- [x] AC-G1: **Thread-level artifact ledger** — `buildThreadMemory` 从 overwrite 改为 append+dedup+cap（上限 20 条，按 updatedAt 淘汰最旧）。跨 seal 累积，不只保留最近一次。`ThreadMemoryV1.recentArtifacts` 升级为 ledger 语义
- [x] AC-G2: **Source ranking** — 新增 `rankArtifactSources(ledger, activeTasks, threadMeta)` 纯函数，确定性优先级：① `thread.backlogItemId → workflowSop.featureId` canonical binding（一等信号，已在 route-serial 工作）② feature doc from canonical featureId ③ open PR（活跃 pr_tracking task）④ 最近修改的关键文件。Fallback：thread title / task title regex `F\d{2,3}` 仅在 canonical binding 缺失时启用。无 LLM，无 classifier
- [x] AC-G3: **Single best-next-source** — 从 ranked list 取 top-1，格式化为可行动指针（如 `先看 F148 spec: docs/features/F148-*.md`）。导航 header 新增 `真相源: {label}` 行
- [x] AC-G4: **Fail-closed confidence** — provenance-based（不发明 score schema）：canonical binding 命中 = 高确定性直接展示；regex fallback 命中 = 展示但标注 `(推断)`；ranked list 为空 = `真相源: 未定位`。不编造、不猜测
- [x] AC-G5: **UI 分层** — 导航 header：`真相源: {label}` + `下一步: {best-next-source}`（2 行，最小可行动信息）；briefing 展开态：完整 ledger 列表 + ranking 理由
- [x] AC-G6: **测试覆盖** — ledger 累积（跨 seal append+dedup）/ ranking 纯函数（各优先级路径）/ fail-closed（空 ledger / 无匹配）/ 导航渲染（有/无真相源）/ backward compat（旧 threadMemory 无 ledger）

## Dependencies

- **Evolved from**: F102（记忆系统 — evidence.sqlite 是 L3 的基础）
- **Related**: F042（三层信息架构 — 分层思想的上层决策）
- **Related**: F024（中途消息注入 + Context 存活监控）
- **Related**: F143（Hostable Agent Runtime — context packet 需要跨 provider 统一）

## Risk

| 风险 | 缓解 |
|------|------|
| burst 切分算法误切语义链 | 保守默认（silence gap ≥15min），加 semantic chain detection（Q→A, tool→result） |
| evidence recall 召回错题（query 质量差） | composite query（title + user msg + recent msgs），不只用 @-mention text |
| warm mention 场景被误改 | Phase A 只改 cold-mention 路径（gap > 可配置阈值），warm path 保持不变 |
| threadMemory 覆盖率低（~4%）导致 L1 空洞 | Phase A 设计为完全容忍 L1 缺失，tombstone + evidence 兜底 |
| tool payload scrub 误压缩关键信息 | 只压缩非最后一跳，最后一跳保留完整 |

## Vision Guard Gaps（愿景守护发现，close 前须修复）

来源：Phase E 愿景守护（2026-04-02），Maine Coon GPT-5.4 + 金渐层独立评估。

| # | Gap | 类型 | GitHub Issue | 状态 |
|---|-----|------|-------------|------|
| VG-1 | `coverageMap.retrievalHints` 硬编码空数组，briefing 卡片"证据 N 条"永远显示 0 | bug | [#916](https://github.com/zts212653/clowder-ai/issues/916) / PR #919 | ✅ merged |
| VG-2 | briefing 卡片 UX：来源标识 + 默认折叠 + 展开态 retrieval hints（team lead runtime 实测反馈 2026-04-02） | enhancement | [#917](https://github.com/zts212653/clowder-ai/issues/917) / PR #920 | ✅ merged |
| VG-3 | threadMemory 是文件操作账本，缺决策/产物粒度（含 GPT Pro structured state ledger 建议） | enhancement | [#918](https://github.com/zts212653/clowder-ai/issues/918) / PR #922 | ✅ merged |

### VG-3 设计方案（2026-04-02 Ragdoll + Maine Coon Spark 收敛）

**方案**：B+A 组合 — AutoSummarizer conclusions 为主 + regex 即时兜底。不一步到位 L1a/L1b。

**架构**：
1. **DecisionSignals** 结构：`decisions[] / openQuestions[] / artifacts[] / sources[]`
   - 来源 1：SessionSealer 扫描 transcript regex（即时，覆盖最近 session）
   - 来源 2：最近 ThreadSummary 的 conclusions/openQuestions（补强，已预计算）
   - 在 SessionSealer 层组装，不污染 buildThreadMemory 纯函数
2. **ThreadMemory v2**（向后兼容）：保留 `summary/sessionsIncorporated/updatedAt`，新增可选 `decisions/openQuestions/artifacts`。旧 v1 读入时自动填空数组
3. **buildThreadMemory 双轨输出**：一行 session 账本 + 结构化决策数组（去重 + 上限 8/5/8）
4. **briefing 展开态新增"关键决策"**：`format-briefing.ts` 渲染 decisions（最多 3 条）+ openQuestions（最多 2 条）

**实施拆分**（3 commit）：
- Commit 1: `signals 抽取` — DecisionSignals 结构 + SessionSealer regex + ThreadSummary 接入
- Commit 2: `threadMemory v2` — 向后兼容升级 + buildThreadMemory 双轨
- Commit 3: `briefing 展示` — format-briefing 渲染决策 + 前端展示

**验收测试**：有/无 summary × 有/无 regex 的 4 组合 + briefing 展开态 "关键决策" 断言

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 不用 cheap-model summarization | Haiku 实验证明 cheap 摘要误导 Opus，增加总成本。Claude Code 也用主模型做 autoCompact | 2026-03-31 |
| KD-2 | Phase A 设计为容忍 L1（threadMemory）缺失 | 96% 的 thread 没有非空 threadMemory，硬等 L1 成熟不现实 | 2026-03-31 |
| KD-3 | evidence recall 用 composite query 而非纯 @-mention text | Maine Coon指出 "@opus 帮看下" 这种 mention text 对 BM25 几乎没信号 | 2026-03-31 |
| KD-4 | search_evidence 负责"找"，get_thread_context 负责"看" | 工具边界清晰，避免功能重叠 | 2026-03-31 |
| KD-5 | GPT Pro 主骨架 + Gemini 局部好点子 | GPT Pro 更贴我们真实代码和约束；Gemini 的 prompt caching 和 source tagging 独到 | 2026-03-31 |
| KD-6 | VG-3 用 B+A（AutoSummarizer + regex），不一步到位 L1a/L1b | MVP 先闭环；DecisionSignals 在 SessionSealer 层组装保持纯函数可测试性 | 2026-04-02 |
| KD-7 | 导航层独立于 smart window（warm mention 也注入） | 即使只有 5 条未读，猫也需要 Intent/Baton/Task。球权死锁案例证明不能靠猫从历史消息推理 | 2026-04-19 |
| KD-8 | 不用 intent classifier（regex/小模型都不行）— 给数据不给结论 | 猫自己是 LLM，给了 @ 原文 + baton 事件 + task 列表，猫自己推理 intent。regex 分类器 = 认知脚手架，错误标签比没标签更糟（meta-aesthetics §2.3 + §3.4） | 2026-04-19 |

## Phase F-J: 导航轴优化（2026-04-19 Reopened）

> **来源**：team lead + Ragdoll复盘（2026-04-19），基于 `docs/canon/meta-aesthetics.md` 的第一性原理审视。
> **核心命题**：F148 Phase A-E 解决了"太胖"（token 降 80%），Phase F-J 要解决"不够聪明"——从 information delivery 升级为 situation awareness。

### 导航缺口（7 个，含圆桌新增）

> **猫冷启动第一屏该回答的 4 个问题**（圆桌共识 + team lead修正）：
> 1. 为什么叫我（Intent）— Intent 解码好了，传球方向自然就清楚了
> 2. 球怎么来的、做完往哪传（Baton Context）— team lead修正：被 @ 了球已经在你手上，"球在谁手上"是废话；真正有价值的是传球链上下文
> 3. 真相源在哪（Task / Artifact / Spec）
> 4. 不够时下一步查什么（Guided Navigation）

| # | 缺口 | 现状 | 期望 | 来源 |
|---|------|------|------|------|
| N-1 | Tombstone 有结构没叙事 | TF-IDF 关键词碎片 | 一句话故事弧（利用 SessionSealer/AutoSummarizer 输出） | Ragdoll复盘 |
| N-2 | Intent 上下文缺失 | 猫看不到 @ 原文和传球链 | 把 @ 消息原文 + baton 事件呈现给猫，由猫自己推理 intent（KD-8：给数据不给结论） | Ragdoll复盘 → **team lead修正**：不用 classifier |
| N-3 | 毛线球（Task）不在视野里 | context packet 无 task 信息 | 活跃 task 及状态纳入 briefing | Ragdoll复盘 + team lead确认 |
| N-4 | Artifact 链路不可靠 | regex 碰运气（覆盖率低） | 确定性记录机制 | Ragdoll复盘 |
| N-5 | Self-serve 反馈不闭环 | selfServeRetrievalCount 只记不回流 | 度量导航成功率（不只是 count） | Ragdoll复盘 + gpt52 精炼 |
| N-6 | 跨 thread 无 bridge | per-thread 孤岛 | cross-thread context bridge | Ragdoll复盘 |
| N-7 | Baton Context（传球链上下文） | 猫不知道球怎么来的、做完往哪传 | 上一棒是谁+做了什么 / 当前 task owner+reviewer / intent 暗含的传球方向 | **gpt52 提出 → team lead修正**：被 @ 了球已在手上，"球在谁手上"是废话，有价值的是传球链 |

附加维度（内嵌到上述 Phase，不独立）：
- **Freshness/Confidence 轴**（codex 提出）：每个导航槽位带时间标记 + 可信度
- **Authority/Boundary 轴**（codex 提出）：与 N-7 合并

### 触发条件（Phase A-E 现状）

F148 smart window 仅在**冷启动**场景触发（`route-helpers.ts:601-619`）：

| 触发条件 | 阈值 | 含义 |
|----------|------|------|
| Count trigger | `relevant.length > 15` | cursor 后超过 15 条未读消息 |
| Token trigger | `totalTokens > 10,000` | 消息少但内容胖（长代码块/工具结果） |

`isColdMention = countTrigger || tokenTrigger`。Warm path（未读 ≤15 且 token ≤10K）F148 完全不介入。

> **KD-7**（2026-04-19 team lead拍板）：导航层（Intent/Baton/Task）独立于 smart window，warm mention 也注入。理由：即使只有 5 条未读，猫也需要知道"为什么叫我"和"球怎么来的"。
>
> **关键场景**（team lead提供的球权死锁案例）：
> - t0: Maine Coon说"我在干活，你别动" → 此刻 true
> - t1: Maine Coon @Ragdoll（球权转移）→ "我在干活"变 false
> - t2: Ragdoll冷启动，看到"你别动" → 把 t0 快照当 t2 现况 → 不动 → 死锁
>
> 根因：消息内容是过去的快照，球权是实时状态。系统应提供球权实时快照 + 矛盾检测，不靠猫从历史消息推理。

### Phase F-J（圆桌收敛后确定）

> **排序依据**：`Agent Quality = Model Capability × Environment Fit`。模型能力短期不变，先提升 environment fit 的"可行动性"收益最大。
>
> **圆桌参与**：Ragdoll（发起 + 复盘）、Maine Coon codex（独立排序）、Maine Coon GPT-5.4（独立排序 + N-7 提出）。Siamese gemini 未能参与（待补充视觉/认知体验视角）。

| Phase | 内容 | 缺口 | 状态 |
|-------|------|------|------|
| **F** | Intent + Baton Context — 为什么叫我 + 球怎么来的/做完往哪传 | N-2 + N-7 | ✅ merged (PR #1286 + #1292) |
| **G** | ~~Task + Narrative~~ → **Goal & Grounding** — 真相源定位 + best-next-source + navigation-first briefing card | N-3(已部分完成) + N-1(降级) → N-4 grounding | ✅ merged (PR #1303 + #1312) |
| **H** | Artifact Deterministic Tracking — 确定性产物记录 | N-4 | ✅ merged (PR #1297) |
| **I** | Eval Baseline — 导航成功率度量（不只是 count） | N-5 | 🔀 de-scoped（运维度量，非用户可感知导航，独立立项） |
| **J** | Cross-thread Bridge — 跨 thread context bridge | N-6 | 🔀 de-scoped（全新跨 thread 能力，独立立项） |

> **2026-04-20 优先级调整**（Ragdoll + GPT-5.4 共识，team lead确认）：
> - 原 Phase G（narrative tombstone）价值偏低——还是压缩轴微调，不是导航轴突破；且与 briefing 卡片信息重复
> - N-3（Task 纳入导航）Phase F 已完成（navigation header + briefing 卡片都有了）
> - N-1（tombstone narrative）降级为 polish，不占独立 Phase
> - **H（确定性 artifact tracking）提前**：没有可靠真相源 → grounding 只能靠猜 → 猜不如不给
> - G 重定义为 "Goal & Grounding"（真相源定位 + best-next-step），等 H 做完再拆 AC

> **2026-04-20 Briefing Card 概念收敛**（GPT-5.4 提出 + Ragdoll确认 + team lead拍板"别搞出两个概念"）：
> - **一个概念**：`F148 Context Briefing Card`。Phase E 定义的 briefing 卡 = Phase G 的真相源展示面 = 同一张卡
> - **两个视图**：猫看 prompt 里的 `[导航]` header（navigation header）；team lead看线程里的 UI 卡片（briefing card）。两者是同一份数据（`coverageMap + briefingContext + rankedSources`），不是两张卡
> - **冷启动无真相源也显示**：卡片 fail-closed 为 `真相源: 未定位` + `下一步: {检索建议}`，不隐藏
> - **折叠态 3 项**：`为什么叫猫` / `真相源` / `下一步`（待team lead确认具体组合）
> - **下一步**：后续 Phase 把现有 briefing 卡的team lead可见性做到"第一眼可依赖"，不新建概念

## Review Gate

- Phase A: Maine Coon review（Maine Coon全程参与设计讨论，最熟悉约束）
