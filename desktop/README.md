# Cat Cafe Desktop

基于 Electron 的桌面应用壳层，为 Cat Cafe 提供一键启动、系统托盘和独立窗口体验。
当前支持 **Windows 安装器** 和 **macOS DMG 安装器**。

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
├── afterPack.js         # electron-builder afterPack hook（补拷 node_modules）
├── splash.html          # 启动画面（显示服务启动状态）
├── package.json         # Electron 包配置与 electron-builder 构建设置
├── scripts/
│   ├── build-mac.sh     # macOS DMG 构建脚本（6 步流水线）
│   └── build-desktop.ps1 # Windows 安装包构建脚本
└── assets/
    ├── icon.ico         # Windows 图标
    ├── icon.icns        # macOS 图标（由 icon.png 自动生成）
    └── icon.png         # 通用图标源文件
```

## 前置要求

1. **Node.js** ≥ 20（与主项目一致）
2. **pnpm** ≥ 8（主项目依赖管理）
3. **desktop 子包依赖已安装**：
   ```bash
   npm --prefix ./desktop install --include=dev
   ```
4. 主项目已完成构建：
   ```bash
   pnpm install
   pnpm build
   ```

## 快速开始

### 开发模式（直接从源码启动）

```bash
# 1. 安装主项目依赖
pnpm install

# 2. 安装 desktop 子包依赖（Electron / electron-builder）
npm --prefix ./desktop install --include=dev

# 3. 构建主项目
pnpm build

# 4. 启动桌面应用（Windows）
pnpm desktop:dev

# macOS / Linux
pnpm desktop:dev:unix
```

> **注意**：如果从 VSCode 等基于 Electron 的编辑器内置终端启动，可能会遇到 `ELECTRON_RUN_AS_NODE` 环境变量污染问题。Unix 环境优先用 `pnpm desktop:dev:unix`。

### 根目录快捷脚本

```bash
# 安装/更新 desktop 子包依赖
pnpm desktop:prepare

# 开发启动（Windows）
pnpm desktop:dev

# 开发启动（Unix）
pnpm desktop:dev:unix

# 构建可分发的桌面应用（输出到 desktop/dist/）
pnpm desktop:build

# 仅打包目录结构（不解压，用于调试）
pnpm desktop:pack

# 构建完整的 macOS DMG
pnpm desktop:build:mac

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

打包产物位于 `desktop/dist/win-unpacked/`（Windows）或 `desktop/dist/mac-arm64/`（macOS），包含可直接运行的应用。

---

### macOS DMG 安装包

构建独立的 `.dmg` 安装镜像。安装完成后可直接启动，无需额外依赖。

#### 前置要求

- macOS 13+（需要 Xcode Command Line Tools：`xcode-select --install`）
- pnpm、node（任意 LTS）、bash、curl、tar、make
- 构建 x64 Redis 需要 Rosetta 2：`softwareupdate --install-rosetta`

#### 构建命令

```bash
# 完整构建（arm64 + x64 双架构 DMG）
./desktop/scripts/build-mac.sh

# 仅构建当前架构（Apple Silicon 机器推荐，速度更快）
./desktop/scripts/build-mac.sh --arch arm64

# 跳过已有缓存步骤（增量构建）
./desktop/scripts/build-mac.sh --skip-web --skip-deploy --skip-node --skip-redis --skip-cli
```

#### 构建流程（6 步）

| 步骤 | 内容 | 产物 |
|------|------|------|
| 1/6 | `pnpm install && pnpm build` 构建 Web 应用 | `packages/web/.next/` |
| 2/6 | `pnpm deploy` 导出 api/web/mcp-server 运行时包 | `bundled/deploy/{api,web,mcp-server}/` |
| 3/6 | 下载 Node.js 便携版（匹配构建机 ABI 版本） | `bundled/node-darwin-{arm64,x64}/` |
| 4/6 | 从源码编译 Redis（~30s/架构） | `bundled/redis-darwin-{arm64,x64}/` |
| 5/6 | `npm pack` 打包 CLI 工具（Claude/Codex/Gemini） | `bundled/cli-tools/*.tgz` |
| 6/6 | 生成 icon.icns + electron-builder 构建 DMG | `dist/CatCafe-{version}-{arch}.dmg` |

#### 已知注意事项

- **node_modules 补拷**：electron-builder 从 v20.15.2 起不再将 `node_modules` 目录包含在 `extraResources` 中（[electron-builder#3104](https://github.com/electron-userland/electron-builder/issues/3104)）。项目通过 `desktop/afterPack.js` hook 在打包后手动拷贝 `node_modules` 解决此问题。
- **未签名应用**：代码签名已禁用（`identity=null`）。首次启动需右键 → 打开，或执行：
  ```bash
  xattr -cr "/Applications/Cat Cafe.app"
  ```

#### 产物位置

```
dist/CatCafe-{version}-arm64.dmg   # Apple Silicon
dist/CatCafe-{version}-x64.dmg     # Intel Mac
```

---

### Windows 安装包

构建一个独立的 `.exe` 安装程序。安装完成后可直接启动，无需再手动 `pnpm install`：

```bash
# 一键构建完整安装包（需要 Inno Setup 6）
pnpm desktop:installer

# 或直接使用 PowerShell 并跳过某些步骤
.\desktop\scripts\build-desktop.ps1 -SkipWebBuild -SkipBundleDeps
```

构建流程（`desktop/scripts/build-desktop.ps1`）：
1. 构建 Web 应用（`pnpm build`）
2. `pnpm deploy` 导出 api / web / mcp-server 运行时包（扁平化 node_modules，无 Windows junction）
3. 下载 Node.js 便携版（ABI 版本与构建机一致，确保 native 模块兼容）
4. 下载/复制 Windows 便携版 Redis
5. 构建 Electron 壳（`electron-builder --win --dir`）
6. 编译 Inno Setup 安装包（`dist/CatCafe-Setup-x.x.x.exe`）

安装包在目标机器上执行：
- 复制运行时包 + 构建产物 + Electron 壳 + 便携 Node.js + 便携 Redis
- 运行 `post-install-offline.ps1`：生成 `.env`、挂载 skills 软链接
- 按用户在安装向导中选择的组件，尝试安装 AI CLI 工具（优先 bundled tarball，回退联网）
- 创建桌面快捷方式
- 注册表启用 Windows 长路径支持

### 离线安装包特性

| 特性 | 状态 | 说明 |
|------|------|------|
| 零网络安装 | ✅ | 运行时包（pnpm deploy）+ Node.js + Redis + 构建产物全部预打包 |
| 长路径支持 | ✅ | 安装时自动启用 Windows LongPathsEnabled |
| 单实例运行 | ✅ | 重复启动会聚焦已有窗口 |
| 系统托盘 | ✅ | 最小化到托盘，右键菜单 |
| AI CLI 工具 | ⚠️ 部分 | 优先从 bundled tarball 离线安装；无缓存时尝试联网；均失败则提示手动安装 |
| 自动更新 | ❌ | 需手动下载新版安装包覆盖安装 |

## 安装后首次启动（Windows）

安装完成 ≠ 立刻可聊。安装器会完成环境部署，但 **不会替用户完成 provider 认证和账号绑定**。

### 步骤

1. **运行安装包** — 双击 `CatCafe-Setup-x.x.x.exe`，选择 `Full`（全部 CLI 工具）或 `Minimal`（仅核心）
2. **等待安装完成** — 安装器自动完成：解包应用 + 便携 Node.js + 便携 Redis → 生成 `.env` → 挂载 skills → 安装所选 CLI 工具
3. **启动 Cat Cafe** — 安装结束后勾选"Launch Cat Cafe"，或从桌面快捷方式启动
4. **配置 Provider** — 打开 Hub → 账号配置，为你要使用的 AI 服务完成认证：
   - **Claude** — 运行 `claude` 命令完成 Anthropic 登录
   - **Codex** — 运行 `codex` 命令完成 OpenAI 登录
   - **Gemini** — 运行 `gemini` 命令完成 Google 登录
   - **Kimi** — 运行 `kimi` 命令完成 Moonshot 登录
5. **补装 CLI（如有需要）** — 如果某个 CLI 工具在安装阶段未成功安装，可手动补装。
   需要系统已安装对应运行时（Node.js/npm 用于前三者，Python/pip 用于 Kimi）：
   ```bash
   npm install -g @anthropic-ai/claude-code        # Claude
   npm install -g @openai/codex                     # Codex
   npm install -g @google/gemini-cli                # Gemini
   pip install --user --upgrade kimi-cli            # Kimi（Python）
   ```
   > 安装包内已 bundle 便携 Node.js，安装过程中会自动使用。手动补装时需确保系统 PATH 中有 Node.js 或 Python。

## 调试

桌面应用的运行日志会写入系统临时目录：

- **Windows**：`%TEMP%\cat-cafe-main.log` / `%TEMP%\cat-cafe-desktop.log`
- **macOS**：`$TMPDIR/cat-cafe-main.log` / `$TMPDIR/cat-cafe-desktop.log`

## 故障排查

| 问题 | 可能原因 | 解决方式 |
|------|---------|---------|
| `app` 为 undefined | `ELECTRON_RUN_AS_NODE=1` 被继承 | Windows 用 `pnpm desktop:dev`；Unix 用 `pnpm desktop:dev:unix`，或手动清理该环境变量 |
| API 启动失败（Redis PING failed） | Redis 未找到且环境变量冲突 | 检查 `cat-cafe-desktop.log`，确认 `MEMORY_STORE=1` 已正确设置 |
| Next.js 启动超时 | `.cmd` 批处理在 spawn 中静默失败 | `service-manager.js` 已自动绕过 `.cmd`，直接调用 `node next/dist/bin/next` |
| 找不到 `node` | PATH 未包含 Node.js | 安装包已 bundle 便携版 Node.js；开发模式确保 Node.js 在系统 PATH 中 |
| 安装包过大 | 包含完整运行时环境 | 正常，`pnpm deploy` 扁平化包 + Electron + Node.js + Redis |

## 平台支持

| 平台 | 状态 | 说明 |
|------|------|------|
| Windows | ✅ 已验证 | Inno Setup 安装器（`dist/CatCafe-Setup-x.x.x.exe`） |
| macOS | ✅ 已验证 | DMG 安装器（`dist/CatCafe-{version}-{arch}.dmg`），2026-04-23 已补齐 clean macOS build/首启证据 |
| Linux | ❌ 暂不支持 | 尚无 Linux 安装包 |

## 相关文档

- [PR #540: Electron Desktop 桌面化](https://github.com/zts212653/clowder-ai/pull/540)
