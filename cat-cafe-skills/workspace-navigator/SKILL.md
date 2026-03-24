---
name: workspace-navigator
description: >
  猫猫可编程导航 Workspace 面板：铲屎官说模糊意图，猫猫找到路径，自动打开文件/目录。
  Use when: 铲屎官说"打开日志""看看代码""打开设计图""帮我打开那个文档"等模糊指令。
  Not for: 打开 localhost 前端页面（用 browser-preview）、纯代码编写（不涉及展示给铲屎官看）。
  Output: Hub 右侧 Workspace 面板自动打开并导航到目标文件/目录。
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

铲屎官说"帮我打开XXX"时，你要**自己找到路径，然后调 API 让 Hub 右面板自动导航到那里**。铲屎官不会给你精确路径——这是你的活。

## 核心工作流（三步走）

```
Step 1: 意图解析 — 铲屎官想看什么？
  "帮我打开日志" → 日志文件/目录
  "看看 F131 的设计图" → F131 相关的 .pen 文件
  "打开那个 discussion" → 讨论文档

Step 2: 路径搜索 — 用你的工具找到精确路径
  用 glob/grep/read 找到文件的相对路径（相对于 worktree 根目录）

Step 3: 调 API — 让 Hub 前端导航
  curl -X POST http://localhost:3003/api/workspace/navigate \
    -H "Content-Type: application/json" \
    -d '{"path": "找到的相对路径", "action": "open", "worktreeId": "目标worktree"}'
```

## Step 2 详解：意图→路径匹配策略

这是本 skill 的核心硬实力。**不同意图用不同搜索策略**：

### 场景速查表

| 铲屎官说的 | 搜索策略 | 示例命令 |
|-----------|----------|---------|
| "打开日志" / "看日志" | **快捷方式：右侧状态面板底部「运行日志 → 查看日志」按钮**。也可用 Navigate API | 按钮会自动打开最新 .log 文件 |
| "看审计日志" | 审计日志在 `packages/api/data/audit/` 下 | `glob("packages/api/data/audit/**")` |
| "打开 F131 的文档" | Feature 文档在 `docs/features/` 下 | `glob("docs/features/F131*")` |
| "看看 F131 的设计图" | Pencil 设计文件 | `glob("**/*F131*.pen")` 或 `glob("designs/*F131*")` |
| "打开那个 discussion" | 讨论文档在 *(internal reference removed)* 下 | `glob("feature-discussions/*")` |
| "看看 chatStore" | 源码文件名搜索 | `glob("**/*chatStore*")` |
| "打开 BACKLOG" | 已知位置 | 直接用 `docs/ROADMAP.md` |
| "看看 plans" | 计划目录 | 直接用 *(internal reference removed)* |
| "打开那个 skill" | Skill 文档 | `glob("cat-cafe-skills/*/SKILL.md")` |
| "看看 spec" + 上下文 | 从对话上下文推断是哪个 Feature | 推断 Feature ID → `glob("docs/features/Fxxx*")` |

### 搜索策略优先级

1. **已知位置直达** — 日志、BACKLOG、SOP 等有固定位置的，不需要搜
2. **Feature ID 匹配** — 铲屎官提到 F 编号，直接 `glob("**/F{num}*")`
3. **文件名 glob** — 铲屎官提到文件名关键词，`glob("**/*关键词*")`
4. **内容 grep** — 铲屎官描述的是文件内容而非文件名，用 `grep("内容关键词")`
5. **目录浏览** — 不确定时先 reveal 目录，让铲屎官自己挑

### 多结果处理

如果搜索返回**多个匹配**：
- **≤ 3 个**：列出让铲屎官选，或者按上下文判断最可能的那个打开
- **> 3 个**：缩小搜索范围（加更多关键词），或者 reveal 到父目录让铲屎官浏览

### 路径格式要求

- **必须是相对路径**（相对于 worktree 根目录），不要传绝对路径
- 例：`packages/api/data/logs/api/2026-03-21.log`，不是 `/home/user/2026-03-21.log`
- 目录路径末尾带不带 `/` 都行

## Step 3 详解：调用 Navigate API

### API 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `path` | **是** | 目标文件或目录的相对路径 |
| `action` | 否 | `reveal`（展开目录树到目标，默认）或 `open`（打开文件查看器） |
| `worktreeId` | **是** | 指定在哪个 worktree 里导航。API 需要此字段来解析路径 |
| `threadId` | **建议传** | 当前 thread ID，用于防止多 tab 串扰。传了只有对应 tab 响应 |

### action 选择

| 目标 | 用什么 action | 效果 |
|------|-------------|------|
| 目录（如 `packages/api/data/logs/`） | `reveal` | 展开文件树到该目录，不打开任何文件 |
| 文件（如 `docs/features/F131-workspace-navigator.md`） | `open` | 打开文件查看器显示文件内容 |
| 不确定 | `reveal` | 安全默认——展开到那里让铲屎官自己看 |

### 获取 API 端口

Cat Cafe API 端口**不要写死**，通过以下方式确定：

1. **优先读运行态 env**：直接用 `API_SERVER_PORT`
2. **没有 env 时按关系推导**：`API port = Frontend port + 1`
3. **验证**：`curl -s http://localhost:${API_PORT}/api/workspace/worktrees` 能返回 JSON 即可

> 注意：不同 profile / 发布通道的默认端口不一样。`3001` 是 Hub 前端（Next.js），**不是** API 后端；Navigate API 始终走 Fastify 的 `API_SERVER_PORT`。

### 调用示例

```bash
# 先拿当前运行态的 API 端口；没有就先去看 .env / 启动日志，不要写死
API_PORT="${API_SERVER_PORT:?set API_SERVER_PORT before calling Navigate API}"

# 打开日志目录
curl -X POST http://localhost:${API_PORT}/api/workspace/navigate \
  -H "Content-Type: application/json" \
  -d '{"path": "packages/api/data/logs/api/", "action": "reveal", "worktreeId": "cat-cafe-runtime"}'

# 打开 Feature 文档
curl -X POST http://localhost:${API_PORT}/api/workspace/navigate \
  -H "Content-Type: application/json" \
  -d '{"path": "docs/features/F131-workspace-navigator.md", "action": "open", "worktreeId": "cat-cafe"}'

# 跨 worktree 打开 runtime 日志
curl -X POST http://localhost:${API_PORT}/api/workspace/navigate \
  -H "Content-Type: application/json" \
  -d '{"path": "packages/api/data/logs/api/", "action": "reveal", "worktreeId": "cat-cafe-runtime"}'
```

## 什么时候主动用

- 铲屎官说"帮我打开XXX" → **立刻搜索 + 导航，不要只回复路径让铲屎官自己找**
- 铲屎官说"一起看看这个日志" → 打开日志目录
- 讨论 Feature 时提到 spec → 主动打开 spec 文档
- Debug 时提到某个文件 → 主动打开让铲屎官和你一起看
- 铲屎官说"看看设计图" → 找到 .pen 文件并打开

## 面板快捷入口（F130）

右侧状态面板底部有内置快捷按钮，不需要走 Navigate API：

| 按钮 | 位置 | 效果 |
|------|------|------|
| **运行日志 → 查看日志** | 右侧状态面板，AuditExplorerPanel 下方 | 自动展开到 `packages/api/data/logs/api/` 并打开最新 `.log` 文件 |

铲屎官说"看日志"时，**告诉铲屎官点右侧面板的按钮**比你调 API 更快。你也可以用 Navigate API 代替。

## 不要做的事

- **不要只回复路径让铲屎官自己去点** — 你的价值是「帮铲屎官打开」，不是「告诉铲屎官路径」
- **不要问铲屎官要精确路径** — 你自己能搜到，这是你的活
- **不要和 browser-preview 混淆** — workspace-navigator 打开文件/目录；browser-preview 打开 localhost 网页
- **不要传绝对路径** — API 只接受相对路径
- **不要瞎猜路径不验证** — 先 glob/grep 确认文件存在，再调 API

## 和其他 skill 的区别

| Skill | 关注点 |
|-------|--------|
| **workspace-navigator（本 skill）** | 帮铲屎官在 Hub Workspace 面板打开文件/目录 |
| `browser-preview` | 在 Hub Browser 面板预览 localhost 前端页面 |
| `tdd` | 写代码的测试驱动纪律 |
| `quality-gate` | 开发完成后的自检 |

## 常见问题

| 现象 | 原因 | 修法 |
|------|------|------|
| 右侧无反应 | API 没跑 / 路径不存在 | 先 `curl localhost:3003/healthz` 确认 API；检查路径是否存在 |
| 打开了错误的文件 | glob 匹配到了多个，选了错的 | 列出所有匹配让铲屎官确认 |
| worktree 切换失败 | worktreeId 不存在 | `curl localhost:3003/api/workspace/worktrees` 查看可用列表 |
| 面板没自动打开 | Socket 连接可能断了 | 刷新 Hub 页面重试 |
