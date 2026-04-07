---
feature_ids: [F148]
related_features: [F102, F042, F024]
topics: [context-engineering, multi-agent, memory]
doc_kind: spec
created: 2026-03-31
---

# F148: Hierarchical Context Transport — 分层上下文传输

> **Status**: done | **Owner**: Ragdoll + Maine Coon | **Priority**: P1 | **Completed**: 2026-04-02

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
| VG-1 | `coverageMap.retrievalHints` 硬编码空数组，briefing 卡片"证据 N 条"永远显示 0 | bug | [#916](https://github.com/zts212653/cat-cafe/issues/916) / PR #919 | ✅ merged |
| VG-2 | briefing 卡片 UX：来源标识 + 默认折叠 + 展开态 retrieval hints（team lead runtime 实测反馈 2026-04-02） | enhancement | [#917](https://github.com/zts212653/cat-cafe/issues/917) / PR #920 | ✅ merged |
| VG-3 | threadMemory 是文件操作账本，缺决策/产物粒度（含 GPT Pro structured state ledger 建议） | enhancement | [#918](https://github.com/zts212653/cat-cafe/issues/918) / PR #922 | ✅ merged |

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

## Review Gate

- Phase A: Maine Coon review（Maine Coon全程参与设计讨论，最熟悉约束）
