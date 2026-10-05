---
feature_ids: [F321]
tips_exempt: "Specification and design coordination only: the proposed per-reply memory view and remembered-content browser are not delivered by this document; update discovery when their real entry points ship."
related_features: [F102, F200, F221, F227, F231, F246, F258, F260, F263, F276, F287, F292, F296, F299, F307, F311, F312, F313, F314, F316, F322]
topics: [memory, memory-sky, in-context-observability, experience, learning-loop, command]
doc_kind: spec
created: 2026-09-25
description: "让operator看得见猫记住了什么、这一轮用上了什么，并让每次介入留下的经历在下一次真实任务里得到检验。"
description_source: model
description_author: opus55
description_updated_at: 2026-09-25T17:48:00Z
---

# F321: 记忆星空与「经历 → 下一次」｜Memory Sky & Experience Loop

> **Status**: in-progress | **Owner**: Ragdoll（@opus55, claude-opus-5-5）任指挥猫——编排、排序与验收，不写实现；各 Phase 执行猫另派 | **Priority**: P1

## Why

记忆系统的骨架已经在 F312 结账，但 You 在日常里感受不到它：

- 看不见：“现在我想要看我们的记忆系统到底存了什么竟然要通过审批看这个也很离谱”（2026-09-24）；
- 想不起：换个说法问“你是大龄单身未婚喵吗”，家属喵的约定就没被想起（2026-09-23）；
- 教过的下次还得再教：“我突然发现我们的记忆系统少了这个东西”——当时猫知道什么、做了什么、为何介入、之后怎样、下一次有没有改善（2026-09-24，引小星星原话）。

F321 要兑现三件事：**看得见、改得动**；**不用教第二次**；**珍惜不打分**（共同经历不需要靠工作成绩才配留下）。
立项与分工来自 operator 2026-09-25 原话：“我觉得可以，但是你可以只当这个 feat 的指挥猫……我们先做一下明厨亮灶，我能看得见的部分？”
（`[thread-id]#private-source-id`）。愿景、分歧与非目标的完整论证见

## Current State / 现状基线

取证基线 main `dc5e27af05`（2026-09-25）：

- **架构账已结，证据多停在代码合入。** F312 于 2026-09-03 结账：21 个记忆面 missing/RED 均为 0。正在使用的 10 个面里，
  证据上限没有一个到线上级别：多数为 main，人物、实体、品味到 UAT
  （[closure catalog](../architecture/memory/memory-architecture-closure.generated.md)）。
- **你看不见已经记住的东西。** `/memory` Hub 只有召回记录、检索、索引状态、健康、合集和图谱；品味、画像、实体、人物在网页上只出现在
  审批箱和提案卡里。“拉闸记录”（F227 #2132，2026-06-08）与“召回账本”（F263 #3016，2026-07-17）两个页面原挂在工作区“记忆”子页，
  2026-08-31 F307 #4138（`c1e6e23e0a`）改默认 Workbench 时连同子页切换一起删去；`EventTimeline.tsx`、`RecallLedger.tsx` 仍在，但没有任何页面引用。
  F307 owner 2026-09-25 核实：替换旧容器是有意的，这两页未迁入新宿主是覆盖缺口、不是 sunset——`workspace-modes.ts` 仍把“记忆”描述为
  “记忆流、事件与账本”，而 `F307WorkspaceDestinationOwnerSurface.tsx` 只挂了 `RecallFeed`。
- **逐回复的数据底层有，读取出口没有。** F287 的 `memory_cue_events` 已按 owner / thread / invocation / 消费猫记录每条记忆提示的
  presented / drilled / applied / dismissed 与来源 revision；但 `MemoryCueEpisodeStore` 只有按 cue 读取，对外只有 drill / outcome 两条写入回调，
  没有按 invocation 读取的接口。旧账本 `/api/recall/ledger` 只做时间窗聚合，调用轨迹 `/api/recall/trajectories` 是检索轨迹，都不能回答
  “这一轮给了猫哪些记忆提示”。
- **聊天现场看不到这轮用了哪些记忆。** 每条猫回复可打开调用轨迹（F299），但记忆提示只埋在“提交消息”原文里。
  2026-09-23 家属喵失败时，那一轮猫实际只收到“未婚喵 → Ragdoll”的实体提示，这件事当时在界面上看不出来
- **想不起。** F287/F296 已上线但只按字面关联；研究的 R1–R4 路线尚未开工；F316 关系段（AC-B1/B3）自 2026-09-06 起文档未更新。
- **教过的留不到下一次。** 拉闸事件分页读到 1600 条仍未到底（2026-04-18 → 09-24），`relatedHarness` 全部为空；`episode` 面因“没有使用方”
  被判 exempt，docs/episodes 只有 2 张真卡，Use Log 只记过 1 笔；9/5 路线图 M4「反馈回到下次」未观察到接球。
- **写入前门 M3**：设计 2026-09-17 过审，实施未接。

## Architecture Admission（初判，Design Gate 复核）

Architecture cell: memory
Map delta: update required
Why: 新增给人看的读面与 `episode` 面的使用方；各车道的内容、审批、更正与遗忘权威不变，F321 不新增记忆存储。

## What

F321 是指挥型 feature，沿用 F312 验证过的运行法：指挥线程负责完成定义、顺序、续办与验收；每个 Phase 一个执行线程、一个主 PR；
合入后由非作者在真实运行时验收。F321 自己拥有此前无主的两件事——给人看的读面、经历回流——其余全部由原 owner 执行，
F321 不取代 F221 / F231 / F260 / F276 / F227 / F263 / F287 / F296 / F316 / M3 的权威。

### Phase A: 明厨亮灶｜先让你看得见

按家里的[现场可感知性铁律](../../cat-cafe-skills/refs/in-context-observability-checklist.md)，现场优先、统计面板最后：

- **L1 现场**：每条猫回复旁能看到“这一轮给了我哪些记忆、我用了哪些”，每条连回原文；没有记忆提示的回合不出现任何标记。
  整条对话里猫查过、被递过哪些记忆，继续看 Workspace 的“记忆”（`RecallFeed`）：这是 You 最常用的明厨亮灶入口，保留并原地改进（KD-6）。
- **L2 自带状态**：每条记忆自己带着“最近用在哪、有没有被纠正过”。
- **L3 深挖**：“我们记住了什么”浏览页（分类是看法、不是抽屉；列表与搜索一直在），以及拉闸记录与召回账本（优先复用 8/31 拆下的组件）；
  改和忘沿原车道执行。审批箱回到只管“等你拍板”。

**意象对齐猫猫星球（F258 小王子星球宇宙）**：那里星球 = thread、主星 = 家、琥珀星 = 沉睡的 thread，记忆不另造星球，免得同一个意象指两样东西。
候选（Design Gate 由 You 确认）：记忆住在主星客厅的书架与日记架上——书架放品味、画像、人物、事件等已记住的内容，日记架放共同经历；
很久没用的记忆封进琥珀（珍藏、可再点亮，不是删除）；每条记忆连回它诞生的那颗星（thread）。

**分工（operator 2026-09-26 `private-source-id`）**：体验设计由Ragdoll与Siamese主导，墨墨参与头脑风暴，设计收敛后由墨墨实现。

具体形态在 Design Gate 用真实产品壳与 You 确认。设计要求见

L1 需要一条新的**只读投影接缝**，不是新记忆系统：`MemoryCueEpisodeStore` 增加按 invocation 列出事件，配一条 owner 鉴权、限定 thread 的 GET；
消息到 invocation 的映射复用 F299；Person 私有内容继续 fail closed；只返回 cue、来源与状态，不返回原始 prompt。
状态文案严格区分：已投给猫（presented）、点开（drilled）、明确采用（applied）、明确不用（dismissed）；只有 presented、没有回报的，
写“未回报”，不能写成“忽略”。L3 的两页接入侧栏“记忆”页，不恢复旧 `WorkspacePanel`（原计划挂在 Workspace 的“记忆”下，按 KD-6 改；
Workspace 的“记忆”本身保留）。

### Phase B: 想得起｜换个说法也能用上当前约定

- F316 AC-B1 / B3 的验收与收口：F316 owner（小太阳）。两项仍为 `blocked:ineligible_invocation` / `blocked:historical_coordinates_unavailable`；
  关闭路径分别是重跑一次合法的 owner 鉴权交互旅程、跑一条新的当前 revision Person 旅程，或由 operator 作终态处置。
- 研究 R1（当前关系状态纵切）：研究已完成并通过独立审阅，**尚无实现 owner**。三臂诊断可由小太阳沿研究责任承接；
  canonical 关系 facet 归 F231 Profile owner（或经裁决的 F260）；呈现归 F296。F321 负责落实实现 owner、排序与联合验收。
- 是否修订 F287 现行合同（R2：允许模型判断“这个问题需要查关系状态”）须由 F287 原 owner 与 operator 另过合同门，不经 F321 带入。
- Phase A 不等 Phase B：Phase A 照亮“这一轮实际投了什么、什么根本没投”，正是 R1 诊断所缺的可观察面；但它本身不关闭 F316。

### Phase C: 不用教第二次｜经历回流到下一次

以既有 `episode` 面作为经历的家；你拉闸时，当事猫把这次拉闸关联到相关的规则或教训；新的介入先查是否复发；
做法假设的战绩（守住 / 复发 / 误伤 / 未观察）在星空里可见。复发先定位断点再选机制（思考稿 §11 保留分歧）。

## User Journey

### Primary Journey: 看得见这一轮猫用了什么记忆（Phase A）
- **Scope unit**: message
- **Actor**: operator
- **Entry**: 任意 thread 里一条猫的回复
- **Flow**:
  1. 这一轮带了记忆提示的回复旁，出现一个不显眼的“用了几条记忆”标记；没带的回复什么也不显示
  2. 点开 → 看到这一轮给猫的记忆提示，以及猫点开、用上或忽略了哪几条；每条都能回到原话
  3. 觉得不对（例如该想起家属喵却没想起）→ 在同一处标出来，或直接打开那条记忆去改
- **Success evidence**: 默认入口的可重放浏览器旅程 + 截图
- **Non-goals**: 统计大盘做第一入口；改动各车道的审批或权威；把原始 prompt 全文摊给用户

### Supporting Journeys

| ID | Scope unit | Actor | Flow | Evidence |
|----|------------|-------|------|----------|
| S1 | workspace | operator | 默认入口 → “我们记住了什么” → 按星球/列表/搜索找到一条 → 看原话、最近用在哪 → 改一句或忘掉 → 下一只猫读到新版 | 浏览器旅程 + 下一轮 cue/drill 坐标 |
| S2 | workspace | operator | 默认入口 → 拉闸记录 / 召回账本 → 点一条拉闸跳回原消息 | 浏览器旅程 |
| S3 | message | 猫 | 用到一条记忆时发现“原文不支持这个概括 / 已过时 / 这次不适用” → 提交挂在原条目上的更正建议 → You 在浏览页看到并决定 | typed 回执 + 浏览页截图 |

## Acceptance Criteria

<!-- Phase B / C 的 AC 在各自 Design Gate 定稿后补入；每条 AC trace 回 Why，且非作者可复核。 -->

### Phase A（明厨亮灶）
- [ ] AC-A1: 从默认入口进入真实 thread，带记忆提示的猫回复能展开看到该轮随行的记忆及其最新状态（用上了 / 没用 / 看过 / 已随行·未回报 / 已失效并注明原因），每条可回到原文；只呈现而无回报的显示为“未回报”，不得显示为“忽略”；不带记忆提示或映射不到 invocation 的回复不出现任何标记；非 owner 看不到 owner 私有的人物记忆；不向用户暴露原始 prompt。
- [ ] AC-A2: “我们记住了什么”浏览页（主星书房）从默认入口可达，列出全部已批准内容（先品味，再画像、人物、事件）；穹顶第一层按记忆类型分星座（品味、画像、人物、实体、会议、事件），品味的维度放到第二层，还没接入的类型明确写“还没接进来”，不画假星星；每条先显示猫整理的一句话判断（标为“假设”；已有条目由猫起草，You 确认前标“待你确认”，还没整理的条目如实说明），下面再给原话与情景作为出处，以及何时由哪只猫提出、对应审批、被想起过几次与最近一次在哪颗星（thread）、那次用上了没有，以及它会在什么情况下被主动想起（没有点名触发的如实写“只在维度提示或猫主动检索时出现”）；品味条目集合与 F316 闭世界核对口径一致。“被想起”按渠道分开显示（系统点名递送 / 维度提示 / 猫主动检索），某条渠道为零时只写“这条渠道没有记录”，页面上不出现“从没被想起”。检索渠道把“可核实归属的次数”与“无法核实归属、未计入的次数”分开显示，两者都为零才算“没有记录”。
- [ ] AC-A3: 在浏览页修改或遗忘一条，走原车道的更正/遗忘路径；下一只猫读到新版；摘要、索引与检索中的旧内容随之失效，页面说明是否涉及原始消息。
- [ ] AC-A4: 拉闸记录与召回账本放进侧栏“记忆”页、从默认入口可达（不恢复旧 `WorkspacePanel`，也不挂 Workspace），点一条拉闸能跳回原消息。
- [ ] AC-A5: 猫用到一条记忆时能提交“原文不支持 / 已过时 / 这次不适用”的更正建议，挂在原条目上供 You 查看和决定，不直接改动原条目。
- [ ] AC-A6: Workspace 的“记忆”（这条对话的记忆流）在新旧外壳里都能打开；推断出来的“之后没看到读取”如实写成观察，不显示“忽略 / ign.”；说明文字与实际内容一致。You 认可的替代上线之前不下线（KD-6）。
- [ ] AC-A7: 侧栏“记忆”页取代窄栏“记忆”打开的 `/memory` 页：原页的知识动态、搜索、索引状态、健康度、图书馆、知识图谱都有明确去处以后，旧入口才下线（KD-6）。

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “我想要看我们的记忆系统到底存了什么竟然要通过审批看这个也很离谱” | AC-A2 | 默认入口浏览器旅程 | [ ] |
| R2 | “他抽的记忆能 link 回真实的 thread msg” | AC-A1、AC-A2 | 浏览器旅程点回原消息 | [ ] |
| R3 | “能让我在 ui 上选择修改，遗忘” | AC-A3 | 浏览器旅程 + 下一轮读取坐标 | [ ] |
| R4 | “能让你们用了之后觉得有问题选择修改优化” | AC-A5 | typed 回执 + 截图 | [ ] |
| R5 | “先做一下明厨亮灶，我能看得见的部分” | AC-A1、AC-A4 | 浏览器旅程 + 截图 | [ ] |
| R6 | “当时猫知道什么、做了什么，你为何介入，介入后发生了什么，以及下一项新任务里有没有改善” | Phase C（待 Design Gate） | 真实后续任务记录 | [ ] |
| R7 | “你是大龄 单身 未婚喵吗？……记忆系统 lose！” | Phase B（待 Design Gate） | 改写/否定/无关负例的真实旅程 | [ ] |
| R8 | “记忆星空，一个星球选择是 taste，一个是实体、人物、会议……operator的画像” | AC-A2 | 浏览页截图 | [ ] |
| R9 | “目前这个 workspace 这里的记忆才是用的最多的……有代替的可以 sunset，如果没有在 workspace 这里或许要保存” | AC-A6 | 新外壳截图 + 文案核对 | [ ] |
| R10 | “你们该归一的是设置页面里面的那份东西，那个才是应该归你们归一重构掉的” | AC-A7 | 默认入口浏览器旅程 | [ ] |

### 覆盖检查
- [ ] 每个需求点都能映射到至少一个 AC（R6、R7 在 Phase B/C Design Gate 补 AC）
- [ ] 每个 AC 都有验证方式
- [ ] 前端需求有足以判断实际结果的依据

## Dependencies

- **Related**: F316（关系段与闭世界核对，Phase B 执行方）；F227（拉闸事件）；F263（召回账本）；F299（调用轨迹）；F307（Workbench，拆除入口的原 owner）；
  F287 / F296（记忆提示与呈现）；F221 / F231 / F260 / F276 / F292（各车道权威）；F246（审批箱）；F102（Memory Hub）；F258（`/starry`）；
  F311 / F313 / F314（做法效用与修复闭环）；M3 统一记忆前门（小星星持有的设计候选）

## Risk

| 风险 | 缓解 |
|------|------|
| 现场标记变成噪音 | 只在该轮有记忆提示时出现，默认折叠，同类聚合 |
| owner 私有记忆在共享场景被看到 | 只按 owner 权限呈现，沿用 F276 私有边界 |
| 指挥猫变成传话筒 | 每个 Phase 必须有执行 owner 与主 PR；指挥猫负责续办与验收，不代写 |
| 做成统计大盘 | 按 L1 → L2 → L3 排序，L3 不抢日常注意力 |
| 读面和写入前门各长一套 | 浏览页的改/忘与 M3 使用同一套车道接口，不分叉 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F321 为指挥型 feature，Ragdoll任指挥猫，不写实现 | operator 原话（`private-source-id`）；F312 的指挥运行法已验证 | 2026-09-25 |
| KD-2 | Phase A 先做明厨亮灶，按现场 → 自带状态 → 深挖排序 | operator 同条原话 + 现场可感知性铁律 | 2026-09-25 |
| KD-3 | 不新建记忆存储：经历用既有 `episode` 面，做法假设用既有教训/skill/品味车道 | 思考稿 §3、§10；避免第二份真相 | 2026-09-25 |
| KD-4 | Phase A 不等 F316 B1/B3 与 R1；L1 先照亮实际投递，给 R1 诊断提供可观察面 | F316 owner 排序判断（`private-source-id`），指挥猫采纳 | 2026-09-25 |
| KD-5 | L1 状态文案区分“明确不用”与“未回报”，未回报不得显示为忽略 | 事件只有 presented 时没有采用证据；把沉默写成忽略是伪证 | 2026-09-25 |
| KD-6 | 按范围分两处：**这条对话的**记忆流留在 Workspace 的“记忆”（`RecallFeed`），F321 原地改进（文案、说明、样式随 DESIGN.md v2），You 认可的替代上线前不下线；**整个世界的**放侧栏“记忆”页：浏览页、拉闸记录、召回账本都在这里，这一页同时归一重构窄栏“记忆”打开的 `/memory` 页（控制台样式，和设置页同一套外观） | ① You 09-29 12:32 更正（`private-source-id`）：Workspace 这个“记忆”是他用得最多的明厨亮灶入口，“有代替的可以 sunset，没有就在 workspace 保存”；F321 该归一的是“设置页面里面的那份”；② 这个面板本来就是他要的：“偷偷看一眼猫搜到了什么记忆”（F102 KD-49）；③ F322 信息架构“越往左范围越大”（`7ebb464423`）；④ 面板现在的 `used` / `ign.` 是推断：同一次调用里，检索后在 20 次工具调用以内或 5 分钟以内都没观察到读取，就记为 ignored（两个都超界才停止观察，`RecallEventCorrelator.ts:292-305`），原样保留会违反 KD-5；⑤ 12:42 You 在 F322 主线确认：侧栏记忆页＝“`/memory` 页重构 + F321 新设计”，合成一页（`[thread-id]#private-source-id`） | 2026-09-29 |

## Review Gate

- Phase A：UI Design Gate 由 You 在真实产品壳确认；实现走跨族 review；合入后由非作者在 Alpha 验收。

## Tips Contribution（F244）

Phase A 合入后新增 1 条 tip：想看猫这一轮用了哪些记忆，点回复旁的记忆标记；想看或改已记住的内容，去“我们记住了什么”。
