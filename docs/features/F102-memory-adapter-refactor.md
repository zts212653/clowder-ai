---
feature_ids: [F102]
related_features: [F024, F100, F042]
topics: [memory, adapter, evidence-store, architecture]
doc_kind: spec
created: 2026-03-11
---

# F102: 记忆组件 Adapter 化重构 — IEvidenceStore + 本地索引

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

## Why

Hindsight（外部记忆服务）已停用——team lead觉得实在难用。当前 `HindsightClient` 硬编码在路由和启动链路中，无法替换。我们需要：

1. 把记忆组件从 Hindsight 硬绑定改为可插拔 Adapter 接口
2. 实现一个轻量的本地替代方案（结构化索引 + feat 体系自动维护）
3. 避免重蹈覆辙：retain 不能直写长期库（碎片化垃圾入库教训）

## 终态架构（P1 面向终态，从这里反推）

```
truth sources (git-tracked)
  docs/*.md                          — 项目文档（feat/decision/plan/lesson）
  docs/markers/*.yaml                — marker 审核日志（durable workflow state）
  global profiles/rules/lessons      — Skills + 家规 + MEMORY.md

compiled indices (gitignore + rebuild)
  evidence.sqlite                    — 项目索引（evidence_docs + evidence_fts + edges）
  global_knowledge.sqlite            — 全局索引（read-only，从 Skills/家规/MEMORY.md 编译）

services (6 个接口)
  IIndexBuilder                      — scan/hash/rebuild/schema migration/fts consistency
  IEvidenceStore                     — search/upsert/delete/get/health
  IMarkerQueue                       — submit/list/transition（真相源在 docs/markers/）
  IMaterializationService            — approved → .md patch → git commit → trigger reindex
  IReflectionService                 — LLM 编排，独立于存储
  IKnowledgeResolver                 — query planning → fan-out → normalize → RRF rank fusion
```

**关键设计决策**：
- **全局记忆** = Skills + 家规 + MEMORY.md（F100 Self-Evolution 体系，已有基础设施）
- **项目记忆** = SQLite 数据库（`evidence.sqlite`），每个项目一个文件，物理隔离
- **SQLite 是终态存储基座**（不是终态检索策略）：FTS5 全文搜索 + SQLite vector extension（按当时稳定版本启用） + edges 关系表，Phase 1 建的东西 Phase N 还在。纯 lexical 不够，Phase C 向量增强是预期路径
- **真相源分层**：
  - 索引（`evidence.sqlite`/`global_knowledge.sqlite`）= 编译产物，gitignore + rebuild
  - 工作流状态（`docs/markers/*.yaml`）= git-tracked durable store，rebuild 不能蒸发审核历史
  - 知识真相源 = `docs/*.md` 文件；approved marker 必须先 materialize 到 .md 才算沉淀
- **联邦检索**：`KnowledgeResolver` 融合两个同质 SQLite index（全局 read-only + 项目 read-write），用 RRF rank fusion，不混用 raw filesystem 和 SQLite MATCH
- **过期知识防护**：`superseded_by` 字段 + `supersedes/invalidates` 关系，过时高相似决策比查不到更危险
- 猫猫出征新项目 → 带走全局层（skills/家规/记忆），新项目自动初始化空的 `evidence.sqlite`

## What

### Phase A: 6 接口 + SQLite 基座 + 解耦

**A1. 接口定义**：6 个接口（KD-13）。

```typescript
// 编译器：scan → hash → incremental rebuild → schema version → fts consistency
interface IIndexBuilder {
  rebuild(options?: RebuildOptions): Promise<RebuildResult>;
  incrementalUpdate(changedPaths: string[]): Promise<void>;
  checkConsistency(): Promise<ConsistencyReport>;
}

// 项目知识索引（编译产物，从 docs/*.md 重建）
interface IEvidenceStore {
  search(query: string, options?: SearchOptions): Promise<EvidenceItem[]>;
  upsert(items: EvidenceItem[]): Promise<void>;
  deleteByAnchor(anchor: string): Promise<void>;
  getByAnchor(anchor: string): Promise<EvidenceItem | null>;
  health(): Promise<boolean>;
  initialize(): Promise<void>;  // idempotent migrations + schema version + PRAGMA setup
}

// 候选记忆队列（真相源在 docs/markers/*.yaml，不是 SQLite）
interface IMarkerQueue {
  submit(marker: Marker): Promise<void>;
  list(filter?: MarkerFilter): Promise<Marker[]>;
  transition(id: string, to: MarkerStatus): Promise<void>;
}

// 晋升服务：approved marker → .md patch → git commit → trigger reindex
interface IMaterializationService {
  materialize(markerId: string): Promise<MaterializeResult>;
  canMaterialize(markerId: string): Promise<boolean>;
}

// 反思服务（独立于存储层，LLM 编排能力）
interface IReflectionService {
  reflect(query: string, context?: ReflectionContext): Promise<string>;
}

// 联邦检索：query planning → fan-out → normalize → RRF rank fusion
interface IKnowledgeResolver {
  resolve(query: string, options?: ResolveOptions): Promise<KnowledgeResult>;
}

interface SearchOptions {
  kind?: 'feature' | 'decision' | 'plan' | 'session' | 'lesson';
  status?: 'active' | 'done' | 'archived';
  keywords?: string[];
  limit?: number;
  scope?: 'global' | 'project' | 'workspace';  // 预留中间层 scope
}

// captured → normalized → approved → materialized → indexed（+ rejected 分支）
type MarkerStatus = 'captured' | 'normalized' | 'approved' | 'rejected' | 'needs_review' | 'materialized' | 'indexed';
```

**接口关系**：`SqliteProjectMemory` 实现 `IEvidenceStore`。`IMarkerQueue` 真相源在 `docs/markers/*.yaml`（git-tracked），SQLite 内的 markers 表只是工作缓存。`IIndexBuilder` 负责 SQLite 编译。`IMaterializationService` 负责 approved → .md patch → reindex。`IKnowledgeResolver` 融合两个同质 SQLite index（全局 read-only + 项目 read-write），用 RRF rank fusion。

**A2. SQLite 存储（终态基座）**：`SqliteEvidenceStore` 实现 `IEvidenceStore`。

```sql
-- 结构化元数据表（常规表，精确过滤 + freshness check + join）
CREATE TABLE evidence_docs (
  anchor TEXT PRIMARY KEY,    -- F042, ADR-005, session-xxx
  kind TEXT NOT NULL,         -- feature/decision/plan/session/lesson
  status TEXT NOT NULL,       -- active/done/archived
  title TEXT NOT NULL,
  summary TEXT,
  keywords TEXT,              -- JSON array
  source_path TEXT,           -- docs/features/F042.md
  source_hash TEXT,           -- 变更检测
  superseded_by TEXT,         -- KD-16: 过期知识指向替代文档的 anchor
  materialized_from TEXT,     -- 关联 marker id（如从 marker 晋升而来）
  updated_at TEXT NOT NULL
);

-- 全文搜索（FTS5 外部内容表，索引 title + summary）
-- KD-18: tokenchars 处理 snake_case/feature ID，bm25 列权重 title > summary
CREATE VIRTUAL TABLE evidence_fts USING fts5(
  title, summary,
  content=evidence_docs, content_rowid=rowid,
  tokenize='unicode61 tokenchars "_-"'
);

-- 关系表（1-hop 扩展）
CREATE TABLE edges (
  from_anchor TEXT NOT NULL,
  to_anchor TEXT NOT NULL,
  relation TEXT NOT NULL,  -- evolved_from/blocked_by/related/supersedes/invalidates
  PRIMARY KEY (from_anchor, to_anchor, relation)
);

-- 候选队列工作缓存（真相源在 docs/markers/*.yaml，KD-8'）
CREATE TABLE markers (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT NOT NULL,        -- cat_id + thread_id
  status TEXT DEFAULT 'captured',  -- KD-12: captured/normalized/approved/rejected/needs_review/materialized/indexed
  target_kind TEXT,            -- 预期 materialize 的类型
  created_at TEXT NOT NULL
);

-- KD-15: 预留 passage 级索引（v1 不填，1000+ docs 或 Phase C 启用）
-- CREATE TABLE evidence_passages (
--   doc_anchor TEXT NOT NULL REFERENCES evidence_docs(anchor),
--   passage_id TEXT NOT NULL,
--   content TEXT NOT NULL,
--   position INTEGER,
--   PRIMARY KEY (doc_anchor, passage_id)
-- );

-- Schema 版本（idempotent migration）
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

**关键规则**：
- `approved` marker 必须先 materialize 到稳定 source anchor（.md 文件），再由 `IIndexBuilder` 写入 `evidence_docs`。SQLite 是编译产物——rebuild 不会丢知识，因为真相源在文件系统
- markers 工作流状态的真相源是 `docs/markers/*.yaml`（git-tracked），SQLite 只是工作缓存
- 检索时 `superseded_by IS NOT NULL` 的结果降权或过滤（KD-16）
- WAL 模式 + 显式单写者队列（KD-18）
- FTS5 external-content 一致性封装到 `IIndexBuilder`（KD-18）

**A3. 路由解耦**：所有硬编码文件改为 DI 注入。

改造文件：
- `HindsightClient.ts` → 保留为 `HindsightEvidenceStore`（legacy adapter）
- `evidence.ts` 路由 → 注入 `IEvidenceStore`
- `callback-memory-routes.ts` → 注入 `IEvidenceStore`，retain 改写 markers 表
- `reflect.ts` → 拆为独立 `ReflectionService`（不属于存储层）
- `index.ts` → factory 按配置选实现
- `hindsight-import-p0.ts` → 适配新接口

### Phase B: 自动索引 + SOP 集成

数据源自动索引（解析 frontmatter → upsert 到 SQLite）：
- `docs/features/*.md` — feat-lifecycle 立项/关闭时
- `docs/decisions/*.md` — ADR 创建时
- sealed session digest — session 封存时

检索链路：`metadata filter (kind/status) → FTS5 search → edges 1-hop expand → source read`

### Phase C: 向量增强（预期路径）

在同一个 `evidence.sqlite` 上加表，不换存储——终态基座不变。纯 lexical 检索是已知短板（KD-5），Phase C 是预期路径而非可选。

**C1. Embedding 模型选型**

| 模型 | 角色 | ONNX int8 | 维度 | C-MTEB | Transformers.js |
|------|------|-----------|------|--------|-----------------|
| **Qwen3-Embedding-0.6B** | 主方案 | 614MB | 32-1024 (MRL) | 66.33 | onnx-community ✅ |
| multilingual-e5-small | 兜底 | ~130MB | 384 | ~50 | ✅ |

选 Qwen3 原因：与项目 Qwen 语音 pipeline 统一技术栈；中英混排 C-MTEB 66.33 远超候选；MRL 支持维度可调（KD-19）。

**C2. 三态开关 + fail-open**

```
EMBED_MODE = off | shadow | on    # 默认 off
EMBED_MODEL = qwen3-embedding-0.6b | multilingual-e5-small  # 默认 qwen3
```

- `off`：纯 Phase B lexical 检索，不加载模型
- `shadow`：lexical 为主，后台异步跑 embedding 并记录 A/B 指标（不影响用户结果）
- `on`：embedding rerank 生效，lexical 作为 fallback

**fail-open 规则**：模型下载 / 加载 / 推理任一失败 → 自动回落 Phase B lexical（不 block 检索）。

**C3. 资源门禁**

```
max_model_mem_mb = 800       # 超阈值直接降级到兜底模型或 off
embed_timeout_ms = 3000      # 单次推理超时 → 该请求走 lexical
```

**C4. 向量存储**

```sql
-- vec0 虚拟表（单一向量真相源，不在 evidence_docs 加列）
CREATE VIRTUAL TABLE evidence_vectors USING vec0(
  anchor TEXT PRIMARY KEY,
  embedding float[256]         -- MRL 维度，shadow 期 A/B 后确定
);
```

**C5. 可复现版本锚**

```sql
-- 索引元数据：模型/维度变更时触发全量 re-embed（不能静默混跑）
CREATE TABLE embedding_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 初始写入：embedding_model_id, embedding_model_rev, embedding_dim
```

模型或维度变更检测到与 `embedding_meta` 不一致 → 清空 `evidence_vectors` + 全量 re-embed。

**C6. Shadow 期 A/B**

`shadow` 模式下 `dim=128` 和 `dim=256` 各跑一轮评测（复用 Phase B `memory_eval_corpus.yaml`），对比 Recall@k 后再决定 `on` 的默认维度。

**C7. 检索链路（Phase C 增强后）**

```
metadata filter → FTS5 search → edges 1-hop expand → [embedding rerank] → source read
                                                       ^-- Phase C 新增
```

语义 rerank 仅对 FTS5 候选集做重排序（不替代 lexical 召回），保证 fail-open 时链路不断。

## Acceptance Criteria

### Phase A（6 接口 + SQLite 基座 + 解耦）
- [x] AC-A1: 六个接口定义（`IIndexBuilder` + `IEvidenceStore` + `IMarkerQueue` + `IMaterializationService` + `IReflectionService` + `IKnowledgeResolver`），不含 Hindsight 术语
- [x] AC-A2: `SqliteProjectMemory` 实现 `IEvidenceStore`，使用 `evidence_docs`（常规表）+ `evidence_fts`（FTS5 外部内容表）+ WAL 模式
- [x] AC-A3: `HindsightEvidenceStore` 实现 `IEvidenceStore`（legacy 兼容）
- [x] AC-A4: 所有路由通过 DI 注入接口，不直接 import HindsightClient — **Phase B 闭合（PR #409）**
- [x] AC-A5: `ReflectionService` 独立实现，不在 `IEvidenceStore` 接口内
- [x] AC-A6: `retain-memory` callback 写入 markers（状态 `captured`），approved marker 必须先 materialize 到 .md 才算沉淀
- [x] AC-A7: Factory 函数按配置选择实现（`EVIDENCE_STORE_TYPE=sqlite|hindsight`）
- [x] AC-A8: edges 表支持文档间关系查询（含 `supersedes`/`invalidates` 关系，1-hop expand）
- [x] AC-A9: `KnowledgeResolver` 联邦检索两个同质 SQLite index — **Phase B 闭合（PR #409）**
- [x] AC-A10: `IIndexBuilder.rebuild()` 含 idempotent migrations + schema version + PRAGMA setup + FTS5 consistency check
- [x] AC-A11: `IMaterializationService` 实现 approved → .md patch → trigger reindex 流程（skeleton，Phase B 完善 frontmatter 兼容）
- [x] AC-A12: markers 真相源在 `docs/markers/*.yaml`（git-tracked），SQLite markers 表仅为工作缓存

### Phase B（自动索引 + SOP 集成 + 评测）
- [x] AC-B1: frontmatter 解析器，从 .md 提取 anchor/kind/status/title/summary
- [x] AC-B3: feat-lifecycle 立项/关闭时自动 upsert 索引（与 SOP 集成）
- [x] AC-B4: search 支持 kind/status/keyword 过滤，检索时 `superseded_by IS NOT NULL` 降权
- [x] AC-B5: 比 grep docs/ 信噪比可测量提升（不返回 internal-archive/废案/discussion）
- [x] AC-B6: 新项目初始化时自动创建空 `evidence.sqlite`
- [x] AC-B7: `memory_eval_corpus.yaml` 评测集：检索评测（Recall@k）+ 状态评测（DB 变化验证），含 10-15 条 Hindsight 失败案例

### Phase C（向量增强——预期路径，非可选）✅
- [x] AC-C1: `EMBED_MODE` 三态开关（`off|shadow|on`，默认 `off`），`EMBED_MODEL` 可配置（`qwen3-embedding-0.6b` 默认 + `multilingual-e5-small` 兜底）
- [x] AC-C2: Qwen3-Embedding-0.6B ONNX 本地推理（Transformers.js），MRL 维度可配置
- [x] AC-C3: `evidence_vectors` vec0 虚拟表（单一向量真相源），不在 `evidence_docs` 加 embedding 列
- [x] AC-C4: fail-open — 模型下载/加载/推理任一失败自动回落 Phase B lexical
- [x] AC-C5: 资源门禁 `max_model_mem_mb` + `embed_timeout_ms`，超阈值降级
- [x] AC-C6: `embedding_meta` 版本锚——模型/维度变更触发全量 re-embed（禁止静默混跑）
- [x] AC-C7: shadow 期 A/B（`dim=128/256`），复用 `memory_eval_corpus.yaml` 对比 Recall@k
- [x] AC-C8: 语义 rerank 对 FTS5 候选集重排序（不替代 lexical 召回）
- [ ] AC-C9: `evidence_passages` 表按需启用（passage 级检索粒度，1000+ docs 后评估）— **deferred per spec**

## Dependencies

- **Evolved from**: F024（Session Chain — 提供了 sealed session digest 数据源）
- **Related**: F003（原始记忆系统研究）
- **Related**: F042（三层信息架构 — 索引结构参考）
- **Related**: F100（Self-Evolution — 全局记忆/Skills 体系，F102 的项目层与 F100 的全局层互补）

## Risk

| 风险 | 缓解 |
|------|------|
| 索引与文档不同步（stale index） | 索引记录 source_hash，`IIndexBuilder` 增量更新 + consistency check |
| FTS5 关键词检索精度不够 | Phase C 向量增强是预期路径（KD-5），不是可选 |
| 重蹈 retain 碎片化覆辙 | marker candidate queue + 分层审批（KD-3/9/12） |
| 多项目 SQLite 文件管理复杂度 | 每项目根目录一个 evidence.sqlite，gitignore + rebuild |
| rebuild 后丢失工作流状态 | markers 真相源在 git-tracked `docs/markers/*.yaml`（KD-8） |
| 过期知识高相似误召回 | `superseded_by` 字段 + 检索降权（KD-16） |
| 评测缺失导致上线后才发现检索质量差 | Phase B 加评测集（KD-17） |
| 614MB ONNX 模型拖慢启动/OOM | 资源门禁 + 兜底模型 + fail-open（KD-20） |
| 模型/维度变更后向量不一致 | 版本锚 + 全量 re-embed（KD-22） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 本地优先，不上外部服务/图数据库 | 三猫全票通过 | 2026-03-11 |
| KD-2 | `reflect` 从存储层拆出 | 它是 LLM 编排能力，不是存储 primitive | 2026-03-11 |
| KD-3 | retain 降级为 candidate/marker queue | 防止碎片化垃圾入库（Hindsight 失败教训） | 2026-03-11 |
| KD-4 | 自动索引 > 手动 retain | 与 feat-lifecycle SOP 集成，90% 记忆沉淀自动化 | 2026-03-11 |
| KD-5 | **SQLite 是终态存储基座**（不是终态检索策略），纯 lexical 不够，Phase C 向量增强是预期路径 | GPT Pro 打回：KD-5 原文把存储和检索混为一谈 | 2026-03-11 |
| KD-6 | **全局记忆跟猫走，项目记忆留在项目** | 全局=Skills/家规/MEMORY.md(F100)，项目=evidence.sqlite | 2026-03-11 |
| KD-7 | 每项目一个 evidence.sqlite（物理隔离） | 猫出征新项目不带旧项目 feat 细节 | 2026-03-11 |
| KD-8 | **索引 = gitignore + rebuild；markers = git-tracked durable store** | GPT Pro 打回：markers 有审核历史，不是编译产物，rebuild 会蒸发 | 2026-03-11 |
| KD-9 | markers 分层审批：项目内知识有 anchor+dedupe → 自动 approve；影响全局层 → needs_review 走 F100 | GPT-5.4 建议，避免全自动/全人工二选一 | 2026-03-11 |
| KD-10 | Schema 拆分：evidence_docs（常规表）+ evidence_fts（FTS5 外部内容表） | 结构化过滤不该塞 FTS5，GPT-5.4 P1 | 2026-03-11 |
| KD-11 | 联邦检索 KnowledgeResolver：全局层只读接入，不写进项目库 | F100 定了"不发明新沉淀库"，GPT-5.4 P1 | 2026-03-11 |
| KD-12 | marker 状态机：`captured→normalized→approved→materialized→indexed`（+ `rejected`/`needs_review` 分支） | GPT Pro 打回：`accepted` ≠ truth，`materialized` 才是终态 | 2026-03-11 |
| KD-13 | 新增 `IMaterializationService` + `IIndexBuilder` 接口（共 6 接口） | 晋升瞬间和编译器是一等公民，不能散落在角落 | 2026-03-11 |
| KD-14 | 全局层也编译 read-only `global_knowledge.sqlite` | resolver 不应混用 raw filesystem 和 SQLite MATCH | 2026-03-11 |
| KD-15 | 预留 `evidence_passages` 表（v1 不填） | 检索粒度太粗，1000+ docs 后 summary 不够 | 2026-03-11 |
| KD-16 | `superseded_by` 字段 + `supersedes`/`invalidates` 关系类型 | 过时高相似决策比查不到更危险 | 2026-03-11 |
| KD-17 | Phase B 加评测集 `memory_eval_corpus.yaml` | 上次痛点是"找不对"不是"存不了" | 2026-03-11 |
| KD-18 | WAL 模式 + 单写者队列 + `tokenchars` + `bm25()` 列权重 | SQLite 实操最佳实践，GPT Pro 建议 | 2026-03-11 |
| KD-19 | **Embedding 模型选 Qwen3-Embedding-0.6B**（主方案）+ multilingual-e5-small（兜底），MRL 维度可调 | team lead指示统一 Qwen 技术栈；C-MTEB 66.33 远超 MiniLM；中英混排核心场景 | 2026-03-12 |
| KD-20 | **三态开关 `off\|shadow\|on`** + fail-open 到 lexical | codex review：增强层不能拖累基础能力 | 2026-03-12 |
| KD-21 | **单一向量真相源** `evidence_vectors`（vec0 虚拟表），不在 `evidence_docs` 加 embedding 列 | codex review：避免双真相源 | 2026-03-12 |
| KD-22 | **可复现版本锚** `embedding_meta` 表：`model_id/model_rev/dim` 变更 → 全量 re-embed | codex review：禁止静默混跑不同模型/维度的向量 | 2026-03-12 |

## Review Gate

- Phase A: 跨 family review（Maine Coon优先）— 接口设计需要多方确认
- Phase B: 同 family review（Ragdoll Sonnet 可）— 实现层面
