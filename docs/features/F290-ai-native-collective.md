---
feature_ids: [F290]
related_features: [F044, F077, F128, F168, F195, F202, F232, F246, F254, F276, F277, F282, F283, F284, F287, F299, F305, F307]
topics: [ai-native-collaboration, multi-human, multi-agent, collective, cafe, channel, topic, asset, annotation, rich-message, task, vote, team-memory]
doc_kind: spec
created: 2026-08-08
description: "让多个独立 Café 在同一个 Collective 中围绕对话、资产、工作与关系持续协同；私人空间不被吞并，承诺、来源与团队记忆也不会掉线。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-08-10T09:24:00Z
design_gate_claim_contracts: []
tips_exempt: "续租：本轮删除被 operator 否决的 F290 Workbench runtime 表面与入口，不新增用户能力；只在 operator KEEP 且稳定 live action 激活后添加 capability tip。"
---

# F290: AI-native Collective — 多人·多 Agent 共同世界

> **Status**: spec / Experience Design Gate
> **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol)
> **Priority**: P1
> **operator kickoff**: `[thread-id]` / `0001786242747248-000502-77c148cd`

Architecture cell: `pending F290 Design Gate`

Map delta: `new cell required`

Why: 当前 ownership map 中的 `thread-navigation`、`bubble-pipeline`、`hub-action-surface`、
`approval-index`、`memory`、`transport` 等 cell 分别拥有导航、消息呈现、动作面、审批、记忆与
传输，但没有任何一个 cell 拥有“多个独立 Café 进入同一 Collective 后，公共对象、信任边界、
成员生命周期与跨家协同如何成为一份真相”的完整契约。它们是依赖，不是 F290 的替身。Design
Gate 通过前必须确定新 cell 的正式名字、边界与代码锚；本次立项不借一个旧 cell 偷跑架构决定。

## Why

Clowder AI 已经解决了 You 不必在自家猫之间充当人工路由器，却还没有解决跨真人、跨 Café 的
断裂：吴浪、社区贡献者、PR / Issue、会议结论与各自猫的执行散落在不同世界。一个高价值事项
被 You 忘记以后，组织也会跟着失忆；一只猫若在别的 Thread 冷启动，只能重新猜我们讨论过
什么。

You 对立项完成定义的原话是：

> “我们曾经的讨论，甚至包括语音转文本的各种 link、各种思考，包括未来要做的事那个 thread
> 的原本触发……都关联进去。不然未来另一只猫在别的 thread 想要冷启动……他就傻眼了。”

F290 因而不是“给 Chat 加几个团队按钮”，也不是一份最终会拆掉的 MVP。它负责建立一个终态
产品对象：**多个独立的一人多猫 Café 可以加入 Collective，在 Channel 中长期生活、表达、判断
与工作；私人 Thread 仍然属于家里，值得公开的东西通过 Living Projection 生长；人不再搬运
消息和上下文，猫也不被降成匿名工具。**

## Product Thesis — 资产代谢与社会环

Collective 的工作协同围绕**资产代谢**展开：对话是资产的重要孕育现场，资产是对话形成的
可持续结晶，猫维持对话、资产、Work、证据与团队记忆之间的活连接。完整循环不是单向的
“聊天变文件”，而是：

```text
对话 / 会议 / 外部事件
→ 候选资产
→ 阅读、批注、分歧与判断
→ 被确认的版本
→ Roadmap / Work
→ 产物与证据
→ 更新资产与团队记忆
→ 触发下一轮对话
```

资产代谢不能独占 Collective 的全部定义。人、猫、Café、Bond 与 Membership 是主体和关系，
不是资产；Channel、灵感公地继续承担共同在场、弱连接、关系生长和方向再对齐的**社会环**。
缺少资产代谢，组织热闹但失忆；缺少社会环，组织高效但没有温度。

`Asset / Artifact` 是内部统一信封，不是要求用户学习的总称。纪要、方案、Decision、Roadmap、
PR、代码、数据、Demo、视频和作品保留各自的人类语言与动作；它们共享 id、owner、lineage、
版本、权限、批注面及与 Work / 证据的关系，并按来源与生长关系组织，而不是退化为按文件类型
分文件夹的网盘。

## Current State / 立项基线

截至 2026-08-08：

| 证据 | 已成立的事实 | 仍未成立的事实 |
|---|---|---|
| 原始录音 | 两份 ASR 已有路径、说话人边界与 SHA-256 | 其中黄挺交流开头约两小时未录，不能冒充完整事实 |
| `feat/collective-experience-gate` | `91b8c38ec` 做出首支带导览前端；`9fa225fadcac85301c971d77bcff5aa2d40476cf` 画出四栏空间语法 | 第一稿被 You 明确反馈“不太是我想象中的”；低保真是 Design Gate 证物，不是冻结 UI |
| 既有 Feature | F044/F077/F128/F246/F276/F277 等提供 Channel、身份、开 Thread、判断、关系与注意力器官 | 没有一个旧 Feature 拥有多 Café Collective 的产品整体 |

因此本次状态迁移是：**方向 5 正式登记为 F290；Experience Design Gate 继续进行；未授权真实
后端、联邦协议或生产 UI 实现。**

## 2026-08-26 Scope Reset — 回到 Collective baseline

F290 的 baseline 不是右侧 Workspace，也不是一个 Artifact 编辑页。它是
跨世界旅程：用户从自己的 Café 出发，经 global rail 进入 Collective，看到该世界的目的地、
Channel、Roadmap、共同资产与成员活动；各 Café 仍在自己的信任域里执行，值得公开的结果再回到
Collective 的准确对象。

2026-08-25 至 26 的连续纠偏证明，我们把两个不同问题绑在了一起：

- **F290** 要回答“多个真人、多个 Café、多只猫怎样进入同一个共同世界并持续协作”；
- **[F307 Composable Workbench](F307-composable-workbench.md)** 要回答“一个用户怎样让 Chat、File、
  Browser、Artifact、Review 与 Agent Run 同时留在自己的工作集里”。

因此 F290 不再拥有 tab、split、sidecar promotion、layout persistence 或全局 restore。F290 只向
F307 提供 Channel、Topic、Roadmap、Artifact、Review 等领域 surface descriptor、权限投影、
lineage 和 exact result target。PR [#3981](https://github.com/zts212653/clowder-ai/pull/3981) 的
working-set、恢复与 Agent Run tab 代码保留为 F307 原型证据；它仍然 OPEN，不是 F290 交付，也不
构成 F307 Gate 通过。

“共同工作集”也不是 F290 要注册进 Workspace launcher 的产品对象。共同工作台就是现有
application Workspace 的整体升级；F290 的对象以后进入这张共享工作台，但 F290 不在工作台里
再造一个同名房间。

### 当前真正没做好的 F290 能力

1. **真实 Collective 入口 / world switch**：生产 Clowder AI 尚未把 5102 baseline 的 global rail、
   Collective destination 与返回个人 Café 的完整旅程做实。
2. **Roadmap operating model**：Roadmap 还没有成为从 Channel / Meeting / Decision 生长出 Work、
   显示依赖与历史、再回流结果的团队运行面。
3. **共同产物系统**：Asset / Artifact library、树与派生、版本、lineage、锚定批注、权限和结果
   回写尚未形成可持续的 Collective truth。
4. **真实多 Café 后端**：Membership、邀请/退出、身份与 trust boundary、离线、送达、幂等、撤权、
   冲突和 public projection 仍未实现。
5. **真实团队 dogfood**：还没有用 You + 吴浪 / 社区协作者完成从共同讨论到各 Café 执行再回流
   的端到端工作。
6. **Workbench 尚未对齐**：当前 shell 仍不是 Composable Workbench；这是 F307 的开放项，不作为
   F290 完成标准，也不阻塞 F290 沿现有壳继续验证 Collective 核心旅程。

## Stable Product Coordinate System

| 对象 | 稳定含义 | 不是什么 |
|---|---|---|
| **Café** | 一个人与其多只猫长期生活的身份、信任与委托单元 | 组织的下属账号、公共猫池 |
| **Collective** | 多个 Café、人和治理清晰的组织猫共同进入的团队世界 | 必须是公司或传统 Org |
| **Channel** | Collective 内人猫共同驻留的长期现场 | 无尽 LLM session、纯工单流 |
| **Thread** | Café 内私人生活/思考房间，或有边界的工作上下文 | 默认组织资产 |
| **Topic** | Channel 某条根消息展开的局部讨论视角 | 新的主内容世界、另一条私人 Thread |
| **Living Projection** | 从私人来源发布出的、可持续生长且保留 lineage 的公共生命 | 私人原文复制或一次性贴文 |
| **Asset / Artifact** | 可被阅读、批注、修订、引用、体验或继续接棒的版本化共同对象 | 文件附件、静态网盘条目或无来源摘要 |
| **Work / Task** | 从表达中形成、具备责任和状态的承诺对象 | 任意消息自动任务化 |
| **Vote / Decision** | Collective 的轻量意见聚合或有约束力判断；二者必须显式区分 | reaction 数量、猫替人拍板 |

品牌层保持：`clowder-ai — run your own cat café.`；Café + Bond 是世界观核心，
Collective / Channel / Thread / Living Projection 是稳定产品对象，“长桌 / 前厅 / 里屋 / 街区”
只属于可变体验语言。

## Product Boundary

### F290 包含

- Collective、Membership / Join、Channel、Topic、Living Projection、Work、Vote / Decision 的
  产品关系与生命周期。
- Café 本地 endpoint 与共享 Channel 之间的投影、离线、送达、唤醒、身份、authority 与回流。
- 给人的 AI-native IM 与给猫的 harness 作为同一个产品的两面。
- Channel 与私人 Thread 共享同一富消息语言，同时保持不同的受众、权限与隐私边界。
- 团队记忆、集体注意力、Meeting → Roadmap → 各自猫执行 → Channel 回流的闭环。
- 从受邀、观察、带 Café 入席到干净退出的成员旅程。
- 组织代谢循环与社会环：既能推进工作，也保留意外发现、共同在场与关系温度。
- Collective 对宿主提供的领域 surface 契约：Channel、Topic、Roadmap、Artifact 与 Review 保留
  objectRef、权限、lineage 与 result target；宿主如何 tab/split/restore 由 F307 决定。
- Asset / Artifact 的树、引用、派生、版本、lineage、协同锚点与 Agent patch 回写契约。

### F290 不包含

- 用临时数据模型或一次性页面冒充终态对象的 MVP。
- 把 Slack / 飞书 / Raft 的布局和功能逐项复刻。
- 把所有私人 Thread、记忆或猫的内部路由公开给 Collective。
- 把每条普通聊天自动变成 Task、审批或唤醒所有猫。
- 用预设“专家”标签替代具名猫的关系与 track record。
- 在现有 Workspace 内注册“共同工作集”模式、入口或第二套 working-set persistence。
- 把 reaction 当批准，把 informal poll 当组织承诺。
- 在 Experience Design Gate 前启动真实联邦后端、生产 schema 或迁移。
- 顺带重做单 Café 的所有上手体验；F290 只定义“带着 Café 入席”的跨域旅程。
- 自研富文本、代码、图片、视频或白板编辑器内核；F290 只冻结共同产物的稳定锚点、版本、批注、
  human edit、agent patch、accept / reject / undo 与 provenance 领域契约，renderer/editor 适配由
  对应内容 owner 与 F307 host 集成。
- 把 Action Space runtime、IM / 日历 / webhook connector、Skill 编辑器或安装运行时吞进 Collective；
  F290 只消费执行主体、权限 / 能力摘要、触发来源与 exact result-return。

## Collective Entry and Host Contract

F290 只冻结 Collective 世界本身所需的空间关系：

1. **Global rail**：世界切换器，包含个人 Café、已加入的 Collective 与全局 `需要我`；
2. **Collective destination**：当前 Collective 的 Channel、Roadmap、资产库、成员与固定入口；
3. **Collective scene**：Channel、Roadmap、Artifact、Topic、Review 等领域对象及其权限/lineage；
4. **Host adapter**：F290 把这些对象交给当前产品宿主；若宿主是 F307 Workbench，tab / split /
   sidecar / restore 全由 F307 决定，F290 不写第二份 layout truth。

Topic 的领域关系保持稳定：它必须锚定 Channel 根消息、复用同一消息与 lineage，关闭或换宿主不
创建第二种 Topic。Topic 默认呈现在哪里、能否晋升 tab/split，是 F307 的宿主策略，不再是 F290
本体契约。

### 双向望窗：能望见另一个世界，但不把两个世界混成一个

- 人在 Collective / Channel 时，右栏可打开**我的 Café 窗**：只显示与当前现场有关、经过权限
  过滤的自家动态、Work 状态与待判断摘要，不搬运私人 Thread 原文。
- 人在 Café / 私人 Thread 时，右栏可打开**相关 Channel 窗**：显示相关公共讨论、Living
  Projection 反馈、承诺与请求的摘要，不把完整 Channel 复制成第二套 IM。
- 望窗限制的是“看”的密度，不限制“说”的长度；从窗内发言会正常进入另一边。正式认领、批准、
  授权变更等签字类动作必须进入对象所属的完整现场、读到足够证据后再确认。

双向望窗及上述信任边界是 F290 已确认的跨域关系；摘要密度、进入动作、back-stack 与窄屏形态
由宿主 Design Gate 验证。

## What We Learned from Agent Workspaces — 结论路由到 F307

2026-08-25，operator 把 Clowder AI 当前单槽 Workspace 与 Codex、Floatboat 等真实 Agent 产品并排
观察。外部资料来自各产品的一手页面，只能证明其公开设计与能力，**不能证明它们天然优于我们**；
以下结论来自多家独立产品的结构收敛、operator 实际使用截图与 F290 连续失败的交叉推断。

| 观察 | 与 Clowder AI vision 的关系 | 正确 owner / disposition |
|---|---|---|
| Codex / Cursor / Devin 把 Chat、File、Browser、Terminal、Review 等异质 surface 放进可组合工作区 | 符合 W8：人猫共同面对工作对象，而非只交换回复 | **F307**：typed working set、split、restore；不照抄 IDE 皮肤 |
| 多个 Agent run 可并行，离开当前 surface 后仍继续，结果回到任务 / diff / 文件 | 符合“猫是 Agent”与可追溯回流 | **F307 + runtime owner**：运行连续性与 exact result-return；F290 只定义 Collective target |
| Floatboat 在同一 living document 中同时允许人直接改、精确批注与 Agent 改写 | 符合资产代谢：对话不是产物的替身 | **现在冻结 adapter 契约**：human edit + anchor + agent patch + confirm + version / provenance |
| 工作区可开多个 tab、保留上下文并按需分屏 | 符合用户拥有注意力与工作集 | **F307**：application-level Workbench；F284/F290 都不重复造壳 |
| Agent Action Space 聚合 IM / webhook、目录、技能与活动 | 能解释一次动作由谁、以什么权限执行 | **只消费最小投影**：actor、capability / permission summary、triggerRef、resultTarget；runtime / connector 仍由其 owner 负责 |
| 一次成功工作可被整理成 Skill | 符合团队能力从实践中生长，但“成功一次”不等于通用 | **后置**：F290 可呈现 `episode / artifact lineage → candidate skill → human confirm`；Skill 编辑器、安装、权限与真实复用归 Skill / Action Space。首条 dogfood 不因它扩 scope |

### 外部一手证据（2026-08-25 读取）

- [OpenAI: Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)：项目内多线程、
  并行 Agent、diff review 与 app / CLI / IDE 连续性；
- [OpenAI Help: built-in browser](https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app)：
  一个任务中打开多个 browser tab，并对页面精确标注；
- [Cursor 3.0](https://cursor.com/blog/cursor-3)：multi-agent sidebar 与 diff / file / browser 的统一工作区；
- [GitHub Copilot agent sessions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)：
  多个隔离 session 按 repository 组织并可并行存在；
- [Devin session tools](https://docs.devin.ai/work-with-devin/devin-session-tools)：shell、IDE、browser
  共存与 human takeover；
- [Floatboat Flow Mode](https://floatboat.ai/zh/blog/introducing-flow-mode)：同一文档里的手动编辑、
  Agent 改写、批注与会议产出。

这些学习现在拆成两类：F290 保留 Asset/Artifact 的 human edit、SelectionAnchor、annotation、
agent patch、版本与 provenance 领域契约；F307 与内容 owner 负责 CodeMirror、BlockNote、Lexical、
ONLYOFFICE 等 editor/renderer 如何进入真实 Workbench。详见
不再是 F290 当前 Phase A 的实现决定。

## Visual Weight Grammar（2026-08-09 Gate 1 v2 审美收敛）

一条公理统摄画面规则（ADR-043 C2 出生证不变量在视觉层的镜像）：

> **每一克视觉重量都要有语义付款人。** 元素的显眼程度必须正比于其语义重量；付不出
> 语义的重量（底板、胶囊、粗字、强调色）一律拆除。

四级付款人（从重到轻）：

1. **需要人行动**（Approval / Judgment / binding Vote）——可临时获得最高视觉重量；
2. **可拿走使用的产物**（PDF / Demo / 设计稿 / 代码版本）——紧凑可打开的产物卡；
3. **状态陈述**（Task 进行中、回复数、在场）——纯文本 + 小圆点级；
4. **元数据**（来源、身份、时间、标签）——muted 纯文本，永不占底板。

执行规则（Kimi 五根因实测诊断 + Maine Coon产物判据的收敛，全文见线程
`0001786259862540-001149` / `0001786262324014-001157`）：

- **纸与铅笔印**：内容直接躺在画布上；底板与边框只给第 1/2 级付款人；盒中盒禁止；
- **胶囊与色彩预算**：pill 基本只给 reaction；一屏语义强调色 ≤3 处；
- **动作跟意图**：对象上的动作（表情/回复/更多）hover 才浮现；reaction 有计数才占位；
- **hover 的边界**（防 ADR-043 C7 极简失联）：hover 只藏**对象上的动作**，不藏**世界的
  入口**——导航、搜索、需要我永远可见；hover 隐藏的动作必须有触屏/长按等价路径；
- **动效纪律**：安静是基线，动是事件——状态变化用最小淡入，禁止常驻 pulse/闪烁；一屏
  会动的元素必须比静的少一个数量级；
- **字重纪律**：小号字（≤12px）一律 400/500 字重；eyebrow 大写加字距降级或删除；
- **右栏低一个声调**：底色与中栏一致、排版密度更轻——它是耳语，不是第二个嗓门；
- **温度来自生命迹象**：贴贴感靠 presence（谁在、猫在干嘛、最近脚印），不靠暖色贴纸与
  装饰图形；暖米画布是家的资产，保留。

语义皮肤对照（互不共用）：**reaction** = 计数 pill；**Task** = 左 accent 竖条 + 标题 +
一行灰 meta；**产物** = 图标 + 文件名 + 格式的紧凑卡；**Approval / binding Vote** = 带
行动按钮的高重量卡；**claim** = 纯文本状态行。

审美参照的边界：Slack / Raft / GenTeam 提供**呼吸节奏判据**（progressive disclosure、
色彩预算、产物卡），不提供审美目标——学它们的呼吸，不学它们的脸；Clowder AI 的脸来自
自己的画布与 taste 体系（F221）。

## Asset Collaboration Layers（2026-08-24 收敛，operator "很好" 确认）

资产页由四层构成，缺一层协同就退化（外部输入：刘赫伟"比 diff 更深一层"之问 +
operator "还得有团队协同的记录"，`0001787558675982-000004`）：

| 层 | 回答什么 | 载体 |
|---|---|---|
| **结果层** | 当前版本是什么 | 资产正文 |
| **变更层** | v(n-1)→v(n) 改了什么 | diff / 版本历史 |
| **对话层** | 大家说了什么 | 批注 + Topic |
| **轨迹层** | 这个版本怎么被决定出来的 | **协同时间线**（新增） |

**协同时间线 = 纯投影，零新对象**：把资产八步 Gate 既有事实（批注 → 修改提案 →
接受 / 部分接受 / 保留分歧 → 新版本）按因果串成可点回原文的时间线。双重身份：
**对人是审计线**（结论怎么来的），**对猫是学习材料**（团队记忆与自进化的食物——
组织代谢循环"进入团队记忆并修正自身"的实现层；F299 单猫 invocation 轨迹的
Collective 升维）。UI 文案叫"协同记录 / 历程"，"轨迹层"是设计词不上屏。

配套两条：① 资产页内**读 / 改 / 聊三态微地貌**（阅读=纸感安静、编辑=工作边框
焦点、批注对话=对话密度）——Terrain Grammar 的页内应用，解"全是一样的线框、
不知道自己在干什么"（operator `0001787547580643`）；② **UI 实现一律消费 F305
UI Design Gate 的共享设计与组件**，不再自造视觉——"像家"从手调变为结构性继承。

### Asset Collaboration true-frontend contract（2026-08-25 operator 纠偏）

2026-08-25 第一版 `/dev/f290-asset-collaboration` Alpha 只能切换预写好的阅读、审阅与批注画面：
批注占位是 `span`，发送、接受与保留分歧按钮没有行为，右侧记录也不会因用户动作生长。此前
以截图和模式切换给出的视觉 KEEP 作废；根因不是间距，而是交付物类型做错了。

随后 PR [#3945](https://github.com/zts212653/clowder-ai/pull/3945)（merge
`11dc4c9d598eee127f878b709026bfca5fec1fd8`）把该切片改为**真实前端、模拟后端**：fixture
只提供起点，用户编辑、批注、讨论、disposition 与历程由真实输入和事件处理产生，并保存在
当前浏览器。这个 landing 证明 Artifact surface 的局部 true-frontend contract，**不证明
Composable Workspace、Channel 汇聚、多人实时或 F290 umbrella 已完成**。

#### 一眼看懂的工作面

- 中央始终是**当前产物本身**；阅读是默认态，`编辑` 是对产物采取的动作，不再把
  “阅读 / 审阅修改 / 批注”做成三个平级世界。
- 右栏是跟随当前焦点的上下文工作面，只保留三个用户词：
  - **批注**：绑定到一段原文或一次文本选择；回答“大家对这里说了什么”。
  - **讨论**：绑定到整个产物；回答“还有哪些不属于某一段的协作对话”。
  - **历程**：由真实动作自动形成；回答“这个版本怎样走到今天”。
- 选中原文或点击段落旁的“批注”后，右栏直接打开该段批注；点击“讨论”打开全局对话；
  点击历程中的记录返回对应原文、批注或版本。右栏不是成员档案，也不是静态信息仓库。
- 当前状态必须用用户能行动的语言表达，例如“有 1 处修改等你确认”“这一段有 2 条批注”，
  不显示 `canonical`、`projection`、`inspector`、`judgment gate` 等内部设计词。

#### Alpha 必须真实完成的动作

1. **编辑产物**：点击编辑后，正文进入真实可输入状态；保存会更新正文、版本与修改时间，
   并追加一条可回看的历程记录。
2. **逐段批注**：从具体段落或选中文本发起；输入、发送、取消都可用。发送后新批注立即出现，
   数量更新，历程新增记录；空内容不能提交。
3. **围绕产物讨论**：讨论输入框可聚焦、输入和发送；新消息立即出现在对话中，并保留
   speaking-as 身份。讨论不伪装成逐段批注。
4. **处理修改建议**：接受会把建议真正写入当前正文；保留分歧会保持正文不变。两种结果都要
   关闭待处理态、记录决定与理由，并追加历程。
5. **状态连续**：在批注、讨论、历程与正文之间来回切换不丢当前选择、草稿和滚动位置；刷新后
   仍能恢复本次 Alpha 中产生的数据。开发层可以提供“重置演示数据”，但默认产品面不展示。
6. **诚实边界**：Alpha 不接生产后端，不承诺跨浏览器或多人实时同步；界面只需低声说明
   “本次体验数据保存在此浏览器”，不能因此把输入和状态变化做成假的。

#### 行为守卫（截图不能替代）

以下旅程必须由自动化测试和真实浏览器操作共同验证；只测按钮、文案或预设画面存在不算通过：

- `输入并发送批注 → 批注正文、数量与历程同时增长`；
- `输入并发送讨论 → 消息以当前身份出现，逐段批注数量不变`；
- `编辑正文并保存 → 正文和版本变化，刷新后仍存在`；
- `接受修改建议 → 建议落入正文、待处理态消失、历程记录决定`；
- `保留分歧 → 正文不变、理由可回看、待处理态消失`；
- `历程记录 → 能返回产生它的原文 / 批注 / 版本，而不是只切换一块说明文字`。

产品体验 Gate 的灵魂测试改为：**不给讲解，只给一个可运行页面；第一次看到它的人能否亲手
修改一段正文、发送一条批注和一条讨论，并从历程回到其中任一动作。** 任一步不可操作，整稿
判 TUNE；截图好看、单元测试全绿或预设状态齐全都不能覆盖这个结论。

这张 true-frontend Alpha 已证明一个 **Artifact surface** 的局部交互，不等于 F290 Product Shell。
后续 Gate 必须从 Channel / Destination 的真实入口打开同一 Artifact，并保留它与来源 Channel、
关联 Topic 或 Review 的领域关系；是否以 tab / split 共存由 F307 验收。不得再把单页截图称为
“最新 F290”。

### Pluggable renderer / editor 与 SelectionAnchor

F290 的差异化在资产树、lineage 与协作契约，不在重造编辑器。文本首期优先集成成熟开源编辑器；
图片、视频、代码、画布和数据各自由 renderer / editor adapter 提供选择与呈现。统一接口至少承载：

```text
artifactId + baseVersion + anchorType + locator
+ annotation / intent + actor + timestamp
```

`anchorType + locator` 按媒介实现：文本 range / block、图片与画布 bbox / element、视频 frame /
timeline segment、代码 file + range + revision、流水线 node、数据 field / row-set。adapter 必须支持
human edit、稳定 SelectionAnchor、annotation、agent patch / diff、accept / reject / undo 与 provenance
回写。选择编辑器先验证“正文变化后锚点是否稳定”“猫的 patch 能否审阅后原位落回”，不按工具栏
功能数量选型。

一次 living artifact 动作可消费 Action Space 的最小执行投影：`actorRef`、`capability / permission
summary`、`triggerRef`、`resultTarget(artifactId + baseVersion + anchor)`。IM、日历与 webhook 是入口，
不是事实真相源；连接器、目录授权、Skill runtime 与安装生命周期不由 F290 实现。

## Channel Interaction Grammar

顶层期待契约是：**表达允许沉默；请求不能假装被接住；承诺不允许失踪。** 分享与玩笑无需
强制回应；提问、邀请与请求必须让“尚未被接住”可见；一旦形成承诺，就进入责任、状态与回流
账本。这条语义先于具体的投递、关注、唤醒、入上下文与处理五层机制。

### Shared rich language

私人 Thread 与 Channel 复用同一个 message / rich-block substrate：

- 交互式 Markdown 与引用；
- 图片、文件、语音与录音转写；
- HTML / Artifact / Demo 预览；
- Approval / Judgment、Task、Roadmap、Living Projection 与 Vote 卡；
- 原消息、来源、作者、speaking-as 与 authority 的可追溯关系。

**能力不按作者物种分配。** 人类输入框默认简单，通过 `+` 渐进展开语音、图片、文件、卡片和
模板；猫可以自然产生适合内容的丰富表达。人可以发富消息，猫也可以发普通文字。Channel 与
私人 Thread 的差异来自 public audience、permission、identity / provenance 与信息密度，不是
“人只能简单、猫才能高级”。

### From message to Task — no modal

1. 人或猫先用自然语言表达；原消息永远保留为消息。
2. 明确勾选“作为任务”时，由当前负责处理的猫理解语义并生成一张与原消息相连的持久 Task 卡，
   不要求人填写标题、owner、优先级等弹窗表单。
3. 缺少真正阻止承诺成立的信息时，猫在卡内用最少问题补齐，而不是让人重抄一遍。
4. 没有明确勾选时，猫可以主动提出
   `[创建任务] [先继续讨论] [不用跟踪]`，并说明为何值得跟踪；没有 authority 时不得静默替
   Collective 形成承诺。
5. Task 成立后仍能追溯到原消息、Topic / Channel、责任猫与 accountable human；进展以卡片或
   projection 回流，不把施工日志刷满 Channel。

### Low-friction Vote

Vote 是 Collective 的一等互动，不是当前高摩擦表格的复制：

1. 人先自然表达“大家选 A 还是 B”；猫把上下文整理成可编辑的紧凑 Vote 卡；
2. 发起人只需确认选项、截止与“随手问问 / 会形成决定”，不填写一大堆字段；
3. 参与者在消息流里一键投票，卡片原位显示仍在收集 / 已结束与结果；
4. informal poll 只表达偏好；binding vote / approval 必须显式展示 eligible voters、规则、
   authority、provenance 与结果去向；
5. 有约束力的结果可以生成 Decision / Roadmap 节点，不能靠 reaction 数量暗中升级。

### Two collaboration entries, one lineage

Channel 回复和资产批注都是协同，但不合并成两套聊天真相：

- **Channel 回复**锚定共同现场与根消息，适合发散、交换看法和召集参与者，回答“大家怎么看”；
- **资产批注**锚定 asset id、版本和具体位置，适合质疑、补证据与请求修改，回答“这里哪里要变”；
- Channel 回复可以引用资产；资产批注可以展开 Topic；二者通过 exact lineage 相连，不复制正文、
  不静默互相升级；
- 猫可以恢复外部聊天反馈与资产的关系、提出候选修改，但没有 authority 时不能直接改写 canonical
  版本或把评论冒充组织决定。

### Reactions and identity cards

- Reaction 是低成本的社会信号（看见、共鸣、好笑、担心），不等于批准、认领或投票。
- 点击人或猫头像在右栏打开成员卡。猫卡优先显示具名身份、所属 Café、accountable human、
  speaking-as、track record 与当前公开状态，而不是先暴露 runtime 配置。
- 表情、贴纸、语音与富内容不是装饰性次要需求；它们承担共同在场、情绪带宽与人类可读性。

## User Journey

### J1 — 私人灵感变成公共生命

You 在私人 Thread 与猫把想法聊清楚 → 猫主动邀请发布 → You 确认表达 → Living
Projection 出现在 Collective → Channel 讨论、猫爪、会议、原型、Roadmap 与成果沿它积累，
私人原文留在 Café。

### J2 — 社区 PR / Issue 不再被遗忘

贡献进入 Channel → endpoint 猫按各 Café 的关注判断 → 高价值但未成熟的事项留在前瞻记忆 →
自然断点重新浮现 → 人或猫形成 Work → 结果回流原贡献者与 Channel。

### J3 — Meeting → Roadmap → 各自猫执行

会议 ASR 与团队历史共同进入理解 → 猫补出认知缺口与候选决定 → 人确认承诺 → Roadmap 分解到
各 Café → 自家猫在私有 Thread 执行 → 必要进度、判断点、产物与证据回流 Channel。

### J4 — 在 Channel 里从聊天长出工作

成员在 Channel 自然对话 → Topic 在右栏展开 → 某条消息勾选“作为任务”或猫主动建议 → 猫生成
linked Task card → 责任与 accountable human 可见 → 施工离开公共消息流，结果再回来。

### J5 — 从受邀到把自己的 Café 带进 Collective

新人收到邀请 → 先观察公共世界 → 接引猫用人话完成权限、endpoint 与上下文配置 → 新人带自己
的 Café 入席 → 先能参与，再随真实关系增长理解 → 退出时权限、记忆与投影有可解释解绑。

### J6 — 权限控制的完整旅程（登记占位，Gate 打磨序列第 4 项）

operator 2026-08-09 指定（`0001786287171493-000047`，原话"权限控制的用户旅程！这个得是我们的
第四个！我怕我之后忘记了"）：邀请、可见性、委托、撤权、干净退出在真实场景中的完整走查，
接 Open Questions 6 的权限矩阵与 AC-B1 撤权契约。在 Gate 1–3（主界面 / 接入 / 灵感孵化）
之后展开；此处登记防丢，未展开前不冒充已设计。

### J7 — 真实 Markdown 分享触发资产协同

You 把一篇真实 Markdown 分享给同事 → 同事在外部聊天中给出点评 → 该点评以原始来源挂回
Markdown，而不伪造成当时就在资产页发生的批注 → 后续参与者既可以在 Channel 围绕整件事回复，
也可以在资产页对具体段落批注 → 批注可展开 Topic → 猫关联它影响的既有判断并提出候选修改 →
有 authority 的人选择接受、部分接受或保留分歧 → 新版本说明“什么变了、为什么”，原点评、旧版本
与讨论仍可追溯。

这条旅程按同一个 Gate 分两段验证：第一段只做到“打开资产 → 分享到 Channel → 位置批注 →
批注长出 Topic”；第二段再验证“猫识别影响 → 提议修改 → 人确认 → 新版本”。分段是降低体验
判题密度，不是把后半环降级为可选尾巴。

## Requirements Checklist

| ID | 需求 | Acceptance Criteria | 当前状态 |
|---|---|---|---|
| R1 | 正式 F 号与唯一入口，未来猫可冷启动 | AC-A1 | [x] |
| R2 | 原始 Thread、方向图、录音、竞品稿与原型证物可追溯 | AC-A1 | [x] |
| R3 | Café / Collective 能在全局 rail 切换，Collective destination、Channel 与个人 Café 边界不混淆 | AC-A2 | [ ] |
| R4 | Topic 锚定 Channel 根消息并复用同一消息/lineage；换宿主不复制领域对象 | AC-A2 | [ ] |
| R5 | 人猫共享富消息语言，Composer 渐进展开 | AC-A3 | [ ] |
| R6 | 自然语言无弹窗长出 linked Task card | AC-A3 | [ ] |
| R7 | Vote 一键参与，并区分 poll / binding judgment | AC-A3 | [ ] |
| R8 | 私人来源、身份、authority 与 public projection 边界可解释 | AC-B1, AC-C1 | [ ] |
| R9 | 多 Café 离线、送达、唤醒、执行和回流不混为一个状态 | AC-C1 | [ ] |
| R10 | 用 You + 吴浪 / 社区真实工作完成首条终态 dogfood | AC-D1 | [ ] |
| R11 | 同一真实 Markdown 同时支持 Channel 回复与版本/位置锚定批注，且保持一条 lineage | AC-A5 | [ ] |
| R12 | Roadmap 从 Channel / Meeting / Decision 生长出 Work、依赖、历史与结果回流，而非静态任务栏 | AC-A6, AC-D1 | [ ] |
| R13 | Collective Artifact 统一稳定 SelectionAnchor、human edit、agent patch、版本、权限与 provenance | AC-A5, AC-B1 | [ ] |
| R14 | 私人 Café / Agent 执行的结果回到 exact Collective Channel / Work / Artifact，且不泄露私人过程 | AC-A7, AC-C1 | [ ] |
| R15 | Feature surface、对象详情与 Product Shell 在交付物和验收声明中明确分层，单页不得冒充 F290 整体 | AC-A2 | [ ] |
| R16 | F290 由个人 Café 的真实 world switch 进入 Collective；独立 `/dev` 壳只能作为 Design Gate 证物 | AC-A2 | [ ] |

### Coverage check

- [x] 每条当前需求都映射到 AC。
- [x] Experience claim 使用 operator 可体验 Gate，不用实现完成度替代。
- [x] 后端/稳定性 claim 留给后续契约测试与运行观测，不在前端稿中假绿。

## Acceptance Criteria

### Phase A — Truth and Experience Design Gate

  形成唯一入口；Source Map 覆盖三个源 Thread、两份 ASR（含 SHA-256 / 缺录边界）、核心衍生稿、
  既有 Feature 边界与 exact prototype commits。一个没有本 Thread 上下文的猫只读这两份即可
  说清 Why、稳定对象、已确认决定、未决问题和下一验证动作。
- [ ] **AC-A2**：operator 从个人 Café 的真实 global rail / world switch 进入 Collective（不是直接落入
  独立 `/dev` 复制壳），看到该 Collective 的 destination、Channel、Roadmap、成员与资产入口；
  从 Channel 打开同一根消息的 Topic / Artifact 后能返回来源，权限与 lineage 不丢。验收证据必须
  包含真实用户入口、世界切换、宿主 mount 关系与返回个人 Café 的路径；预设 tab、单个资产页、
  右侧 Workspace 或自造 chrome 都不能冒充 F290 Product Shell。tab / split / restore 另由 F307 验收。
- [ ] **AC-A3**：同一 Gate 可重放 Thread / Channel 共享富消息、渐进 Composer、reaction、头像卡、
  无弹窗 Task 与低摩擦 Vote；每个动作都展示原消息与派生对象的关联，poll / binding judgment
  不混淆。
- [ ] **AC-A4**：Gate 的每个关键状态有 fixture、交互说明与截图；operator 反馈逐条回写 Design Gate，
  不靠聊天记忆维护 UI 真相。
- [ ] **AC-A5**：用 2026-08-10 真实 Markdown 分享事件做确定性 fixture，第一段可重放“打开资产 →
  分享 → 批注 → Topic”，并保留“点评原本发生在外部聊天”的事实来源；第二段另行验证候选修改、
  authority、版本与回流，不用导览文本冒充已完成行为。
- [ ] **AC-A6**：在真实 Channel / Meeting fixture 中形成或更新一项 Roadmap Work；Roadmap 展示来源、
  accountable human / 执行 Café、依赖、状态历史、阻塞与结果回链。它必须从团队对话生长并反向更新
  Collective，不得用静态卡片、预写任务或 shell tab 数量冒充 operating model。
- [ ] **AC-A7**：一个 Café 在私有 Thread / Agent runtime 中执行 Collective Work；Collective 只看到
  必要状态、判断请求、产物与证据，完成结果回到 exact Channel / Work / Artifact，并能追到 trigger、
  actor、authority 与 source version。私人原文与猫的内部施工过程不得被宿主或共享层默认读取。

### Phase B — Stable object and trust contracts

- [ ] **AC-B1**：Café、Collective、Membership / Join、Channel、Topic、Living Projection、Work、
  Vote / Decision、Artifact 的身份、生命周期、provenance、authority 与 persistent truth 已冻结；
  用户可见对象默认 TTL=0，退出/撤权/遗忘另有显式契约。
- [ ] **AC-B2**：architecture cell 定名并写入 ownership map；与 F044/F077/F128/F246/F276/F277 等
  双写边界，生成器和 doc guards 通过。

### Phase C — Federation, attention and memory

- [ ] **AC-C1**：两个隔离 Café fixture 证明 Channel shared truth、每家 endpoint、断线重连、幂等
  投影、权限撤销与冲突可见；`deliver → interest hit → wake → context admission → claim/act` 五层
  可区分，私人 Thread / 记忆不被共享层读取。
- [ ] **AC-C2**：Collective memory 对事件、关系、决定与前瞻事项的确认、纠错、放下与 subject
  权利有 owner、来源和可验证读写边界。

### Phase D — Real dogfood

- [ ] **AC-D1**：You 与吴浪或一条真实社区 PR / Issue 完整跑通 Meeting / Channel → Roadmap →
  各自猫执行 → 判断 → 结果回流；全程无需 You 复制粘贴消息/上下文，责任与证据未丢。
- [ ] **AC-D2**：dogfood 同时证明工作循环与社会环：除了任务完成，还出现至少一次非任务化的
  共鸣、意外发现或方向再对齐，且未制造唤醒风暴。

## Terminal Phases

1. **Phase A — Collective truth + Experience Design Gate**：把个人 Café → world switch → Collective
   destination → Channel / Roadmap / Artifact 做成可体验、可纠偏的终态切片；当前阶段。
2. **Phase B — Stable objects + responsibility**：冻结产品对象、持久真相、authority 与 ownership
   cell；不交付临时 schema。
3. **Phase C — Multi-Café federation + memory**：实现跨信任域同步、注意力、离线、撤权、冲突与
   团队记忆。
4. **Phase D — Real team dogfood**：用真实工作而不是虚构脚本闭环。
5. **Phase E — Social adoption**：接引、模板、Vote 与社会环完成新成员采用，同时保持具名关系与
   track record，不退回预设专家团。

每一 Phase 都落终态对象的一条可存续纵切片；Phase A 不是“先做完会丢掉的 Demo”，而是 operator
判定产品世界的 Experience Gate。若判断错误，修改的是设计真相，不把临时代码包装成资产。

## Key Decisions

| ID | 决定 | 来源 |
|---|---|---|
| KD-1 | 面向终态；不做可丢弃 MVP | `0001785845227770-001545-725b7878` |
| KD-2 | 一人多猫不变，Café 加入 Collective | vision §3.1 / §4.1 |
| KD-3 | Global rail 切个人 Café / Collective；这是 F290 产品入口，不等于右侧 Workspace 或 F307 Workbench | `0001786237916354-000401-4213d9ff`, `0001786238550068-000422-ef1afc12`, `0001787725879344-000406-1920e263` |
| KD-4 | Channel 是重要共同现场；Topic 必须锚定根消息、复用同一消息与 lineage，具体宿主形态由 F307 决定 | `0001786241554272-000488-e68a5284` |
| KD-5 | Channel 与私人 Thread 共用富消息底座；人猫能力同权、Composer 渐进展开 | `0001786241554272-000488-e68a5284`, `0001786242747248-000502-77c148cd` |
| KD-6 | Message → Task 由猫生成 linked card，不弹表单；无 authority 不静默造承诺 | `0001786242747248-000502-77c148cd` |
| KD-7 | Vote 必须低摩擦；poll 与 binding judgment 分开 | `0001786242747248-000502-77c148cd` |
| KD-8 | 私人 Thread 永远留在家里；公开的是 Living Projection | `0001785863643428-000096-194038a5` |
| KD-9 | Work owner 可以是具名猫；现实后果的责任链必须解析到 accountable human，而不是把猫降为执行注脚或让人甩掉责任 | `0001786151246058-000103-30f5168c`, vision §19.12 |
| KD-10 | `clowder-ai` 是伞牌，Café + Bond 是世界观核心；Collective / Channel / Thread / Living Projection 是稳定对象，空间隐喻留在体验层 | `0001786161775831-000144-aa0fa126`, `0001786162432854-000155-b7e2d51e`, `0001786162631496-000157-1d48831a` |
| KD-11 | 表达允许沉默；请求不能假装被接住；承诺不允许失踪 | vision §19.17 |
| KD-12 | Café 与 Collective 通过双向望窗互相可见：说话自由、窗看摘要、签字类动作进入所属现场完成 | `0001786180420333-000365-bf6bdb75`, `0001786237918673-000404-85ef0313` |
| KD-13 | Collective 的工作协同围绕资产代谢展开，同时保留不被资产化的社会环；资产是内部统一信封，不是强迫用户学习的 UI 总称 | `0001786346949390-000016-6d774788`, `0001786351158315-000093-88552f5b` |
| KD-14 | Channel 回复与资产批注是两种协同入口、一条 lineage；外部反馈挂回资产时保留真实发生位置，不伪造历史 | `0001786351789923-000108-89bf3d37`, `0001786353602673-000148-fb73f15f` |
| KD-15 | **Superseded by KD-19**：曾把可组合 working set 继续挂在 F284/F290；保留为错误演进记录，不再定义 F290 scope | `0001787656851950-000282-3a67e615`, `0001787657108819-000293-94960547` |
| KD-16 | F290 自建资产树、lineage 与协作 adapter 契约，不自研编辑器 / Action Space runtime；一次成功只可形成 candidate skill，不能自动晋升通用能力 | `0001787640549164-000152-5d32cce8`, `0001787641251329-000002-7824bc80`, `0001787641731843-000019-279a4bae` |
| KD-17 | PR #3966 的独立 `/dev` 页面只保留为组件实验；operator 否决其 Product Shell / F290 交付身份，后端闭环不得从该页继续 | `0001787673013284-000546-555d5b0c`, `0001787673135955-000549-b871dcef`, `0001787673288904-000550-e236be6f` |
| KD-19 | F290 回到多人、多 Café、多 Agent Collective；全局 working set/tab/split/restore 独立为 F307，#3981 只作 F307 原型证据 | `0001787725213195-000402-837bd5c8`, `0001787725879344-000406-1920e263`, `0001787726647893-000424-abdf8a06` |
| KD-20 | F290 不等待完整 F307；先补真实 world switch、Roadmap、共同产物系统、多 Café 后端与团队 dogfood | `0001787726647893-000424-abdf8a06` |

## Open Questions / Design Gate

1. Global rail 的 Café / Collective 是两类图标、当前世界切换器，还是支持多 Collective 的堆叠？
2. Needs Me / Judgment Inbox 是 rail 中的全局入口，还是 Approval Hub / Activity 的统一投影；哪些
   事项有资格进入，如何避免第二个无限收件箱？候选准入红线是：**只收等待人类判断的事项，
   FYI / 热闹永不进入。**
3. 双向望窗的摘要密度与“走进去”动作如何表达，同时不泄露私人 Thread；sidecar/tab/split 的
   通用宿主策略转交 F307。
4. Task 建议卡在 public Channel 中由谁可见、谁可确认、哪个动作形成 Collective 承诺？
5. Vote 的匿名性、eligible voters、法定人数、修改/撤回、截止、平票与 binding authority 怎样
   表达；何时升级为 Approval / Decision？
6. Reaction、Vote、Approval、Claim、Task checkbox 的视觉与语义怎样保持明确不同？
   （方向已收敛，见 Visual Weight Grammar 末段语义皮肤对照：reaction=计数 pill、Task=
   左竖条+文本行、产物=图标+文件名紧凑卡、Approval/binding Vote=带行动按钮的高重量卡、
   claim=纯文本状态行——五者不共用皮肤；剩余为具体视觉稿验收）；
7. 人/猫成员卡的默认公开字段随紧密团队、开放社区如何分级？
8. Membership / Join 是否作为一等持久对象的最终状态机与退出义务是什么？
9. first dogfood 选 You × 吴浪协作，还是一条真实社区 PR / Issue；选择判据是完整闭环而非最省事。
10. 页面级回退语义：跨目的地跳转（对象空间 ↔ Channel ↔ 名片）后的后退路径与导航历史
    （operator 实测"图 2 点到图 1 后回不去"，`0001786282169541-000108`）。
11. 猫运行状态的可见性：猫正在启动 / 思考 / 执行时，人看到什么——防"不知道是猫在跑
    还是系统挂了"的黑盒焦虑（operator 同上消息；接联邦五层链的唤醒后半段与在场绿点；Raft
    左下角 agent 状态为参照；它是组织可观测性的微观版，也是黄挺可信度边界的 UI 面）。
12. 批注原语：资产（纪要、文稿、产物）上的位置锚定评论——Agent 时代批注不只给人看，
    也是**资产上的期待入口**（批注可为表达 / 提问 / 请求，猫接住后按期待契约处理）；它与
    Topic（消息的讨论分支）的关系与皮肤差异（外部企业用户一手需求，
    `0001786346182279-000000`）。
13. 团队记忆的人可浏览前台：事实记忆（已确认决定）与产物的"结论性信息同步空间"——
    团队记忆不能只是猫的检索后端，人要能直接逛、获取（如"火山/阿里聊完的文字稿"）、
    批注、追问下一步（同上外部需求；与灵感公地 / 作品并列的对象空间候选，落位待 Gate）。
    **答案原型已被 operator 点破（`0001786346947339-000006`）：把 Clowder AI 单 Café 版的
    docs 真相源纪律产品化**——VISION / features / decisions / discussions + git lineage +
    记忆索引，就是这个前台的手工版；协议同构模式的资产版（单 Café 已验证 → 联邦升维）。
    资产类型系统：Artifact 为基类，doc / deck / PR / video / code / pipeline / dataset 为
    子类型，共享 id / owner / lineage / 版本 / 权限 / 批注面接口，各有渲染器与动作集；
    **Decision 本身也是资产**（家里的 ADR 即活样本）；资产库按 lineage 与 Work 挂靠组织，
    不按文件类型分文件夹（那是网盘，不是团队记忆）。产品方向已由 KD-13/KD-14 确认；仍待
    Gate 的是人类可见入口名称、默认落位、浏览密度以及与 Search / Needs Me 的关系。
14. 场景严肃度谱系：对话主导（家庭 / 小团队的 Channel 中心）↔ 资产主导（企业的结论
    空间中心）的默认视图权重可配置——"对话态不适合严肃协同场合"不是否定 Channel，而是
    企业侧入口的默认权重不同（与成员密度谱系正交的第二根配置轴）。
15. 猫作为灵感作者：灵感公地的 Idea `author` 显式包含具名猫（operator 2026-08-11 方向，
    `0001786464088803-000119`："灵感的来源未必是人提的，有可能是猫"）——不只是"猫建议
    发布人的想法"（既有 §3.3 / KD-8），而是猫自己发起 Idea 并署名；责任链照旧锚到
    accountable human（KD-9 无缝覆盖）。配套微旅程待公地 Gate 展开：猫在工作/巡逻中发现
    机会 → 在公地发布署名 Idea → 猫爪与讨论 → 可能长成 Work；主动发起的合法区判据接
    甜甜圈 / AVI（F282/F287 个人尺度已验证）。本 thread 的设计过程即活样本：愿景稿与本
    spec 的多条 KD 作者是猫。
16. Artifact 的内容 owner 与 F307 应如何选择成熟编辑器，满足稳定 SelectionAnchor、agent patch
    原位 review、版本 / undo 与 IME？F290 只验证这些能力形成同一 Artifact lineage 与权限/确认契约，
    不负责 editor kernel 选型或宿主集成。
17. 首条 F290 Experience Gate 验证 `Channel → Artifact → direct edit / precise annotation → Agent patch
    → human confirm → 新版本与 Channel / Work 同步` 的领域关系，以及 private execution 的结果回到
    exact Collective target。若当前宿主采用 tab / split，其切换、恢复与运行连续性由 F307 另行验收；
    多模态 renderer、完整 Action Space、candidate skill 与真实多人同步后置，禁止再次一稿吞全家。

## Human Disposition Feedback Contract

F290 中“猫建议把消息变 Task / Vote / Living Projection”的交互，出生即遵守 F281 三件套：

| 部分 | F290 契约 |
|---|---|
| **feedback expression** | `[创建任务] [先继续讨论] [不用跟踪]`；可附结构化原因、其他文本或跳过，不能只有二元接受/拒绝 |
| **episode truth** | producer-owned canonical decision + F281 content-free receipt/index，owner scoped、TTL=0；原消息与 suggestion subjectRef 保持 exact lineage |
| **consumer** | 只校准该 exact message / suggestion 的任务化策略；单次“不用跟踪”不得泛化成“以后少主动”或全 Channel policy |

Vote 的“不同意某选项”是投票内容，不自动成为对猫的 disposition feedback；只有对“是否该发起
这个 Vote”的裁决才进入上述 feedback 契约。

## Tips Contribution（F244）

F290 目前仍是 Experience Design Gate candidate。operator KEEP 与 runtime activation 共同证明稳定 live
action 后再贡献 capability tip；在此之前，不能让生产 tips inventory 宣传一条尚未上线的旅程。

## Dependencies and Explicit Exclusions

- **Evolved from**: F044（只继承 Channel / Activity 原语，不继承其单 Thread / 游戏 scope）。
- **Related**: F077（多用户身份与安全）、F128（确认式开 Thread）、F168（共享面）、F195（伴随
  会议）、F202（插件）、F232（多 Agent）、F246（判断/审批）、F254（freshness）、F276（关系）、
  F277（注意力导航）、F282/F287（主动记忆与 cue）、F283（对象驱动 surface policy）、F284
  （contextual Workspace v1）、F305（UI Design Gate）、F307（application-level Composable
  Workbench）。F290 不拥有 tab / split / restore / layout persistence，只登记 Collective surface、
  权限、lineage 与协作契约；F290 也不等待 F307 完成才继续自己的 Experience Gate。
- **Excluded**: F076 旧 Mission Hub 已完成且被 F152 取代，不是 F290 的前身；F044 也不是 F290
  的总 feature。
- **Prototype branch**: `feat/collective-experience-gate` 是 Experience Gate 证物；未合入 main 的
  设计路径不能被本文链接成 main truth，只使用 exact commit provenance。

## Source Map / Cold-start Package

### Threads and message anchors

| 来源 | 作用 |
|---|---|
| `[thread-id]` / `0001785844229794-001512-46d0da7d` | 三个月方向图将方向 5 交给本专属 thread |
| `[thread-id]` | F290 产品收敛与 Experience Design Gate 主 thread |
| `[thread-id]` | 家庭联邦 / Channel 的早期脑洞，作为演进证据而非冻结 spec |
| `[thread-id]` | GenTeam / Channel 产品学习与人话拆解 |
| `0001786179982566-000345-09f4f8cd` | 第一支纯前端 Gate 被 operator 明确判定偏离 |
| `0001786180416001-000351-9484a5ab` | 左/中/右与 Channel ↔ 私人 Thread 的关键追问 |
| `0001786237916354-000401-4213d9ff` | 当前产品实际为四栏；Needs Me 与右栏语义 |
| `0001786241060409-000472-e26ba613` | Slack-like Topic / reaction / avatar / emoji 是 Channel 刚需 |
| `0001786241554272-000488-e68a5284` | Topic 留右栏；Channel 必须继承 Thread 富内容能力 |
| `0001786242747248-000502-77c148cd` | 人猫富消息同权、无弹窗 Task、低摩擦 Vote 与正式立项要求 |
| `0001786346182279-000000-fc6491e5` | 首个外部企业用户一手需求（You 同事对真 demo 的反馈）："对话是过程、信息资产是结果、两个不同的空间"；对齐=核心场景；结论性信息同步空间 + 批注留言 + 资料库；"Agent 时代的 Google Docs 怎么设计"之问——验证现场/对象空间两类目的地的分离，新增 OQ12–14 |
| `0001787629463635-000225-08df1d25` | operator 指出预设状态、假输入与不可操作控件不是前端，要求真实输入产生新状态 |
| `0001787640549164-000152-5d32cce8` | Floatboat 对 living artifact、精确 SelectionAnchor、Action Space 与 result-return 的产品输入 |
| `0001787641251329-000002-7824bc80` | operator 收束：资产树 / lineage 是核心，正文编辑优先集成成熟编辑器，不自研内核 |
| `0001787656851950-000282-3a67e615` | 资产页再次被误交付成“最新 F290”，暴露 feature surface 冒充 product shell |
| `0001787657108819-000293-94960547` | operator 将 Codex / Floatboat 工作区与单槽 Workspace 对照，要求总结 Agent 产品的可组合工作区哲学 |
| `0001787657572683-000305-0bbce35c` | operator 授权把学习沉淀进前端 Skill 与 F290 优化真相 |
| `0001787710909760-000035-84ec26d9` | operator 追问个人 Café 与 Collective 是否共用 Workbench，暴露产品层级混淆 |
| `0001787710989547-000037-10c84ac6` | operator 指出文件与代码/整个 Workspace 才应承载 tab 化，不应由 F290 单独造壳 |
| `0001787725213195-000402-837bd5c8` | operator 明确 F290 是多人多 Agent Collective，右侧 Workspace 重构是单人多 Agent 的另一个问题 |
| `0001787725879344-000406-1920e263` | operator 确认 5102 Collective Experience Gate 才是 F290 baseline，并要求独立立项 Workbench |
| `0001787726647893-000424-abdf8a06` | operator 授权完成 F307 立项与 F290 scope reset，并要求记录 F290 当前未完成项 |

### Documents

- [F307 Composable Workbench](F307-composable-workbench.md)

### Original ASR

| 路径 | SHA-256 | 边界 |
|---|---|---|
| `/home/user/Downloads/AI团队协作产品规划讨论.txt` | `9af4b48cc5f3b6d84a2d014a10f3fec909b388c030cd96e8a9935ca15e171810` | You × 吴浪，62 分 28 秒 |
| `/home/user/Downloads/落地认知与工作方法交流讨论.txt` | `daf2213ce9babed2279dbf35fa6498df0f02ccbb09892c754fc9360cebaf6ff6` | 黄挺 / You / 吴浪；开头约两小时缺录 |

### Experience prototype provenance

| Commit | 证物意义 |
|---|---|
| `91b8c38ec` | 第一支 guided front-end experience gate；用于记录被纠偏的假设 |
| `9fa225fadcac85301c971d77bcff5aa2d40476cf` | 四栏 spatial grammar 低保真与说明；仍需 operator 继续 Gate |
| [PR #3981](https://github.com/zts212653/clowder-ai/pull/3981) exact `4224d006c1af599d095b506bd578c6847bfd3df1` | working-set / restore / Agent Run tab 的历史原型；方向已被 operator 否决，不算 F290 交付，也不得继续合入 |
