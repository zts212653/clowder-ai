---
title: "Cat Cafe Memory System Overview"
doc_kind: architecture
feature_ids: [F102, F163, F186, F188, F200, F209, F221, F227, F231, F256]
related_features: [F148, F152, F169, F229, F236, F242, F243]
topics: [memory, recall, evidence, profile, taste, event-memory, architecture]
created: 2026-06-28
status: draft-for-opus48-discussion
author: "Maine Coon/GPT-5.5"
---

# Cat Cafe 记忆系统全景

> 面向不熟悉 Cat Cafe 内部架构的工程师和新猫的系统概览。
>
> 本文回答三个问题：记忆系统解决什么问题；有哪些层；F102、F188、F200、F221、F231 等 feature 到底各管哪一段。

---

## 这个系统解决什么问题？

Cat Cafe 的猫每次醒来都是新的模型 invocation。没有外部记忆时，猫只能靠当前上下文工作，跨 session 的决策、教训、feature 关系、用户偏好和相处轨迹都会丢。

家里的记忆系统不是一个单独数据库，而是一组运行时能力：

1. **找得到**：猫能用 `search_evidence` / `graph_resolve` / `list_recent` 找到文档、thread、session、message、entity 和外部 collection。
2. **查得准**：结果必须能下钻到原文，不把摘要当真相源。
3. **不会腐烂**：知识有 authority、staleness、verification、health debt 和 consumption 信号。
4. **能养熟**：taste、user capsule、relationship primer 能让猫越来越认识这个用户，而不是只认识规则。
5. **能外派**：猫到外部项目也能冷启动、建索引、回流可泛化经验。

一句话：

> Cat Cafe 记忆系统 = truth sources + compiled indices + recall tools + governance/eval + profile/taste lanes。它维护的是猫对现实的可审计感知，不是给模型塞一段“我记得”的摘要。

---

## 分层全景

```
                         ┌──────────────────────────────┐
                         │  用户 / 猫 / 外部项目 / Hub   │
                         └──────────────┬───────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. Truth Sources                                                     │
│  docs/features, decisions, plans, lessons, discussions               │
│  thread/session transcripts, markers, private/profile, docs/taste    │
│  external collections, event memory, entity seeds                    │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. Materialization + Index                                           │
│  F102 evidence.sqlite: docs / FTS5 / vectors / passages / edges      │
│  F186 collections: project/global/library/collection federation       │
│  F152 scanners: external repo bootstrap + provenance tiers            │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  3. Recall + Drill-down                                               │
│  search_evidence: lexical / semantic / hybrid                        │
│  graph_resolve: typed evidence graph                                 │
│  list_recent: time-based browse                                      │
│  F209: passage vectors / entity anchors / typed readers / Perspective │
│  F236: anchor-first preview + bounded full drill                     │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  4. Governance + Eval                                                 │
│  F163 authority / activation / status / salience                      │
│  F188 health dashboard / graph fidelity / collection lifecycle        │
│  F200 consumption telemetry + ranking feedback                        │
│  F192 harness eval verdict loop                                       │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  5. Specialized Memory Lanes                                          │
│  F221 taste lane, F231 user capsule/profile index, F227 event memory  │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼
════════════════════════════ Consumer Boundary ═════════════════════════
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  6. Consumers + Product Surfaces                                      │
│  F148 context transport, F236 anchor-first, F229 cat ball, F243 index │
└─────────────────────────────────────────────────────────────────────┘
```

边界要点：

- **F102 是底座**：它定义 project evidence store 和检索基础设施。
- **F188 不是另一个 F102**：它让图书馆能维护、能画图、能被猫用，尤其是 `graph_resolve` / `list_recent`。
- **F200 不判断 truth**：它只记录猫是否真的读了/用了某条候选，影响 navigation utility，不提升 authority。
- **F221/F231 不是普通 feature docs**：它们是 per-user alignment 的两条 lane，前者是 taste，后者是 user/relationship profile。
- **L5/L6 分界**：F221/F231/F227 会产生或维护特定记忆，是记忆本体；F148/F236/F229/F243 主要决定记忆怎么被猫/用户使用，是消费侧。

---

## 检索管线详解

> **14 层检索管线的完整技术文档**（含每层的算法、权重参数、代码定位）见：
> [retrieval-pipeline-deep-dive.md](./retrieval-pipeline-deep-dive.md)
>
> 下面的"核心流水线"是宏观流程图，deep dive 是微观实现图。

## 核心流水线

```
产生知识
  │
  ├─ 猫/operator写入 docs、feature、ADR、discussion
  ├─ thread/session sealed 后形成 transcript / digest
  ├─ 猫主动 propose profile update / mark event
  └─ 外部项目 bootstrap scanner 产出 evidence
      │
      ▼
Materialize
  │   稳定真相源必须落到可追溯文件或 typed store
      │
      ▼
Index
  │   F102/F186/F152 scan → evidence_docs / passages / vectors / edges
      │
      ▼
Recall
  │   猫按场景选 search_evidence / graph_resolve / list_recent
      │
      ▼
Drill-down
  │   读原文窗口，不拿摘要直接当结论
      │
      ▼
Consumption + Governance
      F200 记录真实使用；F163/F188/F192 处理排序、健康、eval 和治理闭环
```

这条流水线的基本哲学是：**摘要是入口，原文是证据，治理是长期质量，猫负责判断。**

---

## Feature Map

| 层 | Feature / Doc | 状态 | 它管什么 | 不管什么 |
|---|---|---:|---|---|
| 架构决策 | ADR-020 | accepted | Conversation identity、F102 retrieval/storage、LSM summary、truth source 分层 | 后续 F188/F200/F231 的专门闭环 |
| 存储检索底座 | F102 Memory Adapter | done | `evidence.sqlite`、FTS5/vector、`IEvidenceStore`、`search_evidence`、markers/materialization 契约 | 图书馆联邦、健康治理、消费反馈的完整闭环 |
| 记忆熵减 | F163 Memory Entropy Reduction | done | authority/activation/status、知识生命周期、salience gating、非替代式压缩 | 具体 recall tool UX、图书馆 collection lifecycle |
| 图书馆联邦 | F186 Library Memory Architecture | done | Collection、LibraryResolver、跨域检索、安全绑定、Memory Lens/Typed Graph | 日常健康债治理和 agent-facing tool adoption |
| 管护工具链 | F188 Library Stewardship | done | rebuild、health dashboard、graph fidelity、`graph_resolve`、`list_recent`、collection lifecycle | 原始 evidence store 的核心 schema |
| 召回评估 | F200 Memory Recall Eval | in-progress | RecallEvent、consumed/read/use telemetry、consumption-weighted ranking、trajectory | truth/authority 判断；不能因为常读就证明为真 |
| 召回体验优化 | F209 Evidence Recall Optimization | done | passage semantic recall、entity anchor、typed drill-down readers、Perspective live query plans | 摘要记忆和 topic classifier |
| 外派记忆 | F152 Expedition Memory | in-progress | 外部项目 scanner/bootstrap、项目概况、跨项目经验回流 | F102 之外的第二套记忆 |
| 运行时反射愿景 | F169 Agent Memory Reflex | done as vision | memory spotlight、task-scoped salience gating 的愿景；实现分派到 F148/F163 | 持久 compiled wiki；已被 operator 关闭 |
| Taste lane | F221 Taste Lane | done | `docs/taste/` index/vignettes，记“怎么干活让 operator 满意”的品味信号 | 用户本人画像；spec 明确“这不是用户画像” |
| Event memory | F227 Event Memory | in-progress | cognitive-state-transition 事件、magic-word lane、teleport、未来 `mark_event` | 用分类器猜 aha；no-classifier 红线 |
| User profile | F231 User Profile Capsule | in-progress | L0 `{{USER_CAPSULE}}`、四层 capsule/primer、profile update proposal、profile dynamic recall 方向 | 通用 dream lane；Phase C 是 bounded profile consolidation pilot |
| 上下文传输消费侧 | F148 Hierarchical Context Transport | done | cold mention context packet、tombstone、retrieval hints、navigation header、truth source 指针 | 记忆库本体；它是 context transport consumer |
| Anchor-first | F236 Anchor-First Context Entry | core-complete | preview + bounded drill、cc Read/Grep/Glob mode、anchor telemetry | 记忆语义本体；它控制返回侧 token 预算和下钻 |
| Docs discovery | F243 Docs Discovery Profile | spec | `docs/features` generated index/description/profile lint 的源头可发现性 | 现有 F102/F186 检索内核，不改 |
| 搜索策略进化 | F256 Memory Search Strategy Evolution | active | session hook 策略注入、nudge skill link、expansion hints 投影（Phase B）、doc-code 桥 extractor（Phase C）、eval 闭环（Phase D） | 14 层检索管线本身；它管"猫拿到 query 后第一步做什么"，不改管线内部排序 |
| 前台猫入口 | F229 Cat Ball Concierge | in-progress | 用户侧功能发现、记忆检索、teleport、前台分诊和常驻 surface | 记忆存储/治理本体；它消费记忆能力 |

---

## 六种“记忆”不要混

| 名称 | 主体 | 代表载体 | 用法 |
|---|---|---|---|
| Project evidence | 项目事实、决策、spec、讨论沉淀 | `docs/**/*.md` + `evidence.sqlite` | 猫查“这个 feature/ADR/决策是什么” |
| Thread/session memory | 某个 thread/session 的对话和工具轨迹 | transcripts、digests、session chain | 猫查“刚才/上次在这个 thread 发生了什么” |
| Library memory | 跨项目/跨 domain 的 collection | F186 collections | 猫跨域查全局方法论、外部项目资料 |
| Taste memory | operator 的工作品味、验收标准、关系姿态 | `docs/taste/` vignettes | 猫做输出风格和协作方式判断 |
| User/profile memory | 用户是谁、关系如何、各猫与用户的相处轨迹 | `private/profile/` capsule/primer | 猫醒来第一眼认识主人，必要时动态 recall |
| Event memory | 认知转折点、拉闸、aha、resolution 链 | F227 event store/timeline | 猫/operator回溯“哪次被纠正、长出了什么能力” |

混淆这些层会导致错误方案：

- 把 taste 当 user profile，会只学会“怎么交作业”，但不知道“这是谁”。
- 把 summary 当 truth，会把压缩产物当事实。
- 把 F200 consumption 当 authority，会让“常被读”误变成“是真的”。
- 把 F231 profile update 当 dream lane，会绕过 bounded pilot 和 no-classifier 红线。

---

## Auto Dream 与现有地基

当前 2026-06-28 讨论里的 “auto dream / 猫猫日记” 不该从零造 memory stack。它更像是把几条已有 lane 接起来：

1. **输入材料**：thread/session 留痕、F200 consumed anchors、F227 events、F221 taste vignettes、F231 profile proposals、recent feature/doc changes。
2. **动作形态**：猫站在“气泡”里读留痕、画线、写日记；这是异步 Provoke，不是实时打断。
3. **画像副产品**：日记里出现的稳定观察进入 F231 profile proposal；taste 场景进入 F221 vignette；认知转折进入 F227 mark_event。
4. **治理边界**：系统可以给候选和 provenance，不能用后台 classifier 静默判断“这就是关系信号”。

所以 auto dream 的第一性原理表达是：

> Dream group = profile/taste/event lanes 的异步 consolidation surface。它给 F231 闲置的养熟循环通水，但不替代 F102/F188/F200，也不绕过 F227/F231 的 no-classifier 边界。

换句话说：**六种记忆是名词，dream 是动词**。dream 本身不应成为第七种记忆；如果后续独立立项，它 owns 的应是触发逻辑、产品 surface 和 alignment eval，而不是新的 truth source 或新的 memory lane。

---

## 当前缺口

1. **F231 adoption 仍是硬问题**  
   F231 机制全绿，但历史上出现过“C1 merged 2 天零有机使用”和 8 天 `profile_update.proposed = 0`。后续已用 L6 wakeup 具体化 + post-compact nudge 修，但 auto dream 若要承担“通水引擎”，必须把 organic proposal rate 纳入 eval。

2. **记忆系统地图缺少 machine-readable owner view**  
   本文先给人读；真正的下一步可以是 feature graph / ownership map 上给 memory cell 输出一个 machine-readable index，减少“F186/F188 文件名错认”。

3. **F243 还未落地**
   `docs/features` 仍是平铺文件堆；本文是手写概览，不能替代 generated feature index。F243 close 后，本概览应链接到 generated index 而不是手工维护所有 F 号。

4. **F200 与 alignment eval 是两维**
   F200 已能追踪 recall utility：搜到、读了、用了。但 taste/profile/event/dream 还需要 alignment correctness：学对了没、后续有没有被 override、reaction 是拍扁还是戳破停留。不要把第二维硬塞进 F200；dream feature 若独立立项，应显式背这一维 eval。

5. **搜索策略层缺失（F256 正在解决）**  
   14 层管线解决”水管通不通”，但”往哪浇水”一直没有系统化。operator发现自己的 prompting 策略（场景驱动渐进式激活）可沉淀为猫的搜索策略。F256 Phase A 已上线 session hook 策略注入 + nudge skill link（2026-06-29 merged），Phase B-D 将逐步补 expansion hints 投影、doc-code 桥 extractor 和 eval 闭环。

6. **用户侧入口仍在 F229**  
   猫有三入口 recall，operator仍主要靠猫猫球未来封装。F229 的”金鱼的记忆”场景是记忆系统从猫侧能力变成用户侧产品的关键。

---

## 阅读顺序

如果你只想快速接手：

1. 先读 ADR-020 和 F102，理解 truth source / compiled index / search_evidence。
2. 再读 F188 Phase F 和 F209，理解三入口、graph、recent、message drill-down。
3. 然后读 F163/F200，理解“为什么不能只看搜索结果排序”。
4. 最后按任务读 specialized lane：
   - 做用户画像 / dream：F221 + F231 + F227 dream-consolidation research
   - 做外派项目：F152 + F186
   - 做前台猫 recall：F229 + F236 + F243

---

## 给 48 继续讨论的靶点

这份稿子里我刻意保留三个可打点：

1. **L6 是否还要拆图**：本文已把本体 L1-5 和消费侧 L6 分开，但仍放一张图。后续若变复杂，可以拆成 core memory map + consumer/surface map。
2. **auto dream 是否独立 feature**：本文把 dream 放成 consolidation surface，而不是新 memory lane。若要独立立项，它需要 operator signoff，并声明继承 F221/F231/F227 的写入通道和 no-classifier 边界。
3. **alignment eval 指标**：profile proposal、taste vignette、mark_event、Provoke reaction 的 correctness 指标还没展开，适合作为 dream feature Decision Packet 的核心评估条款。

---

## 主要真相源

- [ADR-020: F102 Memory System Architecture](../decisions/020-f102-memory-system-architecture.md)
- [F102 Memory Adapter Refactor](../features/F102-memory-adapter-refactor.md)
- [F163 Memory Entropy Reduction](../features/F163-memory-entropy-reduction.md)
- [F186 Library Memory Architecture](../features/F186-library-memory-architecture.md)
- [F188 Library Stewardship](../features/F188-library-stewardship.md)
- [F200 Memory Recall Eval](../features/F200-memory-recall-eval.md)
- [F209 Evidence Recall Optimization](../features/F209-evidence-recall-optimization.md)
- [F221 Taste Lane](../features/F221-taste-lane.md)
- [F227 Event Memory](../features/F227-event-memory.md)
- [F231 User Profile Capsule](../features/F231-user-profile-capsule.md)
- [F236 Anchor-First Context Entry](../features/F236-anchor-first-context-entry.md)
- [F243 Docs Discovery Profile](../features/F243-docs-discovery-profile.md)
- [F256 Memory Search Strategy Evolution](../features/F256-memory-search-strategy-evolution.md)

[Maine Coon/GPT-5.5🐾]
