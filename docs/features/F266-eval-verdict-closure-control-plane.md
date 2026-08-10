---
feature_ids: [F266]
related_features: [F167, F168, F192, F248, F267, F268]
topics: [eval, control-plane, closure, lifecycle, sla, hub, reliability]
tips_exempt: "Operational acceptance adds one narrowly scoped lifecycle-writeback MCP tool; its MCP description is the just-in-time cognitive entry, not a general proactive workflow tip"
doc_kind: spec
created: 2026-07-18
description: "把 eval verdict 从一次性报警变成可持久追踪、可回链、可复评、超时可升级的责任闭环。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-18T12:11:00Z
---

# F266: Eval Verdict Closure Control Plane — 评估结论闭环控制面

> **Status**: done | **Completed**: 2026-07-19 | **Owner**: Maine Coon Sol (@codex-sol，implementation) | **Reviewer**: Maine Coon GPT-5.4 (@gpt52) | **Vision guardian**: Maine Coon Terra (@codex-terra) | **Priority**: P1

Architecture cell: harness-eval
Map delta: none
Why: 本 Feature 只补齐 F192 已声明但未接线的 owner response、action reference、re-eval 与 SLA closure；feature-thread 不完整时仍只向既有 case event stream 写 tracked blocker，不新增 Store/Queue/Router，也不把 eval canonical state 塞进 community case store。

## Why

我们现在能让 eval 报警，却不能可靠回答“谁接了、修复 PR 在哪、修完是否复评、超时谁叫醒”。这让真实问题依赖猫四天后人肉 recall 捡球，也让operator在 Hub 里把 evaluator 误报读成“猫犯了五个错”。本 Feature 的价值不是增加状态字段，而是让每条需要行动的 verdict 最终都得到一个可验证的处置结果：修复并复评、带理由不处理，或超时升级；任何一种都不能靠聊天声明自闭环。

## Current State / 现状基线

- `ownerResponseStatus` 类型只有 `not_required | not_started`，read-model 只能派生展示，缺少 owner writeback。
- 全域都会 ensure thread，但 scheduler 只运行 enabled 域；空 thread 无 waiting-first-fire / disabled 的可信区分。
- F248 已交付人话叙事和事件视图，但修复 PR 尚未稳定回链 verdict，承诺与兑现仍不可见。
- `transitionReevalClosure(..., 'sla_elapsed')` 状态机存在，production caller 为 0；SLA 主要只参与 `nextEvalAt`。
- 2026-07-12 capability-wakeup 报警直到 07-16 才被人肉 recall 接住；修复 `50ec90163` 等 07-19 复评，是第一条可用的真实生命周期样本。

## What

### Phase A: Canonical Lifecycle Contract + Stateful Object Census

- 先枚举 verdict artifact、Hub read-model、re-eval closure、owner response、PR reference 与 scheduler 当前各自拥有的状态，禁止在未完成 census 前新增平行 Store。
- 冻结一套 canonical lifecycle 与合法转换，至少覆盖：`open → acknowledged → action_planned → fix_landed → reeval_pending → resolved`，以及 `suppressed_with_reason` / `escalated` 两条合法分支。
- 每个 `reeval_requested` cycle 在 canonical event 中固化当轮 eval-cat authority；registry/override 只选择未来 cycle，不能改写已请求 cycle 的 replay 或结果写权限。历史 request 若无法证明当时 principal，保持 unavailable，并在首个受服务端校验的结果 event 中固化该轮 authority。
- 每个新 cycle 的 `dueAt` 由 command service 以服务端时间和 canonical domain `reevalWithinHours` 派生；调用方不能自报截止期。首次写入后 deadline 成为 immutable event fact，策略变化只影响未来 cycle。
- 每次转换携带 immutable source refs、actor、occurredAt、reason；projection 可重建，聊天与 finding store 均不是 canonical。
- 采用 F168 Phase D 的 `canonical event/record → projection/checklist → reconciler finding → SLA/dead-letter resurfacing` 形状，但 eval 自持 canonical record。

### Phase B: Durable Writeback + Reconciler Vertical Slice

- 接通 owner response、implementation PR/action refs、re-eval refs 与 closure result 的持久 writeback。
- 将现有纯 transition 规则接到幂等 reconciler/scheduler；同一 SLA 只升级一次，重启后不丢、不重复。
- 保持授权边界：自动化只追踪、投影、提醒和升级，不自动修复、不自动 merge、不代 operator suppress。
- 以 capability-wakeup 07-12→07-19 的真实链为第一张工单；若历史数据缺少某段 identity，诚实标 unavailable，不伪造完整性。

### Phase C: You-facing Projection + End-to-End Proof

- 在 F248 既有 Workspace/Settings projection 上显示“问题指向谁/什么”、owner response、修复引用、复评状态、SLA 与 closure reason；不新建第二套 Eval Hub。
- 跑通修复、合理不处理、SLA 超时三条端到端路径，并证明 restart/replay 后状态一致。
- 建立 Program 级 checkpoint：F267/F268 产出的 verdict 能无特殊代码地进入同一 closure contract。

### Operational Acceptance Extension: Legacy Case Responsibility + Executable Re-evaluation

- 用受审计 migration manifest 对 `reviewedThrough` 边界内的 schema v1 actionable roots 做 completeness/freshness 复核；历史 verdict artifact 保持不可变，运行时只合成为 stable case root，并以 `legacy_case_migrated` 记录 review 时间、覆盖周期、处置类型、原 verdict refs 与已恢复的 owner/action/reeval continuity。边界后的未知 v1 root 保持隔离，不得拖垮已审核 stable cases。
- 同一 finding 的 legacy 周期归并到一个 stable `caseId`。当前 repair owner 必须来自 eval-domain registry 的 feature-owner truth，不复用 artifact 中冻结的旧 owner 文本。
- repair responsibility 与 cadence/re-evaluation responsibility 是同一 case 的两类独立债务：分别拥有确定性 TaskStore subject、named owner 和 active F167 lease；Hub/Workspace 分开展示，不能用一项的完成掩盖另一项。
- `nextEvalAt` 到期必须创建真实 re-evaluation task 与 active lease，再写入带 task/lease identity 的 `reeval_requested`；到期不是只把卡片染成 stale。
- 新 trusted verdict 先作为新 cycle 进入原 case，再以 `reeval_passed` 或 `reeval_failed` 关闭/延续当前周期并提升新周期。禁止为同一 finding 产生平行 orphan case，也禁止较旧 cycle 触发当前 repair task 的误结算。
- monitoring cycle 的 trusted re-eval 若失败，原 case 回到可绑定 responsibility 的 `open`，再创建 repair task/lease；Hub 的 repair/cadence debt 必须从当前 lifecycle state 与当前 activation 派生，不能被 `keep_observe` 标签或旧失败结果遮蔽。

## User Journey

### Primary Journey: 从报警看到真正关单
- **Scope unit**: workspace
- **Actor**: operator
- **Entry**: Workspace「评估」事件或 Settings Eval Hub 的一条需要处理的 verdict
- **Flow**:
  1. 打开事件 → 先看到问题指向 evaluator、harness、基础设施还是某只猫。
  2. 查看 owner 是否接单、对应修复 PR/处置理由与下一次复评时间。
  3. 修复后看到“等待复评”，复评通过后看到 closure evidence；超时则看到明确升级，而不是安静消失。
- **Success evidence**: 三条 journey 截图/录屏 + lifecycle record/replay 输出 + 对应 PR/reeval refs
- **Non-goals**: 不自动修复或 merge；不替代 GitHub/CI；不把所有 eval 参数搬到 Workspace；不复用 Community case store 作为 eval canonical。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | 三个 Feat 独立执行，中心只守愿景与跨 Feat 契约（msg `0001784375669179-000320-8ecbe5e1`） | AC-C4 | thread/workflow truth + phase checkpoint | [x] |
| R2 | verdict 报警后必须看得见谁接、怎么修、何时复评、是否超时 | AC-B1 / AC-B2 / AC-C1 | lifecycle replay + Hub journey | [x] |
| R3 | capability-wakeup 四天掉球案要变成第一条真实验收样本 | AC-B4 | production artifact/source-ref 对账 | [x] |
| R4 | 过程自治，只有愿景/战略/跨 Feat 契约/不可逆红灯升级中心 | AC-C4 | operating-contract audit | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求在 Phase C Design Gate 准备需求→证据映射表

## Acceptance Criteria

<!-- 每条 AC 必须 trace 回 Why，并由非作者复核。 -->

### Phase A（Canonical Lifecycle Contract + Census）
- [x] AC-A1: 落库 stateful-object census，逐一标明 verdict、response、action、reeval、SLA 当前 source of truth / writer / reader / retention；新增 canonical 前证明没有双写。
- [x] AC-A2: 生命周期状态、合法转换、terminal semantics、idempotency key 与 authority boundary 形成可执行 schema/transition tests；每轮 re-eval authority 可在 assignment override 变化后稳定 replay，无理由的“已处理”不能进入 terminal。
- [x] AC-A3: F168 复用边界写入 Design Gate：复用 projector/reconciler 范式或接口，不复用 Community case canonical store。

### Phase B（Durable Writeback + Reconciler）
- [x] AC-B1: owner response、implementation refs、reeval refs、closure result 在 restart 后仍可回读；默认无 TTL，迁移/回放测试证明旧 verdict 不丢。
- [x] AC-B2: reconciler 对同一 due item 幂等；测试证明 SLA 到期只产生一次升级，action/reeval 到达后能从 waiting 转入正确状态。
- [x] AC-B3: 自动化没有 merge/fix/suppress 权限；权限边界有失败测试。
- [x] AC-B4: capability-wakeup 07-12 报警→07-16 接单→`50ec90163`→07-19 复评链被作为真实工单摄入；缺失段显式标 unavailable。

### Phase C（Projection + E2E）
- [x] AC-C1: F248 既有两类 surface 显示问题指向、owner response、action ref、reeval、SLA 与 closure reason；主卡不暴露机器枚举。
- [x] AC-C2: 修复、`suppressed_with_reason`、SLA 超时三条 journey 均有重启后 replay + UI/CLI 证据，且 projection 与 canonical record 一致。
- [x] AC-C3: 至少一条 F267/F268 verdict 无 domain-specific closure 分支即可进入同一 contract。
- [x] AC-C4: 执行 thread 只在 phase state transition 或红灯条件回报 Program；无 ask 的 checkpoint 不要求 ACK，feature doc/workflow board 保持最新。

### Operational Acceptance Extension（Legacy + Durable Responsibility）

- [x] AC-D1: production legacy v1 actionable roots 由带 freshness review 的 manifest 完整覆盖；迁移前后 verdict artifact 内容 hash 不变，同 finding 重复周期只投影一个 stable case。
- [x] AC-D2: stable repair case 使用当前 registry owner，并创建真实 TaskStore task + named owner + active F167 lease；缺唯一 feature-thread truth 时 fail closed 为 case 上可投影、可重试的 `responsibility_blocked`，不让 scheduler `RUN_FAILED`，也不把 fallback task 堆回 eval thread。
- [x] AC-D3: keep-observe 或 live-active cycle 到达 `nextEvalAt` 后创建独立 re-evaluation task + active F167 lease，并把 identity 写进 append-only event；重试幂等。
- [x] AC-D4: trusted 后续 verdict 在原 case 内关闭或延续；新 actionable/keep cycle 被确定性提升，旧 task/refs 不泄漏，旧周期不误结算当前 repair task。
- [x] AC-D5: F192/Eval Hub 分别投影 repair debt 与 cadence/re-evaluation debt；due/in-progress cadence work 可行动，resolved repair 不能隐藏仍到期的复评。

## Eval / Tracking Contract

- **Primary Users + Activation Signal**: eval owner、Program guardian、operator；任何 actionable verdict 或超 SLA open record 激活。
- **Friction Metric**: 未认领超时数、缺 action/reeval backlink 数、重复 escalation 数、依赖人肉 recall 才闭环的数量、median time-to-ack/time-to-verified-close。
- **Regression Fixtures**: fix+reeval、suppressed-with-reason、SLA escalation；另以 capability-wakeup 真实链做非合成 replay。
- **Sunset Signal**: 若未来有另一 canonical action-lifecycle 系统在同一权限/持久性/回放契约下完整接管，并通过零丢失迁移与三路径 replay，本 Feature 的专用实现应删除；仅“有个工单 UI”不足以 sunset。

## ADR-031 三层计划

| 层 | 本 Feature 承重 |
|----|----------------|
| Soft | 状态词典、owner handoff/phase checkpoint 约定、You-facing 人话解释 |
| Hard | canonical schema、transition guard、持久 writeback、idempotent reconciler、权限与重启测试 |
| Eval | closure latency/missing-link/duplicate-escalation 指标 + 三路径持续 replay |

## Program Operating Contract

- **operator authorization**: `0001784376506778-000328-2a877146`（Fable OK 后由 Sol 直接开 Feat）；Fable OK: `0001784376508012-000331-f2b9dad1`。
- **Execution**: 独立 thread、owner、reviewer、worktree、PR；技术 OQ 自决。
- **Checkpoint delegation**: 3+ Phase 的默认 operator 碰头委托 Program guardians Sol/Fable 异步完成；feature close 仍按非作者/非 reviewer 愿景守护执行。
- **Red-light escalation only**: Why/scope/terminal predicate 改变、跨 Feat contract 漂移、隐私/数据保留/新外部依赖/不可逆动作、两轮技术僵局，才升级中心或 You。

## Dependencies

- **Evolved from**: F192（verdict handoff / re-eval closure contract）、F248（You-facing projection 缺口）
- **Blocked by**: none（可独立开工）
- **Related**: F168（closure/reconciler 范式）、F267（valid verdict 输入）、F268（tips verdict 输入）

## Risk

| 风险 | 缓解 |
|------|------|
| 又造一套 case/work-item 状态机 | Phase A census + F168 边界审计；先复用形状/接口，再决定最小 canonical delta |
| 自动升级制造噪音 | 幂等、单次 escalation、domain SLA 与 suppression reason；不自动修复/merge |
| Hub 有投影但 canonical 双写漂移 | projection 可重建 + writer 单一化 + replay 对账 |
| 中心统筹退化成人肉 PM | 只收 state transition/red light；无 ask checkpoint 不 ACK |

## Open Questions / Resolutions

| # | 问题 | 类型 | 状态 |
|---|------|------|------|
| OQ-1 | canonical lifecycle 是扩展现有 verdict artifact/closure record，还是新增持久 event record？ | 技术（Phase A census 后自决） | ✅ closed — KD-4 / KD-7 |
| OQ-2 | PR backlink 由显式 owner action 写入，还是从已授权 subject identity 派生？ | 技术 | ✅ closed — KD-5 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Eval Reliability Program 拆三 Feat，本 Feature 只拥有 closure control plane | 四条腿没有共同根因或 terminal predicate | 2026-07-18 |
| KD-2 | Program 中心守愿景，不做日常项目管理 | 三线自治减少等待；红灯条件保护跨 Feat 一致性 | 2026-07-18 |
| KD-3 | 首张工单使用 capability-wakeup 真实复评链 | 真实掉球案比只造 fixture 更能证明端到端价值 | 2026-07-18 |
| KD-4 | canonical 采用 eval 自持 append-only lifecycle event stream；Hub/finding 均为纯投影 | verdict artifact 不适合承载高频 writeback；Community store 与额外 finding store 都会制造双重真相 | 2026-07-18 |
| KD-5 | action/PR backlink 必须显式认证写入，不从 subject 名称推断 | 相似名称不是 ownership/处置身份，推断会伪造闭环 | 2026-07-18 |
| KD-6 | `escalated` 可恢复；仅 re-eval pass 与 operator reasoned suppression 为 terminal | 超时必须重浮，但迟到处置仍应在原记录上走向可验证关闭 | 2026-07-18 |
| KD-7 | generic publisher 在既有 bundle 内固化最小 `lifecycle-root.json` | 当前 packet 的 target owner 只进入 PR body，merge 后无法供 generic backfill/鉴权读取；Git artifact 补根元数据不新增 mutable Store | 2026-07-18 |
| KD-8 | eval-cat authority 按 re-evaluation cycle 写入 event，不从 replay 时的当前 registry/override 反推 | 动态 assignment 是未来调度输入，不是历史 authority；否则 override 变化会让合法旧事件失效或换人接管进行中的 cycle | 2026-07-18 |
| KD-9 | canonical lifecycle 一旦可用，Hub 的 `stale` 与 `actionable` attention 指标只从当前 lifecycle projection 派生 | immutable verdict 的原始 `nextEvalAt`/verdict 仍是历史 finding truth，但不能把新 cycle 提前判过期，也不能让 resolved/suppressed 项继续计入“需处理” | 2026-07-18 |
| KD-10 | canonical projection、writeback response、Hub 与 Workspace 的 owner/re-eval/due/escalation/attention 字段作为一张 canonical presentation-state 表整体派生 | 历史 refs 可以保留，但 terminal/recovered 状态不能继续暴露前一状态的待办标签、截止时间或红色升级提示；active cycle 日期只取 lifecycle `reevalDueAt` | 2026-07-18 |
| KD-11 | command service 与 scheduled reconciler 必须复用同一个 deterministic bootstrap prefix；首个正常 writeback 可在客户端 sequence 0 原子物化长度为 N 的 canonical prefix 后落到 sequence N（普通 root-only 为 N=1，历史导入可为 N>1） | immutable root 已经定义对象身份，首写不能依赖 10 分钟 poller 时序；多入口各造 opener 会产生双重历史，跳过 prefix 则 projector 必然 `invalid_history`，把首写映射硬编码为 1 则历史导入稳定 CAS 冲突 | 2026-07-18 |
| KD-12 | `reeval_requested.dueAt` 由服务端从 canonical domain SLA 派生，调用方只能提交 evidence；首次 event 写入后 deadline 不随 policy/registry 变化 | 让 owner 自报截止期可把 SLA 任意推远，破坏 resurfacing；重试时重新计算又会破坏 event-id 幂等与 replay truth | 2026-07-18 |
| KD-13 | legacy v1 roots 不回写、不复制新 artifact；由受审计 migration manifest + runtime synthetic v2 root 进入 stable case | 历史证据必须不可变，但不迁移会让同 finding 多张 stale 卡继续没有责任对象；manifest 同时提供 completeness/freshness fail-closed 边界 | 2026-08-08 |
| KD-14 | stable case 的当前 owner 从 domain registry truth 派生，artifact `targetOwnerCatId` 只保留历史事实 | 旧 verdict 的 owner 文本会随团队归属变化而过期，拿它创建新 task/lease 会把责任绑给错误主体 | 2026-08-08 |
| KD-15 | repair debt 与 cadence/re-evaluation debt 使用不同确定性 task subject 与 lease，并在 Hub 分栏投影 | 修复落地不等于复评完成；把两者压成一个状态会再次制造“看似 resolved、实际无人复评”的静默孤儿 | 2026-08-08 |
| KD-16 | trusted 后续 verdict 必须在同一 stable case 内 observe + pass/fail，并按 immutable cycle time 提升后续周期 | 逐 artifact 新开 case 会重复红卡；仅按“存在其他周期”判断会让历史旧周期误结算当前 repair task | 2026-08-08 |
| KD-17 | legacy manifest 的 completeness fail-closed 只覆盖显式 `reviewedThrough` 快照；快照后的未知 v1 root 隔离为 legacy subject | 审核边界不能靠“当前所有文件”隐式漂移；否则单个未来 legacy packet 会让全部 stable case 控制面不可用 | 2026-08-09 |
| KD-18 | cadence re-eval 失败从 `monitoring` 回到 `open`，由既有 responsibility service 绑定 repair task/lease；actionable cycle 失败仍由原 owner 在 `action_planned` 延续 | monitoring 原本没有 repair owner，直接进入 `action_planned` 会形成所有命令都不可达的无主状态 | 2026-08-09 |
| KD-19 | repair debt 从 lifecycle state 派生，cadence debt 优先读取当前 `live_active/monitoring` activation，再读取历史结果 | verdict label 与旧 `reeval_failed` 都是历史事实，不能遮蔽当前可执行 repair 或已经到期的新 cadence | 2026-08-09 |
| KD-20 | feature thread 缺失或不唯一时，reconciler 在原 stable case 追加 `responsibility_blocked` 并保持 responsibility 重试；唯一 truth 恢复后原位创建 feature task/lease 并以 `responsibility_bound` 清除 blocker | 进程级 `RUN_FAILED` 既不可投影也不可恢复，会让业务对象伪装成无主 `escalated`；把 task 回退到 eval thread 又会伪造归属 | 2026-08-09 |

## Review Gate

- Design Gate: architecture census + canonical ownership；若 Phase C 新增用户可见布局而非复用 F248 projection，按 UI/UX 路径升级 operator。
- 每 Phase: owner 自选非作者 reviewer；Program guardian 只做薄愿景/contract check，不替代 code review。
- Close: author、reviewer、vision guardian 三个不同个体；三条 lifecycle journey 缺任一条即 BLOCK。
