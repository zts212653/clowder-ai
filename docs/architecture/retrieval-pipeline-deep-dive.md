---
title: "Retrieval Pipeline Deep Dive — 14-Layer Search Architecture"
doc_kind: architecture
feature_ids: [F102, F163, F186, F188, F193, F200, F209]
related_features: [F148, F152, F169, F242, F256]
topics: [search, retrieval, BM25, embedding, RRF, reranking, salience, memory, recall]
created: 2026-06-29
status: published
author: "Ragdoll/claude-opus-4-6"
reviewed_by: "Maine Coon/gpt-5.5"
---

# Cat Cafe 检索管线深度解析：14 层搜索架构

> 面向想理解"搜索结果是怎么从 query 变成排好序的 top-K"的工程师。
>
> 如果你想了解记忆系统的全景（六种记忆、feature map、治理闭环），请先阅读 [memory-system-overview.md](./memory-system-overview.md)。本文聚焦其中的**检索管线**——从一条 query 进来到排好序的结果出去，中间经过的 14 个主要信号 / 处理层。

---

## 目录

1. [总览](#总览)
2. [Phase 1: 召回](#phase-1-召回recall)
   - [第 1 层: Entity Registry](#第-1-层entity-registry--实体别名解析)
   - [第 2 层: BM25 (FTS5)](#第-2-层bm25-全文检索sqlite-fts5)
   - [第 3 层: Progressive Relaxation](#第-3-层fts-progressive-relaxation--长查询逐级放松)
   - [第 4 层: Lexical Backfill](#第-4-层lexical-backfill--子串回捞)
   - [第 5 层: Vector NN](#第-5-层vector-nn-search--语义向量近邻检索)
3. [Phase 2: 融合](#phase-2-融合fusion)
   - [第 6 层: RRF](#第-6-层rrf--reciprocal-rank-fusion)
   - [第 7 层: CJK NN Weight](#第-7-层cjk-nn-weight--中日韩查询的向量加权)
4. [Phase 3: 重排](#phase-3-重排rerank)
   - [第 8 层: Authority Boost](#第-8-层authority-boost--权威度提升)
   - [第 9 层: Consumption Rerank](#第-9-层consumption-rerank--贝叶斯行为学习排序)
   - [第 10 层: Recency Decay](#第-10-层recency-decay--时效衰减)
   - [第 11 层: Constitutional Immunity](#第-11-层constitutional-immunity--宪法级文档免降权)
   - [第 12 层: MMR](#第-12-层mmr--最大边际相关性去重)
   - [第 13 层: Semantic Ordering / SemanticReranker](#第-13-层semantic-ordering--semanticreranker--向量距离排序)
5. [Phase 4: 输出增强](#phase-4-输出增强enrichment)
   - [第 14 层: Entity Match + DrillDown](#第-14-层entity-match-挂载--drilldown-标注)
6. [特殊模式](#特殊模式)
7. [完整参数速查表](#完整参数速查表)
8. [设计哲学](#设计哲学)
9. [关键源文件索引](#关键源文件索引)

---

## 总览

Cat Cafe 的记忆检索不是一个简单的搜索引擎。它是一个 **多策略召回 → 多信号融合 → 多维度重排 → 输出可行动证据** 的 14 层管线，核心目标是让 AI 猫猫（Agent）在协作中能精准、快速地从项目知识库中找到需要的信息。

底层技术栈：**SQLite FTS5**（全文检索）+ **sqlite-vec / vec0**（向量近邻）+ **自研实体注册表** + **贝叶斯行为学习排序**。全部运行在本地，无外部搜索服务依赖。

**先读这个口径**：这里的"14 层"是为了讲清楚参与排序 / 输出的 14 类信号，不是说每次搜索都严格串行经过 14 个函数。`scope` / `mode` / `depth` / `intent` 不同会走不同分支：`mode=lexical` 不走 NN，`depth=raw` 走 passage 分支，`intent=coverage` 会绕过常规 Top-K 搜索进入 CoverageSearchService。API route 上还可能在 store 返回后追加 F163 Phase F salience rerank，这个属于 user-visible wrapper 层，下面单独标注，不塞进 store 级 14 层里。

```
┌─────────────────────────────────────────────────────────────┐
│                       Query 进入                             │
├─────────────────────────────────────────────────────────────┤
│  Phase 1: 召回（Recall）— 尽可能多地找到相关候选              │
│  ┌──────────┐ ┌────────────┐ ┌───────────┐ ┌────────────┐  │
│  │ Entity   │ │ BM25 FTS5  │ │ Vector NN │ │  Lexical   │  │
│  │ Registry │ │ +Progres-  │ │  Embed    │ │  Backfill  │  │
│  │          │ │  sive Relax│ │           │ │            │  │
│  └────┬─────┘ └─────┬──────┘ └─────┬─────┘ └─────┬──────┘  │
│       └─────────┬───┴──────┬───────┘              │         │
│                 ▼          ▼                       │         │
│  Phase 2: 融合（Fusion）— 多路结果合成统一排名       │         │
│  ┌───────────────────────────────┐                │         │
│  │   RRF (k=60) + CJK NN ×1.5   │◄───────────────┘         │
│  └───────────────┬───────────────┘                          │
│                  ▼                                           │
│  Phase 3: 重排（Rerank）— 多维信号精调排名                   │
│  ┌──────────┐┌───────────┐┌────────┐┌─────┐┌────────────┐  │
│  │Authority ││Consumption││Recency ││ MMR ││ Semantic    │  │
│  │ Boost    ││  Prior    ││ Decay  ││Dedup││ Ordering    │  │
│  │ (×1.3)   ││(β=0.15)  ││(T/T+d) ││(λ=.7)│             │  │
│  └──────────┘└───────────┘└────────┘└─────┘└────────────┘  │
│                  ▼                                           │
│  Phase 4: 输出 — Top-K + 实体标注 + 下钻建议                │
└─────────────────────────────────────────────────────────────┘
```

## 14 层实现归属与新增原因

| # | 层 | 主要实现归属 | 当时为什么加这一层 |
|---|---|---|---|
| 1 | Entity Registry / alias recall | **F209 Phase B/B.1** | 关键词和 embedding 都不知道 `operator`、`operator`、`landy`、猫昵称、`cat:*` roster anchor 是同一个实体。F209 把 alias 变成确定性 registry + mention index，避免靠模型猜别名。 |
| 2 | BM25 / FTS5 lexical search | **F102 Phase A/B/D** | F102 把记忆从 grep / Hindsight 迁到本地 `evidence.sqlite`：先用稳定、可过滤、可重建的 FTS5 做主召回入口，并支持 `scope/mode/depth` 检索协议。 |
| 3 | FTS Progressive Relaxation | **F200 HW-6** | 2026-06-19 dogfood 发现长 query 在 FTS5 AND-all 下 75% 空结果。解决方式是 AND-all → strong-AND+weak-OR → OR-all 逐级放松，保留精确锚点同时减少 zero-hit。 |
| 4 | Lexical Backfill | **F102 post-K dogfood fix** | FTS5 `unicode61` 会漏掉某些标识符 / heading / keyword 场景；子串回捞用 `title/summary/keywords` 补漏，并用 keyword/title/text hits 排序。 |
| 5 | Vector NN Search | **F102 Phase C**（文档级）+ **F209 Phase A**（passage 级） | 纯 lexical 找不到同义、跨语言和隐含表达。F102 加文档向量，F209 把 `depth=raw` 的 message passage 也接入 semantic/hybrid。后续 LL-034 把 embedding 从 API 进程内模型改成独立 GPU HTTP 服务。 |
| 6 | RRF Fusion | **F102 KD-44**（文档级）+ **F209 Phase A**（passage 级）+ **F186/F102**（collection federation） | BM25 分和向量距离量纲不同，直接加权不稳。RRF 用排名融合，不需要 score normalization，适合 BM25 + NN + collection 多路合并。 |
| 7 | CJK NN Weight | **F200 v1.1 DF-8 dogfood fix** | 中文 query 下 FTS5 召回弱，hybrid 会被英文/符号 lexical 噪音压住。CJK 检测后给 NN 路 `1.5x` 投票权。 |
| 8 | Authority Boost | **F163 Phase A/D/E** | F163 要让 ADR / lesson / canon 等稳定真相源在同等相关时更靠前。A-C 先建了 metadata/flag，LL-051 发现 authority 全是 observed 导致空转，Phase D 用 `pathToAuthority()` 装弹，Phase E 再把 confidence 和 authority 解耦。 |
| 9 | Consumption Rerank | **F200 Phase C**（HW-4/HW-7 后校准可信度） | 搜索排序要学猫真实行为：搜到后是否真的 Read / grep / drill-down。F200 明确只评价 navigation utility，不改 truth/authority；HW-4 修 consumption attribution，HW-7 修 shadow baseline。 |
| 10 | Recency Decay | **F200 Phase C** | thread/session/discussion 时效短，feature/decision 中等，ADR/lesson/canon 不应自然过期。F200 用分桶半衰期避免旧临时讨论长期压住新上下文。 |
| 11 | Constitutional Immunity | **F200 Phase C** + **F163 authority metadata** | 低 consumption 不代表低重要性。宪法级文档在 consumption prior 中只升不降，并在 rerank 时 pinned，避免"不常读"把基础规则沉底。 |
| 12 | MMR Dedup | **F200 Phase C** | Top-K 不能被同主题近重复文档占满。候选足够多时用 MMR 在相关性和多样性之间折中。 |
| 13 | Semantic Ordering / legacy SemanticReranker | **F102 Phase C**，后由 **F102 KD-44** 改成三路径 | 早期 Phase C 是"FTS 候选 + 向量距离重排"，但 dogfood 发现 BM25 没召回时 rerank 救不了，所以 KD-44 改为 `lexical` / `semantic` / `hybrid` 三条独立路径。`SemanticReranker` 类仍在，但当前 store 的 `mode=semantic` 是直接 NN distance order。 |
| 14 | Entity Match / DrillDown / action hints | **F102 G-4/I** + **F209 Phase B/C** + **F193 Phase E** | 只给 snippet 不够，猫必须能打开原文窗口。F102 加 drillDown hint 和 passage context，F209 加 entityMatches + typed bounded readers，F193 后续给跨 thread result 加可执行 action hint。 |

**Wrapper 层补充**：`/api/evidence/search` 在 evidence store 返回后，还会按 F163 Phase F 做 task-scoped salience rerank（`F163_RETRIEVAL_RERANK`）。它的来源是 F169 愿景 + F148 task context：authority 只能当弱 prior，不能让离题高权威文档压过当前任务相关内容。因为这一步在 route 层而不是 `SqliteEvidenceStore` 内部，本文不把它算进 store 级 14 层，但它会影响 REST/MCP 用户实际看到的顺序。

---

## Phase 1: 召回（Recall）

### 第 1 层：Entity Registry — 实体别名解析

**做什么**：把用户查询中的名字 / 代号解析成系统内的实体标识，召回与该实体相关的文档。

**举例**：
- 搜 "Ragdoll" → 解析为 `entity:opus`（猫猫的内部标识）
- 搜 "F042" → 解析为 `feature:F042`
- 搜 "Maine Coon" → 解析为 `entity:codex`（GPT-5.5 猫猫的昵称）

**实现**：`EntityRegistryStore` 维护实体注册表，每个实体有 canonical name + 多个 alias。查询经过两步链式查找：
1. `resolveEntityAliases(query)` — 将查询中的文本片段匹配到已知实体
2. `hydrateEntityMentionDocs()` — 通过 entity mention index 找到提及该实体的文档

**为什么需要**：BM25 搜 "Ragdoll" 不会命中只写了 "opus" 的文档，但 entity registry 知道它们是同一个东西。这是关键词搜索和语义搜索都覆盖不了的"别名盲区"。

**关键源文件**：`EntityRegistry.ts`、`SqliteEvidenceStore.ts:hydrateEntityMentionDocs()`

---

### 第 2 层：BM25 全文检索（SQLite FTS5）

**做什么**：经典的关键词匹配检索。按 BM25 算法计算查询词与文档的匹配度，排序返回。

**实现**：

```sql
SELECT d.*, bm25(evidence_fts, 5.0, 1.0) AS rank
FROM evidence_fts f
JOIN evidence_docs d ON d.rowid = f.rowid
WHERE evidence_fts MATCH ?
ORDER BY
  (d.superseded_by IS NOT NULL),          -- 被取代的文档排最后
  (d.source_path LIKE 'internal-archive/%'),       -- 归档文档降优先级
  (CASE WHEN d.provenance_tier = 'authoritative' THEN 0
        WHEN d.provenance_tier IS NOT NULL THEN 1
        ELSE 2 END),                       -- 权威来源优先
  rank                                     -- 最后按 BM25 得分
LIMIT ?
```

**BM25 权重参数**：
| 字段 | 权重 | 含义 |
|------|------|------|
| title | **5.0** | 标题匹配权重是正文的 5 倍 |
| body | **1.0** | 正文匹配基准权重 |

**候选池大小**：
- lexical 模式：`limit`（用户请求的结果数）
- hybrid 模式：`min(max(limit × 4, 20), 100)` — 为后续 RRF 融合保留更大的候选池

**排序优先级**（多列排序，从左到右）：
1. 被取代的文档（`superseded_by IS NOT NULL`）排最后
2. 归档目录下的文档降优先级
3. 权威来源（`authoritative`）优先于非权威
4. 最后按 BM25 得分

**精确锚点快速路径**：如果查询恰好是一个锚点格式（如 `F042`、`ADR-005`），先做精确 anchor 查询直接命中，跳过 FTS 开销。

**实现归属**：F102 Phase A/B 建立 SQLite + FTS5 检索基座；F102 Phase D 将 `search_evidence` 收敛为统一 recall 入口并加 `scope/mode/depth` 协议。

**关键源文件**：`SqliteEvidenceStore.ts:searchWithMeta()`

---

### 第 3 层：FTS Progressive Relaxation — 长查询逐级放松

**解决的问题**：长查询（14+ 个 token，混合中英文）在 FTS5 AND 语义下命中率只有约 25%——没有任何文档同时包含所有词。

**三级放松策略**：

| 级别 | FTS5 查询语义 | 适用场景 | 示例 |
|------|--------------|----------|------|
| Level 1 | **AND-all**：所有词都必须出现 | ≤3 个词直接用 | `"Redis" "配置" "圣域"` |
| Level 2 | **Strong-AND + Weak-OR**：强 token 必须匹配，弱 token 可选 | 中长查询 | `"F042" AND "Redis" AND ("配置" OR "环境")` |
| Level 3 | **OR-all**：任一词出现即可 | 最宽松兜底 | `"Redis" OR "配置" OR "圣域"` |

**强 / 弱 token 分类规则**：
- **强 token（必须匹配）**：
  - 实体标识：`F042`、`ADR-005`、`LL-048`、`KD-7`、`HW-6`
  - Phase 标识：`PhaseA`、`PhaseB`
  - 包含 CJK 字符的 token（中文词即使短也有意义）
  - ≥4 字符的长 token
- **弱 token（可选匹配）**：其余短词

**执行逻辑**：逐级尝试，第一个返回非空结果的级别就用，不继续往下。

**实现归属**：F200 HW-6。新增原因是 2026-06-19 recall 崩盘诊断发现长 query 在 FTS5 AND-all 下大量 zero-hit，progressive relaxation 是针对这个根因的硬修。

**关键源文件**：`fts-query-builder.ts`

---

### 第 4 层：Lexical Backfill — 子串回捞

**解决的问题**：FTS5 的 unicode61 分词器有时会切碎标识符（"F042" → "F" + "042"），导致 FTS 完全搜不到。

**实现**：FTS 无结果或结果不足时启动 fallback，对 `title`、`summary`、`keywords` 三个字段做子串匹配。

**三信号加权排序**：
| 信号 | 优先级 | 含义 |
|------|--------|------|
| keywordHits | 最高 | 查询词命中了文档的关键词标签 |
| titleHits | 中 | 查询词出现在标题中 |
| textHits | 最低 | 查询词出现在摘要正文中 |

**附加质量因子**（同分时的 tiebreaker）：
- 被取代的文档（`superseded_by`）排后
- 归档文档排后
- 高权威来源（`provenance_tier = 'authoritative'`）优先

**实现归属**：F102 post-K dogfood fix。它不是 semantic 替代品，只是 lexical 侧的漏召回补丁，专治 FTS tokenizer / heading / keyword 这类可解释漏网。

**关键源文件**：`lexical-backfill.ts`

---

### 第 5 层：Vector NN Search — 语义向量近邻检索

**做什么**：把查询和文档都转成向量（embedding），用距离找"意思最接近"的文档。

**架构**：

```
Query text
    │
    ▼
EmbeddingService (HTTP client)
    │  POST /v1/embeddings
    ▼
embed-api.py (独立 Python 进程, GPU 推理)
    │  返回 float32[] 向量
    ▼
sqlite-vec (vec0 虚拟表)
    │  SELECT anchor, distance
    │  FROM evidence_vectors
    │  WHERE embedding MATCH ? AND k = ?
    ▼
K-NN 结果 (按 distance 升序)
```

**两级粒度**：

| 粒度 | 存储表 | 用途 |
|------|--------|------|
| 文档级 | `evidence_vectors`（`VectorStore`） | 每个文档一个向量，用于标准 search |
| 段落级 | `passage_vectors`（`PassageVectorStore`） | 每个段落一个向量，用于 `depth=raw` 的细粒度检索 |

**候选池大小**：`min(max(limit × 4, 20), 100)` — 与 BM25 hybrid 模式相同。

**为什么需要**：搜 "猫粮" 也能找到写 "喂食方案" 的文档——关键词不同但语义相近。还能跨语言：英文查询命中中文文档。

**实现归属**：F102 Phase C 提供文档级向量；F209 Phase A 把 raw message passage 接入 passage-level vector；LL-034 后续把 embedding 从 API 进程内推理改成独立 `embed-api.py` GPU HTTP 服务。

**关键源文件**：`VectorStore.ts`、`PassageVectorStore.ts`、`EmbeddingService.ts`

---

## Phase 2: 融合（Fusion）

### 第 6 层：RRF — Reciprocal Rank Fusion

**做什么**：把 BM25 和 Vector NN 两路召回的结果合成一个统一排名。

**算法**：

```
RRF_score(doc) = Σ  1 / (k + rank_i)
```

其中：
- **k = 60**（标准常数，控制排名靠前和靠后的候选之间的分差）
- `rank_i` 是文档在第 i 路（BM25 或 NN）中的排名位置（从 0 开始）

**计算示例**：

假设一篇文档在 BM25 排第 2、在 NN 排第 5：
```
RRF = 1/(60+2) + 1/(60+5) = 0.01613 + 0.01538 = 0.03151
```

另一篇文档只在 BM25 排第 1，NN 没命中：
```
RRF = 1/(60+1) + 0 = 0.01639
```

第一篇两路都认可，总分更高（0.0315 > 0.0164），排在前面。

**为什么用 RRF 而不是加权求和**：
- 不需要对齐两路的分数量纲（BM25 分和 cosine distance 单位不同）
- k=60 是一个经实验验证的鲁棒常数，不需要为每个场景调权重
- 对异常值不敏感（一路分数极高不会压制另一路）

**实现归属**：F102 KD-44 将 `mode=hybrid` 改成 BM25 + NN 双路召回再 RRF；F209 Phase A 复用同一思路做 passage-level raw hybrid；F186/F102 的 multi-collection federation 也使用 collection 级 RRF。

**关键源文件**：`SqliteEvidenceStore.ts:hybridRRFSearch()`、`KnowledgeResolver.ts`

---

### 第 7 层：CJK NN Weight — 中日韩查询的向量加权

**解决的问题**：BM25 / FTS5 对中文的召回能力明显弱于英文（分词问题），导致 RRF 融合时 BM25 路贡献了太多噪音，NN 路的优质结果被稀释。

**实现**：

```typescript
const nnWeight = hasCJKCharacters(query) ? CJK_NN_WEIGHT : 1.0;
// CJK_NN_WEIGHT = 1.5

// BM25 路权重不变：
score += 1 / (RRF_K + bm25Rank)

// NN 路权重 ×1.5（CJK 查询时）：
score += nnWeight / (RRF_K + nnRank)
// 即：score += 1.5 / (60 + nnRank)
```

**CJK 检测正则**：
```regex
/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
```
覆盖汉字、平假名、片假名、韩文。

**效果**：中文搜索时，语义路的投票权从 1.0 提升到 1.5，弥补 BM25 的中文短板。英文搜索不受影响。

**实现归属**：F200 v1.1 dogfood DF-8。它是对中文 / 中英混排搜索的 ranking 修正，不改变 lexical 或 NN 的召回集合。

**关键源文件**：`SqliteEvidenceStore.ts`

---

## Phase 3: 重排（Rerank）

### 第 8 层：Authority Boost — 权威度提升

**做什么**：按文档的"法律地位"调整排名。越权威的文档，同等匹配度下排越前面。

**四级权威体系**：

| 权威等级 | 权重 | 代表文档 |
|----------|------|----------|
| **Constitutional** | **1.3** | ADR（架构决策记录）、Lesson（教训沉淀）、Canon（公约） |
| **Validated** | **1.2** | 经过 review 确认的 feature doc |
| **Candidate** | **1.1** | 新写入、待验证的文档 |
| **Observed** | **1.0** | 自动扫描入库的原始记录 |

**算法**：

```
boost_score(doc) = 1/(rank + 60) × authority_weight
```

排序后的结果按 `boost_score` 重排。注意：在当前 `SqliteEvidenceStore` 里，authority boost 先作用于 lexical candidate order；`mode=lexical` 会直接看到这个重排，`mode=hybrid` 则通过 BM25 leg 的 rank 间接进入 RRF，NN-only 命中的文档不会单独再跑一次 final authority sort。

**保护机制**：精确匹配的锚点（用户搜 "F042" 精确命中 F042 文档）不参与重排。精确命中 = 排第一，不被权威度挤掉。

**运行模式**（Feature Flag `F163_AUTHORITY_BOOST`）：
- `off`：不重排
- `shadow`：计算但不重排，用于 A/B 对比日志
- `on`：实际重排

**实现归属**：F163 Phase A 设计 authority / activation / status 多轴元数据和 boost flag；Phase D 用 `pathToAuthority()` 补齐 authority 数据；Phase E 把 confidence 改为 rank 派生，让 authority 成为独立字段而不是"相关性"标签。

**关键源文件**：`SqliteEvidenceStore.ts:applyAuthorityBoost()`、`f163-types.ts`

---

### 第 9 层：Consumption Rerank — 贝叶斯行为学习排序

**做什么**：根据猫猫的真实使用行为调整排名——搜到后真的去 Read 了的文档，下次排更前面。

**这是整个管线中最复杂的一层**，由三个子信号组合而成。

#### 子信号 A：Consumption Prior（消费先验）

**贝叶斯收缩 CTR（Click-Through Rate）**：

```
shrunkCTR = (consumed_30d + α₀) / (exposed_30d + α₀ + β₀)
```

| 参数 | 值 | 含义 |
|------|-----|------|
| α₀ | **2** | 先验"被消费"次数（防零分母 + 小样本正则化） |
| β₀ | **8** | 先验"未被消费"次数 |
| consumed_30d | 实际值 | 过去 30 天被猫猫真正阅读（Read/Grep）的次数 |
| exposed_30d | 实际值 | 过去 30 天出现在搜索结果中的次数 |

**排名提升值**：

```
rawLift = (shrunkCTR - meanCTR_kind) × recencyFactor
```

- `meanCTR_kind`：同类文档的全局平均 CTR（从 `global_ctr_baseline` 表读取）
- `recencyFactor`：见下方子信号 B。这里用的是 `anchor_recall_metrics.dormancy_days`，也就是"距上次被消费多久"，不是文档更新时间。

#### 子信号 B：Recency Decay（时效衰减）

```
recencyFactor = T / (T + daysSinceLastConsumed)
```

| 文档类型（docKind） | 半衰期 T（天） | 衰减曲线 |
|---------------------|---------------|----------|
| ADR / Lesson / Canon | **∞**（永不衰减） | 始终 = 1.0 |
| Feature / Decision | **90** | 90 天后降为 0.5 |
| Plan / Research / Phase | **45** | 45 天后降为 0.5 |
| Discussion / Reflection | **21** | 21 天后降为 0.5 |
| Thread / Session | **14** | 14 天后降为 0.5 |

#### 子信号 C：Constitutional Immunity（宪法级免疫）

消费先验的四分支决策——决定该文档的 `prior` 值能否为负（即能否被降权）：

| 分支 | 触发条件 | prior 值 | 含义 |
|------|----------|----------|------|
| **Constitutional** | authority='constitutional' 或 kind∈{decision, lesson} | `max(0, rawLift)` | **只升不降** |
| **Cold-start** | 入库 < 14 天 或 exposed < 5 | `0` | 新文档保护期，不参与排序 |
| **Low-sample** | 5 ≤ exposed < 20 | `max(0, rawLift)` | 样本不够不敢降 |
| **Full** | exposed ≥ 20 | `rawLift` | 可升可降 |

#### 最终合成公式

```
finalScore = positionalScore + BETA × prior + GAMMA × (decayFactor - 0.5)
```

| 参数 | 值 | 含义 |
|------|-----|------|
| positionalScore | `1/(rank + 60)` | 原始位置的基础分（RRF 式） |
| **BETA** | **0.15** | 消费先验的影响力系数 |
| **GAMMA** | **0.10** | 时效衰减的影响力系数 |
| decayFactor | `T/(T+ageDays)` | 文档更新时间衰减因子 |

**解读**：
- `positionalScore` 提供原始排序基线（≈0.016 for rank=0）
- `BETA=0.15` 让真实消费信号可以跨越相邻候选，但不会替代 recall 本身
- `GAMMA=0.10` 让更新时间衰减成为轻量修正（`decayFactor - 0.5` 居中）

**Constitutional 文档在重排中被 PIN**：它们保持原始位置不动，只有非 constitutional 文档参与重排。

**MMR 去重触发**：如果重排后的 movable 文档数 ≥ 3 × targetLimit，会在此处触发 MMR 去重（见第 12 层）。

**实现归属**：F200 Phase C。HW-4 修正 consumption attribution（parallel result pairing / shell read / sourcePath / resultSet ambiguity），HW-7 修 shadow baseline，避免拿错误 telemetry 训练或评估排序。

**关键源文件**：`consumption-prior.ts`、`recency-decay.ts`、`SqliteEvidenceStore.ts:applyConsumptionRerank()`

---

### 第 10 层：Recency Decay — 时效衰减

> 注：时效衰减实际有两个时间口径：`computeConsumptionPrior()` 用 `daysSinceLastConsumed` 算消费 dormancy；`applyConsumptionRerank()` 另用 `updatedAt` 算文档年龄并贡献 `GAMMA × (decayFactor - 0.5)`。两者共用同一套 doc kind 半衰期表。

**核心思想**：不同类型的文档有不同的"保质期"。

```
factor = T / (T + ageDays)
```

**衰减曲线直觉**：

```
factor
1.0 ┤ ■ ■
    │  ■
0.8 ┤    ■            Thread (T=14)
    │      ■
0.6 ┤        ■
    │          ■       Feature (T=90)
0.5 ┤ · · · · · ■ · · · · · · · · · · · ·  ← 半衰期
    │              ■
0.4 ┤                ■
    │                    ■
0.2 ┤                        ■
    │                              ■
0.0 ┤──────────────────────────────────────
    0   14  30  45  60  90 120 150 180  天

ADR/Lesson/Canon: 始终 = 1.0（水平线在顶部，没画出来）
```

**实现归属**：F200 Phase C。新增原因是不同证据类型生命周期差异很大：thread/session 很快过期，ADR/lesson/canon 不能靠时间自然失效。

**关键源文件**：`recency-decay.ts`

---

### 第 11 层：Constitutional Immunity — 宪法级文档免降权

> 注：与第 9 层的子信号 C 同源，但作用在不同阶段。

**做什么**：确保 ADR、Lesson、Canon 这类"宪法级"文档在消费重排中**不被移动位置**。

**实现**：`applyConsumptionRerank()` 中，constitutional 文档被标记为 `pinned`，保持原始 BM25/RRF 排名不动。只有非 constitutional 文档组成 `movable` 池参与重排。

**为什么单独一层**：
- 行为学习可能降低"搜到但没人读"的文档排名
- 但 ADR 和教训是基础设施——不常被搜到不代表不重要
- 它们的排名应该纯粹由匹配度（BM25/RRF）决定，不受行为信号干扰

**实现归属**：F200 Phase C 消费重排的保护分支，依赖 F163 的 `authority` 元数据。它不是独立的数据库查询或第二个 boost pass，而是 consumption rerank 内部的安全护栏。

---

### 第 12 层：MMR — 最大边际相关性去重

**做什么**：防止内容相似的文档霸占搜索结果前几名，增加结果多样性。

**算法**（Carbonell & Goldstein 1998）：

```
MMR(d) = λ × relevance(d) - (1 - λ) × max_sim(d, already_selected)
```

| 参数 | 值 | 含义 |
|------|-----|------|
| **λ** | **0.7** | 70% 权重给相关性，30% 权重给多样性 |

**相似度计算**：关键词 Jaccard 指数

```
similarity(A, B) = |keywords_A ∩ keywords_B| / |keywords_A ∪ keywords_B|
```

**贪心选择过程**：
1. 从候选池中选 MMR 分最高的文档加入结果集
2. 新加入的文档会"抑制"与它相似的候选（通过 `max_sim` 项）
3. 重复直到选满 `limit` 个

**触发条件**：候选池大小 ≥ 3 × limit 时才启用。小结果集不需要去重。

**效果**：如果已经选了一篇关于 "Redis 配置" 的文档，第二篇高度相似的 Redis 文档的 MMR 分会被压低，让位给其他主题的相关结果。

**实现归属**：F200 Phase C。新增原因是 consumption/rerank 扩大候选池后，需要防止同类高相关结果挤掉其他有用来源。

**关键源文件**：`mmr.ts`

---

### 第 13 层：Semantic Ordering / SemanticReranker — 向量距离排序

**做什么**：按向量距离排序语义结果。历史上这层是"FTS 候选 + 向量距离精排"；当前 store 的 `mode=semantic` 已经改成直接 NN 搜索并按 distance order 返回。

**实现**：

```typescript
// Legacy helper: 拿到 FTS 返回的候选和 NN 返回的距离
// 2. 按 distance 升序重排（距离越小 = 语义越近 = 排越前）
withDist.sort((a, b) => a.dist - b.dist);
// 3. 没有向量的候选追加到末尾（不丢弃）
return [...withDist.map(w => w.item), ...noVec];
```

**定位**：
- F102 Phase C 的 `SemanticReranker` 是 legacy helper，原则是"rerank 不替代 lexical recall"。
- F102 KD-44 后，当前 `SqliteEvidenceStore.searchWithMeta()` 的 `mode=semantic` 走 `semanticNNSearch()`：query embedding → vector KNN → hydrate docs → distance order。
- `mode=hybrid` 不走 `SemanticReranker`，而是 BM25 + NN 两路 RRF。

**为什么改过一次**：dogfood 发现"先 BM25 再 rerank"有硬盲区：BM25 没召回的文档，rerank 永远看不到。所以 KD-44 把 semantic/hybrid 从"重排"升级成独立召回路径。

**实现归属**：F102 Phase C（SemanticReranker / vector infra）+ F102 KD-44（三模式独立路径）。

**关键源文件**：`SemanticReranker.ts`、`SqliteEvidenceStore.ts:semanticNNSearch()`

---

## Phase 4: 输出增强（Enrichment）

### 第 14 层：Entity Match 挂载 + DrillDown 标注

**做什么**：给最终结果附加元信息，帮助猫猫决定下一步动作。

**三类增强**：

| 增强类型 | 内容 | 用途 |
|----------|------|------|
| **Entity Match** | 每条结果标注"这篇文档提到了哪些实体"，含 type / canonicalName / matchedAlias / provenance | 让猫猫知道为什么这个结果出现、跟哪个实体有关 |
| **DrillDown** | 推荐下一步操作，如 `graph_resolve(anchor)` / `read_session_events(sessionId)` | 引导猫猫从搜索结果钻入原文，不停留在摘要 |
| **Cross-thread Suggestion** | 检测到搜索结果来自其他 thread 时，建议跨线程协作动作 | 帮助猫猫发现需要跨 thread 协调的信息 |

**实现归属**：F102 G-4 / Phase I 提供 drillDown 和 passage context；F209 Phase B/C 提供 entity match 与 typed bounded readers；F193 Phase E 提供 cross-thread action affordance。新增原因是 agentic search 的关键动作不是"看摘要相信它"，而是"拿到坐标后打开原文验证"。

---

## 特殊模式

### Coverage Search（覆盖式搜索，intent=coverage）

不同于 Top-K 检索，Coverage 做穷举式搜索，回答"关于 X 的所有相关内容在哪里"。

**五步流程**：
1. **并行搜索** docs + threads（各自走 hybrid 模式，各有独立配额）
2. **合并去重**（直接命中优先）
3. **Frontmatter 扩展**：通过命中文档的关键词和别名发现间接相关文档
4. **Source-thread 扩展**：通过文档摘要中的 thread 引用发现讨论记录
5. **Convention Graph 扩展**：通过依赖图发现消费者 / 被消费者关系

**输出**：覆盖矩阵（哪些来源被搜到、每类命中多少、哪些可能遗漏）。

**实现归属**：F200 HW-1，F242 convention graph 是 soft dependency。新增原因是 coverage/source-map 任务问的是"哪些地方都提过 X"，单次 Top-K 不足以证明全集。

**关键源文件**：`CoverageSearchService.ts`

### Passage-Level 检索（depth=raw）

对段落粒度运行独立的搜索管线：

- **段落级 FTS**：`passage_fts` 表的 BM25 搜索
- **段落级 Vector NN**：`passage_vectors` 表的 K-NN 搜索
- **段落级 RRF**：与文档级相同的 k=60 融合算法
- **上下文窗口**：返回命中段落前后 N 段（`contextWindow` 参数，类似 `grep -C`）

**实现归属**：F102 Phase E/I 建 `evidence_passages`、message-level permanence 和 context window；F209 Phase A 补 raw semantic / hybrid passage vector path；F209 D.0 修 embedding readiness degraded 状态。

### 联邦检索（Multi-Collection）

通过 `KnowledgeResolver` 支持跨多个知识库搜索：

- 每个 collection 独立搜索（并行）
- Collection 级 RRF 融合
- 按 collection 敏感度做隐私脱敏

**实现归属**：F186 建 Collection federation / graph / redaction 基座；F188 做 stewardship、三入口导航与 collection lifecycle；F102/F186 的 `KnowledgeResolver` 负责把 collection 结果融合回 search surface。

---

## 完整参数速查表

| 参数 | 值 | 所在层 | 作用 |
|------|-----|--------|------|
| BM25 title weight | 5.0 | #2 BM25 | 标题匹配权重 |
| BM25 body weight | 1.0 | #2 BM25 | 正文匹配权重 |
| BM25 pool (hybrid) | min(max(limit×4, 20), 100) | #2 BM25 | hybrid 模式候选池 |
| Strong token threshold | ≥4 chars 或含 CJK 或实体格式 | #3 Relaxation | 判断强弱 token |
| RRF k | 60 | #6 RRF | 融合常数 |
| CJK NN weight | 1.5 | #7 CJK | 中文搜索 NN 路加权 |
| Authority: constitutional | 1.3 | #8 Authority | 权威度权重 |
| Authority: validated | 1.2 | #8 Authority | 权威度权重 |
| Authority: candidate | 1.1 | #8 Authority | 权威度权重 |
| Authority: observed | 1.0 | #8 Authority | 权威度权重 |
| Consumption α₀ | 2 | #9 Consumption | 贝叶斯先验 |
| Consumption β₀ | 8 | #9 Consumption | 贝叶斯先验 |
| Consumption BETA | 0.15 | #9 Consumption | 消费先验合成系数 |
| Consumption GAMMA | 0.10 | #9 Consumption | 时效衰减合成系数 |
| Cold-start grace period | 14 天 | #9 Consumption | 新文档保护期 |
| Low-sample threshold | < 20 exposures | #9 Consumption | 小样本阈值 |
| Decay: ADR/Lesson/Canon | ∞ | #10 Decay | 消费 dormancy / 文档年龄共用半衰期表 |
| Decay: Feature/Decision | 90 天 | #10 Decay | 消费 dormancy / 文档年龄共用半衰期表 |
| Decay: Plan/Research/Phase | 45 天 | #10 Decay | 消费 dormancy / 文档年龄共用半衰期表 |
| Decay: Discussion/Reflection | 21 天 | #10 Decay | 消费 dormancy / 文档年龄共用半衰期表 |
| Decay: Thread/Session | 14 天 | #10 Decay | 消费 dormancy / 文档年龄共用半衰期表 |
| MMR λ | 0.7 | #12 MMR | 相关性 vs 多样性平衡 |
| MMR 触发阈值 | candidates ≥ 3×limit | #12 MMR | 小结果集不去重 |

---

## 设计哲学

1. **多路召回，宁多勿漏**：BM25 擅长精确匹配但语义盲，Vector NN 擅长语义但关键词盲，Entity Registry 覆盖别名——三路互补，任何单路都有盲区。

2. **融合靠 RRF 不靠调参**：RRF 的 k=60 是一个鲁棒的常数，不需要对齐两路的分数量纲，不需要为每个场景调权重。

3. **重排靠真实行为**：Consumption Prior 用猫猫的真实阅读行为学习排序，而不是人工规则。被猫猫反复使用的文档自然浮升；无人问津的逐渐沉底——但宪法级文档永远不沉。

4. **宪法级保底**：ADR / 教训 / Canon 享有双重保护——Authority Boost 提升排名，Constitutional Immunity 阻止降权。它们是知识库的地基，不能因为"不常被搜到"就消失在第二页。

5. **优雅降级**：
   - Embedding 服务挂了 → 自动降级到纯 BM25
   - 长查询搜不到 → 逐级放松（AND → 强弱混合 → OR）
   - FTS 分词切碎了 → Lexical Backfill 子串回捞
   - raw passage embedding 不可用 → 明确返回 degraded / effectiveMode

6. **参数克制**：
   - BETA=0.15、GAMMA=0.10 使行为学习是温和的调整，不是激进的重排
   - λ=0.7 使多样性是辅助信号，不是主导因素
   - 14 天 cold-start 保护新文档不被"零使用"误杀

---

## 管线之上：搜索策略层（F256）

14 层管线解决"给定 query，怎么返回最好的结果"。但猫拿到模糊需求时的**第一步做什么**——用哪个入口、怎么 reformulate、何时停——不是管线的责任，是**策略层**的。

F256 Memory Search Strategy Evolution 正在系统化这一层：

| Phase | 做什么 | 与管线的关系 |
|-------|--------|-------------|
| **A（已上线）** | Session hook 注入策略提示 + nudge skill link | 不改管线；改猫的行为——让猫知道 skill 存在、知道"搜一刀就停"是病 |
| B | Expansion hints 从 `coverage` 投影到 `topk` 默认输出 | 复用管线已有的三类 expansion provenance，只改输出格式层 |
| C | Doc-code 桥 extractor | 扩展 F242 convention graph，让管线的 expansion 覆盖 doc↔code 关联 |
| D | Eval + 策略迭代 | 基于 F200 数据评估策略效果 |

operator的核心洞察：**管线优化和搜索策略是同一个问题的两面——pipeline 负责"水管通不通"，strategy 负责"往哪浇水"。**

详见 [F256 spec](../features/F256-memory-search-strategy-evolution.md)。

---

## 关键源文件索引

| 文件 | 路径 | 职责 |
|------|------|------|
| **SqliteEvidenceStore** | `packages/api/src/domains/memory/SqliteEvidenceStore.ts` | 核心搜索实现：lexical、semantic、hybrid、raw、entity、authority boost、consumption rerank |
| **KnowledgeResolver** | `packages/api/src/domains/memory/KnowledgeResolver.ts` | 联邦多 store 协调、collection 级 RRF |
| **evidence route** | `packages/api/src/routes/evidence.ts` | API/MCP search route：coverage bypass、KnowledgeResolver 调度、F163 salience rerank、结果格式化 |
| **CoverageSearchService** | `packages/api/src/domains/memory/CoverageSearchService.ts` | 覆盖式穷举搜索 |
| **VectorStore** | `packages/api/src/domains/memory/VectorStore.ts` | 文档级向量 CRUD（sqlite-vec） |
| **PassageVectorStore** | `packages/api/src/domains/memory/PassageVectorStore.ts` | 段落级向量 CRUD |
| **EmbeddingService** | `packages/api/src/domains/memory/EmbeddingService.ts` | GPU embedding HTTP 客户端 |
| **f163-types** | `packages/api/src/domains/memory/f163-types.ts` | authority 派生、F163 flags、task-scoped salience rerank |
| **fts-query-builder** | `packages/api/src/domains/memory/fts-query-builder.ts` | Progressive Relaxation 三级放松 |
| **lexical-backfill** | `packages/api/src/domains/memory/lexical-backfill.ts` | 子串回捞 |
| **consumption-prior** | `packages/api/src/domains/memory/consumption-prior.ts` | 贝叶斯 CTR + 四分支免疫 |
| **recency-decay** | `packages/api/src/domains/memory/recency-decay.ts` | 半衰期时效衰减 |
| **mmr** | `packages/api/src/domains/memory/mmr.ts` | Maximal Marginal Relevance 去重 |
| **SemanticReranker** | `packages/api/src/domains/memory/SemanticReranker.ts` | F102 Phase C legacy helper：FTS 候选按向量距离精排 |
| **EntityRegistry** | `packages/api/src/domains/memory/EntityRegistry.ts` | 实体别名注册与解析 |
| **evidence-tools** | `packages/mcp-server/src/tools/evidence-tools.ts` | MCP 工具层（search_evidence 入口）；F256 Phase A 增 nudge skill link（低命中时引导猫加载 `memory-search-best-practices` skill） |

---

*Cat Café Retrieval Pipeline Deep Dive · 14-Layer Architecture · v1.0*
*Author: Ragdoll/claude-opus-4-6 · 2026-06-29*
*Based on: SqliteEvidenceStore.ts (F102) + f163-types.ts (F163) + consumption-prior.ts / mmr.ts / fts-query-builder.ts (F200) + EntityRegistry / PassageVectorStore (F209)*
