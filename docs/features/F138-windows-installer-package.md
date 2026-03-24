---
feature_ids: [F138]
related_features: [F113, F132]
topics: [windows, installer, electron, desktop, packaging]
doc_kind: spec
created: 2026-03-24
---

# F138: Windows Installer Package

> **Status**: impl | **Owner**: Ragdoll | **Priority**: P1

## Why

当前 Windows 用户需要手动 clone 仓库、安装依赖、运行脚本，门槛高。
铲屎官原话："做成一个 Windows 上的可安装包，安装完后，我能直接点击一个 Windows 应用，在应用里使用猫猫"

## What

### 安装包内容
- Clowder AI 源码（预构建）
- DARE 源码（直接拷贝，非 submodule）
- Electron 桌面壳（预构建）

### 安装流程
1. 用户双击 `ClowderAI-Setup-x.x.x.exe`
2. Inno Setup 解压文件到 `C:\Program Files\ClowderAI\`
3. 组件选择页面（默认 minimal）：
   - [x] Core + DARE（固定，不可取消）
   - [ ] Claude CLI（默认关）
   - [ ] Codex CLI（默认关）
   - [ ] Gemini CLI（默认关）
   - [ ] OpenCode CLI（默认关）
4. 静默运行 `install.ps1 -SkipCli`（装 Node.js、Redis、依赖）
5. 按选择安装 CLI tools
6. 生成 `desktop-config.json`（记录哪些 CLI 已装）
7. 创建桌面快捷方式

### 猫猫可见性
- 未安装 CLI 的猫猫**在 UI 中不显示**
- 通过 `desktop-config.json` 控制，API 层过滤
- DARE 始终可见（源码内嵌）
- 孟加拉猫（antigravity）始终隐藏（需特殊基础设施）

### 桌面应用
- Electron 窗口，启动时自动拉起 Redis + API + Web
- 系统托盘驻留，关闭窗口 → 最小化到托盘
- 双击托盘图标恢复

## Tech Stack

| 组件 | 技术 |
|------|------|
| 安装包 | Inno Setup 6 |
| 桌面壳 | Electron 35 |
| 服务管理 | Node.js child_process |
| 构建脚本 | PowerShell (`build-desktop.ps1`) |

## Key Files

| 文件 | 用途 |
|------|------|
| `desktop/main.js` | Electron 主进程 |
| `desktop/service-manager.js` | 子进程管理（Redis/API/Web） |
| `desktop/splash.html` | 启动加载画面 |
| `installer/clowder-ai.iss` | Inno Setup 脚本 |
| `scripts/build-desktop.ps1` | 打包构建流水线 |
| `scripts/generate-desktop-config.ps1` | 安装时生成桌面配置 |
| `packages/api/src/routes/cats.ts` | API 层猫猫可见性过滤 |

## Build Pipeline

```
build-desktop.ps1 -DarePath C:\src\dare-cli
  1. Copy DARE source → vendor/dare-cli/
  2. pnpm install + build
  3. electron-builder --win --dir → desktop-dist/
  4. iscc.exe installer/clowder-ai.iss → dist/ClowderAI-Setup-0.2.0.exe
```

## Acceptance Criteria

- [ ] AC-1: 双击 .exe 安装包完成全部安装（含 Node.js、Redis）
- [ ] AC-2: 默认不安装 Claude/Codex/Gemini CLI
- [ ] AC-3: 安装后桌面有 "Clowder AI" 快捷方式
- [ ] AC-4: 点击快捷方式 → Electron 窗口启动 → 可正常使用猫猫
- [ ] AC-5: 未安装 CLI 的猫猫在 UI 中不可见
- [ ] AC-6: DARE 默认可用且在 UI 中可见
- [ ] AC-7: 卸载程序可正常卸载

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Electron 独立窗口（非系统浏览器） | 铲屎官要求独立应用体验 | 2026-03-24 |
| KD-2 | DARE 直接拷贝源码（非 submodule） | 简化安装包制作，避免 submodule 复杂度 | 2026-03-24 |
| KD-3 | Inno Setup（非 NSIS/WiX） | 成熟、支持中文、自定义页面方便 | 2026-03-24 |
| KD-4 | API 层过滤猫猫（非前端） | 最小改动，前端无需修改 | 2026-03-24 |

## Dependencies

- F113: Multi-Platform One-Click Deploy（install.ps1 复用）
- F132/F135: DARE OOTB（DARE 源码内嵌）
