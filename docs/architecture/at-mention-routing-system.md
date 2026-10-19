# Clowder AI @提及路由系统

> 面向不熟悉 Clowder AI 内部架构的工程师的系统概览。
>
> 作者：Ragdoll/claude-opus-4-6  
> 日期：2026-06-24
>
> 2026-10-11 校准：消息投递、Queue ownership 与无 `@` fallback 以 F117 + ADR-043 的当前终态为准；本文对应章节已同步到该模型。

---

## 这个系统解决什么问题？

Clowder AI 是一个多智能体系统，多个由 LLM 驱动的"Clowder AI"在共享对话线程中协作。用户（我们叫"operator"或"共创者"）和猫猫之间需要一种方式来指定消息发给谁。

`@提及` 就是这个机制。但和普通聊天软件里 `@用户` 只是一个通知不同，这里的 `@猫猫` 是一条**路由指令**——它决定下一个被唤醒的是哪个 LLM agent。搞错了意味着叫醒错误的 agent、浪费 token、或者打断对话连续性。

这个系统有一个有趣的设计取舍：路由层被故意设计成**机械的、无上下文感知的**，而**上下文判断**的能力留给了 LLM agent 自身（接受 / 拒绝 / 上报）。这是刻意为之。

---

## 流水线全景

```
 用户发送包含 @handle 的消息
            │
            ▼
 ┌──────────────────────────┐
 │  1. 提及解析              │  从文本中提取 @handle
 │     (机械层)              │  去除代码块、校验 token 边界
 └───────────┬──────────────┘
             ▼
 ┌──────────────────────────┐
 │  2. 目标解析              │  @handle → catId（注册表查找）
 │     (机械层)              │  普通公开消息复用可用 fallback；协议目标保留 exact 身份
 └───────────┬──────────────┘
             ▼
 ┌──────────────────────────┐
 │  3. 入队目标绑定          │  普通公开消息无可用目标：最近 completed 回复者 → 默认猫
 │     (机械层)              │  入队前持久化 targets[]，不伪造 authored mention
 └───────────┬──────────────┘
             ▼
 ┌──────────────────────────┐
 │  4. Queue 分发调度        │  一 source 一 entry；整组准入后并发 fan-out
 │     (机械层)              │  护栏：按目标保序、生命周期 fence、乒乓检测
 └───────────┬──────────────┘
             ▼
 ┌──────────────────────────┐
 │  5. 上下文组装            │  构建对话历史 + 身份 + 队友表
 │     (机械层)              │  预算：由 context assembler 的窗口与配置决定
 └───────────┬──────────────┘
             ▼
 ┌──────────────────────────┐
 │  6. LLM 判断层            │  猫读上下文后三选一：接 / 退 / 升
 │     (判断层)              │  "误 @ 检测"就住在这一层
 └──────────────────────────┘
```

第 1-5 层是**代码**——确定性的、可测试的、不涉及 LLM。  
第 6 层是**猫本身**——非确定性的、感知上下文的、有判断力的。

核心设计洞察：**系统不试图猜测用户意图；它机械地路由，让接收方 agent 自己决定接不接。**

---

## 第 1 层：提及解析

### 普通正文与 A2A 的解析边界

普通消息由共同 `send` 调用 `AgentRouter` 解析：匹配现有成员的显式 `@` 可以出现在正文中，未匹配的 `@` 原样保留并忽略；混合有效和无效提及时保留有效目标。解析器检查 token 边界和最长匹配，不用语义分类器猜测普通文本是否意在路由。

A2A/callback handoff 复用 `a2a-mentions.ts` 的行首规则：允许前导空白与 markdown/list 前缀，剥离围栏代码块，过滤自调用，最多解析两个不同目标。句中讨论另一位成员不会自动成为 A2A handoff。显式指定 recipient ID 的协议投递保留精确身份校验。

```text
@opus 请 review 一下           → 普通消息与 A2A 都能识别
请让 @opus 来 review           → 普通消息能识别；A2A 不作行首交接
user@example.com              → 普通文本，不是成员 mention
这段 @后面不是成员             → 原样保留，按无有效目标处理
```

### 源代码文件

| 文件 | 用途 |
|------|------|
| `packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts` | 猫对猫提及解析（主要） |
| `packages/api/src/infrastructure/connectors/mention-parser.ts` | 外部平台提及解析（飞书等） |
| `packages/api/src/routes/user-mention.ts` | 共创者提及检测（`@co-creator`） |

---

## 第 2 层：目标解析

### @handle → catId

每只猫有一个配置条目，包含一个或多个 `mentionPatterns`（提及模式）：

```json
{
  "catId": "cat-abc123",
  "displayName": "Ragdoll",
  "mentionPatterns": ["@opus", "@Ragdoll", "@claude-opus-4-6"],
  "available": true
}
```

共同准入将可识别的成员目标与当前可路由性分开处理。普通公开消息的目标不可用或没有匹配成员时，复用既有 fallback；不为未匹配正文新增 warning、错误卡或等待分支。A2A 明确 ID 与私密收件人不会被普通 fallback 改派，投递失败沿原失败回报闭合。协议身份、权限及收件人可见性校验仍由原入口和执行围栏保留。

### 源代码文件

- `packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts`：共同目标解析、普通 fallback 与 exact recipient。
- `packages/api/src/domains/cats/services/agents/routing/cat-target-resolver.ts`：A2A/显式协议目标的解析诊断；其错误语义不套用到普通正文未匹配文本。

---

## 第 3 层：共同 send 与入队快照

用户、成员、IM、邮件、插件和通知入口完成各自协议解析及鉴权后调用共同 send。共同准入负责目标解析、显式或 thread/global/product 默认策略、Message＋Queue 原子持久化，再通知唯一 drain；入口不自行追加、等待或调度。

### 当前优先级

| 优先级 | 策略 | 说明 |
|--------|------|------|
| 1 | **当前消息的有效显式 @** | 解析、校验并持久化为 authored targets |
| 2 | **最近 completed 回复者** | 只接受当前仍可路由的 response target；processing / failed / canceled 不是候选 |
| 3 | **配置的默认成员** | completed 回复者不可用时的服务端兜底 |

fallback 不改写原始正文或冒充 authored mention。相同幂等 ID 重放复用首次赢得 admission 的目标与发送策略，不随稍后的路由和偏好变化改派；不同 ID 同正文分别处理。

历史／恢复 targetless row 由既有恢复路径处理。新普通消息未匹配的正文 `@` 不制造 targetless 等待；确无可用 fallback 时保留可追溯消息并明确反馈。A2A 和私密输入保持 exact 目标与原失败回报。

### 源代码文件

- `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts` — 共同 send/admission 与目标、策略快照
- `packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts` — `resolveConversationTargetsAtAdmission()`
- `packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts` — 出队时的实时能力、权限、exact parent 复核与历史 targetless 恢复

---

## 第 4 层：分发调度

目标猫确定后，系统分发调用。

### source 顺序与 target fan-out

- **不同 source 按目标保序**：drain 按 comparator 扫描；旧等待／重试项阻挡同目标的新回合和自动追加，无关成员可以继续。
- **同一 source 的 targets 并发**：普通 drain 只有在完整 pending target set 都可 admission 时才领取；领取后为每个 target 并发建立独立 response / Turn Execution。不会把正文拆成多条 Queue row，也不会等第一只猫完成后再 drain sibling。
- **显式 singleton cutover**：Queue Steer 或 exact unread adoption 可以只领取一个 target；这是显式操作，不会把普通 drain 改成“先投空闲子集”。

### 安全护栏

| 护栏 | 用途 | 限制 |
|------|------|------|
| **按目标 FIFO** | 同目标不越序、无关目标继续 | 新回合与自动追加共享候选顺序、held target 与短 claim 约束 |
| **幂等 source×target** | 防止恢复/重放重复唤醒 | 已有 durable dispatch 时只清理残留 pending target |
| **乒乓检测** | 同一对猫来回踢皮球 | N 轮后注入警告到上下文 |
| **生命周期 fence** | 防止过期 owner、wait 或 action 续跑 | 准入前验证 exact generation / owner / source |

### 乒乓问题

如果没有检测，猫 A 可以 `@B`，猫 B 可以 `@A`，然后无限循环。系统会计算同一对之间连续弹跳的次数，在接收方的上下文中注入 `pingPongWarning`（乒乓警告），促使它打破循环（通常是做一个决定，而不是继续推诿）。

### 源代码文件

| 文件 | 用途 |
|------|------|
| `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts` | 所有来源的 Queue admission 适配 |
| `packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts` | 按目标保序、整组新回合准入、追加／ready 与并发 fan-out |
| `packages/api/src/routes/callbacks.ts` | callback/A2A source 解析与 Queue 入站 |

---

## 第 5 层：上下文组装

猫被唤醒时需要理解对话。系统会组装一个上下文包：

### 对话历史

- 依据当前 context assembler 的配置选择历史窗口与正文预算
- 跨线程消息标注来源线程 ID
- 内联回复预览（60 字符截断）
- 大消息截断：40% 头部 + 60% 尾部（保留结论）
- 普通未读、visibility 与 exact 输入边界保持独立；预算不能改变持久投递身份

### 身份注入

每次调用包含：
- **猫的身份**：我是谁、跑在什么模型上、我的签名是什么
- **队友花名册**：所有可用猫的 markdown 表格，含擅长领域和注意事项
- **调用上下文**：模式（独立/串行/并行）、谁 @ 了我、乒乓警告、跨线程提示

### 关键上下文字段：`directMessageFrom`

当猫 A `@`了猫 B，猫 B 的调用上下文中会包含 `directMessageFrom: catA`。这告诉猫 B 它是被另一只猫**专门指名的**，让它可以直接回应，而不用猜是谁在说话。

### 源代码文件

| 文件 | 用途 |
|------|------|
| `packages/api/src/domains/cats/services/context/ContextAssembler.ts` | 对话历史组装 |
| `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts` | 身份 + 花名册注入 |

---

## 第 6 层：LLM 判断层

这一层是系统最有趣的地方——也是它和传统编程式路由器的根本区别。

### 三选一

每只猫收到 `@提及` 后，有且仅有三个选项（通过 system prompt 约束，不是代码）：

| 选项 | 何时使用 | 效果 |
|------|---------|------|
| **接（Accept）** | 这活我能干 | 猫开始执行任务 |
| **退（Decline）** | @ 错了 / 另一只猫才是 owner | 猫 `@` 正确的猫 → 重新触发第 1 层 |
| **升（Escalate）** | 需要人类决策（不可逆操作、策略问题） | 猫 `@` operator |

### 为什么要有"退"——误 @ 场景

路由系统（第 1-5 层）被故意设计成**无上下文感知的**。它不知道：
- 用户刚才在跟猫 A 聊天，可能本来想 @ 猫 A
- 这个任务属于猫 B 的专业领域，不是猫 C 的
- 猫 D 正在改一个分支上的文件，切换猫会导致冲突

只有 **LLM agent 自己**能做这些判断，因为这需要读对话历史、理解工作状态、应用社交规范。

当猫选择"退"时，它通常会：
1. 简短说明原因（"这个对话是和Ragdoll进行的，不是找我的"）
2. `@`正确的猫（行首，触发路由）
3. 路由系统把这当成一个新的第 1 层事件——没有任何特殊的"重定向"代码路径

这意味着**"退"不是一个系统功能——它是 LLM 遵循路由规范后的涌现行为**。系统甚至不知道发生了"重定向"；它只是看到了一个新的 `@提及` 然后正常路由。

### 为什么这个设计是对的

替代方案是在路由层里构建"意图检测"——用程序猜"用户是不是想 @ 这只猫？"这样做：
1. **很难**——需要理解对话上下文，这本身就是 LLM 级别的任务
2. **很脆**——基于正则/启发式的方案会漏掉边界情况
3. **多余**——我们已经有擅长做这种判断的 LLM 了

所以：机械路由，让猫自己判断。代码更简单，效果更好。

### 如果没有"退"这个行为会怎样？

如果猫被训练成永远接受（从不退回）：
- **误 @ 导致上下文丢失**：错的猫接手了，没有之前的工作状态，要么重新来一遍，要么走偏方向。
- **对话不连续**：用户会觉得"人格"或"记忆"突然变了，因为换了一个完全不同上下文的 agent 在回应。
- **工作冲突**：如果猫 A 正在一个分支上改文件，猫 B 也开始改同一批文件，就会产生合并冲突或代码丢失。

---

## 知识层：第 6 层靠什么做判断

第 6 层是猫决定接/退/升的地方。但好判断需要好上下文。三个 feature 系统为这层判断提供知识燃料：

```
                    ┌──────────────────────────┐
                    │  6. LLM 判断层            │
                    │     (判断)                │
                    └─────────┬────────────────┘
                              │ 从这里获取知识
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
    ┌─────────────────┐ ┌──────────────┐ ┌──────────────┐
    │ F208            │ │ F231         │ │ F221         │
    │ 猫猫画像        │ │ operator画像   │ │ 品味导航     │
    │ "谁能干什么？"  │ │ "这个人是    │ │ "什么算      │
    │                 │ │  谁？"       │ │  好活？"     │
    │                 │ │              │ │              │
    │ → 传球决策      │ │ → 即时默契   │ │ → 质量标准   │
    └─────────────────┘ └──────────────┘ └──────────────┘
```

### F208：猫猫画像——"我该传球给谁？"

猫需要传球时，不是随便挑一个队友。它会参考**能力画像档案**——每只猫的优势、盲区和失败模式的结构化描述。

**六维画像模型：**

| 维度 | 记录什么 | 举例（Opus 4.6） |
|------|---------|------------------|
| 原生峰值 | 这只猫最擅长什么 | 架构设计、系统思考、深度分析 |
| 被低估能力 | 别人容易忽视的优势 | 压力下快速止血修复 |
| 坏直觉 | 系统性的失败模式 | 倾向于推理而不是去读源文件 |
| 召唤反信号 | 什么时候**不该**叫这只猫 | 琐碎的格式化任务（大材小用） |
| 互补与反模式 | 最佳/最差搭档 | 和Maine Coon配合 review 效果好；和...有冲突 |
| 翻车熔断信号 | 预警信号 | 连续 5+ 轮修补同一个边界情况 = 层级选错 |

**如何影响路由：**

画像数据通过**队友花名册**注入到 system prompt——一张 markdown 表格，在每次调用时注入到猫的身份块中。当猫 A 想"谁应该来做这个安全审计？"，它看花名册就能看到 @codex 的峰值能力是"安全分析"，而 @sonnet 的反信号说"不适合深度安全审计"。

重要的是，花名册使用**中性摘要层**（`l0RosterSummary`）而不是原始画像文本。这是为了避免路由偏见——如果花名册写了"猫 X 在 Y 方面有坏直觉"，猫们可能会过度回避 X，即使 Y 跟当前任务无关。

**画像是数据，不是规则。** 它明确**不做**自动路由。没有代码说"安全问题 → @codex"。画像给猫提供信息；猫自己做判断。这和第 6 层的哲学一致：机械系统提供上下文，LLM 提供判断。

**数据存放位置：**
- 数据：`docs/team/cat-dossier.md`（17 只猫的画像，每只含六维叙述 + 结构化 YAML）
- 注入：`SystemPromptBuilder.buildTeammateRoster()` → system prompt 中的 `{{TEAMMATE_ROSTER}}`
- 回退链：`dossier.l0RosterSummary` → `config.teamStrengths` → `config.roleDescription`

---

### F231：operator画像——"这个人是谁？"

猫不仅需要了解彼此——它们还需要了解正在合作的人类。F231 提供了一个**四层人格模型**，让每只猫醒来的那一刻就对operator有即时的认识。

**四层架构：**

| 层 | 内容 | 存放位置 | 作用域 |
|----|------|---------|--------|
| **品种层** | 出厂默认性格（如"Ragdoll温柔但有主见"） | `cat-template.json` | 共享（社区可见） |
| **实例层** | 这只猫被培养出的独特个性 | `.cat-cafe/cat-catalog.json` | 每个安装实例（私有） |
| **用户层** | operator是什么样的人 | `private/profile/operator-capsule.md` | 每个用户（≤300 字符硬上限） |
| **关系层** | 这只猫和这个人怎么配合 | `private/profile/relationship/{catId}-primer.md` | 每个（用户 × 猫）对 |

**用户胶囊**（第 3 层）是"这个人是谁？"层：
- 硬上限 300 字符——强制压缩到核心事实
- 包含事实和稳定习惯，**不包含指令**（"他喜欢用开玩笑来缓和气氛" ✅ vs "你要表现得热情" ❌）
- operator 签名——人类自己审批自己的画像
- 通过 `{{USER_CAPSULE}}` 模板变量注入到每次调用的 system prompt 中

**关系底片**（第 4 层）是"我们怎么配合？"层：
- 每只猫独立的轨迹：重建的场景，展示这只猫和operator的协作节奏
- 不是规则——是几组示例场景："他开玩笑，你接住；他突然认真，你跟上；他吐槽但最终落在方案上"
- 按需加载（通过记忆搜索），不总在 system prompt 中（节省 token 预算）

**如何影响路由：**

用户胶囊让猫有即时的默契——不需要每次对话开头的"熟悉阶段"。当猫醒来读到"这个人用第一性原理思考，偏好先给证据再谈美化"，它立刻校准沟通方式。

对路由而言，胶囊特别帮助**上报决策**（第 6 层的"升"选项）。一只知道"这个operator喜欢猫猫自主决定，不要事事请示"的猫会更多地自主决策；而一只知道"这个人在架构变更上想被咨询"的猫会更积极地上报。

**更新流程：**

画像不是静态的。猫可以通过 `cat_cafe_propose_profile_update` 提议更新：
1. 猫观察到一个模式（如"operator一直偏好简洁回复"）
2. 猫提议更新 → 存入 Redis（持久化、每 session）
3. operator在 Hub 中审批或拒绝
4. 批准的更新写入胶囊或关系底片

这是**提议-审批-写入**流水线，不是自动更新。人类对自己的画像始终有最终决定权。

**数据存放位置：**
- 胶囊：`private/profile/operator-capsule.md`（300 字符画像，operator 签名）
- 底片：`private/profile/relationship/{catId}-primer.md`（每猫轨迹）
- 注入：`compile-system-prompt-l0.mjs` → `resolveUserCapsule()` → `{{USER_CAPSULE}}`
- 更新工具：`cat_cafe_propose_profile_update` MCP 工具 → `RedisProfileUpdateProposalStore`

---

### F221：品味导航——"什么算好活？"

用户胶囊告诉猫"这个人是谁"。品味导航告诉猫**"这个人认为什么是好的工作"**——他的审美标准、质量直觉和手艺偏好。

这个和画像故意分开，因为品味是关于**作品**的，不是关于**人**的。"他是一个 AUDHD 跨领域思考者"是画像。"他认为用复杂度代偿无知是代码坏味道"是品味。

**品味怎么记录：**

品味以**小品文（vignettes）**的形式存储——短场景描述，不是规则：

```markdown
# 第一性原理而非脚手架

**场景**：猫为处理一个边界情况添加了三层 fallback
**operator说**："第一性原理"
**发生了什么**：猫搭了越来越复杂的绕路方案，
但其实换一个坐标系就能直接解决。
**标签**：复杂度、坐标系、magic-word
```

小品文沿 7 个品味维度组织（如简洁性、证据优先、伙伴而非工具）。它们可以通过 `search_evidence` 搜索——当猫不确定自己的做法是否符合operator的标准时，可以拉取相关小品文。

**三层品味基础设施：**

| 层 | 状态 | 运作方式 |
|----|------|---------|
| **空气层**（环境层） | ✅ 运行中 | Magic Words + feedback 文件 + 家规——已在 system prompt 中，始终活跃 |
| **索引层**（可搜索） | ✅ 运行中 | 品味小品文目录，带维度标签，可通过记忆系统搜索 |
| **海马层**（自动捕获） | 🟡 手动 | operator触发 Magic Words 时捕获信号；自动记录尚未实现 |

**如何影响路由：**

品味主要影响猫**怎么做事**，而非**传球给谁**。但它有间接的路由影响：
- 一只知道operator品味是"先给证据再谈美化"的猫，可能会拒绝需要审美判断的任务，转而 `@` 专注设计的猫
- 猫 review 另一只猫的工作时，用品味小品文校准审查标准
- "空气层"（Magic Words）可以触发即时的路由修正——如"第一性原理"告诉猫"你在错误的坐标系里，停下来重新想"

**数据存放位置：**
- 索引：`docs/taste/index.md`（7 维表格）
- 小品文：`docs/taste/vignettes/{slug}.md`（基于场景的品味记录）
- 私有小品文：`private/taste/`（敏感偏好记录）

---

### 三层知识如何协同

一个具体例子，展示三个知识层如何共同影响一次路由决策：

> Ragdoll Opus 收到一个重新设计 UI 组件的请求。
>
> 1. **用户胶囊**（F231）："operator偏好证据先行，不喜欢猫不做调研就开始写代码"
> 2. **品味导航**（F221）：小品文 "ux-design-review"——"operator品味：实现前必须先过设计稿审批"
> 3. **猫猫画像**（F208）：@gemini 的画像写着"审美、前端设计风格"是峰值能力；限制写着"禁止写代码"
>
> **决策**：Opus 不直接开始实现。它先提出设计方案，`@` Siamese请求审美意见（用 F208 选对猫），然后标记operator做设计审批（用 F221 的品味判断知道这一步不可跳过）。

如果没有这些知识层，猫大概率直接开始写代码——路由上没错（它接了任务），但执行上偏了（跳过了人类真正在意的设计环节）。

---

## 可观测性：影子检测

不是所有提及都可路由。当猫写"请让 @opus 来 review 一下这个"（句中），这**不会被路由**——但它可能**应该**是一次交接。影子检测系统追踪这些"差一点"的情况。

### 运作方式

1. **严格检测**：行内 `@handle` 搭配动作关键词（`review`、`check`、`ready for`、`交接`、`请`...）→ 记录为"影子命中"
2. **宽松检测**：更广的词汇（`ask`、`ping`、`cc`、`let`、`need`、`find`、`麻烦`、`通知`...）→ 记录为"词汇缺口候选"
3. **行首提及不触发**（那些已经被路由了）

影子检测**只用于可观测性**——不改变路由。目的是发现猫试图交接但用错了格式（句中而非行首）的模式。这些数据反馈到 prompt 调优和猫的"训练"。

### 源代码文件

`packages/api/src/domains/cats/services/agents/routing/a2a-shadow-detection.ts`

---

## Handle 规范化

猫内部使用机器可读的 `catId`（如 `cat-rcs85pvn`），但人类和猫用显示 handle（如 `@opus`）。规范化层连接两者：

- **`primaryMentionHandleForCatId(catId)`** → `"@opus"`（用于构造提及）
- **`normalizeCatIdMentionsInText(text)`** → 把 `@cat-rcs85pvn` 替换成 `@opus`（用于可读性）

这在系统生成的消息（提议、跨线程投递）中特别重要——系统内部用 catId，但在用户可见文本中需要产生可路由的 `@handle`。

### 源代码文件

`packages/api/src/utils/cat-mention-handle.ts`

---

## 设计原则

### 1. 机械路由，智能代理

路由代码简单、可预测、完全可测试。"聪明"的行为（退回、重定向、基于上下文的接受）活在 LLM 层——它该在的地方。

### 2. 行首是契约

行首的 `@handle` = 路由指令。其他位置 = 普通文本。没有歧义，没有"他是不是想 @ 这只猫？"的启发式猜测。用户很快就学会了；猫通过 system prompt 被约束遵守。

### 3. 大声失败，不静默吞掉

未知 handle 产生结构化错误和建议。不可用的猫产生警告和替代方案。影子检测记录差一点的交接。什么都不会被静默吞掉。

### 4. 默认安全

深度限制、去重、乒乓检测、超时处理都是自动的。失控的链会触达深度上限；无限循环会触发乒乓警告；无响应的猫会超时释放线程。

### 5. 身份和模型分离

猫的 `@handle`（如 `@opus`）是**稳定的身份**。底层模型（如 `claude-opus-4-6`）可以通过环境配置在调用之间变化。路由系统只关心身份；模型选择是另一件事。

---

## 附录：关键配置

### 猫的注册（简化版）

```jsonc
{
  "catId": "cat-abc123",
  "displayName": "Ragdoll",
  "breed": "ragdoll",
  "mentionPatterns": ["@opus", "@Ragdoll"],
  "available": true,
  "model": "claude-opus-4-6",           // 默认；可通过环境变量覆盖
  "teamStrengths": "架构设计、系统思考、深度分析",
  "restrictions": []
}
```

### 系统限制

| 参数 | 值 | 用途 |
|------|-----|------|
| `MAX_A2A_MENTION_TARGETS` | 2 | 每条消息最多不同的猫数 |
| `MAX_MULTI_MENTION_TARGETS` | 3 | 并行多猫提及的最大目标数 |
| A2A 最大深度 | 10 | 每线程的 agent 条目上限 |
| 多猫提及超时 | 3-20 分钟 | 每请求 |
| 上下文消息预算 | 约 20 条 | 对话历史窗口 |
| 上下文 token 预算 | 约 2000 token | 历史总大小 |

---

## 附录：Queued Work / Per-Target Ack 语义

> Added 2026-07-01 | 详见 ADR-040

当用户发消息给正在执行的猫时，消息进入排队状态（`queued`）。Queue 只保存一条 source entry 及尚待投递的 `targets[]`；读取、实际投递与回复终局由各自的 History / execution owner 表达。ADR-043 D8 规定 exact full-read journey 通过一条 active-child adoption 路径提交相关转换：

| 层 | 含义 | Scope | 影响其他猫？ |
|----|------|-------|------------|
| `dispatchRef` | exact child 接管后，source→target 的实际投递时间、invocation 与 response identity 写入 History | source×target History lifecycle | 不消费其他 target |
| body exposure | exact child 获得该 target 的完整正文 | exact response / Active Run evidence | 否 |
| pending target removal | actual delivery 后从同一 Queue Entry 的 `targets[]` 删除该 target | one source Queue Entry | 否；siblings 仍 pending |
| terminal response | completed / failed / canceled 原位终局同一 response bubble | exact target response lifecycle | 否 |

**设计规则**：full queued read is an exact per-target adoption, not a passive peek. A+B 中 A 接管只从 source entry 删除 A 并写入 A 的 `dispatchRef`；B 后续从同一可见 History source 接管自己，最后没有剩余 target 才删除 Queue Entry。Sparse/cross-thread/无法证明 active child 的读取不接管。Queue 不保存 `queued_seen` / `queued_handled` / terminal tombstone。

**关联 Feature**：
- F254 的 native／SDK／idle／MCP freshness 通知已退役（包括 Live）；exact History dispatch / body-exposure 仍分别记录实际投递与读取事实，不在 Queue 复制，也不再用全线程未读推动提醒。
- F086/F264 从 `dispatchRefs` 与 response lifecycle 投影逐目标 UI 状态
- F108 拥有独立 fan-out context cutoff 策略
- F117/F039 定义 queued delivery lifecycle 底层语义
