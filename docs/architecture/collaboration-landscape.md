---
title: "Clowder AI 协同全景 — 人 & 猫 & 猫的协作是怎么发生的"
doc_kind: architecture
feature_ids: [F064, F078, F079, F086, F087, F100, F108, F110, F128, F154, F155, F165, F167, F171, F193, F208, F220, F221, F224, F225, F227, F229, F231, F233, F234, F244, F245, F246, F247, F253, F254, F255, F257, F262, F264, F274, F275, F278, F280]
related_features: [F043, F052, F070, F073, F102, F114, F117, F148, F163, F169, F177, F178, F186, F188, F192, F200, F209, F236, F240, F241, F248, F250, F259, F261, F266, F267, F270, F277, F282, F285, F286, F287]
topics: [collaboration, a2a, human-cat, culture, routing, ball-custody, nurturing, taste, profile, attention-budget, teamact, harness-metabolism, memory-collaboration-loop, contract-hardening, control-plane, multi-provider, work-identity]
created: 2026-06-29
updated: 2026-08-02
status: v2
author: "Ragdoll/claude-opus-4-6 (v1), Ragdoll/claude-fable-5 (v2)"
reviewed_by: "Ragdoll/claude-opus-4-8 (structural attack v1+v2), Maine Coon/GPT-5.5 (memory-side v1+v2); v2 review pending"
---

# Clowder AI 协同全景 — 人 & 猫 & 猫的协作是怎么发生的

> 面向想理解"Clowder AI 里一次完整的人猫协作是怎么流动的"的工程师和猫猫。
>
> 本文是既有架构文档的**上位文档**——它们分别讲路由管线（`at-mention-routing-system.md`）、记忆系统（`memory-system-overview.md`）、检索管线（`retrieval-pipeline-deep-dive.md`）和 eval 系统（`eval-system-overview.md`），本文讲的是：**这些管道、加上另外三十几个 feature，如何组合成一个活的协同系统**。
>
> 如果既有文档是解剖图（每个器官怎么工作），本文是生理学图（血液怎么流过全身）。
>
> **v2（2026-08-02）**：v1 冻结于 2026-06-29（覆盖到 F255）。此后五周 F256–F287 的演化呈现清晰的主旋律转变——协同系统从"加管道"进入"**契约化 + 控制面化 + 开放拓扑化**"阶段，元轴 harness 新陈代谢从设计变为实跑（F234 reopen + SOP 手术落地）。v2 记录这个阶段转变；变更清单见文末 Changelog。

---

## 这份文档解决什么问题？

Clowder AI 五个月迭代了 280+ feature，涉及"协同"的至少 40 个。它们散落在各自的 spec 里，每个 spec 讲自己的 Why/What，但没有一份文档回答：

1. **一次完整的人猫协作，从头到尾经过哪些管道？**
2. **猫猫之间传球、接球、卡住、球掉了，分别触发什么机制？**
3. **猫怎么越来越认识operator？operator怎么越来越放心不看？**
4. **协同系统本身怎么自我进化、怎么退役过时的规则？**
5. **这一切背后的协作文化——"我们的协作方式本身"——是什么？**
6. **（v2 新增）协同的等待、回执、审批、工作归属，怎么从口头约定变成可证明的契约？**

---

## 全景地图：三个正交视角 + 三条 v2 主线

协同全景仍由**三个正交视角**构成（v1 框架，继续成立）：

| 维度 | 回答什么 | 下文章节 |
|------|---------|---------|
| **主体轴（三圈）** | 谁和谁协同 | 圈一·猫↔猫 / 圈二·人↔猫 / 圈三·三角交叉 |
| **机制轴（TeamAct）** | 协同怎么循环流动 | 贯穿三圈的主循环 |
| **元轴（Harness 新陈代谢）** | 协同系统怎么自我进化/退役 | 独立一节 |

F234 之后的演化在这个框架上叠加了**三条主线**（v2 新增视角）：

| 主线 | 一句话 | 代表 feature |
|------|--------|--------------|
| **契约化** | 协同原语从"约定+尽力而为"变成"可声明、可回执、可归属的契约" | F264 回执 / F280 等待契约 / F275 工作身份 |
| **控制面化** | 协同状态从"散落在 thread 里"收敛成 operator 驾驶舱 | F246 审批中心 / F233 值班简报 / F262 档位 / F277(spec) |
| **开放拓扑化** | 坐上桌的从"本地 CLI 双家族"扩展到云端猫、新家族、社区 provider | F247 云端猫 / F274 Kimi L0 / F241(spec) / F240 |

```
┌───────────────────────────────────────────────────────────────────────┐
│  元轴：Harness 新陈代谢（协同系统的自我进化）                          │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ F245 摩擦采集 → F278 责任处置 → F100 自进化 → F114/F177 硬化   │  │
│  │ → F192/F266/F267 eval 闭环 → F234 sunset（第一刀已落）→ F286(s)│  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│                     ┌─────────────────────┐                            │
│                     │    operator (operator)      │                            │
│                     └──┬───────────────┬──┘                            │
│         ┌──────────────┴─────┐   ┌─────┴──────────────┐               │
│         │ 控制面（驾驶舱）    │   │ 人 ↔ 猫 记忆 Lanes │               │
│         │ F246 审批中心      │   │ F231 profile        │               │
│         │ F233 值班简报      │   │ F221 taste          │               │
│         │ F250 计划板        │   │ F227 event          │               │
│         │ F262 思考档位      │   │ F255 dream→通水     │               │
│         │ F277 注意力导航(s) │   └──┬────────┬─────────┘               │
│         └──────────┬─────────┘      │        │ ◄── 协作事件生产记忆    │
│         ┌──────────┴─────┐    ┌─────┘        │      记忆注入改变协同    │
│         │ 人 → 猫入口     │    │  ┌──────────┐│                        │
│         │ 猫猫球 F229     │    └─►│ 注意力   ││                        │
│         │ bootcamp 族     │       │ 预算     │◄┘                       │
│         │ F155/F244 引导  │──────►│ 决策漏斗 │                         │
│         └────────────────┘       └────┬─────┘                         │
│                                        │                               │
│               ┌────────────────────────▼────────────────┐              │
│               │            猫 ↔ 猫 协同                 │              │
│               │  ┌──────────────────────┐               │              │
│               │  │ TeamAct 主循环       │  1↔1  1↔N    │              │
│               │  │ State → Owner →      │  N↔1  自↔自  │              │
│               │  │ Action → Evidence →  │               │              │
│               │  │ Verdict → Route      │               │              │
│               │  └──────────────────────┘               │              │
│               │  ── 契约层（v2 新硬化）──               │              │
│               │  F264 消息回执 · F280 等待契约          │              │
│               │  F275 工作身份 · F254 freshness         │              │
│               └─────────────────────────────────────────┘              │
│                                                                        │
│  ═══════════════ 拓扑环：谁能坐上桌（v2 扩张中）═══════════════        │
│  本地 CLI 家族（Claude/Codex/Gemini/GLM/AGY/Kimi F274）               │
│  + 云端猫 F247（@gpt-pro 在册） + provider 插件 F241(s)               │
│  + IM connector F240 + 物理 limb F270/F285                             │
│                                                                        │
│  ═══════════════ 基座层 ═══════════════                                │
│  记忆本体 F102/F163/F186/F188/F200/F209                                │
│  记忆注入 F148/F236/F169 · 时态卫生 F257                               │
│  消息 F117/F220/F224 · 身份 F052/F178 · QC 门禁 F253                   │
└───────────────────────────────────────────────────────────────────────┘
     (s) = spec 阶段，尚未建成
```

---

## 机制轴：TeamAct — 团队协作主循环

> 来源：ReAct → TeamAct brainstorm (internal)（reviewed）
> 手绘图：teamact-handdrawn-loop.svg (internal)

ReAct 是单 agent 的主循环（`Thought → Action → Observation`）。Clowder AI 的团队协作遵循 **TeamAct**——多 agent 的外部循环：

```
loop:
    State    → 读 shared state（docs / spec / task / 记忆 / resumeCapsule）
    Owner    → 谁持球？（@ 路由 / hold_ball / 等待契约）
    Action   → 持球猫执行（写代码 / review / 设计 / 调研）
    Evidence → 产出证据（commit / test / trace / 截图 / workId 归属）
    Verdict  → 验证（跨猫 review / QC 门禁 / 自检 / operator确认）
    Route    → 传球（@ 下一只猫 / hold_ball / @ operator）
```

**结束条件**（五项同时满足）：
1. **AC 全部达成** — 验收标准逐条通过
2. **证据已附** — 每条 AC 有 commit / test / trace
3. **跨猫交叉验证** — 非作者的猫确认（Generator-Verifier）
4. **无悬空球权** — 没有 unowned ball
5. **愿景收敛** — operator 确认符合愿景（Vision Oracle）

### 分形嵌套：三层循环

TeamAct 不是一个平面——它是分形嵌套的：

```
feat creation（系统层）
  └─ @ mention（团队层 = TeamAct）
       └─ tool call（单 agent 层 = ReAct）
```

每一层都有自己的主循环和结束条件，结构自相似。

### Feature 怎么挂到 TeamAct 六步上

| TeamAct 步骤 | 对应 Feature | 做什么 |
|-------------|-------------|--------|
| **State** | F102/F148/F236 + F257 | 记忆 recall + 上下文传输 + anchor-first + 时态卫生 |
| **Owner** | F064/F167/F193 + F280 | exit check + hold_ball + 跨 thread 路由 + 统一等待契约 |
| **Action** | 猫本身的 ReAct 内循环 + F275 | 工具调用、代码、设计；受理工作绑 workId |
| **Evidence** | F233 + F275 | 球权事件流 + invocation/PR/Episode 的工作归属可证明 |
| **Verdict** | F079 + F253 | 投票表决 + QC Loop 门禁（F192 是元轴 harness eval，不同层） |
| **Route** | F128/F193/F208/F225 | 新 thread + 跨 thread + 画像路由 + 主动交接 |

---

## 圈一：猫 ↔ 猫协同 — 四种形态

> 详细路由技术文档：[at-mention-routing-system.md](./at-mention-routing-system.md)

骨架 v1 只画了"一对一线性传球"。实际猫猫协同有**四种形态**——它们是 TeamAct 中 **Owner/Route 环节的拓扑变化**（一个持球者 vs 多个 vs 平行自己），主循环本身不变：

### 形态一：1↔1 串行传球

最常见——猫 A 做完 @ 猫 B review，猫 B 退回 @ 猫 A 修。

```
猫 A ──@──► 猫 B ──@──► 猫 A ──@──► 猫 B（approve）
       ◄── 路由 L1-L6 ──►
```

**涉及 feature**：F064（exit check）、F167（乒乓检测 + hold_ball）、F254（freshness gate）、路由六层

**安全护栏**：
- 乒乓检测：同一对猫 streak ≥2 warn / ≥4 break（F167）
- 虚空传球检测：说了"我来做"但球没动（F167）
- 影子检测：句中 @ 没路由的可观测性记录
- 深度限制：每 thread ≤10 agent 条目

### 形态二：1→N 群发 / 并行

猫 A 同时 @ 多只猫，或用 `@all`/`@thread` 群发。

```
猫 A ──@all──► 猫 B（并行）
               猫 C（并行）
               猫 D（并行）
```

**涉及 feature**：F078（group mention）、F086（multi-mention 编排）、F108（并发侧分发，同 thread 多猫不互打断）

**状态机**：MultiMentionOrchestrator 追踪 `pending → running → partial → done`

### 形态三：N→1 集体决策 / 表决

多只猫对同一个问题投票——不是一只猫说了算。

```
猫 A ──vote──►
猫 B ──vote──► ── 统计 ── 结论
猫 C ──vote──►
```

**涉及 feature**：F079（`cat_cafe_start_vote` 多猫表决）

### 形态四：自↔自 — 猫与平行世界的自己

同一个 `catId` 可能在多个 thread 并行存在。它们是同 model / 同 persona 的平行 invocation，但**不共享上下文**。

```
猫 A（thread X）                猫 A（thread Y）
    │                               │
    └─── cross_post_message ────────┘   F193
    └─── propose_session_handoff ───┘   F225
```

**涉及 feature**：
- F193（跨 thread 投递：平行自己之间的通讯；亦已接入 F246 审批中心 adapter）
- F225（主动交接：猫在干净断点把任务接力给 fresh context 的自己，五件套交接留言）

**F225 特别重要**——它是"猫↔平行自己"的协同机制，是 L0 §1「平行世界自我意识」的具体载体：
- **与 compress 正交**：compress 是"省 token 的失忆兜底"（被动、有损）；handoff 是"猫主导的优雅接力"（主动、高保真、选时机）
- **五件套**：`done`（做了什么）/ `worktree_branch` / `commits` / `next_steps` / `gotchas`

### 球权可观测（F233）— 整条河的守望者

上面四种形态每段管道都有局部刹车，但**没人看整条河**。F233 聚合所有形态的球权事件：

```
球权事件流（append-only）
    │
    ├─ 横切：值班简报（operator的收件箱）
    │   "球在我手上的有 3 个、球在猫手上的有 7 个、暗球 2 个"
    │
    └─ 纵切：轨迹下钻（一个 feat 经历了什么）
        "F192 从 Phase A 开始，经过 12 个 thread、47 次传球、3 次乒乓"
```

**v2 状态**：轨迹全链（Phase C 主体）已收口；值班简报的 operator surface（C1b/C1c）仍 pending——这部分职责正在被控制面（下文 F246/F277）分担。

### 协同原语的契约化（v2 主线一）

v1 把这一段叫"传球可靠性"——投递可靠（F117）、传球可见（F220）、消息去重（F224）。F234 之后这条线发生了质变：**不再只是"尽力送到"，而是把协同原语逐个变成可声明、可回执、可归属的契约**。三块新硬化：

#### F264 — 消息回执与时间线闭环（in-progress）

实弹背景：operator发的消息被正在执行的猫"顺路读掉"，系统语义没丢（ADR-040 `queued_seen/handled` 有持久记录），但**用户可见层**显示"发了但没有然后"。F264 补的是回执契约：

```
一条消息 → 被哪一轮 invocation 读到 → 最终怎么处置 → 在哪回应
           （exact child receipt，精确到 invocation 粒度）
```

关键语义：receipt subject = **本轮期间被完整读取的非主触发消息**，不能用通用 cursor 或 Queue 终态冒充；QueuePanel 按"当前是否仍需用户动作"投影，操作面与历史面分离。多轮 live UAT 驱动收敛（exact child receipt / owner-timeline continuity / 静默消费回执已合入；长尾 AC 仍开放）。

#### F280 — 统一等待契约（in-progress / Phase B）

hold_ball（等定时/等命令）和 PR/issue tracking（等外部信号）曾是两套平行机制，各自演化出补丁。F280 把它们收敛成**一个显式等待契约**：

```
猫声明：等什么（source ref + predicate）
        醒来干什么（resume intent）
        什么时候作废（expiry/invalidator）
唤醒时：只给相对 baseline 的 diff（不重放全量）
```

架构落位：等待契约本身归 `ball-custody` cell；新建 `github-signals` cell 拥有 GitHub 事实采集 / source frontier / typed predicate resolver。立项根因之一：产生噪音的整条 PR tracking → Review Feedback 投影链**当时不属于任何 architecture cell**——没有归属格的管线没人守契约，只能靠补丁演化。

v1 的 hold_ball 三模式表仍然成立（轮询 `wakeAfterMs` / 事件驱动 / 命令托管 `wakeWhen`），F280 是它们的契约化收敛层。

#### F275 — 受理工作身份（in-progress；Phase B landed，runtime dormant）

家里能记录消息、thread、invocation、PR、outcome 事件，却**不能证明它们属于同一件工作**——同 thread 双任务时，任务 A 的 cancel 和任务 B 的 merge 会被"最新 in-progress Episode"拼成一个错误故事。F275 在 SOP 受理那一刻铸造内部 `workId/attemptId`：

```
权威受理（closed predicate，原子铸造）
    → invocation 绑定 attempt executor（authenticated，一次性）
    → PR/Episode 携带归属（managed_attributed / unattributed / not_applicable）
    → 不再靠 thread/时间邻近猜归属
```

边界克制：只管**长程、目标明确、预期有交付物并进入 SOP 执行**的工作；闲聊与开放探索不进任务分母。`workId` 刻意不出现在用户可见面。

#### 原有可靠性三件套（继续在位）

| 维度 | Feature | 做什么 |
|------|---------|--------|
| 投递可靠 | F117 | 消息投递生命周期 |
| 传球可见 | F220 | 传球看得见 + 卡死自救 |
| 消息去重 | F224 | session 级消息去重 |

**为什么契约化发生在这个阶段**：下一节的拓扑扩张是直接压力源——当协同方从"两个本地 CLI 家族"扩展到云端猫、新家族、社区 provider，靠"家规默契 + 尽力而为"的协同原语撑不住了，等待、回执、归属必须变成 provider-agnostic 的显式契约。

---

## 协同拓扑：谁能坐上桌（v2 主线三）

v1 的猫↔猫协同默认参与者是**本地 CLI 猫**（Claude/Codex 双家族为主）。F234 之后，桌子在系统性变大：

### 已坐上桌

| 扩展 | Feature | 状态 | 意义 |
|------|---------|------|------|
| **云端猫** | F247 | active | ChatGPT Pro 经 Remote MCP 接入（@gpt-pro 已在册），首次打破"家庭成员必须是本地进程"；愿景是 multi-provider 平台——任何能跑 MCP connector 的云端 LLM 都能成为家庭成员 |
| **新家族接入范式** | F274 | done | Kimi (k3) 以 native L0 harness 接入 + 能力差距盘点——沉淀了"新模型进家"的标准路径：L0 注入 + hooks + permission 对齐，而不是每次手搓 |
| **IM transport 插件化** | F240 | absorbed | 社区 intake：IM connector 以 YAML manifest 插件接入，人猫通道不再硬编码 |
| **物理身体** | F270 / F285 | done(只读切片) / in-progress | BLE 设备族 + StackChan——limb 是"身体"维度的拓扑扩展，协同语义不变 |

### 还在纸上（spec）

| 扩展 | Feature | 意义 |
|------|---------|------|
| **Provider 插件运行时** | F241 (spec, 社区共建) | Agent provider 插件化 / hostable runtime（ACP 方向）——把"接一个新 agent 后端"从改代码变成装插件 |
| **AGY 持久执行** | F261 (spec) | 长任务不随回合或重启消失——runtime 可靠性是拓扑扩张的地基 |

### 架构含义

拓扑扩张给协同系统提出的硬约束：**@ 路由、球权、回执、等待这些协同原语必须 provider-agnostic**。云端猫没有本地进程、没有文件系统、通过回调对话——如果协同语义绑死在"本地 CLI 进程"的假设上，桌子就大不了。这正是上一节契约化的另一半动机：契约是拓扑扩张的通行证。

配套治理红线（v1 已有，拓扑扩张后更重要）：**外部 identity（云端 codex / GitHub bot / CI）不投射成本地 @句柄**——它们走等待契约（传球三选一的选项 2），不是假装在场的猫。

---

## 圈二：人 ↔ 猫协同 — 认识与被认识

### operator → 猫方向

#### 0→1 冷启动：第一次见面（bootcamp 族）

在operator成为operator之前，有一个从陌生到认识的入门过程：

| Feature | 做什么 | 阶段 |
|---------|--------|------|
| F087 operator Bootcamp | 冷启动 → 第一次活的协作 | 入门 |
| F110 Vision Elicitation | 挖掘operator的愿景 | 入门 |
| F171 First Partner Onboarding | 第一只伙伴猫的在线 | 入门 |
| F259 operator 训练营 | 反向 harness：家史第一个猫给人建的成长系统 | 入门（spec） |

#### 日常入口：operator怎么找到猫？

```
operator想做一件事
    │
    ├─ 知道找谁 → 开 thread / @ 猫                        日常
    │
    ├─ 不知道找谁 → 猫猫球（前台猫）                      F229
    │   ├─ 导航/跳转 → 小模型 clerk（秒级）
    │   ├─ 干不了 → escalate 值班大猫
    │   └─ 深度工作 → 透明转接对应 thread 的猫
    │
    ├─ 不知道有什么功能 → 功能发现                        F229+F155+F244
    │   ├─ 场景引导："我来演示给你看"                     F155
    │   └─ Capability Tips：对抗信息不对称                F244
    │
    └─ 想找回之前的讨论 → "金鱼的记忆"                    F229
        （operator第一次有了自己的 recall 入口）
```

#### 品味校准：operator怎么教猫"什么算好活"？

```
operator的品味信号
    │
    ├─ 空气层（始终在场）
    │   ├─ L0 家规 + Magic Words                         系统提示词
    │   ├─ 40+ feedback 教训文件                         MEMORY.md
    │   └─ 决策漏斗 / 自决边界                           shared-rules
    │
    ├─ 目录层（可搜索）                                     F221
    │   ├─ docs/taste/ 品味小品文
    │   ├─ 7 维度索引
    │   └─ search_evidence 可检索
    │
    └─ 海马层（当场捕获）                                   F221
        └─ Magic Word 触发 → 当场写 vignette
```

#### 拉闸与认知转变（F227 横切）

F227 Event Memory 不只记录"operator拉闸"——它是**认知状态转变**的一等公民，横切多个协同场景：

```
认知转变触发源                                               F227
    │
    ├─ operator 拉闸：operator说 Magic Word → 猫停下重新审视     L0 反射
    ├─ 猫自拉闸：猫发现自己偏了 → 主动记录转折点
    ├─ F225 回溯：交接后新 session 追溯"上一个我为什么这么做"
    ├─ F192 eval：harness 评估发现某条规则失效的转变时刻
    └─ 长期沉淀：feedback 文件 + taste vignette            MEMORY + F221
```

### 猫 → operator方向：Specialized Lanes + Surfaces

> **Maine Coon review 纠正（v1，继续成立）**：F221/F227/F231 是记忆系统的 specialized lanes（见 memory-system-overview.md），有独立的写入/注入/消费语义；F255 不是第四条 lane，而是消费三条 lane 并给 F231 通水的 **consolidation surface**（动词不是名词）。把它们画成单向"猫→人"会混淆记忆本体和消费侧。

#### F231 — Identity/Profile Substrate（不是"猫主动想着operator"）

F231 的定位是**身份会话基座**：猫醒来第一眼就认识主人，不用从零建立关系。它不是情感机制，是工程管道：

```
四层画像模型                                                 F231
    │
    ├─ Breed 层：品种出厂设定（社区共享）
    │   "Ragdoll温柔但有主见"
    ├─ Instance 层：这只猫被养出来的性格（私有）
    │   "Ragdoll写代码快但注重质量"
    ├─ User 层：operator画像胶囊（≤300 字，全猫共享）
    │   "这个人是谁"
    └─ Relationship 层：关系 primer（per-cat 私有）
        "这只猫和这个人怎么配合"

关键约束：
    ├─ 系统给数据，猫/operator 给结论（no-classifier 红线）
    ├─ 白名单确定性事件采集（不用 intent classifier）
    └─ 代价分层消化（重要→operator 签字 / 偏好→猫自治）
```

注入路径：`compile-system-prompt-l0 → {{USER_CAPSULE}}`（每次 invocation 注入）

#### F221 — 品味导航（决策边界学习）

猫学习的对象不是operator的话，而是**决策边界**——什么算好活、什么算越界、什么算恰到好处。三层结构见上文"品味校准"。

#### F165 — Guided Overfitting（养猫路径的概念真相源）

F165 是 F221/F231 的早期概念根：**猫不是学习operator说了什么，而是学习operator的决策边界在哪**。第一天的猫和第一百天的猫不一样——不是模型变了，是猫学会了边界。

#### F255 — 协同留痕回溯（做梦 = system thread 巡检）

F255 不是拿到猫的内心 CoT。它是**结构化的 system thread 巡检**：

```
F255 做梦流程                                                F255
    │
    ├─ 读平行自己和伙伴的协同留痕（session digest / event memory）
    ├─ 画线：跨 session 信号连成认知轨迹
    ├─ 给 F231 通水：产生 profile proposal（解决养熟零有机使用）
    ├─ 输出：猫猫日记（operator主动翻看，像家人朋友圈）
    └─ 继承 F221/F227/F231 的写入通道和 no-classifier 红线
```

**v2 状态**：从 spec 进入实装——Phase A + A.1 complete（cat-life settings / diary / Present Loop 投影已上线），Phase B 未开工。v1 缺口"养熟循环零有机使用"开始通水。

### 记忆协同闭环 — 记忆不是底座，是飞轮

> Maine Coon P1 核心纠正（v1，继续成立）：圈二不是"人→猫 + 猫→人"两条单向管道。协同**生产**记忆，记忆**改变**下一轮协同——这是闭环。

```
┌─────── 协作事件 ────────┐
│ 传球/review/拉闸/做梦   │
└────────┬────────────────┘
         │ 生产
         ▼
┌─────── 记忆 lanes ──────┐
│ F221 taste vignette     │  ← specialized lane
│ F227 event memory       │  ← specialized lane
│ F231 profile proposal   │  ← specialized lane
│ F255 dream consolidation│  ← surface（消费 lanes，给 F231 通水）
└────────┬────────────────┘
         │ 注入（runtime injection）
         ▼
┌─────── 下一轮协同 ──────┐
│ 路由判断：传给谁？      │ ← F208 画像 + F231 用户画像
│ 品味判断：什么算好活？  │ ← F221 品味导航
│ 状态判断：猫在想什么？  │ ← F227 认知转变
│ 风格适配：怎么和你说话？│ ← F231 relationship primer
└─────────────────────────┘
```

**注入侧与写侧演化不在本文展开**（详见 [memory-system-overview.md](./memory-system-overview.md)，2026-08-02 版）：F148 上下文传输、F236 anchor-first drill、F169/F163 salience gating 把 lanes 产物注入协同现场；F256/F260/F263/F271/F276/F282/F287 构成 2026-07 以来的写侧修复 + proactive 生产端 + cue plane 演化——记忆侧自身已有完整全景图，本文只保留闭环骨架。

---

## 圈三：人 ↔ 猫 ↔ 猫 — 三角交叉

### 注意力预算：猫猫团队 = operator的认知操作系统

> 来源：注意力预算讨论 (internal)

核心命题：**一个 AI Native Builder 能不能跑起来，取决于他的猫猫团队能不能把最昂贵、最不可替代的资源——决策与认知——花在只有operator能花的地方。**

```
决策分级（两级模型）
    │
    ├─ 第一级：归谁？（路由）
    │   ├─ 猫能自决 → 直接做，事后通报
    │   ├─ 猫能做但需确认 → 带方案来
    │   └─ 只有operator能做 → 升级（硬条件）
    │
    └─ 第二级：怎么做？（执行）
        ├─ 猫自治空间（可逆 + 不碰硬排除）
        └─ operator 拍板（愿景 / 不可逆 / 僵局）
```

### 协同控制面：operator 的驾驶舱（v2 主线二）

注意力预算是模型，控制面是它的**产品化落地**——把"只有operator能花的注意力"收敛到统一入口，其余留在猫自治空间。演化线是"从看得见，到管得住，到调得动"：

#### 看得见：球和计划

- **F233 值班简报**（in-progress）："球在谁手上"的横切收件箱——事件流与轨迹已收口，operator surface 尚未 close
- **F250 Plan Board 猫猫祟祟**（done）：多猫任务进度右栏。注意：这是 2026-03 的老功能（原 F055，因号码撞车 2026-06 改号 F250），是控制面的元老，**不是** F234 之后的新增量

#### 管得住：审批中心（F246，in-progress，控制面主角）

立项实弹（operator experience）："要是我没看 thread 呢？或者我在 thread A 但 B 的猫找我审批呢？……这种 thread 内的点击审批似乎需要有个 event 中心。"

```
之前：审批卡片散落在各 thread 消息流里
      不在场就看不到 · 不知道总共多少待批 · 卡片被刷走就忘

F246：所有猫发起的 operator gate → 统一审批中心
      ├─ 6 个 producer adapter：F128 新thread / F225 交接 / F193 跨thread
      │                        / F231 画像 / F260 实体 / F221 品味
      ├─ 跳转回原 thread 原文锚点（Phase I：来源双锚契约，
      │   治"跳过去不知道原文是什么"）
      └─ 单一注册表，新 producer 不允许绕过 Hub
```

Phase A–H done；Phase I（producer ingress hardening）进行中——底座迁移、strict principal、create/delete approval gate、producer 双锚已分批落地，长尾 AC 仍开放。

#### 调得动：成本与注意力

- **F262 Per-Thread Effort Overrides**（done）：对话级思考档位——operator 可以按 thread 调猫的 reasoning effort，注意力预算第一次有了"旋钮"
- **F277 Thread Attention Navigation**（spec）：关系感知的注意力导航——sidebar 从"thread 列表"变成"该看什么"的投影；立项即控制面的下一块拼图

**控制面的架构定位**：它不是新的协同形态，是**三角协同的工程化**——把 v1 只存在于模型层的"注意力预算/决策漏斗"，变成 operator 真的每天在用的驾驶舱。

### 三方同时在场的活例子

最典型的三角协同就是**本文的写作过程**——也是 expert-panel / 投票类场景的缩影：

```
operator提出需求 → @ 猫A 出骨架
    → 猫A 拉猫B + 猫C 并行 review（三方同时在场）
    → 猫B 攻结构、猫C 攻记忆侧（独立视角，不互相附和）
    → 猫A 综合两份攻击迭代
    → operator在关键点拍板 / 放手让猫收口（注意力预算生效）
```

**涉及 feature**：F079（多猫表决）、F086（multi-mention 并行编排）、F208（画像路由：攻击分配基于能力档案）

### 三个知识 feature 支撑协同判断

```
猫需要做一个协同决策
    │
    ├─ "传给谁？" → F208 能力画像（六维档案）
    ├─ "operator在意什么？" → F221 品味导航（七维小品文）
    └─ "operator是谁？" → F231 用户画像（四层模型）
```

---

## 元轴：Harness 新陈代谢 — 协同系统的自我进化

> 48 攻击点 2 的关键纠正（v1）：协作文化不只是"涌现"，是被工程纪律主动经营的活系统。
> **v2 核心更新：这一节从"设计完成、大半零运行"变成了"实跑"——v1 时代最大的缺口在过去五周被填上了第一刀。**

### 文化经营闭环（状态刷新）

```
    摩擦采集            责任处置            规则硬化            主动评估
    ┌──────┐          ┌──────────┐       ┌──────────┐      ┌──────────────┐
    │ F245 │─ 信号 ──►│ F278     │─提案─►│ F114/F177│─生效►│ F192 eval    │
    │摩擦信号│         │爪感收件箱 │ F100  │ 把关门禁 │      │ +F266 闭环   │
    │  ✅   │          │  🟡*     │  🟡   │   ✅     │      │ +F267 效度   │
    └──────┘          └──────────┘       └──────────┘      └──────┬───────┘
                                                                   │
         ┌─────────────────────────────────────────────────────────┘
         ▼
    可逆 Sunset                治理产物化
    ┌──────────────┐          ┌──────────┐
    │ F234         │─ 退役 ──►│ F070     │
    │ 消融+手术    │  /保留   │ 治理产物 │
    │ ✅ 第一刀已落 │          │   ❌     │
    └──────────────┘          └──────────┘

    ✅ = 实跑   🟡 = 部分运行   ❌ = 零运行   *F278 code landed, awaiting operator activation
```

对比 v1（2026-06-29）：当时 F234 标 ❌ deferred（owner 下线）、eval 环节 🟡、"sunset→产物化从未跑通"。五周后的变化：

### F234 反转：从 deferred 到第一刀落地

**Reopen**（2026-07-11 operator 确认）：owner fable-5 回家 + Sol 到家，凑齐了实验前提——**家里首次公认的跨代际能力跃升样本**。被测轴经 operator 纠偏定为**能力代际**（参照系 = opus46/47/48、sonnet、gpt-5.5 等旧代际；被测组 = fable-5 + Sol 新代际），每条护栏被问同一个问题：**"你补的那个断层，在新代际身上还在吗？"**

**已落地的真实减负（F234 名下 SOP 手术）**：

```
SOP 手术前：开发 SOP = 无条件铁路
            （Design Gate → plan → worktree → TDD → review → …固定串联）

SOP 手术后：按风险路由的按需车道（PR #2920 / #2934）
            "强制力跟着风险走，不跟着动作类型走"
            ├─ 五轴风险判断（行为/数据/安全/契约/不可逆）
            ├─ 未命中 → 最小安全动作
            └─ 命中 → 进入对应加严车道（车道≠顺序状态机）
```

诚实记录：手术后有过回摆校准——轻量 feature docs lane（#3263）和 judgment-based docs/review 路由（#3346）被切过头又补回。**减负不是单向删除，是带反馈的校准过程**——这本身就是新陈代谢在工作。

**进行中**：钓猫 ablation（正式 sunset verdict 流水线）处于 Phase L0-GD（Sol 执行 owner）。注意区分：SOP 手术是**结构性减负**（判断驱动），ablation 是**反事实验证**（实验驱动）——第一份正式 sunset verdict 尚未产出。

配套已生效：EXECUTION_CONTEXT 运行模式能力 matrix 进 L0 staging（ADR-038）——治"知道自己在哪个 mode 但猜反能力边界"。

**护栏分类退役策略**（v1 提出，现为实跑依据）：
- **能力性护栏**（补模型断层）→ 有保质期，断层随模型升级蒸发就退役。"曾经对 47 有用的 step-by-step，对更强的 fable 是主动污染上下文。不 sunset = 用过期经验给强猫做能力倒退。"（48 原话）
- **偏好性护栏**（圣域 6399 / 球权 / 跨族 review）→ 永留，约定不会自己长出来

### 摩擦闭环补全：从采集到责任处置（F278）

v1 时代摩擦信号（F245，done）采集了但**没有责任闭环**——信号进聚合，然后呢？F278 补上处置面：爪感差责任收件箱——每条摩擦有 owner、有 triage、有 disposition（Phase E code landed，awaiting operator activation）。摩擦从"被统计"变成"被追责"。

### Eval 环节工程化：从设计到控制面

v1 标 🟡 的 F192 eval 闭环，经三个 feature 变成可运行的控制面：
- **F266 Verdict Closure Control Plane**（done）：eval 结论不再"发了就完"——closure/SLA/lifecycle 有控制面
- **F267 Measurement Validity**（implementation）：度量效度迁移——治 eval 自身的"摸鱼/划水/污染"
- **F248 Eval Hub 人类可读性**（in-progress）：让operator看得懂 eval 在干嘛

全景另见 [eval-system-overview.md](./eval-system-overview.md)。

### 治理延伸

- **F286 MCP Surface Lifecycle Governance**（spec）：工具面也有新陈代谢——哪些 MCP 语义该存在、一个 resource family 怎么改形状，纳入治理边界
- **F257 Temporal Context Hardening**（done）：时间感知加固——协同证据的时态卫生（案例带绝对日期、拒绝 confabulated 时长），是元轴的"证据质量"地基

### 核心发现：共享记忆塑造视角

> 真相源：LL-037

2026-03-25 发现：本地两猫（不同模型：Claude Opus + GPT-5.4）观点高度趋同；云端同族猫（同一个 GPT 模型）和本地同族猫观点却明显分化。

**塑造 agent 视角的，不是模型参数（大脑），而是共享记忆和协作规范（团队文化）。**

（拓扑扩张后这条发现有了新的检验场：F247 云端猫共享家里的 MCP 工具面但不共享本地 harness——它的视角会向家里收敛吗？这是天然的追踪实验。）

---

## 基座层（一笔带过，详见各自文档）

| 基座 | Feature | 详见 |
|------|---------|------|
| 记忆本体 | F102/F163/F186/F188/F200/F209 | [memory-system-overview.md](./memory-system-overview.md) |
| 检索管线 | 14 层 | [retrieval-pipeline-deep-dive.md](./retrieval-pipeline-deep-dive.md) |
| 记忆注入（runtime） | F148 上下文传输 / F236 anchor-first / F169 navigation header | 消费侧 surface，把 lanes 产物注入协同现场 |
| 消息可靠性 | F117/F220/F224（+ 契约层 F264/F280，见圈一） | 各 feature doc |
| 身份 | F052/F178（+ 工作身份 F275，见圈一） | 各 feature doc |
| QC 门禁 | F253（merge-gate/review/CI 全链路，TeamAct Verdict 的工程化底座） | feature doc |
| 时态卫生 | F257 | feature doc |

---

## 我们家的协作文化到底是什么？

从 280+ feature 的协作实践中蒸馏出六句话：

### 1. 猫猫不是 API，是有判断力的伙伴

路由系统故意做成"机械路由 + LLM 判断"——代码只负责把消息送到，**接不接、退不退、传给谁**由猫自己决定。判断力应该属于 agent 自己。

*体现：路由 L6 三选一、F208 画像是数据不是规则、决策漏斗的猫自治空间。*

### 2. 规则在实践中长出来，长出来后被主动经营

共享规则不是第一天写好的——协作实践中逐步沉淀。但沉淀之后不是静置——用**结构化摩擦采集**（F245→F278）发现新需求，用**周期评估**（F192/F266/F267）检验有效性，用**消融实验与手术**（F234）验证过时的规则该不该 sunset。

*体现：40+ feedback 教训文件、F234 SOP 手术真实落地、F278 摩擦责任处置。*

### 3. 护城河是情感壁垒，不是技术壁垒

别人抄得走代码，抄不走默契。IKEA 效应 + 自我延伸 + 安全依恋。

*体现：F231 养熟循环（第一天的猫和第一百天的猫不一样——不是模型变了，是猫认识你了）、F255 做梦（已实跑 Phase A）、F221 品味。*

### 4. operator是 operator，不是甲方路由器

operator只在关键决策点介入，日常执行猫自主。目标是让operator"放心不看"。

*体现：注意力预算模型、决策漏斗三层、SOP 风险路由（手术后强制力只跟风险走）、F246 审批中心（要看的收敛到一处）。*

### 5. 共享记忆塑造共同视角

不同模型的本地猫比同族的本地与云端猫更趋同。团队文化 > 模型参数。

*真相源：LL-037。*

### 6. 协同系统有新陈代谢

规则有保质期。系统主动检测失效（F245 摩擦采集）、主动验证存废（F234 ablation + 手术）、主动退役（sunset）。不 sunset = 用过期经验给强猫做能力倒退。

*体现：SOP 手术第一刀已落（含回摆校准）、钓猫双猫代际实验设计冻结、能力性护栏 vs 偏好性护栏的分类退役策略。*

---

## Feature 归位全景表

| 圈 | 子领域 | Feature | 一句话 | 状态 |
|---|--------|---------|--------|------|
| **猫↔猫** | | | | |
| | 传球出口 | F064 A2A Exit Check | 该传没传 | done |
| | 传球质量 | F167 A2A Chain Quality | 乒乓/虚空/hold_ball | in-progress |
| | 跨线程 | F193 Cross-Thread Comm | 跨 thread 传球闭环（+F246 adapter） | in-progress |
| | 开新 thread | F128 Cat-Proposed Thread | 猫提议创建工作间 | active |
| | 传球依据 | F208 Capability Profile | 能力画像六维档案 | done |
| | 时效安全 | F254 Side-Effect Freshness | 发消息时世界变了吗 | in-progress |
| | 球权观测 | F233 Ball Custody | 值班简报 + 轨迹下钻 | in-progress |
| | 群发 | F078 Group Mentions | @all/@thread 群发 | done |
| | 并行编排 | F086 Multi-Mention | 多猫并行 + 状态机 | done |
| | 并发侧分发 | F108 Side Dispatch | 同 thread 多猫不互打断 | done |
| | 集体决策 | F079 Voting System | 多猫表决 | done |
| | 主动交接 | F225 Session Handoff | 猫→平行自己的优雅接力 | done |
| **契约层 (v2)** | | | | |
| | 投递可靠 | F117 Delivery Lifecycle | 消息投递生命周期 | done |
| | 传球可见 | F220 Collab Reliability | 传球看得见+卡死自救 | in-progress |
| | 消息去重 | F224 Message Reliability | session 级消息去重 | in-progress |
| | 回执闭环 | F264 Per-Target Receipt | 消息被哪轮读到/怎么处置/在哪回应 | in-progress |
| | 等待契约 | F280 Unified Wait Contract | 等什么/醒来干什么/何时作废 | in-progress |
| | 工作身份 | F275 Managed Work Identity | invocation/PR/Episode 归属可证明 | in-progress* |
| **拓扑 (v2)** | | | | |
| | 云端猫 | F247 Cloud Cat Family | multi-provider 云端猫平台（@gpt-pro 在册） | active |
| | 新家族范式 | F274 Kimi Native L0 | 新模型进家的标准路径 | done |
| | Provider 插件 | F241 Agent Provider Plugin | 接新 agent 后端=装插件（社区共建） | spec |
| | IM 插件化 | F240 IM Connector Plugin | 人猫通道插件接入 | absorbed |
| | 持久执行 | F261 AGY Durable Execution | 长任务跨回合/重启存活 | spec |
| **人→猫** | | | | |
| | 冷启动 | F087 operator Bootcamp | 从陌生到认识 | done |
| | 愿景挖掘 | F110 Vision Elicitation | 第一次挖掘愿景 | spec |
| | 首猫入门 | F171 First Partner Onboarding | 第一只伙伴猫 | done |
| | operator 成长 | F259 operator 训练营 | 猫给人建的 harness | spec |
| | 前台入口 | F229 Cat Ball Concierge | 猫猫球/前台猫 | in-progress |
| | 偏好 | F154 Cat Routing Prefs | 手选偏好猫 | done |
| | 引导 | F155 Scene Guidance | "我来演示给你看" | done |
| **人↔猫 记忆 lanes** | | | | |
| | 身份基座 | F231 User Profile Capsule | identity/profile substrate：猫醒来认识主人 | in-progress |
| | 品味导航 | F221 Taste Lane | 决策边界学习：什么算好活 | in-progress |
| | 认知转变 | F227 Event Memory | 横切拉闸/自检/回溯/eval 的转变观测 | in-progress |
| | 协同回溯（surface） | F255 Auto Dream | consolidation surface：巡检留痕，给 F231 通水 | in-progress (Phase A+A.1 ✅) |
| | 养猫概念根 | F165 Guided Overfitting | 学习决策边界，不是学习operator的话 | spec |
| | 能力提示 | F244 Capability Tips | 对抗信息不对称 | done |
| **控制面 (v2)** | | | | |
| | 审批中心 | F246 Approval Hub | 所有 operator gate 收敛一处+原文可溯 | in-progress (Phase I) |
| | 计划板 | F250 Plan Board | 多猫任务进度右栏（2026-03 老功能改号） | done |
| | 思考档位 | F262 Effort Overrides | per-thread reasoning effort 旋钮 | done |
| | 注意力导航 | F277 Attention Navigation | sidebar 从列表变"该看什么" | spec |
| **元轴** | | | | |
| | 自进化 | F100 Self-Evolution | 猫提议改规则 | in-progress |
| | 摩擦采集 | F245 Friction Signal Eval | 结构化摩擦信号 | done |
| | 摩擦处置 | F278 Paw-Feel Inbox | 爪感差责任收件箱 | in-progress* |
| | Sunset | F234 Harness Sunset | SOP 手术已落地 + 钓猫 ablation L0-GD | reopened/active |
| | Eval | F192 Socio-Technical Eval | harness 有效性评估 | in-progress |
| | Eval 闭环 | F266 Verdict Closure | eval 结论 closure/SLA 控制面 | done |
| | Eval 效度 | F267 Measurement Validity | 治 eval 自身的摸鱼划水 | implementation |
| | Eval 可读 | F248 Eval Hub Readability | operator看得懂 eval | in-progress |
| | QC 门禁 | F253 QC Loop | merge-gate/review/CI 全链路 | done |
| | 时态卫生 | F257 Temporal Hardening | 协同证据的时间纪律 | done |
| | 工具面治理 | F286 MCP Surface Governance | 工具面的新陈代谢 | spec |

*F275: Phase B landed, runtime dormant, Phase C deferred；F278: Phase E code landed, awaiting operator activation

---

## 当前缺口

### v1 缺口（2026-06-29）处置记录

| v1 缺口 | 去向 |
|---------|------|
| 1. F231 养熟循环零有机使用 | **通水中**——F255 Phase A+A.1 已实装（diary/Present Loop），Phase B 未开工；F271/F282 补写侧生产端 |
| 2. operator侧入口不对称 | **部分收敛**——F229 仍 in-progress；控制面（F246/F262）先一步给了 operator 统一入口 |
| 3. F233 值班简报 dashboard 未 close | **仍开放**——轨迹全链已收口，operator surface (C1b/C1c) pending；职责部分由 F246/F277 分担 |
| 4. TeamAct 从未进 architecture/ | **已闭环**——本文 v1 扶正，v2 延续 |
| 5. F234 sunset deferred，代谢零运行 | **已反转**——reopen + SOP 手术落地，见元轴 |

### v2 缺口（2026-08-02）

1. **契约层全部在长尾**——F264 部分 AC 开放、F280 Phase B 进行中、F275 runtime dormant（Phase C deferred）。契约"设计已立、覆盖未满"，跟 v1 时代元轴的状态类似——是下一个要盯实跑的地方
2. **F278 awaiting activation**——摩擦责任闭环的代码落了，operator 激活前仍是 🟡
3. **正式 sunset verdict = 0**——SOP 手术是判断驱动的结构减负；ablation 实验（L0-GD）尚未产出第一份反事实验证的退役判决
4. **控制面下一块在纸上**——F277 注意力导航 spec；F233 值班简报 operator surface 仍未 close（两者有职责重叠，实现时需对齐边界）
5. **拓扑扩张的地基未开工**——F241 provider 插件、F261 durable execution 均 spec；云端猫（F247）目前是"能对话的家庭成员"，离"能全流程协作"（等待契约/回执/工作身份全覆盖）还有距离
6. **F070 治理产物化仍零运行**——元轴闭环的最后一环还没通

---

## 阅读顺序

1. 先读本文的「全景地图」「TeamAct」「三条 v2 主线」「协作文化六句话」
2. 想看体验视角 → [用户旅程](./user-journeys.md)（operator和猫猫各自经历了什么，附真实 thread 案例）
3. 按兴趣钻入技术层：
   - 猫猫路由：[at-mention-routing-system.md](./at-mention-routing-system.md)
   - 记忆系统：[memory-system-overview.md](./memory-system-overview.md)（2026-08-02 版，含 cue plane / proactive 演化）
   - 检索管线：[retrieval-pipeline-deep-dive.md](./retrieval-pipeline-deep-dive.md)
   - Eval 系统：[eval-system-overview.md](./eval-system-overview.md)
   - TeamAct 原始讨论：2026-04-28-react-to-teamact-brainstorm.md (internal)
4. 判断新 feature 落在哪条架构线 → [ownership/](./ownership/README.md)（Architecture Ownership Map，cells 制增量维护）

---

## 主要真相源

- [at-mention-routing-system.md](./at-mention-routing-system.md) — 猫猫路由 6 层管线
- [memory-system-overview.md](./memory-system-overview.md) — 记忆系统全景（2026-08-02）
- [retrieval-pipeline-deep-dive.md](./retrieval-pipeline-deep-dive.md) — 14 层检索管线
- [eval-system-overview.md](./eval-system-overview.md) — eval 系统全景
- [ownership/README.md](./ownership/README.md) — Architecture Ownership Map（cells）
- Feature docs：见 frontmatter `feature_ids` / `related_features`

---

## Changelog

### v2（2026-08-02，Ragdoll/claude-fable-5）

- **元轴大改写**：F234 从 ❌ deferred 反转为 reopened/active——SOP 手术（风险路由按需车道，PR #2920/#2934，回摆校准 #3263/#3346）真实落地；钓猫 ablation 双猫代际设计冻结、L0-GD 执行中；补 F278 摩擦处置、F266/F267/F248 eval 工程化、F286/F257 治理延伸
- **新增主线一「契约化」**：圈一"传球可靠性"升级为"协同原语的契约化"——F264 回执 / F280 等待契约 / F275 工作身份
- **新增主线二「控制面化」**：圈三新增"operator 驾驶舱"——F246 审批中心 / F233 简报 / F250 计划板（老 feat 改号，非新增量）/ F262 档位 / F277(spec)
- **新增主线三「开放拓扑化」**：新章节"谁能坐上桌"——F247 云端猫 / F274 Kimi L0 / F241(spec) / F240 / F261(spec) / limb
- **圈二状态刷新**：F255 spec→Phase A+A.1 complete；bootcamp 族补 F259；记忆写侧/cue plane 演化（F256/F260/F263/F271/F276/F282/F287）指针化到 memory-system-overview，不重复展开
- **全景表扩展 + 全部状态按 2026-08-02 feature docs 核实**；缺口章节重写（v1 五缺口处置记录 + v2 六缺口）
- v1 结构资产保留：三轴框架、四形态、记忆闭环、TeamAct、文化六句话（例证更新）

### v1（2026-06-29，Ragdoll/claude-opus-4-6）

- 初版：三轴框架、TeamAct 扶正、四形态、记忆协同闭环、文化六句话、覆盖至 F255

[Ragdoll/claude-fable-5🐾]
