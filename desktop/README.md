# Clowder AI Desktop

基于 Electron 的桌面应用壳层，为 Clowder AI 提供一键启动、系统托盘和独立窗口体验。

## 设计哲学

Electron 在此项目中充当**"服务编排器 + 浏览器壳"**，而非将后端逻辑编译进 Electron 内部：

- ✅ Electron 启动时拉起后端进程（Redis / API / Web），加载 `localhost:3003`
- ✅ 托盘图标、右键菜单、任务栏独立身份
- ✅ 单实例锁：防止重复启动导致端口冲突
- ❌ Electron 壳不内嵌 Node.js 依赖安装、环境检测、版本升级逻辑

后端（Redis / API / Web）仍然作为独立 Node.js 子进程运行，通过 `loadURL` 加载本地前端。这种设计保持了原有 Web 架构的完整性，同时提供了桌面级的托盘体验和一键启动能力。

## 目录结构

```
desktop/
├── main.js              # Electron 主进程：窗口管理、托盘、生命周期
├── preload.js           # 安全的 IPC 桥接（Splash 页面状态通信）
├── service-manager.js   # 子进程管理：启动 Redis、API、Next.js
├── splash.html          # 启动画面（显示服务启动状态）
├── package.json         # Electron 包配置与 electron-builder 构建设置
└── assets/
    ├── icon.ico         # Windows 图标
    └── icon.png         # 通用图标
```

## 前置要求

1. **Node.js** ≥ 20（与主项目一致）
2. **pnpm** ≥ 8（主项目依赖管理）
3. 主项目已完成构建：
   ```bash
   pnpm install
   pnpm build
   ```

## 快速开始

### 开发模式（直接从源码启动）

```bash
# 1. 安装主项目依赖（已包含 electron 和 electron-builder）
pnpm install

# 2. 构建主项目
pnpm build

# 3. 启动桌面应用（Windows）
pnpm desktop:dev

# macOS / Linux
pnpm desktop:dev:unix
```

> **注意**：如果从 VSCode 等基于 Electron 的编辑器内置终端启动，可能会遇到 `ELECTRON_RUN_AS_NODE` 环境变量污染问题。根目录的 `desktop:dev` 脚本已内置清除逻辑，推荐直接使用。

### 根目录快捷脚本

```bash
# 开发启动（Windows）
pnpm desktop:dev

# 开发启动（Unix）
pnpm desktop:dev:unix

# 构建可分发的桌面应用（输出到 desktop/dist/）
pnpm desktop:build

# 仅打包目录结构（不解压，用于调试）
pnpm desktop:pack

# 构建完整的 Windows 安装包（需要 Inno Setup 6）
pnpm desktop:installer
# 或带参数跳过某些步骤
powershell .\desktop\scripts\build-desktop.ps1 -SkipWebBuild -SkipBundleDeps
```

## 打包分发

### electron-builder 打包

```bash
pnpm desktop:pack
```

打包产物位于 `desktop/dist/win-unpacked/`，包含可直接运行的 `Clowder AI.exe`。

### 完整离线安装包（推荐）

构建一个独立的 `.exe` 安装程序，**无需网络、无需手动 `pnpm install`**，安装完成后直接可用：

```bash
# 一键构建完整安装包（需要 Inno Setup 6）
pnpm desktop:installer

# 或直接使用 PowerShell 并跳过某些步骤
.\desktop\scripts\build-desktop.ps1 -SkipWebBuild -SkipBundleDeps
```

构建流程（`desktop/scripts/build-desktop.ps1`）：
1. 构建 Web 应用（`pnpm build`）
2. 打包 production `node_modules` 为 `node_modules.tar.gz`
3. 缓存 AI CLI 工具 tarball（Claude / Codex / Gemini，最佳努力）
4. 下载/复制 Windows 便携版 Redis
5. 构建 Electron 壳（`electron-builder --win --dir`）
6. 编译 Inno Setup 安装包（`dist/ClowderAI-Setup-x.x.x.exe`）

安装包在目标机器上执行：
- 复制源码 + 构建产物 + Electron 壳
- 解压预打包的 `node_modules.tar.gz`（2-5 分钟）
- 从缓存 tarball 或网络安装 AI CLI 工具（如有）
- 配置 `.env` 和 skills 软链接
- 创建桌面快捷方式
- 注册表启用 Windows 长路径支持

### 离线安装包特性

| 特性 | 状态 | 说明 |
|------|------|------|
| 零网络安装 | ✅ | `node_modules` + Redis + 构建产物全部预打包 |
| 长路径支持 | ✅ | 安装时自动启用 Windows LongPathsEnabled |
| 单实例运行 | ✅ | 重复启动会聚焦已有窗口 |
| 系统托盘 | ✅ | 最小化到托盘，右键菜单 |
| AI CLI 工具 | ⚠️ 部分 | 优先从 bundled tarball 离线安装；无缓存时尝试联网；均失败则提示手动安装 |
| 自动更新 | ❌ | 需手动下载新版安装包覆盖安装 |

## 调试

桌面应用的运行日志会写入系统临时目录：

- **主进程日志**：`%TEMP%\clowder-main.log`
- **服务管理日志**：`%TEMP%\clowder-desktop.log`

## 故障排查

| 问题 | 可能原因 | 解决方式 |
|------|---------|---------|
| `app` 为 undefined | `ELECTRON_RUN_AS_NODE=1` 被继承 | 使用 `pnpm start` 脚本启动，或手动 `Remove-Item Env:ELECTRON_RUN_AS_NODE` |
| API 启动失败（Redis PING failed） | Redis 未找到且环境变量冲突 | 检查 `clowder-desktop.log`，确认 `MEMORY_STORE=1` 已正确设置 |
| Next.js 启动超时 | `.cmd` 批处理在 spawn 中静默失败 | `service-manager.js` 已自动绕过 `.cmd`，直接调用 `node next/dist/bin/next` |
| 找不到 `node` | PATH 未包含 Node.js | 确保 Node.js 已安装并在系统 PATH 中，或安装到标准路径 `C:\Program Files\nodejs\` |
| 安装包过大 | `node_modules.tar.gz` 包含所有依赖 | 正常，1.6GB tarball 压缩后约 600-700MB |
| 安装时解压卡住 | `node_modules.tar.gz` 过大 | 等待 2-5 分钟，PowerShell 窗口会显示进度 |

## 平台支持

| 平台 | 状态 | 说明 |
|------|------|------|
| Windows | ✅ 已验证 | 主要开发目标平台 |
| macOS | 🔄 待验证 | `service-manager.js` 中已包含跨平台路径逻辑 |
| Linux | 🔄 待验证 | 同上，需社区验证 |

## 相关文档

- [F138: Windows 安装包方案](../docs/features/F138-windows-installer-package.md)（如有）
- [F160: Electron 桌面化启动调试](../docs/features/F160-electron-desktop-windows-bootstrap.md)（如有）
