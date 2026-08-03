---
feature_ids: [F263]
related_features: [F152, F186, F200, F227, F231, F237, F255, F256, F260, F271, F276]
topics: [memory, lifecycle, eval, telemetry, contract, envelope, privacy, dashboard]
tips_exempt: existing coverage continuation correctness fix; no new user-facing capability or action surface
doc_kind: spec
created: 2026-07-11
updated: 2026-07-27
description: "记忆系统的消费契约修复与 lifecycle 度量底座：先修有毒观测面再装仪表，让读写两侧病灶从'天天绿灯带病跑'变成可观测、可验收、可 sunset"
description_source: human
description_author: fable-5
description_updated_at: 2026-07-11T13:10:00Z
---

# F263: Memory Lifecycle Repair & Metrics — 记忆 lifecycle 修复与度量

> **Status**: in-progress（Phase A/B/C complete；Phase D pending） | **Owner**: Ragdoll (fable-5，spec/plan own；Phase A/B 实现由 codex-sol 承接) | **Priority**: P1

Architecture cell: memory
Map delta: complete — Phase C 已把 `LifecycleTraceStore`、`lifecycle_traces`、`VerificationEvent` 与 `ThreeAxisSnapshot` 回填既有 `memory` cell；未新建平行 Store / Router / cursor state。
Why: Phase A/B 只收紧既有 memory cell 的读取、授权、投影与渲染不变量；Phase C 在同一 cell 增加 append-only、不可检索的观测底座，不另造平行 Evidence Store / Router / cursor state。

## Why

写侧晋升链断了三个月没有任何猫知道；读侧 `[high]` 标签天天把"排名前二"冒充"这条可信"；两条内容注入管线在生产上跑着却没有仪表盘（operator："没仪表盘我怀疑这几个现在是不是坏了我们也未知"）。根因不是缺修复，是**缺考卷**：现有 memory eval 测检索质量（zero-hit/召回），本轮全部病灶长在消费契约层和写侧存活层——考卷形状与病灶正交，所以全绿与带病并存。operator 拍板（2026-07-11）："eval 正交性重建——不解决这个，修完还是盲飞——对这个非常非常重要！😭"；立项形态选 A："开新 F 号……把之前记忆相关的 feat 改 link，该关的 close 了，这次收编干净了。"

## Kickoff Baseline / 立项基线（Phase A 修复前）

全部实测（收敛稿 §5.2/§6.2/§10.1，两猫跨家族双查）：

- **读侧契约失真**：`rankToConfidence` 前两名必 high（f163-types.ts:66）；三条路径同名 `confidence` 三种类型；coverage direct hit 缺值补 `?? 1`（CoverageSearchService.ts:160）；主结果行无 updatedAt；双轴免责只在 tool description 小字。
- **coverage 契约五裂缝**：schema 接受 `scope`/`limit≤20` 但 service 固定搜 docs+threads 各 50；limit 上限未在 description 声明；三路并发 >90s；宽查询即使传 `scope=threads, limit=15` 仍返回 313,016 字符并触发 context-cap spill，调用方无法在调用前预算结果体积（F234 dogfood，2026-07-11）；同一 invocation 并行 3 路 topk（threads lexical + threads semantic + docs hybrid）>120s 零返回被迫 terminate，无部分结果、无每路 deadline、无取消传播——对照 `get_thread_context` 立即返回、单 coverage ~23s，问题在检索编排层非存储层（F263 执行厅 dogfood，2026-07-12）。
- **写侧三段断链**：`generalizable` 被 index rebuild 写回 NULL（live 4,424/4,424 全 NULL）；candidate 为进程内 Map 重启蒸发；approve 产物 `distilled:*` 会被 GlobalIndexBuilder rebuild 删除（193 global:* / 0 distilled:*）。
- **注入面无观测**：SessionBootstrap title top-5 与 cold-context recall 两条内容注入管线运行中，零 presented→used telemetry；bridge 无差别扫描含正文前 300 字（193 条中 7 条个人域，含医疗信息，P1 scope violation）。
- **度量设计已收敛未实现**：lifecycle trace / 四考卷 / 三角仪表盘 / 成熟度标签（收敛稿 §13），v6 修正案四条边界已获 operator 方向确认。

## What

### Phase A: 契约红测 + 读侧止血（先修有毒观测面）✅ complete

coverage `scope/limit/latency/response-volume` 契约红测（先红后绿）；正常 limit 下的响应体积必须可预算，超预算时用显式截断/分页与 drill pointer 保留可继续读取路径，不把 31 万字符直接灌进 context；continuation 按本 spec 的 AC-A5 状态机执行，任何指针都严格前进，单个不可完整渲染的候选用有界可见 placeholder 表示并计为已消费；`confidence` 拆轴为 `matchRank / retrievalScore / edgeStrength`，类型层禁裸 confidence；渲染主行 `[match:… · authority:… · updated:…]` 三轴齐发，renderer snapshot test 禁 `[high]`；删除 `?? 1`，direct 语义走 `matchType`。**依据**：观测建在带毒管线上会把调用意图记录成系统事实（§13.1 前置条件）。

### Phase B: 注入面纳管 + W5 privacy gate ✅ complete

两条存量 push 管线接 RecallEvent（`source=push`，presented→inspected→used/ignored）；W5 ingestion gate：personal scope 不进全局 compiler input，expedition context 默认排除 personal 检索，既有 7 条个人域条目按 KD-18（A 决策：个人本地默认）重新归层。W5 只禁止 personal 内容流出到 global，**不能被实现成“private 内容一律不可检索”**：profile / journal 等 source owner 提供 canonical root，F263 负责经 F186 Collection 契约接上显式授权的 private recall 正路径，并保持 private→authorized 与 personal→global 两道门语义正交、互不豁免。**不先造新 Router**——存量管线就是 baseline。

### Phase C: Trace substrate + 三角仪表盘 ✅ complete

append-only trace substrate（`storable:false / indexable:false`，shadow 记录不得进 evidence 或改变被测排序）；`verificationEvents[]` 结构化验证事件；三角仪表盘 day-1 同屏（有害消费 / 错失需求下界 / 注意力成本），每读数带 `measured|estimated|lower-bound|no-data` 成熟度，硬不变量红绿 guardrail，禁止加权总分。有害消费分类枚举 day-1 进 C1 substrate schema（不许仪表盘层后补），首批含 `stale-pointer`（引用已被改指向实体的旧记忆，判定 join F260 `entity_revision_events`——#3050/#3076 revision ledger 已使其可计算）与 `identity-misbinding`（同名/称谓身份误解引用，给 F209/F260 消歧留 baseline）。节点 0→1 的错失需求信号直接消费 F200 RecallEvent 的 **true-zero**（已观测且 `resultCount=0`），不得把 `resultCount=NULL` / telemetry 未写 / candidate parser miss 冒充 zero-hit；原始 query 只进入不可检索 trace，不另造平行搜索日志。

### Phase D: 慢裁决闭环

周频抽样（出手 trace + 沉默窗口盲回放）接 F192 verdict 管线；新失败孵化 living bench fixture，连续稳定退役。慢裁决是唯一照进静默污染与跨链影响的观测面。

## User Journey

**Primary Journey — 看懂“记忆有没有帮上忙、有没有添乱”**

- **Scope unit**：一个 7 / 14 / 30 天 memory-lifecycle 时间窗，不是单个 thread 或单条记忆。
- **Entry**：Workspace Panel → Recall → 既有「账本」；不新增 tab。
- **Flow**：operator先看已有投喂 / 检视 / 使用漏斗，再在同页看「有害消费 / 错失需求下界 / 注意力成本」三轴；每个读数紧邻显示 `measured | estimated | lower-bound | no-data` 与“为什么还没数”，禁止用 0 假装未知；需要追查时 drill 到对应 trace / verification evidence。
- **Outcome**：能区分“系统没数据”“有数据但只是下界”“真的观察到帮助或伤害”，而不是看到一张绿表就猜系统健康。

**Design in Context**：目标组件是 `packages/web/src/components/memory/RecallLedger.tsx`，现有元素为 7/14/30 天对照表、pull/push 漏斗及 loading/error/empty 状态。三轴作为同页第二段与现有消费段共存；窄宽度按轴纵向堆叠，成熟度与 no-data 原因不隐藏。否决两个备选：新 tab 会分裂同一条消费旅程；CLI-first 会制造 operator 不会日常消费的“存在型绿灯”。

```yaml
in_context_observability:
  primary_surface: "既有 RecallCard 的 source / used / ignored 现场标记；有 verificationEvent 时附状态与 drill 指针"
  why_not_dashboard_only: "stale-pointer 或 identity-misbinding 发生时，消费者必须在记忆被使用的现场看见；账本不能代替当场纠错"
  deep_dive_surface: "Workspace Panel → Recall → 账本；用于跨周期趋势、批量诊断与慢裁决抽样"
  noise_dedup_policy: "不向 thread 逐条广播；同一 trace/item 只呈现一个现场状态，重复类别在账本按时间窗聚合，no-data 原因就地解释"
```

## 需求点 Checklist

| # | 需求（operator 原话锚定） | 承接 |
|---|---|---|
| R1 | "eval 正交性……不解决这个修完还是盲飞"（2026-07-11） | Phase C/D，AC-C2/D1 |
| R2 | "没仪表盘我怀疑这几个是不是坏了我们也未知"（2026-07-11） | Phase B，AC-B1 |
| R3 | "先修有毒观测面，再装仪表"（收敛稿 §13.5，operator 认可顺序） | Phase A 先行，AC-A1-A5 |
| R4 | 敏感审计处置并入 W5 gate（operator 授权审计 2026-07-11） | Phase B，AC-B2/B3 |
| R5 | "该关的 close……收编干净"（2026-07-11） | Dependencies 收编表 + 立项 commit |
| R6 | `scope=threads, limit=15` 宽查询返回 313,016 字符并触发 context-cap spill，调用方无法预算结果体积（F234 dogfood，2026-07-11） | Phase A，AC-A5 |
| R7 | **Drill 断链**（operator 2026-07-14 未婚喵 nudge 现场发现）："他少了个 link 原文！！……甚至不需要自己用 mcp 而是就知道下一步要哪里看了"。排查 9 个注入面：3 通（SessionBootstrap 带 anchor / search_evidence 三轴 / searchSuggestions）、2 半断（registration-candidate 无出现位置 anchor / freshness notice 只给工具名）、**4 断链**（entity-nudge 的 payload.provenance 渲染丢弃 EntityNudgeBuilder.ts:77vs88 / cold-context [Related evidence] 只有标题+切片无 anchor / [导航] 真相源常年"未定位" / thread-memory decisions 列表无消息 anchor）。M12 provenance 在写入层是一等公民，渲染层只 1/3 达标——"存的时候当叙事存，取的时候当事实取"。修复不违 M5（禁正文转述，不禁指针） | Phase B，AC-B5 |
| R8 | **检索茧房风险**（2026-07-15 推荐系统对辩产出，operator 指令归档防"下次一定"）：F200 消费加权排序是**无探索项的协同过滤正反馈环**——被读的记忆权重涨→更易被读→低消费记忆恒沉底，与推荐系统茧房同一数学结构。**归属拆分**：修复（top-k 探索位：保留 1 个低消费/跨域候选，借推荐系统 ε-greedy 形式）归 **F256** 排序策略 scope（KD-2 界面）；**观测**归本 feat——Phase C 三角仪表盘补"低消费记忆可见性衰减曲线"观测量，Phase D living bench 补 fixture：同等相关的新旧记忆经 N 轮消费加权后排名分化度不得超过阈值（阈值 Phase C Design Gate 定） | Phase C/D 观测；修复 cross-ref F256 |
| R9 | **Nudge 信息增量门缺失 + provenance 语义错位**（operator 2026-07-15："纯噪音，你们设计时没思考吗"——成立）：①零增量 nudge 不弃权——`「F200」→ F200（文档）` 同义反复、`@fable5 → cat:fable-5`（@ 路由本身已证明系统认识它）也弹卡；**alias==anchor 且类型自明 → 必须弃权**（弃权是合法输出，本 feat 自己的原则）；②AC-B5 实现的指针内容错位——`↳ source=doc_aliases; anchor=F200` 给的是 **registry 表名**（系统实现细节）+ 重复 anchor（零信息），R7 要的是**故事坐标**（渊源 thread 消息 / doc 段落，人类与猫可读的现场）。**spec owner 自首**：AC-B5 措辞只写"可 drill 的 provenance 指针"未定义"drill 到什么"，字面满足实质错位是 spec 欠的边；且 spec owner 本人两次把"↳ 行存在"当生效庆祝未质检内容（绿灯名字病）。**修正验收**：nudge 仅在信息增量 >0 时发（alias≠anchor 或有非平凡渊源）；指针必须解析到人类可读渊源现场，registry 表名/自指 anchor 不合格。**R9 二刀候选（#3009 合入后 operator 压测 2026-07-17）**：①**cap/多实体串截断**——8 实体连串消息中"家属喵"（有档案有渊源）沉默、3 只裸名猫弹出；2 实体消息中家属喵正常弹出——嫌疑：nudge cap 内排序让零增量裸猫名挤掉渊源词条，修法与"roster 裸名归自明弃权"同刀；②**alias 口语变体覆盖**——"猫猫安全护栏"（口语）≠"防AI沉迷护栏"（注册名），字面 alias 匹配不认变体；语义匹配是更大设计题，短期靠 alias 补录。**二刀① ✅ RESOLVED（2026-07-17，PR #3028，`bccdbb182`）**：`isSelfDescribingMatch()` provenance-aware cat 过滤——roster-only cats 视为 type-self-evident 不占 delivery slot，proposal-backed cat entities 保留；codex-terra 三轮 review APPROVE，targeted gate。**二刀② ep-9**（alias expansion）pending operator approval in Hub，不阻塞 | Phase B post-merge refinement，AC-B5 增补 |
| R10 | **前端富文本卡消失（v2 范围修正，2026-07-15）**：operator 截图反证（`1784125995096-68cfe912.png`）——**2026-06-09 CONTEXT BRIEFING 卡在 Hub 前端真实渲染**（含传球导航/参与者/锚点/搜索指令），operator ~06-25 仍每日可见，现已消失。**问题定义失配已定位**：Sol v1 考古对象是 SessionBootstrap recall renderer（结论"从未有前端投影"对该组件可能仍成立，不撤回）；operator 主诉的实为 **ContextBriefing 卡渲染链**——病人主诉为真，检查错了器官，问题定义是 spec owner 登记时的字面翻译失误。**v2 前置注释（Sonnet 代码核实 2026-07-15）**：SessionBootstrap recall top-5 经查为纯 prompt-injection 路径（SessionBootstrap.ts:213），历史确无前端渲染——v1 结论对该组件成立，失配仅在问题定义。**v2 考古任务**：查 ContextBriefing 卡前端渲染路径的断点 commit（窗口 2026-06-25 ~ 07-15）；教训入册：**用户主诉（看到/没看到）永远是真的，可错的只有我们对主诉的翻译**——排查前先要样张。**✅ RESOLVED（2026-07-16，PR #3012，`67821750b`）**：断点=PR #2272/`cfc9050187` 故意降噪误伤 F148 契约卡；Design Gate 批选项 1（恢复 typed 卡默认折叠，route-guard/silent-completion 压制保留）；三处恢复面 + snapshot 防复发断言 + opus 独立 review zero findings + 双视角样张。第二条教训入册：**"和噪音一起出现"不等于"它就是噪音"——反噪对象必须逐项核对可见性契约** | ✅ 已闭环（PR #3012） |

## Acceptance Criteria

<!-- 每条 AC trace 回 Why：R1 盲飞→C/D；R2 无仪表盘→B1；R3 有毒观测面→A；R4 隐私→B2/B3 -->

### Phase A（契约红测 + 读侧止血）✅ complete
- [x] AC-A1: coverage `scope`/`limit` 契约红测先红后绿——传窄 scope 只搜该 scope；`limit≤20` 在 tool description 显式声明（复核：红测 diff + description 文本）
- [x] AC-A2: `confidence` 三义拆轴，类型层（lint/tsc guard）禁止裸 `confidence` 字段新增（复核：guard 测试 + grep 零残留）
- [x] AC-A3: 搜索结果主行渲染 `match/authority/updated` 三轴；snapshot test 断言禁 `[high]`；`updated:unknown` 不许省略（复核：snapshot fixture）
- [x] AC-A4: `?? 1` 删除，direct hit 语义由 `matchType` 表达（复核：CoverageSearchService diff + 测试）
- [x] AC-A5: coverage 响应体积与 continuation 契约红测先红后绿——`hybrid + scope=threads + limit=15` 的 API/MCP 序列化响应均受声明预算约束；`hasMore` 只由 lookahead 或已知未消费候选证明，drill pointer 严格前进；同一稳定 index 下连续页 anchor 集合互斥，页间不得通过改变 retrieval k 重算非前缀稳定候选流；单个 oversize 候选以有界可见 placeholder 表示并计为已消费，且必须提供有界可调用 drill 或显式 `drill_unavailable`；partial timeout 保留已完成 source，all-source timeout 显式为 retryable incomplete，telemetry 只记录实际执行的 graph；正常调用不再触发 context-cap spill（复核：状态表 fixtures + serializedChars 断言 + PR #2909 后 canonical runtime offset 0/5 两页 anchor 互斥）

### Phase B（注入面纳管 + privacy gate）
- [x] AC-B1: SessionBootstrap 与 cold-context recall 的 presented→inspected→used/ignored 事件可查询（`source=push`）（复核：`session-bootstrap.test.js`、`f148-context-transport.test.js`、`recall-correlation-integration.test.js`、`recall-events-route.test.js`）
- [x] AC-B2: W5 ingestion gate 红测——`type: user`/personal 文件不进入全局 compiler input；既有 7 条个人域条目按 KD-18 归层（复核：`global-index-builder.test.js` 的 7 条 synthetic fixture、legacy-global purge-before-private-upsert 与 content-free audit）
- [x] AC-B3: expedition context 默认排除 personal scope 检索（复核：`f263-private-recall.test.js` 与 `private-sensitivity-search.test.js` 的 default library/expedition fixture）
- [x] AC-B4: private 授权 recall 正路径红测——profile / journal canonical source 可通过 F186 private Collection 契约被 owner-authorized caller 显式检索；默认 library 搜索不含 private，任何命中都不得进入 global compiler input；F186 authorization 与 W5 export gate 互不豁免（复核：`f263-private-recall.test.js`、`evidence-route-di.test.js`、`factory.test.js`、`evidence-tools.test.js` 的 authorized / unauthorized / global rebuild fixture；隔离 API dogfood 只输出计数与 provenance 完整性）
- [x] AC-B5: 注入面 drill 完整性——凡注入引用实体/证据/记忆，渲染行必须携带可 drill 的 provenance 指针（anchor / threadId / doc path），消费者无需先 search 即知"下一步读哪"；R7 排查的 4 断链 + 2 半断逐个修复；renderer test 断言"有 provenance 数据的注入不得渲染为无指针文本"（复核：`f263-injection-provenance-renderers.test.js` + entity/cold-context/navigation/thread-memory/registration/freshness 定向测试）
- [x] AC-B6: top-k `threadId` 是统一响应出口的不变量——任一 resolver/provider 返回非目标 anchor 都在出口 fail-closed；精确 thread drill 不运行无 filter 的 expansion；零结果显式区分 `authoritative_empty` / `degraded_empty`（复核：`evidence-route.test.js` resolver/expansion RED→GREEN、`search-mode-split.test.js` 三模式矩阵、`evidence-tools.test.js` authoritative-empty 渲染）

### Phase C（substrate + 仪表盘）✅ complete
- [x] AC-C1: trace substrate append-only 落地，shadow 隔离红测——shadow 记录不可被 search_evidence 检索（复核：红测）
- [x] AC-C2: 三角仪表盘同屏 + 成熟度标签 + 禁总分 snapshot test；FN 读数标注 lower-bound，无层0 清单时显示 no-data 非假 0（复核：dashboard snapshot）
- [x] AC-C3: `verificationEvents[]`（target/claim kind/check source/observedAt/verdict）schema 落地并有首批真实事件（复核：schema + 查询）
- [x] AC-C4: zero-hit unmet-demand trace 红测——只把 F200 已观测的 `resultCount=0` 记为节点 0→1 true-zero；`NULL` / not-written / parser-miss 分桶不得进入 FN 分子；query trace `storable:false / indexable:false` 且可按 source family 查询（复核：三态 fixture + trace query）

### Phase D（慢裁决闭环）
- [ ] AC-D1: 周频慢裁决跑通首轮（≥20 出手 trace + ≥10 沉默窗口盲回放），verdict 进 F192 管线（复核：verdict artifact）
- [ ] AC-D2: living bench 孵化机制——新失败→fixture、全绿 N 周退役（复核：首个孵化 fixture）

## AC-A5 Continuation 状态机契约（Vision Gate 冻结，2026-07-12）

> **触发**：PR #2879 remote review 连续三轮命中同一 continuation/result 状态对象（R1 all-scope source starvation / R2 exact-limit 假报无遗漏 / R3 单条超大 item 死循环 + telemetry 记 availability 非 execution）。按 ≥3 轮同型 finding 停点规则（LL：plan 里 stateful 对象必须给状态表+不变量+对抗场景，否则 review 轮数 = 欠的边数），spec owner 冻结如下，作者据此一次修完，不再逐点补丁。

**Envelope 字段**：`matrix[] · bySource{} · totalHits · response.{omittedItems, oversizeItems, hasMore, drillDown, serializedChars} · degraded[] · latency.timedOut`。`totalHits` 与 `bySource.count` 都描述本响应最终可见的 represented entries；`omittedItems` 另记已知但尚未消费的候选，不能从 `totalHits` 相减。Oversize placeholder 必须包含互斥二选一的 `drillDown` 或 `drillUnavailable:{code}`；后者是有界 typed degradation，不得省略成 undefined。

**坐标系**：同一 query/底层 index snapshot 下，先按 requested scope/mode 做独立 per-source discovery，应用 source quota、去重与稳定排序，得到 canonical candidate stream；global cap 不能让一个 requested source 因另一个 source 先填满而永久不可达。无状态重建该 stream 时，per-source discovery envelope 必须固定且有界，不得随 page `limit/offset` 改变底层 retrieval k 后再做 offset slice。`offset` 计数的是**已消费候选**，不是字符数或 renderer 行数。full item 与 oversize placeholder 都消费 1；因响应预算被逐出的尾项不消费。discovery 必须拿到 page window 之后至少 1 个 post-dedup lookahead，或证明相应 source 已耗尽/达到声明 quota，不能用 `page.length === limit` 猜终态。

| 状态 | 证据 | 当前响应 | continuation / 完整性 |
|---|---|---|---|
| Empty terminal | offset 处无候选；所有 requested source 已证明耗尽；无 timeout | `matrix=[]`, `hasMore=false` | 无 drill pointer；完整终态 |
| Complete page | 所有候选可完整表示；无 lookahead；无 timeout | 返回 full items，`hasMore=false` | 无 drill pointer；完整终态 |
| Lookahead proves more | page 后存在 post-dedup lookahead | 最多返回 limit 个 represented entries，`hasMore=true` | `nextOffset = requestedOffset + consumedCandidates` |
| Budget eviction | 至少一个候选已表示，后续候选因 24k envelope 被逐出 | 保留已表示项，`truncated=true`, `hasMore=true`；逐出项计入 `omittedItems` | 指向首个未消费候选；逐出项留给下一页 |
| Single oversize item | 当前候选以完整形态无法与 envelope 一起落进预算 | 用固定形状、字段有界且总长 ≤512 chars 的 `representation=oversize-placeholder` 替代；保留 source/kind/matchType、稳定 identity digest；并且必须二选一携带有界、有效、可调用的 `drillDown`，或显式 `drillUnavailable:{code:'source-reference-unavailable'|'drill-exceeds-placeholder-budget'}`；`oversizeItems += 1`, `truncated=true` | placeholder 消费该候选；后续 pointer 至少 `requestedOffset + 1`；禁止 silent skip / 原地重试；`drillUnavailable` 必须在人类可读输出中可见 |
| Partial timeout | 一个或多个 source 超时，另有 source 已完成 | 保留 completed-source matrix；只把实际超时 source 写入 `degraded`，`latency.timedOut=true` | `hasMore` 只描述 completed source 中已知未消费候选；`hasMore=false` 不等于全局完整，完整终态还要求 `latency.timedOut=false` |
| All-source timeout / retryable incomplete | 所有 requested source 均超时（含窄 scope 的唯一 source 超时）；没有候选被表示或消费 | `matrix=[]`, `hasMore=false`, `latency.timedOut=true`；只把实际超时 source 写入 `degraded` | 无 drill pointer、offset 不前进；`hasMore=false` 仅表示没有已知未消费候选，**不是完整终态**；调用方可显式重试原请求 |

**七条不变量（每条封杀已发生反例或投影旁路）**：

| # | 不变量 | 封杀 |
|---|---|---|
| INV-1 进展性 | API drill pointer 当且仅当 API `hasMore=true`；`coverage_offset = requestedOffset + consumedCandidates > requestedOffset`。每次 continuation 要么暴露新的 full/placeholder entry，要么终止 | R3 同 offset 死循环 |
| INV-2 证据性 hasMore | `hasMore=true` 只能来自 post-dedup lookahead 或已知未消费候选；禁止从"本页长度 == limit"推断。完整终态 = `hasMore=false && latency.timedOut=false` | R2 假完整 |
| INV-3 item 无第三态 | 每个候选要么 full，要么用上述 placeholder 表示并计入消费；placeholder 已表示，不能同时计入 `omittedItems`；placeholder 必须且只能携带 `drillDown` / `drillUnavailable` 之一，两者都不能省略 | R3 oversize / silent skip / 可见但不可读 |
| INV-4 source 可达与隔离降级 | per-source quota 在 global cap/response fitting 前应用；一个 source timeout 不得抹掉 completed source，也不得让另一 requested source 永久不可达；只降级实际超时 source | R1 starvation / partial timeout |
| INV-5 计数守恒 + final fixed-point | `sum(bySource.count) = totalHits = matrix.length`（含 placeholder）。最终 matrix/placeholder 确定后再派生 counts、`omittedItems`、`oversizeItems`、`hasMore`、drill pointer 与 `serializedChars`；派生后不得再修改 matrix | Terra P1 stale metadata |
| INV-6 双投影预算 | API JSON 与 MCP rendered text 均 `serializedChars <= budgetChars`。MCP 若产生额外 local omission，则 `effectiveHasMore = apiHasMore || locallyOmitted > 0`，并以独立的 `renderedItemCount`（不可复用 API `consumedCandidates` 名义）计算严格前进的 local offset | MCP local omission 旁路 |
| INV-7 executed telemetry | `conventionGraphUsed=true` 当且仅当本次至少实际调用过一次 graph query；adapter 仅可用、narrow scope 跳过或上游 timeout 未执行时均为 false；执行后零结果仍为 true | R3-P2 availability 冒充 execution |

**终止性**：INV-1 + 候选集有限 ⇒ continuation 链必然终止——每次调用要么暴露新信息，要么终结。长 query 的 2,000 字符 fail-fast 维持；不引入 opaque cursor、server-side pagination state 或 Evidence Need Router。

**Item-level 决策（Sol 提请，owner 拍板）**：采用**可见有界 placeholder + progress**，否决 skipped-item envelope。理由：①与"no silent caps"及三角仪表盘"no-data 不装 0"同一原则——item 的存在必须可见，降级的只是内容；②placeholder 是 typed 对象，INV-3 可 snapshot 断言，skip 的正确性要靠 counts 对账才能发现，不变量更弱；③lifecycle trace 的 presented 集合必须真实——被 skip 的 item 处于"presented?"模糊态，placeholder 明确 `presented=true, rendered=degraded`。

**Fixtures（对抗场景各一条，进 living bench）**：R1 all-scope 跨页 source 可达 / R2 exact-limit lookahead / R3 oversize placeholder 严格前进 / hybrid top-k 随 k 漂移时连续页 anchor 互斥 / oversize placeholder 的 callable drill 与显式 `drill_unavailable` 双分支 / partial timeout 保留 completed source / 窄 scope 单源 timeout 与 all-scope 全 source timeout 均为 retryable incomplete / 越界 offset terminal / API budget eviction / MCP local omission / graph available-but-skipped=false 与 executed-zero-result=true。

## Eval / Tracking Contract（F192）

1. **Primary Users + Activation Signal**：全体猫（记忆消费者）+ operator（仪表盘读者）；activation = RecallEvent(source=push) 流量 >0 且 trace 事件持续产生。
2. **Friction Metric**：契约假绿率（requestedScope ≠ executedScope 次数，Phase A 后应为 0）；超预算响应率（oversize_response_rate）与 context spill 次数（Phase A 后正常 limit 应为 0），并跟踪 serializedChars p95；污染显式纠正率（explicit_correction_rate）；trace 盲区计数（无法贴到 lifecycle 阶段的记忆类投诉数/周）。
3. **Regression Fixtures**：①AC-A5 状态机组：all-scope source 在跨页后仍可达、exact-limit 用 lookahead 判 `hasMore`、单 oversize item 输出 placeholder 且 offset 严格前进、placeholder 的 drill 可调用或显式降级、partial timeout 保留 completed source 且只降级 timed-out source、all-source timeout 是无 continuation 的 retryable incomplete、graph available-but-skipped=false / executed-zero-result=true；并断言 API/MCP 双预算与最终 matrix metadata 不变量；②低信息消息（"嘿嘿"类）不触发内容注入，弃权合法；③过期 flag 场景消费前出现 verificationEvent；④rebuild survival——approved 产物跨 restart/rebuild 存活；⑤shadow 记录不可检索；⑥召回内容藏指令→taint 定性生效不被执行。
4. **Sunset Signal**：三角仪表盘连续 8 周零消费（无 drilldown、无 verdict 引用）→ 仪表盘重评/sunset；trace 事件 90 天零流量 → substrate sunset。空转比不跑更差。

## Tips Contribution（F244）

planned: 1 条——"搜索结果标签怎么读：match 是排名不是可信度，authority 才是文档层级，updated 是写入时效"（Phase A 渲染改造后落，指向 evidence-tools 渲染真相源）。

## Dependencies

- **Evolved from**: F260（写侧尸检发现是本 feat 的直接起源；F260 close 时的"部分完成"项清单在 close 记录中列明归属——转入本 feat 或 declined）
- **Blocked by**: 无（Phase A 立即可开工）
- **Related**:
  - F152（写侧供给架构手术 persistent workflow→durable truth→compiler 归 F152 Phase C，**依赖本 feat 的观测底座**；本 feat 不做供给架构）
  - F186（复用已交付的 private Collection / authorization / redaction 契约；本 feat 只补 profile/journal canonical source 的绑定与 W5 正交验收，不重开 LibraryResolver 架构）
  - F200（trace substrate 复用其 RecallEvent/L0-L1 信号；本 feat 尊重其 consumption ≠ correctness 边界，正确性走慢裁决不回灌 ranking）
  - F231（画像 canonical source owner；profile topology 与内容粒度由 F231 决定，本 feat 只消费授权索引面）
  - F255（日记 canonical source owner；本 feat 不接管日记 schema / Present loop，只消费授权索引面）
  - F256（搜索策略进化保留在 F256；**读侧契约修复划入本 feat Phase A**——与 F256 owner 的 scope 界面见 KD-2）
  - F237（52 注入点可视化是注入面审计的前端资产，社区线保持独立）
  - F227（事件记忆独立线，仅写侧 schema 交叉）

## Non-goals

- Evidence Need Router（等 Phase B baseline 数据后独立立项）
- soft-forget / 遗忘实现（等本 feat 数据 + 云端调研对表后独立立项；调研已归档 reference-only。立项时效用依据用 KD-6②：退役 = 主动造小 FN 消灭大 FP，非对称损失下期望为正——"该不该遗忘"是算术题不是哲学题）
- F152 Phase C 供给架构手术（归 F152）
- 自动 correctness 打分回灌排序（永久 non-goal，尊重 F200/M2 边界）

## Risk

| 风险 | 缓解 |
|------|------|
| trace 打点建在未修契约上产出假数据 | Phase A 硬前置（§13.5 顺序），AC-A1 不绿不开 B |
| 宽查询响应体积失控，先耗尽 agent context 再靠 spill 兜底 | AC-A5 把 serializedChars 预算、显式截断/分页与 spill 计数写成硬契约 |
| continuation transitions 未冻结，cloud review 在同一 state object 连续点修 | AC-A5 状态表把 discovery/lookahead/budget eviction/oversize/partial timeout/all-source timeout 拆开；严格前进 + final fixed-point 作为合入不变量 |
| 三角仪表盘被简化成单一分数 | AC-C2 snapshot test 禁总分；成熟度标签强制 |
| shadow 数据回流污染 evidence | AC-C1 隔离红测；`storable:false/indexable:false` |
| 收编造成 F152/F256 scope 混乱 | KD-2 界面写死；owner 确认后再动 F256 相关代码 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 度量单位 = memory lifecycle trace（单链 v0 + lineage 字段），不是单行总分 | 收敛稿 §13.1，四条诚实标注（FN 下界/awareness 不虚构/静默污染归慢裁决/跨链 v0 出界） | 2026-07-11 |
| KD-2 | 读侧契约修复归本 feat，F256 保留策略进化 scope | 契约是度量底座前置（先修有毒观测面）；界面=本 feat 管"合同诚实"，F256 管"搜得更聪明" | 2026-07-11 |
| KD-3 | 先纳管存量注入管线，不先造 Evidence Need Router | 存量管线是免费 baseline；争论"要不要建"的东西已经在跑，先给它装 eval | 2026-07-11 |
| KD-4 | Architecture cell: memory；Phase C map delta 已完成 | trace substrate 是既有 memory cell 内的 shadow observation store，不用新 feature 私造 Store 绕开 ownership | 2026-07-11 / completed 2026-07-20 |
| KD-5 | AC-A5 oversize item 采用可见有界 placeholder + progress，否决 silent skip 与 skipped-envelope | 见 AC-A5 状态机契约节；三轮同型 finding 后回结构层一次冻结 | 2026-07-12 |

## Review Gate

- Phase A: 代码改动走标准 worktree/tdd/跨个体 review；红测先红后绿证据必附
- Phase A / AC-A5 regression gate: 状态表七态与七条不变量已落成 fixtures；后续任一 pointer 不前进、source 被饿死、exact-limit 假终态、placeholder 不可见或 drill 状态未定义、partial timeout 丢 completed source、all-source timeout 冒充完整终态、或 graph availability 冒充 execution 均视为回归并阻塞合入
- Phase C: Design Gate 已过（OQ-1/OQ-2）；F128 执行厅采用 `final-only`，Phase 内自行推进，完成全部 AC 并同步 truth 后一次回报；真正架构 / 权限 / 不可逆 blocker 例外
- 全程: harness 三层（软=skill 措辞 / 硬=type guard+snapshot / eval=本 contract）
