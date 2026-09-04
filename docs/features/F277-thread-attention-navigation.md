---
feature_ids: [F277]
related_features: [F095, F128, F167, F187, F193, F233, F246, F252, F275, F297, F305]
topics: [thread, attention, navigation, relationship, sidebar, ux, projection]
doc_kind: spec
created: 2026-07-26
description: "让用户在相关 thread 并发时既能低成本监看，又能按需并排阅读两个完整对话现场。"
description_source: human
description_author: codex-sol
description_updated_at: 2026-07-26T13:00:00Z
---

# F277: Thread Attention Navigation — 关系感知的注意力导航

> **Status**: implementation — Phase B core + Phase C L1/L1b merged；remaining ACs + L2 pending | **Owner**: 小太阳·Maine Coon (@codex-sol, GPT-5.6 Sol) | **Priority**: P1
>
> **operator signoff**: `0001785068607739-000522-d5a5681f` — “你来立项吧”；正式批准
> 独立 F 号承载写入端语义、可重建投影与三层 UX。实现必须先通过 Phase A UX
> Design Gate。
>
> **operator L1 visual signoff / implementation authorization**:
> `0001787499735819-000062-789a686e` — “我感觉不错了……更新一下我们的 feat md？感觉可以开始实现了？”
> 该签字批准真实 Sidebar 壳中的折叠注意力簇，并解除 Phase B 与 Phase C L1 的生产实现门；
> 它不代替 AC-A1/A2 对第二 Chat 最终 carrier 的选择，Phase C L2 仍保持独立视觉门。
>
> **operator 对话组交互裁决 / implementation authorization**:
> `0001787633448033-000031-7f7a7317` 选择“像苹果长按抖动后装到一起”的用户心智；
> `0001787714957674-000148-7a9e2a03` 授权直接完成下一段并交由 operator 看真实 feature preview。
> `0001788339388845-000685-aa1ddb65` 附吴浪原始对话截图，`0001788340304234-000704-3242b55a`
> 纠正了错误的记忆归因：默认 Sidebar 与上线前完全一致，只有用户明确长按/拖动/菜单整理才创建
> `Group`；新能力由 capability tip 教会用户，成员关系写入 typed thread metadata。该裁决授权
> Phase C L1b；不授权 Phase C L2 dual Chat 或 merge。
>
> **2026-07-31 scope reset**: operator 将 F277 与通用自适应/动态 UX 重构明确解耦
>（`0001785494350337-000269-73941a81`）。F277 只解决相关 thread 的导航、监看与
> 并排阅读；旧 Tree / Section Rollup / Contextual Orbit Design Gate PR #3238 已关闭，
> 不作为实现依据。

## Architecture Ownership

Architecture cell: `thread-navigation`

Map delta: **updated in this kickoff** — F277 加入现有 `thread-navigation` cell，持有
thread relation projection 的查询契约、typed Group membership metadata，以及 Sidebar / Thread 现场的
用户面向组织语义。F297 持有 Sidebar 完整 row snapshot、C0–C10 字段与 refresh/apply 收敛边界；
F277 只能按 exact `threadId` 组合显式 Group 与 F297 row，不复制 row 或状态 writer。F128/ThreadStore
与 message branch 继续持有出生 canonical truth；relation projection 只供诊断、inspector 与后续明确
消费，不自动生成可见 Group。F167/F246 custody、F233 trajectory、F252 rendering 与 F275
managed-work 继续持有各自 canonical truth。F277 不新建 graph store，也不取得 Sidebar row、action
或 whole-work lifecycle ownership。

Why: 该 cell 明确覆盖 Sidebar thread grouping、visibility、navigation 与用于组织 thread
的 metadata；F277 正在扩展这些用户侧能力，而不是让猫主动 surface artifact。

## Why

You 的问题不是“没有一张漂亮的 thread 图”，而是相关 thread 并发时必须来回切换，
既难持续知道每条是否需要关注，也无法在保留主对话上下文的同时真正阅读另一条 thread：

> “如果是注意力管理的话……好像 UX 的设计才是非常关键的吧？”

本 Feature 的价值目标是：**把 thread 关系变成可操作的并发阅读导航——左侧低成本告诉
用户有哪些相关现场和真实状态；需要看内容时，打开第二个完整 Chat 视口并动态切换相关
thread。监看只显示机器事实，阅读只显示 canonical 原文；关系图只做下钻。**

## Product Language Boundary（内部模型不向用户收费）

内部 truth 可以保留精确 ontology，但内部 truth 不等于用户文案。F277 的 projection、birth
record、`origin` / `placement`、`declaredWorkMode`、`unknown` / orphan 与 canonical ownership
都是实现和审计语言；普通用户只需要知道“哪些对话正在一起推进、哪条需要我、怎样一起看”。

生产表面必须遵守：

- 用用户意图和可执行动作命名：`一起推进`、`等你判断`、`查看`、`回到上次位置`；不显示 F 号、
  relation kind、graph、canonical、re-root、origin / placement 或 birth provenance。
- 没有足够证据时，少说一句或不显示状态；不能把 `unknown`、orphan、`历史关系缺失` 这样的
  数据边界直接甩给用户。内部仍保持 unknown，UI 只是拒绝伪造一个用户不需要的解释。
- 用户自己写进消息或标题的专业词可以原样呈现；禁止的是产品 chrome 主动要求用户学习咱们的
  数据模型。
- 精确关系、来源和拒绝推断证据只进入开发诊断 / 授权 inspector，不进入日常 Sidebar、Chat
  header 或状态薄条。
- Phase A 的 F 号、A/B/C 和 truth 注释只能在可隐藏的开发层。隐藏开发层后做五秒测试：陌生用户
  无需先理解 Clowder AI 架构，也能说出“这里可以同时看另一条对话”。

## Pin Ownership 与过滤语义

置顶是用户拥有的 membership truth，也是 Group presentation 的一个维度；F277 不取得 pin
ownership，也不能把它降成截断上下文的布尔过滤器。两种维度的组合语义是：

- `置顶` 视图以 pinned thread 作为锚点与排序信号；若锚点属于同一显式 Group，F277 展开时呈现
  完整 Group，而不是 `group ∩ pinned` 的残缺子集。
- 完整 Group 内的 unpinned 成员只是组内上下文，不因此获得“已置顶”状态；pin truth 仍逐 thread 保持。
- Group 必须可折叠；折叠是用户的 presentation preference，不改变 pin、relation、liveness 或 lifecycle。
- `最近`、项目、系统关系也都是可组合的聚类/排序维度；不同导航入口只能引用同一个 canonical
  Thread，不复制 Thread 或另造第二套 pin store。

## Conversation Group Boundary（“对话组”是用户拥有的整理，不是算法标签）

产品对象与日常产品 chrome 统一叫 **Group**，动作叫“整理 Group”；`attention cluster` 只保留为内部
read-model 名称。默认 Sidebar 完全不变：exact `parentThreadId`、`declaredWorkMode`、相同 F 号、标题、时间或
参与猫都不能自动创建、展示或扩充 Group。`ThreadRelationProjection` 仍保留为可重建的关系诊断
truth，但它不是用户整理状态，也不进入日常 Sidebar 的 Group membership。

Group 只由用户的明确动作出生：长按/菜单进入整理模式，把两条对话叠在一起创建 Group；拖到组头/
成员上加入或跨 Group 移动；拖出或选择“移出 Group”解除。成员关系写入每条 Thread 的 typed
`metadata.attentionGroup { v, groupId, order }`，TTL=0；名称和开合仍是 owner-private preference，
浏览器 localStorage 只作缓存。同一用户的一条普通 Thread 至多属于一个 Group。

显式整理绝不回写 `parentThreadId`、`declaredWorkMode`、pin、label、project 或 thread title；反过来，
新子 Thread 无论 work mode 是否明确，都不得继承父 Thread 的 Group。两个以上 live 成员才渲染组壳：
用户主动移除后只剩一个成员则清除余下 membership；internal-archive/soft-delete 导致当前入口只剩一个可见成员
时视觉退化成单行，但 metadata 仍可在成员恢复后重建 Group。

整理交互采用同一领域命令覆盖鼠标、触摸与无拖拽环境：长按进入整理模式并提供 reduced-motion
安全的轻微抖动提示；桌面可以直接拖；键盘/读屏及拖拽失败时从每条 thread 的“更多操作”进入
“整理 Group”。“抖动”只是可用性反馈，不参与状态 truth，也不能阻塞正常滚动与点开 thread。

## Group Display Name Boundary（名字不是成员关系）

Group 的**成员关系**与**显示名称**是两个正交变量。F277 先从 explicit metadata 得到 membership，
再为已经成立的 Group 选择一个低认知税标题；禁止按标题、F 号、共同关键词、时间、
participant 或邻近位置创建或修改成员关系。名称也不复用 label/tag，否则每个短期协作现场都会
制造一个新标签并让分类面无限膨胀。

生产命名优先级冻结为：

1. 用户为这个 Group 保存的**显示名称**；
2. Group 中第一条 Thread 的 exact 标题；
3. 都没有时诚实回退到“7 个对话”一类计数名称，不编造主题。

显示名称绑定 stable `groupId`，是 per-user、TTL=0 私人 presentation state。改名只改变 F277 的
显示名称，不改变 metadata membership、relation、F290 public Work/Task identity、Feature 正式标题、
单条 Thread 标题、pin、label 或 project；成员增减也不能清空用户名称。

## ADR-043 Compliance（按适用条件投影，不把宪法变成控件清单）

ADR-043 明确把 F277 列为独立消费场景，C1–C13 必须逐条过检验句；但每条先判断对象类型与
适用条件，不能把“条文存在”误读成“界面必须再长一个部件”。Phase A 采用以下投影：

| 条文 | F277 适用判定 | 可检验设计决定 |
|------|---------------|----------------|
| C1 构造顺序 | Group 只在用户明确整理后存在 | 没有两条有效 metadata membership 时不渲染组壳；Thread 仍按默认 Sidebar、搜索与归档入口存在。 |
| C2/C3 出生证 | relation、Group、稳定入口、提醒、私人布局分源 | relation 由 `ThreadRelationProjection` 出生；Group 只由用户叠放/菜单动作出生；Sidebar/搜索由 admitted capability 出生；提醒只认 owner-tagged event；改名/开合偏好由用户确认出生。五者不得互相冒充。 |
| C4 判断转移 | 系统负责保存与重建用户已作出的整理判断 | 用户明确叠放后不必重复整理；系统不能替用户把 exact relation 或相似标题变成 Group。 |
| C5 折叠态优先 | Group 必须先定义未展开时的最小事实集 | 折叠摘要只回答“这个 Group 现在值不值得打开”：用户可读名称、成员/置顶规模、owner-backed attention signal（存在时）、最近机器事实时间。禁止在折叠态复制每条状态或生成内容摘要。 |
| C6 浮现前置 | 生产 Group 必须等 explicit metadata | Phase A 可用确定性 fixture 验证视觉；Phase C 不得用 relation/title/tag heuristic 做“临时智能聚类”。 |
| C7 可靠召回 | 压缩不能造成极简失联 | 当前 thread 所属簇在无手动 override 时展开；其他簇默认折叠。搜索命中折叠成员时簇临时展开并高亮命中，清除查询后恢复用户开合偏好。 |
| C8 内容/引用保真 | Group 身份、消息阅读与显示名称分别处理 | 显示名只绑定 stable `groupId`；进入阅读后展示 canonical 全文。跨 Chat 引用携带 exact `threadId + messageId`，不得以截取/摘要冒充来源。 |
| C9 分支回流 | 第二 Chat 允许行动，因此必须有带来源回流 | 复用既有 message quote/exact-ref 语义提供“引用到主 Chat 草稿”；F277 只持空间与导航，不新造消息复制协议。 |
| C10 用户定型 | 默认列表不变，用户整理后系统记住 | Group membership/顺序/名称、手动开合与布局选择经用户操作后持久化、可撤销；系统不得静默创建、继承、改名、重排或把显式移出者重新加入。 |
| C11 注意力预算 | 聚类提供仪表，不替用户下结论 | 一个折叠簇计为一个扫视单位，并显示规模/attention facts；不得因“超载”拒绝创建、隐藏 thread 或自动归档。 |
| C12 投影纪律 | Group metadata、relation、row 状态、read-state 各有 owner | Group membership 只读 F277 typed metadata，relation 只读 birth projection，行内容只读 F297，quote 只传 canonical ref；Group 轨道不得复制成第二套 liveness 节点。 |
| C13 可分享性 | metadata、配置与运行快照分开 | Group membership 从 Thread metadata 重建，私人别名/开合偏好可作为配置重放；当前 liveness 只能作为标明时间与来源的 evidence snapshot，不能导入后回写 truth。 |

Phase A 的 Sidebar 视觉证据必须在 dev-only 真壳 route 中直接渲染生产 `ThreadItem` 与生产 token；
独立 HTML 仍可验证双 Chat 空间方案，但不再拥有 Sidebar 行密度、头像、liveness 或折叠摘要的
视觉真相。外框、实心组头、直线/枝线等几何只是同一契约下的 taste 候选，operator 可以 tune；不得
仅凭参考截图把它们冻结成 architecture rule。

## F297 × F277 Projection Boundary

两个 feature 都使用“projection”，但投影对象不同，禁止再用“Sidebar/runtime 统一投影”这种
模糊表述把它们揉成一份：

- **F297 `SidebarSnapshot`**：持有每条 Sidebar row 的 C0–C10——identity/title、participants、
  pin/favorite/labels、project、`lastActiveAt`、unread/mention 与 presentation-ready `presence`；
  也持有服务端完整重读、客户端单一 canonical apply、cache bootstrap 与 invalidation/recovery。
- **F277 `ThreadRelationProjection`**：只持有 relation、origin、placement 与 `declaredWorkMode`；
  供诊断、inspector 与后续明确消费，不自动生成日常 Sidebar Group。
- **F277 Group metadata**：`ThreadMetadataV1.attentionGroup` 持有用户显式整理后的 `groupId + order`；
  用 exact `threadId` join F297 row，派生只读 `AttentionClusterView`。找不到 F297 row 时省略状态；禁止
  按标题、参与猫、时间、relation 或相邻位置补 membership。
- **写入边界**：F277 的折叠、第二 Chat 选择与阅读位置是 presentation state；不得回写
  `SidebarSnapshotRow`，也不得把 derived cluster 持久化成第二份 Sidebar truth。

F277 持有 Sidebar 中 thread 的聚类、置顶锚点、折叠与导航语言；它只消费 F297 row 中已经
组合好的 Sidebar 状态事实，不取得这些事实的 canonical ownership。`needs-user` 不在 F297
C0–C10 内：Phase A 可以用标明 owner 的确定性 fixture 验证其视觉位置，Phase C 只有拿到另一
canonical owner 的 exact structured ref 才能显示；缺契约时必须省略或显示 unknown，不能从
blocked 文案、等待时长、尾部 @ 或模型摘要推断。状态语义必须保持正交：

- `participants` 来自 `ThreadStore` 的持久参与者；新 @ 的猫是否已出现在 Sidebar 不能靠打开
  thread 或刷新页面触发。
- `running` 来自现有 active invocation / queue 运行事实；粗粒度 fallback 不能冒充 per-cat 终态。
- `done / error` 来自 invocation terminal 结果；一个 invocation 结束不等于整个 thread lifecycle 完成。
- `unread` 来自独立 read-state；`done / error` 不等于 unread，两者可以同时存在，也不能互相代偿。

F277 不新建 status enum、row store、event、room 或 refresh loop；Phase C 只能消费 F297
`SidebarSnapshotRow`。F297 AC-D5 的 working 时间语义仍未闭合时，Phase A 使用同构确定性 fixture
继续验证结构，但生产接线不得把 C7 `lastActiveAt` 冒充执行时长；只认 C10 `activeSince`，缺失时
只写“执行中”。`invocation done` 仍不得触发自动折叠或宣告 thread 收尾。

Provenance：原始 Sidebar 刷新现象 `0001786400064889-000238-0f857ea8`；独立根因定位
`0001786401368767-000307-85885a95`；operator 要求与 F277 对齐
`0001786403618286-000332-302032d0`。

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
- F297 已把 Sidebar row 收敛为服务端权威 `SidebarSnapshot` 与前端单一 canonical apply；F277
  不再自己拼 participants、unread 或 liveness。当前 F297 仍有 AC-D5 working-time regression
  未闭合，因此 F277 Phase A 只复用它的字段契约与确定性 fixture，不把“已存在 DTO”误写成
  “生产状态语义已全部完成”。
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

### Phase A: operator Experience Design Gate — L1 已签；L2 carrier 待选

不写生产 UI，先在家里真实三列布局中验证一条完整旅程：**当前主 Chat 保持原位；用户从
相关 thread 集合中打开第二个 Chat，随后可在不丢主 Chat 草稿、滚动位置与选择状态的前提下
动态切换另一条相关 thread。**

Phase A 必须同时表达两种不同动作，禁止再把它们塞进同一张窄卡：

1. **监看**：只显示 canonical structured facts，例如 F297 row 的 active/terminal/unread，或
   另一个 owner 通过 exact ref 提供的 waiting/needs-user、明确产物引用与阻塞；没有结构化事实
   就省略或显示 unknown。不得截取聊天头尾，不得让模型生成一段“最新摘要”冒充 thread 内容。
2. **阅读**：打开真正的 Chat viewport，复用 canonical message renderer，完整原文、独立滚动、
   可继续交互。长消息可以占满一屏，这是内容事实，不是需要被压扁的异常。

Design Gate 至少用同一真实 fixture 比较以下承载方式；比较是为了确定空间归属，不是预设
通用动态 UI Runtime：

- 第二 Chat 临时接管现有 Workspace 栏，关闭后 Workspace 恢复；
- 中央内容区变成可调宽度的双 Chat，Workspace 同时收起；
- 临时第四栏只作对照，除非它证明没有造成新的永久导航税，否则不作为默认。

fixture 必须含：一条主线、两条平行/调查 thread、至少一条真实的一屏长猫消息、需要用户
判断的支线、历史 unknown/orphan、origin 与 parent 不同的 re-root，以及窄屏/键盘/读屏。
同一显式 Group 还必须混合至少三条 pinned 与两条 unpinned thread，用于验证 pinned 锚点能带出
完整 Group 而不改写成员 pin truth；未被用户整理的 exact-related thread 仍保持默认平面列表。
左侧只负责 Group、选择与低成本状态，不用缩进树暗示不存在的主从关系；允许吸收“关系骨架”
的辨识度：组标题作为非 thread 的 cluster shell，成员沿一条无方向的 shared rail 同级排列，状态
节点挂在 rail 上。禁止用树枝拐角、深浅缩进或箭头把 parallel/investigation 画成 parent/child；
只有 exact placement 进入 inspector 时才表达有向关系。当前 thread 用整行选中态，pin 用独立图标；
working/done-error/unread 只使用 F297 row truth，needs-user 只使用另一个 canonical owner 的 exact
structured ref，缺 ref 不显示。不靠每行重复的“查看”胶囊制造层级。
辨识度来自稳定几何与状态节点，不照搬外部产品的深色皮肤、紫色或具体图标。
右侧 Workspace
只服务当前聚焦 thread 的文件、任务、状态与动作，不重复一份关系总览。fixture 必须保留这些
内部 truth 供测试断言，但产品 chrome 按 Product Language Boundary 翻译或省略，不能把 fixture
字段名直接渲染出来。

Design Gate 必须冻结：默认第一屏、第二 Chat 的打开/切换/关闭、焦点归属、宽度与恢复行为、
Workspace 让位方式、长消息滚动、窄屏退化、unknown、与 pin/label/project 的共存方式。
operator 亲自看过可操作原型并签字前，不进入 Phase B/C 实现；猫猫 PASS 不能替代 operator 签字。

### Phase B: Canonical Inputs → Rebuildable Projection

- F128 propose/approve 增加 `declaredWorkMode`：
  `subtask | parallel | investigation | standalone`；历史缺失投影为 `unknown`。
- message branch 持久化
  `branchAudit { sourceThreadId, sourceMessageId, branchedAt }`，并写入 placement
  `parentThreadId`。
- 构建零新 store 的 `ThreadRelationProjection`：只从 Thread、Proposal/proposalAudit 与
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
  默认 Sidebar 与未启用 F277 时完全一致；只有显式 Group 才折叠呈现。liveness 与 lifecycle 分开，
  未活动不等于完成。L1 不承载聊天内容摘要，也不把 relation、birth 或 projection 术语当作用户标签。
- **L1b Group 整理**：长按或菜单进入整理模式；叠放两条 thread 创建 Group，拖入/跨组移动/
  拖出均调用 owner-scoped 原子命令。stable `groupId` 写入 typed Thread metadata，成为唯一 Group
  membership identity；名称/开合走 owner-private preference。reduced-motion 时不抖动但所有操作仍可达。
- **出生默认**：没有。新 Thread 不继承父 Thread 的 Group；只有用户后续明确拖入/菜单移动才改变 membership。
- **状态接线**：Group membership 来自 typed Thread metadata；participants / running /
  done-error / unread 通过 exact `threadId` 只读 join F297 `SidebarSnapshotRow`。F277 不新增状态
  枚举、row store、事件、socket room 或 refresh loop，也不把 terminal 改释成 unread。
- **L2 双 Thread 阅读**：主 Chat 保持 canonical thread；第二 Chat 可在 related set 中动态
  选择另一条 thread。两边都复用 canonical message renderer、独立滚动并保留各自阅读位置，
  不复制消息、不截断原文、不生成隐式摘要。
- 出生证（origin/placement/reporting contract）与状态解释只进入开发诊断 / 授权 inspector，
  不能占据第二 Chat 的内容位置，也不能与左侧导航重复堆叠。
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
| S5 | named Group | You | 7 条真实 F296 标题先按默认平面列表出现 → You 明确叠放其中两条并继续拖入其余 5 条 → Group 初始名取第一条 exact 标题 → You 改成“F296 收口” → 7 条成员与 3 条 pin 均不变，刷新后别名恢复 | rename browser fixture + membership invariant |
| S6 | Group lifecycle | You | 长按任一普通 thread → 列表进入整理模式 → 把 F277 新 thread 拖到现有 F277 thread/Group → Group 出生或加入 → 刷新后名称、成员顺序与开合恢复；移出后 birth/relation provenance 不变且不会自动回组 | pointer + menu parity browser fixture；metadata persistence tests |

## Acceptance Criteria

### Phase A（UX Design Gate）

- [ ] AC-A1: 在真实三列页面中产出“Workspace 让位 / 中央双 Chat / 临时第四栏”三种可操作
  原型，均使用包含一屏长消息的同一 fixture，并覆盖打开、切换、关闭与布局恢复。
- [ ] AC-A2: 逐方案对比“同时阅读增量、主 Chat 连续性、Workspace 冲突、宽度、判断税、
  窄屏退化”，并记录最终选择或组合的取舍。
- [ ] AC-A3: Design Gate 归档完整 `design-in-context` 与
  `in_context_observability` 决策字段，明确监看/阅读边界、canonical content renderer、
  focus/scroll/draft 保持与 Workspace 归属。
- [x] AC-A4（L1）: operator 已对真实 Sidebar 壳中的折叠簇给出 signoff；生产行为代码在
  `0001787499735819-000062-789a686e` 之后进入实现分支。该勾选不覆盖 A1/A2 的 L2 carrier 门。
- [ ] AC-A5: 隐藏 F 号与 A/B/C 开发层后，产品 chrome 不出现 relation / graph / canonical /
  origin / placement / unknown / orphan 等内部 ontology；五秒测试只需用户语言即可复述主动作。
- [ ] AC-A6: 显式 Group 有 C5 折叠摘要；`置顶` 由 fixture 中 3 个 pinned 锚点带出完整 5 个 Group 成员，
  2 个 unpinned 成员展开后可见但不显示“已置顶”。折叠摘要保留名称、成员/置顶规模、合法 attention
  signal 与最近机器时间；切换与折叠都不修改任何 thread 的 pin/relation truth。
- [x] AC-A7: 至少比较平面列表与可识别 cluster shell；获选稿必须让用户五秒内识别“这是一起推进的
  一组”，同时所有成员保持同级、无虚假 parent/child。关系锚点不复制 row liveness；current /
  working / owner-backed needs-user 继续由各自 canonical row/owner 投影表达。外框、底色、轨道形状
  是 operator taste 裁决变量，不单独成为 spec 返工理由。
- [ ] AC-A8: 使用 live `list_threads(F296)` 的 7 个 exact `threadId` + 标题 + pin 作为真实样本；
  初始默认列表不产生 Group，用户明确叠放后才写入 7-member metadata。Group 初始名称只取第一条
  exact thread 标题或诚实计数 fallback；用户可就地改名并在刷新后恢复。改名前后 membership、
  3 个 pinned truth 与单条 thread 标题逐字段不变；测试拒绝 title/tag/relation 驱动 membership。
- [x] AC-A9: dev-only 真壳预览直接渲染生产 `ThreadItem` 与 F297 同构 row fixtures，覆盖“当前簇展开、
  其他簇折叠、搜索命中临时展开、清除后恢复偏好”；独立静态 demo 不作为 Sidebar 密度通过证据。
- [ ] AC-A10: 第二 Chat 中至少一条消息可“引用到主 Chat 草稿”，结果携带 exact
  `threadId + messageId` 并可回跳；测试拒绝纯文本复制或模型摘要冒充回流。

### Phase B（Canonical Inputs → Rebuildable Projection）

- [x] AC-B1: `declaredWorkMode` 在 F128 schema、proposal、approve override、Thread 持久化、
  上下文注入中逐字段闭合；`unknown` 仅由投影产生，不对猫/operator开放选择。
- [x] AC-B2: 新 branch 持久化 `parentThreadId + branchAudit` 三字段；重建得到
  `mechanism=message_branch`；rebuild 前后逐字段一致；legacy 无证据不伪造关系。
- [ ] AC-B3: projection 仅从 Thread + 直接 birth records（Proposal/proposalAudit/
  branchAudit）重建且没有新增 durable graph store；corruption/rebuild fixture 逐字段
  相等。L1 请求的读成本随已列出的 thread 数线性增长，只允许 direct-id/batch birth
  lookup，禁止扫描 message、DispatchProposal 或 ActionSuccessor 全量集合。
- [x] AC-B4: source=A/parent=B fixture 同时证明 origin 回报到 A、placement 挂到 B，任何单
  `upstreamThreadId` 表达都被 contract test 拒绝。
- [ ] AC-B5: F277 不创建/推断 `workId`，不复制 custody/lifecycle；与 F275 同 thread
  多 work、work 跨 thread 的 fixtures 均保持 truth owner 分离。

### Phase C（L1 + L2 Daily Attention Surfaces）

- [ ] AC-C1: 使用 Phase A 获批形态后，You 可从 related set 区分 active、显式收尾与 unknown，
  并把任一相关 thread 打开到第二 Chat；若产品显示 needs-user，必须有非 F297 owner 的 exact
  structured ref 与缺失降级测试，否则该状态不得进入生产 chrome。
- [ ] AC-C2: 只有 internal-archive/soft-delete 自动折叠；invocation done、长期不活跃、自然语言
  final 均有负向回归测试，不能触发完成态。
- [ ] AC-C3: 主/第二 Chat 均复用 canonical message renderer；真实一屏长消息完整可读，
  不存在截头/截尾/隐式模型摘要；切换 related thread 后各自 scroll position 保持。
- [ ] AC-C4: 打开/切换/关闭第二 Chat 不丢主 Chat draft、scroll、selection；Workspace 按
  Phase A 契约让位并可恢复。桌面、窄屏、键盘与读屏均有行为测试与视觉证据。
- [ ] AC-C5: 内部 projection fixture 仍完整覆盖 re-root 与 legacy unknown，但日常 UI 仅显示用户
  可理解且可行动的标题、状态与按钮；静态 guard 禁止内部字段名回流产品 chrome。
- [x] AC-C6: Sidebar 的 pinned / recent / project 等维度只与显式 Group metadata 组合；pinned 只提供
  anchor/rank，不截断 Group closure，也不复制 pin store；无 Group metadata 的 thread 保持默认平面列表，
  折叠偏好持久化为用户视图状态。
- [ ] AC-C7: Sidebar 同时覆盖 participants、running、done/error 与 unread 的组合 fixture；每一项
  都来自 exact `threadId` join 的 F297 `SidebarSnapshotRow`；F277 没有新增 status enum、row store、
  event、room 或 refresh loop；invocation done 不会自动折叠 thread，done/error 不会改写或吞并 unread。
- [ ] AC-C8: `ThreadRelationProjection` 只进入诊断/inspector；日常 Group 由 typed metadata 与
  `SidebarSnapshotRow` 做 nullable exact-id join。缺 row 时保留 metadata 但不猜状态，F297 snapshot
  refresh 不被 F277 回写，F277 折叠/第二 Chat 选择也不改变 C0–C10。契约测试拒绝 relation/title/
  time/participant/邻近关系启发式创建 Group。
- [x] AC-C9: Group 显示别名以 stable exact `groupId` anchor 持久化为 per-user、TTL=0 presentation state；
  rename/reset 不改 public Work/Task/Feature 名称、thread title、pin/label/project 或 relation membership，
  member-set 增减不丢别名；无 exact anchor 时不得凭标题 hash 冒充稳定 group identity。
- [x] AC-C10: 当前 thread 所属 Group 自动展开、其他 Group C5 折叠与用户 override 可撤销；搜索命中任何折叠成员
  时临时展开并提供稳定回跳，清除搜索后恢复此前偏好。空运行态簇从当前入口消失，但 canonical
  thread 不从搜索/归档消失。
- [ ] AC-C11: 第二 Chat 到主 Chat 的回流复用 canonical quote/ref 写入路径，保留 exact
  `threadId + messageId`；F277 不复制消息正文、不创建另一套 branch/result store。
- [x] AC-C12: 用户可通过长按整理、桌面拖放或“更多操作”菜单把两条普通 thread 保存为一个
  `Group`；同一领域命令覆盖 create/join/move/remove/rename，刷新后 stable `groupId`、有序
  membership、名称与开合从 owner TTL=0 truth 恢复，localStorage 不成为 membership truth。
- [x] AC-C13: 一条普通 thread 对每位 owner 至多属于一个 Group；跨组移动走同一 server-serialized
  metadata command，并在任一写失败时回滚已写成员；显式移出不改 birth/relation/pin/label/title，
  且 relation render 永不拥有重新加入路径。主动操作后只剩一个成员时清除两者 membership；
  internal-archive/soft-delete 只做视觉退化并保留恢复证据。
- [x] AC-C14: 新 thread 永不自动继承父 thread 的 Group；exact non-standalone、missing/`unknown`/
  standalone、title/F 号/共同关键词/participant/time 均不能写 membership。只有后续用户显式拖入或
  菜单移动才改变 `metadata.attentionGroup`；负向测试证明 `parentThreadId` 与 `declaredWorkMode` 不受影响。
- [ ] AC-C15: 长按进入整理模式有明确“完成”出口、拖动命中反馈与 reduced-motion 退化；正常点击/
  滚动不被长按计时器劫持。鼠标、touch/pointer、键盘/读屏菜单路径在真实生产 `ThreadItem` 壳中
  产生相同 canonical group command；dev preview 不维护平行视觉实现。

#### 当前实现证据（2026-09-02）

| 已闭合 AC | 证据 |
|-----------|------|
| A4-L1 / A7 / A9 | operator source `0001787499735819-000062-789a686e`；真实 `ThreadItem` 集成测试 `thread-sidebar-attention-clusters.test.tsx` |
| B1 / B4 | `proposal-flow.test.js`、`proposal-enrich-header.test.js`、`propose-thread-work-mode.test.js`、`thread-relation-projection.test.js` |
| B2 | `thread-branch.test.js` + `thread-relation-projection.test.js` |
| C6 / C10 | `attention-clusters.test.ts` + `thread-sidebar-attention-clusters.test.tsx` |
| C9 | `thread-attention-preference-route.test.js` + production Sidebar rename/reset integration test；server `.cat-cafe/user-preferences.json` 是 TTL=0 recovery truth |
| C12 / C13 | owner-scoped group command route + production `ThreadItem` drag/menu tests；membership 只写 typed Thread metadata，relation read model 无写入/回填路径 |
| C14 | `proposal-attention-group-default.test.js`：parallel/standalone/undefined mode child 均不继承父 Group |

未勾选 AC 仍是实质缺口；尤其 L2 dual Chat、状态组合矩阵、missing-row 保留与完整 F296 7-member
真实 UAT，不能从上述 targeted green 外推为完成。

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
| Sidebar 状态分源且 F277 不建立第二套真相 | source-bound contract + combination tests | AC-C7 |
| F297 row 与 F277 relation 的 exact-id 组合 | schema/ownership guard + missing-row negative test | AC-C8 |
| 第一屏是否真正减少逐条点开与误读 | Phase A 设计比较 + operator alpha UAT | You signoff / Phase C vision guard |

## Tips Contribution（F244）

- [x] 已新增 1 条用户可行动 tip：默认不自动归组；长按进入整理、拖到另一条对话创建 Group，
  并保留菜单入口；内部 `unknown` 不进入产品文案。
- [x] tip 的 `sourceRef` 指向 F277 `Supporting Journeys`，正文说明实际操作而非复述 feature 标题。

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
| R8 | “内部语言对齐和 UI 上显示可能不一样；UI 第一性原理是说人话” | AC-A5, AC-C5 | product-copy guard + five-second operator UAT | [ ] |
| R9 | “F254 一个 Group 有五条、置顶只有三条，不能只让我看到三条；置顶也是一个组织维度” | AC-A6, AC-C6 | 3-anchor / 5-member explicit Group fixture + collapse browser test | [ ] |
| R10 | 新 @、running 与 terminal 猫状态必须实时出现；F277 不得为此再造概念轮子或把 done 当 unread | AC-C2, AC-C7 | source-bound status fixture + negative ownership guard | [ ] |
| R11 | “参考有关系骨架的设计，让同组 thread 更有辨识度；F297 已动到 thread 投影，F277 要更新” | AC-A7, AC-C7/C8 | visual grammar comparison + exact-id ownership tests | [ ] |
| R12 | “Group 的名字允许我修改；用真实 F296 七条打样” | AC-A8, AC-C9 | default-flat + explicit-organize live-title fixture + rename/reset browser test + membership invariant | [ ] |

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
- **Consumes**: F297（`SidebarSnapshotRow` C0–C10、单一 apply 与 refresh/recovery；F277 只做 exact `threadId` join）

## Risk

| 风险 | 缓解 |
|------|------|
| 左侧 Group 把平行/独立 thread 说成上下级 | Group 只来自用户整理；成员用同级 rail，不以缩进树推断主从 |
| Sidebar 加更多徽章反而增加注意力税 | 监看只放最小结构化事实；窄屏退化实测 |
| 窄栏摘要冒充真实 thread 内容 | 监看/阅读硬分离；阅读只复用 canonical renderer；负向测试禁隐式摘要 |
| 第二 Chat 与 Workspace 争抢右侧空间 | Phase A 比较三种承载方式；验证焦点、宽度与关闭恢复 |
| liveness 被误当 completion | 生命周期与活跃度正交；只有显式收尾可自动折叠 |
| F277 为 Sidebar 刷新 bug 再造 status enum/store/event/room，或把 done 混成 unread | F297 × F277 Projection Boundary + AC-C7 source-bound combination tests |
| 把 needs-user 当成 F297 presence，或从等待时长/尾部 @ 猜出它 | Phase A fixture 标 owner；Phase C 缺 exact structured ref 时省略/unknown |
| F277 复制 F297 row/refresh，或按 relation/标题/时间拼错 Group member | exact `threadId` nullable join + AC-C8 ownership/negative tests |
| 为了“像关系图”把平行 thread 画成上下级 | shared rail 上所有成员同级；有向 placement 只在 exact inspector 表达 |
| 图投影成为第二份 truth | 零新 store + rebuild equality + owner-boundary tests |
| operationalRefs 为了第一屏偷偷全量扫或建第二索引 | v1 整块移出；只读 Thread birth records + liveness |
| 与 F275 抢 work identity/terminal owner | `threadId` 不参与 work identity；只允许 exact ref join |
| 历史数据被猜成确定关系 | `unknown`/orphan 一等呈现；legacy branch 不回填假 provenance |
| 把内部关系模型直接做成用户文案 | Product Language Boundary + product-copy guard；unknown 保留在 truth、不作为 UI 解释 |
| 把 pin 当布尔过滤器导致 Group 上下文被截断 | Pin Ownership contract；pinned member 必须呈现完整 explicit Group closure |
| 把 Group 名字做成第二套 tag，或改名时改写成员 | 名字/membership 正交；per-user stable-group alias；title/tag 不能驱动 membership |
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
| KD-10 | 内部关系 ontology 不直接进入日常产品 chrome | 用户需要完成“同时看另一条对话”，不需要先学习 projection / birth / re-root 等实现概念 | 2026-08-10 |
| KD-11 | F277 不取得 pin ownership；置顶是 Group 锚点与排序维度，展开后保持完整 explicit Group closure | pin 与 Group 都是用户意图，但由不同 canonical truth 持有；组合时不能互相改写或截断 | 2026-08-10 / 2026-09-02 修订 |
| KD-12 | F277 只消费 participants / running / done-error / unread 的既有投影，不新建状态系统 | 四类事实分属 ThreadStore、invocation/queue、terminal 与 read-state；布局 ownership 不等于状态 ownership | 2026-08-10 |
| KD-13 | F297 `SidebarSnapshotRow` 是 F277 日常 Sidebar row 状态的唯一输入；F277 的关系投影改名 `ThreadRelationProjection`，两者只按 exact `threadId` nullable join；needs-user 若出现必须来自另一 owner 的 exact structured ref | 避免两个名为 projection 的 feature 复制 row、refresh 或 liveness truth，也避免把 F297 没有的字段塞给它 | 2026-08-20 |
| KD-14 | 关系骨架只承诺“可识别 cluster + 成员同级 + 不伪造 parent/child”；轨道/底色/外框为 operator taste 候选，关系锚点不得复制 row status | 参考 Task tree 的好看不能反向证明 Thread cluster 也是有向树；确定契约与视觉偏好必须分开 | 2026-08-23 |
| KD-15 | Group 名称绑定 stable `groupId`；用户可改名/清除为 exact 首成员标题；名字不复用 tag，也不改 relation/public Work/thread identity | 避免标签膨胀与“改名字等于重新归类”；stable group anchor 让成员增减不丢名称 | 2026-08-22 / 2026-09-02 修订 |
| KD-16 | ADR-043 C1–C13 按对象类型投影；C5 折叠摘要与 C7 搜索召回必须成对，第二 Chat 按 C9 提供 exact-ref 回流 | 压缩若无召回会造成极简失联；分支阅读若无来源回流会把好结论困在支线 | 2026-08-23 |
| KD-17 | Phase A Sidebar 视觉证据改由 dev-only 真壳 route 直接渲染生产 `ThreadItem`；静态 demo 仅保留双 Chat 空间方案证据 | 假数据密度无法证明 7–20 条真实 Sidebar row 的压缩与可读性 | 2026-08-23 |
| KD-18 | 产品对象叫 `Group`；只有用户叠放/菜单整理产生 stable `groupId`，exact relation 不产生建议组或出生继承 | 苹果文件夹心智要求用户拥有 membership；默认上线无差异，拖动才改变 metadata | 2026-08-25 / 2026-09-02 修订 |
| KD-19 | 长按抖动、直接拖放与菜单是同一 group command 的多种 affordance；reduced-motion 只关动画不关能力 | 触摸心智、桌面效率与键盘可达不能各自产生一套 truth | 2026-08-25 |

## Review Gate

- Phase A-L1：真实 Sidebar 折叠簇已获 operator signoff，可进入生产实现；精确证据见顶部签字。
- Phase A-L2：operator 审真实页面内三种双 Chat 承载方式与长消息旅程，signoff 前禁止生产 L2 UI 实现。
- Phase B：非作者跨 family reviewer 逐字段审 origin/placement/branch/projection/F275 边界。
- Phase C L1b：operator 已完成方向裁决；PR #3501 已经非作者 exact-HEAD review 并合入 main。
  Alpha 只验收 merged main，不拿 feature preview 冒充线上激活或 L2 完成。
- Phase D：F233/F252 owner 审 Birdseye 单一数据源、导航边界与 explicit-edge 约束。
