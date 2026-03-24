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

### Phase D: 激活 — Hindsight 清理 + 数据源扩大 + 检索协议 + 提示词集成

> **触发**：team lead指示"Hindsight 去掉，把记忆组件跑起来"。
> **外部输入**：Artem Zhutov《Grep Is Dead》— QMD 本地检索层方案（collection 分层 + BM25/vec/hybrid + `/recall` 协议）。
> **两猫共识**：F102 引擎和 QMD 同构（都是 SQLite FTS5 + sqlite-vec + RRF），不引入 QMD，扩大 F102 数据源 + 给猫猫检索协议。
> **team lead核心指示**：功能做完必须修改提示词/skills，让猫猫感知到并主动使用。否则建了也白建。

**D-1. Hindsight 全量清理（三层拆解）**

| 层 | 范围 | 说明 |
|----|------|------|
| Runtime | routes 的 Hindsight 分支、factory `'hindsight'` 类型、HindsightClient/Adapter | 切断运行链路 |
| Config | `hindsight-runtime-config.ts`、ConfigSnapshot、env-registry 12 个 `HINDSIGHT_*` 变量、前端 config-viewer tab | 清理配置面 |
| Legacy | `docker-compose.hindsight.yml`、`scripts/hindsight/`、P0 import pipeline、~26 test files | 归档资产 |

**D-2. 启动自动 rebuild + 可观测**

- 进程启动后自动执行 `indexBuilder.rebuild()`（带锁防并发）
- `search_evidence` MCP 工具默认走 SQLite FTS5（不是 grep fallback）
- Memory status 可观测：`docs_count` / `last_rebuild_at` / `backend=sqlite`

**D-3. 数据源扩大：thread digest → evidence_docs**

- `IndexBuilder.discoverFiles()` 增加 session digest 数据源
- Session digest 已有结构（topics/decisions/participants），直接 parse 进 `evidence_docs`
- `kind='session'` 默认权重低于 feature/decision（避免聊天噪音淹没文档）
- **分层检索策略**（summary-first, raw-on-demand）：
  1. 先搜 `docs + memory`（feature/decision/plan/lesson/memory）
  2. 不够再搜 `threads-summary`（kind=session）
  3. 还不够才下钻 raw transcript（通过现有 MCP `cat_cafe_get_thread_context`）

**D-3b. 自动 edges 提取 + Memory invalidation（GitNexus 理念吸收）**

> **来源**：GitNexus 研讨（thread_mmst8x2uru65azwu），三猫+team lead共识。
> **原则**：吸收"预计算结构 + 变更影响检测"，不吸收图数据库/AST/聚类算法。
> **Maine Coon红线**：edges 只能来自**显式锚点**（frontmatter），不能从语义相似度推断。推断关系不可信。

- **自动 edges 提取**：`IIndexBuilder.rebuild()` 时从 frontmatter `related_features`/`feature_ids`/`decision_id` 交叉引用自动 upsert edges（零手工维护）
- **Memory invalidation**：`incrementalUpdate()` 检测到文档变更时，反向查询 edges 找依赖文档，标记为 `needs_review`（翻译自 GitNexus 的 `detect_changes`）

**D-4. 检索协议升级**

```typescript
// search 接口增强（三维参数）
search(query, {
  kind: ['feature', 'decision'],           // 过滤层（精确 kind）
  mode: 'lexical' | 'semantic' | 'hybrid', // 检索模式
  scope: 'docs' | 'memory' | 'threads' | 'sessions' | 'all', // 快捷分层
  depth: 'summary' | 'raw'                 // 噪音控制：默认 summary
})
```

检索路由策略：
- 找 feature / ADR / 明确术语 → `lexical`（BM25 first）
- 找"我们当时为什么这么决定" → `lexical + semantic`
- 找长聊天里隐含的同义表达 → `semantic` 或 `hybrid`
- 找源码 symbol / API 实现 → 继续 code search，不走记忆组件

**D-5. MCP 工具收敛（team lead指示：不能老的一套新的一套）**

现有 27 个记忆/检索相关 MCP 工具，分 4 条平行链路。Phase D 收敛为两层架构：

**Layer 1: 统一检索入口（猫猫日常用）**

| 工具 | 定位 |
|------|------|
| `search_evidence` | **唯一的 recall/search 入口**。支持 scope/mode/depth 参数，覆盖 docs + memory + threads + sessions |

```typescript
search_evidence(query, {
  scope: 'docs' | 'memory' | 'threads' | 'sessions' | 'all',
  mode: 'lexical' | 'semantic' | 'hybrid',
  depth: 'summary' | 'raw'  // summary-first, raw-on-demand
})
```

**Layer 2: Drill-down 工具（按需深入）**

| 工具 | 定位 | 何时用 |
|------|------|--------|
| `get_thread_context` | by-id fetch（实时上下文） | 已知 threadId，需要最近 N 条消息 |
| `list_threads` | 元数据查询 | 找 thread 列表 |
| `list_session_chain` | session 列表 | 已知 threadId，看 session 链 |
| `read_session_digest` | session 摘要 | search_evidence 命中 session 后深入 |
| `read_session_events` | session 详情（3 视图） | 需要看 raw transcript |
| `read_invocation_detail` | invocation 级取证 | 审计/调试 |
| `reflect` | 反思（证据之上的总结） | 需要 LLM 综合，不是检索入口 |
| `retain_memory` | 记忆沉淀 | marker 提交，不是检索工具 |

**废弃/吸收**

| 工具 | 处置 | 原因 |
|------|------|------|
| `search_evidence_callback` | **合并到 search_evidence** | callback auth 是实现细节，不该暴露两个工具 |
| `reflect_callback` | **合并到 reflect** | 同上 |
| `search_messages` | **吸收为 search_evidence(scope=threads, depth=raw) 的底层实现** | 不再作为独立一级入口 |
| `session_search` | **吸收为 search_evidence(scope=sessions) 的底层实现** | 不再作为独立一级入口 |

**不动**

| 工具 | 原因 |
|------|------|
| `signal_*`（12 个） | 独立系统，外部信息源，不是项目记忆 |
| `feat_index` | 元数据查询，不是内容检索 |
| `list_tasks` | 任务管理，不是记忆 |

**SystemPromptBuilder 也要改**：不能再把 session-chain 三件套排成"默认找历史的第一选择"。要先教猫猫用统一 `search_evidence`，再教怎么 drill-down。

**D-6. 提示词 + Skill 集成（team lead重点指示：最重要的一步）**

**这不是"有了再说"的事——这是 Phase D 的验收门槛。**

- **系统提示词注入**：在 CLAUDE.md / AGENTS.md 中告知猫猫"你有记忆组件，该这样用"
  - 类似 Claude 的 memory 机制：系统提示词里告诉 agent 它有 memory、该怎么查
  - 包含检索策略表（什么场景用什么模式）
- **Recall Skill**：写一个 `recall` skill（或融入现有 skill），让猫猫开工前自动检索
  - 取当前任务标题 / feature_id / thread topic
  - 先查 docs + memory，不够再查 threads-summary
  - 只注入 5-10 条最相关的 snippet 到上下文
- **feat-lifecycle 集成**：立项/状态变更/关闭时自动 `incrementalUpdate`
- **SOP 更新**：在 `docs/SOP.md` 中加入"开工前先 recall"的步骤

### Phase E: Thread 内容索引 — 从"空壳"到"300 thread 可搜"

> **触发**：Phase D runtime 测试暴露核心 gap——thread 对话内容不可搜。
> **Maine Coon(GPT-5.4) 愿景守护结论**：Phase D AC 文档闭合度 90%，runtime 验收完成度 60%。
> **team lead核心需求**："把我们的整个 thread 检索归一到记忆组件"
> **三层真相源设计**（两猫共识）：threadMemory.summary + sealed transcript events.jsonl + live MessageStore

**当前 Gap（Phase D 测试 thread 暴露）**

| 优先级 | Gap | 根因 |
|--------|-----|------|
| P1 | scope=threads/sessions 返回 0 结果 | session digest 路径解析问题（类似 docsRoot CWD bug，PR #524 修了 docs 但 transcriptDataDir 可能仍有问题） |
| P1 | 300 个 thread 对话内容不可搜 | thread 消息在 Redis（TTL=0 永久），但从未被索引到 evidence.sqlite |
| P2 | reflect 返回空 | ReflectionService 仍是空壳 `async () => ''` |
| P2 | lesson/pitfall 召回偏 | redis pitfall 命中无关 F048 |

**E-1. Thread Summary Layer（Step 1）**

目标：让 thread 在统一入口里"有摘要层可命中"。不是"thread 内容可搜已完成"。

- 新增 `kind='thread'`（区别于 `session` = sealed session digest）
- `anchor = thread-{threadId}`
- `title = thread.title`
- `summary` = **从 messageStore 读消息内容拼接 turn-by-turn 文本**（KD-32/33：不靠 threadMemory.summary，不导出 markdown）
  - `[speaker] content` 格式，截取合理长度
  - 340 个 thread 全部入库（不再跳过无 summary 的）
- `keywords = [参与者 catId, backlogItemId, feature_ids]`
- **dirty-thread + 30s debounce flush** 基础设施
  - `messageStore.append()` 后标记 threadId dirty
  - 每 30 秒批量刷新 dirty threads 到 SQLite
  - 启动时全量 catch-up

**E-2. Thread Raw Passage Layer（Step 2）**

目标：让"Redis 坑在第 47 条消息"也能命中。这才是真正兑现"thread 内容可搜"。

- 启用 `evidence_passages` 表（Schema V3）
- 数据源：sealed transcript `events.jsonl` chat 文本 + live `MessageStore` 未封存增量
- 切 passage 策略：按 turn/消息，每条消息一个 passage
- `depth=raw` 时搜 passages，聚合回 `thread-{threadId}`
- FTS5 索引扩展到 passages 表

**E-3. 辅修**

- reflect 返回显式降级消息（不再返回空字符串）
- lesson/pitfall 召回质量改进（keywords 补充 + FTS5 索引调优）
- session digest 路径修复（确认 transcriptDataDir 解析正确）

### Phase F: 多项目记忆 — 猫猫出征新家/接手老项目（待实现）

> **触发**：team lead问"猫出征到 dare/studio-flow 怎么办？记忆系统怎么办？"
> **核心决策**：KD-35（两种策略）+ KD-36（遗留项目 frontmatter formatter）

**F-1. 新项目策略：家规引导建标准 docs 体系**

- 猫带着 Skills 出征 → Skills 里 feat-lifecycle 引导建 `docs/features/`、`docs/decisions/` 等标准目录
- `IndexBuilder` 的 KIND_DIRS 直接适配（13 个标准目录）
- 需要：`project-init` skill 或脚本，猫到新项目时自动创建 docs 骨架

**F-2. 遗留项目策略：通用递归扫描**

- `discoverFiles()` 增加 fallback：先扫 KIND_DIRS 标准目录，再递归扫剩余 `.md`
- Kind 从路径推断（KIND_DIRS 表）→ frontmatter → 默认 `plan`
- 不要求遗留项目有特定目录结构——有 `.md` 就索引

**F-3. 遗留项目 Frontmatter Formatter**

- 扫描遗留项目的 `.md` 文件，自动补充 frontmatter metadata
- 推断 `doc_kind`（从路径/内容关键词）、`topics`（从标题/内容提取）、`anchor`（从文件名）
- 可选人工确认或全自动
- 提升 kind 推断准确度和检索质量

**F-4. 全局知识层（跟猫走）**

- 编译 `global_knowledge.sqlite`：从 Skills/家规/MEMORY.md/lessons-learned 编译只读索引
- 放在猫猫 home 目录（`~/.cat-cafe/global_knowledge.sqlite`），不在项目里
- `KnowledgeResolver` 联邦检索：search 时同时查 project + global 两个 SQLite，RRF 融合
- 猫出征新项目 → 带走全局层，在新项目搜"Redis 坑"能命中 cat-cafe 的教训

**当前可用度**（无需 Phase F 即可用）：
- 新项目 docs 自动索引 ✅（如果按标准目录建）
- thread 消息自动入库 ✅（append listener）
- Skills/提示词跟猫走 ✅
- "开工前先搜"的习惯跟猫走 ✅
- SessionBootstrap auto-recall ✅

**Phase F 后新增**：
- 遗留项目任意 `.md` 可索引
- 跨项目检索（在 dare 里搜 cat-cafe 的教训）
- frontmatter 自动补全工具

### Phase G: Abstractive Summary + Durable Memory Lifecycle（🚧 基础设施已合入，运行时验收中）

> **触发**：team lead发起 Lossless Claw（LCM）调研，三猫（opus + opencode + gpt52）协作对比 LC 与 session chain / F102，收敛出可学习的改进点。
> **核心学习**：从 LC 学到的不是 DAG 数据结构，是"压缩不等于丢弃，摘要必须可穿透"的理念。
> **三猫共识**：LC 最对标的是 F065 Session Continuity，不是 F102。但 F065→F102 的写路径（pre-seal → durable knowledge）是核心改进点。

**G-1. Thread-level Abstractive Digest + Durable Candidate Extraction（KD-37/38/41）**

> **team lead关键修正（KD-41）**：摘要单元是 **thread**（不是 session），触发方式是**定时任务**（不是 seal）。理由：(a) session strategy 可配置（compress/handoff/hybrid），不一定有 seal；(b) thread 是所有猫共享的对话空间，对每只猫的 session 分别摘要 = 同一段对话重复摘要；(c) 定时任务比事件驱动更稳健。
>
> **Maine Coon(GPT-5.4) 关键收紧**：digest 和 candidate extraction 合并成**一次 Opus 调用**。输出 schema、candidate 硬边界、skip path 仍然适用。

一次调用同时产出两样东西：

- **Abstractive digest**：回答"这个 thread 最近讨论了什么、决定了什么、风险和下一步"
- **Durable candidates[]**：回答"这里面哪些内容值得升格为长期知识"

模型：**Opus 4.6**（通过 F062 provider-profiles 反代 API，零新增基础设施）——team lead明确指示不用 Haiku。
**fail-open**：API 调用失败不影响现有拼接摘要，下次定时任务重试。

**输入**：thread 消息增量（`lastSummarizedMessageId` 水位线之后的新消息），不是某只猫的 session transcript。所有猫在同一个 thread 的对话**只摘要一次**。

**Output Schema（Maine Coon定义，thread 化适配）**

```json
{
  "digest": {
    "title": "本 thread 最近讨论了什么",
    "summary": "200-400 字，讲清讨论/决定/风险/下一步"
  },
  "candidates": [
    {
      "kind": "decision | lesson | method",
      "title": "为什么 thread 摘要不能实时调 Opus",
      "claim": "运行时 dirty thread 只做拼接，Opus 摘要走异步批处理",
      "why_durable": "这是后续实现和运维都要遵守的规则",
      "evidence": [
        {"threadId": "thread_xxx", "messageId": "msg_xxx", "span": "原文摘录"}
      ],
      "relatedAnchors": ["F102", "F065"],
      "confidence": "explicit | inferred"
    }
  ]
}
```

注意 evidence 改为 `threadId + messageId`（不是 sessionId），因为摘要单元是 thread。

**Candidate 硬边界（Maine Coon红线，不变）**：
- 只允许 3 类：`decision` / `lesson` / `method`——硬编码枚举
- 必须带 `evidence`（threadId + messageId + 原文 span）和 `relatedAnchors`
- `confidence: "explicit"` → 默认 `normalized`；`"inferred"` → 默认 `needs_review`；**一律不直接 `approved`**
- **`explicit` 判定收窄**（Maine Coon R2）：仅 (a) team lead/owner 明确拍板；(b) 有明确共识语句可直接引用；(c) 已对应到 merged doc/code 事实。"说得像决定"不算 explicit
- **禁止提取**：未定方案/brainstorm、临时 TODO/WIP、碎片上下文、"模型总结性发挥"
- Prompt 定位是"**抽取器**"不是"总结器"

**Eligibility Rule（Maine Coon R3 统一，G-1 和 G-2 共用同一套规则）**：

```
eligible =
  quietWindow >= 10min
  AND (
    pendingMessages >= 20
    OR pendingTokens >= 1500
    OR decision/code/error-fix markers hit    ← 高价值信号 bypass 消息数
  )
  AND (
    cooldown >= 2h
    OR high-signal bypass                     ← 重要决策不等 2h
  )
```

纯闲聊/路由 thread（无高价值信号且消息数/token 均未达标）继续只用拼接 summary。

**API 接入（金渐层确认）**：

```typescript
// 复用 F062 provider-profiles，零新增基础设施
const profile = await resolveAnthropicRuntimeProfile(projectRoot);
// profile.baseUrl + profile.apiKey → 标准 Anthropic Messages API
// model: 'claude-opus-4-6', max_tokens: 1024
```

Rate limit 5000 次/天（team lead确认），日常消耗远低于限额。

**G-2. LSM-style Compaction 摘要架构（KD-39/41/42，三猫+team lead收敛版）**

> **team lead类比**："参考存储是怎么压缩内存的"——LSM-tree（Log-Structured Merge Tree）的分层 compaction 和我们的问题同构。
> **三猫独立收敛**：三猫都独立想到了 LSM compaction 类比（L0 实时拼接 / L1 定时摘要 / L2 deferred 凝结）。
> **Maine Coon提出分段模型（segment-based）**：每次产出独立 summary segment 而不是覆写单一摘要——解决漂移/不可审计/错误放大。
> **架构决策（KD-42 修正）**：采纳Maine Coon的分段 ledger 设计——`evidence_docs.summary` 作为 read model，`summary_segments` 作为 append-only provenance。成本几乎不变（多一张表一次 INSERT），但解决漂移/不可审计/错误放大。L2 凝结仍 deferred。

| 层 | 触发 | 产物 | 状态 |
|----|------|------|------|
| **L0 实时拼接** | dirty-thread flush（30s debounce，<100ms） | `summaryType=concat`，现有拼接 | 已有，不改 |
| **L1 定时摘要** | 定时任务 + 三条件门槛 | L1 summary segment + candidates[] | 新增（MVP） |
| **L2 分段凝结** | （deferred）L1 segment 积累到一定数量/体积 | L2 rollup segment（supersedes 多个 L1） | 预留，但 segment ledger 让升级成本很低 |

**双写路径**（read model + append-only ledger）：

```
evidence_docs.summary     ← read model（搜索/bootstrap 直接读这个，始终是"当前最优摘要"）
summary_segments           ← append-only ledger（每次 L1/L2 摘要都插入一条，永不删除）
```

**dirty thread 结合方式**（dirty 管 L0，定时任务管 L1，两层解耦）：

```
消息写入 → markThreadDirty(threadId)     ← 已有，不改
         → 每 30s flushDirtyThreads()   ← 已有（L0 拼接）
              → 新增：pendingMessageCount++ （为 L1 调度提供信号）

定时任务（每 30 分钟，per-tick 最多处理 5 个 thread）
  → 读 pendingMessageCount
  → 统一 eligibility rule 判断（G-1 共用）：
     quietWindow >= 10min
     AND (pending >= 20 OR tokens >= 1500 OR high-signal)
     AND (cooldown >= 2h OR high-signal bypass)
  → 输入：上次 evidence_docs.summary + 水位线后的增量消息
  → 输出：1..N 个 topic segments（Opus 按话题切分） + candidates
  → (1) INSERT 1..N summary_segments（append-only，永不删除）
  → (2) UPDATE evidence_docs.summary（从所有最新 segments 合成 read model）
  → (3) 更新水位线 + 重置 pendingCount
```

**不依赖 session chain / seal / session strategy**——只看 thread 消息增量。

**存量 backfill**：首次启动时对历史 thread 做一轮全量，串行跑，每次间隔 2s。

**Topic Segment 切分规则（team lead提出 + Maine Coon约束，KD-43）**：

一次 delta batch 可产出 **1..N 个连续 topic segments**（Opus 按话题边界切分），而不是强制一段。

硬约束（Maine Coon R4，模型在笼子里工作）：
- segments 必须**连续、按顺序、互不重叠**
- segments 必须**完整覆盖**当前 batch（不能跳消息）
- `fromMessageId` 不能早于本次水位线，`toMessageId` 不能晚于 batch 末尾
- 最多切 **3 段**，避免过碎
- **最小切分门槛**：batch < 600 tokens 或 < 8 条消息时，强制 1 段（Maine Coon R4b）
- 不确定时**退化成 1 段**（宁可混话题也不乱切）
- 跨时间窗的话题连续性：**只做 link（relatedSegmentIds），不做 merge/回改旧 segment**
- 真正的跨时间窗话题合并留给 L2 rollup

**summary_segments 表（Maine Coon定义 + R4 topic 字段，append-only ledger）**：

```typescript
{
  id: string;                        // segment UUID
  threadId: string;
  level: 1 | 2;                     // L1 = delta, L2 = rollup
  fromMessageId: string;            // 本段覆盖的消息范围起点
  toMessageId: string;              // 本段覆盖的消息范围终点
  messageCount: number;
  summary: string;                  // 本段的摘要文本
  topicKey: string;                 // 稳定话题 key（canonical slug，L2 按此 rollup/聚类）
  topicLabel: string;               // 给人看的话题标题（可变，不用于关联）
  boundaryReason: string;           // 为什么在这里切分（可审计）
  boundaryConfidence: 'high' | 'medium' | 'low';
  relatedSegmentIds?: string[];     // 与历史哪些 segment 主题连续（link，不 merge）
  candidates?: DurableCandidate[];  // 本段提取的候选知识
  supersedesSegmentIds?: string[];  // L2 才有：supersede 哪些 L1 segment
  modelId: string;                  // e.g., 'claude-opus-4-6'
  promptVersion: string;            // e.g., 'g2-thread-abstract-v1'
  generatedAt: string;              // ISO timestamp
}
```

**summary_state 水位线**（Maine Coon R3：补 token + signal，不然调度器实现不了 eligibility rule）：

```typescript
// evidence_docs 扩展或独立表
{
  lastSummarizedMessageId: string;   // 上次摘要覆盖到的消息 ID
  pendingMessageCount: number;       // dirty flush 累积的增量消息数
  pendingTokenCount: number;         // dirty flush 累积的增量 token 估算
  pendingSignalFlags: number;        // bitflags: decision=1, code=2, error-fix=4
  summaryType: 'concat' | 'abstractive';
  lastAbstractiveAt?: string;        // 上次 L1 摘要时间
  abstractiveTokenCount?: number;    // 当前摘要长度（监控漂移信号）
}
```

发现摘要偏了 → 从 summary_segments 审计哪一段出问题 → 从原始消息 rebuild 该段以后的所有摘要（WAL 重放）。

**三个可配置常量**（Maine Coon nit：不要散成裸字面量）：

```typescript
const SUMMARY_CONFIG = {
  pendingMessageThreshold: 20,   // 消息数门槛
  pendingTokenThreshold: 1500,   // token 门槛（覆盖"消息少但重"的情况）
  cooldownHours: 2,              // 距上次摘要最小间隔
  quietWindowMinutes: 10,        // 安静窗口
  perTickBudget: 5,              // 每次定时任务最多处理几个 thread
  backfillIntervalMs: 2000,      // 存量 backfill 间隔
  driftAlertTokenThreshold: 800, // Phase 2 升级监控：连续 3 次 > 此值 = 漂移信号
};
```

**Phase 2 预留：L2 Rollup + 多段读模型（Maine Coon R3 可观测升级触发器）**

> **注意**：Phase 1 MVP 已经有 `summary_segments` append-only ledger（每次 L1 都 INSERT）。Phase 2 新增的不是"分段"（已有），而是：(a) L2 rollup 凝结；(b) bootstrap 从多段拼装；(c) 坏段隔离能力。

升级触发条件——**任一可观测条件命中**：

1. **漂移信号**：某 thread 的 `abstractiveTokenCount` 连续 3 次 L1 摘要后上升且 > 800 tokens
2. **质量信号**：canary thread 的摘要人工抽检连续 2 次失败（计划：每月抽 3 个活跃 thread）
3. **事故信号**：出现 1 次明确的"摘要漂移导致错误 recall"的事故（记入 lessons-learned）

升级后新增能力：
- L2 rollup segment：多个 L1 segment 凝结为一个 L2（level=2, supersedes L1 segments）
- Bootstrap 改为：最新 L2 + 若干最近 L1 + raw tail（而不是单一 evidence_docs.summary）
- evidence_docs.summary 仍由定时任务从最新 L2 + 最近 L1 合成（read model 不变）
- 坏段可丢弃不影响其他段（因为 L1 segment 是独立的）

segment ledger 在 Phase 1 已存在，Phase 2 升级只需改**读路径和凝结逻辑**。

**G-3. ThreadMemory 增强（KD-40）**

当前 `buildThreadMemory` 是 append-to-head + trim-from-tail 的滚动文本——老信息会被彻底删除。

升级：当 thread 有 `summaryType=abstractive` 的摘要时，bootstrap 直接用 abstractive summary 而不是拼接文本。近期消息仍然带原文（和现在一样），远期部分由 abstractive summary 覆盖。

定时任务每次跑的时候，输入是"上次 abstractive summary + 增量消息" → 产出新的合并摘要。这本身就是渐进凝结（LSM minor compaction），不需要额外的凝结步骤。

**G-4. 搜索结果穿透路标**

`search_evidence` 命中 `kind=session` 或 `kind=thread` 结果时，返回值增加 `drillDown` 字段：

```typescript
interface EvidenceItemWithDrillDown extends EvidenceItem {
  drillDown?: {
    tool: string;           // e.g., 'read_session_events'
    params: Record<string, string>;  // e.g., { sessionId, view: 'handoff' }
    hint: string;           // e.g., '可用此工具查看完整对话'
  };
}
```

让猫从"搜到但不知怎么看详情"变成"搜到→一键下钻"。

**G-5. Conversation Identity 统一语义边界（ADR 待立项）**

五个概念（Thread / Session Chain / Active Slot / Connector Binding / CLI Resume）各自定义清晰，但缺少"它们如何协同"的统一叙事。需要一份 ADR 把端到端流转路径画清楚：

```
用户消息 → connector binding 找 thread → thread 找猫的 active slot
  → active slot 找 session → 事件写入 session → seal → digest → F102 索引
```

此项不在 F102 内实现，作为独立 ADR 立项，link 回 F102 + F065 + F088。

## 已知 Gap（待后续实现的猫猫注意！）

> 以下问题由本线程（f102 记忆组件解耦 thread）在 runtime 测试中发现，记录在此供后续实现的猫猫参考。

### Gap-1: Embedding 未开启（Phase C 代码就绪但默认 off）

**现状**：`EMBED_MODE` 默认 `off`，runtime 跑的是纯 BM25 lexical 检索。Phase C 建的整套向量基础设施（EmbeddingService + VectorStore + SemanticReranker + 三态开关 + fail-open + 版本锚）全部空转。

**影响**：中英混搜弱（搜 "cat naming" 找不到中文"猫名故事"），同义表达不匹配（搜 "标题太长" 找不到 "title truncated"）。

**修法**：设 `EMBED_MODE=on`（或先 `shadow`）。模型 Qwen3-Embedding-0.6B ONNX ~614MB，首次加载下载，之后缓存。Mac 上内存占用 ~1GB，推理 <100ms/条。

**注意**：直接跳 `on` 可能更合理——见 Gap-2。

### Gap-2: Shadow 模式无日志（跑了白跑）

**现状**：`EMBED_MODE=shadow` 时，代码确实跑了向量检索 + rerank，但结果存到 `_reranked` 变量后**直接丢弃**，没有任何日志或对比数据记录。

**代码位置**：`SqliteEvidenceStore.ts` L216-219：
```typescript
} else if (this.embedDeps.mode === 'shadow') {
  const _reranked = reranker.rerankWithDistances(lexicalResults, vecResults);
  // Silent comparison — actual logging added in eval phase  ← 从没加过
}
```

**修法选项**：
- A: 补 shadow 日志（记录 lexical vs reranked 排序差异，用于 A/B 评估）
- B: 直接跳过 shadow，上 `on`（Phase C eval corpus 已证明 embedding rerank 对 Recall 的提升）
- **team lead倾向 B**（shadow 没实际产出，浪费 CPU）

### Gap-3: Stories/Lessons 中英混搜需要 embedding

**实测证据**（本线程测试 thread）：
- 搜 "cat naming origin story"（英文）→ 0 命中。搜 "stories cat-names 名字"（中文+路径）→ 5 命中。
- 根因：FTS5 unicode61 tokenizer 不做中文分词，中英之间无语义桥接。
- **只有开启 embedding 才能真正解决**（向量空间里 "cat naming" 和 "猫名故事" 自然靠近）。
- 临时补 frontmatter topics 能治标但不可持续——每个新文档都要手动加。

### 建议实现顺序

1. ~~先开 `EMBED_MODE=on`~~ ✅ 已完成（PR #618 auto-derive from EMBED_ENABLED）
2. ~~验证 Recall 提升~~ ✅ 已验证：hybrid 搜 "cat naming origin story" 命中花名册
3. ~~如果要保留 shadow 模式~~ ✅ 已废弃 shadow（直接 off → on）

### Gap-4: semantic/hybrid 模式未正确实现（Phase C 缺口）

**现状**：`SqliteEvidenceStore.search()` 不读 `mode` 参数。三种模式走同一条路径：
- BM25 召回 → embedding rerank（如果可用）

**问题**：
- `mode=semantic` 应该跳过 BM25，纯向量 NN 搜索。当前等同 hybrid。
- `mode=hybrid` 应该 BM25 召回 + 向量 NN 召回 → 合并去重 → RRF 融合。当前只做 rerank。
- `mode=lexical` 应该纯 BM25。当前行为恰好是对的（rerank 在 embedDeps=null 时跳过）。

**影响**：搜 "why are cats named Ragdoll Maine Coon Siamese" 时，BM25 召回不到猫名故事，
embedding 无法补救（rerank 只重排已召回的，不发现新文档）。

**正确实现**：

```typescript
// mode=lexical: 纯 BM25（现有）
// mode=semantic: 纯向量 NN → evidence_vectors nearest-neighbor
// mode=hybrid: BM25 召回一批 + 向量 NN 召回一批 → 合并去重 → RRF 融合排序
```

**修改文件**：`SqliteEvidenceStore.ts` 的 `search()` 方法

**KD-44**：三种检索模式各有独立实现路径，semantic 不依赖 BM25 召回。

## Phase D 完成后的预期效果

> team lead指示：做完后要讲清楚"team lead日常使用感受到什么优化"和"猫猫自己感受到什么优化"。跑一段时间才知道做得好不好。

### team lead视角（日常使用中的变化）

**之前**：
- team lead问"我们之前怎么决定的？"→ 猫猫 grep docs/ → 翻一堆文件 → 可能漏掉关键讨论
- team lead问"上次那个 Redis 坑是怎么回事？"→ 猫猫不记得在哪个 thread → grep 关键词 → 找到 threadId → 拉全量消息 → 人肉翻
- team lead让猫做新 feature → 猫从零开始，不知道历史上类似功能踩过什么坑
- 改了一个 ADR → 没人提醒依赖这个 ADR 的 3 个 feature docs 需要同步更新

**之后**：
- team lead问"我们之前怎么决定的？"→ 猫猫自动 `search_evidence("memory adapter 决策", scope=docs)` → 直接返回 ADR-005 + F102 spec + 相关讨论摘要，带 score 排序
- team lead问"上次那个 Redis 坑？"→ 猫猫 `search_evidence("Redis 坑", scope=all)` → 命中 LL-001 lesson + session digest → 一步到位，不用先找 threadId
- team lead让猫做新 feature → **开工前自动 recall**（系统提示词 + skill 驱动）→ 猫带着历史上下文开始工作，不重蹈覆辙
- 改了 ADR → `incrementalUpdate` 自动查 edges → 提醒"F042/F088 依赖这个 ADR，需要 review"

**team lead最直观的感受**：猫猫回答问题时不再说"让我搜搜看"然后翻半天。它们开工时自带上下文，像一个有记忆的同事而不是每次都从零开始的实习生。

### 猫猫视角（自身工作流的变化）

**之前**：
- 4 条平行检索链路（evidence/session/thread/grep），不知道该用哪个
- `search_evidence` 搜空库（evidence.sqlite 从没被创建）
- 想找历史讨论 → grep → 噪音大 → 经常找不到关键信息
- 接手不熟悉的 feature → 读 spec → 漏掉相关讨论和教训

**之后**：
- **一个入口**：`search_evidence` 覆盖 docs + memory + threads + sessions
- **开工前自动 recall**：系统提示词告诉猫"你有记忆组件"，skill 引导猫开工前先搜
- **搜到即用**：FTS5 + 向量 rerank，中英混排，命中结果带 source_path + score
- **知识不过期**：edges 自动维护，文档变更自动标依赖文档 `needs_review`
- **不重蹈覆辙**：lessons-learned、教训、踩坑经验都在索引里，recall 时自动浮现

### 可量化的验收指标

| 指标 | 目标 |
|------|------|
| 启动到可检索 | ≤60 秒 |
| Canary query 命中率 | 3/3 固定 query 稳定返回预期 anchor |
| 增量 freshness | 改 doc 后 ≤30 秒可检索新内容 |
| Embedding fail-open | 检索成功率不下降 |
| MCP 工具数量 | 从 4 条平行链路 → 1 个入口 + 8 个 drill-down |
| 猫猫检索步骤 | 从"grep → threadId → grab → 人肉翻"→ "search_evidence 一步" |

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
- [x] AC-C9: `evidence_passages` 表按需启用（passage 级检索粒度，1000+ docs 后评估）— **Phase E PR #531 实现（thread passages）**

### Phase D（激活 — Hindsight 清理 + 数据源扩大 + 检索协议 + 提示词集成）
- [x] AC-D1: 运行链路中无 Hindsight 调用分支，factory 只有 `sqlite` 路径 — **PR #501 merged**
- [x] AC-D2: 12 个 `HINDSIGHT_*` 环境变量、ConfigSnapshot hindsight 段、前端 config-viewer hindsight tab 全部移除 — **PR #503 merged**
- [x] AC-D3: Hindsight legacy 资产归档（docker-compose、scripts、P0 import、~26 tests） — **PR #503 merged**
- [x] AC-D4: 启动 60 秒内 `evidence.sqlite` 存在且 `evidence_docs > 0`（自动 rebuild） — **PR #503 merged**
- [x] AC-D5: `search_evidence` MCP 工具默认走 SQLite FTS5，至少 3 条 canary query 稳定返回预期 anchor — **PR #509 merged**
- [x] AC-D6: Session digest 索引为 `kind='session'`，默认检索权重低于 feature/decision — **PR #518 merged**
- [x] AC-D7: 检索接口支持 `mode`（lexical/semantic/hybrid）和 `scope`（docs/memory/threads/all）参数 — **PR #513 merged**
- [x] AC-D8: Memory status 可观测（docs_count / last_rebuild_at / backend） — **PR #511 merged**
- [x] AC-D9: **CLAUDE.md / AGENTS.md 提示词更新**——告知猫猫记忆组件存在、检索策略、使用方式 — **PR #509 merged**
- [x] AC-D10: **Recall Skill 或等效 SOP 集成**——猫猫开工前自动/主动检索相关上下文 — **PR #509 merged（等效 SOP：CLAUDE.md/AGENTS.md 策略表）**
- [x] AC-D11: feat-lifecycle 集成——立项/状态变更/关闭时自动 `incrementalUpdate` — **PR #521 merged（POST /api/evidence/reindex）**
- [x] AC-D12: 修改 feature 文档后 30 秒内可检索到新标题/摘要（增量 freshness） — **PR #521 merged**
- [x] AC-D13: Embedding load 失败时检索成功率不下降（fail-open lexical 保底） — **Phase C AC-C4 已实现，PR #511 验证**
- [x] AC-D14: `search_evidence` 成为统一检索入口，支持 `scope`/`mode`/`depth` 参数 — **PR #513 merged**
- [x] AC-D15: `search_messages` 和 `session_search` 降级为内部实现，不再作为独立 MCP 工具暴露 — **PR #523 merged**
- [x] AC-D16: callback auth 版本合并到主版本（`search_evidence_callback` → `search_evidence`，`reflect_callback` → `reflect`） — **PR #523 merged**
- [x] AC-D17: SystemPromptBuilder 更新——`search_evidence` 排在记忆工具第一位，drill-down 工具排在后面 — **PR #523 merged**
- [x] AC-D18: `IIndexBuilder.rebuild()` 自动从 frontmatter 交叉引用（`related_features`/`feature_ids`/`decision_id`）提取 edges（零手工维护） — **PR #509 merged**
- [x] AC-D19: `incrementalUpdate()` 变更检测 → edges 反向查询 → 依赖文档标 `needs_review`（memory invalidation） — **PR #521 merged**

### Phase E（Thread 内容索引 — 从"空壳"到"300 thread 可搜"）
- [x] AC-E1: Thread summary 索引为 `kind='thread'`（`anchor=thread-{threadId}`，`summary=threadMemory.summary`） — **PR #526 merged**
- [x] AC-E2: dirty-thread + 30s debounce flush 基础设施（messageStore.append → dirty → 30s batch flush） — **PR #526 merged**
- [x] AC-E3: `evidence_passages` 表启用（Schema V3）+ sealed transcript chat 文本切 passage — **PR #531 merged**
- [x] AC-E4: live MessageStore 未封存增量切 passage 入库 — **PR #531 merged**
- [x] AC-E5: `scope=threads` + `depth=raw` 搜 passages 并聚合回 thread — **PR #531 merged**
- [x] AC-E6: reflect 返回显式降级消息（不再返回空字符串） — **PR #526 merged**
- [x] AC-E7: session digest 路径修复（transcriptDataDir 解析确认正确） — **PR #537 merged**
- [x] AC-E8: lesson/pitfall 召回质量改进 — **PR #537 merged（splitLessonsLearned 32 个独立条目）**

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
| KD-23 | **不引入 QMD 外部依赖**——F102 引擎与 QMD 同构（SQLite FTS5 + sqlite-vec + RRF），扩大数据源即可 | 两猫共识：双轨维护成本 > 收益，违反 KD-1 | 2026-03-16 |
| KD-24 | **thread 检索 summary-first, raw-on-demand**——默认搜 session digest，不搜 raw transcript | 聊天噪音会淹没文档；Artem 方案的核心也是分层 | 2026-03-16 |
| KD-25 | **检索路由 BM25-first**——大多数查询先 lexical，semantic 是增强层不是主路 | 冷启动快、稳定、三猫并发友好 | 2026-03-16 |
| KD-26 | **提示词/Skill 集成是验收门槛**——功能做完必须修改系统提示词，否则猫猫不会用 | team lead直接指示："就算做了超酷功能，没有感知到也不会用" | 2026-03-16 |
| KD-27 | **MCP 工具两层收敛**——统一入口 `search_evidence` + drill-down 层（thread/session/reflect），废弃 4 个冗余工具 | 两猫+team lead共识：不能老一套新一套双轨并存 | 2026-03-16 |
| KD-28 | **search_evidence 加 `depth` 参数**（summary/raw）——默认 summary-first，raw-on-demand | Maine Coon补充：scope 不够，depth 维度决定噪音量 | 2026-03-16 |
| KD-29 | **edges 只从显式锚点提取**（frontmatter），不从语义相似度推断——推断关系不可信 | Maine Coon红线：错边会把猫带去错误历史 | 2026-03-16 |
| KD-30 | **Memory invalidation 翻译自 GitNexus detect_changes**——不做 code impact，做 knowledge invalidation | 三猫共识：对 F102 更有价值的是"改了 ADR → 标依赖文档 needs_review" | 2026-03-16 |
| KD-31 | **不做代码图谱**——图数据库/Tree-sitter/Leiden/Cypher 是代码智能方案，不是记忆方案 | 三猫+team lead共识："太重了"，解的是错层问题 | 2026-03-16 |
| KD-32 | **Thread 索引不导出 markdown**——直接从 messageStore 读消息内容编译索引，不转中间层 md 文件 | team lead明确否决 + Maine Coon方案共识：真相源在 Redis（TTL=0 永久），索引是编译产物，导出 md = 重复真相源 | 2026-03-18 |
| KD-33 | **Thread 索引不靠 threadMemory.summary**——340 thread 中 326 个 summary 为空，必须从消息内容本身提取可搜文本 | team lead指出"threadMemory.summary 不靠谱"，回溯 QMD proposal 确认：正确做法是 turn-by-turn 消息拼接 | 2026-03-18 |
| KD-34 | **Thread 索引增量更新必须覆盖所有 messageStore.append 调用点（36 个）**——不能只 hook 2 条 HTTP 路由，必须在 messageStore 内部加 post-append callback | team lead问"好几天不重启怎么办"，代价分析：IO/CPU 可忽略（<5ms/thread），真实代价只是"确保覆盖所有写入路径" | 2026-03-18 |
| KD-35 | **多项目记忆分两种策略**：(1) 新项目：猫按家规建标准 docs 体系（feat-lifecycle/Skills 引导），IndexBuilder KIND_DIRS 直接适配；(2) 遗留老项目：通用递归扫描所有 `.md`，不硬编码目录名。两种共存，先标准后兜底 | team lead指出"新项目猫不知道要建 docs 体系"，分两种情况设计 | 2026-03-19 |
| KD-36 | **遗留项目需要 frontmatter formatter**——老项目 .md 文件可能没有 frontmatter（feature_ids/doc_kind/topics），需要一个工具自动扫描并补充 metadata，提升 kind 推断和检索质量 | team lead提出"接手垃圾项目也需要 formatter 那个 metadata" | 2026-03-19 |
| KD-37 | **Abstractive digest 模型用 Opus 4.6**（金渐层/反代 API，复用 F062 provider-profiles），不用 Haiku | team lead引用实测：Haiku 带坑里，Sonnet 需推断，Opus 完全准确 | 2026-03-19 |
| KD-38 | **Thread-level durable candidate extraction**——digest + candidate extraction 合并为一次 Opus 调用（定时任务触发，不绑 seal）；candidate 只允许 decision/lesson/method，必须带证据，不直写长期真相源 | 三猫共识（LC 调研 + Maine Coon收紧 + team lead打回 seal 绑定）：吸收 LC"lifecycle 节点触发 durable write"，保留 marker→materialize 门禁 | 2026-03-20 |
| KD-39 | **定时任务跑 thread 增量摘要**——每 30min 扫描增量达标的 thread 调 Opus，不和 session seal 绑定 | team lead修正：session strategy 可配置（不一定有 seal），绑定 seal = 绑定特定策略；定时任务更稳健 | 2026-03-20 |
| KD-40 | **ThreadMemory 用 abstractive summary 替代拼接**——有 abstractive 时 bootstrap 直接用，不需要独立凝结层 | 简化：定时任务每次合并增量 + 上次摘要 = 渐进凝结，不需要额外步骤 | 2026-03-20 |
| KD-41 | **摘要单元是 thread（不是 session）**——thread 是所有猫共享的对话空间，对每只猫的 session 分别摘要 = 同一段对话重复摘要 | team lead指出：多猫 session 有重合，保存多份很奇怪；thread 概念全部猫都用，应该基于 thread 而不是 session | 2026-03-20 |
| KD-42 | **LSM-style compaction + 双写（read model + append-only segment ledger）**——`evidence_docs.summary` 是 read model，`summary_segments` 是 append-only provenance。L2 凝结 deferred 但 segment ledger 让升级成本很低 | Maine Coon坚持 segment ledger 防漂移/不可审计/错误放大，架构师采纳——成本仅多一张表一次 INSERT，收益是完整可审计性 | 2026-03-20 |
| KD-43 | **一次 delta batch 产出 1..N 个 topic segments**（Opus 按话题切分，最多 3 段，不确定退化 1 段）——跨时间窗只 link 不 merge，merge 留给 L2 | team lead提出动态语义窗口（一个增量可能混多个话题），Maine Coon约束：连续/覆盖/最多 3 段/不回改旧 segment/必须带 topicKey + boundaryReason | 2026-03-20 |
| KD-44 | **三种检索模式各有独立路径**——lexical=纯 BM25，semantic=纯向量 NN（跳过 BM25），hybrid=BM25+NN 双路召回 → RRF 融合。Phase C 只实现了 rerank（BM25 上重排序），不是真的 semantic/hybrid | team lead实测：semantic 搜 "why are cats named Ragdoll Maine Coon Siamese" 搜不到猫名故事——因为 BM25 没召回，rerank 无法补救。真的 semantic 应该直接 NN 搜索 | 2026-03-21 |

## 实现路线图（F/G/Gap 整体规划）

> **当前状态**：Phase A~E ✅ 完成 + Phase G foundation 🚧 已合入（PR #604）。Phase F + G 运行时验收 + Gap-1 待开。
> **team lead指示**：开源同步时增强功能需要开关，默认 off。

### 整体顺序

```
① 立即  Gap-1: EMBED_MODE=on（改 env，零代码）
② 第一批  F-1 + F-2（通用扫描 + formatter）  ←─┐ 可并行
          G-2 + G-3（schema + 定时任务调度器） ←─┘
③ 第二批  G-1（Opus 调用 + topic segment 切分）← 依赖 G-2/G-3
④ 第三批  G-4 + G-5（bootstrap + drillDown）  ← 依赖 G-1
⑤ 最后   F-3 + F-4（全局知识层 + project-init）← 独立但较大
```

### Gap 处理

| Gap | 处理方式 |
|-----|---------|
| Gap-1（embedding off） | 我们的 runtime env 加 `embed: { embedMode: 'on' }`。开源默认仍 `off`（不传即 off）。零代码改动 |
| Gap-2（shadow 无日志） | 废弃 shadow 模式，直接 off → on。不修 shadow 日志 |
| Gap-3（中英混搜） | 随 Gap-1 解决（embedding 开启后向量空间自然桥接中英） |

### 开源开关策略

代码级：已有的 `EMBED_MODE` 三态开关覆盖 embedding。Phase F/G 新增功能用 feature flag：

```typescript
// 在 createMemoryServices 调用处按 env 传参
{
  embed: { embedMode: process.env.EMBED_MODE ?? 'off' },           // 已有
  abstractive: {                                                     // Phase G 新增
    enabled: process.env.F102_ABSTRACTIVE === 'on',                 // 默认 off
    topicSegments: process.env.F102_TOPIC_SEGMENTS === 'on',        // 默认 off
    durableCandidates: process.env.F102_DURABLE_CANDIDATES === 'on', // 默认 off
  },
  multiProject: {                                                    // Phase F 新增
    legacyScan: process.env.F102_LEGACY_SCAN === 'on',              // 默认 off
    globalKnowledge: process.env.F102_GLOBAL_KNOWLEDGE === 'on',    // 默认 off
  },
}
```

**我们自己 = 全部 `on`。开源仓 = 全部 `off`（不设 env 即 off），README 说明开启条件。**

开启前提：

| Flag | 开启条件 |
|------|---------|
| `EMBED_MODE=on` | 首次下载 Qwen3 ONNX ~614MB，内存 ~1GB |
| `F102_ABSTRACTIVE` | 需要 Anthropic API key（provider-profiles 配置） |
| `F102_TOPIC_SEGMENTS` | 同上（abstractive 的子功能） |
| `F102_DURABLE_CANDIDATES` | 同上 + marker/materialization 流水线 |
| `F102_LEGACY_SCAN` | 无特殊前提（有 .md 就能跑） |
| `F102_GLOBAL_KNOWLEDGE` | 需要 `~/.cat-cafe/` + Skills 体系 |

**Phase A~E 的全部功能（FTS5 + 向量检索 + thread passages + session chain drill-down）在 flag off 时照常工作。增强功能是 additive，不影响基础能力。**

## Review Gate

- Phase A: 跨 family review（Maine Coon优先）— 接口设计需要多方确认
- Phase B: 同 family review（Ragdoll Sonnet 可）— 实现层面
- Phase G foundation: Maine Coon(GPT-5.4) review 4 轮放行 — 8 findings 全部闭环（PR #604）
