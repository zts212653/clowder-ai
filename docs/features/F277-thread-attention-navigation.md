---
feature_ids: [F277]
related_features: [F095, F128, F167, F187, F193, F233, F246, F252, F275]
topics: [thread, attention, navigation, relationship, sidebar, ux, projection]
doc_kind: spec
created: 2026-07-26
description: "让用户在相关 thread 并发时既能低成本监看，又能按需并排阅读两个完整对话现场。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-26T13:00:00Z
---

# F277: Thread Attention Navigation — 关系感知的注意力导航

> **Status**: spec | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1
>
> **operator signoff**: `0001785068607739-000522-d5a5681f` — “你来立项吧”；正式批准
> 独立 F 号承载写入端语义、可重建投影与三层 UX。实现必须先通过 Phase A UX
> Design Gate。
>
> **2026-07-31 scope reset**: operator 将 F277 与通用自适应/动态 UX 重构明确解耦
>（`0001785494350337-000269-73941a81`）。F277 只解决相关 thread 的导航、监看与
> 并排阅读；旧 Tree / Section Rollup / Contextual Orbit Design Gate PR #3238 已关闭，
> 不作为实现依据。

## Architecture Ownership

Architecture cell: `thread-navigation`

Map delta: **updated in this kickoff** — F277 加入现有 `thread-navigation` cell，持有
thread attention projection 的查询契约，以及 Sidebar / Thread 现场的用户面向组织语义。
F128/ThreadStore 与 message branch 继续持有出生 canonical truth；F167/F246 custody、
F233 trajectory、F252 rendering 与 F275 managed-work 继续持有各自 canonical truth。
F277 不新建 graph store，也不取得 action 或 whole-work lifecycle ownership。

Why: 该 cell 明确覆盖 Sidebar thread grouping、visibility、navigation 与用于组织 thread
的 metadata；F277 正在扩展这些用户侧能力，而不是让猫主动 surface artifact。

## Why

You 的问题不是“没有一张漂亮的 thread 图”，而是相关 thread 并发时必须来回切换，
既难持续知道每条是否需要关注，也无法在保留主对话上下文的同时真正阅读另一条 thread：

> “如果是注意力管理的话……好像 UX 的设计才是非常关键的吧？”

本 Feature 的价值目标是：**把 thread 关系变成可操作的并发阅读导航——左侧低成本告诉
用户有哪些相关现场和真实状态；需要看内容时，打开第二个完整 Chat 视口并动态切换相关
thread。监看只显示机器事实，阅读只显示 canonical 原文；关系图只做下钻。**

## Current State / 现状基线

- F095/F187 已分别提供 Sidebar 折叠、排序、置顶和标签分类，但这些能力回答“怎么找”
  与“属于哪类”，不回答“这几个 thread 为什么连在一起、现在哪个需要关注”。
- Sidebar 仍按 tab/project 平铺；前端 `Thread` 已有 `parentThreadId`，后端已有 children
  索引，但 Sidebar 没有消费该关系。
- F128 已持久化 proposal source、parent 与 `reportingMode`，仍缺“这个新 thread 的组织
  角色”语义；message branch 只有瞬时广播，缺持久出生 provenance。
- Thread 内右侧栏没有 thread 级“从哪来、挂在哪、卫星在做什么”区域；现有 provenance
  只在单条 cross-post 消息上可见。
- F233/F252 已能把部分 thread 画成 trajectory/Birdseye，但 F128 一律压成
  `thread_split`、cross-post 一律压成粗边，且普通未挂 feature 的 thread 不在投影内。
- 数据模型收敛设计已落在
  review 收敛到 0 P1，v0.6 再按 kickoff governance review 收窄运行边界。当前只有
  Tree / Section Rollup / Contextual Orbit 三张已作废的低保真结构草图；它们没有覆盖
  “主 thread + 另一条长消息 thread 同时阅读”的核心场景，**不能作为 Phase A 证据**。

## Boundary With F275 / PR #3209

F275 与 F277 相邻但不重叠：

| 问题 | 唯一 owner |
|------|------------|
| “这份被正式受理的交付工作是谁、经历了第几次 attempt、整体是否完成？” | F275 `managed-work` / `workId` / `attemptId` |
| “这个 thread 从哪来、挂在哪、在当前界面是否值得我关注？” | F277 origin / placement / liveness projection |

硬边界：

- `threadId`、`parentThreadId`、`declaredWorkMode` 不能创建或推断 F275 `workId`。
- F275 明确允许 work 跨 thread 移动；因此 F277 的“注意力簇”不是 managed-work 边界。
- `declaredWorkMode` 只描述 thread placement 角色，不表示 work admission、custody 或
  whole-work lifecycle。
- 未来若 UI 需要显示 managed work，只能通过 F275 提供的 exact nullable ref join 成一个
  badge/status；不得按 thread 邻近、标题或时间猜。
- F275 whole-work terminal 不能直接折叠一个 thread；F277 v1 仍只按 thread 的显式
  internal-archive/soft-delete 收尾折叠。

因此 PR #3209 不阻塞 F277；它反而提供了一条必须遵守的反推断边界。

## What

### Phase A: operator Experience Design Gate — 先验证并发阅读

不写生产 UI，先在家里真实三列布局中验证一条完整旅程：**当前主 Chat 保持原位；用户从
相关 thread 集合中打开第二个 Chat，随后可在不丢主 Chat 草稿、滚动位置与选择状态的前提下
动态切换另一条相关 thread。**

Phase A 必须同时表达两种不同动作，禁止再把它们塞进同一张窄卡：

1. **监看**：只显示 canonical structured facts，例如 active/waiting/needs-user、更新时间、
   明确产物引用与阻塞；没有结构化事实就显示 unknown。不得截取聊天头尾，不得让模型生成
   一段“最新摘要”冒充 thread 内容。
2. **阅读**：打开真正的 Chat viewport，复用 canonical message renderer，完整原文、独立滚动、
   可继续交互。长消息可以占满一屏，这是内容事实，不是需要被压扁的异常。

Design Gate 至少用同一真实 fixture 比较以下承载方式；比较是为了确定空间归属，不是预设
通用动态 UI Runtime：

- 第二 Chat 临时接管现有 Workspace 栏，关闭后 Workspace 恢复；
- 中央内容区变成可调宽度的双 Chat，Workspace 同时收起；
- 临时第四栏只作对照，除非它证明没有造成新的永久导航税，否则不作为默认。

fixture 必须含：一条主线、两条平行/调查 thread、至少一条真实的一屏长猫消息、需要用户
判断的支线、历史 unknown/orphan、origin 与 parent 不同的 re-root，以及窄屏/键盘/读屏。
左侧只负责相关集合、选择与低成本状态，不用缩进树暗示不存在的主从关系；右侧 Workspace
只服务当前聚焦 thread 的文件、任务、状态与动作，不重复一份关系总览。

Design Gate 必须冻结：默认第一屏、第二 Chat 的打开/切换/关闭、焦点归属、宽度与恢复行为、
Workspace 让位方式、长消息滚动、窄屏退化、unknown、与 pin/label/project 的共存方式。
operator 亲自看过可操作原型并签字前，不进入 Phase B/C 实现；猫猫 PASS 不能替代 operator 签字。

### Phase B: Canonical Inputs → Rebuildable Projection

- F128 propose/approve 增加 `declaredWorkMode`：
  `subtask | parallel | investigation | standalone`；历史缺失投影为 `unknown`。
- message branch 持久化
  `branchAudit { sourceThreadId, sourceMessageId, branchedAt }`，并写入 placement
  `parentThreadId`。
- 构建零新 store 的 `ThreadGraphProjection`：只从 Thread、Proposal/proposalAudit 与
  branch audit 重建出生和挂靠关系。
- 明确分开：
  - `origin`：从哪里发起、回报坐标在哪里；
  - `placement`：挂在哪、thread 组织角色是什么；
- v1 **不投影 `operationalRefs`**：DispatchProposal、ActionSuccessor 与 coordination
  目前没有稳定的 by-thread 读面；F277 不全量扫描这些 store，也不为它们新增派生索引或
  forward-ref 双写。相关 action/custody 可视化等 owner 提供稳定 exact-ref/read model 后
  另行接入。
- `declaredWorkMode.investigation`、`EffectClass.investigate`、
  `ActionFamily.investigate` 同词根但属于三个命名空间，禁止自动互推。

### Phase C: L1 Navigation + L2 Dual-Thread Reading

- **L1 日常入口**：按 Phase A 获批形态呈现相关 thread 集合、真实 liveness 与显式收尾；
  liveness 与 lifecycle 分开，未活动不等于完成。L1 不承载聊天内容摘要。
- **L2 双 Thread 阅读**：主 Chat 保持 canonical thread；第二 Chat 可在 related set 中动态
  选择另一条 thread。两边都复用 canonical message renderer、独立滚动并保留各自阅读位置，
  不复制消息、不截断原文、不生成隐式摘要。
- 出生证（origin/placement/reporting contract）与状态解释作为轻量 context/inspector，
  不能占据第二 Chat 的内容位置，也不能与左侧关系导航重复堆叠。
- 只对 internal-archive/soft-delete 的 thread 自动折叠；自然语言 final、invocation done、长期
  不活跃都不能作为完成证据。
- F246 Phase J 尚暂停：v1 不建 predecessor wake、reporting subscription 或第三方 watcher；
  未来若 owner 落地稳定 read model，由独立 follow-up 评估接入；不预埋平行 trigger。

### Phase D: L3 Birdseye Navigation & Boundary

- F252 Birdseye 继续只消费 F233 `FeatTrajectoryProjection`，维持 KD-5
  “一套真相源”。F277 只增加从 thread 页面进入/返回 Birdseye 的导航路径。
- 若未来需要把 `declaredWorkMode` 或 `branchAudit` 表达成 Birdseye 新边，必须先由
  F233 owner 增加 canonical collector/projector kind，再由 F252 渲染；F277 projection
  不直接旁挂进 Birdseye，也不定义冲突优先级。
- 只表达显式因果；round-trip、mention-reply、ping-pong 等“协作边”仍保持 F252 OQ
  open，不在展示层启发式猜。
- F233 OQ-7 的全景网络图仍归 F233 Phase D 候选；F277 只提供 thread ↔ Birdseye
  导航，不向 Birdseye 提供第二份 projection，也不另造全景图产品。

## User Journey

### Primary Journey: 保留主线，同时阅读另一条相关 thread

- **Scope unit**: thread attention cluster
- **Actor**: You
- **Entry**: 正在主 thread 中对话，相关 thread 正并发运行。
- **Flow**:
  1. 左侧显示当前 thread 的相关集合及真实状态，You 先判断哪条值得看。
  2. You 打开第二 Chat；主 Chat 的草稿、滚动位置与上下文保持不变。
  3. 第二 Chat 完整呈现所选 thread 的 canonical 消息，长消息正常滚动，不显示二手摘要。
  4. You 在第二 Chat 顶部切换另一条相关 thread；各 thread 的阅读位置独立保留。
  5. 关闭第二 Chat 后 Workspace 与主 Chat 布局恢复；只有追历史关系时才进入 Birdseye。
- **Success evidence**: 同一长消息 fixture 的三种承载方式、最终桌面/窄屏原型、键盘路径、
  operator UAT 录屏；You 能同时阅读主/支 thread，并在切换/关闭后继续原对话而不丢位置。
- **Non-goals**: 全局力导向图作为首页、AI 自动总结 thread 正文、从文本猜关系或终态、
  用 thread 代替 managed work、新 graph database、通用 Experience Runtime/PDL、自适应
  布局平台、v1 新建跨 thread 唤醒协议、扫描 custody/coordination 全量数据来拼第一屏。

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | proposal | 猫 + You | F128 提议新 thread → 声明/修改 placement mode → 批准后双方看到同一出生契约 | proposal + context fixture |
| S2 | thread | You | source=A、parent=B → 出生证回报到 A，Sidebar 挂到 B | re-root screenshot + contract test |
| S3 | legacy thread | You | 无可靠 provenance → 显示 unknown/orphan，不伪装 standalone | projection fixture + screenshot |
| S4 | managed work | 猫 + You | 同一 F275 work 跨 thread 移动 → F277 不重铸 work、不凭 placement 宣布完成 | cross-feature boundary test |

## Acceptance Criteria

### Phase A（UX Design Gate）

- [ ] AC-A1: 在真实三列页面中产出“Workspace 让位 / 中央双 Chat / 临时第四栏”三种可操作
  原型，均使用包含一屏长消息的同一 fixture，并覆盖打开、切换、关闭与布局恢复。
- [ ] AC-A2: 逐方案对比“同时阅读增量、主 Chat 连续性、Workspace 冲突、宽度、判断税、
  窄屏退化”，并记录最终选择或组合的取舍。
- [ ] AC-A3: Design Gate 归档完整 `design-in-context` 与
  `in_context_observability` 决策字段，明确监看/阅读边界、canonical content renderer、
  focus/scroll/draft 保持与 Workspace 归属。
- [ ] AC-A4: operator 对实际 wireframe/Pencil 原型给出 signoff；在该证据前无生产行为代码进入
  F277 实现分支。

### Phase B（Canonical Inputs → Rebuildable Projection）

- [ ] AC-B1: `declaredWorkMode` 在 F128 schema、proposal、approve override、Thread 持久化、
  上下文注入中逐字段闭合；`unknown` 仅由投影产生，不对猫/operator开放选择。
- [ ] AC-B2: 新 branch 持久化 `parentThreadId + branchAudit` 三字段；重建得到
  `mechanism=message_branch`；rebuild 前后逐字段一致；legacy 无证据不伪造关系。
- [ ] AC-B3: projection 仅从 Thread + 直接 birth records（Proposal/proposalAudit/
  branchAudit）重建且没有新增 durable graph store；corruption/rebuild fixture 逐字段
  相等。L1 请求的读成本随已列出的 thread 数线性增长，只允许 direct-id/batch birth
  lookup，禁止扫描 message、DispatchProposal 或 ActionSuccessor 全量集合。
- [ ] AC-B4: source=A/parent=B fixture 同时证明 origin 回报到 A、placement 挂到 B，任何单
  `upstreamThreadId` 表达都被 contract test 拒绝。
- [ ] AC-B5: F277 不创建/推断 `workId`，不复制 custody/lifecycle；与 F275 同 thread
  多 work、work 跨 thread 的 fixtures 均保持 truth owner 分离。

### Phase C（L1 + L2 Daily Attention Surfaces）

- [ ] AC-C1: 使用 Phase A 获批形态后，You 可从 related set 区分 active、needs-user、
  显式收尾与 unknown，并把任一相关 thread 打开到第二 Chat。
- [ ] AC-C2: 只有 internal-archive/soft-delete 自动折叠；invocation done、长期不活跃、自然语言
  final 均有负向回归测试，不能触发完成态。
- [ ] AC-C3: 主/第二 Chat 均复用 canonical message renderer；真实一屏长消息完整可读，
  不存在截头/截尾/隐式模型摘要；切换 related thread 后各自 scroll position 保持。
- [ ] AC-C4: 打开/切换/关闭第二 Chat 不丢主 Chat draft、scroll、selection；Workspace 按
  Phase A 契约让位并可恢复。桌面、窄屏、键盘与读屏均有行为测试与视觉证据。

### Phase D（L3 Birdseye Navigation & Boundary）

- [ ] AC-D1: Birdseye 仍只消费 F233 `FeatTrajectoryProjection` 的显式边，并能从 graph
  node 一跳进入 canonical thread；F277 未注入第二数据源或 collaboration heuristic。
- [ ] AC-D2: Thread 内一跳进入相关 Birdseye 历史视图，返回后保持当前 thread 与导航状态；
  有桌面/窄屏 UAT 证据。
- [ ] AC-D3: F233 Phase D 仍是全景图 owner；任何新增 relation kind 先进入 F233
  collector/projector，F277 API/DTO 不复制其 trajectory store 或 ball-custody truth。

## 机制选择

| Claim | 选中机制 | 验证证据 / consumer |
|-------|----------|---------------------|
| origin/placement/work mode/branch provenance 的确定契约 | schema + contract/state tests | Phase B fixtures |
| lifecycle 不能靠 liveness 或自然语言猜 | negative guard tests | AC-C2 |
| 第一屏是否真正减少逐条点开与误读 | Phase A 设计比较 + operator alpha UAT | You signoff / Phase C vision guard |

## Tips Contribution（F244）

- [ ] UI 稳定后新增 1 条 tip：何时使用注意力簇/出生证，以及 unknown 为什么不是错误。
- [ ] tip 的 `sourceRef` 指向 F277 用户旅程或最终交互文档，不能只复述 feature 标题。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “不方便一个个关注”——相关 thread 先告诉我该看哪 | AC-A1/A2, AC-C1 | prototype comparison + alpha UAT | [ ] |
| R2 | 不知道 thread 关系与来源 | AC-B1/B2/B4, AC-C3 | contract tests + screenshot | [ ] |
| R3 | A 当 B 是支线，B 却把 A 当主线 | AC-B1/B4, AC-C3 | re-root/reporting fixture | [ ] |
| R4 | 并发时同时看主 thread 与另一条 thread，右侧可按需切换 | AC-A1/A2, AC-C1/C3/C4 | long-message dual-chat UAT | [ ] |
| R5 | “UX 的设计才是非常关键的吧？” | AC-A1/A2/A3/A4 | design gate evidence + operator signoff | [ ] |
| R6 | 与 F275 `workId/attemptId` 不打架 | AC-B5, AC-D3 | cross-feature boundary tests | [ ] |
| R7 | 长消息不能擅自截头/截尾或让小模型总结冒充原文 | AC-A1/A3, AC-C3 | canonical renderer + negative tests | [ ] |

### 覆盖检查

- [ ] 每个需求点都映射到至少一个 AC。
- [ ] 每个 AC 都有 test、截图、录屏或 operator signoff 证据。
- [ ] 前端需求完成需求→证据映射表。

## Dependencies

- **Evolved from**: F128（thread 出生、parent、reporting contract）
- **Evolved from**: F095 / F187（Sidebar 导航、分类与注意力债）
- **Related**: F193（跨 thread 通讯 effect class）
- **Related**: F167 / F246（custody、Phase J predecessor/reporting 契约；v1 不读取或复制）
- **Related**: F233 / F252（trajectory 是 Birdseye 唯一数据源；F277 只加导航入口）
- **Related**: F275（managed work identity；严格禁止由 thread topology 推断）

## Risk

| 风险 | 缓解 |
|------|------|
| 左侧分组把平行/独立 thread 说成上下级 | related set 只用显式关系事实；不以缩进树推断主从 |
| Sidebar 加更多徽章反而增加注意力税 | 监看只放最小结构化事实；窄屏退化实测 |
| 窄栏摘要冒充真实 thread 内容 | 监看/阅读硬分离；阅读只复用 canonical renderer；负向测试禁隐式摘要 |
| 第二 Chat 与 Workspace 争抢右侧空间 | Phase A 比较三种承载方式；验证焦点、宽度与关闭恢复 |
| liveness 被误当 completion | 生命周期与活跃度正交；只有显式收尾可自动折叠 |
| 图投影成为第二份 truth | 零新 store + rebuild equality + owner-boundary tests |
| operationalRefs 为了第一屏偷偷全量扫或建第二索引 | v1 整块移出；只读 Thread birth records + liveness |
| 与 F275 抢 work identity/terminal owner | `threadId` 不参与 work identity；只允许 exact ref join |
| 历史数据被猜成确定关系 | `unknown`/orphan 一等呈现；legacy branch 不回填假 provenance |
| 订阅/自动唤醒趁机扩 scope | Phase J 仍暂停；v1 只做诚实可见性，不建 trigger |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 产品是注意力导航，graph 只是下钻数据结构 | 用户痛点是“不知道该看哪”，不是“缺一张图” | 2026-07-26 |
| KD-2 | UX Design Gate 先于数据/前端实现 | 注意力层级、密度与交互选错，正确数据也会做成噪音 | 2026-07-26 |
| KD-3 | v1 仅以 Thread birth records → rebuildable projection，零新 graph store，零 operationalRefs | 避免第四套关系真相、无界反查与迁移负担 | 2026-07-26 |
| KD-4 | origin 与 placement 分开 | source/回报坐标可与 sidebar 挂靠坐标合法不同 | 2026-07-26 |
| KD-5 | `declaredWorkMode` 是 thread placement role，不是 F275 managed work | 防止 thread topology 冒充 work identity | 2026-07-26 |
| KD-6 | v1 自动折叠只认显式 thread 收尾 | Phase J TerminalEvent 尚未落地，不能拿 plan 冒充 runtime | 2026-07-26 |
| KD-7 | F233 保留全景图与 Birdseye 数据 ownership；F277 只提供导航入口 | 遵守 F233 OQ-7 与 F252 KD-5 单一真相源 | 2026-07-26 |
| KD-8 | 监看与阅读分离：监看只显示结构化事实，阅读只显示 canonical 完整消息 | 长消息无法由截头、截尾或模型摘要无损替代 | 2026-07-31 |
| KD-9 | F277 与通用动态 UX/Experience Runtime 解耦 | F277 是具体的并发 thread 产品问题，不是平台抽象验证场 | 2026-07-31 |

## Review Gate

- Phase A：operator 审真实页面内三种双 Chat 承载方式与长消息旅程，signoff 前禁止生产 UI 实现。
- Phase B：非作者跨 family reviewer 逐字段审 origin/placement/branch/projection/F275 边界。
- Phase C：targeted UI tests + browser preview + alpha operator UAT；愿景守护逐步走 Primary Journey。
- Phase D：F233/F252 owner 审 Birdseye 单一数据源、导航边界与 explicit-edge 约束。
