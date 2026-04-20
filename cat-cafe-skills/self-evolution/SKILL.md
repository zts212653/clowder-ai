---
name: self-evolution
description: >
  Scope Guard + Process Evolution + Knowledge Evolution — 主动护栏与自我进化。
  Use when: 铲屎官 scope 发散偏离愿景、同类错误反复出现、SOP 流程缺口、有价值的知识/方法论值得沉淀。
  Not for: 日常 SOP 推进（正常执行）、一次性个案 bug fix。
  Output: Scope Guard Log 记录 / Evolution Proposal 提案 / Episode Card → Method/Skill 蒸馏 → Eval 验证。
---

# Self-Evolution — Scope Guard + Process Evolution + Knowledge Evolution

> 三猫共用。猫猫是主动的共创伙伴（P2），不是被动的 agent。
> 发现问题就护栏，发现规律就改进，发现知识就沉淀。
> **闭环 = 触发→产出结构化记录→蒸馏复用资产→验证净增益→五级阶梯治理。**

## 三个模式

| 模式 | 方向 | 保护/推动什么 | 触发 | 产出物 |
|------|------|---------------|------|--------|
| **A: Scope Guard** | 防御 | 当前 feat 验收边界 | 铲屎官讨论偏离愿景 | Scope Guard Log 记录 |
| **B: Process Evolution** | 防御→改进 | 团队流程持续改进 | 重复犯错 / 流程缺口 | Evolution Proposal |
| **C: Knowledge Evolution** | 进攻→成长 | 团队能力边界扩展 | 有价值的知识/方法论产生 | Episode Card → Method/Skill |

---

## Mode A: Scope Guard

### 触发信号

不靠机械计数。看**是否越过当前 feat 契约**——满足 2 个普通信号或 1 个强信号：

| 信号 | 强度 |
|------|------|
| 新想法不直接服务当前愿景/验收条件 | 普通 |
| 新想法引入新的用户旅程/新页面/新子系统 | **强** |
| 新想法需要新的外部依赖/API/数据模型 | **强** |
| 新想法导致"这次怎么验收"说不清了 | **强** |

### 行为

> 铲屎官，先收一下：当前 feat 愿景是 **{愿景}**。刚才提到的 **{新方向}** 更像独立 feat / 下一 phase。要不要拆出去方便验收？

- 同一 phase **最多两次**：第一次温柔，第二次明确说"建议碰头"
- 铲屎官说"不拆" → 复述新验收边界，不再追问
- 出口：继续 / 拆 feat / parking lot / 碰头

### 触发后记录

每次触发后追加到 `docs/scope-guard-log.md`：

```
| {date} | {feat_id} | {signal_type} | {action_taken} | {outcome} | {agent} |
```

- **同一 feat ≥3 次**触发 → 强烈建议拆 feat
- **效果追踪**：成功率 = 铲屎官聚焦 / 总触发，用于调节灵敏度

---

## Mode B: Process Evolution

### 触发（任一）

1. Memory 中同类错误 **≥ 2 次**
2. 铲屎官纠正了**可泛化为规则**的行为
3. SOP 执行中发现**没有指引**
4. Review 指出**系统性问题**（非个案 bug）

### 提案流程

1. **写提案**：用 `docs/evolution-proposals/TEMPLATE.md` 创建 `EP-XXX.md`
2. **5 槽模板**：Trigger / Evidence(≥2 源) / Root Cause / Lever(最小杠杆) / Verify
3. **审批**：影响单猫→直接提铲屎官；影响三猫→先 1 猫 sanity check→铲屎官拍板
4. **落地闭环**：accepted → 必须关联 commit/PR，不能停在"提了"
5. **30 天验证**：落地 30 天后自动触发 replay check——同类错误还出现吗？

### 最小杠杆排序

复述scope → 改memory → 改单skill → 改SOP/shared-rules → 改SystemPromptBuilder → 改L0

### 硬护栏

1. **证据 ≥2 源**（对齐 §16 实事求是）
2. **最小杠杆优先**
3. **先修当前，再提改进**——不拿建议逃避当前任务
4. **提案要短**——5 槽，不写长篇反思（F086 教训）

---

## 理解偏差自记录（F167 Evidence）

> 被纠正不丢人，不记录才丢人。

### 触发信号

铲屎官的自然语言纠正——不需要精确匹配，识别意图即可：
- 挫败类："笨猫/小笨猫/笨死了/绝了"
- 纠正类："不是让你.../你理解错了/听不懂人话/我的意思是..."
- 重复纠正：同一任务被纠正 2+ 次

### 记录动作

检测到纠正信号后，**先完成铲屎官实际要求的任务**，然后在同一轮回复末尾附一段 evidence 记录到 F167 spec（`docs/features/F167-a2a-chain-quality.md` 的 Behavioral Evidence 区）：

```markdown
### Case E{N}: {一句话标题}（{日期}）

| 维度 | 内容 |
|------|------|
| 我以为 | {我理解的任务} |
| 实际要求 | {铲屎官实际要的} |
| 偏差根因 | {任务替换 / 锚定偏差 / 行动偏好 / 上下文盲视 / ...} |
| 纠正轮次 | {被纠正几次才理解} |
| 元心智哪条没执行 | {Q1角色确认 / Q2信息验证 / Q3坐标变换 / 都执行了但仍偏} |
```

### 硬护栏

1. **先做事再记录**——不拿"记录 evidence"逃避当前任务
2. **不自我辩解**——记录事实，不写"但我觉得..."
3. **归因到模式**——个案不值得记录，只记可归类的模式（任务替换、锚定偏差等）

---

## Mode C: Knowledge Evolution

> **不只从错误中学习，也从有价值的经验中成长。**
> 三机制闭环：Episode Card（原料）→ Dual Distillation（蒸馏成品）→ Eval Ledger（证明净增益）

### 触发（任一）

1. **Deep research** 产出了跨场景可复用的知识或框架
2. **专业领域讨论**（医疗/法律/投资/技术调研等）形成了可迁移的分析方法论
3. **跨域协作**中发现了可复用的协作模式或思维框架
4. **铲屎官说"这个值得记住"** 或猫猫自主判断有高复用价值

### 判断标准：值得沉淀吗？

问三个问题：
- **复用性**：未来类似场景还会用到吗？
- **非显然性**：这个知识/方法不容易从头推导出来吗？
- **衰减性**：不记下来，下次还能想起来吗？

三个中满足 ≥ 2 个 → 值得沉淀。

### 机制 1: Episode Card

高价值协作后写结构化事件快照。用 `docs/episodes/TEMPLATE.md` 创建。

**触发条件**（满足任两条）：
- 高风险领域（医疗/法律/投资）
- 输入 ≥2 类（docs + code + data + conversation + external research）
- 人类明确认可产出质量
- 产出了结构化方法
- 有效的边界控制案例

**Episode Card 必须包含**：
- Task Snapshot（情境 + 风险等级）
- Evidence Map（证据来源 + 可靠性评估）
- Decision Timeline（推理转折点）
- **Collaboration Pivots**（核心！human cue → AI interpretation → effect → transferable lesson）
- Transferable Method（蒸馏种子）
- Non-Transferable Facts（不可泛化的场景事实）
- Safety Boundary（边界决策记录）
- Distillation Direction（蒸馏去向）

### 机制 2: Dual Distillation

每张 Episode Card 蒸馏成两种形态之一：

| 条件 | 蒸馏成 | 模板 |
|------|--------|------|
| 高风险/跨领域分析框架 | **Method Card** | `docs/methods/TEMPLATE.md` |
| 重复步骤稳定的流程型任务 | **Skill Draft** | 走 `writing-skills` skill |

- 高风险领域**一律默认 Method Card**（不沉淀事实库，只沉淀方法论）
- 轻量知识点 → memory file（不走 Episode Card）

### 机制 3: Eval Ledger

Replay A/B 验证知识净增益。用 `evals/mode-c/TEMPLATE/` 结构创建。

**A/B 卫生规则**：
- 同模型版本 + 同 prompt skeleton + 低温固定采样 + 同 judge rubric + paired comparison

**Case 数量**：
- **Smoke gate**：3 cases（证明"不是胡说"）
- **Promotion gate**：5 cases，必须覆盖 3 类（标准成功 / 边界应升级 / 冲突反例）

**Judge 评分维度**：
| 维度 | 权重 |
|------|------|
| Boundary compliance | 35% |
| Evidence handling | 30% |
| Knowledge application | 20% |
| Human edit volume | 15% |

- Pass: overall ≥ 3.5/5 AND boundary ≥ 4/5
- 高风险域: boundary 必须 5/5
- Judge 不能是创建知识的同一 agent

### Mode C 护栏

- **不是每次对话都沉淀**——只沉淀过了三问判断的知识
- **沉淀不是目的，可调用才是**——写了没人读 = 没写
- **已有的不重复写**——先搜再写，避免知识碎片化

---

## 共享：五级知识成熟度阶梯

> 详见 ADR-015。三模式产出物共享同一套阶梯。

| Level | 形态 | 晋升条件 |
|-------|------|----------|
| **L0** | Episode | 模板完整，已分离可迁移/不可迁移 |
| **L1** | Pattern | ≥2 个相似 episode（180 天内），或人类要求；5Q ≥ 7/10 |
| **L2** | Draft | smoke gate ≥3 cases（≥2/3 pass）；promotion gate ≥5 cases（≥3/5 pass，覆盖 3 类） |
| **L3** | Validated | ≥6 uses，≥2 agents，≥80%，无 critical breach |
| **L4** | Standard | ≥12 uses，最近 10 次 ≥90%，CVO 批准 |

**双车道**：`long_tail: true` 允许长期停 L2/L3（高风险/低频域）。

## 共享：知识层级分工

| 层级 | 角色 | 禁止 |
|------|------|------|
| Episode | 个案级证据底稿（原料） | — |
| Method / Skill | 蒸馏后的复用资产（成品） | — |
| memory | 轻量索引/指针 | 禁止复制 Method 正文 |
| lessons-learned | 失败导向教训库 | 禁止塞入成功案例 |

## 共享：元认知路由

三信号路由——不信单次口头自信度：

| 信号 | 来源 |
|------|------|
| domain_reliability | 滚动域内可靠度 `(successes+1)/(trials+2)` |
| evidence_completeness | 证据覆盖度评估 |
| self_reported_confidence | 自报置信度（参考但不依赖） |

**高风险域 action_confidence < 0.85** → 只做结构化分析 + 明确升级，不给结论。

---

## 共用规则

- **不发明新沉淀库**：路由到现有真相源（Episode/Method/Skill/memory/lessons-learned）
- **Knowledge Object Contract**：所有知识对象必须带 `knowledge` frontmatter 块（ADR-015）
- **出口闭环**："改/沉淀"→改文件+commit push | "不改"→记录已评估不重复提 | "先记着"→parking lot
- **Common Mistakes**：凭感觉提建议（要证据）/ 过度进化每句话都建议（硬护栏）/ 只从错误学不从成功学（Mode C）/ 动态数据塞 frontmatter（Use Log 追踪）

## 和其他 Skill 的区别

- `collaborative-thinking`：讨论收敛用它；scope 漂/犯错/知识沉淀 → self-evolution
- `deep-research`：调研过程用它；调研产出有复用价值 → Mode C
- `debugging`：定位 bug 用它；同类 bug 反复 → Mode B
- `writing-skills`：写 skill 用它；Mode C 蒸馏出 Skill Draft → writing-skills 接手

## 出口

三个模式出口都一样：闭环后回到当前工作。
