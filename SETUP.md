# Setup Guide

**English** | [中文](SETUP.zh-CN.md)

---

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

# 3. Build (required — creates dist/ for workspace packages)
pnpm build

# 4. Configure
cp .env.example .env
# Edit .env — add model API keys or configure CLI auth (see below)

# 5. Run
pnpm start
# If this fails with "target path exists", use:
#   pnpm start:direct
```

`pnpm start` uses the **runtime worktree** architecture: it creates an isolated `../cat-cafe-runtime` worktree (on first run), syncs it to `origin/main`, builds, starts Redis, and launches Frontend (port 3003) + API (port 3004). This keeps your development checkout clean.

> **Tip:** If `pnpm start` fails because `../cat-cafe-runtime` already exists, use `pnpm start:direct` instead — it runs directly in your current checkout without creating a worktree. You can also set a custom path: `CAT_CAFE_RUNTIME_DIR=../my-runtime pnpm start`.

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

> **Custom runtime path:** Set `CAT_CAFE_RUNTIME_DIR` to use a different location: `CAT_CAFE_RUNTIME_DIR=../my-clowder-runtime pnpm start`

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

> **Note**: `scripts/install.sh` is Linux-only (Debian/RHEL). macOS users should install prerequisites manually (`brew install node pnpm redis`) and run `pnpm install && pnpm build && pnpm start`.

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

**`pnpm start` fails with "target path exists"?**
- The runtime worktree path `../cat-cafe-runtime` is already occupied by another project or directory
- **Quick fix:** Use `pnpm start:direct` to bypass the worktree and run directly in your checkout
- **Alternative:** Set a custom runtime path: `CAT_CAFE_RUNTIME_DIR=../my-clowder-runtime pnpm start`
- If you don't need Redis: `pnpm start:direct -- --memory`

**Redis won't start?**
- Check if port 6399 is in use: `lsof -i :6399`
- Make sure Redis is installed: `redis-server --version`

**No agents responding?**
- Check `.env` has at least one valid API key, or verify CLI auth is working (`claude --version`, `codex --version`)
- Check the API logs in terminal for auth errors

**Frontend can't connect to API?**
- Make sure `NEXT_PUBLIC_API_URL=http://localhost:3004` is set
- API must be running before frontend loads

