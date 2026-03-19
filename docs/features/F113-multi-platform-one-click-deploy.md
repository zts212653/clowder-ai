---
feature_ids: [F113]
topics: [deploy, onboarding, linux, macos, windows, community, directory-picker, cross-platform]
doc_kind: spec
created: 2026-03-13
updated: 2026-03-18
source: community
community_issue: https://github.com/zts212653/clowder-ai/issues/14
---

# F113: Multi-Platform One-Click Deploy

> **Status**: in-progress | **Source**: clowder-ai #14 (mindfn) | **Priority**: P2

## Why

当前安装流程需要手动安装十几个依赖（Node.js、Redis、pnpm、Claude CLI 等），并手动配置环境变量。对新用户门槛过高，特别是非开发者背景的内测小伙伴。

此外，目录选择器（`pick-directory`）依赖 macOS 的 `osascript`，在 Linux/Windows 上完全不可用。我们已有自建的 WorkspaceTree 文件浏览器，应统一用 web-based 方案替代原生系统调用。

## What

### Phase D: 跨平台目录选择器（当前实施）

用 web-based 目录浏览器替代 macOS `osascript` 原生文件夹选择：

- **后端**: 将 `execPickDirectory()`（osascript）替换为基于现有 `browse` API 的跨平台目录列表
- **前端**: `DirectoryPickerModal` 内嵌目录浏览器面板（面包屑导航 + 目录列表 + 路径输入）
- **设计稿**: `designs/f113-cross-platform-directory-picker.pen`（已完成，Design Gate 通过）

UX 要点：
1. 面包屑导航 — Home > projects > relay-station，每层可点击跳转
2. 目录列表 — 只显示文件夹，当前项目高亮
3. 手动路径输入 — 底部保留输入框（高级用户 / 系统路径）
4. 全平台统一体验 — macOS/Windows/Linux 完全一致

### Phase A–C: 一键部署脚本

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

**Step 4: Repo-local Build**
- 要求用户先 clone / download 仓库，再在 repo 内运行 `install.ps1`
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
- API：PowerShell 先加载 `.env`，再启动 `node packages/api/dist/index.js`
- Web：`pnpm --dir packages/web exec next start`
- 配套 `scripts/stop-windows.ps1` 用 `Stop-Process` 级联清理

### Windows 特殊处理清单

| 项目 | Linux 方式 | Windows 适配 |
|------|-----------|-------------|
| 执行 | `bash install.sh` | `powershell -ExecutionPolicy Bypass -File install.ps1` |
| 包管理 | apt/yum | winget / npm |
| 环境变量加载 | `source .env` | PowerShell 进程加载后再启动 Node |
| Redis | 系统包 | `redis-windows` / `--memory` fallback |
| 文件权限 | `chmod 600` | NTFS ACL (`icacls`) |
| Skill 挂载 | `ln -sfn` | symlink / junction |
| CLI spawn | 直接 spawn | `.cmd` shim 绕过 (#64) |
| Git Bash | 不需要 | 自动检测 + 环境变量 (#64) |
| 启动 | `pnpm start` | 独立 `start-windows.ps1` |
| 进程清理 | `kill` / `lsof` | `Stop-Process` / `Get-NetTCPConnection` |

## Acceptance Criteria

- [ ] AC-D1: 目录选择器不依赖任何 OS 特定 API（无 osascript / zenity / PowerShell）
- [ ] AC-D2: 面包屑导航可在任意层级间跳转
- [ ] AC-D3: 手动输入路径可直接跳转到目标目录
- [ ] AC-D4: 现有功能不退化（项目列表、CWD 推荐、路径校验）
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
