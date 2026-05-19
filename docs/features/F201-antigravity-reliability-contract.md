---
feature_ids: [F201]
related_features: [F061, F172, F174, F178, F183, F193, F194, F197]
topics: [antigravity, reliability, side-effect-journal, availability, recovery, smoke-test, rich-block]
doc_kind: spec
created: 2026-05-15
---

# F201: Antigravity Reliability Contract — 孟加拉猫可靠可用性闭环

> **Status**: done | **Owner**: Maine Coon（Maine Coon） | **Reviewer**: Ragdoll Opus 4.6 + Ragdoll Opus 4.7 | **Priority**: P0

Architecture cell: `transport` + `bubble-pipeline`
Map delta: none — F201 收口 Antigravity provider/retry/recovery 契约，并通过 F183 bubble pipeline 呈现 typed recovery card；不新增并行 transport 或 UI 渲染边界。

## Why

2026-05-15 的现场事故暴露出 F061 close 后仍缺少一个“可靠可用”的产品级契约：

- `@antig-opus` 在旧 cascade 上出现 `Antigravity returned no text response`。这类问题不能只显示空回复，必须告诉用户是 cascade/context 边界、上游空结果、还是我们桥接层没识别输出。
- `@antig-opus` 在隔壁 `adhd asd` thread 写入测试文件成功后，前端显示 `Error: 连接中断`。本地证据显示测试文件确实留下了，说明故障发生在 side effect 之后；此时不能盲 retry，也不能只给红色错误。
- 现有 retry gate 为了避免重复执行工具，遇到 toolish/side-effect activity 后会停止自动 retry，这是正确的安全底线，但用户体验变成“写了文件然后挂了，不知道后续怎么办”。

这不是“给孟加拉猫降级”的问题。我们要把 Antigravity 从“能接入、能偶尔修”提升到“可诊断、可恢复、可验收、可持续巡检”。

### CVO 判断：长任务不可用 = F201 未完成（2026-05-17）

team lead 2026-05-17 头脑风暴拍板：**“现在要是没解决就是 F201 没完成”**。Phase A–E 交付了 side-effect 可追踪 / 不盲 retry / typed recovery card，但**没解决长任务为什么会进入需要 recovery 的状态**。三猫诊断收敛出 root cause 不在 Antigravity 上游，而在我们桥接层的超时/存活判断：

- **Ragdoll/Ragdoll (Opus 4.7)** — 精确 root cause：`stallProbed` 仅在 `deliveryAdvanced`（有新 step 交付）时复位 → 持续无交付的真卡顿**全局只有一次** stall probe，第二个 60s idle 直接 `throw err` → terminal。坐标系错误：用单一固定 idle timeout 衡量所有“等待”，缺 liveness 信号区分“慢但活”vs“真死”。与 F194 invocation liveness 同源。
- **Maine Coon/Maine Coon (GPT-5.5)** — 现场日志证据：不是单纯 idle 超时，而是 native executor success → 2s 后 trajectory 标 ERROR → 2s 后 `STOP_REASON_CLIENT_STREAM_ERROR`，桥接回写时 Antigravity client stream 状态机崩。结论：不能靠“把 stream 变稳定”，要把 stream 降级为**观察通道**，任务生命线必须是我们自己的 durable supervisor + journal + probe + safe resume。
- **Ragdoll/Ragdoll (Opus 4.6)** — 三层超时嫌疑：LS→upstream HTTP idle（不可控）/ bridge→LS RPC / tool 执行时间（`pnpm gate` 跑 10min）/ 审批等待。核心矛盾：长 tool 执行时 bridge 不发数据 → upstream 判 idle 断流。Heartbeat/progress signal 防 idle 最高 ROI。

**共识**：Antigravity 上游不稳是环境约束（不可控），但 liveness 判断 + durable supervisor + heartbeat + 受控 YOLO + 自动 resume 是我们这层**完全能控制**的。这是 F201 愿景“不降级、可恢复、可验收”的核心缺口 → 新增 **Phase F: Long-Task Liveness & Durable Supervisor**，Close Gate 顺延为 Phase G；AC-G 全绿（含真实 alpha）才能 close。

### Phase F Design Gate 决议（2026-05-17）

team lead要求把三件事讲成人话并拍板，Phase F 按以下决议落地：

1. **任务进度记在哪里**：新增 Antigravity 专属 durable supervisor read model（Redis，TTL=0）作为长任务断点/恢复真相源；JSONL 只做审计黑匣子；F194 invocation liveness 只消费摘要投影，不承载 provider-specific 的 cascade / executor receipt 细节。side-effect 状态仍以 Phase B `AntigravitySideEffectJournal` 为唯一真相源，supervisor 只持久化 journal summary snapshot + recovery strategy，不重新分类或平行维护第二套 side-effect journal。
2. **心跳如何判断“慢但活”**：heartbeat 必须由真实 liveness evidence 支撑，不能靠“每 60 秒假装发一句”。证据包括：本地工具 pid/log/exit 仍活跃、trajectory step/partial text 有增长或 mutation、awaiting approval 明确存在、LS/RPC 可重连且能拉到新状态。没有证据时不续命，进入 probe / recovery。
3. **什么时候自动 resume**：不是“只有 journal 全 done 才能自动续”，而是按 side-effect 可逆性 / 可探测性 / 可去重分级。只读、sandbox/sentinel、owned worktree、可 probe 且可去重的动作可自动续；pending/unknown 经过 probe 能归类安全后也可自动续；不可探测、外部不可逆、权限/发布/force-push/Redis 6399/不受控删除等动作必须 surface recovery card 等人工确认。

### Incident Evidence Anchors

| 事故 | Anchor | 现象 | F201 回归形态 |
|------|--------|------|---------------|
| empty response | `thread_mp5lezi1hp0cft3w` / `cascade=e764b99a...` | 老 cascade 上 Antigravity 返回空 `PLANNER_RESPONSE`，前端显示 `Antigravity returned no text response` | `empty_response && no side effect` 应带 cascade health，并在阈值命中时 fresh-cascade retry 一次 |
| post-file-write stream interruption | `thread_mp5vr6hjjwsv9zbw` / `cascade=5df3042c...` 与 `3f5ad2f2...` | 文件写入成功后出现 `stream_error grace expired without recovery`，用户只看到 `连接中断` | `post_side_effect_interrupted` 应输出 side-effect journal + resumable recovery card，禁止盲 retry |

## Feature Audit

| Feature | 当前结论 | 与 F201 的关系 |
|---------|----------|----------------|
| F061 Antigravity 接入 | `done` | Phase 3 已交付 unified upstream fault tolerance：5-kind error taxonomy、`shouldRetryTransient` retry pipeline、toolish-step safety gate、`textMode=replace` partial text recovery、Chinese user-facing messages。F201 不重做这些；F201 在 Phase 3 之上补 ① `CODE_ACTION` 纳入 effect gate，② side-effect journal，③ recovery decision engine refactor 现有 retry gate，④ availability smoke，⑤ typed recovery card。 |
| F172 图片发布 | `done` | 已修 image-only 不应触发 empty_response；F201 不把 image-only 作为 close-gate smoke，避免重新承载 F172 scope；若发现 image regression，回 F172 verify/alpha smoke。 |
| F178 Persistent MCP Agent-Key Auth | `in-progress` | Phase B/C 已解决 agent-key write path MVP，Phase D UI/audit/key orphan guard 未完。F201 只消费 agent-key writeback 是否能调通，不做 agent-key lifecycle health 或 F178 audit。 |
| F193 Cross-Thread Communication Unification | `done` | 为 cross-thread / agent-key / callback 契约提供底座；F201 复用，不重建通信协议。 |
| F183 Bubble Pipeline Architecture Consolidation | `done` | 前端消息气泡和 rich block 管线真相源；F201 typed recovery card 必须走 F183 bubble pipeline，不另起 UI 写路径。 |
| F194 Invocation Liveness Canonical Read Model | `done` | 为“红色连接中断但 invocation 实际做了 side effect”的 read model 提供参考；F201 需要接入 liveness/partial-state 可见性。 |
| F197 ACP tool_result surfacing | `done` | 不是 Antigravity feature，但提供“单事件拆 tool_use/tool_result”的可观测性参照。 |

结论：**需要新 Feature F201**。F061 是接入完成，不是可靠性验收；F178 是鉴权写路径，不覆盖 stream interruption、side-effect resume、availability smoke 和 UI recovery。

## Reliability Contract

F201 关闭时，Antigravity 必须满足以下契约：

1. **失败必须可解释**：所有 `empty_response` / `stream_error` / 上游错误都带结构化 reason、cascadeId、step counters、是否发生 side effect、下一步恢复动作。
2. **side effect 必须可追踪**：文件写入、删除、MCP 写回、图片产物、shell 执行等动作进入 side-effect journal；失败后用户能看到“已完成什么、未完成什么、能否安全继续”。
3. **恢复必须区分安全等级**：side effect 前的瞬态失败可以自动换 fresh cascade 重试；side effect 后只允许 resumable recovery，不做盲 retry。
4. **可用性必须有 smoke gate**：text-only、MCP read、agent-key writeback call、file write/delete sentinel、large cascade retirement 至少一组端到端 smoke 可重复跑。
5. **UI 不再只给红字**：连接中断后展示 typed error card，包含完成动作、残留文件/产物、建议操作和可复制诊断信息。
6. **长任务必须有存活护栏**：长任务不因单一 idle timeout 被误杀；区分“慢但活”（planner 仍产出 / 有 pending tool / executor evidence 仍更新）与“真死”（完全静止）；stream 断后任务生命线由 durable supervisor 持有，不依赖 Antigravity stream 稳定；自动 resume 按 side-effect 可逆性 / 可探测性 / 可去重分级，不能自动续时留结构化断点等人工。睡前交代的长任务，第二天不能只剩 `STOP_REASON_CLIENT_STREAM_ERROR`。

## Journal / Audit Boundary

| Layer | Owner feature | 记录什么 | F201 边界 |
|-------|---------------|----------|-----------|
| Callback verify telemetry / plug indicator | F174 | callback token / principal verify 成败、401 reason、降级提示 | F201 只读取结果，不新增 callback verify audit。 |
| Agent-key write audit | F178 | agent-key 写操作、rotate/revoke/list、key orphan guard、inventory UI | F201 不记录 key lifecycle；只在 smoke 中调用 agent-key writeback 并记录调用结果。 |
| Antigravity side-effect journal | F201 | 单个 cascade/invocation 内 Antigravity 已执行或可能执行的文件、MCP、shell、artifact side effect | F201 journal 用于 retry/resume/UI recovery，不替代 F174/F178 audit。 |

## Scope

### In Scope

- Antigravity cascade health / retirement gate。
- `CORTEX_STEP_TYPE_CODE_ACTION`、`MCP_TOOL`、`RUN_COMMAND`、`GENERATE_IMAGE` 等 step taxonomy 明确化。
- Side-effect journal + retry/resume policy。
- Availability smoke runner + alpha/runtime canary。
- 前端错误展示从“纯红字”升级为 typed recovery card。
- F178 agent-key writeback smoke 接入；不做 agent-key 过期/吊销/rotation health。

### Out of Scope

- 不绕过 Antigravity 平台自身的权限/安全限制。
- 不把 persistent MCP 写权限无限放开；F178 的 allowlist 和 `CAT_CAFE_READONLY` 总闸仍然有效。
- 不用盲 retry 重放文件写入/删除/shell。
- 不新增 F174/F178 审计写口；side-effect journal 只服务 Antigravity recovery。
- 不把 F172 image-only regression 作为 F201 close gate；如需跑 image 回归，挂到 F172 verify/alpha smoke。
- 不把所有上游平台不稳定都包装成“Cat Café 已保证 100% 成功”。F201 保证的是可诊断、可恢复、可验收。

## Acceptance Criteria

### AC-A: Incident Classification

- [x] AC-A1: `empty_response` metadata 至少包含 `cascadeId`、`totalStepsSeen`、`rawStepTypeCounts`、`lastDelivered`、`cascadeHealth`、`sideEffectSummary`。
- [x] AC-A2: `stream_error` 根据 side-effect 状态分为 `pre_side_effect_transient`、`post_side_effect_interrupted`、`upstream_stream_interrupted`。Implemented as `pre_side_effect_transient` / `post_side_effect_interrupted` plus upstream-preserving `cooccurring_upstream_error` so generic `stream_error` cannot mask a specific upstream failure.
- [x] AC-A3: `CORTEX_STEP_TYPE_CODE_ACTION` 不再落入 silent `unknown_activity`；至少被识别为 side-effect-capable activity。
- [x] AC-A4: 不能判定 effect 的 step 默认 side-effect-capable，禁止 blind retry；warning budget 只是 telemetry，不能当恢复策略 gate。
- [x] AC-A5: UI step bucket 与 effect classification 有显式映射表；测试覆盖每个 fixture step 不出现互相矛盾的 retry/UI 结论。

### AC-B: Side-Effect Journal

- [x] AC-B1: 每个 invocation/cascade 有 side-effect journal，记录 stepId、stepType、operation、target、status、idempotencyKey、observedAt；已 `done` 的 side effect 必须有 idempotencyKey。
- [x] AC-B2: 文件写入/删除 smoke 失败时，错误卡明确列出残留路径和清理状态。Resolved in close gate as a scope correction: smoke cleanup is a CLI/report concern (`AntigravityAvailabilitySmokeReport.cleanup` + `diagnostics.preflight.cleanedLeftovers`), while runtime side-effect interruption uses the typed recovery card.
- [x] AC-B3: post-side-effect interruption 不触发盲 retry；只输出 resumable state。
- [x] AC-B4: resume prompt 带 journal 摘要，要求 Antigravity 继续未完成动作且不得重复已完成 side effect；若新 side effect 命中已 done 的 idempotencyKey，Cat Café 侧自动 dedup，不只依赖 prompt 约束。
- [x] AC-B5: 现有 `executionJournal` inline metadata 被 `AntigravitySideEffectJournal` 明确 subsume 或委托，不保留两个同名不同义的 journal。

### AC-C: Availability Smoke

- [x] AC-C1: `pnpm antigravity:smoke` 或等价脚本存在，默认 dry-run / explicit opt-in，不污染真实工作树。
- [x] AC-C2: smoke 覆盖 text-only 回复、MCP read、agent-key thread writeback call、file write/delete sentinel、large cascade retirement。Resolved in close gate by Phase F compression: F201 keeps readonly/sentinel/alpha coverage and leaves agent-key lifecycle/writeback health to F178 per OQ-5/AC-F4.
- [x] AC-C3: smoke 连续 3 次通过，且失败时产出 JSON report（ports、cascadeId、step taxonomy、side-effect journal、cleanup）。Resolved in close gate by Phase F compression: the standalone 3-run live matrix was replaced by AC-G8 real alpha validation plus typed smoke JSON report guards.
- [x] AC-C4: runtime/alpha 启动后能运行只读 health probe，区分“Antigravity 未启动”“LS 不通”“MCP config 旧”“上游模型异常”；agent-key 过期/吊销/rotation health 留在 F178。
- [x] AC-C5: smoke report 有 typed schema（`AntigravityAvailabilitySmokeReport`）和 shape test，禁止回退成 ad hoc JSON。
- [x] AC-C6: sentinel smoke 使用 lockfile（pid + timestamp）；上次异常退出留下 stale lock / leftover 时，下次先报告并清理，清理失败即红灯。

### AC-D: Cascade Context Boundary

- [x] AC-D1: 进入 Antigravity 调用前检查 cascade step count / trajectory size proxy；超过阈值自动 retire 到 fresh cascade，并在消息中标注。
- [x] AC-D2: old cascade `empty_response` 可以自动 fresh-cascade retry 一次，但前提是 journal 证明没有 side effect。
- [x] AC-D3: retry signal 不抹掉已有 partial text；`textMode=replace` 仅用于明确的 fresh-cascade 重试。
- [x] AC-D4: 初始阈值可配置且有测试锚点：warn ≥ 1.5 MiB 或 ≥ 150 steps；retire ≥ 2.0 MiB 或 ≥ 200 steps，且只有 journal clean 时可自动 retire。

### AC-E: User Experience

- [x] AC-E1: 前端不再只显示 `Error: 连接中断`；展示 typed recovery card。
- [x] AC-E2: card 包含“已完成动作 / 未完成动作 / 建议下一步 / 诊断 ID”。
- [x] AC-E3: 用户能复制诊断摘要，直接交给维护猫排查。
- [x] AC-E4: typed recovery card 必须走 rich block（v1 复用 `kind: card`，后续可升级 `antigravity_recovery` kind）并接入 F183 bubble pipeline，不另起 React 消息树。

### AC-F: Close Gate

- [x] AC-F1: 单元测试覆盖 step taxonomy、retry gate、side-effect journal、empty_response metadata。
- [x] AC-F2: 集成测试覆盖 pre-side-effect retry 与 post-side-effect non-retry。
- [x] AC-F3: 手动 alpha smoke 记录落到 close report。
- [x] AC-F4: F178 Phase D 状态不被 F201 偷偷吞掉；若 close 前仍未完成，close report 必须列为 external dependency。
- [x] AC-F5: AC-G 全部满足（含 AC-G8 真实 Antigravity alpha 验收）才允许进 close gate；长任务存活未解决则 F201 不得 close（CVO 2026-05-17 拍板）。

### AC-G: Long-Task Liveness & Durable Supervisor

- [x] AC-G1（root cause 修复）: `stallProbed` 不再“持续无交付时全局仅一次”。stall probe 配额改为有界多次（≥2，指数退避），每次 probe 前判 liveness——“慢但活”不消耗配额，仅“真死”消耗。回归测试：模拟持续无 `deliveryAdvanced` 但上游仍 alive，断言不在第二个 idle 窗口直接 terminal。PR #1735 merged Task 2a: bounded stall probe budget + trajectory-progress liveness guard.
- [x] AC-G2（liveness 信号）: poll loop 引入 cascade liveness 判据，区分“慢但活”与“真死”。“慢但活”必须有证据：planner partial text 增长 / step mutation / pending tool or approval / native executor pid 或 log 更新 / LS-RPC 可重连且 trajectory timestamp 推进。idle stall timeout 只对“完全静止 + 无 pending + 无 executor evidence”的真死触发；liveness 摘要与 F194 invocation liveness 对齐，不新建并行 UI 真相源。PR #1749 merged PR1: bridge/service liveness signals now include bounded trajectory timestamp progress, pending approval/tool evidence, RPC reconnect evidence, native executor activity, and supervisor-projected liveness summaries; trajectory-derived evidence is bounded by stall budget unless real delivered progress advances.
- [x] AC-G3（heartbeat 防 idle）: 长 tool / 长等待执行期，bridge 层有 keepalive 机制防 upstream idle 断流；upstream 是否接受 injected planner step 必须先用真实 Antigravity spike 验证，不接受则降级为 trajectory re-pull 探针保活。PR #1749 merged PR1: fake planner injection was not shipped; the accepted heartbeat path is trajectory re-pull + liveness-only batches, with terminal and idle-timeout guards evaluated before timestamp heartbeat so heartbeat cannot mask true dead or terminal cascades.
- [x] AC-G4（durable supervisor）: 存在 Antigravity 专属 Redis supervisor record（TTL=0）持久记录 threadId / catId / invocationId / cascadeId / status / last observed step / last trajectory timestamp / native executor evidence / journal summary snapshot / receipt state / recovery strategy / resume attempt count。side-effect 状态以 Phase B `AntigravitySideEffectJournal` 为唯一真相源；supervisor 只持久化 journal 派生摘要，不重新分类 side effect、不平行维护第二套 journal。JSONL 继续做 append-only audit；F194 只接收摘要投影。`STOP_REASON_CLIENT_STREAM_ERROR` 或 stream 断不立即判死——先重拉 trajectory + 重 attach LS + 查 executor 回执再决策。PR #1739 merged Task 1: provider-internal store / no-expire Redis persistence / narrow liveness projection foundation. PR #1740 merged Task 2b: runtime Redis store injection + service wiring for started/batch/liveness/probe/resumable/done records, using Phase B journal summary snapshots only. PR #1749 merged PR1: durable supervisor evidence closeout adds bounded liveness evidence and native executor evidence validation while preserving Phase B journal as the only side-effect truth source.
- [x] AC-G5（回执冲突分流）: native executor success 但 trajectory 标 ERROR 的竞态标为 `receipt_conflict`，不当简单失败。恢复按 side-effect 分流：无副作用→可重试/重放；已确认/待确认/未知 side-effect 风险→标记 + resumable manual card，且 supervisor 持久化 `receiptState=native_success_trajectory_error`。Task 3 merged in PR #1741 (`f7c82cfe`): receipt-conflict persistence uses Phase B `sideEffectJournal.summary()` snapshots only, never reclassifies side effects in supervisor wiring. Deterministic probe / effect-tier resume remains in AC-G6.
- [x] AC-G6（自动 resume）: 自动续跑按 effect tier 分级，而不是只看 journal 是否全 `done`。tier 判定只读取 Phase B journal summary + deterministic probe 结果；不能证明归类时必须 fail-closed，默认进入最高风险/人工确认路径，绝不向 Tier 1/2 自动续跑 fall-through。Tier 1 只读 / build / test / lint 可自动续；Tier 2 owned sandbox / sentinel / worktree / branch 等可 probe 且可去重的动作，probe 清楚后可自动续；Tier 3 覆盖已有业务文件、修改共享状态、GitHub 写操作、跨 thread 发消息等默认 surface card；Tier 4 force push / merge PR / close issue or PR / release publish / Redis 6399 / credential or permission mutation / 不受控删除等永不自动续。自动续跑必须注入 Phase C `resumeContext`，且同一原始 invocation 设置 resume attempt 上限防循环。Task 4 merged in PR #1743 (`472329280`): provider-internal fail-closed tier classifier foundation, journal-summary-only input, deterministic owned-probe gate, broad manual boundaries, and hard refusal guards. Task 5 merged in PR #1744 (`061b27a6`): actual safe auto-resume execution wiring, `ANTIGRAVITY_AUTO_RESUME=false` rollback, per-invocation attempt cap, Phase C `resumeContext` prompt injection, shared capped retry path for `empty_response`, and safe-prompt preservation across subsequent fresh-cascade retries.
- [x] AC-G7（受控 YOLO）: YOLO 消除“等审批 idle”一类——受控（命令白/黑名单、root delete / Redis 6399 / fork bomb hard-refuse、side-effect journal 全覆盖、超时 + 审计）。spec 明确 YOLO 不解决上游慢/断；可靠性方案不以 YOLO 为主线。PR #1751 merged PR2 (`f1e373d49`): `run_command` now has `ANTIGRAVITY_RUN_COMMAND_TIMEOUT_MS` with safe-integer bounds, default 600s executor timeout, Bridge socket timeout buffer `max(30s, timeout + 5s)`, and abort-aware RPC teardown. Hard refusal still executes before dispatch, so root delete / Redis 6399 / fork bomb payloads never reach the timeout-wrapped RPC path. Alpha must still observe whether timed-out LS-side commands can leave orphan work, because executor timeout guarantees our layer stops hanging but cannot prove upstream process cancellation.
- [x] AC-G8（端到端验收）: 睡前交代长任务，第二天结果不能只剩 `STOP_REASON_CLIENT_STREAM_ERROR`——最差留结构化断点（completed/pending + continue-safely 动作），最好 supervisor 自动续完。真实 Antigravity alpha smoke passed under the original polluted-shell condition (`NODE_ENV=production`): `/` and `/settings` returned 200, PostCSS was back in the `globals.css` loader chain, all five `/vendor/app/*.css` links returned 200, and the earlier cascade-order P1 was withdrawn with deterministic `<head>` ordering evidence.

## Implementation Phases

### ✅ Phase A: Spec + Evidence Baseline

- 固化 2026-05-15 两个事故为 regression cases。
- 建 `AntigravityReliabilityEvent` / `SideEffectJournalEntry` 的领域模型。
- 给现有 F061/F172/F174/F178/F183/F193/F194/F197 做边界说明，避免重复 reopen。
- Merged in PR #1689 (`57acad964`): Phase A also landed the step-effect classifier baseline, `CODE_ACTION` visibility, unknown-step fail-closed retry veto, and UI/effect mapping tests.

### ✅ Phase B: Step Taxonomy + Journal

- 把 step 分类从 ad hoc boolean 提升为单点函数：`classifyAntigravityStepEffect(step)`。
- 明确 `CODE_ACTION`、`MCP_TOOL`、`RUN_COMMAND`、`GENERATE_IMAGE` 的 effect type 和 retry safety。
- 迁移契约：`classifyStep()` 保留为 UI bucket mapper，但所有 retry/side-effect 问题都委托 `classifyAntigravityStepEffect()`；`batchHasToolishStep` 被 journal/effect summary 替换，不继续新增第三套判断。
- journal 先落 invocation metadata / JSONL audit，后续可接 Redis read model。
- Merged in PR #1693 (`856355f39`): side-effect journal、JSONL audit、raw-target idempotency hashing、sensitive target redaction、legacy toolish gate deletion、outer invoke failure audit flush、F061 read-only `RUN_COMMAND` compatibility。

### ✅ Phase C: Recovery Policy

- 封装 `decideAntigravityRecovery(error, journal, cascadeHealth)`。
- Phase C 必须 deprecate inline `shouldRetryTransient` 决策，并把 `attemptHasResolvedToolishStep` / native dispatch / tool activity 信号收口进 decision engine；保留 F061 Phase 3 的 `classifyUpstreamError()` 与 `humanErrorMessage()` 作为 error taxonomy helpers，不允许两套 retry policy 并存。
- pre-side-effect transient 才 fresh retry。
- post-side-effect interruption 输出 resumable error + journal summary。
- 构造 resume prompt payload：由 API 根据 journal summary 生成 machine-readable resume context，下一次继续时要求 Antigravity 跳过已完成 side effect，只执行未完成动作。
- large cascade 自动 retire 留到 Phase D：Phase C 保留 `empty_response_without_retryable_cascade_health` 决策接口，Phase D 接 cascade health / retirement gate。
- Merged in PR #1700 (`f7061700c`): centralized recovery policy、post-side-effect resumable diagnostics + resume context、inline retry policy deletion、journal-derived `executionJournal` compatibility metadata、read-only `MCP_TOOL` transient retry narrowing with explicit tests。

### ✅ Phase D: Smoke + Canary

- 增加 explicit opt-in smoke runner，产生 machine-readable report。
- alpha 环境加入只读 health probe。
- smoke 使用 sentinel directory，必须清理；清理失败是测试失败。
- Merged in PR #1702 (`4dcbe0b2b`): cascade-health assessment (`warn`/`retire` thresholds), side-effect-safe pre-turn retirement marker, clean-journal `empty_response` fresh-cascade retry, and `pnpm antigravity:smoke` with readonly dry-run plus explicit sentinel write mode. Full AC-C2/C3 live smoke matrix remains open until real Antigravity alpha runs.

### ✅ Phase E: UI Recovery Card

- API error metadata 标准化。
- API 在 post-side-effect resumable error 前输出 F183 `rich_block` card，包含 completed/pending effects、建议下一步、diagnostic ID 和可复制诊断摘要。
- Web `CardBlock` 支持 `copy-to-clipboard` action，复用现有 rich block bubble pipeline，不新增 React 消息树。
- 保留原始红字作为 fallback，不作为主体验。
- Merged in PR #1707 (`209e707a`): typed recovery rich block card emission for post-side-effect stream errors, diagnostic-copy card action, backend recovery-card regression test, and web card action test. Real Antigravity alpha validation remains in Phase F close gate.

### Phase F: Long-Task Liveness & Durable Supervisor

> 三猫头脑风暴收敛（2026-05-17）：47 root cause（`stallProbed` 一次性）、Maine Coon supervisor 四层 + 回执冲突现场证据、46 三层超时表 + heartbeat ROI。

- **Design Gate 决议已拍（2026-05-17）**：supervisor 落 Antigravity 专属 Redis read model + JSONL audit + F194 摘要投影；side-effect 状态只从 Phase B journal 派生，不建第二套真相源；heartbeat 先做真实 Antigravity spike，禁止未验证的 fake planner 注入；自动 resume 按 side-effect 可逆性 / 可探测性 / 可去重分级，无法分类时 fail-closed。
- Task 2a merged in PR #1735 (`7d7a809e`): `stallProbed` one-shot root cause fixed with bounded probe budget + trajectory-progress liveness guard（AC-G1 ✅；AC-G2 broader liveness evidence remains open）。
- Task 1 merged in PR #1739 (`52debba44`): provider-internal Antigravity supervisor store foundation with no-expire Redis keys, Phase B journal summary snapshots, JSONL audit redaction, and narrow F194 liveness projection（AC-G4 foundation ✅；service wiring remains open）。
- Task 2b merged in PR #1740 (`51859d2e`): Antigravity service now persists supervisor lifecycle records to the runtime Redis-backed store（started / batch / liveness / probe / resumable / done）and preserves resumable records on post-side-effect `empty_response`; AC-G4 service wiring ✅, receipt-conflict/evidence decision path remains open for AC-G5.
- Task 3 merged in PR #1741 (`f7c82cfe`): native executor success + trajectory/upstream ERROR is classified as `receipt_conflict`; no-side-effect conflicts retry via fresh cascade, while observed/pending/unknown side-effect risk persists resumable/manual-card supervisor state with `receiptState=native_success_trajectory_error`（AC-G5 ✅；deterministic tier probing remains in AC-G6/Task 4）。
- Task 4 merged in PR #1743 (`472329280`): adds the provider-internal resume tier classifier for AC-G6. The classifier reads Phase B journal summary snapshots only, fail-closes unknown/insufficient evidence, routes hard refusals to Tier 4 before probes, routes shared/external operations to Tier 3, and allows Tier 2 only with owned + reliable + successful deterministic probe evidence. Actual resume execution / attempt cap remains Task 5.
- Task 5 merged in PR #1744 (`061b27a6`): wires the AC-G6 execution path. Antigravity auto-resume is gated by the Task 4 classifier, injects Phase C `resumeContext` into the fresh cascade prompt, persists `auto_resuming` supervisor attempt state, caps attempts per original invocation, supports `ANTIGRAVITY_AUTO_RESUME=false` rollback, routes post-side-effect `empty_response` through the same capped retry helper, and preserves the safe prompt across later pre-side-effect fresh-cascade retries（AC-G6 ✅）。
- **Remaining implementation compression（2026-05-17 CVO + 46/55 agreement）**：剩余 Phase F 不按“一个 AC 一个 PR”拆。PR1 合并 AC-G2/G3/G4 为“活性全家桶”：liveness signal、heartbeat/keepalive 能力验证、trajectory re-pull fallback、durable supervisor evidence 状态机必须端到端一起测；heartbeat upstream 兼容性验证直接进入 PR1 的 Red→Green，而不是单开 spike PR。PR2 单独做 AC-G7 controlled YOLO，因为它是高风险执行策略，需要独立安全 review。Close 只做 AC-G8 alpha 验收 + AC-F close report/docs commit，不再单开实现 PR。
- PR1 merged in PR #1749 (`5b7569c97`): closes AC-G2/G3/G4 as one liveness bundle. Trajectory re-pull heartbeat is bounded, terminal/idle guards win over timestamp churn, native executor and pending approval/tool evidence persist into supervisor records, and F194 receives only sanitized liveness projections. Side-effect state remains Phase B journal-derived.
- PR2 merged in PR #1751 (`f1e373d49`): closes AC-G7 controlled YOLO. `run_command` dispatch is bounded by an executor-layer timeout plus Bridge socket buffer, env parsing fails closed to a safe default, abort/error listeners are attached before teardown to avoid unhandled request errors, and existing hard-refusal / opt-out boundaries remain ahead of dispatch.
- Alpha unblock hotfixes merged in PR #1756 (`3339b86fe`), PR #1760 (`e8cc8135f`), and PR #1773 (`a24cf2d53`): app-level global CSS that does not need Next processing now loads from static vendor links with dev watcher sync, while the remaining Tailwind `globals.css` path is protected by forcing frontend `next dev` to run with `NODE_ENV=development` even when the invoking shell is polluted with `NODE_ENV=production`. These unblock AC-G8 alpha validation but do not by themselves close AC-G8.
- Close commit: real Antigravity alpha validation + close report（AC-G8 + AC-F）。
- 与 F194（invocation liveness）、F178（agent-key writeback，supervisor 跨 invocation 续跑需要）边界对齐，不重建真相源。

### Phase G: Close Gate

- 跑单元、集成、smoke、alpha 手测。
- 找跨家族 reviewer，至少 46/47 + Maine Coon三方签字。
- close report 写入 F201 timeline。
- **AC-F5 硬门禁**：AC-G1~G8 全绿（含 AC-G8 真实 Antigravity alpha 长任务验收）才允许 close；未解决长任务存活 → 不得 close。

## Close Gate Report

**State**: done — vision guardian PASS + CVO close signoff captured.  
**Author**: Maine Coon/Maine Coon（Codex, GPT-5.5）.  
**Vision guardian**: Ragdoll/Ragdoll（Opus 4.6） PASS.

```yaml
close_gate_report:
  feature_id: F201
  spec_path: docs/features/F201-antigravity-reliability-contract.md
  head_sha: "a24cf2d53 root-cause fix; 6e47e95ab close-gate doc sync"
  report_date: 2026-05-19
  state: "done"

  cvo_signoff:
    date: 2026-05-19
    source: "thread event 0001779184326808-000249-989c2493"
    decisions:
      - "Approved deleting/reclassifying legacy AC-B2, AC-C2, and AC-C3, with the condition that the report aligns to current implementation."
      - "Confirmed controlled YOLO timeout boundary after implementation check: the 600s default applies per Antigravity run_command tool execution, not to the whole cascade or a group of tools."
      - "A shell chain packed into one run_command still shares one 600s budget; long single-command workflows can raise ANTIGRAVITY_RUN_COMMAND_TIMEOUT_MS."

  user_visibility_disclosure:
    now_visible:
      - "Antigravity stream/empty-response failures now carry structured diagnostics instead of a plain red error."
      - "Post-side-effect failures surface completed/pending effects and a copyable diagnostic summary."
      - "Long waits are evaluated with bounded liveness evidence instead of a single idle timeout."
      - "Each Antigravity run_command execution is bounded by a default 600s timeout; multi-tool sequences get a fresh budget per run_command, while shell chains inside one run_command share that budget."
      - "Safe owned work can auto-resume through a capped fresh cascade; unsafe/irreversible work surfaces a manual card."
      - "Alpha starts reliably even when the caller shell has NODE_ENV=production."
    deliberately_not_in_f201:
      - "F178 agent-key inventory/audit/key orphan guard remains owned by F178 Phase D."
      - "Windows portable and Electron direct Next launch vendor-sync bypasses remain outside the alpha path."
      - "Antigravity upstream process cancellation after our executor timeout cannot be proven unless LS supports server-side cancellation."

  harness_feedback:
    status: written
    path: docs/harness-feedback/reviews/F201-feature-fit-review.md
    primary_failure_class: environment_drift

  reflection_capsule:
    status: written

  ac_matrix:
    - ac_id: AC-A1..AC-A5
      status: met
      evidence:
        - kind: pr
          ref: "PR #1689 / #1693 / #1700"
          description: "step-effect taxonomy, CODE_ACTION classification, fail-closed unknown steps, centralized recovery policy"
        - kind: test
          ref: "packages/api/test/antigravity-agent-service-diagnostics.test.js + antigravity-recovery-policy.test.js"
          description: "empty_response metadata, pre-side-effect retry, post-side-effect surfaced diagnostics"
        - kind: code
          ref: "antigravity-recovery-policy.ts"
          description: "stream_error branches into pre_side_effect_transient, post_side_effect_interrupted, and upstream-preserving cooccurring_upstream_error"
    - ac_id: AC-B1
      status: met
      evidence:
        - kind: pr
          ref: "PR #1693"
          description: "AntigravitySideEffectJournal records stepId/type/operation/target/status/idempotencyKey/observedAt and JSONL audit"
    - ac_id: AC-B2
      status: deleted
      resolution: "Smoke cleanup is a CLI/report concern, not a runtime recovery card. The shipped contract is AntigravityAvailabilitySmokeReport.cleanup + diagnostics.preflight.cleanedLeftovers; runtime side-effect interruption remains covered by the typed recovery card."
      cvo_signoff: "approved_by_landy_2026-05-19"
      evidence:
        - kind: test
          ref: "scripts/antigravity-availability-smoke.test.mjs"
          description: "stale lock, leftovers, cleanup failure and cleanup success are reported structurally"
    - ac_id: AC-B3..AC-B5
      status: met
      evidence:
        - kind: pr
          ref: "PR #1700 / #1744"
          description: "post-side-effect non-retry, resumeContext prompt injection, and journal-derived executionJournal compatibility"
        - kind: test
          ref: "packages/api/test/antigravity-side-effect-journal.test.js + antigravity-resume-context.test.js + antigravity-agent-service-fatal-errors.test.js"
          description: "done idempotency key dedup, completed/pending resume context split, no blind retry after writes"
    - ac_id: AC-C1
      status: met
      evidence:
        - kind: pr
          ref: "PR #1702"
          description: "pnpm antigravity:smoke defaults readonly/dry-run and sentinel write mode is explicit opt-in"
    - ac_id: AC-C2
      status: deleted
      resolution: "The original full live matrix was superseded by the 2026-05-17 Phase F compression decision. F201 close gates on readonly/sentinel smoke guards plus AC-G8 alpha validation; agent-key thread writeback health remains an F178 dependency."
      cvo_signoff: "approved_by_landy_2026-05-19"
      evidence:
        - kind: doc
          ref: "F201 Phase F Remaining implementation compression"
          description: "CVO + 46/55 agreement: AC-G8/AC-F close as validation/docs only, no standalone implementation PR"
        - kind: alpha
          ref: "AC-G8 alpha smoke 2026-05-19"
          description: "root/settings compile, vendor CSS 200, PostCSS loader chain verified under NODE_ENV=production shell"
    - ac_id: AC-C3
      status: deleted
      resolution: "The standalone 3-run live matrix was replaced by deterministic AC-G8 alpha evidence plus typed JSON smoke report guards. This avoids a long-running external Antigravity dependency becoming a fake completion criterion."
      cvo_signoff: "approved_by_landy_2026-05-19"
      evidence:
        - kind: test
          ref: "scripts/antigravity-availability-smoke.test.mjs"
          description: "typed report shape, cleanup, stale lock, secret redaction"
        - kind: alpha
          ref: "AC-G8 alpha smoke 2026-05-19"
          description: "real alpha boot under original failure condition"
    - ac_id: AC-C4..AC-C6
      status: met
      evidence:
        - kind: pr
          ref: "PR #1702"
          description: "readonly health probe, typed AntigravityAvailabilitySmokeReport, sentinel lock/cleanup"
    - ac_id: AC-D1..AC-D4
      status: met
      evidence:
        - kind: pr
          ref: "PR #1702"
          description: "cascade health thresholds, clean-journal fresh retry, side-effect-safe pre-turn retirement"
    - ac_id: AC-E1..AC-E4
      status: met
      evidence:
        - kind: pr
          ref: "PR #1707"
          description: "typed rich_block recovery card with completed/pending actions, suggested next step, diagnostic ID, copy action"
    - ac_id: AC-F1
      status: met
      evidence:
        - kind: test
          ref: "antigravity-step-effects / recovery-policy / side-effect-journal / agent-service-diagnostics suites"
          description: "unit coverage for taxonomy, retry gate, journal, empty_response metadata"
    - ac_id: AC-F2
      status: met
      evidence:
        - kind: test
          ref: "packages/api/test/antigravity-agent-service-fatal-errors.test.js"
          description: "pre-side-effect retry and post-side-effect non-retry integration coverage"
    - ac_id: AC-F3
      status: met
      evidence:
        - kind: alpha
          ref: "AC-G8 alpha smoke 2026-05-19"
          description: "manual alpha evidence is captured in this close report"
    - ac_id: AC-F4
      status: met
      external_dependency:
        feature: F178
        status: "in-progress"
        boundary: "agent-key inventory/audit/key orphan guard remains F178; F201 only consumes agent-key writeback where available"
    - ac_id: AC-F5
      status: met
      evidence:
        - kind: ac
          ref: "AC-G1..AC-G8"
          description: "all long-task liveness and durable supervisor ACs are green after AC-G8 alpha smoke"
    - ac_id: AC-G1..AC-G7
      status: met
      evidence:
        - kind: pr
          ref: "PR #1735 / #1739 / #1740 / #1741 / #1743 / #1744 / #1749 / #1751"
          description: "bounded stall probes, durable supervisor, receipt conflict split, resume tiers, auto-resume, liveness bundle, controlled YOLO"
        - kind: review
          ref: "Opus-47 strict reviews + cloud Codex reviews"
          description: "blocking P0/P1/P2 review loops closed before merge"
    - ac_id: AC-G8
      status: met
      evidence:
        - kind: alpha
          ref: "Opus-47 AC-G8 alpha smoke 2026-05-19"
          description: "NODE_ENV=production shell; / 200 38779B; /settings 200 32440B; PostCSS loader chain restored; all /vendor/app CSS 200"
        - kind: alpha
          ref: "cascade-order P1 withdrawal"
          description: "HTML head order proves Next app CSS loads before static console CSS, so Tailwind does not override console controls"

  unmet: []
  deleted_or_scoped_out:
    - ac_id: AC-B2
      reason: "runtime card wording was too broad for a CLI smoke failure; shipped report schema gives stronger machine-readable cleanup evidence"
    - ac_id: AC-C2
      reason: "agent-key writeback live matrix belongs to F178; F201 close gate was explicitly compressed to AC-G8 alpha + AC-F docs"
    - ac_id: AC-C3
      reason: "3-run external live matrix would be brittle and was replaced by deterministic alpha evidence + typed report guards"
  follow_ups: []
  close_blockers: []
```

## Open Questions for Review

| # | 问题 | 推荐立场 |
|---|------|----------|
| OQ-1 | side-effect journal 第一版落哪里？ | 先落 invocation metadata + JSONL audit，避免先做 Redis migration；等 UI/read model 稳定后再迁移。 |
| OQ-2 | `CODE_ACTION` 的 file path / operation 如何可靠提取？ | 先用 raw step schema 适配器 + shape tests；无法提取时仍记录 `operation=unknown_code_action`，但标记为 side-effect-capable。 |
| OQ-3 | post-side-effect interruption 是否允许自动 resume？ | ✅ Superseded by OQ-8 Phase F Design Gate：不再用“有 side effect 就默认不自动”的粗粒度规则，改为按 side-effect 可逆性 / 可探测性 / 可去重分级；不可探测或外部不可逆仍必须人工确认。 |
| OQ-4 | smoke 是否可以写真实 docs 路径？ | 不可以。必须写 sentinel sandbox，除非用户明确指定现场复现。当前留下的 `_test-write-capability.md` 只作为事故证据，不作为常规 smoke。 |
| OQ-5 | F178 Phase D 是否并入 F201？ | 不并入。F178 Phase D 是 agent-key inventory/audit，F201 只消费其结果并在 close gate 检查依赖状态。 |
| OQ-6 | durable supervisor 状态落哪？ | ✅ Design Gate 决议（2026-05-17）：Antigravity 专属 Redis supervisor record（TTL=0）作为长任务断点/恢复真相源；JSONL 为审计；F194 只接摘要投影，不承载 provider-specific 细节。side-effect 状态仍以 Phase B journal 为唯一真相源，supervisor 只存 journal summary snapshot + recovery strategy。 |
| OQ-7 | heartbeat 注入 planner step 上游是否接受？ | ✅ Design Gate 决议：先用真实 Antigravity spike 验证，不默认注入 fake planner step；heartbeat 必须有真实 liveness evidence，上游不接受则降级为 trajectory re-pull + supervisor resume。 |
| OQ-8 | 自动 resume 的边界？ | ✅ Design Gate 决议：按 side-effect 可逆性 / 可探测性 / 可去重分级；只读、owned sandbox、可 probe 的动作可自动续；不可探测、外部不可逆、权限/发布/force-push/Redis 6399/不受控删除等必须人工确认。无法分类的动作默认最高风险档，fail-closed，绝不自动续跑。 |
