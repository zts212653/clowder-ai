---
feature_ids: [F101]
related_features: [F011, F107]
topics: [mode, game, werewolf, game-engine]
doc_kind: spec
created: 2026-03-11
reopened: 2026-03-14
updated: 2026-03-23
---

# F101: Mode v2 — 游戏系统引擎 + 狼人杀

> **Status**: in-progress (Phase I in progress) | **Owner**: Ragdoll | **Priority**: P1 | **Reopened**: 2026-03-14
>
> **重新打开原因**：2026-03-12 声称 done 并通过愿景守护，但team lead 2026-03-14 实际启动 dev 点开狼人杀后发现：(1) 无关闭/返回按钮，用户被困在全屏游戏界面；(2) 无大厅/配置流程，7 只猫自动塞入无法选择；(3) 猫猫不会自动行动，游戏永远卡在 night_guard 等待中；(4) 整体不可用。92 个单元测试全绿但零 E2E 真实验证。教训见 LL-032。

## Why

team experience（2026-03-11）：
> "我们的这个 mode 其实应该是类似于什么，就比如说是假设狼人杀、三国杀这种是需要我们自己额外制作一个系统的，这样子好像才是需要启动一个这种 mode 模式。"

现有 mode（brainstorm/debate/dev-loop）已被 skill 流程吸收，几乎没人使用。Mode 应重新定位为**强机制游戏系统容器**，第一个目标是狼人杀。team lead可选择当玩家、上帝视角观战、或法官。

四猫讨论收敛（Ragdoll + Siamese + Maine Coon GPT-5.4 + Maine Coon Codex），核心共识：
- 法官 = 纯代码 GameEngine（确定性逻辑），LLM 只做玩家发言和策略
- seat/actor/role 三层分离（gpt52 提出）
- 服务端 scoped event log 做信息隔离
- 参考 AIWolf 协议边界，不抄 prompt

## What

分两大部分：**Part A — Mode 机制改造**（通用游戏引擎基座）、**Part B — 狼人杀 v1**（首个游戏实现）。

### Phase A: Mode v2 — 通用游戏引擎基座

将现有 mode 从"协作流程容器"改造为"游戏系统容器"。

**A1. 类型抽象改造**
- **删除**旧三 mode（brainstorm/debate/dev-loop），不做兼容，面向终态开发
- 新增 `GameDefinition`（规则集）/ `GameRuntime`（运行时状态机）/ `GameView`（视图裁剪）三层抽象
- `seat / actor / role` 三层分离：seat=P1-Pn, actor=人类/猫/system, role=游戏角色

**A2. 执行模型改造**
- 从"用户发消息触发一轮 handler"→ 系统驱动 tick（GameEngine 自主推进夜晚/结算/投票）
- 超时自动结算：默认 3-5 分钟，全员提交可提前进入下一阶段（不用等满时间）
- ModeStore 从内存 Map → Redis 持久化（进程重启不丢局）

**A3. 信息隔离层**
- 统一 event log（append-only + version），每个事件带 `scope = public | seat:x | faction:wolf | judge | god`
- API 和 socket 只发 `GameView`（裁剪后视图），**禁止**全量 state 直出
- `GET /mode` 和 `mode_changed` socket 按请求者身份裁剪返回

**A4. 旧 mode 清理**
- 删除 brainstorm/debate/dev-loop 的 handler、类型、路由、前端入口
- 前端 `/mode` 命令和 ModeStatusBar 重写为游戏模式入口
- 不做向后兼容，直接清理干净

### Phase B: 狼人杀 v1 — 首个游戏实现

在 Phase A 基座上实现标准狼人杀。

**B1. 规则引擎（WerewolfRuleset）**
- 规则基准：**网易狼人杀**（大众熟悉的版本）
- 角色配置：可自定义（team lead开局时选角色组合），默认 7 人局
- 状态机：`lobby → deal → night(action collection) → resolve → day(discuss+遗言) → vote → exile → check(win?) → end`
- 结构化动作：`vote / attack / guard / divine / use_potion`，服务端做 phase+role+alive 校验
- 胜负判定：狼人全灭=好人胜 / 好人≤狼人=狼人胜
- 遗言阶段：被投票出局的玩家可发遗言
- 无警长竞选机制（网易标准规则）
- 投票复用现有 `cat_cafe_start_vote` 能力

**B2. 法官系统（GameEngine）**
- 纯代码实现，不走 LLM 推理
- 角色分配：`shuffle(roles) → assign(seats)`
- 回合流转：系统驱动，不依赖用户消息
- 技能结算：确定性逻辑（女巫毒/救、守卫保护、预言家查验、狼人刀人）
- 并发控制：每局单写锁，避免重复结算和竞态投票

**B3. team lead参与模式（v1 支持 player + god-view）**
- `player`：只看自己可见事件，可发言/投票，战争迷雾
- `god-view`：只读全量状态（所有角色+夜间动作），不可干预
- `judge`：放 v2（可手动推进 phase/override + 审计日志）

**B4. 猫猫 AI 玩家**
- 猫猫作为玩家参与：LLM 负责发言策略和社交推理
- 系统 prompt 按角色注入：狼人知道队友、村民只知公开信息
- 结构化动作通过 function call 收集，不从自然语言猜测

**B5. 语音模式（可选）**
- 开局时team lead可选择"文字模式"或"语音模式"
- 语音模式下：猫猫发言通过 audio rich block 输出（TTS 合成），不用文字
- 复用 F066 Voice Pipeline（Qwen3-TTS，各猫各有声线）

**B6. 前端游戏 UI**（KD-12 + KD-13，与 gpt52 讨论定案）
- **GameShell**：全屏接管，替换常规 chat chrome，隐藏左大厅+右状态栏
- **玩家视角布局（C 方案）**：
  - 顶部常驻：`PhaseTimeline` + 倒计时
  - 次顶部：`PlayerGrid`（存活/出局/投票指示）
  - 中间：事件流（公共事件+发言）
  - 底部 sticky：`ActionDock`（技能选择/投票/发言，用 interactive rich block）
- **上帝视角布局（C 变体）**：
  - 同上，但中间区 70% 事件流 + 30% **God Inspector** 右侧面板
  - God Inspector 三层：Seat Matrix（角色+存活+行动状态）→ Night Timeline（结算顺序）→ Scope Tabs（All/Wolves/Seer/Witch/Resolve）
  - 移动端降级为右侧抽屉
- **夜间等待体验**：只显示阶段名+倒计时+个人状态+氛围文案，不显示行动进度数字（防泄露）
- 翻牌仪式：interactive rich block 点击揭牌
- 日夜氛围联动：CSS 变量切换（夜间压暗+降饱和度）

### Phase D: 狼人杀重做 — team lead 1v1 采访定案（2026-03-14）

基于team lead 1v1 采访（2026-03-14 22:30），Phase D 是对 Phase A-C 的体验重做。

**D1. 独立游戏 Thread**
- 游戏在**独立 thread** 中运行（类似 bootcamp 训练营），不在现有聊天 thread 上叠加
- 归档分类：`游戏-狼人杀`，在左侧栏可快速定位（参考现有 cat-cafe / studio-flow / 未分类 project 分类体系）
- **KD-18**: 游戏和日常聊天完全隔离，游戏有专属空间

**D2. 猫猫身份保留**
- 猫猫在游戏内**保留咖啡馆身份**（Ragdoll/Maine Coon/Siamese），不需要新 persona
- 复用现有头像系统（CatAvatar + `/avatars/{catId}.png`）
- **KD-19**: 不需要"玩家3"之类的通用身份，猫猫就是猫猫

**D3. 上帝操控面板**
- 发牌（手动分配角色）✅
- 暂停/恢复（"我要去上厕所你们总得等等我"）✅
- 跳过当前阶段（帮卡住的局面推进）✅
- ~~踢人~~（team lead："太过分了 猫猫做错什么了"）❌
- **KD-20**: 上帝面板三个核心按钮：发牌、暂停/恢复、跳过当前阶段

**D4. 真实到达/就绪状态**
- 展示每只猫的**真实加载状态**，不做假动画
- 卡住的猫要有 loading 指示，team lead担心猫猫卡住看不到
- **KD-21**: ready 状态必须反映真实情况

**D5. 狼人猫猫风 UX**
- 设计关键词：**可爱 + 暗色调 + 猫猫穿狼人服装/装扮**
- 不是纯暗黑 RPG，不是纯可爱，是**猫猫 cosplay 狼人**的混搭风格
- team experience："猫猫装狼人那种可爱的带点黑色的风格"
- **KD-22**: 视觉风格 = 狼人猫猫风（cute dark）

**D6. 战绩统计 + MVP**
- 游戏结束后需要**结算画面**：胜负、各玩家表现统计、MVP 评选
- 对接 Leaderboard F075
- **KD-23**: 每局结束必须有完整的战绩和 MVP

## Acceptance Criteria

### Phase A（Mode v2 通用基座）✅
- [x] AC-A1: `GameDefinition / GameRuntime / GameView` 类型定义完成，支持 workflow+game 双轨
- [x] AC-A2: GameEngine 可自主驱动 tick（不依赖用户消息），超时自动结算
- [x] AC-A3: Event log append-only + scope 裁剪，API/socket 只返回 GameView
- [x] AC-A4: ModeStore Redis 持久化，进程重启后可恢复游戏
- [x] AC-A5: 旧三 mode 代码完全删除，前端入口重写为游戏模式
- [x] AC-A6: 信息泄漏红线测试：不同 scope 的 actor 看不到不该看的事件

### Phase B（狼人杀 v1）⚠️ 重新打开
- [x] AC-B1: 7 人局可完整跑通（lobby→deal→night/day 循环→结局）— ⚠️ 单元测试通过但 E2E 未验证
- [x] AC-B2: team lead可选 player 或 god-view 参与
- [x] AC-B3: 猫猫 AI 玩家能合理发言和执行夜间动作 — ✅ Phase C GameAutoPlayer 修复（PR #454），PR #478 补 hasActed 状态反馈
- [x] AC-B4: 信息隔离：村民看不到狼队夜聊、玩家看不到他人私密技能结果
- [x] AC-B5: 非法动作被拒绝（死人不能投票、白天不能用夜间技能等）
- [x] AC-B6: 断线重连后可恢复游戏状态（v1 简单刷 GameView）
- [x] AC-B7: PlayerGrid + PhaseTimeline 前端组件可用
- [x] AC-B8: 语音模式可选，猫猫用 audio rich block 发言

### Phase C（2026-03-14 补充 — 可用性修复）✅
- [x] AC-C1: GameShell 有关闭/返回按钮，用户可退出游戏回到聊天界面
- [x] AC-C2: 大厅流程 — 选板子（6/7/8/9/10/12人局）+ 配置参赛猫 + 确认开始
- [x] AC-C3: 猫猫 AI 自动行动 — GameAutoPlayer 驱动夜间技能 + 白天投票，游戏可推进
- [ ] AC-C4: **E2E 验收标准** — codex 或 gpt52 启动 dev 环境，team lead能真正进入并完成一局游戏

### Phase D（狼人杀重做 — team lead采访定案）✅
- [x] AC-D1: 游戏在独立 thread 运行，归档分类 `游戏-狼人杀`，左侧栏可见
- [x] AC-D2: 猫猫保留咖啡馆身份（Ragdoll/Maine Coon/Siamese），复用现有头像系统
- [x] AC-D3: 上帝面板三按钮（发牌、暂停/恢复、跳过阶段），无踢人功能
- [x] AC-D4: 每只猫展示真实 ready 状态 + 卡住时有 loading 指示
- [x] AC-D5: 狼人猫猫风 UX（可爱+暗色调+猫猫 cosplay 狼人）— 需Siamese参与视觉资产
- [x] AC-D6: 结算画面 — 胜负 + 各玩家统计 + MVP 评选

### Phase E（Detective Mode 视觉增强）🚧
- [x] AC-E1: 上帝推理模式（Detective Mode）— 观战者开局选定一只猫，只能看到该玩家的身份和信息权限，其余座位只看到公开信息。team experience："只能选择一只猫看他身份，狼人杀观战模式那种"
  - 视觉：塔罗牌卡背 + 灵魂链接光效 + 翻牌仪式（Siamese提案）— ⬜ 视觉资产待Siamese
  - 技术：`GameViewBuilder` 新增 `detective` 视角，绑定 seatId 后继承该座位信息域 ✅
  - 前端视觉：紫色侦探主题 + soul-link-pulse + tarot-back — 🔄 PR review 中

### Phase F（核心体验修复 — 投票/透明度/超时）✅
- [x] AC-F1: GitHub agent werewolf 调研报告完成，覆盖 ≥3 个项目
- [x] AC-F2: God-view 夜晚时间线实时展示每个角色的具体行动目标
- [x] AC-F3: 已行动状态从二态改为五态（waiting/acting/acted/timed_out/fallback）
- [x] AC-F4: 多狼独立投票 + 多数票结算 + 平票处理
- [x] AC-F5: 白天投票可改票 + 全员 commit 提前结束
- [x] AC-F6: 超时未行动自动 fallback，游戏不卡住
- [x] AC-F7: 慢启动猫猫有 grace period + god-view 展示真实连接状态
- [x] AC-F8: team lead在 god-view 能清楚理解"正在发生什么"（不再一脸懵逼）

### Phase H6（Chat UI 重做 — 对齐 .pen 设计稿）✅

愿景守护 review by Ragdoll Opus 4.5（2026-03-19）→ 踢回 → 修复 → codex review 放行 → merged

| # | AC | 承诺 | 当前状态 |
|---|-----|------|----------|
| 1 | — | 系统报幕渲染为**卡片样式**（红色/金色） | ✅ ANNOUNCE_CARD_TYPES + getAnnounceCardStyle |
| 2 | — | 聊天气泡带**头像圆圈** | ✅ 32px avatar + seatToActor 映射 |
| 3 | — | `activeSeatId` 传递到 PlayerGrid | ✅ GameOverlay 推导 + 传递 |
| 4 | — | displayName 格式 "Ragdoll(opus)" | ✅ GameViewBuilder.enrichDisplayName via catRegistry |
| 5 | — | 发言中玩家**金色边框** | ✅ border-[var(--ww-state-speaking)] |
| — | AC-H12 | `<EventFlow>` 替换为 `<ChatMessageList>` | ⚠️ EventFlow 已重做样式但未换成 ChatMessageList 组件（非阻塞，渲染效果已对齐设计稿） |

### Phase H3+H4（LLM AI Bridge + AI Speech with Context）✅

- [x] AC-H3: 夜间动作通过 LLM 推理决定（不再是 pickRandom），10s 超时 fallback
- [x] AC-H4: 讨论/遗言/投票理由通过 LLM 生成真实中文文本，有角色特征
- [x] AC-H7: LLM 超时 10s 后降级到 random，游戏不卡住
- [x] AC-H11: LLM 上下文连贯 — 后发言猫的 context 包含前面猫的发言

**改动概要**：
- `LlmAIProvider.ts`（新增）: Anthropic/OpenAI/Google HTTP API 路由，10s 超时
- `GameAutoPlayer.ts`: buildAction 先 LLM 后 random，phase+role 白名单校验
- WerewolfAIPlayer（死代码）激活，连接到 GameAutoPlayer
- messageStore 注入 GameAutoPlayer（3 处）用于 H4 对话上下文
- 237 tests（+2 new regression guards）

### Phase I（Agent-Driven Game — 猫猫真正玩游戏）🚧

team lead 2026-03-20 批评：当前 `GameAutoPlayer` + `LlmAIProvider` 只是裸调 LLM API，猫猫根本不知道自己在玩游戏。三猫（金渐层诊断 + Ragdoll架构 + Maine Coon审查）一致同意重做驱动层。

**P0 前置条件（信息隔离安全加固，Maine Coon审查门禁：不加就不开工）**：
- [x] AC-I-P0a: Session API catId 授权 — `list_session_chain` / `read_session_events` / `read_invocation_detail` 默认只返回调用者自己的 session，防跨猫读取内心独白
- [x] AC-I-P0b: Evidence 索引排除游戏 thread — `threadListFn` 过滤 `projectPath.startsWith('games/')`，游戏内容不入检索
- [x] AC-I-P0c: 游戏行动走结构化工具 `submit_game_action`（gameId/round/phase/seat/action/target/nonce），引擎端做 phase/seat/role/合法性校验；`post_message` 只用于公开发言和叙事播报

**核心功能**：
- [ ] AC-I1: 猫猫通过 A2A mention 协议（`post_message` → dispatch → CLI `--resume`）参与游戏，不再裸调 HTTP API
- [ ] AC-I2: GameNarrator 发叙事消息到游戏 thread（天黑请闭眼 → 守卫请睁眼 → ...），可见节奏
- [ ] AC-I3: 首次唤醒 Briefing — 猫猫收到完整上下文：身份、队友（如有）、存活状况、行动指引、规则约束
- [ ] AC-I4: 后续 Resume Capsule — 导航指引 + 关键摘要 + 搜索提示（KD-35），不做全量状态 dump
- [ ] AC-I5: Session seal 后 re-briefing — 如果 CLI session 因上下文溢出被 seal，新 session 注入完整 resume capsule
- [ ] AC-I6: 讨论环节顺序发言 — 按座位序轮流 @猫猫，后发言者能看到前面猫说了什么
- [ ] AC-I7: 时限从固定相位超时改为每角色预算制（夜晚 45s/角色，讨论 30s/发言者，投票 20s/投票者）+ 全局单局 30min 天花板
- [ ] AC-I8: `GameDriver` 接口兼容层 — `GameAutoPlayer` 包装为 `LegacyAutoDriver`（✅ PR #654），新 `GameNarratorDriver` 实现同接口，feature flag 切换（待做）
- [ ] AC-I9: 游戏 thread 创建时自动设 `thinkingMode: 'play'`（心里话模式），CLI 内思考不广播（KD-36）
- [ ] AC-I10: 端到端验证 — 7 人局完整跑通，猫猫 CLI agent 真正接入，叙事流可观，信息隔离红线测试通过

### Phase H1+H2（报幕层 + 模板发言 + messageStore 双写）✅

- [x] AC-H1: 天亮公告 — `day_announce` 阶段产出 `scope: 'public'` 的 dawn_announce 事件 + messageStore 双写
- [x] AC-H2: 模板发言 — 讨论阶段每只猫提交带文本的 speech 事件 + messageStore 双写
- [x] AC-H8: 规则引擎 bug RB-1~RB-8 修复（SKIP_PHASES 拆分、announce 事件、遗言、exile 公告）
- [x] AC-H9: 所有报幕/发言/投票结果写入 gameThread 的 messageStore

**改动概要**：
- `GameAutoPlayer.ts`: SKIP_PHASES → ANNOUNCE_PHASES 分离 + 模板发言
- `GameOrchestrator.ts`: writeAnnounce/writeSpeech 双写 + resolveLastWords（entering 时机）
- `WerewolfDefinition.ts`: 阶段重排 day_last_words+day_hunter 在 day_exile 之后（⚠️ day_hunter 编排层当前 auto-skip，引擎层保留，需 special resolve phase 接通）
- 3 处 messageStore 注入（games.ts / messages.ts / index.ts）+ observerUserId
- 4 个新 regression guard 测试

### Phase G（AutoPlayer 存活性 — loop 恢复 + 运行时日志）✅
- [x] AC-G1: API 启动时扫描活跃游戏（Redis status=playing），自动恢复 `startLoop()`
- [x] AC-G2: `GameAutoPlayer` 有运行时日志（loop started/tick/action submitted/error/exited）
- [x] AC-G3: team lead开局后 API 重启，游戏自动恢复推进（不卡在"全员等待"）

**根因（2026-03-16 Maine Coon GPT-5.4 + Ragdoll联合定位）**：
- `GameAutoPlayer.startLoop()` 是纯内存异步循环，只在创建游戏时挂一次
- API 进程退出/崩溃后，Redis 里游戏状态还在，但驱动循环丢失
- 前端倒计时是纯本地 `setInterval`，API 死了照样倒到 0，造成"倒计时结束无事发生"假象
- 当前自动行动是本地随机逻辑（`pickRandom`），不是 CLI/LLM — 所以不是"Gemini 启动慢"

### Phase F: 核心体验修复 — 投票/透明度/超时/行动真实性（2026-03-16）

team lead 2026-03-16 实测发现的核心体验 bug。先调研 GitHub agent 狼人杀项目（AIWolf 等），再设计修复方案。

**F1. 调研 + 设计**
- GitHub agent werewolf 项目竞品调研（AIWolf、LLM werewolf 等）
- 重点：多狼投票协调、观战者信息透明度、超时处理、改票机制、行动真实性

**F2. 行动透明度 + God-View 信息丰富**
- 夜间行动提交时立刻写入 event log（scope: `faction:wolf` / `god` / `seat:x`）
- God-view 夜晚时间线实时展示具体行动目标（不只是"已行动"）
- `hasActed` 从二态改为三态：`waiting` / `acting` / `acted`

**F3. 多狼投票 + 白天投票改票**
- 多狼场景：每只狼独立提交 kill target，多数票结算，平票处理
- 白天投票：可改票 + 全员 commit 提前结束 + 实时可见

**F4. 超时 Fallback + 慢猫容错**
- 超时未行动 → 自动 fallback（wolf: 随机杀、seer: 随机查、村民: 弃票）
- 慢启动猫猫（Gemini 等）增加 warmup grace period
- God-view 展示猫猫真实状态：connecting / thinking / timed-out

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "狼人杀这种需要额外制作一个系统的" | AC-A1,A2 | test | [x] |
| R2 | "team lead可以选择当你们的玩家" | AC-B2 | manual | [x] |
| R3 | "也可以选择是上帝视角去观看" | AC-B2 | manual | [x] |
| R4 | "甚至我可以选择我来当法官" | — | v2 | [-] |
| R5 | "不同规则、不同剧本都是怎么样做的" | AC-A1 | test | [x] |
| R6 | "你们是需要开发一个法官" | AC-B1 | test | [x] |
| R7 | "开源仓有蛮多的，如何让 agent 玩起来狼人杀的" | KD-1 | — | [x] |
| R8 | "可能需要用语音玩...开游戏的时候选择要不要让你们用语音玩" | AC-B8 | manual | [x] |
| R9 | "网易的狼人杀的规则，大家知道的多" | AC-B1 | test | [x] |
| R10 | "允许你们说遗言" | AC-B1 | test | [x] |
| R11 | "新建独立 thread，类似新手训练营那样独立" | AC-D1 | manual | [x] |
| R12 | "还是猫猫咖啡的猫猫！！！" | AC-D2 | manual | [x] |
| R13 | "发牌✅ 暂停✅ 踢人❌ 跳过超时✅" | AC-D3 | manual | [x] |
| R14 | "展示真实状态，不是假动画" | AC-D4 | manual | [x] |
| R15 | "猫猫装狼人那种可爱的带点黑色的风格" | AC-D5 | manual+design | [x] |
| R16 | "要战绩统计 + MVP" | AC-D6 | manual | [x] |
| R17 | "只能选择一只猫看他身份，狼人杀观战模式那种" | AC-E1 | manual | [x] |
| R18 | "看不到他们投了谁" | AC-F2 | manual + screenshot | [ ] |
| R19 | "gemini 还没启动起来…30s到及时结束gemini还没行动整个游戏又卡了" | AC-F6, AC-F7 | test + manual | [ ] |
| R20 | "太不透明了…真的有输出吗？几乎秒行动" | AC-F3, AC-F8 | manual + screenshot | [ ] |
| R21 | "到底我们现在是出bug了还是猫猫在吗了" | AC-F8, AC-F7 | manual | [ ] |
| R22 | "票数一样就随机？可以一直改票？以timeout为准？全部commit？" | AC-F4, AC-F5 | test + manual | [ ] |
| R23 | "猫猫 agent 都没接入！能不能想想看人类是如何玩狼人杀的！天黑请闭眼→等待谁行动→真的调 AI Agent" | AC-I1~I9 | E2E + manual | [ ] |
| R24 | "第一次拉起来要告诉身份/队友/状态/怎么行动" | AC-I3 | test | [ ] |
| R25 | "后面 resume 要告诉别人现在什么样子" | AC-I4, AC-I5 | test | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表

### 需求→证据映射

| 需求 | 证据 |
|------|------|
| R1 (游戏系统) | `GameDefinition` / `GameRuntime` / `GameView` 类型体系 + 92 API tests |
| R2 (player 模式) | `GameViewBuilder` humanRole='player' + `humanSeat` 裁剪 |
| R3 (god-view 模式) | `GameViewBuilder` humanRole='god-view' + `GodInspector` 组件 |
| R4 (judge 模式) | v2 scope（KD-5） |
| R5 (可扩展规则) | `GameDefinition` 抽象 + `WerewolfDefinition` 首个实现 |
| R6 (纯代码法官) | `GameEngine` 确定性结算，0 LLM 依赖 |
| R8 (语音模式) | `voiceMode` config + audio rich block 输出 |
| R9 (网易规则) | `WerewolfDefinition` 遵循网易标准 + 无警长竞选 |
| R10 (遗言) | `day_last_words` phase ✅ + `day_hunter` shoot ⚠️ deferred（引擎层支持但编排层需 special resolve phase，见 TODO） |

## Dependencies

- **Evolved from**: F011（模式系统 v1 — brainstorm/debate/dev-loop）
- **Related**: F086（Cat Orchestration — multi_mention 可复用于游戏内猫猫协作）
- **Related**: F066（Voice Pipeline — 语音模式复用 TTS 能力）
- **Related**: F103（Per-Cat Voice Identity — 多猫语音模式需要独立声线）

## Risk

| 风险 | 缓解 |
|------|------|
| 信息隔离不严导致"作弊" | 服务端 scope 裁剪 + 红线测试（AC-A6, AC-B4） |
| 猫猫 LLM 不遵守游戏规则（自然语言泄露身份） | 结构化动作强制 function call，发言内容由 LLM 自主但不影响结算 |
| 删除旧 mode 影响现有 thread | 旧 mode 几乎没人用，直接清理 |
| 游戏状态丢失（进程重启） | Redis 持久化 + append-only event log 可重放（AC-A4, AC-B6） |
| 前端复杂度高 | Phase B5 与Siamese协作，先组件化再组合 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 借鉴 AIWolf 协议边界，不抄 prompt | AIWolf 的 vote/attack/guard/divine + talk/whisper 分离 + 服务器驱动生命周期最成熟 | 2026-03-11 |
| KD-2 | 法官 = 纯代码 GameEngine，不用 LLM | 规则裁判必须确定性，LLM 只做发言策略 | 2026-03-11 |
| KD-3 | 信息隔离 = 服务端 scoped event log + 视图裁剪 | 前端子 Thread 只做 UX 呈现，真相源在 server | 2026-03-11 |
| KD-4 | seat/actor/role 三层分离 | seat=位置, actor=实体(人/猫), role=游戏角色，让人类和猫在架构上完全对称 | 2026-03-11 |
| KD-5 | v1 只做 player + god-view，judge 放 v2 | judge 模式 scope 翻倍，v1 先跑通核心 | 2026-03-11 |
| KD-6 | 旧三 mode **直接删除**，不做兼容 | team lead拍板：面向终态开发，垃圾清掉 | 2026-03-11 |
| KD-7 | 角色配置可自定义 | team lead开局选角色组合，默认 7 人局 | 2026-03-11 |
| KD-8 | 超时 3-5 分钟，全员提交可提前进入下阶段 | 猫猫推理慢（几秒不够），但全员完成不用空等 | 2026-03-11 |
| KD-9 | 网易狼人杀规则，无警长竞选 | 大家都熟悉的规则 | 2026-03-11 |
| KD-10 | 有遗言阶段 | team lead确认 | 2026-03-11 |
| KD-11 | 语音模式可选 | 开局选文字/语音，语音模式猫猫用 audio rich block 发言 | 2026-03-11 |
| KD-12 | 全屏接管布局 | 进入游戏后收掉左侧大厅+右侧状态栏，狼人杀专属全屏体验 | 2026-03-11 |
| KD-13 | 玩家 C 方案 + 上帝 C 变体 + 夜间无泄露 | 顶部局势带+中间事件流+底部操作区；上帝加右侧 God Inspector 30%；夜间不显示行动进度数字 | 2026-03-11 |
| KD-14 | 头像复用现有 CatAvatar 系统，不做独立管线 | 见下方「头像系统调查」，已有完整的 catId→avatar 解析链，游戏内 PlayerGrid 直接用 `/avatars/{catId}.png` + `CatAvatar.tsx` fallback | 2026-03-11 |
| KD-15 | 同一 thread 单局，不做多局并发 | team lead拍板：一个 thread 只跑一局游戏，想开新局就新 thread | 2026-03-11 |
| KD-16 | 游戏战绩对接 Leaderboard（F075） | 所有游戏模式（狼人杀/三国杀/猜猜我是谁等）统一接入现有排行榜系统，历史战绩通过排行榜查看 | 2026-03-11 |
| KD-17 | 技术细节（断线重连/AI策略等）找 gpt52 讨论，不找team lead | team lead："涉及技术你找 GPT-5.4 讨论都比我靠谱" | 2026-03-11 |
| KD-18 | 游戏在独立 thread 运行，归档分类 `游戏-狼人杀` | team lead希望游戏和日常聊天完全隔离 | 2026-03-14 |
| KD-19 | 猫猫保留咖啡馆身份，不需要新 persona | team lead："还是猫猫咖啡的猫猫！！！" | 2026-03-14 |
| KD-20 | 上帝面板：发牌+暂停+跳过，**不要踢人** | team lead："太过分了 猫猫做错什么了" | 2026-03-14 |
| KD-21 | 展示真实 ready 状态，不做假动画 | team lead担心猫猫卡住看不到 | 2026-03-14 |
| KD-22 | 狼人猫猫风 UX = 可爱+暗色调+猫猫 cosplay 狼人 | team lead："猫猫装狼人那种可爱的带点黑色的风格" | 2026-03-14 |
| KD-23 | 结算画面：胜负+统计+MVP | team lead确认 | 2026-03-14 |
| KD-24 | 上帝推理模式（Detective Mode）列入 Phase E | 观战者绑定单座位视角，增加悬念和代入感，不在 Phase D scope | 2026-03-15 |
| KD-25 | 平票 = no_kill（空刀），默认保守 | team lead："no_kill 好像确实？一般是这样！" | 2026-03-16 |
| KD-26 | 白天投票实名公开（实时可见） | team lead："要公开吧？这是推理的重要信息" | 2026-03-16 |
| KD-27 | 狼队 faction channel 讨论 — 只在夜间，讨论时间需考虑猫猫 LLM 响应速度 | team lead确认要做，担心猫猫"大屁股太慢了"讨论不完 | 2026-03-16 |
| KD-28 | 狼队讨论 30s + 投票在同一阶段；首回合 grace：Ragdoll +6s / Maine Coon +12s / Siamese +30s | team lead确认 30s 可以，"走起" | 2026-03-16 |
| KD-29 | 猫猫通过 A2A mention 协议参与游戏，不再裸调 HTTP API | team lead批评"猫猫 agent 都没接入"——`LlmAIProvider` 只是无状态 HTTP 调 LLM，猫猫根本不知道自己在玩游戏。三猫（金渐层诊断 + Ragdoll架构 + Maine Coon审查）一致同意 | 2026-03-20 |
| KD-30 | 保留 WerewolfEngine 规则引擎，只重写驱动层（GameAutoPlayer → GameNarratorDriver） | 规则核 + 信息隔离层 + 事件日志已验证，只有"谁来驱动猫猫行动"需要重做 | 2026-03-20 |
| KD-31 | 驱动契约兼容层 — 抽 `GameDriver` 接口，新旧 driver 实现同契约，feature flag 切换 | Maine Coon审查发现 `GameAutoPlayer` 被 routes/startup/recovery 硬依赖，直删会破主流程（P1 风险） | 2026-03-20 |
| KD-32 | 时限从固定相位超时改为每角色预算制 | Maine Coon审查发现顺序唤醒猫猫（30-60s/只）会和当前固定 180s/120s 相位超时冲突，导致误 fallback（P1 风险） | 2026-03-20 |
| KD-33 | 复用现有 `invoke-single-cat.ts` session 管理，同 thread = 同 session chain（自动 resume） | team lead提醒"CLI new session vs resume 别搞错"——游戏在独立 thread，`sessionManager.get(userId, catId, threadId)` 天然按 thread 隔离 session | 2026-03-20 |
| KD-34 | Session seal 后必须注入完整 re-briefing（不假设猫猫还记得） | resume 时默认不注入 systemPrompt，briefing 放在消息内容里；session seal 后新 session 需完整 resume capsule | 2026-03-20 |
| KD-35 | Resume capsule = 导航指引 + 关键摘要 + 搜索提示，不做全量状态 dump | team lead指出猫猫有 MCP 搜索 thread 能力（search_evidence / get_thread_context / read_session_events）。Resume 时给关键信息（身份/阶段/存活）+ 提示猫猫主动搜索 thread 历史恢复策略记忆。这考验每只猫的搜索和上下文恢复能力——更像人类凭记忆+回忆玩游戏 | 2026-03-20 |
| KD-36 | 信息隔离 = 心里话模式（`thinkingMode: 'play'`），不需要额外 MCP 权限层 | team lead指出：CLI 内 = 心里话（`origin: 'stream'`，play 模式不 broadcast），`post_message` = 说话（`origin: 'callback'`，进入 thread）。游戏 thread 全程 play 模式，猫猫内心推理天然私密，只有 post_message 发出的才是公开/定向消息。比"三层 MCP 过滤"优雅得多 | 2026-03-20 |
| KD-37 | 游戏 thread 不入 evidence 索引 | team lead指出：写代码的猫搜狼人杀搜出游戏内容很奇怪。`threadListFn` 应过滤 `projectPath.startsWith('games/')` 的 thread，不送入 IndexBuilder | 2026-03-20 |
| KD-38 | 游戏行动走结构化 MCP 工具 `submit_game_action`，不走 `post_message` whisper | Maine Coon审查：自由文本解析不可靠，whisper scope 和游戏 scope 不完全对齐。结构化工具带 `gameId/round/phase/seat/action/target/nonce`，引擎端做完整校验。`post_message` 只用于公开发言和叙事播报 | 2026-03-20 |
| KD-39 | Session API 加 catId 授权（P0 安全加固） | Maine Coon审查实锤：`list_session_chain` + `read_session_events` 按 userId 授权不按 catId，狼人可读预言家完整 session 内心独白。必须封堵后才能推进 Phase I | 2026-03-20 |
| KD-40 | 信息隔离四层架构：play 模式（心里话不广播）+ Session catId 授权 + Evidence 索引排除 + 结构化行动工具 | play 模式只防 WebSocket broadcast（Layer 1），不是唯一隔离层。需要 Session 权限（Layer 2）+ 索引排除（Layer 3）+ 行动分流（Layer 4）形成完整防线。Maine Coon门禁：Layer 2+3 不加就不放行 | 2026-03-20 |

## 头像系统调查（KD-14 依据）

> 2026-03-11 调查，team lead指出 @ 弹出面板已有完整头像映射

### 现有系统数据流

```
cat-config.json (breeds[].avatar + variants[].avatar)
    ↓
API: GET /api/cats（routes/cats.ts）
    ↓
useCatData() hook（hooks/useCatData.ts:59-69）
    ↓
buildCatOptions()（chat-input-options.ts:21-32）→ CatOption.avatar
    ↓
ChatInputMenus.tsx:50  <img src={opt.avatar} />
CatAvatar.tsx:44       src={cat?.avatar ?? `/avatars/${catId}.png`}
    ↓
packages/web/public/avatars/*.png（静态文件服务）
```

### 可用头像文件（`packages/web/public/avatars/`）

| catId | 文件名 | 说明 |
|-------|--------|------|
| opus | `opus.png` | Ragdoll Opus 4.6（紫垫子） |
| sonnet | `sonnet.png` | Ragdoll Sonnet（坐在玻璃杯里） |
| opus-45 | `opus-45.png` | Ragdoll Opus 4.5（躺在纸箱里，紫项圈） |
| codex | `codex.png` | Maine Coon Codex（GPT 铭牌） |
| gpt52 | `gpt52.png` | Maine Coon GPT-5.4（趴在 RGB 键盘上） |
| spark | `sliced-finial/codex_box.png` | Maine Coon Spark |
| gemini | `gemini.png` | Siamese Gemini（蓝垫子+画笔） |
| gemini25 | `gemini25.png` | Siamese Gemini 2.5 |
| dare | `dare.png` | 狸花猫 Dare |
| antigravity | `antigravity.png` | 孟加拉猫（豹纹+棱镜吊坠） |
| owner | `owner.jpg` | team lead（`You.png` 在 assets/avatars/ 也有一份海豚版） |

### 游戏集成方案

GameView 的 `SeatView` 只需携带 `actorId`（= catId），前端直接用 `<CatAvatar catId={seat.actorId} />` 渲染，**零额外开发**。team lead的 seat 用 `owner` 作为 actorId，fallback 到 `/avatars/owner.jpg`。

设计稿里的座位命名规范：`{昵称}-{模型简称}`（如"Ragdoll-Opus"、"Maine Coon-GPT"），与 @ 面板一致。

## Review Gate

- Phase A: Maine Coon review（安全重点：信息隔离 + 非法动作拒绝）
- Phase B: Maine Coon review + Siamese design review（前端组件）
