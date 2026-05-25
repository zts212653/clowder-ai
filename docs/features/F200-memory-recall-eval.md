---
feature_ids: [F200]
related_features: [F102, F153, F163, F188, F192]
topics: [memory, eval, observability, IR]
doc_kind: spec
created: 2026-05-14
---

# F200: Memory Recall Eval — 基于猫真实行为的记忆系统反馈闭环

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

## Why

### 问题

Cat Cafe 的记忆系统（F102 存储基座 + F163 治理层 + F188 管护工具链）已经能"记住"和"治理"知识，但**不知道猫用得好不好**。现有 telemetry（F188 三入口分布 + nudge follow + grep fallback rate）已有 adoption/friction 信号，但缺少 **search result → read/use/verify 的正向 consumption 信号**。我们无法回答：

- 搜索结果排第几的被猫真正读了？
- 猫搜了几轮才找到想要的东西？
- 花了多少 token？
- graph 推荐的候选有没有被 follow？
- 一个 anchor 90 天没人读是不是该 sunset？

### team lead启发（2026-05-14 原话摘录）

> "如果猫猫搜了 evidence 然后他决定用任何方式去读了 evidence 去推荐的文档！！是不是可以算真实命中！你想哦！！你们在 agentic search 的时候！！可是要决定要不要往下读！！"

> "有的时候行为能暴露出你们对于这些东西的判断的！！！"

> "比如猫猫目前的任务 xxxx，猫猫搜索了 xxxx 看了 xxx 文档 修改了 xxx 干了啥啥啥，最后产出 yyyy，我倒是觉得这个轨迹很值钱，搜集的多了都能优化我们的系统"

> "这些可是不需要大模型就能做的！！"

### MemOS 对照（2026-05-12 华为研讨会 teardown 启发）

MemOS 2.0 用 LLM 自评（R_human）+ 数学公式（γ/α/V/η/support/gain）给每条记忆打分。Maine Coon代码级拆解发现根信号有毒：模型自评集中在 0.6-0.85 成功区间，负样本几乎没有，他们在 `gain.ts` 自承认原公式在真实环境塌掉（`apps/memos-local-plugin/core/memory/l2/gain.ts:19-29`）。

**我们的 tradeoff 选择**：不给 truth/authority 打分，只给 **navigation utility** 打分。根信号来自猫的真实 tool call 行为，不是 LLM 自评。consumption 信号只能影响搜索排序和导航优先级，不能影响 authority（authority 仍来自 spec/ADR/review/CVO）。

### 信号层 → Phase 对应关系

| 信号层 | 行为 | 收集 Phase | 使用 Phase |
|--------|------|-----------|-----------|
| L0 | 搜了 | A | B（统计） |
| L1 | 搜了 → 读了某条候选（revealed preference） | A | C（改排序，shadow first） |
| L2 | 搜了 → 读了 → 引用/修改了 | D | D（task trajectory） |
| L3 | 搜了 → 读了 → 用了 → 产出被验证 | D | D+（闭环） |

**Phase C 只吃 L1 信号**。L2/L3 需要 Phase D 的 TaskTrajectory 才能收集。

### 为什么这是独立 Feature 而不是 F192 的子 Phase

F192 是 harness 层面的社会技术评估框架（共创机制 + harness-feedback 文档 + eval contract）。F200 是记忆子系统的专项反馈闭环，需要：新的 event correlation 机制、新的指标族、对 search/graph 排序的实际改进。F192 提供评估框架，F200 在这个框架里建具体的 memory recall eval pipeline。

## What

### Phase A: Search Session Telemetry（打地基）

在 F153 observability 基础上，为每次 memory tool 调用建立 `RecallEvent` 概念：

```typescript
interface RecallEvent {
  recallId: string;
  catId: string;
  invocationId: string;
  toolName: 'search_evidence' | 'graph_resolve' | 'list_recent';
  query: string;
  mode?: string;
  scope?: string;
  candidates: Array<{
    anchor: string;
    rank: number;
    score?: number;
    targetRef:                  // Maine Coon R2：union ref 覆盖所有 drill-down 目标
      | { kind: 'doc'; sourcePath: string; anchor?: string }  // anchor fallback for sourcePath-empty candidates (Phase A P1-1)
      | { kind: 'thread'; threadId: string }
      | { kind: 'session'; sessionId: string }
      | { kind: 'invocation'; sessionId: string; invocationId: string }
      | { kind: 'passage'; passageId: string; threadId?: string; sessionId?: string };
    docKind?: string;           // feature/decision/lesson/discussion/...
    resultSetId?: string;
  }>;
  consumed: Array<{
    anchor: string;
    rank: number;
    method:                     // Maine Coon R2：覆盖全部 drill-down 工具
      | 'Read' | 'Grep' | 'graph_resolve'
      | 'read_session_events' | 'read_session_digest'
      | 'read_invocation_detail' | 'get_thread_context';
    dwellProxy?: number;        // 47：Read 后到下一个 tool call 的间隔(ms)
  }>;
  reformulated: boolean;
  fellBackToGrep: boolean;
  abandoned: boolean;
  nextGraphResolveAfterRead: boolean;  // 47：graph 深度导航信号
  tokenCost: number;
  timestamp: number;
}
```

**Consumption Window 定义**（OQ-1 resolved, 三猫收敛）：

```
consumed := same_invocation
            AND (tool_call_distance ≤ 20 OR wall_clock ≤ 300s)
            AND target_match(tool_call, candidate.targetRef)
```

- **target_match**（Maine Coon R2 扩展）：不只是 `Read.file_path ↔ sourcePath`，还覆盖 `read_session_events ↔ sessionId`、`get_thread_context ↔ threadId`、`read_invocation_detail ↔ invocationId` 等 drill-down 匹配
- **invocation 边界**优于纯 wall-clock（LLM thinking/A2A callback 波动大）
- **tool_call_distance**比时间更稳定（20 步覆盖"搜→想→读"的典型链）
- **300s 兜底**防止超长 thinking 丢信号
- **Grep 分类**：grep 路径命中 candidate.targetRef.sourcePath → drill-down consumption；全仓 `rg` → fallback，不算 consumed
- v1 上 shadow mode，跑 1 周后看 P95 再 finalize 参数

### Phase B: Derived Metrics（无模型指标族）

核心指标（注：这里不是标准 IR relevance judgment，是 consumption 信号，命名区分）：

| 指标 | 公式 | 揭示什么 |
|------|------|----------|
| **Consumed@K** | `P(至少一个 top-K 候选被 consumed)` | 搜索召回质量 |
| **Readthrough@K** | `consumed_in_topK / K`（fraction） | 排序密度（top-K 里有几个值得读） |
| **ConsumedMRR** | `mean(1 / first_consumed_rank)` | 排序质量 |
| **FirstConsumedRank** | `median(first_consumed_rank)` | 排序中位数表现 |
| **Reformulation Rate** | `P(同 invocation 连续搜索)` | query/index 匹配度 |
| **ReformulationsBeforeConsumption** | `mean(search_count_before_first_consumed)` | 几轮才找到 |
| **SearchAbandonRate** | `P(搜了但没 consumed 也没 reformulate)` | 候选全不对 |
| **ReformulateAfterExposure** | `P(reformulate within compound_window AND no consumed AND tool_call_distance_to_next_search ≤ 3)` | 看了候选但觉得不对，立刻又搜（区别于 Abandon：Abandon 是静默放弃，这里是主动换 query） |
| **GrepFallbackRate** | `P(grep fallback \| candidates exposed)` | 摘要/标题不可信（Phase C 加 topConfidence 后可细化为 high-confidence 版） |
| **Token Cost per Hit** | `total_tokens / consumed_count` | 搜索效率 |
| **Anchor Popularity** | `consumed_count(anchor) over 30d` | boost 信号 |
| **Anchor Dormancy** | `days_since_last_consumed(anchor)` | sunset 候选信号 |
| **GraphNonFirstSelectionRate** | `P(consumed candidate rank > 1 \| graph_resolve)` | graph 排序质量 |
| **GraphTraversalCompletion** | `P(graph_resolve → Read → another graph_resolve)` | graph 深度导航价值 |

### Phase C: Consumption-Weighted Ranking（改排序）

**前提**：Phase C 只用 L1 信号（consumed/not consumed）。L2/L3 信号留给 Phase D。

**search_evidence 排序调整**：

```
adjusted_score(anchor, query) =
    rrf_score                               // 现有 BM25+vector RRF (k=60, 不动)
  + α · authority_boost(anchor)             // 现有 F163 权威性 (1.0-1.3)
  + β · consumption_prior(anchor)           // 新：Bayesian shrinkage CTR
  + γ · recency_decay(anchor)              // 新：fractional decay
  - δ · stale_penalty(anchor)              // 现有 F163 stale 检测
```

**consumption_prior 公式**（OQ-5 resolved, centered Bayesian shrinkage — R2 三猫收敛）：

```
shrunk_ctr     = (consumed_count_30d + α₀) / (exposure_count_30d + α₀ + β₀)
mean_ctr_kind  = global_mean_ctr(anchor.kind)       // 按 doc kind 分桶的全局基线
recency_factor = T_kind / (T_kind + days_since_last_consumed)
raw_lift       = (shrunk_ctr - mean_ctr_kind) × recency_factor

// 三段式分支（47 R2 提案 + Maine Coon R1 "exposure ≥ 20 才允许 punish" 融合）
if isConstitutional(anchor):                // 实现注意（Maine Coon R3）：EvidenceKind 没有 ADR/canon 字面值，
                                            // 用 authority + sourcePath + docKind 组合判定，不能按 kind 字面 match
    consumption_prior = max(0, raw_lift)    // 永远不降权
elif exposure_count_30d < 5:                // cold-start
    consumption_prior = 0                   // 中性：不奖不罚
elif exposure_count_30d < 20:               // 低样本
    consumption_prior = max(0, raw_lift)    // 只允许正向 boost
else:                                       // 充分数据
    consumption_prior = raw_lift            // 完整中心化，允许负值
```

- **α₀=2, β₀=8**（先验 mean=0.2，等价于"10 次曝光 2 次 click"）
- **exposure_count 用 30 天滑窗**，不要历史累计
- **中心化是关键**（47+Maine Coon R2 收敛）：v2 的纯正向 `shrunk_ctr × recency` 等于半残——"高 BM25 但 30 天 0 read"的过时 anchor 跟"高 BM25 且高 read"的活 anchor 一样排前面。减去 `mean_ctr_kind` 才有负信号
- **grace period**：新 indexed 文档 14 天内不参与 consumption_prior
- **v2 升级路径**（47 R2 #4）：v1 用 30d hard sliding window；若 shadow 发现窗口边界 anchor 排名有 day-by-day cliff，v2 升级到 event-level decay `w_i = 2^(-age_days/half_life)`

**recency_decay 公式**（OQ-2 resolved, fractional decay + 按 kind 分桶）：

```
decay(age_days, T) = T / (T + age_days)
```

| doc kind | T (half_life) | 理由 |
|----------|---------------|------|
| ADR / lesson / canon (constitutional) | **不降权** | 稳定真相源，consumption 低不代表不重要 |
| feature / decision | **90d** | 长效设计文档，半年后仍可能被新猫读 |
| plan / research / phase | **45d** | 阶段性高频，结束后冷却快 |
| discussion / reflection | **21d** | 热度集中在 1-2 周内 |
| thread / session digest | **14d** | 极短时效 |

47 的 fractional decay `T/(T+age)` 优于 exponential `2^(-age/T)`：365d 后 fractional 剩 ~20% vs exponential 剩 ~6%，长尾保护更好。

**MMR 去重**（OQ-3 resolved）：

```
MMR = argmax_i [λ · sim(d_i, query) - (1-λ) · max_j∈S sim(d_i, d_j)]
```

- **λ=0.7 起步**（Carbonell & Goldstein 1998 + TREC robust [0.5, 0.7] 区间，我们偏 precision）
- **只在 pool ≥ 3×limit 时启用**（否则没空间做多样化）
- shadow 对比 λ ∈ {0.6, 0.7, 0.8}，看 ConsumedMRR 和 Consumed@K 变化

**RRF k=60 和 pool size**：k 不动（Cormack 2009 经典值），pool 不动（max(limit×4, 20) cap 100）。先加指标 `consumed_anchor_not_in_pool_rate`，如果被 consumed 的 anchor 经常不在候选池才考虑扩 pool 或加第三路召回。

**graph edge-level 权重**（R2 Maine Coon+47 收敛，team lead点名"常用路径加权"）：

当前实现（`GraphResolver.ts:224`）遍历时所有 relation 边权重一样。F200 引入 edge-level 信号：

```
edge_weight(A → B) =
    type_base[edge.relation]                    // wikilink=1.0, doc_link=0.9, feature_ref=1.1
  + λ_edge · traversal_count_30d(A → B)        // 具体这条边被猫穿越的频率
  × edge_recency_decay(A → B)                  // 边的 access recency（fractional decay）
```

`type_base` 初始值先 shadow 观察再调。`traversal_count` = graph_resolve 返回 A，猫 Read A 后又 graph_resolve 拿到 B 并 Read B 的次数。

**graph_resolve 候选排序调整**：

```
graph_candidate_score(node) =
    text_match(query, node)
  + authority(node)
  + Σ edge_weight(source → node) · source_relevance  // 入边加权（替换 v2 的 node-level frequency）
  + consumption_recency(node)               // 新：最近有人读过
  - dormancy_penalty(node)                  // 新：90d 无人读（constitutional 免疫）
```

**实现顺序**：先 shadow mode 跑 consumption rerank 两周 → 确认 ConsumedMRR 提升 → 才切 on。

**Phase C shadow → on 切换门禁**（Maine Coon + 46 收敛 2026-05-14）：

binary consumed prior 只允许在 shadow 阶段运行。切 `on` 前必须同时满足：
1. ConsumedMRR 提升（相对 shadow baseline）
2. **无 Goodhart 迹象**：短 dwellProxy（<2s）consumed 比例不升高、reformulate rate 不升高、fellBackToGrep rate 不升高
3. **单次 consumed 永远不能直接抬 rank** — 只能通过 Bayesian shrinkage + exposure sliding window 进入统计。这是防"误点一次越排越高"的核心原则

任一条件不满足 → 不切 on，先做 `signal_strength` 加权（v1.1 upgrade path：用 dwellProxy + nextGraphResolveAfterRead 给 consumed entry 分强弱权重）。

### Phase D: Full Trajectory Records（完整轨迹）

team lead启发的最深一层。把 Phase A-C 的单次搜索视角扩展到任务级，引入 L2/L3 信号：

```typescript
interface TaskTrajectory {
  taskContext: string;          // 从 thread/mention/task 推断
  searchChain: RecallEvent[];
  filesRead: string[];
  filesModified: string[];
  outputVerified: boolean;     // 候选信号源见下方（47 R2 #5）
  catId: string;
  totalTokenCost: number;
  duration: number;
}
```

**outputVerified 候选信号源**（47 R2 #5，Phase D Design Gate 前 finalize）：

```
outputVerified = signal_or(
    PR_merged_via_squash,                   // gh PR merge event
    CI_check_passed_after_modification,     // GitHub check_run success
    CVO_explicit_accept,                    // team lead"merge"/"好"/"通过"等关键词
    reviewer_approval_with_no_followup,     // @codex/@opus 放行且无后续修改
)
```

用途：
- 成功轨迹复用（"上次做这类任务的猫搜了这些、读了这些"）
- 失败轨迹诊断（搜 5 轮 + 读 8 个文档但 review 退回 → 为什么）
- 跨猫对比找 index 盲点（同样任务，不同猫的 effort 差异——只用于系统诊断，不评价个猫）
- **Cross-Cat Effort Variance**：`std(reformulation_count) across cats for similar queries`，揭示 index/alias 对不同搜索习惯的覆盖差距
- **ConsumedButNotUsedRate**：读了但最终 commit/review/post 中没引用，可能是噪音或探索成本高

### Phase E: Cross-Cat Query Pattern Recommendation（deferred）

> Deferred until Phase A-D stable + ethical framework reviewed.

方向：会搜的猫的 query 模式 → 自动建议给不会搜的猫（"Maine Coon搜这类问题用了这个 query，Hit@1"）。这是 harness coaching，不是检索排序本体，数据依赖 Phase D 的 TaskTrajectory。

### v1.1 Dogfooding Backlog（2026-05-16 三猫两轮实测：广度 dogfood + 冷启动模拟）

三猫两轮真实调查任务实测（Round 1 广度 + Round 2 46 九路 / Maine Coon+47 冷启动模拟，刻意抛弃老猫先验）。
**核心洞察（Maine Coon一句话）**：新猫更信"第一屏"——老猫被喂偏能靠项目记忆纠偏，新猫不行。因此优先级按**入口第一屏导航正确性**排，不按工程难度排。

**修复批次（建议 46 开 worktree 按此顺序）**：

#### Batch 1 — P1 导航正确性（新猫第一屏被喂错，最先修）

| # | 问题 | 根因 | 归属 | 发现 |
|---|------|------|------|------|
| DF-1 | `list_recent(scope=docs)` 被 global:memory 淹没 + timestamp = **索引重建时间≠内容活跃时间**（kinds=feature 全标 05-16 / kinds=decision 全标 04-18，新猫无法分辨哪个是真活跃主战场）| index rebuild 刷 memory timestamp + list_recent 排序键用错维度 | **F188** | 46+Maine Coon R1 / 47 冷启动 reframe 根因 |
| DF-11 | `graph_resolve` fuzzy candidate ranking 丢失 text_match——`graph_resolve("F200 v1.1 issues")` → F102（边多）排 F200 前 | 代码 fuzzy candidates 只按 `weightedEdgeScore` 排；F200 spec 公式含 `text_match + authority + edge_weight` 但实现漏了 text_match | **F188**（实现与 F200 spec 公式不符）| Maine Coon冷启动 |

#### Batch 2 — P2 可解释性 + 跨语言

| # | 问题 | 根因 | 归属 | 发现 |
|---|------|------|------|------|
| DF-6 | `list_recent(scope=docs,kinds=["discussion"/"reflection"])` 静默返回 0，但 `scope=threads,kinds=["discussion"]` 实际可用；新猫容易把 `docs/discussions` 误归到 docs scope | `kinds` 会先与 scope ceiling 求交集，空交集直接无结果；MCP schema/description 未提示 kind 所属 scope，也无空交集 nudge | **F188** | 46 R2 / Maine Coon复核修正 |
| DF-2 | `graph_resolve` depth≥2 经 super-hub（F102/F188）边爆炸（209 nodes/439 edges），无 degree cap | hub-node fan-out 无截断；depth=1+relations filter 有 workaround | **F188** | 47 R1 / 三猫 R2 确认 |
| DF-8 | hybrid 跨语言查询退化——纯 semantic 命中的中文文档，hybrid 反而被无关高 BM25 挤掉；MCP description "不确定用 hybrid" 与实际矛盾 | RRF fusion 中英 query BM25 分极低 | **F102/F188**（检索 mode + tool description）| 46 R2 |
| DF-3 | search_evidence 只显示 `boost: authority_boost`，看不出 consumption_prior/MMR 是否参与；新猫无法判断"为什么这条排第一" | search 输出缺 explainability 字段 | **F200** | Maine Coon+47+46 多轮 |
| DF-4 | `list_recent(trajectories)` 缺 `[verified/unverified]` + filesRead/filesModified 摘要——冷启动猫无法分辨成功路径 vs 弯路 | AC-D2 半残（outputVerified 信号源只实现 2/4：PR merge + invocation status，CVO accept/reviewer approval 是 stub）| **F200**（已在 AC-D2.1/D2.2 backlog）| 47+Maine Coon 冷启动 |

#### Batch 3 — P3 边缘 case（可延后）

| # | 问题 | 归属 | 发现 |
|---|------|------|------|
| DF-7 | semantic confidence 与相关性错位（embedding 距离≠真实相关，"cat naming origin" → Architecture Map 排 high）| F102/F188 | 46 R2 |
| DF-10 | graph fuzzy 跨域假阳性（"consumption ranking" → 癌症研究 klra5，~20%）| F188 | 46 R2 |

✅ **三猫共识 OK（确认 working，不动）**：
- search_evidence 概念词召回（不知 F200 编号用"记忆系统消费加权"也能排第一）
- graph_resolve depth=1 + relations filter（13 nodes 干净可导航）
- `list_recent(scope=trajectories)` 真闭环亮点——Phase D 真在记三猫探索轨迹，"穷人的 training loop" 在工作

**冷启动结论**：harness 对新猫 graph+概念 search **确实喂饭有效**（不靠老猫记忆）；但 **list_recent 这个新猫最依赖的"零先验扫最近"入口恰恰对新猫最不可靠**（DF-1 为核心导航正确性问题；DF-6 为 scope/kinds 语义误导）——这是 F165 Guided Overfitting / F152 Expedition Memory 冷启动愿景的直接威胁，Batch 1 应最高优先。

> **归属说明**：本 backlog 横跨 F188（list_recent/graph_resolve 工具实现）+ F200（rerank_reason/trajectory）+ F102（检索 mode）。F200 spec 作为记忆系统 dogfood 反馈中枢汇总，46 开 worktree 时按归属列分别处置（F188 工具 bug 与 F200 ranking 改进不同 scope）。

### v1.2 Backlog（2026-05-17 三猫讨论：硬实力 + 软实力双修）

**触发**：team lead AUDHD recall 任务（"哪些 thread / md 沉淀过 audhd/adhd/asd"）暴露——三猫搜出**不同子集**（46 主干索引 / 47 语义扩散 / Maine Coon source-thread provenance），单 query top-k 无法满足 "X 主题在我们家有哪些沉淀" 这类 coverage/source-map 任务。

**team lead核心论点（2026-05-17 拍板）**：
> "搜索系统怎么知道 audhd 应该搜什么？而是我们可能需要有 hook 或者 mcp tools 描述要告诉猫猫如何搜索！"

→ **Query expansion 不在搜索系统做**（系统是 dumb 的，agent 是 smart 的——领域知识展开由 agent 用 LLM 能力完成）；硬实力只做"可解释的结构性 expansion"（来自 frontmatter aliases / canonical doc 内的 source threads / glossary / graph 显式 alias 边），不做黑盒猜测。引擎层 expansion 违反 KD-8（不用 regex/小模型替猫判断 intent，给数据不给结论）。

**关键发现（team lead特别问的"有没有新硬实力 bug"）**：v1.1 全部 merged 后，这一轮 dogfood **没暴露新的紧急硬实力 bug**——核心三入口 + ranking on + Phase D trajectory 都 working。三猫差异 = 检索策略偏好不同，不是引擎缺陷。所以 v1.2 是**能力补充**（coverage 模式）+ **配套软实力**（教猫怎么用），不是紧急 bug 修复。2026-05-18 runtime 重启后实测：metrics API 已 live（`GET /api/recall/metrics?days=7&refresh=1` + `X-Cat-Cafe-User`），7 天窗口内采到 **146 条 recall events / 6 条 consumed（4.11%）/ 58 条 trajectories / 380 条 anchor metrics**。这说明"其他猫、其他 thread 调用 search_evidence/list_recent/graph_resolve"已经在被记录；但有效 consumption 样本仍太少，只能看使用体感和趋势，不能据此 close OQ-6/OQ-7 这类排序策略决策。另：58 条 trajectory 里 `outputVerified=0`，说明轨迹采集已工作，但强成功信号（PR merged / CVO accept / reviewer approval / CI passed）还没自动流入。

#### 软实力（SW，1-2 天可落，先做，立刻可验证）

| # | 任务 | 描述 | Owner 候选 |
|---|------|------|-----------|
| SW-1 | **新建 `memory-search-best-practices` skill** | 题型→recipe 对照表（**8 类**）：(1) "X 是什么" (2) coverage 全集 "哪些地方提过 X" (3) 周边关系 (4) 决策考古 "为什么当时这么决定" (5) 冷启动 onboard (6) **source-map / provenance map** — 从 canonical doc 追 source threads（Maine Coon review 补） (7) **absence check** — "有没有提过 X / 证明否定"，搜索策略与 coverage 不同（Maine Coon review 补） (8) **delta** — "上次我看到的和现在有什么不同"，压缩后恢复 / Phase 间衔接典型（46 review 补）；AUDHD recall 作为 coverage 示例 5 步 recipe；**Ragdoll家族专属提示**（不许靠记忆推理，必须 ≥3 路真搜 + Read 原文，治 magic word "我能猜出来" / "碎片够了" 病）；"何时停下来"判据（≥3 路命中无新 anchor 才停） | 47 起草 / 46 review |
| SW-2 | **MCP tool description 补 SEARCH TIPS** | `search_evidence`：明示"不是全集入口"，coverage intent（"哪些 / 所有 / 历史"）要 expand+多 scope+drilldown；`list_recent`：DF-1 已修后补一句 timestamp 语义说明；`graph_resolve`：depth≥2+无 relations filter 时显式 warn hub fan-out | Maine Coon / 46 |
| SW-3 | **Hook nudge — coverage intent 识别**（轻量，不增 session-start 噪音） | 改为 **inline nudge**：search payload 末尾，**触发条件 = query 含 coverage intent 关键词**（"哪些 / 所有 / 历史上 / 提过 / 沉淀"）—— 打一条"这是 coverage 任务，单刀 top-k 不够（AUDHD 案例：每猫拿到 10 条但全集需三猫合起来），参考 memory-search-best-practices skill"。**result count ≤ N 仅作"加重提示权重"，不作触发前提**（Maine Coon P2-1：召回多 ≠ 全集，AUDHD 实证）。类比 F188 KD-7 deterministic nudge 模式 | Maine Coon |

#### 硬实力（HW，等软实力反馈 1-2 周后再定 spec）

| # | 任务 | 描述 | 前置 |
|---|------|------|------|
| HW-1 | **coverage/source-map 模式（Maine Coon 5 步 pipeline）** | (1) 分 scope 配额（每类 source 保底 top-N 避免 docs 挤掉 threads） (2) 可解释 expansion 从 canonical doc 抽 source threads + frontmatter aliases (3) union+dedup (4) 输出 coverage matrix（item/source/谁提到/直接 vs 间接/置信度） (5) 展示 expansion 来源（用户原词 / doc alias / source thread / graph edge）—— 不偷偷扩 | 等 SW-1 跑 1-2 周，从猫的实际使用模式收敛 spec（避免做出"实现正确但语义错"的硬实力，如 DF-1 list_recent timestamp 教训） |
| HW-2 | **可解释 expansion 数据源结构化** | frontmatter aliases/tags 索引化；canonical doc 内的 source-thread 链接结构化；graph 增 `alias_of` 显式边类型 | HW-1 spec 拍板后做 |
| HW-3 | **OQ-6/OQ-7 数据驱动决策** | Runtime 重启后实测：`consumed_anchor_not_in_pool_rate=0%`（阈值 15%）/ `maxAnchor≈33%`（阈值 50%）→ 当前结论方向仍是"暂不需要第三路 RRF / 暂不需要 query-conditioned prior"。但 7 天窗口只有 **146 events / 6 consumed（4.11%）**，数据太薄，**"没有证据需要行动" ≠ "有证据证明不需要行动"**——需 1-2 周 ranking on + 真实 dogfood 让数据增长后再 close。**统计窗口必须限定 post-v1.1 + post-SW**（Maine Coon P2-2）——v1.1 之前的 events 含 DF-1 timestamp 错乱 + DF-6 静默 0 + 猫还没学 coverage recipe，会系统性压低 consumption rate，拿脏数据做决策 = 错 baseline。**运行时检查**：metrics API 已 live，正确入口是 `GET /api/recall/metrics?days=...&refresh=1`，需要 `X-Cat-Cafe-User` header | dogfood 持续累积；监控 consumption rate 是否随 SW-1/2/3 落地后回升（猫学会搜→Read 链条更完整） |
| HW-4 | **P1: Consumption attribution fix（消费归因可信度修复）** | team lead challenge 成立且必须修：大规模并发搜索下，当前 consumed 是同 invocation 后续 tool event 的反推 proxy，不是真实用户点击/确认。初筛已发现 `candidates_json=[]` 高达 59.2%，且 Codex 大量 `sed/rg/nl` shell 读文件不被算作消费。Round 1 抽样已钉死三类根因：① Claude/Opus parallel 路由里 tool_result 没有可靠 merge 回 tool_use，导致 `_f200Candidates` 丢失（不是单纯正则错）；② Codex `command_execution` 读文件未进入 consumption / trajectory filesRead；③ 现有 6 条 positive 全来自 2 个 invocation，都是后续 `graph_resolve(F200)` 反推，属于 bundle-level ambiguous signal，不是 clean per-search truth。修复范围：parallel result pairing / `sourcePath` candidates / shell-read parsing / ambiguity-aware `resultSetId` 或 bundle marker。**在修复前，F200 consumption-based eval 不可信，只能看粗趋势，不能作为排序策略裁判。** | **HW-3 前置**：没有 attribution audit + 归因修复，不用 consumption 数据 close OQ-6/OQ-7 |
| HW-5 | **F209 fixture recall@k wrapper** | F209 D.0 已用 F209-owned 四项 observability 完成 Phase D unblock；但 F200 仍应把 `docs/eval/f209-phase-{a,b,c}-*.md` 纳入一键 recall@k cross-validation，输出每个 fixture 的 query、expected anchor、top-k hit、mode/depth、degraded/effectiveMode 摘要。任务：`[F200/F209] Add fixture recall@k wrapper for F209 eval docs`。 | Cross-validation follow-up；不卡 F209 Phase D product spike；不改变 runtime ranking |

#### 优先级与 sequencing

1. **现在做**：SW-1 + SW-2（1-2 天 markdown，立刻可验证 + 立刻可迭代）
2. **持续做**：dogfood 自吃猫粮（让 consumption 数据涨 + 让 skill 在真实使用下迭代修订）
3. **1-2 周后**：基于软实力使用反馈定 HW-1 spec（避免错坐标系硬实力）
4. **先审计归因**：抽样验证 consumed proxy 的 false negative / false positive / ambiguous attribution
5. **数据够且归因可信时（≥1000 events / consumption rate ≥10%，统计窗口限定 post-v1.1 + post-SW）**：close OQ-6/OQ-7

> **2026-05-18 Runtime Signal Check（说人话版）**：现在能看见"哪只猫 / 哪个 thread / 哪次 invocation / 用了哪个工具 / 搜了什么 / 返回了哪些候选 / 后面有没有 Read 或消费 / 有没有放弃或换 query / 形成了哪条 trajectory / 读改了哪些文件"。现在还不能可靠判断"排序策略一定更好"或"哪条 trajectory 一定成功"，因为 consumed 只有 6 条，`outputVerified` 强信号自动接入还是 0。GitHub PR merge 在模型里是 `pr_merged` 强信号，endpoint 支持外部注入，但自动桥接仍待接入；CVO accept / reviewer approval / CI check 同理。
>
> **2026-05-18 Consumption Accuracy Caveat（team lead挑战后补）**：当前 `consumed` 不是"猫亲口确认我用了这条结果"，而是 `RecallEventCorrelator` 在同一只猫 / 同一 invocation / 后续 20 个 tool calls 或 300s 内，用 `Read` / `Grep` / `graph_resolve` / session read 等工具事件反推的 proxy。它会漏掉很多真实消费：猫只读 search snippet 就回答、用 `sed/cat/nl` 等 Bash 读文件、读了候选里链接出去的 source thread、并发多次 search 后再读导致归因不唯一、或者超过时间/距离窗口才读。反过来，同一个后续 Read 也可能被多个前序 search 同时归因。因此 consumption 指标适合看趋势和粗粒度排序反馈，**不能当单条结果的绝对真相**。team lead拍板：这不是普通优化，是 F200 eval 可信度 P1；修复前 consumption-based eval 不可靠不可信，OQ-6/OQ-7 不能 close。初筛报告见 `docs/audits/2026-05-18-f200-consumption-attribution-audit.md`。

> **Review 状态**（2026-05-17）：Maine Coon + 46 双 reviewer pass。2 P2 patched（SW-3 nudge 改 intent 触发不绑 result count / HW-3 窗口限定 post-v1.1+post-SW），1 P3 标注（runtime metrics API sync 是 HW-3 前置）。SW-1 题型 5→8（+source-map +absence-check +delta）。Patch commit 接续 `9d475a918`。47 可直接开 SW-1（writing-skills SOP）。

> **Review focus**（请 @opus 和 @codex 各自独立 review）：
> 1. SW 先 HW 后的分层是否合理？Maine Coon之前 5 步直接当 HW-1 写的，我把它推迟到软实力反馈后再 spec——这跟 "v1.1 list_recent timestamp 实现正确但语义错" 的教训一致，但你们可能觉得太保守？
> 2. SW-1 skill 题型清单是否漏关键 case？（is-什么 / coverage / 周边关系 / 决策考古 / 冷启动 onboard）
> 3. HW-3 "consumption rate 4.3% 太薄"——我的判断是数据不足无法 close，需更多 dogfood。同意还是觉得现有数据已足够 close？
> 4. **"这次没新硬实力 bug"** 的判断准确吗？三猫这轮 dogfood 真的没撞到新的隐藏 bug？我作为 47 主要从冷启动 + AUDHD recall 验证，可能盲区——你们各自验证过的角度有没有抓到我没看到的 bug？

## Acceptance Criteria

### Phase A（Search Session Telemetry）✅
- [x] AC-A1: RecallEvent 被写入 ToolEventLog，包含 candidates（含 targetRef union + docKind）+ consumed 字段
- [x] AC-A2: consumed 通过 compound window（same_invocation + tool_call_distance≤20 + 300s cap）+ target_match 自动推断
- [x] AC-A3: reformulated / fellBackToGrep / abandoned / nextGraphResolveAfterRead 四个布尔正确标记
- [x] AC-A4: Health Dashboard 展示最近 24h 的 RecallEvent 统计摘要
- [x] AC-A5: dwellProxy（Read 后到下一个 tool call 的间隔 ms）被记录

### Phase B（Derived Metrics）✅
- [x] AC-B1: Consumed@3 / ConsumedMRR / Reformulation Rate / SearchAbandonRate 四个核心指标可通过 API 查询
- [x] AC-B2: Anchor Popularity 和 Anchor Dormancy 持久化到 evidence.sqlite 元数据
- [x] AC-B3: Token Cost per Hit 可按猫/按工具/按时间段聚合
- [x] AC-B4: GraphNonFirstSelectionRate 和 GraphTraversalCompletion 可通过 API 查询

### Phase C（Consumption-Weighted Ranking）✅
- [x] AC-C1: search_evidence 排序引入 consumption_prior（Bayesian shrinkage + 14d grace period）和 recency_decay（fractional + kind 分桶）
- [x] AC-C2: graph_resolve 候选排序引入入边加权（edge_weight × source_relevance）+ consumption_recency
- [x] AC-C3: MMR 去重在 hybrid mode + pool≥3×limit 时生效（λ=0.7 可配置）
- [x] AC-C4: shadow mode 先行：新排序 vs 旧排序的 ConsumedMRR 对比
- [x] AC-C5: consumption_prior 不影响 authority（constitutional/ADR 免疫降权）
- [x] AC-C6: `consumed_anchor_not_in_pool_rate` 指标上线，数据驱动 pool 扩展决策
- [x] AC-C7: graph edge_weight（type_base + traversal_count_30d × edge_recency_decay）用于候选排序
- [x] AC-C8: shadow 确认排序改进后，同步更新以下软约束文件的记忆系统段：`CLAUDE.md`、`AGENTS.md`、`cat-cafe-skills/refs/memory-routing-partial.md`（愿景守护检查项）
- [x] AC-C9: Memory Hub flag panel 中显示 F200_CONSUMPTION_RERANK 开关状态（CVO directive 2026-05-15）

### Phase D（Full Trajectory Records）✅
- [x] AC-D1: TaskTrajectory 按 invocation/thread 粒度聚合
- [x] AC-D2: outputVerified 推断框架（injectable signal sources + 外部注入 endpoint）上线。v1 自动检测覆盖 invocation status；PR merge / CVO accept / reviewer approval 通过外部注入 endpoint 接入
- [ ] AC-D2.1: CVO accept + reviewer approval 信号源自动检测（需解析 thread 消息）
- [ ] AC-D2.2: CI check 信号源（需 F140 GitHub check_run 集成）
- [ ] AC-D2.3: GitHub PR merge → `pr_merged` trajectory signal 自动桥接（当前 `pr_merged` 是强信号且 endpoint 支持外部注入，但 runtime 实测 58 条 trajectory 的 `outputVerifiedSignals=[]`，自动桥接尚未喂数）
- [x] AC-D3: 成功轨迹可被 list_recent 或 search_evidence 召回（scope="trajectories"）
- [x] AC-D4: Cross-Cat Effort Variance 和 ConsumedButNotUsedRate 指标上线

## Eval / Tracking Contract

| 项 | 内容 |
|----|------|
| **Primary Users** | 三猫（search_evidence / graph_resolve / list_recent 使用者） |
| **Activation Signal** | RecallEvent 写入量 > 0 / consumed 命中 > 0 |
| **Friction Metric** | ConsumedMRR < shadow_baseline × 0.8（排序劣化）/ SearchAbandonRate > 50%（候选全不对）/ Reformulation Rate > 60%（一次搜不到）。初始 baseline 由 Phase B shadow 1 周后确定 |
| **Regression Fixture** | (1) high-consumption anchor must not be demoted unless authority/stale guard justifies it (2) authority=constitutional 的 anchor 不可因低 consumption 被压制 |
| **Sunset Signal** | 6 周后 ConsumedMRR 无提升 → 回滚 Phase C 排序改动 |

## Dependencies

- **Evolved from**: F153（observability infra 提供底层 trace 机制）
- **Related**: F192（harness eval 提供评估框架 + eval contract 模板）
- **Related**: F188（library stewardship — graph_resolve / list_recent / search_evidence 的 MCP 工具）
- **Related**: F163（authority boost / stale detection — 本 feature 不改 authority 来源，只叠加 consumption 信号）
- **Related**: F102（IEvidenceStore 接口 — 新指标可能需要 schema 扩展）

## Risk

| 风险 | 缓解 |
|------|------|
| consumption ≠ correctness（读了不等于对） | Phase C 只用 L1 信号（consumed/not），L2/L3 留 Phase D。consumption 只影响 navigation utility |
| 冷启动 anchor 不公平（新文档没机会被读） | 14 天 grace period + exposure_count_30d < 5 时用全局 mean_CTR + consumption_prior 允许正向 boost 但低 exposure 不允许惩罚 |
| Goodhart 风险（猫为了指标好看乱读） | consumption 只影响导航排序，不影响 authority；authority 仍来自 spec/ADR/review/CVO |
| 高 authority 但低 consumption 的关键文档被压制 | constitutional/ADR/lesson 类 anchor 免疫 consumption-based 降权 |
| 跨猫对比引入"评价猫"的伦理问题 | Phase D 跨猫数据只用于系统诊断（index 盲点），不用于评价个猫能力。Phase E deferred |
| 热门老文档马太效应（consumption 越高排越前） | Centered lift（减去 mean_ctr_kind）+ Bayesian shrinkage + 30d 滑窗 exposure + fractional decay 四重防线 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 根信号来自猫真实行为（tool call），不用 LLM 自评 | MemOS R_human 根信号有毒（模型自评偏乐观）；猫的 Read 是 revealed preference，跨厂商一致 | 2026-05-14 |
| KD-2 | consumption 只影响 navigation utility，不影响 authority | 防 Goodhart：读得多 ≠ 真相更高。authority 仍来自 spec/ADR/review/CVO。constitutional 类 anchor 免疫降权 | 2026-05-14 |
| KD-3 | Phase C 新排序必须有 shadow mode（A/B 可观测） | 继承 F163 KD-9：所有能力 gated、observable、A/B-testable | 2026-05-14 |
| KD-4 | consumption_prior 用 Bayesian shrinkage（不是简单计数） | 简单计数偏热点 + 不防 cold-start。α₀/β₀ 参数 shadow 后可调（三猫收敛 2026-05-14） | 2026-05-14 |
| KD-5 | recency_decay 用 fractional `T/(T+age)` 而非 exponential | 我们是 design doc（长时效），exponential 365d 后剩 6% 太激进。fractional 长尾保护更好（47 提案 2026-05-14） | 2026-05-14 |
| KD-6 | recency_decay 按 doc kind 分桶，constitutional 不降权 | 不同类型文档热度曲线天差地别。constitutional 低 consumption 不代表不重要（Maine Coon + 47 收敛 2026-05-14） | 2026-05-14 |
| KD-7 | RRF k=60 不动，pool 不动，第三路召回 data-driven | k=60 是 Cormack 2009 经典值。先测 `consumed_anchor_not_in_pool_rate`，数据说了算才扩（Maine Coon 2026-05-14） | 2026-05-14 |
| KD-8 | Phase C 只吃 L1 信号，L2/L3 留 Phase D | 分层递进，避免过早引入噪声更大的深层信号（三猫收敛 2026-05-14） | 2026-05-14 |
| KD-9 | consumption_prior 必须 centered（减全局 mean_ctr_kind） | 纯正向 boost = 半残，低于平均的 anchor 永远不被压。47+Maine Coon R2 独立收敛同一结论（Wilson 1927 / Empirical Bayes 标准做法） | 2026-05-14 |
| KD-10 | graph 引入 edge-level 权重（不只是 node-level） | team lead点名"常用路径加权"；当前 GraphResolver 所有边一视同仁。type_base + traversal_count × recency 三要素（47+Maine Coon R2 收敛） | 2026-05-14 |

## Plan Gate Checklist（writing-plans 前必须解决）

> 来源：47 R3 六细节 + Maine Coon R3 三小修。spec 不阻塞，但 Plan 必须敲定。

- [x] **PG-1**: ✅ 新建 `recall_events` 表（V19 migration）— ToolEventLog windowing 不 reuse，独立 schema 更干净
- [x] **PG-2**: ✅ `recall-target-match.ts` — dispatch table: Read→doc(sourcePath)/passage(passageId), Grep→doc(sourcePath), graph_resolve→thread/session/invocation, read_session_*→session, get_thread_context→thread, anchor fallback
- [x] **PG-3**: ✅ V19 adds `traversal_count` + `last_traversed_at` to edges table（Phase A 开始记，Phase C 用）
- [x] **PG-4**: ✅ `F200_CONSUMPTION_RERANK=off|shadow|on` env flag, defaults to `off`

## Review Gate

- Phase A-B: 跨族 review（Maine Coon preferred）
- Phase C: 跨族 review + shadow mode 数据确认后才切 on
- Phase D: 待 Design Gate
- Phase E: deferred
