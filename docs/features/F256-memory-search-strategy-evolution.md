---
feature_ids: [F256]
related_features: [F200, F209, F242, F188]
topics: [memory, search-strategy, retrieval, expansion, skill, hook, agent-autonomy]
doc_kind: spec
created: 2026-06-29
tips_exempt: Phase A is internal hook/nudge text upgrade — no user-perceivable capability surface change; later phases may add tips
---

# F256: Memory Search Strategy Evolution — 从被动召回到主动探索

> **Status**: active | **Owner**: Ragdoll (opus-4.6) | **Priority**: P1

## Why

operator用"场景驱动渐进式激活"策略引导猫写路由架构文档时，逐步激活了猫自己搜不到的知识（F208 画像 / F221 品味 / F231 胶囊）。operator experience：**"我的 prompting 策略，能不能沉淀成猫的搜索策略？"**

现状问题（2026-06-24 dogfood 实证）：
- **三猫搜同题各拿 10 条，全集需三猫合**（2026-05-17 AUDHD recall dogfood）
- **Ragdoll家族"碎片够了"病**：搜到第一个高置信命中就停，不补刀
- **最佳实践存在但猫不加载**：`memory-search-best-practices` skill 需要主动加载，但缺先验知识的猫不知道要加载（鸡生蛋）
- **搜索结果不"带泥"**：搜"路由"不会自动提示"F208 画像跟路由有关联"——expansion hints 只在 `intent=coverage` 模式暴露，默认 `topk` 不带

operator的核心洞察：**问题不在搜索算法（BM25/向量/RRF），在搜索策略层——猫拿到模糊 query 时的第一步做什么。** 而且这和 retrieval pipeline 优化是**同一个问题的两个面**——pipeline 负责"水管通不通"，策略负责"往哪浇水"。

## Current State / 现状基线

### 已有基建（不是从零开始）

| 组件 | 状态 | 说明 |
|------|------|------|
| `search_evidence` 三入口 | ✅ 生产 | BM25 + vector + hybrid RRF + F200 rerank |
| `memory-navigation` skill | ✅ 生产 | 决定第一刀用哪个工具 |
| `memory-search-best-practices` skill | ✅ 生产 | 8 种题型 recipe + "何时停"判据 |
| Session start hook | ✅ 生产 | 每次注入三入口提示，但**不提 skill、不提补刀策略** |
| `search_evidence` nudge | ✅ 生产 | 低命中时显示 `🧭 Memory navigation nudge` |
| Expansion provenance | ✅ 生产 | 三类 expansion（frontmatter-alias / source-thread / convention-edge），但**只在 `intent=coverage` 暴露** |
| F242 Convention Graph | ✅ 生产 | 3 个 extractor（mcp-tool / skill-manifest / fastapi-route），**缺 capsule/l0/prompt-injection 类** |
| F200 consumption tracking | ✅ 生产 | search → read → use → verify 链路追踪（HW-4/6/7 均已 merged） |

### 缺什么

1. **Session start hook 内容太薄**：只说"三入口"，不提 skill 存在、不提补刀策略、不提Ragdoll病
2. **默认搜索不带 expansion hints**：`topk` 模式下猫看不到关联方向，得靠自己"知道有东西要找"
3. **F242 extractor 覆盖不了跨域桥**：`SystemPromptBuilder` 代码里 F208→路由的依赖关系，现有 extractor 抽不到
4. **没有 eval 闭环**：不知道猫在搜索策略增强后，产出质量是否真的变好了

## What

### Phase A: Session Start Hook 升级 + Skill Link

**最小 token、最大 ROI 的第一步**——升级 session start hook 内容，让猫在每次 session 开始就知道：
1. 三入口怎么选（已有）
2. 复杂搜索任务有 `memory-search-best-practices` skill 可以加载
3. Ragdoll家族：别搜一刀就停

同时确保 `search_evidence` 的 nudge 在低命中时能引导猫换切面或加载 skill。

### Phase B: Expansion Hints 投影到默认搜索

> **与 Phase A 无硬依赖，可并行开发。** B 越早上线 → F200 数据越早积累 → Phase D eval 越早有料。

把已有的 expansion provenance（三类 expansion）从 `intent=coverage` 投影到 `intent=topk` 的默认搜索输出。具体：搜索结果末尾加一块独立的"相关方向"（不混进主排序，保精度），内容复用已有 expansion provenance。

**防噪机制**：hints 不混入主排序只是防污染主排序；hints 本身的噪音靠 participation coefficient 入口闸（只让图上的结构性"桥"通过，不是什么都推）+ PMI/lift 剪枝（防"A 和 B 都很热门所以看起来相关"的自强化假阳性）。技术方案细节见讨论文档第七部分。

**同时接 F200 闭环**：记录 expansion hints 的 followup rate（猫有没有真的追下去）。

### Phase C: F242 Extractor 扩展（doc-code 桥接）

补 extractor 覆盖"文档 ↔ 代码"的跨域关联。核心目标：能让搜"路由"时带出 F208 画像（当前做不到，因为关联藏在 SystemPromptBuilder 代码里）。

具体：新增 capsule/l0/prompt-injection 类 extractor，让 F208→L0→路由这条功能依赖链成为确定性 convention edge。

### Phase D: Eval + 策略迭代（看数据再定）

基于 Phase B 的 F200 数据，评估：
- expansion followup rate 多少？
- 猫是否少 reformulate 了？
- 覆盖度有没有提升？
- 冷启动（完全没支点）占比多大——值不值得单独解？

根据数据决定下一步：迭代 hook/nudge 内容、调整 expansion 策略、或发现冷启动需要单独方案。

## User Journey

### Primary Journey: 猫面对模糊搜索任务
- **Scope unit**: session
- **Actor**: 猫猫
- **Entry**: 收到operator的模糊任务（如"写一份路由系统的架构文档"）
- **Flow**:
  1. Session 开始 → 猫看到 hook 提示"复杂搜索加载 memory-search-best-practices"（Phase A）
  2. 猫搜"路由系统" → 结果末尾带"相关方向"块，列出 frontmatter/source-thread 关联（Phase B）
  3. 猫追搜关联方向 → 又带出新关联 → 逐步拼出全貌（Phase B 循环）
  4. **Phase C 旗舰验收**：搜"路由"通过 doc-code convention edge 带出 F208 画像（Phase B 不保证此路径——需要 Phase C extractor 才能覆盖 SystemPromptBuilder 里的跨域依赖）
  5. 猫搜了 3 路无新 anchor → 知道该停了
- **Success evidence**: 猫独立（无operator碎片引导）完成同等覆盖度的文档
- **Non-goals**: 不替猫决定搜什么（KD-8：给数据不给结论）；不做自动摘要注入

## Acceptance Criteria

### Phase A（Hook + Skill Link）✅
- [x] AC-A1: Session start hook 内容包含 `memory-search-best-practices` skill 的存在提示 + 加载时机
- [x] AC-A2: Session start hook 包含搜索停止判据提醒"≥3 路命中无新 anchor 才停"（Ragdoll家族尤其注意）
- [x] AC-A3: `search_evidence` nudge 在 low-hit 时引导加载 skill 或换切面

### Phase B（Expansion Hints 投影）✅
- [x] AC-B1: `intent=topk` 的默认搜索结果包含独立的"相关方向"块（不混入主排序）
- [x] AC-B2: 相关方向的来源（frontmatter/source-thread/convention-edge）对猫透明可见
- [x] AC-B3: F200 记录 expansion hint 的 followup rate（猫追了 vs 没追）

### Phase C（Extractor 扩展）
- [ ] AC-C1: 新增 ≥1 个 extractor 覆盖 capsule/l0/prompt-injection 类依赖
- [ ] AC-C2: 搜"路由"能通过 convention edge 带出 F208 画像（当前 Ground Truth 复现）

### Phase D（Eval + 迭代）
- [ ] AC-D1: 基于 ≥30 天 dogfood 数据的 expansion followup rate 报告
- [ ] AC-D2: 冷启动占比评估 + 是否需要单独方案的决策
- [ ] AC-D3: 北极星指标——**单猫 recall coverage 逼近多猫合集**：复现 2026-05-17 AUDHD dogfood（同题三猫各搜 → 单猫搜 → 对比覆盖度），量化 F256 前后差距

## Dependencies

- **Related**: F200（consumption eval 闭环——Phase B 的 followup rate 追踪依赖 F200 基建）
- **Related**: F209（passage-level retrieval——互补，F209 管"搜得到"，F256 管"知道该搜什么"）
- **Related**: F242（convention graph——Phase C 扩展 extractor 直接在 F242 框架内）
- **Related**: F188（memory navigation skill 出处）

## Risk

| 风险 | 缓解 |
|------|------|
| Hook 内容太长浪费 token | 控制在 200 token 内，只放最高 ROI 的提示 |
| Expansion hints 带出噪音 | 三层防线：① 不混入主排序（防污染精确结果）② participation coefficient 入口闸（只让图上结构性桥通过）③ PMI/lift 剪枝（防"都热门所以看似相关"的自强化假阳性）+ F200 followup rate 追踪衡量 |
| Phase C extractor 复杂度 | 只做确定性抽取（代码 import/inject 关系），不用分类器（KD-8） |
| 冷启动问题超出本 feature scope | Phase D 数据驱动决策，不预设方案 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 核心下沉到 hook + pipeline（前两层自动兜底），skill 留作第三层进阶 | hook/pipeline 自动生效解鸡生蛋；skill 仍是复杂搜索任务的进阶工具箱，不砍 | 2026-06-29 |
| KD-2 | Expansion hints 不混入主排序 | 保持搜索精度，hints 是额外信息不是排序因子 | 2026-06-29 |
| KD-3 | 不用分类器替猫判断 | KD-8 同源：给数据不给结论 | 2026-06-29 |
| KD-4 | 这是 retrieval pipeline 的增强层，不是独立系统 | operator洞察：桥发现和搜索去噪是同一个问题的两面 | 2026-06-29 |
| KD-5 | Expansion hints 防噪采用四层流水线方向：participation coefficient 入口闸 → 同域邻居过滤 → PMI/lift 30d 共遍历剪枝 → 猫确认高价值边 | 48 们 5 轮收敛（06-25~29），无分歧；弃 betweenness 选 participation 因更适合 kNN 图稀疏结构；PMI 防"两个热门节点看似相关"的自强化；技术 memo 见讨论文档第七部分 | 2026-06-29 |
| KD-6 | graphTraversal 0% 是真约束，expansion hints 在 graphTraversal 解锁前先用 frontmatter/source-thread expansion（已有基建）| 当前 search_evidence 调用链中 graphTraversal 使用率 0%（F200 数据），convention edge 实际从未被猫走过；先发 expansion 不等 fix | 2026-06-29 |
