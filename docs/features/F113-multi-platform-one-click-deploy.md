---
feature_ids: [F113]
topics: [deploy, onboarding, linux, macos, windows, community]
doc_kind: spec
created: 2026-03-13
source: community
community_issue: https://github.com/zts212653/clowder-ai/issues/14
---

# F113: Multi-Platform One-Click Deploy

> **Status**: backlog | **Source**: clowder-ai #14 (mindfn) | **Priority**: P2

## Why

当前安装流程需要手动安装十几个依赖（Node.js、Redis、pnpm、Claude CLI 等），并手动配置环境变量。对新用户门槛过高，特别是非开发者背景的内测小伙伴。

## What

提供针对三大平台的一键部署脚本：

- **Phase A**: Linux（`install.sh`）—— 自动检测发行版、安装依赖、配置环境变量、启动服务
- **Phase B**: macOS（`install-mac.sh`）—— Homebrew 前置检测 + 依赖安装
- **Phase C**: Windows（`install.ps1` / WSL 引导）—— PowerShell 脚本或引导用 WSL

脚本应具备：幂等性（重复运行不报错）、版本检测（已安装不重装）、清晰的进度提示。

## Acceptance Criteria

- [ ] AC-1: Linux 用户执行单条命令完成全部安装并能启动服务
- [ ] AC-2: macOS 用户同上
- [ ] AC-3: Windows 用户有明确引导（脚本或 WSL 说明）
- [ ] AC-4: 脚本幂等，重复运行不破坏已有安装

## Notes

clowder-ai #12 (`buildClaudeEnvOverrides` bug) 应先修，否则 Windows 平台安装成功也无法正常使用。
