---
feature_ids: [F307]
related_features: [F063, F120, F131, F223, F284, F290, F299, F306]
topics: [workspace, workbench, working-set, tabs, split, sidecar, restore, multi-agent, continuity]
doc_kind: spec
created: 2026-08-26
description: "让 Chat、File、Artifact、Browser、Review 与 Agent Run 作为用户拥有的持续工作现场共存、组合与恢复，不被页面切换或后台行动静默覆盖。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-26T06:49:18Z
design_gate_claim_contracts: []
tips_exempt: "续租：本轮只移除 Gate 前误入 runtime 的 F290 半成品并冻结 F307 设计边界，不新增可操作能力；稳定产品激活后再添加 capability tip。"
---

# F307: Composable Workbench — 用户拥有的多上下文工作台

> **Status**: spec / operator Experience + Architecture Design Gate
> **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol)
> **Priority**: P1
> **operator kickoff**: `[thread-id]` / `0001787725879344-000406-1920e263`
> **Landing authorization**: `0001787726647893-000424-abdf8a06`

Architecture cell: `hub-action-surface`

Map delta: `update required`

Why: 当前 cell 已登记 Workspace 导航、Preview、rich block 与 F284 右侧上下文 Workspace，却把全局
typed working set 的 ownership 错挂在 F284/F290 关系上。F307 将 application-level Workbench 的
layout topology、working-set lifecycle 与恢复纪律归到一个共享 owner；F284 继续拥有 contextual
Workspace v1，F290 继续拥有 Collective 领域对象，F063/F120/F299 等继续拥有各自 surface 的内容
和生命周期。

## Why

Clowder AI 现在的主交互仍是 Chat + 一个右侧 Workspace 槽位。文件、Browser、Review、Artifact 和
Agent Run 只能轮流占据这个槽位，用户一切换页面，就很难确认原来的草稿、选择、滚动、执行状态
和结果去向是否还在。多人 Collective 也遇到同样问题，但这不是 Collective 独有的问题：单人在
自己的 Café 里同时让多只猫工作，也需要保存、比较和恢复多个工作现场。

因此本 Feature 的价值不是“加一排 tab”，而是让用户真正拥有自己的 **working set**：人选择哪些
工作现场继续在场，猫可以在后台持续行动，双方围绕同一批可追溯对象协作。tab、split、sidecar
只是这个所有权关系的投影，不是产品目标本身。

operator 对拆分的定论是：

> “这个本质其实是 Workspace 的又一次升级……我们要把这个立项理清楚之后，重新回到我们的
> F290，双方解耦。”

## Current State / 立项基线

| 证据 | 已成立的事实 | 不得冒充的结论 |
|---|---|---|
| F284 | 已落地 contextual 右侧 Workspace v1：稳定入口、单一焦点、Activity 与按需详情 | F284 v1 不是全局多上下文 Workbench |
| [PR #3974](https://github.com/zts212653/clowder-ai/pull/3974) exact `ae6a623cf9e19f88089dc95682233d1f87026319` | 历史上曾把 F290 working-set 原型挂进真实 Workspace | operator 于 2026-08-26 明确否决该产品面；runtime surface、独立 persistence 与一级 Workspace mode 已删除，只保留 Git 历史作为反例证据 |
| [PR #3981](https://github.com/zts212653/clowder-ai/pull/3981) exact `4224d006c1af599d095b506bd578c6847bfd3df1` | 分支曾探索 typed surface、working-set 恢复、Agent Run tab 与结果回链 | 它是被否决方向的原型证据，不是 F290 交付、F307 Gate 通过或既定 merge 路径；不得合入或从其继续堆 UI |
| [F063](F063-hub-workspace-explorer.md) / [F120](F120-hub-embedded-browser.md) / [F299](F299-workspace-invocation-trajectory.md) | File/Code、Browser、运行轨迹已有真实 owner 与产品路径 | F307 不接管编辑器、Browser、Agent runtime 或领域数据 |

## Product Thesis — Workbench，不是 Tabification

一个 surface 进入 Workbench，需要同时满足四个关系：

1. **对象是谁**：`surfaceType + objectRef` 指向 owner 的 canonical object；
2. **谁保存内容状态**：`ownerStateRef` 仍由 File、Browser、Collective、Agent Run 等领域 owner 持有；
3. **谁保存排布状态**：F307 只保存 tab / split / sidecar / order / pin / active / restore 拓扑；
4. **谁决定关闭后果**：关闭视觉宿主不等于删除对象、终止运行或丢掉历史，除非 owner 的显式
   close contract 如此定义。

Workbench 是 application-level 的共享工作层。它同时服务个人 Café 的单人多 Agent 工作与
Collective 的多人多 Café 多 Agent 工作，不要求两个世界复制两套 shell，也不把两个世界的权限、
对象或记忆混成一份。

这里的 **Workbench 就是现有 Clowder AI 右侧 Workspace 本体的升级方向**，不是 Workspace launcher
里再出现一张“共同工作集”卡，也不是用户先进入的独立页面。现有左侧对话列表和中间 Chat 是
真实 shell 基线；F307 只让右侧 Workspace 从一次只能容纳一个对象的槽位，成长为用户拥有的持续
working set。

## Product Boundary

### F307 包含

- 一个权威 working-set owner：typed tabs、active surface、split、sidecar、order、pin 与 restore。
- surface descriptor / renderer bridge：领域 owner 提供对象引用、标题、能力和生命周期回调。
- Chat、File/Code、Browser、Terminal、Artifact、Topic、Review、Roadmap、Agent Run 等异质 surface
  在同一 Workbench 中共存的宿主契约。
- 用户动作与后台事件的焦点纪律：后台更新不得静默替换 active surface；需要人判断时通过 Activity
  或明确 reveal 请求进入视野。
- 桌面 split、窄屏 stack / full-screen host 与 fold / reopen 使用同一 working-set truth。
- 从 F284 右侧 Workspace 状态迁移、坏持久化 fail closed、悬挂 objectRef 安全降级与可恢复验证；
  被否决的 F290 prototype state 不迁入未来 Workbench。

### F307 不包含

- F290 的 Collective、Membership、Channel、Roadmap、Artifact lineage、权限或团队记忆。
- F284 v1 的全部产品重写；F284 是现有 contextual Workspace 入口和迁移基线。
- 富文本/代码/Office 编辑器内核、Browser/Terminal 生命周期、Agent runtime、connector 或 Skill runtime。
- 把所有页面机械塞进 tab，或用预设 tab、头像/presence、独立 `/dev` 壳冒充产品整合。
- 在现有 Workspace 内再注册一个“共同工作集”模式或入口，把整体容器错误地降成容器里的功能卡。
- 让关闭 tab 隐式删除文件、终止 Agent run、关闭 Browser session 或撤销领域承诺。
- 在没有真实产品入口、非 fixture 行为与恢复证据时宣布“可组合工作台已完成”。

## Ownership Contract

| Owner | 拥有什么 | 通过什么接入 F307 |
|---|---|---|
| F307 | working-set identity、layout topology、tab/split/sidecar、焦点与恢复纪律 | `WorkspaceSurfaceDescriptor` + host reducer/store |
| F284 | contextual 右侧 Workspace v1、稳定召回、Activity 与旧状态迁移来源 | launcher / entry adapter；不再拥有全局 working set |
| F063 / F120 / F299 | File/Code、Browser、Invocation/Agent trajectory 的内容与生命周期 | descriptor、renderer、owner state、close/reveal callbacks |
| F290 | Collective 世界、Channel/Topic/Artifact/Roadmap、lineage、权限和 result target | Collective surface descriptors；不写 layout persistence |
| F223 | capability surface registry 与发现/执行契约 | 注册与能力解析；不保存 working set |

## User Journey

Scope unit: **一个用户跨 Café / Collective 持有的 application Workbench**。

1. 用户在正常 Clowder AI Thread 的 Chat 中开始，不先进入独立 demo 页面。
2. 用户打开一个真实 File，再打开一个 Artifact；Chat、File 与 Artifact 都留在同一 working set，
   新对象不静默覆盖当前阅读现场。
3. 用户从 Artifact 打开 Review 并与正文 split；启动一个非预写 Agent Run 后离开该 surface，运行继续，
   状态可以召回，结果回到 exact Review / Artifact。
4. 用户通过全局 rail 从个人 Café 进入 Collective，在同一 Workbench 打开 Channel、Roadmap 或
   Collective Artifact；F290 提供对象与权限，F307 只安排宿主。
5. 用户切换 Thread、折叠 Workspace、改成窄屏或刷新；合法 surface、layout 与 owner state 恢复，
   坏 owner payload 或悬挂对象只降级该 surface，不把整个 Workbench 打崩。
6. 用户关闭一个 tab；视觉现场消失，但领域对象与后台运行只按其 owner 的显式 lifecycle 处理。

## Requirements Checklist

| ID | 需求 | Acceptance Criteria | 状态 |
|---|---|---|---|
| R1 | F307 是全局 Workbench 唯一 layout owner；F284/F290 不再各写 working-set truth | AC-A1, AC-A2 | [ ] |
| R2 | Chat/File/Artifact/Browser/Review/Agent Run 可由真实用户动作进入同一 typed working set | AC-B1, AC-C1 | [ ] |
| R3 | tab/split/sidecar/order/pin/restore 不复制或接管 owner object state | AC-A2, AC-B1 | [ ] |
| R4 | 后台变化不抢焦点；离开 Agent Run 后继续并回 exact target | AC-B2, AC-C1 | [ ] |
| R5 | 旧 Workspace 状态可迁移，坏 payload 与悬挂 objectRef fail closed | AC-B3 | [ ] |
| R6 | 单人多 Agent 与 Collective 两条真实旅程共用 Workbench，不复制 shell | AC-C1, AC-C2 | [ ] |
| R7 | 桌面与窄屏共享 truth，响应式变化不终止 owner lifecycle | AC-B2, AC-D1 | [ ] |

## Acceptance Criteria

### Phase A — Product and Architecture Design Gate

- [ ] **AC-A1**：operator 在真实 Clowder AI shell 中体验默认态、多个 surface、split、sidecar、Activity、
  narrow viewport 与 restore；Gate 明确 Workbench 的信息架构和状态因果，不用画出一排 tab 代替。
- [ ] **AC-A2**：`hub-action-surface` ownership map 明确 F307 是唯一 generic working-set/layout owner；
  F284 只拥有 contextual Workspace v1，F290 只拥有 Collective 领域 surface。静态 guard 能拒绝领域
  Feature 直接导入或持久化 F307 layout store，也拒绝 F307 reducer 保存领域 records。

### Phase B — Shared Workbench Kernel

- [ ] **AC-B1**：真实 host 支持 descriptor 驱动的 add / close / reorder / pin / active / split / sidecar
  promotion；至少 File/Code 与另一个非文件 surface 共存。切换不丢草稿、选择、滚动或内部 history。
- [ ] **AC-B2**：后台事件只更新 Activity 或已存在 surface；fold、host switch、responsive reflow 与
  tab switch 不终止 Browser / Terminal / Agent Run，只有显式 owner close lifecycle 可以终止。
- [ ] **AC-B3**：旧 F284 Workspace state 有一次性迁移；被否决的 F290 prototype mode / localStorage key
  明确忽略，不把假产品状态带进新 Workbench。每个 persisted descriptor 与 owner payload 逐层验证，
  malformed / dangling state 只产生可恢复空态，不造成 Workspace 崩溃或数据静默覆盖。

### Phase C — Real Surface Adapters

- [ ] **AC-C1**：从生产 Thread 入口完成非 fixture 旅程：Chat → File/Code → Artifact → Review →
  Agent Run；结果回 exact target，刷新恢复，关闭 tab 不删除对象或终止仍被 owner 保留的 run。
- [ ] **AC-C2**：从个人 Café 经 global rail 进入 F290 Collective，打开 Channel / Roadmap / Artifact；
  两个世界复用同一 Workbench kernel，而 Collective 权限、lineage 与 owner state 仍由 F290 解释。

### Phase D — Dogfood and Activation

- [ ] **AC-D1**：You 在桌面和窄屏用真实工作连续一周；记录少了多少重找现场、误覆盖和结果迷路，
  并对默认态、密度、恢复与关闭语义给 KEEP / TUNE / SUNSET。稳定前不激活 capability tip。

## Phases

1. **Phase A — Design Gate**：冻结 ownership、descriptor、焦点与恢复语义。
2. **Phase B — Kernel**：把 global working set 从领域 Feature 中抽出，迁移 F284 v1 状态。
3. **Phase C — Adapters**：接入真实 File/Code、Browser/Terminal、Agent Run 与 F290 Collective surfaces。
4. **Phase D — Dogfood**：单人多 Agent + 多人多 Agent 双旅程使用后再裁决视觉与激活。

F290 不等待 F307 全部完成。它先沿已确认的 Collective baseline 继续世界切换、Channel、Roadmap、
Artifact 与多 Café 信任闭环；需要进入 Workbench 的对象通过 adapter contract 对接，而不是让 F290
继续兼任全局 shell owner。

## Risks

1. **Tab checklist**：做出 tab chrome，却没有 owner state、restore 与 lifecycle continuity。
2. **Ownership leak**：F307 保存 Collective/File/Agent records，或领域 Feature 再写一份 layout store。
3. **Focus theft**：后台事件用“相关”作理由覆盖 active surface。
4. **Migration loss**：旧右侧 Workspace / prototype 状态坏掉时拖垮整个工作台。
5. **Responsive overload**：把桌面多列硬压到窄屏，而不是用同一 truth 投影为 stack/full-screen。
6. **Feature shell masquerade**：独立 `/dev` 页面、预设 fixtures 或单一 Artifact 被称作全产品完成。

## Key Decisions

| ID | 决定 | 来源 |
|---|---|---|
| KD-1 | 本质是用户拥有 working set，不是“多做几个 tab” | `0001787657108819-000293-94960547` |
| KD-2 | Workbench 是 application-level shared layer，同时服务单人多 Agent 与 Collective | `0001787710909760-000035-84ec26d9` |
| KD-3 | F307 拥有 generic layout/restore；F284 保留 contextual Workspace v1；F290 只提供 Collective surface | `0001787710989547-000037-10c84ac6`, `0001787725213195-000402-837bd5c8` |
| KD-4 | 各领域 owner 保留 canonical object、权限、renderer 和 lifecycle；F307 只保存 projection topology | ownership audit / PR #3981 review |
| KD-5 | PR #3981 只作为被否决方向的历史原型证据，不是 F290 交付、F307 Gate pass 或既定 merge 路径；不得继续合入 | `0001787726647893-000424-abdf8a06`, `0001787749283987-000587-960b27e9` |
| KD-6 | F290 不等待完整 Workbench；先恢复 5102 baseline 的 Collective 产品主线 | `0001787725879344-000406-1920e263`, `0001787726647893-000424-abdf8a06` |
| KD-7 | “共同工作台”就是现有 Workspace 的整体升级，不是 Workspace 内一个叫“共同工作集”的独立入口 | `0001787798861085-000028-f5e4622f` |
