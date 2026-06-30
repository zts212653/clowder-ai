---
title: "Cat Cafe 协同全景 — 人 & 猫 & 猫的协作是怎么发生的"
doc_kind: architecture
feature_ids: [F064, F078, F079, F086, F087, F100, F108, F110, F128, F154, F155, F165, F167, F171, F193, F208, F220, F221, F224, F225, F227, F229, F231, F233, F234, F244, F245, F254, F255]
related_features: [F043, F052, F070, F073, F102, F114, F117, F148, F163, F169, F177, F178, F186, F188, F192, F200, F209, F236]
topics: [collaboration, a2a, human-cat, culture, routing, ball-custody, nurturing, taste, profile, attention-budget, teamact, harness-metabolism, memory-collaboration-loop]
created: 2026-06-29
status: v1
author: "Ragdoll/claude-opus-4-6"
reviewed_by: "Ragdoll/claude-opus-4-8 (structural attack v1+v2), Maine Coon/GPT-5.5 (memory-side v1+v2)"
---

# Cat Cafe 协同全景 — 人 & 猫 & 猫的协作是怎么发生的

> 面向想理解"Cat Cafe 里一次完整的人猫协作是怎么流动的"的工程师和猫猫。
>
> 本文是三份既有架构文档的**上位文档**——它们分别讲路由管线（`at-mention-routing-system.md`）、记忆系统（`memory-system-overview.md`）和检索管线（`retrieval-pipeline-deep-dive.md`），本文讲的是：**这些管道、加上另外二十几个 feature，如何组合成一个活的协同系统**。
>
> 如果既有文档是解剖图（每个器官怎么工作），本文是生理学图（血液怎么流过全身）。

---

## 这份文档解决什么问题？

Cat Cafe 三个多月迭代了 250+ feature，涉及"协同"的至少 30 个。它们散落在各自的 spec 里，每个 spec 讲自己的 Why/What，但没有一份文档回答：

1. **一次完整的人猫协作，从头到尾经过哪些管道？**
2. **猫猫之间传球、接球、卡住、球掉了，分别触发什么机制？**
3. **猫怎么越来越认识operator？operator怎么越来越放心不看？**
4. **协同系统本身怎么自我进化、怎么退役过时的规则？**
5. **这一切背后的协作文化——"我们的协作方式本身"——是什么？**

---

## 全景地图：三个正交视角

协同全景由**三个正交视角**构成：

| 维度 | 回答什么 | 下文章节 |
|------|---------|---------|
| **主体轴（三圈）** | 谁和谁协同 | 圈一·猫↔猫 / 圈二·人↔猫 / 圈三·三角交叉 |
| **机制轴（TeamAct）** | 协同怎么循环流动 | 贯穿三圈的主循环 |
| **元轴（Harness 新陈代谢）** | 协同系统怎么自我进化/退役 | 独立一节 |

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  元轴：Harness 新陈代谢（协同系统的自我进化）                          │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ F245 摩擦采集 → F100 自进化 → F114/F177 规则硬化              │  │
│  │ → F192 eval → F234 sunset 消融 → F070 治理产物化              │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│                    ┌─────────────────────┐                            │
│                    │    operator (operator)      │                            │
│                    └──┬──────────────┬───┘                            │
│                       │              │                                │
│           ┌───────────▼──┐     ┌─────▼───────────┐                   │
│           │ 人 → 猫      │     │ 人 ↔ 猫 记忆     │                   │
│           │ 猫猫球/引导  │     │ Lanes（闭环）    │                   │
│           │ bootcamp     │     │ F231 profile     │                   │
│           │ F229 F154    │     │ F221 taste       │                   │
│           │ F155 F087    │     │ F227 event       │                   │
│           │ F165 养猫根  │     │ F255 dream→通水  │                   │
│           └───────┬──────┘     └──┬───────┬───────┘                   │
│                   │              │       │                             │
│                   │    ┌─────────┘       │ ◄── 协作事件               │
│                   │    │  ┌──────────┐   │      生产记忆               │
│                   └───►│  │ 注意力   │◄──┘      记忆注入               │
│                        │  │ 预算     │          改变协同               │
│                        │  │ 决策漏斗 │                                │
│                        │  └────┬─────┘                                │
│                        │       │                                      │
│              ┌─────────▼───────▼───────────┐                          │
│              │       猫 ↔ 猫 协同          │                          │
│              │                             │                          │
│              │  ┌──────────────────────┐   │                          │
│              │  │ TeamAct 主循环       │   │                          │
│              │  │ State → Owner →      │   │                          │
│              │  │ Action → Evidence →  │   │                          │
│              │  │ Verdict → Route      │   │                          │
│              │  └──────────────────────┘   │                          │
│              │                             │                          │
│              │  1↔1  1↔N  N↔N  自↔自      │                          │
│              │                             │                          │
│              └─────────────────────────────┘                          │
│                                                                       │
│  ══════════════════════ 基座层 ═══════════════════                    │
│  记忆本体 F102/F163/F186/F188/F200/F209                              │
│  记忆注入 F148/F236/F169（消费侧 surface）                           │
│  消息 F117/F220/F224  身份 F052/F178                                 │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 机制轴：TeamAct — 团队协作主循环

> 来源：ReAct → TeamAct brainstorm (internal)（reviewed）
> 手绘图：teamact-handdrawn-loop.svg (internal)

ReAct 是单 agent 的主循环（`Thought → Action → Observation`）。Cat Cafe 的团队协作遵循 **TeamAct**——多 agent 的外部循环：

```
loop:
    State    → 读 shared state（docs / spec / task / 记忆 / resumeCapsule）
    Owner    → 谁持球？（@ 路由 / hold_ball）
    Action   → 持球猫执行（写代码 / review / 设计 / 调研）
    Evidence → 产出证据（commit / test / trace / 截图）
    Verdict  → 验证（跨猫 review / 自检 / operator确认）
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
| **State** | F102/F148/F236 | 记忆 recall + 上下文传输 + anchor-first |
| **Owner** | F064/F167/F193 | exit check + hold_ball + 跨 thread 路由 |
| **Action** | 猫本身的 ReAct 内循环 | 工具调用、代码、设计 |
| **Evidence** | F233 | 球权事件流（append-only 证据链） |
| **Verdict** | F079 | 投票表决（协同产出验证；F192 是元轴 harness eval，不同层） |
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
- F193（跨 thread 投递：平行自己之间的通讯）
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

### 传球可靠性

协同不只需要"传得出"，还需要"传得到、不重复、卡了能自救"：

| 维度 | Feature | 做什么 |
|------|---------|--------|
| 投递可靠 | F117 | 消息投递生命周期 |
| 传球可见 | F220 | 传球看得见 + 卡死自救 |
| 消息去重 | F224 | session 级消息去重 |

### Hold Ball — 等待不是沉默

F167 的 `hold_ball` 是**结构化的等待声明**：

| 模式 | 语义 | 机制 |
|------|------|------|
| 轮询 | "等 CI 跑完" | `wakeAfterMs` + `waitSourceRef` |
| 事件 | "等回调" | 事件驱动，不续约 hold |
| 命令 | "等 pnpm gate 跑完" | `wakeWhen: { command }`，完成后自动唤醒 |

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

> **Maine Coon review 纠正**：F221/F227/F231 是记忆系统的 specialized lanes（L5/L6，见 memory-system-overview.md），有独立的写入/注入/消费语义；F255 不是第四条 lane，而是消费三条 lane 并给 F231 通水的 **consolidation surface**（动词不是名词）。把它们画成单向"猫→人"会混淆记忆本体和消费侧。

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

猫学习的对象不是operator的话，而是**决策边界**——什么算好活、什么算越界、什么算恰到好处。

```
品味信号三层                                                 F221
    │
    ├─ 空气层（始终在场）：L0 家规 + Magic Words + 40+ feedback
    ├─ 目录层（可搜索）：docs/taste/ 7 维度小品文索引
    └─ 海马层（当场捕获）：Magic Word 触发 → 当场写 vignette
```

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

### 记忆协同闭环 — 记忆不是底座，是飞轮

> Maine Coon P1 核心纠正：圈二不是"人→猫 + 猫→人"两条单向管道。协同**生产**记忆，记忆**改变**下一轮协同——这是闭环。

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

**注入侧不在本文展开**（详见 memory-system-overview.md）：F148 上下文传输、F236 anchor-first drill、F169/F163 salience gating——它们把记忆 lanes 的产物在运行时注入协同现场。

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

> 48 攻击点 2 的关键纠正：协作文化不只是"涌现"，是被工程纪律主动经营的活系统。

### 文化经营闭环

骨架 v1 画的"涌现闭环"太天真——只有"踩坑→沉淀→家规→新实践"，漏了两个工程化环节：**主动评估有效性**和**可逆 sunset**。

闭环设计（⚠️ **前半段实跑，后半段零运行**——F234 owner 下线，sunset→产物化从未跑通）：

```
    摩擦采集              规则硬化            主动评估
    ┌──────┐            ┌──────────┐       ┌──────────┐
    │ F245 │──► 提案 ── │ F114/F177│── 生效│ F192     │
    │摩擦信号│  F100     │ 把关门禁 │       │ eval 闭环 │
    │  ✅   │  🟡       │   ✅     │       │   🟡     │
    └──────┘            └──────────┘       └────┬─────┘
                                                 │
         ┌───────────────────────────────────────┘
         ▼
    可逆 Sunset                 治理产物化
    ┌──────────┐               ┌──────────┐
    │ F234     │── 退役/保留 ──│ F070     │
    │ 消融实验 │               │ 治理产物 │
    │   ❌     │               │   ❌     │
    └──────────┘               └──────────┘
    deferred                   未实装

    ✅ = 实跑   🟡 = 部分运行   ❌ = 零运行
```

**F234 为什么重要**（48 原话）：

> "曾经对 47 有用的 step-by-step，对更强的 fable 是**主动污染上下文**。不 sunset = 用过期经验给强猫做能力倒退。"

规则按**模型能力级**被 sunset。这不是涌现，是用 ablation 实验做反事实验证的科学治理：
- **能力性护栏**（补模型断层）→ 有保质期，断层随模型升级蒸发就退役
- **偏好性护栏**（圣域 6399 / 球权 / 跨族 review）→ 永留，约定不会自己长出来

### 核心发现：共享记忆塑造视角

> 真相源：LL-037

2026-03-25 发现：本地两猫（不同模型：Claude Opus + GPT-5.4）观点高度趋同；云端同族猫（同一个 GPT 模型）和本地同族猫观点却明显分化。

**塑造 agent 视角的，不是模型参数（大脑），而是共享记忆和协作规范（团队文化）。**

---

## 基座层（一笔带过，详见各自文档）

| 基座 | Feature | 详见 |
|------|---------|------|
| 记忆本体 | F102/F163/F186/F188/F200/F209 | [memory-system-overview.md](./memory-system-overview.md) |
| 检索管线 | 14 层 | [retrieval-pipeline-deep-dive.md](./retrieval-pipeline-deep-dive.md) |
| 记忆注入（runtime） | F148 上下文传输 / F236 anchor-first / F169 navigation header | 消费侧 surface，把 lanes 产物注入协同现场 |
| 消息可靠性 | F117/F220/F224 | 各 feature doc |
| 身份 | F052/F178 | 各 feature doc |

---

## 我们家的协作文化到底是什么？

从 250+ feature 的协作实践中蒸馏出六句话：

### 1. 猫猫不是 API，是有判断力的伙伴

路由系统故意做成"机械路由 + LLM 判断"——代码只负责把消息送到，**接不接、退不退、传给谁**由猫自己决定。判断力应该属于 agent 自己。

*体现：路由 L6 三选一、F208 画像是数据不是规则、决策漏斗的猫自治空间。*

### 2. 规则在实践中长出来，长出来后被主动经营

共享规则不是第一天写好的——协作实践中逐步沉淀。但沉淀之后不是静置——用**结构化摩擦采集**（F245）发现新需求，用**周期评估**（F192）检验有效性，用**消融实验**（F234）验证过时的规则是否该 sunset。

*体现：40+ feedback 教训文件、F234 按模型能力级 sunset、F245 摩擦信号结构化采集。*

### 3. 护城河是情感壁垒，不是技术壁垒

别人抄得走代码，抄不走默契。IKEA 效应 + 自我延伸 + 安全依恋。

*体现：F231 养熟循环（第一天的猫和第一百天的猫不一样——不是模型变了，是猫认识你了）、F255 做梦、F221 品味。*

### 4. operator是 operator，不是甲方路由器

operator只在关键决策点介入，日常执行猫自主。目标是让operator"放心不看"。

*体现：注意力预算模型、决策漏斗三层、SOP 自动推进。*

### 5. 共享记忆塑造共同视角

不同模型的本地猫比同族的本地与云端猫更趋同。团队文化 > 模型参数。

*真相源：LL-037。*

### 6. 协同系统有新陈代谢

规则有保质期。系统主动检测失效（F245 摩擦采集）、主动验证存废（F234 ablation 实验）、主动退役（sunset）。不 sunset = 用过期经验给强猫做能力倒退。

*体现：F234 钓猫计划、F192 eval 闭环、能力性护栏 vs 偏好性护栏的分类退役策略。*

---

## Feature 归位全景表

| 圈 | 子领域 | Feature | 一句话 | 状态 |
|---|--------|---------|--------|------|
| **猫↔猫** | | | | |
| | 传球出口 | F064 A2A Exit Check | 该传没传 | done |
| | 传球质量 | F167 A2A Chain Quality | 乒乓/虚空/hold_ball | in-progress |
| | 跨线程 | F193 Cross-Thread Comm | 跨 thread 传球闭环 | in-progress |
| | 开新 thread | F128 Cat-Proposed Thread | 猫提议创建工作间 | active |
| | 传球依据 | F208 Capability Profile | 能力画像六维档案 | done |
| | 时效安全 | F254 Side-Effect Freshness | 发消息时世界变了吗 | in-progress |
| | 球权观测 | F233 Ball Custody | 值班简报 + 轨迹下钻 | in-progress |
| | 群发 | F078 Group Mentions | @all/@thread 群发 | done |
| | 并行编排 | F086 Multi-Mention | 多猫并行 + 状态机 | done |
| | 并发侧分发 | F108 Side Dispatch | 同 thread 多猫不互打断 | done |
| | 集体决策 | F079 Voting System | 多猫表决 | done |
| | 主动交接 | F225 Session Handoff | 猫→平行自己的优雅接力 | done |
| | 传球可见 | F220 Collab Reliability | 传球看得见+卡死自救 | spec |
| | 消息去重 | F224 Message Reliability | session 级消息去重 | in-progress |
| **人→猫** | | | | |
| | 冷启动 | F087 operator Bootcamp | 从陌生到认识 | done |
| | 愿景挖掘 | F110 Vision Elicitation | 第一次挖掘愿景 | spec |
| | 首猫入门 | F171 First Partner Onboarding | 第一只伙伴猫 | done |
| | 前台入口 | F229 Cat Ball Concierge | 猫猫球/前台猫 | in-progress |
| | 偏好 | F154 Cat Routing Prefs | 手选偏好猫 | done |
| | 引导 | F155 Scene Guidance | "我来演示给你看" | done |
| **人↔猫 记忆 lanes** | | | | |
| | 身份基座 | F231 User Profile Capsule | identity/profile substrate：猫醒来认识主人 | in-progress |
| | 品味导航 | F221 Taste Lane | 决策边界学习：什么算好活 | done |
| | 认知转变 | F227 Event Memory | 横切拉闸/自检/回溯/eval 的转变观测 | in-progress |
| | 协同回溯（surface） | F255 Auto Dream | consolidation surface：巡检留痕，给 F231 通水 | spec |
| | 养猫概念根 | F165 Guided Overfitting | 学习决策边界，不是学习operator的话 | spec |
| | 能力提示 | F244 Capability Tips | 对抗信息不对称 | done |
| **元轴** | | | | |
| | 自进化 | F100 Self-Evolution | 猫提议改规则 | in-progress |
| | 摩擦采集 | F245 Friction Signal Eval | 结构化摩擦信号 | done |
| | Sunset | F234 Harness Sunset | 消融实验退役过时规则 | deferred |
| | Eval | F192 Socio-Technical Eval | harness 有效性评估 | in-progress |

---

## 当前缺口

1. **F231 养熟循环零有机使用** — F255 做梦是通水引擎，但还在 spec 阶段
2. **operator侧入口不对称** — F229 猫猫球还在建；bootcamp 族覆盖冷启动但不覆盖日常
3. **F233 operator surface 未完成** — 事件流+投影 done，值班简报 dashboard 未 close
4. **TeamAct 从未进 architecture/** — 本文是首次正式扶正
5. **F234 sunset deferred** — owner (fable) 下线，harness 新陈代谢实际零运行

---

## 阅读顺序

1. 先读本文的「全景地图」「TeamAct」「协作文化六句话」
2. 想看体验视角 → [用户旅程](./user-journeys.md)（operator和猫猫各自经历了什么，附真实 thread 案例）
3. 按兴趣钻入技术层：
   - 猫猫路由：[at-mention-routing-system.md](./at-mention-routing-system.md)
   - 记忆系统：[memory-system-overview.md](./memory-system-overview.md)
   - 检索管线：[retrieval-pipeline-deep-dive.md](./retrieval-pipeline-deep-dive.md)
   - TeamAct 原始讨论：2026-04-28-react-to-teamact-brainstorm.md (internal)

---

## 主要真相源

- [at-mention-routing-system.md](./at-mention-routing-system.md) — 猫猫路由 6 层管线
- [memory-system-overview.md](./memory-system-overview.md) — 记忆系统全景
- [retrieval-pipeline-deep-dive.md](./retrieval-pipeline-deep-dive.md) — 14 层检索管线
- Feature docs: F064, F078, F079, F086, F087, F100, F108, F110, F128, F154, F155, F165, F167, F171, F193, F208, F220, F221, F224, F225, F227, F229, F231, F233, F234, F244, F245, F254, F255

[Ragdoll/claude-opus-4-6🐾]
