---
feature_ids: [F300]
related_features: [F153, F220, F223, F233, F293, F296, F298, F299]
topics: [self-sensing, self-management, member-state, team-state, environment-state, capability, memory, context, availability, plugin-management]
doc_kind: spec
created: 2026-08-17
description: "成长型 Agent 如何有依据地认识自己、其他成员的公开状态与团队环境，在权限边界内管理自身能力和运行状态"
description_source: human
description_author: lang
description_updated_at: 2026-08-25T04:06:00Z
---

# F300: Agent Self-Sensing & Self-Management — 成长型协作伙伴的自我与团队环境认知

> **Status**: spec（概念重新校准；运行时实现尚未开始） | **Owner**: Ragdoll (@fable5, claude-fable-5) | **Priority**: P1
>
> **Baseline**: `origin/main@dd86a802`（2026-08-25） | **本次变更**: 只刷新概念、边界、现状与分阶段路线，不实现运行时代码

- **operator direction（`0001787628299553-000287-d2731687`）**: 成熟 Agent 应自行感知能做什么、不能做什么、当前运行到哪里与出了什么问题；用户不应承担能力发现、状态追问和日常运维。F300 尚无对应 runtime 实现，因此总体合同可以重写，原 Home-State 内容只保留为一个实现切片。
- **operator correction（`0001787630815635-000364-84224743`）**: F300 最关心的是 Agent 自身能力与状态边界的统一抽象；Plugin 只覆盖插件式 provider，memory、context、thread、成员运行等大量能力并不是插件。Self-Sensing / Self-Management 必须同时包含成员自己的私有认知，以及所有成员可用的团队共享认知，让成长型协作伙伴知道自己具有什么、做过什么、能做什么，也知道团队环境里有什么可用。
- **design reference**: PR [#1356](https://github.com/zts212653/clowder-ai/pull/1356) exact HEAD [`5ebc9058a`](https://github.com/zts212653/clowder-ai/blob/5ebc9058a83ab0293716c26feed30cb561e669f0/docs/architecture/message-delivery-handling-handoff-audit.md) 提供 Stop Agent、exact Agent Client、terminal、Active Run 与公开投影的 owner 边界。它仍是 open RFC，且明确有三项产品语义等待 maintainer/product decision；F300 不把它冒充 `main` 已实现事实，只复用“动作、canonical terminal、共享投影必须分层”的设计原则。
- **Canonical product narrative**: 本文的[两种可见性平面](#1-两种可见性平面成员自己的与团队共享的)、[统一状态模型](#2-统一的-member--environment-state-model)与[分阶段路线](#6-分阶段实现路线)

## Architecture Ownership & Delta Evidence

Architecture cell: `self-sensing-management`（相邻：`plugin`、`routing-context`、`identity-session`、`dispatch`、`message-history`）

Map delta: 更新 [`self-sensing-management`](../architecture/ownership/cells/self-sensing-management.md) 的 canonical contract，并保持 [`plugin`](../architecture/ownership/cells/plugin.md) 仅为 provider/lifecycle owner。

Why: F300 拥有 provider-neutral 的 Member/Environment State Model、私有与团队共享投影语义，以及从 grounded state 到 authority-bounded management 的协调政策；每个事实和动作仍由原 canonical domain 持有。

Consumer evidence: `rg -n 'MemberSelfView|TeamSharedView|EnvironmentStateView|SelfStateProjection' packages -g '*.{ts,tsx,mjs}'` 在 `origin/main@dd86a802` 无匹配，因此当前没有 F300 runtime consumer。

Claim guard: “F300 只有架构真相、runtime 尚未实现，且没有复制相邻 owner 状态” → runtime symbol absence + ownership generator clean + feature truth check；出现 symbol 却未登记 owner/callsite，或出现跨 plugin/memory/context/thread/runtime 的中心影子账本即 red。

## 一句话定义

**Self-Sensing** 是 Agent 对“我是谁、我有什么、我在做什么、我做过什么、我能做与不能做什么”以及“团队成员和共享环境现在提供什么”的有依据认知；**Self-Management** 是它在既有权限内据此管理自己的能力、责任和运行状态，并把需要新增授权或价值判断的决定交给用户。

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

这不是“让 Agent 看见所有东西”。真正的团队里，成员既有只有自己可见的工作记忆和局部状态，也有团队共同依赖的公开状态。F300 必须把两者分开，否则不是泄漏私有认知，就是让协作伙伴互相成为黑盒。

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

## 4. Self-Management：管理自己，不取得所有系统的写权限

Self-Management 的核心循环是状态校准，而不是以 Interaction Episode 或插件安装为中心：

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
- Interaction Episode 是“用户摩擦触发能力变化”时的一种上层 journey；Dynamic Interaction 是一种投影与验证 surface。两者都不是 F300 的基础状态模型。

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

### 5.2 `origin/main@dd86a802` 现状

| 能力块 | 当前状态 | 与 F300 的关系 |
|--------|----------|---------------|
| Promise durability / custody / trajectory | 已有多项基础 | 提供 obligation、responsibility 与历史事实，不等于 Agent 已形成自我模型 |
| Context presentation/delivery | 部分落地 | 可承载相关投影；仍没有 Member Self / Team Shared contract |
| Plugin management runtime | 已有实质基础 | 只覆盖 plugin provider，不能代表 builtin、memory、context、thread 或 member-native 能力 |
| Capability surface registry | 已有 registry 基础 | 描述入口和验证面，不是完整 capability/state graph |
| Route/execution/runtime facts | 分散存在 | 缺 provider-neutral、visibility-aware、freshness-aware 的查询投影 |
| PR #1356 lifecycle RFC | open proposal，非 `main` truth | 可作为 exact Stop/terminal/projection 边界参考，不能宣称已实现 |
| F300 runtime | **未实现** | 没有 Member Self View、Team Shared View、Environment State View 或 self-management coordinator |

## 6. 分阶段实现路线

### Phase 0 — 冻结概念与 owner map（本次文档）

- 冻结成员私有 / 团队共享两个可见性平面。
- 冻结 provider-neutral Member / Environment State Model 与动作/事实/投影分离原则。
- 明确 Plugin、memory/context、thread、runtime、delivery 等 owner 边界。
- 将旧 Home-State、Interaction Episode 与 cancellation journey 降为实现切片或消费者。

### Phase 1 — Projection Contract & Owner Adapters

- 定义 subject/facet/visibility/provenance/freshness/invalidator 的 typed projection contract。
- 为 identity、execution、custody、memory/context、thread/environment、capability provider 建立只读 owner adapters。
- 不建立中心 shadow ledger；query 结果可缓存，但必须由 revision/expiry/invalidator 约束。
- 先证明同一事实不会被 F300、Plugin、History 或 UI 多头写入。

### Phase 2 — Member Self View

- 让成员在接任务和关键判断点知道自己的 identity、capability、limits、obligation、activity、availability、memory/context 与 authority。
- 支持“我不知道 / 已过期 / 相互冲突”的明确表达与回源。
- 让成员能说明自己做过什么、当前在做什么、为什么能/不能继续，而不是靠模型复述聊天。

### Phase 3 — Team Shared View & Environment State

- 形成成员公开投影与团队环境投影：谁可协作、谁在工作、共享空间/能力/资源有哪些、当前是否可用。
- 以相关 query/subscription/context projection 替代全家广播。
- 先落地 Stop exact run 后其他成员读取更新状态、新 thread 对受权成员可见、provider 卸载导致共享能力降级三类跨 owner 纵切。

### Phase 4 — Authority-Bounded Self-Management

- 从 private + shared state 选择继续、恢复、组合、降级、停止或提案。
- 所有 mutation 交给 canonical owner，并以 receipt/terminal 校准实际状态。
- 新 authority/value choice 走可拒绝提案；现有 authority 内动作不让用户代运维。

### Phase 5 — Growing Partner Feedback

- 用任务结果、恢复质量、误判、协作可见性和用户负担变化验证自管理效果。
- 学到的稳定能力/偏好只经其 retention/authority owner 保存；不建立无界人格或行为画像。
- 支持 provider 迁移、权限撤回、memory/context 恢复和状态模型纠错。

## User Journey

以下异质切片共同验证同一套 Member / Environment State Model，而不是各自建立状态机。

### Slice A — 成员停止，其他成员在相关判断中知道

1. 用户 Stop B 的 exact run；execution owner 走 canonical cancel/terminal。
2. B 的 Member Self View 反映该 obligation 已 canceled/terminal。
3. A 在准备 handoff、选 target 或承接任务时查询 Team Shared View，得到“B 不再执行 obligation X”的 source-backed projection。
4. A 不向旧 run 继续交付；若 B 有新 run 或仍可接受新工作，不能被旧 cancel 污染。
5. 不向全家广播 raw cancel payload，不由 F300 伪造 terminal。

### Slice B — 新 thread / capability / plugin 变化进入团队环境

1. canonical owner 创建 thread、启动能力或卸载 plugin，并返回 receipt。
2. Environment State View 更新相应对象、visibility 与 readiness。
3. 受权成员能发现新 thread/能力；无权成员看不到敏感细节。
4. plugin 卸载只使其 provider 失效；稳定 capability identity 可切到其他 provider，不能把所有能力等同于 plugin。

### Slice C — Memory / Context 自感知

1. Agent 在任务开始和 context 变化后知道可访问 memory/context 的范围、freshness、预算和缺口。
2. compact、session rollover 或 retrieval failure 后不假装仍完整记得；必要时回源、降级或向用户解释。
3. 团队共享平面只投影允许共享的 knowledge artifact/capability/status，不公开成员私有正文。

### Slice D — 旧 Home-State Awareness（窄切片）

旧 F300 的 M1/M2/M3 保留为“某个 canonical state 影响当前 obligation/下一副作用”时的 delivery/preflight 机制，不再代表 F300 全貌：

- **M1 authoritative preflight**：副作用前按 exact subject 回源；`unknown` 在高风险动作上 fail closed。
- **M2 relevant canonical delta**：F300 判 relevance，F296 负责 presentation/dedupe/receipt；不新建第二 delivery channel。
- **M3 typed snapshot**：引用 owner fact、revision、freshness 与 invalidator，不复制中心账本。

`HomeStateDeltaV1` 若继续实现，应成为 `SelfStateProjection` 的一种 delivery envelope，而不是 cancellation 专用状态机。

### Slice E — Interaction adaptation（上层消费者）

当用户摩擦需要能力或交互变化时，Dynamic Interaction 可以消费同一 private/shared state，形成可拒绝 proposal、选择 surface 并验证真实动作；proposal/install/UI 数量都不是 F300 成功标准。

## 8. Acceptance Criteria

### Phase 0 — Architecture truth

- [x] AC-0.1: 文档区分 Member Self View 与 Team Shared View，并把成员公开投影和团队环境放入共享平面
- [x] AC-0.2: 文档覆盖 plugin 之外的 builtin、member-native、memory、context、thread/workspace、limb/tool 与 remote provider
- [x] AC-0.3: 文档区分动作、canonical fact/terminal 与 derived projection；Stop 例不再依赖全家广播
- [x] AC-0.4: 文档明确统一的是 provider-neutral projection 语义，不是中心 shadow ledger 或统一 mutation API
- [x] AC-0.5: 旧 Home-State 与 Interaction Episode 已降为实现切片/上层消费者
- [ ] AC-0.6: 新方向由非作者完成内容审阅；先前 R4 approval 仅覆盖旧 HEAD/旧坐标，不可复用

### Phase 1 — Projection contract

- [ ] AC-1.1: projection 明确 subject、facet、visibility、source refs、revision、observedAt、expiry/invalidator 与 known/unknown/stale/conflicted/unavailable
- [ ] AC-1.2: 每个 facet 只有一个 canonical owner；F300 cache 失效后回源，不成为第二真相
- [ ] AC-1.3: private projection 不进入 team-shared surface；team-shared projection 不泄漏 memory/context body、凭据或无关数据
- [ ] AC-1.4: contract tests 覆盖 owner mismatch、stale revision、authority change 与 conflicting facts

### Phase 2 — Member Self View

- [ ] AC-2.1: Agent 能查询自己的 capability/limits、obligation/activity、availability、memory/context 与 authority
- [ ] AC-2.2: “做过什么”来自 durable trajectory/result，不从聊天摘要或模型自述伪造
- [ ] AC-2.3: context compact/retrieval failure 后投影显式降为 incomplete/stale/unknown，并给出回源或降级路径

### Phase 3 — Team Shared View

- [ ] AC-3.1: Stop exact run 的 canonical terminal 可使相关成员读到更新后的 member public projection；不广播 raw event，不污染新 run
- [ ] AC-3.2: 新 thread、共享 artifact、capability/provider 和资源按 visibility/authority 出现在 Environment State View
- [ ] AC-3.3: 相关 query/subscription 只在任务接续、target 选择、副作用或显式查看时投影，不把全部 team state 注入所有 prompt
- [ ] AC-3.4: member-private 与 team-shared 对同一公开事实不矛盾；粗粒度 shared view 不越级宣称 seen/handled/responsibility complete

### Phase 4 — Self-Management

- [ ] AC-4.1: 每个 management decision 指回 private/shared state、policy、authority scope、风险与期望变化
- [ ] AC-4.2: 既有 authority 内动作可自主完成，但必须经 owner command + receipt/terminal 验证
- [ ] AC-4.3: 新权限、扩大数据/副作用 scope、不可逆动作或价值取舍必须进入可拒绝提案
- [ ] AC-4.4: plugin uninstall、thread mutation、memory mutation、runtime Stop 均不能由 F300 绕过 canonical owner 直写

### Phase 5 — Growing partner feedback

- [ ] AC-5.1: 评价覆盖任务成功、恢复质量、状态误判、团队协作可见性、用户追问/代运维负担与可恢复性
- [ ] AC-5.2: provider 迁移、权限撤回、memory/context 恢复和 projection correction 都保留可追溯 receipt
- [ ] AC-5.3: 不以 projection 数、广播数、proposal 数、plugin 安装数或 UI 生成数作为代理成功

## 9. 非目标与安全边界

- 本次刷新不实现代码，也不承诺后续 phase 排期。
- 不新建全家状态数据库、第二 Plugin Manager、第二 memory/context store、第二 execution/custody ledger 或统一 mutation super-controller。
- 不把 member-private 事实、chain-of-thought、凭据、私有 memory/context body 或无关用户数据公开到 Team Shared View。
- 不把 team-shared 等同于广播；默认使用 scoped query、subscription 和判断点投影。
- 不允许 Agent 静默扩权、扩大数据/副作用 scope、执行不可逆动作或把推断当成用户授权。
- 不以 Plugin、Dynamic UI、History message、manifest 或单次成功调用替代完整能力/状态真相。
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
| F299 | request-generation evidence、trajectory 与诊断下钻 | invocation history/trajectory truth |
| Plugin cell / Plugin Manager | plugin discovery/install/config/auth/runtime/audit fact + receipt | plugin/package lifecycle、Host Broker、SDK/实现 |
| F153/runtime/quota owners | health、resource、quota 与 availability facts | runtime supervision 与 resource mutation |
| Dynamic Interaction / surfaces | private/shared state 的用户与 Agent 投影 | capability、authority、state 或 receipt truth |

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
| 抽象过重迟迟无真实价值 | Phase 1 contract 后立即用 Stop/thread/plugin/memory 四类异质纵切验证 |

## 12. Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F300 基础模型固定为 Member Self View 与 Team Shared View；后者由 Member Public Projection + Environment State View 组成 | 成长型伙伴既需要自己的认知，也需要团队共同认知；两者不能因共享或隐私要求互相吞并 | 2026-08-25 |
| KD-2 | 统一对象是 provider-neutral state projection 与 management loop，不是中心状态库或统一 mutation API | 让 Agent 用同一种语言理解异质能力，同时保持 canonical owner 单一真相 | 2026-08-25 |
| KD-3 | Plugin 是 capability provider/lifecycle owner 之一，不是 F300 能力边界 | memory、context、thread、member runtime 等关键能力不会也不应都插件化 | 2026-08-25 |
| KD-4 | 动作、canonical result/terminal 与 shared projection 分离；成员 Stop 复用 #1356 owner 边界，不建立 cancel broadcast | 其他成员需要知道的是当前可依赖状态，不是复制一条动作事件 | 2026-08-25 |
| KD-5 | 旧 Home-State M1/M2/M3 是 projection delivery/preflight 的窄切片；Interaction Episode 是上层消费者 | 避免具体取消 bug和 Dynamic Interaction journey 反向定义 Self-Sensing 全貌 | 2026-08-25 |
| KD-6 | memory/context 是 Self-Sensing 的一等 facet，但内容、retention、compaction 与权限仍归其 owner | Agent 必须知道自己记得什么和缺什么，同时不能建立第二 memory/context store | 2026-08-25 |
| KD-7 | team-shared 表示受权可依赖，不等于注入所有 prompt 或向全家广播 | 团队认知需要共同事实，也需要 relevance、隐私和 context budget 边界 | 2026-08-25 |
| KD-8 | 先前 R4 approval 仅覆盖旧 HEAD 的 Interaction Episode/Home-State-first 坐标；本次 operator correction 后必须重新审阅 | 新方向改变了 feature 的核心对象、可见性模型与 phase 顺序，不能用机械 continuity 复用 | 2026-08-25 |

## 13. Review / Delivery Gate

- 本次 docs-only 变更继续走既有 PR #1391；新实质内容需要非作者内容 review。
- Review 重点：两种可见性是否完整；Plugin 是否只是 provider；memory/context 是否一等但不被复制；#1356 Stop 例是否保持 owner 边界；是否仍有 broadcast/Interaction-first 残留。
- 校验：strict-delta frontmatter + feature truth + ownership generator idempotence + runtime-symbol absence。
- 后续实现另立执行 thread，按 owner adapter 与异质纵切逐步落地；本 spec 不直接授权 runtime mutation。
