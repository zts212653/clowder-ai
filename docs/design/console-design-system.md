# Console Design System

> Cat Cafe Console 的视觉语言规范。所有前端组件必须遵循本文档。
> 参考系：macOS System Settings + Linear + Vercel Dashboard

## 1. 设计原则

### 1.1 层次通过背景色建立，不通过边框

**核心规则**：同层内容用背景色区分，跨层才加边框。

```
窗口背景 (--console-shell-bg)
  └─ 面板背景 (--console-panel-bg)        ← 无边框，靠色差
      └─ 卡片背景 (--console-card-bg)     ← 无边框，靠色差
          └─ 内嵌区域 (--console-card-soft-bg) ← 无边框，靠色差
```

**Inset Paper 页面模型**：
- Chat 使用三层：Activity Rail(L1) → Thread Sidebar(L2) → Chat Workspace(L3)。
- Mission Hub / Signal / Memory / Settings 不显示 Thread Sidebar，但仍必须保留三层深度：Activity Rail(L1) → 页面基底(L2) → 内容纸张(L3)。
- 非 Chat L1 页面不能从 Rail 直接跳到最亮的 Workspace 背景；App Body 使用 `--console-panel-bg`，内容 Workspace 使用 `--console-shell-bg` + 圆角 + 极轻阴影。
- L2 与 L3 之间保留 8-12px 呼吸间隙，靠色块渐变衔接，不加硬边框。

**何时加边框**：
- 列表项之间的分隔线（仅 `border-b`，用 `--console-border-soft`）
- 输入框/表单控件的边界
- 需要用户注意的区域边界（警告/错误卡片）
- 拖拽区域的虚线边框

**何时不加边框**：
- 卡片与面板之间 — 用背景色差
- 导航栏与内容区之间 — 用背景色差
- 统计卡片/指标卡片 — 用背景色填充 + 圆角
- 标签页/分段控件 — 用激活态背景色

### 1.2 留白即层次

- 组件之间用 `gap` 而非边框分隔
- 标准间距阶梯：`4px` / `8px` / `12px` / `16px` / `24px` / `32px`
- 面板内边距：`16px`（紧凑） / `24px`（标准）
- 卡片内边距：`12px`（紧凑） / `16px`（标准）

### 1.3 克制的圆角

- 面板/大容器：`12px`（`rounded-xl`）
- 卡片/中型容器：`10px`（`rounded-[10px]`）
- 按钮/输入框：`8px`（`rounded-lg`）
- 标签/徽章：`6px`（`rounded-md`）
- 头像/图标容器：`full`（`rounded-full`）

### 1.4 动效克制

- 过渡时间：`180ms ease`（标准） / `120ms`（微交互）
- 入场动画：仅面板级，`translateY(8px) → 0`，`200ms`
- 禁止：弹跳、旋转、闪烁（游戏模式除外）

---

## 2. Token 使用规则

### 2.1 背景色

| 层级 | Token | Tailwind | 用途 |
|------|-------|----------|------|
| 窗口 | `--console-shell-bg` | CSS 直接引用 | 最外层壳 |
| 面板 | `--console-panel-bg` | `bg-[var(--console-panel-bg)]` | 侧边栏、主内容区 |
| 卡片 | `--console-card-bg` | `bg-[var(--console-card-bg)]` | 独立信息块、设置项分组 |
| 内嵌 | `--console-card-soft-bg` | `bg-[var(--console-card-soft-bg)]` | 卡片内的子区域、代码块 |
| 凹陷 | `--console-code-bg` | `bg-[var(--console-code-bg)]` | 输入框内部、代码预览 |
| 强调 | `--console-active-bg` | `bg-[var(--console-active-bg)]` | 当前选中项 |
| 悬停 | `--console-hover-bg` | `bg-[var(--console-hover-bg)]` | 悬停反馈 |
| 药丸 | `--console-pill-bg` | `bg-[var(--console-pill-bg)]` | 标签、徽章 |

**禁用列表**：
- `bg-white` — 用 `bg-cafe-surface` 或 `bg-[var(--console-card-bg)]`
- `bg-gray-*` — 用对应的 console token
- `bg-cafe-surface-elevated` 作为卡片背景 — 用 `--console-card-bg`（它已经基于 elevated 混合）

### 2.2 边框

| 场景 | Token | Tailwind |
|------|-------|----------|
| 列表分隔线 | `--console-border-soft` | `border-b border-[var(--console-border-soft)]` |
| 表单控件边框 | `--console-border-soft` | `border border-[var(--console-border-soft)]` |
| 强分隔（罕见） | `--console-border-strong` | `border border-[var(--console-border-strong)]` |

**禁用列表**：
- `border-cafe` / `border-cafe-subtle` 在新世界组件中 — 用 console token
- `border` 不带颜色指定 — 必须显式指定 console token
- 卡片四周加边框 — 改用背景色 + 圆角

### 2.3 文字

| 层级 | Token | Tailwind |
|------|-------|----------|
| 主文字 | `--cafe-text` | `text-cafe` |
| 次要文字 | `--cafe-text-secondary` | `text-cafe-secondary` |
| 弱化文字 | `--cafe-text-muted` | `text-cafe-muted` |
| 强调色文字 | `--cafe-accent` | `text-cafe-accent` |

### 2.4 阴影

- 面板/弹层：`--console-shadow`
- 悬浮卡片：`--console-shadow-soft`
- 普通卡片：**不加阴影**（靠背景色差区分）

---

## 3. 组件模式

### 3.1 设置项分组（macOS grouped list）

```
┌─────────────────────────────────────────┐  ← console-card-bg, rounded-xl
│  标题行                    操作按钮      │  ← 16px padding
│─────────────────────────────────────────│  ← border-b console-border-soft
│  设置项 A          [开关/值]            │
│─────────────────────────────────────────│  ← border-b console-border-soft
│  设置项 B          [开关/值]            │
│─────────────────────────────────────────│  ← border-b console-border-soft
│  设置项 C          [开关/值]            │  ← 最后一项无 border-b
└─────────────────────────────────────────┘
```

- 外部容器：`bg-[var(--console-card-bg)] rounded-xl`
- 项与项之间：`border-b border-[var(--console-border-soft)]`
- 最后一项：无 border-b
- 组与组之间：`gap-6`（24px）

### 3.2 统计卡片

```
┌──────────────┐  ← console-card-bg, rounded-xl, NO border
│  数值  12     │
│  标签  在线    │  ← text-cafe-secondary
└──────────────┘
```

- 纯背景色填充，**无边框**
- 数值：`text-xl font-semibold`
- 标签：`text-sm text-cafe-secondary`

### 3.3 列表行（Signal/Memory/Thread 列表）

```
┌─────────────────────────────────────────┐
│  [图标]  标题              时间戳        │  ← hover:bg-[var(--console-hover-bg)]
│          摘要文字...                     │
├─────────────────────────────────────────┤  ← border-b console-border-soft
│  [图标]  标题              时间戳        │
│          摘要文字...                     │
└─────────────────────────────────────────┘
```

- 行内无边框，行间用 `border-b`
- hover 态：`bg-[var(--console-hover-bg)]`
- 选中态：`bg-[var(--console-active-bg)]`

### 3.4 搜索框

```
┌──────────────────────────────────────┐
│  🔍  搜索内容...                      │  ← console-card-soft-bg, rounded-lg
└──────────────────────────────────────┘
```

- 背景：`bg-[var(--console-card-soft-bg)]`
- 边框：`border border-[var(--console-border-soft)]`（仅 focus 时加深为 `--console-border-strong`）
- 宽度：跟随内容区域，**不超过 400px**
- 禁止：满宽搜索框、强调色按钮紧贴搜索框

### 3.5 按钮

| 类型 | 样式 | 用途 |
|------|------|------|
| 主要 | `console-button-primary` | 唯一主操作（每个视图最多 1 个） |
| 次要 | `console-button-secondary` | 辅助操作 |
| 幽灵 | `console-button-ghost` | 工具栏、紧凑操作 |

- 主按钮：`bg-cafe-accent text-cafe-accent-foreground rounded-lg px-4 py-2`
- 次按钮：`bg-[var(--console-card-bg)] border border-[var(--console-border-soft)] rounded-lg px-4 py-2`
- 幽灵：`hover:bg-[var(--console-hover-bg)] rounded-lg px-3 py-1.5`

### 3.6 标签/徽章

- 背景：`bg-[var(--console-pill-bg)] rounded-md px-2 py-0.5`
- 状态标签：使用 `console-status-chip` 的 data-status 变体
- 字号：`text-xs`

### 3.7 对话气泡

- 用户消息：右对齐，`bg-cafe-accent text-white`，圆角 `[12,12,4,12]`
- 猫猫回复：左对齐，`bg-[var(--console-card-bg)]`，圆角 `[12,12,12,4]`
- 猫猫头像：28px 圆形，左侧 bottom-aligned
- 气泡最大宽度 70%
- 时间戳 `text-[10px]`，用户消息 `rgba(255,255,255,0.7)`，猫猫消息 `text-cafe-muted`
- Chat 工具入口（下载、语音、发送等）放在底部输入区工具组；Thread Header 只保留 thread 标题和当前猫/上下文切换。
- 右侧 Inspector 是一个 L2 槽位，不堆叠独立白卡；状态、统计、健康信息使用 soft chips / rows 直接排布。

### 3.8 连接器卡片（纵向列表）

- 图标容器 40×40 + `rounded-[10px]` + 品牌色背景
- 名称 `text-sm font-medium` + 状态文字（在线/未配置）
- 一行一个卡片，水平排列 `gap-4`，无边框，`console-card-bg` 背景
- 添加卡片：虚线边框 `border-dashed` + `console-border-soft` + `+` 图标

### 3.9 配置项（统一模式）

三种配置 UI 共用同一模式：`card-bg` 卡片 + `border-b` 分隔 + 左标签右控件。

| 配置类型 | 左侧 | 右侧控件 |
|---------|------|---------|
| 环境变量 | Key 名 + 权限徽章(敏感/可见) | 值（遮蔽或明文），行内编辑 |
| 功能开关 | 标签 + 描述 | Toggle / Dropdown |
| 只读状态 | 标签 | 数值 / 时间 / 状态徽章 |

### 3.10 可折叠面板（手风琴）

- 收起态：箭头(chevron-right) + 标题 + 类型徽章 + 状态徽章
- 展开态：箭头(chevron-down) + 详情区域 `console-card-soft-bg` 内嵌
- 行间 `border-b` 分隔

### 3.11 输入表单

**基础控件**：
- 输入框：`console-code-bg` + `border border-[var(--console-border-soft)]` + `rounded-lg`
- Focus 态：`border-[var(--console-border-strong)]`
- 下拉选择：同输入框样式 + chevron-down 图标
- 多行文本：同输入框，高度按内容
- 标签输入：`console-pill-bg` + `border-soft` 药丸 + "添加" 文字按钮
- 底部操作栏：右对齐，取消(Secondary) + 确认(Primary)

**动态列表**（参数/环境变量等可增删项）：
- 每项一行：输入框 + 🗑 删除图标
- Key-Value 对：两个等宽输入框并排 + 🗑 删除
- 添加按钮：`console-card-soft-bg` + 满宽 + "+ 添加xxx" 居中
- 删除图标：`text-cafe-muted`，hover 变 `text-error`

### 3.12 空状态

- 居中图标 + 标题 + 描述
- 图标：`text-cafe-muted`，32px
- 标题：`text-lg font-medium text-cafe`
- 描述：`text-sm text-cafe-secondary`
- 可选操作按钮：次要按钮样式

### 3.13 系统通知（对话内嵌）

对话流中偶尔出现的系统级提示，与常规消息气泡不同：居中显示、无头像、带语义色。

**三种 tone：**

| Tone | 场景 | 标签色 | 图标色 | 边框色 | 背景色 |
|------|------|-------|-------|-------|-------|
| info | 功能提示、状态变更 | `--notice-info-label` | `--notice-info-icon` | `--notice-info-border` | `cafe-surface 90%` |
| warning | 降级、配额接近 | `--notice-warning-label` | `--notice-warning-icon` | `--notice-warning-border` | `cafe-surface 90%` |
| error | 失败、中断 | `--notice-error-label` | `--notice-error-icon` | `--notice-error-border` | `--notice-error-surface 90%` |

**布局结构：**

```
          ┌─ 来源标签  时间戳 ──────────────────┐
          │  🔔  通知正文 (Markdown)             │
          └──────────────────────────────────────┘
```

- 居中对齐 `flex justify-center`，`max-w-[85%]`
- 标签行：来源名 `notice-label` 色 + 时间 `text-cafe-muted`
- 主体：`rounded-2xl` + `border notice-border` + `bg notice-surface 90%`
- 图标 + 正文水平排列，图标 `4.5×4.5`
- 入场动画：slide-up + fade-in（respects `prefers-reduced-motion`）
- 特化通知（如自动索引）应复用同一 notice token，不硬编码色值

---

## 4. 页面布局模式

### 4.0 全局 App Shell

页面分为两类：**对话页**（Chat）和**L1 工作页**（Mission Hub / Signal / Memory / Settings）。

对话页布局（保留 Thread Sidebar）：
```
┌──────┬──────────────┬────────────────────────────────────────┐
│ L1   │ Thread       │ 当前工作区                               │
│ Rail │ Sidebar      │ Chat                                    │
└──────┴──────────────┴────────────────────────────────────────┘
```

L1 工作页布局（Mission Hub / Signal / Memory / Settings 覆盖 Thread Sidebar，只保留 L1 Rail）：
```
┌──────┬───────────────────────────────────────────────────────┐
│ L1   │ Mission / Signal / Memory / Settings Workspace          │
│ Rail │ 任务队列 / 内容区 / tabs / Settings 二级导航              │
└──────┴───────────────────────────────────────────────────────┘
```

**硬约束**：
- Activity Bar (L1 Rail) 在所有页面常驻，宽度固定，不卸载。
- Activity Bar 顺序：Chat / Mission Hub / Signal / Memory / Settings。
- Mission Hub 是实时任务中心，Activity Bar 中可显示轻量任务 badge；badge 不改变 rail 宽度。
- 亮/暗色切换属于全局 rail 操作，固定放在 Settings 图标上方；不进入页面内容区。
- 对话页：Thread Sidebar 常驻，用于 thread / 主会话。
- L1 工作页：`/mission`、`/signals`、`/memory`、`/settings` 都覆盖 Thread Sidebar 区域，只保留 L1 Rail。
- Mission Hub 是任务管理一级页，不放在 Thread Sidebar，也不作为 Chat 的子视图。
- Signal / Memory 的 tab 与筛选器只存在于 workspace 内；Settings 的二级导航直接紧邻 L1 Rail。
- 面板之间仍遵循 §1：靠背景色和间距建立层级，不加 `border-r` / `border-l`。

**允许变化**：
- Activity Bar 当前图标的 active 背景可以随 L1 tab 切换，但尺寸、位置和 rail 宽度不能变化。
- Top Bar 已移除；页面工具入口必须下沉到对应 workspace 内，不能依赖全局横条。
- Workspace 内部可以根据页面需要使用双栏、列表+详情、设置二级导航或右侧详情面板。

### 4.1 设置页（双栏，系统级）

```
┌──────────────── L1 Rail 右侧全宽 ────────────────────────────┐
│ Settings Nav │  内容区                                         │
│ 分类列表      │  ┌────────────────────────────────────────────┐ │
│ 220px        │  │ 标题 + 描述                                  │ │
│              │  ├────────────────────────────────────────────┤ │
│              │  │ 设置项分组 A                                 │ │
│              │  ├────────────────────────────────────────────┤ │
│              │  │ 设置项分组 B                                 │ │
│              │  └────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

- Settings Nav：`bg-[var(--console-panel-bg)]`，无右边框，宽度 220px，紧邻 L1 Rail
- 内容区：`bg-[var(--console-shell-bg)]` 或同色
- 分组间距：`gap-6`

### 4.2 列表页（Signal Inbox / Memory Feed）

```
┌──────────────────────────────────────────┐
│  导航栏  [tab1] [tab2]    [搜索框]        │
├──────────────────────────────────────────┤
│  列表行 1                                 │
│  列表行 2                                 │
│  列表行 3                                 │
└──────────────────────────────────────────┘
```

- 导航栏：与内容区同背景，tab 用背景色区分激活态
- 搜索框：右对齐，最大宽度 400px
- 列表：行间 `border-b`，无外框

### 4.3 详情页

```
┌──────────────────────────────────────────┐
│  ← 返回   标题                            │
├──────────────────────────────────────────┤
│  主内容区域                               │
│  ┌────────────────────────────────────┐  │
│  │ 卡片分组                            │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

### 4.4 信号收件箱（列表+详情双栏）

```
┌──────────────────────────────────────────────────────┐
│ 信号        [收件箱] [信号源]                          │
│ [🔍 搜索…  ] [全部状态 ▾] [全部来源 ▾]               │
├────────────────────┬─────────────────────────────────┤
│ 列表行 (active-bg) │  标题                            │
│─────────────────── │  来源 · 日期 · Tier 标签         │
│ 列表行              │  [收藏] [已读] [研读]            │
│─────────────────── │  ────────────────────           │
│ 列表行              │  文章正文内容…                    │
└────────────────────┴─────────────────────────────────┘
```

- 标题 + Tab 切换在同一行
- 搜索 + 筛选器合并为第二行（搜索框 `max-w-[240px]` + 下拉药丸）
- 去掉独立搜索按钮（Enter 触发）
- 左侧列表复用 §3.3 列表行模式
- 右侧详情面板用 `panel-bg` 背景色差区分

---

## 5. 交互模式

### 5.1 决策规则

| 场景 | 交互模式 | 判定标准 |
|------|---------|---------|
| 简单实体新增/编辑（API Key、Skill、IM、插件） | **弹窗** | 字段 ≤5，无复杂子组件 |
| MCP 新增/编辑 | **专用配置弹窗** | 支持 command/http 两种配置形态，含动态参数、环境变量和工作目录 |
| 复杂实体新增/编辑（成员） | **全页表单** | 字段 >5，含头像/颜色/折叠面板等 |
| 只读详情展示（MCP 工具列表） | **展开详情** | 不涉及编辑 |
| 单值切换/单字段编辑 | **直接操作** | Toggle、下拉、行内编辑 |
| 删除/撤销等不可逆操作 | **弹窗确认** | 红色警告 + 输入确认 |

### 5.2 弹窗规范

- 遮罩层 `rgba(0,0,0,0.3)`
- 卡片 `console-card-bg` + `rounded-xl` + `console-shadow`
- 标题 `text-lg font-semibold`
- 底部按钮右对齐：取消(Secondary) + 确认(Primary)
- 危险弹窗：红色图标 + 红色标题 + 影响说明 + 红色确认按钮 + Enter 快捷确认（无需输入名称）

### 5.3 MCP 配置弹窗

MCP 弹窗不是普通 4 字段编辑框，必须按服务类型呈现对应配置面板：

- 顶部：大标题 `更新/新增 {Name} MCP` + 说明文字；右上角危险操作用浅红底 `卸载` 按钮。
- 新增 MCP 时先选择类型：`stdio` / `httpstream` 可切换。
- 编辑 MCP 时类型不可切换；同一弹窗根据当前类型展示固定字段。
- `stdio` 型：启动命令、参数列表、环境变量 Key/Value、环境变量传递、工作目录。
- `httpstream` 型：URL、Bearer 令牌环境变量、标头 Key/Value、来自环境变量的标头 Key/Value。
- 动态列表：输入框 + 删除图标；添加按钮使用 `console-card-soft-bg` 满宽居中。
- 保存按钮位于右下角；无变更时可禁用为灰色。

### 5.4 全页表单规范

- 面包屑导航顶部
- 分区用标题 + 描述分组（如"身份信息"/"认证与模型"）
- 罕用设置折叠（Voice Config 等）
- 底部操作栏固定：取消(Secondary) + 保存(Primary)，右对齐

### 5.5 行内编辑

- 点击值区域 → 变成输入框（`console-code-bg` + `border-strong`）
- Enter 保存，Esc 取消
- 不弹窗、不打断流程

---

## 6. 反模式清单（Don'ts）

| 反模式 | 正确做法 |
|--------|---------|
| 卡片四周加 `border` | 用 `bg-[var(--console-card-bg)] rounded-xl` |
| 满宽强调色按钮 | 按钮定宽 `w-auto`，右对齐或居中 |
| 面板间加 `border-r` / `border-l` | 用背景色差区分 |
| 统计卡片加边框 | 用背景色填充 |
| 搜索框 100% 宽度 | `max-w-[400px]` |
| 用 `bg-white` / `bg-gray-100` | 用 console token |
| Feature ID 出现在 UI 上（如 "F127"） | 用用户可理解的功能名 |
| 同一页面混用框线卡片和无框线卡片 | 全部统一为无框线 |
| `border-cafe` / `border-cafe-subtle` 在新组件中使用 | 用 `border-[var(--console-border-soft)]` |
| 术语不一致（混用"会话"/"对话"/"thread"指代同一概念） | 按 §6 术语表：thread="对话"，session="会话"，不混用 |

---

## 7. 术语规范

| 内部术语 | 用户面展示 | 说明 |
|---------|----------|------|
| thread | 对话 | 持久化的对话上下文，用户日常交互的主单元 |
| session | 会话 | 猫的一次唤醒周期，技术概念，用户面少用 |
| signal | 信号 | — |
| memory / knowledge | 记忆 | — |
| mission / task hub | Mission Hub / 任务 | 任务管理一级入口 |
| settings | 设置 | — |
| connector | 连接器 | — |
| worktree | 工作区 | — |
| MCP | MCP 服务 | — |
| skill | 技能 | — |
| cat / agent | 猫猫 / 助手 | — |

---

## 8. 自检清单

每次提交前端代码前对照：

- [ ] 没有新增 `border-cafe` / `border-cafe-subtle`（用 console token）
- [ ] Chat 保留 Thread Sidebar；Mission Hub / Signal / Memory / Settings 不显示 Thread Sidebar
- [ ] 非 Chat L1 页面遵循 Inset Paper：Rail(L1) → 页面基底(L2) → 内容纸张(L3)，不得直接 Rail → L3
- [ ] Chat 下载、语音等工具入口在 Chat workspace 内可见，不依赖全局 Top Bar
- [ ] Mission Hub 作为 L1 工作页出现在 Activity Bar，不放入 Thread Sidebar
- [ ] 亮/暗色切换固定在 Activity Rail 底部、Settings 上方
- [ ] IM / MCP / Skill / 插件页使用纵向卡片列表（一行一个），点击卡片进入新增/编辑同款弹窗
- [ ] MCP 弹窗区分 stdio/httpstream 配置形态；新增可切换类型，编辑不可切换类型
- [ ] 卡片容器用背景色而非边框
- [ ] 同一视图内视觉元素风格一致
- [ ] 无 Feature ID / 内部标识暴露给用户
- [ ] 搜索框宽度不超过 400px
- [ ] 每个视图最多 1 个主按钮
- [ ] hover/active 状态使用 console token
- [ ] 文字层级不超过 3 级（主/次/弱）
- [ ] 术语符合第 7 节规范
- [ ] 深色模式下通过 token 自动适配（不硬编码颜色）
- [ ] 配置类 UI 统一使用 §3.9 模式（环境变量/功能开关/只读状态同一视觉）
- [ ] CRUD 交互模式符合 §5.1 规则（简单弹窗/复杂全页/单值直接操作）
- [ ] 输入表单控件统一使用 §3.11 样式
