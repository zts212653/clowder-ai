---
feature_ids: [F188]
related_features: [F186, F102, F161]
topics: [memory, library, knowledge-graph, health, maintenance]
doc_kind: spec
created: 2026-05-06
---

# F188: Library Stewardship — 图书馆管护与成长

> **Status**: reopened | **Completed (A-I)**: 2026-05-20 | **Reopened**: 2026-05-20 (Phase J) | **Owner**: Ragdoll | **Priority**: P1

## Why

F186 建成了图书馆的骨架（Collection 联邦 + Scanner + Security + Graph + Query Replay + Lens），但 GBrain teardown 复盘发现：图书馆**建完了不等于能用好**。

team experience（2026-05-06）："Memory Health Dashboard 感觉很鸡肋，开发完成到现在好像没啥用到"、"全量重建索引！我们现在好像是启动的时候才会？"、"graph 到底是如何 link 起文档的？只看 frontmatter？还是会看文档里面的 ref？"、"聊天产出当然是你们自己来放呀"。

核心问题：知识进来没有管道、索引坏了没人知道、graph 连接稀疏、recall 质量没有反馈闭环。

## What

一条完整的价值链：**知识怎么进来 → 索引怎么建 → 质量怎么看 → 坏了怎么修 → 修完怎么验证**。

### Phase A: 运行期维护入口 ✅

运行期全量 rebuild API + Hub 按钮 + 最小状态可见面。不做完整 Durable Job Ledger，只做 memory jobs 的最小状态表（task id / status / progress / error / result）。

team lead/猫猫能在不重启服务的情况下触发全量重建索引，并看到进度。

### Phase B: Library Health Dashboard ✅

Memory Health Dashboard 增强：从"有多少东西"升级到"哪里脏了、漏了、坏了"。

指标：stale anchors（引用已删文件的锚点）、search miss / low-hit query（搜索质量缺口）、orphan edges（悬空图边）、replay drift（Query Replay 质量漂移趋势）、Knowledge Feed pending（等确认的知识候选积压量）、needs_review 积压。

### Phase J: Health Debt Governance（2026-05-20 reopen）

PR #1790 把 Health Dashboard 的问题数主动 surfacing 到 MemoryNav 后，team lead第一次在日常路径看到真实债务：

- `201` 条 orphan edges：孤立边引用不存在的文档
- `724` 篇 unverified docs：非 `observed` authority 但 `verified_at IS NULL`
- `12` 条 Knowledge Feed pending：待处理知识动态

这证明 Phase B 的 badge 在跑，但也暴露出新的闭环缺口：**指标可信以后，系统必须告诉猫猫如何治理，而不是把数字扔给team lead。** Phase J 不重做 Health Dashboard，也不改变 F200；它把 Phase B 暴露出来的两类核心 health debt（orphan edges / verification debt）变成可解释、可 dry-run、可修复、可回归的治理流程。

**Maine Coon独立判断（2026-05-20）**：

1. **orphan edges 是 F188 该管的结构债**：它来自 F188 Phase C edge extraction / graph health，当前抽样显示大头是 `F20` vs `F020` 这类 feature anchor canonicalization 缺失。修复必须包含一次性 migration + 写入时 normalize，不能只在 dashboard 上解释数字。
2. **unverified 不是 F200 能自动清零的问题**：F200 consumption / trajectory 证明“这篇被用过、对导航有用”，不等于“这篇内容被验证为真”。F200 信号可以作为 review candidate / usage prior，但**不能直接写 `verified_at` 或提升 authority**。
3. **不能盲降级 legacy authority**：`validated` / `constitutional` 且 `verified_at IS NULL` 是历史数据语义不完整，不等于内容不可信。Phase J 必须先区分 `authority`（来源/治理层级）、`verified_at`（验证事件时间）、`usage_signal`（被猫用过）三件事，再决定迁移策略。
4. **team lead不做 724 次点击**：治理默认由猫猫批处理 / 抽样 / dry-run / 自动修复承担，只有高风险、语义冲突、跨 feature 决策才升级给team lead。

**Scope**：

- orphan edge detail + repair：列出具体 from/to/relation/provenance，分类 feature-ref canonicalization / true ghost / non-doc wikilink / related-field drift，支持 dry-run 和 apply。
- edge write prevention：所有 edge writer（frontmatter `related_features`、WikiLink、Markdown link、body F-ref）统一走 canonical target resolver。
- verification semantics cleanup：明确 authority / verification / usage 三层语义，迁移 legacy NULL `verified_at`，但不把 F200 consumption 当 truth verification。
- cat-owned review workflow：猫猫能批量确认、标记需复查、或上升少量关键问题；team lead只看到需要愿景/事实判断的少数项。

### Phase C: Graph Fidelity ✅

提升 Typed Evidence Graph 的连接密度 + 修复 graph 运行期 bug + 让 graph 变成人能读懂、愿意看的知识工作台。

**Bug fixes（team lead实测 + Maine Coon代码分析）**：
1. edges 表 schema 不一致：root evidence.sqlite 只有 3 列（from_anchor/to_anchor/relation），代码 getRelated() 查 6 列 → 查询报错导致 graph 无边
2. `inferCollectionId` silent skip：anchor 无法推断 collection 时整个节点 + 边被静默丢弃，无日志
3. `inferCollectionIdSync` 设计缺陷：collection ID 是 `project:cat-cafe` 但 anchor 是裸 `"F188"`，sync 路径永远匹配不上
4. unresolved placeholder 在 mixed sensitivity graph 中泄露/不一致：private edge 发现的 unresolved anchor 需要统一 opaque 化，且 node/edge endpoint 必须一致
5. case-insensitive 查询 anchor（如 `f186`）只显示中心节点：GraphResolver 需用 canonical anchor 贯穿 edge lookup / emitted endpoints，同时保留受 store 约束的 raw alias 做多跳展开

**三种新 edge 来源**：
1. WikiLink `[[...]]` → edge（Scanner 已提取 WikiLink 到 FTS 关键词，差最后一步写 `addEdge()`）
2. Markdown 链接 `[text](path)` → edge
3. F 编号引用（文档体里的 `F186` 等）→ edge

**Graph 信息可读性 + 感官质量**：team experience"F186 天知道是什么东西"、"显示的信息很让人费解"、"太丑了"、"字突破了那个椭圆"。Graph 展示不是把 anchor 和边画出来就算完成；用户必须一眼看出节点是什么、为什么相连、当前选中了什么。

**补充设计约束（Phase C readability follow-up）**：
- 节点主显示信息必须是 `anchor + 人可读短标题`，不能只显示裸 anchor；中心节点/选中节点必须显示完整 title。
- 节点形态必须优先服务文字可读性：禁止把长文字塞进固定圆/椭圆导致溢出；推荐圆角矩形 / pill / label card，宽度随内容或截断策略稳定。
- Graph 需要固定 Inspector（非一闪即逝 tooltip）：展示 anchor、title、kind、collection、sensitivity，以及与当前节点相连的关系列表。
- Legend / edge filter / stats 属于控制/说明区，不应被画布挤到底部或裁出 viewport；密集信息放侧栏或清晰的底部工具带。
- 稀疏图应能直接解释关系（边标签或 Inspector 关系列表）；密集图可以隐藏边标签，但必须能通过 hover/click 获得 relation/provenance。

**Graph Query Resolution（Phase C query follow-up）**：
当前 Graph 输入框实际是精确 anchor lookup，但用户会自然把它当成搜索框使用。`harness`、`team lead的工资`、`landy 最喜欢什么猫` 这类输入不是 anchor，却代表用户想从记忆库里找到一个可画图的知识节点。Graph 入口必须先定义从自然查询到 graph anchor 的解析契约，不能再用 "No graph data for this anchor" 把搜索失败伪装成 graph 为空。

输入语义：
- 精确 anchor：`F186` / `f186` / `doc:...` / `thread-...` / `global:...` 等已存在 anchor，直接解析为 graph center。
- 主题关键词：`harness`、`Redis persistence` 等普通搜索词，先执行 evidence search，返回候选 anchor 列表，由用户选择后再画 graph。
- 自然语言问题：`landy 最喜欢什么猫` 这类 query 只能基于已索引 evidence 生成候选；没有证据时明确 no-match，不允许编造节点或答案。

候选选择：
- 候选项至少展示 `anchor`、title、kind、collection/source、命中理由（如 title/path/content snippet）。
- 候选项必须可解释为什么可画图：有 exact match / title match / content match / edge-related match。
- 多候选时不自动选第一个；除非 exact anchor 唯一命中。

No-match UX：
- 空结果应说"没有找到可画图的知识节点"，并给 anchor 示例和搜索建议。
- 不再把自然 query 失败显示成 "No graph data for this anchor"。
- 如果 exact anchor 存在但没有边，显示单节点 graph + 说明"这个节点暂无关联边"，而不是空图。

Privacy Contract：
- Query resolution 与 graph rendering 必须共用 collection visibility / sensitivity 规则。
- private/restricted 候选不得因搜索 fallback 泄露真实 anchor/title/path；只可显示 opaque/redacted 占位或不返回。
- unresolved private edge 的 opaque anchor 一致性要求仍适用：候选列表、node endpoint、edge endpoint 不得互相泄露。

### Phase D: Chat-to-Collection Materialization ✅

聊天中产出的知识由猫猫审核后 auto-materialize 到目标 Collection。

管道两头已有（Knowledge Feed 30 分钟自动摘要 + approve API 支持 targetCollection），中间需要：猫猫侧触发流程 + materialize 后自动触发增量 reindex。

### Phase E: Replay Seed / Pin — Superseded by F200 ✅

**关闭结论（2026-05-19）**：不单独实现 F188 Phase E。原方案依赖team lead或猫猫主动给 recall 结果打 `useful / wrong / missing / stale` 标签；实际 dogfood 后确认这个交互不成立——team lead不会逐条 pin，猫猫干活时也没有动机停下来评价记忆系统。

该反馈闭环由 **F200 Memory Recall Eval** 接管：F200 用真实猫行为采集 `RecallEvent` / candidates / consumed / trajectory / outputVerified 等隐式信号，覆盖“搜索结果是否被读、是否被用、是否产出被验证”的 replay seed 需求。F188 不再新增手动 Pin UI 或 MCP。

### Phase G: Phase F Post-launch Quick Hotfix (2026-05-12 立项 / Maine Coon 一审收窄)

Maine Coon Design Gate 一审 P1×3 退回原 G.1/G.2/G.3 三件套：G.3 schema 改造与 G.1/G.2 hotfix 风险等级 + 验证半径完全不同，**强行同 PR 把 P0 runtime fix 拖进大改**。收窄方案：

**G.1 — `graph_resolve` API↔MCP wrapper response shape mismatch (OQ-4)** — **P0 runtime error**
- 现象：runtime 跑 `graph_resolve("F186")` 抛 "Cannot read of undefined" / "is not iterable"，每次调用都炸
- 根因：`GraphQueryResolver.ts:257` 返回 nested `{ status:'graph', graph: {nodes,edges,...} }`，但 `graph-tools.ts:60 GraphSubgraph` 期望 flat
- 修法：MCP wrapper unwrap `data.graph.{nodes,edges,center,depth}` 后再传 `formatGraph`；`GraphSubgraph` interface 同步对齐 API contract

**G.2 — `list_recent` tool description precise rewrite** — P2 doc
- Maine Coon P2: 不 oversell——`SCOPE_KIND_MAP` 是 `evidence_docs.kind` 过滤，不是真的跨 surface raw thread/message/memory 全量扫描
- 修法：description 改为「threads/memory scope maps to indexed discussion/session/memory/reflection **docs** (not raw thread messages or memory store)」，准确反映边界

**Phase G 硬约束（Maine Coon一审约束）**：
- **Scope = G.1 + G.2，禁止塞 G.3**（schema/UX 改造）。G.1 是 P0 runtime，应该 5-行 wrapper fix 直接 ship，不被大改拖延
- G.3 移到 Phase H（独立 Design Gate） — 需要重新定义 selection algorithm + schema + MCP text + `deriveResultSummary` 同步

### Phase H: Collection-Aware Recent Selection

**Design Gate 通过（2026-05-19，Ragdoll提案 + Maine Coon二审）**

核心问题：`RecentBrowseResolver.ts:143` 全局 `updatedAt` 排序 + `.slice(limit)` 导致任何 collection 的 burst 挤掉其他 collection。

**2026-05-19 dogfood**：`list_recent(scope=docs, limit=20)` 返回 19 条 `docs/library/finance/*`，全部显示 `source: project:cat-cafe`。根因：`factory.ts` 中 `project:cat-cafe.root = docs/` 包含了 `domain:finance.root = docs/library/finance/`，导致 private child collection 的 docs 通过 parent 泄露 + 归属污染。

**Design Gate 收敛决策**：
- **KD-H1**: overlap 修复优先于 selection 算法（privacy/ownership bug > UI 分组）
- **KD-H2**: 算法用 Guaranteed Minimum + Best-of-Rest，v1 只按 collection 分配；intra-collection burst (kind/path-prefix bucket) 为 P3 follow-up，不做
- **KD-H3**: API 保留 `{items}` 向后兼容 F200，新增 `{groups: SelectionGroup[]}`（`type: 'collection'`）
- **KD-H4**: `RecentBrowsePanel` 不消费 list_recent item payload（只展示 tool-usage-metrics 聚合）→ UI 改动 N/A

### Phase I: Collection Lifecycle Management ✅

team lead实操暴露：想手动创建 `domain:finance` collection 绑定 `docs/library/finance/` 下 5+ 篇理财知识文档，**找不到任何入口**。当前 Collection 唯一创建路径是 `POST /api/library/register`（localhost REST，需手工拼 JSON body），无 MCP/CLI/UI 创建方式。Phase D (Chat→Collection materialization) 也依赖"Collection 已存在"前提——lifecycle 不闭环，D 无法独立 ship。

**核心命题**：Collection CRUD 全生命周期缺失。建了图书馆但没有「登记新书架」的柜台。

**Lifecycle 状态机**：`registered → indexing → active → stale → blocked → archived`
- `registered`：配置已录入，未开始扫描
- `indexing`：首次或 rebuild 扫描中
- `active`：正常可用，有索引数据
- `stale`：源文件变更后索引未更新（health check 标记）
- `blocked`：扫描失败/配置错误，需人工干预
- `archived`：unbind/归档，compiled index 保留但标记不活跃

**两种源模式**：
1. **Bind existing root**（team lead场景）：绑定已存在的目录（如 `docs/library/finance/`），Collection 配置指向该路径，scanner 扫描生成索引
2. **Managed markdown vault**：在 `~/.cat-cafe/library/sources/{collection-id}/` 创建托管目录，适合"从零开始积累"的知识域。Phase D materialize 的文件落到这里

**Dry-run 先行**：创建前必须 dry-run——扫描源目录，报告文件数/scanner level/exclude patterns/secret findings。team lead和猫猫据此决定是否继续创建。

**安全边界**（继承Maine Coon brainstorm 约束）：
- sensitivity 变更有 widening（放宽）/ narrowing（收紧）双向流，widening 需确认
- internal-archive/unbind 不等于 hard delete——compiled index 归档保留，manifest 标记 `archived`
- Phase I 不做 hard delete / rename / CLI（v1 scope）

**入口优先级**（Maine Coon收敛）：MCP tools > Hub UI > REST API（REST 已有，MCP + UI 是本 Phase 增量）

### Phase F: Agent-facing Memory Tools

把 Phase C 已实现的能力（graph resolver / candidate selection / edge filter）从 HTTP API 封装成 MCP tool，加 time-based browsing tool，配套同步更新 F102 hook + CLAUDE.md SOP + memory-navigation skill。

**核心命题（2026-05-10 立项）**：能力 ≠ 猫能用。F188 Phase C 完整做出来的 graph resolver、candidate selection、no-match UX、edge filter，全部锁在 `/api/library/graph` HTTP endpoint 给 Web UI 用——猫的 MCP 工具列表里没有 graph 入口，也没有 time-based browse 入口。猫的"开工前先 recall" hook 只提醒 `search_evidence` one trick，所有零先验/精确 anchor/时间扫描场景都被强制走语义检索。

team experience（2026-05-10）：「如果你们做了能力 这个能力猫不知道 = 没有。所以配套的 harness（系统提示词 / skills / mcp / sop）等等的放置要跟上」。

**Phase F 硬约束（必须一个 PR 内全部交付）**：

- 能力本体（MCP tools）+ harness 配套（hook / SOP / skill / tool description）**必须同 PR**，不允许"能力先合，配套后补"
- 必须有 eval 验证（决策阈值固化）——不只是 Phase F 本身有 eval，P1/P2 候选项也必须**预先固化触发阈值**，避免后续凭感觉拉扯

**Eval trigger（P1/P2 候选项的量化决策门）**：

| 候选项 | 触发条件（量化阈值） | 观测指标 |
|--------|--------------------|---------|
| Maine Coon rg/find 二阶段（drill-down） | search 命中后仍 fallback grep 比例 ≥30%（同 thread <5 turn 内调 Bash grep） | `grep_after_search_rate` |
| 4.6 主题聚类 catalog | `list_recent` 调用占比 <5% **且** 出现手工列 `docs/` 目录的 fallback | `list_recent_adoption_rate` / `manual_browse_count` |
| Query expansion 自动展开 | `graph_resolve` 候选列表 ≥50% 猫选非首位候选（说明 ranking 失准） | `candidate_selection_distribution` |
| Edge weight / fan-out 控制 | 单 anchor edges >100 的节点 ≥10 个 **且** Inspector hover 长尾 >50% | `edge_fanout_p95` / `inspector_hover_tail_rate` |

**Non-goals**：
- 不把 grep/find/rg 集成进 MCP（边界保持：知识 vs 字符串定位）
- 不做 LLM-based query expansion（让 agent loop 自己多轮搜索）
- 不做 graph 全量预计算缓存（按需 query 即可）
- 不上 PostToolUse hook 作为 v1 必交付（用 `search_evidence` return payload 内 deterministic nudge 替代；详见 AC-F3 + KD-7。v2 如 FM-5 显示 nudge 失效再上 hook）

## Architecture Ownership

Architecture cell: memory
Map delta: none — extends existing memory cell（复用 GraphResolver + 新增 RecentBrowseResolver / ToolEventLog / SkillLoadEventLog 等独立 read-models / append-only logs）。Skill 和 canonical .md 配套 (CLAUDE/AGENTS/GEMINI/OPENCODE.md + cat-cafe-skills/memory-navigation/) 同步更新 — 这是 cross-cutting documentation sync，不引入新架构 cell。
Why: Phase F 不创建新 store/queue/router/adapter cell — graph_resolve 复用 F188 Phase C 的 GraphResolver；list_recent 是 metadata browse read-model（不扩 F102 IEvidenceStore，Maine Coon 二审 P2 boundary）；ToolEventLog / SkillLoadEventLog 是 ToolUsageCounter 旁支的 append-only sequence 日志（cross-cutting telemetry，4.6 review #1）。

## Acceptance Criteria

### Phase A（运行期维护入口）✅
- [x] AC-A1: `POST /api/evidence/rebuild` 触发全量 rebuild，返回 task id
- [x] AC-A2: `GET /api/evidence/rebuild/:taskId` 返回 status / progress / error / result
- [x] AC-A3: Hub Memory 面板有 "重建索引" 按钮，点击后显示进度
- [x] AC-A4: rebuild 运行期间，search 仍可用（不阻塞读）

### Phase B（Library Health Dashboard）✅
- [x] AC-B1: Health Dashboard 展示 stale anchors 数量 + 列表
- [x] AC-B2: 展示 search miss / low-hit query 统计
- [x] AC-B3: 展示 orphan edges 数量
- [x] AC-B4: 展示 replay drift 趋势（如 Query Replay 已有数据）
- [x] AC-B5: 展示 Knowledge Feed pending + needs_review 积压

### Phase J（Health Debt Governance — reopened 2026-05-20）✅
- [x] AC-J1: Health debt semantics spec 落地：明确 `authority`（来源/治理层级）、`verified_at`（显式验证事件）、`usage_signal`（F200 consumption / trajectory）三者互不替代；F200 consumption 不得自动写 `verified_at` 或提升 authority
- [x] AC-J2: Orphan edge details API/UI：`orphanEdges` 不只返回 count，还能返回分页/抽样 details（from_anchor / to_anchor / relation / provenance / from_exists / to_exists / suggested_classification），Health Dashboard 可 drill down
- [x] AC-J3: Orphan edge repair dry-run：提供 dry-run 报告，分类至少覆盖 `feature_ref_missing_zero_padding`、`feature_ref_true_ghost`、`wikilink_non_doc_target`、`related_target_missing`；报告包含 before/after count 和拟执行 SQL/edge changes 摘要
- [x] AC-J4: Orphan edge repair apply：只对 dry-run 可证明安全的项自动修复（如 `F20 → F020` 且 canonical anchor 存在）；true ghost / non-doc wikilink 进入 review bucket 或按策略删除；修复同时清理 edges / vectors / derived graph read-model，不留下 dangling rows
- [x] AC-J5: Edge write prevention：所有 edge 写入路径统一调用 canonical target resolver；body F-ref 抽取不得把年份 `F2025`、`F32-b` 等误写成 feature anchor；regression tests 覆盖 `F20→F020`、`F020` no-op、`F2025` no edge、missing target 分类
- [x] AC-J6: Verification debt migration：对 `authority != observed AND verified_at IS NULL` 做迁移 dry-run，输出 buckets（trusted legacy / needs cat review / stale candidate / escalate to CVO）；禁止仅因 `verified_at IS NULL` 盲降级 `validated` / `constitutional`
- [x] AC-J7: Cat-owned verification workflow：猫猫可批量确认低风险 legacy docs、标记 review-needed、或上升少量高风险项；team lead不承担逐篇点击，只有语义冲突、事实判断、愿景级取舍才升级
- [x] AC-J8: F200 integration boundary：F200 consumption 可写入 usage fields（如 last_consumed_at / consumption_count / review_candidate_reason）或生成 review candidate，但不能作为 truth verification；F200 → F188 的接口有单向边界测试
- [x] AC-J9: Dogfood acceptance report：在 runtime DB 副本或 dry-run 环境验证当前 `201 orphanEdges` 和 `724 unverified` 的拆解；报告包含抽样证据、修复前后 count、不可自动修复列表、以及是否需要 CVO 介入的具体项数

### Phase C（Graph Fidelity）✅
- [x] AC-C0a: edges 表 schema 迁移（补 from_collection_id / to_collection_id / edge_sensitivity / provenance / created_at 列）
- [x] AC-C0b: `inferCollectionId` 对裸 anchor（无 collection 前缀）不再 silent skip，降级为 fallback collection 或 warning
- [x] AC-C0c: `buildSubgraph` 返回的 graph 中，frontmatter `related_features` 边正常显示（bug 修复验证）
- [x] AC-C1: WikiLink `[[Target]]` 在 rebuild 时生成 edge（type: `wikilink`）
- [x] AC-C2: Markdown 链接 `[text](path)` 在 rebuild 时生成 edge（type: `doc_link`）
- [x] AC-C3: F 编号引用 `F186` 在 rebuild 时生成 edge（type: `feature_ref`）
- [x] AC-C4: orphan edges 统计接入 Health Dashboard
- [x] AC-C5: Graph 可视化美化（节点样式 + 布局 + 交互体验达到"team lead不说丑"标准）

### Phase C Follow-up（Graph 信息可读性 + 感官验收）✅
- [x] AC-C6a: 节点在图上显示 `anchor + 短标题`；中心/选中节点显示完整 title，用户能看懂 `F186` 是什么
- [x] AC-C6b: 节点形态不再使用固定圆/椭圆承载长文本；文字不得突破节点边界，长标题有稳定截断策略
- [x] AC-C6c: 点击节点后固定 Inspector 显示 anchor / title / kind / collection / sensitivity / 关系列表；hover tooltip 只能作为辅助，不是唯一信息入口
- [x] AC-C6d: Legend、edge filter、Nodes/Edges/Depth 等说明信息在侧栏或清晰工具带中展示，不被画布挤出 viewport
- [x] AC-C6e: 稀疏图（≤10 条 visible edges）显示 relation 名称；密集图至少在 Inspector/hover 中解释 relation + provenance
- [x] AC-C6f: `f186`/`F186` 浏览器验收截图必须证明：图居中、信息可读、控件完整可见、无文字溢出

### Phase C Follow-up（Graph Query Resolution）✅
- [x] AC-C7a: Graph 输入框支持精确 anchor 和自然 query 两种输入；exact anchor 唯一命中时直接画图，大小写不敏感（如 `f186` → `F186`）
- [x] AC-C7b: 非 anchor query（如 `harness`）走 evidence search fallback，展示 top candidates，而不是直接显示 "No graph data for this anchor"
- [x] AC-C7c: Candidate 列表必须展示 `anchor + title + kind + collection/source + match reason/snippet`，用户选择候选后才以该 anchor 为中心画 graph
- [x] AC-C7d: 多候选不得静默自动选第一个；只有 exact anchor 唯一命中可自动进入 graph
- [x] AC-C7e: no-match 状态必须区分"没有找到候选节点"和"节点存在但暂无关联边"，并给出 anchor 示例/搜索建议
- [x] AC-C7f: Query resolution 必须遵守 collection visibility / sensitivity；private/restricted 候选不得泄露真实 anchor/title/path，redaction 规则与 GraphResolver 一致
- [x] AC-C7g: 浏览器验收覆盖 `F186`、`f186`、`harness`、无证据自然语言 query 四类输入；截图证明候选列表、空状态、graph 展示和隐私文案可读

### Phase D（Chat-to-Collection Materialization）
- [x] AC-D1: 猫猫在 Knowledge Feed approve 时可以选择目标 Collection
- [x] AC-D2: materialize 后自动触发增量 reindex
- [x] AC-D3: materialize 产出的文件有 frontmatter（至少 doc_kind + created）

### Phase E（Replay Seed / Pin — Superseded by F200）
- [x] AC-E1: Closed/no-op — team lead手动 Pin UI 不做；F200 用隐式 consumption / trajectory 信号替代逐条人工标注
- [x] AC-E2: Closed/no-op — 猫猫 API/MCP 手动 Pin 不做；F200 自动记录 recall → read/use/verify 行为链，猫猫不需要额外停下来打标签
- [x] AC-E3: Closed/no-op — Pin → Query Replay seed 不做；F200 Phase D trajectory 数据是 replay seed 的更高保真输入，人工纠偏入口如需补充应进入 F200 backlog，不回流到 F188

### Phase F（Agent-facing Memory Tools）
- [x] AC-F1: MCP tool `cat_cafe_graph_resolve(query, depth?, relations?, dimension?, collections?)` 实现，复用 GraphResolver；query 支持精确 anchor + 模糊词（候选列表）；depth 默认 1 上限 3；relations 支持 wikilink / doc_link / feature_ref / related_to 子集；**`callerCollections` 不在 MCP 输入 schema 里**——必须由服务端从 agent identity / session ACL 派生（详见 KD-8），client-supplied `collections` 仅作请求范围 filter，**不能扩展可见性**；private/restricted 节点/边 redaction 规则与 GraphResolver Web 入口一致（unresolved private anchor opaque 化、跨 collection 边按 sensitivity 过滤）；unit test 验证："传 `collections=["world:private-x"]` 当 caller 不在该 collection 时，private 节点必须 redact，不能因 `collections` 参数被自授权"
- [x] AC-F2: MCP tool `cat_cafe_list_recent(scope, since, limit, kinds?, dimension?, collections?)` 实现，跨 docs/threads/memory 按 updatedAt 倒序合并，返回 anchor + title + kind + updatedAt + source；**`callerCollections` 不在 MCP 输入 schema 里**（同 AC-F1 / KD-8）；`collections` 参数仅作请求范围 filter，private/restricted items 按服务端派生 ACL redact，client **不能自授权**
- [x] AC-F3: 两个新 tool 的 description 明确写场景边界 + 触发关键词 + **cross-reference 全部记忆工具家族**（`search_evidence` / `graph_resolve` / `list_recent` / `list_session_chain` / `read_session_digest` / `read_session_events` / `read_invocation_detail`），让猫识别它们是同一类工具的不同 depth/scope（4.6 review #3 缓解方案：猫的认知成本主要来自"工具间互相找"而非"工具总数"，cross-reference 直接解工具数量膨胀关切）；description 写明"零先验试 list_recent / 语义找试 search_evidence / 看关系试 graph_resolve / 看历史细节试 read_session_*"等互相 cross-reference；**`search_evidence` 低命中（top-result score < 阈值 或 result count = 0）时，在 return payload 末尾加 deterministic nudge**（"精确 anchor 试 graph_resolve / 零先验试 list_recent"），用 payload 替代 PostToolUse hook（详见 KD-7）
- [x] AC-F4: SessionStart hook 配置同步到**所有 canonical source**（`.claude/settings.local.json` + `~/.claude/settings.json` + `AGENTS.md` + `GEMINI.md` + `OPENCODE.md`），从 search_evidence one trick 改为三入口路由表（精确 anchor / 关系 → graph_resolve；零先验 / 最近 → list_recent；语义 / 模糊 → search_evidence）；hook 内容由 single canonical partial / template 派生（避免多份漂移），sync 脚本（参考现有 `sync:skills` 机制）保证一致性
- [x] AC-F5: **所有 canonical source 文件**（`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `OPENCODE.md`）的检索策略段同步更新，加入 graph_resolve / list_recent 列 + 场景示例 + 何时**不用** search_evidence 的说明；用共用 partial / template 派生，改一处生效全场
- [x] AC-F6: 新 skill `cat-cafe-skills/memory-navigation/` 实现并注册到 manifest，包含三入口决策树 + 噪音控制（relation filter / depth / collection 限定）+ 加载 trigger（"没先验/压缩后/我记得讨论过"等关键词）
- [x] AC-F7: F102 spec + ADR 同步：`search_evidence` 仍是 F102 owns 的**语义检索入口**（**不扩 `IEvidenceStore`**）；`graph_resolve` / `list_recent` 是 **F188 agent-facing navigation tools**（graph_resolve 复用 F188 Phase C `GraphResolver`；list_recent 是新增 metadata browse read-model，不属于 F102 索引层）；F180 hook health check 加入"三入口 hook 已同步到所有 canonical sources"验证项
- [x] AC-F8: eval — NDCG@10 gold set 不退化 + Phase F 专属指标：3 个新猫 cold-start 场景，对比"只 search_evidence" vs "三入口"的 `turns-to-baton`（从进 thread 到接住 baton 的工具调用次数），新方案显著降低；**baseline 策略**（4.6 review #2 (b) 方案，详见 KD-9）：event log 与 MCP tools 同 PR 合入，上线即开始采集 `turns-to-baton`；**30% 减少阈值标 provisional**，PR merge 后首次 eval（~1-2 周）用真实数据校准，不锁死（分母 N ≥ 10 cold-start session）
- [x] AC-F9: Memory Health Dashboard 加入新指标 panel：MCP tool call distribution（graph_resolve / list_recent / search_evidence 调用比例）+ cold-start usage rate + `grep_after_search_rate`（search 后 5 turn 内 Bash grep 比例；分母 N ≥ 20 thread）+ `candidate_selection_distribution`（graph_resolve 候选非首位选择率；分母 N ≥ 20 candidate selections）+ `list_recent_adoption_rate`（**只在 cold-start 分母里算**，不按全量 tool call）+ `edge_fanout_p95` + `inspector_hover_tail_rate` + `manual_browse_count`，为 P1/P2 候选项 trigger 阈值提供持续观测；**所有 metric 必须标注 N 下限**（默认 N ≥ 20），样本不足时显示 "insufficient data" 不触发阈值
- [x] AC-F10: tool usage **事件序列存储**（per-thread tool call sequence persistence）——**这是 cross-cutting telemetry 基础设施**（4.6 review #1 标注：价值远超 Phase F，未来任何 eval 都能复用），但**实现上与 Phase F 其他 AC 同 PR 合入**（KD-9 单 PR 策略，不拆 sub-PR）；当前 `ToolUsageCounter` 仅按 `(date, catId, category, toolName)` 聚合 count，**`TranscriptWriter.ts:188` 还会把 toolNames 去重成 `Set`**（Maine Coon 二次 review finding），**无法**算"search 后 5 turn 内 grep" 类序列指标，也算不出 candidate ranking 失准 / nudge 失效率。本 phase 引入 append-only event log，schema：`invocationId / sessionId / threadId / catId / toolName / timestamp / turnIndex / toolInputSummary / resultSummary / status`，并按工具类型定义 summary 字段：
  - `search_evidence`：`resultCount` / `topScore` / `nudgeEmitted`（low-hit 时是否发 deterministic nudge）/ `nudgeFollowed`（下一轮是否试 graph_resolve/list_recent）
  - `graph_resolve`：`candidateCount` / `rankedCandidateAnchors`（按 rank 顺序列出的 anchor 数组，让 `selectedCandidateIndex` 可由 `selectedAnchor` 在数组中的位置重建——Maine Coon 三审 P3：只记 `candidateCount` 算不出"猫选了第几个"，必须有 candidate set 关联字段）/ `selectedCandidateIndex` / `selectedAnchor`
  - `list_recent`：`resultCount` / `scope` / `since`
  - 通用 `status` ∈ `success` / `low_hit` / `no_match` / `error`
  
  AC-F9 的序列 / candidate / nudge 类 metric 全依赖此 log 计算；存储位置和 retention 参考 F180 telemetry 现有约定。同时本 phase 新增 **`skill_loaded` 事件**（schema：`invocationId / sessionId / skillId / loadTrigger / timestamp`）以支持 AS-4（不依赖现有 Skill `tool_use` 计数，因其去重且无 trigger 上下文）
- [x] AC-F11: F148 retrieval pattern + F167 A2A eval contract 同步扩展：navigation header 注入 spotlight 时把 `graph_resolve` / `list_recent` 也作为 retrieval pattern 识别（不只是 `search_evidence` + `get_thread_context`），否则 F167 A2A 链路质量 eval 仍只认 search 系，cold-start improvement 不会被计入；**范围锁定（Maine Coon 二次 review 约束）**：只改 retrieval pattern 识别 + eval contract，**不改 A2A routing 语义 / 球权规则 / mention 解析**——任何 routing 语义改动单独立项

### Phase G（Phase F Post-launch Quick Hotfix — G.1 + G.2 only，Maine Coon一审收窄）
- [x] AC-G1: 修 `graph_resolve` MCP wrapper API↔response shape mismatch (OQ-4)：`graph-tools.ts` 的 `data.status === 'graph'` 分支需 unwrap `data.graph.{nodes, edges, center, depth}`（而不是 `data.{nodes, edges, ...}`）传给 `formatGraph`。Type interface `GraphSubgraph` 同步对齐 API contract
- [x] AC-G2: 加 regression test：`graph_resolve("F186", depth=1)` 返回 graph status 时 MCP wrapper 正确 unwrap，不抛 error
- [x] AC-G3: rewrite `list_recent` tool description（`recent-tools.ts:23` 的 scope 字段）reflect 实际边界：「threads/memory scope maps to indexed discussion/session/memory/reflection **docs** (not raw thread messages or memory store)」。Maine Coon一审 P2: 不 oversell `SCOPE_KIND_MAP` 边界（只是 evidence_docs.kind filter，非跨 surface 全量索引）
- [x] AC-G4: F188 spec OQ-4 状态从"⬜ 待 F197 close 后开 F188 Phase F hotfix PR" → "✅ Phase G AC-G1/G2 实做完成"

### Phase H（Collection-Aware Recent Selection — Design Gate 2026-05-19 通过）✅
- [x] AC-H1: Collection overlap cleanup — 同一文件只归属最具体的 collection；parent scanner 动态排除子 collection root；rebuild 清理历史残留行；测试证明 private child docs 不通过 parent 的 `list_recent` 泄出
- [x] AC-H2: Guaranteed Minimum selection — eligible collection（通过 visibility filter + 有结果）保底 ≥1 条；eligible > limit 时按最新 item 排序取前 limit 个各 1 条；best-of-rest 去重（同 anchor 不重复）；最终 items 保持全局 updatedAt 排序兼容 F200
- [x] AC-H3: 返回 `groups: SelectionGroup[]`（`type: 'collection'`，v1 只实现 collection）
- [x] AC-H4: MCP text footer 显示 collection 分布
- [x] AC-H5: Regression fixture — cross-collection burst（3 collections，1 个 50 条新 + 其他各 3 条，limit=20 → 三个都有露出）+ overlap privacy（private child docs 不通过 parent 泄出）
- [x] AC-H6: RecentBrowsePanel UI → N/A（证据：它只消费 `/api/library/tool-usage-metrics` 聚合数据，不渲染 list_recent item payload）

### Phase I（Collection Lifecycle Management）✅
- [x] AC-I1: Collection lifecycle 状态机实现：`registered → indexing → active → stale → blocked → archived`，manifest 持久化状态字段，状态流转有 guard（如 `archived` 不能直接 → `active`，需先 → `registered` 再 rebuild）
- [x] AC-I2: dry-run API（`POST /api/library/dry-run`）+ MCP tool `cat_cafe_library_dry_run(kind, root, exclude?)`：扫描源目录，返回 file count / scanner level / exclude patterns / secret findings / estimated index size，**不写入任何持久化状态**
- [x] AC-I3: create 支持两种源模式——bind existing root（指定 `root` 路径）AND managed markdown vault（`root` 留空则自动创建 `~/.cat-cafe/library/sources/{collection-id}/`）；创建后自动触发首次 indexing
- [x] AC-I4: MCP tools 覆盖 lifecycle 核心操作：`cat_cafe_library_list` / `cat_cafe_library_dry_run` / `cat_cafe_library_create` / `cat_cafe_library_rebuild` / `cat_cafe_library_archive`；**visibility 不可自授权**（继承 KD-8：sensitivity/ACL 服务端派生，MCP 不暴露提权参数）
- [x] AC-I5: MemoryHub Collection 管理 UI——list 页展示所有 Collection（状态 badge + 文档数 + 最后索引时间）；detail 页展示配置（kind/root/sensitivity/exclude）+ rebuild 按钮 + archive 按钮；create 入口（dry-run → confirm → create 流程）
- [x] AC-I6: internal-archive/unbind 不等于 hard delete——compiled index 归档到 `~/.cat-cafe/library/archives/{collection-id}/`，manifest 标记 `archived`，search/graph 不再返回该 Collection 结果；**可恢复**（unarchive → rebuild）
- [x] AC-I7: sensitivity 变更双向流——widening（`private → internal → public`）需确认提示；narrowing（`public → private`）立即生效 + 触发 reindex 刷新可见性
- [x] AC-I8: Phase D（Chat→Collection materialization）只消费 lifecycle API 创建/选择 Collection，**不自行绕过 lifecycle 直接写 manifest**——Phase I 是 Phase D 的前置依赖
- [x] AC-I9: 端到端验收场景：team lead通过 MCP/UI 创建 `domain:finance`，bind `docs/library/finance/` 下 5+ 篇理财知识 .md 文件，触发 rebuild，search/graph/catalog 全部能查到 finance 内容，默认 `private` sensitivity

## Eval / Tracking Contract

> Phase F 触发 F192 v1 模板（新增 MCP tool / skill / SOP/hook 全部命中触发条件）。Phase A-E 不触发（pure backend infra + UI，无猫行为路径变化）。

### 1. Primary Users + Activation Signal

- **Users**：
  - Cats：所有猫，特别是 cold-start 的新分身——进 thread 时需要快速建上下文
  - Runtime：MCP tool `cat_cafe_graph_resolve` / `cat_cafe_list_recent`；SessionStart hook 路由表注入；`search_evidence` payload 内 deterministic nudge
  - CVO：受益方（猫更快接住 baton，不用 CVO 反复重传 context），不直接操作
- **Activation signal**（trace 可观察事件）：
  - **AS-1 三入口分布**：在任意 thread 前 5 次 memory-class MCP 调用中，至少 1 次是 `graph_resolve` 或 `list_recent`（即不再 100% 走 search_evidence）
  - **AS-2 cold-start 缩短**：`turns-to-baton`（从进 thread 到首次接球 / 交付动作的 tool call 数）对比 baseline（only-search）≥30% 减少。**Baton 事件定义**（防止 baseline 不可复现）：以 F167 worklist registry 的 mention 入站事件作为"进 thread"锚点；以首次出现以下任一作为"接球 / 交付"：(a) 行首 @ 路由出站；(b) `cat_cafe_hold_ball` 调用；(c) 文件 edit / git commit / PR action；分母 N ≥ 10 cold-start session
  - **AS-3 三入口路由表注入**：SessionStart hook 输出在 trace 里 query 到三入口路由提示文本（非 search_evidence one-trick）
  - **AS-4 memory-navigation skill 触发**：`skill_loaded` 事件（**Phase F 新增**，schema 见 AC-F10）query 到 `memory-navigation` skill 加载（在压缩后/零先验/"我记得讨论过"等关键词命中场景）；不依赖现有 Skill `tool_use` 计数（去重 + 没有 trigger 上下文，Maine Coon 二次 review P2 修正）。**v1 scope (Maine Coon 四审 acknowledged)**：producer 监听 Claude Code `/Skill` tool_use。Codex/Antigravity 等通过 prompt-injection 方式加载 skill 的 runtime 不发 tool_use，v1 该路径 silent；首次 eval 后 N<20 时显示 insufficient data，不误判。完整跨 runtime instrumentation（SystemPromptBuilder skill-inject 切面）列入 v2 follow-up（追踪 issue 见 PR 描述）。

### 2. Friction Metric

- **FM-1 grep_after_search_rate**：`search_evidence` 调用后同 thread 5 turns 内调 Bash grep 比例 ≥30%（说明 search 不够，猫 fallback 字符串工具——这是Maine Coon提的 "rg drill-down" P1 候选触发条件；分母 N ≥ 20 调用才统计）
- **FM-2 candidate_selection_distribution**：`graph_resolve` 返回 multi-candidate 时，猫选非首位的比例 ≥50%（说明 candidate ranking 失准——这是 query expansion P1 候选触发条件；分母 N ≥ 20 candidate selections）
- **FM-3 list_recent_adoption_rate**：cold-start 场景的 memory-class tool 调用中 `list_recent` 占比 <5%（说明零先验场景没有进入这个入口，仍被 search 强吸收；只在 cold-start 分母里算）
- **FM-4 privacy contract 误穿**：`graph_resolve` / `list_recent` return 中含 private collection 节点/边但 caller 不在该 collection 内（trace fixture：每月 ≥1 次随机抽查 + 自动化 unit test）
- **FM-5 tool nudge 失效**：`search_evidence` 返回 deterministic nudge 后，猫下一轮未试 `graph_resolve` / `list_recent` **且** 后续 3 turns 内出现 Bash grep fallback 的比例 ≥40%（4.6 review #4 修正：纯"nudge 后未试"分不出"真失效" vs "猫正确判断不需要"，必须加 grep fallback 作 confound 排除——只有同时未试 + fallback 时才说明 nudge 真失效；触发条件回到 PostToolUse hook 选项）

### 3. Regression Fixture

- `cold-start/only-search-spike` → `thread_mp0i4nfau5hz0mr6` opus-47 5 次 search_evidence 才建上下文（team lead 2026-05-10 trigger 原话）
- `graph-locked-in-http-api` → commit `d0f0e8437` 之前的现状：`GraphResolver` 只通过 `/api/library/graph` HTTP endpoint 暴露，MCP 工具列表无 graph 入口
- `harness-mismatch-canonical-sources` → Maine Coon review P1-2 finding：hook/SOP 只更 `CLAUDE.md` + `.claude/settings*.json`，漏 `AGENTS.md` / `GEMINI.md` / `OPENCODE.md`；修复后 fixture：sync 脚本/CI 检查所有 canonical source 三入口一致
- `privacy-leak-via-mcp-wrapper` → Maine Coon P1-3 finding 验证 fixture：F186 privacy contract 在 HTTP API 已落实，MCP wrapper 不传 `callerCollections` 时绕过——unit test 验证 private collection redaction
- `counter-cannot-compute-sequence` → Maine Coon P1-4 finding：当前 `ToolUsageCounter` 仅聚合 `(date, catId, category, toolName)` count，**`TranscriptWriter.ts:188` 还把 toolNames 去重成 Set**——fixture 是 AC-F10 的 event log + 工具 summary 字段上线后 sequence / candidate / nudge metric 能算出正确值
- `mcp-self-grant-private-visibility-blocked` → Maine Coon 二次 review P1-1 finding：MCP wrapper **不接受 client-supplied `callerCollections`**；fixture 是 unit test 验证 — 传 `collections=["world:private-x"]` 但 caller 不在该 collection 时，private 节点必须 redact，不能因 `collections` 参数被自授权（`GraphResolver.ts:51` / `GraphQueryResolver.ts:68` 是 server-side option 来源；KD-8）

### 4. Sunset Signal

- **Environment drift**：未来模型升级后能自动从 thread context 推断"零先验→list_recent / 精确 anchor→graph_resolve"路由 → AC-F4 SessionStart hook 三入口路由表可降级为 search_evidence one-trick + skill 加载兜底
- **Subsumption (in-feature)**：连续 3 个月 AS-1 三入口分布稳定、FM-1~3 均低于阈值 → memory-navigation skill 可从 mandatory 降为 optional reference（猫已经形成肌肉记忆，不需要每次提示）
- **Subsumption (cross-feature)**：F169 Reflex Injection（F148 Phase F 实现）演进到能在 navigation header 自动注入 `graph_resolve` / `list_recent` 候选 → AC-F3 tool description nudge 可降级（spotlight 已经把数据端上桌，不依赖 nudge）
- **Adoption decay**：近 3 个月 `graph_resolve` 调用占比 <2% 且 `turns-to-baton` 未改善 → graph 入口对猫无价值，撤回 MCP wrapper 回归"只 Web UI 用"（一次性 sunset 而不是逐步降级——避免半死不活）

## Deferred / Non-goals

以下明确暂不做，附触发条件：

| 项 | 理由 | 触发条件（何时重新考虑） |
|----|------|------------------------|
| Scanner L2/L3 智能建议 | 对我们自家 docs 不值（docs 都是猫猫生成的，已有结构） | 外部 Collection ≥3 或单 Collection 大量缺 metadata |
| 空状态跨域扩搜引导 | 做不好都是噪音（team experience） | Health Dashboard 证明存在 repeated search miss 后再考虑，且只能 title-only / ≤3 条 |
| 完整 Durable Job Ledger | Phase A 的最小状态表足够 | memory jobs 类型 ≥3（reindex / graph extraction / health report / replay）且最小状态表不够支撑 retry / queue / parent-child 时 |
| GBrain compiled wiki / dream cycle 自动写回 | 永久 non-goal | 我们只做 derived read-model，不让它写回真相源。除非team lead明确推翻治理约束 |
| F200 consumption 自动等同 truth verification | F200 明确只评估 navigation utility，不评估文档真伪/authority | 如需让 usage signal 参与 verification，必须先在 F188/F200 之间定义人工/猫审确认边界 |
| team lead逐篇验证 unverified docs | 724 次点击不是可用 workflow，且违背 Phase E dogfood 结论 | 仅当猫猫批处理后剩下少量高风险/事实争议项，才上升给team lead |
| 无 dry-run 直接批量改 runtime evidence DB | edge/authority migration 都可能影响 recall/graph 结果，必须可解释可回滚 | 只允许在 dry-run report + 备份/副本验证后 apply |

## Dependencies

- **Evolved from**: F186（图书馆记忆架构 — 骨架已建，本 Feature 补运维与成长）
- **Related**: F102（记忆系统基础 — IndexBuilder / evidence.sqlite）
- **Related**: F161（ACP Carrier Generalization — Operation Context 的载体侧，互补）

## Risk

| 风险 | 缓解 |
|------|------|
| Phase A rebuild 阻塞 API 响应 | 后台 worker + 读不阻塞写（AC-A4） |
| Phase C edge 爆炸（大量低价值 edge） | 按 edge type 区分权重，Graph 可视化可按类型过滤 |
| Phase D materialize 写错 Collection | fail-closed：需要 owner 二次确认（继承 F186 AC-A10） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | ~~不做自动置信度标记，只做手动 Pin~~ → 被 KD-10 取代 | 早期判断：team lead否决“猫猫自动置信度标记”；后续 dogfood 证明手动 Pin 本身也不现实 | 2026-05-06 |
| KD-2 | 不拆成多个小 feature，合成一个 Stewardship | team lead + GPT-5.5 收敛：价值链是一条线，拆碎了每个都是半截能力 | 2026-05-06 |
| KD-3 | Phase A 做最小状态表，不做完整 Job Ledger | GPT-5.5 建议中间态：够看够用，等 job 类型多了再抽象 | 2026-05-06 |
| KD-4 | Graph UI 质量以信息可读性和感官验收为准，不以"画出了节点和边"为准 | team lead反馈：裸 anchor、文字溢出、控件被裁会让 graph 虽然功能正常但不可用 | 2026-05-08 |
| KD-5 | Graph 入口是 query resolution，不是裸 anchor lookup | 用户会输入 `harness`/自然语言问题；必须先解析候选 anchor，再画图，不能用 search fallback 当 hotfix 糊过去 | 2026-05-09 |
| KD-6 | Phase F 立项硬约束：能力 + harness 配套（hook / SOP / skill / tool description）**必须同 PR**，不允许"能力先合配套后补"；P1/P2 候选项必须**预先固化量化触发阈值**（不靠感觉拉扯） | team experience（2026-05-10）：「能力猫不知道 = 没有」；eval 缺失会让后续 P1/P2 决策"跑了半天没观测"，复现 LL-051 类空转 | 2026-05-10 |
| KD-7 | Phase F **不上 PostToolUse hook 作为 v1 必交付**，用 `search_evidence` return payload 末尾 deterministic nudge 替代；FM-5（nudge 失效率 ≥40%）是回到 hook 选项的触发条件 | Maine Coon Design Gate 建议：PostToolUse hook 是 cross-cutting harness 改动，单 Phase F 不该带；payload 内 nudge 是同入口同 trace 的最小可达方案，FM-5 验证有效性；v2 nudge 失效再上 hook | 2026-05-10 |
| KD-8 | **MCP visibility 边界服务端派生**：`callerCollections` / `allowedCollections` 等决定 private/restricted 可见性的 ACL 字段**必须由服务端从 agent identity / session 派生**，**禁止**作为 MCP 输入参数；client-supplied `collections` 仅作请求范围 filter，不能扩展可见性；任何 MCP wrapper 暴露 ACL 类参数 = privilege escalation = 直接 reject PR | Maine Coon 二次 review P1-1：把 `callerCollections` 写进 MCP schema = 让模型自授权 private collection visibility；GraphResolver/GraphQueryResolver 都把它当"调用方可见集合"，server-side option 不能下放到 client | 2026-05-10 |
| KD-9 | Phase F 实现 **1 个 PR 一次合入**（不拆碎）：AC-F1~F11 + event log + harness 同步 + skill + Dashboard 全做完；baseline 采集用 4.6 review #2 (b) 单方案——event log 上线即开始采，AC-F8 的 30% 改善阈值标 **provisional**，PR merge 后首次 eval 用真实数据校准（不要 pre-launch baseline 窗口） | team lead push back（2026-05-10）：「拆碎 PR 导致原本一天的事五天才搞完」；重读 4.6 review #2 原文 (a)/(b) 是两选一不是组合，(b) 单选已够解 baseline 循环；KD-6「能力+harness 同 PR」也天然兼容 | 2026-05-10 |
| KD-10 | Phase E 手动 Pin 关闭，Replay/feedback 闭环归 F200 | team lead指出“team lead逐条 pin 不现实，猫猫干活时也没动机 pin”；Maine Coon + 47 独立读 F200 后确认：F200 的 RecallEvent / consumption / trajectory / outputVerified pipeline 已覆盖 F188 E 的真实目标。F188 只保留 library navigation / collection 管护职责 | 2026-05-19 |
| KD-11 | F188 reopen Phase J：Health Dashboard 指标必须走向治理闭环 | PR #1790 让 health issue count 主动可见后，team lead dogfood 看到 `201 orphanEdges` / `724 unverified` 并追问可信度与治理。结论：Phase B badge 完成 awareness，但 F188 还需要把可信诊断变成 dry-run / repair / cat-owned review workflow | 2026-05-20 |
| KD-12 | F200 consumption 不是 truth verification | F200 明确评价 navigation utility，不评价文档真伪或 authority。消费记录可作为 usage prior / review candidate，不能直接写 `verified_at`、不能清空 unverified、不能提升 authority | 2026-05-20 |
| KD-13 | Phase J 三维分离：authority / verified_at / usage_signal | authority（治理层级）/ verified_at（显式验证事件）/ usage_signal（F200 消费）三维独立。F200 consumption 不写 verified_at，不提升 authority。review_status 是 triage 状态（trusted_legacy / needs_review / reviewed / escalated），独立于 authority。Design Gate R4 通过 | 2026-05-21 |

## Review Gate

- Phase A-D: 跨猫 review（Maine Coon优先），涉及 UX 的 Phase（A3/B）需浏览器验证；Phase E 已 superseded by F200，不再开 F188 实现 PR
- Graph readability follow-up: 必须用浏览器截图验证 `f186`/`F186` 两种输入，确认节点标题、Inspector、legend/filter/stats 全部可读且无裁切
- Graph Query Resolution follow-up: spec 先经 46 review；实现前必须确认 query → candidate → graph 的 UX，不准只做 silent search fallback
- Phase F: spec 先经Maine Coon Design Gate（重点 review eval 设计 + harness 配套清单是否齐全 + P1/P2 trigger 阈值是否可观测）；实现 PR 必须跨猫 review；close 必须通过 cold-start eval（NDCG@10 不退化 + turns-to-baton 改善 ≥30%）
- Phase I: merged in PR #1774；Maine Coon local review + cloud review closed P1/P2，涉及 UX（AC-I5 MemoryHub UI）已纳入 merge evidence
- Phase J: implementation 前必须先过 Design Gate（重点：verification semantics、F200 边界、orphan edge migration safety）；任何 runtime DB migration 必须 dry-run + 备份/副本验证；实现 PR 需Maine Coon review + cloud review，dogfood acceptance report 是 close gate 输入
