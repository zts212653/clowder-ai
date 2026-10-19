---
title: "Clowder AI Eval System Overview"
doc_kind: architecture
description: "Clowder AI eval 系统的系统地图：从 production trace、domain registry、verdict handoff 到 owner response 和 re-eval closure。"
feature_ids: [F153, F192, F200, F245, F248, F253]
related_features: [F167, F188, F203, F222, F236, F244]
topics: [eval, harness-eval, observability, verdict, friction, quality, architecture]
created: 2026-07-01
status: draft
author: "Maine Coon/GPT-5.5"
reviewed_by: "斑斑/Claude Opus 4.6 Thinking (fact-check review, 2026-07-01)"
---

# Clowder AI Eval 系统全景

> 面向想理解 "Clowder AI 怎么评估猫猫和 harness 是否好用" 的工程师和新猫。
>
> 本文和 [memory-system-overview.md](./memory-system-overview.md) / [collaboration-landscape.md](./collaboration-landscape.md) 是同一类文档：不是某个 feature 的实施计划，而是把散落在 F153、F192、F200、F245、F248 等 spec 里的 eval 架构拼成一张系统地图。

---

## 这个系统解决什么问题？

Clowder AI 是一个长期运行的多 agent 协作系统。猫每天会传球、查记忆、写代码、做 review、调用工具、处理社区 issue，也会犯错：忘记加载 skill、传错球、搜索没搜到、等待方式不对、修完不闭环、用户 cancel 工具调用、operator 说"这不对"。

普通测试只能回答一小部分问题：

- 代码能不能编译？
- 某个函数是否返回预期值？
- 某条规则是否被机械遵守？

Clowder AI 的 eval 系统要回答更大的问题：

1. **harness 现在还适配猫吗？** 规则、SOP、skill、MCP tool 有没有让猫更会干活，还是变成了负担？
2. **真实使用里哪里在痛？** 摩擦来自工具、环境、执行、愿景翻译，还是用户品味不匹配？
3. **修了以后真的好了吗？** owner 不能靠一句"修了"关闭问题，必须等后续 eval 复验或 operator 明确 accept / suppress。
4. **哪些层应该 sunset？** 模型能力、任务环境、工具面变化后，历史上必要的 harness 是否该删除。

一句话：

> Clowder AI eval = production traces + domain truth sources + eval domain registry + verdict handoff + owner response + re-eval closure。它评的是社会技术系统的 fit，不只是模型分数。

---

## 分层全景

```
                         用户 / 猫 / Hub / GitHub / runtime
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. Truth Sources / Signal Sources                                   │
│  F153 telemetry, F200 recall events, F188 health, task outcome DB    │
│  SopTrace, friction rollups, anchor telemetry, QC metrics, feedback  │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. Domain Registry + Schedule                                       │
│  docs/harness-feedback/eval-domains/*.yaml                           │
│  domainId / evalCat / frequency / sourceAdapter / sourceRefsKind     │
│  systemThreadId / handoffTargetResolver / SLA / enabled              │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  3. Source Adapter / Selector                                        │
│  把各域自己的数据转成 bounded sourceRefs / snapshot / rollup         │
│  F192 消费它们，但不拥有业务域 canonical truth                       │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  4. Eval Cat Invocation                                              │
│  eval cat 在对应 system thread 读长期上下文，做趋势分析              │
│  输出 VerdictHandoffPacket，而不是自由文本"你去看看"                 │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  5. Publish Pipeline                                                 │
│  cat_cafe_publish_verdict → schema/ownership/selector 校验           │
│  → generator 写 verdict.md + bundle/{snapshot,attribution,provenance}│
│  → isolated worktree PR                                              │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  6. Eval Hub + Artifacts                                             │
│  人能读的 domain card / verdict card / bundle link / closure status  │
│  F248 正在补"讲人话"和可点击证据链                                  │
└──────────────┬──────────────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  7. Owner Response + Re-eval Closure                                 │
│  owner 修复 / pushback / suppress / sunset                           │
│  closure 只能来自后续 eval 复验、operator accept/suppress、domain sunset   │
└─────────────────────────────────────────────────────────────────────┘
```

边界要点：

- **F153 是 descriptive observability plane**：它回答"发生了什么"，不做质量判断。
- **F192 是 harness-eval control plane**：它消费各域信号，产出 verdict / handoff / closure。
- **F200/F188/F245/F253 等拥有各自 domain truth**：F192 不复制、不重建它们的 canonical data。
- **Eval Hub 不是 metrics dashboard**：没有 verdict、owner ask、re-eval plan 的数字，不应该在 Eval Hub 里伪装成可行动 eval。

---

## 一次 Eval Cycle

```
domain truth source
  → source adapter 生成 bounded snapshot / rollup
  → eval domain scheduler 唤醒 eval cat
  → eval cat 在 system thread 做纵向分析
  → VerdictHandoffPacket
  → cat_cafe_publish_verdict
  → verdict artifact + provenance bundle
  → Eval Hub 展示
  → owner 响应
  → 后续 eval 复验关闭
```

如果其中任何一环需要猫手工抄 bundle、手工 commit、手工猜 owner，说明还没有真正接进 control plane。

---

## 和 Testing / Observability / Metrics 的区别

| 名称 | 主要问题 | 输出 | 谁拥有 |
|---|---|---|---|
| Unit / integration test | 代码行为是否符合预期 | pass/fail | 代码 owner |
| Gate / lint / typecheck | 明显违规能否机械拦住 | hard fail | repo gate |
| Observability | 发生了什么、耗时多少、有没有错误 | trace / metric / health | F153 与业务域 |
| Metrics dashboard | 数字趋势如何 | chart / counter | 各业务域 |
| Eval | 这些现象说明 harness 是否该 fix/build/keep/sunset | verdict + owner ask + re-eval plan | F192 harness-eval |

最容易混淆的是 observability 和 eval。F153 记录 `tool_use`、`llm_call`、latency、active invocation、健康状态；F192 才判断这些信号是否构成 harness finding。没有 F153，F192 没材料；只有 F153，没有 F192，系统只是在看仪表盘。

---

## Eval Domain Map

当前 eval 域的真相源是 `docs/harness-feedback/eval-domains/*.yaml`。域会增减，**不要硬编码数量**。下表是本文写作时可见的主要 registry 条目，用来说明形态，不是永久清单。

| Domain | 观测什么 | 主要信号源 | 典型 verdict |
|---|---|---|---|
| `eval:a2a` | 猫和猫协作顺不顺 | F153 telemetry + F167 A2A counters | fix route guard / build sample evidence / keep observe |
| `eval:memory` | 记忆 recall 和 library health 好不好使 | F200 recall metrics + F188 library health | fix ranking / repair library / keep observe |
| `eval:task-outcome` | 猫干活结果怎么样 | task outcome episodes + event memory | task quality keep/fix/build |
| `eval:sop` | SOP 硬规则有没有被遵守 | SopTrace + SopDefinition predicates | predicate violation handoff |
| `eval:capability-wakeup` | 该用的能力有没有想起来 | runtime sessions + capability trigger windows | add capability tip / fix wakeup path |
| `eval:friction` | 工具/流程让猫或用户哪里难受 | 爪感差、cancel、用户反馈、其他 eval 域摩擦 | propose thread / reference-only / keep observe |
| `eval:anchor-first` | anchor-first 省 token 是否净赚 | F236 anchor telemetry | keep / fix drill path / sunset candidate |
| `eval:qc` | QC 流程有没有拦住坏改动 | QC metrics rollup | fix QC gap / keep observe |
| `eval:capability-tips` | 能力提示是否有效 | capability tip usage window | 当前可注册但可 disabled，取决于 source 是否 wired |

### Registry 字段的职责

| 字段 | 用途 |
|---|---|
| `domainId` | eval 域唯一名，例如 `eval:a2a` |
| `descriptionForHuman` | F248 引入的人话描述，给 Hub 和 operator 看 |
| `systemThreadId` | 该域长期分析 thread；只做 working context，不是状态机 SOT |
| `evalCat` | 哪只猫周期性分析该域 |
| `frequency` | daily / weekly / every-Nd 等调度频率 |
| `sourceAdapter` | 哪个 adapter 读取该域信号 |
| `sourceRefsKind` | publish-verdict selector 的输入形状 |
| `handoffTargetResolver` | finding 交给哪个 feature owner |
| `sla` | owner ack 和 re-eval 期望 |
| `enabled` | source 未 wired 时必须能关，避免 silent-fire |

Y-lite registration 的关键点是：新增 domain 不应在中心 enum 到处加硬编码；registry 负责声明，adapter/generator 仍需代码显式 wiring，缺 wiring 要 fail closed。

---

## Eval 四层覆盖模型（E1-E4）

F192 覆盖度审计原文把 eval 分成 L1-L4。本文改写成 **E1-E4**，避免和记忆系统文档里的 L1-L6 分层、ADR-031 里的 harness L1-L5 混淆。

| 层 | 问的问题 | 典型信号 | 当前状态 |
|---|---|---|---|
| E1 机械正确性 | 格式、规则、状态机对吗？ | predicate、counter、regex、gate | 最强，`eval:a2a` / `eval:sop` / gate 都在这里 |
| E2 路由/决策质量 | 该传给谁、该用什么能力、该不该等？ | capability wakeup、cancel、routing feedback | 部分覆盖，仍依赖后验趋势 |
| E3 任务交付质量 | 用户的事办成了吗？质量行吗？ | task outcome、返工、Magic Word、operator 反馈 | `eval:task-outcome` 开始补，但仍是最难层 |
| E4 链路效率 | 整条链是否最短、最省、最优？ | 反事实、A/B、模拟、成本轨迹 | 目前不是主战场 |

这四层解释了为什么 "tests all green" 仍然会失败：测试通常只覆盖 E1；真实产品体感大量落在 E2/E3/E4。

---

## Signal 不是 Truth

Eval 系统里最重要的纪律是区分 signal 和 truth。

| Signal | 能说明什么 | 不能说明什么 |
|---|---|---|
| F200 consumed | 猫觉得这个结果值得继续读 | 文档是真的、权威的 |
| friction cluster | 某类工具/流程反复让猫或用户难受 | 一定要自动开修复 thread |
| cancel | 用户不认可这次工具调用 | 具体根因已知 |
| Magic Word | operator 强纠偏，方向/品味出问题 | 机械分类一定准确 |
| SOP predicate fail | 某条机器规则没满足 | 最终产物一定不好 |
| latency / token | 成本或体验压力 | agent 质量好坏 |

所以 F192 的输出不是"分数"，而是带 provenance 的 verdict：现象是什么、证据在哪、根因假设是什么、建议 owner 做什么、如何复验。

---

## 按 claim 选择机制：观测、守护与 Eval 的边界

ADR-031 当前状态是 draft v3.4。harness 改动不再按软、硬、eval 盘点三格，而是先问每个 claim 要回答什么问题，再按 claim 逐项选机制；没有选中的类别不需要列出或解释。

| 问题类型 | 选用机制 | 进入 Eval Hub 的边界 |
|---|---|---|
| 确定契约 | test、lint、predicate、schema、gate、typecheck | 契约守护本身不是 eval |
| 运行健康 | logs、metrics、traces、SLO | 原始观测默认留在 F153；不因“有数字”自动升格 |
| 不确定效用 | eval 出生证 + verdict 闭环 | 必须同时有 utility claim、明确 consumer 与 keep/tune/sunset 决策 |
| 教猫怎么做 / 低成本试错 | convention、skill、SOP 文本 | 教学载体本身不自产 eval |

同一改动可以包含多类问题。例如 prompt 模板的 schema 合规走确定契约，措辞是否更有效只有在存在明确 consumer 和后续决策时才走 eval，使用方法则走教学机制。机制可组合，但组合来自多个 claim，不是为了“配齐层次”。

三个例子：

1. **SOP compliance**  
   Skill 负责教学，`SopDefinition` / predicate 负责确定契约，SopTrace 是运行信号；`eval:sop` 只在这些信号被用于判断 SOP 效用并驱动明确 verdict 时成立。

2. **Friction signal**  
   `[爪感差: 工具+现象]` 是 convention，marker schema / extractor 是确定契约，cluster 计数是观测；`eval:friction` 因为有明确 consumer 要判断哪些摩擦进入 F128 / code-as-harness，才构成 eval。

3. **Memory recall**  
   主动 search 的方法由 skill 教学，F102/F188/F200 schema 由 guard 守住，consumed / latency 等先是观测；只有把 recall utility 映射为 keep/tune/sunset verdict 时，才进入 `eval:memory`。

---

## Artifact 与 Source Map

| 产物 | 路径 / 入口 | 说明 |
|---|---|---|
| Eval domain registry | `docs/harness-feedback/eval-domains/*.yaml` | 当前有哪些 eval 域、谁跑、频率、输入形状 |
| Verdict artifacts | `docs/harness-feedback/verdicts/` | 已发布 verdict 的人读入口 |
| Bundle artifacts | `docs/harness-feedback/bundles/` | snapshot / attribution / provenance |
| Harness feedback docs | `docs/harness-feedback/*.md` | close-time feedback、dogfood、fit review |
| Architecture cell | `docs/architecture/ownership/cells/harness-eval.md` | harness-eval ownership 与代码锚点 |
| Eval Hub | Hub Observability / Eval surface | 人读 verdict / domain card / closure 状态 |
| F153 telemetry | `/api/telemetry/*` + local trace store | descriptive traces / metrics / health |
| Feature specs | F192 / F245 / F248 / F200 / F253 | 各域设计和演进真相源 |

---

## 人和猫怎么经历 Eval

### operator：看懂"现在在修什么"

```
打开 Eval Hub
  → 看到每个 domain 的人话描述
  → 点开最新 verdict
  → 看到现象、证据、建议动作、owner、复验计划
  → 必要时 accept / suppress / 让猫开修复 thread
```

F248 的核心目标就是让这条旅程从"看不懂归因包"变成"知道它在观测什么、为什么建议修、证据能点开"。

### Eval 猫：不是跑测试，是做纵向诊断

```
被 scheduler 唤醒到 eval system thread
  → 读该 domain 长期上下文
  → 拉 sourceRefs 对应 snapshot / rollup
  → 比较趋势与旧 verdict
  → 产出 VerdictHandoffPacket
  → publish verdict
```

Eval 猫的价值在于解释：同样是 counter 变高，到底是环境漂移、tool gap、harness misfit，还是 operator taste gap。

### Feature Owner：不能一句"修了"自闭环

```
收到 verdict handoff
  → 读 evidence bundle
  → 接受 / pushback / suppress / sunset proposal
  → 修复或解释
  → 等下一轮 eval 复验
```

这条约束是 F192 的核心之一。没有 re-eval closure，eval 会退化成一次性报告。

### 新 Harness Feature：立项时就写 Eval Contract

```
新增 skill / SOP / MCP tool / shared rule
  → Inception / Design Gate 写 Eval Contract
  → 定义 primary users / activation signal / friction metric / regression fixture / sunset signal
  → 实现后由对应 domain 或新 domain 接进 registry
```

这让 harness "built to delete" 成为可执行纪律：建的时候就要说明什么信号证明它该删。

---

## 当前缺口

1. **人话摘要还没完全补齐**  
   F248 Phase A/C 已补 domain 描述和 bundle 点击链，Phase B verdict 人话摘要、Phase D 信息架构仍待推进。

2. **E3 任务交付质量仍是最难层**  
   `eval:task-outcome` 已补关键缺口，但"用户的事办成了吗"仍需要稀疏人工信号、Magic Word、返工、cancel、operator feedback 等多源 proxy 校准。

3. **E4 链路效率基本还没做**  
   要评估"是否最优路径"，需要反事实或 A/B，不是当前 token 预算下的优先项。

4. **Eval 域增长带来 registry hygiene 压力**  
   每个新 domain 都要有人话描述、sourceRefsKind、generator wiring、fail-closed 测试和 owner resolver。F245 的 Y-lite 迁移就是这类压力的教训。

5. **Signal actionability 需要克制**  
   摩擦 cluster 不等于自动开 thread。F245 的口径是：①②③ 可行动项给 followupDraft，由 eval 猫手动触发；④ 来自其他 eval 域的摩擦 reference-only，不重复处理。

6. **Sunset 真正跑起来还依赖 F234 / 后续 ablation**  
   F192 已有 delete/sunset 语义，但大规模主动退役过时 harness 仍是下一阶段能力。

---

## 读图顺序

如果你是第一次读 Clowder AI eval 架构：

1. 先读本文，建立"signal source → domain → verdict → owner → re-eval"地图。
2. 再读 [F192 spec](../features/F192-socio-technical-harness-eval.md)，看 control plane 如何从 Phase A 发展到多域。
3. 读 [F153 spec](../features/F153-observability-infra.md)，理解 telemetry 为什么只是 descriptive plane。
4. 读 [F245 spec](../features/F245-friction-signal-eval.md)，看一个新 eval domain 如何从死信号长成 rollup + Hub view。
5. 读 F248 spec，理解为什么 eval 不能只给猫看，也要给 operator 讲人话。
6. 读 ADR-031 draft v3.4，理解如何按 claim 选择机制，以及 eval 为什么服务于 harness 的新陈代谢和 sunset。

---

## 相关文档

- [F192: Socio-Technical Harness Eval](../features/F192-socio-technical-harness-eval.md)
- [F153: Observability Infrastructure](../features/F153-observability-infra.md)
- [F200: Memory Recall Eval](../features/F200-memory-recall-eval.md)
- [F245: Friction Signal Eval](../features/F245-friction-signal-eval.md)
- F248: Eval Hub 人类可读性
- [F253: Clowder AI QC Loop](../features/F253-qc-loop.md)
- ADR-031 draft v3.4: Harness Engineering 方法论
- [Harness Eval Control Plane ownership cell](./ownership/cells/harness-eval.md)
