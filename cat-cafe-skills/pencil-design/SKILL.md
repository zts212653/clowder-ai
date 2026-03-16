---
name: pencil-design
description: >
  使用 Pencil MCP 创建/编辑 .pen 设计文件，或导出为 React 代码。
  Use when: 设计 UI、编辑 .pen 文件、从设计稿生成代码。
  Not for: 纯代码实现（无设计稿）、非 Pencil 工具的设计工作。
  Output: .pen 设计文件 或 React/Tailwind 组件代码。
triggers:
  - "pencil"
  - ".pen 文件"
  - "设计稿"
---

# Pencil Design — .pen 文件设计与代码导出

## 核心知识

Pencil 是装在 **Antigravity IDE** 上的设计扩展。
.pen 文件是加密格式，**只能通过 Pencil MCP 工具读写**，Read/Grep/cat 无法解析。

配置要求：MCP 配置必须加 `--app antigravity`（不是默认 IDE）。

## SOP 位置

```
feat-lifecycle → Design Gate → **pencil-design** → writing-plans → worktree → tdd
```

pencil-design 在 **spec 确认后、写代码前**。先把 UX 做对，再动手写代码。

## 🔴 风格一致性门禁（Style Consistency Gate）

**这是最重要的规则。** 在创建任何新设计之前，必须完成以下步骤：

### Step 1: 分析现有 UI

如果要设计的功能是**已有产品的扩展**（如给 Mission Hub 加新 Tab）：

1. **截图现有 UI** — 用 Read 工具查看产品截图，或在浏览器中截图
2. **提取风格特征** — 记录以下 token：
   - 配色方案（背景色、主色、强调色）
   - 布局模式（列表/卡片/详情面板、Tab 结构）
   - 间距和圆角
   - 字体层级
3. **写入设计约束** — 在 batch_design 前明确："延续 X 风格"

### Step 2: 判断设计类型

| 类型 | 做法 | 例子 |
|------|------|------|
| **扩展现有产品** | 必须复用现有风格，作为现有界面的自然延伸 | 给 Mission Hub 加 Tab |
| **全新独立产品** | 可以用 `get_style_guide_tags` + `get_style_guide` 探索新风格 | 新的独立工具 |
| **重新设计** | 先对比旧设计和新方向，铲屎官确认后再动手 | 产品改版 |

### Step 3: 风格验证

设计完成后，`get_screenshot` 截图，然后**和现有 UI 截图并排对比**：
- 配色一致？
- 布局语言一致（Tab/列表/详情面板）？
- 不会让用户觉得"换了个产品"？

**踩坑教训 (F076)**：给 Mission Hub 做面板时用了深色 command-center 风格，和现有暖色调 Mission Hub 完全不搭，铲屎官原话"不能说一模一样，只能说毫不相关"。被否决后全部重做。

## 两种模式

### Mode A：Design — 创建/编辑 .pen 文件

**用 Pencil MCP 工具操作设计画布**：

| 工具 | 用途 |
|------|------|
| `get_editor_state` | 查看当前画布状态（首先调用） |
| `open_document` | 打开已有 .pen 文件（`"new"` 不落盘，需用户手动 Cmd+S） |
| `batch_get` | 批量读取 layer/component 属性 |
| `batch_design` | 批量创建/修改设计元素（**每次最多 25 ops**） |
| `get_screenshot` | 获取当前画布截图（验证设计结果） |
| `get_guidelines` | 获取布局参考线 |
| `get_style_guide` | 获取项目色系/字体规范 |

**关键限制**：
- `batch_design` 每次最多 25 ops，超出必须分批调用
- Binding（绑定引用）不能跨 `batch_design` 调用复用
- MCP 配置改动需等下次调用才生效（无头模式）

**🔴 .pen 文件管理规则**：
- **每个 feat 一个 .pen 文件** — 用 `open_document("new")` 新建，不要在其他 feat 的 .pen 文件上修改
- **不能修改其他猫/feat 的设计稿** — 只读参考可以（`batch_get` + `get_screenshot`），但不要 `batch_design`/`Update`/`Delete` 别人的节点
- **保存需要铲屎官** — `open_document("new")` 创建的文件不落盘，猫猫无法自行保存。设计完成后：
  1. 告诉铲屎官**完整保存路径**：`{项目根目录}/designs/{文件名}.pen`
  2. 路径用 `git rev-parse --show-toplevel` 动态获取项目根目录，**不要硬编码绝对路径**
  3. 文件命名规范：`{feat-id}-{描述}.pen`（如 `F096-interactive-rich-blocks-ux.pen`）
  4. 铲屎官保存后，需要 **commit + push 到 main**（设计稿是共享状态文件）
- **保存后验证** — 铲屎官确认保存后，用 `open_document("{完整路径}")` 打开验证内容完整

### Mode B：Code Export — 从 .pen 设计稿生成代码

1. 用 `get_editor_state` + `batch_get` 读取设计属性
2. 用 `get_style_guide` 获取设计 token（颜色、字体、间距）
3. 生成 React + Tailwind 组件代码
4. 截图对比：`get_screenshot` → 目视验证还原度

## 工作流

```
设计任务
  ↓
现有 UI 截图分析（扩展型设计必须！）
  ↓
get_editor_state（了解画布现状）
  ↓
get_style_guide_tags + get_style_guide（仅全新设计）
  ↓
Mode A: batch_design（分批，≤25 ops/次）
Mode B: batch_get → 生成 React/Tailwind
  ↓
get_screenshot（验证）
  ↓
和现有 UI 对比 → 风格一致？
  ├─ 不一致 → 修正配色/布局后重新 batch_design
  └─ 一致 → 请铲屎官保存
       ↓
       告诉铲屎官完整路径（git rev-parse --show-toplevel + /designs/Fxxx-xxx.pen）
       铲屎官 Cmd+S 保存 → commit push 到 main
       ↓
       铲屎官/设计负责人 review 设计截图
       ├─ 否决 → 记录反馈 → 回到 batch_design 修正
       └─ 通过 → 如需实现 → worktree → tdd
```

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| **🔴 不看现有 UI 就设计** | 风格断裂，被否决重做 | 先截图分析现有风格 |
| **🔴 做独立 dashboard 而不是集成扩展** | 和产品割裂 | 问清楚是"扩展"还是"全新" |
| 用 Read/Grep 读 .pen 文件 | 乱码，无法解析 | 只用 Pencil MCP 工具 |
| batch_design 超过 25 ops | 工具报错 | 拆成多次调用 |
| MCP 配置未加 `--app antigravity` | 工具不可用 | 加上后等下次激活 |
| 跨调用复用 binding | binding 失效 | 每次调用重新声明 |
| `open_document("new")` 后忘记保存 | 内容丢失 | 告诉铲屎官完整路径，请求 Cmd+S |
| `get_style_guide` 的 tags 传字符串 | 参数格式错误 | 必须传 JSON 数组 |
| **🔴 在别人的 .pen 上修改** | 覆盖其他猫的设计 | 永远 `open_document("new")` 新建 |
| **🔴 保存路径硬编码** | 项目搬家后路径失效 | 用 `git rev-parse --show-toplevel` |
| **🔴 保存后不 commit push** | 其他猫看不到设计稿 | 请铲屎官保存后 commit push 到 main |

## 和其他 Skill 的区别

- `tdd` / `worktree`：代码实现阶段 — pencil-design 是**设计阶段**，先于代码
- `quality-gate`：检查代码合规 — pencil-design 输出的是设计文件或组件代码

## 下一步

- Mode A 完成设计 → 告知铲屎官完整保存路径 → 铲屎官 Cmd+S 保存 + commit push → 设计 review → 如需实现 → `worktree` → `tdd`
- Mode B 导出代码 → 进入 `tdd` 编写测试 + 集成
