---
feature_ids: [F268]
related_features: [F192, F223, F244, F266, F267]
topics: [capability-tips, telemetry, effectiveness, eval, privacy, knowledge-feed]
tips_exempt: "This feature measures the existing capability-tips surface; it does not introduce another user-invokable capability that needs its own tip"
doc_kind: spec
created: 2026-07-18
description: "把 Capability Tips 的本地事件接成隐私最小、可持久聚合、能验证真实效果的端到端评估管道。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-18T12:11:00Z
---

# F268: Capability Tips Telemetry & Effectiveness Pipeline — 提示效果管道

> **Status**: Phase B implemented; Phase C gated | **Owner history**: @opus (Phase A/B author) → @codex-sol (operator-authorized Phase B closeout) | **Priority**: P1

Architecture cell: `hub-action-surface` + `harness-eval`
Map delta: none
Why: F244 继续拥有 waiting-state tips 投影与事件语义，F223 继续拥有能力来源，F192/F267 拥有 eval 与 measurement contract；本 Feature 只补 web→API→durable aggregate→source adapter 的缺失竖切，不移动既有边界。

## Why

F244 已经让用户在等待态看到 tips，也定义了 privacy-minimal usage event，但事件停在浏览器 localStorage；API rollup/source adapter 未接，`eval:capability-tips` 因没有真实使用数据保持 disabled。我们因此不知道提示有没有被看见、action 是否可达、dismiss 是否说明打扰，更不知道点击之后是否真的帮助猫或用户完成任务。operator 已明确拍板“当然是需要管道啊！！”（msg `0001784347935457-000058-4788b357`）。本 Feature 要把信号接通，但拒绝把点击率冒充能力提升。

## Current State / 现状基线

- F244 已于 2026-06-22 完成，真实交付 waiting-state projection、tip inventory、stale checker、5 轮 operator dogfood 与本地事件形状；不能通过 reopen F244 篡改其完成历史。
- `packages/web/src/lib/capabilityTipEvents.ts` 最多在 localStorage 保存 100 条事件，失败 silent degrade；没有跨重启/跨设备可靠 delivery contract。
- `eval-capability-tips.yaml` 已定义 consumer/handoff/sourceAdapter 名称，但 `enabled:false`；web 有 producer，API rollup/source adapter 无实现。
- 当前可见 event 包括 exposed/action/dismiss/source-open failure 一类 privacy-minimal signal；现有字段与实际 source 仍需 Phase A census，不能从文档猜 schema。
- click/action 只能证明入口被触发，不能证明用户理解、任务成功或 capability-wakeup miss 降低。

## What

### Phase A: Event Census + Privacy/Delivery Contract

- 开箱现有 event schema、selector state、localStorage retention/failure semantics；锁定哪些字段属于 canonical input，哪些只能作客户端诊断。
- 定义最小事件 envelope、batch id/idempotency、attempt/ack、flush/retry/backoff 与 bounded client queue；tips 展示不得因 telemetry 故障被阻塞。
- 禁止采集 tip body、用户消息正文、prompt、文件内容或可逆重建个人行为的自由文本；identity/granularity/retention 进入 Design Gate Decision Packet。
- 旧 localStorage 数据只在 identity/provenance 足够时 best-effort 导入；不可证明就从新窗口开始，不伪造历史连续性。

### Phase B: API Durable Aggregate + Source Adapter

- 建立认证 API ingress、schema validation、幂等 durable sink 与 bounded aggregate；原始事件与聚合的 retention/删除策略显式化。
- 实现 `eval:capability-tips` source adapter，输出 exposure/action/dismiss/failure 与 opportunity denominator；无数据必须是 `no_data`，不是 healthy。
- 加入 transport degradation 现场可见性：queue 满、持续上传失败或 schema reject 有可诊断状态，但不暴露个人内容。
- domain 继续保持 disabled，直到 F267 measurement certificate 与 Phase B replay 通过。

### Phase C: Effectiveness Evaluation + First Live Verdict

- 按 F267 契约区分 adoption（看见/打开）、friction（dismiss/failure）与 outcome（随后是否完成相关 workflow/降低同类 wakeup miss）；不把 click 直接计为 success。
- 优先使用 cohort/window aggregate 和已有 task-outcome/capability-wakeup refs，避免建立用户内容级行为画像或脆弱的跨域逐人 join。
- 启用 domain 后产出首份 weekly verdict，并在 F266 thin slice 可用时进入统一 closure；F266 未完成不阻塞本 Feature 建管道，但 Program 不宣称全闭环 readiness。
- 与 F244 stale/sunset checker 对接 owner action：source 失效、高 dismiss、长期无价值 signal 均能触发有证据的 review，而非自动删 tip。

## User Journey

### Primary Journey: 提示能学习，但不偷看内容
- **Scope unit**: workspace
- **Actor**: operator
- **Entry**: 猫执行/等待时出现现有 Capability Tip；需要时在 Eval Hub 查看汇总结果
- **Flow**:
  1. 正常看到或使用 tip；telemetry 上传失败不影响提示与任务本身。
  2. 系统只记录最小结构事件，不记录对话、tip 正文或工作内容。
  3. 周期 verdict 能解释哪些 tips 被看见、哪里失败/被 dismiss、是否有后续结果证据；证据不足时明确说 `no_data/insufficient`。
- **Success evidence**: privacy field audit + browser/API failure replay + durable aggregate + first live verdict/Hub projection
- **Non-goals**: 不做用户内容画像；不跨设备同步 tip selector state；不以 CTR 排行；不自动删除低点击 tip；不重做 F244 UI/inventory。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “当然是需要管道啊！！” | AC-A1..B4 | web→API→store→adapter replay | [x] |
| R2 | 三个 Feat 自治；tips 可并行造管道，但启用前等 B 校准，verdict 后接 A | AC-B4 / AC-C3 / AC-C5 | workflow/dependency gate | [ ] |
| R3 | 不把点击提示等同能力提升 | AC-C1 / AC-C2 | measurement certificate + verdict fixture | [ ] |
| R4 | 过程不打扰中心，只有愿景/战略/跨 Feat/不可逆红灯升级 | AC-C5 | thread checkpoint audit | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 本 Feature 默认不改 UI；若新增诊断 surface，Design Gate 补需求→证据映射

## Acceptance Criteria

<!-- 每条 AC 必须 trace 回 Why，并由非作者复核。 -->

### Phase A（Event + Privacy/Delivery Contract）
- [x] AC-A1: census 开箱现有 event/source/queue 行为并锁定最终字段；不存在文档臆造的 event kind。
- [x] AC-A2: event envelope 与 batch/idempotency/ack/retry/overflow contract 有 Red→Green 测试；telemetry 故障不阻塞 tips/任务。
- [x] AC-A3: 字段级 privacy test 证明不采集 tip body、用户正文、prompt、文件内容或自由文本；retention/identity/granularity 经 Design Gate 明确。
- [x] AC-A4: 旧 localStorage migration 有 provenance gate；无法证明 identity/window 时从新 baseline 开始并显式记录。

### Phase B（Durable Pipeline + Adapter）
- [x] AC-B1: 真实/fixture 事件可从 web batch 进入认证 API、幂等 durable sink 与 aggregate；重复投递不重复计数，restart 后数据可回读。
- [x] AC-B2: queue full、网络失败、schema reject 有有界 retry 与现场诊断；无正文/个人内容泄漏。
- [x] AC-B3: source adapter 输出 opportunity/exposure/action/dismiss/failure 与 provenance；空窗口生成 `no_data`，不生成 healthy。
- [x] AC-B4: `eval:capability-tips` 在 F267 certificate + pipeline replay 通过前保持 `enabled:false`，hard test 防止提前启用。

### Phase C（Effectiveness + Live Verdict）
- [ ] AC-C1: measurement bundle 明确 adoption/friction/outcome 三层；CTR/click 只能作 context/diagnostic，不能单独驱动 keep/fix/sunset。
- [ ] AC-C2: 至少一个 outcome 关联使用 cohort/window + task-outcome 或 capability-wakeup canonical ref，并证明不依赖用户内容级逐人画像。
- [ ] AC-C3: domain 首次启用后产生一份可复核 live verdict，包含样本窗口、n/不确定性、版本与 withdrawal condition。
- [ ] AC-C4: stale/source-failure/high-dismiss/low-evidence signal 进入 owner review，不自动删 tip；至少一条 dry-run fixture 回链 F244 source truth。
- [ ] AC-C5: F266 可用时首份 actionable verdict 进入统一 closure；若尚不可用，Program readiness 明标 partial，执行 thread 只报 phase transition/red light。

## Eval / Tracking Contract

- **Primary Users + Activation Signal**: F244 tip owner、F192/F267 eval owner、Program guardian；tip exposure/action/dismiss/failure batch 或 source inventory change 激活。
- **Friction Metric**: upload failure/retry/overflow、schema rejects、duplicate ratio、no-data windows、dismiss/source-open failure、action-without-outcome evidence。
- **Regression Fixtures**: duplicate batch、offline→retry→ack、queue overflow、forbidden content field、empty window、high click/zero outcome、source sunset。
- **Sunset Signal**: 若 Capability Tips surface 被正式替代/删除，停止新 telemetry、保留必要聚合 provenance，并让 domain 进入 delete/sunset；低 CTR 本身不是 sunset 证据。

## ADR-031 三层计划

| 层 | 本 Feature 承重 |
|----|----------------|
| Soft | tip owner 的信号含义/隐私说明、效果≠点击的操作指引 |
| Hard | event/API schema、privacy allowlist、idempotency/retry、durable sink、enable gate、no_data tests |
| Eval | adoption/friction/outcome 分层 verdict、transport health、stale/sunset 与后续 closure |

## Program Operating Contract

- **operator authorization**: tips pipeline 直接拍板 `0001784347935457-000058-4788b357`；三 Feat 开工授权 `0001784376506778-000328-2a877146`；Fable OK `0001784376508012-000331-f2b9dad1`。
- **Execution**: 独立 thread/worktree/PR；F244 保持 done，本 Feature 是 successor。
- **Checkpoint delegation**: Phase checkpoint 委托 Sol/Fable；日常实现/review 不打扰中心。
- **Red-light escalation only**: 采集内容/identity/retention 扩张、改变 F244 UX、跨 Feat contract、外部依赖或不可逆迁移时升级。

## Dependencies

- **Evolved from**: F244（tips projection/event semantics；保持 done）
- **Blocked by**: F267 Phase B measurement certificate（只阻塞 `enabled:true` 与 effectiveness verdict，不阻塞管道实现）
- **Related**: F223（capability truth source）、F192（eval runtime）、F266（verdict closure）

## Risk

| 风险 | 缓解 |
|------|------|
| telemetry 变成内容/行为监控 | 字段 allowlist + forbidden-field tests + cohort aggregate + retention Decision Packet |
| 点击率 Goodhart | click 降为 context；outcome/guardrail/negative control 才能驱动行动 |
| 上传失败拖慢用户主路径 | 非阻塞 batch、bounded queue/backoff、可诊断降级 |
| 为接管道重开 F244、篡改完成历史 | F268 successor，F244 只补 lineage link |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新建 F244 successor，不 reopen F244 | 原交付真实完成；新管道有独立 Why/terminal predicate | 2026-07-18 |
| KD-2 | 可并行造管道，F267 校准前禁止启用 | 区分工程依赖与决策可信度依赖 | 2026-07-18 |
| KD-3 | click 不是 effectiveness | 入口触发不证明理解或任务成功 | 2026-07-18 |
| KD-4 | 不持久化 raw；receipt 14d；UTC 日桶 aggregate 90d；transport 小时桶 14d | 每一层只保留现有 measurement need 所需最小形状 | 2026-07-18 |

## Review Gate

- Design Gate: 先开箱现有 event schema；retention/identity/granularity 属红灯 Decision Packet。
- 每 Phase: owner 自选非作者 reviewer；privacy/API contract 至少一位跨 family reviewer。
- Close: web→API→durable aggregate→adapter→live verdict 全链 replay；`enabled:true` 早于 F267 gate 即 BLOCK。
