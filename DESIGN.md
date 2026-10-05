---
version: alpha
name: Clowder AI
description: "Clowder AI 的视觉基线：Anthropic 的暖编辑感（奶油画布、衬线大标题、赭红点缀）+ Linear 的精密结构（4px 节奏、发丝线分层、单一强调色、产品内容当主角）。2026-09-29 起浅色表面改为同色调 T1 四层（外框安静、作品最亮），并补齐 Workspace 外壳与组件语法。猫味只在这个坐标系里加，不另起一套。设计资料的总入口是正文开头的「从这里开始」。"

colors:
  primary: "#b05f45"
  primary-active: "#8f4730"
  primary-soft: "#f3e3da"
  on-primary: "#ffffff"
  ink: "#141413"
  body: "#3d3d3a"
  muted: "#5f5d57"
  canvas: "#fffbf6"
  surface-1: "#fcf7f0"
  surface-2: "#f7f2ea"
  surface-3: "#efe9e3"
  hairline: "#e5dfd5"
  hairline-strong: "#d8d1c6"
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
  category-object: "#007565"
  category-rubric: "#5c5fac"
  category-measurement: "#8f4d89"
  category-diagnosis: "#6c6610"
  dark-category-object: "#52b9a7"
  dark-category-rubric: "#969cee"
  dark-category-measurement: "#cf88c8"
  dark-category-diagnosis: "#aea85b"
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
  body-lg:
    fontFamily: "Inter, -apple-system, PingFang SC, Noto Sans CJK SC, sans-serif"
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.7
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
  button-destructive:
    backgroundColor: "{colors.critical}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 6px 12px
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
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 16px
  panel:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    padding: 12px
  message-bubble-cat:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.lg}"
    padding: 10px 14px
  message-bubble-user:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.ink}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.lg}"
    padding: 10px 14px
  badge-status:
    backgroundColor: "{colors.surface-3}"
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
  category-accent-object:
    backgroundColor: "{colors.category-object}"
    size: 18px
    rounded: "{rounded.md}"
  category-accent-rubric:
    backgroundColor: "{colors.category-rubric}"
    size: 18px
    rounded: "{rounded.md}"
  category-accent-measurement:
    backgroundColor: "{colors.category-measurement}"
    size: 18px
    rounded: "{rounded.md}"
  category-accent-diagnosis:
    backgroundColor: "{colors.category-diagnosis}"
    size: 18px
    rounded: "{rounded.md}"
  dark-category-accent-object:
    backgroundColor: "{colors.dark-category-object}"
    size: 18px
    rounded: "{rounded.md}"
  dark-category-accent-rubric:
    backgroundColor: "{colors.dark-category-rubric}"
    size: 18px
    rounded: "{rounded.md}"
  dark-category-accent-measurement:
    backgroundColor: "{colors.dark-category-measurement}"
    size: 18px
    rounded: "{rounded.md}"
  dark-category-accent-diagnosis:
    backgroundColor: "{colors.dark-category-diagnosis}"
    size: 18px
    rounded: "{rounded.md}"
  switch-on:
    backgroundColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: 16px
  switch-off:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.pill}"
    height: 16px
  slider-track:
    backgroundColor: "{colors.hairline-strong}"
    height: 4px
  slider-fill:
    backgroundColor: "{colors.ink}"
    height: 4px
  settings-row:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    height: 40px
  inline-notice:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.body}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 8px 10px
  tooltip:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-dark}"
    typography: "{typography.caption}"
    rounded: "{rounded.md}"
    padding: 0 10px
    height: 28px
  desktop-overlay:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.body}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
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
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.ink}"
    typography: "{typography.title-sm}"
    height: 52px
  sidebar:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.body}"
    typography: "{typography.body-md}"
    padding: 8px
  world-rail:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.muted}"
    typography: "{typography.caption}"
    width: 52px
  artifact-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.title-sm}"
    rounded: "{rounded.xl}"
  action-receipt:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.body}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 7px 12px
  annotation-card:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.body}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: 12px 14px
  work-desk:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.body}"
    typography: "{typography.body-md}"
  empty-state:
    backgroundColor: "{colors.surface-1}"
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

## 从这里开始

碰 UI / UX / 设计 / 视觉，先读这一节，再按需往下找。

- **长什么样**（颜色、字号、间距、组件）→ 本文件。
- **入口放哪、叫什么**（窄栏 / 侧栏 / 对话顶栏 / Workspace / 设置与管理）→ 主页北极星 README §0.5。
- **界面上的字怎么起**（标题、按钮、菜单、状态、报错）→ 本文件"界面上的字"。
- **怎么出一张北极星稿** → 本文件末尾"北极星稿的做法"；配色来历、可迁移的方法和踩过的坑 → Studio 北极星 README §2.1–§4。
- **做前端时逐项检查** → [design-in-context 检查清单](cat-cafe-skills/refs/design-in-context-checklist.md)（`console-dev` 的设计关卡用它）。
- **已有的北极星稿** → 主页、Studio、共同体（F290）、记忆（F321）、桌面猫（F317）。新稿复用主页稿的外壳和变量，不另起一套。

> **权威链**：结构判据 ADR-043 → 视觉语言与历史 [F056](docs/features/F056-cat-cafe-design-language.md) → **本文件 = 视觉意图与目标值的 canonical 真相源**（design intent / target） → 运行时实现 `packages/web/src/app/theme-tokens.css`。
> **两个真相域，不互相冒充**：本文件回答"我们要长成什么样"；`theme-tokens.css` 回答"现在实际长什么样"。在 F056 AC-F6 的 parity 守护测试落地之前，**运行时以 CSS 为准**，本文件的 token 是 F2 迁移的目标值（见文末 Implementation Mapping）；AC-F6 之后二者由测试强制一致，红 = 一方漂移，先修漂移的那一方。本文件的十六进制值是设计意图，不是运行时字面值的第二份拷贝（与 F305 AC-A4 的精神一致，F056 KD-37 记录了这次升级）。
> 出生：2026-09-04 co-creator选定 Anthropic + Linear 为视觉基线（[thread-id]）。种子取自两家真实站点提取的 DESIGN.md，再按 Clowder AI 是"密集协作工作区"而非"营销页"重新定标。
>
> **v2 候选（2026-09-29）**：Workspace 重构中 You 选定"A 暖纸 · 同色调 T1"（Studio 北极星、主页北极星），本版把浅色四层表面、外壳的参考尺寸、组件语法、"刚进来的画"和北极星稿做法写回本文件。高密度页面与审批页已在样张上按新语法画过；暗色只做了回归检查，暗色值保持原值，组件按明暗关系映射（见 Colors 的 Dark mode），暗色定稿后再改值；运行时 `theme-tokens.css` 随 Workspace 重构迁移，迁移前以 CSS 为准（见文末）。
>
> **入口放哪、叫什么不在本文件定**：窄栏、侧栏、对话顶栏、Workspace、设置与管理各放什么，以主页北极星 README 的 §0.5 为准（越往左管的范围越大，每样东西只放一处）。本文件只写这些入口长什么样；两处说法不一致时，以 §0.5 为准，并回来改本文件。

## Overview

Clowder AI 是人和几只猫一起工作的房间。看起来应该像一本安静的杂志放在一张整洁的工作台上：**纸是暖的，工具是冷静的**。

- **暖编辑感（Anthropic 侧）**：奶油画布 `{colors.canvas}`、暖墨 `{colors.ink}`、衬线体大标题（weight 400、负字距）、唯一的赭红强调 `{colors.primary}`。这是"像不像我们"的部分。
- **精密结构（Linear 侧）**：4px 节奏、32px 控件、发丝线而不是阴影、四级表面阶梯、产品内容当主角、chrome 退到背景。这是"好不好用"的部分。
- **猫味的位置**：猫在内容里（头像、名字、说话方式、彩蛋），不在 chrome 上。猫猫化不是猫化：一屏最多一个猫爪印级别的装饰，图标永远是设计过的 SVG，不是 emoji。
- **外框安静，作品最亮**（2026-09-29）：世界栏、侧栏这些外框是最暗、最安静的一层；对话在工作面上；作品、文档、输入框是最亮的纸面。温度交给真实内容，以及少数"刚进来"时刻的一幅画（见组件），不给外框上色、不在外框里加装饰。

情绪目标：第一次打开的人应该觉得"安静、可信、有人在"，而不是"热闹、可爱、AI 味"。

## Colors

- **Primary — 赭红 (`{colors.primary}` #b05f45)**：整个系统唯一的品牌色。作为**面**只出现在三处：主按钮底、焦点环、品牌标记。它是稀缺资源——出现越少，出现时越有力。按下变 `{colors.primary-active}`；作为底色时只用 `{colors.primary-soft}` 做浅色 badge。比 Anthropic 原色 #cc785c 深一档，因为工作区按钮是 13px 白字，必须过 WCAG AA（4.6:1）；营销页可以浅，产品不行。
- **Primary 作为文字**：行内链接、选中态文字、强调词一律用 `{colors.primary-active}`（#8f4730，在四档表面上 5.60–6.55:1）；`{colors.primary}` 本身在画布上只有 4.46:1，**不做正文级文字**，只做 ≥ 22px 的展示性标题或图形。
- **Ink / Body / Muted**：文字三档暖灰 `{colors.ink}` / `{colors.body}` / `{colors.muted}`，最浅的 muted 在 canvas → surface-3 四档表面上都 ≥ 5.4:1（5.47–6.39）。层级用这三档表达，不用加粗、不用换色；没有"更淡的灰"——看不清的文字不如不放。 时间戳、次要说明同样用 `{colors.muted}`，不另设第四档。
- **Canvas 与表面阶梯（同色调 T1）**：四层同一个暖色相，越往外越暗、越安静：`{colors.canvas}` 纸面（文档、作品卡片、输入框、弹层）→ `{colors.surface-1}` 工作面（对话区、主区顶栏）→ `{colors.surface-2}` 外框（世界栏、侧栏、作品模式的聊天栏）→ `{colors.surface-3}` 选中项、用户气泡、回执、标签底，以及作品模式里纸面背后的工作台。四层是**用途角色**，不是必须逐级嵌套的层数：只要求放上去的内容比它所在的区域更亮（"纸比桌子亮"），纸面直接放在 `{colors.surface-3}` 工作台上是合法搭配。分区靠明暗差和发丝线，不靠阴影。色温必须统一：不在暖色外框里放中性白（You 2026-09-29："暖纸配白色很奇怪"；层次要像"骨相"一样清楚，"全部糊一起就很扁平"）。
- **Hairline**：`{colors.hairline}` 是默认 1px 边线，和表面差一级，读起来像折痕不像墨线；`{colors.hairline-strong}` 只给输入框和需要被看见的边。
- **Dark mode**：同一个房间关了灯。`{colors.dark-canvas}` 是暖近黑（不是蓝黑、不是纯黑），阶梯 `{colors.dark-surface-1..3}` 同样向上抬，边线 `{colors.dark-hairline}`。文字 `{colors.on-dark}` 带奶油色调，呼应画布。（2026-09-29 回归检查，见 v2 样张：浅色 T1 的组件映射**不能按名字搬进暗色**——暗色阶梯是 canvas 最暗，按名字一换，纸面会成为最暗的一层，卡片和输入框像凹进去。暗色按明暗关系映射：外框最暗，工作面、纸面依次抬亮，选中最亮；浅色 surface-3 兼任的"作品背后的工作台"在暗色里比纸暗一级。暗色的强调字与角标还没有变量，样张用的是候选值。本批 8 天联合交付里，新版遇到暗色时色值沿用运行时 `theme-tokens.css` 现有的暗色梯度（You 2026-06-10 调过），只改组件对应到哪一层；DESIGN.md 暗色 hex 与运行时值怎么统一，等暗色北极星定稿后再改。）
- **Semantic**：`{colors.success}` / `{colors.warning}` / `{colors.critical}` / `{colors.info}` 只表达状态，只以 8px 圆点（`status-dot-*`）、输入框错误态边线或 badge **左侧圆点**出现；唯一的实心例外是 `button-destructive`（见"按钮"）。它们是非文字状态元素，按 WCAG 1.4.11 在 canvas → surface-3 四档表面上 ≥ 3:1（成立范围 3.43–4.70:1）；**永远不做文字色**（做正文不过 AA），badge 文字用 `{colors.body}`。**圆点永远不单独承担状态**：旁边必须有文字标签（"运行中 / 待你决定 / 失败"），颜色只是冗余提示，不是唯一通道。暗色模式用 `{colors.dark-success}` 等四个亮化变体（`dark-status-dot-*`，在暗表面 ≥ 4.3:1），不复用浅色值。不做大面积底色，不参与装饰。
- **Content Category**：`{colors.category-object}` / `{colors.category-rubric}` / `{colors.category-measurement}` / `{colors.category-diagnosis}` 只区分同一工作面里的稳定内容类别，不表达动作优先级或运行状态。类别必须同时有文字与语义 SVG；颜色可作为低浓度浅底字段和图标色，但不能单独承载类别。暗色使用四个 `dark-category-*` 亮化变体。初始映射为对象 = teal、规约 = violet、测量 = berry、诊断 = moss，来自 operator 对 F311 B「柔和色块」的选择（`[thread-id]#private-source-id`）；其他页面只有复用同一类别语义时才可消费，不能把它们变成第二品牌色或装饰色。
- **Focus**：`{colors.focus}`（浅色）/ `{colors.dark-focus}`（暗色）只做键盘焦点环，配方见 Elevation 表：**外置 2px 实色 outline + 2px offset 间隙**。间隙露出宿主表面，所以焦点环只与表面相邻、永远不与控件本身相邻——控件是赭红主按钮还是画布色输入框都不影响可见性。浅色环对 canvas → surface-3 为 3.82–4.46:1，暗色环对 dark-canvas → dark-surface-3 为 4.31–5.47:1；焦点前后的变化对比 = 环色对表面，同一组数。没有透明层参与计算。
- **猫 persona 色**：每只猫的身份色是第三层，只上头像、名字、persona chip（对话里的名片牌就是它，见"对话"）；不进按钮、不进背景、不进图表默认色。

## Typography

两种声音，边界清楚：

- **衬线 = 编辑声音**（`{typography.display-lg}` / `{typography.display-md}` / `{typography.display-sm}`）：页面标题、空态标语、猫在说"人话"的时刻、引言、一次性的仪式感。weight 固定 400，字号越大字距越负。中文走宋体（Songti SC / Noto Serif CJK SC），拉丁走 Source Serif 4。**只在 ≥ 22px 使用**——宋体在小字号发灰，不能拿它排正文。
- **无衬线 = 工作声音**（`{typography.title-md}` 及以下）：列表、表单、按钮、标签、消息正文、侧栏。这是密集工作区，正文 14px（`{typography.body-md}`），不是营销页的 16px。层级靠字号和三档灰，加粗只到 500。 阅读栏里的正文（对话、文档）用 `{typography.body-lg}` 15px / 1.7；列表、表单、侧栏、按钮仍是 14px 及以下。
- **等宽 = 机器声音**（`{typography.mono}`）：代码、ID、路径、SHA、diff。凡是"复制出去要一字不差"的东西都用等宽，其余地方不用。
- **Eyebrow**（`{typography.eyebrow}`）是唯一正字距的样式：11px、+0.6px，用来做小分类标签，和负字距的标题形成对照。

字体加载顺序即 fallback 顺序；系统没有 Source Serif 4 时退到 Songti/Georgia，仍是衬线——**绝不退到无衬线**，那会让整个系统失去声音。

## Layout

- **基准 4px**；间距 token `{spacing.xxs}` 4 → `{spacing.section}` 64。工作区内不存在 96px 的营销留白，`{spacing.section}` 64px 只给空态和设置页首屏。
- **控件高度统一 32px**（按钮、输入、tab、select）。这是 Linear 密度，不是 Anthropic 营销页的 40px；40px 只给空态/首屏里唯一的主动作。
- **卡片内距 16px**（`{spacing.md}`），面板内距 12px，消息气泡 10px 14px。
- **容器**：阅读主体最大 720px（消息流、文档），工作区整体不设上限，右栏 320–360px。
- **外壳**（2026-09-29）：从左到右是世界栏（`{colors.surface-2}`）、侧栏（`{colors.surface-2}`）、对话区（`{colors.surface-1}`，阅读栏居中，输入框在栏底）。作品模式里对话退到作品左侧的聊天栏，其余空间给作品（纸面放在 `{colors.surface-3}` 工作台上，默认整张看全、不放大超过原尺寸，见"作品模式"）。**尺寸是 1440 宽样张的参考值**：世界栏 52、侧栏 300、阅读栏 720、作品模式聊天栏 400、顶栏 52（52 是候选宽度，不能拿来缩字或藏含义）。**行为按原负责方的合同，不按本文件**：作品模式是用户显式进入 / 退出、约 30/70 可拖动的默认比例，尊重用户调过的宽度，退出后恢复原来的经典比例；聊天始终是同一个运行中的对话（同一 Chat runtime / 同一 DOM），不销毁、不另起第二份（F307 `[thread-id]#private-source-id`，F322 联合交付节）；默认聊天在左、作品在右，用户可以显式进入整窗，让聊天暂时让开，退出恢复原来的比例和现场（F307 KD-25，见"作品模式"）。
- **首屏规则（ADR-043 C5）**：折叠态先设计。用户不点开时必须知道的最小事实集放首屏，其余按需展开；URI、revision、路径、原始 JSON 默认折叠。
- **留白哲学**：奶油画布本身就是留白。分区靠表面抬一级 + 发丝线，不靠大段空白；同一区块内元素间距 8px，区块间 16–24px。

## Elevation & Depth

| 层级 | 处理 | 用途 |
|---|---|---|
| 0 平 | 无边无影 | 正文、标题、大多数区域 |
| 纸面 | `{colors.canvas}` + 1px `{colors.hairline}`，放在比它暗的区域上 | 作品卡片、文档纸面、输入框 |
| 工作面 / 外框 | `{colors.surface-1}` / `{colors.surface-2}`，区域之间一条 `{colors.hairline}` | 对话区与主区顶栏、批注卡（放在工作台上，比作品纸面暗一级，让作品最亮） / 世界栏、侧栏、聊天栏 |
| 选中 | `{colors.surface-3}` | 选中项、用户气泡、回执、激活 tab、作品背后的工作台 |
| 浮层 | 表面 + 1px `{colors.hairline-strong}` + 小阴影 `0 4px 10px rgba(20,20,19,0.10)` | 弹出菜单、popover、对话框、桌面浮层（见组件）——**只有真正离开页面平面的东西才有阴影** |
| 焦点 | `outline: 2px solid {colors.focus}` + `outline-offset: 2px`（暗色用 `{colors.dark-focus}`）；控件自身边线与底色不变 | 所有可聚焦控件，键盘可见；环与控件之间的 2px 间隙露出宿主表面，环只需对表面 ≥ 3:1 |

原则：**色块优先，阴影稀有**。深度由暖表面阶梯和发丝线承担；阴影只证明"这个东西浮在页面上方"。暗色模式下浮层顶边加 1px 白色 10% 高光代替阴影扩散。

装饰性深度：产品内容本身（消息、diff、图、卡片里的真实数据）是唯一的"插画"——唯一例外是"刚进来"时刻的地方画（见组件）。不加氛围渐变、光斑、玻璃拟态、噪点纹理。

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
- `button-destructive`：`{colors.critical}` 实心底、白字、8px 圆角、32px 高；宽度随文字（不小于 96px），不拉满整行。只给"现在就结束一件正在进行的事"的动作（如挂断通话）。**一屏一个**，不和 `button-primary` 放在同一行。同屏其他有后果的动作用 `button-secondary`，把后果写进按钮名（"结束通话并关闭"）。这是语义色做实心底的唯一例外。
- 成对按钮的顺序：取消在前，起作用的那个在后。
- 图标按钮 28×28，图标 16px，永远是设计过的 SVG。

### 输入
- `text-input`：32px 高、画布底、`{colors.hairline-strong}` 边；聚焦时边线和底色都不变，只在控件外 2px 处出现 2px 实色 `focus-ring`（`outline-offset: 2px`），不加阴影。
- 占位文字 `{colors.muted}`；错误态边线 `{colors.critical}` + 下方 12px 说明文字（`{colors.body}`，不用红字），不整块变红。

### 设置与表单控件
- `switch-on` / `switch-off`：26×16，圆钮 12px。开 = `{colors.ink}` 底 + 画布圆钮；关 = 画布底 + 1px `{colors.muted}` 边 + muted 圆钮（关的状态也要和底面分得开，浅灰底加白钮不够）。不用赭红，赭红留给一屏唯一的主动作。开关表示一项设置现在是开还是关；更改要先确认时（如通话中调整资料访问权限），点了先进确认页，确认成功后开关才变。
- `slider-track` / `slider-fill`：4px 槽，已选部分 ink；圆钮 14px，画布底 + 1px `{colors.muted}` 边。两端标出含义（如"小 / 大"）；需要精确数值时才在右边写数，带单位。
- `settings-row`：设置里的一行。最小 40px 高；左边标题用 `{typography.body-md}` ink，可带一行 `{typography.caption}` muted 说明；右边是当前值加"›"或开关。分组标题用 `{typography.eyebrow}` muted，组与组之间一条发丝线。
- 选择行（单选列表）：28px 头像或缩略图 + 名称，可带一行 caption 说明；选中行垫 `{colors.surface-1}`，右侧 ink 对勾。不可选的行整体减淡，并写明原因。
- `inline-notice`：原位的提示条。工作面底 + 发丝线 + 8px 圆角，左边状态圆点，正文 `{typography.body-sm}`，右边最多一个动作。哪一项出了问题，就紧跟在那一项后面，不弹窗。

### 容器
- `card`：`{colors.canvas}` 纸面 + 发丝线 + 12px 圆角 + 16px 内距，放在比它暗的区域上。**卡片里不套卡片**；需要分组用 8px 间距或一条发丝线。
- `panel`：外框容器（`{colors.surface-2}`），无圆角、只有一条分隔发丝线。
- `dark-card` / `code-block`：暖近黑表面，承载代码、终端、原始输出。这是页面上唯一允许的"深色块"，它的存在是因为内容是代码，不是为了好看。

### 对话
- `message-bubble-cat`：工作面底、无边，正文 `{typography.body-lg}`。猫说话不需要一个框把它围起来：不画气泡、不填底、不描边（2026-10-01 You 定）。
- 猫的名片牌：每次回话开头一块，认人靠它。16px 头像 + 名字（13px / 600），头像在牌子里不带圈：牌子本身已经是猫的颜色，再加一圈等于把同一个颜色标两遍（`CatNameplate` 用 `ring="none"`，别处的头像不变）；如果哪只猫的头像在暗色牌子上糊成一片，加 1px `{colors.hairline}` 细线，不用猫的主色。牌高 26px，上两角 8px 圆角，左右内距 8px / 10px；时间跟在牌子右边（12px `{colors.muted}`）。牌子的底用这只猫在当前主题下的表面色，从上往下淡出到透明；名字用当前主题下的猫名字色。牌子下面直接是正文，作品卡片、动作回执、状态行跟在正文下面，都不再包一层框。
- 名字读得清的判据：在当前主题（浅色、暗色、调色器调过的）下，名字文字覆盖到的每一处，和它实际叠出来的背景（渐变、透明叠底、下面的工作面一起算）的最小对比 ≥ 4.5:1。不够就在当前主题里调名字色或牌子色，不朝一个固定方向压暗（暗色里往 ink 压只会更糊）。参考数只对北极星稿那张浅色样张成立（牌底 = 75% 猫浅色 + 25% 工作面）：家里三种家族色的名字用"65% 主色 + 35% `{colors.ink}`"是 4.64–5.54:1，稿子里的 75% 在暹罗蓝上只有 3.84:1；这不是公式。暗色沿用同一条规则：牌底是这只猫在暗色下的表面色，往下淡到透明，名字用暗色的名字角色；不为暗色另写公式，嫌牌子太淡就在 F056 调色器里调暗色的猫表面明度（设计负责人 2026-10-01 认可，`[thread-id]#private-source-id`；实现 #4978）。#4978 作者自测的 16 格（浅、暗、各调过表面）最低 8.69:1，只覆盖这些主题且没调名字角色，不代替上面按当前主题实测的判据。名字角色在显示时有可读下限：用户保存的值原样保留，只有不够读时，显示值才往最近能过的一侧移动明度（色相、彩度不动；两侧差不多时取当前主题文字本来的方向）；两侧都过不了就取最差处对比最高的那个明度（不一定在两端）。
- 颜色从哪来不变：仍走 F056 那条链（`ThemeApplier` → `themeStore` 的 `buildCSS` → 按明暗各自派生的 OKLCH 梯度与 `--cat-name-*`，落到 `--color-{slug}-surface`、`--color-{slug}-text` 这些角色；起点是 `cat-config.json` 的猫色）。名片牌消费当前生效的这些角色，调色器对名字和表面的调节照样生效，不另造一套固定色公式。现在运行时的名字色是所有猫共用的一组 H / L / C，名片牌上的名字要不要带各自的色相，由调色器的名字角色决定。变的是用在哪：从整块气泡底色收到名片牌上，一只猫在一屏里只有这一小块颜色。整块上色、勾边、托盘、斜光、淡底都画过，放进 Studio 的窄聊天栏后，带框的都和作品卡片框里套框、和旁边的作品抢眼，经过见 Studio 北极星 §0.7。
- 定位环：点回执或吸收坞时，相关消息上那圈约 3 秒的定位环用人的颜色；它不是文字，明度在显示时有 3:1 的下限，判法同名字角色（保存值不动，只移明度；两侧都过不了就取最差处对比最高的那个明度）。
- 一次回话里露多少过程：三层（说了什么、做出了什么 / 在干什么 / 怎么干的）、记录默认收起、一行状态、个人默认 + 本对话单独调，这些方向 You 已认可；"召回 N"的计数和定位、状态凭什么证据写、多只猫时状态归哪次执行、设置分几档，这些具体合同由猫收齐，见同一节。合同和实现都还没齐，本文件暂不写成规则。
- `message-bubble-user`（人的消息，2026-10-01 You 定）：靠右，一整块 12px 圆角气泡，不淡到透明，也不挂名片牌、不署名：Café 里只有你一个人，靠右就是你。短句按字收窄，最宽约阅读栏的八成，左侧留空；字在气泡里左对齐。底色用人的颜色的浅色（下一条）。时间用 `{typography.caption}` `{colors.muted}` 挂在气泡下面，连着几条只在最后一条显示。
- 别的人：共同体里有其他人说话时，他们放在左边，和猫一样用名片牌（见下），名片牌用人的颜色；你自己的消息仍靠右、不署名。规矩只有一条：自己靠右不署名，别人靠左有名片牌。
- 人的颜色：所有人共用一种，可可（主色 #6B5443 / 浅色 #E9DCCF），不用灰色（You："灰色像个机器人"）。颜色从配置来：新版界面里，配置里人的颜色由 `CoCreatorHueInjector` 写成人的色相和彩度，经 F056 的明暗梯度得到 `--color-cocreator-*` 这组人的主题角色，气泡底取 `--color-cocreator-surface`（#4983）；调色器的明暗梯度照样生效，浅色、深色各自派生。没配人的颜色时就用可可，不再回退到 `{colors.surface-3}`；代码里的默认值 `CO_CREATOR_COLOR` 也是可可。经典界面不变，人的色相仍是 `cat-persona-tokens.css` 里写死的 40 / 0.13。其它用到人的主题角色的地方，在新版里也跟着人的颜色变色（色相、彩度跟配置走，明暗不变）。名字读得清的判据同猫的名片牌。经过见 Studio 北极星 §0.7。
- 共同体房间（Collective Client）：它是嵌在 Café 里的独立页面，长相跟打开它的那个 Café 走：界面版本（经典 / 新版）、明暗和调色器调过的主题、人的颜色，都由宿主通过宿主桥传进房间，房间里不另设一套。宿主没传时（桥还没接通，或者房间被单独打开），用 Café 当前的默认：界面版本按 Café 的默认值（现在是经典），浅色，人的颜色用可可。`?presentation=v2|classic` 和 Café 的 `?shell=` 一样，只作为链接和验收入口。房间现在只有一套浅色变量，系统切到暗色只会翻转 color-scheme，不能算暗色验证通过。
- 猫的衬线时刻：猫主动开启话题、空态问候、总结陈词可以用 `{typography.display-sm}`；日常回复用正文。

### 状态与标签
- `badge-status`：pill、`{colors.surface-3}` 底、12px 字。文字表达状态，颜色只给左侧 8px 圆点（`status-dot-*`，在 surface-2 上 3.70–4.34:1）；没有文字的裸圆点不是合法状态指示。
- `badge-primary`：`{colors.primary-soft}` 底 + `{colors.primary-active}` 字，用于"新 / 推荐 / 待你决定"这种需要被看见的少量标签。
- `tab` / `tab-active`：选中 = 抬到 `{colors.surface-3}` + 字色变 ink，不用下划线，不用主色。

### 导航
- `top-bar`：52px、工作面底（`{colors.surface-1}`）、底部一条发丝线，标题 14px/500。不放品牌色。
- `sidebar`：外框（`{colors.surface-2}`）。Café 标题只写世界名，去掉切换世界的 ⌄；共同体标题若保留 ⌄，只打开当前世界自己的菜单，世界名单仍只从窄栏末尾的"…"打开。Café 的导航行是新对话、全部作品、记忆（§0.5），32px、14px 字；选中项垫 `{colors.surface-3}`。对话行规则见"对话列表"。

### 世界栏与全局入口
- `world-rail`：52px，外框色。上面只放世界（最上面是品牌标记 = 我的 Café；每个共同体一个线框字标，有注册头像时用头像）和"加入"，世界多了在末尾放"…"；下面是小信箱（待办）、前台猫、头像（进"设置与管理"）。用户自己从设置与管理钉上来的快捷入口放在小信箱上方、用发丝线隔开，默认没有；演示浮窗开关只在有浮窗时出现。不用色块、不描边圈、不在格子下塞小字；选中只垫 `{colors.surface-3}`。
- 世界的名字：桌面上停留或键盘聚焦时提示，当前世界名写在侧栏标题；"全部世界"名单只从世界栏末尾的"…"打开（世界多时出现，键盘可达）；手机上常显。读不到的世界照样占位并说明原因（读取中 / 服务连不上 / 需要重新登录 / 当前账号没有访问资格），不当作"没有"，不悄悄跳到别的世界。
- 全局入口：待办只有窄栏的小信箱一个入口，侧栏和头像里都不放，名字靠它的悬停提示和读屏标签；头像点开直接进"设置与管理"，不弹菜单（§0.5，2026-09-29 You 拍板）。
- **尚未通过、待同屏实物验收**：不悬停、不被提示时，人能不能认出小信箱（待办）、前台猫和头像（设置与管理）；有事项或读不到时能不能看懂是哪一种（F322 AC-A1 / B5 / J3）。第 1 段第一份能操作的外壳出来就试；认不出就在原入口加短标签，不另加入口（主页北极星 README 1.6 节）。前台猫入口按它自己的配置状态（configLoaded / enabled / muted，`ConciergeRailToggle`）显示，不一律出现"叫回前台猫"。

### 图标与悬停提示
- 三个入口有自己的图形，每个概念只有一个图形，同一概念的所有入口共用。产品里的唯一定义在 `packages/web/src/components/shell/ShellIcons.tsx`，新入口直接引用它，不复制 SVG、不另画；下面的设计稿链接只说明来源：
  - 作品：两张错开叠着的卡片，`WorksIcon`（来源：主页北极星稿 里的 `i-works`）。侧栏"全部作品"和对话顶栏"作品 N"共用。
  - 记忆：摊开的书上一颗星，`MemoryBookStarIcon`，路径在 `memory-book-star-path.ts`，填色、跟随文字颜色（来源：memory-D.svg）。侧栏记忆和 Workspace 里的记忆共用。
  - 猫猫球：布偶本人，`CatBallImage`，引用 `packages/web/public/shell/catball-E-28px.png` 与 `@2x`，窄栏 28px（来源：catball-E）。它是带色的角色图，不随文字颜色变。
- 别的猫画好、经 You 选定的图形，落地时用原件（导出或机器描摹），不照着重画一版（You 2026-09-30）。
- `tooltip`：图标入口的名字提示，墨色小条、白字、28px 高。悬停约 150ms 出现；已经显示过一个以后，移到相邻入口不重新等；键盘聚焦立刻出现。不用浏览器原生 `title`（要等一秒左右才出，You 2026-09-30 指出）。产品里只有一个实现：`packages/web/src/components/AppTooltip.tsx`，新入口直接用它，不另写一份。提示只是辅助：全局入口仍要有默认看得见的名字，有提示不算"默认看得出"。

### 桌面浮层
猫猫球在桌面上弹出的名牌、通话条、面板和字幕卡。它们压在别人的窗口和壁纸上，除了页面浮层的做法，还要守下面几条。定稿与每条的来由见桌面猫北极星。
- `desktop-overlay`：不透明纸面（`{colors.canvas}`）+ 1px `{colors.hairline-strong}` + 浮层小阴影，12px 圆角。不做毛玻璃、不做半透明：壁纸和视频会透上来，字读不清。
- 名牌：墨色小条白字（长相同 `tooltip`），外加一圈 1px 浅色描边，在深色壁纸和全屏视频上也分得出边。没事时不挂名牌；挂的时候只写当前确知的一件事。
- 尺寸：面板宽 120–420、高 32–500（桌面宿主的合同）。内容放不下就减行或折叠，控件不能被面板边缘裁掉；出稿和实现都要量到里面的按钮，不只量外框。
- 位置：面板默认贴在猫的一侧、往屏幕内侧展开。全屏或贴边时，猫、名牌、面板整块上抬，不盖住底部的控制条和字幕；不用"收起"代替挪开。这是摆放目标：自动识别外部控件还不是现有能力，由桌面宿主补。
- 通话条在通话期间常驻；打开面板时它收进面板顶部，不叠两层。
- 状态文字只写数据来源能证明的事（"正在思考""正在处理""正在查看共享画面"），不写推断出来的说法。视图名用 `badge-status`。
- 字幕卡：猫说的话和译文用 `{typography.title-md}`，听到的原声用 `{typography.body-sm}` muted；靠字号和颜色区分，不逐行加标签。
- 窄到放不下文字按钮时，次要按钮收成 28px 图标按钮（带提示和读屏名），不裁字；`button-destructive` 保留文字。
- 图标按钮画的是当前状态（麦克风开着就画不划线的麦克风），点了再切换；旁边的状态文字和图标不能说两样。
- 设置放在猫身边的面板里。会结束通话的设置更改（如更换陪伴者、调整资料访问权限）先说明后果并确认，由宿主先结束当前通话、再改设置；通话条的挂断仍直接执行，不加确认页。保存成功不等于当场生效：下次通话才生效的设置要写出来（如人设基调）。保存失败、结果还没确认、通话已结束但设置未保存是三种不同的结果，分开写。

### 对话列表
- 每行第一行是标题 + 时间（`{colors.muted}`）；第二行只在有事时出现：左边一个状态（出错 / 某猫正在工作 / 已回复，三者本来互斥）+ 可选"草稿"标记，右边独立放"@你"（`badge-primary`）和未读数（`badge-status`）。几种信号并存，不挑一个盖掉其他（F297 AC-D6）。
- 只写"正在工作"，不写"正在回复"；不显示没有数据来源的消息预览或草稿内容；出错用 `status-dot-critical` + "出错"文字，不用红字。
- 分组收起时同时显示：正在工作的猫头像（按猫去重）、有 @你 的对话数、未读总数。排序、改名等管理动作收进分组的"…"菜单。

### 作品卡片与动作回执
- `artifact-card`：聊天里的作品是一张卡片。图片直接给大预览（最宽 440px），底部一行名称、类型、版本和"打开"（常显，不只悬停）；文档给缩略纸面。点开进入作品模式（见下"作品模式"）。
- `action-receipt`：猫做过的事是一行回执（图标 + 动作 + 加粗对象，如"在 **Café 像素主视觉** 上批注了 2 处"），可点回原处；用户自己的动作回执靠右。回复、标为已解决、生成新版本是三件事，各自一条回执，不互相冒充。

### 批注
- 作品窄、旁边有留白（文档、手机稿）：`annotation-card` 贴在留白里，定位点是批注者头像。作品铺满宽度（横图、视频）：批注是作品上的头像点，点开在原处弹出。两种都在原位回复、标为已解决、请猫修改，这三个动作分开。

### 作品模式
在作品上说一句、看猫改、比新旧、做决定。画面与来由见 Studio 北极星 §0（图片这条线）、§0 的修正稿（聊天留在旁边）和 §0.6（其他作品）；画面上的动作大多还要补合同，能力边界见同一文件 §0.4、§5.1。比例、拖动、进出和返回按 Layout 的"外壳"与 F307 合同。
- 打开：人点了作品才进作品模式；新消息、猫交回新版都不抢主屏。聊天留在左边的聊天栏，几只猫的话都看得见；作品在右边，默认整张看全、不放大超过原尺寸，顶栏的百分比是真实比例；长截图要能上下滚动、字读得清。什么时候从"整张看全"改成"按宽度铺满往下滚"还没定：稿子估的"适应后小于原尺寸一半"没拿真实长截图验证过，只是待实测的候选，不作验收依据。返回回到聊天原来的位置。
- 和验收依据的关系：F309 Phase U 正文、计划与 AC-U2 / U10 / U13 已由 F309 负责方同步为聊天在左、作品在右（`c7afca0c7a`）。来历：You 2026-09-30 先定"图片主动打开默认整窗"（`[thread-id]#private-source-id`）；之后他看了整窗稿，指出多猫时没有聊天、发出去看不到进度都奇怪（`…private-source-id`）；修正稿把默认改成聊天在旁边，和 F307 / F322 的约 30/70 合同一致，他看过说"还蛮漂亮"（`…private-source-id`），不是逐条拍板。规范同步不等于实现验收，也不是新的开工许可。
- 一个输入框：作品模式里只有聊天的输入框。作品下方浮一条有名字的工具，按作品种类换：图片是圈选、画笔；视频是选时间段、圈选；文档没有工具，选中文字就挂上去。圈选、时间段、选中的文字以编号标签挂在输入框上沿，可以圈多处再说一句；不圈就是对整件作品说。
- 一个发送，猫判断你的意思（You 2026-09-30）：指出问题或说了想要的样子，猫就去改；在问，猫就在那一处回答，不产生新版本；真分不清才在原处问一句，不能每次都问。没有"只保存、不叫猫"的第二个入口：这一条是宪宪和小星星从 You 那句话做的设计推论，不是他逐字要求删除的（Studio 北极星 §0.3 第 5 条）。
- 发出去以后：你的话带着每处圈选的截图出现在聊天里；接活的猫在下面回话，"正在修改 · 取消"跟在这条回话下面；作品顶栏同时写"谁正在修改 · 几处"。进度来自执行记录，不来自猫的一句话。
- 新版回来：对比有三种看法，并排、切换、滑动。并排不会让作品变小就默认并排，会变小就默认切换（同一位置一次看一版，滚动位置不变）；滑动只给两版版面一样、只改了局部的图。文档是原文 / 修改后对照；视频是两版同步播放、时间轴对齐。决定按作品从哪来分两组，不合成一组：任务里的作品是"通过此版本"（`button-primary`）/ "要求修改"（`button-secondary`），结论交回原任务，不代表整件任务完成，也不写文件；工作区里的文件是"采用并写回" / "不采用"，拿到真实写回成功的回执才显示已写回，原文件已有改动（冲突）和结果无法确定各自照实写，不被成功的说法吞掉（运行时 `ContentModificationResults.tsx` 的 applied / conflict / unknown；Studio 北极星 §1.3 第 4 条）。一屏只一个主按钮。
- 浮在作品上的工具条、决定条只在滚动中途盖住作品；滚到底时作品下方留出它们当时的高度，最后一行不被压住。
- 整窗看（You 2026-10-02 定，`[thread-id]#private-source-id`；F307 KD-25）：默认仍是聊天在左、作品在右。人点作品顶栏右上的 ⤢ 才进整窗：聊天的历史暂时让开，作品占满，底部留同一个输入框，说的话照样进这条对话。聊天仍是同一个运行中的对话、同一份挂着的页面，不销毁、不另起一份；让开的历史不能被键盘或读屏聚焦到。
  - 点开输入框：框上方展开这条对话最后两条消息，带名片牌，谁说的都算；有猫在干活时，"执行中"那一行也在这里，和聊天栏底下那一行读同一份执行状态，不另记一份。右上"展开聊天"回到左右布局。
  - 没点输入框时猫回了话：框上方只冒一行（名片牌、第一句、时间），不自动展开、不抢焦点；点这一行退出整窗，停在那条消息上。
  - 再点 ⤢ 或按 Esc 回到左右布局：比例、两边的草稿、滚动位置、选择和当前看的版本都照旧。
  - 画面见 Studio 北极星 §0.9（场景 pk7a / pk7b）。这是已接受的设计和合同，还没实现（F307 R10 / AC-D5 未勾选），规范同步不等于产品已经能用。
- 还没定：没有归属的文件怎么选发给哪只猫。聊天在旁边时新版对比和决定的画面、视频的素材库 2026-10-01 已补稿（Studio 北极星 §0 修正 4–6），还没实现。整窗看不借用会让聊天不可见的 `mainAreaAttention`，按上一条和 F307 KD-25 做。

### 面板、数字与结果
- 侧滑面板（待办）：从世界栏旁滑出，盖住左栏；打开不切换世界、不批准、不清数字。
  - 不是模态的：主区不加遮罩，照常能看、能点、能打字。所以点面板外面不关，只有右上的关闭、Esc、再点一次待办入口才关。1.6 稿上主区画了一层轻遮罩，2026-10-01 改掉：遮罩在告诉人"后面暂停了，点这里就回去"，这块面板两样都不做，留着遮罩就多出一块点了没反应的地方。
  - 面板里再弹出的东西（如填反馈的框）先接住 Esc，关掉后焦点回到面板里原来的位置；在里面打字、点击，不能把面板关掉，也不能丢掉没发出去的字。
  - 顶部单独标"返回位置"（关闭后回到哪），和每一项自己的"来源"分开写。来源按原始锚点，不按背景世界推断；返回位置只用 Host / F307 / F290 记下的打开现场，拿不到就不画这一行，不拿背景世界或上一个页面去猜。
  - 底部"已处理的"（历史），以及审批的筛选和安全批量，要能从面板走到，可以经原审批入口的第二层，不能因为换成这块面板就没了。分批实现时，还没做的照实标"还没做"，在 F322 第 3 段完整待办验收（S3-4）之前补齐并验证；第 1 段"不悬停能不能找到入口"的第一眼检查不因此往后推。要去掉其中哪一样，是另一个产品决定。
- 待办角标消费 F310 提供的可信独立事项总数：只有声明范围内的来源覆盖完整、去重身份可证、且没有未解决的版本冲突时才写数字。计算和各来源状态沿用主页北极星 README 里的 F310 消费合同，不以 HTTP 成功、当前页长度或客户端相加来证明完整；本轮已确认有事但凑不出可信总数 → 只给圆点，悬停写"数量未确认"；两边都读成功、合起来为空 → 入口还在、没有角标，打开写"暂无待办"；读取中 → 不写 0、不沿用旧数，第一次没读到也不算 0；全部没读到 → "暂不可用"，打开给重试；一部分没读到 → "仅部分读取"，先列读到的；确知需要登录 → "需要登录"，只标要登录的那一边。七种状态的画法见主页北极星 README 1.6 节状态板。
- 处理结果只说确知的事：请求没有回应 → "暂未确认处理结果" + "重新读取状态"，不把"重试"默认成再做一次；明确的"已处理""没有权限"各自照实说。

### 刚进来的画
- 新对话页、进入一个世界的首页这类"刚进来"的时刻，上方可以放一幅这个地方自己的画（Café 一幅，共同体各自一幅）；一开始干活（进入对话、打开作品）画就退场；带着具体目的进来（点了某条对话或链接）的人直接落在工作状态，不先看画。
- 构图约束：上方约 40% 安静，叠白色衬线标题（加柔和阴影保证可读）；脸落在 43%–78% 高度、横向中间一半；底部约 20% 低细节并渐隐进 `{colors.surface-1}`，输入框压在画的下沿上。可以按时间换画（如傍晚 / 深夜）。
- 画里家里的猫从角色正典 §7 派生，全家四只：宪宪、砚砚、烁烁、墨墨。导演稿先写"这一刻发生了什么"，每只猫一个不同的动作。
- 画只出现在这些时刻；外框和工作状态里不出现插画、渐变或装饰。现行两幅见主页北极星。

### 空态与仪式
- `empty-state`：衬线 22px 标语（`{typography.display-sm}`）+ 一句 14px 说明 + 一个 `button-primary`。这是衬线体和 40px 按钮唯一常规出场的地方。
- 新对话页（2026-09-29）：衬线大标题 + 一句说明 + **输入框就是主动作**（不另放主按钮），下面是"最近的作品"（只取当前用户的 Café，按时间；按记录、作品族还是版本来算以 F232 为准，本文件不替它定；补空与失败状态）。可以叠在"刚进来的画"上。
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
- 外框安静：世界栏只放世界和少数全局入口；温度交给真实内容和"刚进来的画"，不给外框上色。
- 全局入口有默认可见的名字，不让人猜陌生图标；悬停只做辅助。
- 状态画全、说实话：成功为零、读取中、失败、需要登录各不相同；不知道就说不知道。
- 新增或实质改变一整屏，先出北极星稿（见下节），过能力核对，再动代码。
- 猫味放在头像、名字、语气、彩蛋；一屏最多一个猫爪印级别的装饰。
- 交付视觉改动前看实际渲染结果，并留下足以回查判断的证据；可现场共看、截图或录屏，按声明选择。交互能力还须真实操作验证，不能由截图单独证明。Design Gate 具体入口见 `cat-cafe-skills/feat-lifecycle/SKILL.md`。
- 新增或实质改变 UI/UX，先看同类产品怎样完成同一任务，优先使用co-creator提供的参考；保留成立的操作与空间关系，再适配本文件的颜色、图标与密度。交付前按同一任务对照实际页，方法见 `cat-cafe-skills/refs/design-in-context-checklist.md`。

### Don't
- 不用纯白 `#ffffff` 做画布，不用纯黑 `#000000` 做暗底，不用冷灰。
- 不用紫色作第二品牌色，不用蓝紫渐变、任何渐变按钮、玻璃拟态、光斑、噪点——这些是"AI 味"的指纹。唯一例外是已注册的 violet 内容类别 token；它只在稳定类别字段与配套 SVG 中出现。 "刚进来的画"是家里的插画，不受这条约束；UI 外框和组件仍然适用。
- 不引入第二个品牌色。绿黄红蓝只表达状态，只以圆点 / 错误边线 / badge 圆点出现（`button-destructive` 的实心底除外，使用范围见"按钮"），永远配文字标签，永远不做文字色，不做装饰底。
- 不用 emoji 当图标；不用猫 emoji 当装饰；不把猫爪印铺满界面。
- 不用 Inter/无衬线做大标题，不把衬线用在 22px 以下。
- 不做 pill 按钮，不做 24px 圆角气泡，不做 100px 圆角。
- 不在卡片里套卡片，不做全宽 stat tile 阵列，不做"上个世纪的仪表盘"（F174 教训）。
- 不给 hover 加新的颜色语义；hover 只允许抬一级表面。
- 不把 Feature ID、Gate、stage、内部术语写进产品文案（ADR-043 / design-in-context）。
- 不用口语短句当标题、面板名、入口名、按钮名；名字先想英文、再译成正式的产品中文（见"界面上的字"）。
- 不凭“我觉得挺好看”交付；猫要先完成设计判断并给出推荐，遇到影响方向的体验分歧时拿具体稿请co-creator共创。A/B 截图是可选比较方式，不把设计责任或常规 QA 转交co-creator。
- 不用第四档更浅的灰（时间戳也用 muted）；不用赭红原色写小字（强调词用 `{colors.primary-active}`）；不用状态色写字（出错 = 红点 + 正文色文字）。
- 不用字号表之外的字号（13.5、12.5、11.5 这类半档）；拿不准就取相邻的一档。
- 不用实心赭红做计数角标；需要你动手的数字用 `badge-primary`（浅赭底 + 深赭字）。

## 界面上的字

所有出现在界面上的字都按这一节起：标题、面板名、入口名、按钮、菜单项、标签、状态、空态、报错。You 2026-09-30 定为设计军规（`[thread-id]#private-source-id`，品味记录 产品命名）。

1. **先想成熟产品做同一件事时怎么叫，用英文写出来。** 东西用短名词，动作用动词加宾语。
2. **再译成正式的产品中文。** 译完倒回英文读一遍，意思对得上才算数。
3. **不用口语短句当名字。** 标题、面板名、入口名、按钮名不写成一句随口的话。
4. **不暴露无助于当前任务的内部术语和实现细节。** Feature ID、Gate、stage、对象模型里的名字不上界面。人做判断需要知道的行为、权限和操作后果，用产品语言说清楚；目标用户本来就用的任务词汇可以用。
5. **优先沿用已经确认、符合本节的产品词。** 指用户看得见的词；代码里的状态值不直接当文案。旧词不符合本节时，在这次动到的界面和同一概念的其他出现处一起改掉。同一件事在整个产品里只有一个名字。
6. **对话里的话不在此列。** 猫和人说的话照常说人话；这一节只管界面自己的字。

| 第一稿（口语或内部用语） | 英文 | 定稿 |
|---|---|---|
| 从头看 | Full discussion | 完整讨论 |
| 中间 37 条 | 37 more messages | 其余 37 条消息 |
| 带过去 | Continue | 继续讨论 |
| 上游还有更多引用 | Continued from a discussion in #general | 延续自 # general 的讨论 |
| 这段讨论在一个你进不去的频道里 | You don't have access to this channel | 你无权访问这段讨论所在的频道 |

样本出自 F290 北极星第 12 屏。在这条规则之前定下的界面用语没有逐屏重过；动到哪一屏，就按这一节把那一屏的字过一遍。

## 北极星稿的做法

新增或实质改变一整屏 / 一条旅程时，先出北极星稿再动代码（2026-09-29 Studio 与主页两轮验证）。完整复盘见 Studio 北极星 §3 与 主页北极星；逐项检查见 `cat-cafe-skills/refs/design-in-context-checklist.md`。

1. 先问这一屏上人在做什么，而不是要展示哪些字段。
2. 借成熟产品的空间语法（批注贴在留白、工具条在原位变形、聊天里只有一行回执）；字不照抄它的，按"界面上的字"一节起。
3. 行为规则先和负责猫对齐：什么会叫醒猫；回复、解决、采用、新版本怎么区分。
4. 用真实内容和最难的样本：最长的标题、最多人批注、读不到和出错的状态。
5. 探索和已定实现分开：北极星稿先画、先验证，稿子里可以用标明"候选"的局部变量，同一份稿子里保持一致、不临场改；You 看过、确认后，再把定下来的值写回本文件和运行时 tokens。已定的实现只用统一的 tokens，不把局部候选留成第二份规范。
6. 做减法：说明文字、内部术语、重复入口、常驻流程状态收起或删掉；一屏一个主按钮。
7. 按真实尺寸渲染，自己先看；量像素、查计算样式。拼图和标签也要自己看一遍（字体回退会变成方块字）。
8. 分层请人判断：先同布局换长相，一次只动一个旋钮；再看场景。不把规则、布局、风格一起堆给 You。
9. 每张稿子先交负责交付的猫，对照真实代码核一轮能力与契约（入口是否真有能力、数字从哪来、状态是否画全），再请 You 看。
10. 插画（刚进来的画）：导演写稿（这一刻、每只猫的动作、构图约束、不要什么），出图找 Sol6.1（2026-09-29 起接替 Sol6），放进页面按 1:1 自查后再给 You。

## Implementation Mapping

本文件是视觉意图与**目标值**；`packages/web/src/app/theme-tokens.css` 是**当前运行时**（OKLCH 单 hue 派生）。AC-F6 之前以 CSS 为准，下表右两列就是 F2 要合拢的差距；AC-F6 之后由 parity 测试强制一致。二者的对应关系：

| 本文件 | 运行时旋钮 / 变量 | 现状（2026-09-04） | 目标 |
|---|---|---|---|
| `{colors.primary}` #b05f45 | `--accent-hue` / `--accent-chroma` → `--accent-500` | hue 50 / chroma 0.14（暖金） | hue ≈ 38 / chroma ≈ 0.11（赭红），L 0.55 与现有 AA 约束一致 |
| `{colors.canvas}` → `{colors.surface-3}` 四层（T1） | `--surface-hue` / `--cafe-surface-*` 四档 | hue 80 / L 0.92–0.995（2026-09-04） | 同色调 T1：#fffbf6 / #fcf7f0 / #f7f2ea / #efe9e3，同一暖色相、亮度逐级下降，随 Workspace 重构迁移 |
| 外壳尺寸（2026-09-29） | `AppShell` / `ActivityBar` / `ThreadSidebar` / F307 主区 | 现有 rail + sidebar + 右栏 | 1440 样张参考：世界栏 52 / 侧栏 300 / 阅读栏 720 / 作品模式聊天栏 400 / 顶栏 52；作品模式的比例、拖动、进出与返回按 F307 / F322 合同（见 Layout 的"外壳"），不按这些数字硬编码 |
| `{colors.ink}` 系 | `--neutral-*` 11 档（hue 30） | 已是暖中性 | 不变 |
| `{colors.dark-*}` | `[data-theme="dark"]` 表面四档 | L 0.21 / 0.24 / 0.28 / 0.36（名字不是明暗次序） | **本批（2026-09 Workspace 8 天联合交付）**：色值不动，沿用运行时现有暗色梯度，只在新版范围按明暗关系做组件对应（外框最暗 → 工作面 → 纸面 → 选中最亮），经典界面不受影响；样张里的暗色候选色不进运行时。**长期**：与 dark-canvas → dark-surface-3 对齐、保持暖 hue，由暗色北极星定 |
| `{colors.category-*}` / `{colors.dark-category-*}` | `--content-category-*` | F311 旧实现借用 chart / semantic 色 | teal / violet / berry / moss 独立类别角色；浅底字段 + SVG，和主动作及状态色分权 |
| `{typography.display-*}` | 全局 `font-family`（目前仅 Inter） | 无衬线单声音 | 增加衬线 display 字体栈；正文保持 Inter |
| `{rounded.*}` / 控件 32px | Tailwind `borderRadius` + 组件类 | 气泡 24px、pill 按钮存量 | 迁移到 8 / 12 / 16 |

迁移在 F056 Phase F 里分步进行；每一步以 A/B 渲染截图由co-creator选定，再落 token。这是该迁移已确定的专项确认方式，不扩展为所有视觉改动的固定配额。本文件 token 与运行时解析值的一致性由 F056 AC-F6 的 parity 守护测试保证（落地前不声明一致）；本文件**允许的角色配对**（文字 × 表面、on-primary × primary 等）的对比度由 `scripts/check-design-md.test.mjs` 的确定性矩阵守住，lint 只覆盖已声明的组件对，矩阵覆盖 prose 允许的全部配对。
