---
feature_ids: [F113]
topics: [deploy, onboarding, linux, macos, windows, community, directory-picker, cross-platform]
doc_kind: spec
created: 2026-03-13
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

### Phase A–C: 一键部署脚本（后续）

- **Phase A**: Linux（`install.sh`）—— 自动检测发行版、安装依赖、配置环境变量、启动服务
- **Phase B**: macOS（`install-mac.sh`）—— Homebrew 前置检测 + 依赖安装
- **Phase C**: Windows（`install.ps1` / WSL 引导）—— PowerShell 脚本或引导用 WSL

脚本应具备：幂等性（重复运行不报错）、版本检测（已安装不重装）、清晰的进度提示。

## Acceptance Criteria

- [ ] AC-D1: 目录选择器不依赖任何 OS 特定 API（无 osascript / zenity / PowerShell）
- [ ] AC-D2: 面包屑导航可在任意层级间跳转
- [ ] AC-D3: 手动输入路径可直接跳转到目标目录
- [ ] AC-D4: 现有功能不退化（项目列表、CWD 推荐、路径校验）
- [ ] AC-1: Linux 用户执行单条命令完成全部安装并能启动服务
- [ ] AC-2: macOS 用户同上
- [ ] AC-3: Windows 用户有明确引导（脚本或 WSL 说明）
- [ ] AC-4: 脚本幂等，重复运行不破坏已有安装

## Notes

clowder-ai #12 (`buildClaudeEnvOverrides` bug) 应先修，否则 Windows 平台安装成功也无法正常使用。
