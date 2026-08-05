---
title: "Clowder AI Memory System Overview"
doc_kind: architecture
feature_ids: [F102, F152, F163, F186, F188, F200, F209, F221, F227, F231, F255, F256, F260, F263, F271, F272, F276, F281, F282, F287]
related_features: [F139, F148, F153, F169, F192, F229, F236, F242, F243, F246, F258, F267]
topics: [memory, recall, write-side, cue-plane, relationship-memory, lifecycle, evidence, profile, taste, event-memory, proactive, architecture]
created: 2026-06-28
revised: 2026-08-04
status: active
author: "Maine Coon/GPT-5.5"
revised_by: "小太阳·Maine Coon/GPT-5.6 Sol"
description: "Clowder AI 记忆系统的当前全景：供给、canonical truth、索引检索、执行时 Cue Plane、反馈裁决与猫自主行动，以及 main/live/UAT 的剩余闭环。"
description_source: model
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: 2026-08-02T11:00:04Z
description_confirmed_by: codex-sol
description_updated_at: 2026-08-02T11:00:04Z
---

# Clowder AI 记忆系统全景

> 面向 You、新猫与工程实现者。本文回答五件事：家里有哪些记忆器官；一段经历如何
> 变成 canonical truth；检索与执行时 cue 如何分工；F271“主动写入”主动在哪里；截至
> 2026-08-04 哪些闭环已经工作、哪些仍欠真实运行或裁决。
>
> **文档分工**：[memory-philosophy.md](./memory-philosophy.md) 管长期原则；本文管当前系统地图；
> [retrieval-pipeline-deep-dive.md](./retrieval-pipeline-deep-dive.md) 管 pull recall 执行细节；
> [memory-cue-source-map.md](./memory-cue-source-map.md) 管 F287 逐 lane ownership；
> 2026-08-02 closure plan (internal) 管剩余工作的顺序。
> 各 feature doc / task 才是 phase 与 AC 的 canonical truth。
>
> **Freshness**：本轮增量核验锚点为 F271 `1ba70d6a3`、F256 `f976a4266` 与 F227
> exact Alpha `origin/main@4f9eba7cd`。运行态、UAT 与 verdict 必须单列，不能由 main commit 推断。

---

## 三十秒结论

Clowder AI 的记忆系统不是一个数据库，也不是“自动把旧聊天塞进 prompt”。它是六个
相互制约的器官：

1. **供给与捕获**发现值得留下的 delta：F271、F221、F227、F231、F260、F276、F282。
2. **Canonical truth** 决定谁能批准、修改、忘记哪类事实：F152 与各 typed lane。
3. **索引与 pull recall** 把 truth 投影、搜索、解引用并下钻原文：F102、F186、F188、F209、F256。
4. **执行时 Cue Plane** 只在明确判断点投影有界 cue：F287；它不拥有任何源 lane 的 truth。
5. **反馈、观测与慢裁决** 记录展示、消费、纠正和效用：F281、F200、F263、F192/F267。
6. **猫的私人主动性** 把线索变成猫自己采纳的念头和行动：F255、F272。

截至 2026-08-04：

- 存储、索引、下钻、实体 revision、typed proposal、lifecycle trace 与 Cue Plane A–E 实现已进入 main。
- F281/F282 已闭工程；F287 已完成 lifecycle/delivery/budget 加固，canonical Alpha 完成 Person、operational precedent 与 Taste integrated UAT；production 仍是 `dormant/unverified`。
- F271 session-close 已有 durable output；daily 的 120 秒 timeout 已修并在 `11.874s` 内 delivered，但该 run 的五条候选全部被 household-day budget 拒绝且 `quiet=false`，尚无合法 daily outcome。
- F256 `f256-health-v2` 已在自然 `natural_topk` 路径通水；21 条 durable row、16 个 eligible/presented event 与 56 个 presented hint 关闭了 health/observability 缺口，`followed=0 / used=0` 仍不支持效用结论。
- F152 external bootstrap 与 distillation route 实测读取不同 store，generalizable mark 返回 404；AC-C1/AC-C5 必须先修产品链再做 You UAT。F227 已完成 cat-side Alpha 预演，只欠视觉与 teleport 签字。
- 核心未闭项是 F271 合法 daily outcome、F152 同 store 修复与 AC-C5、F263 Phase D1、F271 Phase C、F256 效用裁决，以及证据成熟后的 soft-forget Decision Packet。

---

## 一段经历经过哪些状态

| 状态 | 谁拥有 | 可以做什么 | 不代表什么 |
|---|---|---|---|
| raw event / source | 原 thread、外部项目或 owner-private artifact | 作为 provenance 被精确引用 | 它已经值得长期保存 |
| candidate / proposal | producer + destination lane | 等待验证、批准、拒绝或降档 | canonical truth |
| canonical truth | F152 / F221 / F227 / F231 / F260 / F276 / F255 等 typed owner | 修改、replace、retire、forget；生成可重建投影 | 任意 consumer 可以改源 |
| index / projection | F102/F186/F188/F209 | 搜索、排序、解引用、重建 | 第二套真相库 |
| cue | F287 在 typed opportunity 上投影 | 让当前猫知道“这里可能有相关东西”，可 drill 或忽略 | 自动结论、欲望、prompt dump |
| outcome / episode | F281/F200/F263/F287 content-free ledger | 观测 presented/drilled/applied/dismissed、纠正、沉默与 invalidation | 单一指标直接证明有用 |
| owned seed / action | F255/F272 的猫本人 | 采纳、改写、先做一步、表达 | 系统替猫宣布意图 |

---

## F271“主动写入”到底是什么

### 人话

以前，只有 You 说“记住这个”，或者某只猫当场自觉调用写入工具，经历才比较可能
留下来。F271 补的是**供给缺口**：

> 猫收工时和每天低频巡逻时，主动检查刚发生的事情，只捡会蒸发且以后真可能有用的
> delta，做成有类型、有原文锚点、有预算的 candidate 或 cue。

它捡的是 delta，不是聊天摘要：

| 增量 | 例子 | 交给谁 |
|---|---|---|
| decision | 选了 A 而不是 B，以及为什么 | F152 durable truth / F227 |
| correction | “以后不要这样”“这才是我们家的做法” | F221 taste proposal |
| identity / relationship | 对人、猫或关系的稳定修正 | F231 proposal；第三方人物归 F276 |
| open loop | 已承诺但尚未完成的事 | task / event owner |
| desire cue | 猫可能想在私人时间重访的线索 | F255 private cue sink |

### 它不是什么

- 不是每天总结所有聊天。
- 不是自动升级 canonical truth；F271 不拥有 promotion / rejection / retirement。
- 不是系统替猫宣布“我想要这个”；`cue ≠ owned seed`。
- 不是 F272 的主动消息。F271 供给线索，F272 才负责形成意图、先做一步、再来开口。
- 不是 F287 的 cue resolver。F287 只消费 closed typed opportunity，F271 在 catalog v1 不是隐式 producer。

### 当前状态

- **Phase A 已有真实产物**：`reflection_outputs` 中有 5 条 `f271-session-close-v1` durable outputs。
- **Phase B 工程已落**：`f271-daily-context-reflection` 按 04:15 household timezone 注册。
- **Phase B timeout 已修、outcome 未闭**：`1ba70d6a3` 已被 live runtime 加载；production
  scheduler 同 job 手工触发后在 `11.874s` 内 `RUN_DELIVERED`。但结果为
  `extracted=5 / accepted=0 / rejected=5 / cues=0 / quiet=false`，全被 household-day budget
  拒绝；它既没有 durable delta，也不是合法 quiet day。自然预算 reset 后仍需再跑一次。
- **Phase C 未闭**：要把 producer output 与 destination-lane 的 approve/reject/retire 结果
  串成 trace，并让 F263/F192 产生首个 live verdict；不能私建第二套 truth engine。

---

## 端到端架构

```text
对话 / session / 外部项目 / 私人时间 / 用户纠正 / typed runtime event
                              │
                              ▼
┌──────────────────────── 供给与捕获 ────────────────────────┐
│ F271 typed delta       F221 taste       F227 event         │
│ F231 profile           F260 entity      F276 person        │
│ F282 lane-neutral candidate/readiness                      │
└──────────────────────────────┬──────────────────────────────┘
                               │ candidate / proposal / cue sink
                               ▼
┌──────────────────────── Canonical truth ────────────────────┐
│ F152 personal durable truth/compiler    F255 private seed   │
│ F221 taste     F227 event     F231 profile/primer           │
│ F260 entity+revision          F276 people+relationship      │
└──────────────────────────────┬──────────────────────────────┘
                               │ authorized, rebuildable projection
                               ▼
┌──────────────────────── 索引与 pull recall ─────────────────┐
│ F102 evidence → F186 collections → F188 stewardship        │
│ → F209 passage/entity/drill → F256 route/coverage/expand    │
└───────────────────────┬───────────────────┬─────────────────┘
                        │ pull              │ typed opportunity
                        │                   ▼
                        │     ┌──────── F287 Cue Plane ────────┐
                        │     │ catalog → resolver → budget     │
                        │     │ → CueEnvelope → drill/outcome   │
                        │     │ → revision/auth invalidation    │
                        │     └──────────────┬──────────────────┘
                        └────────────────────┤ presented / used
                                             ▼
┌────────────────────── 反馈、观测与裁决 ─────────────────────┐
│ F281 human disposition + exact-subject reflow               │
│ F200 consumption / trajectory                               │
│ F263 lifecycle / verification / three-axis / slow verdict   │
│ F192/F267 eval artifact + measurement validity              │
└───────────────────────┬───────────────────┬─────────────────┘
                        │ correction        │ useful cue / echo
                        │ 回源 typed owner  ▼
                        │     ┌──────── 猫的主动性 ────────────┐
                        └────▶│ F255 cue → cat-owned seed       │
                              │ F272 intent → first action      │
                              │ → expression → home → echo      │
                              └─────────────────────────────────┘
```

---

## 八条硬边界

1. **Producer 不等于 truth owner**：F271/F282 可以发现，不替 destination lane 批准。
2. **Cue 不等于欲望或结论**：F287 投影线索；只有猫能把 cue 采纳为 owned seed。
3. **索引不等于真相源**：evidence projection 可重建；重建不能改写产品 truth。
4. **Cue Plane 不等于万能 RAG**：只认 closed typed opportunity；未知输入、未授权、过期、被纠正或 forgotten source 一律零 cue。
5. **观测不等于干预**：F263 看见生命周期，不顺手成为 soft-forget 执行器。
6. **`main ≠ live ≠ UAT ≠ verdict`**：代码合入、runtime 加载、owner 验收和效用裁决分别取证。
7. **Owner memory 不以模型权重作 truth store**：owner-specific / 用户可见的记忆 payload 不得靠 parametric internalization 变成“模型自己知道”；provenance、纠正、授权遗忘在参数里不可执行（kangrui 对读 (internal) D 档）。公开、可复用的方法论可以进入 skill / training 演化，但那是方法演化，不是 memory truth，也不得夹带私有 payload。
8. **真相仲裁归 canonical source，不归多数**：投票/共识式冲突裁决违反 M16；机制只把冲突证据摆上桌，裁决归猫与真相源（同上 D 档，拒 Byzantine consensus over memory）。

> 远期注记：everywhere/多端愿景落地那天，privacy-preserving sync 须前置到 schema 设计层，
> 不是事后补丁（W5"只回流方法论"是它的家规先例；位阶判断来自 kangrui 对读 C 档）。

---

## F287 Cue Plane 在全景里的位置

F287 解决的是“记忆已经存在，但当前猫在正确判断点没有想起”的执行时缺口。它只拥有：

- closed `RecallOpportunity` catalog 与 admission；
- lane-specific resolver routing、budget、dedupe、expiry；
- bounded `CueEnvelope`、opaque drill 与 outcome；
- owner/revision/source invalidation；
- content-free consumption episode。

Catalog v1 的 producer 只有三族：

1. `subject_seen`：来自 server-owned Entity nudge；
2. `delivery_decision`：来自 typed GitHub CI / gate evidence；
3. `judgment_surface_entered`：来自显式 workflow selection。

Profile 与 project knowledge 在 v1 注册为 zero-only；F152、F188、F200、F256、F263、F271
是 substrate、health/eval consumer 或 convention，不得被偷偷变成 implicit producer。F282 负责
lane-neutral candidate detection/readiness，也不会因为频率高就直接出生 cue。

### 当前交付边界

- Phase A–E 实现已进入 main：source census、readiness、Cue Contract、三条 golden slice、lifecycle replay、direct connector delivery 与 canonical billing budget hardening。
- canonical Alpha 已完成 Person、operational precedent 与 Taste 的 presented→drilled→applied journey；Person correction/hard-forget、scope 与 over-budget 负向也已闭合。
- 三个 family 的 utility birth certificate 均为 `keep`，且不存在跨 lane total score。
- production `3002/6399` 未激活、未验证；它是授权边界，不是 F287 的 deferred AC。

因此，F276 lifecycle 与 Cue Plane integrated UAT 均不再由非 F287 总计划重复派工。

---

## Feature Map

### A. 存储、索引与 pull recall

| Feature | 当前角色 | 状态 |
|---|---|---|
| [F102](../features/F102-memory-adapter-refactor.md) | `evidence.sqlite`、passage、FTS/vector、统一 evidence 接口 | done；长期底座 |
| [F163](../features/F163-memory-entropy-reduction.md) | authority/status/salience 与 lifecycle metadata | done；不等于通用遗忘器 |
| [F186](../features/F186-library-memory-architecture.md) | collection federation 与安全边界 | done |
| [F188](../features/F188-library-stewardship.md) | rebuild/health/graph/recent/collection lifecycle | done |
| [F209](../features/F209-evidence-recall-optimization.md) | passage recall、entity anchor、typed drill、Perspective | done |
| [F256](../features/F256-memory-search-strategy-evolution.md) | 三入口策略、coverage 补刀、related directions、doc-code bridge | A–C landed；D 待健康漏斗与 utility verdict。appearance 目前 not_observable，5/4816 已撤回，不能据组件绿宣称有效 |

### B. Typed truth 与写侧 lanes

| Feature | 它拥有的真相 / 责任 | 状态 |
|---|---|---|
| [F152](../features/F152-expedition-memory.md) | 外部项目冷启动；generalizable candidate→approve→personal durable truth→compiler | durable supply 已闭；只欠 AC-C5 You 全链 UAT |
| [F221](../features/F221-taste-lane.md) | 可复用品味 vignette 与 propose/approve | 写入口与可搜索 materialization 已有；长期有机增长继续观察 |
| [F227](../features/F227-event-memory.md) | 认知转折、magic-word Event Memory、timeline/teleport | Phase A code complete；alpha backfill+视觉/teleport acceptance pending；B/C 未做 |
| [F231](../features/F231-user-profile-capsule.md) | You profile 与 cat↔You relationship primer | A–C + D code landed；AC-D6 live migration blocked on OQ-7 granularity |
| [F260](../features/F260-write-side-autopsy-entity-deref.md) | entity registry/alias/conflict/revision ledger | 主链 closed；管理入口与三项 maintenance 待明确 owner |
| [F276](../features/F276-people-relationship-memory.md) | owner-private 第三方人物、关系、互动事件与 bounded card | 工程 contract landed；F287 Alpha lifecycle + correction/hard-forget journey pass |

### C. 主动供给、反馈与 Cue Plane

| Feature | 当前角色 | 状态 |
|---|---|---|
| [F271](../features/F271-pragmatic-memory-reflection.md) | session-close + daily typed delta producer；只产 candidate/cue | A 有真实产物；B 工程落但 daily live 未证活；C pending |
| [F282](../features/F282-proactive-memory-pipeline.md) | lane-neutral detector、typed source bundle、preflight/pending lifecycle、冷启动判断入口 | done；main landed，运行投影按 source 保持 dormant/需独立验证 |
| [F281](../features/F281-feedback-channel-first-class.md) | structured human why、durable disposition receipt、exact-subject bounded reflow | done；不拥有 source truth |
| [F287](../features/F287-memory-cue-plane.md) | typed opportunity→resolver→bounded cue→drill/outcome/invalidation | done；implementation main landed；Alpha loaded/UAT；production dormant/unverified |

### D. 私人时间与主动行动

| Feature | 当前角色 | 状态 |
|---|---|---|
| [F255](../features/F255-auto-dream.md) | Present Loop、日记/余温、private cue、owned seed、stable home | 第一纵切片闭；旧 Phase B schema frozen，后续只走当前产品路线图 |
| [F272](../features/F272-cat-jumps-on-the-table.md) | seed→intent→first action→expression→home→echo | 第一纵切片闭；world contact 与长期 echo/eval 是后续产品线 |

### E. 观测、评估与慢裁决

| Feature | 当前角色 | 状态 |
|---|---|---|
| [F200](../features/F200-memory-recall-eval.md) | RecallEvent、消费归因、trajectory、ranking feedback | 长期 measurement active |
| [F263](../features/F263-memory-lifecycle-repair-and-metrics.md) | 诚实消费合同、push governance、lifecycle trace、三轴账本、慢裁决 | A/B/C complete；D pending |
| F192 / F267 | versioned verdict、living bench 与 measurement validity | 只承载有 consumer 的效用决策；不决定 memory truth |

### F. 邻接基建，不属于 memory truth owner

| Feature | 关系 |
|---|---|
| F139 | 执行 schedule；不拥有 F255/F271 的候选、生活配置或欲望 |
| F153 | 观测超时、stage health、漏斗与稳定性；运行健康默认不塞进 Eval Hub |
| F229 / F258 | 身体与入口投影；不是第二消息库或第二 seed store |
| F246 | 审批外部/不可逆动作与 typed proposal；普通“我发现/我惦记”不因此一律审批 |

---

## 当前闭环账本（2026-08-04）

| 环节 | 当前判定 | 人话 |
|---|---|---|
| 检索与下钻 | ✅ 基本闭 | scope/limit/cursor、collection、entity、typed reader 与 drill 有合同 |
| Typed truth + revision | ✅ 主链闭 | 事实按 lane 拥有；实体/人物能 conflict、replace、revision、forget，索引可重建 |
| F281/F282 生产与反馈基础 | ✅ 工程闭 | lane-neutral detection、source bundle/preflight、human disposition/reflow 已落 |
| F287 Cue Plane | ✅ main + Alpha UAT 闭 | A–E + hardening landed；三条 family journey 与 lifecycle negatives 通过；production dormant/unverified |
| F271 session-close | ✅ 有真实产物 | 已有 5 条 durable typed outputs |
| F271 daily | 🟡 timeout 闭 / outcome 未闭 | live run 已由 120 秒失败降至 11.874 秒 delivered；预算拒绝且 `quiet=false`，不算 durable delta 或合法 quiet day |
| F152 durable supply | ❌ 产品链未闭 | external bootstrap 写 project collection，distillation route 读 root store；generalizable mark 404，AC-C1/AC-C5 重开 |
| F256 search guidance | 🟡 health 闭 / utility 未闭 | `f256-health-v2` 自然通水；21 rows / 16 events / 56 hints，但 follow/use 仍为零 |
| F263 lifecycle | 🟡 A–C + D0 闭 / D1 未闭 | D0 已校准 abandoned/appearance 并孵化两个 measurement fixtures；1b 已通水，首个周频窗口仍待自然 follow/use 与 sample floor |
| F227 Event Memory | 🟡 Phase A cat-side READY | exact Alpha backfill、38 tests 与真实 teleport 通过；只欠 You 视觉/跳转 acceptance，B/C 非核心水管 |
| 私人主动性 | 🟡 第一纵切片闭 | F255/F272 已有 seed→first-action 骨架；完整 home/world/echo 是后续产品线 |
| 通用 soft-forget | ❌ 未立项 | 等 Phase D 退休证据后出 Decision Packet；不塞进 F263，不提前造号 |

---

## 检索面已知薄弱（2026-08-03 对读，2026-08-04 可观测性校准）

1. **未裁决矛盾对在读侧结果中不可见**（conflict surfacing 缺位）：写侧已有 contradiction detector / supersedes / revision，但"还没人发现它们打架"的两条记忆在检索结果里仍是互不相干的条目，靠猫自己扫。LL-081 只是同构 failure mode 的 review 通道类比，不是已发生的 memory 事故。未来机制只能检测与标注，不自动裁决。
2. **temporal 只是过滤器，非推理维度**：三个检索入口都不把时间范围推断进 query plan。
3. **现有 trace 看不见两枚观察候选的语义**：`RecallEvent.candidates` 记录 anchor / rank / consumption / result set，`LifecycleTrace.kind` 只覆盖 `harmful_consumption` / `unmet_demand` / `verification` / `attention_cost`；它们不能确定两个 candidate 语义互斥，也没有“猫又做了一次现场综合”的 episode。因此 F263 D0 对 conflict / repeated synthesis 只能返回 `observed | no_data | not_observable`；静默不得作为“问题不存在”的证据。

候选解法与升级触发器见 kangrui 对读 §5 (internal)。D0 已对 conflict / repeated synthesis 均返回 `not_observable`，因此不立项、不加塞；conflict surfacing 继续等真实错选事故或可观测 trace，物化 Perspective 继续等重复综合浪费证据，temporal query plan / EvidenceNeed 继续等自己的时间推理或证据槽位失败。最后一组可在 F256 keep/tune 时共用 Decision Packet，但不继承 hint 路线的生死结论。

---

## F263 现在到底还欠什么

F263 A/B/C 已完成：

- **A**：诚实检索合同、continuation 与有毒观测面止血；
- **B**：纳管存量 push recall，拆清 personal→global 与 private→authorized 两道门；
- **C**：append-only lifecycle trace、verification、true-zero 分桶和三轴 RecallLedger。

Phase D 分成两个不同证据时点：

1. **D0 基线裁决（2026-08-04 closed）**：69 条 verification trace 与 127 个零活动小时通过 gate。全盘 abandoned 因类别混淆降级为 `keep_observe`；F256 appearance 判为 `not_observable`，旧 5/4816 LIKE 代测正式撤回；conflict / repeated synthesis 均为 `not_observable`。详见 versioned verdict。
2. **D1 修复后效用**：F256 健康漏斗稳定且达到预先冻结的 sample floor 后，再判 keep/tune/sunset；新失败孵化进 living bench，连续稳定且已有低成本 guard 的 fixture 才退役。

F263 不接走两个外部责任：F260 maintenance 需单独归属；soft-forget 是带副作用的干预 feature，必须另过 operator Decision Gate。

---

## 当前施工的直线路径

详细 Ready/Done/evidence 合同见
2026-08-02 Memory System Closure Plan (internal)。这里只保留架构顺序：

1. F271 在自然 budget reset 后补一条合法 daily outcome；F256 health 已通水，继续积累自然 follow/use。F263 D0 不再重复取证。
2. F152 先修 project collection 与 distillation 的同 store 产品链并重签 READY；F227 已 cat-side READY，随后再安排 operator UAT。
3. F263 D1、F271 C、F256 三岔 verdict 只按真实 follow/use 与 destination lifecycle 样本启动。
4. Phase D 产生退休证据后，再写 soft-forget Decision Packet。
5. F231/F260/F255/F272 作为独立尾巴或产品路线图跟踪，不污染核心水管。

F287 已在自己的责任 thread 完成 A–E 与 terminal close；本路径只消费其 release，不再重复指挥。

---

## 几个容易混淆的词

| 词 | 含义 |
|---|---|
| candidate | 有来源、可被真实任务消费的待定资产；不等于 canonical truth |
| proposal | 进入某个 typed owner 的可批准/拒绝变更请求 |
| cue | 执行时有界线索；不等于结论或欲望 |
| owned seed | 猫自己采纳、改写或原创的种子；真相归 F255 私人产品面 |
| active | 当前 recall 可见并参与任务 |
| retired | 可逆移出 active recall，但保留 provenance/audit |
| forgotten / erased | 经 owner 授权删除或 redact payload；与退休不是同一动作 |
| tombstone | 证明某对象曾存在及为何不可再取回的最小审计事实，不应偷偷保留 payload |
| archive | collection/产品容器状态；不自动等于其中每条记忆被遗忘 |

---

## 阅读顺序

1. 原则：[memory-philosophy.md](./memory-philosophy.md)
2. 全景：本文
3. Pull recall：[retrieval-pipeline-deep-dive.md](./retrieval-pipeline-deep-dive.md) + F102/F188/F200/F209/F256
4. Cue Plane：[memory-cue-source-map.md](./memory-cue-source-map.md) + F287
5. 写侧：[memory-write-side-autopsy-2026-07.md](./memory-write-side-autopsy-2026-07.md) + F152/F221/F227/F231/F260/F271/F276/F282
6. 主动性：F255 + F272 + “猫是会自己跳上桌的”愿景 (internal)
7. 生命周期与排程：F263 + closure plan (internal)

## 主要真相源

- [Memory Philosophy](./memory-philosophy.md)
- [Retrieval Pipeline Deep Dive](./retrieval-pipeline-deep-dive.md)
- [Memory Write-Side Autopsy](./memory-write-side-autopsy-2026-07.md)
- [F287 Memory Cue Source Map](./memory-cue-source-map.md)
- [ADR-020: F102 Memory System Architecture](../decisions/020-f102-memory-system-architecture.md)
- ADR-028: Trust, Provenance, and Authority
- [F152](../features/F152-expedition-memory.md) · [F256](../features/F256-memory-search-strategy-evolution.md) · [F263](../features/F263-memory-lifecycle-repair-and-metrics.md)
- [F271](../features/F271-pragmatic-memory-reflection.md) · [F276](../features/F276-people-relationship-memory.md) · [F281](../features/F281-feedback-channel-first-class.md) · [F282](../features/F282-proactive-memory-pipeline.md) · [F287](../features/F287-memory-cue-plane.md)

[小太阳·Maine Coon/GPT-5.6 Sol🐾]
