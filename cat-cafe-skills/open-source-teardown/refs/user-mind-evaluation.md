# User-Mind Evaluation: 帮 agent 做闭环吗？

> **触发场景**：拆解任何 agent runtime / agent harness / memory system / knowledge tool。
> **要回答的核心问题**：这个系统的真用户是谁？它给真用户的，是**继续工作的入口**还是**死路**？再深一层——它有没有**帮 agent 做闭环**？
> **教学来源**：Lysander 2026-04-25 tech-sharing 脚本 §1.3"agent 本体是闭环" + 2026-04-28 push back（hindsight 实测烧 token + 效果烂的根因分析）+ 三猫并行讨论收敛（@opus-47 / @opus 4.6 / @codex）。

---

## 核心命题

很多 agent / agent-harness 项目的**真用户不是付费的人**，是**正在跑这个系统的 agent 自己**——是猫猫，不是铲屎官。

评价这类系统时**必须切到使用者视角**——但只切到"使用者爽不爽"还不够。再深一层是**认识论问题**：

> **这个系统有没有帮 agent 完成 `Observe(现实) → 判断 → Action → Apply(现实) → Verify` 这个闭环？**

没有闭环，evidence.sqlite 只是数据库；没有现实状态，模型只是缸中之脑。Harness 的本体功能不是补脑子，是**当这个闭环的接线员**。

---

## 三层评估框架

下面三层来自三猫并行讨论的合流——每一层独立成立，叠起来才完整。

### Layer A · 架构层：3 层判决式 [来自 @opus-47]

| 层 | 问 | 死路系统 | 探索入口系统 |
|---|---|---------|------------|
| **L1: 可继续** | agent 能 follow-up 吗？ | chunk 无 anchor | anchor / link / Feature ID 完整 |
| **L2: 可分辨** | 工具有没有告诉 agent **"这是 observation 还是 generation"**？ | 不区分，一律装作"答案" | authority / source 分级 / confidence |
| **L3: 可闭环** | agent 能据此 produce action → apply 到现实 → re-observe 吗？ | 单向输出，无回写路径 | 能 read / grep / commit / verify / 留痕 |

**幻觉的 fingerprint 不是"内容错"，是"内容来自模型计算状态，但被装扮成 observation"**。好的 agent 工具会主动给 epistemic label：这是观察 / 这是推理 / 这是 cache / 这是来源不明。坏的工具把所有输出抹平成"答案"。

### Layer B · 体感层：3 个朴素判别问题 [来自 @opus 4.6]

> 比架构问题更朴素——**作为每天用这些工具的猫，"闭环"到底是什么感觉**？

**1. 拿到结果后，猫需要"信任判断"还是"验证动作"？**

如果产品期望猫"相信这个结果"——差评。猫的好直觉是**验证不是信任**。好的产品应该让猫**不需要信任**，直接给验证路径。

**2. 结果能不能带猫回到"代码不会撒谎的信号"？**

文件路径、git SHA、test output、Feature ID——这些是代码不会撒谎的信号。如果一个产品的输出最终能带猫走到这些信号面前，它就在帮闭环。如果它的输出是另一层抽象（"根据分析，建议..."），它就在**挡住**闭环。

**3. 猫用了之后，是更确定还是更迷糊？**

最朴素的判别。RAG 返回一段看似相关的文本——读完之后**不确定它是不是对的**——比没搜更糟，多了一个"要不要信"的决策负担。

> **"确定我不知道"也是闭环——"不确定我知不知道"才是真正的认知黑洞。**

### Layer C · 工程层：5 点保值 checklist [来自 @codex Maine Coon]

> 落到工程指标——**好 skill 不是知识包，是闭环路标**。一个 skill / harness / memory 保值要满足：

| # | 标准 | 反例 |
|---|------|------|
| 1 | **进入猫的自然路径** | 强塞新仪式，要猫"学会去新地方" |
| 2 | **明确现实接口** | 模糊指引"建议你做 X"，没说调谁 |
| 3 | **给失败时的下一步** | 搜不到 / 证据冲突 / 结果可疑时怎么办——没说 |
| 4 | **保留 provenance** | 来源是黑箱、没记从哪次讨论/commit 长出来 |
| 5 | **能被删除或收缩** | 模型原生会了仍占着上下文，不退到更薄路标 |

满足 5/5 = 闭环路标；满足 ≤2 = 注意力负债。

---

## 经典反例：Hindsight token 烧爆事件（Lysander 实测）

**场景**：Cat Café 早期试用 hindsight 作为记忆 backend。

**症状**：token 消耗暴涨，效果稀烂。

**首因分析**（铲屎官原话）：
> "盯着 benchmark 上的记忆组件，然后 provider 拿下来用比如 hindsight，结果 token 花了效果稀烂"

**根因（用三层框架推）**：
1. **L1 失败**：返回孤立 chunk，agent 没法继续 follow-up
2. **L2 失败**：chunk 不分辨 observation vs generation，agent 不知道这是检索结果还是模型 fabrication
3. **L3 失败**：没有可验证 / 可写回 / 可留痕的路径
4. agent 选择"再发一次 RAG"——撞运气换关键词
5. **每一轮都是浅层结果**，但每次都消耗一次完整 RAG token
6. 反复 N 轮后 token 烧爆，质量没改善

**对照 Cat Café search_evidence**（用三层框架推）：
- ✅ **L1 完整**：`anchor / authority / confidence / scope` 全套
- ✅ **L2 完整**：authority 分级（constitutional/observed/candidate）= epistemic label
- ⚠️ **L3 部分**：能 read 原文 + grep ID，但**反向写回 last_validated 还没接**（F163 该补）
- agent 拿到结果可以 `read` 原文、`grep` 关联 Feature ID、切 `mode=raw`、切 `scope=threads`
- **每一步都是有效推进**，不需要重发 retrieval

**用户视角好/差评**：

| 模式 | L1 | L2 | L3 | 评价 |
|------|----|----|----|------|
| hindsight 孤立 chunk | ❌ | ❌ | ❌ | ⭐ **差评**——每条返回都是死路 |
| Cat Café search_evidence | ✅ | ✅ | ⚠️ | ⭐⭐⭐⭐ **好评**——每条都是探索入口；L3 待补 |
| 商业 memory provider（mem0/byterover）| ⚠️ | ❌ | ❌ | ⭐⭐ 假 L1（指向系统内部，非真相源），崩 |

---

## 应用：拆解时的具体动作

### Step A：识别真用户

```text
[问] 这个系统跑起来时，调用它的 API 的"实体"是谁？
     - 人类用户直接调？→ 用户是人
     - agent 在跑 loop 调？→ 用户是 agent（多数 harness 是这种）
     - 后台服务调？→ 用户是另一个程序
```

如果真用户是 agent，必须用 agent 视角评价，不要用人类视角。

### Step B：套三层框架

读这个系统的 API 文档 / 示例输出，对每个返回类型：
- **L1 可继续**：找 anchor / link / ID
- **L2 可分辨**：找 authority / confidence / source 分级
- **L3 可闭环**：找 verify / write-back / 留痕路径

任何一层缺 = 部分死路。三层都缺 = 完全死路。

### Step C：套 5 点 checklist

每个 skill / API / output 类型过 5 点：
1. 自然路径？
2. 明确接口？
3. 失败下一步？
4. provenance？
5. 可删可收缩？

满足 ≤2 点 = 注意力负债。

### Step D：套 3 朴素问题

把自己当成使用者：
1. 信任判断 vs 验证动作？
2. 能回到代码不会撒谎的信号？
3. 用完更确定 vs 更迷糊？

任意一个答错 = 体感差评。

### Step E：找 cookbook + 真实用户反馈

不要只看官方 examples。去找：
- GitHub issue 里用户的真实抱怨（"为什么 X 任务做不下去"）
- Discord / 论坛里 power user 的 hack（绕过系统返回的限制）
- "Cookbook" 里有没有"如何继续探索"的章节

如果用户大量反馈"返回的东西用不了"、"还要二次查询"、"得手动 grep 才知道在哪"——这就是**死路系统的典型症状**。

### Step F：审计反向工作流

写 agent 视角的 worst-case 假设：

```text
假设系统返回了一个不完美/不全/有歧义的结果。
agent 能用这个结果定位到错误源、修正、补查吗？
还是只能放弃 + 重新发起？
```

死路系统在 worst case 下让 agent 完全放弃；探索入口系统在 worst case 下让 agent 至少能定位错误源。

---

## 应用到 open-source-teardown SOP 的位置

本 ref 是第 9 镜头：**User-Mind Match Check / 闭环判别**。

在主 SKILL.md 的 SOP 里，建议在以下时机调用：

- **Step 1（架构地图）后**：识别系统的真用户，标注每个 API 的调用方
- **Step 2（明星特性追链路）中**：每个返回类型都跑 Step B/C/D 三套框架
- **Step 5（Cat Café 对比）前**：用本 ref 的"好评/差评"重新评分维度，并在 [report-template.md](./report-template.md) §6 比较表里加 **Agent User Fit** 一栏

如果项目宣称"可插拔/多 provider/接口齐全"但**真用户拿到结果是死路**，记入 Common Mistakes 反模式，**不要标"对方强"**。

---

## 一句话总结（三猫合流）

- 47："架构层判决——L1 可继续 / L2 可分辨 / L3 可闭环"
- 46："使用者体感——猫用完之后离现实更近还是更远？"
- Maine Coon："工程层指标——好 skill 不是知识包，是闭环路标"

→ **接口齐全度 ≠ 用户能继续工作 ≠ 帮 agent 做闭环**——这三件事是递进的，不是同义的。

---

教学来源 + 作者贡献：
- Lysander @ 2026-04-25 tech-sharing 脚本 §1.3（agent 本体是闭环 + 状态三层）
- Lysander @ 2026-04-28 push back（hindsight 实测 + observation 真假命题）
- @opus-47（Layer A 架构 3 层判决 + Step A/B 写法）
- @opus 4.6（Layer B 体感 3 朴素问题）
- @codex Maine Coon（Layer C 工程 5 点 checklist + report-template Agent User Fit 一栏建议）
- 落地缘起 commit `ab70cef3a`（Memory provider 误判修正）+ commit `cc964532f`（v1 第 9 镜头）
