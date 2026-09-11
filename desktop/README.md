# Clowder AI Desktop

基于 Electron 的桌面应用壳层，为 Clowder AI 提供一键启动、系统托盘和独立窗口体验。
当前支持 **Windows 安装器** 和 **macOS DMG 安装器**。

## 设计哲学

Electron 在此项目中充当**"服务编排器 + 浏览器壳"**，而非将后端逻辑编译进 Electron 内部：

- ✅ Electron 启动时拉起后端进程（Redis / API / Web），加载 `localhost:3003`
- ✅ 托盘图标、右键菜单、任务栏独立身份
- ✅ 单实例锁：防止重复启动导致端口冲突
- ✅ 应用内更新（F273）：检查 GitHub Releases、校验大小与 SHA-256 后下载、Windows 原地静默升级、macOS 引导替换 DMG
- ❌ 不代装 Provider CLI、不代做 Provider 登录：安装包只交付运行时，真正调用模型前仍需用户自行安装并登录 CLI

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
│   ├── build-desktop.ps1 # Windows 安装包构建脚本
│   ├── verify-mac-bundle-arch.mjs # 打包后校验原生模块架构（失败闭合）
│   └── lib/
│       └── mac-native-arch.mjs    # 架构判定纯逻辑（含单测）
└── assets/
    ├── icon.ico         # Windows 图标
    ├── icon.icns        # macOS 图标（由 icon.png 自动生成）
    └── icon.png         # 通用图标源文件
```

## 前置要求

1. **Node.js** ≥ 24（与主项目 `engines.node` 一致；构建脚本按构建机 Node 版本内嵌便携运行时）
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
# 默认：只构建宿主架构（推荐；异架构构建见下方「原生模块架构」）
./desktop/scripts/build-mac.sh

# 显式指定单个架构
./desktop/scripts/build-mac.sh --arch arm64

# 双架构（arm64 + x64）——需要依赖树同时支持两种架构，见下方「原生模块架构」
./desktop/scripts/build-mac.sh --arch both

# 跳过已有缓存步骤（增量构建）
./desktop/scripts/build-mac.sh --skip-web --skip-deploy --skip-node --skip-redis
```

#### 构建流程（6 步）

| 步骤 | 内容 | 产物 |
|------|------|------|
| 1/6 | `pnpm install && pnpm build` 构建 Web 应用 | `packages/web/.next/` |
| 2/6 | `pnpm deploy` 导出 api/web/mcp-server 运行时包 | `bundled/deploy/{api,web,mcp-server}/` |
| 3/6 | 下载 Node.js 便携版（匹配构建机 ABI 版本） | `bundled/node-darwin-{arm64,x64}/` |
| 4/6 | 从源码编译 Redis（~30s/架构） | `bundled/redis-darwin-{arm64,x64}/` |
| 5/6 | 跳过（macOS DMG 无 post-install 阶段，不捆绑 CLI 工具；用户自行安装） | — |
| 6/6 | 生成 icon.icns + electron-builder 构建 .app + ad-hoc 签名 + **原生模块架构校验** + hdiutil 打 DMG | `dist/ClowderAI-{version}-{arch}.dmg` |

#### 已知注意事项

- **原生模块架构（重要）**：第 1–2 步只在本机跑**一次**依赖安装，因此原生模块（`better-sqlite3`、`sqlite-vec`、`sharp`）只按**宿主架构**落盘。在本机打包异架构会把宿主架构的二进制塞进产物 —— 实测在 arm64 机器上产出的 x64 DMG 内含 arm64 的 `better_sqlite3.node` 与 `vec0.dylib`，能构建、能签名、能安装、能启动，但在 Intel Mac 上 API 一加载 SQLite 即崩。因此：
  - 默认只构建宿主架构；真正的双架构发布由 `.github/workflows/build-mac-dmg.yml` 用**每架构一台 runner** 完成，不要依赖单机 `--arch both`；
  - 打包后 `desktop/scripts/verify-mac-bundle-arch.mjs` 会失败闭合地校验每个 bundle 的原生模块架构，不匹配就直接拒绝产出 DMG；
  - `node-pty` 这类自带多平台 `prebuilds/` 的模块不受影响（运行期由 loader 选择正确变体），校验按"平台-架构家族"判定，不会误报。
- **node_modules 补拷**：electron-builder 从 v20.15.2 起不再将 `node_modules` 目录包含在 `extraResources` 中（[electron-builder#3104](https://github.com/electron-userland/electron-builder/issues/3104)）。项目通过 `desktop/afterPack.js` hook 在打包后手动拷贝 `node_modules` 解决此问题。
- **未签名应用**：代码签名已禁用（`identity=null`）。首次启动需右键 → 打开，或执行：
  ```bash
  xattr -cr "/Applications/Clowder AI.app"
  ```
- **支持的安装位置（macOS）**：packaged 版本仅支持从 `/Applications/Clowder AI.app` 启动。
  - 启动时 `desktop/main.js` 的 `ensureValidMacInstallLocation()` guard 会拒绝从 DMG 卷
    （`/Volumes/...`）直接运行，并弹出"必须先安装"对话框。
  - **范围外**：`~/Applications`（用户级 Applications）、外部卷（USB / 网络盘）、企业
    MDM 管理路径目前不在支持范围内 —— `app.isInApplicationsFolder()` 仅认 `/Applications`。
    如果你的运行场景需要这些路径，请先开 issue 讨论而不是直接绕过 guard。
  - clowder-ai#1004 硬化点 4：把"仅 `/Applications`"作为显式支持策略落到文档，而不是
    隐式约束。（如果将来要扩展支持 `~/Applications`，需要同步改 main.js 的 guard +
    本文档 + 引导用户在哪个位置安装的 onboarding 文案。）

#### 产物位置

只产出**本次请求的架构**对应的 DMG：

```
dist/ClowderAI-{version}-arm64.dmg   # Apple Silicon
dist/ClowderAI-{version}-x64.dmg     # Intel Mac
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
6. 编译 Inno Setup 安装包（`dist/ClowderAI-Setup-x.x.x.exe`）

安装包在目标机器上执行：
- 复制运行时包 + 构建产物 + Electron 壳 + 便携 Node.js + 便携 Redis
- 运行 `post-install-offline.ps1`：生成 `.env`、挂载 skills 软链接
- **不安装 Provider CLI**：安装包只交付运行时；`claude` / `codex` / `agy` / `kimi` 等需用户自行安装并登录（见「安装后首次启动」）
- 创建桌面快捷方式
- 注册表启用 Windows 长路径支持

### 离线安装包特性

| 特性 | 状态 | 说明 |
|------|------|------|
| 零网络安装 | ✅ | 运行时包（pnpm deploy）+ Node.js + Redis + 构建产物全部预打包 |
| 长路径支持 | ✅ | 安装时自动启用 Windows LongPathsEnabled |
| 单实例运行 | ✅ | 重复启动会聚焦已有窗口 |
| 系统托盘 | ✅ | 最小化到托盘，右键菜单 |
| AI CLI 工具 | ❌ | 安装器**不代装**任何 CLI；用户自行安装并登录后应用才可用 |
| 自动更新 | ✅ | 应用内检查 GitHub Releases、校验大小与 SHA-256 后下载；Windows 原地静默升级，macOS 引导替换 DMG（F273） |

## 安装后首次启动（Windows）

安装完成 ≠ 立刻可聊。安装器会完成环境部署，但 **不会替用户完成 provider 认证和账号绑定**。

### 步骤

1. **运行安装包** — 双击 `ClowderAI-Setup-x.x.x.exe`（安装器不带组件选择，所有用户装到同一份运行时）
2. **等待安装完成** — 安装器自动完成：解包应用 + 便携 Node.js + 便携 Redis → 生成 `.env` → 挂载 skills。**Provider CLI 不在其中**
3. **启动 Clowder AI** — 安装结束后勾选"Launch Clowder AI"，或从桌面快捷方式启动
4. **安装并登录至少一个 Provider CLI（必做）** — 安装包**不代装**任何 CLI；一个都没装时，首次引导的「客户端」步骤会是空列表。
   需要系统已安装对应运行时（Node.js/npm 用于 Claude/Codex 与可选 Gemini CLI fallback，Python/pip 用于 Kimi）：
   ```powershell
   npm install -g @anthropic-ai/claude-code        # Claude
   npm install -g @openai/codex                     # Codex
   irm https://antigravity.google/cli/install.cmd | iex  # Antigravity CLI / Gemini 默认
   npm install -g @google/gemini-cli                # Gemini CLI（可选 fallback）
   pip install --user --upgrade kimi-cli            # Kimi（Python）
   ```
   然后在终端各跑一次完成登录（OAuth）：
   - **Claude** — `claude`
   - **Codex** — `codex`
   - **Gemini / Antigravity CLI** — `agy`（并用 `/model` 选择账号侧默认模型）
   - **Kimi** — `kimi`
   > 安装包内已 bundle 便携 Node.js，但那份运行时只供应用自身使用；手动补装 CLI 需系统 PATH 中有 Node.js 或 Python。
5. **配置 Provider 账号并验证连通** — 打开 Hub → 账号配置，新建/确认 profile（OAuth 或 Base URL + API Key + 模型），再点「连接测试」。测试不通过则首次引导无法继续。macOS 未签名版本首次打开需右键 → 打开。

## 调试

桌面应用的运行日志集中在用户数据目录：

- **Windows**：`%LOCALAPPDATA%\Clowder AI\data\logs\` (`main.log` / `desktop.log` / `api\api.log`)
- **macOS**：`~/Library/Application Support/Clowder AI/data/logs/` (`main.log` / `desktop.log` / `api/api.log`)

## 故障排查

| 问题 | 可能原因 | 解决方式 |
|------|---------|---------|
| `app` 为 undefined | `ELECTRON_RUN_AS_NODE=1` 被继承 | Windows 用 `pnpm desktop:dev`；Unix 用 `pnpm desktop:dev:unix`，或手动清理该环境变量 |
| API 启动失败（Redis 连接失败） | 没有可用的 Redis 且降级被拒 | 查看 `desktop.log`；运行时会在**内存模式**下弹窗告知（会话不落盘），并给出原因与恢复入口 |
| Next.js 启动超时 | entry 解析失败或端口被占 | `service-manager.js` 直接以 `node next/dist/bin/next` 启动（绕过 `.cmd`），并显式绑定 `--hostname 127.0.0.1`；端口冲突见下方「端口与实例」 |
| 找不到 `node` | PATH 未包含 Node.js | 安装包已 bundle 便携版 Node.js；开发模式确保 Node.js 在系统 PATH 中 |
| 安装包过大 | 包含完整运行时环境 | 正常，`pnpm deploy` 扁平化包 + Electron + Node.js + Redis |

### 端口与实例

桌面实例在启动时解析端口，并把选择记在用户数据目录（`data/desktop-instance.json`）。

- **Web 端口与 API 端口必须相邻**（`api = web + 1`）。前端依据 `location.port + 1` 推导 API 地址，两者一旦错开就会「页面能开、请求全错」。
- 默认从 **3003/3004** 开始找第一对**两个都空闲**的端口；上次用过的端口会被记住。
- **Redis 不会被"顺手续用"**：只有带本实例标记（`clowder:desktop:instance`）的 Redis 才会被采纳；否则该实例会在空闲端口上另起自己的 Redis，**绝不读写别人的库**。
- ⚠️ **安装目录只读时端口无法迁移**。Next.js 在**构建时**就把 API 地址写进 `.next/routes-manifest.json`，改变端口必须改写该文件；而 per-machine 安装位于 `Program Files`（运行时只读）。此时若 3003/3004 被占用，应用会**明确报错退出**，而不是启动一个 `/api` 指向别处的界面。
  - 解决：释放 3003/3004，或改为按用户安装/便携包（目录可写）。
- API 的网关与预览端口（如 4100）也可能与同机其他 Clowder 实例冲突；同一台机器上并行跑多个实例时请确保它们使用不同的数据目录。

## 平台支持

| 平台 | 状态 | 说明 |
|------|------|------|
| Windows | ✅ 已验证 | Inno Setup 安装器（`dist/ClowderAI-Setup-x.x.x.exe`） |
| macOS | ✅ 已验证 | DMG 安装器（`dist/ClowderAI-{version}-{arch}.dmg`），2026-04-23 已补齐 clean macOS build/首启证据 |
| Linux | ❌ 暂不支持 | 尚无 Linux 安装包 |

## 相关文档

- [PR #540: Electron Desktop 桌面化](https://github.com/zts212653/clowder-ai/pull/540)
