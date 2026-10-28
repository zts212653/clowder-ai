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
- **已有的北极星稿** → 主页、Studio、共同体（F290）、记忆（F321）、桌面猫（F317）、剪辑台、记忆 › 画像（F332）。新稿复用主页稿的外壳和变量，不另起一套。

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
- **Semantic**：`{colors.success}` / `{colors.warning}` / `{colors.critical}` / `{colors.info}` 只表达状态，只以 8px 圆点（`status-dot-*`）、输入框错误态边线或 badge **左侧圆点**出现；唯一的实心例外是 `button-destructive`（见"按钮"）。它们是非文字状态元素，按 WCAG 1.4.11 在 canvas → surface-3 四档表面上 ≥ 3:1（成立范围 3.43–4.70:1）；**永远不做文字色**（做正文不过 AA），badge 文字用 `{colors.body}`。**圆点永远不单独承担状态**：旁边必须有文字标签（"运行中 / 待你决定 / 失败"），颜色只是冗余提示，不是唯一通道。暗色模式用 `{colors.dark-success}` 等四个亮化变体（`dark-status-dot-*`，在暗表面 ≥ 4.3:1），不复用浅色值。不做装饰性的大面积底色；唯一的例外是整块状态的淡底（执行中那一行、正在干活的那一块），见下面「颜色花在哪」和「状态色是一套」。
- **Content Category**：`{colors.category-object}` / `{colors.category-rubric}` / `{colors.category-measurement}` / `{colors.category-diagnosis}` 只区分同一工作面里的稳定内容类别，不表达动作优先级或运行状态。类别必须同时有文字与语义 SVG；颜色可作为低浓度浅底字段和图标色，但不能单独承载类别。暗色使用四个 `dark-category-*` 亮化变体。初始映射为对象 = teal、规约 = violet、测量 = berry、诊断 = moss，来自 operator 对 F311 B「柔和色块」的选择（`[thread-id]#private-source-id`）；其他页面只有复用同一类别语义时才可消费，不能把它们变成第二品牌色或装饰色。
- **Focus**：`{colors.focus}`（浅色）/ `{colors.dark-focus}`（暗色）只做键盘焦点环，配方见 Elevation 表：**外置 2px 实色 outline + 2px offset 间隙**。间隙露出宿主表面，所以焦点环只与表面相邻、永远不与控件本身相邻——控件是赭红主按钮还是画布色输入框都不影响可见性。浅色环对 canvas → surface-3 为 3.82–4.46:1，暗色环对 dark-canvas → dark-surface-3 为 4.31–5.47:1；焦点前后的变化对比 = 环色对表面，同一组数。没有透明层参与计算。
- **猫 persona 色**：每只猫的身份色是第三层，上头像、名字、persona chip（对话里的名片牌就是它，见"对话"）。在按猫分块的地方（状态与会话、成员列表这类），还可以上三处，都只说"这是这只猫的"：它那一块的名片牌开头、它名下条目左边一道细线、属于它的量条（例如它这段会话的上下文用量）；它正在干活时，它那一块可以铺它颜色的浅底，活停了就撤。仍然不进按钮、不进分组标题、不进图表默认色。（2026-10-03 改，见下条）
- **颜色花在哪**（2026-10-03，You 认可，`[thread-id]#private-source-id`）：颜色只花在三种意思上——**是谁**（猫或人的颜色：名片牌、它名下条目的左边线、它的量条）、**什么状态**（8px 圆点；正在进行的那一块铺浅底）、**有多少**（量条；接近上限换 `{colors.warning}`，并用文字写出"接近上限"）。量条只给还在变、有上限的量；已经做完的（100 / 100）和文件大小写数字，不画条：满格的条读起来像进度，却不带任何信息（2026-10-07 剪辑台，小星星评审）。分组标题、按钮、装饰不上色。一屏里如果只剩一种颜色、全是字，先查这三种意思是不是都漏了。**注意力分四档**（2026-10-08 You 认可，`[thread-id]#private-source-id`；他说 v2「最大的问题，到底什么东西是重点需要人关注的，没有高亮」，画面见主页北极星 §1.23）：一屏上先看到的永远是要你动手的事，其次是新消息；在进行的只动、不抢；其余安静。
- **要你动手**：@你（赭色实底白字的小标签，它是提醒、不是计数）、等你决定（琥珀点 + 文字）、出错（红点 + 文字）；所在的对话标题加粗。
- **有新消息**：未读数用 `badge-primary`（浅赭底、深赭字、600），标题加粗。
- **在进行**：蓝色圆点或蓝色跑动小猫，不加粗。
- **安静**：已回复、没新消息，文字是正文色和 muted；完成的小勾仍是绿色。
- **状态色是一套**，侧栏、回话最后一行、子代理、执行中那一行共用：在进行 = info 蓝，完成 / 已回复 = success 绿，出错 = critical 红，等你决定 / 很久没动静 = warning 琥珀。状态色仍只给圆点、图标和整块的淡底，不做文字色。**执行中那一行在猫正常干活时也铺淡蓝**，和侧栏「在跑」的蓝一致（2026-10-12 You 否了改成素色白框的提议：「白色的之前用过，放那里毫无存在感……侧栏猫在跑就是蓝色了，为啥不统一」，`[thread-id]#private-source-id`）。
来源：08-22 三猫诊断"颜色和位置是信息通道，我们把它们花在标签上，没花在语义上"，本文件只写进了"别花在标签上"这一半，状态与会话第三版因此比原页面还单色；对照见 主页北极星 §1.12「状态与会话 · 颜色版」。

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
- **页面上的猫猫球**（2026-10-05 定）：网页上不留常驻的悬浮猫，也不留贴边小把手或自动出现的网页兜底猫。找猫说话走外壳现有的猫入口：装了桌面猫就唤回桌面；没装、停用、出故障或纯浏览器时，由人主动从窄栏打开同一个伴随对话或插件设置，面板按作品模式 / Workspace 已有的摆放合同出现，不另造一套聊天（F317 负责方定，`docs/features/F317-coactive-companion.md` "2026-10-05：F229 下线范围与网页终态"；起因是 You 要 F317 把 F229 原来那一套下线）。旧的 F229 悬浮球、它的工具条和避让标记（`data-concierge-reserved-rect`）已随 #5168 撤掉（`0f66a8a345`），历史、草稿和配置保留。以后要在页面上放任何浮在内容上面的东西，先出稿，不默认借浮层压住内容。
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

装饰性深度：产品内容本身（消息、diff、图、卡片里的真实数据）是唯一的"插画"——唯一例外是"刚进来"时刻的地方画（见组件）；另一个例外是用户自己选的对话背景：整窗一张清楚的图，按图算出的浓淡垫在底下（见组件「对话背景」，2026-10-26 定稿）。不加氛围渐变、光斑、玻璃拟态、噪点纹理。

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
- 工具条与「更多」（2026-10-03，You 看完 Workspace 代码组改版说"满意了"）：信息不收进菜单；操作按常用程度排，常用的留在条上，其余进「更多」。窄到放不下时，按事先定好的顺序一项项收进「更多」，核心动作（如"请猫修改""批注"）不收；不让按钮被悄悄裁掉、看不出后面还有。只剩图标的按钮都有悬停提示和读屏名。

### 输入
- `text-input`：32px 高、画布底、`{colors.hairline-strong}` 边；聚焦时边线和底色都不变，只在控件外 2px 处出现 2px 实色 `focus-ring`（`outline-offset: 2px`），不加阴影。
- **聊天输入框（composer）不套焦点环**（宪宪 10-12 定。You 18:55 PDT 问「这个点击就高亮的红线框的设计当时是为啥来着」，`[thread-id]#private-source-id`）：焦点环本来是给键盘用户看「现在在哪」的。聊天输入框一直在页面底部，光标在闪，点进去不需要再提示。实现却在鼠标点击时，外框和里面的文字区各套了一圈赭红环，成了两圈红线。改成：鼠标点进去不出环，外框边线只加深一档；用 Tab 键进来时，只在最外面一层出一圈环，里面的文字区永远不套环。
- 占位文字 `{colors.muted}`；错误态边线 `{colors.critical}` + 下方 12px 说明文字（`{colors.body}`，不用红字），不整块变红。
- 对话输入框（主页北极星 §1.6 `shots/16-1-chat-1440.png`；项目那一格 2026-10-06 补定；整体 2026-10-08 按 You 意见重画，§1.22、§1.23 `shots/cv-cv1b-1440.png`）：一层细边（`{colors.hairline-strong}`），不要加粗的双层赭色边。附件缩略图放在框里最上面，带 ×；中间写字，字多了框往上长，长到一定高度在框里滚动，底下那排不动；底下一排左边 + 和项目（灰底只包住「项目名 ⌄」这一块，不撑满），右边「发给谁」、麦克风、圆形发送。
  - **框上面的执行行**（新版 `execution-row/ExecutionRow`；经典界面的 `ThreadExecutionBar` 不动）：有运行、排队或待处理的状态时显示，全部清空才隐藏；多项时汇总成一行，保留队列入口，原有动作的权限和确认规则照旧（主页北极星 §1.11）。一行是名牌 + 状态点 + 文字 + 一个动作，整行铺状态色的淡底，按状况换：在工作淡蓝 +「停止」；很久没动静淡琥珀 +「强制重置」；出错淡红 + 原因 +「重试」；等你决定淡琥珀 +「去决定」。名牌仍是猫的颜色，只标是谁。**只有一层框**：这一行本身就是那块淡底加同色细边，外面不再套一圈白框（2026-10-12，吴浪 meow-club#4 指出两层框，You 看图「ok」，`[thread-id]#private-source-id`；图 `row-keep-blue-single-frame.jpg`）。其余东西都不放在框上面。
    - **还在读和读不到要分开**（2026-10-09 runtime 真页面对稿补）：刚打开对话、运行状态还在读的时候，写中性的「正在确认运行状态…」，灰点，不给「强制重置」。读失败了，或者读了一段时间还没有结果，才换成淡琥珀「运行状态待确认」加「强制重置」，这样出口一直在。来由：runtime 很慢时，冷开一条猫正在干活的对话，执行行先挂了 50 秒以上橙色的「运行状态待确认 · 强制重置」，同一时刻侧栏那一行写的是「执行中」。把正常的加载画成异常，还把一个会打断猫的按钮递到手边。
  - **+ 里**：添加（引用对话或文件、上传附件），然后悄悄话、游戏。最上面单独一节「发送策略：排队等待 / 引导当前回复」，点进去先选「本 Thread」还是「全局默认」，再选两项之一，每项一句说明会发生什么；选了一直有效，直到再改。设置页的默认用同一套名字。它和悄悄话是两回事，不放一组。框上面不再挂那枚「下一件工作 · 全局默认」的条。发出去以后消息下面那行小字照实写结果（F264 回执）。来由：2026-10-24 You 看到功能片《不用等它说完》和产品对不上：「我感觉是#3 改错了，或者说我希望你是宣传片里的叫法」，片子里就是这一套。10-22 #5961 按旧 DESIGN 改成的「这条发出去后：作为下一件工作 / 接着当前工作」（只在有猫干活时出现、只管一条）已撤回。这套名字来回翻过四次，再改先问 You。
  - **项目在已有对话里只读**：对话建好就绑定了项目，也没有给对话换项目的接口。点开是个小菜单：完整路径（放不下时悬停看全文）、复制路径；现成入口能直接打开时，再加一项"在 Workspace 打开文件与代码"。不放"切换项目"，也不借全局当前项目的设置假装给这条对话换项目。要换项目就开新对话，新对话里这一格才是选择器。
  - **发给谁**（2026-10-08 You 19:26 PDT 提的，`[thread-id]#private-source-id`；取代原来这格的首选猫选择器）：写的是「这条现在发出去，谁会收到」，样子是「发给 头像 小名」，只读。答案由服务端用发送时同一套路由算出来：消息里的 @ → 你上一条 @ 过的猫 → 最近回过你的猫 → 首选猫 → 默认猫。前端不自己再写一份规则，要一个只读的路由预览，和真正发送时用同一段逻辑。打字加了 @ 就跟着变；几只猫就并排头像、小名用顿号连。悬停写一句为什么：「这条里 @ 了宪宪」「你上一条 @ 了宪宪」「宪宪最近回过你」「还没有猫回过话，用首选猫」。点开是个小菜单列出能发的猫，选了就在正文开头插入「@小名 」：换收信人只有写 @ 这一种办法，看得见，发出去也留在消息里。不用 @ 前缀，不做成胶囊，免得像已经写进正文的 @。来由：这格原来放首选猫，可已有对话里首选猫几乎不决定发给谁（路由先看 @ 和最近回话的猫），You 看着「缅因猫 Astra」以为在 @ 谁，而那条其实会发给宪宪。
  - **没 @ 时完整的顺序**（2026-10-16 You「这个我是认可的」，`[thread-id]#private-source-id`；浪哥在 clowder-ai#1610 也同意；预览、发送、排队接纳用同一个解析函数）：① 这条消息 @ 了谁就发给谁 → ② 写了 `#ideate` 且有多只首选猫：一起发 → ③ 值班对话：值班猫 → ④ **你上一次 @ 过的猫** → ⑤ 这条对话里最近回过话、状态正常的猫 → ⑥ 这条对话里的参与猫中，是首选猫、状态正常的（没说过话也算）→ ⑦ 任何状态正常的参与猫 → ⑧ 第一只首选猫 → ⑨ 默认猫。悄悄话不走这串，只发给指定的猫；对话的「优先 / 避开」规则盖在选出的结果上，不占一步。**选中的猫正忙不算不能发**：消息排队等它，不为快改发别的猫；只有停用、额度用完这种真不能用，才往下一步找，并且「发给谁」那一行写明「宪宪暂时不能用，改发给小太阳」，不悄悄换名字。**一条消息里 @ 了几只，就叫几只**（第 ① 步，不变）。下面说的都是**下一条没 @** 的时候：上一条 @ 了几只，这条只发给其中第一只能用的（You 2026-05-10 10:17「上一次at了两只猫 这次没有任何at fallback应该是一只猫」，F194 AC-Z18；10-16 宪宪写成「只取第一只」被读成第 ① 步，已改清楚）；宪宪按建议定、可推翻的两点：在同一条对话里**不限时间、不限条数**，你最后 @ 的那只一直是默认收件，直到你 @ 别的猫（原来是只看最近 5 条、1 小时内；实现可以把它记在对话上，不必每次往回翻）；猫之间传了球（你 @ 宪宪、宪宪又 @ 小太阳接手），没 @ 时仍发给你 @ 的宪宪，要找小太阳就 @ 一下。来由：F194 AC-Z16，You 2026-05-10「明明 at 的最后一只猫是 47 or 55 但是召唤出来的却是 46」。
  - **打字时不闪**（2026-10-09 You：「send to checking 的体验不好，经常下面的猫猫头在闪」「我要是开始输入……这竟然还又 checking 其实我都没做啥改变」）：已有答案时，正文变化只在后台重新核对；上一次的答案留在原处，新答案回来再换，不先清空成「正在确认」。输入法还在拼字（composition）时不问，结束后再核对；有猫回话也照旧核对。只有第一次打开、还没有任何答案时才写「正在确认」。核对仍走服务端与真实发送相同的路由：当前发送除了 @，还会受 `#ideate` 和对话的 review / architecture 路由策略影响，所以前端不能用「@ 集合没变」推断答案一定不变，也不自己复制路由规则。
  - **同名的猫要分得出**（2026-10-09 runtime 真页面对稿补）：家里好几只猫共用一个小名（宪宪是 Opus 5.5、Fable、Sonnet 等几只；小太阳·砚砚也有两只）。菜单里同名的行，名字后面加上模型（「宪宪 · Opus 5.5」「宪宪 · Fable 5」），头像旁边那格同理。插进正文的 @ 要用唯一的句柄：小名唯一时插「@小名 」；同名时插「@opus55 」这类不会撞名的句柄。看得见的 @ 要和真正送达的是同一只猫（「看起来是什么，就得真是什么」）。来由：runtime 菜单里一连 4 行都写「宪宪」，只能靠右边灰色句柄分。
  - 首选猫收进 + 里，单独一节「这条对话 · 没 @ 时先找谁」，说明写「只在还没有猫回过话时用上」。新对话页没有历史，「发给谁」就是首选猫，改它也在 + 里。顶栏的群聊 / 单猫视图只管怎么看，「发给谁」管发给谁，两者不合并。

### 设置与表单控件
- **成员详情：保存一直看得见，排障记录不进设置**（2026-10-15，You 投诉「有保存……找半天能找到吗」「前端当 log？！」，指 v1 弹窗问「这里的优点在哪里」，看了重画稿说「可以」，`[thread-id]#private-source-id`；稿 `docs/evidence/2026-10-15-member-settings-redo/`）：
  - **保存条**贴在表单区底部，和表单同宽，滚动时一直在；纸面底 + 顶上一条发丝线，不用浮在正中的深色小条。右边一个主按钮「保存」（品牌色），**任何时候都是这个颜色、在这个位置**，不因为没有改动就变灰；没有改动时左边写「没有改动 · 上次保存 时间」，点了说「没有要保存的修改」。有改动时多一个「放弃修改」。左边依次写：没有改动 / N 处修改还没保存（列出字段名）/ 正在保存… / 已保存（写什么时候生效，如「模型从下一次接活开始生效」）/ 没保存上（写原因，写明修改还在，按钮变「重新保存」）。
  - **改过的格子**左边一条橙线 +「已改」，和保存条里列的字段名对得上。
  - **顶上状态一句话**：「可用 · 最近一次接活顺利完成 · 时间 · 查看接活记录 ›」。状态只用 可用 / 额度紧张 / 不稳定 / 不可用；不写「已恢复」，不挂「?」，不铺诊断字。
  - **路由历史不在设置里**：目录和页面都不放；要看点「查看接活记录 ›」，去「成员能力与路由状态」这只猫的记录。改设置的页面只放改设置的东西。
  - 其余照旧：左边目录、模型与接入在最前、启用开关、「打开猫猫团队」。从聊天点开的成员弹窗用同一套保存与反馈。
- **成员与运行时：一只猫一行**（2026-10-21，You 嫌开源 #1519 带进来的「配置详情」和多行状态突兀，看稿说「成员与运行时可以的」，`[thread-id]#private-source-id`；稿 `docs/evidence/2026-10-21-member-list-quota-proposal/members-row-1440.png`；公开讨论 clowder-ai#1656）：
  - 列：成员（头像、名字、品种）· 模型 · 账号 · 接入方式 · 现在 · @ 名字 · 启用。每只猫一行高，放不下的字单行截断，悬停或键盘聚焦时看全文。
  - **编辑只有一个入口**：点名字进成员详情。不在行里另放「配置详情」展开或「编辑配置」；ID 和「复制」放在成员详情顶上。
  - **「现在」只写一个词**：能干活的猫写 可用 / 额度紧张 / 不稳定 / 不可用，和成员详情顶上那句同一套；还没准备好的照写自己的短标签：已停用 / 未安装 / 待登录 / 待验证 / 未确认，不硬压进那四个词（2026-10-21 回应 clowder-ai#1661 C2，家里实现就是这样）。不写「已恢复」，不挂「?」，不铺诊断句和完整时间。原因和时间放进说明：一句话加「查看接活记录 ›」，没有记录写「还没有接活记录」；说明是一个按钮，悬停、键盘聚焦、点击都能打开，Esc 关。
  - **窄屏**（2026-10-21 补，原稿未定，#1661 C3）：改成卡片，和账户与登录的窄屏一样。第一行头像 · 名字 · 状态 · 开关，第二行模型 · 账号 · 接入方式；不在容器里横向滚动把状态和开关藏到屏外。
  - 「@ 名字」至少放得下第一个名字，有多个写「+N」；中英文表头都不重叠。行里新加的字都进中英词表。
- **账户与登录**（F320，You 10-10 09:0x–09:22 PDT，`[thread-id]#private-source-id`、`…private-source-id`）：
  - **位置**：猫猫团队 › 账户与登录，紧跟「成员与运行时」（You：「对」）。
  - **骨架**：账号只有一种东西。接入方式分两类：OAuth 登录（用某家官方工具登录订阅）和 API 密钥。OAuth 的类型就是哪一家（Claude、Codex、Gemini……）。同一家 OAuth 可以有多个号。支持很多家时也要能马上找到某一家：一个账号一行，可以搜索、可以按 OAuth / API 筛，不按工具一家一大块往下排。
  - **两个词分清，不用「当前」**：
    - 「本机默认登录」：这台电脑上 Codex App / Claude Code 自己登录的那个号（默认目录）。它在列表里是一个普通的号，名字就写「Codex App 登录（本机默认）」。
    - 「正在用」：一家 OAuth 现在选定的那一个号，只标在一行上。一开始就是本机默认登录；换成「主号」以后，标记就挪到主号那一行。用这家工具的本地猫都跟着它，云端的 gpt-pro 不算。
  - **登录成功不等于正在用**：新登录的号不会自动换上。换号前确认一次，写清哪些猫会跟着换、从下一次调用起生效、本机默认登录不受影响、怎么换回来（这张确认 You 说「这一页 ok」）。登录失败写原因，给「重新登录」；状态读不出来就写「读不到」。
  - **成员表直接写号的名字**，不写「跟随当前账号」：例如「Codex · Codex App 登录（本机默认）」，换号后变成「Codex · 主号」。某只猫被单独指定了别的号时，名字后面加「单独指定」。
  - 工作区 ID、账号目录这类内情点开那一行再看。
  - **列表版面**（You 10-10 14:29 PDT 看了 v2 稿：「这次的 ui ux 画的是对的」，`[thread-id]#private-source-id`；稿 `docs/evidence/2026-10-10-f320-accounts-redesign/v2/`）：
    - 顶上一行：搜索（能搜哪一家、号名、邮箱，也能搜猫的名字）· 「全部 / OAuth 登录 / API 密钥」筛选，带个数 · 右边「＋ 添加账号」，整页只有这一个添加入口。
    - 两块：「OAuth 登录」和「API 密钥」。列是 哪一家 / 号 / 状态 / 谁在用 / 动作。同一家的号挨着排，家名只写在第一行；「正在用」排这一家最前，后面跟着用它的猫的头像和只数。家与家之间按用它的猫多少排。API 密钥按地址认是哪一家，认不出的归「自定义地址」。
    - 别的号在动作列给「换成这个」，进换号确认。资料不全、用不了的旧账号收成一行放最底下，点开才列出来。
    - 状态只写读得到的：Codex 读登录状态；没有登录状态接口的家，按跟着它的猫最近一次调用写「能用 · 猫最近调用成功」，没有就写「读不到」；API 密钥只写「密钥已填 / 没填密钥」，不代表密钥有效。
    - 点开一行：跟着它的猫是哪几只（注明云端的不跟本机的号）、怎么换号、本机默认登录归原工具管理（退出、换号在 Codex App 里做），内情放最后。
  - **额度单独一列，用量条看**（2026-10-21，You：「下拉才出现这个查额度还挺奇怪的」，第一版写在状态格里一行字被说「太丑了」，重画后「可以可以 这个好看」，`[thread-id]#private-source-id`；稿 `docs/evidence/2026-10-21-member-list-quota-proposal/quota-1440.png`；取代 10-10「额度放在点开后的区域」）：
    - 列是 哪一家 / 号 / 状态 / **额度** / 谁在用 / 动作。接口给几个时间窗口就画几根量条，一个窗口一行：窗口名（如「5 小时」「本周」）· 量条 · 「剩 46%」· 「6 天后重置」（悬停写具体时间）；列宽不够时一个窗口排两行（上行窗口名和剩多少，下行量条和重置时间）。量条轨道各行一样长，不让文字挤短；放不下时只截重置时间。量条用 ink，剩余**低于 20%**（不含 20%）换 `{colors.warning}`，并写「接近上限」；剩 0% 写「已用完」（照画空条，0% 是真读数），不写「接近上限」。缺百分比或重置时间写「未知」，不补数。
    - 刷新是这一格行尾一个图标按钮 ↻，悬停写「刷新额度 · 上次 时间」；正在刷新时条和数字留着、图标转；没刷新上留着上次的数，下面小字「没刷新上 · 显示的是 01:35 的 · 重试」。
    - 还没查过的号给一个小按钮「↻ 查额度」；读不到写「额度读不到 · 重试」；这一家没有额度接口就写「这一家没有额度接口」，不放按钮。窄屏只留最紧的那个窗口。
    - 点开一行只留谁在用这个号和登录详情，不再放额度。
    - **查询没成功时说清是谁的问题**（2026-10-22，You：「查询应该写一下……如果没在使用很可能查询是失败的？这要如何在uiux上体现？……现在还以为你们哪里挂了」，`[thread-id]#private-source-id`）：额度格只说这一次查询的结果，「状态」列的「已登录」不跟着改（它只说明本机登的是哪个号）。正常时不出现任何诊断字。没成功时在额度格原位写两行：主行一个状态短语，次行写几点查的、为什么、接下来怎么办，后面一个文字操作。
      - **登录要续期**（官方说凭据过期，且之后本机凭据没变）：琥珀点「登录要续期 / Sign-in needs renewal」；次行「23:17 查询时官方说登录过期了。这个号在 Codex 里用一次就会自动续期，之后再查。」；操作「重新查询 / Check again」。没在用的号常遇到，但不写成「没在用就查不了」。
      - **已经续期**（失败之后本机凭据更新过，例如 suce）：不再挂旧的失败；打开页面或凭据更新时自动重查一次（同一个号每次凭据变化最多一次），过程中写「已续期，正在重新查询…」；成功回到量条，仍失败按新的时间写。判断不出凭据是否更新时按上一条写，靠「23:17 查询时」表明是过去的结果，不把号写成失效。
      - **这次没连上**（超时、断网、官方或我们自己的服务出错）：灰点「这次没连上额度服务 / Couldn't reach the quota service」；次行「23:17 · 和这个号的登录无关」；操作「重试 / Retry」。
      - **需要重新登录**（官方拒绝续期、凭据缺失或被收回）：琥珀点「需要重新登录 / Sign in again」；次行一句原因；操作「重新登录 ›」打开这一行「⋯」里现有的重新登录流程；本机默认登录那一行不放按钮，写「在 Codex App 里重新登录」。
      - 有旧读数时刷新没成功：量条和旧数留着，下面一行小字「没刷新上 · 显示的是 23:17 的 · 登录要续期 / 没连上 · 重试」。
      - 官方原话在悬停、键盘聚焦或点按状态短语时显示，不只给读屏软件；点开这一行在「最近一次查询」写时间、结果和官方原话。颜色只用琥珀点（要人动一下）和灰点（暂时的、不是账号的事），不用红。「重新查询 / 重试」只是再查一次。
      - **点「重新查询」时顺手续期；用完了就提示换号**（2026-10-22，You：「那我估计如果这样续期得用比如 luna 去续期好点」，随后「我点 retry 的时候才要去续期吧？或者反正都 0 了告诉用户需要换才行，不然就不能查也不是不行，反正都是用完换下一个」，`[thread-id]#private-source-id`）：
        - 上次失败是登录过期时，「重新查询」先续期再查，不另放「续期」按钮。续期优先用官方不调模型的刷新（需实测 `codex login status` / `codex doctor` 在这个号的目录下是否会刷新）；只有真跑一次 Codex 才能续期时，不在重查里偷偷调模型，写「这个号要在 Codex 里用一次才会续期」。
        - 没在用的号查不到不算问题：用灰点安静地写「没查到 · 登录要续期」，不用琥珀点、不提醒。只有「正在用」的号查不到才用琥珀点。
        - 「正在用」的号剩 0% 或接近上限：这一行写「用完了 · 换成 主号（剩 90%）」，操作按钮写明换成谁：「换成 主号」（就是那个号的「换成这个」，走原来的换号确认），指向剩余最多、查得到的那个号；正在用的这一行不放会被读成「换成它自己」的「换成这个」。查不到额度的号不推荐。
  - **添加账号**：本机默认登录不用添加，装了工具、登录过就自己出现在列表里。只有要再加一个号（公司号、私人号）才走「＋ 添加账号」：先选「用官方工具登录（哪一家）」还是「填 API 密钥」。菜单里只列真的支持多账号登录的家（现在只有 Codex；Claude 在 F320 计划里，还没做），不放假按钮。登录成功的号出现在列表里写「已登录」，不会自动换上，要换再点「换成这个」。
  - **状态和低频动作**（宪宪 10-10 补定，回应 F320 接入核对；细则 `docs/evidence/2026-10-10-f320-accounts-redesign/v2/states-and-actions.md`）：「正在用」由后端存一个明确的家级选择，猫分「跟随 / 单独指定」，不从成员里推；升级时各猫的号不一致就不挂「正在用」，在这一家上方原位写明分歧，由用户选一个统一，确认里单独列出用别的号的猫、默认不勾「也一起换」。号本身的状态和这一次登录的过程分开写：重新登录失败不把原来能用的号改成没登录。动作列一次只放一个（换成这个 / 取消 / 重试 / 去处理），改备注、重新登录、编辑、删除登记进行尾「⋯」，内情放在点开后的区域（额度原来也放这里，10-21 改到行上，见下条）；本机默认那一行的「⋯」只说明归原工具管理。登进已有的号或别的号时，在那一行下面原位确认，不在页面顶上堆红条。
- **插件集成：一个插件一行，动作一次只放一个**（2026-10-23，You：「整个ui 好像都改坏了 字体等等都不对了」，`[thread-id]#private-source-id`；对稿 `docs/evidence/2026-10-23-plugin-page-design-check/`。看北极星稿「10-12 的安静 + 现在的功能」后：「就按照这样」，`[thread-id]#private-source-id`；稿 `docs/evidence/2026-10-23-plugin-page-northstar/proposal-1440.png`。照「账户与登录」「成员与运行时」已定写法）：
  - 分三组：需要处理 / 已安装 / 可以安装，带个数，需要处理排最前。
  - 行：图标 · 名字（`{typography.title-sm}`）· 下面只有一行 `{typography.body-sm}` 灰字，放不下单行截断、悬停看全文。这一行按先后取一个：出了问题写中文状态（「运行出错」「和当前版本不兼容，已停用」，带琥珀或灰点）> 有新版（「有新版 0.1.2」）> 一句说明。来源可疑只在名字后挂灰色小标签「来源未知」。不放英文原话。行高一致，不因为字多、按钮多被撑高。
  - **动作列一次只放一个**：最要紧的那个（坏了先「修复」，否则有新版「更新」，没装「安装」），用次要按钮，不用赭红实心；开关留在行尾；卸载等低频动作进行尾「⋯」或详情，不常驻在行上。
  - 详情：顶上图标 · 名字 · 版本和来源一行，右边开关和「⋯」；出错和有新版各占一条提示，出错那条的「修复」是这一屏唯一的主动作，有新版那条用普通按钮「更新到 x.y.z」；来源记录、仓库可用版本和「卸载插件…」放在最下面一行。出错用 `inline-notice`，写中文原因和下一步，英文代码放悬停或展开里。「标签 — 值」左右挨着排（标签列约 120px），整块最宽约 720px，不左右贴边。正文 `{typography.body-md}`，说明 `{typography.body-sm}`。
  - 页头：「从本地目录安装 / 从安装包安装」合成一个「安装插件 ⌄」；开发文档是灰色文字链接「开发文档 ↗」，不用蓝。
  - 窄屏：行改卡片，第一行图标 · 名字 · 状态 · 开关，第二行灰字；动作照样一次一个。
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
- 猫的名片牌：每次回话开头一块，认人靠它。32px 头像 + 名字（13px / 600）。头像压在牌子左端：底边比牌子低 2px，顶上比牌子高出一点，外面一圈 2px 的工作面底色把它和牌子分开（2026-10-05 You 嫌 16px "看不清你们的美貌"，在三种放大里选了这一种，`[thread-id]#private-source-id`，稿子见主页北极星 `?s=rp6`）。头像不带猫色的圈：牌子本身已经是猫的颜色，再加一圈等于把同一个颜色标两遍（`CatNameplate` 用 `ring="none"`，别处的头像不变）；如果哪只猫的头像在暗色牌子上糊成一片，加 1px `{colors.hairline}` 细线，不用猫的主色。牌高 26px，上两角 8px 圆角，左内距 40px（给头像让位）、右内距 10px；转发卡里的缩略名牌仍用 16px 头像；时间跟在牌子右边（12px `{colors.muted}`）。牌子的底用这只猫在当前主题下的表面色，从上往下淡出到透明；名字用当前主题下的猫名字色。牌子下面直接是正文，作品卡片、动作回执、状态行跟在正文下面，都不再包一层框。
- **点名片牌上的头像或名字：出一张「看猫」的小卡**（10-23 You：「我有时候觉得你们的头像很好看，很可爱，我就想要看看你们的这些可爱的大猫猫」，`[thread-id]#private-source-id`；v2 被说「放这么大比例失衡」后定 v3；10-24 You 问「点击你们的头像出现你们的小卡还没实现诶？」，`[thread-id]#private-source-id`；稿）：
  - 点头像或名字出卡，贴着名牌往下；点卡外、按 Esc 关；鼠标路过不弹。不再直接跳到设置页。
  - 卡宽 340、圆角 14。顶上一条 52px 高的它名牌浅色底，头像直径 96、白边 3px、轻阴影，压在浅色底下沿，左边 16。名字（18px 半粗）和「品种 · @名字」（12.5px，太长省略）在头像右边、和头像底对齐。点头像用现有的图片浮窗看整张原图（鼠标是放大镜）。
  - **横幅可以换成图（2026-10-26 定稿，随「设置 › 你」那一轮一起拍板，`[thread-id]#private-source-id`）**：这只猫设了横幅图时，顶上那条变成 104px 高，图片 cover 居中铺满；头像照旧压在下沿，名字和「品种 · @名字」仍写在下面的纸上，不叠在图上。没设图时还是 52px 的浅色条。在设置 › 成员 › 这只猫 › 「横幅」里设（颜色 + 图片），设置页还没画。第一张是云端宪宪的黄昏（从他头像 C 的窗外裁出）。来由：云端宪宪说想用「那片黄昏的云」当横幅，You「发现新的需求！……成员卡的横幅！！！」（`[thread-id]#private-source-id`）；稿。
  - 下面只留认猫的几行：一行状态（和成员页、执行行同一套：可用 / 额度紧张 / 不稳定 / 不可用 / 正在这条对话里回复 · 时长 · 看它在干什么 ›）；模型；它自己写的那句性格，最多三行。不放 ID、目录、走哪个号这些配置项。
  - 三个动作：「@ 它」把 @名字放进输入框光标处；「只看它的回话」切到这条对话只看它（现有对话视图）；右边「设置 ›」跳到设置里这只猫那一页。聊天里不放第二套配置表单。「停止」只在执行行。
  - 手机上从底下升起同一张（浅色底 46，头像 84），往下拖或点外面收起。你自己的头像不在这个范围。以后头像可以换成会眨眼的小动画，版式不变。
- 名字读得清的判据：在当前主题（浅色、暗色、调色器调过的）下，名字文字覆盖到的每一处，和它实际叠出来的背景（渐变、透明叠底、下面的工作面一起算）的最小对比 ≥ 4.5:1。不够就在当前主题里调名字色或牌子色，不朝一个固定方向压暗（暗色里往 ink 压只会更糊）。参考数只对北极星稿那张浅色样张成立（牌底 = 75% 猫浅色 + 25% 工作面）：家里三种家族色的名字用"65% 主色 + 35% `{colors.ink}`"是 4.64–5.54:1，稿子里的 75% 在暹罗蓝上只有 3.84:1；这不是公式。暗色沿用同一条规则：牌底是这只猫在暗色下的表面色，往下淡到透明，名字用暗色的名字角色；不为暗色另写公式，嫌牌子太淡就在 F056 调色器里调暗色的猫表面明度（设计负责人 2026-10-01 认可，`[thread-id]#private-source-id`；实现 #4978）。#4978 作者自测的 16 格（浅、暗、各调过表面）最低 8.69:1，只覆盖这些主题且没调名字角色，不代替上面按当前主题实测的判据。名字角色在显示时有可读下限：用户保存的值原样保留，只有不够读时，显示值才往最近能过的一侧移动明度（色相、彩度不动；两侧差不多时取当前主题文字本来的方向）；两侧都过不了时，名字先按工作面取离保存值最近、能过的值，牌子的明度在显示时往工作面那一侧让，让到名字读得清为止（牌子的色相、彩度和保存值都不动）；连页面底本身都过不了时，取最差处对比最高的那个明度（不一定在两端），调色器里如实写没达标。这里的"背景"按当前配置里真的会出现的猫色、人色和调色器参数算，不按假设的颜色范围算；猫的名单或颜色一变就重算。调色器在猫名文字下面把话说明白：显示值和保存值不一样时，并排写“你存的 / 实际显示的”（名字挪了写名字，牌子挪了写牌子，保存的值没改）；读不清时写“这组颜色下名字读不清（最高 x:1）”，x 向下取整，不会把没达标的写成 4.5。
- 颜色从哪来不变：仍走 F056 那条链（`ThemeApplier` → `themeStore` 的 `buildCSS` → 按明暗各自派生的 OKLCH 梯度与 `--cat-name-*`，落到 `--color-{slug}-surface`、`--color-{slug}-text` 这些角色；起点是 `cat-config.json` 的猫色）。名片牌消费当前生效的这些角色，调色器对名字和表面的调节照样生效，不另造一套固定色公式。现在运行时的名字色是所有猫共用的一组 H / L / C，名片牌上的名字要不要带各自的色相，由调色器的名字角色决定。变的是用在哪：从整块气泡底色收到名片牌上，一只猫在一屏里只有这一小块颜色。整块上色、勾边、托盘、斜光、淡底都画过，放进 Studio 的窄聊天栏后，带框的都和作品卡片框里套框、和旁边的作品抢眼，经过见 Studio 北极星 §0.7。
- 定位环：点回执或吸收坞时，相关消息上那圈约 3 秒的定位环用人的颜色；它不是文字，明度在显示时有 3:1 的下限，判法同名字角色（保存值不动，只移明度；两侧都过不了就取最差处对比最高的那个明度）。
- **每只猫一条颜色边**（2026-10-06）：猫的一条回话，从名牌下面到最后一行，左边一条 3px 的竖线，用这只猫的颜色（和名牌同一个来源）；正文离竖线 16px。不填底色、不加框、不加阴影。长消息滚到中间，看竖线的颜色也知道是谁在说。来由：You 用了一天新版，嫌「满屏一个颜色、全是字」。我拿 F314 的真实长对话排了几版：C 颜色边、D 淡底色、10-01 的 I2 托盘气泡。他看了说「三个都挺好」，真正的问题是「输出太长了，啥也没有……信息不够突出」（`[thread-id]#private-source-id`）。所以选最安静的 C，把力气花在内容上（见下一条的「正文只放回答」）。对照图在 `.cat-cafe/evidence/f322-real-content-compare-20261006/`，里面是真实对话，不进仓库。
- 一次回话分三层（2026-10-05 You 看稿认可，`[thread-id]#private-source-id`；细则和代码依据见主页北极星 §1.16；#5145 / #5152 / #5174 / #5179 已合入，10-06 重启后真页面首看见 §1.16 末尾）：
  - **说了什么、做出了什么**：这一轮的回答直接用正文排在名牌下面，不进任何框；干活中途写的过程话不进正文，按时间放进执行记录、夹在工具行之间。回答和过程话怎么分，先认猫输出时自带的证据（每条输出的身份 + 过程/回答）：Codex 有原生通道，照它分。没有通道的猫（Claude、Kimi、Gemini 等）由一个开关决定（2026-10-26 You：「最好做成开关，现在不知道 b 这种到底安全不安全，没准你把有用的信息放上面了」，`[thread-id]#private-source-id`）：设置 › 主题里的「回话里的过程话」，**默认「整段显示」**，整段留在正文，和以前一样；改成「收进执行记录」后，以这一轮成功结束时的最后一次工具调用为界，之后的话是回答，之前的话按时间进执行记录。这条边界和 Claude Code 自己交出的最终结果（result）是同一条，不按标点猜；Opus 5.5 这一代把较长的过程话标成「进度」块，只当旁证（短的过程话仍是普通文字，进度块里存的是模型写的英文摘要，不是原话）。这一轮没有工具调用就整段算回答；失败、被取消的整段保留。被这样分过的回话，回答上方留一行「前面还有 N 段话 ›」，点开在原处展开，不用去执行记录里翻；没有证据的老消息照原样整段显示，但不同输出之间至少断成两段（10-06 真页面更正）；作品卡、改了哪些文件、回执跟在后面；交给别的猫写成这条回话里的一行"交给 [头像] 猫名"（排队交给 / 同时交给），不再另起一条蓝色胶囊。
  - **同一次执行发的几条消息**（2026-10-08，§1.22）：名牌只挂在第一条；后面的消息接在同一条颜色边里，上面一条细线写「23:31 · 同一次执行里的第 2 条」；执行记录和最后一行只在这一组末尾出现一次。这只是展示上的归组：只把能证明属于同一次执行的消息归在一起，不跨别人的插话重排；同一次执行里文字完全相同的可以折叠成一段，但每条原消息和它带的作品、回执、引用、复制来源都保留（例如两条文字一样、各挂一张不同的图，两张图都在）。
  - **最后一行**：干活时是"正在 + 动作 · N 次工具调用 › · 轨迹"（10-06 起不带参数：真页面上整条命令原文 `/bin/zsh -lc "python3 - <<'PY'…` 太吵，参数放进悬停提示和执行记录），做完以后是"[召回 N] N 次工具调用 · 时长 · 花费 › · 轨迹"（花费 2026-10-08 You 认可放回这一行，token 和缓存仍在执行记录里）；「轨迹」是次要入口，用 muted，不上色。状态只写最近一次工具调用；很久没动静、读不到状态的判断和措辞与执行中那一行同源，不写"几分钟前有进展"；正常做完不写"已完成"；没有完成、已停止、结果待确认、等你决定才留下状态行。颜色只给前面的小圆点。
  - **干活时这一行要看得出在动**（You 2026-10-09 05:31 PDT，`[thread-id]#private-source-id`：「只是头像闪烁……会老让我感觉你是不是卡了」）。10-06 去掉参数以后，连着几十次「正在运行命令」字都不变，点又是静止的，看起来像停了。改成：
    - 动作后面带一个短对象：文件名（`ThreadItem.tsx`）、搜索词、命令的第一个词；整条命令仍只进悬停提示和执行记录。
    - 前面的点换成和侧栏同一只蓝色会跑的小猫；每来一次工具调用，字换一次、小猫跳高一下。
    - 用时每秒走：「· 2 分 13 秒」。
    - 小猫怎么动跟着真实状态走（2026-10-11 改，You 看真页面：「他不在跳动，像卡住」，`[thread-id]#private-source-id`）：
      - 这一轮还在跑、没被判成没动静：小猫一直小跑，和侧栏那只同一个节奏（0.8 秒一下，起落 2–3px）。
      - 每来一次工具调用：跳高一下（约 6px，0.6 秒），然后接着小跑。
      - 被判成没动静（两分钟没有新动静，或运行状态报了疑似卡住）：小猫立刻停，换成琥珀点，照「很久没动静」写。
      - 系统设了减少动态：小跑和跳都不做，靠字和用时表示在动。
      - 头像仍不靠常驻闪烁表示在干活。
      - 这一条取代 10-09 的「没有新事件就不动」。一条长命令跑几十秒、中间没有新事件是正常的，小猫不动反倒像卡住；真卡住时，最多跑两分钟就会被判出来、停下。对比小样：`docs/evidence/2026-10-11-f322-reply-cat-motion/demo.html`。
  - **怎么干的**：点最后一行展开执行记录：召回分项、思考、每次工具调用，最后一行是模型和花费。默认收起，干活时也不强制展开。
  - **子代理**（2026-10-07 You 定，`[thread-id]#private-source-id`；画面见主页北极星 §1.17，`?s=sa1`–`sa3`）：猫叫来的子代理归在"怎么干的"里，不另起卡片，都在这只猫那条颜色边里面，不另给颜色。最后一行照旧写这只猫自己最近一次工具调用（不带参数），后面加"子代理 N · 几个运行中"；只有最近一次调用确实是在等子代理才写"正在等子代理"。执行记录里子代理是一组：组头只写要留意的（运行中、失败、已中断各几个，都完成了写"都完成了"）；每个一行、列对齐：小名签（所属猫的深色字、浅底，只包住名字）、任务短标题（拿不到就显示任务标识，等宽字，不替它编）、状态圆点 + 文字、用时。点开先露最新进展（运行中）或最终回报（完成），更早的收进"之前的 N 条进展"；再叫子代理就缩进一层，不写 depth、不显示 `/root/…` 路径。这只猫自己的工具调用收成一行"这只猫自己的 N 次工具调用"。不用紫色标签，状态不做实心胶囊。
  - 召回 N 和"记忆"面板同一批记录、同一个分组，这一轮结束后才出现；状态只读这条回话自己那次执行；停止只在执行中那一行；设置两档（执行记录默认收起 / 展开，这条对话可单独调），沿用现在的折叠偏好。
  - 名字行只留名牌、时间和有内容时的引用、方向标签；`#` 和朗读收进鼠标停上去那一排（多选、回复、轨迹、朗读、删除、更多）。那一排紧跟在时间后面浮出：贴近作者区、静止时零占位、出现时不挤动版面（F294 #3908 定的，不放到回话最右边）。多选：每条左边一个勾，输入框的位置换成"已选 N 条 · 导出为 文档 文本 长图 · 转发 · 取消"（You 10-05 认可）。**转发只有多选这一个入口**（2026-10-23 You「这个转发这个东西是OK的」，`[thread-id]#private-source-id`）：那一排第一个「多选」悬停提示写「多选：转发或导出」；「⋯」里没有转发，卡片不带悬停转发按钮，也没有右键菜单。多选里有卡的消息，每张卡左上角一个 18px 小方勾（只在多选时出现）：勾消息 = 文字和所有卡都勾上，点掉一张卡圆勾变「−」，不勾消息只勾一张卡也是「−」；底部有卡没勾时补一句「1 张卡没勾」，导出和转发用同一份勾选。转发面板最上面一句写转什么、哪张卡没带，不在面板里再勾一遍。选中一段文字的「引用… / 转发」照旧，用同一个转发面板。稿转发卡（F294）：转发人的留言是他自己的一条消息，卡紧跟在下面、纸面细边、不套气泡；多条时收起先露原顺序前两项（16px 小名牌 + 两行字，不可读的写原因），再"展开全部 N 条"；单条直接展开。仍是同一条消息、同一个转发包（F294 负责方 10-05 确认，护栏见 §1.16）。
- 人发的图（2026-10-08，§1.22）：一排固定大小的缩略图，靠右放在气泡上面，不包进气泡；字照旧在气泡里。
- **别的对话发来的消息（来信）**（2026-10-08 You 01:38「新的来信 ok 了」，`[thread-id]#private-source-id`；主页北极星 §1.24，`?s=lt1`、`lt2`）：You 01:15 指出 v1 一眼看得出是跨对话的通讯，v2 看不出来（`[thread-id]#private-source-id`）。v2 现在只在名字行挂一颗 11px 的灰色「来自…」小药丸，正文和这只猫在本对话里说的话长得一样。改成：
  - 名牌照旧，认是谁写的。正文装进一张信纸：纸面底、1px `{colors.hairline}` 细边、10px 圆角，和转发卡同一家；信纸不画这只猫的颜色边。本对话里说的话不画框，别处来的才有框，靠这个一眼分开。
  - 信纸第一行写全：信封图标「来信 · 从「来源对话标题」→ 写给谁」，最右「去原对话 ↗」，点了跳到原消息（有来源执行 id 就定位到那条）。来源 id 只放悬停提示。
  - 写给谁取这条消息的显式收信人，没有就取行首 @；猫用小名签（那只猫的颜色），写给你用赭色实底「@你」，算「要你动手」那一档（侧栏也亮）；都没有就不写箭头那段。
  - 来源标题拿不到时按 id 去取；确认来源已删除才写「一个已删除的对话」，不给跳转；只是读不到就写「来源对话（标题读不到）」，照常给跳转，不猜删没删。
  - 名字行里原来的「来自…」小药丸和「↗ 前 8 位 id」方向标签都去掉：两个说的是同一件事，↗ 还读成「发出去」，和「从那里来」正好相反。
  - 可以后做：正文里的消息坐标 `thread_…#…` 显示成「原话 N ↗」，点了跳过去，全文进悬停提示；所有消息都受益，不只来信。
- **插件和外部发件人的消息**（2026-10-23，开源 clowder-ai#1711 提出：插件消息被做成单独一类卡片，来源跳转藏在发送者名字上；按家里现有写法定）：插件（如 GitHub Operations）和从别的平台来的人，用和猫同一套消息外壳——靠左、名牌、时间、鼠标停上去那一排操作（回复、多选、删除、更多）、回复时的引用预览都一样。不再给它们单独的底色、单独的气泡。
  - 名牌照实写来源，不装成猫或人：插件是它自己的图标（圆角方块，和猫、人的圆头像分开）+ 插件名 + 名字后一个灰色小字「插件」；外部的人是对方的名字和头像（没有头像用首字）+ 灰色小字「外部 · 来源平台」；Host 自己发的（持球、托管命令、回执）写它是什么，如「持球通知」。名牌底用中性的 `{colors.surface-3}`，不用插件的主题色，插件的颜色只留在它的图标里；正文左边的竖线用中性的 `{colors.hairline}`，彩色的颜色边只属于猫。外部的人也靠左：靠右只属于你。
  - 名字和头像不跳外部页面。要去的地方写在正文里、看得见：说的是哪个外部对象（PR、issue、工单），正文第一行就是它的标题，编号和标题本身就是链接（如「clowder-ai#1711 插件消息与成员共用消息外壳」），不另起一行「在 GitHub 查看」。正文里的链接和路径按所有消息共用的规则显示。
  - 要你操作或会变的内容（持球等待可取消、托管命令、Host 回执、开发回执）按内容选样子，不按谁发的：外壳照上面，正文里放现有的内容卡。状态写成一行，同框上面的执行行：状态点 + 一句话 + 一个动作（如「等 CI 跑完 · 10 分钟后再看 · 取消等待」）；结束后收成一行，同审批卡批完的写法（点 + 结果，如「已结束 · CI 通过，已叫醒宪宪」）。
  - 隐藏行、被吸收的托管命令、系统提示、挫折可见性这些原有规则照旧。
- **正文里的路径和链接：变成能点的东西，点开在右边**（2026-10-22 You：「给我的任何的 path，我希望它能解析成东西……你看它这给我一个这玩意，我还得自己复制在右边输入，然后打开一下」，`[thread-id]#private-source-id`；看稿后「对对对我想要这样的！！……你这里右边得是现在那样 方便复制 path 快捷打开 finder」，`[thread-id]#private-source-id`；稿 `docs/evidence/2026-10-22-chat-path-chips/`）：猫、人、插件的消息都一样。
  - **怎么写都认**：反引号里、正文里、Markdown 链接里的路径；相对路径按这条对话绑定的项目找。要真有这个文件（真有这个提交、这个 PR）才变，对不上就照原样显示；代码块里的不动。
  - **句子里是一枚小标签，单独一行是一张卡**。小标签：类型图标（文档、代码、文件夹，PPT / Word / Excel / PDF 各自的色标），图片带 16px 缩略图；只露文件名，有行号加「:行号」；悬停显示完整路径（等宽），可复制路径、在 Finder 中显示。一行只有它（或列表里一项只有它）时是卡片：图标或缩略图、文件名、所在目录（等宽，放不下截断）、类型 · 大小 · 时间；图片卡直接露出图；一次交几个就排成一组小卡。
  - **点开都去右边，用现在的 Workspace**：顶栏、标签，「⋯」和右键里的复制路径、在 Finder 中显示、用默认应用打开都照旧（见「打开作品后：一排顶栏 + 常用文件操作」），不另做简化的查看器。文档和代码开成常驻标签（同「聊天里显式点的文档链接」那条），有行号就跳过去；图片走浮窗；文件夹在文件树里展开；提交号和 PR 在右边看改动；别的网址去浏览器。
  - **本地网页默认渲染成页面**（2026-10-26 You 在 F329 沙盘线：「家里的 workspace 有问题，这里应该能自动用图 2 这个打开才对」，图 2 是 Workspace 的「页面预览」，`[thread-id]#private-source-id`）：本地 `.html` / `.htm`，不管是点路径小标签、从文件树打开，还是猫用 `cat_cafe_workspace_navigate` 打开，都进 Workspace 的「页面预览」渲染。同目录的相对路径图片、样式、脚本照常加载（家里的证据页和设计图册多是 `index.html` 加同目录的图，You 看实物靠它）。标签顶栏有「看源码」切到代码视图，再点切回；要改这个文件时才进代码视图。网页放在沙箱里跑，碰不到家里的接口。
  - **GitHub**：PR、issue 写编号、标题和 GitHub 当下的状态（进行中绿、已合入紫、关了红）；读不到状态只写编号，不猜。GitHub 上的文件链接，本地仓库里有就打开本地文件。
  - **文件不在了**：虚线灰字，悬停写「这个文件已经不在了」，不等点了才发现打不开。
  - **PPT / Word / Excel**：Workspace 现在不能预览，点开先照实显示图标、页数、大小，给「用默认应用打开 / 在 Finder 中显示」；要在右边直接翻页看得加转换工具，以后单独定。
- `message-bubble-user`（人的消息，2026-10-01 You 定）：靠右，一整块 12px 圆角气泡，不淡到透明，也不挂名片牌、不署名：Café 里只有你一个人，靠右就是你。短句按字收窄，最宽约阅读栏的八成，左侧留空；字在气泡里左对齐。底色用人的颜色的浅色（下一条）。时间用 `{typography.caption}` `{colors.muted}` 挂在气泡下面，连着几条只在最后一条显示。
- **靠右只属于 Café 里的对话，不带进共同体频道**（2026-10-08 You 纠正，`[thread-id]#private-source-id`："那是在家里的规则……家里的 chat 的产品逻辑和类似 Slack 的多人多猫能一样吗"）。上一条成立的前提是"Café 里只有你一个人"；频道里有很多人和很多猫，读的人要先认出是谁在说，消息还常带工作卡、作品卡和回复，要用满阅读栏。所以共同体频道里每个人（包括你自己）和每只猫都靠左，开头挂名片牌：人用人的颜色，猫用猫的颜色，头像和名字都在。你自己的消息不靠右、不加气泡，和别人一样排。10-01 这里写过"共同体里你自己的消息仍靠右"，是我把家里的规则硬搬过去，已撤回；F290 北极星稿里按它画的靠右气泡要一起改。
- 人的颜色：所有人共用一种，可可（主色 #6B5443 / 浅色 #E9DCCF），不用灰色（You："灰色像个机器人"）。颜色从配置来：新版界面里，配置里人的颜色由 `CoCreatorHueInjector` 写成人的色相和彩度，经 F056 的明暗梯度得到 `--color-cocreator-*` 这组人的主题角色，气泡底取 `--color-cocreator-surface`（#4983）；调色器的明暗梯度照样生效，浅色、深色各自派生。没配人的颜色时就用可可，不再回退到 `{colors.surface-3}`；代码里的默认值 `CO_CREATOR_COLOR` 也是可可。经典界面不变，人的色相仍是 `cat-persona-tokens.css` 里写死的 40 / 0.13。其它用到人的主题角色的地方，在新版里也跟着人的颜色变色（色相、彩度跟配置走，明暗不变）。名字读得清的判据同猫的名片牌。经过见 Studio 北极星 §0.7。
- 共同体房间（Collective Client）：它是嵌在 Café 里的独立页面，长相跟打开它的那个 Café 走：界面版本（经典 / 新版）、明暗和调色器调过的主题、人的颜色，都由宿主通过宿主桥传进房间，房间里不另设一套。跟着 Café 走的只是这些外观；消息怎么排、侧栏放什么，按频道自己的规则（见上面"靠右只属于 Café 里的对话"和 F290 北极星稿），不照搬家里对话的版式。宿主没传时（桥还没接通，或者房间被单独打开），用 Café 当前的默认：界面版本按 Café 的默认值（现在是经典），浅色，人的颜色用可可。`?presentation=v2|classic` 和 Café 的 `?shell=` 一样，只作为链接和验收入口。房间现在只有一套浅色变量，系统切到暗色只会翻转 color-scheme，不能算暗色验证通过。
- **共同体频道里的图、贴纸和续读**（候选，2026-10-24，待 You 看图；稿和照抄的数值见 F290 北极星 README「10-24 频道表达」）：
  - 输入框和家里是同一个（见「输入」），频道里只差三处：
    - 所有人靠左；图放在名牌下面、正文上面，一排靠左，每张 220×140；
    - 底下一排没有「项目」和「发给谁」；
    - 多一个贴纸按钮，家里也加。
  - 贴纸是一条消息：桌面 128px，手机 112px，不包框。它和回应、投票、接下工作、验收都无关。首包只挑表情；画面像交付、接下、退回、被推翻的不放。
  - 回到有未读的频道时，停在上次读到的地方，第一条未读前画一条「新消息」线；第一条未读不在视野里时，顶部出「N 条新消息 · 跳到第一条」。真的看到才算读过。
- 猫的衬线时刻：猫主动开启话题、空态问候、总结陈词可以用 `{typography.display-sm}`；日常回复用正文。

### 共同体：带猫进来、频道里的回复
2026-10-12 You 在 F290 线定的方向（`[thread-id]#private-source-id`），并要求回流到这里（`…private-source-id`）。同日 21:36 PDT，他引用 873 的 9c 稿说“审核ok update吧”“可以了 这些都ok”（`…private-source-id`）：该设计包列出的 9c 我的猫、9b 已允许的工作、2b 频道菜单、3c 例外卡、13 共同体菜单均已确认。未画分支、实现和真实验收仍开放，见 F290 北极星交接 §6b、§7。后台依据是 [F290 通讯模型](docs/architecture/f290-communication-model.md) §1–4、§7。
- **带猫进来 = 家里的成员名单 + 一个开关**（You：「直接检测家里有多少成员，然后一个开关，开了就是带进来」）：成员页「我的猫」直接读家里现在的成员，和「设置 › 成员与运行时」是同一份，头像、名字、品种和模型、@ 名字都一样。不用先建档，不另造一套公共猫。每个真实成员一行，每行只有一个开关「参与这个共同体」：开了就带进来，频道里能 @ 到；关了就不带。
  - **一行认一只猫，不认它背后的一路对话**：同一只猫同时在好几个频道、好几件工作里跑，也只有一行，不让人选「哪一路小星星」（You：「小星星他后面可能有一万只小星星呢」）。同名的不同成员各一行，靠品种和模型分得出，比如两只宪宪（Opus 5.5、Fable 5）。
  - **开关只管这一个共同体**：不是家里的「启用」，打开也不会自动唤醒很多路执行。沿用 F290 已有的默认带进来、显式排除和频道例外；以前关过的照旧关着。
  - 不能参与的照实写原因（家里已停用；这种接入方式暂时不能参与），开关不能点，不悄悄打开家里关掉的成员。读不到名单时整块写读不到、给「重新读取」，不当成没有猫。
  - 这一页不放频道、正在做的工作和授权：谁留意频道里的所有消息在频道菜单里设；接下的工作在小信箱「日程」；以前允许过的在「已允许的工作」。公开的成员名片只看身份。
  - 「点一只猫进详情页，在里面管它参与的频道、正在做的工作和授权」（F290 北极星 9a）已被 You 否掉，图留作历史，不再作依据。
- **回复挂在原消息下面**：猫和人回复一条频道消息，都留在这条消息的讨论里，不另发一条看不出回的是谁的主消息，也不默认把每条回复再广播到频道里。原消息下面露出最近两条回复：回复者的头像和名字、正文第一行、回复数和时间，点开看完整讨论，也能回到原消息（You 854：「消息下，显示最近两条和回复」→「也没啥问题」）。频道里人和猫都靠左（见「对话」里「靠右只属于 Café 里的对话」）；外观跟打开它的 Café 走，版式按频道自己的，不照搬家里单人对话。

### 共同体：项目、任务和看板
2026-10-18 You 冻结（`[thread-id]#private-source-id`：「那我们就先按照这个版本冻结到北极星的相册和 design 里」）。这版是宪宪的 v1.1 和烁烁的北极星稿（`…002283–002285`）合成的 v1.2。稿、示例出处和「今天还没有的」见 `docs/evidence/2026-09-29-f290-collective-northstar/README.md`「v1.2」，图册第五章「项目」「项目看板」「进到一个项目」。

- **项目是什么**：一个共同目标和它下面的任务。不是家里按文件夹分的项目。侧栏只有「项目」一项，Roadmap 不单列：它就是项目里的「依赖图」视图。
- **叫法**（You 10-18：语言对齐成熟产品）：任务、负责人、执行、阻塞、前置任务、动态、待办、新建项目 / 新建任务。不用「等你」「从讨论里定一个」「冻结」这类自造词。
- **负责人和执行分开**：负责人是人，负责验收；执行可以是负责人自己，也可以是他家的猫。猫交了结果，任务变成「待确认」，进负责人的待办，负责人确认了才算完成。每个项目、每件任务都写「负责人 · 执行」，执行用头像小签。
- **什么会变成任务**：人在一条消息上「建成任务」，或在项目里新建，每件都有出处；猫建议，人点「接受」才算数；别人在频道里请你家的猫做事，猫按你给的授权自己决定接不接，接下就是你负责、猫执行；GitHub PR / Issue、会议纪要以后先进「待分拣」，由负责人接受、忽略或并进已有任务。会议纪要不会自动变成任务。
- **顶栏只放两样**：视图切换和主按钮。项目页的视图是「项目列表 / 跨项目依赖 / 看板」，单个项目里是「计划 / 看板 / 依赖图 / 作品」。「与我相关」是筛选，不是视图。筛选放第二行，是带件数的胶囊；分组等显示设置收进一个按钮。
- **待办**：项目页顶上的待办和家里的待办是同一份。「看谁的：我 ⌄」只管这一块，默认是自己，可以选成员。每件一行：状态标签（待指派、待验收、多久没回）+ 一句话 + 一个动作。
- **项目列表**：每个项目一行，依次是完成标准、负责人和执行、一根分段进度条加件数、阻塞或下一步、最新作品（可直达）。不写进度百分比。
- **看板**：列按进度从左到右，依次是待开始、进行中、待确认、已完成。阻塞不单独成列，是卡片顶上的红色横幅，写在等什么；待确认的卡顶上是琥珀色横幅，写在等谁。泳道默认一行一个执行者，可以改按负责人或项目。未分配置顶、铺浅红底，卡上直接「指定负责人…」。猫建议、人还没接受的事不进看板。
- **单个项目里**：做完的折成一条绿色横条，不会被后来的调整挪动。做不下去时在它前面加前置任务（标「新增前置任务」），被挡住的任务缩进、标阻塞。没人负责的照实写「未分配」，进项目负责人的待办，不替人补。
- **猫怎么参与**：右侧写「猫接手这个项目的任务时先读到这些」，包括项目目标、已完成、当前阻塞、出处。被分配、前置任务做完、被退回修改、有人在任务下说话时，叫醒执行的猫。猫只能建议，不能替人接受、改别人的承诺或自己标完成。
- **动态**：人和猫的操作都自动记下（谁、什么时候、改了什么），有出处就附上，不用填表。
- **颜色和图标**：状态色用色板，进行中 `{colors.info}`、完成 `{colors.success}`、待确认 `{colors.warning}`、阻塞和未分配 `{colors.critical}`。文字用往墨色压过的那一档，只做圆点、图标、标签淡底和整块淡底。图标用家里的 SVG，不用 emoji。
- **时间**：不写每件任务的「承诺 / 预计」两个日期。写最近一次动静，拖久了写多久没回（如「18 天没回」）。日期等真需要了再加，排期字段是后续契约。
- **日期、待分拣和作品版本**（候选，2026-10-26，待 You 看图；稿和全部规则见北极星 README「10-26 第二批…第三批」）：
  - **日期**：叫法沿家里日程（截止 / 请你审阅 / 计划开始 / 实际开始 / 预计完成）。上一条不变：列表最后一列改叫「时间」，一格只写最要紧的一个（过期 > 截止 > 请你审阅 > 预计 > 最近动静），没有日期照旧写最近动静。截止和请你审阅只有任务负责人能定，别人和猫只能建议，建议写理由、等负责人点。每次改都记谁、何时、出处。预计、会上提到的日子都不会自己变成截止。
  - **待分拣**：已登记仓库的 PR / Issue、发布在频道里的会议纪要，先进项目的「待分拣」。项目负责人选建成任务、并进已有任务、留作资料或忽略；同一份只列一次、只处理一次。分拣不往外写，不替人定负责人和日期；来源打不开就不显示原内容。
  - **作品版本**：项目里写「这个项目用的」是哪一版。出了新版只提示「有新版 vN」，由项目负责人选「换用… / 保持…」，不悄悄跟着变；换的时候只改这个项目，别的项目和旧版都不动。

### 状态与标签
- `badge-status`：pill、`{colors.surface-3}` 底、12px 字。文字表达状态，颜色只给左侧 8px 圆点（`status-dot-*`，在 surface-2 上 3.70–4.34:1）；没有文字的裸圆点不是合法状态指示。
- `badge-primary`：`{colors.primary-soft}` 底 + `{colors.primary-active}` 字，用于"新 / 推荐 / 待你决定"这种需要被看见的少量标签。
- `tab` / `tab-active`：选中 = 抬到 `{colors.surface-3}` + 字色变 ink，不用下划线，不用主色。
- **Workspace 顶栏**（You 10-10 16:00 PDT，`[thread-id]`：「这个标签看起来没一个完整的……这几个要不全收起来得了……展开后的这几个图标都让人看不懂……没名字、没解释、hover 啥也没有，甚至还有重复的 svg」；稿 `docs/evidence/2026-10-10-f322-workspace-tools/ws3c-*`）：
  - 左边是标签，每个标签是完整的一块：图标 + 名字 + ×（「首页」不带 ×）。没选中的标签之间画一条竖线隔开（约 18px 高，`{colors.muted}` 约 45% 浓度；发丝线太浅看不见，You 17:06「太浅了，看不清」）；选中的按上一条抬底色、字加深、带一圈 1px `{colors.hairline-strong}` 细边，它两边不画分隔线，不画下划线（You 10-10 16:53：「每个 tab 标签的分割呢？」）。放不下时末尾写「还有 N 个 ⌄」，用中文，不写 More。
  - 右边只放两个按钮：「+」打开工具或文件（见 Workspace 的「+」浮层），「⋯」放其余的。锁定视图、专注、整窗、左右并排、关闭其他标签、关闭全部标签、收起 Workspace 都进「⋯」，每一项写名字，需要时加一句短说明或快捷键。顶栏不再排一串没有名字的图标；收起 Workspace 用对话顶栏原有的开关、「⋯」里那一项或 Esc，不另放 ×。
  - 只有图标的按钮，鼠标一停就出名字（自己的提示条，约 150ms，不用浏览器 `title` 那种要等一秒的），读屏念同一个名字。同一个动作在顶栏和它的菜单里只出现一次：「⋯」打开的菜单里不能再出现「+」和「⋯」。
- **Workspace 首页与「+」**（You 10-10 16:1x 定稿，细则见 F322 旅程⑦「⑦ 定稿」）：
  - 首页三段：正在发生（所有对话里在跑的全部露出来，不设上限）/ 状态与会话（这条对话一行）/ 作品（最新一件给图，其余最多两行）；状态与会话、作品有「全部 ›」开完整版，作品的「全部」就是对话顶栏「作品 N」那个列表。
  - **正在发生每一件照 10-06 定的写法，不压成一行**（10-12 更正。You 15:45 PDT（`[thread-id]#private-source-id`）：「这里没有 all 的按钮才对」「原本可以点击回到那个 thread，能看到完整的 thread 名字，能点击 stop……当时还能看是在托管还是在真的回复，现在点击进去是轨迹」；10-06 原规则见主页北极星 README「10-06 用了真页面以后改的两处」。10-10 的 v3 稿把这几条压掉了，是宪宪改稿时丢了已定规则）：
    - 第一行：头像 · 猫名（和名牌同一个名字）· 在干什么（回复中 / 托管命令，和执行行同一个说法）· 跑了多久；第二行：对话标题，最多两行，不截成一行。当前这条对话写「当前对话」。
    - 整行点了回到那条对话，落在它的执行行。看轨迹是行尾的「›」，不是整行的点击目标。
    - 行尾一个小方块「停止」图标，停上去提示「停止」，确认照旧。
    - 正在发生**没有「全部 ›」**：所有在跑的都已经在这里。等待与接回有事时接在下面，没有就不出。
    - **按项目分组**（2026-10-16，You 请设计线定、小太阳 6.1 实现，`[thread-id]#private-source-id`；稿与规则 `docs/evidence/2026-10-16-f322-live-by-project/`）：读你看得见的所有项目。在跑的分属两个以上项目，或者只有一个、但不是当前项目时，才出项目标题；全在当前项目里就和原来一样。标题一行：▾/▸ · 文件夹图标 · 项目名（侧栏同一套写法，无项目写「未分类」，重名带上一级目录）· 当前项目后面跟「· 当前项目」，右边「N 件」。当前项目排第一，其余按最早开始的那件排，「未分类」最后。**默认全部展开**，收起由你点、按项目记住、持久保存；收起后标题照样写头像、「N 件在跑 · 最长 mm:ss」，不是少算，也不放「全部停止」。每一件的写法不变。默认不收起别的项目，因为那会违反「全部露出来」。
    - **首页一种画风**（2026-10-16，You 看稿：「新的改法有好处……大体上是满意的」，只嫌「状态与会话跟后面的作品淹没在茫茫的全都是字」；加了段头记号和「这条对话」分隔后，20:13 PDT「我觉得OK了」，`[thread-id]#private-source-id`；`[thread-id]#private-source-id`；起因 `…private-source-id` 说正在发生、等待与接回、状态与会话三种画风；稿 `docs/evidence/2026-10-16-f322-live-by-project/shots/home-fold2-1440.png`）：首页每一段都用「正在发生」那一种行：第一行头像 · 名牌名 · 状态点和短状态 · 时长，第二行是哪件事（最多两行），右边「›」，能停的才有 ■；整行点了打开对话；不套边框卡片，行里不放描边按钮。段头一个格式：记号 + 标题 + 范围 + 右边「全部 ›」（有才放）。记号是：正在发生绿点、等待与接回琥珀点、状态与会话一个活动线小图标、作品用对话顶栏「作品」同一个图标。「正在发生」「等待与接回」是所有对话的；它们下面画一条深一点的分隔线，接一行小字「这条对话 「对话名」」，再往下是「状态与会话」和「作品」（这两段的范围就不再写「这条对话」，作品写「840 件」）。**等待与接回**：每件写「名牌名 · 等正式环境更新 · 23 小时 / 任务名 ›」，猫名用名牌写法；「›」展开「接回后」，平时不铺开；整行点了打开对话（取代上面 10-15 那条「后面跟『打开对话』」）。只是在等正式环境更新的，默认收成一行「▸ 头像 · N 件在等正式环境更新 · 最久 23 小时」，点开逐件列出；等别的东西的照常一件一行露在外面。段尾那句「main 上已有新版本……」保留。跨项目时按项目分组，同正在发生。**状态与会话**：同一种行「宪宪 · 处理中 · 1:34 / 第 7 段会话 ›」，不再是带框的胶囊按钮。作品的样子不动，段的顺序不动。
    - **执行详情原地展开，不另起卡片**（2026-10-21，You 发现双击聊天底部的执行行能看后台任务：「画风不太和谐，但是好用」，`[thread-id]#private-source-id`；按上一条「首页一种画风」）：双击执行行，Workspace 首页滚到「正在发生」里这只猫的那一行，短暂高亮并在行下原地展开：命令（等宽小字，一行放不下就截断、悬停看全文）、已跑多久、「输出与执行记录 ›」；停止仍是行尾那个 ■，收起用文字「收起」。不在首页顶上另放带粗边框的「Execution details」卡片，不用描边大按钮「Close details / Stop task」。
    - **跳回正在跑的那条消息要停得住**：双击执行行定位到原消息后，暂停「贴底自动滚动」，直到人自己滚回最底或点「回到最新」；不能跳过去又被新输出拉回最下面（You 同条：「有的时候会跳转过去然后又跳转到最下面，在人看来就是没跳转成功，快速闪了一下」）。
    - **等待与接回写人话**（10-15，正式环境走查时看到 7 件都用红字写「运行状态信息不足」，下面整段铺开猫写给自己的接回指令）：每件一行写等什么、等了多久、是谁的，后面跟「打开对话」。等新版本时写「等正式环境更新到包含这次修复」；没法确认就写「还没确认正式环境已包含」。这是正常的等待，不用红字，也不写「运行状态信息不足」。猫写给自己的「接回后」收进点开以后再看，默认不铺开。同一个新版本能放行几件，就在段尾写一句「main 上已有新版本，正式环境更新后这 N 件会接回」。
    - **你不在时**（**2026-10-26 暂停，不按这条实现**：You 看了信箱版对比稿说冗余，并指出「你没有办法判断出我到底是不是离开了……你们这群猫还是会用我电脑的屏幕去测东西」，`[thread-id]#private-source-id`；靠判断人在不在的设计站不住，等重新想清楚再定。下面是 10-15 的原文，留作历史。）（旅程⑤，2026-10-15 You 看稿定，`[thread-id]#private-source-id` 到 `…000121-f7052374`；稿 `docs/evidence/2026-10-12-f322-journey5-return/` r7 和规则 1–10）：
      - 放在首页最上面、「正在发生」上面。侧栏不贴东西，也不换成别的列表。
      - 只在你离开 30 分钟以上、回来时有「要你处理」或「有结果」才出现。分两段：要你处理（和待办同一份，右上「在待办里处理 ›」）、有结果（回了你的话、合入的 PR、交出的作品，一件一行，点了落到那条消息）。在等更新的指向下面的「等待与接回」，只有进展的收成一句。
      - 和首页另外两段按时间分：你不在时 = 已经交到你手上的；正在发生 = 这一刻还在跑的；等待与接回 = 停着等条件的。
      - 「不在」按人算，不按标签页：所有页面里任何一处有人动手都算在，开着不动的标签页不算；猫操作的浏览器不算。
      - 不加新红点；只有「要你处理」会来叫你，其余攒到你回来。
      - 结清：点「看完收起」，或者里面每件都处理过、看过。没看完又走开，下次回来还是这一张，从最早那次离开算起，接着加新的，不叠两张。
    - **正在发生只在首页，不单独开成标签**（10-14。You 在 F325 对话里看到单开的「正在发生」标签，以为首页坏了、少了「状态与会话」和「作品」：「正常的 workspace 图2 有个 thread 的竟然图1 这样 没 sessions 没 works」）。首页已经把在跑的全列出来，单开一个标签只会多出一张标题和内容都一样、却缺了下面两段的「假首页」。所以「+」和首页工具清单里不列「正在发生」；已经开着的旧「正在发生」标签，再点就回到首页并关掉自己。
    - 旧的「待办」Workspace 标签同理（10-15 走查发现它还会打开旧页「NEEDS ME」）：待办只有窄栏小信箱一个入口，旧标签点了就打开小信箱并关掉自己。
    - v2 的任何入口都不能连到 v1 的页面。
  - **作品只算交到这条对话的东西**（10-12 宪宪以 F232 负责人身份定，回应 Sol6.1 的口径问题）：消息里明确发出的图、文档、视频、可看的页面，以及挂在这条对话上的 PR，算作品；同一个来源发了几次，算一件、多几版。只被猫改过、没在消息里交出来的文件不算作品，去「代码 › 变更」里看。首页和「全部作品」用同一份计数，经典界面不动。
  - **作品页**（Workspace「作品」标签；2026-10-16 You 嫌原页「太丑了」，看了重画稿说「验收通过」，`[thread-id]#private-source-id`；稿 `docs/evidence/2026-10-16-f322-works-redo/shots/works-1440.png`，底子是 10-10 v3 的作品稿）：标题行「作品 · N 件 · 最新在前」，右边一个 28px 小分段「这条对话 | 所有对话」；下面一行 32px：搜索框 + 「全部类型 ⌄」下拉（只列有作品的类型并带件数，0 件的不出现），不铺胶囊墙。卡片两列（窄于约 360px 一列）、一样高：上面 16:10 缩略图（截图从顶部裁），下面标题最多两行（13.5px 半粗），再一行「谁 · 第 N 版 · 时间」，最右一个小「↗」= 在原对话打开（悬停提示）；「⋯」悬停时出现在缩略图右上；卡外不再挂「在原对话打开」一行。没有图的作品也有封面（2026-10-26，You 看了 Claude app 改版后问作品集能学什么，看稿说「我觉得很棒！」，`[thread-id]#private-source-id`；稿 `docs/evidence/2026-10-26-f322-works-typed-covers/`，数值照那份 README）：按类型给比纸面暗一级的浅色底（文档蓝、版面黄、语音青、代码与 PR 暖近中性），上面放一张纸、一个版面或一页幻灯片，能放真实内容就放（md 开头几行、PR 的 `#编号` 和仓库）；视频先用作品登记的封面图，没有才取一帧真实画面（不取片头），左下写「▶ 时长」。封面左下一枚类型角标，PDF / PPT / Word / Excel 用聊天文件标签同一套色标。图片作品不加角标。标题照样在下面。聊天里的作品卡用同一个封面（见「作品卡片与动作回执」）。往下滚自动接着加载。
  - **同一份内容，入口都是投影**（2026-10-27，You 要求把文件卡、作品卡、预览的分叉归一：「他们得是一份的投影不能每来一个都新造一个」，授权原文 `[thread-id]#private-source-id`；执行方案 `docs/plans/2026-10-27-f309-one-content-viewer.md`）：路径标签、文件树、搜索、聊天附件、作品页、首页和猫导航都交给同一个内容目标解析、类型判断、查看器和文件操作。文件卡显示名称/类型/大小，作品卡增加版本/作者/封面，预览显示同一内容的缩略或加载中状态；各入口不另定义身份、类型、打开方式或菜单。文本、代码和网页用同一 Workspace 常驻标签；图片视频沿下方浮窗→作品模式→整窗。Office 与其他不能直接预览的文件用同源信息呈现和文件操作；已有协作编辑器从明确动作进入，不按来自聊天还是文件树决定是否导入。
    - 文档标签下只留一排工具栏。来源/目录、大小、只读原因在左，源码/渲染、实际具备的编辑/听读和「⋯」在右；“返回原消息”合在这一排，不给副本另造两排查看器。“只读”是灰色状态，悬停说明原因，不摆不可用的编辑按钮。经典界面可保留外观，动作仍消费同一实现。
    - 「⋯」、右键和卡片菜单共用一份适用动作；卡片省去只在打开后有意义的选区/当前帧等项。文本右键放在标签或文件名，正文保留原生选区复制、粘贴与引用；图片视频右键在作品上。复制内容/图片/当前帧按类型变化，完整文件名可复制；默认应用显示系统实际应用名，取不到不编造。
    - 文件操作指向**正在看的这一份**。只读副本也有本机路径、Finder、默认应用和下载，服务端确认本机文件后即可提供，不依赖原稿写权限；远程对象不出本机动作，复制路径换为复制链接。有权威登记的原稿关联才另给“打开原稿”，无关联不显示。同名、大小或哈希相同均不授予原稿身份或写权限；发布副本的外部编辑不自动写成新作品版本。读取、批注、编辑/采用的权限仍分别来自原 owner。
  - 「+」是用完就关的小浮层：搜索 → 最近打开 → 按「活动 / 代码 / 其他」列 Workspace 的全部工具（和首页工具清单同一份）→ 一行写旧入口去了哪。不把已经迁去待办、对话顶栏、设置与管理的入口放回来。
  - **点开作品是正中一个悬浮大窗，和 ChatGPT 一样**（2026-10-15 You 看了悬浮窗稿 `docs/evidence/2026-10-15-f309-video-viewer/shots/lb-image-1440.jpg`、`lb-video-1440.jpg` 说「这里这个是对的」，`[thread-id]#private-source-id`；09-30 那两张整窗稿是 Workspace 放到最大的样子，不是这个。起因，You：「我点击你们的图片就能打开一个大图的悬浮窗 现在咋改没了」「你回顾我们最早说的 chatgpt 的和你共创图片的体验」；09-30 他定过「保持和 chatgpt 一个体验就好」，10-10 说过「点开在屏幕中间浮起一个大图，带 ×，不是 Workspace 整窗」）：聊天里、作品列表、首页点一张图或一段视频，屏幕压暗，正中浮起作品，整张看全、尽量大；四角几个小按钮：名字和版本、对比、「作品模式」、下载、⋯、✕。作品下面一条输入，就是这条对话的输入框（同一份草稿），圈选、画笔（视频是选时间段、圈这一帧）和发送都在这一条里，圈的地方以编号标签挂在上面，发出去就到这条对话，猫在聊天里回话。✕ 或 Esc 回到聊天原来的位置。要细改、比新旧时，点右上「作品模式」，直接进作品模式（见下「作品模式」：对话列表收起，聊天收成左边一栏，作品占其余；左上 ← 回聊天原来的位置），在作品模式里点右上 ⤢ 是整窗。这条路是「浮窗 → 作品模式 → 整窗」，中间不经过右边 Workspace 的窄栏（You 2026-10-15「是ok的」，`[thread-id]#private-source-id`）。不管 PNG、JPG 还是别的常见图片格式，点开都是同一个浮窗，不按格式分成两种行为。不另放一个只能看、要再点「批注」才能圈的大图；也不在点开时直接跳进右边 Workspace。同一个文件（如 md）只有一套看法，批注就在那一页里做。
  - **打开作品后：一排顶栏 + 常用文件操作**（2026-10-17，You：「我没办法复制到他的 path，也没办法快速的 open finder……还有哪些常用的功能被我们阉割了……上面的栏透明的好像也有点问题」，`[thread-id]#private-source-id`；看稿后「这点 ok，可以让 f309 开始开发了」，`[thread-id]#private-source-id`；稿 `docs/evidence/2026-10-17-f309-artwork-actions/`）：浮窗顶上**只有一排**：左边作品名 +「第 N 版 · 当前 ⌄」（下拉切版本），右边「作品模式 / 下载 / ⋯ / ✕」；背后压暗到读不出原页面（约 90%），不再透出原页面顶栏；浮窗里不放「‹ 聊天」（✕ 就是回聊天），图上不再套「修改记录 / 39% / ⋯」第二排。**「⋯」和在作品上点右键是同一个菜单**：先是文件操作「在 Finder 中显示 / 用默认应用打开（右边写应用名）/ 复制路径 / 复制图片（视频「复制当前帧」，⌘C）/ 在新标签页打开」，再是作品操作「在聊天里讨论整张图（视频「整段视频」）/ 修改记录 / 实际大小 · 适合窗口」，最底一块信息：文件名、尺寸 · 格式 · 大小 · 谁做的 · 时间、完整路径（等宽字，家目录写 `~`，点了复制）。复制后顶上提示「已复制路径」等一句，自己消失。作品不在这台电脑上或远程打开时，不出 Finder 和默认应用，「复制路径」换成「复制链接」。菜单跟界面语言走，中文界面不出英文。作品模式顶栏的「⋯」和右键用同一个菜单。
  - **视频要能真全屏，本机视频一定能「在 Finder 中显示 / 用默认应用打开」**（2026-10-19，You：「在视频模式的时候 没有真的能全屏看视频的模式！……那个全屏也不知真全屏 也没有快捷finder然后打开播放器？」，`[thread-id]#private-source-id`；看了改法后「我们就按照你这个来～」，`[thread-id]#private-source-id`）：视频控制条最右加「全屏播放」（悬停写「全屏播放 · F」），按 F 或双击画面也进；进的是**整个屏幕**（浏览器全屏），不是铺满猫咖窗口的「整窗」。全屏时只留看片用的：播放 / 暂停、进度条、时间、音量、倍速、退出全屏；圈选和画笔先收起，已选的时间段仍标在进度条上。Esc 或再点一次回到进来前的样子（浮窗、作品模式或整窗），播放位置不变。「全屏」这个词只给真全屏用；⤢ 照旧叫「整窗」。顶栏不加按钮：「在 Finder 中显示 / 用默认应用打开」照旧在「⋯」和右键菜单里，但**凡是这台电脑上的视频都要出现**，不分它是从聊天附件、作品、发布还是审阅打开的；只有远程打开或文件不在本机时才不出。
  - **一组图：翻页，几张图各圈几处再一起发**（2026-10-18，You：「这个变大之后我想换成下一页好像也没办法……没办法支持我图 1 怎么样批注然后图 2 怎么样批注然后一起发出去」，`[thread-id]#private-source-id`；看稿后「可以！我喜欢！……快速安排上！我很需要！」，`[thread-id]#private-source-id`；稿 `docs/evidence/2026-10-18-f309-gallery-annotate/`）：从同一条消息里的几张图（图组、几个附件、几件作品）点开任意一张，浮窗认这一组：顶上名字后写「4 / 5」，图左右各一个圆形箭头，键盘 ← →、触控板左右滑也能翻，到最后一张不绕回；图下是这张原来的说明，再下面一排缩略图，当前加白框，圈过的右上角写圈了几处，点了直接跳。第一版不跨消息、不跨对话翻。圈选和画笔照旧，**编号跨图连续**（①② 在图 1，③ 在图 4），圈完旁边弹小框写这一处想说的（可不写，回车记下、Esc 取消）；输入框上沿标签写缩略图 · 编号 · 图几 · 这一处的话，点了跳到那张图亮出那一块，× 删掉。**草稿只有一份**，翻页、关浮窗回聊天、刷新都在；发送旁写「2 张图 · 3 处 · 发到这条对话」。发出去是**一条消息**：话在气泡里，下面一张卡按图分组，每张一行（带编号框的缩略图、图几和文件名、这几处的话），点任何一处在浮窗里打开那张图亮出那一块。猫收到每张图的原件和当时的版本、每块位置、每处的话，不是拼起来的截图；按编号回话，新版本挂回原作品。一组里有视频时，「选时间段 / 圈这一帧」和图片编号连着排；进作品模式还是同一组、同一份草稿，顶栏也写「4 / 5」。
  - **聊天里文字批注的编号点不能浮到作品上**（2026-10-16，You：「在 chat 里 comments 的红点在到处乱飞」，`[thread-id]#private-source-id`；小太阳查清：引用文字的编号点按原文的屏幕位置画在整页最上层，原文被打开的图片盖住时不藏，`[thread-id]#private-source-id`）：编号点只跟着它的原文出现——原文在聊天里看得见才显示，滚出去、或被浮窗 / 作品模式 / 右栏盖住就藏起来；聊天布局或宽度变了跟着原文重算位置。浮窗、作品模式、整窗都在这些编号点上面。关掉作品回到聊天，草稿和编号原样还在。作品自己的圈选标记只画在作品上，按作品的坐标。

### 导航
- `top-bar`：52px、工作面底（`{colors.surface-1}`）、底部一条发丝线，标题 14px/500。不放品牌色。
- `sidebar`：外框（`{colors.surface-2}`）。Café 标题只写世界名，去掉切换世界的 ⌄；共同体标题若保留 ⌄，只打开当前世界自己的菜单，世界名单仍只从窄栏末尾的"…"打开。Café 的导航行是新对话、全部作品、记忆（§0.5），32px、14px 字；选中项垫 `{colors.surface-3}`。对话行规则见"对话列表"。
- **「对话设置」只有一个**（2026-10-25，F332 线画守望猫入口时发现两个面板都叫「对话设置」，`[thread-id]#private-source-id`）：对话顶栏的「⋯」（悬停「对话设置」）和侧栏对话行「…」里的「对话设置」打开**同一块**面板（`ThreadSettingsPanel`），不再有只装置顶和关联 Feature 的小面板（10-08 #5256 随 v2 新对话页带进来的，没定过）。面板从上到下三组：这条对话要做什么（对话目标、守望猫）→ 谁来、怎么跑（默认猫猫、思考档位、速度档位、运行状态）→ 整理（标签、关联 Feature）。「置顶」只在侧栏对话行的「…」里，它管的是这条对话在列表里的位置，不在面板里再放一份。
- 对话右边的跳转用琴键（主页北极星 §1.7，2026-10-08 随聊天整屏认可）：一条消息一根键，长短按它实际占的高度，颜色按说话的猫（人是灰色），框住当前看到的一段；聊天栏给它让出位置，不压正文。不用 v1 的圆点。
- 查找只有一份（2026-10-23 You：「一定要记得要归一，就是不能出现同样一个能力我们写两份的这种事情」，`[thread-id]#private-source-id`）：对话顶栏现有的「查找」弹框就是唯一的查找入口和实现。旅程⑥「找回以前的」（定下来的那一行、已定 / 没采用标签、原地展开前后文、去原处并能回来、引用到聊天）都加在这个弹框里，不另开一页、不在 Workspace 再做一个查找标签，搜索后端也只用现有的 `/api/evidence/search`，新加的只有给结果打标签的「已定表 → 出处消息」索引。问猫和猫猫球回答时给的是同一份结果。以后别的地方要搜对话，就打开这个弹框，不再写一份。稿
- 返回（2026-10-03）：进了下一层（打开一个文件、看一轮的详情），返回键写上一层的名字（「‹ 文件」「‹ 搜索结果」「‹ 变更」），不写光秃秃的"返回"；从哪进来就回哪，回去后列表还是原来展开和滚动的位置。

### 世界栏与全局入口
- `world-rail`：52px，外框色。上面只放世界（最上面是品牌标记 = 我的 Café；每个共同体一个线框字标，有注册头像时用头像）和"加入"，世界多了在末尾放"…"；下面是小信箱（待办）、前台猫、头像（进"设置与管理"）。用户自己从设置与管理钉上来的快捷入口放在小信箱上方、用发丝线隔开，默认没有；演示浮窗开关只在有浮窗时出现。不用色块、不描边圈、不在格子下塞小字；选中只垫 `{colors.surface-3}`。
- 世界的名字：桌面上停留或键盘聚焦时提示，当前世界名写在侧栏标题；"全部世界"名单只从世界栏末尾的"…"打开（世界多时出现，键盘可达）；手机上常显。读不到的世界照样占位并说明原因（读取中 / 服务连不上 / 需要重新登录 / 当前账号没有访问资格），不当作"没有"，不悄悄跳到别的世界。
- **从 Café 进共同体**（候选，2026-10-26，待 You 看图；稿和全部规则见北极星 README「10-26 从 Café 进共同体」）：
  - 点共同体的入口直接进去，没有「进入哪个？」选择页。同一个共同体经几个连接都能到，也只算一个入口。地址、端口、编号只放在家里「设置与管理」的共同体连接里。
  - 共同体侧栏标题下面一行，写你在这个共同体里叫什么。停上去看用哪个账号登录，可以换账号。
  - 频道输入框空着时写「发到 # 频道 · {共同体}的成员都看得到」。有了仅受邀的频道后，频道名前加锁，写人数。
  - 草稿属于你和那一处，换世界不带走。
  - 界面上统一叫「共同体」，不叫「共同家园」。
- 全局入口：待办只有窄栏的小信箱一个入口，侧栏和头像里都不放，名字靠它的悬停提示和读屏标签；头像点开直接进"设置与管理"，不弹菜单（§0.5，2026-09-29 You 拍板）。
- **尚未通过、待同屏实物验收**：不悬停、不被提示时，人能不能认出小信箱（待办）、前台猫和头像（设置与管理）；有事项或读不到时能不能看懂是哪一种（F322 AC-A1 / B5 / J3）。第 1 段第一份能操作的外壳出来就试；认不出就在原入口加短标签，不另加入口（主页北极星 README 1.6 节）。前台猫入口按它自己的配置状态（configLoaded / enabled / muted，`ConciergeRailToggle`）显示，不一律出现"叫回前台猫"。

### 图标与悬停提示
- 三个入口有自己的图形，每个概念只有一个图形，同一概念的所有入口共用。产品里的唯一定义在 `packages/web/src/components/shell/ShellIcons.tsx`，新入口直接引用它，不复制 SVG、不另画；下面的设计稿链接只说明来源：
  - 作品：两张错开叠着的卡片，`WorksIcon`（来源：主页北极星稿 里的 `i-works`）。侧栏"全部作品"和对话顶栏"作品 N"共用。
  - 记忆：摊开的书上一颗星，`MemoryBookStarIcon`，路径在 `memory-book-star-path.ts`，填色、跟随文字颜色（来源：memory-D.svg）。侧栏记忆和 Workspace 里的记忆共用。
  - 猫猫球：布偶本人，`CatBallImage`，引用 `packages/web/public/shell/catball-E-28px.png` 与 `@2x`，窄栏 28px（来源：catball-E）。它是带色的角色图，不随文字颜色变。
  - 毛线球：对话顶栏写「毛线球 N」，点开的面板写「这条对话的毛线球 · N 颗没完成」，Workspace 标签也写「毛线球」；英文界面仍写「Tasks」。2026-10-26 You：「是不是应该直接叫毛线球啊？因为一直都是在叫毛线球，而且我们的宣传片很多东西也都是一颗毛线球串起来的。然后我们的也叫传球。」（`[thread-id]#private-source-id`）。09-29 主页北极星里写的「任务 N」作废。图形从宣传片里那颗毛线球缩出来（`cat-cafe-films/promo-kit/ball.mjs`），三版候选见 `docs/evidence/2026-10-26-f322-undrawn/shots/yarn-icons.png`，**You 选 C「片子原色」**（`[thread-id]#private-source-id`）：赤陶色小球，和猫猫球一样是带色图形、不随文字变色；原件 `docs/evidence/2026-10-26-f322-undrawn/art/yarn-C.svg`，落地照原件放进 `ShellIcons.tsx`，不另画。
- 别的猫画好、经 You 选定的图形，落地时用原件（导出或机器描摹），不照着重画一版（You 2026-09-30）。
- **品牌标志**（You 2026-10-09 02:13 PDT，`[thread-id]#private-source-id`）：整体商标换成 meow-club 与 [clowder-ai 网站](https://zts212653.github.io/clowder-ai/) 现在用的三猫剪影，赤陶色。原件是 `site/assets/logo-transparent.png`（1254px，和网站上的同一份）。原来的海豚加三猫线稿退役，包括 `assets/icons/cat-cafe-logo-*.svg`、`packages/web/public/icons/favicon.svg`、`components/icons/CatCafeLogo.tsx` 里那份；**文件保留，不删**。
  - 要换的地方：浏览器标签图标；PWA 和桌面图标（`icons/icon-192x192.png`、`icon-512x512.png`、`apple-touch-icon.png`，现在是另一张躺在紫色垫子上的布偶插画，一起换掉）；新版窄栏「我的 Café」；README。经典界面按 v1 冻结不动，它跟着 v1 一起退役。
  - 小尺寸：直接用原件，不另做简化版。我 10-09 拿原件缩小时担心 16～24px 会糊，You 纠正：clowder-ai 网站的浏览器标签图标用的就是这张，实际看得出来（`…private-source-id`）。要清晰就用原件机器描摹成 SVG，不照着重画。
- 反过来，一个图形也只表示一件事（主页北极星 §1.13，2026-10-03）：⤢ 只表示整窗（和作品一致）；放大 / 还原用加宽图标，专注用四个角，弹出成浮窗用画中画图标。以前同一个 ⤢ 在三处表示三件事。两个人的图形只表示共同体（窄栏顶上那一格）；「猫猫团队」「成员与运行时」和钉到窄栏上的成员入口用爪印（lucide `paw-print`）。2026-10-24 You 看到窄栏底部钉着的「成员」和顶上的共同体是同一个两个人，分不清（`[thread-id]#private-source-id`）。
- `tooltip`：图标入口的名字提示，墨色小条、白字、28px 高。悬停约 150ms 出现；已经显示过一个以后，移到相邻入口不重新等；键盘聚焦立刻出现。不用浏览器原生 `title`（要等一秒左右才出，You 2026-09-30 指出）。产品里只有一个实现：`packages/web/src/components/AppTooltip.tsx`，新入口直接用它，不另写一份。提示只是辅助：全局入口仍要有默认看得见的名字，有提示不算"默认看得出"。
- **被截成省略号的字，鼠标停上去都要能看到全文**（You 2026-10-06，`[thread-id]#private-source-id`）：猫名、对话标题、文件名、标签名、命令参数，凡是放不下被截掉的，停上去用同一个 `tooltip` 出完整的字，键盘聚焦也出；没被截的不出提示。省略号仍是最后一招：先让字拿宽度（按钮收成图标、文字可以占两行），放不下才截。
- **路过不打扰：看得见的内容不挂悬停卡**（You 2026-10-08 19:49 PDT，`[thread-id]#private-source-id`：「我只是路过这里……我甚至想点被 hover 盖住的东西」）。上面的 150ms 和「相邻不再等」只给图标入口，因为不看提示就不知道它是什么。对话列表的一行、名牌、链接，内容本来就看得见，鼠标多半只是路过；在这里弹卡片，会接连盖住你正要点的下一行。
  - 对话行不挂「参与 / 路径 / 时间」卡：猫和时间行里已经有，路径放进「…」里的对话设置；标题被截断时才按上一条出全文。
  - 真要给看得见的内容补一句：停稳 600ms 以上才出，扫过不出，也不参与「相邻不再等」的连发。
  - 提示不挡鼠标要去的地方：列表里的提示出在侧栏外侧（这一行的右边），不往下盖住下一行；放不下再换边。
  - 提示不接鼠标（`pointer-events: none`）：鼠标离开触发它的东西就立刻收起，点下去点到的是底下那一行。需要在里面点东西的，用浮层（popover），不叫提示。

### 桌面浮层
猫猫球在桌面上弹出的名牌、通话条、面板和字幕卡。它们压在别人的窗口和壁纸上，除了页面浮层的做法，还要守下面几条。定稿与每条的来由见桌面猫北极星。
- `desktop-overlay`：不透明纸面（`{colors.canvas}`）+ 1px `{colors.hairline-strong}` + 浮层小阴影，12px 圆角。不做毛玻璃、不做半透明：壁纸和视频会透上来，字读不清。
- 名牌：墨色小条白字（长相同 `tooltip`），外加一圈 1px 浅色描边，在深色壁纸和全屏视频上也分得出边。没事时不挂名牌；挂的时候只写当前确知的一件事。
- 尺寸：面板宽 120–420、高 32–500（桌面宿主的合同）。内容放不下就减行或折叠，控件不能被面板边缘裁掉；出稿和实现都要量到里面的按钮，不只量外框。
- 位置：面板默认贴在猫的一侧、往屏幕内侧展开。全屏或贴边时，猫、名牌、面板整块上抬，不盖住底部的控制条和字幕；不用"收起"代替挪开。这是摆放目标：自动识别外部控件还不是现有能力，由桌面宿主补。
- 通话条在通话期间常驻；打开面板时它收进面板顶部，不叠两层。
- **通话状态点要「呼吸」**（2026-10-12 You 选 B，`[thread-id]#private-source-id`；他的理由：「这个绿点最好是闪烁的！！他才是真的像通话」「产品心智是不是还是得贴近用户的心智」）：静止的绿点在大家习惯里是「在线」，看不出线是通的。通话中：8px 绿点本身不变，外面一圈同色光环约 2 秒一次从 1 倍扩到约 3 倍并淡出（ease-out）；不做一亮一灭的硬闪，那是告警 / 录音的意思，通话一开很久，余光里会一直扯眼睛（「在进行的只动、不抢」）。恢复中：琥珀色点，同样呼吸；已断开：灰色点，静止。系统「减少动态」时一律静止。三种对照见同一消息上方的小样（A 静止 / B 呼吸 / C 闪烁）。
- 状态文字只写数据来源能证明的事（"正在思考""正在处理""正在查看共享画面"），不写推断出来的说法。视图名用 `badge-status`。
- 字幕卡：猫说的话和译文用 `{typography.title-md}`，听到的原声用 `{typography.body-sm}` muted；靠字号和颜色区分，不逐行加标签。
- 窄到放不下文字按钮时，次要按钮收成 28px 图标按钮（带提示和读屏名），不裁字；`button-destructive` 保留文字。
- 图标按钮画的是当前状态（麦克风开着就画不划线的麦克风），点了再切换；旁边的状态文字和图标不能说两样。
- 设置放在猫身边的面板里。会结束通话的设置更改（如更换陪伴者、调整资料访问权限）先说明后果并确认，由宿主先结束当前通话、再改设置；通话条的挂断仍直接执行，不加确认页。保存成功不等于当场生效：下次通话才生效的设置要写出来（如人设基调）。保存失败、结果还没确认、通话已结束但设置未保存是三种不同的结果，分开写。

### 对话列表
- **对话组：整理时一眼找到组；猫提议新对话时建议放哪个组，你批的时候定**（2026-10-23，You：「我这边搜这个F329，它还下拉框这边一大堆的选项，我每次都要找半天」，`[thread-id]#private-source-id`；看稿「对话组，我觉得OK，这个挺好的……改成你这个V2的样式」，`…private-source-id`；稿 `docs/evidence/2026-10-23-thread-group-placement/`；组的出生与成员规则见 F277「Conversation Group Boundary」）：
  - 整理 Group 的「整理到」是可搜索的列表：搜索词对得上组名的排第一并已选好，其后最近用过的组，「新建 Group」放最后；顶上写「匹配 N 条 · 其中 M 条已在 ××」，按钮写清「把另外 K 条加入 ××」。
  - 组仍只由你的明确操作决定。猫提议新对话时卡上多一行「放进 Group ⌄」：发起的对话在哪个组就建议哪个；不在组里时，标题里的 F 号对上某个组名就建议它；都没有写「不放进组」；旁边灰字写建议理由。你点「同意」才生效，可以换组或选「不放进组」。
2026-10-08 按新旧对比后的合版重写（You「thread 栏的 ok」，`[thread-id]#private-source-id`；画面见主页北极星 §1.21、§1.23）。之前 10-06 的版本：You 说经典界面那排有颜色的猫加会动的小猫更好看，又说两边结合（`…private-source-id`、`…private-source-id`）。
- **字号一致**：组名和对话标题都是 14px，组名 600、标题 400（有新消息或要你动手时标题也 600）。不能出现组比组里的对话还小。
- **标题最多两行**，时间在第一行右边（`{colors.muted}`）。
- **组是一整块，和外面的对话同一级**（2026-10-11 You 18:51 PDT 定，`[thread-id]#private-source-id`：「可以……我们 runtime 版本 group 和 thread 色块没区分，实在是让人太难看懂了」；稿 `docs/evidence/2026-10-11-f322-sidebar-groups/`。取代 10-08 的「组里的对话缩进一级，左边一条 1px 细线」）：
  - 第一级的东西都按「记号 + 文字」两列排：对话的记号是图钉，组的记号是组图标（文件夹样子的细线图标），都在最左那一列；对话标题和组名都在第二列。组不能比外面的对话多缩一格，否则看着像挂在上一条对话底下（You 10-11 07:58、18:47 两次指出）。
  - 每个组是一整块：很淡的底色，加一圈发丝细边，10px 圆角。底色要和「当前选中的那条对话」分得开，所以加细边，不能只靠底色。组和组、组和对话之间留一点空。
  - **组块比侧栏亮一档，选中的对话仍是最显眼的那一层**（宪宪 10-12 提，You 15:37 PDT 看三档对比图后定「中这个就能区分了」，`[thread-id]#private-source-id`；起因是他 15:33 说 group 和 thread 的颜色有点难分，又不想要 v1 那么大的色差）。实测 boot24 的组块是 rgb(240,236,228)，侧栏是 rgb(242,238,231)：只差两三级，眼睛看不出来，而且组块往「暗」的方向偏，和选中行是同一个方向。改成组块往亮的方向，像一张薄纸垫在侧栏上，浅色目标约 rgb(247,244,239)，暗色同样比侧栏亮一档；浅色里选中行照旧往暗，两者方向相反就不会混；暗色里选中行本来就是最亮的一层（10-12 Sol6.1 实测 frame [25,24,24] / 选中 [62,61,60]，小星星核了 token），组块只比侧栏亮一档、比选中行暗，选中行不动。细边保留，差别不靠加大色差。
  - **收起的组也露出要你看的那几条**（宪宪 10-12 定。You 16:21 PDT：「每个这个 group 很长我都是收起来的，我现在想看一条消息都是展开，选择，关闭……有的时候里面只有一条待我查看我也得这样选」，`[thread-id]#private-source-id`。成熟产品里 Discord 收起的分类同样会露出有未读的频道）：组收起时，组头下面列出这一组里要你看的对话，包括等你决定、@你、有新回复。每条一行：标题加一个标签（等你决定 / @你 / N 未读），按这个先后排，最多 3 条。**标签和对话行上同一件事长得一样，不另起一套**（10-12 宪宪对 #5453 合后 Alpha 补）：「@你」是对话行那个赭色实底小标签；「N 未读」是对话行那个浅赭底、深赭字的未读数，字也和对话行一样写「N 未读」（英文「N unread」），不另叫「N 条新」——同一条对话展开时写「5 未读」、收起时写「5 条新」，会被读成两件事；「等你决定」是琥珀圆点加状态字，字色用侧栏状态字那一档（琥珀往墨色压 25%），不铺赭色底，免得和未读看成一家，英文写「To decide」，不写「Decide」（单个动词读起来像按钮），多了写「还有 N 条 · 展开」。点一条直接进那条对话，组保持收起。新回复和 @你 看过就不再露；「等你决定」要等真的处理了（同意、拒绝、回答或在待办里忽略）才消失，只看一眼不算（旅程③：处理成功才算处理完，读过不等于处理完）。在干活、但不需要你的不露，头像那一行已经说了。组头右边写「N 条要看」，数的是要你看的对话，和露出来的条数对得上；没有要看的就不写数字，不出「0 条要看」。想完全收起的组，在组的「⋯」里关掉「收起时露出要我看的」（默认打开，按组记住）：关掉后收起就只剩组头，「N 条要看」照样写。待办里的「等你决定」不受影响，不会漏掉。（You 16:29 追问「那如果有人就是想完全收起来呢」；Slack 的分组也有「只显示未读 / 全部」这样的开关。）
  - 组里的对话缩进一级（约 20px）：图钉在组名下面那一列，标题再往里一格，第二行跟着一起缩。不画竖线，块的边就说明谁在组里。组末尾「其余 N 个对话」和组里的标题对齐，块的底边收圆。
  - 展开箭头放在组名后面，不放在组名前面。
  - **外层先找未读，组内保留最近**（You 10-13 对照 v1/v2 后认可，`[thread-id]#private-source-id`、`…private-source-id`；取代旧「内外同一规则」）：外层独立对话和整个组按置顶 → 执行中 → 未读 → 最近活跃排，执行中之间沿真实开始时间、同时间按对话 ID 稳定排序。组占组里最靠前成员的位置，不把一个成员的置顶和另一个成员的新时间拼成虚构排名。组里的对话保留 v2 置顶 → 最近活跃，同时间按 ID；显式手动、执行中优先偏好继续有效，不改保存的成员顺序。「其余 N 个对话」收起排在后面的。鼠标停在列表里时保留顺序和已显示行的空间，免得点开绿色已回复后下面一行跑走；未读和回复标记仍及时更新，移开后释放空间并按规则排，滚动位置沿实际显示的行保持。
- **置顶看得见、一下就能改**（You 10-09 18:53 PDT：「v1 那边原本直接点就能 pin 取消 pin，现在……我都不知道这些 thread 到底是 pin 还是没 pin 的，也没办法操作」）：置顶的对话在标题前一直显示实心的置顶钉（赭色，和组名旁的置顶记号同一个图标）。没置顶的，鼠标停在这一行或键盘聚焦时，同一个位置出现空心钉，点一下置顶；点实心钉取消。钉占固定位置，出现、消失都不推动标题。触屏上一直显示。「⋮」菜单里的置顶 / 取消置顶照旧保留。
  - **钉子跟着自己那一行走**（2026-10-11 You 18:30 PDT 改，`…private-source-id`：「那个置顶的图钉太前面了」）：外面对话的钉子在最左那一列；组里对话的钉子随缩进挪到组名下面那一列，不再全挤在最左一列。组被置顶时，在组图标右上角加一个小钉子，不另外占一格。下面这条 10-10 的规矩，「竖着对齐成一列」那部分由这条取代，其余照旧。
  - **组的钉子和对话的钉子放在同一个位置**（You 10-10 09:07 PDT：「后现代的不对称设计，group 的钉子后面，thread 的再前面」，`[thread-id]#private-source-id`）：都放在名字前面最左边那一格，对话行在标题前，组行在展开箭头和组名之前，竖着对齐成一列。组名后面不再放钉子。一个组「被置顶」和「组里有对话被置顶」是两回事：组名前的钉子只表示这一组被置顶；组里有没有置顶的对话，展开后看各行自己的钉子，收起时不在组名上另外标。
- **第二行只在有事时出现**：在干活 / 回过话的猫的头像（一圈它自己的颜色）+ 它的小名（用它的颜色写）+ 状态：执行中 = 蓝色会跑的小猫（ᓚᘏᗢ，系统设了减少动态时不动）+「执行中 · 21 分」；已回复 = 绿色的小猫（不跑）+ 小勾 +「已回复」（2026-10-09 You：「我们完成了可以是绿色的猫然后打钩吗」，照 v1，`…private-source-id`）；等你决定 = 琥珀点 +「等你决定」；出错 = 红点 +「出错」。可选「草稿」标记。
- **第二行固定一行，不折行**（2026-10-09 You 看 r2 对照稿后定，`[thread-id]#private-source-id`；稿子 `docs/evidence/2026-10-09-sidebar-attention/compare-r2.html`）：从左到右是头像 → 小名 → 小猫 → 「状态 · 时长」，位置固定；放不下时先让小名，再让状态字，时长不掉到下一行（侧栏太窄、让完还放不下时的例外见下）。时长超过 60 分钟写小时，超过 48 小时写天；不到 1 分钟写「刚开始」（英文 just now），不写「0 分」。
  - **小名要么写全，要么不写**（2026-10-09 runtime 真页面对稿补）：放不下整个小名时整段不写，只留头像，悬停或聚焦头像看全名；不能截成「小…」「GP…」，更不能截成没有省略号的一个「小」字。半个名字会被读成另一只猫（「看起来是什么，就得真是什么」）。来由：英文界面、组内缩进、右边有未读数时，侧栏实测小名只剩 10px。
  - **状态字也是要么写全，要么不写**（2026-10-10 宪宪对 runtime 真页面定，`[thread-id]#private-source-id`）：「执行中 · 21 分」「已回复」「出错」放不下时整段不写，只留小猫、小勾或圆点，悬停或聚焦看全文；不截成「执…」。中英文一样。来由：240 宽时中文剩一个「执…」，英文整段不见，两种语言不一致。
  - **让完还放不下，就把整样东西挪到下一行**（2026-10-10 宪宪定，问题和小稿见 `[thread-id]#private-source-id`）：头像、小猫（小勾、圆点）、草稿、@你、「N 未读」这几样不让：不藏、不缩小、不互相压住。它们一行放不下时，第二行拆开：头像和状态单独一行（宽度够了，小名和状态字照上两条重新判断）；草稿、@你、未读挪到下一行，照原顺序靠右；还放不下，就把放不下的那一项整个再挪一行，仍靠右。每多一行 20px，行间 4px。换不换行只看这几样，不看小名、状态字，也不随悬停变，免得来回跳。组收起时的第二行照同一条。
    - 什么时候发生（按 Sol6.1 实测尺寸算）：最挤的一种是组里一行同时有两只猫在干活、草稿、@你、「99+ 未读」。侧栏 300 宽时它也还是一行；默认 240 宽时拆成两行；拖到最窄 160 时拆成三行。代价是挤满的行变高。
    - 为什么不守一行：240 宽的组内第二行只有 183px，两个头像 +「@你」+「99+ 未读」就要 157px，再加小猫和草稿就超了；160 宽只剩 103px。守一行只能去掉「未读」两个字、小猫或一个头像，这几样都是 You 明确要的（「这里的红色数字到底代表啥」、跑动小猫不能去掉）。调高侧栏最窄值也没用，默认 240 就已放不下。一行是平常的样子，事实比行数要紧。r2 定「不折行」修的是状态和时长被挤得逐字折下去、换位置，那种折法仍然不许；这里挪的是整样东西，顺序和靠右都不变。
- **状态字用状态色**（同上，You：「replied running 之类的字的颜色」要改）：执行中蓝、已回复绿、等你决定琥珀、出错红；为了读得清，用状态色往墨色压 25% 的那一档，500 字重。实现取当前主题的状态色（`--semantic-*`）和墨色混，不写死色值；下面的色值按本文件 frontmatter 的色板算，只作参考：执行中 `#3f647f`、已回复 `#346942`、等你决定 `#835a1a`、出错 `#9a3938`，在侧栏底和选中底上对比度都在 5:1 以上。注意：runtime 的默认主题里，info 是 `oklch(0.55 0.12 210)`（偏青，约 `#008398`），不是 frontmatter 的 `#4d7fa3`，所以真页面上的「执行中」比稿子更青。两份色板不一致，已登记到 F322 复盘 §6，下一轮统一。小猫、小勾、圆点仍用原状态色。这一条取代 10-08「状态字是正文色或 muted，不用状态色写字」。
- **头像只画在干活或回过话的猫，不铺群成员**：一只就写它的小名；两只以上画两个头像，写第一只的小名再加「+N」，不再用顿号把小名连成一串。
- **右边的数字**：「@你」赭色实底小标签；未读数 `badge-primary`（浅赭底、深赭字、600），**数字后面带上它是什么：写「12 未读」（英文「12 unread」），不只写一个光秃秃的数字**（2026-10-09 18:31 PDT You 看着收起组上的「12」问：「这里的红色数字到底代表啥啊？是有猫在跑？还是猫跑完了？还是出错了？」，`[thread-id]#private-source-id`；颜色照 r2 不改）。几种信号并存，不挑一个盖掉其他（F297 AC-D6）。数字在第二行最右边对齐成一列，「@你」在前、未读在后；时间在第一行最右边。
- **组收起时也是两行**（2026-10-09）：第一行组名（置顶的组带置顶记号）；第二行在干活的猫的头像 +「N 只在干活」（蓝）+ 会跑的小猫。**组里没有猫在干活时，第二行左边不留空**：写组里最该你看的那种状态，按出错（红点「1 个出错」）→ 等你决定（琥珀点「1 个等你决定」）→ 已回复（绿猫加勾「2 个已回复」）的顺序取第一种；都没有就不出第二行。（10-12 起，原来挂在第二行右边的「@你」「N 未读」取消：要你看的对话按下面「收起的组也露出要你看的那几条」露出来，组头右边只写一个「N 条要看」，没有就不写。每条对话行自己的未读、@你标记不变。）和对话行同一个节奏，不再一高一矮。排序、＋、改名等管理动作收进组名的「…」菜单，不常驻；不像经典界面那样铺一排头像和几颗看不懂的小圆点，未读不做整块实心橙色。
- 不显示没有数据来源的消息预览或草稿内容。
- **列表头的两个菜单**（2026-10-08，§1.24，`?s=lt2`）：「分组」和「标签」用同一种菜单：纸面底、细边、12px 圆角、14px 字、32px 行高，选中行用选中底色加小勾。都从列表头左边展开，宽度不超过侧栏；侧栏拖窄菜单跟着窄，名字截断、悬停看全名。标签行前面的色点用标签自己的颜色，没设颜色画空心圈；不加分隔线。选了标签以后按钮写「标签 · feat ×」，× 清除，和「分组 置顶」一样用选中底色，不用赭色字加下划线。Esc 关闭。来由：v2 把「标签」按钮挪到「分组」旁边，菜单却还从按钮右边往左展开，左边约 26px 跑出侧栏被裁掉（You 10-08 01:15「这个太 bug 了」）；菜单中间那条空行是 v1「前 5 个平铺、其余收进更多」留下的分隔线。

### 作品卡片与动作回执
- `artifact-card`：聊天里的作品是一张卡片。图片直接给大预览（最宽 440px），底部一行名称、类型、版本和"打开"（常显，不只悬停）；文档给缩略纸面。点图本身是正中浮窗；点"打开"直接进作品模式（见下"作品模式"，2026-10-15）。
- **聊天里的作品卡和作品页是同一张卡**（2026-10-26，You 看 F331 七张交片卡：「图1 这个不如图2 或者说应该结合一下！展示的应该是你的视频的某一帧或者封面啥的」「我们的F326这样其实还是超级难用的感觉」，`[thread-id]#private-source-id`；封面跟 `docs/evidence/2026-10-26-f322-works-typed-covers/` 那一稿走，You 说那张卡也适合放进聊天）：猫交的作品（`cat_cafe_work` 的交片卡）和聊天里的视频、文件卡用作品页那一张卡：16:10 封面（视频是真实画面加「▶ 时长」），标题最多两行，底行「谁 · 第 N 版 · 时长或时间」。
  - **点开只有两条路，哪张卡都一样**：点封面进正中浮窗（和点聊天里的图一样，浮窗里有版本、作品模式、下载）；卡上的「打开」直接进作品模式，而且是真的作品模式（对话列表收起、聊天收成左边一栏、作品占其余），不开在右边窄栏。不再有「看这版 · 标意见」这种另起名字的按钮。
  - **卡上不铺这一版的整段说明**：说明写在猫的消息正文里；每一版改了什么在浮窗和作品模式的「第 N 版」下拉里看。这一版不是最新时，封面左上一枚「已有第 N 版」，点了看最新（不再另放「查看最新」按钮）。
  - **一条消息里几张作品卡排成两列**（窄时一列），和作品页同样高、同样间距，不一张张竖着铺满屏。
  - 同一件作品从哪张卡点进去都是同一件作品、同一本意见账：聊天里的文件卡如果指向已登记的作品，打开的就是那件作品，不另算一份。
- `action-receipt`：猫做过的事是一行回执（图标 + 动作 + 加粗对象，如"在 **Café 像素主视觉** 上批注了 2 处"），可点回原处；用户自己的动作回执靠右。回复、标为已解决、生成新版本是三件事，各自一条回执，不互相冒充。
- **叫云端猫（dot 等）的回执**（2026-10-14，You 看到卡片正文还写「等待 dot 读取」，下面却已经是 dot 的回复；他又去 ChatGPT 私聊里没找到，以为没收到）：只在 @ 它的那条消息下面放一行，跟着真实回执变：已发出（还没确认读到）→ dot 已读到这条消息 → 「dot 已在这条对话里回复 · 看回复 ↓」。每一步只写有证据的事：HTTP 确认不算「已收到」，读到不推断「正在回」，查不到或超时只留最后确认的状态和时间，不写「没收到」。点了跳到回复并亮定位环。发出时写死的文字不再当状态显示。出问题时同一行变琥珀色，写原因和能做的事（「去连接 dot ›」只在连不上时出现）。回复在哪边要写明（「在这条对话里」）；ChatGPT 那边不复制回复内容，也默认不发指路句（那也是跨端消息，只能由用户自己打开）。事件号、时间戳收进「详情」。状态表和文案见 dot 召唤回执。
- **你的消息下面：谁收到了**（2026-10-15，You：「这个气泡下的头像真的很丑，想要知道这条消息谁收到也应该设计一下」，看了稿说「这个好点」，`[thread-id]#private-source-id`）：每条你发出的消息，时间后面跟一行小字（12px，`{colors.muted}`），写收到它的猫的头像（16px）和名字，加现在到哪一步：「收到，已回复 · 看回复 ↓」（点了跳到回复并亮定位环；**只用于精确关联的那次回复正常完成**，失败写「收到，回复失败」、取消写「收到，已取消」、中断写「收到，回复中断」，找不到精确关联写「待核对」——10-16 浪哥指出处理完还包括这些结果，见 PR1398 审计第十一节）、隔了一会儿才收到时写收到的时间、「收到，正在回…」（名字后一个这只猫颜色的小点）、同时发给几只就几段并排各写各的、「排队中 · 等 [猫] 接，前面还有 N 条」（服务端确认入队就画，不等猫开始；**猫空闲、马上就发的，写「发送中…」，不写「排队中」**，只有真要等（猫在忙、前面有别的）才写排队中，不为了显示好看推迟实际执行——10-16 You 嫌空闲时也「卡在排队里 1 秒」，[#1610 浪哥 10-16 02:35 PDT](https://github.com/zts212653/clowder-ai/issues/1610#issuecomment-6212590415) 建议用真实的「发送中」；那 1 秒花在哪另外量；它只是队列的只读投影，不算已投递的历史、不进模型上下文，真正投递时按原消息收敛成同一条）、红字「没送到」+「重新发送」（按原 source×target 恢复，已成功的不重放）、「悄悄话，只有 [猫] 收到」。和上一条一样只写有证据的状态。不挂没有字的小头像（#1398 带来的 11px 头像取代掉）；猫回话里「交给 [头像] 猫名」一行照「对话」一节另外保留。画面见图册第二章「你的消息下面：谁收到了」，稿与数据对应见 PR1398 审计 第九节。
- **回话下的「补充消息」：每条写清收到没、读了没**（2026-10-15，You：「好像我也不知道你到底收没收到读没读」，看了稿说「可以的」，`[thread-id]#private-source-id`；列表本身 10-15 定了保留）：每条右边一列对齐写读取状态，再右是「跳到原文」——「✓ 已读 21:04」/「已收到，等读取确认」（这一轮还在跑）/ 琥珀「已收到，没确认读到」（这一轮结束仍没回执）/ 灰「已收到，读没读查不到」/ 琥珀「状态待核对」（找不到精确对应）。标题「补充消息 · N 条」后跟汇总（「全部已读」或各几条）。作者圆点只表示是谁说的。读取证据和上一条「谁收到了」的送达进度是两个维度，「已回复」不推出「已读」；被并进正在跑那一轮的消息，它下面那一行写「[猫] 收到，并进了正在回的这一轮 · 已读 21:04」，和这里同一份事实、同一套字。稿见图册第二章与 PR1398 审计第十节。
- **并进没成功，不算没送到**（2026-10-16 You 报：宪宪一轮刚开始 13 秒，他发的话被拒，聊天里出红色系统卡「opus55 的当前 Agent Client 已关闭，消息未追加到该回合」，`[thread-id]#private-source-id`）：你的话并进正在回的这一轮被拒（比如那一轮换了连接），只要这只猫还能用，就**自动排到它的下一轮**，你消息下面那一行写「排队中 · 等 [猫] 接」，接到后照常「收到，正在回…」。不出红色系统卡，也不出「Agent Client」这类内部词，你不用重发。排队也失败了，才写红字「没送到」+「重新发送」。**只有明确被拒、没被这一轮接手的才自动排队**；送出去了但没等到回音的（可能已经进了这一轮），不自动重发：系统先用**同一个编号**再核一次（读第一次接纳的结果、迟到的确认和读取记录），这时那一行写「正在核对 [猫] 收到没…」；核出收到了就照常显示，核出明确没收到就自动排下一轮；还是核不出来，那一行只写「没确认 [猫] 收到 · **再发一次**」；「如果它其实收到了，会再回一遍」放在指着「再发一次」时的提示里，不占这一行（You 10-16「这个我估计会太长哦？」，`[thread-id]#private-source-id`；「没确认收到」本身已经说了可能收到）——这是你主动的、可能重复的重发，用新的编号，和上面「没送到 · 重新发送」（同一编号、不会执行两遍）是两个不同的操作，不共用一个名字（10-16 浪哥指出：只让用户点一下，并不能保证不重复，[#1610 浪哥 10-16 03:30 PDT](https://github.com/zts212653/clowder-ai/issues/1610#issuecomment-6213507766)；宪宪定，可推翻）。原先这里写的是（[#1610 浪哥 10-16 02:35 PDT](https://github.com/zts212653/clowder-ai/issues/1610#issuecomment-6212590415)）。见 PR1398 审计第十二节。
- **聊天里的顺序**（2026-10-16，宪宪定；起因是 You 报的「上下疯狂跳」和浪哥问的「实时和重载后顺序怎么讲清」，PR1398 审计第十一节）：实时和重新打开用同一条规则——你发的消息按发送时间、回话按开始的时间排；卡片一旦出现就不再挪，回话跑完也不跳到后面。排着队的消息在原位标「排队中」，真正送到的时间写在它下面「谁收到了」那一行，不改位置（10-16 更正：初稿写「按送到的时间」，会让排队的消息送到时挪位，小星星指出）。回话收进了哪些后来的话，由它下面的「补充消息」写明，因果靠这一栏讲清，不靠移动卡片。用户往上滚时不被贴底拉回。存储分页和读取游标不跟展示时间走。 这是一次**展示规则的调整**（#1398 原来按完成时间排、每秒提交位置），不是对旧规则的等价修复；实时和历史、经典和新版界面都用这一条，不留两套，相关说明和测试一起收敛。（浪哥 10-16 01:24 PDT 认可它自洽，`clowder-ai#1610#issuecomment-6211320060`。）

### 批注
- 作品窄、旁边有留白（文档、手机稿）：`annotation-card` 贴在留白里，定位点是批注者头像。作品铺满宽度（横图、视频）：批注是作品上的头像点，点开在原处弹出。两种都在原位回复、标为已解决、请猫修改，这三个动作分开。

### 作品模式
在作品上说一句、看猫改、比新旧、做决定。画面与来由见 Studio 北极星 §0（图片这条线）、§0 的修正稿（聊天留在旁边）和 §0.6（其他作品）；画面上的动作大多还要补合同，能力边界见同一文件 §0.4、§5.1。比例、拖动、进出和返回按 Layout 的"外壳"与 F307 合同。
- 打开：人点了作品才进作品模式；新消息、猫交回新版都不抢主屏。聊天留在左边的聊天栏，几只猫的话都看得见；作品在右边，默认整张看全、不放大超过原尺寸，顶栏的百分比是真实比例；长截图要能上下滚动、字读得清。什么时候从"整张看全"改成"按宽度铺满往下滚"还没定：稿子估的"适应后小于原尺寸一半"没拿真实长截图验证过，只是待实测的候选，不作验收依据。返回回到聊天原来的位置。
- 打开要快（2026-10-23 You：「正在打开作品的速度太慢了，至少5秒以上，这个是不能接受的」，`[thread-id]#private-source-id`）：点了作品，手上已经有的图（聊天里的缩略图、已经缓存的原图）先画出来，目标是一秒内看见；归属、版本、能不能改这些后到的信息补在顶栏和工具条上，不挡画面。什么都还没拿到时，原位置先放缩略图加一行「正在打开」，不放空白转圈。
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
- 还没定：没有归属的文件怎么选发给哪只猫。聊天在旁边时新版对比和决定的画面、视频的素材库 2026-10-01 已补稿（Studio 北极星 §0 修正 4–6），还没实现。视频在作品模式里的四个状态（看片、停下来指一处、猫在改、新版回来）2026-10-15 补稿，You「挺好的」（`[thread-id]#private-source-id`），画面见图册第六章与 `docs/evidence/2026-10-15-f309-video-viewer/` 的 `wmv-*`；视频对比同样按「会变小就默认切换」，两版一起播、换版本时间不跳；剪辑用的素材库和轨道归剪辑台，不放进作品模式。整窗看不借用会让聊天不可见的 `mainAreaAttention`，按上一条和 F307 KD-25 做。

### Workspace 的工具
专注、锁定、整窗三件事（2026-10-03，You 看完代码组改版说"满意了"；画面和来由见主页北极星 §1.13）。稿子已通过，还没实现。
- 专注：作用于当前这一个工具。专注后 Workspace 里只剩内容，顶栏、标签、工具条都藏起来，聊天还在左边。顶边正中**一直留着**一枚小标签「⤡ 退出专注 · Esc ｜ 整窗」（24px 高，外框底色 + 发丝线，下边圆角，不压页面自己右上角的按钮），不自动藏起来；Esc 也能退，内容在 iframe 里 Esc 收不到时就点这枚标签。2026-10-08 改：原来「两秒后缩成顶边一道细线」，You 点了专注找不到怎么退出（`[thread-id]`，10-08 01:0x PDT），那道 6px 的线看不出能点。
- 整窗：专注里再点"整窗"，和作品的整窗看是同一套（见"作品模式"）。
- 标签：打开过的东西是一排标签，不收进下拉；选中或悬停时有 ×，放不下时末尾「更多 N ⌄」（主页北极星 §1.8）。从聊天点开的**图片**、从文件树或搜索打开的文件，先进「预览」标签：点下一个就在同一个标签里换；批注、编辑、点「固定」或双击标签才变成常驻。**例外：聊天里显式点的文档链接**（具名或绝对路径的 Markdown 链接、文件路径链接）直接开成常驻标签：不同文件各开一个标签，同一个文件复用原标签并跳到行号，已有同一文件的预览就升级成常驻。2026-10-08 改：You 在 F307 线程里已经开着文档 A，再点对话里的文档 B，A 被盖掉了（`[thread-id]#private-source-id`）。
- 锁定：锁住 Workspace 现在的样子（哪个工具、哪个文件、哪一行、滚到哪），切到别的对话右边不变，顶栏写"已锁定"。锁着时猫要打开别的文件，不抢右边，右下角出一张小卡（"小太阳 请求打开 F317-actions.md"，可以忽略或替换锁定内容）。点"已锁定"就解锁，回到当前对话自己的 Workspace。

### 记忆 › 全部记忆 › 画像
2026-10-26 You 看了烁烁的整页稿：「我感觉差不多了，『个人简介』可能换成『关于你』更好」（`[thread-id]#private-source-id`）；稿在 `docs/evidence/2026-10-26-f332-profile-northstar/`，底图是真页面。
- 三层，左列从上到下：**关于你**（每场新对话自动带上，300 字内）→ **共同画像**（全家共享，按需回看）→ **与各只猫的关系画像**（真头像、猫名和模型，不露 catId 和 Markdown 符号）。进「画像」默认选中「关于你」，右栏直接展开全文，不留空。
- 名字按内容叫，不按投递机制叫：「关于你」取代「开场简介 / 个人简介」；什么时候带上写在旁边的小标签里（「每场新对话自动带上」）。
- 本人在右栏原地改，保存就生效，不走审批；改动没保存时底部一直有提示，带字数。
- 猫起草的更新，记忆页只做新旧并排对比，不另放同意 / 拒绝按钮；「查看并决定 ↗」跳到原对话里那张审批卡，和待办「等你决定」是同一件事（见「审批只在待办里」）。You 10-26：「最好要架构归一哦，别搞的导出一个能力各自一份」（`[thread-id]#private-source-id`）。
- 界面上不写内部说法：「开场递送」「检索命中」「唯一审批单」这类换成人话，比如「新对话带上 N 次」「被猫翻到 N 次」「和待办里是同一件」。

### 面板、数字与结果
- 侧滑面板（待办）：从世界栏旁滑出，盖住左栏；打开不切换世界、不批准、不清数字。
  - 不是模态的：主区不加遮罩，照常能看、能点、能打字。所以点面板外面不关，只有右上的关闭、Esc、再点一次待办入口才关。1.6 稿上主区画了一层轻遮罩，2026-10-01 改掉：遮罩在告诉人"后面暂停了，点这里就回去"，这块面板两样都不做，留着遮罩就多出一块点了没反应的地方。
  - 面板里再弹出的东西（如填反馈的框）先接住 Esc，关掉后焦点回到面板里原来的位置；在里面打字、点击，不能把面板关掉，也不能丢掉没发出去的字。
  - 顶部单独标"返回位置"（关闭后回到哪），和每一项自己的"来源"分开写。来源按原始锚点，不按背景世界推断；返回位置只用 Host / F307 / F290 记下的打开现场，拿不到就不画这一行，不拿背景世界或上一个页面去猜。
  - 底部"已处理的"（历史），以及审批的筛选和安全批量，要能从面板走到，可以经原审批入口的第二层，不能因为换成这块面板就没了。分批实现时，还没做的照实标"还没做"，在 F322 第 3 段完整待办验收（S3-4）之前补齐并验证；第 1 段"不悬停能不能找到入口"的第一眼检查不因此往后推。要去掉其中哪一样，是另一个产品决定。
- 待办角标消费 F310 提供的可信独立事项总数：只有声明范围内的来源覆盖完整、去重身份可证、且没有未解决的版本冲突时才写数字。计算和各来源状态沿用主页北极星 README 里的 F310 消费合同，不以 HTTP 成功、当前页长度或客户端相加来证明完整；本轮已确认有事但凑不出可信总数 → 只给圆点，悬停写"数量未确认"；两边都读成功、合起来为空 → 入口还在、没有角标，打开写"暂无待办"；第一次读取、或换了范围（换对话、换身份）时 → 不写 0、不沿用别处的旧数，第一次没读到也不算 0；同一范围后台刷新时 → 保留上一次确认的数字，新结果到了再换，刷新失败才按下面的失败状态改画法，刷新期间不把数字拿掉（You 10-19：对话顶栏「Works 1」随着每条新消息重读一闪一闪。这条对顶栏 Works / 任务、侧栏未读等所有件数都适用）；全部没读到 → "暂不可用"，打开给重试；一部分没读到 → "仅部分读取"，先列读到的；确知需要登录 → "需要登录"，只标要登录的那一边。七种状态的画法见主页北极星 README 1.6 节状态板。
- **审批只在待办里**（2026-10-08 You 认可，主页北极星 §1.19）：同一件事只在待办出现一次，新版 Workspace 不再有单独的「审批」工具。卡片展开就能决定：写清谁提的、为什么（提议里的原话）、谁来做、同意后会怎样；按钮「同意」（主按钮）/「拒绝」，左边一条「在原处看这条提议」，拿不到原处就不显示这条链接，不写「原处暂不可定位」。同意后卡在原地变成一行结果（「已同意 · 对话已开，小星星在干活 · 打开」），数字减一，原对话里留一行回执。**聊天里的原提议卡也一样收成一行**（2026-10-22 You：「审批完成之后……approve 的话搞个怎么样绿色，reject 的话搞个怎么样的红色？」，`[thread-id]#private-source-id`）：结果行开头一个状态点，同意绿点「已同意 · 对话已开 · 打开 ›」，拒绝红点「已拒绝 · 05:44」；谁提的、为什么、第一条消息这些详情收起，点开还能看；「打开」用文字链接，不用描边按钮。只给状态点上色，不把整张卡染绿或染红。**不只提议卡，所有审批卡都这样**（2026-10-22 You：「最好你得别只设计一个！其他的几个审批也得这样」，`[thread-id]#private-source-id`）：会话接力、画像更新、派活、品味、实体、记忆纠错、定时任务、评估修复、记人的记忆、会议整理、认领托付、运行中的选择题 / 审批 / 表单，凡是要你同意或拒绝的卡，在聊天里和待办里批完都收成同一种一行：同意绿点、拒绝红点，过期或撤回灰点（「已过期」「已撤回」），后面一句这件事的结果（如「已同意 · 定时任务已登记，明早 9:00 第一次」），再跟一个文字链接；选择题写选了哪一项。用同一个结果行组件，不每种卡各写一套。处理过的在待办底部「已处理的」；原审批列表的筛选和安全批量从待办走第二层进去。**「已处理的」只有一个**（2026-10-27，You 看到首屏铺开 50 条已处理、底下又有「已处理的 @你」「审批记录」两个门、点进去还是旧审批界面：「这两个难道不就是跳转到已处理的那个地方吗……你们都不做架构归一的吗」，`[thread-id]#private-source-id`；补稿 `docs/evidence/2026-10-27-f322-inbox-history/`）：首屏只放等你决定和 @你，刚处理的那件在原地留一行到关掉待办；底部固定一行「⟲ 已处理的 ›」，首屏不读历史。点进去是同一面板的第二层，「全部 / 等你决定 / @你 / 忽略的」四档加结果、种类筛选，按天分组；每件两行，第一行结果词 + 种类 + 时间，第二行标题 + 谁提的，不允许只写「已同意 · 打开」认不出是什么事；点开是原卡收起后的样子（打开 / 在原处看 / 技术详情），不嵌旧审批组件，不写 `default-user`。历史只读一份，进了才读，一次 30 条；读过的再进来先显示，更新失败保留旧的并写读到的时间。**原对话里那一行回执**（2026-10-26 You 看稿：「这个可以啦……细节问题都不大」，`[thread-id]#private-source-id`；稿 `docs/evidence/2026-10-26-f322-undrawn/`，底子是 10-11 旅程③ j3-5）：是你做的事，靠右一行，底色 `{colors.surface-3}`，不用居中的系统框；写「● 你同意了 [头像] 猫名 提的新对话「标题」↑ · 对话已开 · 打开 › · 时间」，后半句就是上面那个结果行组件的同一份数据；拒绝红点，填了理由带「理由：…」；界面不露提案编号；点标题或 ↑ 回原卡并亮定位环。原卡就在正上方（中间没有别的消息）时不再画这一行，卡上的结果行已经说了；回执消息照旧存，猫照旧读得到。过期、撤回不留回执。
- **猫提议新对话的卡：派给谁只在一个地方，想改就跟提议的猫说**（2026-10-23，You：「现在在 chat 里这张卡并没有你自己设计的这么好……我改了派发给的🐈，结果你正文还是猫 a，等于我得改两个地方」，`[thread-id]#private-source-id`；看稿后「图2的那个东西其实是可以的」，`…private-source-id`；稿 `docs/evidence/2026-10-23-thread-proposal-card/`）：
  - 中文界面全中文：派给 / 项目 / 放进 Group / 回报 / 置顶 / 第一条消息；不出英文标签。
  - **「派给」是唯一来源**：第一只标「先开口」；第一条消息开头的点名由它自动生成，猫写的正文不再 @ 被派的猫。
  - **换猫、改范围、改第一条消息都交回提议的猫**：卡底「让宪宪改…」（写提议猫的名字）展开一行输入，按钮「请宪宪改」；猫按原话重提一张，旧卡收成一行灰字「已按你的话改，换成新提议 ↓」。不再有大表单「Edit」。
  - 项目、放进 Group、置顶是选一下的小事，卡上直接改，改完就是你同意时的选择。
  - 批完照上一条收成一行；被新提议替代的写灰点「已被新提议替代」。
- **待办里能做原卡能做的事，不用回聊天**（You 2026-10-14 02:30 PDT：「消息中心原本要帮我节省注意力，结果难读，也没人家原本完整的能力……如果一定要让我回到原本的 chat 里点，这个 needs me 的价值就大打折扣」，`[thread-id]#private-source-id`；每一类的梳理和新卡的稿见 待办能力对齐）：
  - **能力不少于原卡**：每一种要你决定的事，在待办里都能处理完。原卡能看的都能看，能做的都能做：编辑、勾选、多选、填写、撤销、批后跳转。「在原处打开」只是去看前后文，不是唯一的出路。
  - **同一件事只有一张卡**：聊天里和待办里用同一张卡（同一份读取，同样的按钮），待办只是排得紧一点，不另做「提议者 / 为什么 / 执行者 / 同意后」那种通用摘要卡，也不只给一行标题。
  - **不同种类各长各的**（You 2026-10-14 03:58 PDT 看了新卡说「可以的」，并强调「家里的审批中心对接的不同的审批，他们得渲染不同的！」，`…private-source-id`）：
    - 新建对话、会话接力、画像更新、派活、品味、实体、记忆纠错、定时任务、评估修复、记人的记忆、会议整理、运行中的选择题 / 审批 / 表单、认领托付、聊天里的选择、作品审阅，每一类有自己的种类名、卡面上的关键事实、折起的长内容，按钮名字照原卡；
    - 逐类写在 待办能力对齐「每一类各长什么样」那张表里；
    - 框架统一：头（种类 · 谁提 · 时间）→ 要做什么 → 为什么 → 关键事实 → 折起的长内容 → 选项 → 主动作，右边「忽略 / 在原处打开」；
    - 新来一类先在表里加一行再接进待办，不能悄悄落到通用卡上。
  - **收起时也能拍板**：卡上露出这几样：
    - 一句话：谁提的 · 要做什么 · 为什么；
    - 关键事实，用人话写：对话写名字不写编号，人写「你」不写 default-user，原因代码翻成话；
    - 主动作。

    长内容（首条消息、改动前后、草稿、表单）折起来，点开是排好版的正文，不露 `**`、JSON 和内部编号。「技术详情」只给想查的人，不能是看懂内容的唯一地方。
  - **要你回答或决定的都在这里**：聊天里的选择卡、运行中要你填的表、授权，和审批一起进「等你决定」（猫想接下你顺口说的事时发的托付邀请不进，留在原对话，10-15 定）。进不来的照实写去哪儿处理，不悄悄漏掉。
  - **聊天里的选择卡只收「猫明确在等你」的那一次**：要有原请求和能核对的终点（你点了、你用文字答了、猫撤回或改问、过了截止）。能反复点的引导、导航和重试按钮、不欠你一次决定的推荐和小游戏留在原处。判断看发起方有没有声明「在等你」，不看卡的种类、按钮长相，也不猜句子；猫在等却没声明，是发起方要补。正反例见待办能力对齐「第 16 类的分界」。
  - **同类的能一起处理**：按种类筛选、批量同意或拒绝、清掉过期项，在待办第一层就能做到，不藏在「审批记录」第二层。
  - **结果要有终点**：处理完原地变成一行结果。确认办成了就写办成了；确认不了就写原因，再给「重新读取」，不长期挂着「结果待确认」。
- **待办里的「@你」看过就算处理完**（You 2026-10-14 02:26 PDT：「我点了回去查看这个 thread 之后，这个 at 我的点还没消失，必须我点 ignore，这个其实是不合理的吧？我去看了等于我去看了这个 at 我的」，`[thread-id]#private-source-id`）：
  - **怎么算看过**：「@你」是提醒你看一眼，不是等你做决定。只要你看过那条消息，它就从「@你」里移到「已处理的 @你」，不用再点「忽略」。从待办点「在原处打开」算看过；自己从侧栏进那条对话、读到那条消息也算。
  - **看过用哪个信号**：和侧栏的「@你」小标签读同一个已读信号，两边同时消失。这和上面「收起的组也露出要你看的那几条」里「@你 看过就不再露」是一条规矩。
  - **其他关闭方式**：回了话照样关。「忽略」只留给不想点开看、直接清掉的时候用。
  - **「已处理的 @你」里写清是怎么关的**：看过、回了话、还是忽略的。
  - **不包括「等你决定」**：审批、选择题这些看一眼不算，要真的同意、拒绝、回答或忽略了才消失（旅程③：处理成功才算处理完）。
  - **猫真要你做事，就别只 @**：比如请你重启，要用「等你决定」这一类能核对是否办成的事项，不能指望一条普通 @你 一直挂着提醒。
- **待办的第二栏叫「日程」**（You 2026-10-09 由「全部工作」改名，`[thread-id]#private-source-id`；英文 Schedule）：放托付给猫的工作，只看进度，不计入待办的数字。为了名实相符，打开默认是日历（周 / 月）；旁边两列「没排期的」和「最近 7 天完成」，这两类不算日程，但仍在这里找得到。待办是窄的侧滑面板，放不下日历，所以点「日程」在 Workspace 里打开宽页；列表要读 F310 完整的工作读取，不读统一注意力列表。打开成果再回来，日期、选中的工作和聊天草稿都还在。
- 处理结果只说确知的事：请求没有回应 → "暂未确认处理结果" + "重新读取状态"，不把"重试"默认成再做一次；明确的"已处理""没有权限"各自照实说。

### 制作工作台
做片子、做一组作品时，人和猫一起用的工作台（2026-10-07 剪辑台，用醋醋喵 EP0 的真图、真时间轴画；You 定为当前北极星，没上手前先这样，画面见剪辑台北极星，规则来由见同目录 logic.md）。审片已做出来（F326 B）；2026-10-20 起按真实片子重排，见下面「片子就是作品」几条。
- 层级：项目栏用外框色（面包屑 + 工作区导航，中间一道竖线）；内容（播放器、表格、卡片、记录）是纸面，放在 `{colors.surface-3}` 工作台上；右边检查栏用 `{colors.surface-1}`。片子和画稿最亮。
- 顶栏说清谁审过什么：写"猫已自审 100 个镜头"和"1 项待你决定"（点了跳到那一项），不写"已通过 100 / 100"，那会让人以为整片定稿了。
- 只提异议：人只标不同意的地方，没标的算通过，不给人逐张确认的按钮。列表里的状态只标例外（通过（附说明）、需修改、未开始），不铺一列"已通过"；配"全部 / 有说明 / 需修改"筛选。
- 主按钮按这一屏人要做的事选：审片是"标记问题"，导出是"导出"；没有主动作的屏不放。"一屏一个主按钮"不是整套只能有一个。
- 看片：两层时间轴，上层全片概览（场次用数字，悬停看名字），下层当前片段的镜头条（真实缩略图）；有上一个 / 下一个问题、循环、全屏。标记时先选挂在哪：这一刻、这个镜头、全片。说不清是哪一张的意见按全片意见显示，猫定位后再挂到镜头上，经过写在意见下面（谁提、谁定位、谁改）。
- 对象、镜头、时间码分开写：一个镜头可以有几张画稿。画稿修改是静态图，按"画稿对比"给并排和同步缩放，不配播放控件；"在影片中查看"跳到这张画在片里真正出现的时刻，时刻按渲染规则算，不手写。
- 检查页：可以分页，但分页由人和猫自己新建，不写死（You 2026-10-07，`[thread-id]#private-source-id`）。每页写名称、看什么（一两句判断标准）、对照哪几张参考图、用在全部场次还是这一场、谁来做、由来（谁、哪天、哪条意见）。某一场还没有这页的图就给空状态，能请画师补；本场不适用就写明在哪一页一起查。名称和说明是人或猫写的，界面不替它改字。
- **片子就是作品，剪辑台是视频的作品模式**（2026-10-20，You 看了近期五支片子后的对齐：「我们这版本什么的好像某种情况也得对齐？」「这里最好不是平铺的！我们家的风格好像是下拉框？」，`[thread-id]#private-source-id`；「好～ 那就先这样！」，`…001938-c0f033a4`；稿 `docs/evidence/2026-10-20-f326-c-real-films/`）：片子不另立列表，在 Works 里用「视频 ⌄」找；版本就是这件作品的版本（与 F309 活的作品同一身份、同一条版本链），顶栏「第 N 版 · 当前 ⌄」，聊天卡引用确定的版本；打开后一排顶栏（‹ 聊天、片名、版本下拉、对比版本、标记问题、下载、⋯），不分页签：左边故事线或素材（顶上一个下拉切换），中间看片和章节条（动画片换成场次和镜头条），右边意见。
- **故事线从成片读出来，剪辑台不规定怎么做片**（You：「新建一个thread甚至不是在家里的仓+告诉你别看skills 你都没先做脚本的情况下 比如猫猫星球 效果反而最惊艳」）：有时间线就读章节和逐句旁白，只有成片和字幕就从字幕切段；不要求先写脚本、不要求在家里的仓或照 skill 做。片子在哪做的都能交进来。
- **素材在一处看全**：这部片子用到的图、视频、配音、配乐、字幕、封面按种类列出，只读、索引原文件；哪个是正典另行标记（F326 Phase D）。
- **章节条永远一行，不挤播放器**（2026-10-21，boot43 真片入库后《AI-native builder 的一天》49 章把章节条折成多行、播放器高度被挤成 0，Sol6.1 实页发现）：章节条是播放器下一条按每章时长分段的细色带，当前章高亮，点一段跳到章首；放得下时每段写「时间 + 章名」，放不下就只画色带，章名和时间在悬停 / 聚焦时出现，当前章名写在色带一端。不换行、不横向出滚动条。完整章节目录在左边故事线。播放器高度固定，下方任何控件都不能把它挤小。
- **没有故事线就不留那一栏**（2026-10-26，同上 You 那句「超级难用」；他截图里作品模式左边一栏只写着「这版没有可用故事线」，播放器缩在右半边）：故事线栏只在这一版读得出章节或字幕时出现；读不出来就不占位、不写那句话，播放器拿到整块宽度。
- 还没定：宣传片的节拍表、时间线视图；渲染引擎（Remotion）只在插件里，不进主仓。

### 刚进来的画
- 新对话页、进入一个世界的首页这类"刚进来"的时刻，上方可以放一幅这个地方自己的画（Café 一幅，共同体各自一幅）；一开始干活（进入对话、打开作品）画就退场；带着具体目的进来（点了某条对话或链接）的人直接落在工作状态，不先看画。
- 构图约束：上方约 40% 安静，叠白色衬线标题（加柔和阴影保证可读）；脸落在 43%–78% 高度、横向中间一半；底部约 20% 低细节并渐隐进 `{colors.surface-1}`，输入框压在画的下沿上。可以按时间换画（如傍晚 / 深夜）。
- 画里家里的猫从角色正典 §7 派生，全家四只：宪宪、砚砚、烁烁、墨墨。导演稿先写"这一刻发生了什么"，每只猫一个不同的动作。
- 画只出现在这些时刻；外框和工作状态里不出现插画、渐变或装饰。现行两幅见主页北极星。例外只有一个：用户自己给某条对话选的背景（见下「对话背景」）。

### 对话背景（2026-10-26 定稿：照 IntelliJ IDEA 的背景图）
来由：You 10-26「我们的chat 等等 是不是也可能 变成是可以定制背景图的那种！」（`[thread-id]#private-source-id`）。第一版「中间一张白纸、画只露两边」被说「太丑了」「很突兀」，第二版「整窗一起虚化」被说「不应该叫虚化」，第三版照 IDEA：「对对对！！是这个！是这个！ 我想要的是这个！」（`…private-source-id`）。稿、样本和算法见对话背景北极星；参照的是 [IntelliJ IDEA · Background image](https://www.jetbrains.com/help/idea/setting-background-image.html)。
- 默认没有背景（You 10-27：「这些主题好看是好看 但是干活的时候中看不中用」——背景适合聊天、贴贴这类不用细看的对话，干活的对话保持「无」；按对话单独设就是为了这个）。只影响用户自己看到的界面：不进消息、不进导出，猫也看不到。设置要持久保存。
- **整个窗口铺同一张清楚的图**：世界栏、侧栏、顶栏、对话区、输入框那一整条原本的底色去掉，透出同一张图；图不虚化，固定不跟着滚动。设置页也铺着。
- **整窗一个浓淡**（图片不透明度），不分区、不渐变：原来的底色以「1 − 浓淡」盖在图上。**默认取「这张图字都读得清的上限」和 20% 中较小的那个**（10-27：上限 38% 的黄昏铺满后 You 说「花里胡哨的看不清了」，`[thread-id]#private-source-id`；对比度过线不等于读着舒服，上限只当滑杆的警戒线，不当默认值）。上限这样算：有字的地方取最暗 5% 像素，`{colors.muted}` 仍有 4.5:1，浅色、暗色各算一个。算法和画字用同一个 token：`{colors.muted}` 在 runtime 是 `--shell-muted`（10-26 更正，原先样本手挑了更浅的灰）。背景开着时，直接压在图上的字一律不浅于 muted：灰字统一用 `{colors.muted}`，彩色字保留色相、明度压到不浅于 muted。滑杆可以往右推，超过时写「再往右，有些灰字会看不清」。
- 摆放：铺满（默认）/ 居中 / 平铺。
- 两处可以设：「设置 › 你 › 对话背景」是所有对话的默认值；对话里「⋯ 对话设置 › 对话背景」只用于这条对话，盖过默认值（在「已置顶」下面一行，右边是当前背景的缩略图、名字和「›」，点进去原地换成面板）。面板一格一张：无 / 家里的画 / 上传图片，下面是浓淡；点一张立刻换，没有保存按钮，选中的那格套一圈 `{colors.primary}`。
- **保留原本的色差**（10-27 定，取代上午「卡片去底色」那版；You：「没有主题的时候 其实每个卡会有不同的颜色，改成统一主题……大家都一样了」「按道理应该是在原本的色差下」，`[thread-id]#private-source-id`）：每块有底色的面（世界栏、侧栏、侧栏组卡、对话区、作品卡、人的气泡、设置卡片、输入框、按钮）**保留自己的颜色**，同一张图固定在窗口上，按同一个浓淡叠在每块面自己的颜色上：面的颜色 ×(1 − 浓淡) + 图 × 浓淡。每块面直接和图合成、不叠父层，所以哪一层透出的都是同样浓的同一张图，不会一层压一层越压越白；字在最上面，不被图盖。菜单、弹窗、浮窗、选择面板这类浮起来的东西保持不透明。**透图的只有「面」**：外框、工作面、纸面这些 surface 层，侧栏组卡、作品卡、设置卡片、人的气泡、输入框底。用强调色或状态色填满的小控件（主按钮、未读角标、开关、状态胶囊、实心标签）保持原样、不透图，读得清的上限也不算它们（10-27 小太阳实测：赭色主按钮叠 20% 黄昏后白字只剩 3.55:1，若算进去黄昏默认会被拖到 5%，`[thread-id]#private-source-id`）。读得清的上限按每块透图的面自己的颜色分别算，取最差的。参照：VS Code 的背景插件、macOS 侧栏的半透明材质、Windows 11 的 Mica 加卡片层、Telegram 的气泡压在壁纸上，都是背景只是最底下一层，各层原来的颜色关系不变。这里不虚化，没有毛玻璃，和 Elevation & Depth 不冲突。
- 一张画在浅色、暗色下各能放多浓，按实测，不按画本身的明暗去猜：PR #6245 实测 Café 夜景浅色上限 13%、暗色只有 3%（暗色的灰字更亮，画里的灯光一透就不够），和「深色的画配暗色」的直觉相反（`docs/evidence/2026-10-27-f322-background-surfaces/final/README.md`）。所以面板里不写「适合暗色」这类静态小标；要提示，就按这张图实测的两个上限现算。输入框和消息列用同一条中线。
- **设置 › 你（2026-10-26 定稿，You：「我感觉你这个设计ok的 就这样决定了」，`[thread-id]#private-source-id`）**：「设置与管理」侧栏最上面一行是你的头像 + 名字 + 灰色「你」，点左下角头像先落在这一页；两张卡：资料（头像、名称、@ 名字、颜色）和对话背景的默认值。成员列表里你那一行跳到这一页。

### 空态与仪式
- `empty-state`：衬线 22px 标语（`{typography.display-sm}`）+ 一句 14px 说明 + 一个 `button-primary`。这是衬线体和 40px 按钮唯一常规出场的地方。
- 新对话页（2026-09-29）：衬线大标题 + 一句说明 + **输入框就是主动作**（不另放主按钮），下面是"最近的作品"（只取当前用户的 Café，按时间；按记录、作品族还是版本来算以 F232 为准，本文件不替它定；补空与失败状态）。可以叠在"刚进来的画"上。
  - **「最近的作品」往下滚看更多、一键去找做它的猫**（2026-10-16，You：「现在只能看到 3 张，我想看看你们都干了啥……希望在首页能往下滑……能让我一键跳转到正在干活的那只猫」，`[thread-id]#private-source-id`；看稿后「顺手把作品跟引用放到输入框其实挺好的」，`[thread-id]#private-source-id`；稿 `docs/evidence/2026-10-16-f322-landing-recent-works/`）：三列网格（窄于约 720px 两列、约 420px 一列），和作品页同一种卡，往下滚自动接着加载，到底写「这就是全部了 · 全部作品 ›」；范围仍是你 Café 里所有对话，最新在前。每张卡：标题最多两行，下一行小字「在『对话名』」，最底一行做它的猫的头像 + 名牌名 + 时间；这只猫此刻正在那条对话里干活，时间换成小绿点 +「正在干活」。卡片右下「去聊 ›」（平时描边，指着卡片时实心赭色）：打开那条对话，停在交出这件作品的那条消息上并亮一下定位环，输入框里先放好对这件作品的引用并 @ 做它的猫，只是草稿、不替你发；不要就自己删。点卡片其它地方照旧在正中浮窗打开作品。那幅画不吸顶，往下滚自然滚走。
  - **建对话时就能起名、勾置顶**（You 10-09 20:10 PDT：「我的 thread 名没地方让我自定义……至少有个自定义的」「也没一个置顶的按钮，这创建了就淹没了。v1 的这里最常用的就是 1. 取名 2. 勾选置顶。当然置顶不能是默认勾选，但是得有个勾」，`[thread-id]#private-source-id`）：
    - 输入框最上面一行放「对话名（可不填）」：单行、安静，不抢输入框的主角位置。
    - **不填名字时，由第一只回话的猫起名**（You 10-10 04:21 PDT：「如果我没填是不是让第一条消息的🐈自己填一个，比我打的那一段话变成一个 thread 名好多了」，`[thread-id]#private-source-id`）。猫读完第一句，在第一次回话时起一个短名，概括要做的事，不照抄你的原话。在它起名之前，先临时用你第一句话的开头。你自己填过或改过的名字，猫不再动；猫只起一次名，之后改名只由你来。
    - 输入框底下那排，项目旁边放「☐ 建好后置顶」，默认不勾。
    - 两者都在第一句发出、对话真正建立时一起生效。起名和置顶都不是阻挡，不填不勾也能直接发。
    - **接上 Claude Code / Codex 里已有的会话**（You 10-10 04:09 提，04:21 认可入口和面板）：输入框下面一行安静的「接上 Claude Code / Codex 里已有的会话」。点开是小面板：交给哪只猫（只列用同一工具的成员）、哪个会话（本机最近的会话，找不到再贴 ID）、项目跟着会话走；「接上并打开」不需要先发一句。打开后对话顶上一张卡，说明接上了哪个会话、谁从那里接着做。稿见 `docs/evidence/2026-10-10-f322-import-session/`。必须守住三条：
      - **不只 Claude Code 和 Codex**（10-15 You 看到工具只有这两个：「笑死我了你们这其他猫都没做？！」）：猫用的工具只要能接着原会话往下聊，就列进「哪个工具」（Kimi、OpenCode、Antigravity 等按各自的实际能力加）。本机列得出最近会话的，就给列表；列不出的，只给「贴会话 ID」；根本接不上的工具不列，不放一个点了没用的选项。工具多了以后，入口那行改成「接上本机已有的会话」，具体是哪个工具在面板里选。
      - **会话的名字用人说的第一句**：跳过系统塞进去的包装（`<runtime-routing-context>`、「# Files mentioned by the user」这类），它们不是谁说的话。找不到人说的话（比如猫自己的会话），就用它已经接上的对话名；两样都没有，才写「没有可显示的第一句」。
      - 会话正在 Codex App、Codex CLI 或别的地方运行时会被锁住。这时不接，写「这个会话正在 Codex 里运行，先在那边关掉再接」，并给一个「再看一次」。接上必须是原样续上；续不上就明说，不能悄悄换成一个新会话。
      - 一个会话只能接在一条对话里。已经接过的，在列表里写「已接在『某某』对话里 · 打开」，不再让你接第二次。
      - 列会话、查重都不能拖慢家里：面板打开时才去读，只读最近的一小批；只读会话的索引信息，不读整段记录；查重用家里现成的按会话 ID 直接查的索引，不做全量搜索；也不能挡住别的请求（教训见线程「刚启动很容易出现网络超时 + 网络慢」）。
    - 窄屏（< 640px）：底栏保持一行，和加置顶之前一样。为此「☐ 置顶」挪到对话名那一行的最右端，文字缩成「置顶」，读屏仍念全称。不能让底栏折成两行，把「+」孤零零留在左下角、上面空出一块。（宪宪 10-09 23:04 PDT 在 Alpha 上对 #5328 时定）
    - 对话名下面那条分隔线，两端收在输入框边框以内，不能探出圆角。
    - 窄屏底栏排成一行以后，每一格都只占一行：放不下的字用省略号截断，不换行，也不能越出自己那一格。「+」、麦克风和发送三个按钮宽度固定。项目名最多占剩余宽度的约三分之一，超出就用省略号。「发给」那一格占剩下的宽度，「发给」两个字和头像总是留着；小名和「正在确认」「暂不可确认」这类状态字放不下就用省略号截断，悬停提示和读屏念全文。相邻两格之间至少留 8px。验收时要量每一格里的内容有没有溢出（内容宽度大于格子宽度），只看格子之间不重叠不算数。
      - 被截断的名字和状态字，要么至少露出一个字再加省略号，要么整段不显示，不能只露出半个字。头像外面有一圈描边，算上描边，头像和「发给」之间看得见的空隙至少 4px。
      - 英文 390 宽时，项目名可能只剩两三个字母加省略号（「ca…」），全名在悬停提示和读屏里。这是底栏排成一行的代价，接受，不再另找位置。（宪宪 10-09 复核 #5330 第二轮时补）（宪宪 10-09 复核 #5330 时补：底栏挤成一行后，「发给」那格只剩 56px，中文「暂不可确认」竖着一字一行漏出卡片，英文「Send to」压在「cat-cafe」上面，可是每一格的外框彼此并不重叠）
    - 来由：v1 的新建框（`DirectoryPickerModal`）有「对话标题（可选）」和「创建后置顶」；v2 新对话页（#5256）只能建完后再改，所以一建好就被别的对话淹没了。
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
- 组织工作的分页、分类可以有，但让人和猫自己新建、改名；界面不写死一套分类，不同项目要的不一样（You 2026-10-07，见"制作工作台"）。
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
- 不用实心赭红做计数角标；需要你动手的数字用 `badge-primary`（浅赭底 + 深赭字）。唯一的实心赭例外是「@你」小标签：它是提醒，不是计数（2026-10-08，见 Colors「注意力分四档」）。

## 界面上的字

所有出现在界面上的字都按这一节起：标题、面板名、入口名、按钮、菜单项、标签、状态、空态、报错。You 2026-09-30 定为设计军规（`[thread-id]#private-source-id`，品味记录 产品命名）。

1. **先想成熟产品做同一件事时怎么叫，用英文写出来。** 东西用短名词，动作用动词加宾语。
2. **再译成正式的产品中文。** 译完倒回英文读一遍，意思对得上才算数。
3. **不用口语短句当名字。** 标题、面板名、入口名、按钮名不写成一句随口的话。
4. **不暴露无助于当前任务的内部术语和实现细节。** Feature ID、Gate、stage、对象模型里的名字不上界面。人做判断需要知道的行为、权限和操作后果，用产品语言说清楚；目标用户本来就用的任务词汇可以用。
5. **优先沿用已经确认、符合本节的产品词。** 指用户看得见的词；代码里的状态值不直接当文案。旧词不符合本节时，在这次动到的界面和同一概念的其他出现处一起改掉。同一件事在整个产品里只有一个名字。
6. **对话里的话不在此列。** 猫和人说的话照常说人话；这一节只管界面自己的字。
7. **说明文字分三档，不常挂解释**（2026-10-12，吴浪 meow-club#4 提，You 看图认可，`[thread-id]#private-source-id`；对照图 `2026-10-12-f322-wulang-review`）：
   - **常显**：当前值、真实状态、出错和恢复动作、做一个动作前必须知道的后果、状态的证据和时间（例如「已恢复 · 最近一次接活顺利完成 · 2 分钟前」：写清它证明了什么，不写「调用成功」这种看不出是哪次调用、证明了什么的字）。
   - **删掉**：把标题或表格列再念一遍的说明、列举页面上已有的东西、为了猫味写的口语句、内部原话和术语（例如成员页「派活偏好」下面直接漏出来的「operator 于 … 明确要求 sunset …」）。
   - **收进标题旁的「?」**：概念的意思、口径、少见的边界情况。「?」是一个统一的组件，鼠标停留、键盘聚焦、点击或触屏都能打开，不只靠鼠标悬停或原生 `title`。
   - 操作的后果在做那一步时当场说（例如「添加账号不会自动改变猫的绑定」放进添加和换绑的流程里），不长期挂在页面底部。页面标题下面的副标题不是必填。

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
11. **每张稿只对它的主角那一块负责**（2026-10-12，You 问旧稿里过时的侧栏要不要全局改，`[thread-id]#private-source-id`）：四周的外壳（侧栏、聊天栏、窄栏）以最新的外壳稿和本文件为准。旧稿四周过时了不回头重画，旧图是当时拍板的证据，也不覆盖；哪张稿再动到时，顺手换成现行外壳。拿稿子对照真界面时只对主角那一块；图册里外壳过时的页在页脚写明主角是哪块。新画的稿外壳一律从主页北极星的 `mock/home-northstar.html` 取，不各画各的。
12. **给已有功能换外壳先对内容**（2026-10-12，F311 北极星第一版被 You 退回）：先把功能文档的验收项和正在跑的 V1 每个阶段的内容列成清单，画完逐项打勾；外壳只决定东西放在哪、长什么样，内容一样不能少。窄栏放摘要，完整阅读在主区展开。清单样例 `docs/evidence/2026-10-12-f311-northstar-gap/README.md`。
13. **重画或压缩一个面之前，先把它已经定下的规则取出来**（2026-10-12：v3 稿把 10-06 定的「正在发生」写法压掉了，You 两天后在真页面上撞到，`[thread-id]#private-source-id`）：从本文件、对应北极星 README、F322 已定表里，把这个面所有「You 定」「用了真页面以后改」的条目抄成清单，写在新稿 README 里，逐条打勾。要删或要改其中一条，单独写出来请 You 拍，不夹在整张新稿里一起过。对稿也拿这份清单对，不只对最新那张稿。
14. **稿子里每个「去那里」都要指到一张画好的 v2 稿**（同日：「全部 ›」接到了 v1 页，「请猫修改」弹出 v1 表单）：「全部 ›」「打开」「在原处打开」「完整版」这类入口，指向的页面必须已经有 v2 稿。没有就当场画，或者在稿里写明「这一步还没设计」，不能留给实现方去接现成的 v1。

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
