---
feature_ids: [F313]
related_features: [F128, F167, F192, F245, F246, F266, F267, F278, F281, F311, F312]
topics: [analysis, approval, repair, outcome, paw-feel, eval, closure, orchestration, runtime-acceptance]
tips_exempt: "Phase B is merged but remains zero-activation and creates no user-visible proposal or action; after the delegated final seal, Phase C must remove this exemption and add a real tip only when the canonical Approval lifecycle contract and first repair proposal ship."
doc_kind: spec
created: 2026-08-29
description: "把分析结论经正式审批、真实修复与新鲜复验闭成一条由单一 Feature 持续负责的交付责任田，同时保留各 canonical owner 的单写边界。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-29T13:57:01Z
---

# F313: Analysis-to-Outcome Closure Command｜分析结论到真实变化闭环总控

> **Status**: in-progress | **Owner**: 小太阳·Maine Coon（@codex-sol, GPT-5.6 Sol）+ F313 指挥线程责任猫 | **Priority**: P0
>
> **operator architecture correction**: `[thread-id]#0001788010645041-000684-cb618f8e`：
> “想要把这件事情闭环的话，最好直接一个 Feature 来闭环，然后 link 其他的这些 Feat；不然这个东西永远写不完。”
>
> **operator operating correction**: `[thread-id]#0001788011821216-000734-46ece593`：
> 复用“指挥与理论 thread → 各 Phase 执行 thread → runtime 重启后验收 Phase”；当前 thread 负责验收后的
> vision 守护与继续驱动，参与其中的猫共同承担不让链路掉地的责任。

## Why

咱们已经分别拥有爪感责任回执、分析 bundle、Approval Hub、verdict case、任务球权与 re-evaluation，
但没有一个 Feature 对完整旅程持续负责。旧设计把“canonical truth 必须留在原 owner”错误地翻译成
“实施也要分散成 F245/F267、F246、F266/F281 各自的一条 Feature 施工线”。这样每条线都可能局部完成，
却没有任何一条完成声明必须证明：

```text
分析结论 → 建议修/不修/观察/信息不足 → 必要时进入 Approval
→ 审批 why → canonical repair owner → 真实变化/有意不变
→ 新鲜复验 → keep/tune/rollback/observe → 回链原始信号
```

F313 负责把这件事真正写完。它是**单一交付、集成与验收 owner**，不是新的运行时中央控制器：
实现仍扩展 F245/F267、F246、F266/F281 的 canonical extension points，但所有代码 slice、PR、Phase、
验收证据与最终关账都挂在 F313 下；既有 Feature 只提供 linked contracts，不再各自成为待追赶的项目线。

执行拓扑直接复用 F312 已有的三类线程运行法，不再发明一套 F313 专用角色、状态或路由规则：当前 thread
持 command/theory 与最终 vision guard；Phase B–D 各有一个 terminal-aggregation execution thread；Phase E 是唯一专用的
runtime-restart acceptance thread。共同责任只约束“不能让下一状态无人推进”，每个 bounded action 的 active
custody 仍由现有 `@` / structured coordination / task/lease 单点表达，不能据此产生同一 action 的多 writer
或多人同时持球。

## Current State / 现状基线

和真实 bundle `2026-08-29-eval-friction-pawfeel-breakout-insufficient-keep-observe` 为准：

| 链路位置 | 当前真实状态 | 缺口 |
|---|---|---|
| F278 signal responsibility | production accepted；44/44 durable duty receipt | 只证明每条爪感有合法处置，不是逐 finding 分析或修复效果 |
| F245/F267 analysis | Phase B 已为真实三 candidate bundle 生成逐 finding 四态、稳定 identity 与 verified repair target；v3 root 仍 quarantined | 尚未进入 F266 case/Approval/dispatch；保持 zero activation |
| F266 lifecycle | 已有 stable case、TaskStore/F167、main/live/re-eval 事件形状；Phase C 新增 v3 Approval events 与 ref-only materializer | v1/v2 历史路径保持可读；v3 只有 complete cutover + `v1_active` epoch 才能出生 proposal/custody |
| F246 Approval | 同一 ingress、producer catalog、runtime registry、adapter 与 decision route | F266 通过同一 extension point 接入；Hub 前统一为 canonical lifecycle v1，不新增 store |
| outcome lineage | stable case 内可表达 re-eval | 当前真实 bundle 无 stable case/proposal/change/outcome join，无法证明能力因此进化 |

原始断点在 `F245 actionableCandidates[].followupDraft` 之后。Phase B 已在
PR [#4136](https://github.com/zts212653/clowder-ai/pull/4136) / `main@91e6fc401f0dadbaf4212c8a4c8eb2f54b9bd23`
补齐逐 finding artifact、可信 repair target 与 quarantined v3 root；当前断点前移到 **v3 root → canonical
Approval lifecycle → safe dispatch**，且仍为零 open case/proposal/card/task/lease。

### Current Command State

| 字段 | 当前真相 |
|---|---|
| Canonical command/theory thread | `[thread-id]`（本 thread） |
| Current phase | Phase C 已合入 main、runtime 仍 dormant；下一步由独立 Phase D owner action 接续，production writer migration 保持硬停止 |
| Durable task | `0001788011552734-000721-5bace058` · `doing` · owner `codex-sol` |
| Thread convention | 复用 F312 的 command / phase execution / runtime acceptance 三类线程；不新增 role/store/status |
| Implementation authorization | `[thread-id]#0001788052080007-000526-a81101af` |
| Phase C design seal | `[thread-id]#0001788327680802-000466-ba7a600b`（APPROVED） |
| Owner-backed authorization source | `docs/features/F311-capability-evolution-workspace.md@396a379d7b` · hard constraint 13 / Phase 4 / KD-17 |
| Phase C implementation baseline | reviewed base `origin/main@ff17a8cd50610a411cf13cba7abf5b8cc4cf1d11`；landed onto `main@e0e36943254fac0e46d788ab4b56f13cb11f0e32` |
| Phase B terminal | PR #4136 · reviewed HEAD `9f2f26346a89eba34f9e9b64a59a44cf9fabde50` · merged `91e6fc401f0dadbaf4212c8a4c8eb2f54b9bd23` · Terra APPROVED · full gate PASS |
| Next gate | Phase D owner-owned intervention / receipt join；Phase C 合入不等于 production migration，owner adapter/epoch migration 仍需后续显式授权 |

## Architecture Admission

- **Architecture cell**: `harness-eval`；Approval 投影与审批语义复用 `approval-index`。
- **Map delta**: update existing cells only；不新增 cell。F313 是薄 integration/acceptance owner，不新增 store、
  queue、approval state machine、case ledger 或 outcome ledger；Phase B–D 只把新代码 anchors 补进
  `harness-eval` / `approval-index` 既有 cell，运行时 state 继续由下列 canonical owner 单写。
- **Canonical sources**: F278 signal event log；F245/F267 immutable finding/measurement artifact；
  F266 case event stream；F246 ApprovalIngress + producer adapter/decision route；真实资产 owner mutation receipt。
- **Completion truth**: 本 Feature 的 AC、phase ledger 与端到端 acceptance packet；它只证明各 owner refs 已经
  按同一 journey 接通，不复制其 payload/state。
- **Claim guards**: finding/root schema tests、Approval admission/decision contract tests、dispatch exactly-once tests、
  owner-drift supersession tests、cold-start action scenarios、真实 merged+loaded runtime acceptance。

### Single-Feature ownership boundary

| F313 持有 | 既有 owner 继续持有 | 明确禁止 |
|---|---|---|
| 一份 spec、一个 current phase、跨 owner release 顺序、集成计划、端到端 AC、真实 acceptance 与最终 close | F278 signal/disposition；F245/F267 finding/measurement；F246 approval；F266 case/dispatch/outcome；source owner mutation | 为每个 owner 再开独立 Feature；F313 新建 ProposalStore/ApprovalQueue/CaseStore/OutcomeStore |
| 每个 implementation slice 的依赖、exact HEAD、merge/live ceiling 与 terminal packet | 各代码模块的 writer、schema、route 与业务 CAS | 用“F246 完成”“F266 完成”等局部声明代替 F313 闭环 |
| 一条真实 paw-feel 的 source→outcome 端到端证据链 | 每段证据正文和状态仍在 owner store | 在 F313 复制 payload 或从聊天推断 approval/change/outcome |

## What

### Phase A: Single Feature Freeze｜单 Feature 真相与 Design Gate

- 建立 F313 spec、BACKLOG 入口与当前 thread 的唯一 command responsibility；
- 将原审计从“owner-split repair phase”纠正为“F313 单 Feature，linked owner contracts”；
- 冻结 owner/source/join matrix、Approval 唯一入口、软认知 action、证据 ceiling 与 close gate；
- 形成一份实施计划；后续可以有多个 PR，但全部使用 F313 scope 与同一 AC/phase ledger。

### Phase B: Finding Artifact Contract｜逐 finding 身份与真实 repair target（不激活 case）

- F245/F267 为每条 actionable candidate 生成独立 immutable finding artifact、稳定 `findingKey`、
  `repair | no_repair | observe | insufficient`、rationale、falsifier 与 withdrawal condition；
- 每条 finding 生成独立 child packet/bundle/v3 lifecycle root；aggregate verdict 只保留窗口语义；
- `harnessUnderEval` 保持 domain truth，`ResolvedRepairTargetV1` 单独保存 verified feature/component/owner/ref；
- target unresolved/mismatch 时 fail closed，不能 fallback 到 F245 domain owner，不能出生 proposal/task/lease。
- Phase B 只交付 finding/root schema、deterministic serialization 与 owner artifact；生产 case loader / `case_ready`
  activation 留到 Phase C 原子 cutover。在 Phase C 未完整加载前，即使 Phase B 代码已在 main/runtime，仍必须
  零 open actionable case、proposal/card/task/lease。

### Phase C: Approval-Gated Action + Safe Dispatch｜审批接线与安全派工原子 cutover

**Entry gate（2026-09-02）**：统一设计已由
`[thread-id]#0001788327680802-000466-ba7a600b` seal 为 APPROVED；Phase C 同时消费
`docs/features/F311-capability-evolution-workspace.md@396a379d7b` 的 hard constraint 13 / Phase 4 / KD-17。
唯一业务代数是 `Resolution(open|accepted|rejected|closed_without_decision) × Materialization`；旧 producer
词汇只允许在 registry adapter boundary 归一。`ApprovalPublication` 继续承担同一 proposal 的
card/provenance commit，不是业务 lifecycle，也没有新 store/queue/state machine。

- F266 v3 root loader / case admission 与既有 case stream 的 immutable proposal/decision/supersession events 同时启用，
  不新增 proposal store；
- F266 producer 原子接入 F246 catalog、runtime registry、ApprovalIngress、adapter 与 decision route；
- 每个 producer 绑定 lifecycle contract version 与 writer generation；durable TTL=0 epoch 只允许
  `legacy_active → draining → fenced → v1_active`，missing/corrupt/read error 对双 writer fail closed；
- draining 只允许 legacy in-flight decision/materialization/recovery；先持久进入全写关闭的 fence，再等待
  quiescence 单调收敛为零，最后凭 cutover receipt 切到 v1 writer；
- Approval origin 由 authenticated invocation 服务端派生；`clientMessageId` 仅作幂等，body 不得覆盖身份；
- approve/reject/withdraw/supersede 与 typed why 可回链 proposal；pending/rejected/withdrawn/superseded 零派工；
- 普通 `observe/insufficient` 自动复查，只有请求改变、采纳、预算、scope 或 owner 决策时才进入 Approval。
- F266 append `case_ready_for_proposal`，向 canonical system thread/resolved owner 投影 `caseActionRef`；
- ref-only action 只接受 `caseActionRef + clientMessageId`，服务端从 canonical case 装配 proposal；
- `code-as-harness` 只在已确认重复摩擦场景指向同一 action；非摩擦 case 直接由 F266 projection 唤醒；
- hard route 未部署时返回 `approval_route_unavailable`，猫不得降级到聊天、F128、F193 或手工 `assign_work`；
- proposal 前与 accepted dispatch 前均调用 canonical owner resolver；其返回 opaque `ownerAuthorizationRef`、
  exact `targetVersionRef`、owner/dispatch refs，全部进入 request/approval/dispatch/receipt lineage，F313/F311
  不解析或复制 permission payload；
- 只有 active proposal + fresh accepted Approval + exact target/version/authorization 全匹配，canonical repair
  owner 才按稳定 `dispatchId` exactly-once upsert 一个 Task/F167 lease。F266 先以 event-log CAS 持久化唯一
  materialization attempt；owner 在同一原子边界内复核 opaque refs 并 upsert custody，stale/blocker 结果证明
  零 Task/lease。任一 owner/target/auth drift 都用单一 supersession event 同时封死旧批准并出生 linked fresh
  cycle；该事件也是 crash/retry 后的恢复真相源，绝不复用旧权限或依赖第二次 append。
- F266 case admission、F246 admission、F266 action route 与“未批准不得 Task/lease”dispatch guard 是**同一个
  runtime cutover unit**：loader/producer/adapter/guard/route 任一未部署或未加载时，整条 repair route 保持关闭，
  零 open actionable case/proposal/card/task/lease；
  Phase C 不能以“producer 已合入、guard 下一 Phase 再开”作为 terminal。代码合入时若 production 仍缺
  canonical owner adapter 或 epoch migration receipt，composition 必须整体 inactive、route 返回
  `approval_route_unavailable`；这属于本 Phase 的安全落地状态，不得伪装成已迁移或 live。

### Phase D: Mutation + Outcome Join｜真实变化、有意不变与新鲜复验

- 真实 feature/asset owner 执行 mutation，并返回 commit/asset version、main、live 或 no-change receipt；
- F266 将 proposal、approval decision、task/lease、mutation、intervention version 与 re-evaluation 连回同一 case；
- outcome 只允许 `effective/keep`、`ineffective/tune-or-rollback`、`rubric_reopen`、`insufficient/observe` 等诚实终态；
- `merge != live`、分析完成 != 能力进化；只有 merged+loaded 后的新鲜、未污染复验才能支持 keep。

### Phase E: Runtime Acceptance + F311 Consumption｜重启后真实闭环与关账

- 选择一条真实 paw-feel，从原消息走到 finding、必要的 F246 Approval、真实 owner change/no-change 与 fresh outcome；
- 另跑一条普通 `observe/insufficient`，证明系统自动复查且不制造 Approval 卡；
- 负例覆盖未批准派工、origin 伪造、owner unresolved、target drift、旧批准复用、重复 replay 与 route unavailable；
- F311 只消费完整 lineage refs，不新增审批/修复/outcome state；
- 非作者在 runtime restart 后按 source refs 复核整条旅程，command thread 再做 vision guard，F313 才能 close。
  任一 owner action 只完成局部时，F313 保持 open。

## Three-Thread Operating Model｜复用三类线程，不新增规则体系

这不是 F313 新造的 workflow/state machine，而是复用 F312 已经跑通的 closure-command convention。三类 thread
只表达工作载体；Feature/AC/task 仍是 completion truth，`@` / structured coordination / F167 仍是 active custody，
F245/F246/F266 与真实 owner store 仍是业务真相。thread 标题、聊天 ACK 或“大家都负责”都不能替代这些 owner。
本次复用只写在 F313 Feature contract，不把三类 thread 提升为新的全局 SOP、Skill、L0 规则或运行时状态机；
是否形成跨 domain meta method，仍等待 F312/F313 至少两个真实闭环周期的 reflection 证据。

### 1. Command / Theory Thread｜指挥与理论线程

当前 canonical command thread 是 `[thread-id]`。在本 thread 接过 F313 球、更新 command state、
参与 phase/vision 判断的猫共同承担**责任猫**义务：任何 terminal 到达后，都不能只给建议或等operator再问，
而要完成核验并推动下一状态迁移。

共同责任不等于同一 action 多人同时持球。每个 bounded action 只有现有 custody 机制认定的 active holder 能
执行对应副作用；必要并行仍使用既有 structured parallel / 独立 task，每个 action 各有 custody，但不能并行
激活两个 F313 Phase。一次性只读 reviewer 的责任止于 exact verdict。command thread 不写实现，也不复制
approval/case/outcome state，只做：

1. 冻结理论、Phase 顺序、owner contract 与验收 ceiling；
2. 发起当前 Phase terminal-aggregation thread，并用既有 structured action/task 把 bounded action 投给真实 owner；
3. 消费各 action terminal，形成 Phase terminal 后核 exact review/merge/main truth；
4. Phase B–D 全部 terminal 后发起并消费 Phase E runtime acceptance；
5. 验收后做 vision guard：通过则给 F311 refs-only terminal 并 close，失败则把 finding 投回原 Phase thread。

### 2. Phase Execution Thread｜各 Phase 执行线程

Phase B–D 各有且只有一个 canonical execution thread；Phase A 留在 command thread，Phase E 留给 acceptance thread。
这个 thread 是该 Phase 的**终态汇总 carrier**，不直接持有 F245/F246/F266 的业务 authority，也不把不同 owner
塞进同一 action custody。一个 Phase 内的每个 bounded owner action 继续使用现有 structured action / task / lease
独立持球；Phase thread 只等待并汇总这些 terminal refs，**不再按 owner 拆新 Feature、平行 Phase 或额外 command thread**。

“三类 thread”是分类，不是要求 kickoff 时预建固定数量。Phase B–D 的 execution thread 只在对应 Phase
发车时按需建立；未启动 Phase 不建空 thread，失败复用原 thread，完成后只保留 terminal refs。

execution thread 默认 final-only 回 command；普通施工 chatter 不回灌。terminal packet 至少包含：

- Phase ID 与满足/未满足的 F313 AC；
- exact reviewed HEAD、PR/merge SHA、main containment 与 cleanup truth；
- `fixture | main | loaded | UAT` 证据 ceiling、负例与 unsupported claims；
- 所有同 Phase bounded action 的 terminal refs；局部 PR、测试计划、Approval 卡或 ACK 不算 terminal。

若 Phase E 验收失败，修复回到**原 canonical Phase B–D thread**及准确 owner action；不另开“验收修复 thread”、不在 acceptance
thread 顺手改代码，也不把失败包装成新 Feature。

### 3. Runtime Acceptance Thread / Phase E｜重启后验收

Phase E 是唯一专用 runtime acceptance thread。只有 Phase B–D terminal 均已由 command 核验、代码已合入 main
且目标 runtime 已重启加载后，才允许发车。中间 Alpha/main 检查属于 execution evidence，不另立 acceptance phase。

验收猫不参与被验代码的实现，并且只做真实 paw-feel、observe/insufficient 零卡旅程及负例复核；它记录
deployment revision、source/owner refs、main/live ceiling 与 fresh outcome。失败返回 typed finding，不修代码；
成功 terminal 交回 command thread，由责任猫做最终 vision guard，而不是让 acceptance verdict 自动 close Feature。

### Machine-driven closure loop

```text
command 发 Phase B execution → terminal → command 核验
  → Phase C execution → terminal → command 核验
  → Phase D execution → terminal → command 核验
  → Phase E runtime restart acceptance
  → command vision guard
      ├─ fail：finding 回原 Phase thread，F313 保持 open
      └─ pass：F311 refs-only terminal → F313 Close Gate
```

这个分解把复杂度放在正确位置：业务 state 留在 canonical owner，阶段施工留在 execution thread，真实验收留在
acceptance thread，只有“下一步与是否关账”回到 command。除此之外不新增 coordinator、registry、thread status
或 meta-SOP。

## First-Principles / Mathematical-Beauty Audit｜第一性原理与数学之美

最小问题只有三个互不相同的动作：**决定下一步**、**改变系统**、**证明改变已在真实 runtime 生效**。它们分别
对应 command、execution、acceptance；不是因为喜欢“三层”，而是因为少一类会混淆权责，多一类没有新增信息。

| 变换 | 会发生什么 | 判定 |
|---|---|---|
| command 与 execution 合并 | 总控开始替 canonical owner 写实现，理论/进度/业务状态混成一份聊天真相 | 不可合并 |
| execution 与 acceptance 合并 | 作者边改边验，失败时顺手补代码；`main`/fixture 容易冒充 loaded outcome | 不可合并 |
| 再拆 owner/slice/review/fix thread | 不增加 authority 或证据，只增加协调税、状态同步和掉球点 | 必须删除 |
| 新建 responsibility registry / command store | 复制 task/custody/owner truth，制造第二真相源 | 必须删除 |
| 直接提升成全局 meta method | 两个真实闭环周期尚未完成，抽象早于证据 | 暂不出生 |

所以最简不变量是：**一个 Feature completion truth、一个当前 Phase、每个 bounded action 一个 active custody、
业务状态只在原 owner、一次独立 loaded-runtime acceptance、一次 command vision guard**。任何新增概念若不能
保护其中一项，就不进入实现。

## Mechanism Selection｜按 claim 选机制

| Claim | 机制 | 验证/consumer |
|---|---|---|
| 未批准不得派工；target/origin/replay 必须准确 | schema + test + runtime guard | F246/F266 contract tests、negative scenarios、exactly-once assertions |
| case/action/Approval 路由是否健康、是否超时 | F153 logs/metrics/traces（真实需要时） | named operational consumer；不默认挂 Eval Hub |
| repair 是否真的改善目标 | F192/F267/F266 outcome eval | 明确 keep/tune/rollback/observe consumer 与独立新鲜证据 |
| 冷启动猫怎样想起并走唯一入口 | F266 projection + tool description；摩擦场景复用 Skill pointer | 五个冷启动 scenario contracts |

## Human Disposition Feedback（F281 / ADR-038）

```yaml
human_disposition_feedback:
  feedback_expression: approve 默认 accepted_as_proposed；reject/not_now/withdraw 提供结构化原因、other 与 skip；skip 不生成空 F281 envelope
  episode_truth: F266 TTL=0 canonical decision event；需要负向细节时引用 F281 exact-subject episode
  consumer: 当前 proposal/case 的 revision、next action 与 F311 exact-lineage consumer；禁止外推成全局政策
```

审批动作本身就是决策信号，不要求 operator 再写一份标签。普通 observe/insufficient 不出生 proposal，避免把用户
变成标注员；只有真实请求人类裁决时才进入 F246。

## User Journey

### Primary Journey: 一条真实爪感从“有人看”走到“系统真的变了或诚实不变”

- **Scope unit**: finding/case
- **Actor**: 值班猫、分析猫、operator、canonical repair owner、验收猫
- **Entry**: F278 已登记并完成责任处置的一条真实 paw-feel signal
- **Flow**:
  1. F245/F267 形成逐 finding 结论、证据强度与真实 repair target；
  2. F266 投影唯一合法 action；普通观察自动复查，需要改变时才生成 proposal；
  3. proposal 进入 F246，operator 在现有 Approval surface 看见建议、证据、不确定性、owner、成本与撤回条件；
  4. 批准后 F266 才派给 canonical owner；拒绝/撤回/漂移均不派工；
  5. owner 返回真实 change/no-change receipt，系统在 merged+loaded 后用新鲜证据复验；
  6. 原 paw-feel、finding、approval、change 与 outcome 可沿 refs 回看；只有 verified keep 才称能力进化。
- **Success evidence**: 真实 sourceMessageId → findingKey/caseId → proposalId/ApprovalEnvelope → task/lease →
  mutation/no-change receipt → fresh resultRef 的可重放 acceptance packet
- **Non-goals**: 新建中央 proposal/outcome store；为每条 observe 打扰用户；F311/F278 接管 repair；
  用 fixture/main/聊天结论冒充 production outcome

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|---|---|---|---|---|
| S1 | observe case | 系统 | `observe/insufficient` → no proposal → nextEvalAt 自动复查 | Approval 零卡 + recheck event |
| S2 | owner drift | F266/F246 | 旧 target invalidated → old approval audit-only → linked new cycle → fresh approval | supersession + exactly-one task/lease test |
| S3 | cold-start action | 猫猫 | case-ready projection → ref-only action / typed blocker | 五场景 contract fixtures |
| S4 | F311 lineage | CEW consumer | 消费 owner refs → 展示 verified status，不复制 payload | refs-only projection test |

## Acceptance Criteria

### Phase A（单 Feature 真相与 Design Gate）

- [x] AC-A1: F313 是 BACKLOG 与当前 thread 中唯一的端到端交付 Feature；原审计与所有 owner links 指向 F313，
  且不存在分别挂在 F245/F246/F266/F278/F281/F311 下的平行 implementation phase。
- [x] AC-A2: 一份 implementation plan 覆盖 Phase B–E、每个 bounded owner action 的 code anchors/custody/terminal、
  Phase terminal 与 release 顺序；任一局部 action 完成不能把 F313 标为 done。
- [x] AC-A3: Architecture Design Gate 证明 F313 不新增运行时 authority/store，所有 write path 命中现有
  `harness-eval` / `approval-index` / source-owner extension point。
- [x] AC-A4: 当前 thread 是唯一 command/theory thread；Phase B–D 各自只有一个 terminal-aggregation execution
  thread，Phase E 只有一个 runtime acceptance thread。Phase thread 不持业务 authority，共同责任与 per-action
  custody 分离，且未新增 role/store/status/路由规则。

### Phase B（Finding Artifact Contract）

- [x] AC-B1: 真实三-candidate bundle 产生三个独立 stable finding/root；aggregate verdict 不覆盖逐项四态，
  replay 得到相同 finding identity。
- [x] AC-B2: `harnessUnderEval` 与 `repairTarget` 分离；target unresolved/mismatch/drift 在 proposal/task/lease 前
  fail closed，且不能把 F245 domain owner 当 repair owner。
- [x] AC-B3: Phase B 已合入/加载而 Phase C cutover 未完整时，真实 finding/root serialization 可复核，但 F266
  loader 不出生 open actionable case，且 proposal/card/task/F167 lease 全为零。

### Phase C（Approval-Gated Action + Safe Dispatch）

- [x] AC-C1: F266 v3 root loader/case admission/producer、F246 catalog/registry/ApprovalIngress/adapter/decision route、
  case-ready action 与 dispatch guard 作为一个 runtime cutover unit 部署；Hub 仍是 read-through projection，
  不出现第二 proposal DB。
- [x] AC-C2: approve/reject/withdraw/supersede 与 decision why 可沿 proposalId 回链；普通 observe/insufficient
  无 Approval 卡，真正请求改变/投入时必须有 Approval。
- [x] AC-C3: authenticated invocation 服务端派生 Approval origin；伪造 body/clientMessageId、缺 record、错 principal
  与未审计 exemption 均为零 proposal/card/event side effect。
- [x] AC-C4: 冷启动猫在 repair、observe/insufficient、owner unresolved、rejected/superseded、route unavailable
  五种场景得到唯一合法动作，无需阅读本审计，也不能手填 proposal 或旁路 F246。
- [x] AC-C5: pending/rejected/withdrawn/superseded/旧 target version 都不能创建 TaskStore task 或 F167 lease；
  fresh approved exact target 恰好创建一次。
- [x] AC-C6: 批准后派工前 owner drift 产生 typed invalidation → 旧批准 side-effect-ineligible → linked new cycle →
  fresh Approval → 新 target exactly-one task/lease，旧 immutable root 不被覆写。
- [x] AC-C7: loader/producer/adapter/guard/route 任一缺失、未加载或版本不一致时，repair route fail closed，零
  open actionable case/proposal/card/task/lease；“root 或 Approval 已接入，但 dispatch guard 下一 Phase 再开”
  不能通过 Phase C terminal。

### Phase D（Mutation + Outcome）

- [ ] AC-D1: repair 与 no-change 两条路径都生成 owner receipt，并分别记录 main/live/no-change；聊天或 merge
  不得单独满足 mutation AC。
- [ ] AC-D2: outcome 与 source/finding/proposal/approval/intervention/change 同 case 回链；新鲜复验能诚实产出
  keep/tune/rollback/rubric-reopen/insufficient，失败与不足不被吞掉。

### Phase E（Runtime Acceptance + Close）

- [ ] AC-E1: 至少一条真实 paw-feel 在 merged+loaded runtime 完成 source→analysis→Approval（若需）→repair/no-change
  →fresh outcome 的全链路，非作者可沿 opaque refs 复核。
- [ ] AC-E2: 至少一条真实 observe/insufficient 旅程自动复查且零 Approval 卡，证明用户没有被变成逐条标注员。
- [ ] AC-E3: F311 只消费 owner refs/lineage edge/terminal status；F278/F311 均无 proposal、approval、dispatch、outcome
  shadow state。
- [ ] AC-E4: 所有 Phase AC、owner terminal、main/live ceiling、负例与 Close Gate 对照表齐全后才可关闭 F313；
  command thread 在 acceptance terminal 后完成 vision guard；任一 linked Feature 的局部完成、open PR、测试计划、
  Approval 卡或 acceptance verdict 本身都不能冒充 F313 完成。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|---|---|---|---|---|
| R1 | “最好直接一个 Feature 来闭环，然后 link 其他这些 Feat” | AC-A1, AC-A2, AC-E4 | feature truth、单一 plan、Close Gate source map | [ ] |
| R2 | “不然这个东西永远写不完”——必须有人持续持球到真实终态 | AC-A2, AC-E1, AC-E4 | terminal packets + real acceptance | [ ] |
| R3 | Proposal 必须进入家里的 Approval，不能造影子审批 | AC-C1–AC-C3, AC-C5, AC-C7 | F246/F266 contract + partial-cutover negative tests | [x] |
| R4 | 猫猫必须知道何时提案、何时自动复查、何时停手 | AC-C4–AC-C7 | cold-start scenario fixtures | [ ] |
| R5 | 用户不是标注员，“分析过”不能冒充“能力已进化” | AC-C2, AC-D2, AC-E2 | zero-card observe + fresh outcome | [ ] |
| R6 | “指挥与理论 thread 负责验收后的 vision 守护 + 驱动干活，thread 里的猫是责任猫” | AC-A4, AC-E4 | command terminal→vision guard→next/close transitions | [ ] |
| R7 | “各 Phase 执行 thread；runtime 重启之后的验收 Phase” | AC-A2, AC-A4, AC-E1 | Phase B–D terminal packets + Phase E deployment receipt | [ ] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC。
- [x] 每个 AC 都有 test、source map、runtime receipt 或非作者 acceptance 等可复核证据。
- [x] Approval 卡的真实产品壳主旅程、默认/负向状态与窄屏呈现已在 implementation plan §4 冻结到现有
  `ApprovalPendingPane` / `ApprovalItemCard` / `ApprovalHistoryPane` / `MobileApprovalSheet` 与真实组件测试；
  不建 F313 专用页面或 schema-only demo。

## Dependencies

- **Evolved from**: F266（稳定 case/dispatch/outcome lifecycle）+ F278（真实 paw-feel responsibility loop）。
- **Blocked by**: Phase B 无外部 blocker，已完成；Phase C 入口受全家统一 Approval 生命周期 canonical
  contract/spec/code landing 约束，未落地前不得新增 legacy F266 producer 或 F313 shadow lifecycle。
- **Related**: F245/F267（finding/measurement）、F246（Approval）、F281（负向 why）、F311（refs-only consumer）、
  F128（仅 owner thread 建立）、F167（审批后 executable custody）、F192（不确定效用 outcome）。

## Risk

| 风险 | 缓解 |
|---|---|
| 单 Feature 退化成新的中央系统 | F313 只持交付顺序/AC/acceptance；所有运行时 writer 与 payload 留在 owner extension point |
| “link 其他 Feature”又变成分散项目线 | owner work 一律作为 F313 Phase 下的 bounded action；不 reopen/另立 linked Feature，不接受局部完成作为 F313 exit |
| 大 Feature 永远 open | Phase 顺序 + Phase terminal packet + 一条真实 E2E close gate；不新增无证据 phase，也不允许 deferred 尾巴 |
| 跨 owner PR 互相等待 | F313 同一时刻只激活一个 Phase execution thread；其完整 terminal 后同回合核验并推进下一 Phase |
| “全体责任猫”被误读成同一 action 多人同时持球/写状态 | collective responsibility 只约束不掉球；每个 bounded action 的 active custody 与副作用仍由现有 @/coordination/task/lease 单点表达 |
| thread 数继续膨胀 | 固定为一个 command thread、Phase B–D 各一个 terminal-aggregation thread、一个 Phase E acceptance thread；失败复用原 Phase thread |
| acceptance thread 顺手修代码或自动 close | acceptance 只产 typed finding/terminal；失败回原 execution thread，成功仍由 command 做 vision guard |
| 两个 Feature 都用了三类 thread，就提前升格全局方法 | F313 只作 feature-local reuse；完成两个真实周期并 reflection 前不建 Skill/SOP/L0 规则 |
| finding/root 或 Approval producer 已加载但 dispatch guard 尚未加载 | Phase B case activation 延后，原 C/D 合并为一个 Phase C runtime cutover；任一组件缺失或版本不一致时 repair route 全关闭、零 open case/proposal/card/task/lease |
| Phase C 沿用旧 Approval publication 状态，随后再迁统一 contract | 在 Phase C 入口冻结代码；先完成全家 canonical Approval contract，再让 F266 作为同一 producer extension point 的消费者，禁止双状态机/过渡 producer |
| Approval 卡过量 | 只有请求改变/采纳/继续投入才出生 proposal；observe/insufficient 自动复查 |
| owner 漂移复用旧批准 | target version + explicit supersession + fresh Approval + dispatch-time resolver guard |
| “main 绿了”冒充真实进化 | Phase E 必须 merged+loaded real paw-feel + fresh outcome + 非作者复核 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| KD-1 | 新立 F313 作为唯一 delivery/integration/acceptance Feature | canonical owner 分散不等于项目责任也要分散；单 Feature 才能定义一条不可局部冒充的 close gate | 2026-08-29 |
| KD-2 | 不把 F313 变成新 control plane/store | F245/F246/F266/F278/F281 已有自然 owner 与 extension point，复制会破坏单一真相源 | 2026-08-29 |
| KD-3 | 当前调查 thread 直接承担 F313 command responsibility，不再为立项新开 thread | 避免继续扩散；原始问题、operator纠正和设计证据都在同一 source thread | 2026-08-29 |
| KD-4 | 一个 Feature 可有多个 owner slice/PR，但只有一个 close | 兼顾代码归属与端到端完成责任，阻止“每条线都差最后一棒” | 2026-08-29 |
| KD-5 | F311 只在完整链路成立后消费 refs | 不把普通确定契约修复包装成 Evolution Program，也不让 F311 代建 repair 系统 | 2026-08-29 |
| KD-6 | Feature-local 复用 F312 的 command / phase execution / runtime acceptance 三类 thread | 复用比新增 F313 workflow/角色体系更简单；真实周期不足前不升格全局方法 | 2026-08-29 |
| KD-7 | 责任猫是 collective no-drop obligation，每个 bounded action 的 active custody 仍单点 | 保留共同愿景责任，同时不破坏 @ 路由、Task/F167 lease、显式 parallel 与 canonical single-writer | 2026-08-29 |
| KD-8 | Phase B root 保持 non-actionable，原 Approval Admission 与 Safe Dispatch 合并为一个 Phase C 原子 cutover | finding/case、ingress、action、guard 任一单独上线都会制造未批准直派或孤儿审批的危险半态 | 2026-08-29 |
| KD-9 | Phase C 不沿用 legacy `ApprovalPublication` 生命周期；先等统一 Approval contract canonical landing 后再实现 | 新增 F266 legacy producer 会立刻制造待迁移的第二套语义；F313 应消费唯一 Approval contract，而不是为时间表复制状态机 | 2026-08-31 |

## Review Gate

- Phase A: 非作者审“单 Feature 是否真持完成责任、三类 thread 是否复用而非造规则、责任/球权是否冲突、是否复制 canonical authority”。
- Phase B–D: 每个 bounded owner action 遵循 TDD 与 exact-HEAD 非作者 review；Phase thread 汇总全部 action terminal 并写 F313 AC delta。
- Phase E: 非实现作者在独立 acceptance thread、merged+loaded runtime 走真实 paw-feel 与 observe 两条旅程；command thread 随后做愿景对照/Close Gate。

## Tips Contribution（F244）

F313 不新增另一套用户概念。Phase C/D 在现有 Approval/Workspace 能力说明中补一条 source-linked 提示：
“分析建议只有在请求改变/投入时进入 Approval；观察/证据不足会自动复查。”提示只导航 F246/F266 canonical
surface，不复制 proposal 状态或判断表。
