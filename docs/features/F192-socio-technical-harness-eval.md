---
feature_ids: [F192]
related_features: [F167, F153, F086, F188, F200]
topics: [harness-engineering, eval, socio-technical, observability, cat-user-feedback]
doc_kind: spec
created: 2026-05-07
---

# F192: Socio-Technical Harness Eval — harness 共创评估体系

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

## Architecture Ownership

Architecture cell: harness-eval
Map delta: new cell required (Phase E-pilot)
Why: Phase E turns F192 from per-feature harness feedback into a cross-domain harness eval control plane. The cell owns eval domain registration, verdict handoff contracts, eval-cat invocation, legacy scheduled-task migration, and re-eval closure semantics.

## Why

Cat Cafe 的 harness（skill、SOP、MCP tool、shared rules）是猫猫和team lead共同创造的社会技术系统，但目前缺少系统化的评估和反馈路径。harness 改动后无法追踪效果，不满意的 feature 无法定位归因层级（是愿景不清？翻译偏差？工具不顺手？执行不到位？），猫猫作为 harness 的一线用户没有结构化的反馈通道。

team experience（2026-05-06 01:15）："我们必须有 tracing...当一个 feat close 了...thread id 可知道...session id 可知道 => 意味着他们的 tool call 上下文完全透明！...可选环节采访猫猫的干活体验是否才是不污染工作上下文且是一个持续性评估的可靠扩展点？"

## Authority Boundary

本 feature 是 trace 数据的**解释层和标注层**，不是 trace 的定义层。

| 文档 | Owns | Does NOT own |
|------|------|-------------|
| ADR-031 | harness engineering 方法论 | trace schema、export 格式 |
| ADR-032 | trace 数据归属、脱敏、导出 | 内部 harness 改进流程 |
| **F192（本 feature）** | close-time eval workflow、cat interview、harness-feedback doc type、feature fit review、digest、**runtime eval pipeline（消费 F153 telemetry → 聚合 → 归因 → 行动）** | canonical trace schema、export 格式、data ownership、F153 ring buffer 容量/TTL |

## What

### Phase A: 基础骨架——doc type + feat-lifecycle 接入 + scanner ✅

最轻量的一刀：让 harness-feedback 作为 doc type 存在、被索引、能在 feat close 时被触发。

- 创建 `docs/harness-feedback/` 目录 + README
- 定义 `doc_kind: harness-feedback` frontmatter 规范
- 确认 CatCafeScanner glob 覆盖 `docs/harness-feedback/**/*.md`
- feat-lifecycle Completion 加 Step 0.6 Harness Eval Checkpoint（判断是否触发 interview，默认写 `harness_feedback: none`）
- 写一份样例 harness-feedback 文档验证全链路（建议用 F167 A2A 的某个已知摩擦点）

### Phase B: F167 Pilot——Eval Contract & Evidence Artifact Pilot ✅

用 F167 A2A 球权作为试点，跑完预期声明层的全部产物。

- 给 F167 补 Eval / Tracking Contract
- 从历史 trace 抽 3-5 个 fixture（ball drop、zombie hold、ack loop）
- 生成一次 Feature Trace Bundle 样例
- 写一次 evidence-directed cat interview 样例
- 写一次 Feature Fit Review 模板样例
- 定义 A2A 工具的 adoption / friction / false-positive 指标

**Phase B 定位（KD-5 重新定性）**：Phase B = 预期声明层（should be）。产物是 eval pipeline 的 schema / 触发点 / 输入锚点，不是 runtime eval 完成证明。具体定位：

| Phase B 产物 | 新定位 | 自动化程度 |
|---|---|---|
| Eval Contract | 预期声明（spec-time）——pipeline 用它对比 actual | 手填 |
| Trace fixtures | regression ground truth——pipeline 必须正确判断 | 手填 anchor，pipeline 消费 |
| Feature Trace Bundle | derived view——pipeline 自动从 F153 生成 | 自动化（Phase C） |
| Cat interview | 触发型产物——pipeline 检测 anomaly 时触发 | 触发自动化，回答手填 |
| Feature Fit Review | 人工 sense-check——归因后 CVO/愿景守护猫裁定 | 半自动 |
| Tool Eval Contracts | 预期声明——同 Eval Contract | 手填 |

### Phase C: Runtime Harness Eval — F167 端到端验证 ✅

从 F153 消费运行时 telemetry，对 F167 A2A harness 跑一次真实的端到端 eval。Phase B 定义了"应该怎样"（eval contract），Phase C 观测"实际怎样"（telemetry），**diff = eval 信号**。

核心 scope：搭骨架（3-4 条 AC），不做自动化 pipeline / 定时任务 / 通用化。用 F167 作为唯一接入对象。

- 实现 F153 Telemetry Adapter，消费 `/api/telemetry/traces`、`/traces/stats`、`/metrics`、`/metrics/history` 四个公开 API
- 对 F167 的 4 个 harness 组件（L1 ping-pong breaker / C1 hold_ball / C2 forced-pass guard / route-serial）产出真实数据驱动的 runtime eval snapshot
- 对 telemetry 中的 friction signal 跑至少一次归因 → 抽象 → 解决循环
- 明确标注 telemetry gap（不可观测本身就是 eval 结果）

### Phase D: Eval Infrastructure Completion + Tool Eval Expansion

Phase C 骨架跑通后，完善基础设施 + 扩展到更多工具。含原 Phase C scope + 三猫讨论的剩余 AC + 愿景守护新增 AC。

- **Instrumentation Gap Closure（前置）**：实施 Phase C 暴露的 6 个 add-counter findings，让 L1/C1/C2 进入 confidence ≥ medium。这是其他 D-AC 的前置——没有 instrument 就没有 data，D2 snapshot store 存的是空气
- Harness Component Registry：F167 每个 harness 组件拆出 hard/soft/eval 三栏
- Snapshot Store：daily scheduled task 从 F153 拉聚合摘要，解决 24h TTL 限制
- End-to-End Verification：pipeline 复现 Phase B fixtures 的已知 friction（recall gate）
- Self-Eval Contract：Phase C pipeline 自己填 Eval Contract（meta-eval），含 sunset signal + attribution action-rate metric
- Top-5 MCP 工具写 tool eval contract（search_evidence、post_message、hold_ball、browser tools、rich block）
- 注册 monthly scheduled task `harness-fit-digest`
- 跑第一次 micro fit digest，评估 Phase A/B/C 的机制是否太重
- 根据 digest 结论决定：升级为 ADR / 精简 / sunset
- **Attribution Action-Rate（meta-loop）**：tracking findings → acted-on 比例，连续 3 月 < 50% 则 pipeline 自候选 sunset

### Phase E: Harness Eval Control Plane / Eval Hub

Phase A-D 证明了 F192 能对单个 harness domain（F167/A2A）做预期声明、runtime 观测、归因和 digest。但team lead在 2026-05-21 指出：eval 的第一性目的不是"有个告警"或"有个定时任务"，而是**长期追踪并解释 harness 运行效果，产出 delete/sunset / build / fix / keep 的证据化 verdict，再把诊断交给负责 feature 的猫处理，由后续 eval 复验**。

Phase E 将 F192 从单域试点提升为横切的 Harness Eval Control Plane：

- 每个 eval domain 有独立系统 thread（如 `eval:a2a`、`eval:memory`），保留该域长期分析上下文
- 每个 harness 注册 Eval Contract（服务谁 / 触发条件 / 摩擦指标 / 回归用例 / sunset 信号）
- eval 猫产出结构化 Verdict Handoff Packet，不能只说"你去看看"
- Eval Hub 展示 verdict、趋势、handoff、owner 响应、复验状态和社区报告
- F192/F200/F188 当前各自注册的定时任务迁移到统一 runtime，迁移完成后必须关闭旧任务，避免双触发

**Delete includes sunset**：`delete` verdict 包含"模型/猫猫能力变强后不再需要该 harness"的 sunset 场景。实现上可显示为 `sunset`，但 lifecycle 语义是删除/退役/收回注意力预算。

**Build sequence（owner review R1）**：Phase E 必须先跑通一个真实 domain 的 contract→verdict→handoff→re-eval 闭环，再做 Hub UI 和多域扩展。顺序固定为：

1. **E-pilot**：只接 `eval:a2a`，无新 UI，验证 registry / handoff / legacy cleanup / re-eval closure
2. **E-hub**：用 E-pilot contract mechanics + 后续真实 verdict 驱动 Eval Hub v1
3. **E-scale**：接 `eval:memory`（F200 + F188 adapter）并迁移对应旧任务
4. **E-sop**：接 `eval:sop`（cat-cafe SOP compliance；ground truth = `SopDefinition.hard_rules/pitfalls` per F203 #748；domain-generic schema 从 day 1 支持 development / video-cocreation / tech-article / family-office 等多 domain）
5. **E-community**：开放社区 issue packet / custom domain path

**Remaining PR packaging（CVO + 46/55, 2026-05-24）**：Phase E 剩余工作不按 AC 逐条拆 PR，按可独立验收的功能块收敛为 4 个 PR，避免过细 PR 造成 review / merge overhead：

1. **E-hub PR（owner: Maine Coon/Maine Coon）**：System Workspace 归一 + Eval Hub v1。只消费真实 `eval:a2a` verdict，不接 memory / sop / community；Hub 放 Console daily workflow path（Observability/Eval），不放 Settings；必须提供 IM Hub / domain thread / 相关 surface 的跳转按钮。
2. **E-scale PR（owner: Ragdoll/Ragdoll）**：`eval:memory` adapter（F200 + F188）+ F188 repair surface 双向跳转 + F200/F188 旧定时任务清理 dry-run，确保不双触发。
3. **E-sop PR**：`eval:sop` runtime evaluator + domain registry + invocation + predicate violation verdict + re-eval closure；依赖 F203 #748 的 `SopDefinition` / predicate ground truth，已由 F203 PR #1868 满足。
4. **E-community PR**：社区 issue packet / custom domain schema + sanitized fixture；基于已落的 verdict / bundle / hub contract，不抢先做新控制面。

分工原则：E-hub 由Maine Coon接（contract / handoff / Hub IA 由Maine Coon主导），E-scale 由Ragdoll接（F188 health governance / repair API 由Ragdoll主导）。E-sop 与 E-community 在 E-hub/E-scale 稳定后再排，避免四条线同时改控制面。

## Acceptance Criteria

### Phase A（基础骨架）
- [x] AC-A1: `docs/harness-feedback/` 目录存在，README 含 doc_kind 规范
- [x] AC-A2: CatCafeScanner 能索引 `docs/harness-feedback/**/*.md`，并保留/暴露 `doc_kind: harness-feedback`（search result 能区分它不是普通 discussion）。若当前不支持按 doc_kind filter，在 README 记录此限制
- [x] AC-A3: feat-lifecycle Completion 含 Step 0.6 Harness Eval Checkpoint，且明确：checkpoint 必做；默认允许写 `harness_feedback: none` + reason；触发条件（harness/skill/MCP feature、CVO 不满意、trace anomaly、抽样）；interview 必须独立 session/turn；触发后必须链接 harness-feedback 文档到 feature spec / CloseGateReport
- [x] AC-A4: 至少一份样例 harness-feedback 文档通过 search_evidence 可召回
- [x] AC-A5: harness-feedback README/schema 明确只存 annotations + evidence_refs，不存 raw trace 副本；Feature Trace Bundle 是 derived view，schema defer to F153/ADR-032
- [x] AC-A6: 样例 harness-feedback 文档使用 trace_refs/evidence_refs 指向 canonical trace/thread/session，不复制 raw tool-call payload

### Phase B（F167 Pilot + Inception Gate 验证）
- [x] AC-B1: F167 spec 含 `## Eval / Tracking Contract` 节，使用 v1 模板（4 项：Primary Users + Activation Signal / Friction Metric / Regression Fixture / Sunset Signal），验证模板在真实 feature 上的可用性
- [x] AC-B2: 至少 3 个 trace fixture 文档（ball drop / zombie hold / ack loop）
- [x] AC-B3: 一份完整 Feature Trace Bundle 样例
- [x] AC-B4: 一份完整 evidence-directed cat interview 样例
- [x] AC-B5: 一份 Feature Fit Review 模板样例
- [x] AC-B6: A2A 工具 eval contract 含 adoption / friction / false-positive 指标
- [x] AC-B7: `feat-lifecycle` Inception / Design Gate 加 Eval Contract 硬门禁——harness/skill/MCP/shared-rules 类 spec 立项时必须含 Eval Contract 节，否则 Design Gate 不通过。触发条件：新增规则/接口/行为变化（小修小补不触发）。Sunset Signal 空填 = 不通过，不设 reviewer 签字降级

### Phase C（Runtime Harness Eval — F167 端到端验证）
- [x] AC-C1: F153 Telemetry Adapter 实现——消费 F153 四个公开 API（`/api/telemetry/traces`、`/traces/stats`、`/metrics`、`/metrics/history`），不 import F153 内部类型。写 adapter contract test：F153 response 格式变化时 F192 失败在 adapter 层
- [x] AC-C2: F167 Runtime Eval Snapshot——对 F167 四个 harness 组件（L1 ping-pong breaker / C1 hold_ball / C2 forced-pass guard / route-serial）产出真实数据驱动的 health snapshot。字段含 window / data_source / activation_counts / friction_counts / false_positive_candidates / bypass_candidates / confidence。Telemetry gap 必须明确标注（缺 counter / span 未持久化 / tool_use 不可查 / cross-cat 403 / TraceContext Phase G 未完成）——不可观测本身就是 eval 结果
- [x] AC-C3: Attribution Finding——至少跑一个基于 telemetry 的「归因 → 抽象 → 解决」循环。输出结构化 YAML attribution_record（含 trace_anchor / friction_signal / attribution / proposed_action / status）。归因使用 7-class 矩阵（vision_gap / translation_gap / harness_misfit / tool_gap / execution_gap / environment_drift / taste_gap）。"no finding" 也是合法结论，但必须基于 telemetry 证据
- [x] AC-C4: Phase B Reclassification——F192 spec 明确写入：Phase B = 预期声明层（should be），Phase C = 实际观测层（actually is），diff = eval 信号。Phase B 产物保留但定位为 L0/L1/L4 支撑层，不是 runtime eval 完成证明

### Phase D（Eval Infrastructure Completion + Tool Eval Expansion）
- [x] AC-D0: Instrumentation Gap Closure（前置）——实施 Phase C 暴露的 add-counter actions：`streak_warn_count` / `streak_break_count`（L1）、`zombie_hold_count` / `hold_cancel_count`（C1）、拆分 `hint_emitted` 为 routing/verdict 两个独立 counter（C2）、`verdict_without_pass_count`（C2）。完成后 L1/C1/C2 confidence ≥ medium
- [x] AC-D1: Harness Component Registry——F167 每个 harness 组件拆出 hard / soft / eval 三栏，形成可扩展的 registry 格式
- [x] AC-D2: Snapshot Store——daily scheduled task 从 F153 拉聚合摘要到 `docs/harness-feedback/snapshots/`，解决 F153 24h TTL 限制。monthly digest 从 daily snapshot 二次聚合
- [x] AC-D3: End-to-End Verification——pipeline 必须复现 Phase B fixtures 的已知 friction signal（recall gate），且对正常 trace 不误判（precision gate）
- [x] AC-D4: Self-Eval Contract——Phase C pipeline 自己填 Eval Contract（meta-eval），定义 sunset signal
- [x] AC-D5: top-5 MCP 工具各有 tool eval contract
- [x] AC-D6: monthly scheduled task `harness-fit-digest` 已注册
- [x] AC-D7: 第一次 micro fit digest 已完成
- [x] AC-D8: digest 结论写入 feature spec（升级 / 精简 / sunset）
- [x] AC-D9: Attribution Action-Rate——tracking Phase C/D findings 的 acted-on 比例。pipeline 自身 eval contract 含 action-rate metric；连续 3 月 < 50% 则候选 sunset

### Phase E（Harness Eval Control Plane / Eval Hub）

#### E-pilot（`eval:a2a`，无 UI）
- [x] AC-E1: Architecture Decision / Design Gate 明确 Phase E 不是新 F 号，而是 F192 的横切控制面升级；写清 eval 第一性原理、domain thread、legacy scheduled-task 迁移和 verdict handoff 契约
- [x] AC-E2: Eval Domain Registry v0 定义 `eval:a2a` 最小 schema（domain id、system thread id、eval cat invocation policy、frequency、source adapter、legacy scheduled-task ids、handoff target resolver、SLA）
- [x] AC-E3: Verdict Handoff Packet schema 落地，字段至少含 phenomenon、harness under eval、evidence packet、daily trend、root-cause hypothesis、verdict、owner ask、acceptance / re-eval plan、counterarguments；缺字段不得 cross-thread handoff
- [x] AC-E4: `eval:a2a` domain thread bootstrap：thread 只承载 A2A eval 长期分析；状态 / verdict / trend SOT 在 registry，不在 thread 文本
- [x] AC-E5: Eval cat invocation primitive：统一 scheduled task 唤醒 eval 猫进入 `eval:a2a` thread，加载该域纵向上下文，执行 day-over-day analysis，替代旧 `harness-fit-digest` 自注册任务
- [x] AC-E6: `eval:a2a` legacy scheduled-task cleanup：inventory `harness-fit-digest`，接入后 disable / redirect，并用 dry-run report 证明不会双触发
- [x] AC-E7: Re-eval closure loop：feature owner 处理 handoff 后，只有后续 eval 复验或明确 CVO accept / suppress 才能 close verdict；猫猫不能靠一句"修了"自闭环
- [x] AC-E8: E-pilot contract demo：用 representative A2A 数据证明 Verdict Handoff Packet contract / adapter transform / pending closure state；不得把 fixture 当作 live F167 verdict。真实 day-over-day telemetry verdict + cross-thread handoff deferred until real snapshot / attribution artifacts exist

#### E-hub（由 E-pilot contract + 真实 a2a verdict 驱动）
- [x] AC-E9: Eval Hub v1 只展示 E-pilot 产出的真实 `eval:a2a` verdicts、trend windows、handoff 状态、owner 响应、re-eval closure、stale findings；它是 harness lifecycle 控制面，不是单纯 metrics dashboard
- [x] AC-E10: Eval Hub design-in-context：Hub 主入口在 Console daily workflow path（Observability/Eval sub-area），不放 Settings；明确它与现有 Observability / Health surfaces 的关系，禁止在没有真实 verdict 数据前做空 dashboard

#### E-scale（`eval:memory`） ✅
- [x] AC-E11: Unified Eval Runtime 接入 `eval:memory` adapter：F200 memory recall eval + F188 library health governance 只产出标准 verdict / finding，不复制各自业务数据真相源
- [x] AC-E12: F188 Health Dashboard / badge 与 Eval Hub 边界决议落地：F188 health 是 memory-domain adapter 输入；Eval Hub 聚合 verdict / handoff / closure，不替代 F188 的现场健康入口，除非 Design Gate 明确迁移。UI 必须提供双向跳转：Eval Hub verdict → F188 repair / dry-run / apply surface，F188 Health Dashboard → 相关 Eval Hub verdict / handoff / closure 详情
- [x] AC-E13: `eval:memory` legacy scheduled-task cleanup：列出现有 F200/F188 相关 scheduled tasks / health repair reminders；接入后 disable / redirect 对应旧任务，并有 regression test 或 dry-run report 证明不会双触发

#### E-sop（`eval:sop`，domain-generic SOP compliance）

来源 2026-05-23 #748 设计讨论（clowder-ai 社区 terrenceeLeung 提议外化 SOP stage 定义；CVO 反思 "skill = 软约束（猫可加载可不加载），需硬约束兜底"）。Phase D AC-D1 「hard / soft / eval 三栏 registry」正是答案：`SopDefinition.hard_rules / pitfalls` 是 ground truth，eval 跑 runtime trace 检测违规；hook 注入与否由 eval 数据驱动 (per AC-D9 acted-on rate)，不预判。**Domain-generic from day 1**：schema 不绑 coding，`development` 只是第一个 domain，video co-creation / tech article / family office 同 schema 不同实例（消除「多阶段 skill 如 video-forge / ppt-forge / tech-writing / expert-panel 本质是 SOP 错位写进 skill body」的归位错位）。

- [ ] AC-E16: Architecture Decision——`eval:sop` 是 F192 内部 domain 扩展（同 E-pilot/E-scale，不是新 F 号）；复用 Verdict Handoff / re-eval closure pattern；明确三件套定位（skill = 软约束 / SopDefinition = 硬约束 ground truth / eval = 观测层）
- [ ] AC-E17: SOP Trace Adapter——从 F153 telemetry / session events / git state 抽 stage transition + tool-call sequence + repo state，喂 predicate evaluator
- [ ] AC-E18: Predicate Evaluator——接 SopDefinition 里的机器可检测 predicate（基础 type 集：command_pattern / command_sequence / sha_dedup / env_check / git_state_predicate / handle_check），输出 violation 列表带 trace anchor
- [ ] AC-E19: `eval:sop` domain registry + system thread bootstrap：复用 AC-E2/E4 pattern；first SOP scope = `development`（cat-cafe 开发 SOP，从 #748 SopDefinition 读取）
- [ ] AC-E20: Eval cat invocation：周度 scheduled task 唤醒 eval 猫，per-stage / per-rule 出 violation verdict
- [ ] AC-E21: Verdict Handoff target resolver：rule owner = SOP 维护者 / skill 维护者（按 rule 归属解析；development.yaml 的 owner 在 cat-cafe-skills/refs/）
- [ ] AC-E22: First batch machine-checkable predicates 覆盖 sop_navigation 现存 12 条规则（merge `--squash` / `closed≠merged` / self-review / Redis 6398 / main 双向同步 等）；每条 rule 跑通过/未通过判定
- [ ] AC-E23: Cross-domain schema validation——用 stub `video-cocreation.yaml` / `tech-article.yaml` / `family-office.yaml` 跑 schema 校验，证明 schema generic 不绑 coding；不实做这些 domain，只验 schema
- [ ] AC-E24: Re-eval closure——与 E-pilot 同 pattern（owner 处理 handoff → 复验 verdict pass / CVO accept / suppress）

依赖：#748（cat-cafe）已由 F203 PR #1868 落地（`SopDefinition` + predicate-backed `hard_rules/pitfalls`）；与 E-hub / E-scale / E-community 可并行（不依赖 UI / memory adapter / community path），但按 PR packaging 决策排在 E-hub / E-scale 后，降低控制面并发改动风险。

#### E-community
- [ ] AC-E14: Community path：支持社区实例把本地 eval finding 导出为脱敏 issue packet；也支持社区项目注册自有 eval domain，不 fork Cat Café core
- [ ] AC-E15: Community dogfood：至少 1 个 sanitized issue packet fixture + 1 个 custom domain fixture 通过 schema validation

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "eval 是为了 tracing harness 后看 harness 效果如何，是不是需要 sunset / delete / build" | AC-E1, AC-E3, AC-E8, AC-E9 | Design Gate + Verdict Packet fixture | [ ] |
| R2 | "delete 还有一种情况是 sunset，比如猫猫变强了，不需要了" | AC-E1, AC-E3 | Verdict enum + sunset fixture | [ ] |
| R3 | "负责 a2a eval 的猫要分析、深度分析原因、对比每天" | AC-E2, AC-E4, AC-E5 | domain thread registry + trend window fixture | [ ] |
| R4 | "eval 猫要跨线程通讯，发给负责的猫，让负责的猫来深度看" | AC-E3, AC-E7, AC-E8 | cross-thread handoff packet + re-eval closure test | [ ] |
| R5 | "verdict → handoff 要不要结构化，必须带证据包" | AC-E3 | schema validation rejects incomplete packet | [ ] |
| R6 | "诊断 / eval 结果需要一个看板，叫 Eval Hub" | AC-E9, AC-E10 | Eval Hub screenshot / API response | [x] |
| R7 | "接入完成得清理遗留定时任务，避免双触发" | AC-E6, AC-E13 | scheduled task inventory + dry-run migration report | [x] |
| R8 | "社区小伙伴发现自己的场景有掉球，也能提 issue / 接自己的项目 eval" | AC-E14, AC-E15 | sanitized issue packet fixture + custom domain fixture | [ ] |

### 覆盖检查
- [ ] 每个需求点都能映射到至少一个 AC
- [ ] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（Eval Hub Phase 需要）

## Phase E Eval / Tracking Contract

| 项 | Contract |
|----|----------|
| Primary Users + Activation Signal | eval 猫、feature owner、CVO、社区 maintainer。触发：harness 进入 registry / existing domain adapter 接入 / verdict 产生 / owner action 完成后待复验 |
| Friction Metric | incomplete_handoff_count、duplicate_trigger_count、unowned_verdict_count、stale_verdict_days、unverified_close_count、legacy_task_overlap_count |
| Regression Fixture | 1) F192 `harness-fit-digest` 迁入后旧 scheduled task 不再重复发；2) F200 memory eval 产出 verdict 后必须带 evidence packet；3) F188 orphan-edge health finding 不能只显示指标，必须能形成 owner ask + re-eval plan |
| Sunset Signal | 若 Phase E 连续 2 个 eval domain 接入后，verdict handoff acted-on rate < 50% 且 duplicate_trigger_count > 0，说明控制面比旧竖井更重，必须进入 simplify / sunset review |

### Phase E Verdict Matrix Contract（E-hub 前硬化）

Verdict 不是自由文案。每个 verdict 都必须满足对应证据门槛、handoff ask 和 closure 规则；不满足时 schema / review 必须拒绝，而不是靠 reviewer 一条条补语义洞。

| Verdict | 合法触发条件 | 必填证据 | Handoff ask | Closure / re-eval | Governance |
|---|---|---|---|---|---|
| `fix` | 已有 harness 目标正确，但实现 / prompt / workflow 没做到位；出现 regression、false positive、bypass 或 owner friction | phenomenon、affected harness、metric refs、day-over-day trend、root-cause hypothesis、counterarguments | 请 feature owner 修正现有 harness 或其接线 | 后续 eval 对同一 failure pattern 复验通过；owner 不能自报 resolved | 默认 eval owner + feature owner 闭环；高影响行为变更走 Design Gate |
| `build` | 反复出现的 failure pattern 没有现有 harness 覆盖，或现有 harness 边界外出现新场景 | missing-coverage evidence、candidate harness scope、expected activation signal、success metric、counterarguments | 请 feature owner 设计 / 扩展 harness，并补 Eval Contract | 新 harness 有 Eval Contract + 首次 eval snapshot；未接入前不得标 resolved | 新增规则 / SOP / MCP 行为变化必须过 Design Gate |
| `delete_sunset` | harness 的边际效果低或成本高，且可能已被模型 / 猫猫能力内化；**不能仅因最近没触发就判 sunset** | cost/effect trend、activation history、原始 failure pattern refs、Sunset Trial Plan、counterarguments | 请 owner 启动 sunset trial；verdict 本身不执行删除 | trial 满足 criteria 后进入 `dormant`；真正 `retired` 需额外 CVO accept | `toDormant` 可按 criteria 自动；`toRetired` 必须 CVO accept |
| `keep_observe` | 当前证据不足以改变 harness，或 harness 仍健康；不是“什么都不做”的永久终态 | current metric refs、why-no-action、next observation window、known blind spots | 继续观察 / 补 instrumentation / 等下一窗口 | 到期必须重新 eval；若无 next window 则不合法 | 可由 eval owner 自决；不能用来掩盖缺数据 |

不变式：

1. live verdict 的 evidence refs 必须可解析；fixture / demo 必须显式标注，不能伪装成真实 telemetry verdict。
2. `delete_sunset` verdict 只能触发 Sunset Trial，不能直接关闭或删除 harness。
3. `keep_observe` 必须带 next observation window；否则就是把未知包装成结论。
4. `build` 必须补 Eval Contract；没有可观测 success metric 的新 harness 不得进入 active。

### Phase E Sunset Trial Contract（`delete_sunset` 展开）

Sunset 是对 harness 的可逆退役试验，不是直接删 guardrail。默认生命周期：

```
active -> trial -> dormant -> retired
            ^         |
            |_________|  任一 regression signal 回退 active
```

- `active`: harness 在 prompt / SOP / tool / hook 的正常路径里生效。
- `trial`: harness 从主动路径中撤出或降级，只按 Trial Plan 观测。
- `dormant`: 默认 sunset 终态。harness 不再消耗 active 注意力预算，但配置、文档、revival path 保留，目标是 24h 内可恢复。
- `retired`: 真的删除代码 / skill / SOP。只在 dormant 连续通过多个周期后考虑，且必须 CVO accept。

Trial Plan schema：

```ts
{
  harnessId: string;
  ablationMode: 'log_only' | 'ab_cohort' | 'full_ablation';
  triggerScenarios: AdversarialProbeRef[]; // 必填：复用 Eval Contract 原始 failure pattern
  trialWindow: {
    minDays: number;
    minSessions: number;
    minCatsSampled: number;
  };
  successCriteria: {
    minProbePassRate: number;
    maxNaturalRegressionCount: number;
  };
  failureCriteria: {
    anyProbeFail: boolean;
    maxNaturalRegressionCount: number;
  };
  revertPlan: {
    snapBackPath: string;
    slaHours: number; // must be <= 24
  };
  governance: {
    toDormant: 'auto-if-criteria-met';
    toRetired: 'cvo_accept_required';
  };
}
```

Trial mode 选择：

| Harness type | Preferred ablationMode | 原因 |
|---|---|---|
| tool / hook / MCP guard | `log_only` | 可以“本该拦截但不拦截”，记录 would-have-fired |
| prompt / SOP / skill thinking harness | `ab_cohort` 或 `full_ablation` + adversarial probes | prompt 在上下文里就会影响行为，不能真正 shadow，只能移除后主动 probe |
| high-risk guardrail | `full_ablation` only in isolated fixture / alpha | 生产路径不允许无保护试验 |

Sunset 判断规则：

1. **低触发率不是 sunset 证据**。低触发只说明场景少，不能区分“能力内化”与“问题间歇出现”。
2. 思考类 harness 的效果用 adversarial probe pass rate 衡量：把当初 harness 要防的 failure pattern 重新呈现给不带 harness 的猫，观察是否仍能正确处理。
3. 任何 probe fail、真实 regression、或 CVO / feature owner 指出关键反例，都立即回退 `active`。
4. `triggerScenarios` 为空时 Trial Plan schema reject；没有原始 failure pattern 的 harness 先补 Eval Contract，不许 sunset。
5. 进入 `dormant` 不是失败，是正常释放注意力预算；进入 `retired` 才是不可逆删除门，必须 CVO accept。

### Phase E Live Verdict Evidence Bundle Contract（OQ-15）

Live verdict 不是单独一篇 markdown。若 verdict 引用 `snapshot:` / `attribution:` evidence ref，必须随 verdict 提交一个 sanitized evidence bundle；bundle 是这两类 ref 的证据真相源，raw runtime snapshot / attribution 只作为派生输入，继续保持 gitignored。

```text
docs/harness-feedback/
  verdicts/
    <verdict-id>.md
  bundles/
    <verdict-id>/
      snapshot.json
      attribution.json
      provenance.json
  snapshots/      # raw runtime generated, gitignored
  attributions/   # raw runtime generated, gitignored
```

Bundle contract：

1. **Bundle 是 `snapshot:` / `attribution:` 的 SOT**。Live verdict 文档中的 `snapshot:` / `attribution:` ref 必须解析到 `docs/harness-feedback/bundles/<verdict-id>/`；不得引用 raw runtime `snapshots/` 或 `attributions/` 路径。
2. **Bundle 是 sanitized subset**。`snapshot.json` 只包含 verdict 实际引用的 domain / window / components / metrics / trend 字段；`attribution.json` 只包含 verdict 实际引用的 finding / no-finding record / evidence anchors；未引用组件、自由文本样本、临时 runtime noise 不进入 bundle。若必须保留 user text，先脱敏或降级为 trace / thread / message ref。
3. **Bundle 可从 raw 重派生**。`provenance.json` 必须记录 raw input path、content hash、generatedAt、generator version / commit、sanitize rules version。相同 raw input + 相同规则应能生成 bit-identical bundle。
4. **Bundle 与 verdict 同提交**。`verdicts/<verdict-id>.md` 与 `bundles/<verdict-id>/` 1:1 绑定；invariant test 必须拒绝 live verdict 缺 bundle、bundle 缺 verdict、或 ref 指向不存在 bundle item。

Evidence ref SOT 分类：

| Ref 类型 | SOT | 说明 |
|---|---|---|
| `snapshot:` / `attribution:` | `docs/harness-feedback/bundles/<verdict-id>/` | 本 contract 覆盖；committed sanitized subset |
| `trace:` | F153 trace store | 已有 canonical SOT，不复制进 bundle |
| `thread:` / `message:` | runtime DB | 已有 canonical SOT，不复制进 bundle |
| `pr:` / `commit:` | git / GitHub | 已有 canonical SOT，不复制进 bundle |

### Phase D Digest Conclusions (AC-D8)

Based on the first micro fit digest (2026-05-11):

- **Upgrade**: route-serial instrumentation is production-ready (high confidence with full counter coverage). Consider per-agent breakdown in future eval cycles.
- **Streamline**: L1/C1/C2 now have dedicated counters (D0 closed all 6 gaps). The mixed `hint_emitted` counter is retained for routing hints (backwards compat) — evaluate removing it once C2 split counters accumulate enough data.
- **No sunset candidates**: All 4 components actively serve A2A chain quality. Action-rate tracking (D9) will surface sunset candidates if findings go unacted for 3+ months.
- **Next cycle focus**: Verify D0 counters are incrementing in production after merge. If any counter shows zero after 1 week of deployment, investigate code path reachability.

## Dependencies

- **Related**: F167（A2A Chain Quality——pilot 目标）
- **Related**: F153（Observability Infrastructure——canonical trace 来源）
- **Related**: F086（Cat Orchestration——anti-散文反思 discipline）
- **Related**: F188（Library Stewardship——health governance / orphan edge / verification debt 作为 memory-domain eval 输入）
- **Related**: F200（Memory Recall Eval——memory-domain 专项 eval 竖井，Phase E 首批迁移对象）
- **Related**: ADR-031（Harness Engineering 方法论）
- **Related**: ADR-032（Local-First Trace Producer Enabler）

## Risk

| 风险 | 缓解 |
|------|------|
| 流程膨胀——eval checkpoint 变成每次 feat close 的 token 黑洞 | Phase A 默认写 `none`，只在触发条件下展开；Phase D digest 显式审计是否太重 |
| Feature Trace Bundle schema 和 F153 trace 脱节 | Authority Boundary 约束：bundle 是 derived view，schema defer to F153 |
| cat interview 变成走形式 | interview 基于 trace 的固定问题，不是自由散文；Phase B pilot 验证有效性 |
| 草案最终没用 | Build to Delete：Phase D digest 是显式 sunset 判断点，废弃只删标注层，不影响 ADR-032 |
| F153 24h TTL 不够 monthly digest | Phase C 不阻塞；Phase D 建 Snapshot Store 每日快照聚合 |
| 又把 eval 做成文档 | Phase C AC-C2 要求 telemetry 数据驱动的 snapshot，手填 = 不通过；AC-C4 明确写入 Phase B 重新定性 |
| 跨猫 403 阻塞 aggregate eval | Phase C 先走单猫可拉的 aggregate 数据；403 不阻塞骨架，Phase D 解决 |
| F153 API 格式变化导致 F192 破碎 | AC-C1 adapter contract test 兜底——变化失败在 adapter 层，不散落一地 |
| Phase E 退化成"漂亮 metrics dashboard" | AC-E3/E5 强制 verdict + handoff + re-eval closure；Eval Hub 不以分数为终点 |
| F192/F200/F188 旧定时任务与新 runtime 双触发 | AC-E6/AC-E13 强制 inventory + disable/redirect + dry-run 证明 |
| domain thread 变成新垃圾桶 | AC-E4 限定 thread 只按域承载长期分析；工作状态 / verdict SOT 在 registry + Eval Hub |
| IM Hub 老系统 thread 与 Eval domain thread 割裂成两套前端模型 | KD-15 明确 System Thread / System Workspace 归一：统一 system kind / linked surface / actions；IM Hub kind=`connector_hub`，Eval kind=`eval_domain`，互用系统分区与删除保护 |
| eval 猫武断给 delete/sunset verdict | AC-E3 要 counterarguments；高影响 delete/sunset 需 CVO accept 或 Design Gate 签字 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 本 feature 是 enrichment layer，不拥有 canonical trace schema | 防止和 ADR-032 变成两套源（team lead + 三猫共识 2026-05-07） | 2026-05-07 |
| KD-2 | F167 作为首个 pilot | 天然具备 failure pattern / trace signal / CVO pain / cat friction / sunset 问题 | 2026-05-07 |
| KD-3 | 立项前置 Eval Contract 塞进 Phase B 验证（方案 C），不 reopen Phase A | 模板需 pilot 验证后才有资格成为硬门禁；AC 驱动验证不是验证驱动 AC（47 提议 + 46 确认） | 2026-05-07 |
| KD-4 | Sunset Signal 空填 = Design Gate 不通过，不设 reviewer 签字降级 | 治"只加不删"的核心机制；说不清何时删 = 没想清楚要解决什么（46 决策） | 2026-05-07 |
| KD-5 | Phase C scope pivot：从"文档模板 + monthly digest"改为"runtime eval 基础设施"。Phase B 重新定性为"Eval Contract & Evidence Artifact Pilot"（预期声明层），不是 runtime eval 完成证明 | Phase B AC 设计把"pilot"翻译成了"写文档模板验证 schema"，没有从 F153 拉运行时数据跑真正的 eval。CVO 原话："f192的基础设施根本没做呀！""一个 harness 需要有硬/软/eval，eval 去观测 harness 跑的如何→归因→抽象→解决"。三猫讨论收敛后team lead确认（2026-05-08） | 2026-05-08 |
| KD-6 | Phase C = 4 条核心 AC（骨架），剩余推 Phase D。原 Phase C (Tool Eval Contracts + Monthly Digest) 推为 Phase D 后半 | 7 条 AC 是终态蓝图，一口气做完有过度设计风险。3-4 条先搭骨架跑通端到端，再扩展（team lead 2026-05-10 确认） | 2026-05-10 |
| KD-7 | Phase E 不开新 F 号，作为 F192 的 Harness Eval Control Plane / Eval Hub 升级 | 关联检测显示 F192 已 owns harness eval + runtime pipeline；longform 第 5 章也把统一 Eval Hub 定位为 F192/F200 竖井的终态收敛 | 2026-05-21 |
| KD-8 | Verdict Handoff Packet 是硬 contract，不是文案建议 | 没有 evidence / trend / root cause / owner ask / re-eval plan 的 handoff 无法 enforce "有理有据"，会退化成"你去看看" | 2026-05-21 |
| KD-9 | 每个 eval domain 要有专属 system thread，但 thread 不是状态真相源 | 深度分析需要长期上下文；状态和趋势仍进入 registry/Eval Hub，避免 thread 变垃圾桶 | 2026-05-21 |
| KD-10 | 旧 scheduled task 清理是接入 AC，不是收尾优化 | F192/F200/F188 已有各自定时/报告机制；不迁移清理会双触发，导致猫猫收到重复 verdict，破坏信任 | 2026-05-21 |
| KD-11 | Phase E 拆为 E-pilot → E-hub → E-scale → E-community；先一个真实 domain 跑通闭环，再做 Hub UI 和多域扩展 | owner review 指出 10 AC 单 Phase 违反 F192 KD-6；Hub 必须由真实 verdict 驱动，避免 F188 dashboard-before-verdict 反模式 | 2026-05-21 |
| KD-12 | Verdict Matrix + Sunset Trial 是 E-hub 前的 contract hardening，不是 UI 后补 | E-pilot review 连续暴露 `fix/build/delete_sunset/keep_observe` 语义洞；应把四类 verdict 的证据门槛、handoff ask、closure 和 CVO 门固化成 contract，避免靠 review 逐条补锅。`delete_sunset` 只能触发可逆 trial，默认终态是 dormant，不直接删除 | 2026-05-22 |
| KD-13 | Live verdict 的 `snapshot:` / `attribution:` evidence SOT 是 committed sanitized bundle，不是 raw runtime artifacts | raw `snapshots/` / `attributions/` 是 gitignored generated artifacts；直接引用会让 clean checkout / reviewer 无法解析 refs。Hybrid bundle 保留审计证据、脱敏边界和可重派生 provenance，同时避免把全量 runtime dump 提交进 repo | 2026-05-22 |
| KD-14 | Eval Hub 是 daily workflow surface，不是 Settings 配置页；F188 Health Dashboard 与 Eval Hub 互链不互替 | Settings 只承载 domain registry / frequency / owner / export policy 等配置。Hub 承载 verdict lifecycle、trend、handoff、closure；F188 承载现场 health repair controls。互链按钮是验收要求，避免用户在两个 surface 间手动找入口；若实用性差，后续调整 IA / 跳转位置属于低风险 UI 改动 | 2026-05-23 |
| KD-15 | System Thread / System Workspace 基座归一：IM Hub 与 eval domain thread 共享系统线程模型，但按 `kind` 区分 | IM Hub（`connector_hub`）和 Eval domain（`eval_domain`）都是 system-managed thread / workspace；归一的是 thread 基础模型、系统分区、删除保护、跳转和管理方式，不归一业务语义。Eval Hub 是工作面，不另造割裂前端；IM Hub 与 Eval Hub 互链，不互替 | 2026-05-23 |
| KD-16 | Phase E 剩余交付按 4 个功能块 PR 收敛：E-hub / E-scale / E-sop / E-community，不按 AC 粒度拆 | PR 边界应对应可独立验收的用户/系统能力，而不是单条 AC。E-hub 由Maine Coon接，E-scale 由Ragdoll接；E-sop 依赖已由 F203 #1868 满足但排在 Hub/Scale 后；E-community 最后基于稳定 contract 输出社区 packet | 2026-05-24 |

## Review Gate

- Phase A: Maine Coon review（草案原作者验证骨架实现与设计一致）
- Phase B: 跨家族 review
- Phase C: spec 更新需跨家族 review；实现需跨家族 review
- Phase D: digest 结论需team lead确认
- Phase E: 架构级 Design Gate 由 F192 owner + 跨族 reviewer 收敛；E-pilot 先行（无 UI）；Eval Hub UI 需等 E-pilot 真实 verdict 后再 design-in-context + team lead验收；legacy scheduled-task cleanup 需 dry-run report
