---
feature_ids: [F257]
topics: [harness, objective-driven, tracing, condition-registry]
doc_kind: design
created: 2026-07-17
tips_exempt: { reason: "Internal exact-metric integrity contract; no new user/cat action or capability surface." }
status: superseded-2026-08-04 — 保留为 2026-07 设计/落地历史；当前评估契约以 feature-specs/2026-08-04-f257-objective-eval-redesign.md 为准
---

# F257 全量重设计：Objective-Driven 段评估体系 v1

> **历史文档，不得作为当前实现依据。** 2026-08-04 终态模型已改为 invocation 全程 tracing → 统一 `TraceAnnotation` → Objective 自有 Metric 规则 → 阈值/窗口触发 → code/LLM/replay evaluator → append-only `MetricResult`。MCP 只标记当前 invocation，不直接写评估结果；反例 counter 不强造分母；旧 `SegmentJudgment` 与时间窗违规率不再进入新读模型。当前真相源：[`feature-specs/2026-08-04-f257-objective-eval-redesign.md`](../../../../feature-specs/2026-08-04-f257-objective-eval-redesign.md)。

> 触发：operator 2026-07-17 03:43 全量重整指令。判定成立："之前猛猛干了很多，对目标的实际提升基本是 0"——tracing 底座是资产，但**对"段的评估分析迭代"这个目标，已交付能力 = 0**。本文档是确认材料，不是实施记录。
>
> 设计链条（operator 给定）：段怎么设计 → 构建评估 → 指标怎么设计 → 该 tracing 什么 → 怎么 tracing（通用逻辑 + condition 外置）。

## 0. 口径先行（KD-6）+ 文档架构规则（v1.7，五轮 review 根因 A 的结构修法）

> **规范归属 = concern → canonical owner 映射（v2.2，sol R10 P2-1：数章节数量的规则本身脆弱，已三次改数字——改为按 concern 定 owner）**：
>
> | concern | canonical owner |
> |---------|----------------|
> | deviation/eval_model 数据 schema | §3.1 |
> | routing tokenization + outcome | T-A §3.4 |
> | magic word 指标口径 | T-B §3.5 |
> | manual provenance / auth / 去重 / 原子性 | T-C §3.6 |
> | 采集完整性 / producer health | §4.5 |
> | LLM vs 纯代码边界 | §4.6 |
> | 引擎插拔契约（adapter/manifest 两层 + 治理安全边界） | §4.8 |
>
> **任何 concern 只有一个 owner 章节可下定义；其余位置（含主 spec 摘要）一律 `→ 见 X` 引用，禁止复述**——多处复述曾三次成为 P1（R2/R3/R5）。§4.7 walkthrough 为**实例叙事层**：片段均为示例，规范一律以 owner 章节为准。

- **46 个 prompt hook 段**，how_counted: `ls -d assets/prompt-hooks/*/ | wc -l` @ develop_base `c0e2f1b96`
- operator 口径"52 个规则协作段"——已决（§7.1，operator 03:51 授权自决）：**正文按实测 46 hooks 为工作口径**；SOP 6 步独立对象走 eval:sop 委托（KD-8），"52"不再作为工作口径
- 段分布：session-init 20 个 / per-turn 26 个

## 0.5 阅读地图：通用架构层 vs 段应用层（v2.0，operator 06:48 定位修正）

> operator 修正：全量设计应是"**评估的通用架构和流程**（对任何 harness unit 类型成立）→ 围绕**段**这次的具体设计"。本文档章节按此分两层读；段只是通用架构的第一个应用实例，skill / MCP GOTCHA / SOP 未来套同一架构。

| 层 | 章节 | 内容（unit-type 无关 ↔ 段专属） |
|----|------|------|
| **A 通用评估架构** | §3.0 公理 / §3.1 数据模型 / §4.2 观察面+condition 外置 / §4.3 语义层 / §4.4 评估与治理 / §4.5 producer health / **§4.6 LLM vs 纯代码分工** / **§4.8 引擎插拔契约（双层发现 + UnitTypeAdapter/UnitEvaluationManifest 两层 + 语义通道收敛）** | objective-评估模型-deviation-condition-fact 五实体、置信度与多归属（typed unitRefs）、四观察面、求值器双模式、per-action 治理安全边界、自动化边界——**全部与"段"无关；新增 unit = 写 adapter+manifests 不改引擎不改公共 schema** |
| **B 段应用设计** | §1 段分类学（应用层输入注记）/ §2 归组 / §3.2 八评估模型 / §3.4-3.6 规范表 / §5 资产处置 / §6 切片 | 46 段怎么套 A 层架构：归 8 objectives、每个的指标、路由/magic word/manual 三张落地契约 |
| **C 端到端实证** | **§4.7 签名缺失 walkthrough** | 一条信号从发生到迭代闭环的每一步：怎么发现/记什么/记哪里/怎么归属/怎么看/怎么进评估/哪步 LLM 哪步代码 |

**终态叙事（operator 06:48 原话直译，= 本设计的验收愿景）**：用户升级新版本后继续正常使用 → 系统自动采集 → 用户在段页面看到哪些正在评估、哪些已纳入采集、采集了什么数据 → 系统自动迭代（override 层启禁用/修改试验 = 自动；base 固化/合并/淘汰 = operator 批准，KD-12 边界）→ 用户感觉流程越来越平顺、纠偏越来越少。

## 1. ［B 段应用层｜输入注记］段分类学：指令段 vs 信息段（v2.0 降位——不是"发现"不是架构实体，只是段这个 unit 类型在设计其 objectives 指标时的一个输入维度；operator 06:48 定位确认）

盘点 46 段的应用层注记——"段"不是同质的，这影响段所挂 objective 的指标**倾向**：

| 类型 | 定义 | 例子 | 背离含义 | 对指标设计的含义 |
|------|------|------|---------|---------|
| **指令段（directive）** | 要求猫做/不做某事 | L3 传球三选一、L4 五条铁律、S4 协作格式、D1 身份锚定 | 信息给对了，猫没照做 | 该段所挂 objective 倾向背离率型指标（段效力问题→改写/升结构/退役） |
| **信息段（informative）** | 向猫供给现场状态 | D6 队友上下文、D18 世界上下文、N1 导航、D14 SOP 阶段 | 供给的信息错/过时，导致猫行为错 | 该段所挂 objective 倾向供给质量型指标（段内容/数据源问题→修供给链路） |

不区分的后果：信息段永远测不出"违规"（它不是命令），会被误判 dormant。**分类学是 46 段 backfill 的第一个字段，作为评估模型设计的输入，不是独立的评估模型分类。**

## 2. Objective 归组表（46 段 → 8 objectives，草案）

> objective = 评估单位（KD-20）。同 objective 段共指标、一起评估；governance 判读单段合并/禁用/修改/新增。

| Objective | statement | 挂靠段 | 类型构成 |
|-----------|-----------|--------|---------|
| **OBJ-1 球权路由送达** | 球经 @ 准确送达、不掉地、不假接 | L3, D21, D8, D9, D13, D5, D4, R1, R2 | 指令为主 + R1/R2 机制供给 |
| **OBJ-2 等待与存活纪律** | 不空等不死等，等待必带检测与触发器 | （L3/D21 的 hold 条款；无独立段——本身是发现：高频事故区无专段，靠工具 GOTCHA 兜底） | 指令 |
| **OBJ-3 身份完整性** | 签名/身份/能力边界始终正确 | S1, D1, S2, S3 | 指令 |
| **OBJ-4 协作与 review 纪律** | 跨个体 review、五元组 handoff、review 后回传 | S4, D3, S6, D10 | 指令 |
| **OBJ-5 记忆与能力唤醒** | 压缩后 recall 不从零开始；场景触发对的 skill/工具 | B1, L5, L6, D11, S13, D20, L1 | 指令+信息混合 |
| **OBJ-6 安全边界** | 铁律零违规 | L4, S10, L2 | 指令（低频高危） |
| **OBJ-7 现场状态供给** | 猫的行为基于准确、新鲜的现场状态 | D6, D18, D12, D2, D7, D15, N1, D14, D16, D17 | 信息段 |
| **OBJ-8 治理与偏好对齐** | 决策走漏斗、沟通符合 operator 偏好 | D19, S9, S11, S12, S5, S7, S8, C1 | 信息为主 |

附录：SOP 6 步——**已决**（§7.1）：独立对象委托 eval:sop（既有 trace/predicate，KD-8 不变），不入本 46 段册。

## 3. 评估模型详细设计（v1.2 重写——operator 修正落地，msg 0001784264045844）

### 3.0 三条 operator 修正（本节的公理）

1. **评估模型是 per-objective 实体**——每个 objective 有自己的评估模型（指标集），不是全局"指令/信息"两类。两类分类学降级为**设计参考维度**（指令型目标测背离率、供给型目标测供给质量），不再是架构实体。
2. **tracing 数据按置信度分层**：`confidence: exact`（condition 精确命中）| `inferred`（语义判断/三源标注）。
3. **语义事件多归属 + 部分影响**：非黑即白不成立——一个 inferred 事件可挂多个 objective，每个归属带影响权重。

### 3.1 统一数据模型（置信度 + 多归属）

```yaml
# v1.6（sol R4）：写入支收敛为两支；magic word 不再独立写入——Event Memory 已是其
# single source of truth（EventMemoryStore.ts:5 归一裁定 2026-06-06，owner-scoped 唯一键 + dead-letter），
# 再建一支 = 第二真相源违反 P4。EM-8 指标 = Event Memory 只读投影（唯一 message-word hit 数口径）。
deviation_event:                        # union by `kind`，公共字段：
  eventId / timestamp / registryVersion / incidentKey
  ownerUserId                           # v1.7：单一 auth scope（T-C 定死）——server-trusted，进事实/索引/
                                        # 全部查询授权路径；workspaceId 不进 V1（HookOverride 命名空间 ≠ 认证 owner）
  attributions:                         # v2.2（sol R10 P1-1）：通用层不认识"段"——unit 引用 typed 化
    - { objectiveId, unitRefs: [{unitType, unitId}], weight }
      # unitType ∈ 已注册 UnitTypeAdapter（V1 仅 'segment'）；段应用层写的 segment id
      # 是 unitRef 的 segment 类型实例——接入 skill/MCP/SOP 不改本 schema
      # exact 支强制单条 weight=1.0；manual 权重∈(0,1] objective 不重复
  anchors: { threadId, messageId?, invocationId? }

  kind=condition_hit:                   # confidence 恒 exact
    conditionId: <registry 条目>
    sourceFactRef: <指向 typed fact（可回放可审计）>
    recordedBy: system
    subjectCatId: <取自 fact 的 actor 字段>

  kind=manual_observation:              # confidence 恒 inferred
    source: operator | peer | self
    subjectCatId: 必填
    note: 必填
    # v2.3.2（sol R13，选 defer 路线）：V1 observation **不可变，无修订通道**——无 revisesEventId 字段；
    # 修订能力整体 deferred（完整方案存档于 T-C"修订能力"行，需求实证后按图实现）
    # recordedBy 注入 / sourceAnchor typed union 与三条服务端校验 / incidentKey / 幂等 / Lua 原子 /
    # 无锚 candidate 转正通道——唯一定义 = T-C（§3.6），此处不复述

# incidentKey / 幂等 / 原子性 / anchor 校验 / auth scope：唯一定义 = **T-C（§3.6）**，此处不复述。
#   condition_hit 的 incidentKey = hash(**ownerUserId** + conditionId + sourceFactRef)（v1.8：owner
#   namespace 进 key 与公共隔离契约一致，防 owner-scoped fact ref 跨用户互压）；Redis claim key 同样
#   owner namespace 化（服务端生成，非 manual 通道）

# DeviationEventLog 存储规格：
#   TTL=0（Console 治理证据；≥14 天基线窗是底线）
#   查询带分页/完整聚合——不沿用现默认 200 条静默截断
#   注意（sol R2 P2-2）：本账本只存 condition 求值后的分子事件；观察面的原始 typed fact
#   （RoutingDecisionFact / GuardDecisionFact…）是独立存储——分母与离线回放能力来自 fact 层，两层不得合并

eval_model:                             # 每 objective 一个，外置 YAML（与 condition registry 同目录族）
  id: em-routing-delivery
  objectiveId: obj-routing-delivery
  metrics: [ { id, numerator, denominator, confidence_scope, thresholds } ]
  verdict_rules: 指标→verdict 的确定性映射（EM-6 特例：0 容忍）
```

**指标双口径（置信度分层的直接推论）**：分子含 inferred 贡献的率类指标产两条曲线——`strict`（仅 exact）/ `broad`（exact + Σ weight×inferred）；**exact-only 指标只画单线**（sol R2：不画两条相同曲线）。

**阈值纪律**：v1 全部 `thresholds: null` —— 先跑 ≥2 周拿真实基线再定阈值，无基线不拍数字（防假精确）。阈值未定期间 verdict 只产 `keep_observe / needs-attention(broad 与 strict 显著分叉时)`。

### 3.2 八个评估模型逐个设计（v1.4 全表重写——单一真相，无"目标态"残留）

> 每个指标带 `status`：**active-V1 / active-V2**（分子分母已验真，标注上线切片）｜**candidate**（启发式或三源，恒 inferred，只产候选不进 strict）｜**blocked-on-fact**（缺 typed fact，列明缺哪个，fact 落地前不上线不展示）。没有"目标态表格"——写在这里的就是要实现的。

**EM-1 球权路由送达**
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| @ 解析成功率（per parserMode） | **active-V1** | 定义唯一来源 = **T-A decision table（§3.4）**：tokenization / outcome / eligibility / **parser 改造全集 → T-A**（本行不复述编号与细节）；group mention 退出 V1 | exact |
| void_ack 率 | **blocked-on-fact（v1.6 自 active 降级，sol R4 P1-1）** | `ball.handed`（invocation 开始，fire-and-forget）与 `ball.void_ack`（结束，另一次旁路写）是两个时间点独立写丢的信号——同窗相除纳入未完成 invocation + 跨窗右删失，不是可验真 exact。需 **per-attempt terminal decision fact**（attemptId / invocationId / subjectCatId / outcome，invocation 终态单点写），按完成 cohort 计算；P3 面工作，V2 | exact(目标) |
| @ 送达率 | blocked-on-fact | 需 attemptId join 实际 `ball.handed`——解析≠送达；V2（与 terminal fact 同期） | exact(目标) |
| 掉球率 | blocked-on-fact | 需 wake-outcome fact；eligibility 仅带 `completionRequirement` 的 wake invocation，不是全部 invocation | exact(目标) |
| 乒乓拦截计数 | active-V2 | GuardDecisionFact 面接入后由 fact 计数（迁自现硬编码 emit） | exact |
| 语义误路由 | candidate | manual_observation 加权 | inferred |

**EM-2 等待与存活纪律**
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| hold 429 率 | active-V2 | GuardDecisionFact(hold_429) / hold_ball 调用数（P2 ToolEventLog）——**分子分母同取 7 天窗**（P2 TTL 限制，如实标注） | exact |
| 唤醒零产出率 | blocked-on-fact | 需 wake-outcome fact（completionRequirement 字段现在持久化时被丢弃）；eligibility 同上 | exact(目标) |
| 无检测死等 | candidate | manual_observation | inferred |

**EM-3 身份完整性**
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| 签名缺失率 | active-V2 | 消息尾无签名模式（P1 正则离线可算）/ 猫消息总数——**只测"缺失"** | exact |
| 签名错误率 | blocked-on-fact | "错误"需身份 registry 版本快照对照（哪只猫当时该签什么） | exact(目标) |
| 冒名/越权计数 | blocked-on-fact | 需 publish_verdict 403 等接入 GuardDecisionFact 面（现不入流） | exact(目标) |
| 身份漂移 | candidate | manual_observation | inferred |

**EM-4 协作与 review 纪律**（v1.4：**无 active exact 指标**——结构信号在本 objective 天然稀薄，如实呈现）
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| 五元组缺失候选 | candidate | What/Why 正则**只产 candidate**（分母 A2A handoff 数存在，但正则不能证语义完整——sol REFUTED as exact） | inferred |
| review 后未回传 | candidate | manual_observation | inferred |
| 同族 review | candidate | manual_observation | inferred |

**EM-5 记忆与能力唤醒**
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| 压缩后零 recall 率 | active-V2（离线 job） | continuation session + transcript **离线 join**；实时窗受 P2 7 天 TTL 限制；`Skill` tool 只覆盖部分 provider——口径注明 per-provider | exact(窗口限定) |
| skill 加载计数 | active-V2 | 绝对数呈现（该触发场景数不可机判，无分母如实标注） | exact(无分母) |
| "猜代替查" | candidate | manual_observation（多归属带权重）——**命中置信度≠归因置信度**（sol R3 P1-2）：「我能猜出来」词条出现的 exact 事件只归 EM-8 计数；它对本 objective 的影响另产 manual_observation inferred 表达 | inferred |

**EM-6 安全边界**（0 容忍 verdict 规则**仅对已接入 GuardDecisionFact 的 guard 生效**——"既有结构护栏统一命中流"不存在，sol REFUTED，逐 guard 渐进接入）
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| 铁律违规（逐 guard） | blocked-on-fact | 第一个接入：publish_verdict 403 → GuardDecisionFact；其余 guard 逐个入面，接一个算一个 | exact(渐进) |
| 铁律违规（语义） | candidate | manual_observation，任何 1 例 → 人工升级通道 | inferred |

**EM-7 运行时现场供给**
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| 段渲染失败率 | active-V2 | 分子**只取失败 reason（`template_missing` 等）——普通 condition-false 的 `skipped` 不算失败**（HookPipeline:153，sol 修正）；分母 = eligible render attempts | exact |
| 信息过时/缺失事故 | candidate | manual_observation（标注 involved segments） | inferred |

**EM-8 治理与偏好对齐**
| 指标 | status | 定义 | 置信度 |
|------|--------|------|--------|
| magic word 词面出现数 | **active-V1**（Event Memory 只读投影） | 口径唯一来源 = **T-B（§3.5）**：raw substring 口径，**不解释为治理拉闸**；graded 拉闸数 = **future capability**（T-B 第二行，非汇总口径成员）；上下文影响另产 manual_observation | exact(raw 口径) |
| 决策漏斗违规 | candidate | manual_observation | inferred |
| Decision Packet 缺失 | candidate | manual_observation | inferred |

**汇总（how_counted: **仅 §3.2 八张 EM 表逐行**，规范表 T-A/B/C 内的 future capability 行不计入——v1.8 口径精确化，sol R6 P2-1）**：active-V1 = **2** 项（@解析成功率 / magic word 词面出现数）；active-V2 = 6 项；blocked-on-fact = **7** 项；candidate = 11 项。**V1 收窄原则：只对马上实现的部分做采集语义级声称，其余一律 blocked/candidate 不预支精确性**——V1 上线的每个数字可验真。

### 3.3 Console 归属链（operator UX 模型直译）

- **段详情页头部**：`本段归属 → obj-xxx → 评估模型 em-xxx`（可点跳）；段生命线保持 `v1 → tracing → eval → governance` 不变
- **eval 节点展开** = 所属评估模型的指标实况：曲线（含 inferred 贡献的指标才双线，exact-only 单线）+ 分子事件列表 + 阈值状态（未定基线期显示"基线收集中 N/14 天"）+ collection-health 徽标
- **tracing 节点展开** = 相关 events 按置信度分组：exact 命中列表（condition id + 锚点）/ inferred 标注列表（source + weight + note + 锚点）；点击锚点 → join 回对话上下文

### 3.4 规范表 T-A：RoutingAttemptFact decision table（V1 唯一 tokenization/outcome 真相源）

> 从 parser 代码逐路径 derive（`a2a-mentions.ts` analyzeA2AMentions / `AgentRouter.ts` parseMentionsRaw），每行带现状锚点。**fact 由 parser 内部产**（parser 是 tokenization 唯一真相源；外部 re-tokenize = 第二真相源，禁止）。`attemptId = (messageId, parserMode, tokenOrdinal)`，**tokenOrdinal 赋值时机（v1.8.2，sol R8）：所有扫描 pass 完成、span 去重合并之后，按 source span 起点排序一次性赋值（0-based）**——不在任何单遍扫描中途赋值，与"形成顺序"无关。

**parserMode=a2a（行首语法，analyzeA2AMentions）——outcome 互斥优先级自上而下：**

| 优先级 | outcome | 触发条件（代码现状） | 现 parser 可产？ | V1 实现动作 | eligible（进分母）？ | success？ |
|---|---|---|---|---|---|---|
| 0 | `ambiguous` | **（v2.3.11 / PR #44 sol F2 修复新增）** token 在统一路由视图（patterns ∪ @nickname ∪ canonical @catId，`groupRoutingTokenHolders`）中有 >1 holder——多持有即拒绝路由，先于 self 判定（多 holder 含 self 时也不猜"是不是我"）；产 `mention_ambiguous` warning 携带各 holder 的可路由显式 handle | ✓（修复后） | 已实现（同 PR）；无单一 targetCatId（validator target-iff-single-target 不变式） | ✓（发送方authored 真实路由尝试，系统拒绝解析——排除会在碰撞伤害路由时虚高成功率） | ✗ |
| 1 | `self_excluded` | token 匹配 self pattern——现状：self patterns 在 pattern build 时预删（`continue`），匹配时与 unknown 不可区分 | ✗ | parser 改造①：self patterns 保留参与匹配，命中时标记 self_excluded 后跳过（不路由） | ✓ | ✗ |
| 2 | `disabled_cat` | pattern 匹配但 `resolveCatTarget` 返回 error（F182 KD-10 match-time 检查）→ routing_warnings | ✓ | 直接采 | ✓ | ✗ |
| 3 | `duplicate` | pattern 匹配但 catId 已在 `seen` ——现状静默跳过 | 半（需标记） | parser 内标记 emit | ✗（去重语义，不代表路由质量；不进分子分母） | — |
| 4 | `resolved` | pattern 匹配 + boundary 通过 + resolver 通过 → `found` | ✓ | 直接采 | ✓ | ✓ |
| 5 | `unknown_token` | cursor 处 `@` 开头但无 pattern 匹配——现状 `if (!matched) break` **静默放弃该行剩余，零痕迹** | ✗ | parser 改造②：break 前对 cursor 处 token（`@` 至下一 boundary）emit unknown_token attempt | ✓ | ✗ |
| — | （右截断） | `found.length >= MAX_A2A_MENTION_TARGETS` → 外层 break，后续行不扫 | — | **v1.8.1（sol R7）：达到 cap ≠ 被截断**——停止路由后继续**只读 token scan**，确认存在额外可路由 token 才置 `truncated=true` → 该批 `metricEligible=false`（防有偏保留成功前缀）；恰好 cap 个合法目标且无更多 token 的消息**正常计入**（防反向选择偏差：合法双目标消息被误排除） | — | — |

**parserMode=user（任意位置 prose，parseMentionsRaw）**——现状是 route-line + prose **两遍扫描**且按 `seenCats` 折叠（AgentRouter.ts:386/1005），同一 source 位置可被访问两次；group mention 先过 parseMentionsRaw 再过滤（AgentRouter.ts:1162）：

| outcome | 触发条件 | 现 parser 可产？ | V1 实现动作 | eligible？ | success？ |
|---|---|---|---|---|---|
| `ambiguous` | **（v2.3.11）** token 在统一路由视图中 >1 holder → 拒绝路由 + `mention_ambiguous` warning（per-pattern 去重）；ambiguous-only 消息 targetCats=[]（不 fallback recent/default，sol F3） | ✓（修复后） | 已实现（同 PR） | ✓ | ✗ |
| `resolved` | route-line 或 prose `@` 候选位匹配 pattern | ✓ | draft 化 | ✓ | ✓ |
| `unknown_token` | 显式 `@handle` 无匹配且非 domain-suffixed（codex 6949db49） | ✓ | draft 化 | ✓ | ✗ |
| `disabled_cat` | resolver error → routing_warnings | ✓ | draft 化 | ✓ | ✗ |
| `duplicate` | **仅限：不同 span 指向同一猫**（同猫多 token 被 seenCats 折叠）——语义重复。**同 span 被两遍扫描 ≠ duplicate**：那是 traversal artifact，draft 层无声合并、不产/不改原 outcome（v1.8.1，sol R7 P1-1：否则真实 resolved token 会被第二遍扫描改判） | ✗ | parser 改造③：span 级合并 + distinct-span-same-target 标记 | ✗ | — |
| `group_keyword_skip` | `@all` 等 group 关键词——**现状在 parseMentionsRaw 后才过滤，parser 内产 fact 会误标 unknown_token** | ✗ | parser 改造④：group 关键词在 draft 层先行识别标记，不落 unknown | ✗（非单播路由意图） | — |
| `domain_suffixed_skip` | `hasDomainSuffixedMentionPatternAt` 排除 | ✓ | draft 化 | ✗ | — |

**Attempt 流唯一性契约（v1.8.1 修正）**：parser 返回 **`RoutingAttemptDraft[]`——每个语法 token（唯一 source span）恰好一条 draft**；**同 span 二次访问 = traversal artifact，draft 层无声合并，不产新 draft 不改原 outcome**；`duplicate` outcome 仅指 distinct span 指向同一目标；`tokenOrdinal` = **全部 pass 合并去重后**按 span 起点排序一次性赋值（与 §3.4 头注同一定义）；draft 在 **MessageStore 生成 messageId 之后** finalize 为 fact——**禁止任何 parser 外部 re-tokenize**。

**指标定义（唯一来源）**：`@解析成功率(parserMode) = resolved / (resolved + disabled_cat + self_excluded + unknown_token + ambiguous)`，仅 `metricEligible=true` 的 batch 计入；两 parserMode 分开报，不合并。**口径演进（v2.3.11）**：`ambiguous` 进分母不进分子——它是发送方 authored 的真实路由尝试被系统拒绝解析，排除会在昵称/pattern 碰撞正在伤害路由时虚高成功率；历史 batch 无此 outcome，分母口径向后兼容（旧 batch 该项恒为 0）。`mention_not_line_start` 启发式（#417）永不进此表——candidate 通道。V1 前置：**parser 改造全集 = 本表"V1 实现动作"列的全部条目**（同一 PR，测试基线先行；不以编号列表复述，防条目演进后编号漂移）。

### 3.5 规范表 T-B：MagicWordProjection eligibility（V1 唯一 magic word 指标真相源）

> live 路径实测（sol R5）：substring detector（`messages.ts:225`）+ **live hit 强制 `confidence: high`**（`index.ts:1762`）；deterministic grader 只跑 backfill（`event-backfill.ts:4` 自注 "live is always high"）。

**观测去重 / 身份契约（v2.3.4）**：magic word 只统计 authenticated local operator 的 `author=user && observation=original` 持久化消息；connector 人类发送者必须声明 `author=external_user + source`，不得因 `catId=null` 冒充 operator。thread branch / transcript history import 等由既有消息派生的存储副本必须写 `observation=derived + sourceRef`，不产生第二次词面观测；用户在 branch 时提交编辑后的最终消息是一次新的 `original` 观测，`timestamp` 取编辑提交时刻而非源消息时刻，正常进入当前窗口。缺失、空值或跨字段矛盾的 provenance 不得静默降级为 legacy cohort，窗口必须标记 unmeasurable。

| 指标 | 口径 | status |
|---|---|---|
| magic word **词面出现数** | Event Memory 只读投影，owner-scoped 唯一键去重（"唯一 message-word hit"）；**raw substring 口径——不解释为治理拉闸/偏好背离**（定义、引用旧消息同样计入，如实标注） | **active-V1** |
| magic word **治理拉闸数**（graded） | 需 live 路径接通同一 deterministic grader + 定义准入 confidence 集合——live/backfill 口径归一是前置 | **future capability（非 §3.2 指标汇总口径成员）** |

**采集完整性契约（v2.3.6）**：live 路径是 `void tryDetectMagicWords`（messages.ts:207，异常直接 catch 连 dead-letter 都不到），corpus backfill 是手动 HTTP（events.ts:170）——Event Memory 漏记时 raw count 静默偏低。**V1 前置**：指标计算前按 **owner-scoped message cursor 自动 reconcile**——对窗口内消息幂等重扫 detector（纯函数）补账 Event Memory，**high-watermark 持久化**；reconcile 未完成的窗口 → `unmeasurable`。cursor→hash join 必须先通过 canonical whole-record validator：hash `id/userId` 分别等于 timeline member/owner，timeline score 必须等于 `effectiveOrderAt = deliveredAt ?? timestamp`；`timestamp` 永远保留原始发送事实，`deliveredAt` 是可选但一旦存在必须为健康的投递事实。`threadId/content/mentions/source/routingFact/provenance` 及 `deletedAt/deletedBy/_tombstone` 的必需字段、JSON shape 与跨字段 invariant 全部健康；任何损坏 fail closed，禁止默认成空内容或 `timestamp=0`。健康 deleted 终态按下表确定性退出 cohort，不得继续 join 旧 Event Memory；Event Memory 命中按窗口内 active-message coordinate join，不得用 event/raw-send timestamp 预裁剪；reconcile 新写的事件使用 `effectiveOrderAt`。producer heartbeat 不能替代此项（heartbeat 证明进程活着，不证明每条消息被扫描）。投影只读 Event Memory，不写任何第二份存储。

**Persisted-message 状态机（v2.3.10，exact reader 唯一坐标与删除语义）**：

| 状态 / 转移 | 持久化事实与 projection | exact reader 语义 | 可逆性 / 约束 |
|---|---|---|---|
| append immediate / queued | `timestamp=sentAt`，无 `deliveredAt`；owner score=`sentAt` | active；坐标=`timestamp` | hash `userId` = timeline owner |
| `queued → delivered` | 保留 `timestamp`，新增 `deliveredAt`；thread/global 与**提交时当前 owner** score 在同一 Lua 原子前移 | active；坐标=`deliveredAt` | 若 caller snapshot 的 owner 已变化，Lua 不得写旧 owner；返回当前 owner 后重读/重试 |
| `reassignUserId` | owner member 从旧 owner 移到新 owner；Lua 在提交时从 authority hash 读取 `deliveredAt ?? timestamp` 作为新 score | active；坐标=`deliveredAt ?? timestamp` | hash `userId` = 新 timeline owner；禁止把 Lua 外预读 score 当提交事实 |
| `softDelete` | 保留 content、provenance、routingFact、Event Memory，新增健康 `deletedAt/deletedBy` | inactive：T-A/T-B 均排除；旧 Event Memory 不参与 join | 可 restore；restore 清 deletion marker 后按原坐标重入 cohort |
| `hardDelete` | 先持久化 coordinate delete fence；清 Event Memory 主表/dead-letter 与 episode `magic_word_ref`，再原子写 `content=''`、`mentions=[]`、清 `routingFact/provenance` 与 routing projection，保留健康 tombstone 骨架 | fence 后任何 stale live/backfill/dead-letter/ref writer 必须拒写；T-A/T-B 均排除 | 不可恢复且 tombstone authority 不可再变；重复 hard 不再改 authority，但必须幂等重试扫描并清理全部历史 owner 的 routing/error member；soft/restore/payload/index mutation 均 no-op/reject；tombstone 仍带 token/excerpt/F257 payload = malformed，窗口 `unmeasurable` |
| physical `deleteByThread` | 无论 thread index 是否为空/损坏，先持久化 thread delete fence 并清 Event Memory + episode refs；以 hash scan 与 thread member 并集发现 IDs，并在同一 authority-delete 事务中为并集补齐 thread retry anchors；再 post-transition 扫描并清 global/user/mention/routing/error projections，最后才删除 thread discovery index | owner timeline 无残留 member；后续 exact window 健康为空而非 collection gap | 物理级联，不可恢复；empty/orphan authority 也必须收敛；authority absence 先线性化后 stale mutator/projector 均拒写；并集 IDs 的 thread anchors 保留到全部 sibling cleanup 成功 |

canonical validator 必须读取 effective-order 与 deletion marker 全集：不得把合法投递后的 `timestamp != score` 判为损坏；不得接受 malformed `deliveredAt/deletedAt/deletedBy/_tombstone`、与 effective-order 不同的 score，或仍携带 F257 token/excerpt payload 的 hard tombstone。健康 deleted row 是显式 `deleted` 终态，不是 active/legacy，也不是默认空内容。

**删除线性化契约（v2.3.8）**：hard/thread delete 的线性化点是持久化 delete fence，而不是一次 best-effort pre-hook 清理。Event Memory `markEvent/appendDeadLetter` 与 episode `magic_word_ref` append 必须在各自持久化事务内检查同一 coordinate/thread fence；fence 后持有旧 message snapshot 的 writer 也不得重建 excerpt/token。删除级联需覆盖 Event Memory、dead-letter/outbox、episode refs 与 Redis 全部 message/routing projections。`restore` 与 `hardDelete` 必须通过 Redis CAS/Lua 原子转换：restore 只能从“soft-deleted 且非 tombstone”转回 active；hard delete 一旦先线性化，restore 永远不得清除其 deletion markers。physical thread delete 必须先让 authority hashes absent，再扫描/清理 sibling projections；否则 initial SCAN 与 hash delete 之间恢复的 projector 会制造一个永远漏扫的新 key。thread discovery index 只能在 sibling cleanup 成功后删除，使中途 WRONGTYPE/连接错误可通过同一 API 重试。跨存储中途失败采用 privacy-first fail-closed：fence/authority absence 保留、exact window unmeasurable，幂等重试继续收敛，不允许重新开放写入。

Redis authority 的 lifecycle owner 是 `MessageStore` 最终写边界，不是各调用方。以下 mutation census 是状态机的一部分：`softDelete`、`hardDelete`、`restore`、`updateExtra`、`augmentStreamMetadata`、`revealWhispers`、`markDelivered`、`markCanceled`，以及 Redis-only `reassignUserId`；不得靠调用方先读 `_tombstone`。所有单 hash mutator 在原子提交时必须同时满足 `hash exists && _tombstone != 1`；跨 hash/index mutator 必须在同一 Lua/事务判定后提交。soft-deleted row 仍可接收正常完成中的 payload/order mutation（内容本就保留且可 restore），但 hard tombstone 仅允许升级为 physical delete，任何其他 mutation 均不得改变字段或重建 sibling index。重复 `hardDelete` 是清理重试而非状态转移：authority 必须保持字节级不变，但仍扫描所有 routing/error sibling keys 并移除该 message id，确保第一次清理在 fence 后中断也能继续收敛。in-memory 实现保持同一可观察契约。

**Delivery ↔ owner reassignment 线性化契约（v2.3.9）**：`userId` 与 `effectiveOrderAt = deliveredAt ?? timestamp` 是同一个 authority coordinate，不是两个可独立预读后拼装的字段。若 reassign 先线性化，迟到的 delivery Lua 必须检测 expected owner 不匹配、返回当前 owner，并由 Store 重读后只更新新 owner；若 delivery 先线性化，迟到的 reassign Lua 必须在同一脚本内读取最新 `deliveredAt ?? timestamp`，再移动 owner member。两个顺序的唯一健康终态均为：hash owner=新 owner、旧 owner 无 member、新 owner/thread/global score=`deliveredAt`。任何 Lua 外 owner/score snapshot 只可作为 optimistic expectation，不能作为提交授权或坐标事实。

**Mutator response 契约（v2.3.10）**：当 Redis transition 在 Lua 内消费了 caller snapshot 之后才出现的 authority 字段时，成功返回的 `StoredMessage` 必须重新水合 canonical hash，不能用旧对象局部改字段来合成一个从未持久存在的混合态。特别地，delivery-first 的 `reassignUserId()` 返回必须同时包含新 owner、`deliveryStatus=delivered` 与 `deliveredAt`。这不是“所有 API 永远返回全局最新值”的承诺；并发 transition 仍按各自线性化点排序，但单个成功返回必须能对应一个真实 authority snapshot。

`RedisRoutingFactProjection.project()`、reconcile missing-member repair 与 error-marker writer 都是派生层的最终写边界：写 index/watermark/error 前必须原子重读 authority，且只接受 `hash exists`、active（无 `deletedAt/_tombstone`）、owner 与 `routingFact` 仍匹配 snapshot 的记录。routing index score 必须在该 Lua 内从 authority 的 `deliveredAt ?? timestamp` 推导，禁止使用 projector/reconcile 调用前 snapshot score；因此 delivery 已先线性化时，迟到 projector 只能提交新的 delivery coordinate。若 stale snapshot 遇到 soft/hard/physical delete 或 owner/fact 已变化，必须 no-op 并移除该旧 owner 下的 stale routing/error member。该 projection 按 §4.5.1 是可重建的异步派生层：projector 先线性化、随后 delivery/reassign 改变 authority 时，旧 projection 允许暂时 stale，但任何 exact evaluation 必须先执行同步 reconcile，以 authority 当前 owner/effective-order 修复后才能读；authority transition 先线性化时，后续 project/repair 则必须直接服从提交时 authority。删除终态例外：delete fence 后 stale writer 无权复活 projection，不能把 terminal cleanup 延后给 reconcile。

### 3.6 规范表 T-C：ManualObservation provenance/auth（V1 唯一 manual 契约真相源）

| 契约项 | V1 定义 |
|---|---|
| auth scope | **`ownerUserId` 单一 scope**（运行时消息与 Event Memory 的既有授权边界）；`workspaceId` **不进 V1 schema**（HookOverride 命名空间 ≠ 认证 owner，留 future） |
| sourceAnchor（typed union，必填） | `{kind:'thread_message', messageId}` ｜ `{kind:'operator_confirmation', confirmationId}` |
| 服务端校验（写入时，三条全过） | ① anchor 指向的实体存在；② anchor 与 authenticated ownerUserId 同域；③ `source=operator` 时 anchor 必须满足统一 authenticated-operator 判据：`provenance.author=user && observation=original && catId=null && source absent`；system、external_user、derived 均拒绝 |
| recordedBy | callback principal 注入（猫）/ console 会话注入（operator）——不可自报 |
| subjectCatId | 必填，与 recordedBy 分离 |
| incidentKey | `hash(ownerUserId + sourceAnchor + subjectCatId + sorted((objectiveId, unitType, unitId) 归属元组全集))`——v2.3（sol R11 P1-1）：**canonical attribution identity 全量进 key**（旧版只 hash objectiveIds → 同 anchor/subject/objective 但归属不同 unit 的两条 observation 会抢同一 Lua claim，第二条被静默丢弃）；owner namespace + 服务端排序防换序绕过 |
| 修订能力 | **V1 = observation 不可变，无修订通道**（v2.3.2 定稿，sol R13 选项 b——修订需求未实证，不预支读写闭环复杂度；写错的观察由新的独立 observation 表达）。**Deferred 完整方案存档**（需求实证后按此实现，不重新设计）：修订事件带 `revisesEventId` + 独立 key `hash(owner + revisesEventId + canonical(新归属含 weight))`；每 lineage 唯一 current head，revision append 同一 Lua 内校验 `revisesEventId === currentHead` 后原子推进（CAS），stale 返回显式 conflict；评估/Console 默认读 **effective view**（每 lineage 取 current head），audit view 保留完整版本链；rebuild 从 append-only log 确定性重建 head，检测到历史分叉标 conflict/unmeasurable 不任选一支 |
| 原子性 | claim incidentKey + append event 同一 **Lua** 脚本（BallCustody APPEND_LUA 先例）；失败无 phantom claim |
| 幂等 | client 可带 idempotencyKey（principal+threadId scoped，仅防网络重试） |
| 无 anchor 的口头纠偏 | 停留 candidate 态；operator 一键确认产生 `operator_confirmation` anchor 后转正 |

## 4. 通用 Tracing 架构（condition 外置——本次重设计的核心）

### 4.1 病根承认

现状两处 emit 全是**主流程硬编码**（hold_ball routes 里 15 行、A2A generator 里同款）——operator 判定正确：hotfix 形态。每加一个信号改一处业务代码，46 段 × N 签名不可扩展。**修正原则（v1.4 收紧，sol R2 P2-1）：业务现场只负责发稳定的 typed fact；新增 condition 不再改业务代码。**（新增一类 fact 仍需业务侧一次接线——"永不再改业务代码"不成立，边界如实）

### 4.2 三层架构（v1.3：观察面改为现状实测——sol review 证伪"零新增采集"）

**观察面现状实测（sol 逐锚点核验，2026-07-17）**——v1.2 声称"已存在的全量流、零新增采集"**不成立**：

| 面 | v1.2 声称 | 实测现状（代码锚点见 sol review） | v1.3 处置 |
|----|----------|--------------------------------|----------|
| P1 消息流 | TTL=0 含 @ 结构/routing_warnings | 落库仅 `id/threadId/timestamp/content`；**routing_warnings 只走 WebSocket 广播不落库**；mentions 存解析后目标非原始 token/失败诊断 | **新增 `RoutingDecisionFact` 持久化**（首切片核心）——tokenization/outcome/eligibility 唯一定义 = **T-A（§3.4）**；持久化形态 = 权威记录一次写（§4.5.1） |
| P2 工具调用流 | TTL=0 可回放 | **ToolEventLog TTL=7 天**，且 Skill tool 只覆盖部分 provider | 7 天窗口内指标可算；跨窗评估 blocked，P2 留存策略进 OQ |
| P3 生命周期流 | 统一流可查 | **不存在统一流**；`sourceCategory/completionRequirement` 等关键字段在 InvocationRecord 持久化时**被丢弃**（进程内 QueueEntry 独有） | per-fact 渐进补齐（wake outcome fact 等），每个 fact 是独立小 PR |
| P4 HTTP guard 流 | 已存在 | **不存在通用流**——现 GuardRejectionEventLog 仅 2 硬编码 kind + 7 天清理 | 演进为 **`GuardDecisionFact` 观察面**（原始 guard 决策事实：可回放、供分母）；**不由 DeviationEventLog 吸收**——fact 是观察面、deviation 是求值分子，合并会丢回放与分母能力（sol R2 P2-2） |

**排序判据修正（v1.2 的"结构信号可回放"被打掉一半）**：可回放性只对**已持久化**的面成立——路由诊断、guard 命中此刻也在不可逆丢失。语义与结构两侧都在漏 → 首切片必须同时堵两个口（vertical slice，见 §6）。

```
层1 观察面 → per-plane adapter 产 typed fact（RoutingDecisionFact 先行，字段 typed 非裸 JSON）
层2 Condition Registry（外置 YAML）——谓词分层（sol 方案）：
    · condition 层最小谓词：exists / eq / gte / regex / not_empty + all / any / not / in
    · 窗口逻辑、跨事件 join、去重 → 不进谓词，归 metric aggregator 层
    · eligibility（如"仅评估带 completionRequirement 的 wake"）→ adapter 在 fact 上标记，condition 只读标记
层3 求值器两模式：实时（fact 落库后单点 post-hook）+ 离线（对已持久化 fact 回放）
```

### 4.3 语义层（conditions 判不了的）——v1.7：纯引用节，零定义

- 语义背离唯一写入通道 = `manual_observation`（工具 `cat_cafe_report_harness_signal`）：schema → §3.1；provenance/auth/incidentKey/原子性 → **T-C（§3.6）**
- magic word 不在本层写入任何事件：指标 = Event Memory 只读投影 → **T-B（§3.5）**
- 覆盖承诺：**不承诺全量捕获**（"依赖被纠偏的猫记得调工具"与 F257 要消灭的失忆路径同构）；无 anchor 口头纠偏走 candidate → operator 确认转正（T-C 末行）

### 4.4 评估与治理（下游不变，坐标系换）

deviation 账本（分子）+ typed fact 计数（分母）→ per-objective 指标 → eval 猫归因（weekly + 阈值插队，机制保留）→ governance 四动作作用于段（合并/禁用/修改 override 现成 / 新增 base 级）→ PatchTrial 差分验证 → 生命线呈现（console 组件复用，数据源换 objective join）。

### 4.5 Producer Health（v1.4 机制化——sol R2 P1-4："只有目标没有机制"不放行）

零事件必须可区分"零违规"与"采集器坏了"。**具体机制（V1 可执行）**：

1. **关键 fact 权威记录一次写 + 投影覆盖率契约**（v2.3.6 收紧）：`RoutingDecisionFact` 内嵌消息持久化记录一次写入（同一权威值物理共命运；Redis MULTI 无 rollback、pipeline.exec 不查逐命令 error——此路径不依赖 MULTI 语义）；查询投影（ZSET 时间索引）异步派生，**配套三件**：① **owner-scoped high-watermark**（投影记录已处理到的权威序号，持久化）② **评估前覆盖校验**：窗口内 authority 计数 vs projection 计数对账，且 authority hash 必须通过 T-B 同一 canonical whole-record validator（member/owner 与 hash 一致、score = `deliveredAt ?? timestamp`、payload/deletion state 结构健康）；健康 deleted row 退出 cohort，hard/physical delete 同步清理 routing projection；缺口/损坏 → 先同步幂等重建（仅投影缺口可重建，权威损坏不可伪修），失败 → 该窗口指标强制 `unmeasurable` ③ 现有 MessageStore 异步 listener 的静默吞错形态（RedisMessageStore.ts:193）**不得复用**——投影 worker 错误必须落 heartbeat 缺口
   **fail-open 适用范围显式列表（v1.8）**：仅限 best-effort producer（guard fact、ball-custody 类旁路写）；**内嵌 RoutingFact 不适用 fail-open**（它与消息共命运，消息写成功即 fact 存在）；manual_observation 不适用（T-C await-append）
2. **manual_observation 不 fail-open**：工具 `await append`，写失败**显式返回错误**给调用者（猫可见可重试）——手工上报静默丢失 = 三源通道自我否定
3. **best-effort producer**（guard fact 等 fire-and-forget 类）：**时间桶 heartbeat 序列**（每分钟一桶，ZSET/bitmap；不是最新值型 key——最新值会被恢复后覆盖，weekly 无法回看历史缺口，sol R3 P2）；评估时计算期望桶 vs 实际桶覆盖率，**缺桶窗口** → 依赖该 producer 的指标 verdict 强制 `unmeasurable`，禁产零事件结论
4. **入账时效 AC 拆三条**（不再泛写"operator 纠偏 30 秒入账"）：
   - magic word：operator 消息落库后 **30s 内自动**入账
   - manual/candidate：operator 确认或 report 调用成功起 **30s 内**入账
   - 未确认的语义纠偏：**不承诺捕获**——覆盖率如实呈现为 candidate 通道指标

fail-open 政策**唯一定义 = §4.5.1 的 per-producer 显式列表**（best-effort producer 限定；内嵌 RoutingFact 与 manual observation 排除）——无全局总括。故障必须经 heartbeat 缺口可见；Console 指标卡带 collection-health 徽标。

### 4.6 LLM vs 纯代码分工（通用架构层，operator 06:48 点名补齐）

**划分原则一句话：判据能写成谓词/正则/算式的 → 纯代码；需要理解语境和"为什么"的 → LLM。LLM 产物永远是 inferred/candidate/建议稿，永不进 exact、永不直接执行治理。**

| 环节 | 实现 | 为什么 |
|------|------|--------|
| fact 采集（parser draft / 渲染失败 / guard 命中 / 签名正则 / magic word substring） | **纯代码** | 全量、廉价、可回放、**对已声明谓词确定性求值且可复算**（v2.2 修正措辞：正则仍可能语义误报/漏报，"确定"指判据执行不指语义完美）——观测层掺 LLM = 分母不可信 |
| condition 求值（谓词匹配 → condition_hit） | **纯代码** | 判据确定，可单测可回归；这就是"condition 外置"的前提——外置的是配置不是智能 |
| 指标聚合（分子分母/双口径/覆盖率对账/watermark） | **纯代码** | 算数必须可复算（KD-6） |
| exact 事件的归属 | **纯代码（condition YAML 静态声明）** | exact 通道的归属在设计时由人定死，运行时零判断——归属判断是语义工作，混进 exact 就污染置信度分层 |
| 语义背离的发现与归属（多归属+权重） | **LLM/人（三源 manual_observation）** | "跑歪了""绕路了"只有语义引擎能判；operator/peer/self 本身就是三个语义求值器 |
| weekly 归因分析（指标+抽样事件 → 归因叙事） | **LLM（eval 猫）**，输入是纯代码预计算的指标包（KD-17 snapshot-first） | 跨事件模式识别（"缺失集中在 X 猫的 continuation session"）是语义工作；但 eval 猫**不算数**——数字全部来自确定性引擎 |
| verdict 判定规则（指标 → keep_observe/needs-attention/…） | **纯代码**（确定性映射，eval 猫的归因叙事是附件不是判定源） | 判定可审计可复算；防"LLM 心情决定段生死" |
| 段内容修改建议稿（governance 环节） | **LLM 起草** → override 试验（自动）→ base 固化（operator 批） | 改写是生成任务；但试验有 rollback、固化有人批——LLM 不直接动基线 |

### 4.7 端到端 walkthrough：一条"签名缺失"从发生到迭代（实例叙事层；该指标 active-V2）

> 每步标注【代码】/【LLM】/【人】。**两条链路不同，如实分开（v2.2 修正 sol R10 P1-2——V1 不走 condition 链）**：
> - **V1 链（@解析成功率）**：权威消息**内嵌** RoutingDecisionFact（一次写，共命运）→ 投影/覆盖率对账（§4.5.1）→ 指标聚合 → Console。**无 condition registry、无求值器、失败 outcome 不产 deviation 事件**——分子分母全部直接从 fact 聚合（condition/evaluator 是 V2 切片）。
> - **V2 链（本节签名实例）**：消息权威记录 → **可重建的 SignatureFact 投影** → condition 求值 → DeviationEvent → 评估。

1. **发生**：某猫回复了一条消息，末尾没带 `[昵称/模型🐾]` 签名。
2. **发现**【代码】：消息落库后，投影 worker 对 cat 消息跑签名正则产 `SignatureFact{messageId, catId, ownerUserId, present:false}`。**这是投影不是权威记录**（消息权威记录内没有签名字段）——因此必须带满 §4.5/T-B 同款完整性契约：**owner-scoped cursor + watermark 持久化 + 评估前 reconcile（幂等重扫窗口消息补投影）+ 覆盖缺口 → `unmeasurable`**。不依赖任何猫"自觉上报"。
3. **记录**【代码】：求值器按 plane 索引匹配外置 condition `signature_missing`（示例，规范语法以 §4.2 为准）→ 命中 → `DeviationEventLog.append(condition_hit)`——字段全集见 §3.1；归属静态来自 condition 声明（`obj-identity-integrity, unitRefs=[segment:S1, segment:D1], weight=1.0`）。
4. **归属**【代码，设计时人定】：见上——exact 事件的归属是 condition 注册时由人写死的声明，运行时零判断。（若这条缺签名背后另有语义问题——比如猫在身份漂移——那是三源 manual_observation 的活【LLM/人】，另产 inferred 事件多归属。）
5. **看**【代码渲染】：Console 两个入口——objective 页 EM-3 指标卡（签名缺失率单线曲线 + collection-health 徽标 + 分子事件列表，点任一事件经锚点 join 回**原消息全文**）；段生命线（S1/D1 的 tracing 节点展开，exact 命中按 condition 分组）。
6. **进评估**【代码 → LLM】：weekly（或阈值插队）触发 → 判定引擎【代码】算指标（分子=窗口内 condition_hit 计数，分母=猫消息总数，覆盖率对账通过才可信）→ 产 snapshot 注入 eval 猫【LLM】→ 归因叙事（如"缺失 87% 集中于 continuation session 前 3 轮——疑似 session 恢复时身份段未生效"）→ verdict 由确定性规则【代码】给出，归因叙事作为附件。
7. **治理**【自动 override / 人批】：verdict + 归因 → 若建议"D1 段对 continuation 场景加强"→ LLM 起草改写稿 → **override 层自动试验**（不动 base，随时 rollback）→ PatchTrial 窗口。
8. **验证迭代**【代码差分 + 人批】：试验窗口后签名缺失率差分——降了 → 带证据固化 base（operator 批）；没降 → rollback，段进合并/退役候选。**用户感知：纠偏越来越少。**

### 4.8 通用引擎与 unit 插拔契约（v2.1，operator 06:59 架构输入——"引擎通用、定制插拔、语义通道收敛"）

**① 发现是双层的（operator 定式）**：

| 层 | 机制 | 适用 | 参照系 |
|----|------|------|--------|
| 静态规则层 | 外置 condition（谓词）+ 纯代码 fact producer | 判据可写成谓词/正则的——**能静态搞定的优先静态**（廉价/全量/可回放） | 本设计 §4.2 |
| 语义上报层 | **MCP 工具现场上报**（manual_observation：operator/peer/self） | 静态处理不了的语境判断 | **与画像更新提议、F245 摩擦 marker 生命周期同构**（"语义观察 → 结构化事件 → 审批/消费"——传输机制各异，见本节③，不混称）；report_harness_signal 的传输 = MCP await-append 直写（T-C 契约） |

**② 引擎 unit-type 无关——插拔契约两层（v2.2，sol R10 P1-1/P1-3：类型级与实例级分离 + 治理安全边界进接口）**：

```yaml
UnitTypeAdapter:                  # 类型级（per unit-type，注册一次）：该类型怎么被观测与治理
  unitType: segment | skill | mcp_gotcha | sop | …
  schemaVersion:                  # v2.3：adapter↔引擎版本兼容声明，提至根级（sol R11 P1-2）
  fact_producers:                 # v2.3（sol R11 P1-3）：每个 producer 绑采集完整性契约——
    - factType:                   #   否则引擎无法判断新 unit 的零事件 = 无偏差 or 采集失败
      authorityMode: embedded | projection | best_effort   # 权威内嵌 / 可重建投影 / 旁路尽力
      ownerScope:                 #   授权边界字段（ownerUserId 语义）
      retention:                  #   留存（TTL=0 / 7d / …如实声明）
      reconcilePolicy:            #   → 引用 §4.5（projection 必填；best_effort 无可回放权威源时
                                  #     显式 `none`——此时 healthPolicy 必须承担 unmeasurable 强制，v2.3.1 sol R12 P2-1）
      healthPolicy:               #   → 引用 §4.5（heartbeat 桶 / 覆盖率对账 / unmeasurable 规则）
  console_renderer:               # 生命线/指标卡如何呈现该类型
  governance:
    actions:                      # v2.3：per-action 安全策略（adapter 级单值表达不了
      - action: enable|disable|modify|merge|add|…        #   "modify 可 auto、merge 仅 proposal"）
        safetyTier / approvalMode(auto-trial|proposal-only) / trialScope / rollbackRef
  # 只有该 action 条目显式 approvalMode=auto-trial + rollbackRef 有效时才能自动试验；
  # 其余一律产提案等审批——"引擎通用"不得抹平不同 unit/不同动作的治理风险
  # （段的三轴 gate 即 segment adapter 的 actions 实现）

UnitEvaluationManifest:           # 实例级（per 具体 unit，unit 域内自维护、versioned、独立迭代）
  unitRef: {unitType, unitId}
  objectives: []                  # 该 unit 挂靠的 objectives
  conditions: []                  # 该 unit 相关的外置 condition 集
  eval_model_refs: []             # 引用的评估模型
  version / changelog             # "定制逻辑本身可迭代"的承载
# 引擎（观察面 post-hook / 求值器 / 指标聚合 / verdict 规则 / 触发 / console 组件）对两层内容零感知，
# 只消费接口。新增 unit 类型 = 写 adapter + manifests，不改引擎、不改公共 schema（attributions 用 unitRefs）。
```

**③ 语义通道收敛 runway**（渐进，非 V1 大合并——防 scope 爆炸）：`propose_profile_update`（画像）/ F245 摩擦 marker / `report_harness_signal`（本设计）三者**生命周期同构**——"语义观察 → 结构化事件 → 审批/消费域"；**传输机制各异，不混称**（v2.2 修正 sol R10 P2-3：画像 = callback proposal + operator 审批；摩擦 marker = 消息文本标记 + pull adapter 回扫提取（paw-feel-adapter）；harness = MCP await-append 直写）。V1 只做**生命周期模式对齐**（provenance/anchor/审批形态，T-C 为模板）；后续 friction adapter 对接统一 deviation 面（原 spec Phase B 承诺不变），画像通道最后评估是否并轨。**方向：相关语义上报逐渐往统一架构收敛，而不是每个场景一套。**

## 5. 既有资产处置表（诚实盘点）

| 资产 | 处置 | 理由 |
|------|------|------|
| InjectionTrace 注入账 | **保留** | 分母基础设施，objective 模型直接用 |
| **Event Memory（EventMemoryStore）** | **保留并复用**（v1.6 新盘入，sol R4 P1-3 抓获此前漏盘）——magic-word single source of truth（归一裁定 2026-06-06），EM-8 指标 = 其只读投影；DeviationEventLog 不双写 | P4 单一真相源；owner-scoped 唯一键 + dead-letter 现成 |
| GuardRejectionEventLog 存储层（ZSET+queryWindow） | **演进为 `GuardDecisionFact` 原始事实面**（观察面 P4：可回放、供分母；形态 ZSET+时间窗保留）——不与 DeviationEventLog 合并（v1.5 修正 sol R3 P1-1：§4.2/§5 曾互相矛盾）；存量 7 天 events 不迁移自然到期 | fact 是观察面、deviation 是求值分子，合并丢回放与分母 |
| DeviationEventLog | **新建**（求值结果账本：**两写入支** union → §3.1；magic word 为 Event Memory 只读投影不入此账 → T-B；TTL=0）——无兼容包袱（operator 授权） | 与 fact 层分离的分子账本 |
| 阈值升级钩子 | **保留** | 挂账本不挂业务代码，模式正确，改挂 DeviationEventLog |
| hold_ball / A2A 两处硬编码 emit | **承认 hotfix，迁移后删除** | 迁入 P4/P3 通用求值器 |
| 判定引擎 | **直接重构** per-objective（不留 per-segment 兼容路径）：ObjectiveJudgment + 段明细，段分类学感知，"测不到≠alive"修正 | 同上无兼容约束 |
| 生命线 console + 审批执行器 + override store | **保留** | governance 执行面与呈现面，数据源换 join |
| ledger YAML schema（锅面向） | **废弃** | 零实例；被 objective / condition / segment 三实体模型取代 |
| eval:harness-ledger 域注册 | **保留** | 域不变，评估单位换 objective |

## 6. 实施切片（vertical slice V1→V4，sol 方案；v1.4 指标与机制修正已入）

> 排序判据 v1.3 修正：v1.2 判据（"结构信号可回放"）被 sol 证伪一半——**路由诊断与 guard 命中此刻也在不可逆丢失**（不落库/7 天 TTL）。语义与结构两侧都在漏 → 第一切片必须是**一条端到端可验真的垂直切片**同时堵两个口，先证明"非零采集 + 可信分母"，再扩面。不先建空账本。

1. **切片 V1（vertical slice，第一优先；v1.7 全部引用规范表，本节零细节复述）**：
   - `RoutingDecisionFact`：tokenization / outcome / eligibility / **parser 改造全集** → **T-A（§3.4）**；持久化 = 权威记录一次写 + 投影异步派生 → §4.5.1；ownerUserId scope → T-C
   - `DeviationEventLog`：schema → §3.1；TTL=0 / 分页 / Lua 原子 / exact 单归属校验 / owner scope 进索引与查询授权 → §3.1 存储规格 + T-C
   - 标注工具 `cat_cafe_report_harness_signal`：契约全集 → **T-C（§3.6）**
   - **只上线 2 项 active-V1 指标**：@ 解析成功率（per parserMode → T-A）+ magic word 词面出现数（raw 口径 → T-B）；void_ack 率 blocked-on-fact（V2 terminal fact）；group mention 退出 V1
   - Console：分子 + 分母 + join anchor + **collection-health（时间桶 heartbeat 覆盖率）** 全展示
   - AC（拆分口径见 §4.5）：真实窗口非零采集 + magic word 30s 投影可见 + manual 确认后 30s 入账 + backfill LI-001~006
2. **切片 V2**：condition registry + 求值器双模式泛化（P1 adapter 抽象成 per-plane 模式）+ EM-2/EM-3 可证实指标接入（hold 429 率 / 签名缺失率）+ P3 wake-outcome fact 补齐
3. **切片 V3**：判定引擎 per-objective 重构（无兼容路径）+ 两处硬编码 emit 迁移删除 + producer health 全面接入 → AC：hold_ball routes 无任何 F257 代码
4. **切片 V4**：46 段分类学 + objective 归组全量落账（渐进）+ 新段未挂 objective 的 CI lint + 其余 EM blocked-on-fact 逐个解锁

## 7. 已决事项（operator 2026-07-17 03:51 授权自决后落账）

1. **口径**：正文按实测 46 hooks（可复算）；SOP 6 步独立对象走 eval:sop 委托（KD-8），"52" 不再作为工作口径
2. **归组粒度**：8 objectives 定稿。OBJ-7/8 判据补充——OBJ-7 = 运行时现场供给（每 turn 变化：队友/世界/导航/模式，背离修数据源）；OBJ-8 = 静态治理与偏好供给（低频变化：宪法/花名册/铲屎官参考，背离修内容）
3. **切片顺序**：~~2→1→3→4（v1.2）~~ → **v1.3 起改为 vertical slice V1→V4（§6）**——v1.2 判据"结构信号可回放"被 sol 证伪（路由诊断/guard 命中当下也在丢），保留此改判痕迹防止旧顺序被引用
4. **兼容性**：零兼容包袱（operator 授权），存储/引擎/schema 直接换代，历史 guard events 不迁移
5. **sol 落地性 review R1→R5（05:01/05:16/05:26/05:34/05:49）**：五轮 BLOCK 全收零 pushback。五轮根因收敛为两条：**A 多处复述 = 残留永生**（R2/R3/R5 三犯同型——修法 = §0 文档架构规则：规范位唯四 + 全文引用化）；**B exact 声称先于代码验证**（R1/R4/R5 三犯——修法 = 规范表从 parser/写路径代码 derive，每行带锚点 + 现 parser 可产性列）。R5 增量：解析分母需 decision table + parser 改造①②；magic word live 路径实测强制 confidence:high → 指标降 raw 口径；auth scope 定死 ownerUserId；MULTI≠rollback → 权威记录一次写。**v1.7 = 46 协议第 5 轮系统性重整产物。后续 review 循环状态一律以本文件 status 行为唯一真相（本历史行不再逐轮更新）；解除 BLOCK 才进切片 V1**
6. **P2 ToolEventLog 留存策略**（7 天 → ? ）：EM-5 跨窗评估的前置，进 OQ 随切片 V2 决
