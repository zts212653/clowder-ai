# Thread Progress Visual Gate — Demo Contract

## 0. 一句话契约

- **Demo 名称**：聊天优先的 Thread 会话进度三级开合
- **demo_kind**：`product_experience_gate`
- **目标观众**：co-creator 与 Clowder AI 产品/工程伙伴
- **使用场景**：内部对齐、视觉签字、实现前体验 Gate
- **这个 Demo 要作出的判断**：看完后，co-creator 能决定“单行收起 + 双行摘要 + 右侧完整时间线”应 keep、tune 或 sunset。
- **最小可见证据**：同一真实 Chat 壳中，进度始终可召回；收起后只占 40px，摘要不超过 88px，右栏关闭后聊天宽度完整恢复。
- **观众复述句**：我看到进度从挤占聊天的大面板变成了可收起、可召回的薄层，因为完整历史只在需要时进入现有 Workspace。
- **主 claim**：聊天仍是主画面；进度只占所需空间，但“谁在做 / 是否需要我”永远不消失。
- **非目标**：不验证后端数据、事件 producer、领域模型或正式组件实现。

## 1. 判题类型、交付车道与视觉真相

- **delivery_lane**：`internal_product_gate`
- **交付位置**：当前 thread 中的 PNG 画布 + Workspace 内可打开的本地 HTML 原型
- **visual_source_of_truth**：
  - `packages/web/src/components/AppShell.tsx`
  - `packages/web/src/components/ActivityBar.tsx`
  - `packages/web/src/components/ChatContainer.tsx`
  - `packages/web/src/components/ChatContainerHeader.tsx`
  - `packages/web/src/components/workspace/ContextualWorkspaceChrome.tsx`
  - `packages/web/src/app/theme-tokens.css`
  - `packages/web/src/app/console-tokens.css`
- **native_elements**：52px Activity Bar、240px Thread Sidebar、Chat header/message/input、右侧 Contextual Workspace、移动端覆盖式抽屉。
- **stylized_elements**：演示文案、进展卡、时间线事件与“功能原型·演示数据”角标。
- **dev_controls**：只存在于 `index.html` 顶部的状态切换器，画布 SVG 内不放开发控制。
- **truth_label**：每张画布右下角标明“功能原型 · 演示数据”。

### Internal product gate 自检

- [x] 去掉开发控制后仍像 Clowder AI 的自然部分
- [x] 从真实三栏 Chat/Workspace 壳和 token 开始，没有另造 SaaS 控制台
- [x] Demo 控制与产品画面分层
- [x] 包含安静态、主动作、折叠/召回、等待用户、移动恢复
- [x] Must-Preserve 覆盖聊天宽度、输入框、消息滚动、Workspace 关闭恢复与移动全屏语义

## 2. 视角与判题变量

- **视角**：工作台 / 用户视角
- **主角**：co-creator 的长期会话
- **受益者 / 操作者 / 裁判**：co-creator
- **规约 owner**：co-creator 已确认的“聊天优先、三级开合”规则

| 待裁决变量 | A | B | C | 固定上下文 | 判题 |
|---|---|---|---|---|---|
| 进度占用高度 | 单行 40px | 摘要 84px | 右栏完整时间线 | 同一 Chat、同一消息、同一输入框 | 可见性与聊天空间是否平衡 |
| 完整进展承载方式 | 宽桌面 dock | 窄桌面 overlay | 移动全屏 | 同一时间线内容与关闭语义 | 聊天内容宽度不得低于 640px |

## 3. 信号路径

```text
真实 ThreadBrief → 会话头部薄卡 → 用户选择展开 → 现有 Contextual Workspace → 关闭后恢复聊天宽度
```

原型只演示 UI 状态；不声称 ThreadBrief API 或 progress producer 已实现。

## 4. 诚实边界

| 画面 / 行为 | 概念编排 | 功能原型 | 真实证据 | 标注 |
|---|:---:|:---:|:---:|---|
| 三级开合和布局 |  | ✓ |  | 功能原型 |
| Cafe 三栏比例与色彩 |  |  | ✓（来自当前源码/token） | 原生视觉基线 |
| 猫、进展、时间线数据 | ✓ |  |  | 演示数据 |
| 偏好持久化、API、实时状态 |  |  |  | 本 Demo 未连接后端 |

## 5. 灵魂画面

- **灵魂画面**：桌面右侧完整进展打开态。
- **画面左侧**：聊天仍保留足够阅读宽度，顶部进度折回 40px 单行。
- **画面右侧**：完整时间线在现有 Workspace 中展开，关闭按钮清晰。
- **观众应说**：完整进度出来了，但聊天没有被永久挤小；关掉就能全部还给聊天。

## 6. 场景与画布

| # | 画布 | 尺寸 | 判题证据 |
|---:|---|---:|---|
| 1 | 桌面·收起态 | 1440×900 | 40px 单行保留 actor 与 needs-user |
| 2 | 桌面·摘要态 | 1440×900 | 84px 双行，五秒读懂且消息区稳定 |
| 3 | 桌面·完整进展 | 1440×900 | 右侧 Workspace 打开，聊天仍可读，关闭可恢复 |
| 4 | 全局·近况 | 1440×900 | Activity Bar 原生入口与 ThreadBrief 紧凑卡 |
| 5 | 移动·收起态 | 390×844 | 40px 单行，Chat 优先 |
| 6 | 移动·全屏进展 | 390×844 | 全屏抽屉、清晰关闭与上下文恢复 |
| 7 | 窄桌面·覆盖进展 | 1024×768 | dock 后聊天不足 640px 时改为 overlay；聊天保持原宽度与滚动位置 |

## 6.1 响应式承载规则

按实际可用聊天宽度判定，不写死单一 viewport breakpoint：

```text
dockedResidualChatWidth = contentHostWidth - requestedPanelWidth

if dockedResidualChatWidth >= 640px:
  完整进展使用右侧 dock
else if viewportWidth >= mobileBreakpoint:
  完整进展使用覆盖式 drawer，不改变 Chat flex-basis / width / scroll position
else:
  完整进展使用移动全屏 drawer
```

- 1440×900、默认 52px rail + 240px sidebar + 420px panel：聊天约 728px，允许 dock。
- 1024×768、同样结构：若 dock 只剩约 312px，因此必须 overlay。
- sidebar 调宽、折叠或 Workspace panel 调宽时仍按实际剩余宽度重新判定。
- 模式切换只改变 Workspace 的承载方式，不重新创建时间线、不改变 Chat 消息布局。

## 7. Must-Preserve

- 不随滚动自动开合，不产生消息区跳动。
- needs-user 只高亮，不强制展开。
- 收起偏好由用户动作触发；原型仅展示状态，不模拟持久后端。
- 完整时间线使用现有 Workspace；不是永久第四栏。
- dock 后聊天内容宽度不足 640px 时必须切换为覆盖式 drawer，禁止继续挤压聊天。
- overlay 打开不改变 Chat 的 flex-basis、内容宽度或 scroll position；关闭后恢复原聊天画面。
- overlay 的 scrim 拦截底层点击，焦点限制在 drawer 内，并支持 Escape 与明确关闭按钮；遮挡期间底层输入区不可交互。
- 移动端完整进展覆盖全屏；关闭回到原 Chat 滚动位置。
- 不重复展示原 ThreadExecutionBar。

## 8. 验证

- 画布尺寸由 SVG `viewBox` 固定。
- `verify_prototype.py` 检查七张画布、尺寸、40px/84px 核心高度、640px dock/overlay 断点 metadata、truth label 和 HTML 入口。
- 每张 SVG 渲染为 PNG 后逐张视觉检查。
- 目标复述：三级开合让进度可见，但不牺牲聊天主空间。
