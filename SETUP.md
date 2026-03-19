# Setup Guide / 安装指南

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Node.js** | >= 20.0.0 | [nodejs.org](https://nodejs.org/) |
| **pnpm** | >= 9.0.0 | `npm install -g pnpm` |
| **Redis** | >= 7.0 | `brew install redis` (macOS) or [redis.io](https://redis.io/download/) |
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
# Edit .env — add at least one model API key (see below)

# 4. Run
pnpm start
```

This auto-starts Redis, builds packages, and launches both Frontend (port 3003) and API (port 3004).

Open `http://localhost:3003` and start talking to your team.

## Required Configuration

### Model API Keys (at least one)

You need at least one model provider to have a working agent. All three are recommended for full multi-agent collaboration.

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

Clowder works out of the box with just model API keys and Redis. Everything below is opt-in.

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

Chat with your team from Feishu. Requires a Feishu app.

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_VERIFICATION_TOKEN=xxx
```

### Telegram Integration

Chat with your team from Telegram. Requires a bot via @BotFather.

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
```

### GitHub PR Review Notifications

Get notified when GitHub review emails arrive (polls IMAP).

```bash
GITHUB_REVIEW_IMAP_USER=xxx@qq.com
GITHUB_REVIEW_IMAP_PASS=<auth-code>    # app-specific password, not login
GITHUB_REVIEW_IMAP_HOST=imap.qq.com
GITHUB_REVIEW_IMAP_PORT=993

# GitHub MCP tools (for PR operations)
GITHUB_MCP_PAT=ghp_...
```

### Web Push Notifications

Browser push notifications when cats need your attention.

```bash
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

Generate keys: `npx web-push generate-vapid-keys`

### Hindsight (Long-Term Memory)

AI-powered evidence recall and knowledge management. Runs as a Docker container.

```bash
HINDSIGHT_ENABLED=true
HINDSIGHT_URL=http://localhost:18888
```

First start downloads embedding models (~1-3 min). Manage with:
```bash
pnpm hindsight:start    # Docker compose up
pnpm hindsight:status   # Health check
pnpm hindsight:stop     # Shut down
```

## Ports Overview

| Service | Port | Required |
|---------|------|----------|
| Frontend (Next.js) | 3003 | Yes |
| API Backend | 3004 | Yes |
| Redis | 6399 | Yes (or use `--memory`) |
| ASR | 9876 | No — voice input |
| TTS | 9879 | No — voice output |
| LLM Post-process | 9878 | No — speech correction |
| Hindsight API | 18888 | No — long-term memory |
| Hindsight UI | 19999 | No — memory dashboard |

## Useful Commands

```bash
pnpm start              # Start everything (Redis + API + Frontend)
pnpm start --memory     # No Redis, in-memory mode
pnpm start --quick      # Skip rebuild, use existing dist/

pnpm check              # Biome lint + format check
pnpm check:fix          # Auto-fix lint issues
pnpm lint               # TypeScript type check

pnpm redis:user:start   # Start Redis manually
pnpm redis:user:stop    # Stop Redis
pnpm redis:user:backup  # Manual backup
```

## Troubleshooting

**Redis won't start?**
- Check if port 6399 is in use: `lsof -i :6399`
- Make sure Redis is installed: `redis-server --version`

**No agents responding?**
- Check `.env` has at least one valid API key
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
| **Redis** | >= 7.0 | `brew install redis`（macOS）或 [redis.io](https://redis.io/download/) |
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
# 编辑 .env — 至少填一个模型 API key（见下方）

# 4. 启动
pnpm start
```

自动启动 Redis，构建包，启动前端（端口 3003）和 API（端口 3004）。

打开 `http://localhost:3003`，开始和你的团队对话。

## 必须配置

### 模型 API Key（至少一个）

至少需要一个模型 provider 才能有一个可用的 agent。建议三个都配，这样才能完整体验多 agent 协作。

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

只要有模型 API key + Redis，Clowder 就能开箱即用。以下功能全是可选的。

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

在飞书里直接跟猫猫团队聊天。需要创建一个飞书应用。

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_VERIFICATION_TOKEN=xxx
```

### Telegram 接入

在 Telegram 里跟猫猫聊天。需要通过 @BotFather 创建一个 bot。

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
```

### GitHub PR Review 通知

当 GitHub review 邮件到达时自动通知（轮询 IMAP）。

```bash
GITHUB_REVIEW_IMAP_USER=xxx@qq.com
GITHUB_REVIEW_IMAP_PASS=<授权码>    # 应用专用密码，不是登录密码
GITHUB_REVIEW_IMAP_HOST=imap.qq.com
GITHUB_REVIEW_IMAP_PORT=993

# GitHub MCP 工具（用于 PR 操作）
GITHUB_MCP_PAT=ghp_...
```

### Web Push 通知

浏览器推送通知 — 猫猫需要你注意时会提醒。

```bash
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

生成密钥：`npx web-push generate-vapid-keys`

### Hindsight（长期记忆）

AI 驱动的证据检索和知识管理。以 Docker 容器运行。

```bash
HINDSIGHT_ENABLED=true
HINDSIGHT_URL=http://localhost:18888
```

首次启动会下载嵌入模型（约 1-3 分钟）。管理命令：
```bash
pnpm hindsight:start    # Docker compose 启动
pnpm hindsight:status   # 健康检查
pnpm hindsight:stop     # 关闭
```

## 端口概览

| 服务 | 端口 | 必需 |
|------|------|------|
| 前端（Next.js） | 3003 | 是 |
| API 后端 | 3004 | 是 |
| Redis | 6399 | 是（或用 `--memory`） |
| ASR | 9876 | 否 — 语音输入 |
| TTS | 9879 | 否 — 语音输出 |
| LLM 后处理 | 9878 | 否 — 语音纠正 |
| Hindsight API | 18888 | 否 — 长期记忆 |
| Hindsight UI | 19999 | 否 — 记忆面板 |

## 常用命令

```bash
pnpm start              # 启动全部（Redis + API + 前端）
pnpm start --memory     # 无 Redis，纯内存模式
pnpm start --quick      # 跳过重编译，用已有 dist/

pnpm check              # Biome lint + 格式检查
pnpm check:fix          # 自动修复 lint 问题
pnpm lint               # TypeScript 类型检查

pnpm redis:user:start   # 手动启动 Redis
pnpm redis:user:stop    # 停止 Redis
pnpm redis:user:backup  # 手动备份
```

## 常见问题

**Redis 启动不了？**
- 检查端口 6399 是否被占用：`lsof -i :6399`
- 确认 Redis 已安装：`redis-server --version`

**没有 agent 响应？**
- 检查 `.env` 里至少有一个有效的 API key
- 看终端里 API 日志有没有认证错误

**前端连不上 API？**
- 确认设了 `NEXT_PUBLIC_API_URL=http://localhost:3004`
- API 必须在前端加载前启动
