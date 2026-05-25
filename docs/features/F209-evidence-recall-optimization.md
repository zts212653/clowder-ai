---
feature_ids: [F209]
related_features: [F102, F188, F200, F192, F208, F211]
topics: [memory, evidence-recall, passage-vector, entity-anchor, drill-down, perspective, eval]
doc_kind: spec
created: 2026-05-21
---

# F209: Evidence Recall Optimization — 消息级语义、实体门牌号与活查询藤

> **Status**: in-progress (Phase A ✅ merged PR #1842; Phase B ✅ merged PR #1846 + AC-B3 contract fix PR #1851; Phase C ✅ merged PR #1853 + file-slice dogfood hotfix PR #1854; AC-B6 transferred to F208 AC-A5 — F209 不再阻塞 AC-B6; Phase B.1 minimal seed ✅ merged PR #1867; Phase D.0 readiness sprint ✅ completed, initially BLOCK then **UNBLOCK** after PR #1877 raw embedding reprobe + PR #1882 MCP default dimension fix + runtime restart; next F209 owner focus = Phase D product spike / Design Gate. Cross-line follow-ups are delegated below: F193 MCP topology cleanup, F200 recall@k wrapper, Phase C reader hardening.) | **Owner**: Maine Coon/Maine Coon | **Priority**: P1

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

## Phase Close Definition

每个 Phase close 必须**同时满足**机制层和体感层两条标准：

1. **机制 ship**：该 Phase 的 ACs 在代码 / 测试 / 跨族 review 层全部 ✅。
2. **真实可感知闭环**：至少 1 个真实端到端 dogfood demo，证明该 Phase 的能力对真实用户 / 猫**可感知**。
   - Phase A: 真实 raw `semantic`/`hybrid` query 找到一条**无字面命中**的旧消息。
   - Phase B: 至少 seed 1 个真实实体（如 `person:landy`），搜别名能命中只提及别名的原消息。
   - Phase C: 真实 `search_evidence → drillDown → typed reader` 端到端打开原文窗口闭环。
   - Phase D: BLOCKED per Phase D.0 readiness report（见 `docs/decisions/2026-05-23-f209-d0-readiness.md`）。

> **来源**：2026-05-23 F209 post-Phase-C dogfood 反思（47 / Maine Coon alignment + team lead指示）。Phase B alias registry 在生产里**机制 ship 但字典为空**、Phase C drillDown **post-merge 才被 author 真用一次抓到 file-slice bug** —— 都是"AC pass ≠ 用户感受到"的同型走偏。该定义钉死后，未来 Phase close 必须证据双足。

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
- [x] AC-B6: **transferred to F208 AC-A5** (2026-05-23 post-Phase-C reflection). F209 不再阻塞此 AC；F208 spec 持有对偶 AC `cat-dossier consumes F209 entity_id; no parallel namespace`。这是 ownership cleanup，不是新决策——47 / Maine Coon owner 对齐即可，不需 ping landy。

## Phase B.1: Minimal Entity Seed Follow-up

Phase B 机制完成（registry + alias expansion + mention index）后，**生产 entity_registry 仍为空**——`upsertEntities` 只有测试在调，对真实用户来说 alias 召回功能 inert。Phase D Perspective 若建在空 registry 上会继承 Phase B 的空心状态。B.1 在 D.0 readiness sprint 之前先填这个坑。

边界：
- **真相源是 git-tracked explicit seed**：`config/entity-seeds.json`（B.1 Design Gate 选定为 machine-readable runtime seed）。
- **猫 roster aliases 单向从 F032 roster 同步**：roster 仍是 truth，registry 只做 retrieval anchor 镜像（KD-7 / ownership map 已钉）。**不允许反写 roster**。
- **不做自动推断**：不从聊天里"猜别名"。守 KD-8（给数据不给结论）。

### Acceptance Criteria

- [x] AC-B1.1: explicit seed 真相源存在并 git-tracked（`config/entity-seeds.json`）。
- [x] AC-B1.2: 至少 1 个真实 `person:` 实体 seeded，覆盖 ≥ 4 个 alias（`person:landy ← landy / team lead / CVO / l.s. / L.S. / Lysander / @co-creator / @co-creator / @you`）。
- [x] AC-B1.3: 真实 `search_evidence("CVO")` / `search_evidence("team lead")` 能命中只提及另一 alias 的旧消息（`entity-seeds.test.js` 通过 `/api/evidence/search?q=CVO` 覆盖 dogfood 路径）。
- [x] AC-B1.4: 猫 roster aliases 同步是 **roster → registry 单向**，registry 不反写 cat-config.json / AgentRegistry。
- [x] AC-B1.5: seed 真相源带 provenance（来源 + 日期 + 维护者），编辑历史进 git log。

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

## Phase D.0: Readiness Eval Sprint（Phase D 前置硬门禁）

Phase D Perspective 建在 Phase A/C readers 之上，但**没人验证过 Phase A/C 真被猫用**——drillDown 提示真被打开了吗？inline passage content 真被读了吗？猫是不是仍在绕回人工 grep transcript？数据没拉出来之前盲推 Phase D 等于把 Perspective 建在沙上。

D.0 是 **1-2 天的小切片 eval**（不是 1 周大工程），用既有 F200 fixture + 3 条真实 dogfood query 拉数据。

### Scope（D.0 必做）

- 跑 Phase A/B/C 既有 F200 fixtures（`docs/eval/f209-phase-{a,b,c}-*.md`）。
- 加 3 条真实 dogfood query（team lead指定 / 历史真实场景），跑 `search_evidence → drillDown → reader` 端到端。
- 同时跑 B.1 seed 后的"CVO 找到只提team lead的消息"作为 Phase B 真实可感知验证。

### Observability（D.0 要拉的数据）

**F209-owned 四项**（D.0 自己 own，AC-D0.2 拉的就是这四项）：

- **drillDown 点开率**：搜索返回的 `drillDown.tool` 被猫真调用的比例。
- **anchor open rate**：候选 anchor 真被打开（reader 调用）的比例。
- **inline content 阅读率**：`passages[].content` 是被猫读完判断（继续 drilldown 或停下），还是直接全 ignore 走 drill-down。
- **绕回 grep 比例**：猫放弃 search_evidence 改用 `rg` / `grep` / `Read` 直查 transcript 的次数。

**F200-owned 参考 metric**（D.0 借来对照，归属仍在 F200，按 KD-6）：

- **recall@k**：F200 既有 metric，D.0 跑既有 fixture 时顺带拉一份参考值。

### Pass Conditions

- 数据**清楚**（drillDown 真用率 ≥ 经验阈值，anchor open rate 非异常低，猫不大量绕回 grep）→ 进 Phase D Design Gate (AC-D0 product spike)。
- 数据**难看**（机制 ship 但实际无人用 / 大量绕回 grep）→ **不推 Phase D**，先回头修 Phase A/C UX 或补 B.1 seed 覆盖。

### Phase D.0 Acceptance Criteria

- [x] AC-D0.1: 跑完 Phase A/B/C 既有 fixture + 3 条真实 dogfood query，证据写进 D.0 report。
- [x] AC-D0.2: 上述四项 observability 指标拉出实际数字（不能"看着差不多"）。
- [x] AC-D0.3: 通过 / 不通过结论 + 下一步（推 Phase D / 回头修哪段）由 47/Maine Coon 共同决定，结论 commit 进 docs/decisions/。

### Post-D.0 Delegation Matrix（不阻塞 Phase D product spike）

Phase D.0 的 user-visible recall 已 unblock；以下问题继续追，但不应把 F209 Phase D product spike 拖回 MCP/config/eval 细节里。新 thread / 新 owner 可以直接按本表开干。

| Work item | Suggested owner/thread | Why separate from F209 Phase D | Acceptance target |
|-----------|------------------------|--------------------------------|-------------------|
| **F193/F209 MCP topology cleanup** — split servers 与 legacy `cat-cafe` all-in-one 在本机同时暴露，原因是 `cat-cafe-limb` 被标成 `source=external` 时 F193 heal 保守退出，legacy `cat-cafe` 未被移除 | F193 / MCP topology thread（建议 Opus-47 或后端协议猫） | 属于 F193 Phase C split-only migration / L5 config heal，不是 Perspective 产品层 | `capabilities.json` + `.mcp.json` + `.codex/config.toml` 在 split+limb 可用时不再保留 legacy `cat-cafe`；保留外部 ID collision 安全测试；不丢 limb tools |
| **F200/F209 recall@k wrapper** — 将 `docs/eval/f209-phase-{a,b,c}-*.md` 接入 F200 fixture runner | F200 eval thread | Cross-validation 工具，不是 Phase D 前置门禁；D.0 已用 F209-owned 四项指标完成判定 | F200 可一键跑 F209 fixtures，输出 recall@k / pass-fail 摘要；不改变 F209 runtime 行为 |
| **Phase C reader hardening** — file-slice drillDown 绝对 host path 不泄漏；缺 `sourceRoot` fail-closed | F209 hardening mini-thread（安全/测试向） | Phase C 安全边界修复，和 Phase D Perspective user story 可以并行 | 回归测试覆盖 host path redaction + missing sourceRoot fail-closed；MCP/REST surface 不再泄漏不可读主机路径 |

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

- [x] AC-D0: Design Gate 前完成 Perspective product spike，给出 2-3 个 user story + runtime contract。
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
- **Related / upstream input**: F211 Cross-Runtime Session Transparency — 负责让 Antigravity cascade / IDE-direct session 先进入 Session Chain / transcript / digest；F209 只消费这些已存在证据做 retrieval，不 owns session lifecycle。

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
| "AC pass 但用户感受不到" 走偏（Phase B 空字典 / Phase C post-merge dogfood bug） | Phase Close Definition（KD-11）要求机制 ship + dogfood demo 双足；quality-gate skill 加 Step 4.5 Dogfood-Your-Slice |
| Phase D Perspective 建在没人用的 A/C 上 | D.0 readiness eval sprint（KD-13）作为 Phase D 前置硬门禁 |

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
| KD-11 | Phase close = 机制 ship + 真实可感知 dogfood demo（同时满足） | Phase B 空字典 + Phase C dogfood bug post-merge 都是"AC pass ≠ 用户感受到"的同型走偏；机制绿灯不等于用户可用 | 2026-05-23 |
| KD-12 | AC-B6 transferred to F208 AC-A5（不再让 F209 永远 99%） | 跨 feature AC 不应永久挂在另一 feature 的 timeline 上；F208 spec 持有对偶责任，ownership cleanup 由两边 owner 自决 | 2026-05-23 |
| KD-13 | Phase D 启动前必须过 D.0 readiness sprint（1-2 天） | 没数据盲推 Phase D 会让 Perspective 建在沙上；先证 A/C 真被用，再决定 D 设计 | 2026-05-23 |
| KD-14 | Antigravity session transparency 不进 F209，拆到 F211 | F209 是“找证据、开原文、让猫判断”；F211 是“让跨 runtime session 先成为可见证据”。F209 只作为 downstream consumer | 2026-05-24 |

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
- Phase B.1：跨族 review（seed schema + provenance + roster 单向边界守住）
- Phase C：跨族 review（typed reader contract）
- Phase D.0：跨族 review（eval sprint methodology + 通过/不通过判据 + 数据真实性）
- Phase D：跨族 review + CVO product review（Perspective 语义）
- Phase E：F200/F192 owner review（eval contract + telemetry）
