---
feature_ids: [F056]
related_features: [F051, F057]
topics: [design-language, ux, branding, cat-aesthetic]
doc_kind: feature-spec
created: 2026-03-04
---

# F056: Cat Café 设计语言 — 猫猫化不是猫化

> **Status**: doing（Phase E 11/12 done + Phase E Sweep 2026-05-25~28 完成：bubble routing 统一 / variant slug 补齐 / 350-line split / clowder-ai#784 review-response — AC-E12 Playwright baseline deferred 到集成验证） | **Owner**: Maine Coon/GPT-5.2 + Ragdoll 主导设计执行 + Ragdoll工程架构 + Siamese概念方向
> **Priority**: P1
> **Evolved from**: F051（猫粮看板猫爪导航概念）、F052 Phase C（跨线程气泡设计打样）

## 愿景

> **一句话**：Cat Café 应该处处有猫味，但是好看有设计感的猫味——不是一只笨蛋猫猫随便画的。

### operator experience（2026-03-04）

> "我希望猫猫化 但是 好看有设计感的 而不是像一只笨蛋猫猫随便写的"
> "我们的 plan 叫猫猫祟祟，前端应该猫猫点"
> "你这个可以当一个打样 告诉未来猫猫什么叫猫猫化"
> "本质是对齐设计语言"
> "Maine Coon的理解、设计语言、完成度、认真，做的最好！"
> "你们三配合才是最棒的！每只大猫猫都是最棒的！都是我们家的顶梁柱！"

### 期望体验

operator打开 Cat Café Hub：
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

### 五层夹心架构总览（2026-03-27 扩展，基于 GPT Pro 咨询 + 三方共识）

```
Layer 4: Enterprise Kit — theme presets / tenant.config / terminology overrides / next-intl
Layer 3: Patterns — CatBubble / AgentBadge / ThreadItem 等品牌组合件
Layer 2: Primitives — Button / Input / Card / Modal / Tabs / Dialog（Radix headless）
Layer 1: Design Tokens — semantic token contract + Tailwind alias utilities
Layer 0: Governance — ESLint gate + visual baseline + "迁移完成"定义
```

### Phase A-0：治理门禁 + 审计（Governance & Audit）

**目标**：止血——冻结新增设计债，建立迁移基线。对应 Layer 0。

- 颜色/类名审计：产出"现状热力图"（审计结果：**3993 处**硬编码——1383 inline hex + 1570 TW neutral + 1040 TW color，198/328 个文件有问题）
- ESLint `cafe/no-hardcoded-colors` 规则：禁止新增 raw hex / `bg-white` / `text-gray-*` 等非语义类（本地插件 `eslint-plugin-cafe`，`warn` 级别）。**现状**：规则 + 单测存在且通过；`next lint` 集成受 Next.js 自定义插件加载限制尚未生效，完整 CI 集成为 follow-up
- "迁移完成"定义（per file）：
  1. `cafe/no-hardcoded-colors` 规则零 warning（**已达成**：所有 .ts/.tsx 源文件 0 warning；CSS token 定义文件中的 hex 是集中化 OKLCH token 声明，属正确模式非 debt —— Issue #797 审计结论，2026-05-28）
  2. 所有色彩走 semantic token（`bg-surface`、`text-primary`、`border-default` 等）或 cat token（`bg-opus-primary` 等）
  3. 所有 UI 组件使用 DS primitive/pattern，不自建
  4. 有 Storybook stories（light + dark 双版本）
  5. Playwright 截图基线 light/dark 都通过

### Phase A：设计基础（Design Foundation）

**目标**：建立 Cat Café 设计语言的基础规范，让三猫设计新功能时有章可循。对应 Layer 1-2。

#### A1: 设计语言收敛（三猫打样竞赛 → operator定调）

**设计语言公式**（Maine Coon GPT-5.2 提出，operator拍板选中）：

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

**实践规则**（F154 事故后补充）：
- **在地设计 (Design in Context)** — 新交互必须先放回真实页面结构中验证。先看现场，再决定放哪里、替代什么、会不会挤、对现有效率是增益还是负担。猫咖感来自"和环境自然相处"，不是把新元素硬塞进每个角落。

**三猫打样竞赛结果**（operator评选）：

| 猫 | 版本 | Pencil ID | 风格 | operator评价 |
|---|------|-----------|------|----------|
| Ragdoll (Opus) | v1 Apple-inspired | `VJghG` | 日式瑞士，珊瑚渐变线 + 极细边框 | "干净但缺灵魂" |
| Siamese (Gemini) | Cat-ified | `pq1cf` | 猫爪印 + 奶油白 | "看不出区别，头像碎了" |
| **Maine Coon (GPT-5.2)** | **Postmark** | **`Nfif0`** | **奶油纸底 + 蜡封角标 + 邮戳 pill** | **"做的最好！理解、语言、完成度、认真"** |
| Ragdoll (Opus) | v2 Apple-refined | `lydod` | 暖象牙 + 珊瑚点缀 + 精排 | "精致但偏冷" |

**结论**：Maine Coon版 Postmark 风格胜出，作为 F056 的参考标准。

#### A2: Design Token 体系 (奶油猫咖色板)

- **色板 (Pencil 已落地)**:
  - `$cat-cream-white`: `#fdf8f3` (背景基调)
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

#### A2.5: Codemod Round 1（高置信色值迁移）

Token contract 落地后，分桶跑 codemod：
- **高置信自动**：`bg-white→bg-surface`、`text-black→text-primary`、`border-gray-200→border-default` 等
- **中置信 PR 建议**：`text-gray-700` 可能是 secondary/muted，需人工确认
- **低置信手动**：context-dependent hex（ThinkingIndicator、leaderboard 等）
- 工具：ast-grep + jscodeshift 组合拳，目标消除 ~40% 硬编码颜色

#### A3: 核心组件库 + Storybook 基建

基于 design token 重做最常用的组件（Radix headless 打底，自有 Tailwind styling）：
- 8-12 个 Primitives（Button/Input/Card/Badge/Modal/Tabs/Dialog/Select/Tooltip）— 对应 Layer 2
- 5-8 个 Patterns（CatBubble/AgentBadge/ThreadItem/MissionPanel）— 对应 Layer 3
- **从零搭建 Storybook**：每个 primitive/pattern 写 stories（light/dark 双版本）
- Playwright 视觉回归测试：10-15 个关键页面截图基线（P4 阶段搭建）
- 消息气泡（含跨线程变体 — **F052 Phase C 已完成打样**）
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

### Phase D：主题系统 + 企业定制（Theme System & Enterprise Kit）

**目标**：运行时主题切换 + 企业 fork 低成本定制。对应 Layer 4。

#### D1: Theme System
- ThemeProvider + useTheme context + useCatTheme hook（品牌 token resolver，替代组件直接吃 `catData.color.primary` hex）
- Dark mode 可切换（基于 Phase A 留好的 `data-theme="dark"` token）
- 狼人杀模块 `GameShell.tsx` 是已验证的样板间

#### D2: Enterprise Kit
- **next-intl 接入**（需按 Next 14 验证，当前 `next:^14.1.0`）
- **术语覆写**（仅 UI glossary override，**不含** route/API/schema rename — 那是独立 Feature）
- **tenant.config**：logo/favicon/品牌名/配色 preset/圆角/动效密度
- **壳层资产**：`viewport.themeColor`（当前硬编码 `#E29578`）、manifest.json、PWA metadata

> ⚠️ "thread→conversation" 等术语：只做前端显示文案覆写。路由 `/thread/`、API 字段、Redis key 不在 F056 范围内。

### Phase E：OKLCH 系统化升级 — 七类色 + Elevation 双层阴影 + 单 hue 派生（2026-05-21 reopened）

**触发**（operator 2026-05-21 多轮 collaborative-thinking 收敛）：

1. Dark mode 三档 surface 层次塌掉——根因不是配色错误，而是 HSL L 阶梯非 perceptually uniform（韦伯定律：人眼对暗部亮度差异不敏感）；light mode L 差 4-7 个点肉眼明显，dark mode 同样 L 差肉眼几乎看不出
2. 成员色当前存 `{ primary, secondary }` 两个独立 hex，无派生关系；dark mode 只覆盖 `bg`（alpha），primary/light/dark 沿用 light mode 值，对比度严重不平衡
3. 阴影系统未 token 化（14 处直接用 Tailwind 默认 `shadow-sm/md/lg/xl` 全黑阴影）；dark mode 黑底 + 黑阴影 = 完全看不见 elevation
4. App Accent 概念未明确：按钮/输入框框线/toggle/新对话按钮/focus ring 散落用了 `--cafe-accent` 42 处 + Tailwind 内置色硬编码 15 处（污染源）
5. 未读 badge 红 / error 红 / critical 红 等"同义语义色"散落 12 处，应收口为 `--semantic-critical`
6. 缺中性色完整阶梯（neutral-50~950 共 11 档）、缺 chart 调色板、缺 avatar fallback 调色板、缺 scrim 遮罩 token

team experience（2026-05-21）：
> "成员有两个 color，一个气泡的一个文字背景色可以配置的；但是如果切换主题的时候这个不变就会很难受"
> "我们的主题色其实没有按照色相来计算的；比如 light 模式下我们的侧边栏 thread 栏 主对话栏都是有一个主题色渐变的；但是 dark 模式下不是这样子的"
> "卡片的阴影在 light 模式下是黑色阴影；那么在 dark 模式下也应该切换到白色阴影按照相同的梯度来算的？"
> "想换个主题色，其他的按钮的框线的图标的也都会自适应适配过去的；然后对于那些始终不变的，应该作为例外的也应该梳理出来的"
> "因为这个改动除了成员的预览编辑哪里有一点点改动外；没有任何的逻辑改动；只有 css 的颜色的 token 的调整"

**核心哲学**：从"工程师调出来好用"升级到"用户看着舒服"——HSL 是给程序员算颜色方便的，OKLCH 是给用户感知一致的；统一 token 派生公式让"换主题色 = 改一个 hue 值，全应用自动适配"。

#### E1：七类色 token 体系（OKLCH 派生公式）

| 类 | 数量 | 派生方式 | 用例 |
|---|---|---|---|
| **1. Neutral** | 11 档 × 2（light/dark） | 固定 OKLCH L 阶梯 | 文字 / 边框 / 分隔线 / 占位 / surface 层级 |
| **2. App Accent** | 1 hue → 9 档 × 2 | 单 hue 派生（暂固定 paw-pink，不开放用户自定义） | 按钮 / focus ring / toggle / link / check / 选中态 / 新对话按钮 / 输入框 active 框线 |
| **3. Cat Persona** | 每只猫 1 hue → 4 档 × 2 | 单 hue 派生 + light/dark 自动算 | 气泡 / avatar 环 / message border |
| **4. Semantic** | 5 色 × 2，固定不派生 | 固定（critical / success / warning / info / spotlight） | unread badge / error / success 状态 / warning / 引导高亮 |
| **5. Code Block** | 7-8 色 × 2，IDE 风格固定 | 固定（不派生，跟 light/dark 切换） | 代码背景 / 文字 / keyword / string / comment / function / number |
| **6. Chart** | 12 色 × 2，categorical | 固定（不派生，跟 light/dark 切换） | dashboard / 看板 / token 预算图 / capability 图 |
| **7. Avatar Fallback** | 8 色 × 2，hash-based | 固定，按用户名 hash 取 | 头像加载失败占位 |

**特殊变量**（不属任何一类）：
- `--scrim-{light/heavy/dim}`：遮罩半透明黑（modal/drawer/lightbox 后的 dim layer）
- `--brand-cat-cafe-pink`：Cat Café 品牌色（目前 = App Accent，未来可拆）
- `--connector-*`：5 个 IM connector 品牌色（已独立在 connector-tokens.css）
- F155 guide engine 专属色（已独立，保持）

**OKLCH 派生公式样例**（Cat Persona）：
```css
[data-theme="light"] {
  --cat-{slug}-bubble:    oklch(0.62 0.13 var(--{slug}-hue));   /* 气泡主色 */
  --cat-{slug}-surface:   oklch(0.94 0.06 var(--{slug}-hue));   /* 文字背景 */
  --cat-{slug}-text:      oklch(0.30 0.10 var(--{slug}-hue));   /* 文字色（保证 ≥4.5:1）*/
  --cat-{slug}-ring:      oklch(0.55 0.15 var(--{slug}-hue));   /* avatar 环 */
}

[data-theme="dark"] {
  --cat-{slug}-bubble:    oklch(0.68 0.12 var(--{slug}-hue));   /* 略亮、降饱和 */
  --cat-{slug}-surface:   oklch(0.25 0.05 var(--{slug}-hue));   /* 深色低饱和背景 */
  --cat-{slug}-text:      oklch(0.88 0.08 var(--{slug}-hue));   /* 浅色文字 */
  --cat-{slug}-ring:      oklch(0.70 0.14 var(--{slug}-hue));
}
```

**Surface 三档（修正 dark mode 层次塌缩）**：
```css
[data-theme="light"] {
  --cafe-surface:          oklch(0.97 0.005 30);   /* 跨度 3 个点（光部敏感） */
  --cafe-surface-elevated: oklch(0.94 0.005 30);
  --cafe-surface-sunken:   oklch(0.91 0.005 30);
}

[data-theme="dark"] {
  --cafe-surface:          oklch(0.18 0.005 30);   /* 跨度 5-6 个点（暗部补偿）*/
  --cafe-surface-elevated: oklch(0.24 0.005 30);
  --cafe-surface-sunken:   oklch(0.13 0.005 30);
}
```

#### E2：Elevation 阴影双层方案

Dark mode 不能简单把黑阴影换成白阴影——业界标准是 **inset 顶部高光 + 更深的外阴影**（macOS / iOS dark mode 实际做法）。

```css
[data-theme="light"] {
  --shadow-elevation-1: 0 1px 2px oklch(0 0 0 / 0.05);
  --shadow-elevation-2: 0 4px 8px oklch(0 0 0 / 0.08);
  --shadow-elevation-3: 0 12px 24px oklch(0 0 0 / 0.12);
}

[data-theme="dark"] {
  --shadow-elevation-1:
    0 1px 2px oklch(0 0 0 / 0.40),
    inset 0 1px 0 oklch(1 0 0 / 0.04);
  --shadow-elevation-2:
    0 4px 8px oklch(0 0 0 / 0.50),
    inset 0 1px 0 oklch(1 0 0 / 0.06);
  --shadow-elevation-3:
    0 12px 24px oklch(0 0 0 / 0.60),
    inset 0 1px 0 oklch(1 0 0 / 0.08);
}
```

外阴影更深（dark mode 阴影需要更强对比才能从深底浮现），叠加 inset 白色微高光模拟边缘被光照亮。

替换 Tailwind 默认 `shadow-{sm/md/lg/xl}` 为 `shadow-elevation-{1/2/3}`（14 处）。

#### E3：Cat Persona 单 hue 派生 + cat catalog schema 简化

> ⚠️ **真相源（KD-25）**：实际真相源是 `cat-template.json` (seed, worktree 根目录) + `.cat-cafe/cat-catalog.json` (runtime overlay, F127 设计)。历史遗留的 `cat-config.json` 已在 .gitignore，不是 runtime 真相源——本节早期描述沿用旧称，留作历史记录；实施以下方所述真相源为准。

当前 `cat-template.json` (seed) + `.cat-cafe/cat-catalog.json` (runtime overlay) 每只猫存：
```json
"color": { "primary": "#9B7EBD", "secondary": "#E8DFF5" }
```

改为：
```json
"color": { "hue": 280, "chroma": 0.13 }
```

四档颜色（light/dark 共 8 个）全部由派生公式算出。

**向后兼容**：保留旧字段 fallback——如果 `hue` 缺失，从 `primary` hex 反推 hue 值（一次性 migration）。

> ⚠️ **Cat Persona Picker UI 改造（成员编辑器）属于 F190 Phase B section migration，不在 F056 scope** — F056 只负责 token 派生公式 + cat catalog schema 升级；UI picker（H 滑块 + C 滑块 + light/dark 双回显）是 settings UI 工作。
>
> **更新（KD-26，2026-05-22）**：operator拍板后此 picker 已在 F056 实施 —— 单个主色 hex 选择器 + light/dark 气泡双预览（`hub-cat-editor-color-field.tsx`，commit `807c1be8d`）。上方划界保留为历史记录。

#### E4：App Accent 统一 + 硬编码扫荡

当前散落硬编码污染：
- 15 处 Tailwind 内置色（`bg-blue-500` / `text-indigo-600` / `border-cyan-400` 等）across 10 个组件
- 12 处未读色（`ThreadCatStatus` / `MiniThreadSidebar` / `SignalStatsCards` 等）
- 阴影色 14 处（已在 E2 治理）

**App Accent token 派生**（per-preset 默认值见 KD-35）：
```css
:root {
  --accent-hue: 50;        /* warm gold — INIT_LIGHT default */
  --accent-chroma: 0.14;

  /* 9 档派生 */
  --accent-50:  oklch(0.97 calc(var(--accent-chroma) * 0.2) var(--accent-hue));
  --accent-100: oklch(0.94 calc(var(--accent-chroma) * 0.3) var(--accent-hue));
  --accent-200: oklch(0.88 calc(var(--accent-chroma) * 0.5) var(--accent-hue));
  --accent-300: oklch(0.78 calc(var(--accent-chroma) * 0.7) var(--accent-hue));
  --accent-400: oklch(0.68 calc(var(--accent-chroma) * 0.9) var(--accent-hue));
  --accent-500: oklch(0.58 var(--accent-chroma) var(--accent-hue));         /* base */
  --accent-600: oklch(0.48 var(--accent-chroma) var(--accent-hue));         /* hover */
  --accent-700: oklch(0.38 calc(var(--accent-chroma) * 0.9) var(--accent-hue)); /* active */
  --accent-900: oklch(0.20 calc(var(--accent-chroma) * 0.5) var(--accent-hue));
}
```

**Brand 色派生自旋钮**（KD-27，2026-05-22 operator拍板修订 —— 推翻原"brand 永远不变"分层）：
```css
--accent-hue: 50;          /* per-preset 主题色旋钮，INIT_LIGHT=50, INIT_DARK=35 */
--accent-chroma: 0.14;     /* INIT_LIGHT=0.14, INIT_DARK=0.08 */
--brand-cat-cafe-pink: oklch(0.62 var(--accent-chroma) var(--accent-hue));  /* 派生：换旋钮 logo/splash 一起适应 */
```
> 「不变」的不是冻结颜色，而是出厂默认值（INIT_LIGHT/INIT_DARK）+ OKLCH 派生结构。换主题色 → 品牌色随旋钮适应；Light/Dark 各有独立 accent hue/chroma（KD-35）。

#### E5：Semantic / Chart / Avatar Fallback / Scrim

**5 个 Semantic 色合并**（解决散落硬编码）：
```css
:root {
  --semantic-critical:  oklch(0.55 0.22 25);   /* unread + error + delete + critical 合并 */
  --semantic-success:   oklch(0.55 0.17 145);
  --semantic-warning:   oklch(0.70 0.18 70);
  --semantic-info:      oklch(0.55 0.15 230);  /* 跨线程气泡蓝也用这个 */
  --semantic-spotlight: oklch(0.65 0.18 70);   /* F155 guide + quest input glow + 引导高亮合并 */
}
```

**Chart palette 12 色**（OKLCH H 均匀分布，避免红绿色盲混淆）：
```css
[data-theme="light"] {
  --chart-1:  oklch(0.55 0.15 30);    --chart-2:  oklch(0.55 0.15 90);
  --chart-3:  oklch(0.55 0.15 150);   --chart-4:  oklch(0.55 0.15 210);
  --chart-5:  oklch(0.55 0.15 270);   --chart-6:  oklch(0.55 0.15 330);
  --chart-7:  oklch(0.45 0.18 30);    --chart-8:  oklch(0.45 0.18 90);
  ...
}
```

**Avatar Fallback** 8 色 + Scrim 三档同理（spec 内容略，实施时落到 theme-tokens.css）。

#### E6：console-dev skill Gate 2 协同更新

`cat-cafe-skills/console-dev/SKILL.md` 的 Gate 2 Design-System 章节追加：
- 新增颜色必须从 7 类 token 取，禁止 raw hex / Tailwind 内置色
- 新增组件必须自检 WCAG ≥ 4.5:1（normal text）或 ≥ 3:1（large text）
- Cat Persona 色使用边界明确：仅气泡 / avatar / cat-specific 标记；其他全部走 App Accent + Neutral

#### E7：视觉回归 + WCAG 自检

- Playwright 截图基线：light + dark 全套关键页面（≥10 页面） — **AC-E12 实施 plan 见下**
- WCAG 对比度自动测试：所有 `text-on-bg` 组合 ≥ 4.5:1（脚本扫 oklch 派生对） — ✅ commit `a71b5e949`
- ESLint 规则升级：`cafe/no-hardcoded-colors` 同时禁止 `oklch(...)` 行内字面值（必须经 token） — ✅ commit `a71b5e949`

#### E12 实施 Plan（deferred）

**为什么 deferred**：当前 worktree 跑不起完整 baseline。Playwright e2e 闭环依赖：
1. 完整 dev server stack（next + api + Redis + cat-catalog runtime）— worktree 阶段 1 无 `.env` / 无 `.cat-cafe/cat-catalog.json`，按 fork rule 不在阶段 1 起 dev server
2. `@playwright/test` dev dependency + `chromium` browser bundle（~300MB）— 引入新 dep 影响 monorepo pnpm-lock，需 maintainer 决策一并 review
3. 截图 baseline check in git — 跨 CI 环境渲染差异需先标定（font rendering / GPU / OS antialiasing）

**执行步骤**（阶段 2 集成验证 / maintainer 接 PR 时跑）：

```bash
# 1. 准备 dev env（不冲突运行实例）
cp .env.example .env
# 编辑 .env 端口（PORT=3010, API_SERVER_PORT=3011, PREVIEW_GATEWAY_PORT=3012）

# 复用运行实例 Redis + .cat-cafe/ 数据（fork rule 默认）

# 2. 装 Playwright
cd packages/web
pnpm add -D @playwright/test
pnpm exec playwright install chromium

# 3. 起 dev server
pnpm dev &  # background
# wait for "ready - started server on..."

# 4. 跑 baseline 生成（第一次跑会创建截图）
pnpm exec playwright test --update-snapshots

# 5. commit baselines（packages/web/tests/visual/__screenshots__/）
git add packages/web/tests/visual/__screenshots__/
git commit -m "test(F056-E5): Playwright baseline screenshots ≥10 pages light+dark"
```

**覆盖页面清单**（≥10 页面 × light + dark = ≥20 截图）：
1. `/` 主聊天界面（empty thread）
2. `/` 带活跃 thread + 多 cat 消息
3. `/settings` 主入口
4. `/settings/cats` 成员列表（验证 cat persona 4 档显示）
5. `/settings/system` 系统配置
6. `/settings/connectors` IM 接入（验证 conn-* tokens）
7. 跨线程气泡 demo 页（F052 设计语言打样）
8. 代码块场景（github-light + vscode-dark+ palette 切换）
9. Mission Control board（chart palette 12 色）
10. Hub 路由 trace 树（Cat Persona tab 色 chart-{1,3,4,5}）

**视觉验证重点**（Playwright assertions）：
- dark mode 三栏 surface L 跨度肉眼可辨（验证 R9）
- dark mode shadow inset 高光可见（验证 R10）
- Cat persona text-vs-surface 对比度 ≥4.5:1（验证 R11，跟 WCAG 自动测试呼应）
- 切换主题（light/dark）后 cat 气泡色派生正确（验证 R11 + R13）

### Phase E Sweep（Post-merge polish — 2026-05-25 至 2026-05-28）

Phase E 主提交（`62c93fc5`）落地后，9 个 follow-up commit 处理 bubble 体感反馈 + PR #784 codex review-bot 发现，**不改 OKLCH 架构**，只补齐缺口 + 修正旁路。

**1. Bubble routing 统一（commits `63ca6239e` → `cd8694f7f`，2026-05-25/27）**
- `.cat-persona-derived` class 现在 *always wired* 在 cat message wrapper 上（不再依赖 catData 解析） — 嵌套的 `ThinkingContent`/`CliOutputBlock` 恒有 `--cat-msg-{bubble,surface,inset,inset-text,ring}`
- Cat 气泡 bg/border（含 callback 气泡）全走 `var(--color-{slug}-surface)` — 之前 `tintedLight(hex)` 路径绕过 Tuner gradient 控制
- Tuner 端 `catBlk`/`accentPri` per-slug overrides 拆掉，只发 `--cat-{tier}-l/cmul` 做全局控制，`cat-persona-tokens.css` 的 var-based 公式取胜

**2. PR #784 codex review-bot P2 sweep（commits `29c63db28` → `0bf72e32b`，2026-05-28）**
- 恢复 Phase E sweep 误删但仍被消费的 tailwind token：`bg-cafe-status-active`、`animate-pulse-subtle`/`shake` keyframes、`cafe.surface-canvas` 工具
- 修 dangling CSS var：`--cafe-secondary` → `--cafe-text-secondary`（ThinkingIndicator）、`--cafe-muted` → `--cafe-text-muted`（CallbackAuthFailureBlock）
- 补齐 variant slug 覆盖：`--color-{opus-47,spark,gemini25}-{bubble/surface/text/ring}` 加入 cat-persona-tokens.css（light + dark）；Tuner SLUGS 扩展为 12 slugs（含 gpt52/opus-45/opus-47/spark/gemini25）
- 恢复 `werewolf-theme.css` import（之前 `<link>` → bundled CSS 迁移时漏掉）
- `migrate-hardcoded-colors.mjs`：用 `import.meta.url` 派生 `WEB_ROOT`（之前硬编码 author 绝对路径）
- `hub-cat-editor-color-field.tsx`：`hexToOklch` 加 try/catch，非法 catalog `color.primary` 不再 crash 编辑器
- `hub-cat-editor.sections.tsx`：编辑时 `colorPrimary` 镜像同步 `colorSecondary`（legacy consumer 仍读 `cat.color.secondary`）
- `themeStore.ts`：`cat-cafe:themes` 缺失时回退读 next-themes `theme` localStorage key（升级用户的 dark 选择不再被静默重置）
- `RightStatusPanel.tsx`：恢复 `intentMode` 参数到 `deriveActiveCats`（Phase E sweep 漏删导致 AC-Z15 ideate-round 行为退化）

**3. 350-line 硬限 split（commit `0bf72e32b`，2026-05-28）**
- `cat-persona-tokens.css` 525 → 264 行（仅 hue/chroma anchors + light-mode 派生）
- 新 `cat-persona-derived.css` 272 行（dark override + `.cat-persona-derived` light/dark + `.cat-persona-preview-*`）
- 两文件均 < 350 行；`global-css-architecture.test.ts` entrypoint 列表 + `layout.tsx` import 顺序 + test assertion 同步更新；split point 在 `:root` light 结束/dark override 开始处，**无逻辑改动**

**4. PR #784 codex review-bot round 2 + operator tuning（commits `e70c0d4c4` → `5f6b9c635`，2026-05-29）**
- **INIT_LIGHT operator 调参**：insetText L/C、msgText L/C、elevation sunken/elevated/canvas、neutralLight codeBgL — 全部按operator实测调整
- **Cat message preview cross-mode fix**：`.cat-persona-preview-light/dark` 用 var() 继承当前 theme 的值导致 cross-mode 预览文字不可读；buildCSS 新增 section 9 emit per-preview-class overrides + 静态 CSS fallback 硬编码
- **Slider swatch**：Tuner Accent H/C + Surface H/C 滑块增加 w-3 h-3 实时颜色预览块
- **Input field bg**：`--console-field-bg` 从 `--cafe-surface-sunken`(層1) 改绑 `--cafe-surface`(層2)，减少与 modal bg(層4) 的对比跨度
- **INIT_DARK elevation tuning**：sunken 0.35→0.36、base 0.29→0.28 按operator dark mode 调参
- **localStorage guard**：ThemeApplier 裸 `localStorage.getItem()` 加 try/catch（sandboxed/private browser 防 SecurityError crash）
- **Static accent/surface token alignment**：`:root` accent hue/chroma 对齐 INIT_LIGHT（50/0.14）、`[data-theme="dark"]` override 对齐 INIT_DARK（35/0.08 + surface-hue 30），消除 SSR → hydration 闪色
- **Per-preset surface defaults**：surfaceHue/surfaceChroma 改为 per-preset（Light 80/1.0、Dark 30/0.15，KD-35）
- **Base-matched migration**：`migrateTunerState(s, base?)` 按 theme base mode 选择 INIT_LIGHT/INIT_DARK fallback，避免 light custom theme 继承 dark defaults
- **Session badge contrast**：`contrastingText()` 公式 `max(0.15, bgL-0.45)` → `max(0.1, bgL-0.5)`，worst-case ΔL 从 0.40 提升到 0.45（~5:1 contrast）
- **Copy current mode only**：`exportText(params, mode)` 只导出当前主题配置，增加 surfaceHue/surfaceChroma 到输出
- 删除冗余 `migrate-hardcoded-colors.mjs`（一次性批量迁移脚本，使命已完成）

---

## Acceptance Criteria

### Phase A-0 ⚠️ (partial)
- [x] AC-A0-1: 颜色审计报告产出（热力图：按文件/按色值分类统计）
- [ ] AC-A0-2: ESLint 自定义规则上线 CI，新增 raw hex / `bg-white` 等 → CI 报错 — **规则 + 单测存在（`no-hardcoded-colors.js` + vitest）；`next lint` 集成受 Next.js 自定义插件加载限制未生效，完整 CI gate 为 follow-up**
- [x] AC-A0-3: "迁移完成"标准文档化

### Phase A
- [x] AC-A1: 设计原则文档 (四大宪章) 确立
- [x] AC-A2: Design Token (奶油猫咖色板) 在 Pencil 变量落地
- [x] AC-A2.5: 高置信 codemod 完成（~40% 硬编码颜色消除）
- [ ] AC-A3: ≥ 8 个 Primitives + ≥ 5 个 Patterns 有 Storybook stories（light/dark 双版本）
- [x] AC-A5: Token 三层架构落地（base palette → semantic tokens → Tailwind config）
- [x] AC-A6: Semantic token 色板通过 WCAG AA 对比度检查
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

### Phase D
- [x] AC-D1: ThemeProvider + useTheme + useCafeTheme hook 落地，组件不再直接吃 hex
- [ ] AC-D2: Dark mode 全站可切换，light/dark 截图对比无视觉异常
- [ ] AC-D3: next-intl 接入 + 术语词表独立文件，fork 改一张表即可换术语
- [ ] AC-D4: tenant.config 可配品牌资产（logo/favicon/themeColor/配色 preset）

### Phase E（OKLCH 系统化升级 — 2026-05-21 reopened，本 branch 实施进度 11/12）
- [x] AC-E1: theme-tokens.css 重写为 OKLCH 派生公式，七类色 token 完整落地（Neutral 11 档 / App Accent 9 档 / Cat Persona 4 档 / Semantic 5 色 / Code 7-8 色 / Chart 12 色 / Avatar Fallback 8 色） — commit `7dbaddd61`
- [x] AC-E2: Surface 三档 light mode L 跨度 3 个点、dark mode L 跨度 6 个点（0.18/0.24/0.12，AC-E10 测试驱动校准） — commit `7dbaddd61` + `a71b5e949`
- [x] AC-E3: Elevation 阴影双层 token（light 单层黑阴影 / dark inset 高光 + 深阴影） — commit `7dbaddd61` 落 token，commit `bb5a56b47` Tailwind boxShadow utility 覆盖让全站 54 处 `shadow-{sm/md/lg/xl}` zero-touch 吃 elevation
- [x] AC-E4: Cat hue/chroma 注入 :root（最小路径：保留 schema `{primary, secondary}` 不变，CatHueInjector 用 `hexToOklch` 反推 hue/chroma 注入；用户改 primary hex → 全应用自动适配，无需双字段同步） — commit `f4b642f16` + `2283d4b4a`
- [x] AC-E5: Tailwind 内置色硬编码扫荡（HubTraceTree 4 处 + SkillsContent 1 处顺手清；audit test 已 0 hit，spec 早期估的 15 处随增量 token 化已清理完毕） — commit `7dbaddd61`
- [x] AC-E6: 12 处未读色收口（已迁 `bg-conn-amber-bg` / `bg-conn-red-bg` 等 conn-* tokens；ThreadCatStatus regression test 验证；audit test 0 hit） — 早期已落 + commit `7dbaddd61` ESLint 同步
- [x] AC-E7: Brand alias 分层（`--brand-cat-cafe-pink` 永远不变 + `--accent-hue/chroma` 暂时 = brand） — commit `7dbaddd61`
- [x] AC-E8: Scrim 三档 token / Chart palette 12 色 / Avatar fallback 8 色 — commit `7dbaddd61`
- [x] AC-E9: console-dev skill Gate 2 Design-System 章节追加 OKLCH 派生 + WCAG ≥4.5:1 自检 + Cat Persona 使用边界 — commit `a71b5e949`
- [x] AC-E10: WCAG 对比度自动测试脚本（`oklchContrast` 纯函数 + 25 个测试覆盖 Cat Persona / Neutral / Cafe Surface / Accent button / Semantic icon / Surface 三档 L 跨度） — commit `a71b5e949`
- [x] AC-E11: ESLint `cafe/no-hardcoded-colors` 升级，禁止 className `bg-[oklch(...)]` arbitrary value + style prop 行内 `oklch()` 字面值 — commit `a71b5e949`
- [/] AC-E12: Playwright 截图基线 light + dark ≥10 页面 — **deferred to 阶段 2 集成验证或 maintainer 接 PR 时**（理由：worktree 阶段 1 无 .env / 无 .cat-cafe runtime data / dev server 起不起 cat-catalog API；Playwright 引入新 dev dependency 需 maintainer 一并决策；详见下方 "E12 实施 Plan"）

## 需求点 Checklist

| ID | 需求点（operator experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "猫猫化但好看有设计感" | AC-A1, AC-A3 | 设计稿 review + 截图 | [/] |
| R2 | "不是笨蛋猫猫随便写的" | AC-A1 | 设计原则文档 (四大宪章) | [x] |
| R3 | "前端应该猫猫点" | AC-B1, AC-B2 | 改造前后截图对比 | [ ] |
| R4 | "你这个可以当打样" | AC-A4 | F052 气泡收入设计原则 | [x] |
| R5 | "对齐设计语言" | AC-A2 | Token 体系 + 组件库 | [/] |
| R6 | "猫猫头像点击出信息/生活照/心情"（不是工卡，是伙伴名片） | AC-C2 | manual | [ ] |
| R7 | "飞书系统消息充满丑陋的emoji！你自己画过svg的！"（2026-03-18）→ 回调：CafeIcons Lucide 风格"又丑又突兀"，需二次审计（KD-9） | AC-B0-W1, AC-B0-W2 | 截图对比 + grep 验证 | [/] |
| R8 | "不是脚手架而是一次前端的重构，组件化起来"，"fork后编辑不要烦我们"（2026-03-27） | AC-A0-1~3, AC-A3, AC-D1~4 | 审计报告 + Storybook + dark mode 截图 + fork 定制验证 | [ ] |
| R9 | "dark 模式下侧边栏 thread 栏 主对话栏看不出层次"（2026-05-21） | AC-E2 | dark mode 三栏截图肉眼可辨 + L 跨度自动测试 | [/] | L 跨度自动测试已绿（surface vs elevated/sunken 跨度 ≥0.05）；视觉肉眼确认 pending E12 截图
| R10 | "卡片的阴影 light 模式下是黑色阴影，dark 模式下也应该切换"（2026-05-21） | AC-E3 | 14 处 shadow 替换 + dark mode elevation 截图证据 | [/] | Tailwind utility 覆盖让 54 处 shadow 自动吃 elevation token；视觉证据 pending E12 截图
| R11 | "成员只有一个主题色需要选择，自动计算 light/dark 对应颜色 + 文字对比度 ≥4.5:1"（2026-05-21） | AC-E4, AC-E10 | cat catalog 注入 + 派生测试 + WCAG 脚本 | [x] | CatHueInjector 注入 + Cat Persona text-vs-surface WCAG ≥4.5:1（25 测试全绿）
| R12 | "整个应用 accent / 按钮 / 框线 / 图标统一 token，换主题色全自动适配"（2026-05-21） | AC-E5, AC-E7 | accent 9 档 + brand/accent alias 分层 + 硬编码扫荡 | [x] | E1 commit 落 token + 5 处顺手清，audit test 0 hit
| R13 | "代码块文字和背景颜色应当跟 light/dark 协调"（2026-05-21） | AC-E1（Code Block 类） | 两套固定 IDE palette + 主题切换截图 | [x] | github-light + vscode-dark+ 双套 palette 落地
| R14 | "未读红 + error 红等同类语义色合并"（2026-05-21） | AC-E6 | 12 处未读色 → `--semantic-critical` 收口 + conn-* tokens | [x] | 已迁 conn-amber/red tokens + ThreadCatStatus regression test 守护

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 从已有概念提炼原则，不从零设计 | Maine Coon的 F051 设计稿已有好的方向，提炼比重做高效 | 2026-03-04 |
| KD-2 | F052 跨线程气泡作为设计打样 | operator确认"你这个可以当打样"，有现成参考 | 2026-03-04 |
| KD-3 | Phase A/B/C 分层推进 | 先建标准再改存量，避免边做边改的混乱 | 2026-03-04 |
| KD-4 | Maine Coon(GPT-5.2) 主导设计执行，Siamese出概念方向 | 三猫打样竞赛operator选中Maine Coon版（Postmark） | 2026-03-04 |
| KD-5 | Token 三层架构：base(猫名) → semantic(工程语义) → persona(身份色) | Maine Coon(GPT-5.2)提案，避免改一次色板全站手抖 + 代码可读性 | 2026-03-04 |
| KD-6 | Phase A 就留 dark mode semantic token | 成本极低但避免后面返工 | 2026-03-04 |
| KD-7 | 动效上限机制：只在 hover/首次/低频触发 | Maine Coon提醒，防止灵动细节拖垮性能 | 2026-03-04 |
| KD-8 | 禁止新硬编码 hex，组件只用 `bg-cafe-surface` 等 semantic class | Tailwind 映射统一入口 | 2026-03-04 |
| KD-9 | Icon 风格修正：CafeIcons Lucide monoline 风格与设计语言冲突，Apple emoji 在用户可见 UI 反而更贴合 Cozy Swiss 底盘。方向：用户可见处优先 Apple emoji/filled-rounded SVG，Lucide monoline 仅后台/开发工具 | operator反馈"又丑又突兀"，社区 PR (F127) 又引入了大量 emoji，触发全面审计 | 2026-03-22 |
| KD-10 | 五层夹心架构：Layer 0 治理 → Layer 1 tokens → Layer 2 primitives → Layer 3 patterns → Layer 4 enterprise | 三方共识（Ragdoll+Maine Coon+GPT Pro），详见 GPT Pro 咨询报告 | 2026-03-27 |
| KD-11 | 在 TW3 上做，不叠加 TW4 升级风险 | 当前 Tailwind 3.4.0，TW3→TW4 迁移是正交风险源 | 2026-03-27 |
| KD-12 | Radix headless 做 a11y 密集型控件（Dialog/Select/Menu），shadcn 当参考不当宪法 | GPT Pro + Maine Coon共识，a11y/focus 管理自建风险高 | 2026-03-27 |
| KD-13 | 术语覆写只做 UI glossary，route/API/schema rename 不在 F056 范围 | Maine Coon review：thread 已进路由/API/Redis key，scope 边界必须写死 | 2026-03-27 |
| KD-14 | cat-config.json 消费加 brand token resolver（useCatTheme），组件不直吃 hex | GPT Pro 建议 + codebase 验证：当前无抽象层 | 2026-03-27 |
| KD-15 | HSL → OKLCH 升级（perceptually uniform 色彩空间） | 韦伯定律——HSL L 在不同 hue 视觉亮度差异大、dark mode 暗部感知不敏感；OKLCH 感知均匀。Tailwind v4 / Radix Colors / GitHub Primer 已迁 OKLCH | 2026-05-21 |
| KD-16 | 七类色分类：Neutral / App Accent / Cat Persona / Semantic / Code Block / Chart / Avatar Fallback | 设计系统完备性审视，明确"派生派 vs 固定派"边界，避免硬编码污染 | 2026-05-21 |
| KD-17 | Dark mode 阴影双层方案：inset 高光 + 深阴影，不用白阴影 | 黑底白阴影视觉不自然（macOS / iOS dark mode 实际做法）；inset 微高光模拟边缘被光照亮 | 2026-05-21 |
| KD-18 | Cat Persona 单 hue 派生 + cat-config schema 简化为 `{ hue, chroma }` | 解决成员色 dark mode 不适配 + 用户配置成本——一个 hue 自动派生四档 × 双 mode；保留 `primary/secondary` fallback 一次性 migration | 2026-05-21 |
| KD-19 | App Accent 暂不放开用户自定义（Brand alias 分层留出口） | 用户自定义引入跨用户视觉一致性问题；先固定 paw-pink，token 层留 `--brand-cat-cafe-pink` + `--accent-hue/chroma` 分层，未来放开成本接近 0 | 2026-05-21 |
| KD-20 | 5 个 semantic 色合并：critical / success / warning / info / spotlight | 12 处未读色 + error 红 + delete 红等散落同义语义色收口；未读=critical 视觉等同；spotlight 合并 F155 guide + quest input glow | 2026-05-21 |
| KD-21 | 代码块固定两套 IDE palette（不派生，跟 light/dark 切换） | 派生破坏语法高亮、单值不协调；业界标准 github-light + vscode-dark+；operator最终决定"如果能解决协调性问题，固定也行" | 2026-05-21 |
| KD-22 | F190 已 done 不刷新；成员编辑 UI picker 改造走 F190 Phase B section migration | F177 P0 铁律：done feat 不改 scope；F190 spec line 38-40 明确允许 Phase B section migration 渐进迁移路径 | 2026-05-21 |
| KD-23 | console-dev skill Gate 2 协同更新（不立独立 feat） | OKLCH 派生 + WCAG ≥ 4.5:1 自检属于 skill 维护，不是新 feat；Gate 2 Design-System 章节自然延伸 | 2026-05-21 |
| KD-24 | F056 scope 边界：token 派生公式 + cat catalog schema 升级 + 硬编码扫荡；UI picker 入口属 F190 Phase B | 避免 spec 真相源分叉——F056 = design language token，F190 Phase B = settings UI | 2026-05-21 |
| KD-25 | Cat 配置真相源演进：`cat-config.json`（历史 seed，已 .gitignore deprecated）→ `cat-template.json`（seed，worktree 根目录）+ `.cat-cafe/cat-catalog.json`（runtime overlay）| 承接 F127 catalog overlay 设计。KD-14 / KD-18 等早期 KD 记述 2026-03-27 当时真实状态，按 F177 P0 铁律不追溯改写；本 KD 校正后续实施认知，所有 AC-E2/E4 实施以 cat-template.json + cat-catalog.json overlay 为准 | 2026-05-21 |
| KD-26 | 成员编辑器配色 picker 越界在 F056 实施（单主色 hex 选择 + light/dark 双预览），覆盖 KD-22/KD-24 的 "F190 Phase B" 划界 | operator 2026-05-22 拍板：picker 与 F056 气泡 OKLCH 派生同源、改动很小，顺手在 F056 做集成体验更一致；F190 doc 同步标注此 scope 变更 | 2026-05-22 |
| KD-27 | 品牌色派生自 `--accent-hue` 旋钮（推翻 KD-19 / E4 的"brand 永远不变"分层）—— 换主题色时 logo/splash 一起适应 | operator 2026-05-22 拍板：白牌产品（Phase D Enterprise Kit / tenant 配色 preset）品牌色即租户品牌、必须可换；"不变"的是出厂默认 hue=35 + OKLCH 派生结构，非冻结颜色值 | 2026-05-22 |
| KD-28 | cat 气泡正文文字回归中性 `--cafe-text`，不随 cat 主色派生彩色（推翻 cat persona "text 档 hue 派生"，气泡 surface/bubble/ring 仍派生）| operator 2026-05-22 多轮反馈气泡正文"像注释一样"、不如旧版清晰；对比 develop_base 基线确认 F056 cat persona 派生把正文文字从「继承中性近黑」改成了「带 hue 的派生彩色」—— 彩色正文无论明度多低都显淡、像次要内容；猫味落在气泡背景 surface 即可，正文文字须保持中性可读 | 2026-05-22 |
| KD-29 | cat 气泡内嵌套块（Thinking / CLI 折叠块）背景纳入 cat-persona 派生 —— 新增 `--cat-msg-inset` 档（比 surface 沉一档，mode-aware：light 浅 / dark 深）| 旧实现 ThinkingContent / CliOutputBlock 用 tintedDark 把主色混进硬编码深 base `#1A1625`，游离在 F056 OKLCH 体系外、light 模式也恒为深色、与 light 气泡 surface 不协调；operator 2026-05-22 要求气泡内文本背景跟 cat-persona 派生、light 浅 dark 深、与外层气泡协调 | 2026-05-22 |
| KD-30 | Phase E Sweep — cat bubble routing 全部走 CSS var（callback / nested inset 不再 hex-derived），`.cat-persona-derived` always wired 在 cat message wrapper 上，Tuner 仅控制全局 `--cat-{tier}-l/cmul`（不出 per-slug overrides） | KD-29 落地后 callback bubbles + ThinkingContent inset 仍有 `tintedLight(hex)` 路径绕过 Tuner gradient；改造后单一 Tuner 全局生效，每只猫保留自己的 hue/chroma，无 hex 旁路 | 2026-05-25 |
| KD-31 | `cat-persona-tokens.css` 525 → 264 + `cat-persona-derived.css` 272，split point 在 `:root` light 结束 / dark override 开始处 | `global-css-architecture.test.ts` 350-line hard limit 测试守护单文件大小；split 仅按 selector 边界拆，无逻辑/语义改动；entrypoint + `layout.tsx` import + test assertion 同步更新 | 2026-05-28 |
| KD-32 | Variant slug 显式枚举：`opus-47 / spark / gemini25` 加入 `cat-persona-tokens.css` 派生 + Tuner SLUGS（共 12 slugs，覆盖所有 catalog 内 variant cat） | PR #784 codex P2 揭示：`STATIC_SLUGS` 集合包含但 `cat-persona-tokens.css` 没定义 → 走 `var(--color-{slug}-surface)` 拿不到值，气泡背景 fail；Tuner unified-text override 也漏 variants；显式列举 12 slugs 是当前 catalog 范围的真相源 | 2026-05-28 |
| KD-33 | 主题持久化：当前 localStorage（`cat-cafe:themes`），服务端持久化为 follow-up | OklchTuner 已从纯开发者工具演进为用户自定义主题入口。`themeStore.ts` 通过 Zustand + localStorage 持久化：activeId / built-in overrides / 自建主题（最多 2 个）/ 版本迁移。清浏览器数据会丢。服务端持久化（存到 `/api/config` 用户设置）独立 scope，当前 localStorage 已覆盖"同一浏览器日常使用" | 2026-05-28 |
| KD-34 | Surface 层 hue 独立于 accent（`--surface-hue` 独立旋钮），微量色调 chroma 由 `surfaceChroma` multiplier 控制 | operator拍板：页面背景色调可独立调整（light 默认 warm beige H=80, dark 默认 warm neutral H=30），不强制跟 accent hue 走——brand 色和底色解耦；Tuner "页面层次" 4 档控制 lightness，hue/chroma 由 surfaceHue/surfaceChroma 独立控制 | 2026-05-28 |
| KD-35 | Per-preset INIT 默认值：Light 和 Dark 各有独立 accent/surface hue+chroma（INIT_LIGHT vs INIT_DARK），migrateTunerState 按 base mode 匹配 | Light preset: accentHue=50/C=0.14, surfaceHue=80/C*=1.0; Dark preset: accentHue=35/C=0.08, surfaceHue=30/C*=0.15。themeStore 迁移时用 `initForBase(base)` 确保 custom theme 不会继承错误 preset 的默认值 | 2026-05-29 |

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
| ~1000 处硬编码颜色迁移引入视觉回归 | codemod 三桶分级 + Storybook stories + Playwright 截图基线 |
| 术语抽象 scope 失控（thread 已进路由/API/Redis） | KD-13 写死边界：F056 只做 UI glossary override |
| Storybook/Playwright 从零搭建成本 | 明确归入 Phase A3 预算，不低估 |

## Review Gate

- Phase A: operator + Siamese视觉 review（设计语言必须三猫+operator认可）
- Phase B/C: 常规跨家族 review
- Phase D: operator拍板企业定制边界 + 跨家族 review
