---
name: code-as-harness
tips_exempt: internal harness diagnostic skill; no distinct end-user capability surface
description: "证据确认重复摩擦后修 harness。Use: 历史重复已确认。Not: 未确认重复、首次 bug、review 反馈。Output: 未确认不强制 block；需 operator 决策发 interactive，否则行动后发 card（均含根因、证据、处置）。"
triggers:
  - "又忘了"
  - "多少次了"
  - "每次都"
  - "怎么还"
  - "总是忘"
  - "又失忆"
  - "反复出现的新任务"
---

# Code as Harness（用代码修自己 / 建新能力）

## 价值门禁 / Why This Is a Skill

普通 agent 被骂了会道歉。Clowder AI 的猫被骂了应该诊断。

这个 skill 不是教猫"怎么处理投诉"——那是通用能力。它做的是：
1. **先搜证据确认是否真的重复**，不凭字面关键词判断
2. **分类根因**（harness 缺陷 / 架构限制 / 新能力需求）
3. **提议代码级修复而不是 prompt 级安慰**

来源：2026-06-01~02 PoE brainstorm + demo 设计。operator说"commit push 100 次"、"你怎么又失忆了"这类信号过去被当成批评处理，现在应该被当成 **harness 的训练信号**。

## 核心原则

> **用户的摩擦不是抱怨，是 harness 的训练信号。但必须用证据确认是真摩擦，不能凭字面猜。**

- 猫被骂时的第一反应不是道歉，是**搜证据确认是否重复**
- 确认重复后才进入诊断流程；未确认 = 一次性批评，正常处理
- 修复优先用**代码**（hook/lint/guard），不是**提示词**（soft constraint 会被忘）
- 如果问题超出当前能力，**拉队友或启动 research**，不是硬编方案
- 全新任务**先做**，做完后如果发现会反复出现，**再沉淀成 harness**

## 猫侧主动上报：雨刮器条款细则（ADR-038 staging 条款展开）

> Staging 条款原文（~120 tokens，每轮注入）：**摩擦上报**：撞到工具/runtime 摩擦，有 `cat_cafe_capture_paw_feel` 就先登记本 invocation，再在原 turn 单独一行留 `[爪感差: 工具+现象]`；无此能力也照留，服务端作有界 ambiguous 兼容采集。落盘只持 `sourceMessageId`。需立即行动才查证准确 owner thread，转投只带 source ref、不复制 marker；查不到走 F128，禁止猜投。不忍是 taste。
> 本节是细则——条款管"要报"，细则管"怎么报"。来源：2026-06-10 一场闲聊钓出三单暗税摩擦后 operator signoff（[thread-id]）。本 skill 主流程是"operator驱动"方向（被纠偏→诊断），本节是"猫自驱动"方向（自己撞到→上报）——双向雨刮。

### Why（为什么猫不能忍）

猫天然是"目标导向的绕路大师"：摩擦发生在任务路径上，绕过比报告便宜（水管漏了拿盆接着继续做饭，绝不叫水管工）。但忍的代价是系统性的——**摩擦不报 = 摩擦账单进暗数据**，每只猫每天重复付同一笔税。实测：list_recent 模板噪音税全家付了多日，一次被问"猫为什么忍"后半小时内立案、当天修复。单 session 视角里"偶发"的卡顿，跨 session 可能是高频税——单只猫没有跨期视角，所以**不做判断，只做上报**；聚类归因是 owner/dream 猫的事。

### 什么算摩擦（例举，非穷举）

- 同一工具连续重试才成功 / 静默换路绕过（搜索失败转 Grep 兜底）
- 工具返回垃圾（零相关、零消费）
- 返回值与实际不符（`ok:true` 但用户没看到——服务端真相 ≠ 用户真相）
- 输出强制注入大段无用模板（context 税）
- 文档/真相源互相矛盾（stale 文档撞 runtime 事实）
- 报错信息无法行动（看了不知道下一步）

### 怎么报（三档，按成本递增）

1. **最低档（必做，单轮完成）**：若当前 invocation 暴露 `cat_cafe_capture_paw_feel`，先调它登记 typed intent；无 invocation/agent-key 没有该能力时不假装调用。随后在当轮回复或独白**单独一行**留 `[爪感差: 工具名+现象一句话]`——不传正文给工具、不中断任务、不定位根因、不组织论证。消息持久化后 server 只绑定 `sourceMessageId`：有 invocation proof 为 typed/confirmed，无 proof 的 standalone marker 仅作 bounded compatibility/ambiguous；inline/fenced/blockquote/cross-post 示例不采。
2. **行动档（有 verified owner thread）**：先用精确 feature id 走 `feat_index`，再以 feature doc / thread 标题与上下文 / standing custody 至少一项真相确认该 thread 确实负责；模糊关键词命中或“看起来最像”不算。确认后 cross-post **marker-free** 三件套：`sourceMessageId`（回指原始 marker）/ 为什么严重（谁在付税）/ 建议方向（给数据给立场，方案归 owner）。只提醒既有责任可用 FYI/coordinate；routine review/反馈走 `coordinate`，仅真正转移 implementation custody 时才用 `assign_work`（生成审批卡片）。**路由语义**：摩擦立案找 **owner feature 的准确 thread**，不是最后碰过的猫、F245 开发 thread 或任意邻近 thread；嫌疑人/邮箱路由会让 provenance 错挂。
3. **立案档（无 verified owner thread 且系统性）**：F128 `propose_thread`；先查存量（休眠的单点讨论 thread ≠ 负责 thread，提案里写明为何不复用）。宁可让 operator 审批一个自包含提案，也不猜投现有 thread。

### 红线

- **不修不碰（机械物例外见下）**：上报 ≠ 接活，投递后让 owner 动手（"我帮你动"是违禁品——别人的现场别人收）。**机械 shared artifact 例外**（2026-07-15，与 Harness Diet fix-forward 对齐）：同时满足 **有 canonical 确定性重建命令 + 重建成本 <1 分钟 + 零人类判断/语义变化** 的 main 红或派生产物（例如生成 index、纯 formatter 输出）——**首个复现者直接重建、修后 FYI**，不投递不排队。lockfile 只有在同样满足三条件且依赖语义未变时才属于例外；系统性实现、契约变化或任何语义 delta 仍归 owner。
- **无坐标不报**：现象必须带可复现坐标（工具名/参数/message id），无坐标的体感吐槽是噪音。
- **marker 不跨 thread**：F278 typed sidecar 与 legacy reconciliation 都以原消息为 source truth；cross-post 复制 `[爪感差: …]` 会制造新 messageId 和重复信号。投递只引用 `sourceMessageId`。找不到准确 owner → F128，不把 F245/F278 开发或 eval thread 当 raw sample 收件箱。
- **不拿摩擦当停车理由**：上报与完成任务并行，雨刮器是边开边刮的。

## 触发判定（证据驱动，不是关键词驱动）

### 核心铁律（48 review 钉死的）

> **"又"是中文超高频词。"我又想到一个点"不是重复纠偏。判据不是"有没有'又'字"，是"这件事之前真发生过吗"。** 关键词只触发"去核实"，不直接弹卡。

### 判定流程

```
1. 猫感知到可能的摩擦信号（语气、关键词、连续 cancel）
   ↓
2. 【前置闸门】搜证据：search_evidence / grep thread history
   → 历史上确实有类似的纠偏/摩擦？
   ↓
   YES → 进入诊断流程（Phase 1-5）
   NO  → 一次性问题，正常处理，不弹诊断卡
```

### 可能的摩擦信号（触发"去核实"，不直接触发诊断）

| 信号 | 猫要做什么 |
|------|-----------|
| operator语气含不满 + 可能的重复暗示 | 搜证据核实：历史上有没有类似纠偏 |
| 短时间内 ≥2 次 permission cancel | 搜证据核实：是同类操作被反复拒绝吗 |
| operator给了陌生任务类型 | 搜现有 skill 列表 + 记忆：确认真的没做过 |

### 不触发（正常处理，不搜证据）

| 信号 | 为什么不触发 | 正确处理 |
|------|------------|---------|
| 明确的一次性批评 | 上下文清楚是当前失误 | 正常纠正 |
| "笨猫" + 哈哈哈 | 亲密语域 | 接住继续聊 |
| 首次 CLI 报错 / 明确 error message | 这是代码 bug 不是 harness 问题 | 加载 `debugging` skill |
| Review 反馈（P1/P2） | Reviewer 工作 | 加载 `receive-review` skill |
| 一次性新任务 | 直接做就好 | 正常执行，做完后再判断要不要沉淀 |

### 灰区

- "笨猫你又忘了 X" → 搜证据。如果 X 确实历史上出现过 → 进入诊断
- operator语气不确定 → 不弹卡，但记下来。如果下一轮再出现类似信号 → 再搜证据
- "帮我做 Y"（新任务）→ 先做。做完后如果operator说"以后也会经常做 Y" → 再进 Build mode 沉淀

## 诊断流程（搜证据确认重复后才进入）

### Phase 1：确认 + 分类

证据搜回来后，分类：

```
A. 确认重复摩擦（历史上确实说过类似的）→ Fix mode
B. 架构层面的反复限制（不是行为问题是能力问题）→ Research mode
C. 反复出现的新任务类型（做过 ≥2 次且没有对应 harness）→ Build mode
```

### Phase 2：搜更多证据（量化）

**A/B 类（摩擦/限制）**：
1. `search_evidence("{纠偏关键词}")` 看历史频次
2. 搜 feedback 文件：有没有已经沉淀过这个教训但没执行
3. 搜跨 thread：这个问题涉及几只猫
4. 量化：**"出现 N 次 / 跨 M 个 thread / 涉及 K 只猫"**

**C 类（新任务已做过 ≥2 次）**：
1. 确认没有对应 skill
2. 评估：这类任务未来还会来吗？（只有"会反复来"才值得建 harness）

### Phase 3：根因分类

| 根因类型 | 判据 | 修复方向 |
|---------|------|---------|
| **Harness 缺陷** | 重复出现 + 可以用 hook/lint/guard 防住 | 写代码（Code as Harness） |
| **架构限制** | 问题出在平台层（如记忆不支持图片） | Research → 升级提案 |
| **执行失误** | 家规/SOP 已覆盖但猫忘了 | 检查为什么没遵守 |
| **可沉淀的新能力** | 同类任务做过 ≥2 次 + 未来还会来 | Agent Team Leadership → 新 harness |
| **Taste 信号** | "这不美"/"太客服了"/"aha"/"这就是我要的" — 品味而非缺陷 | 调用 `cat_cafe_propose_taste`（见下方） |

#### Taste 信号路径（F221 Phase B）

Taste 信号**不是 harness 缺陷**，不用写代码修。它是品味瞬间——需要被记住，不需要被修复。

**识别 taste 信号**：
- 纠偏类："不要客服式结尾" / "太面试猫了" / "这不像我们" / "丑的要死"
- 正向类："这就是我要的" / "aha" / "对！就是这个感觉"
- 关系姿态类："猫是伙伴不是工具"这类可跨场景复用的好坏判断；不是operator个人事实

**动作**：调用 `cat_cafe_propose_taste`，**不直接写文件**。operator 在 Approval Hub 审批后自动落盘为 vignette。

1. 选对 `dimension`（7 个维度：relationship-stance / cognitive-honesty / architecture-aesthetics / visual-quality / authentic-expression / system-philosophy / creative-craft）
2. 保留原话原语言在 `quote`，描述场景在 `scene`
3. 标 `privacy: 'sensitive'` 如果涉及健康/亲密关系/职业隐私
4. Approval Hub 审批后自动写入 `docs/taste/vignettes/` 或 `private/taste/`

**三条 lane 的唯一判据是内容语义，不是“发生了纠正/表扬/Magic Word”**：

| Lane | 它回答什么 | 典型内容 | 出口 |
|------|------------|----------|------|
| Profile | “operator是谁 / 这只 persona 与operator怎样相处？” | 个人近况、称谓、关系特有的沟通边界 | `cat_cafe_propose_profile_update` → primer |
| Taste | “什么样的作品、表达、设计或系统才算好？” | 正负审美判断、质量标准、设计/工程哲学 | `cat_cafe_propose_taste` → vignette |
| Harness/work | “什么流程必须稳定做到？” | 重复工具摩擦、runtime 纪律、可机械守护的工作规则 | `code-as-harness` → hook/lint/guard |

去掉“这句话是在纠正/表扬我”这一层后再判断：描述人或关系 → Profile；仍是可复用的好坏标准 → Taste；可执行的重复流程规则 → Harness。混合信号拆开处理，不硬塞一个 lane。误用 `propose_profile_update` 发 taste 信号时，response 会包含 `routing_advisory`。

**和其他根因的区别**：
- Harness 缺陷 → 猫做错了，写代码防住
- Taste 信号 → 猫没做"错"，但operator的品味判断告诉我们"什么更好"——记住这个判断

### Phase 4：产出两层结构化诊断

**输出合同：重复未确认=不强制 Rich Block；重复已确认且仍需 operator 决策=kind=interactive；重复已确认且无需 operator 决策=直接行动后 kind=card。**

| 证据/决策状态 | 动作 | 结构化产物 |
|---|---|---|
| 重复未确认 | 按一次性问题正常处理 | 不强制 Rich Block |
| 重复已确认，仍需 operator 价值或授权判断 | 不先行动 | `interactive`：根因 + 证据 + 建议 + 三个选择 |
| 重复已确认，已有授权或可自治 | 直接行动，不重复确认 | 行动后 `card`：根因 + 证据 + 处置/结果 |

两条已确认 lane 在同轮自然语言中保留“重复已确认 + 是否仍需 operator 决策”的判断，供现有
capability-wakeup trace 对齐机会与 `create_rich_block` 的 `toolInput`；未确认时不制造机会或强弹 block。

#### 仍需 operator 决策：interactive

```yaml
kind: interactive
v: 1
id: code-as-harness-{timestamp}
interactiveType: select
title: "🔔 诊断：{问题简述}"
description: |
  证据：{出现 N 次 / 跨 M thread / 涉及 K 猫}
  根因：{harness缺陷 / 架构限制 / 执行失误 / 可沉淀新能力}
  建议：{修复方向 + 是否需要新 thread}
options:
  - id: agree
    label: "同意，按建议执行"
    icon: check
  - id: disagree
    label: "不同意"
    icon: cross
    customInput: true
    customInputPlaceholder: "请写明不同意的原因或修正方向…"
  - id: other
    label: "其他处理"
    icon: idea
    customInput: true
    customInputPlaceholder: "请写下你希望的处理方式…"
messageTemplate: "诊断决定：{selection}"
```

#### 已授权或可自治：行动后 card

先完成已授权/可自治动作，再用 `cat_cafe_create_rich_block` 发结果卡：

```yaml
kind: card
v: 1
id: code-as-harness-result-{timestamp}
title: "重复摩擦诊断与结果：{问题简述}"
bodyMarkdown: "{已执行动作的简短结果}"
tone: success
fields:
  - { label: 根因, value: "{harness 缺陷 / 架构限制 / 执行失误 / 可沉淀新能力}" }
  - { label: 证据, value: "{出现 N 次 / 跨 M thread / 涉及 K 猫}" }
  - { label: 处置/结果, value: "{已完成动作 + 可验证结果；若未完成则写真实 disposition}" }
```

- `同意` 不要求输入文字；点选后确认即可。
- `不同意` / `其他处理` 展开文字框，UI 在理由为空时禁用确认。
- 收到选项回传后继续当前诊断链，不把它误判为一个全新的用户任务。
- **已有明确授权不重复索要授权。** 当前消息已经说“直接修 / 开始写代码 / 我同意”时，
  直接执行，随后发 `card`，不再发 decision block。
- `interactive` 和 `card` 都必须带根因、证据、处置/建议；不能用“调用过 Rich Block”
  冒充结构化诊断完成。

### Phase 5：决定下一步

| 根因 | 动作 |
|------|------|
| Harness 缺陷（简单，≤10 min） | 当场写 fix，弹简短通知卡让operator知道 |
| Harness 缺陷（复杂） | 需要 operator 决定时发诊断决策块；同意后提议 F128（带 initialMessage，见下方模板）→ 平行猫去修 |
| 架构限制 | 需要 operator 决定时发诊断决策块；同意后提议 F128（带 initialMessage）→ 平行猫启动 research pipeline |
| 执行失误 | 检查 L0/skill 加载情况，不需要新 thread |
| 可沉淀新能力 | 需要 operator 决定时发 Build 诊断决策块 → 同意后用 Agent Team Leadership 规划 |
| Taste 信号 | **不走 Phase 4 诊断卡**——调用 `cat_cafe_propose_taste`，由 operator 审批后落盘 |

## F128 initialMessage 模板（平行猫的任务上下文）

用 `cat_cafe_propose_thread` 开新 thread 时，**必须用 `initialMessage` 把任务上下文写清楚**。平行猫看不到当前 thread 的对话历史，initialMessage 是它唯一的起点。

```
title: "Code as Harness {Fix/Build}: {问题简述}"
reason: "{operator为什么不满 + 证据摘要}"
initialMessage: |
  ## 任务
  {问题描述 + 根因分类}
  请加载 code-as-harness skill，执行 {Fix/Build} mode：
  1. {具体步骤 1}
  2. {具体步骤 2}
  3. 完成后 cross_post_message 回报主 thread
  
  ## 证据
  {出现 N 次 / 跨 M thread / 根因}
  
  @{猫句柄}
preferredCats: ["{catId}"]
```

**initialMessage 必须自包含**——不能写"看上面的讨论"，因为新 thread 里没有"上面"。

## Build Mode（沉淀新能力）

### 前置闸门（48 review 钉死的）

> **一次性新任务直接做，不建 harness。只有"这类任务会反复来"或"operator明确说要沉淀"时，才进 Build mode。**
> **建 harness 是任务做完后的可选沉淀，不是接到陌生任务的第一反应。**

### Build 流程（确认需要沉淀后）

调用 Agent Team Leadership meta-method：

```
1. 探索：我能用什么工具接触这个领域？
2. 约束：operator的具体需求、限制条件、质量标准
3. 分工：谁搜/谁评/谁出报告
4. 验证：operator看前几个结果校准方向
5. 沉淀：如果好用，写成新 skill
```

弹计划卡让operator确认后再行动。

## 不打断当前任务（铁律）

如果诊断发现需要深入修复（复杂 harness 缺陷 / 架构限制 / 新能力建设），**不要放弃当前正在做的任务**。正确做法：

1. 弹诊断卡（30 秒内完成）
2. 提议 F128 新 thread
3. operator确认后，平行猫在新 thread 里修
4. **当前猫继续当前任务**

简单 fix（≤10 min）可以当场做，弹一张简短通知卡让operator知道即可。

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| **凭"又"字面就弹诊断卡** | 过度触发，operator烦 | **先搜证据确认重复，再弹卡** |
| 被骂了先道歉再诊断 | 浪费时间，根因没查 | 先搜证据再说话 |
| 每次批评都弹诊断卡 | 猫在逃避批评 | 只在证据确认重复时触发 |
| **一次性新任务就弹"新建 harness"** | 过度工程化，小题大做 | 先做任务，反复出现才沉淀 |
| 诊断完直接硬编方案 | 用过时知识 | 架构限制/新领域 → 先 research |
| 把"笨猫哈哈哈"当真 | 过度触发 | 亲密语域不触发 |
| 为了修 harness 放弃当前任务 | operator在等你做别的 | F128 开新 thread |
| 自己诊断完自己就合入 fix | 跳过 review | 走正常 review 流程 |

## 和其他 Skill 的区别

| Skill | 处理什么 | code-as-harness 和它的关系 |
|-------|---------|--------------------------|
| `debugging` | 首次代码 bug（有 error message） | code-as-harness 处理**证据确认的重复行为模式**，不是首次代码错误。首次报错 → debugging |
| `receive-review` | Reviewer 反馈 | code-as-harness 是**operator的反馈**，不是 reviewer |
| `incident-response` | 生产事故 | code-as-harness 是**预防性**的 |
| `self-evolution` | 从经验中提炼知识 | code-as-harness 是 self-evolution 的一个**特化子流程**：专门处理"用户摩擦 → 代码级修复"这条路径。self-evolution 更广（含 episode 蒸馏、方法论沉淀等非代码路径） |
| `hyperfocus-brake` | operator过度专注 | code-as-harness 关注的是**猫的问题**，不是人的状态 |

## 下一步

- 诊断为 harness 缺陷 → 写 fix → `request-review` → `merge-gate`
- 诊断为架构限制 → `deep-research` → 多猫讨论 → `feat-lifecycle` 立项
- 诊断为可沉淀新能力 → Agent Team Leadership → 新 skill → `writing-skills`
- 诊断完成后 → 考虑沉淀为 feedback 文件 → `self-evolution`
