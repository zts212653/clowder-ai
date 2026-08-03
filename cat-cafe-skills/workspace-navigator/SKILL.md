---
name: workspace-navigator
description: 猫猫把“打开文档、代码或日志”等模糊意图解析成本地绝对路径或 worktree 相对路径，并返回 applied、queued、blocked 或 unconfirmed 的真实 Workspace 投递状态。
triggers:
  - "打开文件"
  - "看看代码"
  - "看日志"
  - "帮我打开"
  - "一起看看"
  - "打开设计图"
  - "看看这个文档"
  - "打开 discussion"
  - "看看 feature"
  - "打开审计日志"
  - "看看 spec"
  - "帮我找到"
  - "打开那个"
---

# Workspace Navigator

operator说"帮我打开XXX"时，你要**自己找到路径，然后用 `cat_cafe_workspace_navigate` 让 Hub 右面板自动导航到那里**。operator不会给你精确路径——这是你的活。

## 核心工作流（三步走）

```
Step 1: 意图解析 — operator想看什么？
  "帮我打开日志" → 日志文件/目录
  "看看 F131 的设计图" → F131 相关的 .pen 文件
  "打开那个 discussion" → 讨论文档

Step 2: 路径搜索 — 用你的工具找到精确路径
  用 glob/grep/read 找到文件的精确绝对路径；已有可靠 worktreeId 时也可用相对路径

Step 3: 调 typed MCP — 让 Hub 前端导航
  cat_cafe_workspace_navigate({
    path: "/精确/绝对/路径",
    action: "open",
    threadId: "当前 threadId（有就传）"
  })
```

## Step 2 详解：意图→路径匹配策略

这是本 skill 的核心硬实力。**不同意图用不同搜索策略**：

### 场景速查表

| operator说的 | 搜索策略 | 示例命令 |
|-----------|----------|---------|
| "打开日志" / "看日志" | **快捷方式：右侧状态面板底部「运行日志 → 查看日志」按钮**。也可用 `cat_cafe_workspace_navigate` | 按钮会自动打开最新 .log 文件 |
| "看审计日志" | 审计日志在 `packages/api/data/audit/` 下 | `glob("packages/api/data/audit/**")` |
| "打开 F131 的文档" | Feature 文档在 `docs/features/` 下 | `glob("docs/features/F131*")` |
| "看看 F131 的设计图" | Pencil 设计文件 | `glob("**/*F131*.pen")` 或 `glob("designs/*F131*")` |
| "打开那个 discussion" | 讨论文档在 `feature-discussions/` 下 | `glob("feature-discussions/*")` |
| "看看 chatStore" | 源码文件名搜索 | `glob("**/*chatStore*")` |
| "打开 BACKLOG" | 已知位置 | 直接用 `docs/ROADMAP.md` |
| "看看 plans" | 计划目录 | 直接用 `feature-specs/` |
| "打开那个 skill" | Skill 文档 | `glob("cat-cafe-skills/*/SKILL.md")` |
| "看看 spec" + 上下文 | 从对话上下文推断是哪个 Feature | 推断 Feature ID → `glob("docs/features/Fxxx*")` |

### 搜索策略优先级

1. **已知位置直达** — 日志、BACKLOG、SOP 等有固定位置的，不需要搜
2. **Feature ID 匹配** — operator提到 F 编号，直接 `glob("**/F{num}*")`
3. **文件名 glob** — operator提到文件名关键词，`glob("**/*关键词*")`
4. **内容 grep** — operator描述的是文件内容而非文件名，用 `grep("内容关键词")`
5. **目录浏览** — 不确定时先 reveal 目录，让operator自己挑

### 多结果处理

如果搜索返回**多个匹配**：
- **≤ 3 个**：列出让operator选，或者按上下文判断最可能的那个打开
- **> 3 个**：缩小搜索范围（加更多关键词），或者 reveal 到父目录让operator浏览

### 路径格式要求

- **绝对路径可直接传**，这是 Codex 输出本地文件的原生格式；服务端会解析为安全的
  `(worktreeId, repoRelativePath)` target
- 已知目标 worktreeId 时也可传 repo-relative 路径；此时 `worktreeId` 必填
- 例：`/home/user/cat-cafe/docs/VISION.md` 可不传 worktreeId；
  `docs/VISION.md` 必须同时传 `worktreeId: "cat-cafe"`
- 目录路径末尾带不带 `/` 都行

## Step 3 详解：调用 `cat_cafe_workspace_navigate`

### 工具参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `path` | **是** | 目标文件或目录的绝对路径；或配合 worktreeId 的 repo-relative 路径 |
| `action` | 否 | `reveal`（展开目录树到目标，默认）或 `open`（打开文件查看器） |
| `worktreeId` | 条件必填 | repo-relative path 必填；absolute path 省略 |
| `threadId` | **建议传** | 当前 thread ID，用于防止多 tab 串扰。传了只有对应 tab 响应 |

### action 选择

| 目标 | 用什么 action | 效果 |
|------|-------------|------|
| 目录（如 `packages/api/data/logs/`） | `reveal` | 展开文件树到该目录，不打开任何文件 |
| 文件（如 `docs/features/F131-workspace-navigator.md`） | `open` | 打开文件查看器显示文件内容 |
| 不确定 | `reveal` | 安全默认——展开到那里让operator自己看 |

### 调用示例

| 场景 | 调用 |
|------|------|
| 打开日志目录 | `cat_cafe_workspace_navigate({ path: "packages/api/data/logs/api/", action: "reveal", worktreeId: "cat-cafe-runtime" })` |
| 打开 Feature 文档 | `cat_cafe_workspace_navigate({ path: "/home/user/cat-cafe/docs/features/F131-workspace-navigator.md", action: "open" })` |
| 打开到某一行 | `cat_cafe_workspace_navigate({ path: "packages/web/src/stores/chatStore.ts", action: "open", worktreeId: "cat-cafe", line: 1273 })` |

如果 MCP 工具不可用，先说明工具面缺失并按 F223 追踪；不要把手写第一方 `curl localhost` 当主路径。

### 结果判读

| deliveryStatus | 含义 | 下一步 |
|---|---|---|
| `applied` | 至少一个 Hub client 已写入 Workspace 状态 | 可告诉operator已经打开 |
| `queued` | 目标 thread/route/viewport 当前不可见，已在该浏览器 session 排队 | 说明“已排队，回到目标 thread/桌面宽度会打开” |
| `blocked` | Presentation Lock 或浏览器无法安全持久化 | 说明明确 reason，不声称已打开 |
| `unconfirmed` | 请求合法且已发出，但没有 client 回执 | 说明未确认；不要把 `ok:true` 翻译成用户已看到 |

## 什么时候主动用

- operator说"帮我打开XXX" → **立刻搜索 + 导航，不要只回复路径让operator自己找**
- operator说"一起看看这个日志" → 打开日志目录
- 讨论 Feature 时提到 spec → 主动打开 spec 文档
- Debug 时提到某个文件 → 主动打开让operator和你一起看
- operator说"看看设计图" → 找到 .pen 文件并打开

## 面板快捷入口（F130）

右侧状态面板底部有内置快捷按钮，不需要走 `cat_cafe_workspace_navigate`：

| 按钮 | 位置 | 效果 |
|------|------|------|
| **运行日志 → 查看日志** | 右侧状态面板，AuditExplorerPanel 下方 | 自动展开到 `packages/api/data/logs/api/` 并打开最新 `.log` 文件 |

operator说"看日志"时，**告诉operator点右侧面板的按钮**比你调工具更快。你也可以用 `cat_cafe_workspace_navigate` 代替。

## 不要做的事

- **不要只回复路径让operator自己去点** — 你的价值是「帮operator打开」，不是「告诉operator路径」
- **不要问operator要精确路径** — 你自己能搜到，这是你的活
- **不要和 browser-preview 混淆** — workspace-navigator 打开文件/目录；browser-preview 打开 localhost 网页
- **不要为了适配工具手工把可靠绝对路径改写成相对路径** — 绝对路径就是受支持输入
- **不要瞎猜路径不验证** — 先 glob/grep 确认文件存在，再调 API
- **不要把 `ok:true` 当成“operator已看到”** — 必须看 `deliveryStatus`

## 和其他 skill 的区别

| Skill | 关注点 |
|-------|--------|
| **workspace-navigator（本 skill）** | 帮operator在 Hub Workspace 面板打开文件/目录 |
| `browser-preview` | 在 Hub Browser 面板预览 localhost 前端页面 |
| `tdd` | 写代码的测试驱动纪律 |
| `quality-gate` | 开发完成后的自检 |

## 常见问题

| 现象 | 原因 | 修法 |
|------|------|------|
| 右侧无反应 | `deliveryStatus` 是 queued/blocked/unconfirmed | 读 reason；queued 等目标 thread/桌面，blocked 解除锁，unconfirmed 重试 |
| 打开了错误的文件 | glob 匹配到了多个，选了错的 | 列出所有匹配让operator确认 |
| worktree 切换失败 | 相对路径的 worktreeId 不存在，或绝对路径不在注册 root | 改传可靠绝对路径，或核对 worktree 列表 |
| 面板没自动打开 | Socket 无客户端回执 | `unconfirmed` 时确认 Hub 在线后重试 |
