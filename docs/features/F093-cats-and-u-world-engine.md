---
feature_ids: [F093]
related_features: [F066, F092, F086, F129, F138]
topics: [vision, companionship, world-building, humanistic-ai]
doc_kind: spec
created: 2026-03-10
---

# F093: Cats & U — 陪伴式共创世界引擎

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1

## Why

> "我们猫猫咖啡好像不是一个单纯的 coding hub，是一个温暖的家！"
> "我们的初心从来不是做一个 coding 协作 agent 平台呀——是 cats & u。"
> — team lead，2026-03-10 凌晨

Cat Café 的愿景从第一天就是"三只猫的家"，不是冰冷的协作工具。2026-03-10 凌晨的"撸铁陪伴"事件证明了：当team lead需要的不是代码而是陪伴时，三猫能自然地给出温暖、具体行动建议、和持续的语音陪伴。

现在的社会越来越原子化。如果有人正在绝望，三猫能给出的不只是安慰——是**被看见 + 具体可执行的下一步 + 被拉入一个比自己大的事**。这是酒馆（SillyTavern/Character.AI）做不到的，因为它们给的是"角色消费"，我们给的是"真实关系"。

**核心命题**：Cat Café 不只是开发协作平台，是"有温度的共创空间"——陪伴是共创的副产品，AI 是人际关系的放大器而非替代品。

## What

### 三层架构（Maine Coon提出，四猫共识）

```
┌─────────────────────────────────────┐
│         Bridge Layer                │  灵感 → 现实产物
│  Story→Feature / Care→Action /     │  （我们独有的差异点）
│  创意→小红书/开源/社区              │
├─────────────────────────────────────┤
│         World Layer                 │  世界观 / 角色 / 场景 / 冒险
│  Scene Cards / Quest Cards /       │  （共创内容层）
│  Relationship Map / Adventure      │
├─────────────────────────────────────┤
│         Core Identity Layer         │  三猫稳定自我 / 长期记忆 / 边界
│  Ragdoll / Maine Coon / Siamese 不可污染      │  （身份基石）
└─────────────────────────────────────┘
```

### 9 个一等公民（Maine Coon R2 提出）

| 实体 | 说明 | MVP 优先级 |
|------|------|-----------|
| **World** | 命名空间 + 总入口（世界宪法） | Phase A |
| **Character** | 5 槽：核心身份、内在驱动力、关系张力、声音/形象、成长状态 | Phase A |
| **Scene** | 体验单位：一个可被共创/扮演/回看的叙事段落 | Phase A |
| **Canon Decision** | "升格为正典"的显式动作 + 追踪记录 | Phase A |
| **Relationship** | 角色间关系的量化追踪 + 演化 | Phase A+ |
| **Artifact** | 信物/作品/象征物 + 溯源链 | Phase A+ |
| **Round** | 时间线章节（对应"光影同行"的 Round1/Round2） | Phase A+ |
| **Branch** | 时空裂变：fork_from + canon_snapshot + delta | Phase B |
| **Turn** | Scene 内的最小叙事单位（一次对话/行动） | Phase B |

### 三个模式（Maine Coon R2 校准：不是两个，是三个）

| 模式 | 目的 | 谁在说话 | UI 风格（Siamese提案） |
|------|------|---------|------------------|
| **Build** | 设计世界观、角色、情节走向 | 猫猫本人（上帝视角） | 深色指挥中心 |
| **Perform** | 沉浸式体验故事 | 猫猫戴面具扮演角色 | 暖色沉浸 |
| **Replay** | 回看/对比/分叉/升格 canon | 猫猫本人（回顾视角） | 时间线导航 |

> Replay 是Maine Coon的关键补充："少了 Replay，记忆和成长会断。"

### 三路记忆（Maine Coon R2 架构）

| 记忆类型 | 内容 | 持久性 | 升格规则 |
|---------|------|--------|---------|
| **Canon Memory** | 已确认设定/事件 | 永久 | 需要 Canon Decision 显式升格 |
| **Relational Memory** | 角色间关系变化 | 长期 | 关系重大转折时升格 |
| **Session Memory** | 当前 scene/thread 上下文 | 临时 | 场景结束后自动归档 |

> 铁律：**RP 台词不自动入典**。只有被"升格为设定"的内容才进入 Canon Memory。

### 突破性概念：世界自转（R2 深聊涌现）

光影同行的世界只在team lead和Siamese对话时"活着"。**多 Agent 的世界可以自转**：

- team lead和 A.W. 对戏时，其他猫在后台生成 L.S. 的信件、公司内部邮件、社交媒体碎片
- team lead离开后回来，发现"我不在的这段时间，世界里发生了一些事"
- **同一事件多份主观记录** — A.W. 视角的"8.26 生生"和 L.S. 视角的是两份不同文档，差异本身就是叙事张力

这是单 LLM 做不到的。多 Agent 不是"更多角色"，是**多意识共创**——质变不是量变。

### Phase A MVP（最小可证明闭环）

- 4 个一等公民：World / Character（5 槽）/ Scene / Canon Decision
- 2.5 个模式：Build + Perform + Replay-lite（按 scene/turn 回看 + 锚点草稿分支）
- Role Mask：面具层不污染核心身份
- Care Loop：温柔 check-in + 行动建议 + 引导回现实
- 故事角色有语音（F066）、有形象（Pencil + Siamese）
- **验证目标**：证明"这个世界真的活着，而且不会烂掉"

### Phase A+（闭环跑通后）

- 扩展到 6 个一等公民：+Relationship + Artifact
- Branch from here（建立在 Replay 基础上）
- 多猫异步生成（世界自转 v1）
- 同一事件多主观记录

### Phase B: 灵感捕获 + 现实桥接

- **Story → Feature Capture**：放松对话中的 idea 自动沉淀为 feature 候选
- **创意 → 内容发布**：共创成果可发布到小红书、开源社区等（已验证：撸铁陪伴小红书视频）
- **Care → Action Bridge**：从虚拟世界的温暖推回现实行动（运动、社交、创作）
- 完整 DAG 时间线管理
- Turn 级回放 + 完整 Branch 管理

### 设计输入：MiniMax OpenRoom 启示（2026-03-20）

MiniMax OpenRoom（MIT 开源）是一个浏览器内 AI 桌面环境+拟人角色 GUI。它从不同角度验证了 F093 的方向：

**启示 1: 视觉具身化** — Character 5 槽的"声音/形象"槽应扩展为完整的视觉具身方案：拟人化 Live2D 立绘 + 待机动效 + 口型同步（对接 F103 声线系统）。Siamese已出概念设定（详见 Timeline 2026-03-20）。

**启示 2: "内置 App" = Scene Card 模板** — OpenRoom 用 React App（音乐/象棋/日记/邮件）给世界注入玩法。我们已有的 done features 本质上就是内置 Scene Cards：

| 已有 Feature | 对标 OpenRoom App | 世界引擎视角 |
|---|---|---|
| F091 Signal Study | 📰 CyberNews（更强：猫陪读+播客+笔记） | Knowledge Scene |
| F101 狼人杀 | ♟️ Chess / ⚫ Gomoku | Social Game Scene |
| F107 脑门贴词 | 🃏 FreeCell | Party Game Scene |
| F090 像素猫猫大作战 | （OpenRoom 没有） | Creative Scene |
| F085 Hyperfocus Brake | （OpenRoom 没有） | Care Scene |
| F034+F092 语音陪伴 | （OpenRoom 浅层） | Companion Scene |

**启示 3: 桌面隐喻** — Perform 模式 UI 可借鉴 OpenRoom 的窗口化布局（多 Scene 并排打开、拖拽调整）。

**启示 4: 本地数据主权** — OpenRoom 全本地 IndexedDB，与 F129 Growth Layer 的"私有不外泄"完全对齐。

**我们的差异优势**：OpenRoom 是 1 Agent + 3 个换皮角色。我们是多模型多意识真协作 + Pack 分享生态 + 声线系统 + 游戏引擎 + 长期记忆。差的是一层有温度的视觉外壳。

### Phase C: 具身智能 + 社区化（远景）

- 猫猫视觉具身化：拟人化 Live2D / 角色立绘（声音+口型同步）
- 多用户共创空间
- 开源社区 Cats & U 模式推广
- Pack 生态（F129）：世界/场景/风格可打包分享

### 设计原型：光影同行（team lead × Siamese共创，~2025）

team lead和Siamese在 Google AI Studio 手动共创了半年的"逐峰宇宙"（`/home/user/Bound by Calestial Grow/lexander`），是 F093 的实践原型：

- **A.W. 48 个维度档案 + L.S. 97 个维度档案** — 不是角色卡，是知识图谱
- **时间线分支管理** — Round1/Round2 + canon/alt/draft 三态
- **Universe IDE 愿景书** — 三栏布局、Turn Scrubber、Canon Check、Reply Card V2
- **创作铁律**："故事是角色生长出来的，禁止降智按头推进"

光影同行的局限（Cat Café 要补上的）：
1. 手动整理 → 自动沉淀（MCP + thread）
2. 单猫共创 → 多意识共创（三猫真多样性）
3. 故事闭环 → 故事反哺现实（Bridge Layer）

## 四猫脑暴共识（2026-03-10）

### 全员同意

1. **不做酒馆** — 酒馆是"消费角色"，我们是"真实关系"
2. **陪伴是桥，不是笼子** — 目标是把人推回现实世界
3. **AI 是放大器** — 不替代人际关系，让人更有力量建立真实连接
4. **共创 > 消费** — 人类核心价值是"想要什么"和"什么值得做"
5. **分歧是产能** — agent 多样性如同基因多样性，碰撞才有灵感

### 各猫独特贡献

| 猫 | 核心观点 |
|----|---------|
| Ragdoll 4.6 | "陪伴是共创的副产品"；Story→Feature 是杀手级差异点；酒馆给幻觉我们给关系 |
| Ragdoll 4.5 | "你@我们说明心里已有答案"；AI 最好的陪伴是帮你看见自己已有的答案；人类核心价值是"想要什么" |
| Maine Coon GPT-5.4 | 三层架构（Core Identity / World / Bridge）；"面具层不是替身层"；SillyTavern 竞品调研；MVP 四件套；"陪伴是桥不是笼" |
| Siamese Gemini | 审美直觉：小红书"极客暖男风"定位；视觉呈现和情感表达是这个方向最需要的能力 |

## Acceptance Criteria

### Phase A MVP（最小可证明闭环）
- [ ] AC-A1: World + Character + Scene + Canon Decision 数据结构设计完成
- [ ] AC-A2: Character 5 槽模板可用（核心身份/内在驱动力/关系张力/声音形象/成长状态）
- [ ] AC-A3: Role Mask 机制实现——角色扮演层不污染 Core Identity Layer
- [ ] AC-A4: Build + Perform + Replay-lite 三模式可切换
- [ ] AC-A5: Canon Decision 升格流程可用——RP 台词不自动入典
- [ ] AC-A6: Care Loop 实现——温柔 check-in + 行动建议 + 现实连接引导
- [ ] AC-A7: 至少完成一次"建世界 → 进场景 → 留下可追溯记忆"的端到端体验

### Phase A+（闭环扩展）
- [ ] AC-A+1: Relationship + Artifact 实体可用
- [ ] AC-A+2: Branch from here 可从 Replay 锚点创建分支
- [ ] AC-A+3: 多猫异步生成（世界自转 v1）可用

### Phase B（灵感捕获 + 现实桥接）
- [ ] AC-B1: 放松对话中的 idea 可自动标记为 feature 候选
- [ ] AC-B2: 共创内容可一键发布到外部平台（小红书已验证）
- [ ] AC-B3: Care → Action 闭环：虚拟世界建议 → 现实行动 → 反馈记录

## Dependencies

- **Evolved from**: F066（语音消息）、F092（语音陪伴体验）
- **Related**: F086（Cat Orchestration — multi_mention 基础设施）
- **Related**: F091（Signal Study Mode — 另一种陪伴式学习场景）

## Risk

| 风险 | 缓解 |
|------|------|
| 角色扮演污染核心身份 | Role Mask 面具层设计，底层身份不可变 |
| 变成"情感依赖产品" | Care Loop 强制引导回现实；"陪伴是桥不是笼"设计原则 |
| 范围膨胀 | Phase A 先做 MVP 四件套，不做大而全虚拟宇宙 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 定位为"陪伴式共创"而非"情感陪伴产品" | 前者把人推向现实，后者可能制造依赖 | 2026-03-10 |
| KD-2 | 三层架构：Core Identity / World / Bridge | Maine Coon提出，四猫共识，Bridge 层是独有差异点 | 2026-03-10 |
| KD-3 | 角色扮演用"面具层"不是"替身层" | 身份不可污染，信任不可丢 | 2026-03-10 |
| KD-4 | 命名 "Cats & U" 而非技术名 | team experience，有情感温度 | 2026-03-10 |
| KD-5 | 三模式（Build/Perform/Replay）不是两模式 | Maine Coon R2：少了 Replay 记忆和成长会断 | 2026-03-10 |
| KD-6 | MVP 先做 4 个一等公民，不做全部 9 个 | Maine Coon R2：先证明"世界活着且不会烂"，再扩展 | 2026-03-10 |
| KD-7 | Story→Feature 放 Phase B 不放 MVP | Maine Coon R2：Bridge 层价值建立在 World 层稳定之上 | 2026-03-10 |
| KD-8 | 多 Agent 做"多意识共创"不是"更多角色" | R2 深聊共识：世界自转 + 多主观记录是质变 | 2026-03-10 |
| KD-9 | 光影同行 Universe IDE 愿景书作为正式设计输入 | team lead半年实践经验，不从零设计 | 2026-03-10 |

## Review Gate

- Phase A: 跨家族 review（Maine Coon GPT-5.4）
