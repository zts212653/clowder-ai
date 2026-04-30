---
name: console-dev
description: >
  Console 前端开发流程管控：设计语言对齐 → 效果图确认 → Token 合规开发 → 视觉自检。
  Use when: 开发/修改 Console 前端页面、组件、样式；修复 UI 不一致问题；新增页面或重构布局。
  Not for: 纯后端 API 开发、纯逻辑/hook 重构（无视觉变化）、游戏模式 UI（werewolf-cute 有独立 token）。
  Output: 符合 Design System 规范的前端代码 + 视觉自检通过。
triggers:
  - "console"
  - "前端"
  - "UI"
  - "页面"
  - "样式"
  - "布局"
  - "设计"
  - "border"
  - "框线"
---

# Console Dev — 前端开发流程管控

## 核心文档

**必读**：`docs/design/console-design-system.md` — Console 视觉语言规范（Token 规则、组件模式、反模式清单）。

每次开工前先读一遍 Design System 的自检清单（第 7 节）。

## SOP 位置

```
有视觉变化的前端改动：需求确认 → **console-dev** → worktree → tdd → quality-gate → request-review
无视觉变化的前端逻辑改动：需求确认 → worktree → tdd（跳过 console-dev）
```

## 流程

### Step 0: 确认影响面

1. 这次改动涉及哪些页面/组件？
2. 是新增页面、修改现有页面、还是视觉统一刷新？
3. 列出受影响的文件清单

### Step 1: 设计对齐

**新增页面/大幅改动**：
1. 读 `docs/design/console-design-system.md` 确认适用的页面布局模式（§4）
2. 用 Pencil 出效果图，标注使用的 Token 和组件模式
3. 铲屎官确认效果图 → 再动手写代码
4. 如果铲屎官不在线，截图发到 thread 留存并**等待确认，不得继续进入实现**

**小幅修改/Bug 修复**：
1. 确认改动符合 Design System 中的哪条规则
2. 无需出图，直接动手

**视觉统一刷新**：
1. 全局 grep 待替换的模式（如 `border-cafe`、`bg-white`）
2. 按 Design System 反模式清单（§5）逐条扫描
3. 批量替换，逐文件验证

### Step 2: Token 合规开发

写代码时的硬规则：

| 场景 | 正确用法 | 禁用 |
|------|---------|------|
| 卡片背景 | `bg-[var(--console-card-bg)]` | `bg-white`, `bg-gray-*`, `bg-cafe-surface-elevated` |
| 面板背景 | `bg-[var(--console-panel-bg)]` | `bg-cafe-surface` 单独使用 |
| 边框 | `border-[var(--console-border-soft)]` | `border-cafe`, `border-cafe-subtle` |
| 悬停 | `hover:bg-[var(--console-hover-bg)]` | `hover:bg-gray-*` |
| 选中 | `bg-[var(--console-active-bg)]` | `bg-blue-*`, `bg-amber-*` 做选中态 |
| 搜索框宽度 | `max-w-[400px]` | `w-full` 无限制 |

**边框决策树**：
```
需要视觉分隔？
├─ 同层内容 → 用背景色差（不加边框）
├─ 列表项之间 → border-b + console-border-soft
├─ 表单控件 → border + console-border-soft
└─ 其他 → 大概率不需要边框，三思
```

### Step 3: 视觉自检

代码写完后，逐条对照 Design System §7 自检清单：

```
□ 没有新增 border-cafe / border-cafe-subtle
□ 卡片容器用背景色而非边框
□ 同一视图内视觉元素风格一致
□ 无 Feature ID / 内部标识暴露给用户
□ 搜索框宽度不超过 400px
□ 每个视图最多 1 个主按钮
□ hover/active 状态使用 console token
□ 文字层级不超过 3 级
□ 术语符合规范
□ 深色模式自动适配
```

### Step 4: 浏览器验证

1. 启动 dev server（`pnpm dev`）
2. 用 browser-preview 或 Chrome MCP 打开页面
3. 检查：
   - 光看页面 3 秒，感觉"干净"还是"杂乱"？
   - 有没有视觉上"突兀"的元素（不一致的边框、异常的颜色、过大的按钮）？
   - 切换深色模式，token 是否自动适配？
4. 截图留存

### Step 5: 提交

- commit message 标注涉及的组件/页面
- 如果是视觉统一刷新，列出替换统计（如 "border-cafe → console-border-soft: 23 处"）

## 常见场景速查

### "这个组件要不要加边框？"

大概率不要。先试试只用背景色 + 圆角 + 间距，看起来够不够清晰。
如果内容确实混在一起无法区分 → 加 `border-b` 分隔线（不是四周边框）。

### "这个颜色用什么 token？"

1. 先查 Design System §2 的 Token 使用规则表
2. 没找到 → 查 `theme-tokens.css` 的语义 token
3. 还没有 → 停下来，在 Design System 里新增定义后再用

### "铲屎官说'不够高级'"

通常意味着以下一项或多项：
- 边框太多 → 替换为背景色
- 间距太紧 → 增加 padding/gap
- 元素不统一 → 逐个对齐到组件模式
- 颜色不协调 → 检查是否混用了硬编码色和 token

### "我要加一个新页面"

1. 确认属于哪个布局模式（§4：双栏设置/列表页/详情页）
2. 用 Pencil 出效果图
3. 铲屎官确认
4. 按 Token 规则开发
