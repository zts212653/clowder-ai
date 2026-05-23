---
feature_ids: [F209]
related_features: [F102, F188, F200, F192, F208]
topics: [memory, evidence-recall, passage-vector, entity-anchor, drill-down, perspective, eval]
doc_kind: spec
created: 2026-05-21
---

# F209: Evidence Recall Optimization — 消息级语义、实体门牌号与活查询藤

> **Status**: in-progress (Phase A ✅ merged PR #1842; Phase B ✅ merged PR #1846 + AC-B3 contract fix PR #1851; Phase C ✅ merged PR #1853 + file-slice dogfood hotfix PR #1854; AC-B6 waits F208 consumer integration) | **Owner**: Maine Coon/Maine Coon | **Priority**: P1

## Why

team lead提出一个现实用户问题：普通人不会认真分 thread，一个 thread 里可能同时聊技术、rua 猫、红巨星、战争新闻、金融分析和家人健康。等 session 被压缩后，用户会说“你失去记忆了”。如果系统只靠 ChatGPT / Claude.ai 那种被动摘要注入，就会出现两个问题：

1. 摘要可能过期、漏掉 tradeoff、混淆边界。
2. 模型会一本正经地拿摘要当真相源回答。

Cat Café 现有 F102 / F188 已经走了另一条路：`search_evidence` 找候选证据，猫读原文判断。F209 立项时的代码剖面确认，当时还有一个关键缺口：`depth=raw` 仍是 lexical-only，因为 passage-level vectors 还没有做。也就是说，消息原文虽然进了 `evidence_passages`，但“没有出现精确字面词”的旧聊天仍不稳。Phase A 已在 PR #1842 关闭这条 raw passage semantic/hybrid 缺口；后续 Phase 继续补 entity、typed reader、Perspective 与 eval 闭环。

F209 的目标是把 evidence-first recall 推到终态一层：**消息级语义召回 + 实体门牌号 + typed 原文窗口 + 活查询 Perspective + retrieval eval**。它不做摘要记忆，不做算法路由，不替猫判断，只让猫更快抓到可审计原文。

## Architecture Cell

```markdown
Architecture cell: memory
Map delta: update required during Design Gate
Why: 本 feature 扩展 Memory / Evidence 的 retrieval grain（passage vector）、anchor 类型（entity）、drill-down reader 与 Perspective 视图边界。
```

## What

F209 完整终态包含五层：

1. **Passage-level semantic recall**：message / transcript passage 也能 semantic/hybrid 检索。
2. **Entity anchor / alias registry**：人、猫、功能、外部概念有确定门牌号。
3. **Typed message-window drill-down**：搜到 message / invocation / file 后能打开合适窗口，不打开巨型 blob。
4. **Perspective live query plan**：保存“常顺的藤”，每次现场重跑，不存结果。
5. **F200 eval integration**：F209 每个 Phase 贡献 retrieval fixture，F200 统一拥有 golden query set / recall metric / consumption rerank。

核心边界：

> 系统给线索 + 坐标 + 可打开的原文窗口；猫读证据、判断、沉淀 artifact。

## Non-goals

- 不做小模型 topic splitter。
- 不做摘要注入式 memory；系统级摘要猫 / 用户选择摘要范围属于 future related feature，不进 F209 scope。
- 不做自动 topic map 真相源。
- 不做算法替猫判断 intent。
- 不把 Perspective 的结果缓存成“事实”。
- 不做用户操作的 Smart Folder UI（Perspective v1 是猫操作、CVO 可见，不是用户搜索入口）。
- 不用 entity / facet 推断替代原文证据。

## Phase A: Passage-level Semantic Recall ✅

让 `depth=raw` 支持 semantic/hybrid，而不是强制降级 lexical。

Phase A 不是“先只建一个向量表”的碎片切片。可关闭的最小完整切片必须同时保住三条检索腿：

- **BM25 / lexical**：字面词命中仍然最快、最可解释。
- **Embedding / semantic**：解决“没出现原词但意思相关”的旧聊天召回。
- **RRF hybrid**：把 BM25 与 embedding 候选融合，既保精确命中，也扩语义召回。

### Acceptance Criteria

- [x] AC-A1: `evidence_passages` 的 message / transcript passage 有 embedding path（`passage_vectors` 或等价结构）。
- [x] AC-A2: `search_evidence(depth=raw, mode=semantic)` 能走 passage-level NN，而不是降级 lexical。
- [x] AC-A3: `search_evidence(depth=raw, mode=hybrid)` 用 passage BM25 + passage vector NN 做 RRF。
- [x] AC-A4: raw results 仍返回 `passageId`、speaker、timestamp、contextWindow、thread/message anchor；不返回“摘要结论”。
- [x] AC-A5: embedding unavailable 时 fail-open 到 lexical，并明确 `degraded/effectiveMode`。
- [x] AC-A6: Phase A 不能只以“向量已写入”关闭；必须验证 lexical / semantic / hybrid 三种 raw 检索模式与 RRF 融合行为。

## Phase B: Entity Anchor / Alias Registry

把实体做成一等检索轴，解决 `landy` / `team lead` / `CVO` 这种别名误伤。

与 F208 / F032 的边界：**F209 owns entity registry / retrieval anchor 层**，回答“`landy` / `team lead` / `CVO` 是否同一个可检索实体”，提供 `entity_id`、alias、type 与 provenance 真相源；它不是 roster truth，不决定谁是猫、当前 model、role 或 reviewer eligibility。**F208 owns 实体能力画像层**，回答“Maine Coon强什么、盲点在哪、适合接什么任务”。F208 的 `cat-dossier` 消费 F209 的 `entity_id` 作为猫/人标识键，不另造一套猫 ID。

Phase B 隐私模型：entity registry 跟随所属 evidence store / collection 的边界；本 slice 不在实体记录上携带半接线的 `privacy_scope` / `sensitivity` 字段。AC-B5 由 collection routing 与 `redactForTranscript` 白名单 redaction 承担；mixed-scope entity seeding 后置到有完整 router enforcement 的设计。

### Acceptance Criteria

- [x] AC-B1: 有 durable entity registry，支持 `entity_id`、aliases、type、provenance、updated_at。
- [x] AC-B2: `search_evidence` query 可进行确定性 alias expansion；alias 字典不是 classifier。
- [x] AC-B3: 索引层可记录 entity mentions，结果能解释“为何命中 person:landy / cat:gemini”。
- [x] AC-B4: entity 与 project/global/library/collection 联邦检索兼容。
- [x] AC-B5: 隐私实体默认受 scope 控制，不跨域泄漏。
- [ ] AC-B6: F208 `cat-dossier` 等画像消费者使用 F209 `entity_id`，不创建平行猫 ID / 人 ID namespace。

## Phase C: Typed Drill-down Readers

统一 anchor contract，但保留 typed readers，不造万能黑盒。

Phase C 的默认方向是**扩展现有读取工具**，不是重复造一套 reader：

- thread/message：扩展现有 thread context 读取能力，补 `messageId + before/after` window。
- invocation：复用 / 补强现有 `read_invocation_detail`。
- file：优先使用猫已有的 `rg` / `sed` / file slice 能力；只有 MCP 场景确实需要时再补 typed file reader。

### Acceptance Criteria

- [x] AC-C1: 支持 message window reader：按 `threadId + messageId + before/after` 打开上下文。
- [x] AC-C2: 支持 invocation detail reader：按 invocationId 打开工具调用 / 输出 / 状态细节。
- [x] AC-C3: 支持 file slice reader：按 path + line range 打开文档或代码切片。
- [x] AC-C4: `search_evidence` 结果为不同 sourceType 给明确 drill-down hint。
- [x] AC-C5: 大文件 / 大 thread 默认窗口化，不一次塞全文。

## Phase D: Perspective Live Query Plans

从 Smart Folder 学“存问题，不存结果”。

Perspective 是本 feature 最容易漂成“漂亮概念”的部分，因此进入实现前必须先做 product spike，回答三个 user story：

1. 猫在什么场景下创建 Perspective？
2. 猫如何打开 / 复用 Perspective？
3. Perspective 返回什么结构，如何保证它只是“活查询藤”，不是固化结果集？
4. CVO 在哪里看到 Perspective 运行过程，如何和现有 `search_evidence` 明厨亮灶联动？

候选 runtime 形态：

- 存储：git-backed query plan（YAML / markdown frontmatter 均可，Design Gate 定）。
- 执行：解释成一组 `search_evidence` / `graph_resolve` / typed reader 调用建议。
- 返回：带 anchor 的候选线索 + drill-down hints，不返回结论。
- 可见性：Perspective run 复用现有 Memory / Recall 实时面板或同等可见层，展示 query plan id、执行步骤、命中数量、打开过的 anchors 与 degraded 状态。
- v1 入口：猫手动保存 / 复用；CVO 可看运行过程但不作为用户搜索操作员；F200 自动建议与用户 Smart Folder UI 后置。

### Acceptance Criteria

- [ ] AC-D0: Design Gate 前完成 Perspective product spike，给出 2-3 个 user story + runtime contract。
- [ ] AC-D1: Perspective 存 query plan / route recipe，不存结果集。
- [ ] AC-D2: 打开 Perspective 时现场重跑，结果全带 anchor + drill-down。
- [ ] AC-D3: Perspective 可由猫保存 / 命名 / 复用；默认用户不是操作员。
- [ ] AC-D4: skill / 任务可激活建议 Perspective，但只给“藤”，不下结论。
- [ ] AC-D5: Perspective 消费信号可进入 F200 navigation utility，不改变 truth / authority。
- [ ] AC-D6: Perspective run 对 CVO 可见，至少展示 query plan id、step、hit count、opened anchors、degraded/effectiveMode。
- [ ] AC-D7: v1 不提供用户操作的 Smart Folder UI；如果未来做，必须另走 product/design gate。

## Deferred / Future Related: Summary Memory

摘要记忆是必须解决的问题，但不属于 F209。F209 只优化“找证据、开原文、让猫判断”。如果未来做摘要，应另立 feature，至少讨论：

- 产品形态：系统级 thread / 系统级摘要猫，而不是每个普通 thread 里临时塞摘要。
- 用户控制：CVO 可配置由哪只猫做摘要、哪些 thread / 阶段需要摘要、哪些内容禁止摘要。
- 审核与过期：摘要必须带 anchors、生成者、时间、过期 / superseded 状态，不能变成无来源真相。
- 消费边界：摘要可作为入口 / digest，不能替代 `search_evidence` 原文证据。

## Phase E: F200 Eval Integration

避免“更聪明但更偏”的检索回归，但**不在 F209 自建第二套 eval 系统**。边界如下：

- **F209 owns**：每个 Phase 的 regression fixture、触发场景、预期 anchor / drill-down 行为。
- **F200 owns**：golden query set、recall@k / open-rate / false-confidence 指标、consumption rerank、exploration/freshness 对冲。
- **接口**：F209 Phase 完成时向 F200 贡献 fixtures；F200 统一跑 retrieval eval 并产出 finding。

### Acceptance Criteria

- [ ] AC-E1: F209 每个 Phase 至少向 F200 贡献 2 条 retrieval regression fixture。
- [ ] AC-E2: fixture 至少包含 query、scope/mode/depth、expected anchor pattern、expected drill-down behavior。
- [ ] AC-E3: F200 统一持有 recall@k / anchor open rate / false confidence / raw drill-down success 指标。
- [ ] AC-E4: F200 consumption signal 只能影响 navigation utility，不得改变 authority/truth。
- [ ] AC-E5: F200 负责 exploration / freshness 对冲，防 rich-get-richer；F209 不重复实现。

## Dependencies

- **Related / base**: F102 Memory Adapter Refactor — evidence store、passages、raw lexical、KnowledgeResolver。
- **Related**: F188 Library Stewardship — navigation / collection 维度。
- **Related**: F200 Memory Recall Eval — consumption signal 与召回评估。
- **Related**: F192 Socio-Technical Harness Eval — eval contract / finding→action 框架。
- **Related**: F208 Capability Profile Routing — 能力画像档案层；消费 F209 `entity_id`，不 owns id/alias 真相源。

## Risk

| 风险 | 缓解 |
|------|------|
| embedding 被误解成“模型替猫判断” | AC-A4 强制返回 anchor + context；embedding 只做 sensor，不做 conclusion |
| entity/facet 推断污染真相源 | alias 只做确定字典；candidate facet 必须标 candidate + provenance |
| F208/F209 在 `docs/team/` 重复建猫/人身份表 | F209 owns entity registry / retrieval anchor；F208 owns capability profile；F032 / identity-session owns roster truth；AC-B6 强制复用 `entity_id` |
| raw hybrid 召回噪音变大 | Eval golden set + false confidence rate + contextWindow |
| Perspective 变成固化 topic map | 只存 query plan，每次现场重跑；不存结果 |
| Perspective 变成黑盒猫内工具，CVO 无法迭代 | AC-D6 要求运行过程在 Memory / Recall 可见层明厨亮灶 |
| F200 consumption rich-get-richer | 交由 F200 统一做 exploration/freshness 对冲；F209 只贡献 fixture |
| 大 thread / 大文件把猫上下文撑爆 | typed reader 默认窗口化，禁止大 blob 默认展开 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 立新号 F209，不只挂 F102 Phase K/K3 | 范围已超过 passage vector：包含 entity anchor、typed drill-down、Perspective、eval 闭环 | 2026-05-21 |
| KD-2 | 优化召回，不替猫判断 | 贯彻 agentic search：系统给候选 + 坐标，猫读原文 | 2026-05-21 |
| KD-3 | 统一 anchor contract，不统一读取实现 | file/message/invocation/thread 的最佳读取方式不同；统一成万能 reader 会制造巨型 blob | 2026-05-21 |
| KD-4 | Embedding 是 sensor，不是判断者 | 只要结果带 anchor + 原文窗口，语义召回不会违反 KD-8 | 2026-05-21 |
| KD-5 | Perspective 存 query plan，不存 result set | 结果集会 stale；活查询每次现场重跑才保鲜 | 2026-05-21 |
| KD-6 | F209 不自建 retrieval eval 系统，向 F200 贡献 fixture | 避免 F209/F200 双 owner；F200 是 Memory Recall Eval 的统一归属 | 2026-05-22 |
| KD-7 | F209 owns entity registry / retrieval anchor 层；F208 owns 能力画像层；F032 owns roster truth | 防止两个 feature 在 `docs/team/` 各建一套猫/人身份 namespace；画像层必须复用 `entity_id`，但不得把 `entity_id` 当 roster truth | 2026-05-22 |
| KD-8 | 摘要记忆不进 F209，另作 future related feature | 摘要涉及系统级摘要猫、用户可选范围、审核/过期与产品形态；F209 只做 evidence-first recall | 2026-05-22 |
| KD-9 | Phase A 是 lexical + semantic + hybrid 的完整 raw retrieval 切片 | CVO 明确不要拆碎；只建 passage vector 不能解决实际检索体验 | 2026-05-22 |
| KD-10 | Perspective v1 猫操作、CVO 可见；不做用户 Smart Folder UI | 保持“猫用活查询藤”边界，同时接入 search_evidence 明厨亮灶让 CVO 可迭代 | 2026-05-22 |

## Eval / Tracking Contract

| 项 | 内容 |
|----|------|
| **Primary Users** | 需要从旧 thread/docs/sessions 找证据的猫；Activation Signal：`search_evidence` 在复杂 thread recall 中被调用 |
| **Friction Metric** | 搜到摘要但打不开原文窗口的比例；raw 搜不到但人工能在 transcript 找到的比例；>3 轮 query reformulation |
| **Regression Fixture** | Phase A fixture: `docs/eval/f209-phase-a-raw-retrieval-fixtures.md`（raw semantic 非字面消息召回；raw hybrid 保留 lexical + semantic passage hits）。Phase B fixture: `docs/eval/f209-phase-b-entity-anchor-fixtures.md`（`landy/team lead/CVO` alias 归一、raw entity passage anchor、private collection redaction）。Phase C fixture: `docs/eval/f209-phase-c-drilldown-fixtures.md`（message window / invocation detail chain / file slice bounded readers）。后续 Phase 继续贡献：Perspective 现场重跑、Perspective run 可见层 step / hits / opened anchors。F209 贡献 fixture，F200 统一纳入 golden set |
| **Sunset Signal** | 6 个月内 golden query recall@k 无提升，或猫仍主要绕过 F209 直接人工 grep transcript → 回滚 Perspective / entity layer，仅保留 passage vector |

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “一个 thread 什么都聊，压缩后你能找回之前记忆吗？” | AC-A1~A5, AC-C1 | raw semantic + message window fixture | [ ] |
| R2 | “不要小模型替猫思考，search_evidence 为什么不能用在群聊里？” | KD-2, AC-A4 | 搜索只返回候选 + anchor；猫读原文 | [ ] |
| R3 | “每条消息都有 invocation，这样不就能搜了？” | AC-C1, AC-C2 | message / invocation typed readers | [ ] |
| R4 | “Everything 为什么那么快，SmartFolder 是否能找奶奶相关内容？” | AC-B1~B5, AC-D0~D5 | entity alias + Perspective walk-through | [ ] |
| R5 | “现在检索有 bm25/embedding/docs/thread/msg，先列现状再优化” | discussion 04 + KD-1 | discussion doc review | [x] |
| R6 | “别补锅，要用我们现有 search_evidence / graph_resolve / list_recent 思路” | KD-3, Non-goals | spec 不引入摘要 memory / 小模型 splitter | [x] |
| R7 | “Perspective 不是给team lead搜，但能给team lead看；和 search_evidence 明厨亮灶联动” | AC-D6, AC-D7, KD-10 | Memory / Recall 面板显示 Perspective run trace | [ ] |

### 覆盖检查

- [x] 每个需求点都能映射到 AC / KD
- [x] 每个 AC 有验证方式
- [x] Eval Contract 存在（memory / MCP / harness 行为变更）
- [x] Design Gate 时补 Architecture map delta 细节（2026-05-22：`memory` / `identity-session` ownership cell 已更新）

## Review Gate

- Design Gate：猫猫讨论 → CVO 拍板（架构级；会改变 memory ownership cell 的边界说明）
- Phase A：跨族 review（passage vector + raw hybrid 语义边界）
- Phase B：跨族 review（entity alias / privacy / provenance）
- Phase C：跨族 review（typed reader contract）
- Phase D：跨族 review + CVO product review（Perspective 语义）
- Phase E：F200/F192 owner review（eval contract + telemetry）
