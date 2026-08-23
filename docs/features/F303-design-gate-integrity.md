---
feature_ids: [F303]
related_features: [F083, F101, F191, F192, F215, F217, F242, F267, F277, F297, F299]
topics: [design-gate, architecture-ownership, contract-integrity, consumer-discovery, review-efficiency, alpha]
doc_kind: spec
created: 2026-08-21
description: "让新增 consumer、重构与“保持既有行为”声明在现有 Design Gate 中回到同一架构真相源，并在昂贵 review 与 landed Alpha 前获得风险匹配的证据。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-22T02:44:00Z
cvo_signoff: "2026-08-21 — sourceMessageId 0001787331361033-000441-1574d35e：完成立项，但必须复用已有概念、语言和规则；立项后只请 Fable 做一次审核，不做过度 A2A。"
tips_exempt: "内部开发治理立项；没有新增用户可调用 surface。若未来实现产生可见操作入口，再按 F244 补指向真实入口的 tip。"
---

# F303: Design Gate 归一性加固 — 防止新增 consumer 另造规则

> **Status**: in-progress | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1

Architecture cell: `harness-eval`

Map delta: `none`

Why: 本 Feature 只加固 F083 已有 Design Gate、F191 Architecture Ownership、F217 Merge Gate 与现有五轴风险路由的连接方式；它不新增 stage、治理 registry、永久矩阵或第二套规则语言。

## Why

咱们已经有 Design Gate、tests、跨猫 review、merge gate 与 Alpha，却仍会在真实使用时才发现“同一事实被不同入口各解释一遍”：猫猫认真完成了每一道门，operator却成了第一个跨入口、跨身份、跨生命周期的集成测试员。直接代价不只是一次 403，而是前面所有 review token 和等待时间被投入了错误问题框架；更深的代价是operator不敢让猫猫推进已挂起的重构，因为一次看似完成的归一化可能制造更长的修复尾巴。

F303 的价值目标是：**不增加一条新流水线，而是让现有生命周期在“新增谁会消费既有规则、这条规则由谁拥有、什么证据足以支持改动声明”三个位置闭环。** 已知契约尽早由机器变红；机器尚不知道的问题由平等 Agent Team 提出；Alpha 只检验已经 landed 的真相，不再承担首次验收。

operator experience：

> “经常好像会各自造一套的情况出现，各种规则分叉直到真的我使用之后出现问题才知道。”
>
> “你最好再检查一下哦，小宝贝，不要造出多套概念和原语言和规则。”
>
> “先完成立项吧，立项完成之后让 Fable 审核一次，不要过度 A 来 A 去。”

## Current State / 现状基线

- 2026-08-20 的 system-thread 事故中，同一 thread 已进入用户可见索引，但 Sessions、Transcript、Invocations 与 Theater 仍按另一套读取条件返回 403。数据未丢，分叉发生在可见性与资源读取的 canonical 语义之间。
- PR #1913 让 system thread 进入用户索引；#1930 在单条 route 上形成了正确的 owner/default/caller-index 组合，却没有成为所有 consumer 复用的架构真相；#2605 的 Theater 没覆盖 indexed system thread；#3787/F299 新增 trajectory consumer 后直接触发分叉。
- F299 的 plan 明写 `Map delta: none` 与 “existing ownership/auth guard is preserved”。这证明至少一个关键样本不是“没人想到要保留鉴权”，而是**声明已经出现，却没有验证它对新增 consumer 仍成立**。
- 当前 thread 按严格口径已找到 **10 个**进入 runtime、用户现场或 fail-close 的规则分叉事故家族下限，另有 **4 个**直到晚期多轮 review 才截住的 near miss；它不是历史精确总数，但已足以证明重复摩擦存在。
- F083 已定义 Design Gate，F191 已定义 Architecture Ownership cell 与 `Map delta`，F217 已定义风险匹配的 merge gate，F297 已证明 canonical single writer + structural guard 能终止重复事故。代码符号级 consumer 通过既有 LSP find-references / `rg` census 发现；F242 仍在 productization，只覆盖 MCP tool、skill、workflow callback 等约定面。缺口不是再建一套 registry，而是让这些既有机制在新增 consumer、重构与“保持既有行为”声明出现时真正相接。
- `docs/SOP.md` 的五轴风险路由已有行为、数据、安全、契约、不可逆五轴；当前契约轴偏向 API/MCP/event/external schema，对内部 canonical policy 被新 consumer 复用时的语义覆盖不够明确。
- Alpha 的现有职责是验证最新 `origin/main` 的 landed truth。它不应被提前改造成未合入分支的第一次产品启动，也不应为每个 Feature 强制生成一个验收 thread。
- F192 已提供 eval domain registry、source adapter、Verdict Handoff、Eval Hub 与 re-eval closure 的横切控制面；但现有 `eval:sop` 只以 `SopTrace` / predicate violation 为主要观测面，当前 measurement validity 仍是 `certified_insufficient / keep_observe_only`。F303 的效用 claim 还需要 Design Gate admission、review、landed Alpha、incident 与返工成本证据，不能硬塞进 `eval:sop` 共享错误的真相源、owner 与有效性边界。

## Phase delivery contract

operator source：`0001787410619622-000083-b477a451`。统一指挥与 phase checkpoint 位于
`[thread-id]`；每个 Phase 的实现与 review 在各自执行 thread 闭环：

- 一个 Phase = 一个执行 thread = 一个 PR；同一 Phase 可以有多个 commit，但不能拆成多个 PR；
- blocking findings 在该 Phase 的同一 branch / PR 内修完，不另开补丁 PR；
- Phase 串行放行：上一 Phase 合入、统一指挥 thread 完成 checkpoint 后，才决定下一棒；
- Phase A 执行现场是 `[thread-id]`。Phase A 合入后停止，不自动启动 Phase B；
- F299 Phase B.2 的 `thread-access-policy` repair 有独立 owner，F303 只引用其事故与裁定作为 replay 证据。

这些是交付包装与 checkpoint 约束，不是新的 lifecycle、role、state 或 stage。

## Product Contract / 归一边界

### 只复用现有语言

| 本 Feature 要表达的事实 | 唯一沿用的现有承载 |
|---|---|
| 同一规则不能被多个入口各自重写 | P4 单一真相源 + F191 Architecture Ownership cell |
| 代码入口可能遗漏既有规则的 consumer | 既有 LSP find-references / `rg` census；必要时在 plan 中保留可重跑命令与输出 |
| 约定面可能遗漏 MCP tool / skill / callback consumer | F242 convention graph（in-progress，仅限约定面） |
| “保持既有行为”必须可验证 | P5 + 现有 targeted self-check + test/lint/guard |
| review 不应承担作者第一次启动产品 | 现有 SOP targeted self-check；review 消费其证据 |
| Alpha 只验证合入后的真实组合 | 现有 Alpha 通道与 F217 merge-gate 边界 |
| 治理效用如何长期运行、发布与复验 | F303 拥有 Tracking Contract；F192 现有控制面承载独立 `eval:design-gate` domain 的 registry / schedule / verdict / Hub / closure，不替 F303 定义真相或阈值 |
| 多模型如何发现未知风险 | 平等 Agent Team 的独立判断；不是机器 gate，也不是主从对象模型 |
| thread 如何展示相关工作 | F277 related-set / attention projection；不承载 work、custody、completion 或 acceptance truth |

### 明确不造什么

- 不新增第六道 lifecycle stage；只修改现有 Design Gate / 风险路由的触发与验收条件。
- 不新增永久 consumer matrix。需要 impact view 时从 Architecture cell、可重跑代码 census，以及仅用于约定面的 F242 生成；用完后让结论进入代码、测试或 ownership cell。
- 不新增 incident-family 台账。历史 replay 引用既有 bug report、lessons-learned、Feature doc 与 git/PR 证据。
- 不默认创建“验证 thread”。只有验收本身是可独立交付的工作时，它才是一个普通、平等的 peer thread。
- 不把 F277 变成流程引擎；F277 只投影明确关系与注意力，不推断状态。
- 不在 F303 内命名或实现 403 的 domain policy。403 只是 replay fixture；最终类型名、owner 与修复范围由对应 domain Design Gate 决定。
- 不默认把确定契约挂到 Eval Hub，也不拿 raw latency/稳定性指标冒充效用判断。
- 不把 F303 的治理效用硬并入 `eval:sop`。SOP compliance 可以作为一条 evidence ref，但不能代替跨 Design Gate、review、Alpha 与 incident 的完整 episode。
- 不另建第二套 eval registry、scheduler、Hub 或 verdict 语言；只在可信 source adapter 就绪后接入 F192 的既有扩展点。没有有效 episode 时不启用一个会定时空转的 domain。

## What

### Phase A: 历史 replay 与术语归一

- 从 403、F101、F215、F297/F299 等已有证据中选取代表样本；逐个区分：问题没有被发现、claim 已出现但没有验证、已有 guard 却未覆盖、或 Alpha 才暴露 landed integration。
- replay 是一次有界设计证据，不形成新台账。输出引用原始 source ref、当时可见的 plan/review/gate 证据与“现有哪道门本可更早拦截”。
- 把当前 discussion / Demo 中看似正式的新名词压回上表的既有语言，并用静态回归测试防止这些临时解释词再次伪装成架构对象。
- 用 replay 决定 Phase B 的最小触发条件；不按“没想到 vs 想到没验证”的简单多数票覆盖混合事故。

#### Phase A replay result / OQ-1

代表 source map 与逐项证据见
四个样本覆盖四种机制：F101 是反例没有被提出；F215 是 claim 已出现但验证没有穿过 production wiring；
F299 是 canonical authority 未明确且 consumer 漏发现；F297 是现有 guard 只证明局部表现，没有证明真实 owner
provenance / 正向旅程。样本数不参与投票。

Phase B 的最小 trigger 是三个客观事实的 **OR**：

1. 新增/搬动 route、surface、后台 job 或 caller，并复用既有 auth / policy / resolver / cursor / lifecycle 语义；
2. 重构、迁移或 single-writer 收敛改变 canonical owner、writer 或 read path；
3. 出现“保持既有行为”“不改变鉴权”“Map delta: none”“只做 projection”等 preservation claim，且 diff
   触及对应 consumer / authority 边界。

命中后仍按 claim 只选择 Architecture Ownership exact ref、可重跑 consumer census 与会变红的
targeted self-check / test / lint / guard。重复事故 family 只提高反例与证据深度，不独立触发新 stage，
也不要求普通增量填写永久矩阵。

### Phase B: 加固现有 Design Gate 与五轴风险路由

以下任一事实出现时，现有 Design Gate 必须把相关 claim 纳入架构/契约风险判断：

- 新增 consumer、入口、route、surface 或后台 job，且复用既有 policy/resolver/cursor/lifecycle/auth 语义；
- 重构、迁移、single-writer 收敛或目录搬迁可能改变 owner、consumer 或读取路径；
- spec/plan/review 中出现“保持既有行为”“不改变鉴权”“Map delta: none”“只做 projection”等声明；

命中前三项之一后，仍填写 F191 的同一组三行 `Architecture cell / Map delta / Why`。既有重复事故 family 或 route-local 分叉证据只作为 prior，决定反例与证据深度；不能独立让未命中前三项的变更成为 eligible change。只有命中上述 trigger 的 eligible change 才追加三份可被门禁消费的证据：

- **canonical source**：`path#symbol` 或 doc anchor exact ref；现有 checker 至少能确认 path/anchor 存在；
- **受影响 consumer**：代码级使用可重跑的 LSP find-references / `rg` 命令与输出；MCP tool、skill、workflow callback 等约定面才使用 F242；工具无法表达的语义边界必须给出显式 references 清单与无法自动扫描的理由；
- **选中机制**：指向一个具体 test/lint/guard/self-check 命令或测试名，并写清哪种输入会让它变红。

普通增量仍只写 F191 三行，不画矩阵。重构、迁移与 single-writer 收敛类 eligible change 还必须提供 characterization 或 contract test，加代码级 consumer census；涉及持久化或运行语义迁移时，再补适用的 migration/restart/rollback 证据。

### Phase C: 让现有 predicate 与 review 消费证据

- 在 `harness-eval` 已拥有的 `sop-definitions/development.yaml` / `scripts/sop-definitions.mjs` predicate 路径加固 trigger 与证据形态，不扩展尚未锚入该 cell 的 `check:architecture-ownership`，也不另建 dashboard、gate runner 或控制面。
- F303 通用 RED 只检查声明与 diff 的一致性：diff 新增 route/consumer 并触及既有 auth/policy/resolver/cursor/lifecycle helper，而 eligible spec/plan 没有声明 consumer delta 与具体证据时，现有 SOP predicate fail。
- domain owner 可另为确定性约束提供 test/lint/guard。例如 thread access owner 一旦确定，可禁止下游 route-local ownership 判断；该 domain lint 属对应 domain Feature，不是 F303 AC-C1 的依赖。
- risk claim 命中后，作者在 feature worktree exact HEAD 上完成 targeted self-check；真实入口旅程、contract test、lint/scan 只选覆盖该 claim 的最小集合。
- 非作者 review 读取 spec、diff、Architecture cell 与 targeted self-check evidence，主要判断残余未知和证据是否支持 claim；它不替作者完成第一次产品启动。
- 回归 fixture 至少证明一个 #3787/F299 类 diff 会在 review/merge 前失败，同时证明纯文档和不触及 ownership/consumer 的普通增量不会被误拦。

### Phase D: Landed Alpha 与 F192 治理效用闭环

- 合入后继续由 Alpha 验证 `origin/main` 的构建、依赖组合、真实入口与环境连续性；Alpha 逃逸必须回写到更早且更便宜的 owner-specific guard，不能只增加 review 轮数。
- “canonical owner / consumer 覆盖正确”是确定契约，由 test/lint/guard 判定。
- “这次加固能减少逃逸和返工，同时没有制造不可接受的门禁税”是不确定效用 claim，按下面 Tracking Contract 决定 keep / tune / sunset。
- review/命令的原始耗时与稳定性若需要诊断，进入 logs/metrics/traces；只有被定义为治理效用估计量并有明确 consumer 时，才进入该 Tracking Contract。
- F303 拥有 episode 定义、指标出生证、有效性边界与决策阈值；F192 只承载 domain registry、调度、结构化 verdict 发布、Eval Hub 展示与 re-eval closure，不反向成为 F303 的业务真相源。
- Phase C 先产出可追溯的 eligible admission / gate receipt，并证明 source adapter 能从 canonical git/PR、review、Alpha 与 incident refs 重建完整 episode；在此之前不注册或启用空 Eval domain。
- 观测面有效后，在 F192 现有 registry 中注册独立 `eval:design-gate` domain。它不复用 `eval:sop` 的 source adapter、measurement certificate 或 handoff owner；`eval:sop` 的单条 predicate 结果最多作为 episode 的一项输入证据。

## Tracking Contract（仅治理效用 claim）

### E0 资格门

- **Ground truth**：触发 F303 条件的 Feature/PR episode；结局来自 pre-review catch、review verdict、merge 后 Alpha、incident/bug report 与修复归因。
- **Fresh bit**：门是否独特拦住 canonical divergence、是否发生 post-merge escape、是否产生 false-positive block；可由 gate/review/incident 记录观察，歧义样本由 operator 或 Feature owner 做有界裁决。
- **Salary**：维护已有 checker/predicate 与少量歧义裁决的时间。无需模型 judge，也不建立持续人工标注队列。

### 指标出生证

- **utility_claim**：在 eligible change 中降低 post-merge 规则分叉与返工，同时不显著增加无效阻塞、active minutes 或 review rounds。
- **estimator**：以向量呈现 eligible episodes、pre-review unique catches、post-merge divergence escapes、false-positive blocks、额外 active minutes、额外 review rounds；不合成一个“质量分”。
- **validity_bounds**：只统计实际命中 Phase B trigger 的变更；admission 记录缺失、incident 未关联、分类规则中途变化或人工等待无法分离时，该窗口不可用于效用归因。
- **consumer**：F303 owner 与 operator；用于 keep / tune / sunset trigger 或 predicate，不用于给猫猫排名。
- **calibration_plan**：首个 4 周或 20 个 eligible episodes（取先到者）全量看 escape/block，并抽查通过样本；风险定向样本与随机样本分开报告。
- **repeatability_contract**：discovery、attribution、acceptance 分开；冻结 commit/diff、checker version 与 gate output，确定性部分可重跑，人工裁决保留 source ref 与理由。
- **keep / tune / sunset**：有 unique catch 且 false-positive/tax 可接受则 keep；集中误报则 tune trigger；若无 unique catch 且持续增加阻塞/轮次，则 sunset 通用触发，只保留已证明有效的 owner-specific guard。

### F192 执行契约

- **Domain**：`eval:design-gate`。这是 F192 既有 domain 扩展机制中的独立注册项，不是新 Feature、新控制面或新 lifecycle stage。
- **Source adapter**：只接 canonical refs——eligible admission + exact HEAD、gate/self-check receipt、非作者 review verdict、landed Alpha receipt、incident/bug report 与修复归因；生成 snapshot/bundle 时引用源，不复制第二份业务真相。
- **Admission**：source adapter 能重建至少一个完整 eligible episode，且缺失 admission/incident 关联会 fail closed 后，domain 才允许启用；无数据、来源不完整或有效性未认证时只能 `keep_observe`，不得从沉默推断成功。
- **Handoff**：`handoffTargetResolver` 指向 F303 owner / `harness-eval` 责任线，不沿用 `eval:sop` 当前的 F192 owner。状态与 verdict truth 在 F192 registry/artifact，不在 system thread 文本。
- **Verdict 映射**：F303 的 keep → F192 `keep_observe`；trigger/阈值需要调整 → `fix`；缺 source adapter、观测能力或新机制 → `build`；通用触发器不再产生独特价值且持续制造税 → `delete_sunset`。
- **Closure**：owner 处理 finding 后不能靠“修了”关闭；只由后续同域 re-eval 或明确 operator accept/suppress 收口。

## User Journey

### Primary Journey: 新 consumer 在 review 前证明没有另造规则

- **Scope unit**: feature change
- **Actor**: 实现猫、非作者 reviewer、operator
- **Entry**: Feature 在现有 Design Gate 进入 architecture / contract 风险判断
- **Flow**:
  1. 实现猫在 spec/plan 中引用现有 Architecture Ownership cell，并指出新增或受影响的 consumer 与 canonical source。
  2. 每个风险 claim 按 ADR-031 选择 test/lint/guard、targeted self-check、observability 或 eval；没有被选中的机制不要求补齐。
  3. 实现猫在 feature worktree exact HEAD 产出对应证据后再请求一次风险匹配的非作者 review。
  4. reviewer 用独立问题框架检查残余 unknown 和证据支持度，不重新扮演作者跑首次旅程。
  5. 合入后 Alpha 只验证 landed truth；若逃逸，归因回 owner-specific guard 与原触发条件。
- **Success evidence**: representative replay、checker regression fixture、exact-HEAD self-check receipt、review verdict、landed Alpha receipt 与 Tracking Contract 报告
- **Non-goals**: 不保证零 bug；不要求每个 Feature 新开验收 thread；不把 F277 关系图当责任或完成真相；不以更多 review 轮数代替机器证据。

### Supporting Journey: 独立验收确实是一项工作

当跨 Feature 集成、真实用户验收或独立体验判断本身具有独立交付物时，可创建平等 peer thread / Team。它通过现有球权与任务真相记录责任，F277 只展示明确关系；不因“进入实现阶段”自动生成。

## 机制选择（ADR-031）

| Claim | 选中机制 | 验证 / consumer |
|---|---|---|
| 新 consumer 必须复用 canonical owner，且“保持既有行为”声明成立 | 现有 SOP predicate + 选定的 test/lint/guard | exact source + consumer census + 会变红的具体命令；merge gate 消费 |
| 猫猫在 Design Gate 记得查 owner、consumer 与 claim | F083/feat-lifecycle/SOP convention；必要时加现有 predicate | spec/plan 与 design review 消费 |
| 治理加固减少逃逸且没有制造过高成本 | 上述 Tracking Contract | F303 owner + operator 做 keep/tune/sunset |
| review/命令耗时与稳定性诊断 | logs/metrics/traces | F153 runtime-health 诊断；不默认进入 Eval Hub |

## Acceptance Criteria

### Phase A（历史 replay 与术语归一）

- [x] AC-A1: 至少 4 个代表事故/near miss 逐项给出 source ref、当时可见 claim、失败类别与现有可承接门；非作者可从原文重放，不建立新事故台账。
- [x] AC-A2: discussion / Demo 只使用 P4/P5、Architecture Ownership、Design Gate、targeted self-check、review、Alpha 与 F277 的既有含义；静态测试阻止临时解释词重新成为正式 stage/type。
- [x] AC-A3: kickoff commit 由 Fable 在 exact HEAD 上完成一次架构审核并留下 APPROVE 或 blocking findings；没有 finding 时不发起第二轮礼貌性复审。（reviewed `219efcf383fccc972078ced1a2d65656f835f899`，REQUEST_CHANGES ×4）

### Phase B（现有 Design Gate 与风险路由）

- [ ] AC-B1: F083/feat-lifecycle/SOP 在不增加 lifecycle stage 的前提下，能对新增 consumer、重构/迁移及“保持既有行为”声明触发 architecture/contract 风险核验。
- [ ] AC-B2: eligible spec/plan 的 canonical source 是可机核存在的 `path#symbol` / doc anchor exact ref；受影响 consumer 有可重跑 scan 命令与输出，或附理由的显式 references 清单；每个 claim 指向一个具体会变红的 test/lint/guard/self-check 命令或测试名。普通增量不被要求填写永久矩阵。
- [ ] AC-B3: F277 文档与实现仍只承载 related-set/attention projection；自动检查或 review fixture 证明它没有获得 work/custody/completion/acceptance 推断职责。
- [ ] AC-B4: 重构、迁移或 single-writer 收敛类 eligible change 同时提供 characterization/contract test 与代码级 consumer census；涉及持久化或运行语义迁移时补 migration/restart/rollback 证据，且至少一个 fixture 证明缺失任一必需证据时会变红。

### Phase C（checker 与 review 消费）

- [ ] AC-C1: `harness-eval` 现有 SOP predicate 至少让一个 #3787/F299 类 fixture 因“diff 新增 route/consumer 并触及既有 auth/policy/resolver/cursor/lifecycle helper，但 eligible spec/plan 未声明 consumer delta 与具体证据”而在 review/merge 前变红；补齐声明与证据后变绿，不依赖尚未归属的 domain lint。
- [ ] AC-C2: 至少两个不触及 ownership/consumer 的普通变更 fixture 保持绿，证明没有把所有 Feature 升级为重型审计。
- [ ] AC-C3: review packet 可验证绑定 exact HEAD，包含命中的 risk claim 与对应 targeted self-check receipt；不要求 reviewer 重跑作者首次旅程。

### Phase D（landed Alpha 与效用裁决）

- [ ] AC-D1: 至少一个 landed change 的 Alpha receipt 与 earlier self-check receipt 可追溯区分，Alpha 逃逸能归因回 owner-specific guard 或 trigger gap。
- [ ] AC-D2: 到达 4 周或 20 个 eligible episodes 后，Tracking Contract 产出完整向量、有效性声明与 keep/tune/sunset 决策，并映射为 F192 `keep_observe / fix / build / delete_sunset` verdict；缺失 admission/incident 关联时明确判 invalid，不编造结论。
- [ ] AC-D3: Phase C source adapter 能从 canonical refs 重建至少一个完整 eligible episode 后，F192 既有 registry 注册并启用独立 `eval:design-gate` domain，包含独立 source adapter、F303 owner handoff resolver、publish path 与 re-eval closure；fixture 证明它不复用 `eval:sop` truth/validity，且无完整 episode 时不会产出 actionable verdict。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|---|---|---|---|---|
| R1 | “不要造出多套概念和原语言和规则” | AC-A2, AC-B1, AC-B2 | 静态术语回归 + spec diff + SOP/checker tests | [ ] |
| R2 | 方案不能冲突于平等 Agent Team；F277 只负责展示/聚类 | AC-B3 | F277 boundary fixture + non-author review | [ ] |
| R3 | 先完成立项，再让 Fable 审核一次，不要过度 A2A | AC-A3 | exact-HEAD 单次 kickoff review receipt | [x] |
| R4 | 规则分叉应在真实使用和 landed Alpha 前暴露 | AC-C1, AC-C3, AC-D1 | RED→GREEN fixture + self-check/Alpha receipts | [ ] |
| R5 | SOP 要又快、又保证质量，重构不再让返工更久 | AC-B1, AC-B4, AC-C2, AC-D2 | 重构缺证据 RED fixture + false-positive/tax 向量 + keep/tune/sunset verdict | [ ] |
| R6 | “不要硬和之前的结合”——治理 Eval 复用 F192 控制面，但不能硬塞进 `eval:sop` 或继承它的真相源/owner/有效性 | AC-D3 | domain registry + source adapter/handoff/validity fixtures | [ ] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC。
- [x] 每个 AC 都有可由非作者执行的验证方式。
- [x] 无新增产品 UI；现有 Demo 的需求→证据映射由 `demo-ui.test.mjs` 承载。

## Dependencies

- **Evolved from**: F083（Design Gate）与 F191（Architecture Ownership Governance）。
- **Blocked by**: 无外部 Feature blocker；Phase A/B/C 可直接推进。Phase D 的 F192 domain wiring 有内部顺序依赖：Phase C 先产出可信 eligible episode 与 source adapter，domain-specific guard 仍由各 owner Feature 独立承接。
- **Related**: F217（Merge Gate Integrity）、F242（仅约定面 Convention Graph，in-progress）、F267（measurement validity / action gate）、F277（Thread Attention Navigation）、F297（Single Writer 正例）、F299（直接事故样本）、F101/F215（真实旅程晚发现教训）、F192（既有 eval control plane，只承载 registry / verdict / Hub / closure）。

## Risk

| 风险 | 缓解 |
|---|---|
| 用“归一”之名再造一套 stage / registry / matrix | Architecture cell 固定为 `harness-eval`、Map delta none；AC-A2/B1/B2 与 reviewer 专门检查概念复用 |
| 每个普通改动都被拉进重型审计 | Phase B 明确触发条件；AC-C2 用普通增量 negative fixtures 守 false positive |
| 只加文书，仍然无法在 review 前变红 | Phase C 要求 SOP predicate 的声明↔diff RED→GREEN fixture 与 exact-HEAD receipt；domain guard 不代偿通用层 |
| 只信机器，作者与 reviewer 共享盲区 | 机器只执行已写断言；不确定风险由平等、非作者 Agent Team 以独立问题框架检查 |
| 为追求独立而默认开验收 thread，制造新的流程税 | Supporting Journey 只在验收本身是独立工作时成立；F277 不推断或生成工作状态 |
| 403 reference 越界接管 auth domain | F303 只消费事故作为 replay fixture；policy 名称、owner、实现与安全矩阵另走 domain Design Gate |
| Eval Hub 被拿来验证确定契约 | Architecture correctness 只走 test/lint/guard；Eval 仅消费明确的治理效用与成本 claim |
| 为省一个 domain 而把效用 claim 硬塞进 `eval:sop` | 独立 `eval:design-gate` source adapter / owner / validity；SOP predicate 只作 evidence ref，不继承 `eval:sop` measurement certificate |
| 先注册 cron、后补观测面，形成 silent-fire 或空 verdict | AC-D3 admission：完整 eligible episode + fail-closed source adapter 先行；无效窗口只能 `keep_observe` |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|---|---|---|
| KD-1 | F303 是现有 Design Gate 的 integrity 加固，不是新的 lifecycle stage | 用户明确要求不造多套概念；F083/F191/F217 已有正确承载 | 2026-08-21 |
| KD-2 | 不建永久 consumer matrix 或 incident ledger | Architecture cell、代码 references、仅限约定面的 F242 与既有 lessons/bug reports 已是真相源；重复文书会再次漂移 | 2026-08-21 |
| KD-3 | Agent Team 平等协作与机器 gate 分工，不引入 Shadow / 主从模型 | 机器适合执行已知断言，独立 Team 负责发现 unknown；两者不是同一层 | 2026-08-21 |
| KD-4 | F277 只展示明确关系与注意力，不拥有工作状态 | 维持 F277 canonical boundary，避免 UI 聚类反向定义流程 | 2026-08-21 |
| KD-5 | kickoff 完成后只请 Fable 做一次 exact-HEAD 审核 | 满足独立架构校对，同时避免在共识已高的区域反复 A2A | 2026-08-21 |
| KD-6 | F303 Tracking Contract 接 F192 既有控制面，但使用独立 `eval:design-gate` domain，不硬并 `eval:sop` | 两者的 ground truth、episode、owner 与 validity 不同；复用控制面不等于复用错误测量域 | 2026-08-21 |

## Review Gate

- **Kickoff**：立项 commit 后只向 Fable (`@fable5`) 发起一次 exact-HEAD 架构审核；重点检查概念复用、F277 边界、AC 可证伪性与 eval 适用性。除非结论含 blocking finding，不进行礼貌性往返或重复 review。
- **Implementation**：按真实改动的五轴风险另选一个非作者 review source；kickoff review 不预先充当未来代码 review。
