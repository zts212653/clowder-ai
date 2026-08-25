---
feature_ids: [F300]
related_features: [F153, F220, F223, F233, F293, F296, F298, F299]
topics: [self-sensing, self-management, capability, availability, user-friction, interaction-adaptation, plugin-management, feedback-loop]
doc_kind: spec
created: 2026-08-17
description: "Self-Sensing / Self-Management 总体架构：Agent 如何基于能力、可用性与协作摩擦形成有依据的自我认知，并在用户授权下完成能力构建、交互适配与反馈闭环"
description_source: human
description_author: lang
description_updated_at: 2026-08-25T02:34:00Z
---

# F300: Self-Sensing / Self-Management — Agent 自感知、自管理与交互共建

> **Status**: spec（总体架构已刷新；运行时实现尚未开始） | **Owner**: Ragdoll (@fable5, claude-fable-5) | **Priority**: P1
>
> **Baseline**: `origin/main@dd86a802`（2026-08-25） | **本次变更**: 只刷新概念、边界、现状与分阶段路线，不实现运行时代码

- **operator signoff**: 2026-08-16/17 确认“运行过程中可感知家里整个系统，不是黑盒”；2026-08-25 确认 F300 应描述 Self-Sensing / Self-Management 全貌，按阶段实现，并澄清与插件管理的重合
- **Canonical product narrative**: 本文的[总体概念](#1-总体概念)、[系统边界](#3-系统边界f300插件管理与-dynamic-interaction-各管什么)与[分阶段路线](#5-分阶段实现路线)
- **Publishing provenance（非规范源）**: 本次刷新逐段核对外部 publishing archive `longform-008-self-sensing-agent-interaction-v3.md` 与 `assets/dynamic-ui/agent-proposal-loop.svg`（archive commit `ffc81c4b8b10abb6059eb3572d7ffb3f99f46c17`）。该 archive 没有可解析 remote URL，因此不再把本机文件名冒充链接；仓内可访问、可审阅的规范叙事以本文及 ownership cell 为准

## Architecture Ownership & Delta Evidence

Architecture cell: `self-sensing-management`（相邻：`plugin`、`hub-action-surface`、`routing-context`、`identity-session`）

Map delta: new cell required → 新增 [`self-sensing-management`](../architecture/ownership/cells/self-sensing-management.md)，并更新 [`plugin`](../architecture/ownership/cells/plugin.md) 的 F300 shared touchpoint

Why: F300 现在拥有 friction-to-proposal policy、capability-state interpretation 与 Interaction Episode 阶段语义；plugin lifecycle/runtime、route、delivery、authority execution 和 surface rendering 仍由相邻 owner 持有。

Canonical source: [`self-sensing-management#canonical-owner`](../architecture/ownership/cells/self-sensing-management.md#canonical-owner)；[`plugin#canonical-owner`](../architecture/ownership/cells/plugin.md#canonical-owner)；本文[四层责任模型](#31-四层责任模型)

Consumer evidence: `rg -n 'HomeStateDeltaV1|HomeStateSnapshot|InteractionEpisode|affects_current_obligation|affects_next_side_effect' packages -g '*.{ts,tsx,mjs}'` 在 `origin/main@dd86a802` 无匹配，因此当前没有可列举的 runtime consumer；未来 consumers 只存在于本文 Phase 1–5 的未勾 AC，代码 callsite scan 在实现落地前无法表达它们。

Claim guard: “Phase 0 只有架构真相、runtime 尚未实现，且 ownership map 与 feature registration 同步” → `! rg -n 'HomeStateDeltaV1|HomeStateSnapshot|InteractionEpisode|affects_current_obligation|affects_next_side_effect' packages -g '*.{ts,tsx,mjs}'` + `node docs/architecture/ownership/generate-readme.mjs && git diff --exit-code docs/architecture/ownership/README.md` + `node scripts/check-feature-truth.mjs`；出现 runtime symbol 却未更新本节、生成 map 变脏或 feature truth 失配即 red。

## 一句话定义

**Self-Sensing** 是 Agent 对“我能做什么、此刻是否真的能做、当前协作哪里产生了摩擦”的有依据认知；**Self-Management** 是把这份认知转化为可解释提案、用户决定、受权执行、交互适配与结果反馈的治理闭环。

它不是 Agent 自己给自己扩权，也不是一个更大的插件管理器。

## Why：我们真正要解决的不是“多知道几个状态”

目前系统中的事实、能力和界面分散在多个层面：custody 账本知道取消，route snapshot 知道路由与额度，plugin runtime 知道安装和健康，limb registry 知道节点暴露的能力，用户则在对话中表达真实阻力。但 Agent 往往只能在动作失败以后才拼出局部真相。

已发生的三个例子揭示了同一问题：

1. **取消感知**：用户已经取消并要求换猫，协作猫仍可能继续唤醒被取消的目标。
2. **猫粮拓扑**：某一只 Ragdoll 无额度时，Agent 需要逐只试错后才猜到共享额度池已经耗尽。
3. **能力可用性**：用户提出“语音输入”时，Agent 可能在真正调用以后才发现插件或运行节点不可用。

“把更多状态塞进 prompt”只能修补这些例子。F300 的终态问题是：

> Agent 如何在恰当判断点获得可信、足够新鲜的自我与环境事实，识别真实协作摩擦，在不越过用户权限的前提下管理自身能力与交互，并从实际使用结果继续学习？

## 1. 总体概念

### 1.1 Self-Sensing：三类感知，不是无界监控

| 感知维度 | 回答的问题 | 事实来源 | 不允许的替代物 |
|----------|------------|----------|----------------|
| **Self-Capability Management** | 我具备哪些能力？边界、输入输出、风险、提供者是什么？ | capability contract、F223 surface registry、builtin/plugin/tool provider manifest | “界面上有按钮”“工具名存在” |
| **Self-Availability Management** | 这项能力此刻是否已安装、配置、授权、可达、健康？ | plugin lifecycle/runtime、Host Broker、limb readiness、route/quota、runtime health | 安装成功、manifest 声明或旧缓存单独充当 ready |
| **User-Friction Sense** | 用户此刻在哪个任务、动作或交互上遇到了可观察阻力？ | 当前对话、失败/重试/取消、显式反馈、受范围约束的 interaction evidence | 持续监视、人格画像、跨场景臆测意图 |

三类感知必须保持证据来源、观察时间、新鲜度和不确定性。`unknown`、`stale`、`conflicted` 都是一等状态；系统不能为了“显得聪明”把缺失事实补成确定结论。

Self-Sensing 也不是把全家的全部状态广播给每只猫。它只在当前 obligation、下一次副作用或用户明确查看时，投影与该判断相关的最小事实。

### 1.2 Self-Management：受治理的控制回路

Self-Management 同时产生两个彼此耦合的结果：

- **能力构建与管理**：发现、匹配、组合、安装或启用、配置、授权、验证、停用与恢复能力。
- **交互适配**：决定应该怎样解释、呈现、调用和管理这项能力；必要时改变 Dynamic UI、CLI、语音或其他 surface。

完整回路为：

```text
FRICTION
  → SENSE
  → MATCH
  → PROPOSE
  → USER DECISION
  → ACTIVATE / CONFIGURE
  → INTERACTION ADAPTATION
  → IMMEDIATE USE
  → FEEDBACK
  → RETAIN / EDIT / DISMISS / REVERT
```

其中：

- Agent 可以感知、匹配、解释和提出建议，但**不能把推断当成用户授权**。
- 安装、授权、外部副作用及高风险配置仍由各 authority owner 执行，并返回可验证 receipt。
- “能力可用了”不是闭环终点；第一次成功动作以及后续摩擦是否降低，才决定这项变化是保留、调整还是回滚。
- 用户始终拥有拒绝、编辑、撤回授权和恢复原状的权利。

### 1.3 Interaction Episode：最小可追责单元

F300 不以“发出一条建议”作为成功。一个可追责 episode 至少包含：

```text
friction-evidence
  → hypothesis
  → capability-match
  → proposal
  → user-decision
  → capability-and-interaction-ready
  → first-successful-action
  → friction-feedback
  → retained | edited | dismissed | reverted
```

每个阶段都必须能指回证据、authority decision 或执行 receipt。没有用户决定，episode 不得越过 `proposal`；没有成功动作，不能把 `activated` 记成效果成立。

## 2. 能力状态：不能压成一个 `enabled` 布尔值

目标状态模型必须把下列维度分开：

| 维度 | 示例问题 |
|------|----------|
| Identity | 这是哪一种稳定能力？即使 provider 从 builtin 迁到 plugin，它是否仍是同一用户能力？ |
| Provider | 当前由 builtin、plugin、generated、local limb、remote connector 或组合提供？ |
| Provisioning | provider 是否存在、已安装或可取得？ |
| Configuration | 必填配置是否完整、版本是否兼容？ |
| Authority | 用户是否授权了当前 scope、数据与副作用？授权是否仍有效？ |
| Runtime readiness | 依赖是否可达、健康、未熔断且满足资源/额度约束？ |
| Context applicability | 这项能力是否适用于当前任务、主体和时刻？ |
| Effectiveness | 是否发生过成功动作？真实使用后摩擦降低了吗？ |

因此 `installed ≠ configured ≠ authorized ≠ ready ≠ applicable ≠ effective`。Dynamic UI 可见、插件 manifest 声明、tool 被注册，也都不能单独证明能力此刻可用。

## 3. 系统边界：F300、插件管理与 Dynamic Interaction 各管什么

### 3.1 四层责任模型

| 层 | 真相与职责 | 典型 owner | F300 如何使用 |
|----|------------|------------|----------------|
| **L1 能力与运行事实** | 能力 identity/contract；插件发现、安装、启停、升级、配置、授权、Host Broker、runtime health、审计与恢复 | plugin cell、Capability Surface Registry、limb/runtime owners | 只消费 canonical fact/command/receipt，不复制账本 |
| **L2 感知与判断点接入** | 聚合与当前判断相关的 capability/availability/friction evidence；校验 freshness、scope、relevance | F300 + routing-context；F296 承担 presentation/delivery | 形成 grounded sensing view；不从 UI 或旧消息反推事实 |
| **L3 自管理协调器** | match、proposal、authority envelope、用户决定、调用 owner command、核对 receipt、episode 状态与反馈 | F300 | 拥有闭环政策与阶段转换，不取得底层系统的越权写权限 |
| **L4 交互投影** | 根据 episode 与能力状态生成/调整对话、Dynamic UI、CLI、voice 等 surface | Dynamic Interaction / surface owners | 呈现解释、决定与可用动作；不是能力或授权真相源 |

### 3.2 与插件管理的重合边界

插件管理是 Self-Management 的一个关键执行域，但两者不等价：

| 问题 | Plugin Manager / plugin cell | F300 Self-Sensing / Self-Management |
|------|------------------------------|------------------------------------|
| 哪些插件可发现、已安装、启用、需升级？ | **拥有 canonical lifecycle truth** | 读取并解释与当前 episode 有关的事实 |
| 配置、权限、Host Broker、runtime 是否健康？ | **拥有状态、命令、审计与 receipt** | 在动作前校验；`unknown/stale` 不得冒充 ready |
| 什么时候值得建议新增或调整能力？ | 提供候选与约束，不决定用户当前需要 | **基于 friction + capability match 形成 proposal** |
| 谁能安装、启用、授权或回滚插件？ | **在用户授权和系统策略内执行** | 发出带 authority envelope 的 intent；不得直接绕过 owner 改状态 |
| 安装后如何与用户交互？ | 提供 UI contribution/contract 候选 | **结合当前 episode 选择 Dynamic UI/CLI/voice 投影** |
| 实际效果是否值得保留？ | 提供运行与审计证据 | **关联 first successful action 与 friction feedback** |

硬边界：

1. F300 不建设第二个插件目录、安装器、授权中心或 runtime supervisor。
2. Plugin Manager 不根据 plugin catalog 的存在擅自推断用户需求，也不自行定义完整 Interaction Episode。
3. F300 的状态转换必须消费 Plugin Manager 的 canonical receipt；proposal 卡片、toast 或消息写入都不能冒充执行成功。
4. 能力 identity 高于 provider identity。用户配置和交互偏好应绑定稳定能力身份，而非永久绑死某个实现插件；迁移是否安全由显式 contract 与验证决定。

### 3.3 Dynamic UI 的位置

Dynamic UI 是 Self-Sensing / Self-Management 的一种可视化实现，不是概念总和，也不是先决条件。

- 没有 Dynamic UI，episode 仍可通过对话、CLI 或语音完成。
- 有 Dynamic UI，也不能仅凭组件出现就宣称能力 ready 或已授权。
- UI 应投影同一份 capability、authority、receipt 与 episode truth，而不是建立平行状态机。
- 合适的界面不是事先固定模板，也不是模型随意画布；它由当前任务、可用能力、权限与 surface contract 共同约束。

## 4. 最新 `main` 的真实状态

以下是对 `origin/main@dd86a802` 的代码与 feature truth 审计。它描述“已经存在什么”，不把相邻能力包装成 F300 已实现。

| 能力块 | 当前状态 | 已有证据 | 距离 F300 终态的缺口 |
|--------|----------|----------|----------------------|
| Promise durability | **已完成基础** | F298 done；principal、admission/result、wake 等承诺具备持久化边界 | 只保证承诺活着，不产生 self-sensing 或 episode policy |
| Context presentation/delivery | **部分落地** | F296 Phase A/B foundations、B3/B4 多项已落地，仍有 AC 未完成 | 可承担相关事实送达，但 F300 producer、relevance 与 home-state contract 尚不存在 |
| Invocation trajectory/evidence | **in-progress，A–D 已有明确交付** | F299 Phase A/B/B.1/B.2/C/D 的 AC 已勾，Phase E `AC-E1` 未勾；request-generation envelope 已有 `home_state` source kind | 当前 `home_state` 仅标注 profile/thread-mission 证据来源，不是 F300 HomeStateSnapshot 或感知闭环 |
| Plugin management runtime | **已有实质基础并持续演进** | plugin domain 已有 host inventory/broker、official catalog/installer、auth/history/signals、external runtime；Web 有插件设置面 | 尚未形成跨 builtin/plugin/generated provider 的统一 capability state，也没有由 friction 驱动的 F300 controller |
| Capability surface registry | **已完成 registry 基础** | F223 提供 trigger/execution/verification/eval registry | 它描述能力入口和验证面，不等于完整 capability ontology/readiness graph |
| Route/custody/execution/runtime facts | **分散存在** | F233 custody ledger、F293 route/preflight、F220 execution/liveness、F153 runtime health 等各有 owner | 仍缺面向当前 obligation 的统一、typed、freshness-aware sensing view |
| F300 Home-State Awareness | **未实现** | 代码中不存在 `HomeStateDeltaV1`、`HomeStateSnapshot`、`affects_current_obligation` 或 `affects_next_side_effect` | 原 Phase A/B 的 producer、preflight、snapshot、receipt UI 与红绿验收均未开始 |
| Self-Management episode | **未实现** | 无 friction→proposal→decision→activation→interaction adaptation→feedback controller | 这是后续阶段主体，不能由插件页或单次 tool call 代替 |

结论：你对当前差距的理解是对的。最新代码已经有若干必要底座，尤其是插件运行、持久化、上下文送达和轨迹证据；但完整 Self-Sensing / Self-Management 仍处于**架构定义期**。现有能力之间还没有被一个可信、受权、可反馈的 episode 串起来。

## 5. 分阶段实现路线

阶段表达依赖与可验收纵切，不要求所有工作严格串行。Plugin Manager 与 capability contract 可以独立演进；任何阶段进入生产闭环前，都必须满足其列出的 truth/authority gate。

### Phase 0 — 总体概念与现状真相源（本次文档）

- 冻结 Self-Sensing、Self-Management、Interaction Episode 和能力多维状态的语义。
- 明确 F300 与 Plugin Manager、F296、F299、Dynamic Interaction 的所有权边界。
- 记录 latest-main 已有底座与真实缺口。
- 保留 Home-State Awareness 为首个实现纵切，而非把它冒充完整愿景。

### Phase 1 — Home-State Awareness：先让错误动作在发生前停下

延续原 F300 的三个机制，首个 Aha 仍为“取消后不再唤醒同一 subject 的原目标”：

- **M1 authoritative preflight**：在同一 obligation 的 @/dispatch 等副作用前，按 exact `subjectRef` 回源；冲突时最新 authoritative state 获胜，`unknown` fail closed。
- **M2 relevant canonical delta**：F300 负责 admission/relevance，F296 负责 context epoch、presentation、dedupe 与 provider-minted receipt；不新建第二 delivery channel。
- **M3 typed HomeStateSnapshot**：只引用 custody、execution/liveness、route、runtime、plugin/limb 等 canonical owner，携带 `observedAt`、expiry/invalidator 和 source ref，不复制中心账本。

后续扩到额度拓扑与 plugin/limb readiness，验证“调用前可知”，而不是失败后归纳。

Phase 1 的 provisional delivery contract 保留如下，实施设计时可在不破坏上述语义的前提下细化：

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

### Phase 2 — Capability Graph：统一“能力是什么”与“现在能否用”

- 以稳定 capability identity 关联 builtin、plugin、generated、local/remote tool 与可组合 provider。
- 把 contract、provider、provisioning、configuration、authority、readiness、applicability、effectiveness 分轴建模。
- Plugin Manager 保持 lifecycle/runtime canonical owner；F223 registry 继续拥有 capability surface/verification 描述。
- 为 F300 提供 typed query，不用枚举 UI、猜 tool 名或扫描 prompt。
- 对 provider 迁移、降级、冲突与 `unknown` 建立明确规则。

### Phase 3 — Grounded Proposal：从摩擦到可拒绝提案

- 只从有 provenance 的 interaction evidence 形成 friction hypothesis。
- 将摩擦与 capability graph 匹配，显式展示“为什么现在建议、需要什么权限、会改变什么、如何撤回”。
- 生成 authority envelope；没有用户决定不得进入 activation。
- proposal 支持 accept / edit / dismiss，并记录选择而非把沉默当同意。
- 对反复误报、噪音与错误归因建立 episode-level evaluation。

### Phase 4 — Capability Activation + Interaction Adaptation

- 把已批准 intent 交给 Plugin Manager、Host Broker 或对应 capability owner 执行。
- 以 canonical receipt 进入 installed/configured/authorized/ready 状态，失败可解释、可恢复。
- 同一 episode 内生成或调整合适的 Dynamic UI、CLI、voice surface，并立即尝试首个真实动作。
- surface 只投影 owner truth；安装完成、组件渲染和工具注册均不能冒充 first successful action。

### Phase 5 — Feedback-Governed Self-Management

- 关联真实动作结果与后续 friction evidence，决定 retained / edited / dismissed / reverted。
- 保存用户可见、可追责、可恢复的 episode 历史，不保存无界用户画像。
- 支持权限撤回、provider 迁移、能力降级和交互恢复。
- 在多场景、多 surface、跨重启条件下验证闭环是否确实降低摩擦，而非只提高提案数量。

## User Journey

### Phase 1 首纵切：Home-State Awareness

### Primary: 取消一只猫，全家在相关判断点知道

- **Scope unit**: thread + exact obligation/action subject
- **Actors**: 用户、当前协作 Agent、被取消 invocation 的 custody owner
- **Entry**: 用户在 Hub 取消 invocation，并要求当前协作换目标
- **Flow**:

1. 用户取消某 invocation，并要求当前协作改换目标；custody owner 写 canonical event。
2. 原动作位置呈现 `recorded → pending_delivery → presented | failed_or_unknown`；只有 provider receipt 能表示目标 Agent 看见。
3. 等球或新 invocation 通过 F296 收到相关 delta，不再尝试同一 subject 的旧目标。
4. 若 delta 尚未送达，Agent 在真正 @/dispatch 前执行 M1 preflight，最新取消状态阻止副作用。
5. 新 subject 不继承旧取消；需要追责时从 source ref 下钻 F299 invocation trajectory。

### Supporting

| 场景 | 期望 |
|------|------|
| 共享额度池耗尽 | 一次返回 pool topology 与 freshness，避免对同 family 逐只试错 |
| 用户提出语音输入 | 调用前返回 capability/plugin/limb readiness；stale/unknown 不冒充可用 |

## 7. Acceptance Criteria

### Phase 0 — Architecture truth

- [x] AC-0.1: 文档区分 Self-Sensing 三类感知、Self-Management 两类结果及完整 Interaction Episode
- [x] AC-0.2: 文档明确 capability 多维状态，禁止用 installed/UI-visible/tool-registered 单点替代 ready/effective
- [x] AC-0.3: `self-sensing-management` ownership cell 与 plugin shared touchpoint 已登记，文档给出 F300、Plugin Manager、F296/F299 与 Dynamic Interaction 的 owner 边界
- [x] AC-0.4: 文档基于 exact latest-main SHA 标注已有底座、部分能力和未实现缺口
- [x] AC-0.5: 原 Home-State M1/M2/M3 被保留为 Phase 1，而非继续代表完整 F300
- [x] AC-0.6: 非作者完成内容审阅，确认没有把愿景写成已实现、没有制造第二能力/plugin truth

### Phase 1 — Home-State Awareness

- [ ] AC-1.1: cancellation event 只有在 exact recipient、subject/revision、why-now、source refs、freshness/invalidators 完整时才能 admission 为 typed delta
- [ ] AC-1.2: F296 在安全 invocation/tool-result boundary 呈现 delta；不做未经 provider 证明的 mid-token prompt mutation
- [ ] AC-1.3: 同一 obligation/action subject 的 @/dispatch 前按 exact `subjectRef` 回源；cancelled 阻止动作，stale/unavailable 返回 typed `unknown` 并 fail closed
- [ ] AC-1.4: 同一 `subjectKey + revision + contextEpoch + presentation` 不重复；expired/superseded 不在新 epoch 复活
- [ ] AC-1.5: `presented` 只由 provider-minted receipt 铸造；message persisted、toast 或 queue admission 不冒充 model-visible
- [ ] AC-1.6: 取消动作原位呈现 recorded/pending/presented/failed-or-unknown，绑定 exact cat、receipt 与 source ref
- [ ] AC-1.7: 非作者完成红绿验收，同时覆盖 M2 已送达与 M2 未达但 M1 拦截；无关新 subject 不被旧取消污染
- [ ] AC-1.8: quota preflight 返回 shared-pool topology 与 freshness；plugin/limb preflight 在调用前返回 typed readiness，过期均为 `unknown`
- [ ] AC-1.9: `HomeStateSnapshot` 每项引用 canonical owner，无中心化复制存储；F153 可诊断 delivery latency/failure 与 stale/unknown 命中

### Phase 2 — Capability Graph

- [ ] AC-2.1: builtin/plugin/generated/local/remote provider 通过稳定 capability identity 查询，provider 更换不会静默丢失用户配置或权限边界
- [ ] AC-2.2: provisioning/configuration/authority/readiness/applicability/effectiveness 可分别表达，并带 source/freshness
- [ ] AC-2.3: Plugin Manager、F223 registry 与 F300 对每个字段只有一个 canonical owner，contract test 阻止第二真相

### Phase 3 — Grounded Proposal

- [ ] AC-3.1: 每条 proposal 指回 friction evidence、capability match、预期改变、所需权限、风险与撤回路径
- [ ] AC-3.2: accept/edit/dismiss 为显式用户决定；沉默、打开卡片或重复使用不能被解释成授权
- [ ] AC-3.3: 未获 authority envelope 的 episode 无法产生 install/configure/permission/external-side-effect command

### Phase 4 — Activation + Interaction Adaptation

- [ ] AC-4.1: lifecycle/permission/runtime 变更只经 canonical owner command 执行，并以 owner receipt 推进 episode
- [ ] AC-4.2: Dynamic UI/CLI/voice 投影同一 episode/capability truth，不建立 surface-local 平行状态机
- [ ] AC-4.3: episode 只有在首个真实动作成功后进入 `first-successful-action`，安装或渲染成功不足以通过

### Phase 5 — Feedback loop

- [ ] AC-5.1: 后续 friction evidence 可使 episode 进入 retained/edited/dismissed/reverted，并保留可见因果链
- [ ] AC-5.2: 用户可撤回授权、回滚交互与替换 provider；恢复流程经 canonical owner 验证
- [ ] AC-5.3: 评价以任务成功、摩擦变化、误报与可恢复性为核心，不以提案数、插件安装数或 UI 生成数作为代理成功

## 8. 非目标与安全边界

- 本次刷新**不实现代码**，也不承诺某一后续 phase 的排期。
- 不新建第二个 Plugin Manager、capability registry、permission store、delivery channel 或 episode 外业务账本。
- 不允许 Agent 静默安装、启用、授权、扩大 scope 或产生外部副作用。
- 不做无界后台扫描、持续用户监控、人格画像或跨场景隐式意图推断。
- 不以 Dynamic UI 为起点倒推能力；先有 grounded truth 与 authority，再选择 surface。
- 不把“系统知道”写成“模型已经看见”，不把“模型看见”写成“事实仍然新鲜”。
- 不一次建设超级系统；每个 phase 都必须有独立纵切、失败语义、回滚路径与现场证据。

## 9. 依赖与所有权地图

| 依赖 | 为 F300 提供 | 不由 F300 接管 |
|------|-------------|----------------|
| F223 | capability surface trigger/execution/verification/eval registry | registry owner 与验证契约 |
| F233 | custody canonical ledger 与 cancellation source | custody 状态机 |
| F220 | invocation execution/liveness 与协作恢复事实 | execution lifecycle、liveness 收敛与恢复动作 |
| F293 | route snapshot/preflight 与 routing fact | route decision owner |
| F296 | context presentation、epoch、dedupe、provider receipt | delivery ledger 与 presentation semantics |
| F298 | principal/admission/result/wake 的持久承诺 | durability infrastructure |
| F299 | request-generation evidence、trajectory 与诊断下钻 | invocation history/trajectory truth |
| Plugin cell + plugin repository | discovery/install/config/auth/runtime/audit contract 与事实 | plugin lifecycle、Host Broker、插件 SDK/实现 |
| Dynamic Interaction | episode 的 UI/CLI/voice 投影与交互验证 | capability、authority 或 runtime truth |

Phase 1 生产验收依赖 F296/F298 对 delivery/receipt/durability 的真实证据；Phase 2 可以与 Plugin Manager 演进并行，但不得在 canonical owner 未冻结时先造 F300 shadow state。

## 10. 风险与防线

| 风险 | 防线 |
|------|------|
| 感知变成 prompt 噪音或全家广播 | exact subject/recipient/why-now；只在当前 obligation、下一副作用或显式查看时投影 |
| 把局部线索拼成确定事实 | provenance + freshness + typed unknown/stale/conflicted；副作用前 authoritative preflight |
| 与插件管理重复建设 | Plugin Manager 拥有 lifecycle/runtime command 与 receipt；F300 只协调 episode |
| “安装了”被误报成“解决了” | capability 多轴状态；first successful action + friction feedback 才能证明效果 |
| Agent 借自管理扩大权限 | explicit user decision + authority envelope + canonical owner execution + rollback |
| Dynamic UI 形成第二状态机 | 所有 surface 只投影同一 capability/episode truth；receipt 只能由执行 owner 铸造 |
| 过度平台化导致迟迟没有真实价值 | Phase 1 从已发生的取消 bug 做红绿纵切；后续每 phase 都绑定一条完整用户旅程 |

## 11. Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Self-Sensing 固定为 capability、availability、friction 三维；Self-Management 固定为能力管理 + 交互适配的受权闭环 | 维持原始产品概念，不让“家况送达”缩窄总愿景；本文成为仓内可解析的 canonical narrative | 2026-08-25 |
| KD-2 | F300 成为 Self-Sensing / Self-Management 总体 feature truth；Home-State Awareness 降为 Phase 1 首纵切 | 文档先描述终态，实现可以分阶段，不再用首切片冒充全貌 | 2026-08-25 |
| KD-3 | 2026-08-17 的“F300 不做完整闭环”只保留为当时的实现范围判断，在总体文档层面被本决策取代 | 控制实现范围仍正确，但不应继续截断 feature 的概念边界 | 2026-08-25 |
| KD-4 | Plugin Manager 拥有 lifecycle/runtime/authority execution truth；F300 拥有 friction-to-episode policy，二者以 command/receipt 相接 | 避免两个管理器和两个真相源，同时允许插件系统独立演进 | 2026-08-25 |
| KD-5 | Dynamic UI 是交互投影，不是 Self-Sensing 本身，也不证明能力 ready/effective | 防止从可见界面反推不可见能力与授权状态 | 2026-08-25 |
| KD-6 | `unknown/stale/conflicted` 是一等状态；高风险或下一副作用前不能乐观降级 | 自感知的可信度比“总能给答案”更重要 | 2026-08-25 |
| KD-7 | 成功单位是完整 Interaction Episode，不是 proposal、install、tool call 或 surface 数量 | 只有真实使用与反馈才能证明自管理降低了摩擦 | 2026-08-25 |
| KD-8 | execution/liveness 继续作为 Phase 1 HomeStateSnapshot 输入；F220 保持 lifecycle/recovery owner，F300 只做相关判断点投影 | 防止总体刷新时遗漏“当前动作是否仍在执行”，同时不把 F220 状态机搬进 F300 | 2026-08-25 |

## 12. Review / Delivery Gate

- 本次 docs-only 变更：`co-creation-docs` 分类 + frontmatter/feature-truth 校验 + 非作者内容审阅。
- Phase 0 内容审阅重点：概念是否完整、现状是否诚实、plugin ownership 是否清晰、阶段是否没有偷带实现承诺。
- 后续任何实现必须另立执行 thread，在同一 feature worktree 内做红绿测试、跨个体 review 与 merge gate。
- Dynamic UI 视觉实现进入 Phase 4 前，需要在真实宿主中做 interaction/design gate；本 spec 不凭空冻结视觉皮肤。
