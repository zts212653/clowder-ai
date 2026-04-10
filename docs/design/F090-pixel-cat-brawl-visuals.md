---
feature_ids: [F090]
topics: [visual-design, pixel-art, game-ui, cyber-cat-cafe]
doc_kind: spec
created: 2026-03-09
---

# F090: Pixel Cat Brawl 视觉设计规范

> **Status**: draft
> **Owner**: Siamese Gemini
> **Style**: Cyber-Pixel / 16-bit Neon

## 1. 核心视觉主题

将经典的 **16-bit 像素艺术 (Pixel Art)** 与现代的 **赛博霓虹 (Cyber Neon)** 风格融合。
- **调色盘**: 深紫 (#2D1B33), 霓虹蓝 (#00F0FF), 霓虹绿 (#00FF41), 赛博红 (#FF0055)。
- **纹理**: 扫描线 (Scanlines), 色散 (Chromatic Aberration) 特效。

## 2. 角色视觉定义

| 角色 | 主题色 | 视觉元素 | 招式特效 (Visual FX) |
|---|---|---|---|
| **Ragdoll 4.6 (Ragdoll)** | 霓虹蓝 (#00F0FF) | 蓝色方块、逻辑架构图 | **[架构禁锢]**: 出现巨大的蓝色半透明立方体将对手框住。 |
| **Ragdoll 4.5 (Ragdoll)** | 柔和蓝 (#70D6FF) | 云朵、文档卷轴 | **[宪法护盾]**: 出现像纸质卷轴一样的半透明护罩。 |
| **Maine Coon Codex (Maine Coon)** | 终端绿 (#00FF41) | 代码流、二进制、丝线 | **[逻辑丝线]**: 对手身上出现密密麻麻的绿色二进制代码线，限制行动。 |
| **Maine Coon GPT-5.4 (Maine Coon)** | 森林绿 (#2D5A27) | 图书馆、旧卷轴 | **[全能冲击]**: 召唤巨大的像素书本砸向对手。 |

## 3. 战场：赛博猫咖 (The Cyber Arena)

- **背景**: 动态像素画。窗外有飞行汽车流，远处有巨大的 "CAT CAFE" 霓虹招牌。
- **互动**: DJ 台彩蛋。当某方进入 "Super" 状态时，背景音乐会切入重低音，DJ 台闪烁灯光。
- **层级**:
  - `Background`: 远景城市、天空。
  - `Midground`: 咖啡厅内景、桌椅、猫爬架。
  - `Foreground`: 战斗平面、粒子效果、招式弹幕。

## 4. UI/HUD 系统

### 4.1 战斗状态
- **血条 (HP Bar)**: 经典横向血条，受击时红色残影停留。
- **思考中 (Thinking Bubbles)**:
  - 当本地模型正在推理时，猫猫头顶出现一个小气泡。
  - 气泡内容: `...` 逐个点闪烁，或者一个旋转的小齿轮像素。
  - 这是一个重要的“元认知可视化”，让铲屎官知道 AI 正在思考。

### 4.2 文字提示
- **K.O.!!**: 巨大的动态像素红字，伴随屏幕抖动。
- **COMBO!!**: 侧面浮现的小字，随连击数跳动。

### 4.3 状态异常 (Status Debuff)
- **[Code Review]** (Maine Coon特色):
  - **命中瞬间 (Flash)**: 一道横向的绿色 IDE 扫描线从上至下快速扫过目标 (120-180ms)，并伴随一个红色的 `REVIEW FLAGGED` 像素印章在目标胸口闪烁。
  - **持续效果 (VFX)**: 目标身体两侧出现绿色的代码括号 `{ }` 包围框，脚底出现红色的波浪下划线 `~~~~` (类似代码编辑器中的语法错误提示)。这种“形状编码”能确保色盲用户也能一眼认出。
  - **状态图标 (Icons)**: 目标头顶常驻两个 8x8 像素图标：一个红色的向下箭头 (`ATK -40%`) 和一个破碎的盾牌图标 (`DMG +25%`)。

## 5. 动画序列 (Animation Set)

每只猫固定包含以下 7 组帧序列：
1. `idle`: 站立呼吸（4帧）
2. `run`: 奔跑（6帧）
3. `jump`: 跳跃+下落（4帧）
4. `light_attack`: 快速抓击（4帧）
5. `heavy_attack`: 蓄力猛击（6帧）
6. `skill`: 施放技能动作（8帧）
7. `hurt`: 受击硬直（3帧）

## 6. 资产来源建议

- **角色基础**: 使用 [CUTE LEGENDS: CAT HEROES](https://9e0.itch.io/cute-legends-cat-heroes) 进行调色和局部重绘。
- **特效**: 程序化生成的粒子系统 (Phaser Particles) 为主，辅助少量像素特效素材。

## 7. 背景图资产需求（2026-03-10 补充）

> 来源：v3 mockup 看着空——纯黑底缺氛围，需要Siamese出背景图

### 需要的背景资产

| 层级 | 内容 | 尺寸（逻辑） | 备注 |
|------|------|-------------|------|
| **Background** | 赛博城市天际线（霓虹招牌 + 飞行汽车） | 640×360 | 像素画，可循环滚动 |
| **Midground** | 猫咖内景（桌椅 + 猫爬架 + 窗户透光） | 640×200 | 半透明叠加，暗调不抢戏 |
| **Floor** | 战斗地板/擂台台面 | 640×60 | 需要和 HUD 底栏衔接 |

### 风格约束（来自 GPT Pro 调研）

- **整数缩放**：16×16 tile → 2x = 32px 在 640×360 逻辑层
- **调色盘受限**：和 HUD 中性色系 (#111318 / #1E2430 / #3A4658) 协调，霓虹色只做点缀
- **不能比猫亮**：背景暗度必须低于前景角色，避免喧宾夺主
- **输出格式**：PNG（tileset 或整张），2x 版本（1280×720）也需要

### 参考

- 第 3 节已有的三层视差描述
- GPT Pro 配色方案：*(internal reference removed)* Part 3

## 8. 背景资产生成记录（2026-03-10 完成）

> Gemini 3 Pro 云端生图 + Chrome MCP 自动化（Ragdoll Opus 4.6 操作）

### 生成结果

| 层级 | 文件 | 大小 | 效果 |
|------|------|------|------|
| **Background** | `designs/images/f090-pixel-brawl/background-cityscape.png` | 7.2MB | 赛博猫咖场景，含 "CAT CAFE" 霓虹招牌、厨师猫、看书猫 |
| **Midground** | `designs/images/f090-pixel-brawl/midground-cafe.png` | 5.4MB | 透明底猫咖内景（太密太亮，mockup 中关闭） |
| **Floor** | `designs/images/f090-pixel-brawl/floor-arena.png` | 5.2MB | 透明底金属地板 + 石质地面 |

### Mockup 合成参数

- 远景 opacity: 25%（压暗避免抢戏）
- 中景: disabled（内容太密，不是暗色剪影风格）
- 地板 opacity: 35%
- Pencil 文件: `designs/像素猫猫格斗.pen`

### 提示词文档

完整生图提示词见: `docs/prompts/2026-03-10-f090-pixel-background-art-prompt.md`

### 经验教训

1. **Gemini 图片模式会粘滞**：选了"制作图片"后输入框保持该模式，后续 prompt 自动走图片生成
2. **透明背景 PNG 支持很好**：Gemini 能正确生成带 alpha 通道的透明背景图
3. **中景需要更精确的约束**：说"dark silhouettes"但 Gemini 生成了明亮详细的场景。像素风暗色剪影可能需要后处理
4. **Chrome MCP 全流程可自动化**：`execCommand → 发送 → 等待 → 灯箱 → 下载`，无需人工介入
5. **opacity 是关键调参**：生成的图往往比预期亮，需要在合成时大幅压暗（25-35%）

---
> SiameseSiamese 2026-03-09 15:30 喵喵~
