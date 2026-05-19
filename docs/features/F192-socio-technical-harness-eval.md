---
feature_ids: [F192]
related_features: [F167, F153, F086]
topics: [harness-engineering, eval, socio-technical, observability, cat-user-feedback]
doc_kind: spec
created: 2026-05-07
---

# F192: Socio-Technical Harness Eval — harness 共创评估体系

> **Status**: in-progress | **Owner**: Ragdoll | **Priority**: P1

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

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 本 feature 是 enrichment layer，不拥有 canonical trace schema | 防止和 ADR-032 变成两套源（team lead + 三猫共识 2026-05-07） | 2026-05-07 |
| KD-2 | F167 作为首个 pilot | 天然具备 failure pattern / trace signal / CVO pain / cat friction / sunset 问题 | 2026-05-07 |
| KD-3 | 立项前置 Eval Contract 塞进 Phase B 验证（方案 C），不 reopen Phase A | 模板需 pilot 验证后才有资格成为硬门禁；AC 驱动验证不是验证驱动 AC（47 提议 + 46 确认） | 2026-05-07 |
| KD-4 | Sunset Signal 空填 = Design Gate 不通过，不设 reviewer 签字降级 | 治"只加不删"的核心机制；说不清何时删 = 没想清楚要解决什么（46 决策） | 2026-05-07 |
| KD-5 | Phase C scope pivot：从"文档模板 + monthly digest"改为"runtime eval 基础设施"。Phase B 重新定性为"Eval Contract & Evidence Artifact Pilot"（预期声明层），不是 runtime eval 完成证明 | Phase B AC 设计把"pilot"翻译成了"写文档模板验证 schema"，没有从 F153 拉运行时数据跑真正的 eval。CVO 原话："f192的基础设施根本没做呀！""一个 harness 需要有硬/软/eval，eval 去观测 harness 跑的如何→归因→抽象→解决"。三猫讨论收敛后team lead确认（2026-05-08） | 2026-05-08 |
| KD-6 | Phase C = 4 条核心 AC（骨架），剩余推 Phase D。原 Phase C (Tool Eval Contracts + Monthly Digest) 推为 Phase D 后半 | 7 条 AC 是终态蓝图，一口气做完有过度设计风险。3-4 条先搭骨架跑通端到端，再扩展（team lead 2026-05-10 确认） | 2026-05-10 |

## Review Gate

- Phase A: Maine Coon review（草案原作者验证骨架实现与设计一致）
- Phase B: 跨家族 review
- Phase C: spec 更新需跨家族 review；实现需跨家族 review
- Phase D: digest 结论需team lead确认
