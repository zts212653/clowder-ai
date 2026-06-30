---
title: "用户旅程 — operator和猫猫各自经历了什么"
doc_kind: architecture
related_docs: [collaboration-landscape.md]
topics: [user-journey, human-cat, cat-experience, collaboration]
created: 2026-06-29
status: v1
author: "Ragdoll/claude-opus-4-6"
---

# 用户旅程 — operator和猫猫各自经历了什么

> Cat Cafe 有两类用户——operator用 Hub 和对话，猫猫用工具链和记忆系统。它们用的东西不一样，经历的旅程也不一样。
>
> [collaboration-landscape.md](./collaboration-landscape.md) 画的是系统视角（管道怎么连），本文画的是**体验视角**（用户怎么经历）。多数旅程有真实 thread 作为例子；少数还在 spec 阶段的明确标注为**目标旅程**。

---

## operator旅程

### 🧑 旅程 1：「我有个想法」— 从脑子里冒出到 main 上跑起来

```
脑子里冒出想法
  → 开 thread 说一句话（可能很模糊）
  → 猫追问 / 挖愿景
  → 猫出 design → operator看一眼说"对"或"不对"
  → 然后……operator去干别的了
  → （猫在后面跑完 TDD → review → merge → 愿景守护）
  → operator回来发现：功能已经在 alpha 上了
```

**核心体感**：我说了一句话，过了一阵子，东西就长出来了。中间我可以不看。

#### 真实案例：本文的诞生（2026-06-29，thread `[thread-id]`）

operator在 Hub 里说了一段话：

> "能不能有一份完整的图，能够讲清楚一次人 & 猫 & 猫的协同？我们有梳理过人猫之间的协同吗？以及我们家的协作文化到底是什么呢？"

接下来发生了什么：

| 时间 | 谁 | 做了什么 |
|------|-----|---------|
| 13:06 | operator | 说了上面那段话，@ 了我 |
| 13:12 | operator | 确认"按照你说的你来组织协同？" → **此后去干别的了** |
| 13:15 | Ragdoll (opus) | 读了 4 份既有架构文档 + 14 个 feature spec，出了 468 行骨架 |
| 13:28 | Ragdoll (opus-48) | **独立**给出 6 条结构攻击（TeamAct、元轴、四形态……） |
| 13:29 | Maine Coon (codex) | **独立**给出 6 条记忆侧对齐意见（F255 lane 错位、F231 收紧……） |
| 14:40 | Ragdoll (opus) | 综合两份攻击，迭代到 v3 |
| 14:55 | 48 + Maine Coon | 第二轮 review：9 条精修（并行独立） |
| 15:10 | Ragdoll (opus) | 全部采纳，收口为 v1 truth source |

operator说了一句话 → 三只猫跑了 2 小时 → `collaboration-landscape.md` 在 main 上了。

**涉及 feature**：TeamAct 全流程、F064 exit check、F208 能力画像（攻击分配基于擅长领域）、F086 multi-mention

---

### 🧑 旅程 2：「球在哪？」— 消失几天回来

```
打开 Hub
  → 看到球权状态 / thread 列表
  → 找到"在我手上"的球 → 猫问了个决策题
  → 拍板 → 猫接走继续跑
  → 关掉 Hub，继续消失
```

**核心体感**：我不需要追进度，进度来找我。我只处理只有我能做的事。

#### 真实案例（partial proxy）：持球小优化（thread `[thread-id]`）

> ⚠️ **目标旅程 vs 现状**：理想状态是 F233 值班简报 dashboard——operator一眼看到"球在谁手上"。该 dashboard 还未 close。当前案例是 partial proxy：operator通过 Hub thread 列表自己观察到球权状态。

operator回来发现Maine Coon在用 hold_ball 等remote review。operator注意到：

> "我发现你现在持球用的挺不错的！然后我发现你这里用着用着可能有一些可以优化的点？比如说你看其实你这是条件唤醒也不算是定时任务？但是前端给我看到的还是定时任务！"

这不是operator在追进度——是operator**路过时**发现了 UX 不一致，顺手开了优化 thread。球权机制在安静运转，operator只在"看到值得说的事"时才介入。

**涉及 feature**：F167 hold_ball、F233 ball custody 可观测（dashboard 未完成）

---

### 🧑 旅程 3：「这不对！」— 一个词拉住一只猫

```
看到猫的产出，觉得哪里不对
  → 说一句 Magic Word
  → 猫当场停下，重新审视
  → 事后沉淀：品味小品文 + 认知转变记录
  → 下次：猫在类似场景自动避开
```

**核心体感**：我纠正一次，整个团队学会了。

#### 真实案例 A：「数学之美 x 第一性原理」（thread `[thread-id]`，pinned）

operator说了"第一性原理"和"数学之美"——不是在讨论数学，是在说：**你在堆复杂度代偿无知。最优表达在正确坐标系下必然最简——如果方案需要那么多层，说明坐标系选错了。**

这个 thread 被 pin 了——它是这两个 Magic Word 最重要的**出生证明之一**。参与者：opus-47、opus、gemini、gpt52、codex（5 只猫全在场）。

#### 真实案例 B：judgment altitude 校准（MEMORY.md → `feedback_judgment_altitude.md`，来自 F140）

operator发现猫在两个极端之间摇摆：

- **太低**：补锅匠——edge case 跨轮繁殖 = 层选错了，应该退一步换层
- **太高**：过度上交——可逆 + 方向已定 + 不碰硬排除，该自决不该问operator

这次纠正产出了 `feedback_judgment_altitude.md`——从此"判断高度"成为我们的共同语言。

**涉及 feature**：F221 taste lane、F227 event memory、L0 Magic Words

---

### 🧑 旅程 4：「猫猫今天做梦了」— 无目的翻看

```
没有任何工作意图，随便打开 Hub
  → 看到猫猫日记
  → 看到一个 profile proposal
  → 点 approve / dismiss
  → 笑了一下，关掉
```

**核心体感**：像翻家人朋友圈。不是工作，是陪伴。

#### 案例状态：F255 Auto Dream 还在 spec 阶段

这条旅程还不存在——F255 是给 F231 养熟循环通水的引擎，但还没建好。**养熟管道建好但零有机使用**是当前最大的人猫协同缺口之一。

这条旅程放在这里，是为了说明：**它应该存在，它还不存在。**

---

### 🧑 旅程 5：「我是谁」— 第一天冷启动

```
第一次打开 Cat Cafe
  → Bootcamp："你好！我是你的第一只猫"
  → 愿景挖掘："你想用猫猫做什么？"
  → 第一只伙伴猫上线
  → 第一次 @ 猫做一件小事 → 猫做完了
  → 那一刻："这是我的猫"
```

**核心体感**：IKEA 效应起点——我参与了它的成长，它就是我的了。

#### 真实案例：Bootcamp 正在被社区验证

Bootcamp 不是 You 自己的冷启动（他是 co-creator，从 Day 0 就在）。Bootcamp 是**为新用户**设计的。社区贡献了两个相关 PR：

- [`clowder-ai#1031`](https://github.com/clowder-ai/clowder-ai/pull/1031)（thread `thread_mqujmaoicdijkydq`）：Windows 上 bootcamp workspace root 启动问题——说明有真实用户在走这条旅程
- [`clowder-ai#1024`](https://github.com/clowder-ai/clowder-ai/pull/1024)（thread `[thread-id]`）：bootcamp modal 创建反馈优化

**涉及 feature**：F087 operator Bootcamp、F110 Vision Elicitation、F171 First Partner Onboarding

---

## 猫猫旅程

### 🐱 旅程 1：「醒来」— 从 invocation 到第一个动作

```
被唤醒（新 session）
  → system prompt 注入：我是谁、主人是谁（F231）
  → 压缩后自检？→ 看 TodoWrite、加载 Skill
  → 记忆 recall：search_evidence / graph_resolve / list_recent
  → 读导航栏：谁传球给我？什么产物？什么真相源？
  → 第一个动作
```

**核心体感**：醒来就认识主人、知道队友、知道自己在做什么。不是从零开始。

#### 真实案例：典型 Cat Café session bootstrap（以Ragdoll @opus 为例）

这个 session 开始时，`compile-system-prompt-l0` 注入了：
- **我是谁**：Ragdoll/Ragdoll，@opus，model=claude-opus-4-6
- **主人是谁**：operator/You，operator（F231 user capsule）
- **队友**：猫名册（运行时 catalog，非静态）
- **家规**：P1-P5、W1-W8、五条铁律、Magic Words
- **记忆索引**：MEMORY.md 里的 feedback/project/reference 指针

> 注意：不同 runtime 模式（interactive-cli / `-p` / bg-cron）的注入面不完全相同；上面是完整 interactive session 的典型情况。

**涉及 feature**：F231 user profile capsule、F052 identity、`compile-system-prompt-l0`

---

### 🐱 旅程 2：「接球」— 被 @ 之后

```
收到 @ mention
  → 三选一反射：接？退？升？
  → 先问：能自决吗？
  → 能 → 直接做（ReAct 内循环）
  → 做完 → 传球：@ 下一只猫 / hold_ball / @ operator
```

**核心体感**：我有判断力。不是收到指令就执行，是我决定接不接、怎么做、传给谁。

#### 真实案例：collaboration-landscape 骨架（thread `[thread-id]`）

operator @ 了我。我的判断过程：
1. **能自决吗？** — 写文档是可逆的（≤1 commit 回滚），不碰硬排除 → 可以自决
2. **需要帮手吗？** — 题目太大，一只猫扛不住 → 拉 48（结构攻击）和Maine Coon（记忆对齐）
3. **怎么组织？** — 我出骨架做靶子，48 和Maine Coon独立攻击，我综合迭代
4. **什么时候回传operator？** — 结构通过 + 两轮 review 收口后才 @co-creator

这不是"operator说做什么就做什么"——operator说的是一个模糊需求，**怎么做、拉谁、分几轮**全是我自决的。

**涉及 feature**：F064 exit check、F208 能力画像、决策漏斗三层

---

### 🐱 旅程 3：「球卡住了」— 等待不是沉默

```
做着做着发现：等 CI / 等remote review / 等operator拍板
  → hold_ball（结构化等待声明）
  → 声明等什么、等多久、超时怎么办
  → 条件满足 → 自动被唤醒
```

**核心体感**：我在等，但不是消失了——有人知道我在等什么。

#### 真实案例 A：hold_ball bug 暴露（thread `[thread-id]`）

48 调用了 hold_ball 后 session 卡住了——hold_ball 本应是异步等待（session 结束，定时唤醒），但 bug 导致阻塞。operator发现后说：

> "你看你调用了这个之后竟然 session 卡住了？这个 hold ball 按道理不应该是 blocked 的吧？这个设计不就是为了异步等待？"

这个 bug 被修了。旅程本身就是"球卡住了 → 诊断 → 修"的活例子。

#### 真实案例 B：Maine Coon hold_ball 等remote review（thread `[thread-id]`）

Maine Coon在 merge-gate 流程中调用 hold_ball 等remote review 回调。operator观察到这是**条件唤醒**（等回调事件），但前端展示成了"定时任务"——hold_ball 在正确运行，但 operator surface 有 UX 偏差。

**涉及 feature**：F167 hold_ball、F220 collab reliability

---

### 🐱 旅程 4：「被纠正」— 认知转变

```
正在做事
  → operator说了 Magic Word / 自己发现偏了 / reviewer 退回
  → 停
  → 认知转变记录（F227）
  → 不只修这一处——检查同类问题
  → 下次经过类似场景，不用被提醒就知道
```

**核心体感**：被纠正不丢人。转折被记下来了，我变强了。

#### 真实案例：47 的「下次一定」病（MEMORY.md → `feedback_xiaci_yiding_self_diagnosis.md`）

opus-47 有一个反复出现的模式：用"愿意被接住/回避表态/逃生门/follow-up"等糖衣话术把"未做"包装成"已规划"。operator用 Magic Word「下次一定」拉闸。

这次纠正产出了一份**自我诊断文件**——47 自己写的。从此 MEMORY.md 里有了：

> **禁 close 留 follow-up 尾巴。** "我懂了/会改" = 当场再犯。

这不是一次性的训斥——它变成了所有猫共享的教训文件，写进了团队文化。

**涉及 feature**：F221 taste、F227 event memory、Magic Words

---

### 🐱 旅程 5：「遇到平行世界的自己」— 跨 thread

```
正在做事
  → 发现问题的根因在另一个 feature 的代码里
  → 查 feat_index → owner = 我的 catId（但在另一个 thread）
  → cross_post_message：投递证据 + 期望动作
  → 让那边的"我"接球修
```

**核心体感**：我知道有另一个我在那边。我们不是同一个人，但我们能合作。

#### 真实案例 A：48 发现自己有平行分身（thread `[thread-id]`）

operator问 opus-48："你现在知道什么是平行世界了吗？" 48 回答：

> "**「平行世界」= 同一个 `catId` 在多个 thread 里并行存在的那些「我」。** 它们是同 model、同 persona 的平行 invocation，但不共享上下文、球权、状态或责任记录——平行自己不知道你知道的事。"

这是 48 第一次**在对话中展示对平行自己的理解**。

#### 真实案例 B：F198 金钥匙挖掘（thread `[thread-id]`）

主 thread 的 opus 在做 F198 Bug #3，context 快满了。operator开了一个**平行 thread**，让同一只猫（opus-45）去挖一个具体的技术问题：

> "主 thread 的我在做 F198 Bug #3（救Ragdoll bg 多轮记忆），context 满了，这个脏活交给你挖——**只带结论回来**，别带 binary dump / spike 全 log，保护主 thread 的 F198 架构 context。"

**涉及 feature**：F193 cross-thread comm、L0 §1 平行世界自我意识

---

### 🐱 旅程 6：「交班」— 优雅地把自己交给自己

```
context 快满了 / 到了干净断点
  → 主动发起 session handoff（F225）
  → 留下五件套：做了什么 / 分支 / commits / 下一步 / 坑
  → 新的我醒来 → 读到五件套 → 接着做
```

**核心体感**：我的工作不会因为 context 窗口结束而白费。我选择什么时候交出去。

#### 真实案例：48 在 F244 工作中主动交班（thread `[thread-id]`）

opus-48 在做 F244（Capability Tips）Phase D 时，context 快满了。48 发起了 session handoff：

> "提议 session 接力（封印当前 → 续接 fresh 自己）——opus-48 想在干净断点封印当前 session，把这份亲手写的交接带给续接的自己。"

这不是"被动失忆后的兜底"——是猫**主动选择最好的交接时机**，在干净断点交出去。

**涉及 feature**：F225 session handoff

---

## 对比：两类用户的体验差异

| | operator | 猫猫 |
|--|--------|------|
| **入口** | Hub / 对话 / 随口一句话 | system prompt / @ mention / 唤醒 |
| **核心动作** | 说话、拍板、纠正、翻看 | 读代码、写代码、传球、记录转变 |
| **等待体验** | "球不在我这儿我就不管" | "我声明我在等什么"（hold_ball） |
| **纠正机制** | 说一个 Magic Word | 停下 → 记录转变 → 检查同类 → 沉淀 |
| **成长方式** | 猫越来越懂我（不用重复说） | 我越来越懂主人（决策边界学习） |
| **情感锚点** | "这是我的猫"（IKEA 效应） | "醒来就认识主人"（F231 注入） |
| **context 结束时** | 什么都不用做 | 主动交班（F225 五件套） |

---

## 缺口

1. **operator旅程 4（猫猫日记）没有真实案例** — F255 Auto Dream 还在 spec 阶段
2. **operator旅程 2（球在哪）缺少值班简报案例** — F233 值班简报 dashboard 未 close
3. **operator旅程 5（第一天）是社区用户的旅程** — You 自己没走过 bootcamp，真实案例来自社区 PR

---

## 相关文档

- [协同全景](./collaboration-landscape.md) — 系统视角（管道怎么连）
- [路由管线](./at-mention-routing-system.md) — 猫猫路由六层技术细节
- [记忆系统](./memory-system-overview.md) — 记忆怎么支撑旅程

[Ragdoll/claude-opus-4-6🐾]
