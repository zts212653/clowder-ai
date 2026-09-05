---
version: alpha
name: Clowder AI
description: "Clowder AI 的视觉基线：Anthropic 的暖编辑感（奶油画布、衬线大标题、赭红点缀）+ Linear 的精密结构（4px 节奏、发丝线分层、单一强调色、产品内容当主角）。猫味只在这个坐标系里加，不另起一套。"

colors:
  primary: "#b05f45"
  primary-active: "#8f4730"
  primary-soft: "#f3e3da"
  on-primary: "#ffffff"
  ink: "#141413"
  body: "#3d3d3a"
  muted: "#5f5d57"
  canvas: "#faf9f5"
  surface-1: "#f5f0e8"
  surface-2: "#efe9de"
  surface-3: "#e8e0d2"
  hairline: "#e6dfd8"
  hairline-strong: "#d6cec3"
  dark-canvas: "#181715"
  dark-surface-1: "#1f1e1b"
  dark-surface-2: "#252320"
  dark-surface-3: "#2d2b27"
  dark-hairline: "#34322d"
  dark-hairline-strong: "#45423c"
  on-dark: "#faf9f5"
  on-dark-muted: "#a09d96"
  success: "#3f8552"
  warning: "#a8721c"
  critical: "#c64545"
  info: "#4d7fa3"
  dark-success: "#6fbf80"
  dark-warning: "#d9a441"
  dark-critical: "#e06b6b"
  dark-info: "#7fb0d0"
  focus: "#b05f45"
  dark-focus: "#cc785c"

typography:
  display-lg:
    fontFamily: "Source Serif 4, Songti SC, Noto Serif CJK SC, Georgia, serif"
    fontSize: 40px
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: -0.8px
  display-md:
    fontFamily: "Source Serif 4, Songti SC, Noto Serif CJK SC, Georgia, serif"
    fontSize: 28px
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: -0.4px
  display-sm:
    fontFamily: "Source Serif 4, Songti SC, Noto Serif CJK SC, Georgia, serif"
    fontSize: 22px
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: -0.2px
  title-md:
    fontFamily: "Inter, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: -0.1px
  title-sm:
    fontFamily: "Inter, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  body-md:
    fontFamily: "Inter, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0
  body-sm:
    fontFamily: "Inter, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  caption:
    fontFamily: "Inter, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  eyebrow:
    fontFamily: "Inter, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 0.6px
  button:
    fontFamily: "Inter, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0

rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  pill: 9999px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  section: 64px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 6px 12px
    height: 32px
  button-primary-active:
    backgroundColor: "{colors.primary-active}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 6px 12px
    height: 32px
  button-ghost:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.body}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 6px 10px
    height: 32px
  text-input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 6px 10px
    height: 32px
  text-input-focused:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  focus-ring:
    backgroundColor: "{colors.focus}"
    size: 2px
  dark-focus-ring:
    backgroundColor: "{colors.dark-focus}"
    size: 2px
  divider:
    backgroundColor: "{colors.hairline}"
    height: 1px
  divider-strong:
    backgroundColor: "{colors.hairline-strong}"
    height: 1px
  card:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 16px
  panel:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    padding: 12px
  message-bubble-cat:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 10px 14px
  message-bubble-user:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 10px 14px
  badge-status:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.body}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: 2px 8px
  badge-primary:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary-active}"
    typography: "{typography.eyebrow}"
    rounded: "{rounded.pill}"
    padding: 2px 8px
  tab:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.muted}"
    typography: "{typography.title-sm}"
    rounded: "{rounded.md}"
    padding: 6px 10px
  tab-active:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.ink}"
    typography: "{typography.title-sm}"
    rounded: "{rounded.md}"
  top-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.title-sm}"
    height: 44px
  sidebar:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.body}"
    typography: "{typography.body-sm}"
    padding: 8px
  empty-state:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.muted}"
    typography: "{typography.display-sm}"
    padding: 48px
  code-block:
    backgroundColor: "{colors.dark-surface-1}"
    textColor: "{colors.on-dark}"
    typography: "{typography.mono}"
    rounded: "{rounded.md}"
    padding: 12px 14px
  callout-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.display-sm}"
    rounded: "{rounded.lg}"
    padding: 24px
  status-dot-success:
    backgroundColor: "{colors.success}"
    size: 8px
  status-dot-warning:
    backgroundColor: "{colors.warning}"
    size: 8px
  status-dot-critical:
    backgroundColor: "{colors.critical}"
    size: 8px
  status-dot-info:
    backgroundColor: "{colors.info}"
    size: 8px
  dark-status-dot-success:
    backgroundColor: "{colors.dark-success}"
    size: 8px
  dark-status-dot-warning:
    backgroundColor: "{colors.dark-warning}"
    size: 8px
  dark-status-dot-critical:
    backgroundColor: "{colors.dark-critical}"
    size: 8px
  dark-status-dot-info:
    backgroundColor: "{colors.dark-info}"
    size: 8px
  dark-card:
    backgroundColor: "{colors.dark-surface-1}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 16px
  dark-panel:
    backgroundColor: "{colors.dark-surface-2}"
    textColor: "{colors.on-dark}"
    typography: "{typography.body-md}"
    padding: 12px
  dark-tab-active:
    backgroundColor: "{colors.dark-surface-3}"
    textColor: "{colors.on-dark}"
    typography: "{typography.title-sm}"
    rounded: "{rounded.md}"
  dark-divider:
    backgroundColor: "{colors.dark-hairline}"
    height: 1px
  dark-divider-strong:
    backgroundColor: "{colors.dark-hairline-strong}"
    height: 1px
  dark-canvas:
    backgroundColor: "{colors.dark-canvas}"
    textColor: "{colors.on-dark-muted}"
    typography: "{typography.body-md}"
---

# Clowder AI Design

> **权威链**：结构判据 ADR-043 → 视觉语言与历史 [F056](docs/features/F056-cat-cafe-design-language.md) → **本文件 = 视觉意图与目标值的 canonical 真相源**（design intent / target） → 运行时实现 `packages/web/src/app/theme-tokens.css`。
> **两个真相域，不互相冒充**：本文件回答"我们要长成什么样"；`theme-tokens.css` 回答"现在实际长什么样"。在 F056 AC-F6 的 parity 守护测试落地之前，**运行时以 CSS 为准**，本文件的 token 是 F2 迁移的目标值（见文末 Implementation Mapping）；AC-F6 之后二者由测试强制一致，红 = 一方漂移，先修漂移的那一方。本文件的十六进制值是设计意图，不是运行时字面值的第二份拷贝（与 F305 AC-A4 的精神一致，F056 KD-37 记录了这次升级）。
> 出生：2026-09-04 co-creator选定 Anthropic + Linear 为视觉基线（thread_mtmmd0j92wuisea9）。种子取自两家真实站点提取的 DESIGN.md，再按 Clowder AI 是"密集协作工作区"而非"营销页"重新定标。

## Overview

Clowder AI 是人和几只猫一起工作的房间。看起来应该像一本安静的杂志放在一张整洁的工作台上：**纸是暖的，工具是冷静的**。

- **暖编辑感（Anthropic 侧）**：奶油画布 `{colors.canvas}`、暖墨 `{colors.ink}`、衬线体大标题（weight 400、负字距）、唯一的赭红强调 `{colors.primary}`。这是"像不像我们"的部分。
- **精密结构（Linear 侧）**：4px 节奏、32px 控件、发丝线而不是阴影、四级表面阶梯、产品内容当主角、chrome 退到背景。这是"好不好用"的部分。
- **猫味的位置**：猫在内容里（头像、名字、说话方式、彩蛋），不在 chrome 上。猫猫化不是猫化：一屏最多一个猫爪印级别的装饰，图标永远是设计过的 SVG，不是 emoji。

情绪目标：第一次打开的人应该觉得"安静、可信、有人在"，而不是"热闹、可爱、AI 味"。

## Colors

- **Primary — 赭红 (`{colors.primary}` #b05f45)**：整个系统唯一的品牌色。作为**面**只出现在三处：主按钮底、焦点环、品牌标记。它是稀缺资源——出现越少，出现时越有力。按下变 `{colors.primary-active}`；作为底色时只用 `{colors.primary-soft}` 做浅色 badge。比 Anthropic 原色 #cc785c 深一档，因为工作区按钮是 13px 白字，必须过 WCAG AA（4.6:1）；营销页可以浅，产品不行。
- **Primary 作为文字**：行内链接、选中态文字、强调词一律用 `{colors.primary-active}`（#8f4730，在四档表面上 5.15–6.41:1）；`{colors.primary}` 本身在画布上只有 4.36:1，**不做正文级文字**，只做 ≥ 22px 的展示性标题或图形。
- **Ink / Body / Muted**：文字三档暖灰 `{colors.ink}` / `{colors.body}` / `{colors.muted}`，最浅的 muted 在 canvas → surface-3 四档表面上都 ≥ 5.0:1。层级用这三档表达，不用加粗、不用换色；没有"更淡的灰"——看不清的文字不如不放。
- **Canvas 与表面阶梯**：`{colors.canvas}` 是页面底；`{colors.surface-1}` → `{colors.surface-2}` → `{colors.surface-3}` 逐级变暖变深，用来分区（侧栏、卡片、选中态）。分区靠"抬一级"，不靠阴影，不跳级。
- **Hairline**：`{colors.hairline}` 是默认 1px 边线，和表面差一级，读起来像折痕不像墨线；`{colors.hairline-strong}` 只给输入框和需要被看见的边。
- **Dark mode**：同一个房间关了灯。`{colors.dark-canvas}` 是暖近黑（不是蓝黑、不是纯黑），阶梯 `{colors.dark-surface-1..3}` 同样向上抬，边线 `{colors.dark-hairline}`。文字 `{colors.on-dark}` 带奶油色调，呼应画布。
- **Semantic**：`{colors.success}` / `{colors.warning}` / `{colors.critical}` / `{colors.info}` 只表达状态，只以 8px 圆点（`status-dot-*`）、输入框错误态边线或 badge **左侧圆点**出现。它们是非文字状态元素，按 WCAG 1.4.11 在 canvas → surface-3 四档表面上 ≥ 3:1（成立范围 3.15–4.59:1）；**永远不做文字色**（做正文不过 AA），badge 文字用 `{colors.body}`。**圆点永远不单独承担状态**：旁边必须有文字标签（"运行中 / 待你决定 / 失败"），颜色只是冗余提示，不是唯一通道。暗色模式用 `{colors.dark-success}` 等四个亮化变体（`dark-status-dot-*`，在暗表面 ≥ 4.3:1），不复用浅色值。不做大面积底色，不参与装饰。
- **Focus**：`{colors.focus}`（浅色）/ `{colors.dark-focus}`（暗色）只做键盘焦点环，配方见 Elevation 表：**外置 2px 实色 outline + 2px offset 间隙**。间隙露出宿主表面，所以焦点环只与表面相邻、永远不与控件本身相邻——控件是赭红主按钮还是画布色输入框都不影响可见性。浅色环对 canvas → surface-3 为 3.51–4.36:1，暗色环对 dark-canvas → dark-surface-3 为 4.31–5.47:1；焦点前后的变化对比 = 环色对表面，同一组数。没有透明层参与计算。
- **猫 persona 色**：每只猫的身份色是第三层，只上头像、名字、persona chip；不进按钮、不进背景、不进图表默认色。

## Typography

两种声音，边界清楚：

- **衬线 = 编辑声音**（`{typography.display-lg}` / `{typography.display-md}` / `{typography.display-sm}`）：页面标题、空态标语、猫在说"人话"的时刻、引言、一次性的仪式感。weight 固定 400，字号越大字距越负。中文走宋体（Songti SC / Noto Serif CJK SC），拉丁走 Source Serif 4。**只在 ≥ 22px 使用**——宋体在小字号发灰，不能拿它排正文。
- **无衬线 = 工作声音**（`{typography.title-md}` 及以下）：列表、表单、按钮、标签、消息正文、侧栏。这是密集工作区，正文 14px（`{typography.body-md}`），不是营销页的 16px。层级靠字号和三档灰，加粗只到 500。
- **等宽 = 机器声音**（`{typography.mono}`）：代码、ID、路径、SHA、diff。凡是"复制出去要一字不差"的东西都用等宽，其余地方不用。
- **Eyebrow**（`{typography.eyebrow}`）是唯一正字距的样式：11px、+0.6px，用来做小分类标签，和负字距的标题形成对照。

字体加载顺序即 fallback 顺序；系统没有 Source Serif 4 时退到 Songti/Georgia，仍是衬线——**绝不退到无衬线**，那会让整个系统失去声音。

## Layout

- **基准 4px**；间距 token `{spacing.xxs}` 4 → `{spacing.section}` 64。工作区内不存在 96px 的营销留白，`{spacing.section}` 64px 只给空态和设置页首屏。
- **控件高度统一 32px**（按钮、输入、tab、select）。这是 Linear 密度，不是 Anthropic 营销页的 40px；40px 只给空态/首屏里唯一的主动作。
- **卡片内距 16px**（`{spacing.md}`），面板内距 12px，消息气泡 10px 14px。
- **容器**：阅读主体最大 720px（消息流、文档），工作区整体不设上限，右栏 320–360px。
- **首屏规则（ADR-043 C5）**：折叠态先设计。用户不点开时必须知道的最小事实集放首屏，其余按需展开；URI、revision、路径、原始 JSON 默认折叠。
- **留白哲学**：奶油画布本身就是留白。分区靠表面抬一级 + 发丝线，不靠大段空白；同一区块内元素间距 8px，区块间 16–24px。

## Elevation & Depth

| 层级 | 处理 | 用途 |
|---|---|---|
| 0 平 | 无边无影 | 正文、标题、大多数区域 |
| 1 抬一级 | `{colors.surface-1}` + 1px `{colors.hairline}` | 侧栏、面板、默认卡片 |
| 2 抬两级 | `{colors.surface-2}` + 1px `{colors.hairline}` | 选中项、hover 后的卡片、用户气泡 |
| 3 抬三级 | `{colors.surface-3}` | 激活 tab、选中分类 |
| 浮层 | 表面 + 1px `{colors.hairline-strong}` + 小阴影 `0 4px 10px rgba(20,20,19,0.10)` | 弹出菜单、popover、对话框——**只有真正离开页面平面的东西才有阴影** |
| 焦点 | `outline: 2px solid {colors.focus}` + `outline-offset: 2px`（暗色用 `{colors.dark-focus}`）；控件自身边线与底色不变 | 所有可聚焦控件，键盘可见；环与控件之间的 2px 间隙露出宿主表面，环只需对表面 ≥ 3:1 |

原则：**色块优先，阴影稀有**。深度由暖表面阶梯和发丝线承担；阴影只证明"这个东西浮在页面上方"。暗色模式下浮层顶边加 1px 白色 10% 高光代替阴影扩散。

装饰性深度：产品内容本身（消息、diff、图、卡片里的真实数据）是唯一的"插画"。不加氛围渐变、光斑、玻璃拟态、噪点纹理。

## Shapes

| Token | 值 | 用途 |
|---|---|---|
| `{rounded.xs}` | 4px | 小 chip、状态 badge 内的方形元素、代码内联 |
| `{rounded.sm}` | 6px | 行内 tag、下拉项 |
| `{rounded.md}` | 8px | **所有按钮、输入框、tab、代码块** |
| `{rounded.lg}` | 12px | 卡片、面板、消息气泡、对话框 |
| `{rounded.xl}` | 16px | 大预览容器（截图、媒体、嵌入浏览器） |
| `{rounded.pill}` | 9999px | 只给 badge / 状态 pill。**按钮不做 pill** |
| `{rounded.full}` | 9999px | 头像、圆点（等宽高元素上与 pill 同值，语义不同：full = 圆，pill = 胶囊） |

消息气泡是 12px，不是 24px；主按钮是 8px，不是 100px。圆角越大越"可爱"，而我们要的是"安静"。

图片与头像：头像永远圆形，尺寸 20 / 28 / 40；截图和预览保持原比例放进 `{rounded.xl}` 容器，不裁切、不加边框光。

## Components

### 按钮
- `button-primary`：赭红底、白字、8px 圆角、32px 高。**一屏一个**。按下变 `button-primary-active`，没有 hover 变色。
- `button-secondary`：画布底 + `{colors.hairline-strong}` 边。默认的"第二个动作"。
- `button-ghost`：无底无边，只有文字色 `{colors.body}`，hover 抬到 `{colors.surface-1}`。工具栏、行内动作用这个。
- 图标按钮 28×28，图标 16px，永远是设计过的 SVG。

### 输入
- `text-input`：32px 高、画布底、`{colors.hairline-strong}` 边；聚焦时边线和底色都不变，只在控件外 2px 处出现 2px 实色 `focus-ring`（`outline-offset: 2px`），不加阴影。
- 占位文字 `{colors.muted}`；错误态边线 `{colors.critical}` + 下方 12px 说明文字（`{colors.body}`，不用红字），不整块变红。

### 容器
- `card`：`{colors.surface-1}` + 发丝线 + 12px 圆角 + 16px 内距。**卡片里不套卡片**；需要分组用 8px 间距或一条发丝线。
- `panel`：侧栏/右栏的容器，无圆角、只有一条分隔发丝线。
- `dark-card` / `code-block`：暖近黑表面，承载代码、终端、原始输出。这是页面上唯一允许的"深色块"，它的存在是因为内容是代码，不是为了好看。

### 对话
- `message-bubble-cat`：画布底、无边，靠头像和名字定位，正文 14px。猫说话不需要一个框把它围起来。
- `message-bubble-user`：`{colors.surface-2}` 抬一级、12px 圆角，右对齐。
- 猫的衬线时刻：猫主动开启话题、空态问候、总结陈词可以用 `{typography.display-sm}`；日常回复用正文。

### 状态与标签
- `badge-status`：pill、`{colors.surface-2}` 底、12px 字。文字表达状态，颜色只给左侧 8px 圆点（`status-dot-*`，在 surface-2 上 ≥ 3.4:1）；没有文字的裸圆点不是合法状态指示。
- `badge-primary`：`{colors.primary-soft}` 底 + `{colors.primary-active}` 字，用于"新 / 推荐 / 待你决定"这种需要被看见的少量标签。
- `tab` / `tab-active`：选中 = 抬到 `{colors.surface-3}` + 字色变 ink，不用下划线，不用主色。

### 导航
- `top-bar`：44px、画布底、底部一条发丝线，标题 14px/500。不放品牌色。
- `sidebar`：`{colors.surface-1}`，条目 28px 高、13px 字，选中项抬到 `{colors.surface-2}`。

### 空态与仪式
- `empty-state`：衬线 22px 标语（`{typography.display-sm}`）+ 一句 14px 说明 + 一个 `button-primary`。这是衬线体和 40px 按钮唯一常规出场的地方。
- `callout-primary`：赭红整块底 + 衬线标题，只用于一次性的重大时刻（首次进入、里程碑、co-creator需要拍板）。一个页面最多一个，多数页面没有。

## Do's and Don'ts

### Do
- 画布用 `{colors.canvas}` 奶油色；暗色用 `{colors.dark-canvas}` 暖近黑。这是"我们家"的第一识别点。
- 标题用衬线 400 + 负字距；正文用无衬线 14px；代码用等宽。三种声音各司其职。
- 赭红作为面只出现在主按钮、焦点、品牌标记；作为文字（链接 / 选中 / 强调）用 `{colors.primary-active}`。一屏一个主按钮。
- 分层靠表面阶梯 + 发丝线；阴影只给真正浮起的层。
- 焦点永远是外置 2px 实色环 + 2px 间隙；不用透明层、不用内嵌边、不用改控件底色来表示焦点。
- 控件 32px、圆角 8px、卡片 12px。密度向 Linear 看齐。
- 让内容当主角：真实消息、真实 diff、真实数据。chrome 越退后越好。
- 先写折叠态：用户不点开时需要知道的最小事实集在首屏，其余按需展开（ADR-043 C5）。
- 猫味放在头像、名字、语气、彩蛋；一屏最多一个猫爪印级别的装饰。
- 交付任何视觉改动前，附渲染后的截图；没有截图不进 Design Gate。

### Don't
- 不用纯白 `#ffffff` 做画布，不用纯黑 `#000000` 做暗底，不用冷灰。
- 不用紫色、蓝紫渐变、任何渐变按钮、玻璃拟态、光斑、噪点——这些是"AI 味"的指纹。
- 不引入第二个品牌色。绿黄红蓝只表达状态，只以圆点 / 错误边线 / badge 圆点出现，永远配文字标签，永远不做文字色。
- 不用 emoji 当图标；不用猫 emoji 当装饰；不把猫爪印铺满界面。
- 不用 Inter/无衬线做大标题，不把衬线用在 22px 以下。
- 不做 pill 按钮，不做 24px 圆角气泡，不做 100px 圆角。
- 不在卡片里套卡片，不做全宽 stat tile 阵列，不做"上个世纪的仪表盘"（F174 教训）。
- 不给 hover 加新的颜色语义；hover 只允许抬一级表面。
- 不把 Feature ID、Gate、stage、内部术语写进产品文案（ADR-043 / design-in-context）。
- 不凭"我觉得挺好看"交付；好看由co-creator在 A/B 截图里选，猫只负责给出可选项。

## Implementation Mapping

本文件是视觉意图与**目标值**；`packages/web/src/app/theme-tokens.css` 是**当前运行时**（OKLCH 单 hue 派生）。AC-F6 之前以 CSS 为准，下表右两列就是 F2 要合拢的差距；AC-F6 之后由 parity 测试强制一致。二者的对应关系：

| 本文件 | 运行时旋钮 / 变量 | 现状（2026-09-04） | 目标 |
|---|---|---|---|
| `{colors.primary}` #b05f45 | `--accent-hue` / `--accent-chroma` → `--accent-500` | hue 50 / chroma 0.14（暖金） | hue ≈ 38 / chroma ≈ 0.11（赭红），L 0.55 与现有 AA 约束一致 |
| `{colors.canvas}` #faf9f5 | `--surface-hue` / `--cafe-surface-*` 四档 | hue 80 / L 0.92–0.995 | hue ≈ 75，L 分布对齐 canvas → surface-3 |
| `{colors.ink}` 系 | `--neutral-*` 11 档（hue 30） | 已是暖中性 | 不变 |
| `{colors.dark-*}` | `[data-theme="dark"]` 表面四档 | L 0.21–0.36 | 对齐 dark-canvas → dark-surface-3，保持暖 hue |
| `{typography.display-*}` | 全局 `font-family`（目前仅 Inter） | 无衬线单声音 | 增加衬线 display 字体栈；正文保持 Inter |
| `{rounded.*}` / 控件 32px | Tailwind `borderRadius` + 组件类 | 气泡 24px、pill 按钮存量 | 迁移到 8 / 12 / 16 |

迁移在 F056 Phase F 里分步进行；每一步以 A/B 渲染截图由co-creator选定，再落 token。本文件 token 与运行时解析值的一致性由 F056 AC-F6 的 parity 守护测试保证（落地前不声明一致）；本文件**允许的角色配对**（文字 × 表面、on-primary × primary 等）的对比度由 `scripts/check-design-md.test.mjs` 的确定性矩阵守住，lint 只覆盖已声明的组件对，矩阵覆盖 prose 允许的全部配对。
