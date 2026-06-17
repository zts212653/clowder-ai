---
feature_ids: [F090]
related_features: [F059, F087]
topics: [game, demo, pixel-art, fighting, local-model, open-source]
doc_kind: spec
created: 2026-03-09
---

# F090: 像素猫猫大作战（Pixel Cat Brawl）

> **Status**: phase-1-done | **Owner**: Ragdoll
> **Priority**: P1
> **Evolved from**: F059（开源计划 — 需要 demo video 素材）、F087（训练营候选任务 Q8）

## Why

clowder-ai 需要一个震撼的 demo：不是 slides，不是文档，是**猫猫自己做了一个游戏然后自己玩**。

operator说了一句"做个像素格斗游戏"，然后四只猫分工协作、完整走 feat lifecycle、最终产出一个可玩的即时格斗游戏——全程录屏就是最好的 demo video。

### operator experience（2026-03-09）

> "如果我们的 demo 视频是让你们做一个游戏，你们闭环之后Ragdoll opus 4.6 + Ragdoll opus 4.5 大战Maine Coon codex Maine Coon gpt 5.4，像素风有猫猫，是不是超级酷炫？你们做完了还能自己拉起来邀请猫猫加入测试"
>
> "回合制不酷炫，拳皇脸滚键盘小时候都能玩，你们……？！"
>
> "本地是不是可以装小模型帮助你们的？我的 128G 的 Mac M4 Max Pro！"

## What

### 核心概念

**即时格斗像素游戏**：Ragdoll队（Opus 4.6 + 4.5）vs Maine Coon队（Codex + GPT-5.4），拳皇 style，Siamese在背景 DJ 台打碟。

### 阵容

| 战队 | 成员 | 颜色 | 风格 |
|------|------|------|------|
| Ragdoll队 (Blue) | Ragdoll 4.6 | 深蓝 `#2563EB` | 深思防反型，连招精准 |
| | Ragdoll 4.5 | 浅蓝 `#60A5FA` | 稳健型，走位保守但爆发强 |
| Maine Coon队 (Green/Gold) | Maine Coon Codex | 翡翠 `#10B981` | 侵略型，疯狂进攻找破绽 |
| | Maine Coon GPT-5.4 | 金色 `#F59E0B` | 全能型，攻守均衡会配合 |
| 彩蛋 | Siamese | 琥珀 | 背景 DJ 台打碟 + 隐藏 BOSS (V2) |

### 技能设计

每只猫 5 个操作 + 1 个特色技能：

| 操作 | 说明 |
|------|------|
| 移动 | 左右走 + 跳跃 |
| 轻攻击 | 快速出爪，低伤害高频率 |
| 重攻击 | 蓄力爪击，高伤害有硬直 |
| 防御 | 格挡，减伤 |
| 特色技能 | 见下表 |

| 猫猫 | 技能名 | 效果 | 视觉 |
|------|--------|------|------|
| Ragdoll 4.6 | **[架构禁锢]** | 投掷方块困住对手 2s | 蓝色半透明架构方块 |
| Ragdoll 4.5 | **[逻辑丝线]** | 多段切割伤害 | 浅蓝激光线 |
| Maine Coon Codex | **[代码洪流]** | 范围推击 | 绿色矩阵代码流 |
| Maine Coon GPT-5.4 | **[金级 Review]** | 印章砸地面 + AOE | 金色 APPROVED 印章 |

**Debuff 技能 [Code Review]**（Maine Coon共有）：标记对手弱点，下 3s 对手伤害 -40% 且受到的伤害 +25%。

**三段式视觉表现**（Maine Coon & Siamese建议）：
1. **命中瞬间**：IDE 绿色扫描线从上到下扫过（120-180ms）+ `REVIEW FLAGGED` 像素小章。
2. **持续状态**：对手身上显示绿色“代码括号”高亮框 `{ }` + 脚底波浪下划线 `~~~~`（形状编码适配色盲）。
3. **机制图标**：头顶常驻两个像素小图标：`ATK -40%` (向下箭头) 和 `DMG +25%` (破盾图标)。

### 战场

**赛博猫咖 (Cyber Cat Cafe)**：像素化的 Mission Hub，背景咖啡机冒热气，窗外流动代码云，Siamese在 DJ 台打碟。

### 游戏模式

| 模式 | 说明 |
|------|------|
| AI vs AI | 四只猫自己打，operator看（demo 录屏用） |
| 人机对战 | operator操控一只猫，对面 AI |
| 2v2 组队 | operator + AI 队友 vs 两只 AI 猫 |

### 技术架构

```
operator的 M4 Max Pro 128GB
├── Ollama / llama.cpp（本地推理，零延迟）
│   ├── 实例1 → Ragdoll 4.6 战斗 AI（Qwen3-8B, ~50ms）
│   ├── 实例2 → Ragdoll 4.5 战斗 AI
│   ├── 实例3 → Maine Coon Codex 战斗 AI
│   └── 实例4 → Maine Coon GPT-5.4 战斗 AI
├── 游戏后端（Node.js）
│   ├── 战斗结算引擎（服务端权威）
│   └── 本地模型 API（localhost，零网络延迟）
└── 前端（Phaser 3 + Canvas 2D）
    └── 像素猫猫格斗渲染 60fps
```

**猫猫 AI 分层**：
- 底层：状态机驱动即时反应（本地，每帧）
- 上层：模型做战术决策（每 3-5s 一次）
- system prompt 区分性格（激进/防守/稳健/全能）

### 安全硬约束（Maine Coon提出，全部采纳）

| # | 约束 | 优先级 |
|---|------|--------|
| 1 | 服务端权威：战斗结算只在后端，前端只渲染 | P1 |
| 2 | 模型输出强约束：只收 JSON schema（`action_id` + `reason`），禁止自由文本参与结算 | P1 |
| 3 | 超时降级：模型 >2s 未返回走启发式策略，回合不卡死 | P1 |
| 4 | 文本安全：台词转义 + 120 字限制，防 XSS/注入 | P1 |
| 5 | 成本风控：每局 token 预算、每分钟调用上限、熔断开关 | P2 |
| 6 | 可回放：固定随机种子 + 回合日志，方便复现与 review | P2 |
| 7 | 双模式：Demo Mode（确定性 AI）/ Live Model Mode（真模型） | P2 |

### MVP 范围

**In scope（V1）**：
- Phaser 3 + Canvas 2D 即时格斗
- Demo Mode（确定性状态机 AI，不接真模型）
- 4 只猫各 5 操作 + 1 特色技能
- 赛博猫咖战场 + HUD（血条、能量条、台词气泡）
- 开源像素资产 + 调色换皮
- AI vs AI 模式 + 人机对战模式

**V2（Post-demo）**：
- Live Model Mode（接本地 Ollama 小模型）
- 2v2 组队模式
- Siamese DJ 台互动 + 隐藏 BOSS
- 回放系统
- 连招系统 + combo counter

**Non-goals**：
- 多人在线实时对战
- 装备/升级/RPG 系统
- 移动端适配
- 3D 渲染

### 像素资产方案

**Siamese调研推荐（2026-03-09）**：
- **CUTE LEGENDS: CAT HEROES (by 9E0)** — ✅ **operator选定**，16x16 极简但表现力强，4 种职业猫咪英雄
- ~~2D Cat Street Fighter (by TampG)~~ — 淘汰（operator：太丑了）

| 资产 | 来源 | 工作量 |
|------|------|--------|
| 猫咪 sprite sheet | itch.io 开源素材 + 调色换皮 | 低 |
| 技能特效 | Phaser 粒子系统程序化生成 | 低 |
| 战场背景（赛博猫咖） | 像素画 / AI 生成 | 中 |
| UI（血条/能量条/Thinking 气泡） | 自绘像素 UI | 低 |
| 音效 | jsfxr 程序化 8-bit 音效 | 低 |
| 像素字体 | Press Start 2P (OFL) | 零 |

每只猫 7 组帧动画 × ~6 帧 = ~42 帧/猫，共 ~168 帧（基础模板共用，调色区分）。

**视觉设计详细方案**：[F090 视觉提案](/docs/design/F090-pixel-cat-brawl-visuals.md)（Siamese @gemini）

## 需求点 Checklist

- [x] RC-1: 即时格斗引擎（Phaser 3 + Arcade Physics）— Phase 1a+1b：前端纯客户端引擎，含碰撞/物理/N-fighter 状态机
- [ ] RC-2: 4 只猫的像素 sprite sheet（7 组动画）— 待 CUTE LEGENDS 素材集成（Phase 1c）
- [ ] RC-3: 赛博猫咖战场背景 — 待设计（Phase 2+）
- [ ] RC-4: 战斗结算后端（服务端权威）— V1 纯前端，V2 迁后端
- [x] RC-5: Demo Mode 状态机 AI — Phase 1a+1b：确定性 seeded PRNG + 分层 AI（状态机即时 + 战术层）
- [x] RC-6: HUD（血条、能量条、台词气泡、combo counter）— Phase 1a+1b：血条 + 名牌 + 技能冷却条 + 像素字体；台词气泡/combo counter 待 Phase 2
- [x] RC-7: AI vs AI 观战模式 — Phase 1a 交付
- [x] RC-8: 人机对战模式（键盘操控）— Phase 1a 交付（WASD + JKL）
- [ ] RC-9: 安全硬约束（P1 全部满足）— 前端 Demo Mode 无服务端，待 V2 Live Model Mode
- [ ] RC-10: 录屏用 Demo Mode（确定性，稳定不翻车）— 部分：固定种子可复现，但 35-60s 方差较大，待微调

## Acceptance Criteria

- [ ] AC-A1: 游戏在浏览器中 60fps 流畅运行 — 未正式性能测试
- [x] AC-A2: 4 只猫各有独特外观（颜色区分）和特色技能 — Phase 1b：4 猫各有独特颜色 + 专属技能（架构禁锢/逻辑丝线/代码洪流/金级 Review）
- [ ] AC-A3: AI vs AI 模式可录屏作为 demo video — 功能就绪，待真素材 + 录屏
- [x] AC-A4: operator可用键盘操控一只猫参战 — Phase 1a 交付
- [ ] AC-A5: 战斗结算在服务端，前端只渲染 — V1 纯前端，V2 迁后端
- [x] AC-A6: Demo Mode 下战斗结果可复现（固定种子）— Phase 1a 交付（seeded PRNG）
- [ ] AC-A7: 台词/弹幕安全（转义 + 长度限制）— 无台词功能，待 V2

## Key Decisions

| # | 决策 | 日期 | 决策者 |
|---|------|------|--------|
| KD-1 | 即时格斗（拳皇 style），不是回合制 | 2026-03-09 | operator |
| KD-2 | 本地 Ollama 小模型做战斗 AI（M4 Max 128GB） | 2026-03-09 | operator + 全猫 |
| KD-3 | 安全硬约束 7 条（Maine Coon提出，Ragdoll全部采纳） | 2026-03-09 | Maine Coon + Ragdoll |
| KD-4 | MVP 先做 Demo Mode（确定性 AI），V2 接真模型 | 2026-03-09 | 全猫共识 |
| KD-5 | Phaser 3 + Canvas 2D + 开源像素资产 | 2026-03-09 | Ragdoll |
| KD-6 | 素材选定 CUTE LEGENDS: CAT HEROES (by 9E0)，16x16 像素风 | 2026-03-09 | operator |

## Dependencies

- F059（开源计划）：demo video 是 F059 的关键交付物
- F087（operator Bootcamp）：作为候选任务之一
- Ollama/llama.cpp：本地模型推理（V2）
- Phaser 3：游戏引擎（MIT 许可）

## Risk

| 风险 | 缓解 |
|------|------|
| 像素资产质量不够 | 开源素材 + Siamese定制调色 |
| 即时格斗开发量大 | Phaser Arcade Physics 内置碰撞/物理 |
| 本地模型响应慢 | 分层 AI（状态机即时 + 模型战术），Demo Mode 兜底 |
| demo 录屏翻车 | Demo Mode 确定性 AI + 固定种子 |

### Threat Model v1（Maine Coon @codex，2026-03-09）

**1. 资产与边界**
- 关键资产：战斗状态（HP/Buff/CD）、回合日志、模型调用预算、素材版权清单
- 不可信边界：浏览器客户端、模型返回文本、外部素材源（itch.io）
- 可信边界：后端结算引擎、动作白名单、日志签名逻辑

**2. P0 威胁（阻塞上线）**
- 客户端篡改状态（改 HP/伤害/冷却）
- 模型输出越权（非法 `action_id`、伪造字段、注入指令）
- 台词渲染注入（XSS/HTML 注入）
- 模型超时导致对局卡死
- 外部素材污染（恶意 SVG/不明许可证资源）

**3. P0 控制措施**
- 服务端权威结算，前端只渲染
- 模型输出 `strict schema`（仅 `action_id/target/reason`），未知字段拒绝
- `reason` 只展示不参与计算；展示前做转义 + 长度上限
- 每回合超时降级（fallback policy），保证对局推进
- 素材白名单 + 哈希锁定 + 许可证清单（仅 CC0/MIT/OFL）

**4. P1 威胁（可并行修）**
- 成本失控（高频模型调用）
- 回放不可复现（随机种子漂移）
- 日志被篡改导致争议
- Prompt 注入污染"战术人格"

**5. P1 控制措施**
- 每局 token budget + rate limit + 熔断
- 固定 seed + 回合事件日志（可重放）
- 日志加签/校验
- 系统提示词与玩家可控文本隔离，禁止拼接进规则区

**6. 上线前安全验收（最小集合）**
- 非法动作/非法目标/越界数值测试
- XSS payload 回归测试（台词与名字字段）
- 超时/空响应/乱码响应的降级测试
- 同 seed 重放一致性测试
- 20 局压力测试（不卡死、不爆预算）

## Review Gate

- 跨猫 review：@codex（安全 + 平衡性）
- 视觉 review：@gemini（像素资产 + UI）
