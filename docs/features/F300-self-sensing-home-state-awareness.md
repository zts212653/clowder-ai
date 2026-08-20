---
feature_ids: [F300]
related_features: [F233, F293, F167, F220, F153, F276, F296, F298, F299]
topics: [self-sensing, availability, custody, quota, capability, agent-awareness]
doc_kind: spec
created: 2026-08-17
description: "家况可感知：custody/quota/plugin 等 canonical 状态送达猫的判断点——preflight 附带、关键 delta 推送、typed 家况快照"
description_source: human
description_author: fable-5
description_updated_at: 2026-08-18T13:05:00Z
---

# F300: Self-Sensing 首切片 — 家况可感知（Home-State Awareness）

> **Status**: spec | **Owner**: Ragdoll (@fable5, claude-fable-5) | **Priority**: P1

- **operator signoff**: 2026-08-16/17 [thread-id]（`0001786845058052`「新建feat 这个可能要和吴浪提出的sense 结合」+ `0001786950943499` 两 feat 结构确认）
- **Reviewer**: spec 细节由 @codex-sol 补齐；@fable5 已对 exact `c22defbd0` 完成唯一一次最终架构审核并 `APPROVE`
- **Architecture cell**: `routing-context` + `identity-session`
- **Map delta**: none——`routing-context` 继续拥有判断点 preflight projection，`identity-session` 继续通过 F296 拥有 context epoch、presentation mapper/ledger 与 provider receipt；`ball-custody`、F153、limb registry 等只提供 canonical source，`dispatch` 只消费 M1 结论，本 feat 不新建第二条 delivery channel 或业务账本

## Why

operator experience（2026-08-16 `0001786845058052`）："其实这里他是期待你们在运行过程中可感知到家里整个系统的情况，如果你们想感知。**不是黑盒**。" 三个真实例子：① **取消感知**——You 按了取消并说"换一只猫"，但猫感知不到，还去 @ 一只早已被取消的猫；② **猫粮拓扑**——fable 没猫粮时本质是Ragdoll全家共享猫粮桶都没了，猫只能一只只试错归纳；③ **基建可感知**——说"要语音输入"时猫应立刻知道插件状态，"而不是当你调用之后发现这东西挂了"。

共同根因：**canonical 状态存在（或应存在），但从未到达猫的判断点**。不是猫不勤快，是事实没有送达路径。

## Current State / 现状基线

- 取消/审批等 custody 事件已有 canonical 账本（F233 Phase B，append-only + 16 kinds + 状态机，已按 Close Summary 移交本 feat），但**无猫侧消费面**——例①实测发生过（thread 内猫 @ 已取消的猫）。
- 配额拓扑（家族共享猫粮桶）无结构化查询面——例②实测：fable 断粮时靠逐只试错归纳出共享桶事实。
- F293 route snapshot 已组合 quota/provider health，但只在 route 判断点；`limb_list_available` 已列节点能力，readiness 深度不足以回答例③。
- F233 值班简报（同账本的日报消费形态）已 sunset：65 天 operator 零消费——证明"推送到日报"不是正确送达形态，判断点送达是本 feat 要验证的替代。

## What

### Phase A: Aha 纵切——取消例端到端

M2 与 M1 是**互补的两条保证**，不是“主路径 + 兜底”：

- **M2 awareness**：F300 把 canonical cancellation event admission 成 `HomeStateDeltaV1`，交给 F296 按 context epoch 映射、去重、重验证并在 provider 真正接收后写 content-free receipt。等球/空闲猫在下一 invocation 自然看见；正在运行的猫不接受“半句话中途改 prompt”，只在 provider 支持的下一安全 tool/result boundary 呈现，否则留到下一 invocation。
- **M1 authoritative preflight**：每次准备为**同一 obligation/action subject**继续 @/dispatch 之前，按 exact `subjectRef` 重新读取 canonical cancellation projection。它是副作用前置条件，不依赖猫是否记得 M2；M1 与旧 M2 冲突时 M1 获胜，`unknown` 不得被当作“可以继续”。这不是按 catId 建全局黑名单：不继承该 subject 的新工作走自己的正常 admission。

F300 只拥有 delta 的 admission/relevance；F296 拥有送达。**不扩展 F254 freshness notice 的语义 owner，也不另造 runtime-delta channel**。F254 仅作为“安全边界通知”的实现先例。

### Phase B: M1 全量判断点 + M3 家况快照

M1 扩展到 quota/插件/能力判断点（@ 猫时附带 quota 拓扑事实；说到语音时先查 limb/plugin ready）；M3 `HomeStateSnapshot`——typed references 只引用 canonical 源（custody→F233 账本 / execution→F220 / route→F293 / runtime health→F153 / limb→registry），每项带 `observedAt`、`expiresAt`/invalidator 与 source ref，无中心化复制存储。取消/权限类 preflight 必须实时回源；quota/plugin 可用短缓存，但过期后只能成为 `unknown`，不能继续授权动作。

## Delivery Contract

```ts
type HomeStateDeltaV1 = Readonly<{
  subjectKey: string;
  revision: string;
  claimKind: 'custody' | 'route_availability' | 'runtime_health' | 'capability_readiness';
  consumerScope: { threadId: string; catIds: readonly string[] };
  whyNow: 'affects_current_obligation' | 'affects_next_side_effect';
  sourceRefs: readonly string[];
  observedAt: number;
  expiresAt?: number;
  invalidators: readonly { owner: string; ref: string }[];
}>;
```

- F300 producer 必须先完成 exact recipient、why-now、revision、expiry/invalidator 与 source ownership admission；不得把“全家可能有用”当 consumer scope。
- F296 将 admitted delta 映射为 `ContextPresentation`，按 `subjectKey + revision + contextEpoch + presentation` 去重；新 epoch 只允许重验证后重发，不得复活 expired/superseded 状态。
- `presented` 只能由 provider adapter 铸造的 receipt 写入。render/launch/admission 失败都保持“待送达/失败”，不能让 MessageStore 持久化或 UI toast 冒充模型已看见。
- M2 的行为上界是**下一次受影响的副作用之前**：如果 delta 尚未送达，M1 必须重新查证并阻止错误动作；不设一个脱离 provider/carrier 能力的假毫秒 SLA。
- presentation ledger 的跨重启/多实例去重由 F296 B3 共享持久化合同承担；F300 不复制 ledger。principal、wake admission 与 accepted/result witness 的寿命由 F298 #1/#3/#8 保证。

## 三层栈定位（operator 2026-08-17 定调，`0001786971350592`）

> 展示层 F299（You 看猫）· **送达层 F300（本 feat，猫看家）** · 持久层 F298（承诺活得够久）——每层终态，不被谁推翻。

本 feat 是**送达层**：把持久层保证活着的事实送到猫的判断点。M2 可靠性以 F298 家族表为前提：#1 保证 callback principal 不因静默蒸发；#3/#8 保证 durable Queue 的 admission/result obligation 与 wake admission receipt 不会在重启或 invoke 失败时被投影成“已送达”。送达层只消费 canonical lifecycle delta，不持久化旧 `InvocationQueue` 对象，也不新建业务账本。**custody 移交边界**（2026-08-18 rebase）：可观测性与送达归 F300；寿命判据归 F298；dispatch/Queue/History 业务状态机归 clowder-ai #1356。

## User Journey

### Primary Journey: 取消一只猫，全家都知道
- **Scope unit**: thread
- **Actor**: operator + 猫猫（双主角）
- **Entry**: You 在 Hub 按下某猫 invocation 的取消按钮
- **Flow**:
  1. You 按取消并对协作中的猫说"别喊Ragdoll了，换一只" → 系统写 custody 事件
  2. 取消动作原位显示 `已记录 → 等待送达 → 已送达 <猫>`；只有 provider-minted receipt 才能进入“已送达”，失败/未知必须原位说真话并给 source ref
  3. 等球的猫下一轮**自然知道**（F296 context delta + 事件 ref），改口喊别的猫——不再 @ 已取消的猫
  4. 若猫在 delta 送达前仍准备 @ 目标猫，M1 preflight 读取最新 canonical 状态并阻止错误动作；它不是对 M2 的信任
  5. You 日常主要感知到的是“猫变聪明”；需要追责时从取消回执的 source ref 下钻 F299 invocation inspector
- **Success evidence**: alpha 复现原 bug 行为（红）→ 上线后同场景消失（绿）；对照录屏
- **Non-goals**: 不做常驻家况仪表盘；不推送非关键事实（噪音税，见 OQ-4 注入门槛）

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | thread | 猫猫 | 说到"语音输入" → 先查 limb/plugin ready 再回答，不再调用后才发现挂了 | Phase B 实测记录 |
| S2 | thread | 猫猫 | @ Ragdoll前 preflight 附带 quota 拓扑（家族共享桶）→ 一次判断替代逐只试错 | Phase B 实测记录 |

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | You 已取消当前协作 subject 时，协作猫不应为同一 subject 再次尝试唤醒原目标；不能误伤该猫的无关新工作 | AC-A1、AC-A2、AC-A3、AC-A7 | contract test + alpha 红绿录屏 | [ ] |
| R2 | 猫要知道取消事实是否真的到达，不能把“消息已写”冒充“模型已看见” | AC-A4、AC-A5 | provider receipt fixture + restart/multi-instance test | [ ] |
| R3 | You 在取消现场能看见 recorded/pending/presented/failed，而不是去 dashboard 猜 | AC-A6 | UI 状态测试 + operator 截图验收 | [ ] |
| R4 | 共享猫粮桶应一次呈现拓扑事实，不再逐猫试错 | AC-B1 | route preflight fixture + 实测记录 | [ ] |
| R5 | 语音/plugin readiness 在调用前可知；stale/unknown 不冒充可用 | AC-B2 | readiness contract test + degradation fixture | [ ] |
| R6 | 家况快照只引用 canonical owners，不拼第二真相 | AC-B3 | source-owner contract test | [ ] |
| R7 | 送达健康能诊断但不强造 utility eval | AC-B4 | F153 metrics/trace schema + sample trace | [ ] |

### 覆盖检查

- [x] 每个需求点都映射到至少一个 AC
- [x] 每个 AC 都有确定性 test、现场截图/录屏或运行健康 trace
- [x] 用户可见取消回执已有语义状态；视觉皮肤在 Phase A Design Gate 由 operator 确认

## Acceptance Criteria

<!-- AC↔Why 同源：A=例①取消感知端到端 / B=例②③判断点可感知；家规=LL-099 只投影不拼接 -->

### Phase A（Aha 纵切：取消例）
- [ ] AC-A1: cancellation canonical event 被 admission 为 `HomeStateDeltaV1`；exact recipient、revision、why-now、source refs、expiry/invalidators 缺一即拒绝，schema/contract test 守护
- [ ] AC-A2: 等球/空闲猫在下一 invocation 收到 F296 presentation；active invocation 不做 mid-token prompt mutation，只在已证明支持的安全 tool/result boundary 呈现，否则下一 invocation 重验证
- [ ] AC-A3: 为同一 obligation/action subject 继续 @/dispatch 前，M1 按 exact `subjectRef` 重新读取 authoritative cancellation projection；`cancelled` 阻止动作，stale/无法查询返回 typed `unknown` 并 fail closed，M1 与旧 M2 冲突时 M1 获胜；不继承该 subject 的新工作不受旧取消全局污染
- [ ] AC-A4: 同一 `subjectKey + revision + contextEpoch + presentation` 不重复；new epoch 重验证，expired/superseded 不复活；render/launch 失败不提前消费 dedupe
- [ ] AC-A5: `presented` 只接受 provider-minted receipt；F296 共享 ledger 跨重启/多实例保持同 epoch 去重，F298 #1/#3/#8 保证 principal/admission/result 不静默蒸发
- [ ] AC-A6: 取消动作原位呈现 `recorded / pending_delivery / presented / failed_or_unknown` 四态；“已送达”必须绑定 exact cat + receipt，重复事件原位更新不刷 thread 富块
- [ ] AC-A7: Aha 红绿验收——alpha 先复现“猫 @ 已取消的猫”原 bug（红），Phase A 上线后同场景消失（绿），非作者录屏同时覆盖 M2 已送达与 M2 未达但 M1 拦截两条路径

### Phase B（判断点全量 + 家况快照）
- [ ] AC-B1: quota preflight 返回 shared-pool topology、`observedAt/expiresAt` 与 source ref；同池 exhaustion 一次覆盖同 family targets，过期/owner 缺失为 `unknown` 而非逐猫试错
- [ ] AC-B2: plugin/limb preflight 在调用前返回 `ready/degraded/unavailable/unknown` + source ref；UI 是否显示、机器是否安装或 tool 名存在都不能替代 runtime readiness
- [ ] AC-B3: `HomeStateSnapshot` 每项引用 canonical owner + `observedAt` + expiry/invalidator，无中心化复制存储（contract test 守护）
- [ ] AC-B4: F153 记录 admitted→presented latency、pending/failed reason、M1 stale/unknown 命中率与 payload-free source coordinates；这些是运行健康 trace/metrics，不进入 Eval Hub

## Dependencies

- **Evolved from**: F233（Phase B custody 可观测性账本按 Close Summary 移交本 feat 作 canonical 源）
- **Blocked by**: F296 B3（真实 surface 接线、provider-minted receipt、共享 persistent ledger）+ F298 #1/#3/#8（principal 与 admission/result/wake 承诺寿命）；M1 contract 与 producer adapter 可先实现，Phase A 生产验收必须消费两者证据
- **Related**: F299（视野快照在其 Phase D 交汇：猫决策时看到的 snapshot 进 envelope，You 可确诊"供给 gap vs 猫的 bug"）、F293（route preflight 既有机制）、F153（runtime health 源）、F276（人物域 canonical 边界参照）

## Risk

| 风险 | 缓解 |
|------|------|
| M2 推送变成噪音税（猫被无关事实淹没） | OQ-4 注入门槛：只推关键 delta（取消/审批/依赖失效）；M3 是 pull-only |
| 送达层拼接推断冒充事实（重蹈 LL-099） | 家规写死：只投影 canonical 账本；快照每项必须指回 owner；review 检查项 |
| M2 通道与 F296 语义冲突（双 delta 体系） | 已冻结为 F300 producer → F296 presentation；不扩 F254 semantic owner、不另建 channel |
| principal 蒸发或 message-only 假 admission 导致送达承诺静默断裂 | Blocked by F298 #1/#3/#8；生产验收含重启 terminal convergence 与 invoke 失败不写 wake_sent |
| process-local ledger 重启后重复/漏投 | Blocked by F296 B3 shared persistent ledger；F300 禁止复制 presentation receipt store |
| 从 UI 可见性反推能力状态（大象谬误） | longform §五原则入 review 检查：capability runtime state 为准 |

## Design Gate Inputs：现场可感知性

取消反馈的**语义状态**已冻结；视觉皮肤在 Phase A 实现前给 operator 看一次真实宿主稿，不在 spec 阶段凭空造新 dashboard。

```yaml
in_context_observability:
  primary_surface: "原取消动作/对应 invocation 行原位状态：recorded → pending_delivery → presented | failed_or_unknown"
  why_not_dashboard_only: "取消会立刻改变当前协作；如果只在 dashboard 记一次统计，You 和正在决策的猫都无法知道是否已生效"
  deep_dive_surface: "回执 source ref → F299 invocation inspector；跨周期 delivery health → F153"
  noise_dedup_policy: "每个 cancellation subject 只更新一条原位状态；同 revision 不重复；非阻塞家况漂移用 entity/status，不发送独立 thread 富块"
```

## Claim → Mechanism

| Claim | 机制 | 证据 |
|------|------|------|
| exact recipient/revision/expiry、M1 fail-closed、dedupe/receipt/restart 是确定契约 | schema + contract/integration tests + runtime guard | AC-A1–A5、AC-B1–B3 |
| admitted→presented 延迟、pending/failed 与 stale/unknown 是运行健康 | F153 logs/metrics/traces | AC-B4 |
| You 必须在取消现场知道“记录了/送达了/失败了” | UX + Design Gate | AC-A6 + operator 截图验收 |

## Tips Contribution（F244）

- 计划 1 条 tip（Phase A 落地时提交）：「取消了一只猫？等球的猫下一轮自己就知道，不用你复述」→ truth source: F300 delta 推送机制。

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 三机制（M1 preflight / M2 delta 推送 / M3 快照）对应operator三例子，Aha 选取消例 | 需求 canonical 表述直接映射 | 2026-08-17 |
| KD-2 | 家规第一条：sense 只做 canonical 账本的投影和送达，不做第二真相、不拼接推断 | LL-099 继承；F233 值班简报 sunset 证明消费形态错误而非账本错误 | 2026-08-17 |
| KD-3 | 不做 longform 完整闭环（能力构建+交互适配+Dynamic UI），只做家况可感知首切片 | 验证送达机制后再谈 grounded proposal；防超级系统 | 2026-08-17 |
| KD-4 | 三层边界：F300 消费并送达 canonical delta；F298 守 principal/receipt 寿命；#1356 拥有 dispatch/Queue/History 业务状态机 | 防送达层持久化旧 Queue 投影或发明第二业务真相 | 2026-08-18 |
| KD-5 | F300 是 state producer/admission owner，F296 是 epoch-aware presentation/delivery owner | 复用既有统一 mapper/ledger，避免第二 delta channel | 2026-08-18 |
| KD-6 | M2 awareness 与 M1 authoritative preflight 互补；冲突时 M1 胜 | 模型已看见不等于事实仍新鲜，副作用前必须回源 | 2026-08-18 |
| KD-7 | active invocation 不做 mid-token prompt mutation | provider/carrier 能力不同；安全 tool/result boundary 未被证明时留到下一 invocation，并由 M1 保底 | 2026-08-18 |
| KD-8 | 取消现场只在 provider receipt 后显示“已送达” | message persisted / toast / queue admission 都不是 model-visible truth | 2026-08-18 |

## Review Gate

- spec architecture: ✅ @fable5 已对 exact `c22defbd0` 最终审核 `APPROVE`；剩余 gate 仅为取消现场视觉皮肤在真实 Hub 宿主稿上由 operator 确认
- Phase A: 实现走 F128 执行 thread，标准跨个体 review + merge-gate；Aha 红绿验收非作者执行；生产验收必须消费 F296 B3 与 F298 #1/#3/#8 证据
