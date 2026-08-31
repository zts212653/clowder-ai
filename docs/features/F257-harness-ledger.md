---
feature_ids: [F257]
related_features: [F192, F245, F237, F254, F177, F233, F153, F244, F218]
topics: [harness, self-evolution, eval, governance, observability]
doc_kind: spec
created: 2026-07-06
---

# F257: Harness Ledger — 锅账体系与自进化闭环

> **Status**: in-progress（实现主干 #23/#24/#33/#34/#35/#36/#38 与 Phase D lifecycle/operations 已合入；**objective-driven V1 typed-fact 采集层已合入（PR #42 @ 47157c560，2026-07-19）**：T-A RoutingDecisionFact + reconcile、T-B magic-word exact 指标、T-C DeviationEventLog + report_harness_signal、三轴写入方声明 provenance 全链 fail-closed，跨猫 review 12 轮收敛，gate 19038 tests 对基线 0 新失败；**当日事故修复切片 A 已合入（PR #44 @ 10dacad2b，2026-07-20）**：昵称唯一性/模糊 @ fail-closed + 运行实例写保护；**Console 六项判据 ①—⑥ 已全部合入 develop_base（PR #65 true-scene replay @ e33d4e7b，2026-07-27；PR #66 变量段呈现 @ 53082a4f，2026-07-28；PR #71 启禁用矩阵 @ e3b5b1cb，2026-07-29）**，post-merge build + focused tests 全绿；**当前下一切片 = Phase E 首个真实五环退役 + Objective 多指标端到端垂直切片**） | **Owner**: Ragdoll (Fable) | **Priority**: P1

## 2026-08-04 当前评估模型（覆盖旧 SegmentJudgment 口径）

> 实现与验收真相源：[`feature-specs/2026-08-04-f257-objective-eval-redesign.md`](../../feature-specs/2026-08-04-f257-objective-eval-redesign.md)。本文下方保留的早期时间窗、`SegmentJudgment`、统一分母/违规率和相关 KD 只是历史设计记录，不再是当前运行契约。

当前模型只有一条主链：

1. **Tracing 只记录事实**：每个 invocation 从开始就 tracing，terminal 时以 invocation/input/output/trace turn 精确闭合为 `TraceEpisode`。Tracing 不判断 Objective、Metric 或 verdict。
2. **三条识别通道写同一种标记**：MCP 只给当前已鉴权 invocation 打 pending marker，terminal 后绑定 exact episode；结构化规则直接补同样的 `TraceAnnotation`；仍无归属的 episode 由异步 eval 猫按周期做语义 sweep。LLM 不进主回复路径。
3. **Objective 是静态目标，没有状态机**：23 个 Objective 与 46 个段/条款由版本化 manifest 挂靠；每个 Objective 指向自己的 Evaluation Model，模型内声明 Metric、规则、触发条件和 code/LLM/replay evaluator。
4. **指标不强制统一成率**：反例型 counter 只统计 distinct incident，达到 3/5 等阈值即触发，不伪造分母/违规率；只有天然存在 eligibility 分母的 Metric 才用 rate；语义指标和 replay 指标按自己的规则运行。
5. **调度和判断分离**：`EvaluationScheduler` 只按阈值、最小样本或 cadence 冻结不可变 snapshot；code/LLM/replay evaluator 读同一 snapshot，成功后 append-only 写 `MetricResult`。失败可重试，不影响原 invocation。
6. **旧派生数据不迁移**：旧 Objective id、`SegmentJudgment`、时间窗分摊与违规率不参与新评估；但不删除 raw tracing、message、thread 等原始持久数据。

新 Console 的 Eval 卡只展示“归属 Objective / Evaluation Model / Metric 结果 / 评估时间 / 评估窗口”；Tracing 卡展示真实 episode 回放，不再把 ID 列表冒充回放剧场。

> 信号 → 归因 → 修补 → 验证 → 淘汰。犯错可以，**同类偏差第二次必须被结构拦截，第三次 = 体系失败**（operator 定义的成功判据，thread_mr6kh7kdoac6852d 启动包）。

## Why

四层 harness（MCP 工具 GOTCHA / skill 手册 / 家规 / 记忆 feedback）积累了 130+ 口"锅"——每口都是一次真实事故换来的，但**没有任何一层能回答"这口锅最近 30 天拦住过什么"**。锅只加不减：每 turn 注意力被 130+ 条规则稀释（#1018 实证：PR #962 周期 60+ 次 operator 纠正，根因之一是"规则丰富但不在运行时关键路径上"），而同类偏差照样二犯三犯（#1080 A2A claim 冒名、#1082 消息排序假设失效，均为 2026-07 调查线实锤）。系统对偏差的唯一响应是"再添一口锅"，形成越治理越稀释的死循环。

终态：每口锅是**带生命周期的资产**——登记（origin/assertion）→ 触发可观测 → 周期实证评估 → 修补/升级/淘汰。锅账（ledger）是四层锅的单一真相源；"减"第一次成为有证据支撑的合法操作。

## Current State / 现状基线

2026-07-06 首棒审计实测（全表：`assets/F257/harness-audit-2026-07-06.md`）：

**Inventory（四层合计 130+，实测口径）**：
- MCP 层：43 处 GOTCHA 分布于 30 tools / 10 文件（`packages/mcp-server/src/tools/`），另有 ~13 条 hard-block 断言（400/403/429）
- Skill 层：48 个 skill（`cat-cafe-skills/manifest.yaml`），9 个 SKILL.md 含 GOTCHA 段
- 家规层：10 个 magic words + 20 条带事故编号规则（shared-rules.md 806 行）
- 记忆层：22 个文件（20 feedback + 1 reference + index）
- ⚠️ 启动包引用数字（86 工具 / 51 skill / 21 GOTCHA）回查后确认是**四个数字四种口径混排**：86=工具全集、43=GOTCHA 出现次数、31=脏过滤行数、51=目录条目数。根因不是单个数字错，而是 `unqualified-count`：数字进决策文档未带 `how_counted`（命令/口径/时间戳），下游不可复算（见 seed-cases SC-002）。

**30 天触发审计（窗口 2026-06-06→07-06，26 个签名，双路：~/.claude transcripts 540 文件 873MB + 运行时磁盘工件）**：

| 观测层级 | 样本 | 结果 |
|---------|------|------|
| O1 结构强制（server fail-closed） | 5 | 3 有 firing 实证：hold_ball 429 × 7-8 session（反复触发=锅在挡没在治）；cross_post 路由拒绝 × 2；publish_verdict 403 × 1（**拦下真实越权**：opus 试图替 gpt52 域发 verdict）。但唯一 durable 痕迹 = transcripts 自由文本 echo；pino 4xx 只在 /tmp 重启即失；tool-usage-archive 无 outcome 维度 |
| O2 提示文本（GOTCHA/家规/magic words） | 15 | 活着 3 条（KD-27 × 15 session 引用、LL-048 × 4、补锅匠 operator 06-29 真实使用）；零痕迹 5 条（星星罐子/碎片够了/LL-054/LL-071/脚手架-as-scold）；**结构性不可测 8 条**——3 条 MCP 提示型 GOTCHA 无违规信号无分母；5 个抽样 skill 30 天 **0 次 Skill-tool 加载**（手册没被打开，GOTCHA 不可能生效；#860 的 30 天新证，检测器已用其他 skill 190+ 次命中验证有效） |
| O3 记忆文件 | 4 | **4/4 零回读**；其中 feedback_check_hypothesis_first 06-09 创建后从未被读过——记忆层实际是 write-only |

**四个结构性结论**：
1. 触发可观测性是**意外不是设计**——无任何结构化 guard-rejection 遥测；F237 `InjectionTraceStore` 已在基线但语义是 prompt injection，F254 `FreshnessAttentionEventLog` 提供了可借鉴的 Redis LIST + closed union 形态但语义/TTL 是 freshness 专用。F257 需要独立 `GuardRejectionEventLog` / `HarnessLedgerEventLog`，不复用既有 union。
2. **无分母问题**——0 触发无法区分"威慑生效"与"锅已死"（waitSourceRef 400 从未 rendered vs cat_disabled 历史触发过，语义完全不同却同样无声）
3. **重复触发无归因闭环**——hold_ball 429 反复 fire，无人知道谁/为什么/是否该升级为结构修复
4. **有效修补的主形态被数据指认**——O2/O3 文本层大面积死寂（skill 0 加载 / 记忆 4/4 零回读 / GOTCHA 无分母）vs O1 结构层拿到全部拦截实锤（429×7-8 session、403 拦真实越权、cross_post fail-closed 后"无路由掉球"零复发）。**补文本不改变行为，升结构才改变**：修补环必须显式建模为 O2→O1 升级通路（见「修补环」节 + KD-10），不能只隐含在 eval verdict 一个词里

## What

> Phase 拆分为对齐稿：opus（架构）/ codex（风险与落地）对齐 + Design Gate 后冻结。
> **2026-07-07 问题先行修正**（co-creator 方向质疑 → SC-004）：开工顺序调转为"问题先行，账本伴生"——不先做 130 口全量导入，先拿审计两个实锤走完整五环闭环，registry / 事件日志以最小形态从真实修补里长出来。原 A-E 能力面不变，承载顺序变。

### 修补环 — 链路第三环显式建模（2026-07-07 补）

启动包链路是 信号→归因→修补→验证→淘汰 五环，但原 spec 里**修补环只隐含在 eval verdict 一个词里**——co-creator 连问两次"改了对我们的问题有什么用"才暴露（SC-004）。审计数据恰好把"什么改法有用"证出来了：

- 文本锅大面积死寂：抽样 skill 30 天 **0 次加载**、记忆 feedback **4/4 零回读**、提示型 GOTCHA 无分母
- 全部拦截实锤来自代码级 guard：hold_ball 429 × 7-8 session、publish_verdict 403 拦真实越权、cross_post fail-closed 后"无路由掉球"**零复发**

结论：**模型不会因为多一篇文档变乖，只会因为结构上做不到而不犯。** 修补环因此显式建模为：**高频偏差 → 归因 → O2→O1 升级（文本提醒 → 代码强制/lint/schema 字段）→ 触发数实证下降 → 旧文本锅退役**。已完成样本：cross_post 无路由掉球 → fail-closed 后零复发；"多信号等待"散文 → `waitSourceRef` 结构字段。

**边界矩阵**（哪些自动 / 哪些 approve / 哪些社区 issue）：

| 动作 | 通道 | 理由 |
|------|------|------|
| 观测记账（触发 / anomaly / eval verdict） | 自动 | 事件驱动被动 append，零轮询干扰 |
| 段/skill 类资产迭代（启禁用 / 内容调整） | **override 层自动试验**（不动 base；随时 rollback）→ eval 稳定后带证据沉淀基线（源码：上游 PR；安装包用户：提 issue 附迭代记录） | 2026-07-08 co-creator 模型（KD-12）：未验证的改动不得直接固化为基线；git PR 直改通道对安装包用户不存在 |
| O2→O1 结构升级（新 guard / lint / schema 字段） | operator approve（看 diff） | 改执行路径 |
| 淘汰（retire + 注入源移除） | operator approve（Console） | 硬边界 |
| 上游依赖问题（Claude Code / 外部 MCP / 内置框架） | 蓝色通道：同一 upstream 锅反复触发 → 自动**起草** issue 草稿 task，operator 决定发不发 | 外发必须人批 |

**驱动模型**：事件驱动（拒绝/纠正/anomaly 发生时被动 append）+ 低频 eval（weekly 批处理做归因与判定）+ operator gate（升级与淘汰）。无高频轮询（co-creator 2026-07-07 明确要求，与既有设计一致）。

**skill 多版本**（2026-07-08 更新）：**deferred**——skill 是随包分发资产，版本/迭代机制必须考虑安装包用户侧更新链路（co-creator 约束，改动面过大）。形态共识（做的时候按这个）：**overlay**——base 随包不可变、迭代在 overlay 层、挂载走合成版本、skill 自见版本迭代史；与 #1075 PR3 `HookOverrideStore` 同模式，段先走通 skill 直接复用。加载链路问题（抽样 0/5 被加载）保留为 runway 项，不再是 Phase A 内容。

### Objective-centric 对象模型（2026-07-17 operator 模型对齐，KD-20——评估分析迭代的正确坐标系）

> 来源：operator 三轮逼近纠偏（msg `0001784256050927` + `0001784258753232`）。LI-006 实锤：此前链路是"信号可得性驱动"（恰好有 4xx 的被记账），不是"目标驱动"。本节为修正后的对象模型，Phase A-E 能力面在此坐标系下重释。**全量重设计真相源：`assets/F257/objective-driven-redesign-v1.md`（46 段盘点 + 8 objectives + typed fact/condition 外置架构 + vertical slice V1→V4；sol 落地性 review 多轮修入，版本一律以该文件 status 行为准）。**

```yaml
objective:                        # 一等公民 = 评估单位（"不是为了做而做"的锚点）
  id: obj-routing-delivery        # 第一个实例：球权路由
  statement: 球权经 @ 路由准确送达目标猫，不掉地、不假接
  metrics:                        # 定义唯一来源 = redesign T-A（§3.4）decision table——本行纯指针，
                                  # 不复述 outcome 名单/公式（v1.8 按 §0 文档架构规则清扫）
    - parse_success_rate → T-A
  segments: [传球三选一, @路由格式, a2a 工具提示]   # 段多对一挂靠——同目标共指标、一起评估
  violation_signatures: → redesign T-A（tokenization/outcome）+ §3.2 EM-1（status 与可采集性）

deviation_event:                  # union **两写入支**（唯一定义 = redesign §3.1，本行仅指针不摘要）：
  # condition_hit（exact）/ manual_observation（恒 inferred）；magic word = Event Memory 只读投影
  # 不入此账（redesign T-B）。tokenization/manual 契约 → redesign T-A / T-C。

governance_actions: 合并 | 禁用 | 修改 | 新增    # 治理单位是段（objective 是评估单位）
  # 禁用/修改：override 层现成（#34 执行器 + PR3 store）
  # 合并/新增：base manifest 级——override 做不了，走 pack 版本变更；生命线呈现为旧段 retire + 新段 v1
```

持久化现状实测（sol 落地性 review，redesign §4.2 现状表为真相源）：消息本体 TTL=0，但**路由诊断不落库、工具调用流仅 7 天 TTL、生命周期关键字段持久化时被丢弃**——"对话/tool tracing 全量可回放"不成立，指标所需 typed fact（RoutingDecisionFact 等）需新建。背离事件只打坐标锚（threadId/msgId），分析时 join 回已持久化的上下文。评估以 objective 为单位跑：同目标段一起算指标，governance 时判读单段动作（冗余检测天然成立：同 objective 三段，某段贡献为零 → 合并候选）。

### Phase A: 段 Harness 首试验品（2026-07-08 重定，v0.1 草案承载）

> 完整设计：`assets/F257/segment-harness-v0-draft.md`（draft-v0.1，codex 落地 review 4P1+6P2 已修入）。重定依据：co-creator 2026-07-08 三重定（段/SOP 是当前最大问题；skill 缓做；hold_ball 归业务自诊断）+ 基建盘点（段是四类对象中唯一信号层就绪者，见 capability-gap-analysis §9.3）。

对 prompt 段（现 50 template id，how_counted: `TEMPLATE_FILES` @ 当前分支；#1075 合入后切 46 hook manifest 口径）+ SOP 段建立**只读评估 → evidence-backed candidate → 分通道迭代 → 版本差分验证**闭环：

- **Week 1 线 A**：T1 静态体检（跨层冗余 / 段间矛盾 / 语义撞词）+ T3 缺段初筛 → 第一份 candidate 报告（数字带 how_counted）
- **Week 1 线 B**：`GuardRejectionEventLog`（`queryWindow` 接口 + ZSET 时间索引，fail-open，raw payload 不落盘）+ 2 类事件 emit（`http_rate_limit` + `route_decision_block`，一 HTTP 面一 generator 面）；correlation 两档——Week 1 `threadId+catId+timestamp window+guardId`（confidence: window），精确 bridge 为后续增强
- **Week 2+**：`eval:harness-ledger` 域（sourceRefs selector `{scope: 'prompt-segments'}`，不新增域名）weekly 产 verdict → 首批修补走 approve 通道 → 版本差分自动验证

**伴生结构（不变）**：涉事段/锅 YAML 登记（schema 同 Design Gate 对齐版：`id / layer / origin / assertion / observability(O0-O3) / denominatorKind / observabilityDeadline / nextRequiredAction / supersedes / status(active|dormant|retired)`，存 `docs/harness-feedback/ledger/{layer}/{slug}.yaml`；runtime stats 与 registry 拆分）+ 归因 task 通道（阈值默认 3/7d，per-guard 可配）。CI lint 自 day-0 生效：**新增** GOTCHA/规则/feedback 未登记 → 红；registry 数字 summary 必须可由 extractor 重跑。存量 130 口 backfill 降为**渐进任务**，不作为任何 Phase 的前置。seed-cases 机制持续（自举条款，文件已建）。

**后续 runway（从 Phase A 迁出，不删除）**：skill 观测与迭代（deferred，overlay 形态共识见「skill 多版本」节）；hold_ball 429 深归因（业务代码自诊断维度，Phase A 的 `http_rate_limit` 事件为其积累数据）；phase-boundary drift 检查卡（第二批，判据已固化于 seed-cases SC-002/003/004）。

### Phase B: 触发可观测扩面 + Anomaly 通道

把 Phase A 伴生的最小 `GuardRejectionEventLog` 扩到全量结构拒绝（4xx guard rejection）：API route 层和 MCP client-layer 本地 fail-closed 都必须 emit（例如 missing `waitSourceRef`、cross_post 无 routing credentials、publish_verdict 403、hold_ball 429）。拒绝响应携带 ledger id；事件至少含 `ledgerId / catId / threadId / invocationId / sourceTool / normalizedReason / layer / timestamp`。猫侧 anomaly 上报通道作为 F245 第 5 个 friction source adapter（引用 ledger id → stats+1），不新建第二套聚合管道。O2 层采用 hybrid：magic word / ledger id 引用 / skill-load / guard-rejection / anomaly report 等确定性信号实时埋点；transcripts 离线挖掘只用于 backfill、审计复核和 regression fixture。

### Phase C: 双 Eval 域注册（F192 Y-lite，fail-closed）

`eval:harness-ledger`：周期抽锅 → alive / dormant / unmeasurable / observability-debt / needs-denominator / retire-candidate verdict + 证据链。连续 2 个 eval 周期仍 unmeasurable 的锅必须进入三级政策：① 优先升结构补分母；② 不能升结构则 operator 显式 `intentional-keep`；③ 无明确保留理由进入 retire-candidate 队列。`eval:spec-fidelity`：检验"写了 ≠ 载了 ≠ 照做"——抽样 session 对照锅 assertion 与实际行为（直接承接 #860 / #1018 的"written ≠ loaded ≠ effective"诉求）。边界：spec-fidelity 只评估 ledger assertion 链路；SOP 类锅只链接/委托 eval:sop 的 trace/predicate 结果，不重写 SOP evaluator。

### Phase D: Console — Harness Unit 版本生命线（KD-19 重定主视图）

**主视图 = 单 unit 生命线弹窗**（operator 产品模型，msg `0001783689753064`）：`v1 → 观测事件（计数/锚点）→ eval verdict → 治理动作（diff 可看）→ v2 → …` append-only 时间线，含"证据不足累计下一窗"与"直接禁用"分支；用户可视 + 可自助回滚（override 层语义）。组件按 unit-type 无关设计——段先上，skill（overlay 形态落地后）/MCP 复用。**数据 = 既有流 read-model join（"零新增采集"限于生命线视图数据源本身；KD-20 后的 objective 指标评估面需新建 typed fact，见 redesign §4.2——两个口径勿混）**：InjectionTrace + GuardRejectionEventLog + eval verdict artifact + OverrideChangeEvent + PatchTrial；唯一待接 join = per-segment verdict（judgment schema §2）。辅视图保留原 registry 浏览（四层筛选 / status / retire 队列，operator 批准入口）。首条真实生命线已存在：`eval:harness-ledger` 2026-07-12 03:00 首轮 weekly（0 事件 → keep_observe，sol 产 opus 复核）。

**Operator AC 再确认 + 细化（2026-07-14 03:04，msg `0001783998256727`）**：段生命线需含**进行时状态标签**（如 `v1 → tracing 中`），且 tracing 态可展开“本阶段已收集哪些事件”（计数+锚点列表）——即生命线不只展示已完结环，进行中的观测窗口也要可见可下钻。这是 Phase D 的 operator 验收基准线（“至少可以在 console 的段那里预览到某个段的评估状态”）。

**Operator AC 补遗（2026-07-15 01:35 纠偏，msg `0001784079340858`）**：**eval 节点 pending 态不得为空灰占位**，必须展示进行中的评估指标活值：injectionCount（当前窗口观测数）、violationCount（窗口 join 违规数）、评估触发进度、denominatorKind、上次 verdict（无则标“从未评估”及原因）。数据零新增采集，纯 read-model 展示；已随 Phase D operations 合入。

### Phase E: 闭环验证（含自举验收）

淘汰第一批 dormant 锅并在 pack/prompt 中真实移除（证明"减"通路端到端）；自举回放：本特性开发史 seed cases 逐类回放，验证同类偏差第二次被结构拦截。

## User Journey

### Primary Journey: operator 看锅账、批淘汰
- **Scope unit**: workspace
- **Actor**: operator
- **Entry**: Console → Harness Ledger（锅账）页
- **Flow**:
  1. 打开锅账页 → 看到四层锅列表（status / observability / denominatorKind / nextRequiredAction / last-triggered / 30d 触发数）
  2. 点开一口锅 → 看到 origin 事故锚点、assertion、触发历史、eval verdict 链
  3. 进 retire 队列 → 看到 eval 判定的 dormant 候选及证据 → 批准 → status=retired，对应文本段在下个 pack 版本移除
- **Success evidence**: 截图 + ≥1 口真实锅走完 retire 全程的 diff
- **Non-goals**: 不做自动淘汰（operator-in-the-loop 硬边界）；不改写既有锅的内容（只登记/观测/淘汰）；不新建独立 friction 采集面（复用 F245）

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | session | 猫猫 | 撞到 429/403 拒绝 → 拒绝响应带 ledger id → anomaly 上报引用它 → 锅 stats+1，反复触发进入归因队列 | 一次真实拒绝的端到端 trace |

## 需求点 Checklist（启动包逐条回执）

- [ ] 锅 registry：id/layer/origin/assertion/observability/denominatorKind/observabilityDeadline/nextRequiredAction/supersedes/status → Phase A 伴生（最小），存量渐进 backfill
- [ ] 修补环显式承载：归因 task → O2→O1 结构升级（approve 通道）→ 版本差分验证 → 文本段/锅退役 → Phase A 段试验品走通（≥1 段五环），Phase C/E 制度化
- [ ] 锅 stats：trigger/applicability/last-triggered/eval refs/how_counted，与 registry 拆分 → Phase A/B
- [ ] anomaly 上报通道接 F245 → Phase B
- [ ] eval:harness-ledger 域（Y-lite，fail-closed） → Phase C
- [ ] eval:spec-fidelity 域（Y-lite，fail-closed） → Phase C
- [ ] Console 锅账页 → Phase D
- [ ] 自举条款：开发偏差 = eval 种子；验收含"拦截自己开发史偏差类型" → seed-cases（已建）+ Phase E
- [ ] 烂尾资产并入：#617（automation layer → Phase B/C 承接）、#860（skill 0 加载 → spec-fidelity 域检验对象）、#1018（subtraction/工具化 → retire 通路 + CI lint）
- [x] 锅账有效性审计（抽样 26 签名查 30 天触发率）→ 本文档 Current State + assets 报告（2026-07-06 done）

## Acceptance Criteria

<!-- AC↔Why 同源自检：每条 trace 回 Why 的"不可观测/只加不减/同类偏差复发"三诉求；非作者可复核。 -->

### Phase A（段试验品 + 伴生结构）
- [ ] AC-A0（**第一 milestone 灵魂条款**，2026-07-08 v0.1 重定）: ① T1 静态 candidate 报告产出（段口径带 `how_counted`，pre/post-#1075 两口径差异显式声明）；② `GuardRejectionEventLog` 最小可查（`queryWindow` 返回 `http_rate_limit` + `route_decision_block` 两类真实事件，带 `correlationConfidence` 标注）；③ **≥1 个段走完五环**（candidate → operator approve → 修补 → 下一 eval 周期版本差分显示对应违规下降 or 显式证伪）。走不通 = 设计证伪停下重议。账本覆盖率不是本 milestone 判据
- [ ] AC-A1: 涉事段与修补过程新增锅完成 YAML 登记（id/layer/origin/assertion/observability/denominatorKind/status 完整）；CI lint 绿（**新增**锅未登记 → 红可复现）；存量 backfill 为渐进任务不阻塞
- [ ] AC-A2: seed-cases 文件自 day-0 持续记录本特性开发偏差，每条含偏差类型 + 期望拦截层（可复核：文件 + 条目日期）
- [ ] AC-A3: inventory summary 由 extractor 可复算生成，所有审计数字带 `how_counted`（命令/口径/时间戳）；给定缺 `how_counted` 的数字 claim，lint 红可复现

### Phase B（可观测 + 通道）
- [ ] AC-B1: API route 层与 MCP client-layer 的结构拒绝事件都结构化落盘且可按 ledger id 查询（可复核：触发一次 429 + 一次 MCP 本地 routing reject → 查询返回两类事件）
- [ ] AC-B2: anomaly 上报出现在 F245 friction rollup 且回写锅 stats（可复核：rollup 记录 + stats 变更，stats 带 `how_counted`）

### Phase C（双 Eval 域）
- [ ] AC-C1: 两域完成 Y-lite 注册且 fail-closed（越权 publish 被 403，可复现）+ 首轮 verdict 产出
- [ ] AC-C2: eval:harness-ledger 对抽样锅给出 alive/dormant/unmeasurable/observability-debt/needs-denominator/retire-candidate 判定及证据链；连续 2 个 eval 周期 unmeasurable 触发三级政策；eval:spec-fidelity 对 ≥1 个真实 session 产出"ledger assertion vs 行为"diff 报告，SOP 类锅委托 eval:sop 证据

### Phase D（Console）
- [ ] AC-D1: 锅账页展示 registry + stats（截图，含四层筛选）
- [ ] AC-D2: retire 队列 operator 批准流程可走通（截图/录屏）

### Phase E（闭环验证）
- [ ] AC-E1: ≥1 口锅经证据淘汰且对应文本从 pack/prompt/skill 注入源真实移除；双向 lint 证明 retired 不再注入、active runtime 文本可反查 ledger id（可复核：diff + 移除后 eval 无回归）
- [ ] AC-E2: 自举回放——本特性开发史 seed cases 每类偏差有对应拦截机制且回放中触发（可复核：回放报告，灵魂条款）

## 2026-07-19 实战暴露修复清单（V1 上线首日，全部带活体事故证据）

> 来源：operator 实测 Console + 三笔真实 deviation 入账（dev-628ea4d1 / dev-7a882ba0 / dev-af6d4e28）+ 投错线程调查。按依赖排序，1/5 最小先做。

1. **昵称唯一性与模糊 @ fail-closed**（归属 F167/路由域，坐标记录于此）：`cat-template.json` 把 nickname 定义在 roleTemplate（家族）层——opus 实例 nickname="宪宪"(L188) + patterns 含 @宪宪(L194)，codex nickname="砚砚"(L357/363) 与 sol/terra 三猫共用 → @昵称确定性投错猫 + persona 注入错身份（dev-628ea4d1 根因坐标）。修复：nickname per-cat 唯一 + config 加载时 mentionPatterns 冲突 fail-closed + 多命中拒绝路由要求显式 handle。**状态：✅ PR #44（`10dacad2b`）已合入。**
2. **L 系列段观测粒度**：native-L0 路径 collectTrace 只记 session-init-pack-only 聚合（trace-collector.ts else-if 分支），不做 per-segment 拆解 → L 系列 Console 全体"无数据"。修复：L0 编译器持有确定段清单，直录 trace（结构化直录，不解析文本）。
3. **objective 目录运行时发现机制**：report_harness_signal 的 objectiveId 为自由 string，无 list 工具/schema 枚举/harness 注入清单——三次上报三次考古文档（含一次归因困难降权 0.6）。修复：objective registry 只读发现接口 + 工具 description 同步。
4. **签名 lint O2→O1**：消息末行签名 [昵称/模型🐾] 是完美可 lint 断言，当前零结构覆盖（dev-7a882ba0：靠 operator 人工发现）。**两阶段**（2026-07-20 owner vision-guardian 校准，AC 完成 ≠ feature 完成）：**① 检测层**（切片 1，PR 待提）——复用 `isCatSignatureLine` 结构化检测 + post-seam 记 `message.extra.signatureLint`（message 级可观测、denominator-bearing、observe-only 非阻断）；**② 账本闭环**（deferred 到切片 2 / #3 后）——检测到 miss 自动 emit deviation 归因 `obj-identity-integrity` 进 harness ledger，把 dev-7a882ba0 的**手动** `report_harness_signal` 上报**自动化**。闭环 deferred 原因：harness ledger 读 DeviationEventLog/GuardRejectionEventLog/eval verdict，**不扫 message.extra**；正确 deviation 需 registered objective（否则重蹈 #3 修的 free-string 考古）+ segment/condition 归因基建（属 #2/#3 数据根）。**`extra`-only ≠ #4 完成**。
5. **运行实例写保护**：pre-commit hook 白名单（仅 §14 共享状态文档路径），把 LI-004 从认知纪律降为结构强制（dev-af6d4e28：平行实例任务错位 merge 污染运行基线，V1 一度整体不在运行树）。**状态：✅ PR #44（`10dacad2b`）已合入。**
6. **Console 收尾包**（已固化验收判据于 V2 thread）：activeStage/actionableStage 分离、eval 窗口标注（18 vs 0 类矛盾）、判定词解释、tracing 锚点回放剧场式下钻（历史版本渲染防伪造现场）、变量段编辑呈现、启禁用矩阵测试。

## Eval / Tracking Contract（F192）

1. **Primary Users + Activation Signal**：全体猫（锅触发/anomaly 上报方）+ operator（retire 决策方）。Activation：guard rejection 结构化事件、anomaly 上报、eval 域周期运行、Console 页访问。
2. **Friction Metric**：① 同类偏差 30 天复发率（第二次未被结构拦截的比例，目标 → 0）；② dormant/retire-candidate 锅占比 + retire 吞吐（治"只加不减"）；③ 重复触发递减率（同一锅对同一猫的 429 类重复触发应随归因闭环下降）；④ observability-debt 老化数量（超过 observabilityDeadline 未处理 = 失败信号）。
3. **Regression Fixture**：① seed-cases 回放集（本特性开发史，持续增长）；② #1080 A2A claim 无 anchor 案例；③ #1082 类 superseded 假设案例（锅前提失效 → status 变更）；④ hold_ball 429 重复触发序列（归因闭环 fixture）；⑤ SC-002 unqualified-count（数字 claim 缺 how_counted → lint 拦截）；⑥ SC-003 thread/spec drift（thread 内决策未写回 spec → closure lint 拦截）。
4. **Sunset Signal**：连续 2 个 eval 周期满足（a）新增锅 100% 经 registry 登记（lint 零逃逸）、（b）同类偏差第二次拦截率达标、（c）operator 零手动策展 → ledger 维护降为例行；若 eval:harness-ledger 域自身连续 4 周期无 actionable verdict → 域降频或并入 eval:friction。

## Harness 三层计划（ADR-031 软+硬+eval）

| 层 | 本 feat 承载 |
|----|-------------|
| Soft | L0/skill 触发句："撞到 4xx 锅拦截 → anomaly 上报引用 ledger id"；锅账进猫认知路径（capability-wakeup index） |
| Hard | CI lint（新锅未登记 → 红；审计数字缺 how_counted → 红；retired/active 双向映射不一致 → 红）；拒绝响应携带 ledger id；guard rejection 结构化落盘（API + MCP 双入口，不靠自觉） |
| Eval | eval:harness-ledger + eval:spec-fidelity 双域 + 上节 4 项 contract |

## Dependencies

- **Evolved from**: F192（harness-eval control plane——把"域级评估"下沉到"单锅生命周期"）
- **Code substrate**: 独立 `GuardRejectionEventLog` / `HarnessLedgerEventLog`（Phase B 新建）。借鉴 F237 `InjectionTraceStore` 的 summary/detail 保留策略和 F254 `FreshnessAttentionEventLog` 的 Redis LIST + closed union 形态，但不复用它们的事件 union。
- **#1075 已合入**（2026-07-09，main `ebffcd8e5`）：46 hook.yaml 就位（段口径切换）；HookPipeline/Registry 为基础层。合入后重验：逐 hook TraceEvent 仍被 route 层 drain、持久化走 v0 路径——**逐段粒度需「trace 持久化桥」工作项**（归属随 PR3 对齐，KD-13）。观测评估侧（Week 1）不依赖此项；代码开工前 rebase 到 ebffcd8e5+ 基线。
- **Related**: F245（anomaly/friction 聚合复用）、F254（freshness event log pattern）、F237（prompt injection trace pattern）、F177（四心智护栏的前身）、F233（observability 姊妹篇）、F153（观测基础设施）、F244（tips 生效追踪同类问题）、F218（provenance 反射）；issues #617 / #860 / #1018（烂尾并入）、#1080 / #1082（调查线动因）

## Risk

| 风险 | 缓解 |
|------|------|
| 锅账变成第 131 口锅（观测本身增熵） | registry 是数据不是 prompt 文本，不进上下文注入；元审美自检：这是坐标变换（散文锅 → 结构化资产），不是堆层 |
| MCP client-layer reject 漏记 | AC-B1 明确 API route + MCP client-layer 双入口埋点；本地 fail-closed 也必须 emit guard event |
| O2 提示层本质不可测，eval 误判 dormant | observability + denominatorKind 进 schema；无分母只能判 unmeasurable/needs-denominator，不能判 dormant；连续 2 个 eval 周期未处理进入三级政策 |
| unmeasurable 成为永久豁免 | `observabilityDeadline` + `nextRequiredAction` 进 schema；verdict 层产 observability-debt / needs-denominator / retire-candidate；operator `intentional-keep` 是显式例外而非默认 |
| inventory 数字再次不可复算 | 所有审计数字要求 `how_counted`；Phase A extractor 生成 summary；缺口进入 SC-002 fixture |
| retire 只在 UI 发生，runtime 文本未移除 | 双向 lint：retired 不得仍注入；active runtime 文本必须反查 ledger id |
| transcripts 挖掘的体量/隐私 | 只存聚合 stats + anchor 引用，不复制 raw payload（harness-feedback 同款规则） |
| F 号/文档在特性分支上直到 PR（占号可见性） | 立项即 cross-post 主 thread 声明 F257 占号；ROADMAP 行随 PR 上行 |
| 双 eval 域与既有 eval:sop / eval:friction 边界重叠 | OQ-4 在 Design Gate 前对齐，宁可并域不可撞域 |
| 问题先行导致存量账本长期残缺、lint 覆盖不全 | lint 对**新增**锅 day-0 强制（增量零逃逸）；存量随修补/eval 触达渐进补录；Sunset Signal (a) 只考核新增锅登记率 |
| "过度设计"类偏差无机器可判定定义，结构拦截天然拦不到 100% | 只拦可测投影：超出 plan 声明的 diff、跳 SOP 步骤（eval:sop）、同类第二次必须被结构拦截（AC-E2）；不承诺全拦，承诺二犯拦截 |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | ledger 存储形态：YAML in docs/ vs JSONL in data/ vs SQLite（Console 读取 + CI lint + human review 三方消费如何平衡） | ✅ YAML registry + runtime stats split |
| OQ-2 | 锅 id 命名规范 + supersedes 语义（替代/演化/合并三种关系是否分开建模） | ✅ `{layer}/{slug}` + single `supersedes: []` |
| OQ-3 | O2 层代理信号采集边界：transcripts 离线挖掘 vs session hook 实时埋点（成本/隐私/覆盖三角） | ✅ hybrid：实时确定性信号 + transcript backfill/fixture |
| OQ-4 | eval:spec-fidelity 与既有 eval:sop 域的 scope 边界（sop 查"流程步骤合规"，spec-fidelity 查"锅断言 vs 行为"？还是该并域） | ✅ 分域：spec-fidelity 评 ledger assertion 链路，SOP 类委托 eval:sop |
| OQ-5 | 启动包 inventory 数字（86/51/21）与实测（30/48/9）口径差——调查线的推导方法需回查 | ✅ 定性为 `unqualified-count`，所有数字需 `how_counted` |
| OQ-6 | KD-1 文档先行分支策略（origin/main 现基线切出，#1075 合入后 rebase）是否认可 | ✅ 文档先行放行；#1075 不阻塞 Phase B，代码前 rebase 最新基线 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 文档先行：特性分支自 origin/main@6868041 切出；代码 Phase 开工前 rebase 到最新基线，但不等 #1075 | 文档与 F237 代码零重叠；#1075 是 F237 hook pipeline migration，不是 F257 guard event store；审计+立项不应被外部 merge 排队阻塞 | 2026-07-06 |
| KD-2 | observability 分级 O0(导入未分类)/O1(结构强制)/O2(提示文本)/O3(记忆文件) + denominatorKind 进 ledger schema | 审计实证三层观测能力天差地别；单一 stats 模型会把"不可测"误读成"dormant"导致错杀 | 2026-07-06 |
| KD-3 | Registry 定义层用 YAML，运行时 stats 拆到 Redis/SQLite/eval artifacts | 定义变更要 Git review；触发计数不能刷 Git；Console 读时 join | 2026-07-06 |
| KD-4 | `status` 保持三态 `active/dormant/retired`，不引入 `probation` | 待决语义由 eval verdict / action queue 承载；少一套状态转换矩阵 | 2026-07-06 |
| KD-5 | unmeasurable 压力进 `observabilityDeadline` / `nextRequiredAction` + verdict/action queue | 防错杀同时防永久豁免；连续 2 eval 周期未处理走三级政策 | 2026-07-06 |
| KD-6 | 所有审计/registry summary 数字必须带 `how_counted` | SC-002 证明无口径数字会污染决策；数字 claim 必须可复算 | 2026-07-06 |
| KD-7 | `GuardRejectionEventLog` 独立新建，借 F237/F254 形态不复用类型 | F237/F254 语义和 retention 不匹配；复用 union 会污染边界 | 2026-07-06 |
| KD-8 | `eval:spec-fidelity` 与 `eval:sop` 分域 | 一个评 ledger assertion 链路，一个评 SOP trace/predicate 流程合规；SOP 类锅委托而不重写 | 2026-07-06 |
| KD-9 | 修补环显式建模：有效修补主形态 = O2→O1 结构升级，文本内容迭代自动、结构升级 approve、上游问题走 issue 草稿蓝色通道 | 审计实证文本层死寂（0 加载/零回读）vs 结构层全部拦截实锤；修补只藏在 verdict 一个词里导致 co-creator 看不到价值链（SC-004） | 2026-07-07 |
| KD-10 | 开工顺序调转"问题先行，账本伴生"：Phase A = 双实锤（skill 零加载 + hold_ball 429）修补闭环，全量 backfill 降为渐进任务；第一 milestone 验收 = 真问题被修 + 触发数实证下降（AC-A0），账本覆盖率降为次要指标 | 先建两周全量 registry 修不了任何真问题（co-creator 质疑成立）；最小 registry/事件日志从真实修补里长出来，避免账本变成第 131 口锅 | 2026-07-07 |
| KD-11 | Phase A 对象重定为 prompt 段 + SOP（v0.1 草案承载，KD-10 的"问题先行"原则不变、对象变）：correlation 两档（window→exact）；GuardRejectionEventLog 用 queryWindow+ZSET 时间索引（非 F254 per-invocation LIST）；emit 按六类 union 分型，Week 1 只上 2 类；eval 复用 harness-ledger 域 + scope selector 不新增域名 | co-creator 三重定（skill 缓做-安装包用户约束 / hold_ball 归业务自诊断 / 段与 SOP 是当前最大问题）+ 盘点证实段唯一信号就绪 + codex 落地 review 4P1（turnId 是 pre-invocation random UUID、per-invocation LIST 不可窗口发现、emit 分属两种工程面等代码事实） | 2026-07-08 |
| KD-12 | 迭代通道 override-first（v0.2）：段/skill 类改动一律先在 override 层试验（启禁用/调整，不动 base，随时 rollback）→ eval 相对稳定后带迭代记录与证据沉淀基线（源码上游 PR / 安装包用户提 issue）；tracing 与 eval 永久保留；观测评估不依赖 #1075，**迭代环以 #1075+PR3 HookOverrideStore 为前提**（"要基于 1075"的准确语义） | co-creator 否决 git PR 直改通道：未验证改动不得固化为基线、可能只需 rollback/启禁用、安装包用户无 PR 通道；带证据的沉淀才有上游价值 | 2026-07-08 |
| KD-13 | PR3（HookOverrideStore）归属：F237 线出实现，F257 驱动优先级 + 消费侧契约（enable/disable/setContentOverride/getActiveVersion/rollback + **listOverrides 全量枚举** + **override 变更事件流**（变更驱动触发的依赖）+ safetyTier 门控，disableable=false 豁免清单进 ledger 登记）；「逐 hook trace 持久化桥」为独立工作项随 PR3 对齐归属（合入后重验：TraceEvent 仍被 drain） | opus 层权分离论证（F257 自建 = scope leak）+ Fable 消费侧需求补充；#1075 已合入使 PR3 可直接基于 main 开发 | 2026-07-09 |
| KD-14 | **开工组织**（co-creator 批准 Week 1 双线）：thread 不新开——F237 既有线做段应用实现（PR3+tracing 桥）、F257 工作线做方法论库、主 thread 为治理/审批面；角色 = Fable 监工（设计真相源 + judgment schema v1 定义 + 验收 gate 执行 + T1 体检报告 + 集成分支协调 + operator 接口）/ **opus 双线实现**（PR3 + override 事件 + trace 桥 + GuardRejectionEventLog + emit×2 + eval 域注册 + 判定引擎 + 审批执行器）/ **codex 全线 review**（两线 PR + schema 契约 + 集成 merge gate）；交付边界端到端无过渡态（dogfood 前全链路代码化）；两 P1 前置生效（rebase `ebffcd8e5+` / Week 1 末 schema v1 freeze） | co-creator 2026-07-09 08:19 拍板并建议分工；既有双线各持完整领域上下文，新开 thread 割裂；Fable 监工位与设计收敛角色一致且 context 消耗史支持轻载位 | 2026-07-09 |
| KD-15 | **PR3 交付边界与流程惯例**（PR mindfn#22 → develop_base 已合入）：① runtime override 对 per-turn hooks（D 段，含全部首批评估对象）+ 非 native session 路径生效；**native S/L 段 override 接入 = 独立 runway 项**（L0 编译链 + cache invalidation，排 trace 桥之后）② version switching / governanceTier enforcement / route 层 authenticated authority / auto-eval writeback = F237 侧 defer 项，**scope 变化须批准锚点，不以文案 defer 替代**（sol/terra 对齐）③ 全猫共用 GitHub 账号 → formal review 不可用于自家 PR，**fork merge-gate 以 in-thread review + PR comment 留痕为准** | codex GitHub review P2 + Fable 监工收窄决策 + sol round-2（manifest 收紧穿透/audit TTL=0/source 自报）与 terra exact-head review 的 scope 分类；本条曾被 PR body 提前引用而未落盘，terra 审出——SC-003 型偏差再犯实录 | 2026-07-10 |
| KD-16 | **PR3 验收边界收口**（原并行铸号 KD-15，与上行撞号后重编——双 Fable 平行落账实录，内容互补：KD-15=交付边界+流程惯例 / KD-16=契约对账+defer 锚点）（Fable 监工批准，行使 KD-14 验收 gate 职权）：PR3 交付集 = KD-13 消费侧契约全集——2026-07-10 逐项核验 ✓（enable/disable/setContentOverride/clearContentOverride/rollback/listOverrides/loadSnapshot + OverrideChangeEvent 事件流 + safetyTier/disableable/limited-edit 门控 + Registry 层 getActiveVersion；59/59 tests @ `4aa3a9a71` = 41 store + 10 pipeline + 8 registry）。F237 doc PR2 时代前瞻句（AC-P2-18 尾项 + Upstream PR3 行）所列三项**显式 defer、不删除**：① version-switch 写路径 + governanceTier 门控——v1 无任意版本写路径（仅 rollback），随多版本 base 管理进 runway（同 skill 多版本 overlay 共识）；② auth model——PR3 纯 store 层无 HTTP 面，鉴权随审批执行器/console 路由落地（KD-14 序列）；③ auto-eval writeback = AC-B2（Phase B；KD-12「迭代环以 PR3 为前提」）。Native S/L 段 override 接入为独立 runway 项（L0 编译链 + cache invalidation；批准锚点 msg `0001783647563293`） | KD-13 契约是 PR3 唯一验收基准（F257 驱动契约）；F237 旧前瞻句未随 KD-12/13 重定同步 = SC-003 型 thread↔spec drift 的又一活体，本行修正落账；三项全部留 runway 不静默消失；sol 拓扑裁决「operator/Fable 已批准决策可为锚点」（msg `0001783656003097`） | 2026-07-10 |
| KD-17 | **eval 数据到达模型：snapshot-first（预注入路径）**（terra PR#24 P1#3 修正，Fable 裁决）：eval cat 判定前必须收到归一化 snapshot——trigger 先经受控 provider（strict 读语义，接 queryWindowStrict）产 snapshot（byGuard counts + kinds + window + 抽样 anchors，无 raw payload）注入 eval invocation；publish generator **复用同一 stored snapshot**（single-read，按 runId 键，缺失 = fail-closed 500），禁止 decision 与 artifact 两套数据源漂移。只读 query tool = v2 增强，不进本轮 | 三依据：与 eval:qc/friction「rollup 先行」惯例一致；provenance 单源（judgment schema v1 §2 producedBy.runId 链）；最小新表面（不开新 MCP 工具）。terra 实证成立：全库 grep 无数据通路到 eval cat、publish 前 packet 已定 = 证据倒置。**异常路径对称性补强**（terra round-2 P1，2026-07-10）：snapshot 不可用时——scheduled 记 domain-local SKIPPED 诊断后 return（fail-open 仅限任务 runner 层，防 cron 崩溃/重试风暴）；manual 返回 503；**两路径均不得 invoke eval cat**（invocation 层 fail-closed）——无证据不唤猫，Redis outage 恰是盲判最危险时刻 | 2026-07-10 |
| KD-18 | **eval:harness-ledger weekly 自动评估启用**（operator 批准锚点：msg `0001783676749911` "开"，2026-07-10 09:45 UTC）：启用范围 = weekly 只读分析自动产判定报告进 Eval Hub；**激活开关 ②（修补/淘汰执行）与 ③（上游 PR）不变，仍逐项等 operator**。时序备注：opus 按 terra round-3 repair 于 09:43 先行 flip（`abba4bf75`），lang 锚点 09:45 到达——2 分钟倒挂，结果合法化但流程记为"激活开关应先锚后 flip"的边界样本 | terra round-3 P1（PR 承诺 weekly live vs enabled:false 矛盾）+ Fable 拆两路裁决（repair 与激活门分离）+ operator 3 开关承诺（今早"为什么要合入"对话）兑现第 ① 个 | 2026-07-10 |
| KD-19 | **Phase D 主视图重定为「harness unit 版本生命线」**（operator 产品模型，msg `0001783689753064`）：以单个 unit（段，后续 skill/MCP 复用同组件）为中心的 append-only 生命线弹窗——`v1 → 观测事件（计数/锚点）→ eval verdict（指标+判定）→ 治理动作（diff 可看）→ v2 → …`，含"评估不足以迭代→累计下一窗"与"直接禁用"分支；用户可视 + 可自助回滚到任意版本（override 层语义，安全）。**数据契约：零新增采集**【范围注（2026-07-17）：此契约限于生命线视图数据源，当日成立；KD-20 objective 指标评估面经 sol 落地性 review 证伪"全局零新增"——RoutingDecisionFact 等 typed fact 必需新建，真相源 redesign §4.2】——生命线 = 既有流的 read-model join：InjectionTrace(版本/fired) + GuardRejectionEventLog(事件) + eval verdict artifact(评估) + OverrideChangeEvent(治理/谁/为何) + PatchTrial(diff/结论)。唯一待接的 join：per-segment verdict（judgment schema §2 SegmentJudgment，generator 现为域级）| operator 完整产品心智模型自发与五环/schema 同构（v→观测→评估→治理→v' 就是五环的 UI 投影）——验证设计坐标系正确；unit-centric 优于原 registry-centric 浏览页 | 2026-07-10 |
| KD-20 | **对象模型重定 objective-centric**（operator 2026-07-17 03:25 模型输入）：objective 为一等公民评估单位（statement + metrics），段多对一挂靠——同 objective 段共用指标一起评估；governance 动作作用于段（合并/禁用/修改/新增；禁用/修改 override 级现成、合并/新增 base 级走 pack 版本）；背离事件三源统一 kind（operator_correction / peer_observation / self_report）挂 objective + unit 归属 + 对话锚【本行初始 schema 已 supersede，字段不在此复述——**当前 schema 唯一真相 → redesign §3.1**】；tracing 通用化 + condition 外置（4 观察面 / 声明式谓词 registry / 一个求值器实时+离线双模式），既有两处硬编码 emit 承认 hotfix 迁移后删除；切片顺序 2→1→3→4（语义信号不可回放先堵，结构信号可离线回放后建）【判据当日即被 sol 落地性 review 证伪——"结构可回放"仅对已持久化面成立，路由诊断/guard 命中彼时也在丢；现行顺序 = vertical slice V1→V4，真相源 redesign §6】；零兼容包袱授权（客户端应用） | operator 连环纠偏落点："不是为了做而做"——LI-006 后仍从最易接线处开工是信号可得性思维残留；评估单位若是段则"合并"无自然语义，objective 层才能承载"A/B/C 段同目标共指标"；完整定稿 `assets/F257/objective-driven-redesign-v1.md` | 2026-07-17 |
| KD-21 | **raw-first Unit 评估证据契约**：非结构化 `TraceEpisode` 是共享 canonical fact pool；同一 Objective 的多个 attached segments 组成一个 Unit，各 owner+Objective Unit 分别按去重结构化反例、raw volume、距上次完成评估（首次从首条 eligible trace 起算）三路 `anyOf` 触发。结构化反例是高权重检索锚点而非 evidence gate；触发时冻结 raw corpus，eval cat 先看锚点再按 cursor 渐进检索其余 tracing，服务端以 immutable identity+digest receipt 记录实际证据 provenance，且不复制 message body。Semantic Sweep 只产稀疏提示，不能替代 Unit evaluator。 | co-creator 2026-08-20 对“annotation 才能归属评估证据”的纠正：语义指标无法靠预先结构化 admission；正确路径是在独立 Unit 评估节点从共享 raw pool 冻结周期证据，以反例高权重起步并让 eval agent 渐进检索。当前契约真相源：`feature-specs/2026-08-04-f257-objective-eval-redesign.md`。 | 2026-08-21 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-06 | 立项（首棒 Fable：四层审计 + spec 初稿；来源 thread_mr6kh7kdoac6852d 调查线启动包） |
| 2026-07-06 | Design Gate 三猫对齐：opus 架构/存储/schema，codex O2/O4/风险，Fable owner 收束 |
| 2026-07-07 | co-creator 指示继续，Design Gate 结论写回 spec；记录 SC-003 thread/spec drift |
| 2026-07-07 | Session #2 补充 in_context_observability 决策字段 + 更新 harness-eval.md cell（Design Gate 完整收束） |
| 2026-07-07 | co-creator 方向质疑（"改了好像也没用"）→ 修补环显式建模（KD-9）+ 开工顺序调转"问题先行，账本伴生"（KD-10）+ AC-A0 换判据；记录 SC-004 |
| 2026-07-08 | co-creator 七问 → 能力盘点 gap 分析（`86ac0ab41`，记录 SC-005）；三重定 + 共创邀请 → 四猫体感征集（A1 公理三样本，`8b593dfd5`）；v0 草案（`0bf619d3c`）→ codex 落地 review（4P1+6P2，放行方向）→ v0.1 修入 + spec Phase A 对齐（KD-11）；否 git PR 直改 → v0.2 override-first（KD-12）；五问 gate → v0.3 |
| 2026-07-09 | **#1075 合入 main（`ebffcd8e5`）**：46 hook.yaml 就位、段口径切换；重验证实逐段 TraceEvent 仍被 drain → 「trace 持久化桥」独立工作项；PR3 归属共识落账（KD-13） |
| 2026-07-13 | **KD-14 审批执行器第一腿合入 develop_base（PR #34 `273126849`）**：operator-gated override routes（GET lifeline 读面 KD-19 + POST enable/disable/rollback，reason 必填进审计）；terra R1 P2×2（非字符串 body→500 / unknown-hook rollback 污染永久审计流）→ fail-closed 修复（store 边界 resolveManifest；audit 同型 clearContentOverride 一并；orphan override 显式 fail-closed 留迁移通道）→ FINAL PASS @ `2c58a37a9`；fork 等价 gate 18726 tests / 18622 pass，69 fail 逐一证明 pre-existing（21 文件零 import + capabilities-route 裸基线同构对照）；下一步 D21 隔离集成验收（opus 接棒） |
| 2026-07-13 | **D21 审批执行链隔离集成验收 PASS（opus）**：六项逐检 ✓（三门禁顺序 / 三轴 gate 权威 404-409 / 审计 TTL=0 / fail-closed 契约 / store 单实例接线 / orphan fail-closed 取舍确认）@ `cat-cafe-develop-base` `273126849`，62/62 green——**KD-14 审批执行器第一腿全链闭环**（实现 Fable → review terra → merge #34 → 验收 opus）；序列剩余：trace 持久化桥、判定引擎（opus 双线实现位） |
| 2026-07-14 | **trace 桥 + 判定引擎合入 develop_base（PR #35 `709e01336`）**：route-parallel 逐段 trace 持久化、`queryWindow`、确定性 SegmentJudgment 及 manual/daily trigger 接线完成；terra review 拦下“定义了但未接线”、三键关联、窗口边界和 evalCat provenance，修复后 FINAL PASS @ `11dfeb9a9`。 |
| 2026-07-14 | **Phase D lifecycle chain 合入 develop_base（merge `d0fb34e12`，review 源 `663fce0c7` R10 PASS）**：epochVersion 真相源贯穿 Store→Registry→Engine→Trace→Chain，per-version eval、active epoch、版本化 judgment 与原子计数闭环。 |
| 2026-07-14 | **KD-19 隔离旅程验收 7 项 PASS**（`/tmp/f257-phase-d-acceptance` @ `d0fb34e12`，Redis 6398 空库）：发现 AF-1 冷启动 bootstrap P1、AF-5 governance 归因 P2、AF-6 v1 activate 产品 P3。 |
| 2026-07-14 | **AF 修复合入 + 隔离复验双绿**（merge `d0957b11f`）：AF-1 冷启动零预热 create 成功；AF-5 operator disable 正确归为 `governance-reject`；AF-6 由前端 v1 rollback 映射承接。 |
| 2026-07-15 | **Phase D operations 合入 develop_base（merge `07696d7b2`，reviewed head `2b80199fe`）**：创建/激活/启禁用/回滚操作面、tracing 锚点下钻、eval pending 活指标、per-epoch guard 归因及共享类型契约落地。 |
| 2026-07-15 | **LI-001 hold-ball action liveness 合入 develop_base（PR #38 `0cdd17f68`）**：`hold_ball` wake invocation 显式携带 `action-or-routing-exit` completion requirement，direct/queued 两路同契约；terra 对 exact HEAD `4154e316` APPROVE（0 P1/P2/P3），fresh API build + 351/351 定向回归 + Biome 4502 files。后续 `29533ccbb` 禁用 hold_ball 429 的秒级自动重试，`729509e35` 修正环境隔离与逐 endpoint 测试断言。 |
| 2026-07-16 | **LI-004 仓库收敛复核**：`cat-cafe-develop-base` @ `729509e35` 与 `origin/develop_base` 一致、worktree 干净；这只证明 Git 真相源已收敛，运行进程的 Console 现场验收仍须单独留证。 |
| 2026-07-16 | **段生命线 capability tip 合入 develop_base（`46fe3aca5`）**：新增 `feature-f257-segment-lifeline`，从 Console「协作与规则」→「生命周期与注入」引导 operator/developer 进入版本生命线；opus 对 exact HEAD APPROVE（0 P1/P2/P3）。 |
| 2026-07-17 | **LI-005 改道本地验证线 + 合入 develop_base（merge `7da9da9a0`）**：上游 PR #1162 按 operator 指示 close（流程偏差自认：跳过本地运行实例验证直提上游；maintainer intake 表态"方向欢迎"留待后续）。11 个 LI-005 commit 自 `591a9dc9a` rebase 到 `fecbffeb2`（剔除未 intake 的上游尾部，Brand Guard 20 文件零违规）；与 LI-001 的 `guardRemediated` 改名冲突按 develop_base 命名收敛；组合定向回归 **464/464**（ack-liveness + replyTo + ball-custody + bg-transcript + ndjson + LI-001 全套）。**部署断层实锤（Fable 盘点）**：运行进程（API 31122 / next-server 31372）自 2026-07-15 09:17 未重启，`.next` BUILD_ID 同刻——07-15 14:10 后合入的操作面①②③、LI-001、LI-005 全部未上线；operator 所见"eval 无指标/tracing 无详情"即旧 UI。待 operator 重启 → Console 现场验收关 Phase D。 |
| 2026-07-17 | **LI-006 坐标系纠偏 + KD-20 objective-centric 全量重设计**：operator 三轮逼近（"只对 holdball 有效"→"你在忽悠我"→"对目标的实际提升基本是 0"）——查证四实锤成立（ledger 零实例 / routing_warnings 死于一次性广播 / 无猫自报工具 / 引擎把"测不到违规"误判 alive）；汇报偏差同案入账（把 queued/planned 说成体系能力）；operator 给出完整目标驱动模型（objective 一等公民 + 段两类分类学 + 治理四动作 + 背离三源 + tracing 通用化 condition 外置）→ 46 段全量盘点归 8 objectives，重设计定稿 `objective-driven-redesign-v1.md`（v1.1），切片 2→1→3→4，**确认后才实施** |
| 2026-07-17 | **重设计九轮落地性 review 收口（sol R1→R9，operator 点名审"真的能采集起来"）**：R1-R8 累计 27 P1 + 9 P2 全收零 pushback，两大根因结构性修法（多处复述→规范位唯四全文引用化；exact 声称先于代码验证→规范表从 parser/写路径 derive 带锚点）；V1 按 reviewer Tradeoff 收窄至 2 个可验真指标（@解析成功率 per parserMode / magic word 词面出现数 raw 口径），void_ack 等 7 项如实 blocked-on-fact；新增 RoutingAttemptDraft 唯一性契约 / 投影覆盖率契约 / detector reconcile 契约 / ownerUserId 单一 scope / Lua 原子去重 / producer health 时间桶。**R9 APPROVE（0 P1/P2/P3）@ 设计版 v1.8.2 FINAL（feature `8a337aec9`）**。后续：operator 三轮凌晨输入（分层定位/LLM-代码分工/插拔通用化）→ v2.x 增量系列 + operator 将开工 gate 委托 Fable+sol 共同判定（msg `0001784273529722`）→ sol 增量 review 循环进行中——**当前状态一律以 redesign status 行为唯一真相，本表不逐轮更新** |
| 2026-07-20 | **当日事故修复切片 A 合入 develop_base（PR #44，merge `10dacad2b`，reviewed head `cac2aa5a9`）**：昵称/mentionPatterns 唯一性与模糊 @ fail-closed、五项精确运行实例写保护、routing-mismatch 四路径零副作用矩阵落地；Fable 架构审核 + sol R1→R5 code review 收敛，正确 registry preload 249/249。 |
| 2026-07-27 | **Console 判据④ true-scene replay 合入 develop_base（PR #65，merge `e33d4e7b`，reviewed head `c4400641`）**：segment lifeline 确定性回放、原子 Lua 删除生命周期、completeness gap 贯穿、v0 null version 与 native-L0 null vars 合法化；sol R1→R7 review 收敛。 |
| 2026-07-28 | **Console 判据⑤ 变量段呈现合入 develop_base（PR #66，merge `53082a4f`，reviewed head `36ab2dcf`）**：TEMPLATE_FILES runtime 占位符与 hook.yaml canonical variables parity、source/preview/replay 三界分离、restore-backup placeholder guard；sol R1→R4 review 收敛。 |
| 2026-07-29 | **Console 判据⑥ 启禁用矩阵合入 develop_base（PR #71，merge `e3b5b1cb`，reviewed head `7e6017a3`）**：localOverlay / runtimeOverride 双平面、manifest safetyTier 服务端门控、VersionActions 组件；sol R1→R2 review 收敛。post-merge acceptance：shared/API/web build 全绿，segment-enablement 12/12、enablement-matrix 10/10、VersionActions 6/6 通过。 |
| 2026-08-05 | **判据④ replay primary surface 精简合入 develop_base（PR #85，merge `5376a9ab`，reviewed head `5ae2c96bc`）**：按 operator 现场反馈只保留来源 Thread / Message anchor 与周边上下文，Thread 新窗口跳转；模板、变量、现场内容及 window-correlated guard 从主界面移除但 durable replay 数据契约不变。Opus 跨 provider review APPROVE（0 P1/P2，1 P3 不阻塞），fork repository gate 全绿。 |

## In-context Observability（明厨亮灶决策）

```yaml
in_context_observability:
  primary_surface: |
    L1（现场）：guard rejection 时工具响应携带 ledger id + 人类可读 reason（猫在调用现场立即看到被哪口锅拦了）
    L2（实体）：无持续状态实体（锅本身是静态 registry，不是 runtime entity）
  why_not_dashboard_only: |
    猫撞到 429/403 guard rejection 时，如果只在 Console 锅账页数字 +1，猫不知道"刚才被拦是
    正常还是异常"，也不知道该 anomaly 上报哪个 ledger id。rejection 响应必须携带 ledger id
    和 reason，让猫在调用现场（tool error message）立即看到"这是哪口锅 + 为什么拦你"。
  deep_dive_surface: |
    Phase D Console 锅账页——事后审计 + 批量 retire 决策 + 单锅触发历史 drilldown。
    定位：operator 周期性治理入口，不是日常感知（eval 周期驱动 operator 来看，不是 operator
    主动盯）。
  noise_dedup_policy: |
    - 同类 guard rejection（同 ledger id + 同 cat + 同 tool）在 API 侧不 dedup（每次都拒绝
      且都落盘），但 eval 周期聚合时按 ledger id 聚合为单条"重复触发"记录
    - anomaly 上报成功无 in-context 通知（静默计数）；失败时 tool 返回错误但不发 thread 富块
      （anomaly 上报本身是 meta 行为，失败不应打断主任务）
    - eval verdict 产出后不主动 push thread 富块；operator 通过 Console retire 队列 + 可选
      的周期 scheduled task 提醒（Phase C 外，本 feature 不改 eval 通知机制）
```

## Review Gate

- Design Gate（架构级）：✅ 完成（opus 架构对齐 + codex 风险对齐 + Fable owner 收束 + in_context_observability 决策字段 + Architecture cell 更新）
- Phase A schema/lint：codex review
- 每 Phase merge 后与 operator 碰头（3+ Phase 大 feature）

## Architecture 归属（F191）

- **Architecture cell**: `harness-eval`（与 F245 同 cell）
- **Map delta**: ✅ updated——新增 ledger store + 双 eval 域 + Console 锅账页三个 anchor，harness-eval.md cell 已登记 F257 code/doc anchors + canonical feature + cited_by（2026-07-07）
- **Why**: ledger 是 harness-eval 控制面的资产层（域评估之下的单锅账本）

## Tips Contribution（F244）

- 已交付：`feature-f257-segment-lifeline`——引导 operator/developer 从 Console「协作与规则」→「生命周期与注入」打开段生命线，查看版本/trace/guard/eval 并执行创建、激活、启禁用或回滚（sourceRef: 本文 Phase D）。
- 待 Phase B：`撞到工具 4xx 拒绝时，拒绝响应里的 ledger id 是锅账坐标——anomaly 上报引用它，让锅的触发被记账`。

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Evidence** | `docs/features/assets/F257/harness-audit-2026-07-06.md` | 首棒 30 天触发审计全表（26 签名双路狩猎） |
| **Evidence** | `docs/features/assets/F257/seed-cases.md` | 自举条款种子案例账本（day-0 起） |
| **Feature** | `docs/features/F192-socio-technical-harness-eval.md` | 演化母体：五层 control plane |
| **Feature** | `docs/features/F245-friction-signal-eval.md` | anomaly 通道复用基座 |
| **Feature** | `docs/features/F237-prompt-injection-visibility.md` | Prompt injection trace pattern（非 Phase B blocker） |
| **Feature** | `docs/features/F254-side-effect-freshness-gate.md` | Redis LIST + closed union event log pattern |
| **Thread** | `thread_mr6kh7kdoac6852d` | 调查线主 thread（启动包来源） |
| **Thread** | `thread_mr96jyudj9iqisa9` | F257 工作 thread（Fable→opus→codex 接力） |
