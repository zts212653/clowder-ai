---
feature_ids: [F087]
related_features: [F059, F075, F090, F096]
topics: [onboarding, cvo, tutorial, gamification, open-source]
doc_kind: spec
created: 2026-03-08
---

# F087: 猫猫训练营（operator Bootcamp）

> **Status**: done | **Owner**: Ragdoll | **Completed**: 2026-03-12
> **Priority**: P2
> **Evolved from**: F059（开源计划 — clowder-ai 需要 onboarding 体验）
> **Related**: F075（成就/排行榜系统）, F090（像素猫猫大作战）, F096（可交互富文本）

## Why

clowder-ai 开源后，用户拿到框架但不知道怎么用。文档教程是"读"，训练营是"做"——用户在猫猫陪伴下走完一次真实的 feat lifecycle，从此知道如何当一个合格的 operator（Chief Vision Officer）。

### operator experience（2026-03-08）

> "猫猫训练营！如何快速培养一个合格的 operator operator？可以借用游戏的新手任务模式呀！你们几只可爱大猫猫带大家使用我们的猫猫咖啡！比如一起研发一个有趣的功能，走我们完整的 feat 流程体验一下协作的乐趣！当然不能是贪吃蛇这类简单的要死的。得有 UX UI 让他们看看你们的实力？！"

### operator纠正（2026-03-10）

> MVP **不是**我们内置任务让用户做，而是引导新用户**像operator一样和猫猫协作**——帮装 MCP、解决配置问题、带走一次真正的 feat lifecycle。成就系统直接接入 F075 猫猫排行榜，不要重新发明。**家规 P1：每步产物是终态基座不是脚手架。**

## What

### 核心概念

**Onboarding Flow + 游戏化引导**：用户不是在读教程，是在猫猫陪伴下**配好环境、学会协作、真正造一个功能**。

| 要素 | 游戏类比 | 训练营实现 |
|------|---------|-----------|
| 新手村 | Starting zone | 环境检测 + MCP 安装 + 配置帮助 |
| 引导 NPC | Tutorial NPC | 猫猫天团**轮流登场自我介绍** + 分角色引导 |
| 主线任务 | Story quest | 和猫猫一起完成一个完整 Feature |
| 成就徽章 | Achievements | 接入 **F075 猫猫排行榜**（"第一次拍板"、"第一次否决"等）|
| 技能树 | Skill tree | operator 能力逐步解锁：表达愿景→判断结果→纠偏→多猫协调 |

### 用户旅程

```
用户点击"引导"按钮 / 说"我是新手"
  → Phase 0: 选择主引导猫（用户选哪只猫当主引导，考虑不同模型成本）
  → Phase 1: 猫猫天团轮流登场自我介绍（Ragdoll→Maine Coon→Siamese）
  → Phase 2: 环境检测——MCP 装了吗？配置对吗？缺什么依赖？
  → Phase 3: 猫猫主动帮用户解决配置问题（不是甩文档链接！）
  → Phase 3.5: 进阶功能引导（TTS/ASR/Pencil，跑不起来就跳过）
  → Phase 4: 展示任务候选菜单，用户选一个感兴趣的
  → Phase 5: 立项——用户说愿景，猫猫帮结构化成 spec
  → Phase 6: 设计讨论——猫猫各自出方案，用户做 operator 拍板
  → Phase 7: 开发——猫猫写代码，用户做方向判断
  → Phase 8: Review——跨猫 review，用户看到意见分歧+收敛过程
  → Phase 9: 完成——功能上线，用户的名字在 commit 里
  → Phase 10: 回顾——猫猫带用户复盘，成就写入 F075 排行榜
  → Phase 11: 告别——告诉用户以后有问题可以回这个训练营线程找猫猫
```

### 前端入口（Design Gate 2026-03-11 确认）

- **Sidebar 按钮**：猫猫学士帽 SVG icon，放在 "+ 新对话" 按钮旁边（不用 emoji，自己画）
- **空消息态 CTA**：在现有欢迎文字下方加 "第一次来？开始猫猫训练营" 引导链接
- 点击任一入口 → 自动创建新 thread（title: "🎓 猫猫训练营"）→ 进入 Bootcamp 模式
- 配套 Skill：`bootcamp-guide`（猫猫进入引导模式，更耐心、更多解释、主动检测环境）

### Phase 3.5: 进阶功能引导（2026-03-11 operator补充）

核心必备（Phase 2-3 必须通过）之外，还有**进阶功能**需要引导安装。这些功能跑不起来不影响核心体验，但有了体验更好。

| 功能 | 说明 | 推荐方案 | 跑不起来的降级策略 |
|------|------|---------|-------------------|
| **TTS（语音合成）** | 猫猫能说话 | 推荐 **Kokoro-82M**（82M 参数，多数机器跑得动）；我们自己用 Qwen3-TTS 1.7B（音质最好但吃资源） | 无语音，纯文字交互 |
| **ASR（语音识别）** | 用户能说话 | Whisper large-v3（需 GPU/Apple Silicon） | 打字输入 |
| **Pencil（设计工具）** | 可视化设计 | 需要 Antigravity IDE + Pencil 扩展（`--app antigravity`） | 用 ASCII wireframe / 文字描述设计 |

**引导策略**：
- 猫猫**尝试检测**这些服务是否可用（检查端口/进程）
- 可用 → 告知用户已就绪
- 不可用 → 问用户要不要装，**如果不想装或装不了就跳过**（不阻塞流程！）
- TTS 推荐轻量版 Kokoro-82M：`mlx-community/Kokoro-82M-bf16`，大多数 Mac 都能跑

> **operator experience（2026-03-11）**：
> "比如说有些进阶功能你们也要引导比如 TTS Pencil 安装 ASR？这些可以和他们说如果他们电脑跑不起来那就缺失就缺失了。我们自己用的最好的那个 Qwen 推荐用的之前的那个老古董是给他们的代替。"

### Phase 11: 持续帮助入口（2026-03-11 operator补充）

训练营完成后，这个线程不会消失——**用户以后有问题可以回到训练营线程找猫猫**。

- 完成回顾后，猫猫告知用户："以后有什么需要帮助的，随时回这个线程找我们！"
- 训练营线程保持 pinned 状态，方便用户找到
- 猫猫在这个线程里持续保持"引导模式"（更耐心的回复风格）

> **operator experience（2026-03-11）**：
> "然后可以告诉他们以后有什么需要帮助引导的，可以在这个线程找你们的。"

### 新手任务的要求

不是贪吃蛇！任务项目需要满足：
- [ ] 有 UX/UI（展示设计猫实力）
- [ ] 有后端逻辑（展示架构猫实力）
- [ ] 有 review 价值（展示安全猫实力）
- [ ] 有真实的设计讨论空间（不是一个显而易见的答案）
- [ ] 1-2 天能完成（不能太长打击新手积极性）
- [ ] 完成后用户有成就感（能看到/用到自己参与的成果）

### 新手任务候选菜单（全猫全量收集，2026-03-08）

> **设计理念**：不预设"正确任务"——列出所有候选，让新手operator自己选感兴趣的。谁喜欢什么就做什么！
>
> **分层逻辑**：Lv.1 好玩即时反馈 → Lv.2 有深度但仍有趣 → Lv.3 进阶协作挑战

#### Lv.1 — 好玩上手（Aha Moments！）

| # | 任务名 | 提出者 | 亮点 | 涉及能力 |
|---|--------|--------|------|---------|
| Q1 | **猫猫盲盒** — 每天随机生成一只"每日猫猫"，有独特名字+性格+趣味建议 | Ragdoll(opus) | 即时惊喜感，每次打开都不一样 | 前端动画 + 随机生成算法 + 猫猫人设系统 |
| Q2 | **猫猫星座运势** — 输入生日，猫猫们用各自风格解读今日运势 | Ragdoll(opus) | 个性化 + 多猫不同解读对比 | 多 Agent 独立生成 + 前端卡片 UI |
| Q3 | **猫猫侦探社** — 给一段"代码案发现场"，猫猫们各自推理凶手（bug），用户做裁判 | Ragdoll(opus) | 游戏化 debug 体验 | 多猫推理 + 用户决策 + review 流程 |
| Q4 | **心情墙/留言板** — 用户发心情，猫猫用各自风格回应（Ragdoll讲道理、Maine Coon找 bug、Siamese画猫） | Ragdoll(opus) | 情绪价值拉满，即时互动 | 前端瀑布流 + 多 Agent 回复 + 存储 |
| Q5 | **Emoji 制造机** — 描述一个表情，猫猫合作生成自定义 emoji（暹罗画+布偶调+缅因审） | Siamese(gemini) | 创意表达 + 跨猫协作可视化 | 图像生成 + 跨猫 review + 前端展示 |
| Q6 | **猫猫拿铁实验室** — 选配料（咖啡因/奶泡/糖浆），猫猫各自推荐配方，用户拍板尝试 | Maine Coon(codex) | 轻松有趣，咖啡馆主题契合 | 前端配方 UI + 多猫推荐算法 + 决策流 |
| Q7 | **猫猫点餐系统** — 给虚拟猫咖设计菜单+点餐流程 | Ragdoll(opus) | 咖啡馆主题天然契合，所见即所得 | 全栈：菜单 CRUD + 点餐 UI + 结算逻辑 |
| Q8 | **像素猫猫世界** — 像素风格的猫猫互动场景，operator可以操作猫猫移动/互动 | operator | 即时视觉反馈，游戏感强 | Canvas/像素渲染 + 键盘交互 + 猫猫 AI 行为 |
| Q9 | **3D 猫猫能力看板** — 3D 或 2D 动态可视化，看到不同猫猫在做什么、各自的能力雷达图 | operator | 纯视觉 + 立刻反馈，不是严肃 Mission Hub 而是好看的猫猫们 | Three.js/CSS 3D + 实时数据 + 动画 |
| Q10 | **猫猫互动玩具** — 前端游戏化界面，operator可以和猫猫们做小互动（逗猫棒、喂食、摸头） | operator | 纯情绪价值，建立和 AI 团队的情感连接 | 前端交互动画 + Agent 性格化回应 |

#### Lv.2 — 有深度但仍有趣

| # | 任务名 | 提出者 | 亮点 | 涉及能力 |
|---|--------|--------|------|---------|
| Q11 | **猫猫天气站** — 输入城市，三只猫用不同风格播报天气（Ragdoll分析气压、Maine Coon安全提醒、Siamese画天气图） | Maine Coon(codex) | API 集成 + 多猫个性化输出 | 外部 API + 多 Agent + 前端天气 UI |
| Q12 | **每日 Standup 面板** — 猫猫们每天自动生成"今天我干了什么"的可视化面板 | Siamese(gemini) | 展示协作可观测性 | 数据聚合 + 可视化 + 定时任务 |
| Q13 | **猫猫成就博物馆** — 展示所有猫猫的历史成就、里程碑、有趣的 commit message | Siamese(gemini) | 回顾感 + 荣誉感 | Git 数据挖掘 + 前端展览 UI + 筛选过滤 |
| Q14 | **猫猫翻译官** — 用户输入一段话，猫猫们各自翻译成不同"风格"（正式/卖萌/技术/诗意） | Maine Coon(codex) | 展示多 Agent 个性差异 | 多 Agent 并行 + 风格对比 UI |

#### Lv.3 — 进阶协作挑战

| # | 任务名 | 提出者 | 亮点 | 涉及能力 |
|---|--------|--------|------|---------|
| Q15 | **决策室（Decision Room）** — 给一个真实的技术/产品二选一，猫猫各自论证，用户做最终裁判 | 全猫共识 | 展示跨猫 review + 意见分歧收敛的核心价值 | 多猫独立论证 + 结构化对比 + 用户裁决 + 复盘 |
| Q16 | **猫猫代码接力** — 一只猫写骨架，另一只猫加功能，第三只猫 review，用户做方向裁判 | Ragdoll(opus) | 完整体验多猫分工协作 | 全 feat lifecycle + 跨猫 handoff + review |

> **operator补充（2026-03-08）**：候选不限于以上！任何有趣的互动形式都可以加入。核心原则：
> 1. 新手operator**自己选**感兴趣的任务（菜单制，不是单一路径）
> 2. 好玩优先，让人想继续玩下去
> 3. 每个任务都能体验到"和猫猫一起造东西"的乐趣
> 4. 视觉反馈要即时——做完就能看到成果

### operator 能力树

| 级别 | 能力 | 训练营体现 |
|------|------|-----------|
| Lv.1 | 表达愿景 | 用户口述想要什么，猫猫帮结构化成 spec |
| Lv.2 | 判断方案 | 猫猫出 2-3 个方案，用户选择并说理由 |
| Lv.3 | 纠偏 | 开发中途猫猫故意问"要不要加 X？"，用户判断是否跑偏 |
| Lv.4 | 协调冲突 | 两只猫意见分歧，用户做裁判 |
| Lv.5 | 复盘总结 | 回顾全程，提取可复用的协作模式 |

## Acceptance Criteria

- [x] AC-A1: 前端有"新手引导"入口按钮，点击触发 Bootcamp 模式（PR #375）
- [x] AC-A2: 猫猫天团轮流登场自我介绍（Ragdoll→Maine Coon→Siamese，各自风格）（bootcamp-guide skill Phase 1 引导）
- [x] AC-A3: 自动检测用户环境（MCP、依赖、配置），主动帮用户解决问题（env-check API, PR #375）
- [x] AC-A4: 提供任务候选菜单（≥3 个不同难度），用户自选感兴趣的任务（bootcamp-blocks, PR #375）
- [x] AC-A5: 用户从头到尾走完 feat lifecycle（立项→设计→开发→review→完成）（Phase 5-10 状态机 + skill 引导）
- [x] AC-A6: 过程中用户做了 ≥3 次 operator 决策（方案选择、纠偏、冲突裁判）（skill 引导 + 「🎯 operator 决策时刻」标记）
- [x] AC-A7: 完成后用户能看到自己参与的成果（功能上线 / commit 记录）（F075 成就徽章 + 训练营线程保留）
- [x] AC-A8: 成就/进度接入 F075 猫猫排行榜系统（终态基座，不搞临时版）（PR #391）
- [x] AC-A9: 训练营可作为 clowder-ai 的 Quick Start 引导（**Deferred to F059** — clowder-ai 开源后对接，训练营代码已就绪）
- [x] AC-A10: 进阶功能引导（TTS/ASR/Pencil）——检测可用性、引导安装、跑不起来优雅跳过（env-check API, PR #375）
- [x] AC-A11: TTS 推荐轻量版 Kokoro-82M 给资源有限的用户（env-check.ts 已返回 Kokoro-82M 推荐）
- [x] AC-A12: 训练营完成后线程保持可用，用户以后可回来找猫猫求助（GET /api/bootcamp/thread 线程发现 + auto-pin）

## Design Gate（2026-03-11，operator确认）

**类型**：前端 UI/UX → 需要operator确认 wireframe

### UX Wireframe 总结（5 屏）

| 屏 | 内容 | 设计要点 |
|----|------|---------|
| Screen 1 | 入口（Sidebar + 空消息态） | SVG 猫猫学士帽按钮放 "+ 新对话" 旁；空消息态加 CTA |
| Screen 2 | Phase 0-1（选引导猫 + 天团登场） | 用户先选主引导猫（card-grid），然后三猫依次自我介绍 |
| Screen 3 | Phase 2-3（环境检测 + 配置帮助） | checklist 卡片（✅/⚠️/❌），有问题猫猫主动给解法 |
| Screen 4 | Phase 4（任务选择菜单） | card-grid 按难度分三层 + "🎲 随机抽" 按钮 |
| Screen 5 | Phase 5+（进入真实协作） | 进度条 Rich Block + 正常猫猫协作，只是更耐心 |

### operator反馈（4 点，全部采纳）

1. **入口按钮自己画**（不用 emoji）→ KD-8
2. **让用户选引导猫**（考虑模型成本差异）→ KD-9
3. **任务菜单加随机抽** → KD-10
4. **可交互富文本做成通用组件** → 提取为 F096 独立 Feature

### 前置依赖

F087 的 Phase 0（选引导猫）和 Phase 4（任务选择）依赖 F096 Interactive Rich Blocks。F096 是 F087 的 `Blocked by` 依赖。

## Implementation Phases

### Phase A: 基础设施 ✅ (PR #375, `d26feec3`)

**交付物**：
- Thread `bootcampState` 字段（schema + API + Redis 持久化）
- `/api/bootcamp/env-check` 环境检测端点（Node/pnpm/Git/Claude CLI/MCP/TTS/ASR/Pencil）
- 前端入口：Sidebar 学士帽按钮 + 空消息态 CTA
- `bootcamp-guide` Skill（13 phase 引导行为定义）
- SystemPromptBuilder bootcamp 注入
- `bootcamp-blocks`：引导猫选择 + 任务选择的 Interactive Rich Block 定义
- 测试：24 tests（thread-bootcamp 6 + env-check 5 + blocks 5 + prompt-builder 2 + 预有 6）

### Phase B: Callback Routes + MCP Tools ✅ (PR #381)

**交付物**：
- `callback-bootcamp-routes.ts`: 2 个回调端点（update-bootcamp-state, bootcamp-env-check）
- `env-check.ts`: 环境检查逻辑抽取为共享 helper（GET + callback 共用）
- `callback-tools.ts`: 2 个 MCP 工具（cat_cafe_update_bootcamp_state, cat_cafe_bootcamp_env_check）
- `bootcamp-guide/SKILL.md`: 更新 MCP 工具引用
- 安全：严格线程绑定（403 跨线程）+ stale invocation guard
- 测试：15 tests（callback-state 8 + callback-env-check 6 + bootcamp-flow 1）
- Review：Maine Coon 3 轮 review（P1 跨线程写入 + P1 default bypass + P2 stale guard）

### Phase C: 运行时编排 ✅ (PR #386, `725a24bc`)

**交付物**：
- `SystemPromptBuilder.ts`: `threadId` 注入 bootcamp prompt（猫猫可调 MCP 工具）
- `route-parallel.ts` / `route-serial.ts`: 传递 `threadId` alongside `bootcampState`
- `callback-bootcamp-routes.ts`: `phase-11-farewell` 自动 pin thread
- `bootcamp-guide/SKILL.md`: 全面重写（threadId 来源 + 完整 phase 编排指南）
- `tool-registration.test.js`: 补上 2 个 bootcamp 工具到 guard 列表
- 测试：API 3814 pass、MCP 54/54 pass
- Review：Maine Coon 1 轮放行（0 P1/P2）+ 云端 Codex 放行

### Phase D: 成就接入 ✅ (PR #391)

**交付物**：
- `achievement-defs.ts`: 4 个 bootcamp 成就（入营新兵/装备齐全/第一次拍板/训练营毕业）
- `BOOTCAMP_PHASE_ACHIEVEMENTS` 映射表：phase→achievement（4 个关键 phase 触发解锁）
- `callback-bootcamp-routes.ts`: forward-only phase 状态机（PHASE_ORDER + PHASE_INDEX），防刷成就
- 成就通过 `app.inject()` 走 F075 events pipeline（统一契约），含响应校验
- 测试：callback-bootcamp-state 17/17、bootcamp-flow 1/1、leaderboard 38/38
- Review：Maine Coon 3 轮 review（P1 phase-skip farming + P1 dead def + P2 event contract + P2 response validation）+ 云端 Codex LGTM
- **Deferred**: `bootcamp-first-rejection` 成就需要对话级事件系统（非 phase 迁移），待未来对话事件管道就绪后实现

### Phase E: AC 收尾 ✅

**交付物**：
- `bootcamp.ts`: `GET /api/bootcamp/thread` 线程发现端点（找用户最近的训练营线程）
- `index.ts`: 传 `threadStore` 给 `bootcampRoutes`
- 测试：bootcamp-env-check 9/9（含 4 个线程发现测试）
- AC 覆盖扫描：A2/A5/A6/A7 已被 skill + 状态机覆盖，A11 已在 env-check 实现，A12 由 API + auto-pin 覆盖
- 仅 AC-A9（Quick Start 文档）待 clowder-ai 开源后对接

## Key Decisions

| # | 决策 | 日期 | 决策者 |
|---|------|------|--------|
| KD-1 | 新手任务采用"菜单制"——列出所有候选让用户自选，而非预设单一路径 | 2026-03-08 | operator |
| KD-2 | 任务分三层难度：Lv.1 好玩即时反馈 → Lv.2 有深度 → Lv.3 进阶协作 | 2026-03-08 | 全猫讨论 |
| KD-3 | 鼓励视觉/互动/游戏化方向（像素、3D、前端互动），不局限于传统 CRUD | 2026-03-08 | operator |
| KD-4 | MVP 是 onboarding flow（环境检测+配置帮助+真实协作体验），不是内置预设任务 | 2026-03-10 | operator |
| KD-5 | 成就系统直接接入 F075 猫猫排行榜，不重新发明（家规 P1 终态基座） | 2026-03-10 | operator |
| KD-6 | 猫猫天团登场方式：轮流自我介绍（不是同时说话） | 2026-03-10 | operator |
| KD-7 | 前端入口：在现有聊天界面加"引导"按钮，不做独立页面 | 2026-03-10 | operator |
| KD-8 | 入口按钮用自绘 SVG icon（猫猫学士帽），不用 emoji；放在 "+ 新对话" 旁边 | 2026-03-11 | operator |
| KD-9 | 让用户选择主引导猫（Ragdoll/Maine Coon/Siamese），考虑不同模型成本差异 | 2026-03-11 | operator |
| KD-10 | 任务选择菜单加"随机抽"功能（骰子动画） | 2026-03-11 | operator |
| KD-11 | 渐进式引导：Phase 0-3 强引导（猫猫手把手），Phase 4+ 回归真实协作体验 | 2026-03-11 | Ragdoll+operator |
| KD-12 | 环境检测 MVP 最小集：Node.js + pnpm + Git + Claude CLI + MCP 连接状态 | 2026-03-11 | Ragdoll |
| KD-13 | 任务选择菜单和引导猫选择使用 Interactive Rich Blocks（F096），通用可交互富文本组件 | 2026-03-11 | operator+Ragdoll |
| KD-14 | 进阶功能（TTS/ASR/Pencil）引导但不阻塞——跑不起来就跳过 | 2026-03-11 | operator |
| KD-15 | TTS 推荐策略：我们用 Qwen3-TTS 1.7B（最佳），用户推荐 Kokoro-82M（轻量可替代） | 2026-03-11 | operator |
| KD-16 | 训练营线程作为持续帮助入口——完成后不消失，用户可回来找猫猫 | 2026-03-11 | operator |

## Dependencies

- **Evolved from**: F059（开源计划 — clowder-ai 需要 onboarding 体验）
- **Blocked by**: F096（Interactive Rich Blocks — 任务选择/引导猫选择需要可交互富文本）
- **Related**: F075（猫猫排行榜 — 成就/统计系统的真相源）
- **Related**: F090（像素猫猫大作战 — 训练营候选任务之一）
- clowder-ai 核心框架就绪后才能做训练营

## Risk

| 风险 | 缓解 |
|------|------|
| 任务太简单没挑战 | 选有真实设计空间的项目 |
| 任务太复杂新手放弃 | 控制在 1-2 天内可完成 |
| 引导太死板像教程 | 猫猫的回复保持个性和自然感 |
| 环境千差万别导致配置失败 | 猫猫主动诊断 + 提供多种解法 |

## Review Gate

- 跨猫 review：@codex
