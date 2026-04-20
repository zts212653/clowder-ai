# 安装指南

[English](SETUP.md) | **中文**

---

## 前置要求

| 工具 | 版本 | 安装方式 |
|------|------|---------|
| **Node.js** | >= 20.0.0 | [nodejs.org](https://nodejs.org/) |
| **pnpm** | >= 9.0.0 | `npm install -g pnpm` |
| **Redis** | >= 7.0 | `brew install redis`（macOS）或 [redis.io](https://redis.io/download/) — *可选：用 `--memory` 标志跳过* |
| **Git** | 任意近期版本 | 大多数系统自带 |

## 快速开始

```bash
# 1. 克隆
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai

# 2. 安装依赖
pnpm install

# 3. 构建（必需 — 为工作区包生成 dist/）
pnpm build

# 4. 配置基础设施（API key 在启动后通过前端 UI 添加）
cp .env.example .env

# 5. 启动
pnpm start
# 如果报 "target path exists" 错误，改用：
#   pnpm start:direct
```

如果要给记忆系统开启本地语义 rerank，把 `.env` 里的 `EMBED_MODE` 改成 `on`（或 `shadow`）。开启后，`pnpm start` / `pnpm start:direct` 会自动拉起对应平台的 launcher（Unix 用 `scripts/embed-server.sh`，Windows 用 `scripts/embed-server.ps1`）。Apple Silicon 默认走 MLX，其它平台回落到 `sentence-transformers`。

`pnpm start` 使用**运行时 worktree** 架构：首次运行时自动创建隔离的 `../cat-cafe-runtime` worktree，同步到 `origin/main`，构建，启动 Redis，然后启动前端（端口 3003）+ API（端口 3004）。这样你的开发目录保持干净。

> **提示：** 如果 `pnpm start` 因为 `../cat-cafe-runtime` 已存在而失败，改用 `pnpm start:direct` — 直接在当前目录启动，不创建 worktree。也可以自定义路径：`CAT_CAFE_RUNTIME_DIR=../my-runtime pnpm start`。

打开 `http://localhost:3003`，开始和你的团队对话。

> **替代方案 — 一键安装（Linux）：** `bash scripts/install.sh` 一步搞定 Node、pnpm、Redis、依赖、`.env` 和首次启动。**Windows** 用户请使用 `scripts/install.ps1`，然后 `scripts/start-windows.ps1`。

## `pnpm start` 的工作原理（运行时 Worktree）

Clowder 使用**运行时 worktree** 保持开发目录干净：

```
your-projects/
├── clowder-ai/             # 你的开发目录（feature 分支、编辑）
└── cat-cafe-runtime/       # 自动创建的运行时 worktree（跟踪 origin/main）
```

| 命令 | 作用 |
|------|------|
| `pnpm start` | 初始化（首次）→ 同步到 origin/main → 构建 → 启动 Redis + API + 前端 |
| `pnpm start --memory` | 同上，但跳过 Redis（纯内存，重启数据丢失） |
| `pnpm start --quick` | 同上，但跳过重编译（用已有 `dist/`） |
| `pnpm start --daemon` | 同上，但后台运行（日志输出到 `cat-cafe-daemon.log`） |
| `pnpm start:direct` | 跳过 worktree — 从当前 checkout 启动，不自动更新（[详情](#运行指定版本不自动更新)） |
| `pnpm stop` | 停止后台 daemon |
| `pnpm start:status` | 查看 daemon 是否在运行 |
| `pnpm runtime:init` | 只创建运行时 worktree（不启动） |
| `pnpm runtime:sync` | 只同步 worktree 到 origin/main（不启动） |
| `pnpm runtime:status` | 显示 worktree 路径、分支、HEAD、ahead/behind |

首次运行自动创建 `../cat-cafe-runtime`。后续运行做 fast-forward 同步后启动。

> **自定义运行时路径：** 设置 `CAT_CAFE_RUNTIME_DIR` 使用不同位置：`CAT_CAFE_RUNTIME_DIR=../my-clowder-runtime pnpm start`

## 运行指定版本（不自动更新）

默认情况下，`pnpm start` 会自动同步到最新的 `origin/main`。如果你想**停留在某个特定版本** — 为了稳定性、可复现性，或者暂时不想更新 — 请使用 `pnpm start:direct`。

### 方式一：Checkout 到某个 Release Tag

Clowder 在 [Releases 页面](https://github.com/zts212653/clowder-ai/releases)发布带标签的版本（`v0.1.0`、`v0.2.0`、`v0.3.0`、`v0.4.0` 等）。运行指定版本：

```bash
# 1. 克隆（或用你已有的 clone）
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai

# 2. 切换到你想要的版本
git checkout v0.4.0          # 或者 Releases 页面上的任意 tag

# 3. 安装 + 构建
pnpm install
pnpm build

# 4. 配置基础设施（API key 在启动后通过 UI 添加）
cp .env.example .env

# 5. 直接启动（跳过 worktree，不会自动更新）
pnpm start:direct

# 不需要 Redis？用内存模式
pnpm start:direct -- --memory
```

### 方式二：停留在当前 commit

如果你已经 clone 好了并且对当前版本满意，只需用 `pnpm start:direct` 代替 `pnpm start`：

```bash
pnpm start:direct            # 从当前 checkout 启动，不同步
pnpm start:direct -- --quick # 也跳过重编译
```

### 为什么用 `pnpm start:direct`？

| 命令 | 自动同步到最新？ | 创建 worktree？ | 适用场景 |
|------|----------------|----------------|---------|
| `pnpm start` | **是** — 同步到 `origin/main` | 是 | 始终运行最新版本 |
| `pnpm start:direct` | **否** — 从当前 checkout 运行 | 否 | 固定在特定版本或分支 |

> **后续更新：** 准备好更新时，执行 `git fetch && git checkout v0.5.0`（或者新版本 tag），然后 `pnpm install && pnpm build && pnpm start:direct` 即可。

## 后台 / Daemon 模式

默认情况下 `pnpm start` 在前台运行 — 关闭终端或 SSH 断开后服务会停止。使用 `--daemon` 可以在后台运行：

```bash
# 后台启动
pnpm start --daemon

# 可以和其他参数组合
pnpm start --daemon --memory
pnpm start --daemon --quick

# 查看状态
pnpm start:status

# 查看日志
tail -f cat-cafe-daemon.log

# 停止
pnpm stop
```

Daemon 模式将日志输出到项目根目录（或运行时 worktree 根目录）的 `cat-cafe-daemon.log`。PID 文件（`~/.cat-cafe/daemon.pid`）用于追踪运行中的进程。

> **其他后台运行方式**（如果你不想用 `--daemon`）：
> - **tmux / screen**：`tmux new -s cat-cafe` → `pnpm start` → 按 `Ctrl+B D` 脱离
> - **nohup**：`nohup pnpm start > cat-cafe.log 2>&1 &`
> - **systemd**（Linux 生产环境）：创建 service 文件 — 见下方

<details>
<summary>systemd service 文件示例</summary>

```ini
# /etc/systemd/system/clowder-ai.service
[Unit]
Description=Clowder AI (Cat Café)
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/clowder-ai
ExecStart=/usr/bin/pnpm start:direct
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now clowder-ai
sudo journalctl -u clowder-ai -f
```

</details>

## 配置

### 基础设施（`.env`）

`.env` 文件只配置**基础设施** — 端口、Redis 和可选的服务 URL。模型 API key 通过 Web UI 管理（见下方）。

**Redis** — 线程、消息、任务和记忆的持久化存储：

```bash
REDIS_URL=redis://localhost:6399
```

`pnpm start` 会自动启动 Redis（端口 6399）。数据持久化在 `~/.cat-cafe/redis-dev/`。

**没有 Redis？** 用 `pnpm start --memory` 启动纯内存模式（重启后数据丢失 — 试玩够用了）。

**前端：**

```bash
NEXT_PUBLIC_API_URL=http://localhost:3004
```

### 模型接入（UI）

启动后，打开 `http://localhost:3003`，进入 **Hub → 系统配置 → 账号配置** 来配置模型 provider。

账号分两种类型：

| 类型 | 工作方式 | 适用 Provider |
|------|---------|--------------|
| **内置（OAuth / CLI 订阅）** | 通过 provider 的 CLI 工具认证（`claude`、`codex`、`gemini`），无需 API key — CLI 订阅自动处理认证 | Claude、GPT/Codex、Gemini |
| **API Key** | 输入 API key + base URL 直接调用 API。兼容任何 OpenAI 或 Anthropic 协议的端点 | Claude、GPT、Gemini、**Kimi、GLM、MiniMax、Qwen、OpenRouter** 等 |

**步骤：**
1. 在账号配置页点击 **"添加账号"**
2. 选择一个 provider 或添加自定义 provider
3. 内置 provider：选择 OAuth/订阅模式（CLI 已认证则无需 key）
4. API key provider：输入 API key，可选填自定义 base URL
5. 点击 **保存**

**添加国产 / 第三方 provider（Kimi、GLM、MiniMax、Qwen、OpenRouter）：**

这些 provider 以 API key 账号形式配置，需要填写自定义 base URL。在**账号配置** UI 中添加新账号，选择 provider，输入 API key，填入该 provider 的 OpenAI 兼容端点 URL，选择对应协议，点击**保存**。

**示例 — 阿里百炼（Qwen）：**

![百炼 Provider 账号配置](docs/setup/setup-provider-bailian.png)

> **兼容模式：** 系统仍会从 `.env` 读取 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GOOGLE_API_KEY` 作为兜底，但这条路径已不推荐。新安装请统一用 UI 配置。

### 成员配置

给团队成员（猫猫）绑定特定的 provider：

1. 进入 **Hub → 成员协作 → 总览**
2. 每个成员可以绑定账号配置中的一个 provider 账号
3. 内置 provider 支持 OAuth；第三方 provider 使用 API key 账号

![成员绑定百炼 Provider](docs/setup/setup-member-binding.png)

## 可选功能

只要有模型访问 + Redis（或 `--memory` 模式），Clowder 就能开箱即用。以下功能全是可选的。

### 设计工具（Pencil MCP）

设计任务、UI 迭代、截图、设计转代码等工作流需要在编辑器（VS Code、Cursor 或 Antigravity）中安装 [Pencil](https://marketplace.visualstudio.com/items?itemName=highagency.pencildev)。

不装 Pencil：Clowder 照常运行，编码任务不受影响，设计任务退化为纯文本指导。

**自动配置：** 能力编排器会自动检测你的 Pencil 安装，按以下顺序扫描：

1. `PENCIL_MCP_BIN` 环境变量（显式路径 — 最高优先级）
2. `~/.antigravity/extensions/highagency.pencildev-*/`
3. `~/.vscode/extensions/highagency.pencildev-*/`
4. `~/.cursor/extensions/highagency.pencildev-*/`
5. `~/.vscode-insiders/extensions/highagency.pencildev-*/`

自动选择所有编辑器中最新的版本。当两个编辑器安装了相同版本时，优先选择 Antigravity。

**环境变量覆盖：**

| 变量 | 用途 | 示例 |
|------|------|------|
| `PENCIL_MCP_BIN` | 强制指定 Pencil 二进制路径 | `/path/to/mcp-server-darwin-arm64` |
| `PENCIL_MCP_APP` | 强制连接到指定编辑器 | `vscode`、`antigravity`、`cursor`、`vscode-insiders` |

**诊断：** `pnpm mcp:doctor` 显示 MCP 就绪状态（ready / missing / unresolved）。

### 语音输入 / 输出

解放双手跟猫猫对话。需要本地 ASR/TTS 服务。

```bash
ASR_ENABLED=1
TTS_ENABLED=1
LLM_POSTPROCESS_ENABLED=1

# 语音转文字（ASR）
WHISPER_URL=http://localhost:9876
NEXT_PUBLIC_WHISPER_URL=http://localhost:9876

# 文字转语音（TTS）
TTS_URL=http://localhost:9879
TTS_CACHE_DIR=./data/tts-cache

# 语音纠正（LLM 后处理）
NEXT_PUBLIC_LLM_POSTPROCESS_URL=http://localhost:9878
```

支持引擎：输入用 Qwen3-ASR（主）/ Whisper（备）；输出用 Kokoro / edge-tts / Qwen3-TTS。
这些服务默认关闭。只有在本地依赖安装完成后，再把对应的 `*_ENABLED=1` 打开。

**启动语音服务：**
```bash
# TTS（文字转语音）— 需要 Python 3，自动创建 venv 到 ~/.cat-cafe/tts-venv
./scripts/tts-server.sh                    # 默认: Qwen3-TTS（三猫声线）
TTS_PROVIDER=edge-tts ./scripts/tts-server.sh  # edge-tts 备选（无需 GPU）

# ASR（语音转文字）— 需要 Python 3 + ffmpeg
./scripts/qwen3-asr-server.sh             # Qwen3-ASR 服务器
```

> **系统依赖**：音频处理需要 `ffmpeg`。安装方式：`brew install ffmpeg`（macOS）或 `apt install ffmpeg`（Linux）。

### API 网关代理

可选的反向代理，用于将 API 请求路由到第三方网关。适用于需要通过自定义端点调用 Claude API 的场景。

```bash
ANTHROPIC_PROXY_ENABLED=1          # 默认: 0（关闭）
ANTHROPIC_PROXY_PORT=9877          # 代理监听端口
```

在 `.cat-cafe/proxy-upstreams.json` 中配置上游：
```json
{ "my-gateway": "https://your-gateway.example.com/api" }
```

### 飞书接入

在飞书里直接跟猫猫团队聊天。需要创建一个飞书自建应用。

**第 1 步 — 创建飞书应用：**
前往 [飞书开放平台](https://open.feishu.cn/app) → 创建自建应用。

**第 2 步 — 开通权限：**
在权限管理中，添加以下权限：
- `im:message` — 读取消息
- `im:message:send_as_bot` — 以机器人身份发消息
- `im:resource` — 读取媒体资源（图片、文件）
- `im:resource:upload` — 上传媒体（语音气泡和图片原生显示必需）

> **为什么需要 `im:resource:upload`？** 如果不开通，语音消息会以文本链接形式显示，图片也只会发送 URL 而非原生媒体。机器人会自动将 WAV 音频通过 ffmpeg 转码为 Opus 格式，上传到飞书后以语音气泡播放。

**第 3 步 — 配置事件订阅：**
在事件订阅中：
- **请求地址**：`http(s)://<你的域名或IP>:3004/api/connectors/feishu/webhook`
- 订阅事件：`im.message.receive_v1`
- 系统会自动响应飞书的 URL 验证 challenge。

**第 4 步 — 设置环境变量：**
```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_VERIFICATION_TOKEN=xxx    # 在事件订阅页面获取
```

**第 5 步 — 启用机器人：**
在飞书应用控制台 → 机器人，启用机器人能力。之后用户可以直接 DM 机器人和 AI 团队聊天。

> 目前仅支持私聊（1:1），群聊支持计划中。

### Telegram 接入

> **状态：进行中** — 适配器代码已存在，但尚未在生产环境部署/验证。

在 Telegram 里跟猫猫聊天。需要通过 @BotFather 创建一个 bot。

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
```

### GitHub PR Review 通知

当 GitHub review 邮件到达时自动通知（轮询 IMAP）。Review 评论自动路由到对应的猫和线程。

```bash
# QQ 邮箱示例
GITHUB_REVIEW_IMAP_USER=xxx@qq.com
GITHUB_REVIEW_IMAP_PASS=<授权码>    # 应用专用密码，不是登录密码
GITHUB_REVIEW_IMAP_HOST=imap.qq.com
GITHUB_REVIEW_IMAP_PORT=993

# Gmail 示例（需要开启两步验证 + 生成应用专用密码）
# GITHUB_REVIEW_IMAP_USER=xxx@gmail.com
# GITHUB_REVIEW_IMAP_PASS=<应用专用密码>    # Google 账号 → 安全性 → 应用专用密码
# GITHUB_REVIEW_IMAP_HOST=imap.gmail.com
# GITHUB_REVIEW_IMAP_PORT=993

# Outlook / Hotmail 示例
# GITHUB_REVIEW_IMAP_USER=xxx@outlook.com
# GITHUB_REVIEW_IMAP_PASS=<应用专用密码>    # Microsoft 账号 → 安全 → 应用密码
# GITHUB_REVIEW_IMAP_HOST=outlook.office365.com
# GITHUB_REVIEW_IMAP_PORT=993

# GitHub MCP 工具（用于 PR 操作 + 获取 review 内容）
GITHUB_MCP_PAT=ghp_...
```

**路由机制（三层）：**
1. **PR 注册**（首选）：猫猫在开 PR 时通过 `register_pr_tracking` MCP 工具注册。收到 review 邮件后，直接路由到该猫的线程。
2. **标题标签**（备选）：如果没有注册记录，系统从 PR 标题中查找猫名标签（如 `[宪宪🐾]`），路由到该猫的 Review 收件箱。
3. **分诊**（兜底）：如果无法识别猫，review 进入分诊线程等待手动分配。

Review 内容通过 GitHub API（使用 `GITHUB_MCP_PAT`）获取，自动提取严重等级（P0/P1/P2 标签）。

### Web Push 通知

浏览器推送通知 — 猫猫需要你注意时会提醒。

```bash
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

生成密钥：`npx web-push generate-vapid-keys`

### 长期记忆（Evidence Store）

项目知识（决策、教训、讨论）存储在本地 SQLite — 不需要外部服务。

每个项目有自己的 `evidence.sqlite` 文件（首次启动自动创建），支持 FTS5 全文检索。数据留在你的机器上。

猫猫通过 `search_evidence` 和 `reflect` MCP 工具查询这个存储。开箱即用，无需配置。

## Agent CLI 配置

每个 Agent CLI（Claude Code、Codex、Gemini CLI）有自己的配置。Clowder 提供项目级 MCP server 配置，将 agent 连接到平台：

- **Claude Code**：读取 `.mcp.json` 获取 MCP 服务器，`CLAUDE.md` 获取项目指令
- **Codex CLI**：读取 `.codex/config.toml` 获取 MCP 服务器，`AGENTS.md` 获取项目指令
- **Gemini CLI**：读取 `.gemini/settings.json` 获取 MCP 服务器，`GEMINI.md` 获取项目指令

### Codex CLI — "困在箱子里"修复

如果 Codex（缅因猫/砚砚）报告无法访问文件或工具，可能是因为在沙箱模式中运行。在**用户级** Codex 配置（`~/.codex/config.toml`）中添加以下设置：

```toml
approval_policy = "on-request"         # 危险操作前询问
sandbox_mode = "danger-full-access"    # 允许文件/网络访问

[sandbox_workspace_write]
network_access = true
```

> 项目级 `.codex/config.toml` 只包含 MCP 服务器定义。`sandbox_mode` 和 `approval_policy` 等运行时设置必须在 `~/.codex/config.toml` 中配置。

## Windows 安装

Windows 通过 PowerShell 脚本完整支持。

```powershell
# 安装一切（Node.js、pnpm、Redis、CLI 工具、认证）
.\scripts\install.ps1

# 启动服务
.\scripts\start-windows.ps1            # 完整启动（构建 + 运行）
.\scripts\start-windows.ps1 -Quick     # 跳过重编译
.\scripts\start-windows.ps1 -Memory    # 无 Redis（内存模式）

# 停止服务
.\scripts\stop-windows.ps1
```

> **注意**：`scripts/install.sh` 仅适用于 Linux（Debian/RHEL）。macOS 用户请手动安装依赖（`brew install node pnpm redis`）后运行 `pnpm install && pnpm build && pnpm start`。

## 端口概览

| 服务 | 端口 | 必需 |
|------|------|------|
| 前端（Next.js） | 3003 | 是 |
| API 后端 | 3004 | 是 |
| Redis | 6399 | 是（或用 `--memory`） |
| ASR | 9876 | 否 — 语音输入 |
| TTS | 9879 | 否 — 语音输出 |
| LLM 后处理 | 9878 | 否 — 语音纠正 |

## 常用命令

```bash
# === 启动 ===
pnpm start              # 启动全部（Redis + API + 前端），通过运行时 worktree
pnpm start --memory     # 无 Redis，纯内存模式
pnpm start --quick      # 跳过重编译，用已有 dist/
pnpm start --daemon     # 后台运行（daemon 模式）
pnpm start:direct       # 直接启动 dev server（跳过 worktree）

# === Daemon 管理 ===
pnpm stop               # 停止后台 daemon
pnpm start:status       # 查看 daemon 是否在运行
                        # 查看日志: tail -f cat-cafe-daemon.log

# === 运行时 Worktree ===
pnpm runtime:init       # 创建运行时 worktree（仅首次）
pnpm runtime:sync       # 同步 worktree 到 origin/main
pnpm runtime:start      # 同步 + 从 worktree 启动
pnpm runtime:status     # 查看 worktree 状态

# === 构建和测试 ===
pnpm build              # 构建所有包
pnpm dev                # 所有包并行 dev 模式
pnpm test               # 运行所有测试

# === 代码质量 ===
pnpm check              # Biome lint + 格式检查 + Feature 文档 + 端口漂移检测
pnpm check:fix          # 自动修复 lint 问题
pnpm lint               # TypeScript 类型检查（按包）
pnpm check:deps         # 依赖图检查（depcruise）
pnpm check:lockfile     # 校验 lockfile 完整性
pnpm check:features     # Feature 文档合规检查
pnpm check:env-ports    # 环境变量端口漂移检测

# === Redis ===
pnpm redis:user:start   # 手动启动 Redis
pnpm redis:user:stop    # 停止 Redis
pnpm redis:user:status  # 检查 Redis 状态
pnpm redis:user:backup  # 手动备份

# Redis 自动备份（cron 方式）
pnpm redis:user:autobackup:install    # 安装自动备份定时任务
pnpm redis:user:autobackup:run        # 立即执行备份
pnpm redis:user:autobackup:status     # 查看自动备份状态
pnpm redis:user:autobackup:uninstall  # 移除自动备份定时任务

# === 线程导出 ===
pnpm threads:sync       # 同步线程导出
pnpm threads:status     # 查看线程导出状态
pnpm threads:export:redis              # 从 Redis 导出线程
pnpm threads:export:redis:dry-run      # 模拟导出

# 线程自动保存（cron 方式）
pnpm threads:autosave:install          # 安装自动保存定时任务
pnpm threads:autosave:run              # 立即执行自动保存
pnpm threads:autosave:status           # 查看自动保存状态
pnpm threads:autosave:uninstall        # 移除自动保存定时任务

# === Alpha Worktree（预发布测试）===
pnpm alpha:init         # 创建 alpha worktree（../cat-cafe-alpha）
pnpm alpha:sync         # 同步 alpha worktree 到 origin/main
pnpm alpha:start        # 启动 alpha 环境（端口 3011/3012）
pnpm alpha:status       # 查看 alpha worktree 状态
pnpm alpha:test         # 运行 alpha 集成测试
```

## 远程部署

所有服务都通过环境变量配置 — 远程部署**不需要改代码**。在 `.env` 中添加：

### 必须修改

```bash
# API 必须监听所有网络接口（默认 127.0.0.1 只允许本机访问）
API_SERVER_HOST=0.0.0.0

# 前端 URL — 用于 CORS 和重定向
FRONTEND_URL=https://your-domain.com

# API URL — 反向代理场景通常不需要设置（自动探测）。
# 仅在 API 使用独立域名等非标准端点时设置。
# NEXT_PUBLIC_API_URL=https://api.your-domain.com

# Redis — 如果在其他机器上
REDIS_URL=redis://your-redis-host:6399
```

### 可选：语音服务

如果语音服务在其他机器上运行，更新对应 URL：

```bash
WHISPER_URL=http://your-asr-host:9876
NEXT_PUBLIC_WHISPER_URL=http://your-asr-host:9876
TTS_URL=http://your-tts-host:9879
NEXT_PUBLIC_LLM_POSTPROCESS_URL=http://your-llm-host:9878
```

> **Python 服务**（ASR/TTS/embed）默认绑定 `127.0.0.1`。如果部署在独立机器上，启动时需要加 `--host 0.0.0.0`。

### CORS

API 自动接受以下来源的请求：
- `localhost` / `127.0.0.1`（任意端口）
- 你设置的 `FRONTEND_URL`

如果你是直接通过局域网 / Tailscale IP 打开 Cat Cafe（例如 `http://192.168.x.x:3003` 或 `http://100.x.x.x:3003`），还需要在 `.env` 里加上：

```bash
API_SERVER_HOST=0.0.0.0
CORS_ALLOW_PRIVATE_NETWORK=true
```

这个显式开关会信任 RFC 1918 内网地址（`10.x.x.x`、`172.16-31.x.x`、`192.168.x.x`）和 Tailscale IP（`100.x.x.x`）上的浏览器。如果你走反向代理或固定 `FRONTEND_URL`，通常不需要额外打开这个选项。

## 常见问题

**`pnpm start` 报 "target path exists" 错误？**
- 运行时 worktree 路径 `../cat-cafe-runtime` 已被其他项目或目录占用
- **快速解决：** 改用 `pnpm start:direct`，跳过 worktree 直接在当前目录启动
- **替代方案：** 自定义运行时路径：`CAT_CAFE_RUNTIME_DIR=../my-clowder-runtime pnpm start`
- 不需要 Redis 的话：`pnpm start:direct -- --memory`

**Redis 启动不了？**
- 检查端口 6399 是否被占用：`lsof -i :6399`
- 确认 Redis 已安装：`redis-server --version`

**没有 agent 响应？**
- 检查是否已在 **Hub → 系统配置 → 账号配置** 中添加了至少一个 provider 账号
- 如果用 CLI 认证，确认认证正常（`claude --version`、`codex --version`）
- 看终端里 API 日志有没有认证错误

**前端连不上 API？**
- 本地开发确认 `.env` 里有 `NEXT_PUBLIC_API_URL=http://localhost:3004`
- 反向代理场景下前端会自动探测同源 API —— 确保 Nginx 把 `/api/` 和 `/socket.io/` 代理到 3004 端口
- API 必须在前端加载前启动
