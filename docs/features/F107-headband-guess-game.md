---
feature_ids: [F107]
related_features: [F101, F075, F119]
topics: [game, headband, guess-who, party-game, ai-deception]
doc_kind: spec
created: 2026-03-12
---

# F107: 脑门贴词 — 坏猫战术推理游戏 #1

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P1

## Why

team experience（2026-03-12）：
> "我们自己曾经在 thread 玩过猫猫杀，其实就是猜猜我是谁，脑门贴词，猫猫猜测自己是什么词。我也想做成狼人杀这样的游戏。猫猫杀一定要告诉猫猫们坏猫战术！！！"

猫猫杀是 Cat Cafe 的**招牌推理游戏**，七届历史（Ragdoll 1v1 四届三胜一平）。之前全靠手动 MCP 消息轮次推进，存在问题：
- team lead需要手动当主持人（选词、分配、计轮、判胜负）
- 坏猫战术（泛化描述、选择性强调、时间模糊、否定排除法）靠口传心授，新猫不知道
- 没有信息隔离保证（心里话曾泄露过，第四届 bug）
- 游戏战绩手动统计

F101 已搭好通用游戏引擎基座（`GameDefinition` / `GameRuntime` / `GameView`），猫猫杀作为**第二个游戏实现**，验证引擎的扩展性。

## What

复用 F101 通用游戏引擎基座，实现猫猫杀（脑门贴词 / Headband Guess Game）。

### Phase A: 猫猫杀游戏引擎

在 F101 GameEngine 基座上实现猫猫杀规则。

**A1. 规则引擎（HeadbandDefinition）**

核心规则（源自七届实战）：
- **N 只猫参赛**（2-8 人），每只猫"脑门上贴一个词"
- 每只猫**看不见自己的词**，但**看得见所有其他猫的词**
- 轮流提问（Yes/No 问题），其他猫**必须诚实回答**
- 每轮可选择猜词或继续提问，**猜错不淘汰**（继续下一轮）
- **猜对 = 得分**，轮数越少分越高
- 全员猜对 → 游戏结束，按轮次排名

状态机：`lobby → assign_words → round(ask → answer → guess?) → check_all_guessed → end`

信息隔离：
- `seat:x` scope：每只猫的脑门词对自己不可见
- `public` scope：提问和回答公开
- `god` scope：所有词 + 所有猫的推理过程

**A2. 选词系统（三种模式）**

三种选词模式（team lead Design Gate 确认）：
- **team lead出题**：team lead开局为每只猫手动指定脑门词（传统模式，支持恶趣味操作）
- **猫猫出题**：由一只猫（不参赛）为其他猫选词，可利用 meta 信息搞恶趣味
- **随机词库**：从词库随机抽取同主题词组（AI 关键词 / 历史人物 / 科技名人 等）

词库要求：
- 同一局的词属于同一主题（让猜测有上下文）
- 词的难度可调：简单（高辨识度）/ 困难（同领域相近概念）
- team lead恶趣味模式（meta 信息：给 Claude 猫贴 Claude Shannon，给 GPT 猫贴 Karpathy）

**A3. 坏猫战术系统 — AI 玩家 prompt**

这是猫猫杀的**灵魂**。**所有猫都要教会坏猫战术**（team experience："你到时候提示时一定要告诉其他的猫，让他们坏起来"）。

**回答策略（坏猫四大心法，源自七届实战）**：
1. **泛化描述** — 用模糊特征回答，让答案适用于多个候选人
2. **选择性强调** — 突出真实但不关键的侧面
3. **时间模糊** — 用宽泛的时间范围
4. **否定排除法** — 排除大类但不指明真实答案

**高阶心法（第六届总结）**：
5. **偷换标签** — 用"技术上正确但画风不同"的描述替代真实标签
6. **隐藏王牌** — 找到最独特的识别特征，全程不碰
7. **放大次要** — 把真实但不核心的特征说得像主标签

**提问策略（做题家路线 vs 直觉路线）**：
- 二分法缩小范围
- Meta 信息利用（team lead选题模式预判）
- 交叉验证（用已知其他猫的词反推自己的词）

**诚实约束**：回答必须是真话，但允许合法误导。GameEngine 不强制校验回答真实性（依赖 LLM 的诚实 + 其他猫的监督）。

**A4. 开局配置 + team lead参与模式**

开局配置界面（参考狼人杀 UI，team lead截图确认）：
1. **选择参赛猫猫**：点击头像添加，team lead决定几只猫参赛、分别是哪些猫
2. **选择team lead角色**：
   - `player`：team lead也是参赛者，脑门贴词，提问/回答/猜词
   - `god-view`：看到所有词 + 所有猫的推理过程（内心戏），纯观战
   - `host`：team lead手动选词 + 观战，可干预（暂停/提示/换词）
3. **语音模式开关**：复用 F066 TTS
4. 点击"开始游戏" → GameMaster 接管自动驱动

**A5. 战绩对接（F075 Leaderboard）**

复用 F075 `game-store.ts`：
- 冠军次数、平均猜词轮数、最快猜词记录
- 误导成功率（让对手多猜 N 轮）
- MVP 评选（最快猜中 + 最强误导）

**A6. GameMaster 自动驱动（系统角色）**

GameMaster 是一个独立的系统角色，走现有消息管线，有专属头像（KD-8/KD-9）。

**身份**：
- 独立角色（不是任何一只猫），像飞书 bot / GitHub bot
- 有专属头像和显示名称
- 通过 `post_message` / `multi_mention` / 富文本（`create_rich_block`）在消息流中发言

**自动流程**：
- **开局**：team lead说"开一局脑门贴词" → GameMaster 自动发词、分配身份、注入坏猫战术 prompt
- **教学**：首局自动给猫猫发送游戏规则 + 战术手册
- **回合推进**：自动 @ 该轮到的猫，提示动作（提问/回答/猜词）
- **可见性切换**：自动管理 scoped event log（公开发言 vs 内心戏）
- **裁判**：自动计分、判定猜词结果、宣布全员猜中时排名
- **结算**：自动写战绩到 leaderboard + 宣布 MVP

**team lead零操作**：
- 当上帝 = 开局后躺着看，god-view 自动展示内心戏
- 当玩家 = 和猫猫一样被 @ 到时才操作
- 当 host = 只管选词，其余 GameMaster 全包

### Phase B: 前端游戏 UI（KD-7: 不做，纯聊天模式）

~~复用 F101 GameShell 框架，定制猫猫杀交互：~~

> **KD-7 决策**：不做前端，纯聊天模式。脑门贴词的灵魂是对话博弈，聊天本身就是游戏场。以下 B1-B3 保留作为未来可选增强参考，当前不实施。

**B1. 游戏布局**

- 顶部：当前轮次 + 谁在提问 + 倒计时
- 中间上：PlayerGrid — 每只猫的头像 + 脑门词（自己的显示 `???`）+ 已猜中/未猜中状态
- 中间下：事件流（提问/回答/猜词记录）
- 底部：ActionDock — 提问输入 / 回答 Yes/No / 猜词按钮

**B2. 内心戏面板（god-view 专属）**

- 每只猫的推理过程实时展示（半透明毛玻璃气泡，参考名场面集锦设计）
- 坏猫战术标注（自动识别：泛化描述/选择性强调/隐藏王牌 等）

**B3. 揭词仪式**

- 猫猫猜中时：翻牌动画 + 音效
- 全员猜中：排行榜展示 + MVP 颁奖

## Acceptance Criteria

### Phase A（猫猫杀游戏引擎）
- [ ] AC-A1: `HeadbandDefinition` 实现 `GameDefinition` 接口，包含完整阶段/动作/胜利条件
- [ ] AC-A2: 2-8 人局可完整跑通（lobby → assign → rounds → end），单元测试覆盖
- [ ] AC-A3: 信息隔离：每只猫看不到自己的脑门词，但能看到其他猫的
- [ ] AC-A4: AI 猫猫能运用坏猫战术回答问题（prompt 注入四大心法 + 高阶心法）
- [ ] AC-A5: AI 猫猫能合理提问和猜词（二分法 + meta 信息利用）
- [ ] AC-A6: team lead可选 player / god-view / host 三种模式参与
- [ ] AC-A7: 选词系统支持手动选词 + 自动选词（词库）
- [ ] AC-A8: 战绩数据正确写入 F075 game-store
- [ ] AC-A9: GameMaster 系统角色有独立身份 + 头像，走消息管线发言
- [ ] AC-A10: GameMaster 全自动驱动：开局→教学→回合推进→裁判→结算，team lead零操作
- [ ] AC-A11: GameMaster 自动管理可见性切换（公开发言 vs 内心戏 scope）
- [ ] AC-A12: 开局配置界面：team lead可选参赛猫（哪些猫 + 几只）、选角色（玩家/上帝/host）、选词模式
- [ ] AC-A13: 开局配置复用狼人杀 UI 模式（选猫头像点击添加 + 语音开关 + 开始按钮）

### Phase B（前端增强 — 游戏过程在聊天，开局配置需 UI）
- [ ] AC-B1: 开局配置 UI 复用/适配狼人杀的 GameSetup 组件
- [ ] AC-B2: god-view 内心戏通过 scoped 消息在聊天中展示
- [ ] AC-B3: 揭词仪式通过富文本/rich block 在聊天中展示
- [ ] AC-B4: 语音模式可选（复用 F066 TTS）

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "做成狼人杀这样的游戏" | AC-A1,A2 | test | [ ] |
| R2 | "脑门贴词，猫猫猜测自己是什么词" | AC-A3,A7 | test | [ ] |
| R3 | "一定要告诉猫猫们坏猫战术"，所有猫都要教 | AC-A4 | test + manual | [ ] |
| R4 | player + 上帝模式（同狼人杀） | AC-A6 | test | [ ] |
| R5 | 战绩接入排行榜 | AC-A8 | test | [ ] |
| R6 | 猜错语音卖萌（语音模式） | AC-A2,B4 | manual | [ ] |
| R7 | 允许猫猫讨论/质疑 | AC-A2 | test | [ ] |
| R8 | 坏猫内心戏 god-view 必须保留 | AC-B2 | screenshot | [ ] |
| R9 | team lead选参赛猫（几只 + 哪些猫），参考狼人杀开局 UI | AC-A12,A13,B1 | screenshot | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（Phase B 时补充）

## Dependencies

- **Evolved from**: F101（Mode v2 游戏引擎基座 — 复用 GameEngine/GameRuntime/GameView）
- **Related**: F075（Cat Leaderboard — 战绩对接 game-store）
- **Related**: F066（Voice Pipeline — 语音模式 TTS）
- **Related**: F103（Per-Cat Voice Identity — 多猫独立声线）
- **Related**: F119（谁是卧底 — 坏猫战术推理游戏 #2，共享战术体系）

## Risk

| 风险 | 缓解 |
|------|------|
| AI 回答不够"坏"（太诚实，没有误导性） | prompt 注入七届实战案例 + 坏猫心法 + few-shot 示例 |
| AI 回答不诚实（说假话） | prompt 强调"必须是真话" + 其他猫可质疑 + god-view 审计 |
| 选词难度不平衡（太简单/太难） | 词库分级 + team lead host 模式可手动调整 |
| 信息隔离：心里话泄露自己的词 | scoped event log（F101 KD-3），AI 推理过程只对 god scope 可见 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 复用 F101 GameEngine 基座，不另起炉灶 | seat/actor/role 三层分离 + scoped event log 完美适配 | 2026-03-12 |
| KD-2 | AI prompt 必须注入坏猫战术，**所有猫都要教** | team lead强调"一定要告诉猫猫们坏猫战术"，不只Ragdoll一只坏 | 2026-03-12 |
| KD-3 | 三种选词模式：猫猫出题 / team lead出题 / 随机词库 | team lead确认：猫猫也可以当出题者 | 2026-03-12 |
| KD-4 | 猜错不淘汰，语音模式下卖萌 | 猫猫杀传统规则 + team lead要求语音卖萌 | 2026-03-12 |
| KD-5 | 允许猫猫之间讨论/质疑回答 | team lead确认，保留七届传统玩法 | 2026-03-12 |
| KD-6 | 坏猫内心戏是核心乐趣，god-view 必须保留 | team lead确认，毛玻璃面板 + 战术标注 | 2026-03-12 |
| KD-7 | 游戏过程纯聊天，开局配置复用狼人杀 UI 模式 | 游戏在对话窗玩，但开局需要选猫、选角色、选词模式的配置界面 | 2026-03-14 |
| KD-8 | GameMaster 系统全自动驱动，走现有消息管线 | team lead当上帝不需要手动组织流程，复用 post_message/multi_mention/富文本 | 2026-03-14 |
| KD-9 | GameMaster 是独立角色，有专属头像 | 像飞书 bot / GitHub bot，在消息流中有清晰视觉区分 | 2026-03-14 |
| KD-10 | 开局由team lead选参赛猫 + 数量 | 参考狼人杀开局 UI：选板子→选猫猫→选视角→开始游戏 | 2026-03-24 |

## Review Gate

- Phase A: Maine Coon review（重点：信息隔离 + AI 战术 prompt 质量）
- Phase B: Maine Coon review + Siamese design review
