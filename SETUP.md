# Setup Guide / 安装指南

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Node.js** | >= 20.0.0 | [nodejs.org](https://nodejs.org/) |
| **pnpm** | >= 9.0.0 | `npm install -g pnpm` |
| **Redis** | >= 7.0 | `brew install redis` (macOS) or [redis.io](https://redis.io/download/) — *optional: use `--memory` flag to skip* |
| **Git** | any recent | Comes with most systems |

## Quick Start

```bash
# 1. Clone
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai

# 2. Install
pnpm install

# 3. Configure
cp .env.example .env
# Edit .env — add model API keys or configure CLI auth (see below)

# 4. Run
pnpm start
```

`pnpm start` uses the **runtime worktree** architecture: it creates an isolated `../cat-cafe-runtime` worktree (on first run), syncs it to `origin/main`, builds, starts Redis, and launches Frontend (port 3003) + API (port 3004). This keeps your development checkout clean.

Open `http://localhost:3003` and start talking to your team.

> **Alternative — One-line installer (Linux):** `bash scripts/install.sh` handles Node, pnpm, Redis, dependencies, `.env`, and first launch in one step. On **Windows**, use `scripts/install.ps1` then `scripts/start-windows.ps1`.

## How `pnpm start` Works (Runtime Worktree)

Clowder uses a **runtime worktree** to keep your dev checkout clean:

```
your-projects/
├── clowder-ai/             # Your development checkout (feature branches, edits)
└── cat-cafe-runtime/       # Auto-created runtime worktree (tracks origin/main)
```

| Command | What it does |
|---------|-------------|
| `pnpm start` | Init (first time) → sync to origin/main → build → start Redis + API + Frontend |
| `pnpm start --memory` | Same, but skip Redis (in-memory store, data lost on restart) |
| `pnpm start --quick` | Same, but skip rebuild (use existing `dist/`) |
| `pnpm start:direct` | Bypass worktree — run dev server directly in current checkout |
| `pnpm runtime:init` | Only create the runtime worktree (no start) |
| `pnpm runtime:sync` | Only sync worktree to origin/main (no start) |
| `pnpm runtime:status` | Show worktree path, branch, HEAD, ahead/behind |

First run creates `../cat-cafe-runtime` automatically. Subsequent runs do a fast-forward sync then start.

## Configuration

### Model API Keys (recommended)

If you use API keys directly, at least one model provider is needed for a working agent. All three are recommended for full multi-agent collaboration.

> **Using CLI auth?** If you've already authenticated via `claude`, `codex`, or `gemini` CLI tools, you can skip API keys — the CLI subscription handles authentication. API keys are only needed for direct API access.

```bash
# Claude (Ragdoll cat / 布偶猫) — recommended as primary
ANTHROPIC_API_KEY=your-anthropic-api-key

# GPT / Codex (Maine Coon / 缅因猫) — code review specialist
OPENAI_API_KEY=your-openai-api-key

# Gemini (Siamese / 暹罗猫) — visual design
GOOGLE_API_KEY=...
```

### Redis

Redis is the persistent store for threads, messages, tasks, and memory.

```bash
REDIS_URL=redis://localhost:6399
```

The `pnpm start` command auto-starts Redis on port 6399. Data persists in `~/.cat-cafe/redis-dev/`.

**No Redis?** Use `pnpm start --memory` for in-memory mode (data lost on restart — fine for trying things out).

### Frontend

```bash
NEXT_PUBLIC_API_URL=http://localhost:3004
```

## Optional Features

Clowder works out of the box with model access (API keys or CLI auth) and Redis (or `--memory` mode). Everything below is opt-in.

### Voice Input / Output

Talk to your cats hands-free. Requires local ASR/TTS services.

```bash
ASR_ENABLED=1
TTS_ENABLED=1
LLM_POSTPROCESS_ENABLED=1

# Speech-to-Text (ASR)
WHISPER_URL=http://localhost:9876
NEXT_PUBLIC_WHISPER_URL=http://localhost:9876

# Text-to-Speech (TTS)
TTS_URL=http://localhost:9879
TTS_CACHE_DIR=./data/tts-cache

# Speech correction (LLM post-processing)
NEXT_PUBLIC_LLM_POSTPROCESS_URL=http://localhost:9878
```

Supported engines: Qwen3-ASR (primary), Whisper (fallback) for input; Kokoro, edge-tts, Qwen3-TTS for output.
These services are disabled by default. Set the corresponding `*_ENABLED=1` flags only after you have installed the local dependencies.

**Starting voice services:**
```bash
# TTS (Text-to-Speech) — requires Python 3, creates venv at ~/.cat-cafe/tts-venv
./scripts/tts-server.sh                    # default: Qwen3-TTS (三猫声线)
TTS_PROVIDER=edge-tts ./scripts/tts-server.sh  # edge-tts fallback (no GPU needed)

# ASR (Speech-to-Text) — requires Python 3 + ffmpeg
./scripts/qwen3-asr-server.sh             # Qwen3-ASR server
```

> **System dependency**: `ffmpeg` is required for audio processing. Install with `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Linux).

### API Gateway Proxy

Optional reverse proxy for routing API requests through third-party gateways. Useful when you need to route Claude API calls through a custom endpoint.

```bash
ANTHROPIC_PROXY_ENABLED=1          # default: 0 (disabled)
ANTHROPIC_PROXY_PORT=9877          # proxy listen port
```

Configure upstreams in `.cat-cafe/proxy-upstreams.json`:
```json
{ "my-gateway": "https://your-gateway.example.com/api" }
```

### Feishu (飞书 / Lark) Integration

Chat with your team from Feishu. Requires a self-built Feishu app.

**Step 1 — Create a Feishu app:**
Go to [Feishu Open Platform](https://open.feishu.cn/app) → Create Custom App (自建应用).

**Step 2 — Enable permissions:**
Under Permissions & Scopes (权限管理), add:
- `im:message` — read messages
- `im:message:send_as_bot` — send messages as bot
- `im:resource` — read media resources (images, files)
- `im:resource:upload` — upload media (required for native voice bubbles and image display)

> **Why `im:resource:upload`?** Without it, voice messages appear as text URLs and images are sent as links instead of native media. The bot automatically converts WAV audio to Opus format (via ffmpeg) and uploads it to Feishu for playback.

**Step 3 — Configure event subscription:**
Under Event Subscriptions (事件订阅):
- **Request URL**: `http(s)://<your-host>:3004/api/connectors/feishu/webhook`
- Subscribe to event: `im.message.receive_v1`
- The system auto-responds to Feishu's URL verification challenge.

**Step 4 — Set env vars:**
```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_VERIFICATION_TOKEN=xxx    # from Event Subscriptions page
```

**Step 5 — Enable the bot:**
In the Feishu app console → Bot (机器人), enable the bot capability. Users can then DM the bot to chat with your AI team.

> Currently supports DM (1:1) only. Group chat support is planned.

### Telegram Integration

> **Status: In Progress** — adapter code exists but not yet deployed/verified in production.

Chat with your team from Telegram. Requires a bot via @BotFather.

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
```

### GitHub PR Review Notifications

Get notified when GitHub review emails arrive (polls IMAP). Review comments are automatically routed to the right cat and thread.

```bash
# QQ Mail example
GITHUB_REVIEW_IMAP_USER=xxx@qq.com
GITHUB_REVIEW_IMAP_PASS=<auth-code>    # app-specific password, not login
GITHUB_REVIEW_IMAP_HOST=imap.qq.com
GITHUB_REVIEW_IMAP_PORT=993

# Gmail example (requires 2FA + App Password)
# GITHUB_REVIEW_IMAP_USER=xxx@gmail.com
# GITHUB_REVIEW_IMAP_PASS=<app-password>    # Google Account → Security → App Passwords
# GITHUB_REVIEW_IMAP_HOST=imap.gmail.com
# GITHUB_REVIEW_IMAP_PORT=993

# Outlook / Hotmail example
# GITHUB_REVIEW_IMAP_USER=xxx@outlook.com
# GITHUB_REVIEW_IMAP_PASS=<app-password>    # Microsoft Account → Security → App Passwords
# GITHUB_REVIEW_IMAP_HOST=outlook.office365.com
# GITHUB_REVIEW_IMAP_PORT=993

# GitHub MCP tools (for PR operations + review content fetching)
GITHUB_MCP_PAT=ghp_...
```

**How routing works (3-tier):**
1. **PR Registration** (primary): Cats register PRs via `register_pr_tracking` MCP tool when they open a PR. When a review email arrives, it routes directly to that cat's thread.
2. **Title Tag** (fallback): If no registration found, the system looks for a cat name tag in the PR title (e.g., `[宪宪🐾]`) and routes to that cat's Review Inbox.
3. **Triage** (last resort): If no cat can be identified, the review goes to a Triage thread for manual assignment.

Review content is fetched via GitHub API (using `GITHUB_MCP_PAT`) for automatic severity extraction (P0/P1/P2 labeling).

### Web Push Notifications

Browser push notifications when cats need your attention.

```bash
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

Generate keys: `npx web-push generate-vapid-keys`

### Long-Term Memory (Evidence Store)

Project knowledge (decisions, lessons, discussions) is stored locally in SQLite — no external services required.

Each project gets its own `evidence.sqlite` file (auto-created on first run) with FTS5 full-text search. Data stays on your machine.

Cats use `search_evidence` and `reflect` MCP tools to query this store. No configuration needed — it works out of the box.

## Agent CLI Configuration

Each agent CLI (Claude Code, Codex, Gemini CLI) has its own configuration. Clowder provides project-level MCP server configs that connect agents to the platform:

- **Claude Code**: reads `.mcp.json` for MCP servers, `CLAUDE.md` for project instructions
- **Codex CLI**: reads `.codex/config.toml` for MCP servers, `AGENTS.md` for project instructions
- **Gemini CLI**: reads `.gemini/settings.json` for MCP servers, `GEMINI.md` for project instructions

### Codex CLI — "Stuck in a Box" Fix

If Codex (Maine Coon / 缅因猫) reports being unable to access files or tools, it's likely running in sandbox mode. Add these settings to your **user-level** Codex config (`~/.codex/config.toml`):

```toml
approval_policy = "on-request"         # ask before dangerous ops
sandbox_mode = "danger-full-access"    # allow file/network access

[sandbox_workspace_write]
network_access = true
```

> The project-level `.codex/config.toml` only contains MCP server definitions. Runtime settings like `sandbox_mode` and `approval_policy` must be set in `~/.codex/config.toml`.

## Windows Setup

Full Windows support is available via PowerShell scripts.

```powershell
# Install everything (Node.js, pnpm, Redis, CLI tools, auth)
.\scripts\install.ps1

# Start services
.\scripts\start-windows.ps1            # Full start (build + run)
.\scripts\start-windows.ps1 -Quick     # Skip rebuild
.\scripts\start-windows.ps1 -Memory    # No Redis (in-memory mode)

# Stop services
.\scripts\stop-windows.ps1
```

> **Note**: `scripts/install.sh` is Linux-only (Debian/RHEL). macOS users should install prerequisites manually (`brew install node pnpm redis`) and run `pnpm install && pnpm start`.

## Ports Overview

| Service | Port | Required |
|---------|------|----------|
| Frontend (Next.js) | 3003 | Yes |
| API Backend | 3004 | Yes |
| Redis | 6399 | Yes (or use `--memory`) |
| ASR | 9876 | No — voice input |
| TTS | 9879 | No — voice output |
| LLM Post-process | 9878 | No — speech correction |

## Useful Commands

```bash
# === Startup ===
pnpm start              # Start everything (Redis + API + Frontend) via runtime worktree
pnpm start --memory     # No Redis, in-memory mode
pnpm start --quick      # Skip rebuild, use existing dist/
pnpm start:direct       # Start dev server directly (bypasses worktree)

# === Runtime Worktree ===
pnpm runtime:init       # Create runtime worktree (first time only)
pnpm runtime:sync       # Sync worktree to origin/main
pnpm runtime:start      # Sync + start from worktree
pnpm runtime:status     # Show worktree status

# === Build & Test ===
pnpm build              # Build all packages
pnpm dev                # Run all packages in parallel dev mode
pnpm test               # Run all tests

# === Code Quality ===
pnpm check              # Biome lint + format + feature doc + env-port drift checks
pnpm check:fix          # Auto-fix lint issues
pnpm lint               # TypeScript type check (per-package)
pnpm check:deps         # Dependency graph check (depcruise)
pnpm check:lockfile     # Verify lockfile integrity
pnpm check:features     # Feature doc compliance check
pnpm check:env-ports    # Env-port drift detection

# === Redis ===
pnpm redis:user:start   # Start Redis manually
pnpm redis:user:stop    # Stop Redis
pnpm redis:user:status  # Check Redis status
pnpm redis:user:backup  # Manual backup

# Redis auto-backup (cron-based)
pnpm redis:user:autobackup:install    # Install autobackup cron job
pnpm redis:user:autobackup:run        # Run backup now
pnpm redis:user:autobackup:status     # Check autobackup status
pnpm redis:user:autobackup:uninstall  # Remove autobackup cron job

# === Thread Exports ===
pnpm threads:sync       # Sync thread exports
pnpm threads:status     # Check thread export status
pnpm threads:export:redis              # Export threads from Redis
pnpm threads:export:redis:dry-run      # Dry-run export

# Thread auto-save (cron-based)
pnpm threads:autosave:install          # Install autosave cron job
pnpm threads:autosave:run              # Run autosave now
pnpm threads:autosave:status           # Check autosave status
pnpm threads:autosave:uninstall        # Remove autosave cron job

# === Alpha Worktree (pre-release testing) ===
pnpm alpha:init         # Create alpha worktree (../cat-cafe-alpha)
pnpm alpha:sync         # Sync alpha worktree to origin/main
pnpm alpha:start        # Start alpha environment (ports 3011/3012)
pnpm alpha:status       # Show alpha worktree status
pnpm alpha:test         # Run alpha integration tests
```

## Troubleshooting

**Redis won't start?**
- Check if port 6399 is in use: `lsof -i :6399`
- Make sure Redis is installed: `redis-server --version`

**No agents responding?**
- Check `.env` has at least one valid API key, or verify CLI auth is working (`claude --version`, `codex --version`)
- Check the API logs in terminal for auth errors

**Frontend can't connect to API?**
- Make sure `NEXT_PUBLIC_API_URL=http://localhost:3004` is set
- API must be running before frontend loads

---

<a id="中文"></a>

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

# 3. 配置环境
cp .env.example .env
# 编辑 .env — 添加模型 API key 或配置 CLI 认证（见下方）

# 4. 启动
pnpm start
```

`pnpm start` 使用**运行时 worktree** 架构：首次运行时自动创建隔离的 `../cat-cafe-runtime` worktree，同步到 `origin/main`，构建，启动 Redis，然后启动前端（端口 3003）+ API（端口 3004）。这样你的开发目录保持干净。

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
| `pnpm start:direct` | 跳过 worktree — 直接在当前目录启动 dev server |
| `pnpm runtime:init` | 只创建运行时 worktree（不启动） |
| `pnpm runtime:sync` | 只同步 worktree 到 origin/main（不启动） |
| `pnpm runtime:status` | 显示 worktree 路径、分支、HEAD、ahead/behind |

首次运行自动创建 `../cat-cafe-runtime`。后续运行做 fast-forward 同步后启动。

## 配置

### 模型 API Key（推荐）

如果直接使用 API key，至少需要一个模型 provider 才能有一个可用的 agent。建议三个都配，这样才能完整体验多 agent 协作。

> **用 CLI 认证？** 如果你已经通过 `claude`、`codex` 或 `gemini` CLI 工具登录认证，可以跳过 API key — CLI 订阅会处理认证。API key 只在直接调用 API 时需要。

```bash
# Claude（布偶猫/宪宪）— 推荐作为主力
ANTHROPIC_API_KEY=your-anthropic-api-key

# GPT / Codex（缅因猫/砚砚）— 代码审查专家
OPENAI_API_KEY=your-openai-api-key

# Gemini（暹罗猫/烁烁）— 视觉设计
GOOGLE_API_KEY=...
```

### Redis

Redis 是线程、消息、任务和记忆的持久化存储。

```bash
REDIS_URL=redis://localhost:6399
```

`pnpm start` 会自动启动 Redis（端口 6399）。数据持久化在 `~/.cat-cafe/redis-dev/`。

**没有 Redis？** 用 `pnpm start --memory` 启动纯内存模式（重启后数据丢失 — 试玩够用了）。

### 前端

```bash
NEXT_PUBLIC_API_URL=http://localhost:3004
```

## 可选功能

只要有模型访问（API key 或 CLI 认证）+ Redis（或 `--memory` 模式），Clowder 就能开箱即用。以下功能全是可选的。

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

> **注意**：`scripts/install.sh` 仅适用于 Linux（Debian/RHEL）。macOS 用户请手动安装依赖（`brew install node pnpm redis`）后运行 `pnpm install && pnpm start`。

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
pnpm start:direct       # 直接启动 dev server（跳过 worktree）

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

## 常见问题

**Redis 启动不了？**
- 检查端口 6399 是否被占用：`lsof -i :6399`
- 确认 Redis 已安装：`redis-server --version`

**没有 agent 响应？**
- 检查 `.env` 里有有效的 API key，或确认 CLI 认证正常（`claude --version`、`codex --version`）
- 看终端里 API 日志有没有认证错误

**前端连不上 API？**
- 确认设了 `NEXT_PUBLIC_API_URL=http://localhost:3004`
- API 必须在前端加载前启动
