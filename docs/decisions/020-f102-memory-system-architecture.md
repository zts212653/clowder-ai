---
feature_ids: [F102, F065, F088]
topics: [memory, architecture, conversation-identity, embedding, search, compaction]
doc_kind: decision
created: 2026-03-22
decision_id: ADR-020
---

# ADR-020: F102 Memory System Architecture — Conversation Identity + 检索 + 摘要

> **Status**: accepted
> **Deciders**: 铲屎官 + Ragdoll(opus) + Maine Coon(gpt52) + 金渐层(opencode)
> **Date**: 2026-03-22
> **Architecture Diagram**: 见 thread `thread_mmygpnn83c3m0oiq` 的 html_widget `f102-architecture-v2`

## Context

Cat Café 需要一个记忆系统，让猫猫能：
1. 搜索项目知识（feature specs、决策、教训、对话历史）
2. 跨语言搜索（英文 query 命中中文文档）
3. 自动生成 thread 摘要（不靠人工）
4. 知道五个核心概念（Thread/Session/Active Slot/Connector Binding/CLI Resume）的关系

### 演进历程

| Era | 方案 | 结局 |
|-----|------|------|
| 1 | Hindsight（外部 SaaS） | 铲屎官说"实在难用"，Phase D 全量清理 -5000 行 |
| 2 | grep docs/ + threadId 手翻 | 4 条平行链路不知道用哪个，中英混搜不行 |
| 3 | **F102 当前方案** | SQLite 本地索引 + GPU Embedding + LSM Compaction |

## Decision

### 1. Conversation Identity — 五个概念的统一关系

```
用户消息 (飞书/Telegram/Hub)
  │
  ▼
Connector Binding          外部 chat → Cat Café thread 的映射
  connector:{id}:{externalChat} → threadId
  │
  ▼
Thread                     所有猫共享的"聊天室"
  title · participants · features · threadMemory
  消息归属单元, 摘要归属单元
  │
  ├──→ Session Chain (opus)    每只猫在每个 thread 的独立链
  │    seq: 0 → 1 → 2 → ...   按 catId × threadId 组织
  │    ↓
  │    Active Slot             每猫每 thread 最多 1 个 active session
  │    session-active:{catId}:{threadId} → sessionId
  │    ↓
  │    CLI Resume              Claude Code --resume 的映射
  │    session-cli:{cliSessionId} → sessionId
  │
  └──→ Session Chain (codex)   另一只猫的独立链
```

**关键关系**：
- **Thread** 是共享语义单元（摘要/搜索/消息都归 thread）
- **Session Chain** 是 per-cat 运行时单元（恢复/审计/事件下钻）
- **两层不混**（KD-41：多猫 session 有重合，不重复摘要）

### 2. 检索架构 — 三种独立路径 (KD-44)

| 模式 | 路径 | 适用场景 |
|------|------|---------|
| **lexical** | FTS5 BM25 全文搜索 | Feature ID、精确术语（F042, Redis） |
| **semantic** | 向量 NN（vec0 nearest-neighbor）→ hydrate evidence_docs | 跨语言（"cat naming" → "猫名故事"）、同义表达 |
| **hybrid** | BM25 召回 + 向量 NN 召回 → RRF 融合（k=60） | **推荐日常使用** |

每种模式有独立的召回路径（KD-44）：
- semantic 不依赖 BM25 召回（纯 NN）
- hybrid 的 BM25 候选池 = max(limit×4, 20) cap 100
- depth=raw 强制 lexical-only（passage 级暂无向量）
- fail-open：embedding 不可用时退化为 lexical

### 3. 存储架构 — evidence.sqlite

```
evidence_docs         882 行 · 结构化元数据 + FTS5 全文索引
evidence_fts          FTS5 虚拟表 · BM25 检索
evidence_vectors      850 行 · vec0 虚拟表 · dim=768 · Qwen3-Embedding-0.6B
evidence_passages     消息级粒度 · passage_fts
edges                 296 行 · evolved_from/blocked_by/related/supersedes/invalidates
summary_segments      543 行 · append-only ledger · topic segments + provenance
summary_state         421 行 · 水位线 + 调度信号 + carry_over
embedding_meta        版本锚 · model_id + model_rev + dim
schema_version        迁移版本 (当前 V4)
```

**真相源分层**：
- 索引（evidence.sqlite）= 编译产物，gitignore + rebuild
- 工作流状态（docs/markers/*.yaml）= git-tracked durable store
- 知识真相源 = docs/*.md 文件

### 4. LSM Compaction 摘要架构 (KD-42)

```
L0: 实时拼接层
    消息写入 → markThreadDirty → 30s debounce → 拼接文本
    成本: 零 · 延迟: <100ms

L1: 定时摘要层
    调度器 30min tick → eligibility rule → Opus 4.6 API → 自然语言摘要
    成本: 1 次 Opus/thread · 写入: summary_segment + evidence_docs + re-embed

L2: Rollup (deferred)
    segment ledger 已就绪 · 升级只改读路径
```

**Eligibility Rule**：
```
quietWindow ≥ 10min
AND (msgs ≥ 20 OR tokens ≥ 1500 OR high-signal)
AND (cooldown ≥ 2h OR carry_over)
```

**冷启动**：>20 pending threads → 去掉 budget 限制，全量批处理

**Opus 输出自然语言**（不输出 JSON）：
- `# 标题` → topicLabel + topicKey
- 正文 → summary
- `[decision]` `[lesson]` `[method]` → DurableCandidate
- 格式由程序解析填充（铲屎官："让模型说人话，格式交给程序"）

**双写路径**：
- evidence_docs.summary = read model（搜索/bootstrap 直接读）
- summary_segments = append-only ledger（可审计、可 rebuild）
- evidence_vectors = re-embed（semantic 实时生效）

### 5. GPU Embedding Server

```
:9880  embed-api.py
  └─ sentence-transformers + MPS GPU (Apple Silicon Metal)
  └─ Qwen3-Embedding-0.6B · dim=768
  └─ POST /v1/embeddings · GET /health
  └─ asyncio.Lock() GPU 锁
  └─ MLX fallback (等上游修 tokenizer)
```

与 TTS(:9879) / ASR(:9876) / LLM后修(:9878) 同架构模式：独立 Python 进程 + HTTP + /health + 端口注册。

**Dim 选择**（CMTEB 调研）：768 是中英混搜甜点。256 太低（CJK 语义损失 ~5%），1024 收益递减。

### 6. 六个服务接口

| 接口 | 职责 |
|------|------|
| `IIndexBuilder` | scan → hash → rebuild → migration · dirty-thread debounce |
| `IEvidenceStore` | search(query, {scope, mode, depth}) · upsert · delete |
| `IMarkerQueue` | submit → list → transition（真相源在 docs/markers/*.yaml） |
| `IMaterializationService` | approved → .md patch → git → reindex |
| `IReflectionService` | LLM 编排（独立于存储层） |
| `IKnowledgeResolver` | 联邦检索 → RRF rank fusion（project + global） |

### 7. Feature Flags

```
EMBED_ENABLED=1           → 启动 embed-api sidecar + EMBED_MODE=on（一个开关）
F102_ABSTRACTIVE=on       → 启动摘要调度器（需要 Opus API）
ANTHROPIC_PROXY_ENABLED=1 → 本地反代 :9877（调度器自动读 proxy-upstreams.json）
```

默认全 off，开源用户不受影响。Phase A~E 的全部功能在 flag off 时照常工作。

## 参考了什么开源

| 来源 | 学了什么 | 没搬什么 |
|------|---------|---------|
| **Lossless Claw (LCM)** | "压缩≠丢弃，摘要必须可穿透" · LSM 分层思想 | DAG 数据结构 · session 内 compaction |
| **OpenClaw Gateway** | connector binding · conversation identity · session truth boundary | 强隔离多脑模型（我们保留多猫共享协作） |
| **Artem《Grep Is Dead》(QMD)** | SQLite FTS5 + vec + RRF 同构确认 | QMD 外部依赖（我们扩大自有数据源） |

## 独有优势

1. **Thread-level 共享摘要** — 不按猫分（多猫 session 重合），thread 一份摘要所有猫共享
2. **自然语言摘要 + 程序解析** — 让 Opus 说人话，格式交给程序（不强迫模型输出 JSON）
3. **三种检索模式真正独立** — semantic 不依赖 BM25 召回（纯 NN），hybrid 是 RRF 融合
4. **本地优先 + 全部 feature-flagged** — SQLite 本地文件 · 开源默认 off · 一个开关启用
5. **Append-only segment ledger** — 可审计、可 rebuild、坏段可丢弃

## Consequences

### 正面
- 猫猫搜 "cat naming origin" 第一条就是花名册（中英混搜桥接）
- 380+ thread 自动生成 abstractive summary，不靠人工
- 新猫/新 session 启动时自带项目上下文（SessionBootstrap auto-recall）
- 五个概念关系清晰，端到端流转有文档

### 负面
- GPU Embedding server 增加一个 Python 进程（~900MB 内存）
- Abstractive summary 消耗 Opus API 额度（~30-60 次/天日常，冷启动一次性 ~400 次）
- evidence.sqlite 是单写者（WAL 模式），高并发写需要排队

### 风险
- 摘要漂移（每次在旧摘要上合并增量）→ 缓解：summary_segments ledger + abstractiveTokenCount 监控 + Phase 2 segment-based compaction 预留
- MLX tokenizer 兼容性（当前 fallback 到 sentence-transformers + MPS）→ 缓解：auto-fallback + fail-open

## Related

- [F102 spec](../features/F102-memory-adapter-refactor.md) — 完整 Phase A~G 定义 + KD-1~44
- [LL-034: Embedding 实现教训](../public-lessons.md#LL-034)
