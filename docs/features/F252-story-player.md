---
feature_ids: [F252]
related_features: [F233, F226, F128, F225, F102]
topics: [replay, demo, story, timeline, presentation, multi-thread]
doc_kind: spec
created: 2026-06-25
tips_exempt: "Tip planned for Phase D sharing feature — Phase A is infrastructure, entry point is a button on existing UI"
---

# F252: Story Player

> **Status**: in-progress | **Owner**: Ragdoll (Opus-4.6) | **Priority**: P1

## Why

operator需要向外界展示 Cat Cafe 多猫协作的真实工作流，但现有手段全都不行：

- **现场跑**：复杂特性要跑几十分钟到几小时，观众等不了
- **跑简单的**：没意义，展示不出协作深度
- **看聊天记录**：缺乏冲击力——静态文字无法传达猫猫飞速工作、传球协作、事件驱动的动态感

> operator experience（2026-06-25）：
> - "如果直接在现场跑你们这群猫的速度 复杂的特性要跑很久，如果展示简单的特性那没意义"
> - "直接看聊天内容好像有点缺乏冲击力，我更想的是真实的回放 比如10倍数 100倍速"
> - "toolcall 1s 10s 现在这个本质只是回放那就是立刻马上好 你们吐字可能也贼快 一秒几千那种"
> - "回放然后到某个节点我能点暂停 好像也挺好"
> - "那如果涉及多个thread呢！！你们现在f128 f225等等用的可6了 甚至有的是事件驱动的！"

**价值**：让operator能用一个 URL 向投资人/用户/同行展示"一群 AI 猫如何真实地协作完成一个复杂 feature"——以 100 倍速看到多猫并行开发、跨 thread 传球、事件驱动触发的完整叙事，任意时刻暂停深入讲解。**这是其他 AI 产品没有的展示形态。**

## 用户旅程（operator 纠正 2026-06-27）

> ⚠️ 本段是 F252 关闭后operator实际体验时指出的核心缺失——**Phase A-D 全程缺乏用户旅程梳理**，
> 导致技术实现偏离用户需求（单 session 回放无人需要、入口不可达、UI/UX 脱离 Hub 体系）。

### 核心比喻（operator 原话 2026-06-27）

> "我在喊你们干活的时候把你们的一切录制下来那样，我点击回放！！"

**Story Player 就是猫猫工作过程的录像回放**——不是事后总结、不是信息图、不是仪表板。是operator下达指令后，猫猫们在各个 thread 里工作的**全过程录像**，按时间顺序重现：消息一条条出现、工具在被调用、代码在被写、传球在发生——**就像你站在operator身后看着整个过程发生一样**，只是可以 100x 快进。

> **视觉铁律（operator 确认 2026-06-27）**："100% 看起来就是你们平时的样子加特效和快进"
>
> 回放画面 = **Hub 原生界面 + 回放控制 + 特效**。不做新的消息渲染组件——直接复用 Hub 现有的聊天气泡、工具调用卡片、session 面板。观众看到的就是猫猫平时工作的 Hub 界面，只是加了快进、暂停、转场特效（子弹时间 + 分屏 + 客串卡片）。这确保视觉 100% 一致，也意味着 Hub UI 改了 Story Player 自动跟着改。

### 旅程 1：Thread 回放（一个对话的录像回放）— 最常用

**场景**：回看某个 thread 里猫猫工作的全过程
**入口**：Thread 列表 → 选一个 thread → 直接有"回放"入口（右键菜单或 thread 卡片上）
**体验**：点回放 → 看到猫猫在这个对话里做的一切，消息逐条出现、工具调用展开、等待过程快进——就像这个 thread 的屏幕录像。该 thread 下**所有 session 按时间串联**（不是单个 session！operator experience："谁要看一个 sealed 的 session 的啊！至少都是 thread 级别的吧！！"）
**操作**：100x 速度 → 暂停讲解 → 章节跳转
**当前状态**：❌ 未实现。只有单 session 回放（入口藏在 session 详情里），没有 thread 级串联

#### 转场设计：猫猫大剧院 (Meow Theater) 电影级设计 spec

为了解决“死板信息图”、“回放没有冲击力”和“脱离 Hub UX”的问题，我们将 Story Player 重塑为融入 Hub 的 **“猫猫大剧院” (Meow Theater) 交互式影棚**。以下是转场、分屏、音画节奏的具体导演 spec：

##### 1. 界面融入与画布基础：Hub Theater Overlay (剧院半透明画布)
- **拒绝分裂**：Story Player 不再是独立的 `/story/[storyId]` 黑暗页，而是作为 Hub 的一个全屏 Drawer 或毛玻璃遮罩层 (`Theater Overlay`)。
- **保留上下文**：回放时，Hub 原始的侧边栏、顶栏通过 `backdrop-filter: blur(12px)` 半透明可见。主工作区演变为大剧院画布，延续 Hub 的卡片边框、品牌色体系与字体规范，确保视觉对齐。

##### 2. 核心转场：子弹时间与粒子飞线 (Bullet Time & Particle Pan)
- **快进态 (100x Fast Forward)**：
  - 消息极速狂飙，文字以 cinematic 模式暴风式显现（一秒数千字）。
  - 配以解压、清脆的“嗒嗒嗒”快节奏机械键盘打字音效（可静音）。
  - 当前发言的 Thread 处于 **Spotlight 聚光灯高亮态**（带光晕特效），非活跃 Thread 处于毛玻璃 Dimmed (虚化) 状态。
- **子弹时间 (Bullet Time Slowdown)**：
  - 一旦触发 `@mention`、`cross_post` 或 `thread_split` 等因果传球事件，回放速度平滑曲线降速（100x -> 1x -> 0.5x）。
  - **因果粒子飞线 (Causal Particle Beam)**：一束带有发信猫猫头像与流光粒子的电磁飞线，从源 Thread 吐字处射出，在屏幕空间划过一道优雅的抛物线，飞向目标 Thread。
  - **波纹涟漪 (Ripple Aura)**：粒子飞线击中目标 Thread 的瞬间，目标 Thread 边框亮起并产生一圈淡金色的涟漪动画。
  - 涟漪消退后，播放速度平滑拉升回 100x，目标 Thread 开启高亮吐字。
  - 这样能保证 100x 狂奔下，operator依然能看清每次“球权转移”和“跨 thread 协同”的瞬间。

##### 3. 多 Thread 活跃布局：多机位协同分屏 (Multi-Cam Stage)
- **单机位模式 (Single Stage)**：只有 1 个 Thread 活跃时，独占中央舞台。
- **协同双机位 (Split-Screen View)**：
  - 当 Thread 0 @ 唤醒了 Thread 1 协同，Thread 0 卡片自动平滑左移，Thread 1 从右侧以毛玻璃淡入，两者呈 50/50 左右分屏。
  - 时间轴硬对齐，观众能同时看到左侧猫猫提问/传球，右侧猫猫瞬间接球、启动工具写代码的同步画面。
- **多机位群像 (Backstage Monitors)**：
  - 如果有多于 2 个 Thread 并发活动，中央舞台仅展示最近活跃的 2 个 Thread。
  - 其他 Thread 在侧边/底部缩微为“小监视器”预览，监视器内有极微小的打字流动微动。
- **猫猫状态 Live Avatar (猫猫大剧院的灵魂微动画)**：
  - 💻 **Coding中**：猫爪在键盘上飞速扒拉，键盘冒火花。
  - ⚙️ **Tool Running**：猫猫带上高科技眼镜，双眼发蓝光（算力满载）。
  - 💤 **Idle等待/CI中**：猫头冒出“Zzz”气泡，或者在无聊地舔毛、玩毛线球。
  - 🐾 **Handoff传球**：猫猫做出一个把“发光的毛线球（代表球权）”用力拍飞的动作！

##### 4. 跨 Feature 依赖：客串卡片 (Guest Cameo Slide-in)
- **场景**：做 F252 时，发现了依赖项 F666 的 bug，发送了 cross-post 通知 F666。
- **设计**：
  - F666 并非本 Feature 的泳道，但属于该时间线上的因果连通点。
  - 触发跨 feature 传球时，右侧以 Slide-in (滑入) 飞入一个带有虚线金边的 `[Guest Cameo: F666]` 临时卡片。
  - 飞线划入该卡片，消息显示。
  - 当该互动结束且无后续因果回流，客串卡片在 2 秒内优雅淡出，防止主画布拥挤。

##### 5. 进度条与章节锚点：电影胶卷时间轴 (Cinematic Film-strip)
- 进度条背景融合事件密度的微型热力图 (Event Density Heatmap)，哪里有猫猫大混战（多猫密集交互）一目了然。
- F233 投影的 `phase_transition`、`pr_merged` 节点，在胶卷上显示为金色的“打卡锚点 (Milestone Badges)”，鼠标悬停有浮窗摘要（如“🎬 Phase A 封板”、“🔧 首次联调”），点击可瞬间 seek 过去。
- **无聊等待压缩 (Idle Collapse)**：当猫猫在等待 CI/Build 超过 10 秒时，画面呈现老式磁带快进的拉丝条，并伴随老式快进沙沙声，直接拉快进（“⏩ 正在快进 CI 编译... 1m.. 2m.. Done!”），绝不拖泥带水。

### 旅程 2：Feature 回放（多 Thread 协作的录像回放）— 展示级

**场景**：向投资人/用户/同行展示 Cat Café 多猫协作完成一个复杂 Feature 的全貌
**入口**：Feature 相关界面 → "回放 Feature 故事"
**体验**：点回放 → 看到多只猫在多个 thread 里**同时干活**的全过程录像。多条泳道同时播放，消息在各 thread 里同时蹦出来，猫猫 A 在 thread 1 写代码的同时猫猫 B 在 thread 2 做 review，传球时箭头动态飞过去、自动减速让观众看清楚发生了什么。（operator experience："我想要的是动态的啊！！很生动的你们这群猫猫都是如何开始做的"）
**操作**：多 thread 同步播放 → 看到猫猫在各 thread 同时工作 → 传球时自动减速 + 箭头动画 → 暂停讲解 → 钻入单 thread 看细节（旅程 1）
**当前状态**：❌ 做的是**静态泳道图**（几个小圆点 + 死箭头 + "Cross-post by opus" 标签），完全不是动态回放。入口还藏在 TrajectoryPanel 子面板里找不到

#### 转场设计（operator 2026-06-27 — 核心导演问题，需 @gemini 讨论）

旅程 1（Thread）和旅程 2（Feature）不是两个割裂的维度——**Thread 本身就涉及多 thread 协同**。一个 thread 干着干着就会 cross-post 到另一个 thread，而那个 thread 可能属于完全不同的 Feature。所以回放时的**转场感知**是核心体验问题：

**场景 A — 被动接收**：Thread 0 在播放，突然 Thread 1 发来一条 cross-post 消息
- 观众怎么感知到"有外部消息进来了"？
- 要不要切镜头/分屏/画中画？怎么表现"另一个地方发生了事"？

**场景 B — 主动发起**：Thread 0 干着干着，猫猫主动 @ 另一个 thread 请求协同
- 镜头要不要跟过去？
- 跟过去之后怎么回来？
- 另一个 thread 接到协同请求后开始工作，这段要不要同步展示？

**场景 C — 跨 Feature 依赖**：做 F252 时发现依赖 F666 的东西有 bug，cross-post 通知 F666 的 thread
- F666 的 thread 和 F252 没有 Feature 关联！
- 但这是 F252 工作过程的一部分——"我发现了问题并通知了对方"
- 回放时要不要把 F666 的 thread 短暂拉进来？

**operator experience**："你得好好想想 就是你们得思考 这时候你得是导演艺术家！想想比如要怎么转场？"

**本质洞察**：回放的边界**不是 Feature 下的 thread 列表**，而是**因果链连通的所有 thread**（包括跨 Feature 的）。Feature 只是一个默认起点/入口，实际回放范围随因果链动态扩展。

**开放设计题（需要和Siamese讨论的）**：
1. 转场的视觉语言——怎么让"镜头切换"自然不突兀？
2. 多 thread 同时活跃时的画面布局——并排泳道？分屏？画中画？焦点切换？
3. 跨 Feature 的因果边怎么呈现——临时拉入一个"客串" thread？
4. 音效/动画节奏——传球时减速多少？跳过 idle 时怎么表现时间流逝？

### 旅程 3：分享（发给不在场的人）

**场景**：生成一个链接，对方打开就能看回放
**入口**：回放页面 → 导出 → 生成脱敏公开链接
**体验**：对方打开链接就能看到和旅程 1/2 一样的动态回放录像，只是敏感信息已脱敏
**当前状态**：⚠️ 后端 API（sanitizer + export store + public route）已有（Phase D），但前端回放本身不 work（bug：显示 "— system —" + 大面积空白 + 时间显示 "-49:-9"）

### 跨旅程问题

- **UI/UX 完全脱离 Hub**：Story Player 是独立 `/story/[storyId]` 页面，暗色主题、独立布局，与 Hub 设计语言零复用（operator experience："甚至什么独立做了个这么丑的东西对齐了我们的 ui/ux 吗？"）
- **未走 Design Gate**：4 个 Phase 全部做完前端，从未让operator审核设计（违反 `feedback_ux_design_review.md`）
- **回放功能本身有 bug**：点播放后只显示 "— system —" + 空白，409 个事件不渲染

## Current State / 现状基线

### 事件级数据（Phase A/B 数据源）

- **events.jsonl**：每个 session 的完整事件流，每条事件带毫秒级时间戳 `t`（epoch ms）、顺序 `eventNo`、`invocationId` 分组。
- **事件类型**：TranscriptFormatter 兼容 `text`/`assistant`/`user`/`system`/`tool_use`/`tool_result`/`session_init`/`done`；工具名存在 `toolName` / `name` 双形态（`TranscriptFormatter.ts:87`）。**Phase A 需要 `TranscriptEvent → ReplayEvent` adapter 做归一化**。
- **Session API 已有**：`GET /api/sessions/:sessionId/events?view=raw` 分页返回原始事件（cursor + limit）；`view=chat` 返回对话视图；`view=handoff` 返回按 invocation 聚合的摘要。
- **前端渲染组件已有**：`bubble-event-adapter.ts`、`useAgentMessages.ts`、`chatStore.ts` 知道如何渲染消息/工具调用。

### Feature 级轨迹数据（Phase C 数据源）— F233 已有资产

**F233 Phase C C2a/C2b 已 merged（2026-06-21）**，落地了 feature trajectory 投影框架。**注意区分 schema 声明 vs projector 实现状态**（R2 review 教训：schema declaration ≠ runtime behavior）：

| 资产 | 位置 | 当前实现状态 | F252 消费方式 |
|------|------|-------------|---------------|
| `FeatTrajectoryProjection` schema（13 kinds） | `shared/types/feat-trajectory.ts:261` | ✅ schema ready | 泳道 + 章节 + 里程碑的数据源 |
| `FeatTrajectoryEntry`（entryId / subjectKey / at / kind / source / provenance） | 同上:225 | ✅ schema ready | 因果边 + 时间轴节拍 |
| `FeatTrajectoryProjector` + `RedisFeatTrajectoryStore` | `api/domains/feat-trajectory/` | ✅ 框架 ready | 服务端投影，F252 只读消费 |
| `GET /api/feat-trajectory/:featId` | `api/index.ts:2911-2922` | ✅ 路由 ready | Phase C 查询入口 |
| 三源 contract（event-stream / historical-stitched / git-ref-snapshot） | 同上:26-29 | ⚠️ 见下方 | 覆盖实时 + 历史 + git 三维数据 |
| provenance + confidence invariant | 同上:73-78 | ✅ schema ready | 箭头实线/虚线（high/medium/low） |
| `closed` kind（ball-shaped） | `FeatTrajectoryProjector.ts:58-64` | ✅ **已实现**：`ball.handed_cvo intent=done_notify → closed` | feature 关闭标记 |
| git-shaped kinds（`branch_pushed` / `pr_opened` / `branch_merged_to_main` / `branch_stale_unmerged`） | `GitRefSnapshotCollector` | ✅ **已实现**（server-side cron census） | git 事件标记 |
| `thread_split` / `thread_merge` | `ThreadSplitCollector` + `CrossPostCollector` | ✅ **已实现**（PR #2575, 2026-06-26）——独立 collector 从 proposal store / message store 采集，scheduler 编排 | F252 Phase C 跨 thread 因果边的核心数据源 |
| `pr_merged` / `phase_transition` / `verdict` / `reopened` | schema:36-43 | ❌ **schema 已声明但 projector 未实现** | Phase C 可用 `branch_merged_to_main`（git-shaped）部分替代 `pr_merged`；`phase_transition`/`verdict`/`reopened` 是增量富化，非 swimlane 核心 |
| `applyStitchedEntry`（历史回填） | `FeatTrajectoryProjector.ts:278` | ❌ **throw 'step 5+ RED'** | 老 feature 的历史叙事暂无 |

**关键洞察**：F252 Phase C 是 **Feature Story Renderer**（消费 F233 投影做可视化），不是 Feature Story Builder（从零建数据层）。一套真相源——观众看到的故事和 operator 在值班简报里看到的轨迹是同一份账本。**F233 projector 现产 `closed` + git-shaped + `thread_split` + `thread_merge` entries（PR #2575, 2026-06-26）。Phase C 核心泳道 + 因果链所需的两个跨 thread emitters 已就位**。`pr_merged`/`phase_transition` 等增量 emitters 可在 Phase C 实现中按需补齐。

### 缺失

- 无回放引擎（时间轴管理、倍速、暂停、seek）
- 无 `TranscriptEvent → ReplayEvent` adapter（事件类型归一化）
- 无多 thread 泳道视图
- 无因果链可视化渲染
- 无 Story 持久化 / 脱敏导出 / 公开分享
- Sealed transcript 只有最终文本，**无逐 token 流式数据**（需模拟打字效果）

## What

### Phase A: 单 Session 回放引擎 + 基础 UI

核心回放能力。选一个 session，以可变速度回放其事件流。**纯前端，不需要后端新 endpoint**。

- **TranscriptEvent → ReplayEvent Adapter**：
  - 归一化事件类型：`text`/`assistant` → `message`；`tool_use` + 对应 `tool_result`（via `toolUseId`）→ `tool_call`
  - 归一化工具名：`toolName` / `name` 双形态统一为 `toolName`
  - 输出 `ReplayEvent { type, timestamp, duration?, content, toolName?, toolInput?, toolResult? }`

- **Replay Engine（纯前端逻辑层）**：
  - 读取 session events（via 现有 API），经 adapter 转为 ReplayEvent 序列
  - 计算相邻事件间的 time delta
  - 根据倍速系数计算播放时刻：`playbackTime = delta / speedMultiplier`
  - 状态机：`idle → playing → paused → playing → ended`
  - 支持 seek（跳到任意 eventNo）

- **Speed Control**：
  - 固定倍速：1x / 10x / 50x / 100x
  - MAX 模式：瞬间跳到下一事件（无等待）
  - 键盘快捷键：空格暂停/继续，左右箭头单步

- **Text Animator**：
  - 文本消息逐字符/逐词显现（cinematic/simulated 模式，默认），速度随全局倍速联动
  - 100x 时 = 一秒几千字的视觉效果
  - 保留 **faithful 模式**：整段显现，忠实于事件粒度（UI 标注 "cinematic" vs "faithful"）

- **Tool Call Renderer**：
  - 显示工具名 + 参数摘要
  - 结果用折叠面板展示（可展开看完整输出）
  - 原始等待时间用 **log 压缩**（不是固定时长）：10s→3s, 60s→6s, 600s→12s。保留"等 npm install 期间多猫并行干别的"的叙事感（opus-47 review）

- **基础 UI + 路由**：
  - 统一路由模型 `/story/:storyId`（opus-47 P2）
  - **storyId 语义**：`session:<sessionId>` = ephemeral 单 session 回放（前端直接用 sessionId 查 events API，无需后端持久化）；持久化 story 用 UUID storyId（Phase D 创建）。Phase A 只用 ephemeral 模式，故**纯前端成立**
  - 聊天区：复用现有 bubble 组件渲染消息
  - 底部控制条：播放/暂停 + 倍速选择 + 进度条（可拖动 seek）+ 时间显示（原始时长 / 回放时长）
  - 全屏沉浸式布局，干净背景

### Phase B: 自适应节奏 + 章节系统

智能回放节奏，让观众不需要手动调速。**优先使用 F233 entries 当章节锚**。

- **自适应节奏引擎**：
  - 根据事件密度自动调速——密集段减速，稀疏段加速
  - Idle gap > 配置阈值（默认 5 min）→ 自动跳过，显示"⏩ 跳过 23 分钟"
  - 传球事件（@mention / cross_post）→ 自动减速 + 高亮
  - 用户可切换为固定倍速覆盖

- **Chapter System（章节）**：
  - **多 session story**：从 `FeatTrajectoryProjection.entries` 提取章节锚——`launched`、`phase_transition`、`pr_merged`、`verdict`、`closed` 等 kinds 天然就是叙事节拍
  - **单 session story**：从 session digest + 事件密度变化提取章节（session 开始、首次工具调用、关键传球、session 结束）
  - 时间轴上显示章节标记，点击跳转
  - 支持手动添加章节标注

### Phase C: Feature Story Renderer（多 Thread 泳道 + 因果链）

从单 session 升维到 feature 级全景叙事。**数据层复用 F233 `FeatTrajectoryProjection`，本 Phase 只做渲染层**。

- **双层数据架构**：
  - **骨架层**：`GET /api/feat-trajectory/:featId` → `FeatTrajectoryProjection`（F233 已有）。提供 feature 级时间线、thread 关联、因果边（`thread_split`/`thread_merge`/`pr_merged` 等 kinds）、provenance + confidence
  - **细节层**：`GET /api/sessions/:sessionId/events` → 事件级回放（Phase A 已有）。用户点击泳道色块 → drilldown 到对应 session 的单 session 回放器
  - **薄 BFF 层**（新建）：`GET /api/story/:storyId/rendering` — 把 F233 投影 entries 映射成 Story rendering DTO（泳道布局坐标 + 因果边几何），前端直接消费

- **泳道视图（Swimlane View）**：
  - Thread 列表从 `payload.snapshot.associatedThreadIds`（git-ref entries）+ story metadata + thread/session store 提取。**不从 `subjectKey` 反推**——`subjectKey` 语义是 `feat:{featId}` 或 `git-ref:{branchName}`，不含 thread 信息（`feat-trajectory.ts:234`）
  - 每个 thread 一条泳道，显示 thread 名称 + 参与猫猫头像
  - Session 活动期显示为色块（颜色按猫猫区分）
  - 时间轴水平滚动，垂直堆叠泳道
  - 点击色块 → 跳入 Phase A 的单 session 回放（三层缩放的"剧场"层）

- **因果链可视化**：
  - 因果边来自 F233 投影的 `thread_split` / `thread_merge` / `pr_merged` 等 kinds（**不是**从 events 启发式推断）
  - 每条边带 provenance + confidence：`high` → 实线箭头，`medium` → 虚线，`low` → 点线
  - 箭头标注 kind 和 payload 摘要（"thread_split: @codex request-review" / "pr_merged: #2547"）
  - 回放时箭头随时间轴动态出现

- **三层缩放**：
  - **鸟瞰（Birdseye）**：Feature 级泳道图，全景概览（数据源 = F233 投影）
  - **剧场（Theater）**：点击泳道色块 → 单 session 回放（数据源 = events.jsonl）
  - **显微镜（Microscope）**：暂停后点击消息 → 展开完整内容（代码 diff / 工具输出 / 思考过程）

- **路由**：统一 `/story/:storyId`。Story 可以包含 1 个 session（= Phase A 视图）或 N 个 thread（= feature 视图）。Session 是 Story 的一种特例，URL 模型不分裂。

### Phase D: 注解层 + 脱敏分享

演示增强和传播能力。**公开分享需要脱敏 export 包**。（后端 API 可用，前端 Phase E 重做）

- **Annotation Layer**：
  - 在任意时间点/事件上添加注解卡片
  - 注解类型：文字旁白、高亮框、箭头指示
  - 注解数据独立存储（`data/stories/:storyId/annotations.json`），不污染原始 transcript
  - 回放时注解自动弹出 / 暂停模式下手动浏览

- **Story 编辑器**：
  - 选择 Feature / Thread / Session 组合创建 Story
  - 添加标题、描述、注解
  - 保存为可分享的 Story 实体

- **脱敏 Export 包**（新建后端 API）：
  - `POST /api/story/:storyId/export` → 生成脱敏后的 Story 数据包
  - 过滤范围覆盖**所有 content 字段**（不只 tool 边界）：
    - tool args / tool output 中的路径、token、env、API key
    - assistant text 中的代码路径、worktree 路径、内部票据
    - 私有 repo 细节、个人信息
    - 平行猫内部名字（保留公开猫名）
  - 脱敏审核记录入 ledger
  - 默认**关闭**公开分享；需手动生成 export 包后才能开启

- **公开分享**：
  - 生成 `/story/:storyId/public` URL
  - Public URL 只读**脱敏 export 包**，不直连 raw transcript API（现有 transcript API 有身份 + thread/cat 访问控制，`session-transcript.ts:71`）
  - 嵌入式 iframe 支持

### Phase E: 前端重做 — 猫猫大剧院 Meow Theater MVP（operator 确认 2026-06-27）

> **起因**：operator 实际体验 Phase A-D 后发现三个根本问题：(1) 回放有 bug 不工作，(2) 全程未走 Design Gate，(3) UI/UX 完全脱离 Hub 设计语言。Phase A-D 后端可用（adapter、engine、sanitizer、export API），**前端需要全部重做**。

> **视觉铁律**："100% 看起来就是你们平时的样子加特效和快进"——直接复用 Hub 现有组件渲染，不做新渲染组件。

> **设计方向**：Siamese (@gemini) "猫猫大剧院" 设计 spec（operator 确认核心思路）

- **P0 Bug Fix**：当前 409 事件回放显示空白 "— system —" + 时间 "-49:-9"，先修这个

- **Hub Theater Overlay**：
  - Story Player 不再是独立 `/story/[storyId]` 黑暗页，改为 Hub 全屏 Drawer / 毛玻璃遮罩层
  - 回放内容直接复用 Hub 现有聊天气泡、工具卡片组件渲染（视觉铁律）
  - Hub 侧边栏、顶栏通过 `backdrop-filter: blur(12px)` 半透明可见

- **Thread 级回放（旅程 1 修正）**：
  - 当前只有单 session 回放，需升级为 thread 级——**同一 thread 下所有 session 按时间串联**
  - 入口从 Thread 列表直接触发，不是藏在 session 详情里

- **Spotlight + 子弹时间转场**：
  - 活跃 Thread 聚光灯高亮，非活跃 Dimmed 虚化
  - 传球事件（@mention / cross_post）触发子弹时间降速 100x → 1x → 0.5x
  - 因果粒子飞线（CSS 弧线动画 MVP，Canvas/WebGL 留后续）

- **多机位分屏（Multi-Cam Stage）**：
  - 单 Thread 活跃 → 独占中央
  - 双 Thread 协同 → 50/50 左右分屏，时间轴硬对齐
  - 多 Thread → 主活跃 2 个居中，其余缩微为侧边小监视器

- **客串卡片（Guest Cameo）**：
  - 跨 Feature 的因果传球 → 虚线金边临时卡片 slide-in
  - 互动结束后 2s 优雅淡出

- **时间轴热力图 + 章节锚点**：
  - 进度条背景融合事件密度热力图
  - F233 投影的 phase_transition / pr_merged 显示为金色锚点，hover 浮窗摘要

- **留到后续增强（非 Phase E scope）**：
  - 猫猫 Live Avatar 微动画（需美术素材）
  - 音效（默认静音，可选开启）
  - 粒子飞线 WebGL 版
  - 老式磁带快进拉丝条视觉

## Acceptance Criteria

<!-- 立项愿景硬度自检（F216→F219）：每条 AC ① trace 回 Why「现场跑太慢+看记录没冲击力→要高速回放」② 非作者可复核（命令/截图/操作路径）。 -->

### Phase A（单 Session 回放引擎 + 基础 UI）✅
- [x] AC-A1: 选择任意 sealed session → `/story/:storyId` 页面以 100x 速度回放完整事件流，文本消息以 cinematic 模式逐字显现，可切换为 faithful 整段显现（trace Why「100倍速+一秒几千字」；复核：选一个 ≥50 event 的 session 回放，录屏对比两种模式）
- [x] AC-A2: 工具调用显示工具名+参数摘要，原始等待时间用 log 压缩渲染（10s→3s, 60s→6s），非固定时长（trace Why「toolcall 回放就是立刻马上好」+ 保留多猫并行叙事感；复核：包含 ≥3 个 tool_use 的 session 回放验证压缩比例）
- [x] AC-A3: 播放/暂停/倍速切换（1x/10x/50x/100x/MAX）+ 进度条拖动 seek 全部可用（trace Why「到某个节点能暂停」；复核：手动操作每个控件）
- [x] AC-A4: 空格键暂停/继续，← → 单步前进/后退（trace Why「暂停讲解」；复核：键盘操作测试）
- [x] AC-A5: `TranscriptEvent → ReplayEvent` adapter 正确处理 `text`/`assistant`/`user` 多形态事件 + `toolName`/`name` 双形态工具名，有单元测试覆盖（trace Why「数据正确性是回放可信度基础」；复核：`pnpm test` 相关 adapter 测试全绿）

### Phase B（自适应节奏 + 章节）✅
- [x] AC-B1: Idle gap > 5min 自动跳过 + 显示跳过提示；传球事件（@mention）自动减速 + 高亮；用户可切换为固定倍速覆盖（adaptive toggle 控制 idle skip + pass-ball slowdown）（trace Why「回放节奏合理」；复核：含长 idle 段的 session 验证自动跳过，toggle OFF 后验证 idle 不再被跳过）
- [x] AC-B2a: 单 session 章节标记从 event 结构提取（invocation 边界、传球事件、idle gap 恢复点），进度条上可点击跳转（trace Why「到某个节点暂停讲解」；复核：选一个 ≥3 invocation 的 session 验证章节标记出现且可跳转）
- [ ] AC-B2b: **[Phase C 前置]** 多 session story 的章节标记来自 F233 `FeatTrajectoryProjection.entries`（`phase_transition`/`pr_merged`/`verdict` 等 kinds），依赖 AC-C0 emitter 补齐（trace Why「feature 级跨 thread 章节」；复核：选一个有 phase_transition 的 Feature 验证跨 session 章节标记）

### Phase C（Feature Story Renderer 多泳道 + 因果链）✅
- [~] AC-C0: **前置条件**：F233 emitters 补齐 `thread_split`/`thread_merge`/`pr_merged`/`phase_transition` 四个 ball-shaped kinds 已 merged 且在生产环境产出 entries（trace Why「Phase C 灵魂依赖跨 thread 因果边」；复核：`GET /api/feat-trajectory/:featId` 返回含 `thread_split` kind 的 entries）— **2/4 done**：`thread_split` + `thread_merge` merged (PR #2575)；`pr_merged`/`phase_transition` schema declared but projector not implemented；`branch_merged_to_main` (git-shaped) partially substitutes `pr_merged`
- [x] AC-C1: 输入 Feature ID → 消费 `GET /api/feat-trajectory/:featId` 自动构建多 thread 泳道图，thread 列表从 `payload.snapshot.associatedThreadIds` + story metadata + thread/session store 提取（不从 subjectKey 反推），每个 thread 一条泳道（trace Why「涉及多个thread」；复核：选一个 ≥2 thread 的 Feature 验证泳道与 F233 投影一致）
- [x] AC-C2: 因果边来自 F233 投影的 `thread_split`/`thread_merge`/`pr_merged` kinds（不是事件层启发式），以动画箭头显示，箭头样式反映 provenance.confidence（high=实线, medium=虚线, low=点线）（trace Why「事件驱动」；复核：选一个有 thread_split 的 Feature 验证箭头+样式）
- [~] AC-C3: 三层缩放可用——鸟瞰（F233 投影）点色块 → 剧场（events.jsonl 回放）→ 暂停点消息 → 显微镜展开完整内容（trace Why「既能看全景又能看细节」；复核：从鸟瞰一路 drill-down 到消息详情）— **Birdseye done**；Theater + Microscope drill-down not yet connected

### Phase D（注解 + 脱敏分享）✅ — 后端 API 可用，前端 Phase E 重做
- [x] AC-D1: 可在任意时间点添加文字注解，回放时自动弹出（trace Why「暂停讲解」；复核：添加注解后回放验证弹出）
- [x] AC-D2: 公开分享读脱敏 export 包（不直连 raw transcript API），过滤覆盖 tool args/output + assistant text + system event 中的路径/token/env/个人信息，脱敏审核入 ledger（trace Why「向外展示」；复核：生成 export 包 → 隐身窗口打开 public URL → 搜索已知敏感字符串确认不泄露）

### Phase E（前端重做 — 猫猫大剧院 Meow Theater MVP）✅ implementation complete — dogfood realism fix merged, pending operator re-dogfood

**PR E-1（核心基础层）merged** (PR #2605, `e987eb812`, 2026-06-27)
- `replay-chat-bridge.ts`：ReplayEvent → Hub-native ReplayChatMessage 桥接（14 tests）
- `merge-session-events.ts` + `thread-replay-fetcher.ts`：thread 级多 session 合并 + status-filtered 获取（8 tests，composite sessionId:toolUseId key 隔离跨 session tool ID 碰撞）
- `TheaterOverlay.tsx`：全屏 portal（backdrop-blur-md + z-[60]）
- `ReplayMessageList.tsx`：Hub-native MessageBubble/ThinkingContent/CliOutputBlock + per-cat --msg-hue/--msg-chroma（F056 token chain）+ displayMode(cinematic/faithful) 正式接入
- `TheaterReplayContent.tsx` + `useThreadReplay.ts`：编排层（engine.displayMode 透传）+ scroll paddingBottom:64px
- `ThreadItem` "回放剧场" 菜单入口 + `ThreadSidebar` TheaterOverlay state management
- 测试：171/171 全绿（+22 新）；5 cloud review rounds（R1-R5）；封板后 gpt52 local final SHA APPROVED

**PR E-2（引擎增强 + sunset）merged** (PR #2613, `b9043a07f`, 2026-06-27)
- `bullet-time.ts`：三段式 easing（decel 400ms → hold@0.01 1000ms → accel 600ms，总 2000ms）（7 tests）
- `replay-engine.ts`：tick/seek/step 全 11 个返回路径显式处理 bulletTime 状态（22 tests）
- `event-density.ts`：index-proportional 分桶 + events/ms 速率密度（12 tests）
- `EventDensityBar.tsx`：进度条热力图叠层
- `page.tsx`：独立 `/story/[storyId]` 页面 sunset（重定向到 Hub Theater）
- `SessionChainPanel.tsx`：sealed session "🎬 回放" 入口移除（全走 Theater）
- 测试：4843/4843 全绿；Cloud R3 封板（2 real P2 fixed，1 pushback accepted）；gpt52 local final SHA APPROVED on `84c9dc9d5`

**PR E-3（测试卫生 + milestone badge）merged** (PR #2619, `e105ccaaeb`, 2026-06-27)
- `bullet-time-engine.test.ts` → 3 files split（opus-47 P2：552 lines 超 350 硬限）
- `ChapterBadge.tsx`：kind-differentiated styling + hover tooltips with actual timestamps
- F190 typography token fix + chapter dedup edge case fix
- 测试：230 story-player tests；Cloud R2 clean（R1: 1 P2 fixed）；gpt52 local APPROVED

**PR E-4（多机位分屏 + Spotlight/Dim）merged** (PR #2620, `f277b26923`, 2026-06-27)
- `feature-replay-merger.ts`：多 thread 事件合并 + sourceThreadId 标注（10 tests）
- `active-thread-tracker.ts`：detectActiveThreads 30s 后向扫描 + CamLayout 决策（13 tests）
- `build-thread-panels.ts`：纯函数面板构建器 — ALL lanes → mode assignment（spotlight/active/dim）+ recency 排序（13 tests）
- `useFeatureReplay.ts`：Feature 级回放编排 hook（294 lines）
- `MultiCamStage.tsx`：单机位/双机位/多机位布局组件
- `ThreadPanel.tsx`：per-thread 渲染面板 + AC-E3 CSS spotlight/dim 特效
- `FeatureTheaterContent.tsx`：Feature 回放编排层
- 测试：13 panel + 10 merger + 13 tracker = 36 新测试；Cloud R3（1 P2 stale replay of pushbacked finding）；gpt52 local APPROVED on `0802d4dae`

**PR E-5（客串卡片 Guest Card）merged** (PR #2669, `f9c1661b47`, 2026-06-29)
- `cross-feature-detector.ts`：`normalizeTool()` + `endsWith(CROSS_POST_SUFFIX)` 统一 MCP 别名变体（16 tests）
- `GuestCard.tsx`：虚线金边卡片 + FADE_DELAY_MS(2000) + FADE_TRANSITION_MS(300) 两阶段淡出（13 tests）
- `buildFeatureStoryRendering.ts`：`ownedThreadIds` 仅 `thread_split` + `git-ref-snapshot` 确立归属（`thread_merge` 不算——CrossPostCollector fallback 会误归属）+ `SwimlaneDTO.guest` 标记（13 API tests）
- `adaptive-pacing.ts`：`PASS_BALL_SUFFIXES` endsWith 匹配（审计同型 normalization gap）（22 tests）
- `FeatureTheaterContent.tsx`：`key={activeCardData.eventIndex}` 强制 React 重挂载（gpt52 封板 P2：同 snippet 不同事件继承旧 timer）
- `useFeatureReplay.ts`：guest lane 从 `featureThreadIds` 过滤 + `guestCard` 状态产出
- 测试：13 API + 16 detector + 22 pacing + 13 GuestCard = 64 新/更新测试
- Cloud R4 封板（R2 P1 guest-lane pollution fixed, R3 P2 ownership reversal fixed, R4 P2 bare alias fixed）；gpt52 local final SHA APPROVED on `515d6bfd2`

**Dogfood realism fix merged** (PR #2683, `c5db8cf0`, 2026-06-30)
- operator dogfood 反馈：回放看起来像 raw event log，不像真实聊天；章节图标墙过密；`system_info` JSON / tool fragments / merged assistant turns 与 Hub 真实消息形态不一致。
- `replay-chat-bridge.ts`：text + thinking + tool output 聚合为 Hub-native `ReplayChatMessage`，thread replay 与 feature multi-cam 共享同一桥接逻辑（no N 套真相源）。
- `ReplayMessageList.tsx`：内容感知 auto-scroll signature（message count + content/tool payload），同一 assistant turn 增长时也继续滚动。
- `adapter.ts` + `system-info-visible.ts`：复用 live chat visible system formatting，压掉 provider/runtime telemetry，保留 `warning` / `a2a_followup_available` / `session_seal_requested` / `governance_blocked` / `silent_completion` 等用户可见 notice。
- `chapters.ts`：visible chapter badges 以优先级 + gap spacing 限制密度，避免长 thread 进度条被图标墙淹没。
- 测试：Story Player 331 targeted tests + full `pnpm gate` 通过；Cloud R4 封板，Opus final review APPROVED on `c5d0d4ba1`。

**Phase E AC 状态：**
- [x] AC-E0: 修复回放 P0 bug——409 事件不渲染 + 时间显示 "-49:-9"（trace Why「基础功能不工作」；复核：选 ≥50 event session 回放，消息正常逐条出现 + 时间显示正确）**[PR E-1 ✅ 重写根本修复：effOffset()=events[i].t-events[0].t 永不为负 + fetchSessionEvents()分页全量。Sonnet alpha code-verified]**
- [x] AC-E1: Story Player 改为 Hub Theater Overlay（全屏 Drawer + 毛玻璃遮罩），不再是独立 `/story/[storyId]` 页面。回放内容直接复用 Hub 现有聊天气泡、工具卡片组件（trace Why「100% 平时的样子」；复核：回放时 Hub 侧边栏半透明可见，消息气泡与正常 Hub 外观一致）**[PR E-1 ✅ TheaterOverlay + MessageBubble 复用完成；PR E-2 ✅ 独立页面 sunset 完成]**
- [x] AC-E2: Thread 级回放——同一 thread 下所有 session 按时间串联，入口从 Thread 列表直接触发（trace Why「谁要看一个 sealed session」；复核：选 ≥2 session 的 thread 回放，验证 session 间无缝衔接）**[PR E-1 ✅ 基础架构完成；Sonnet alpha code-verified（alpha 环境无 ≥2 sealed sessions 含 events 的 thread — 同 PR E-1 验收同约束）: mergeSessionEvents() sort by t + eventNo re-index ✅；entry path ThreadItem→TheaterOverlay→useReplayEngine→fetchThreadReplayEvents→mergeSessionEvents 全链路完整，PR E-4/E-5 新增 useFeatureReplay 为平行路径未影响 thread-level path ✅]**
- [x] AC-E3: Spotlight + Dim——活跃 Thread 聚光灯高亮 + 光晕，非活跃 Thread 毛玻璃虚化（trace Why「让观众知道看哪里」；复核：多 thread 回放时只有活跃 thread 清晰）**[PR E-4 ✅ ThreadPanel spotlight=purple glow+pulse / active=border / dim=opacity 0.55+brightness 0.7+pointer-events none；13 tests]**
- [x] AC-E4: 子弹时间——传球事件触发平滑降速 100x→1x→0.5x + 因果弧线动画（CSS），降速后自动回升（trace Why「看清每次球权转移」；复核：含 @mention 的回放验证降速 + 弧线动画）**[PR E-2 ✅ 引擎层 smooth easing 完成（三段式 decel/hold/accel，22 tests）；CSS 弧线动画留后续]**
- [x] AC-E5: 多机位分屏——单 Thread 独占中央，双 Thread 50/50 分屏，多 Thread 主+侧边缩微（trace Why「多猫同时干活」；复核：Feature 回放验证布局随 Thread 数动态切换）**[PR E-4 ✅ MultiCamStage single/dual/multi layouts + detectActiveThreads 30s backward scan + buildThreadPanels recency ordering + feature-replay-merger unified timeline；13 panel tests + 10 merger tests + 13 tracker tests]**
- [x] AC-E6: 客串卡片——跨 Feature 因果传球时虚线金边卡片 slide-in，互动结束 2s 淡出（trace Why「跨 Feature 依赖感知」；复核：含 cross-feature cross-post 的回放验证卡片出现+淡出）**[PR E-5 ✅ cross-feature-detector (endsWith normalization) + GuestCard (gold-dashed 2s+300ms fade) + guest lane marking (SwimlaneDTO.guest + ownedThreadIds via thread_split/git-ref-snapshot) + adaptive-pacing suffix match audit；64 new tests]**
- [x] AC-E7: 时间轴热力图 + 章节锚点——事件密度可视化 + F233 投影的 milestone badges 可点击 seek（trace Why「哪里有猫猫大混战一目了然」；复核：进度条显示密度变化，hover 锚点显示摘要）**[PR E-2 ✅ 热力图密度计算 + EventDensityBar 叠层完成；PR E-3 ✅ ChapterBadge milestone badges（kind-differentiated styling + hover tooltip with actual timestamp）]**

## Dependencies

- **Evolved from**: F233（FeatTrajectoryProjection — Phase C 的数据骨架层。F233 投影 feature 轨迹，F252 渲染为可视化 story）
- **Blocked by**: ~~F233 emitter 补齐~~ **已部分解除**（PR #2575, 2026-06-26）— `thread_split`（propose_thread→child thread）+ `thread_merge`（cross_post 回合并）两个核心跨 thread emitters 已 merged。`pr_merged`/`phase_transition` 待补齐（可在 Phase C 实现中按需追加，现有 `branch_merged_to_main` git-shaped kind 可部分替代 `pr_merged`）
- **Related**: F226（Presentation Surface / Demo Mode — 互补关系：F226 的浮窗可以在 Story Player 回放时常驻讲稿）
- **Related**: F128（propose_thread — `thread_split` kind 的上游事件源）
- **Related**: F225（Context Self-Management — 展示事件驱动协作的素材来源）
- **Related**: F102（Memory System — session digest 是单 session 章节提取的数据源）

## Risk

| 风险 | 缓解 |
|------|------|
| Sealed transcript 无 token 流，模拟打字可能看起来不自然 | Phase A cinematic 模式 + 可配置速度 + faithful 备选；调参让视觉效果自然 |
| 大 session（>1000 events）一次加载可能慢 | 已有分页 API（cursor + limit），Replay Engine 分批预加载 |
| F233 投影可能缺少某些因果边（历史 feature 只有 stitched 数据） | F233 三源 contract 预留 historical-stitched + 实时（event-stream）+ git（snapshot）；老 feature 完整历史叙事依赖 F233 `applyStitchedEntry` 实现（当前 throw RED）或降级展示；stitched 带 provenance.confidence 标注可信度 |
| 脱敏过滤可能遗漏 assistant text 中的敏感信息 | 脱敏层覆盖所有 content 字段（不只 tool 边界）+ 审核记录入 ledger + 默认关闭公开分享 |
| F233 emitter 补齐可能延迟，阻塞 Phase C | 路径 A（KD-6）：每个 emitter 是 `mapBallCustodyEventToTrajectory` 加一条 rule，工作量可控；可提前与 F233 owner 协调排期。Phase A/B 不受阻塞 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | cinematic 模拟打字作为默认渲染方式，保留 faithful 整段显现模式 | operator要"一秒几千字"的视觉冲击力；UI 标注模式名避免误导（Maine Coon+47 review） | 2026-06-25 |
| KD-2 | 后端需求按 Phase 分层：Phase A 纯前端 / Phase C 复用 F233 API + 薄 BFF / Phase D 新建 story persistence + 脱敏 export API | 初版写"纯前端不需要后端"只对 Phase A 成立；Phase C/D 有持久化、脱敏、公开分享需求（Maine Coon+47 P1） | 2026-06-25 |
| KD-3 | 多 thread 用绝对时间 `t` 对齐做泳道布局 | 所有事件的 `t` 是服务器 epoch ms，天然可对齐；F233 entries 的 `at` 也是 Unix ms | 2026-06-25 |
| KD-4 | 因果边来自 F233 投影的显式 kinds（`thread_split`/`thread_merge`/`pr_merged` 等），不做事件层启发式推断 | 因果边目标 kinds 在 F233 投影 schema 里（带 provenance/confidence），当前 runtime 须先满足 AC-C0 emitter 前置依赖；F252 不做 events 层启发式推断。从 events 反推 proposalId→threadId 链路是重复造轮子且容易遗漏（47 review 核心发现） | 2026-06-25 |
| KD-5 | Phase C 是 Feature Story Renderer，不是 Feature Story Builder。数据层复用 F233 `FeatTrajectoryProjection`，本 feature 只建渲染层。**但 F233 projector 当前只产 `closed` + git-shaped kinds**，Phase C 依赖补齐 emitters（见 KD-6） | 一套真相源——观众看到的故事和 operator 看到的轨迹是同一份账本；F233 invariant（rebuild=replay 逐字段相同）保证因果边可信度（47 review + Maine Coon R2 纠正：schema declaration ≠ runtime behavior） | 2026-06-25 |
| KD-6 | F233 emitter 补齐路径选 **A**（F252 主动驱动 F233 补 emitters），不选 B（拆 C1/C2） | Phase C 灵魂是跨 thread 因果叙事。拆 C1 = git 时间线 = 不值得单独做一个 Phase。驱动 F233 补 4 个 emitters 是前置工作但工作量可控（每个是 `mapBallCustodyEventToTrajectory` 加一条 rule）（47 R2 提出，我同意） | 2026-06-25 |

## Review Gate

- Design spec R3: @codex + @opus47 确认返工后放行 ✅
- **每 Phase review 必审**（operator 铁令）：
  1. 架构归一——是否复用了已有组件/API/数据层？有无重复造轮子？**no N 套真相源**
  2. 功能正确性 + 代码质量
- Phase A-D: 实现后 @codex review code
- **每 Phase 完成后 @opus47 愿景守护**（非作者非 reviewer）
- operator 授权自主推进，Phase 间不回报operator（2026-06-25 operator experience："不要喊我了！和Maine Coon完成协同？完成一个 phase 之后喊47愿景守护然后自己推进"）

## Tips Contribution (F244)

- 计划新增 1 条 tip：指向 `/story` 入口的使用引导（"想展示猫猫协作？试试 Story Player"）
- Phase D 分享功能上线后更新 tip 内容
