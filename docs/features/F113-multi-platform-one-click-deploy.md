---
feature_ids: [F113]
topics: [deploy, onboarding, linux, macos, windows, community]
doc_kind: spec
created: 2026-03-13
updated: 2026-03-16
source: community
community_issue: https://github.com/zts212653/clowder-ai/issues/14
---

# F113: Multi-Platform One-Click Deploy

> **Status**: in-progress | **Source**: clowder-ai #14 (mindfn) | **Priority**: P2

## Why

当前安装流程需要手动安装十几个依赖（Node.js、Redis、pnpm、Claude CLI 等），并手动配置环境变量。对新用户门槛过高，特别是非开发者背景的内测小伙伴。

## Current State

- [clowder-ai #14](https://github.com/zts212653/clowder-ai/issues/14) 已被明确为 F113 的 umbrella issue，用来聚合 Linux / macOS / Windows 的整体进度。
- [PR #102](https://github.com/zts212653/clowder-ai/pull/102) 已形成 Linux 一键安装的 9 步骨架，但当前仍未合入。
- 截至 GitHub `main@1cc0bce`，Windows 关键兼容修复仍未在主线落地：
  - `packages/api/src/utils/cli-spawn.ts` 仍是直接 `spawn(command, args)`，没有 #64 的 `.cmd` shim 绕过逻辑。
  - `ClaudeAgentService.ts` 的 `buildClaudeEnvOverrides()` 仍会在 `callbackEnv` 缺失时返回 `undefined`。
  - `scripts/start-dev.sh` 仍依赖 Bash `source .env`、`lsof` 和 `kill $(jobs -p)`，不能作为 Windows 启动链路。

## Phase Plan

- **Phase A**: Linux（`scripts/install.sh`）—— 沿用 PR #102 的 9 步骨架。
- **Phase B**: macOS（`scripts/install-mac.sh`）—— 复用 Linux install contract，改用 Homebrew / macOS 原生依赖检查。
- **Phase C**: Windows 11（`scripts/install.ps1` + `scripts/start-windows.ps1`）—— PowerShell 原生安装与启动，不把 WSL 作为默认路径。

## Team Lead Decisions (2026-03-16)

- **Redis**：Windows 本地 Redis 方案优先评估 [`redis-windows/redis-windows`](https://github.com/redis-windows/redis-windows)，同时保留 external Redis 和 `--memory` fallback。
- **Node.js**：以 `winget` 为首选安装方式，且安装器内所有可静默的步骤都应优先走 silent install。
- **#64**：不要求先拆成独立前置 PR；Windows installer 与 #64 的 runtime 修复可以在同一个 F113 PR 一起交付。

## Windows 11 Scope

- 只支持 **Windows 11 x64**；Windows 10、WSL2-first、MSI/EXE 打包不在本次范围。
- 裸机前提：正常联网（可走 proxy/mirror），已安装 Git，无 GitHub 凭证，有系统自带 PowerShell 5.1。
- "一键安装完成"定义：单条 PowerShell 命令结束后，用户能看到可用的 Web UI，并能至少驱动 Claude / Codex 其中之一工作。

## Windows v1 Design

Native PowerShell Installer + Production-like Runtime。

### 阻塞依赖

| 依赖 | 说明 |
|------|------|
| #64 | Windows CLI spawn 修复（`.cmd` shim 绕过 + Git Bash 自动发现 + 嵌套检测清除），与 installer 同 PR 交付 |
| #21 | skills mount / symlink 逻辑必须进入 Windows 安装器 |
| #105 | Windows 不复用 `start-dev.sh` / `tsx watch`，需独立启动脚本 |

### 安装流程（9 步）

**Step 1: 环境检测**
- Windows 11 版本、管理员权限、PowerShell 版本、执行策略
- `winget` 可用性检测；Git 安装位置与 Git Bash 路径

**Step 2: Node / pnpm / 原生依赖**
- 首选 `winget install OpenJS.NodeJS.LTS`（silent install）
- `pnpm` 优先 `corepack`，失败走 `npm install -g pnpm`
- 原生模块先走预编译；node-gyp 失败时才装 Build Tools

**Step 3: Redis 策略**
- 优先评估 `redis-windows/redis-windows`（silent install + 服务注册）
- 失败降级到 external Redis URL 或 `--memory` 模式

**Step 4: Clone / Update / Build**
- `git clone` 或更新已存在目录
- `pnpm install --frozen-lockfile` + 分步构建 shared/mcp-server/api/web

**Step 5: Skills 挂载**
- `cat-cafe-skills/*` 挂到 `~/.claude/skills`、`~/.codex/skills`、`~/.gemini/skills`
- 优先 directory junction / symlink；权限不足时给明确提示

**Step 6: AI CLI 工具**
- Claude / Codex / Gemini 按需安装，支持交互式多选
- Claude 安装后记录 Git Bash 路径供 #64 使用

**Step 7: 认证配置**
- OAuth 默认，API Key 可选
- Claude → `.cat-cafe/provider-profiles*.json`；Codex/Gemini → `.env`

**Step 8: 生成 `.env`**
- 从 `.env.example` 复制并写入配置
- PowerShell 原生文本处理，不依赖 Bash

**Step 9: 启动与收尾**
- 调用 `scripts/start-windows.ps1`（production-like 模式）
- API：`node --env-file=.env packages/api/dist/index.js`
- Web：`pnpm --dir packages/web exec next start`
- 配套 `scripts/stop-windows.ps1` 用 `Stop-Process` 级联清理

### Windows 特殊处理清单

| 项目 | Linux 方式 | Windows 适配 |
|------|-----------|-------------|
| 执行 | `bash install.sh` | `powershell -ExecutionPolicy Bypass -File install.ps1` |
| 包管理 | apt/yum | winget / npm |
| 环境变量加载 | `source .env` | `node --env-file=.env` |
| Redis | 系统包 | `redis-windows` / `--memory` fallback |
| 文件权限 | `chmod 600` | NTFS ACL (`icacls`) |
| Skill 挂载 | `ln -sfn` | symlink / junction |
| CLI spawn | 直接 spawn | `.cmd` shim 绕过 (#64) |
| Git Bash | 不需要 | 自动检测 + 环境变量 (#64) |
| 启动 | `pnpm start` | 独立 `start-windows.ps1` |
| 进程清理 | `kill` / `lsof` | `Stop-Process` / `Get-NetTCPConnection` |

## Acceptance Criteria

- [ ] AC-1: Linux 用户执行单条命令完成全部安装并能启动服务
- [ ] AC-2: macOS 用户同上
- [ ] AC-3: Windows 11 用户在裸机上执行单条 PowerShell 命令完成安装并启动
- [ ] AC-4: 脚本幂等，重复运行不破坏已有安装
- [ ] AC-5: Windows 版含 #64 CLI spawn 修复，安装后猫可正常启动
- [ ] AC-6: Windows 默认路径不要求 WSL
- [ ] AC-7: Windows 安装器完成 skills 挂载
- [ ] AC-8: Windows 启动链路不依赖 `start-dev.sh` / `tsx watch`

## Notes

- #12 是早期 Windows 诊断报告，保留为参考。
- #94 多 worktree 治理属后续风险，不阻塞 first boot。
- #95 Gemini OAuth 稳定性需在安装完成页提示。
- #92 Windows UI 渲染差异属后续优化。
