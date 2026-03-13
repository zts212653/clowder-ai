---
feature_ids: [F113]
related_features: [F087]
topics: [devops, setup, linux]
doc_kind: spec
created: 2026-03-13
---

# F113: Linux One-Click Deploy

> **Status**: spec | **Owner**: opus | **Priority**: P1

## Why

目前 Cat Cafe 的安装流程主要在 macOS 上验证过，缺乏 Linux 裸机一键部署能力。新用户在 Linux 服务器上需要手动安装 Node.js、pnpm、Redis、AI CLI 等依赖，过程繁琐易出错。

需要一个交互式安装脚本，让用户在全新的 Linux 机器上运行一条命令就能完成全部环境配置。

## What

### Phase A: 核心安装流程

实现单文件 bash 脚本，支持：

1. **系统检测** — 自动识别发行版（Debian/Ubuntu, RHEL/CentOS/Fedora, Arch 等）和包管理器
2. **依赖检测 & 安装** — 逐项检测并询问用户：
   - Git — 检测 → [已安装/自动安装/稍后配置]
   - build-tools (gcc, make, python3) — better-sqlite3 编译依赖
   - Node.js >= 20.0.0 — 通过 fnm 安装
   - pnpm >= 9.0.0
   - Redis >= 7.0 — 或选择内存模式跳过
3. **AI Client 检测 & 安装引导**：
   - Claude CLI — 检测 → [已安装/安装引导/跳过]
   - Codex CLI — 检测 → [已安装/安装引导/跳过]
   - Gemini CLI — 检测 → [已安装/安装引导/跳过]
4. **配置交互** — 对已安装的 Client 询问：[API Key 配置 / 稍后登录]
5. **项目安装** — 克隆仓库、pnpm install、生成 .env
6. **验证** — 确认环境就绪，显示启动命令

### Phase B: 优化与测试

- Docker 测试镜像（Ubuntu/Debian/CentOS）
- 非交互模式 (`--auto` 标志)
- 卸载/重装支持

## Acceptance Criteria

### Phase A（核心安装流程）
- [ ] AC-A1: 脚本可通过 `curl -fsSL ... | bash` 方式运行
- [ ] AC-A2: 正确检测 Debian/Ubuntu (apt)、RHEL/CentOS/Fedora (dnf/yum)、Arch (pacman)
- [ ] AC-A3: 每个依赖先检测再询问安装方式
- [ ] AC-A4: Node.js 通过 fnm 安装，版本 >= 20.0.0
- [ ] AC-A5: AI Client 支持 API Key 配置或稍后登录两种模式
- [ ] AC-A6: 安装完成后用户可直接运行启动命令

### Phase B（优化与测试）
- [ ] AC-B1: 提供 Docker 测试镜像验证各发行版
- [ ] AC-B2: 支持 `--auto` 非交互模式

## Dependencies

- **Evolved from**: F087（CVO Bootcamp，其中的环境检查逻辑可复用）
- **Related**: scripts/setup.sh（现有交互式向导，复用部分逻辑）

## Risk

| 风险 | 缓解 |
|------|------|
| 发行版差异导致安装失败 | 先支持主流发行版，其他标记为实验性 |
| AI CLI 安装方式变化 | 脚本中只做检测和引导，不硬编码安装命令 |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | 是否需要支持 WSL2？ | 待定（Windows 后续支持）|
| OQ-2 | Hindsight 是否纳入安装流程？ | 待定 |
| OQ-3 | macOS 支持 | 后续 Phase，复用 Linux 逻辑 + Homebrew |
| OQ-4 | Windows 支持 | 后续 Phase，需单独实现 PowerShell 版本 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 单文件脚本，不拆分 lib | 方便 curl \| bash 分发 | 2026-03-13 |
| KD-2 | 依赖通过 fnm 安装 Node.js | 不污染系统 Node，便于版本管理 | 2026-03-13 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-03-13 | 立项（Bootcamp Q7 任务） |

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Feature** | `docs/features/F087-cvo-bootcamp.md` | Bootcamp 环境检查逻辑 |
| **Script** | `scripts/setup.sh` | 现有交互式向导 |
| **Issue** | [#14](https://github.com/zts212653/clowder-ai/issues/14) | 多平台裸机支持总 issue |
