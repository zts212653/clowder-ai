---
feature_ids: [F300]
related_features: [F153, F220, F223, F233, F293, F296, F298, F299]
topics: [self-sensing, self-management, member-state, team-state, environment-state, capability, availability, user-friction, capability-construction, interaction-adaptation, plugin-management, feedback-loop]
doc_kind: spec
created: 2026-08-17
description: "成长型 Agent 如何认识自己与团队环境，从真实协作摩擦形成可拒绝改善方案，并在权限边界内完成能力构建、交互适配与反馈闭环"
description_source: human
description_author: lang
description_updated_at: 2026-08-26T04:03:00Z
---

# F300: Agent Self-Sensing & Self-Management — 从自我与团队认知到能力构建和交互共建

> **Status**: spec（概念重新校准；运行时实现尚未开始） | **Owner**: Ragdoll (@fable5, claude-fable-5) | **Priority**: P1
>
> **Baseline**: `origin/main@dd86a802`（2026-08-25） | **本次变更**: 只刷新概念、边界、现状与分阶段路线，不实现运行时代码

- **operator direction（`0001787628299553-000287-d2731687`）**: 成熟 Agent 应自行感知能做什么、不能做什么、当前运行到哪里与出了什么问题；用户不应承担能力发现、状态追问和日常运维。F300 尚无对应 runtime 实现，因此总体合同可以重写，原 Home-State 内容只保留为一个实现切片。
- **operator correction（`0001787630815635-000364-84224743`）**: F300 最关心的是 Agent 自身能力与状态边界的统一抽象；Plugin 只覆盖插件式 provider，memory、context、thread、成员运行等大量能力并不是插件。Self-Sensing / Self-Management 必须同时包含成员自己的私有认知，以及所有成员可用的团队共享认知，让成长型协作伙伴知道自己具有什么、做过什么、能做什么，也知道团队环境里有什么可用。
- **operator product direction（`0001787716986266-000439-d91c1b16`）**: F300 后续要承载这块能力的具体产品目标与设计；概念已经明确，不能只留下架构摘要。实现可以等待 Plugin 整改完成后启动，但文档现在必须写清完整体验闭环、首个产品纵切与启动门槛。
- **design reference**: PR [#1356](https://github.com/zts212653/clowder-ai/pull/1356) exact HEAD [`5ebc9058a`](https://github.com/zts212653/clowder-ai/blob/5ebc9058a83ab0293716c26feed30cb561e669f0/docs/architecture/message-delivery-handling-handoff-audit.md) 提供 Stop Agent、exact Agent Client、terminal、Active Run 与公开投影的 owner 边界。它仍是 open RFC，且明确有三项产品语义等待 maintainer/product decision；F300 不把它冒充 `main` 已实现事实，只复用“动作、canonical terminal、共享投影必须分层”的设计原则。
- **Canonical product narrative**: 本文的[产品目标与完整闭环](#产品目标能力增长但用户心智负担不增长)、[两种可见性平面](#1-两种可见性平面成员自己的与团队共享的)、[统一状态模型](#2-统一的-member--environment-state-model)、[产品设计合同](#产品设计合同能力怎样进入用户的工作方式)与[分阶段路线](#6-分阶段实现路线)

## Architecture Ownership & Delta Evidence

Architecture cell: `self-sensing-management`（相邻：`plugin`、`routing-context`、`identity-session`、`dispatch`、`message-history`）

Map delta: 更新 [`self-sensing-management`](../architecture/ownership/cells/self-sensing-management.md) 的 canonical contract，并保持 [`plugin`](../architecture/ownership/cells/plugin.md) 仅为 provider/lifecycle owner。

Why: F300 拥有 provider-neutral 的 Member/Environment State Model、私有与团队共享投影语义、evidence-bounded friction hypothesis，以及从 grounded state 到 authority-bounded management、能力构建、交互适配和反馈校准的协调政策；每个原始事实和动作仍由原 canonical domain 持有。

Consumer evidence: `rg -n 'MemberSelfView|MemberPublicProjection|TeamSharedView|EnvironmentStateView|SelfStateProjection|HomeStateDeltaV1|affects_current_obligation|affects_next_side_effect|InteractionEpisode|FrictionHypothesis|GroundedProposal' packages -g '*.{ts,tsx,mjs}'` 在 `origin/main@dd86a802` 无匹配，因此当前没有 F300 runtime consumer；完整守望集与 architecture cell 的 `static_scan_hints` 对齐。

Claim guard: “F300 只有架构真相、runtime 尚未实现，且没有复制相邻 owner 状态” → runtime symbol absence + ownership generator clean + feature truth check；出现 symbol 却未登记 owner/callsite，或出现跨 plugin/memory/context/thread/runtime 的中心影子账本即 red。

## 一句话定义

**Self-Sensing** 是 Agent 对“我是谁、我有什么、我在做什么、我做过什么、我能做与不能做什么”“团队成员和共享环境现在提供什么”，以及“当前协作为什么值得改变”的有依据认知；**Self-Management** 是它据此维护自身状态、形成可解释改善方案，并在用户决定和既有权限边界内完成能力构建、交互适配与反馈校准。

F300 的目标不是一张更大的状态页，也不是让一只猫收到更多广播。它要让每个成员拥有一份持续更新、分清私有与共享、能指回 canonical owner 的工作模型，从而成为会认识自己、理解团队环境并能自我调整的成长型协作伙伴。

## Why：成长型伙伴不能靠用户充当外置自我意识

当前系统已经有很多局部真相：Agent Client 知道 exact run，custody 知道责任，Plugin Manager 知道插件生命周期，memory/context owner 知道可访问范围，thread owner 知道协作空间，runtime owner 知道健康与资源。但这些事实没有形成 Agent 可查询、可解释、可用于决策的统一认知。

结果是本应由 Agent 承担的工作倒置给了用户：

| 用户被迫承担的工作 | 成熟 Agent 应承担的责任 |
|--------------------|------------------------|
| 反复问“你现在跑到哪儿了、是不是停了” | 知道自己的 exact obligation、活动状态、最近结果、阻塞与下一判断点 |
| 先发现某个成员已经停止，再提醒其他成员 | 从共享成员投影知道谁可用、谁在工作、谁已终局，不向已失效运行继续交付 |
| 偶然发现“原来你有/没有这项能力” | 认识自身能力、限制、authority、当前 readiness 与替代 provider |
| 替 Agent 记住 memory/context 是否存在、够不够、还新不新 | 知道自己可访问哪些记忆与上下文、覆盖范围、预算、freshness 和缺口 |
| 替团队盘点有哪些 thread、工具、插件、成员和共享资源 | 读取团队环境的可用对象、能力、状态和边界 |
| 替 Agent 安装、启停、恢复或降级 | 在已有 authority 内调用 owner 完成管理并核对 receipt；需要扩权时再提案 |
| 忍受反复出现的摩擦，再自己寻找功能、插件、设置或教程 | 从当前协作中的可解释证据形成待确认的摩擦假设，把合适能力带回原任务现场 |
| 安装后再自己摸索“从哪里用、以后去哪里管、到底有没有改善” | 同步完成交互适配，让用户立即真实使用，并按反馈保留、调整、关闭或回滚 |

这不是“让 Agent 看见所有东西”。真正的团队里，成员既有只有自己可见的工作记忆和局部状态，也有团队共同依赖的公开状态。F300 必须把两者分开，否则不是泄漏私有认知，就是让协作伙伴互相成为黑盒。

## 产品目标：能力增长，但用户心智负担不增长

Agent 产品的能力可以通过 builtin、memory/context、thread operation、plugin、limb/tool 或 remote connector 持续增长；人的发现、理解、启用和管理带宽却不会同步增长。大而全的固定界面把选择成本交给用户，固定极简只服务平均用户，Chat-only 又会让已经稳定的操作每次重新付出描述和确认成本。

F300 的产品目标不是让产品“变化更多”，而是让能力持续增长时，用户不必成为能力目录、运行监控和产品配置器：每一次改善都回应当前真实摩擦，引用当前可信能力状态，经过正确的决定与授权，并在原任务里立即证明是否有效。

系统、Agent 与用户的长期关系固定为：

> **系统提供权威事实和受治理的执行边界；Agent 基于自感知提出并落实改善；用户决定哪些能力和交互进入自己的长期工作方式。**

### 三种感知共同形成判断依据

| 感知维度 | 回答的问题 | 典型证据 | 不能退化成 |
|----------|------------|----------|------------|
| **Self-Capability Management** | 我原则上会什么、不会什么？输入输出、风险、成本和 provider 边界是什么？ | capability contract、F223、builtin/plugin/limb/tool owner | capability 名称、按钮或 tool registration |
| **Self-Availability Management** | 这项能力此刻是否已 provisioned、configured、authorized、ready、applicable？ | owner lifecycle/runtime fact、route/quota/health、最近 verification | manifest、旧成功记录或单一 `enabled` |
| **User-Friction Sense** | 当前协作里，为什么现在值得改变？变化是否真的降低了阻力？ | 用户直接表达、当前任务中的失败/重试/绕行、受范围约束的 interaction evidence 与即时反馈 | 持续监控、用户画像、健康/人格/长期意图推断 |

`User-Friction Sense` 感知的是 Agent 自己提供的能力与交互在当前协作中的效果，不是“理解用户的一切”。一次停顿、输入量或模型直觉只能成为待确认假设；它们既不是事实，也不是授权。

三种感知是形成判断的维度；§1 的 facets 是 Member Self View 的内容轴。Capability / availability 由这些 facets 与 Team Shared / Environment facts 共同支持，而 friction 是当前协作的有界效果信号，不进入成员自我状态 facets。

### 两个耦合结果

- **Capability Construction**：发现、匹配、组合、安装/启用、配置、授权、就绪校验、失败恢复、停用或 provider 迁移。
- **Interaction Adaptation**：解释为什么建议、选择合适媒介、提供使用入口与状态、安排召回和管理路径，并让一次试用在用户确认后稳定为习惯。

二者缺一不可。只构建能力，不适配交互，用户仍不知道能力从哪里用、现在能否用、以后在哪里管理；只改变交互，不读取能力真相，产品会用漂亮入口掩盖未授权、未就绪或已经降级的能力。

### 完整反馈闭环

```text
FRICTION EVIDENCE
  → SENSE self + team + environment
  → MATCH capability + availability + current task
  → GROUNDED PROPOSAL
  → USER DECISION / REQUIRED AUTHORITY
  → CAPABILITY CONSTRUCTION
  → INTERACTION ADAPTATION
  → IMMEDIATE REAL USE
  → FRICTION / OUTCOME FEEDBACK
  → RETAIN | EDIT | DISMISS | REVERT
  → calibrate the next sensing cycle
```

F300 不以“发出建议”“安装成功”“组件渲染”或“工具调用过一次”作为终点。面向用户改善的最小可追责单元是一个 **Interaction Episode**：它必须能从摩擦证据一路指回 capability match、用户决定、owner receipt、首次真实动作和结果反馈。没有用户决定不得越过 proposal；没有首次真实成功不能宣称改善成立；没有恢复路径不能把一次候选固化为长期习惯。

Interaction Episode 不是 F300 的底层状态对象，也不取代 Member/Environment State Model；但对于“能力和交互是否真的变好了”这一产品问题，它是首要体验验收单元。

## 1. 两种可见性平面：成员自己的与团队共享的

### 1.1 Member Self View：成员自己的自我模型

每个 Agent 对自己的认知可以比团队共享投影更细，但仍必须来自 owner truth，而不是模型凭感觉自报：

| Facet | 成员需要知道什么 | 典型事实来源 |
|-------|------------------|--------------|
| Identity & membership | 我是谁、属于哪个家庭/团队/线程、当前角色和责任边界 | identity/session、membership、thread owners |
| Capability & limits | 我会什么、不会什么、有哪些 provider、输入输出与风险边界 | builtin contracts、F223、plugin/limb/tool owners |
| Activity & responsibility | 我正在做什么、接过什么、完成/失败/取消了什么、下一责任是什么 | obligation/custody、InvocationRecord、TurnExecution、F299 trajectory |
| Availability & health | 当前是否可运行，依赖、route、quota、runtime 是否满足 | execution/liveness、route/preflight、runtime/quota owners |
| Memory & context | 我能访问哪些记忆/上下文，覆盖到哪里、是否 compact/stale、还缺什么 | memory owner、context/session owner、F296 presentation receipt |
| Authority & policy | 我能自行采取哪些动作，哪些需要新增授权或价值判断 | grants/policy/authority owners |

“成员自己的”不等于把 chain-of-thought、凭据或无界原始数据存成 F300 资产。F300 只定义可用于任务判断的 typed view；内容读取、保留、压缩和权限继续归 memory/context owner。

### 1.2 Team Shared View：所有成员可依赖的团队认知

团队共享平面包含两类东西：

1. **Member Public Projection**：成员身份、可协作能力、当前 availability、公开 obligation/活动阶段、已发布结果与显式阻塞；
2. **Environment State View**：团队空间中可用的 thread、共享 artifact、memory/knowledge surface、builtin/plugin/limb/tool、connector、runtime、额度与其他资源。

“共享”表示在同一团队和 authority 范围内可查询、可订阅或被投影，不等于把全部事实广播进每只猫的 prompt。成员只在接受任务、选择协作者、执行副作用、处理状态变化或显式查看时获取相关投影；共享投影可以比 owner truth 粗，但不能与 owner truth 矛盾。

团队共享平面禁止暴露：成员私有 memory/context 正文、凭据、未发布草稿、内部推理、无关用户数据，或超出接收者 authority 的资源细节。它可以表达“memory capability 当前不可用”或“共享知识库含某 artifact”，不能因此公开私有内容。

### 1.3 两个平面的关系

```text
CANONICAL DOMAIN FACTS
  ├─ member-private projection ──→ exact member's Self View
  └─ team-shareable projection ─→ Member Public Projection
                                 + Environment State View

JUDGMENT POINT
  → query relevant private + shared projections
  → decide within current authority
  → canonical owner command
  → owner receipt / terminal
  → projections update
```

同一个变化可能只更新私有平面，也可能产生团队共享投影；选择由事实 owner、visibility policy 与当前 authority 共同决定，不能由 F300 猜测。

## 2. 统一的 Member / Environment State Model

### 2.1 统一的是语义，不是把全家状态复制进一张表

F300 需要 provider-neutral 的 typed projection，使 Agent 能用同一种语言询问 member、capability、obligation、memory/context 与 environment，而不把这些 owner 的状态机合并：

```ts
type SelfStateProjection = Readonly<{
  subject: {
    kind: 'member' | 'capability' | 'obligation' | 'thread' | 'memory' | 'context' | 'resource';
    ref: string;
  };
  facet: 'identity' | 'capability' | 'activity' | 'availability' | 'memory_context' | 'authority' | 'health';
  visibility: 'member_private' | 'team_shared';
  state: 'known' | 'unknown' | 'stale' | 'conflicted' | 'unavailable';
  valueRef?: string;
  sourceRefs: readonly string[];
  revision: string;
  observedAt: number;
  expiresAt?: number;
  invalidators: readonly { owner: string; ref: string }[];
}>;
```

这是方向性 contract，不是已经获批的数据结构。`valueRef` 指向 owner-owned fact 或受权 projection；F300 不把原始 message、memory body、plugin ledger、thread record 或 runtime state 复制进中心 store。

### 2.2 Capability 不能等同于 Plugin，也不能压成 `enabled`

能力 provider 至少包括：Agent-native/builtin、memory、context、thread/workspace operation、plugin、local limb/tool、remote connector，以及这些 provider 的组合。Plugin Manager 只拥有 plugin/package 这一类 provider 的生命周期。

每项能力至少分开：

| 维度 | 回答的问题 |
|------|------------|
| Identity | 这是哪一种稳定能力？provider 更换后是否仍是同一能力？ |
| Provider | builtin、member-native、memory/context、thread、plugin、limb、remote 或组合？ |
| Provisioning | provider 是否存在、安装或可取得？ |
| Configuration | 配置是否完整、版本是否兼容？ |
| Authority | 当前成员是否获准在这个 scope 使用或改变它？ |
| Runtime readiness | 依赖、健康、route、quota 与资源此刻是否满足？ |
| Applicability | 是否适用于当前任务、成员、环境和时刻？ |
| Effectiveness | 是否真实完成过目标，结果是否仍可信？ |
| Visibility | 仅成员自己可知，还是团队可依赖？共享到什么粒度？ |

因此 `installed ≠ configured ≠ authorized ≠ ready ≠ applicable ≠ effective`；“我能创建 thread”“我能查询某类 memory”“团队有语音能力”和“某插件已安装”是不同事实。

### 2.3 动作、事实与投影必须分开

| 用户/Agent 动作 | Canonical owner 产生的事实 | F300 可形成的认知 |
|-----------------|--------------------------|-------------------|
| Stop 某成员的 exact run | Agent Client terminal、bubble/result、Active Run 释放、owner disposition | 自己知道 run 已取消；其他成员在相关判断读取“该成员不再执行该 obligation” |
| 新建 thread | thread owner 的新 thread、membership 与 authority receipt | 团队环境出现一个可用协作空间；受邀成员知道其可访问性 |
| 启动/启用一项能力 | capability owner 的 activation/readiness receipt | 成员私有或团队共享 capability projection 更新 |
| 卸载一个 plugin | Plugin Manager lifecycle receipt；受影响 provider 失效 | 由该 plugin 提供的能力变为 degraded/unavailable，其他 provider 不被误伤 |
| memory/context compact、缺失或恢复 | memory/context owner 的 coverage、budget、freshness 与 access fact | 成员知道自己还记得/可读什么、哪里有缺口；团队只见允许共享的 capability/status |

F300 统一这些变化的读模型与管理闭环，不统一它们的写 API。动作请求、canonical outcome 和 derived projection 是三个不同对象。

## 3. 成员停止后，团队如何正确感知

当前文档先前把“取消一只猫，全家在相关判断点知道”写成 Primary journey，这是错误坐标：它暗示 cancellation delta 是 F300 的中心机制，并容易退化为一次全家广播。

PR #1356 给出更合理的分层：

1. Stop 只选择操作边界上仍 live 的 exact Agent Client run；
2. Agent Client 产生唯一 canonical `canceled` terminal，原位终局公开 bubble，并释放 exact Active Run；
3. delivery/history/execution/custody owner 各自维护事实，F300 不另写一个 `cat_stopped` 真相；
4. 其他成员在任务接续、选择 target、查看团队状态或副作用前，从 Team Shared View 读取由这些事实组成的粗粒度公开投影；
5. 投影只说明可证明的含义，例如“B 不再执行 obligation X”或“B 当前无 live Agent run”，不能越级声称 provider 已读、责任已完成或成员永久不可用。

这也解释了 F300 与 #1356 的关系：#1356 负责消息/运行如何 canonical 收敛，F300 负责 Agent 在自己的判断中如何认识这个结果。若 #1356 的产品提案尚未获批，F300 只能依赖最终落地的 owner contract，不能复制它的候选状态机。

## 4. Self-Management：维护自身状态，也推动受权的产品改善

Self-Management 包含两条互补回路。第一条是持续运行所需的**状态维护回路**：

```text
SENSE private + shared state
  → compare obligation / desired state / constraints
  → choose management action
      ├─ within existing authority
      │    → continue / retry / reroute / recover / degrade / stop / compose capability
      └─ needs new authority or value choice
           → rejectable proposal → explicit user decision
  → canonical owner command
  → receipt / terminal
  → verify actual state and update projections
```

- 既有 policy/scope/budget 内的例行恢复、改道、降级和安全停止不应反复询问用户。
- 新增权限、扩大数据或副作用 scope、不可逆动作、持久偏好和价值取舍必须进入可拒绝提案。
- F300 可以决定“现在需要什么变化”，但安装、授权、thread mutation、memory mutation、runtime cancel 等仍由各 canonical owner 执行。

第二条是面向能力成长与协作体验的**产品改善回路**：当 User-Friction Sense 形成有依据的假设时，F300 将相关 private/shared state、capability match、authority、风险、成本与恢复路径组织成可拒绝 proposal；用户决定后，再协调 canonical owner 完成能力构建，并让 Dynamic Interaction / surface owner 交付对应的交互适配。首次真实使用和后续反馈决定这次变化保留、编辑、关闭还是回滚。

两条回路不能混为一谈：维持既有运行不应处处打断用户；改变用户的权限、成本、主要输入输出方式、注意力或长期习惯又不能借“自管理”静默完成。Interaction Episode 不是基础状态模型，却是产品改善回路的可追责容器和体验验收单位。

## 产品设计合同：能力怎样进入用户的工作方式

F300 后续会承载具体产品设计，但这里冻结的是跨媒介、跨 provider 的稳定体验语义，不预先冻结某张页面或某个组件。视觉 UI、CLI、语音和后台能力可以有不同表达，下面五条合同不能随媒介漂移。

### 变化必须有因果来源

每一次主动建议、临时工作面、稳定入口、通知或默认行为变化，都必须回答“它由什么出生”：

| 来源 | 可以产生的交互 | 生命周期 |
|------|----------------|----------|
| 当前任务、运行对象或审批 | 临时工作面、状态和下一动作 | 随对象终局退出，可从历史召回 |
| 已确认并已就绪的稳定能力 | 可预测入口与管理路径 | 能力降级时原位解释，不伪装可用 |
| 需要注意的结构化事件或摩擦假设 | 低成本信号、解释或可拒绝 proposal | 处理、拒绝、过期后收敛，不自动变成长期习惯 |
| 用户直接编辑或确认的候选变化 | 个人布局、触发方式、确认强度或默认媒介 | 可撤销、可恢复默认、可追溯决定 |

答不出 evidence、决定者、期限和恢复路径的变化，没有资格进入产品。

### 能力事实与交互投影分层

能力 ready 但当前没有常驻入口，不代表能力不存在；入口可见但能力未授权、未就绪或已经降级，也不代表它可用。所有 surface 必须投影同一份 capability、authority、receipt 和 episode truth：

| 能力事实 | 交互表达 | 用户与 Agent 应理解什么 |
|----------|----------|--------------------------|
| ready，入口已配置 | 可直接调用 | 当前可用，并有稳定管理路径 |
| 未 ready，入口已配置 | 原位降级、等待或解释 | 入口存在，但现在不能可靠使用 |
| ready，无常驻入口 | 搜索、命令、对话、策略或相关时刻召回 | 系统会做，不等于必须一直显示 |
| unsupported / activation failed | 明确原因、恢复或替代方案 | 不伪装成功，不把失败隐藏到下一次调用 |

### 越主动占用注意力，所需依据越强

默认体验可以克制，但隐藏不能等于失联。普通状态用低成本信号；用户明确请求、已确认的变化、无法继续推进的判断点，或 policy 明确允许的恢复动作，才可以主动展开。被隐藏或关闭的能力仍需稳定、可预测的召回与管理路径。随机 tips、无关推荐和模型“觉得有用”不构成主动打断依据。

### 候选先于长期定型

Agent 发起的能力或交互变化应先成为真实、可试用、可拒绝且可回滚的候选。能力装配与交互定型是两个决定：用户可以同意一次试用，但不同意修改默认输入方式；也可以保留能力，却隐藏长期入口。拒绝、超时、断线、权限失败或再次进入，都必须回到上一个已确认状态或给出明确恢复路径。

### 用户可以直接塑造，但不承担系统设计

用户可以选择显露程度、入口位置、触发方式、确认强度、默认媒介和打扰策略，并撤销或恢复默认。系统仍负责提供受约束的组件、语义、样式、权限防线和可用性基线；用户组合的是可信积木，不是被迫成为产品经理和工程师。可复用、可分享的是受权的交互偏好，不是发送者的凭据、安装状态、运行对象或私有数据。

## 5. 系统边界与最新 `main` 真相

### 5.1 Owner 边界

| 领域 | Canonical owner | F300 责任 |
|------|-----------------|-----------|
| Member identity/membership/session | identity/session、thread membership owners | 形成受权的 member-private / team-shared projection |
| Exact execution, Stop, terminal, liveness | Agent Client、TurnExecution/InvocationRecord、execution owners | 解释活动/availability；不另写 execution 状态机 |
| Custody/obligation/handoff | F233 与 structured protocol owners | 解释当前责任与历史；不从聊天猜 holder |
| Memory/context | memory、context/session、F296 owners | 表达 access/coverage/freshness/limit；不复制正文或 ledger |
| Thread/artifact/team environment | thread、workspace、artifact owners | 构造环境可用性投影；不接管 CRUD |
| Plugin/package | plugin cell / Plugin Manager | 把 plugin 视为 capability provider；生命周期和 receipt 仍归 plugin |
| Capability surface/verification | F223 / surface registry | 关联 provider-neutral capability identity；不以 UI 存在证明可用 |
| Route/runtime/quota/health | F293、F153 与 runtime owners | 在判断点查询 freshness-aware fact |
| Presentation/delivery | F296、message/history/surface owners | 决定哪些 F300 projection 与当前判断相关；不造第二 delivery channel |
| User expression / interaction evidence | message、history、surface 与具体任务 owner | 形成当前协作范围内可解释、可撤回的 friction hypothesis；不改写原始事件，不建用户画像 |
| Dynamic Interaction / preference surfaces | 对话、Hub、CLI、voice 与 preference/retention owners | 定义 capability/episode truth 如何进入当前媒介；长期偏好只能由用户决定并交原 owner 保存 |

### 5.2 `origin/main@dd86a802` 现状

| 能力块 | 当前状态 | 与 F300 的关系 |
|--------|----------|---------------|
| Promise durability / custody / trajectory | 已有多项基础 | 提供 obligation、responsibility 与历史事实，不等于 Agent 已形成自我模型 |
| Context presentation/delivery | 部分落地 | 可承载相关投影；仍没有 Member Self / Team Shared contract |
| Plugin management runtime | 已有实质基础 | 只覆盖 plugin provider，不能代表 builtin、memory、context、thread 或 member-native 能力 |
| Capability surface registry | 已有 registry 基础 | 描述入口和验证面，不是完整 capability/state graph |
| Route/execution/runtime facts | 分散存在 | 缺 provider-neutral、visibility-aware、freshness-aware 的查询投影 |
| PR #1356 lifecycle RFC | open proposal，非 `main` truth | 可作为 exact Stop/terminal/projection 边界参考，不能宣称已实现 |
| Friction / proposal / episode runtime | **未实现** | 没有 evidence-bounded friction hypothesis、grounded proposal 或 end-to-end Interaction Episode coordinator |
| F300 runtime | **未实现** | 没有 Member Self View、Team Shared View、Environment State View 或 self-management coordinator；不存在完整产品纵切 |

## 6. 分阶段实现路线

实现顺序遵循“先证明一次完整改善，再从体验证据抽取通用合同”。不能先做一个覆盖所有 provider、所有媒介和所有团队状态的平台，再等待产品价值出现；也不能只做漂亮 Demo，绕过 canonical owner、authority 和失败恢复。

### Phase 0 — 冻结概念与 owner map（本次文档）

- 冻结三种感知、两个耦合结果、完整反馈闭环与 Interaction Episode 成功定义。
- 冻结成员私有 / 团队共享两个可见性平面，以及 provider-neutral Member / Environment State Model。
- 冻结能力事实、authority、交互投影和用户长期习惯之间的产品设计合同。
- 明确 Plugin、memory/context、thread、runtime、delivery、friction evidence 与 surface owner 边界。
- 记录 Plugin 整改完成前不启动 F300 runtime，但不把 Plugin 误写成 F300 的全部能力边界。

### Phase 1 — 首个完整产品纵切

- 在 Plugin 启动门槛通过后，选择一项 plugin-backed、需要用户决定且能在原任务立即验证的能力完成端到端 episode。语音输入是当前 reference journey，但不是 F300 对某个 provider 或媒介的永久绑定。
- 同一纵切必须同时经过 friction evidence、capability/availability sensing、proposal、用户决定、plugin owner command/receipt、interaction adaptation、first successful action 与 feedback/rollback。
- 只实现该纵切所需的最小 projection 和 adapter；缺失字段以 typed unknown 暴露，不用 mock truth、UI state 或 prompt 约定补齐。
- 纵切失败必须能区分：匹配错误、用户拒绝、权限未授予、plugin activation/configuration/runtime failure、surface failure、真实动作失败与“能力可用但没有降低摩擦”。

### Phase 2 — Projection Contract & Owner Adapters

- 从首纵切提取 subject/facet/visibility/provenance/freshness/invalidator 的 typed projection contract。
- 为 identity、execution、custody、memory/context、thread/environment 与多类 capability provider 建立只读 owner adapters。
- 不建立中心 shadow ledger；query 结果可缓存，但必须由 revision/expiry/invalidator 约束。
- 用 contract tests 证明同一事实不会被 F300、Plugin、History 或 UI 多头写入。

### Phase 3 — Member Self View + Team Shared View

- 让成员在接任务和关键判断点知道自己的 identity、capability、limits、obligation、activity、availability、memory/context 与 authority。
- 形成成员公开投影与团队环境投影：谁可协作、谁在工作、共享空间/能力/资源有哪些、当前是否可用。
- 支持“我不知道 / 已过期 / 相互冲突”的明确表达与回源；“做过什么”来自 durable trajectory/result，不靠模型复述聊天。
- 以相关 query/subscription/context projection 替代全家广播。
- 用 Stop exact run、新 thread、provider 卸载与 memory/context compact 四类异质纵切验证同一个状态模型。

### Phase 4 — Generalized Self-Management & Interaction Adaptation

- 把首纵切的协调政策扩展到 builtin、memory/context、thread/workspace、limb/tool、remote 与 composite provider。
- 从 private + shared state 与 friction evidence 选择继续、恢复、组合、降级、停止或形成 proposal。
- 所有 mutation 交给 canonical owner，并以 receipt/terminal 校准实际状态。
- 新 authority/value choice 走可拒绝提案；现有 authority 内动作不让用户代运维。
- 用视觉、CLI、语音或后台能力中的至少两个差异媒介反证：交互语义不依赖某个按钮、页面或话术。

### Phase 5 — Growing Partner Feedback

- 用任务结果、首次真实动作、摩擦变化、恢复质量、误判、协作可见性和用户负担变化验证自管理效果。
- 学到的稳定能力/偏好只经其 retention/authority owner 保存；不建立无界人格或行为画像。
- 支持 provider 迁移、权限撤回、memory/context 恢复和状态模型纠错。

## 7. Plugin 启动门槛与首纵切完成定义

co-creator 已明确：F300 runtime 在 Plugin 完整整改完成后开始。这里的“Plugin 完成”不是看某个 PR、页面或安装按钮存在，而是由 Plugin truth owner / operator 明确宣布整改完成，并且首纵切所需的以下合同都有可验证证据：

1. **多轴状态可查询**：provider identity、provisioning、configuration、authority、runtime readiness、failure/degraded reason 与 revision/freshness 可以分别读取；不能只返回 `enabled`。
2. **命令与 receipt 单写**：install/enable/configure/test/disable/uninstall/rollback 只经 Plugin canonical command 边界执行，并返回可关联到 exact plugin/provider 的 receipt。
3. **失败和恢复真实**：权限拒绝、配置错误、Host Broker/runtime 不可达、重启 rehydrate、禁用与回滚都有稳定语义；“命令被接受”不冒充 ready。
4. **F300 只读接缝成立**：F300 能通过 owner adapter 查询与发出 intent，不读取 Plugin 私有 store、不从 Settings UI 反推状态，也不建立第二 lifecycle ledger。
5. **能力身份不绑死插件**：reference journey 可以由 plugin provider 实现，但 capability identity、episode 和交互偏好能与 provider identity 分离。

门槛通过表示“可以开始实现 F300”，不表示 F300 已完成。首纵切只有同时满足以下条件才算产品上闭环：

- 用户能理解 Agent 为什么此刻提出改善、需要什么权限/成本、会改变什么以及怎样撤回；
- 用户可以接受、编辑或拒绝，沉默和打开卡片都不算授权；
- 能力由 canonical owner 真正进入 ready，交互入口/状态/管理路径与事实一致；
- 用户在原任务里立即完成第一次真实动作，而不是离开现场重新查教程；
- 结果反馈能让用户保留、调整、关闭或回滚，并成为下一轮 Self-Sensing 的校准证据。

## User Journey

Primary journey 证明完整产品闭环；supporting slices 证明同一套 Member / Environment State Model 能跨事实域成立。它们不能各自建立状态机。

### Primary — 从“打字太累”到第一次真实语音输入

语音只是当前最容易同时暴露能力、插件、系统权限、交互入口和即时反馈的 reference journey；验收对象是闭环，不是语音功能本身。

1. 用户直接说“今天打字太多了，手很累”，或当前文字协作中出现反复、可解释的输入摩擦；Agent 只形成待确认假设，不诊断健康问题。
2. Agent 查询 voice capability 的稳定 contract、当前 provider、Plugin provisioning/configuration、麦克风 authority、runtime readiness 与当前媒介适用性。
3. 如果事实缺失、过期或冲突，Agent 明说不知道并回源；如果能力不可行，不为了完成 Demo 仍然建议。
4. Agent 解释观察到的摩擦、为什么语音可能改善、需要安装/启用什么、哪些步骤可自动完成、哪些系统权限必须用户亲授，以及以后从哪里管理或关闭。
5. 用户接受、编辑或拒绝 proposal；拒绝立即终止且不降低后续服务质量，接受只授权已明确的 capability/scope/interaction candidate。
6. F300 把受权 intent 交给 Plugin / permission / surface canonical owner；每一步以 receipt 推进，失败原位解释并提供恢复或回滚。
7. 能力 ready 后，当前媒介出现清楚的语音入口、状态和管理路径；入口存在不反向证明能力 ready。
8. 用户不离开当前任务，立即说出下一条消息并看到它进入当前对话；这次动作成功才进入 `first-successful-action`。
9. 用户根据当场体验保留、调整入口/确认方式、关闭能力或完整回滚；结果成为下一轮 sensing 的反馈，而不是无界用户画像。

### Supporting A — 成员停止，其他成员在相关判断中知道

1. 用户 Stop B 的 exact run；execution owner 走 canonical cancel/terminal。
2. B 的 Member Self View 反映该 obligation 已 canceled/terminal。
3. A 在准备 handoff、选 target 或承接任务时查询 Team Shared View，得到“B 不再执行 obligation X”的 source-backed projection。
4. A 不向旧 run 继续交付；若 B 有新 run 或仍可接受新工作，不能被旧 cancel 污染。
5. 不向全家广播 raw cancel payload，不由 F300 伪造 terminal。

### Supporting B — 新 thread / capability / plugin 变化进入团队环境

1. canonical owner 创建 thread、启动能力或卸载 plugin，并返回 receipt。
2. Environment State View 更新相应对象、visibility 与 readiness。
3. 受权成员能发现新 thread/能力；无权成员看不到敏感细节。
4. plugin 卸载只使其 provider 失效；稳定 capability identity 可切到其他 provider，不能把所有能力等同于 plugin。

### Supporting C — Memory / Context 自感知

1. Agent 在任务开始和 context 变化后知道可访问 memory/context 的范围、freshness、预算和缺口。
2. compact、session rollover 或 retrieval failure 后不假装仍完整记得；必要时回源、降级或向用户解释。
3. 团队共享平面只投影允许共享的 knowledge artifact/capability/status，不公开成员私有正文。

### Supporting D — 旧 Home-State Awareness（投影机制）

旧 F300 的 M1/M2/M3 保留为“某个 canonical state 影响当前 obligation/下一副作用”时的 delivery/preflight 机制，不再代表 F300 全貌：

- **M1 authoritative preflight**：副作用前按 exact subject 回源；`unknown` 在高风险动作上 fail closed。
- **M2 relevant canonical delta**：F300 判 relevance，F296 负责 presentation/dedupe/receipt；不新建第二 delivery channel。
- **M3 typed snapshot**：引用 owner fact、revision、freshness 与 invalidator，不复制中心账本。

`HomeStateDeltaV1` 若继续实现，应成为 `SelfStateProjection` 的一种 delivery envelope，而不是 cancellation 专用状态机。

M1/M2/M3 随 Phase 2 projection contract 落地，并在 Phase 3 的 Stop / provider / memory 等纵切中复用，不再让未来实现者自行猜测 phase 归属。

### Supporting E — 跨媒介适配与用户定型

同一项能力分别通过视觉、CLI、语音或后台策略中的至少两种媒介表达：状态、authority 与 receipt 含义保持一致；入口形态、注意力成本和反馈方式可以不同。用户可以只接受一次试用、不改变默认媒介；也可以保留能力但隐藏入口，并始终能从稳定路径召回、管理或恢复默认。

## 8. Acceptance Criteria

### Phase 0 — Architecture truth

- [x] AC-0.1: 文档同时定义 capability、availability、friction 三种感知，以及 capability construction、interaction adaptation 两个耦合结果
- [x] AC-0.2: 文档区分 Member Self View 与 Team Shared View，并把成员公开投影和团队环境放入共享平面
- [x] AC-0.3: 文档覆盖 plugin 之外的 builtin、member-native、memory、context、thread/workspace、limb/tool 与 remote provider
- [x] AC-0.4: 文档区分动作、canonical fact/terminal、derived projection 与 Interaction Episode；统一语义不等于中心 shadow ledger
- [x] AC-0.5: 文档冻结 friction→proposal→decision→construction/adaptation→immediate use→feedback 的完整产品闭环、跨媒介设计合同与 Plugin 启动门槛
- [x] AC-0.6: 本轮产品合同扩写由非作者完成 exact-HEAD 内容审阅；旧 R6 approval 不跨实质语义变化复用

### Plugin kickoff gate

- [ ] AC-G1: Plugin truth owner / operator 明确宣布首纵切依赖的整改完成，并绑定 exact implementation/evidence refs
- [ ] AC-G2: Plugin provider 的 provisioning/configuration/authority/readiness/failure/recovery 可分别查询并带 revision/freshness
- [ ] AC-G3: 所有 Plugin mutation 经 canonical command + receipt；重启、失败、禁用与回滚不产生平行真相
- [ ] AC-G4: F300 只经 owner adapter 读事实/发 intent，且 capability identity 不与 plugin identity 永久绑死

### Phase 1 — First complete product slice

- [ ] AC-1.1: reference journey 从有 provenance 的 friction hypothesis 开始；不做健康、人格或长期意图推断
- [ ] AC-1.2: proposal 展示 why-now、capability match、当前 readiness、权限/成本、交互变化与恢复路径，并支持 accept/edit/dismiss
- [ ] AC-1.3: 未获明确 authority 的 episode 不产生 install/configure/permission/external-side-effect command
- [ ] AC-1.4: Plugin / permission / surface 状态只由 owner receipt 推进；安装、注册或渲染不冒充 ready/effective
- [ ] AC-1.5: 用户在原任务完成 first successful action，随后可 retain/edit/disable/revert；完整因果链可下钻
- [ ] AC-1.6: 失败验收覆盖用户拒绝、权限拒绝、activation/runtime/surface/real-action failure 与“成功但未降低摩擦”

### Phase 2 — Projection contract

- [ ] AC-2.1: projection 明确 subject、facet、visibility、source refs、revision、observedAt、expiry/invalidator 与 known/unknown/stale/conflicted/unavailable
- [ ] AC-2.2: 每个 facet 只有一个 canonical owner；F300 cache 失效后回源，不成为第二真相
- [ ] AC-2.3: private projection 不进入 team-shared surface；team-shared projection 不泄漏 memory/context body、凭据或无关数据
- [ ] AC-2.4: contract tests 覆盖 owner mismatch、stale revision、authority change 与 conflicting facts

### Phase 3 — Member and team state

- [ ] AC-3.1: Agent 能查询自己的 capability/limits、obligation/activity、availability、memory/context 与 authority
- [ ] AC-3.2: Stop exact run 的 canonical terminal 可使相关成员读到更新后的 member public projection；不广播 raw event，不污染新 run
- [ ] AC-3.3: 新 thread、共享 artifact、capability/provider 和资源按 visibility/authority 出现在 Environment State View
- [ ] AC-3.4: 相关 projection 只在任务接续、target 选择、副作用或显式查看时进入 context；private/shared 对公开事实不矛盾
- [ ] AC-3.5: context compact/retrieval failure 后显式降为 incomplete/stale/unknown，并给出回源或降级路径

### Phase 4 — Generalized self-management

- [ ] AC-4.1: 每个 management decision 指回 private/shared state、friction evidence、policy、authority、风险、期望变化与恢复路径
- [ ] AC-4.2: 既有 authority 内动作可自主完成，但必须经 owner command + receipt/terminal 验证
- [ ] AC-4.3: 新权限、扩大数据/副作用 scope、不可逆动作、注意力或长期习惯变化必须进入可拒绝候选
- [ ] AC-4.4: plugin、thread、memory、runtime mutation 均不能由 F300 绕过 canonical owner 直写
- [ ] AC-4.5: 至少两种差异媒介共享同一 capability/episode truth，surface 不建立平行状态机

### Phase 5 — Growing partner feedback

- [ ] AC-5.1: 评价覆盖任务成功、first action、摩擦变化、误报/漏报、恢复质量、团队协作可见性、用户追问/代运维负担与可恢复性
- [ ] AC-5.2: provider 迁移、权限撤回、交互偏好恢复、memory/context 恢复和 projection correction 都保留可追溯 receipt
- [ ] AC-5.3: 不以 projection 数、广播数、proposal 数、plugin 安装数或 UI 生成数作为代理成功

## 9. 非目标与安全边界

- 本次刷新不实现代码，也不承诺后续 phase 排期。
- 不新建全家状态数据库、第二 Plugin Manager、第二 memory/context store、第二 execution/custody ledger 或统一 mutation super-controller。
- 不把 member-private 事实、chain-of-thought、凭据、私有 memory/context body 或无关用户数据公开到 Team Shared View。
- 不把 team-shared 等同于广播；默认使用 scoped query、subscription 和判断点投影。
- 不允许 Agent 静默扩权、扩大数据/副作用 scope、执行不可逆动作或把推断当成用户授权。
- 不做无界后台监控、跨场景用户画像、健康/人格诊断或由行为痕迹推断长期意图；friction evidence 必须限于当前受权协作范围。
- 不让一次试用、默认入口或模型偏好自动沉淀为长期习惯；长期定型必须由用户明确决定且可以恢复。
- 不以 Plugin、Dynamic UI、History message、manifest 或单次成功调用替代完整能力/状态真相。
- 不在首个完整 episode 之前先建设覆盖所有 provider 和媒介的通用 Experience Runtime。
- 不把 #1356 的 open RFC 写成 `main` 已实现或已获产品授权。

## 10. 依赖与所有权地图

| 依赖 | 为 F300 提供 | 不由 F300 接管 |
|------|-------------|----------------|
| identity/session/thread owners | member identity、membership、session/thread availability | identity、membership、thread CRUD 与 session lifecycle |
| F223 | capability surface trigger/execution/verification/eval registry | registry owner 与验证契约 |
| F233 | custody/obligation canonical fact | custody 状态机与 structured handoff |
| F220 + execution owners | invocation execution/liveness、terminal 与恢复事实 | Agent Client / execution lifecycle、Stop 与 recovery |
| F293 | route snapshot/preflight | route decision owner |
| F296 | context presentation、epoch、dedupe、provider receipt | context body、delivery ledger 与 presentation semantics |
| memory/context owners | access、coverage、freshness、retention、compaction、budget | memory/context body 与 lifecycle |
| F298 | principal/admission/result/wake 的持久承诺 | durability infrastructure |
| F299 + message/history/surface owners | request-generation evidence、trajectory、当前任务 interaction evidence 与诊断下钻 | 原始消息、事件、历史与用户事实；F300 只形成 scoped hypothesis |
| Plugin cell / Plugin Manager | plugin discovery/install/config/auth/runtime/audit fact + command/receipt；首纵切启动门槛 | plugin/package lifecycle、Host Broker、SDK/实现 |
| F153/runtime/quota owners | health、resource、quota 与 availability facts | runtime supervision 与 resource mutation |
| Dynamic Interaction / surfaces | proposal、authority、capability/episode 状态在 UI/CLI/voice/background 中的表达与即时使用反馈 | capability、authority、state、receipt 或用户长期偏好 truth |

F300 implementation kickoff 明确依赖 §7 的 Plugin gate；这是一条实现顺序依赖，不是概念所有权合并。非 plugin provider 的状态、管理和交互仍按各自 owner 接入同一 provider-neutral contract。

## 11. 风险与防线

| 风险 | 防线 |
|------|------|
| Self-Sensing 退化成全家广播 | 两种 visibility + scoped query/subscription + relevance gate |
| 中心模型复制所有 owner 状态 | projection refs + revision/expiry/invalidator；owner command/receipt 单写 |
| Plugin 再次吞掉能力概念 | provider-neutral identity；memory/context/thread/member-native 与 plugin 同级建模 |
| 团队共享泄漏成员私有认知 | public projection schema + authority filter + body/credential/thought exclusion |
| Stop event 被误写成永久成员状态 | exact run/obligation subject；canonical terminal；新 run 不继承旧 cancel |
| Agent 自我报告替代事实 | provenance + typed unknown/stale/conflicted + authoritative preflight |
| Self-Management 变成扩权 controller | authority classification + rejectable proposal + canonical owner mutation |
| User-Friction Sense 变成监控或画像 | current-collaboration scope + explainable hypothesis + confirmation + sensitive inference prohibition |
| 建议泛滥或随机占用注意力 | why-now + relevance + reject/dismiss + attention threshold + stable recall path |
| “安装/渲染成功”被误报成“改善成立” | first successful action + friction/outcome feedback + retain/edit/disable/revert |
| Plugin 整改完成被口头化 | §7 五项可验证 gate + truth owner/operator exact evidence signoff |
| 抽象过重迟迟无真实价值 | Plugin gate 后先跑一条完整产品纵切，再从证据提取 projection 与跨媒介合同 |

## 12. Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F300 基础模型固定为 Member Self View 与 Team Shared View；后者由 Member Public Projection + Environment State View 组成 | 成长型伙伴既需要自己的认知，也需要团队共同认知；两者不能因共享或隐私要求互相吞并 | 2026-08-25 |
| KD-2 | 统一对象是 provider-neutral state projection 与 management loop，不是中心状态库或统一 mutation API | 让 Agent 用同一种语言理解异质能力，同时保持 canonical owner 单一真相 | 2026-08-25 |
| KD-3 | Plugin 是 capability provider/lifecycle owner 之一，不是 F300 能力边界 | memory、context、thread、member runtime 等关键能力不会也不应都插件化 | 2026-08-25 |
| KD-4 | 动作、canonical result/terminal 与 shared projection 分离；成员 Stop 复用 #1356 owner 边界，不建立 cancel broadcast | 其他成员需要知道的是当前可依赖状态，不是复制一条动作事件 | 2026-08-25 |
| KD-5 | 旧 Home-State M1/M2/M3 是 projection delivery/preflight 的窄机制；Interaction Episode 不是基础状态对象，但它是用户可见改善的首要体验验收单位 | 避免具体取消 bug 反向定义 Self-Sensing，同时不再把完整产品闭环压成一句“上层消费者” | 2026-08-26 |
| KD-6 | memory/context 是 Self-Sensing 的一等 facet，但内容、retention、compaction 与权限仍归其 owner | Agent 必须知道自己记得什么和缺什么，同时不能建立第二 memory/context store | 2026-08-25 |
| KD-7 | team-shared 表示受权可依赖，不等于注入所有 prompt 或向全家广播 | 团队认知需要共同事实，也需要 relevance、隐私和 context budget 边界 | 2026-08-25 |
| KD-8 | 先前 R4 approval 仅覆盖旧 HEAD 的 Interaction Episode/Home-State-first 坐标；本次 operator correction 后必须重新审阅 | 新方向改变了 feature 的核心对象、可见性模型与 phase 顺序，不能用机械 continuity 复用 | 2026-08-25 |
| KD-9 | F300 的完整产品合同固定为 capability + availability + friction 三种感知，驱动 capability construction + interaction adaptation，并以 immediate use + feedback 闭环 | Member/Environment State 是可信认知底座，但不能单独代表产品目标 | 2026-08-26 |
| KD-10 | Plugin 完整改是 F300 runtime kickoff gate；通过后先做一条 plugin-backed 完整 episode，再抽取通用平台合同 | 当前最关键执行边界在 Plugin，但 provider-neutral 语义和产品目标不归 Plugin 吞并；纵切先于平台化 | 2026-08-26 |
| KD-11 | 交互变化必须有 evidence、决定者、期限、召回与恢复路径；能力装配和长期交互定型是两个决定 | 用户可以试用能力而不改变长期习惯，也可以保留能力但选择不同入口 | 2026-08-26 |

## 13. Review / Delivery Gate

- 本次 docs-only 变更继续走既有 PR #1391；新实质内容需要非作者内容 review。
- Review 重点：完整产品闭环是否重新成为一等合同；三种感知与两种可见性是否同时成立；Plugin kickoff gate 是否具体但未吞并非 plugin provider；首纵切是否可直接指导产品设计与实现；friction/authority/privacy/rollback 是否有硬边界。
- 校验：strict-delta frontmatter + feature truth + ownership generator idempotence + runtime-symbol absence。
- Plugin gate 通过后另立执行 thread，先交付 Phase 1 完整产品纵切，再抽取 owner adapter 与异质切片；本 spec 本身不授权 runtime mutation。
