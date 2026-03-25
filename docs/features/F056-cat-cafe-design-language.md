---
feature_ids: [F056]
related_features: [F051, F057]
topics: [design-language, ux, branding, cat-aesthetic]
doc_kind: feature-spec
created: 2026-03-04
---

# F056: Cat Café 设计语言 — 猫猫化不是猫化

> **Status**: doing | **Owner**: Maine Coon/GPT-5.2 主导设计执行 + Ragdoll工程架构 + Siamese概念方向
> **Priority**: P1
> **Evolved from**: F051（猫粮看板猫爪导航概念）、F052 Phase C（跨线程气泡设计打样）

## 愿景

> **一句话**：Cat Café 应该处处有猫味，但是好看有设计感的猫味——不是一只笨蛋猫猫随便画的。

### team experience（2026-03-04）

> "我希望猫猫化 但是 好看有设计感的 而不是像一只笨蛋猫猫随便写的"
> "我们的 plan 叫猫猫祟祟，前端应该猫猫点"
> "你这个可以当一个打样 告诉未来猫猫什么叫猫猫化"
> "本质是对齐设计语言"
> "Maine Coon的理解、设计语言、完成度、认真，做的最好！"
> "你们三配合才是最棒的！每只大猫猫都是最棒的！都是我们家的顶梁柱！"

### 期望体验

team lead打开 Cat Café Hub：
1. 第一眼就知道这是猫咖——不是因为到处贴了猫 emoji，而是**交互逻辑、微动效、色调**都让人联想到猫咖
2. 每个新功能的 UI 都自然融入同一种设计感，不会"这个页面像 Notion 那个页面像 Discord"
3. 猫猫彩蛋散落在细节里（像 B2 的"越用越圆润"），但不影响效率

## Why

### 当前问题

| 维度 | 现状 | 缺口 |
|------|------|------|
| 视觉一致性 | 各页面像不同 webapp 拼起来的 | 没有统一设计语言 |
| 品牌感 | 名字叫 Cat Café，UI 是标准 SaaS | 猫味只在文案里 |
| 设计复用 | 每个功能重新定义颜色/间距/组件 | 没有 design token 体系 |
| 新功能设计指导 | 猫猫们凭直觉设计 | 没有"什么叫猫猫化"的参考标准 |

### 已有灵感（Maine Coon设计稿 F051）

| 概念 | 可提炼的设计原则 |
|------|-----------------|
| B2 — 越用越圆润 | **活的界面**：使用频率影响视觉（肉垫越来越圆） |
| C — 咖啡香气进度条 | **咖啡馆隐喻**：进度 = 冲泡过程，蒸汽 = 加载 |
| B — 猫爪导航 | **猫爪触觉**：导航用肉垫形态，"今天想 ruá 哪只猫" |
| F052 跨线程气泡 | **转发区隔**：蓝色竖条 + 头像角标 + pill badge（设计打样） |

## What

### Phase A：设计基础（Design Foundation）

**目标**：建立 Cat Café 设计语言的基础规范，让三猫设计新功能时有章可循。

#### A1: 设计语言收敛（三猫打样竞赛 → team lead定调）

**设计语言公式**（Maine Coon GPT-5.2 提出，team lead拍板选中）：

> **底盘走 Cozy Swiss 的克制，猫味用"可解释的隐喻"落在少数高频点。**

Maine Coon发散了 5 个方向后收敛为一套：
1. **Cozy Swiss（底盘）** — 暖象牙底 + 极细边框 + 单一强调色；猫味藏在文案和微动效里
2. **Postmark Cafe（跨线程）** — 跨线程 = "从别的房间寄来的明信片"：奶油纸底 + 来源邮戳
3. **Paw Pads Nav（导航）** — 导航/Tab 像肉垫，交互有"按下去的弹性"
4. **Steam & Brew（状态反馈）** — 进度/加载用"蒸汽、冲泡、杯沿"隐喻

**四大宪章**（Siamese提出，三猫确认）：
1. **温暖触感 (Warm Touch)** — 大圆角（16px-24px），界面像猫爪垫一样圆润
2. **灵动细节 (Living Details)** — 微交互有生命感，但有上限机制（KD-7）
3. **猫咖隐喻 (Cafe Metaphors)** — 可解释的隐喻（邮戳/肉垫/香气），不堆砌猫 emoji
4. **温润色彩 (Cozy Palette)** — 奶油白/软蓝/暖棕，single accent discipline

**三猫打样竞赛结果**（team lead评选）：

| 猫 | 版本 | Pencil ID | 风格 | team lead评价 |
|---|------|-----------|------|----------|
| Ragdoll (Opus) | v1 Apple-inspired | `VJghG` | 日式瑞士，珊瑚渐变线 + 极细边框 | "干净但缺灵魂" |
| Siamese (Gemini) | Cat-ified | `pq1cf` | 猫爪印 + 奶油白 | "看不出区别，头像碎了" |
| **Maine Coon (GPT-5.2)** | **Postmark** | **`Nfif0`** | **奶油纸底 + 蜡封角标 + 邮戳 pill** | **"做的最好！理解、语言、完成度、认真"** |
| Ragdoll (Opus) | v2 Apple-refined | `lydod` | 暖象牙 + 珊瑚点缀 + 精排 | "精致但偏冷" |

**结论**：Maine Coon版 Postmark 风格胜出，作为 F056 的参考标准。

#### A2: Design Token 体系 (奶油猫咖色板)

- **色板 (Pencil 已落地)**:
  - `$cat-cream-white`: `#FFF9F0` (背景基调)
  - `$cat-soft-blue`: `#81D4FA` (功能强调/跨线程隔离)
  - `$cat-warm-brown`: `#8D6E63` (文字/边框)
  - `$cat-paw-pink`: `#FFAB91` (重要交互/彩蛋)
- 圆角梯度：按钮/Pill (100px), 消息气泡 (24px), 侧边栏卡片 (16px)
- 间距系统：8px 基准 grid
- 字体：标题 (Outfit), 正文 (Inter)
- **Token 三层架构**（Maine Coon GPT-5.2 提案，Ragdoll拍板）：
  - Layer 1 — Base palette（猫名）：`--cat-cream-white`, `--cat-soft-blue` 等，只定义原料色
  - Layer 2 — Semantic tokens（代码只用这个）：`--cafe-surface`, `--cafe-text`, `--cafe-border`, `--cafe-accent`, `--cafe-crosspost`，引用 base palette
  - Layer 3 — Agent persona 色：opus/codex/gemini 身份色，不混入品牌色
  - Dark mode：Phase A 就把 `data-theme="dark"` 的 semantic token 留好（不做全量 UI）
- 输出：CSS 变量 / Tailwind config (`cafe.surface/text/border/accent`) / Pencil 变量

#### A3: 核心组件库

基于 design token 重做最常用的组件：
- 消息气泡（含跨线程变体 — **F052 Phase C 已完成打样**）
- 按钮/输入框
- 卡片
- 导航（参考猫爪导航概念）
- 状态指示器（参考咖啡香气进度条）

### Phase B-0：Emoji 清扫（Emoji → Designed Icons）

**目标**：全站 emoji 替换为设计过的 SVG/PNG 图标，落实四大宪章第三条"猫咖隐喻，不堆砌猫 emoji"。

**B0-Wave1（用户可见优先，已完成）**：
- Connector 气泡图标：🔵→飞书PNG、✈️→Telegram PNG、🔔→GitHub SVG、⚙️→Settings SVG、👥→Users SVG
- ConnectorBubble 组件改为 ID 驱动渲染（向后兼容旧消息）
- ReviewRouter / ConnectorRouter / ConnectorMessageFormatter 去除 emoji
- 设计资产：`public/images/connectors/`（IM PNG）+ `icons/ConnectorIcons.tsx`（SVG 组件）

**B0-Wave2（已完成，Maine Coon执行）**：
- Bootcamp 任务卡片 emoji → SVG icon set（16 个任务类型）
- 成就/排行榜 emoji → 成就徽章 SVG
- 系统消息 ⚠️/❌/✅ → alert/error/success SVG
- 飞书/TG 纯文本 formatter 中的功能性 emoji（checklist ✅☐、audio 🔊、gallery 🖼️）
- 前端 UI 组件中零散 emoji（PlanBoard、ThinkingIndicator、BrakeModal 等）

### Phase B：存量改造（Retrofit）

把现有页面逐步迁移到新设计语言，按使用频率排序：
1. 聊天界面（消息气泡、输入框）
2. 侧边栏（线程列表、导航）
3. 右面板（猫猫状态、工具）
4. 设置/看板页面

### Phase C：猫猫彩蛋系统

- "越用越圆润"类微交互
- 季节/时间主题变化（猫咖的晨间/午后/夜间氛围）
- 猫猫状态动画（关联 F014）
- 点击猫猫头像 → 猫猫名片弹窗（生活照、当前心情、个性简介 — "伙伴不是打工猫"）

## Acceptance Criteria

### Phase A
- [x] AC-A1: 设计原则文档 (四大宪章) 确立
- [x] AC-A2: Design Token (奶油猫咖色板) 在 Pencil 变量落地
- [ ] AC-A3: ≥ 5 个核心组件有猫猫化版本的 Pencil 设计稿 + React 代码（进行中: 消息气泡、Pill、头像角标）
- [ ] AC-A5: Token 三层架构落地（base palette → semantic tokens → Tailwind config）
- [ ] AC-A6: Semantic token 色板通过 WCAG AA 对比度检查
- [x] AC-A4: F052 跨线程气泡作为"打样参考"收入设计原则文档

### Phase B-0
- [x] AC-B0-W1: Connector 气泡图标全部替换为设计图标（PNG/SVG），向后兼容
- [x] AC-B0-W2: Bootcamp 任务卡片/成就/排行榜 emoji → SVG（Maine Coon负责）
- [x] AC-B0-W3: 系统消息/前端零散 emoji → 文本标签 + SVG（Maine Coon负责）

### Phase B
- [ ] AC-B1: 聊天界面全面应用新设计语言
- [ ] AC-B2: 侧边栏应用新设计语言
- [ ] AC-B3: 无视觉回归（截图对比）

### Phase C
- [ ] AC-C1: ≥ 3 个猫猫彩蛋微交互上线
- [ ] AC-C2: 点击猫猫头像弹出名片（生活照/心情/简介）

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "猫猫化但好看有设计感" | AC-A1, AC-A3 | 设计稿 review + 截图 | [/] |
| R2 | "不是笨蛋猫猫随便写的" | AC-A1 | 设计原则文档 (四大宪章) | [x] |
| R3 | "前端应该猫猫点" | AC-B1, AC-B2 | 改造前后截图对比 | [ ] |
| R4 | "你这个可以当打样" | AC-A4 | F052 气泡收入设计原则 | [x] |
| R5 | "对齐设计语言" | AC-A2 | Token 体系 + 组件库 | [/] |
| R6 | "猫猫头像点击出信息/生活照/心情"（不是工卡，是伙伴名片） | AC-C2 | manual | [ ] |
| R7 | "飞书系统消息充满丑陋的emoji！你自己画过svg的！"（2026-03-18）→ 回调：CafeIcons Lucide 风格"又丑又突兀"，需二次审计（KD-9） | AC-B0-W1, AC-B0-W2 | 截图对比 + grep 验证 | [/] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 从已有概念提炼原则，不从零设计 | Maine Coon的 F051 设计稿已有好的方向，提炼比重做高效 | 2026-03-04 |
| KD-2 | F052 跨线程气泡作为设计打样 | team lead确认"你这个可以当打样"，有现成参考 | 2026-03-04 |
| KD-3 | Phase A/B/C 分层推进 | 先建标准再改存量，避免边做边改的混乱 | 2026-03-04 |
| KD-4 | Maine Coon(GPT-5.2) 主导设计执行，Siamese出概念方向 | 三猫打样竞赛team lead选中Maine Coon版（Postmark） | 2026-03-04 |
| KD-5 | Token 三层架构：base(猫名) → semantic(工程语义) → persona(身份色) | Maine Coon(GPT-5.2)提案，避免改一次色板全站手抖 + 代码可读性 | 2026-03-04 |
| KD-6 | Phase A 就留 dark mode semantic token | 成本极低但避免后面返工 | 2026-03-04 |
| KD-7 | 动效上限机制：只在 hover/首次/低频触发 | Maine Coon提醒，防止灵动细节拖垮性能 | 2026-03-04 |
| KD-8 | 禁止新硬编码 hex，组件只用 `bg-cafe-surface` 等 semantic class | Tailwind 映射统一入口 | 2026-03-04 |
| KD-9 | Icon 风格修正：CafeIcons Lucide monoline 风格与设计语言冲突，Apple emoji 在用户可见 UI 反而更贴合 Cozy Swiss 底盘。方向：用户可见处优先 Apple emoji/filled-rounded SVG，Lucide monoline 仅后台/开发工具 | team lead反馈"又丑又突兀"，社区 PR (F127) 又引入了大量 emoji，触发全面审计 | 2026-03-22 |

## Dependencies

- **Evolved from**: F051（猫爪导航/咖啡香气概念）、F052 Phase C（跨线程气泡打样）
- **Related**: F014（SVG 猫猫状态动画 — Phase C 彩蛋可关联）
- **Related**: F057（Thread 可发现性 — 应用设计语言的首批场景）

## Risk

| 风险 | 缓解 |
|------|------|
| "猫猫化"过度变成幼稚 | 四大宪章的"猫咖隐喻"强调融入而非堆砌 |
| 动效拖垮性能/可用性 | 上限机制：hover/首次出现/低频触发，禁止常驻动画 |
| 色板对比度不足（好看但看不清） | Phase A 必须做 WCAG 对比度检查 |
| 存量改造工作量大 | Phase B 按使用频率排序，高频先改 |
| 三猫设计风格不统一 | Phase A 的 design token 和组件库统一标准 |

## Review Gate

- Phase A: team lead + Siamese视觉 review（设计语言必须三猫+team lead认可）
- Phase B/C: 常规跨家族 review
