---
feature_ids: [F281]
related_features: [F246, F280, F272, F192, F276, F221]
topics: [feedback-loop, structured-rejection, proactive, approval-hub, telemetry, calibration]
doc_kind: spec
created: 2026-07-30
description: "把'猫提议、人裁决'交互的拒绝/取消反馈变成一等公民：结构化拒因契约、UI 采集、episode 落账与回流给猫的校准闭环。"
description_source: human
description_author: fable-5
description_updated_at: 2026-07-30T14:50:00-07:00
---

# F281: Feedback Channel First-Class（反馈通道一等公民）

> **Status**: done | **Owner**: Ragdoll (@fable-5, claude-fable-5) | **Priority**: P1

Architecture cell: human-disposition-feedback

## Why

猫的每次主动提议（proposal 卡 / hold / visit）被拒绝或取消时，operator的"为什么"信号**全部蒸发**——猫学到的是"提议危险"，而不是"下次怎么提对"。校准回路断裂的直接后果是双向失败：该提的没人提（Alden 反复出现无猫记录），提了的学错教训（周玉晶 F276 两连拒后，猫习得"人物提案危险"而非"provenance 不合格"）。没有拒因的拒绝，教出来的全是错误泛化；proposal 系统在这个激励结构下必然滑向沉默。

operator 原话（2026-07-30，[thread-id]）：

> "我们必须有 审批卡的拒绝动作要带结构化拒因 可以选项也可以其他让我写，或者说我们涉及到主动的反馈的这些遥测都必须加上，比如持球mcp我们的cancel好像就是这样的，但是我不知道有多少类似的互动，我们忘记做遥测了"

根因一句话：**反馈通道不是交互的一等公民**——各交互面出生时只带"裁决动作"，不带"反馈表达 + 落账 + 回流"三件套。

## Current State / 现状基线

2026-07-30 快扫审计（5 个交互点，代码证据，全部可 grep 复核）：

| 交互点 | 拒因字段 | 结构化分类 | UI 输入口 | 回流给猫 |
|---|---|---|---|---|
| hold_ball cancel（`callback-hold-ball-cancel-routes.ts`） | ✘ 零 reason；已有 `withFeedback` → `onHoldBallCancelFeedback` 通知钩子（F167 Phase J），但 payload 仅 `{taskId,threadId,userId,catId}`，无用户 reason 载荷 | ✘ | ✘ | 部分（有钩子无拒因） |
| F276 person-memory reject（`person-memory-decision-routes.ts`） | ✘ 零 reason 命中 | ✘ | ✘ | ✘ |
| taste / entity / schedule proposal | ✔ `rejectionReason?: string`，Redis/InMemory store 落账完整 | ✘ 纯自由文本 | ✘ `packages/web/src` grep rejectionReason **零命中**（无输入框，字段永远 undefined） | ✘ |
| F272 proactive echo | ✔ `not_now` / `wrong` | ✔ 结构化分类正样本 | — | ✔ seed dormant + lineage 保留 |
| F192 permission cancel（`PermissionCancelEvent` + `authorization.ts` AC-G10 前端 popup） | ✔ 结构化输入 | ✔ 结构化正样本（task-outcome 域） | ✔ | 部分（episode 落账，无猫侧定向回流） |
| 回流通道（全仓） | — | — | — | ✘ 无任何代码把拒因注入猫后续 context；唯一接近闭环的是 task-outcome episode builder（`task-outcome-signal-builder.ts`），但只覆盖 task 域 |

**复用基线**（Sol review 2026-07-30 补正）：F272 echo 分类学、F192 permission cancel 的"popup 结构化输入 → episode"路径、hold_ball 的 `withFeedback` 回调骨架——三者都是本 feat 的既有正样本/半成品，Phase B/C 优先扩展它们，不平行造新。

缺口形状 = **三段式断裂**，三段是独立断点、修法不同：
1. **采集端断**：hold_ball / person-memory 连字段都没有；有字段的面前端不采集
2. **结构断**：有 reason 的地方全是自由文本，无分类集（无法聚合、无法定向教学）
3. **回流断**：落账的 reason 死在 store 里，没有 consumer

最阴险的模式：后端 schema 全线有 `rejectionReason` 字段，review 时看起来"已支持拒因"——**绿灯的名字 ≠ 绿灯的覆盖**。

## What

### Phase A: 全量盘点 + 拒因分类集契约（✅）

- 拒因分类集契约进 shared types（单一真相源）。**设计判据：每个拒因必须映射到猫的一个不同的行为修正方向**——两个拒因导致同一修正就合并，一个拒因对应两个修正就拆分：

| 拒因 | 行为修正方向（**一律 scoped to subject/candidate，见 KD-4**） |
|---|---|
| `not_important` 不重要 | 仅该 subject（exact subjectRef / proposal lineage）降权 / dormant——**不外推到"同型"或整个 lane** |
| `wrong_lane` 走错 lane | 该候选改道正确 lane 重提（内容对，地方错） |
| `bad_evidence` 证据不合格 | 该候选补合格 provenance 再提（值得提，来源不行） |
| `not_now` 不是现在 | 该候选换时机重提（复用 F272 语义） |
| `wrong` 内容错误 | 该候选事实修正（复用 F272 语义） |
| `other` + 自由文本 | 逐条人读；**不进入自动回流注入**，仅落账供设计者聚合 |

> 泛化边界：单次拒因只修正该 subject/候选；lane 级或全局策略调整必须由多样本聚合 + 设计者裁决产生，绝不由单条反馈自动触发。否则系统亲自制造"拒一次人物卡 → 以后不提人物"——与本 feat 要修的病同型。

- 复用 F272 `not_now`/`wrong` 的分类学，**不另起炉灶**；Phase A 的 strict public input、server binding、episode/envelope schema 和 pure eligibility predicate 已落在 `packages/shared/src/types/human-disposition-feedback.ts`。

### Phase B: 采集端接入

- Approval Hub 的 F225 Session Handoff 与 F276 Person Memory reject 已接入共享结构化拒因 dialog（一键分类 + "其他"自由文本，默认可跳过不强制——反馈是礼物不是关卡）；producer catalog 同时约束 UI 选项与 route admission。
- F225/F276 的 canonical producer store 在同一原子裁决中持久化 optional feedback；F276 仍保留 F282 的 subject suppression / hard-forget 边界。
- hold_ball cancel reason 已通过 F280 canonical runtime termination event 接入：F280 event 只承载
  `user_cancel` 终止真相，F281 adapter 用 server-bound owner/cat/subject/source 构建 optional why
  envelope；无 feedback 仍留 decision episode，不打旧 API。

### Phase C: episode 落账 + 有界回流（feedback envelope）

- F225、person-bound F276 与纯 unbound F276 terminal reject 在同一原子 transition 中落
  disposition entry；
  F281 只持久化 content-free random receipt/index，查询时再从 producer-owned truth hydrate
  完整 episode/envelope。pre-Phase-C terminal row 不静默 backfill，也不冒充普通 replay。
- **反馈 envelope**（回流的唯一载体，Phase A contract 已冻结字段）：
  `{ interactionKind, subjectRef, proposalId?, decision, feedback: { reasonCode, detail? }, producerCatId, ownerUserId(server-bound，不信 callback payload), decidedAt, scope, expiry, invalidator, sourceRef }`
  ——`subjectRef` 必填（回流匹配键）；`proposalId` 可选，仅补充同 subject 多次提案的 lineage 链；无 feedback 的裁决仍记 decision episode，但**不出生 envelope**。
- 回流载体已收敛为 direct-owner invocation 的专用 prompt segment。consumer 只在当前 owner
  直接消息中运行；queue replay、A2A、callback、connector、system 与 unknown origin 均 fail closed。
- 回流是**触发式 + exact-match**：自动回流只匹配 exact `subjectRef` / verified current proposal
  lineage，**"同型候选"不是合法匹配范围**——跨 subject 泛化必须生成独立、版本化的设计者策略
  （多样本聚合产物，可审计可回滚），不藏在回流机制里；不做全量/无差别 context 注入；
  自由文本 `other` 不进自动回流。
- F276 的 subject/lineage/locator/binding proof 全部由 producer ownership cell 持有；F281
  receipt/index 不保存 raw 或可确定推导的 F276 identifier。Person-bound lineage 保持在同一
  person hard-forget closure；纯 unbound terminal lineage 使用 proposal-scoped binding，并由
  owner-authenticated exact `proposalId` purge 原子清除 producer/F281 truth。Mixed lineage
  仍 fail closed、零 Phase-C 写入。
- 铁律（承自 F272 cell + 度量系统 A6）：episode 账本给系统设计者调参，**接受率绝不回灌成猫的 KPI**；回流的是"该候选的定向教训"，不是"你的成绩"

### Phase D: 出生三件套反射沉淀

- "主动交互面出生三件套"已进入 ADR-038 机制选择反射：任何"猫主动提议、人做裁决"的交互面，出生时必答三问——①反馈可表达（结构化分类+其他，纯 binary 不合格）②反馈落账（不落账=没发生）③反馈有 consumer（**声明不出 consumer 就别采**，死遥测是负资产）。
- `feat-lifecycle` Design Gate checklist 已引用该反射，并以 F281 自身为首个合规样例。

## User Journey

### Primary Journey: 拒绝一张提案卡时顺手说清为什么
- **Scope unit**: workspace
- **Actor**: operator
- **Entry**: Approval Hub 中任意 pending 提案卡
- **Flow**:
  1. operator点"拒绝" → 弹出轻量拒因选择（6 类一键 + 其他文本，可跳过）
  2. 选择"证据不合格" → 拒绝完成，拒因落账
  3. 该 subject（exact subjectRef / lineage 匹配）相关候选再现时，猫 context 注入对应 envelope → 对该 subject 补合格 provenance 重提而不是弃提；其他 subject 的提议行为不受影响
- **Success evidence**: UI 截图 + store 落账查询 + 猫侧 context 注入复现（路径 Design Gate 后定）
- **Non-goals**: 不强制填写拒因（可跳过）；不给猫看接受率统计（A6）；不做拒因的自动语义分析

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | session | 猫猫 | hold_ball 被 cancel → 收到 cancel reason → 修正等待策略而非盲目重挂 | 复现脚本 |
| S2 | workspace | 猫猫 | 相关候选再现 → 对应拒因 envelope 注入 → 对**该 subject** 的行为修正与拒因分类一致（其他 subject 不受影响） | F282 联测 fixture（含有界性负向断言） |

## Acceptance Criteria

<!-- 每条 AC trace 回 Why：断裂三段（采集/结构/回流）各有硬验收；出生三件套防复发 -->

### Phase A（盘点 + 契约，✅）
- [x] AC-A2: 拒因分类集进 shared types，每类附行为修正方向映射注释；F272 `not_now`/`wrong` 语义兼容（不产生平行分类）；证据：`packages/shared/src/types/human-disposition-feedback.ts` 及 `human-disposition-feedback.test.ts`。

### Phase B（采集）
- [x] AC-B2: hold_ball cancel 的**解释性反馈适配层**落在 F280 canonical
  `UserCancelWaitTerminationEventV1` 上——新 owner-authenticated route 只接受 optional strict
  feedback，F280 event 零 feedback，F281 adapter 生成 `wait_cancel` episode/envelope；producer truth
  与 content-free receipt/index 原子落 Redis、TTL=0、可由现有 authenticated ledger query hydrate。
  RED/GREEN：`f280-user-cancel-termination.test.js`、`f280-wait-termination-redis.test.js`、
  `wait-termination.test.ts`；旧 callback cancel API 未修改、未调用。

### Phase C（落账 + 有界回流）
- [x] AC-C1: 裁决 episode 落账可查询（含拒因、lane、裁决者、时间、envelope 有效域）。
  F225、person-bound F276 与纯 unbound F276 都由 producer 原子写 canonical entry +
  content-free F281 receipt/index，authenticated query + TTL=0；owner-authenticated exact
  `proposalId` purge 对纯 unbound terminal lineage 做 fenced、幂等、跨 owner 等权清除，
  person-bound fail closed 并导向既有 `forget_person_relationship`。证据：
- [x] AC-C2: **有界回流**实测——exact `subjectRef`/verified lineage 再现时对应 envelope
  在 serial/parallel 专用 prompt segment 注入可见；同 lane `Alden` subject 不注入，单条拒因
- [x] AC-C3: 反向验收——fixture 与 contract tests 锁住无面向猫的接受率/分数/global-policy
  投影；rendered block 只含 enum reason + exact-subject correction。证据：

### Phase D（反射沉淀）
- [x] AC-D1: 出生三件套反射已落
  ADR-038，`feat-lifecycle` Design Gate checklist
  引用；F281 的 feedback expression / TTL=0 episode truth / exact-subject consumer
  对照表是首个合规样例。

## Eval / Tracking Contract（草案，Design Gate 走 eval-design 出生证补全）

> Sol review：以下每个不确定效用指标在 Design Gate 走 eval-design 补出生证规范字段——`utility_claim / estimator / validity_bounds / consumer / calibration_plan / repeatability_contract`。单指标不做裁决依据——裁决用约束向量（审批负担 / 污染·误提率 / 覆盖机会）。采集覆盖与延迟属 observability（F153），不进 eval。

- **Primary Users**: 全体猫（提案/等待侧）+ operator（裁决侧）
- **Activation Signal**: 拒绝/取消动作携带拒因的比例 > 0 且持续
- **Friction Metric**: `other` 自由文本占比持续过高（分类集不够用）；拒因填写引入的裁决时长增量
- **Regression Fixture**: 周玉晶场景重放——拒因=`bad_evidence` envelope 回流后，猫对**同一 subject** 的下轮行为是补 provenance 重提而非弃提，且不改变其他 subject 的提议行为（有界性断言）
- **Sunset Signal**: 拒因长期 ≥90% 空置（operator不愿填；样本量契约 Design Gate 定）→ 交互形态重新设计或降级
- **Consumer**: F282 冷启动收敛决策（作为约束向量的一维，非单独判据）+ 分类集迭代（`other` 占比驱动 keep/tune）

## Dependencies

- **Evolved from**: 2026-07-30 proactive rules 讨论（[thread-id]）+ 《Proactive 度量系统 v0.1.2》episode 坐标系
- **Satisfied by**: F280 Phase B0 canonical user-cancel termination event + owner-authenticated
  feedback adapter anchor；F281 继续不接旧 callback API。
- **Related**: F246（Approval Hub UI 宿主）、F280（**边界已裁定**：F280 拥有 wait 的终止状态语义，本 feat 只拥有"用户取消后的解释性反馈"适配层——双向登记，F280 侧由 owner Maine Coon登记）、F272（结构化 echo 分类学源头）、F192（episode/eval 基建 + permission cancel 结构化输入正样本）、F276 / F221（第一批消费面）

## Risk

| 风险 | 缓解 |
|------|------|
| F280 并行收敛 hold_ball 契约，cancel reason 打在旧 API 上白做 | AC-B2 已绑定 F280 canonical event + 新 owner-auth route；legacy callback API 保持零改动，事件 schema test 拒绝 feedback 混入 |
| 抽象空转（脱离真实消费面做纯契约设计） | 验收场景硬绑记忆 proposal reject + hold_ball cancel 两个已实锚的面 |
| 分类集过度设计 | 初版 ≤6 类 + other；按真实拒绝样本迭代，`other` 占比是信号（见 Eval） |
| 只采不消费（死遥测） | AC-C2 回流是硬验收；出生三件套第③问制度化 |
| 拒因变成裁决摩擦（每次拒绝多一步） | 可跳过不强制；一键分类优先；Friction Metric 盯裁决时长 |
| 单次拒因被过度泛化成 lane 级/全局策略（系统亲手制造错误泛化） | KD-4 有界 envelope + 触发式回流；AC-C2 负向测试；`other` 自由文本不进自动回流 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 与 F282 **按职责切分**（Sol review 修订，替代最初的时序切分）：本 feat 管通用 human-disposition feedback envelope（拒因采集/落账/有界回流），F282 管 memory producer lifecycle（候选发现/证据/预检/pending 生命周期——含裁决后的 producer 撤回）；materialization 归各 memory lane | 时序切法（裁决前/后）有反例：producer 撤回发生在卡片生成后仍属 producer lifecycle；职责切分无此洞。operator 2026-07-30 拍板拆二 | 2026-07-30 |
| KD-2 | 拒因分类设计判据=每类映射一个不同的行为修正方向 | 拒因的目的是定向教学，不是统计标签；判据可裁决合并/拆分争议 | 2026-07-30 |
| KD-3 | 接受率/episode 账本绝不回灌成猫的 KPI | F272 cell 已写死 + 度量系统 A6 + 恋爱头脑战一手负定理（对 aha 设产出义务得到 aha 的尸体） | 2026-07-30 |
| KD-4 | **回流必须有界**：envelope 携带完整字段（含 `decision`、required `feedback.reasonCode`、`sourceRef`、server-bound `ownerUserId`），触发式注入且初版**只认 exact subjectRef / proposal lineage**（"同型候选"不是合法匹配范围）；单条拒因不得自动全局化；lane/跨 subject 策略只能是多样本聚合产出的独立、版本化设计者策略 | 无边界回流让系统亲自制造"拒一次人物卡→以后不提人物"的错误泛化——与本 feat 要修的病同型（Sol review 两轮 P1） | 2026-07-30 |
| KD-5 | public feedback 与 server binding 分离：public body 仅允许 `reasonCode` / `detail`；owner/cat/subject/decision/source 均由 authenticated principal + canonical decision 绑定。feedback 缺席时裁决仍成立，但只留 decision episode，不创建空 envelope | 把信任边界写成 proof-carrying input，避免 callback identity 或空 instruction 被 consumer 猜测 | 2026-07-30 |
| KD-6 | eligibility 先比 exact `subjectRef`；proposal lineage 还必须有 verified 的同 root。`now`、revision、supersession 都由显式 typed context 提供，unknown/mismatch/expired/superseded 一律 fail closed；历史 TTL=0 | 让有界回流可审计，避免 selector 猜 lineage、查 store 或把 unknown 当未失效 | 2026-07-30 |
| KD-7 | 建立独立 `human-disposition-feedback` ownership cell；它只拥有 reason/episode/envelope/exact-match contract，F246/F280/F272/F192 与各 producer 继续拥有各自的裁决或 lifecycle 状态 | 横切共享合约不应以“集中 feedback”为名搬走 producer 决策责任 | 2026-07-30 |

## Review Gate

- Kickoff spec: Maine Coon @codex-sol（operator 指定）
- Phase A 契约: 跨个体 review（分类集契约影响所有 proposal 面）
