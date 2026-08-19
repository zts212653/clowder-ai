---
title: "Clowder AI Architecture Lineage — 从 thread 到 feature 的架构谱系"
doc_kind: architecture
description: "Clowder AI 核心架构主题的来源谱系：讨论种子、设计文档、feature 落点、现状总览之间如何连接。"
feature_ids: [F064, F086, F088, F102, F124, F128, F132, F167, F192, F200, F221, F222, F223, F231, F234, F245, F248, F253, F254, F256]
related_features: [F050, F055, F143, F148, F159, F161, F173, F188, F193, F208, F209, F227, F229, F236, F241, F242, F243, F246, F255]
topics: [architecture-lineage, source-map, provenance, teamact, memory, eval, friction, autoharness, taste, freshness, governance, transport, im-integration, connector]
created: 2026-07-01
status: reviewed-draft
author: "Maine Coon/GPT-5.5"
---

# Clowder AI Architecture Lineage — 从 thread 到 feature 的架构谱系

> 本文不是又一份 subsystem overview。
>
> [collaboration-landscape.md](./collaboration-landscape.md) / [memory-system-overview.md](./memory-system-overview.md) / [eval-system-overview.md](./eval-system-overview.md) 讲的是 **现在系统长什么样**。
>
> 本文讲的是：这些架构主题 **为什么会长成这样**，从哪些 thread / discussion / draft 里长出来，后来落到了哪些 feature / ADR / skill / eval domain。

## 0. Scope

本文覆盖的是 **全量架构主题谱系**，不是从 longform-003 才开始，也不是全量聊天流水账。

- **不是 longform-003 子索引**：longform-003 是 PoE / AutoHarness / Agent 3.0 叙事线的关键汇流点，但 TeamAct、memory、routing、eval 等主题的源头更早。
- **不是 feature changelog**：feature doc 讲单个 F 号的 Why/What/AC，本文只讲主题之间的继承关系。
- **不是 thread 全文摘要**：只收录已经影响 feature / ADR / L0 / skill / eval 的讨论种子。
- **不是实现细节文档**：实现细节链接到现有架构文档和 feature spec。

推荐阅读方式：

1. 想知道系统现在怎么工作：先读 `docs/architecture/*overview.md`。
2. 想知道为什么这些系统会这样分层、这些 feature 为什么存在：读本文。
3. 想追某一条线的实现：从本文的 feature list 跳到对应 F 号。

## 1. Evidence Strength Legend

谱系图必须防止过度叙事。本文用三档证据强度：

| 等级 | 含义 | 可以怎么说 |
|---|---|---|
| **T0 Direct inheritance** | feature / doc 明确复用该术语、链接该设计、或在 Why 中直接继承该问题 | "直接长出来" |
| **T1 Strong inheritance** | 没有显式写"来自 X"，但术语、结构、问题切面明显延续 | "强继承 / 同一条线" |
| **T2 Thematic resonance** | 概念同构或互相支撑，但不能证明直接来源 | "同构 / 共振" |

后续补 source anchor 时，T0 应优先补 thread id / discussion path / commit / PR；T1/T2 可以只保留设计路径和 current-state doc。

## 2. Map Of Maps

现有架构文档各自负责一个当前视角；本文只做来源谱系，不重复它们的实现内容。

| 当前文档 | 它回答什么 | 本文怎么使用 |
|---|---|---|
| [collaboration-landscape.md](./collaboration-landscape.md) | 人 & 猫 & 猫的协同系统怎么流动 | TeamAct / ball custody / harness metabolism 的当前总图 |
| [user-journeys.md](./user-journeys.md) | operator和猫猫各自经历什么 | 把架构谱系落到体验结果 |
| [at-mention-routing-system.md](./at-mention-routing-system.md) | `@` 路由的机械层和判断层 | Collaboration 主题的实现入口 |
| [memory-system-overview.md](./memory-system-overview.md) | 记忆系统六层：truth source 到消费者 | Memory / taste / profile / recall 主题的当前总图 |
| [retrieval-pipeline-deep-dive.md](./retrieval-pipeline-deep-dive.md) | search query 到 top-K 的 14 层管线 | Retrieval 主题的实现细节 |
| [eval-system-overview.md](./eval-system-overview.md) | production trace 到 verdict handoff 的 eval 控制面 | Eval / friction / QC 主题的当前总图 |
| [ownership/cells/transport.md](./ownership/cells/transport.md) | 平台/设备 transport 规范化后的消息入口、出口与对话语义 | Transport / IM integration 主题的当前所有权边界 |

## 3. Executive Lineage Map

| 架构主题 | 主要种子 | 设计沉淀 | Feature 落点 | 当前总览 | 强度 |
|---|---|---|---|---|---|
| Collaboration / TeamAct / Ball Custody | 从人肉路由器到自主传球、出口检查、乒乓检测 | TeamAct longform、routing docs | F064, F086, F128, F167, F254 | collaboration / @ routing / user journeys | T0/T1 |
| Memory / Recall / Retrieval | 记忆不是摘要，是可审计 recall + 原文下钻 | memory overviews、retrieval deep dive、memory search strategy discussion | F102, F188, F200, F209, F236, F256 | memory / retrieval | T0 |
| Eval / Friction / Harness Metabolism | eval 四层、五类摩擦传感器、code-as-harness | F192 audit、ADR-038 staging、code-as-harness skill | F192, F222, F245, F248, F253 | eval overview | T0 |
| AutoHarness / PoE / FDE Compression | Agent 3.0、真实轨迹学习、L1-L5、FDE 三段压缩 | longform-003、Huawei PPT、Anthropic takeaways | F223, F234, F245, F256 | collaboration / eval / memory cross-cut | T1 |
| Taste / Profile / Relationship | taste 在空气里，缺目录和海马体 | taste memory design、longform-003 | F221, F231, F227, F255 | memory overview / user journeys | T0/T1 |
| Freshness / Execution Context / Side-effect Gate | 猫发消息时世界可能已经变了；运行模式能力不等于授权 | ADR-038 staging、Raft teardown | F167, F254, F246 | collaboration / user journeys | T0/T1 |
| Capability Surface / Action Surfaces | 能力存在不等于猫想得起、调得稳、用户看得到 | capability wakeup index、F223 inventory | F223, F243, F229 | collaboration / memory consumers | T0 |
| Governance / Source Hygiene / QC | 自进化要防作弊、分权、可回滚、可审计 | ADR-031、source-audit、QC discussion | F234, F245, F248, F253 | eval overview / collaboration | T1 |
| Transport / IM Integration / Message Normalization | 外部 IM、设备输入、agent runtime 都必须收口到可审计的 thread/message 语义 | F088 gateway、F124/F088 unification、transport ownership cell | F088, F124, F132 | transport ownership / CLI integration | T0/T1 |

## 4. Theme Cards

### A. Collaboration / TeamAct / Ball Custody

**Core question**: 多 agent 不是"能互相说话"就够了，关键是球在哪里、谁能接、什么时候该停。

**Seed**

- 早期人肉路由器经验：三只猫各自能干，但不会传球。
- `@` 从普通提及变成路由指令；行首 `@handle` 是机械路由边界。
- "不传球"、"过度传球"、"虚空传球"、"角色错配"等 failure mode 逐步浮现。

**Design artifacts**

- longform-003-teamact-evolution-v0.md
- [at-mention-routing-system.md](./at-mention-routing-system.md)
- [collaboration-landscape.md](./collaboration-landscape.md)

**Feature outcomes**

| Feature | Role in lineage |
|---|---|
| **F064** | exit check：每条消息结束前判断下一步谁动 |
| **F086** | multi-mention / 多猫并行协调 |
| **F128** | propose thread：把新工作从聊天分流到可追踪 thread |
| **F167** | hold_ball / ping-pong / stale hold / 路由守卫 |
| **F208** | 猫能力画像，用于路由与 review 分工 |
| **F254** | freshness gate，防止猫在世界变化后发过时副作用 |

**Current state docs**

- [collaboration-landscape.md](./collaboration-landscape.md)
- [at-mention-routing-system.md](./at-mention-routing-system.md)
- [user-journeys.md](./user-journeys.md)

**Evidence strength**: T0 for TeamAct / route guard / freshness line; T1 for broader culture framing.

**Open gaps**

- F233 ball custody dashboard 仍是 user journey 中的 partial proxy。
- Freshness / side-effect gate 还在推进，尚未覆盖所有通知和 ack journey。

### B. Memory / Recall / Retrieval

**Core question**: 猫每次醒来都是新 invocation；记忆系统必须让历史在正确时刻重新变成判断力，而不是塞一段"我记得"摘要。

**Seed**

- 旧决策、thread、feature、taste 信号散落；压缩后容易丢失判断上下文。
- "摘要是入口，原文是证据"成为 recall 纪律。
- operator用场景驱动 prompting 激活了猫搜不到的关联，推动"搜索策略能不能沉淀成 harness"。

**Design artifacts**

- [memory-system-overview.md](./memory-system-overview.md)
- [retrieval-pipeline-deep-dive.md](./retrieval-pipeline-deep-dive.md)

**Feature outcomes**

| Feature | Role in lineage |
|---|---|
| **F102** | evidence store / search_evidence 底座 |
| **F188** | library stewardship / graph_resolve / list_recent |
| **F200** | recall consumption telemetry，记录猫是否真的读了/用了结果 |
| **F209** | passage-level recall、entity anchor、typed drill-down |
| **F236** | anchor-first preview + bounded drill |
| **F242** | convention graph，发现 doc-code / skill-tool 关系 |
| **F256** | memory search strategy evolution：把 prompting 策略沉淀成 hook / hints / eval |

**Current state docs**

- [memory-system-overview.md](./memory-system-overview.md)
- [retrieval-pipeline-deep-dive.md](./retrieval-pipeline-deep-dive.md)

**Evidence strength**: T0. F256 的 Why 明确来自operator prompting 策略，且直接把 "pipeline = 水管，strategy = 往哪浇水" 收成 feature。

**Open gaps**

- F256 Phase C/D 仍在推进：capsule/l0/prompt-injection extractor 与 30 天 dogfood eval 未完成。
- 记忆系统现状文档已成形，但 lineage source anchor 还可继续补 thread 原话。

### C. Eval / Friction / Harness Metabolism

**Core question**: Clowder AI 评的不是模型分数，而是 harness 是否还适配真实协作；摩擦不是吐槽，是传感器。

**Seed**

- F192 eval 覆盖审计把 eval 拆成机械正确性、路由/决策、任务交付、链路效率等层。
- 讨论中把信号和真值拆开：中断动作、理由、世界结果、聚合 proxy、缺席摩擦。
- code-as-harness 形成路径：重复摩擦 -> 搜证据确认 -> 修 harness 或建 harness。

**Design artifacts**

- [eval-system-overview.md](./eval-system-overview.md)
- `cat-cafe-skills/code-as-harness/SKILL.md`
- ADR-038 staging items: 摩擦上报、摩擦检测反射、运行模式能力、freshness notice。

**Feature outcomes**

| Feature | Role in lineage |
|---|---|
| **F192** | harness-eval control plane / task outcome / verdict handoff |
| **F222** | frustration auto-issue：把负体验变成结构化反馈 |
| **F245** | eval:friction：统一爪感差、cancel、F222、eval-domain 摩擦 |
| **F248** | eval hub readability：让 operator 看懂 eval 观测什么 |
| **F253** | QC loop：把质量门禁接入 eval domain |
| **F234** | harness sunset：让 harness 也有退役证据 |

**Current state docs**

- [eval-system-overview.md](./eval-system-overview.md)
- [collaboration-landscape.md](./collaboration-landscape.md) 的 harness metabolism 元轴

**Evidence strength**: T0. F245 的 Why 直接列出四个散落摩擦通道，并把五类摩擦传感器作为现状基线。

**Open gaps**

- Silent failure / active probing 仍是边界：五类传感器能抓显性/聚合摩擦，但用户没察觉的错误需要主动探测与 provenance 暴露。
- Eval Hub 可读性仍在推进，Phase B/D 尚未完成。

### D. AutoHarness / PoE / FDE Compression

**Core question**: Agent 环境如何从静态编排走向自进化；企业部署 AI 的 FDE 成本如何被真实轨迹学习和 harness 自修复压缩。

**Seed**

- Longform-003 把 PoE / Agent 3.0 / auto-harness / 真实轨迹学习串成对外叙事。
- 华为 PPT 把 AutoHarness 收成 L1-L5 责任迁移轴：从用户/专家负责，到受控 L3，再到长期 L4/L5。
- Anthropic 文章讨论后，"环境 > 模型"、skill 衰退、correction harvesting、Scenario 2 进入 demo/pitch 论据。

**Design artifacts**

- longform-003-seed-poe-vision.md
- ppt-huawei-pitch-v0.md
- agent-experience-and-self-evolution-synthesis.md
- 2026-06-05-anthropic-june-takeaways.md

**Feature outcomes**

| Feature | Role in lineage |
|---|---|
| **F223** | capability surface registry：能力从隐藏工具变成可发现、可执行、可验证的 surface |
| **F234** | harness sunset：自进化不只会加，也要会删 |
| **F245** | friction rollup：把真实摩擦变成 harness 修复入口 |
| **F256** | memory search strategy evolution：把用户 prompting 策略沉淀成猫的搜索 harness |

**Current state docs**

- 没有单独 "AutoHarness overview"；目前分布在 PPT / collaboration / eval / memory 三条线。

**Evidence strength**: T1. longform-003 是强汇流点，但多数 feature 不应被说成"都从 longform-003 直接长出"；更准确是同一组架构判断在不同 subsystem 落地。

**Open gaps**

- AutoHarness 仍缺一篇稳定的 architecture overview；PPT 是路演稿，不是系统真相源。
- L1-L5 对标产品仍需要 source-audit，不能把候选池当正式 claim。

### E. Taste / Profile / Relationship

**Core question**: 个性化不是调更多参数，而是让 taste、profile、relationship 进入可检索、可审计、可演化的记忆 lane。

**Seed**

- 5.31 Taste Memory 设计：taste memory 缺的不是再存更多，而是共享 Taste Index。
- 6.01 taste 实验证明：本地猫因为环境和反馈空气层，更有 You 味。
- Longform-003 把 taste 放进 PoE：关系和品味是 Agent 3.0 的护城河。

**Design artifacts**

- longform-003-seed-poe-vision.md
- [memory-system-overview.md](./memory-system-overview.md) 的 Specialized Memory Lanes

**Feature outcomes**

| Feature | Role in lineage |
|---|---|
| **F221** | Taste Lane：建立 `docs/taste/` evidence lane 和 taste path |
| **F231** | User Profile Capsule：让猫醒来第一眼认识用户与关系 |
| **F227** | Event memory：记录认知转折、magic word、aha/resolution |
| **F255** | Auto Dream：给 profile/event/taste 管道通水的目标旅程 |

**Current state docs**

- [memory-system-overview.md](./memory-system-overview.md)
- [user-journeys.md](./user-journeys.md)

**Evidence strength**: T0 for F221; T1 for broader relationship architecture.

**Open gaps**

- F255 仍在 spec/目标旅程阶段；"无目的翻看"的陪伴 surface 还没成为日常。
- Taste 与 profile 的边界需要持续守住：taste 是怎么协作/验收，profile 是用户是谁和关系如何。

### F. Freshness / Execution Context / Side-effect Gate

**Core question**: 猫在一次 invocation 中思考几分钟，世界可能已经变化；运行模式能力不能靠自我感觉脑补。

**Seed**

- A2A/hold_ball 讨论暴露：等待外部条件、结构化回调、定时器、事件驱动容易混淆。
- Raft teardown 后明确：freshness gate 应在 MCP tool 层，不依赖 agent 感知。
- F234 设计增量沉淀了 execution context / runtime capability matrix，进入 ADR-038 staging。

**Design artifacts**

- ADR-038 L0 staging items
- F254 Raft teardown lineage

**Feature outcomes**

| Feature | Role in lineage |
|---|---|
| **F167** | hold lifecycle / external wait / ping-pong / ball custody guard |
| **F254** | side-effect freshness gate：post_message 前检查 unseen message |
| **F246** | approval hub：把散落审批聚合到 operator 可见 surface |

**Current state docs**

- [collaboration-landscape.md](./collaboration-landscape.md)
- [user-journeys.md](./user-journeys.md)

**Evidence strength**: T0/T1. F254 Why 直接来自 "-p 模式如何感知世界变化"问题；execution context item 已作为 ADR-038 staging 注入。

**Open gaps**

- F254 D1.2 read/ack journey 仍 queued；content-free notice 的 full lifecycle 还需继续闭环。

### G. Capability Surface / Productized Agent Abilities

**Core question**: 家里能力再多，如果猫想不起、调用不稳、用户看不到，就等于没有。

**Seed**

- workspace navigator / browser preview / rich messaging 已存在，但猫经常靠手写 `curl`、猜端口或完全想不起来。
- capability-wakeup eval 只能衡量 miss，不能定义执行面；需要 registry 管 Trigger / Execution / Verification / Eval。

**Design artifacts**

- [F223 capability surface inventory](../features/assets/F223/capability-surface-inventory.md)
- `cat-cafe-skills/refs/capability-wakeup-index.md`
- [collaboration-landscape.md](./collaboration-landscape.md) 的 consumer/surface 视角

**Feature outcomes**

| Feature | Role in lineage |
|---|---|
| **F223** | Capability Surface Registry：统一 Trigger / Execution / Verification / Eval |
| **F243** | docs discovery profile：让 docs/features 等 source 更可发现 |
| **F229** | Cat Ball / concierge surface：前台猫入口与能力发现 |

**Current state docs**

- [collaboration-landscape.md](./collaboration-landscape.md)
- [memory-system-overview.md](./memory-system-overview.md) 的 Consumers + Product Surfaces

**Evidence strength**: T0 for F223. Its Why 明确来自 2026-06-03 workspace-navigator 现场摩擦。

**Open gaps**

- Registry 条目和 capability tips 还需要持续由 F192/F245 反馈校正。
- 新能力进入 Tier 1 时，仍要守 "能力 surface 不是全都 MCP 化" 的 Decision Ladder。

### H. Governance / Source Hygiene / QC / Anti-cheating

**Core question**: 自进化最怕两件事：为了指标作弊，和把软约定误当硬保障。Clowder AI 的答案是分权、证据、回滚、eval 复验。

**Seed**

- ADR-031 把 harness 落地拆成 soft / hard / eval 三层。
- DGM / self-evolution 讨论提醒：能改自己的 agent 可能 reward hack，所以评估与执行必须分权。
- Source-audit 纪律反复强调：外部 claim 必须区分一手/二手、产品/论文/营销、时效和利益冲突。

**Design artifacts**

- ADR-031 source-audit / harness 三层
- ADR-038 L0 staging protocol
- F234 harness sunset
- [F253 QC loop](../features/F253-qc-loop.md)

**Feature outcomes**

| Feature | Role in lineage |
|---|---|
| **F234** | sunset ablation / three-power separation / sandbox boundary |
| **F245** | friction eval soft+hard+eval 三层闭环 |
| **F248** | human-readable eval，防止 verdict 对 operator 不可见 |
| **F253** | QC loop：自动触发可以，授权不能自动 |

**Current state docs**

- [eval-system-overview.md](./eval-system-overview.md)
- [collaboration-landscape.md](./collaboration-landscape.md)

**Evidence strength**: T1. Governance 是多个 theme 的横切层，不应归因到单一 thread。

**Open gaps**

- Source-audit 仍依赖猫判断触发，高风险对标产品应补 source ledger。
- F234 deferred，sunset 的真实 ablation 还没跑出第一发完整闭环。

### I. Transport / IM Integration / Message Normalization

**Core question**: Clowder AI 可以接入很多外部入口，但系统真相源必须仍是 thread/message；平台协议、设备输入、agent runtime 不能把业务语义分叉到各自私有管道。

**Seed**

- F088 把飞书 / Telegram 接入从"各平台各写业务逻辑"收口成 ConnectorRouter + MessageEnvelope + outbound hooks。
- F124/F088 架构归一讨论明确：统一的是规范化后的消息，不是原始 device / connector transport。
- 外部 agent runtime 接入线（F050/F143/F241）把 CLI / A2A / ACP 等 carrier 和 Clowder AI 内部协作语义分层。

**Design artifacts**

- [F088 Multi-Platform Chat Gateway](../features/F088-multi-platform-chat-gateway.md)
- F124/F088 architecture unification draft
- [Transport Plane ownership cell](./ownership/cells/transport.md)
- [F050 External Agent Onboarding](../features/F050-a2a-external-agent-onboarding.md)
- [F241 Agent Provider Plugin](../features/F241-agent-provider-plugin.md)

**Feature outcomes**

| Feature | Role in lineage |
|---|---|
| **F088** | IM gateway 公共层：connector adapter 只管平台协议，业务语义收口到 router / binding / formatter / hooks |
| **F124** | 第一方设备输入边界：Watch/iOS 等 raw transport 规范化后进入 canonical message，不强行复用第三方 connector 形状 |
| **F132** | DingTalk / WeCom 扩展验证：新企业 IM 复用 F088 公共层，而不是重建平行网关 |

**Current state docs**

- [Transport Plane ownership cell](./ownership/cells/transport.md)
- [cli-integration.md](./cli-integration.md)

**Evidence strength**: T0 for F088/F124/F132 transport normalization; T1 for external runtime carrier lineage, because F050/F143/F241 主要是 agent provider 接入线而不是 IM connector 本体。

**Open gaps**

- 还缺一篇独立 transport overview；当前稳定真相源是 ownership cell + feature specs。
- IM 平台能力矩阵分散在 F088/F132 assets，后续若要对外说明应先 source-audit。

## 5. Reverse Index By Feature

This table indexes `feature_ids` from the frontmatter: features where the lineage doc treats the theme as a primary architecture landing point. `related_features` are supporting or adjacent anchors; they are intentionally not duplicated here unless they become primary lineage entries in this doc.

| Feature | Primary lineage theme | Secondary themes |
|---|---|---|
| F064 | Collaboration / TeamAct | Governance |
| F086 | Collaboration / TeamAct | Capability surface |
| F088 | Transport / IM gateway | Connector normalization / External chat UX |
| F102 | Memory / Recall | Retrieval |
| F124 | Transport / Device normalization | Message core / First-party client boundary |
| F128 | Collaboration / Thread routing | AutoHarness trigger routing |
| F132 | Transport / Enterprise IM extension | Connector reuse / Platform adapters |
| F167 | Ball custody / Freshness | Eval |
| F192 | Eval control plane | Harness metabolism |
| F200 | Memory recall eval | Search strategy / Eval |
| F221 | Taste | Memory / Relationship |
| F222 | Friction | Eval / Auto-issue |
| F223 | Capability surface | AutoHarness / Eval |
| F231 | Profile / Relationship | Memory |
| F234 | Harness sunset | Governance / AutoHarness |
| F245 | Friction rollup | Eval / Code-as-harness |
| F248 | Eval readability | Human-facing governance |
| F253 | QC loop | Governance / Eval |
| F254 | Freshness gate | Ball custody / Side-effect safety |
| F256 | Search strategy evolution | Memory / AutoHarness |

## 6. What This Map Changes

This map is not just a retrospective. It changes how future architecture docs should link.

1. **New architecture docs should link both ways**:
   - current-state doc -> lineage section when the reader asks "why does this exist?"
   - lineage doc -> current-state doc when the reader asks "how does this work now?"

2. **Feature docs should name their lineage theme**:
   - Example: F245 belongs to `Eval / Friction / Harness Metabolism`, not just "harness-eval".
   - This helps future new cats know which older decisions to read.

3. **PPT / longform / external research should not become truth source by accident**:
   - PPT is pitch narrative.
   - Feature docs / ADR / architecture docs are implementation truth.
   - Research notes are external anchors with source-audit discipline.

4. **Thread seeds should be promoted only when they changed runtime shape**:
   - A clever conversation is not automatically architecture.
   - It becomes architecture when it changes feature shape, L0, ADR, skill, eval domain, or product surface.

## 7. Gaps To Fill Later

This v0 intentionally does not chase every source thread transcript. High-value next fills:

| Gap | Why it matters | Suggested next step |
|---|---|---|
| Add exact thread anchors for TeamAct early failures | T0 provenance for collaboration line | Pull from TeamAct longform source refs and thread memory |
| Add longform-003 -> AutoHarness feature matrix | Clarifies what longform-003 did and did not originate | Split AutoHarness theme into PoE / FDE / L1-L5 subcards |
| Add ADR-031/038 exact links | Governance lineage needs canonical ADR anchors | Link accepted ADR paths and staging item commits |
| Add source-audit ledger for Huawei PPT competitors | Prevent overclaim in external-facing pitch | Reuse source-audit skill before public deck |
| Add F255/F231 relationship lineage once mature | Human-cat journey still has target-state gaps | Update after F255 closes or changes scope |

## 收敛检查

1. 否决理由 -> ADR？没有。本文整理谱系，不新增架构否决。
2. 踩坑教训 -> lessons-learned？没有。没有新 failure mode，只把现有主题归档。
3. 操作规则 -> 指引文件？没有。本文建议未来链接纪律，但不新增硬规则。
