---
feature_ids: [F273]
related_features: [F179, F180]
topics: [desktop, electron, auto-update, inno-setup, dmg, github-releases, installer, opensource-ops]
doc_kind: spec
created: 2026-07-07
updated: 2026-07-26
description: "Desktop in-app update system: fresh GitHub release discovery, resumable verified download, Windows installer upgrade, and guided macOS DMG replacement."
description_source: model
description_author: codex-sol
description_generated_by: codex-sol@gpt-5.6-sol
description_generated_at: 2026-07-26T03:59:46Z
description_confirmed_by: codex-sol
description_updated_at: 2026-07-26T03:59:46Z
---

# F273: Desktop In-App Update — 应用内检查更新 + 原地升级（无签名约束版）

> **Status**: in-progress（Phase A–D 已通过 clowder-ai #1105 合入；Clowder AI intake #3222 已合入 `8424af315`；exact-head RC package verification 与 macOS arm64 isolated old-install 验收通过；**Phase E 首次 upstream stable release field validation 待完成**） | **Source author**: mindfn | **Intake owner**: @codex-sol | **Priority**: P1
>
> **Source**: clowder-ai#1105（Phase A–D 实现 PR，已合入 `d908aa265`）→ clowder-ai#1102（issue）→ clowder-ai#1219（docs sync，已合入 `7207936a38`）
>
> **operator signoff**: 2026-07-24，operator授权分配 F273 + intake 回家
>
> **operator sequencing decision (2026-07-26)**: 既有 Windows 安装验证作为合入前证据；真实旧版 → 首个 upstream stable release 升级验证移至合入后。若现场验证发现缺陷，以新的 follow-up issue / PR 修复，不改写已审 exact HEAD。

## Why

**用户反馈触发（2026-07-07 operator 转述）**：我们从 v0.9.1 起提供 dmg + Windows 安装包（F179 pipeline），但用户反馈**不知道怎么升级**。当前不支持原地升级——唯一升级方式是用户自己发现新 release → 手动下载 600–800MB → 手动重装，且没有任何地方告诉用户数据会不会丢。

**现状证据链（2026-07-07 调研 + review 核验）**：

| 事实 | 证据 |
|------|------|
| 主进程/preload/service-manager 零 update 代码 | grep `updat\|upgrade` 零命中 |
| `dmg.writeUpdateInfo: false`，mac `identity: null` 未签名 | `desktop/package.json` build 段 |
| Win 是 Inno Setup（非 NSIS），固定 AppId，覆盖装即原地升级 | `desktop/installer/cat-cafe.iss` |
| v0.11.1 包体：dmg 622–632MB / Setup.exe 802MB；下载 30+10+93 次 | `gh release view v0.11.1` |
| **GitHub release asset API 直接返回 `digest`（sha256）**，v0.11.1 全部 4 个 asset 实测有 | `gh api releases/latest`（Codex review 发现，Fable 复核） |
| GitHub asset 下载支持 Range（`bytes=0-0` 实测返回 206） | Codex review 实测 |
| 用户数据在 userData（mac `~/Library/Application Support/Clowder AI`，win `%LOCALAPPDATA%\Clowder AI`），与安装目录完全分离 | `service-manager.js:24-31` |
| `quitApp()` → `services.stopAll()` 有完整子进程树清理（redis/api，`_killProcessTree` + timeout） | `main.js:172-180, 244-258`，`service-manager.js:740+` |
| `generate-desktop-config.ps1` 现状只写 `version/installedAt`，且 version **硬编码 "0.10.1"**（存量 bug） | 该脚本 L10-13 |

## User Journey

**Scope unit**：桌面安装包用户的版本升级旅程（Win installer / mac dmg / Win portable 三类用户 + 失败恢复）。

**Journey 1 — Win installer 用户（主路径，准全自动）**
1. 启动/重新登录时检查一次；持续运行期间，新版本发布后 ≤24h（或点 tray「检查更新」）弹窗：「发现新版本 vX.Y.Z」+ release notes 摘要 + [跳过此版本 / 稍后 / 下载]
2. 点 [下载] → 任务栏进度条 + tray tooltip 百分比，期间正常使用不受影响
3. 下载完成（digest+size 校验通过）→ [稍后 / 重启并升级] → 确认 → UAC 点一次「是」
4. 看到安装进度条跑完 → app 自动以原用户权限重开新版本 → 「已更新到 vX.Y.Z」通知 → 聊天记录/数据完好
5. **失败分支**：UAC 取消 / 安装中断 → 下次打开 app 出恢复对话框 [重试安装（不重下）/ 打开安装包位置 / 查看日志 / 忽略并清除]；app 打不开的最坏情形 → 按 README/release notes 指引到 `%LOCALAPPDATA%\Clowder AI\updates\` 直接重跑安装包即修复

**Journey 2 — mac 用户（半自动，无签名上限）**
1. 同样收到提示 → [下载] → 进度可见 → 完成校验
2. [退出并安装] → Finder 自动打开 dmg（拖拽指引布局，同首装心智）→ 拖入 Applications 替换 → 右键打开新版（quarantine，同首装）→ 数据完好，收到「已更新」确认

**Journey 3 — Win portable 用户（fail-safe）**
1. 收到新版本提示 → 打开 release 页自行下载 zip（绝不自动安装；`installType` 缺失/unknown 同此路径）

**Journey 4 — 存量老版本用户（无 updater 代码）**
1. 不感知本 feature；README Upgrading 章节提供手动升级步骤 + 数据安全声明，完成一次手动升级后进入 Journey 1/2

## 已拍板约束（operator 2026-07-07）

1. **不买 Apple Developer（operational cost/年）** → electron-updater 的 mac 路线不可用（其底层 Squirrel.Mac 强制校验 Apple code signing，未签名 app 无法自动替换；electron-builder 官方文档确认，Codex review 复核）。mac 上限 = 半自动引导升级。
2. Win 保留 Inno Setup：electron-updater 官方只支持 NSIS/Squirrel/MSI/AppX；迁移 NSIS 需重写全部 install 逻辑（tar 解压、junction、post-install、hook sync）且老用户卸载表项割裂。Inno Setup 本身天然支持原地覆盖升级（同 AppId）+ `/SILENT` 静默 + post-install 逻辑升级时自动重跑（F180 hook sync 复用）。
3. Update feed = **GitHub Releases API**（现有发布渠道，零新增基础设施）。

## What — 架构设计

四个新模块（`desktop/` 下）+ installer 改造 + 失败恢复 journal + 文档。**总原则：永远先询问用户再下载/安装（800MB 流量不偷跑）；一切网络失败静默降级；升级是一个有 journal 的事务，任何一步失败用户都有明确的恢复入口。**

### 1. `desktop/update-checker.js` — 检查器（纯逻辑，可单测）

- **Feed：`GET /repos/zts212653/clowder-ai/releases?per_page=10`** → 过滤 `draft/prerelease` → **max semver** → 校验 asset 完整性（两个 dmg + Setup.exe 均在且带 digest）→ 作为升级目标。
  - 不用 `releases/latest`：latest 按发布时间选最近 release，不是 semver 选择器（GitHub 官方语义，Codex review 指出）。max-semver 选择器下 backport hotfix（如 v0.12.0 之后发 v0.11.2）不会误导新版本用户；撤版运维 = 把坏 release 标 prerelease 或删除，选择器自动回退到上一稳定版。
  - 仅当 target > current（`app.getVersion()`）才提示，天然不提示降级。
- 每个候选 asset 记录 **四元组 `{ id, name, size, digest }`**（digest 直接来自 API response），作为后续下载与校验的绑定凭据。
- 触发时机：启动/重新登录后立即首查 → 持续运行期间每 24h → tray 菜单「检查更新」手动触发。自动检查只在发现新版本时提示；无更新和网络失败均静默。带 `If-None-Match` ETag 条件请求；收到 304 后，任何提示或安装决策前必须再做一次无条件请求取得新鲜的 GitHub 元数据，`userData` 下同用户可写的持久缓存不得作为安装授权来源。匿名限额 60 req/h/IP，频率远低于此。
- 版本比较：自写 semver 比较（支持 `vX.Y.Z` 及 pre-release 后缀如 `-rc.1`、`-beta.2`，按 semver §11 规范排序；不引第三方依赖）。
- 平台 asset 解析：win → `ClowderAI-Setup-{v}.exe`；mac → `ClowderAI-{v}-{arm64|x64}.dmg`（按 `process.arch`）。
- 设置持久化 `{userData}/update-settings.json`：`{ autoCheck: true, skippedVersion: null, lastCheckAt, etag }`。
- 失败（断网/超时/API 变更/rate limit）：log-only 静默。

### 2. `desktop/update-downloader.js` — 下载器

- Electron `net` 模块（走系统代理设置，对国内用户重要）下载到 `{userData}/updates/`。
- 下载前检查磁盘空间 ≥ 2× asset size；下载中主窗口 `setProgressBar()` + tray tooltip 显示百分比。
- **校验 = 四元组绑定**：完成后 `node:crypto` streaming sha256 对照 API `digest` + 字节数对照 `size`，任一不匹配 → 删除 + 提示重试。安装恢复也必须重新拉取对应版本的 GitHub release，并以新鲜响应中的 asset name/digest/size 复核已下载文件；本地 journal 只记录恢复状态，不授权执行。
- Windows 提权边界前，在服务停止完成后必须立即再次校验 installer；手动运行 Setup 时由 installer 通过单实例参数请求桌面端执行同一 `quitApp() → stopAll()` 生命周期，确认进程退出后才安装，超时强制清理仅作有界兜底。
- **威胁边界（明确声明）**：digest 来自 api.github.com，asset 字节来自下载域（objects.githubusercontent.com 等），跨源比对可防传输损坏与下载链路篡改；**不防 GitHub 账号/release 本身被替换**——该威胁下源码同样可投毒，信任等级与源码信任一致。不引入 minisign/ed25519（见 Resolved Questions #4）。
- **断点续传（MVP 含）**：首次响应记录 `ETag` + total size；中断重试用 `Range` + `If-Range: <etag>`；若响应非 206、或 `Content-Range`/ETag 与记录不一致 → **丢弃 partial 全量重下**（正确性优先于流量）。
- 清理策略：升级成功确认后（见 journal 状态机）清空 `updates/` 内旧文件。

### 3. Windows 升级执行器（准全自动 + 事务化恢复）

#### 3.1 正常路径

```
downloader 完成+四元组校验通过
  → dialog [稍后 / 重启并升级]
  → 写 pendingUpdate journal（见 3.2）
  → spawn(setupExe, ['/SILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/LOG={userData}\updates\install.log'],
          { stdio: 'ignore' })  // 每个 Inno switch 独立 argv；不经 PowerShell 拼串重解析
  → quitApp()  // stopAll() 干净关闭 redis/api/exe → 释放全部文件锁
  → UAC 弹窗一次（PrivilegesRequired=admin，不可避免，用户点一次"是"）
  → Inno Setup 原地覆盖安装 → 静默模式装完自动以原用户权限重启 app（iss 改造 b）
```

`/SILENT`（显示进度条、无向导页）而非 `/VERYSILENT`：用户能看见升级在进行，不误以为 app 消失。

#### 3.2 pendingUpdate journal — 失败恢复（Codex review P1）

spawn 前落盘 `{userData}/updates/pending-update.json`：

```json
{ "targetVersion": "0.12.0", "assetId": 123, "assetName": "ClowderAI-Setup-0.12.0.exe",
  "digest": "sha256:…", "installerPath": "…\\updates\\ClowderAI-Setup-0.12.0.exe",
  "startedAt": "…" }
```

journal 是同用户可写的恢复状态，不能授权提权参数。重试时安装包路径由 fresh GitHub release 的认证 asset name + 固定 `updates/` 目录推导，`install.log` 也只由本地固定路径推导；journal 中遗留或伪造的路径字段一律不进入 installer argv。

**下次启动时状态机**（main.js 早期、服务启动前检测）：

| 状态 | 判定 | 动作 |
|------|------|------|
| 升级成功 | journal 存在且 `app.getVersion() >= targetVersion` | 清 journal + 清理 `updates/`，一次性「已更新到 vX.Y.Z」通知 |
| 失败/取消 | journal 存在且 `app.getVersion() < targetVersion` | 恢复 dialog：**[重试安装 / 打开安装包位置 / 查看安装日志 / 忽略并清除]**；重试 = 重新校验已下载 installer（digest 复核）→ 重新 spawn，**不重下 800MB** |

覆盖场景：UAC 取消、tar 解压失败、安装中途断电/杀进程、installer 启动失败。

**App 外恢复路径（硬要求，Codex r2 提醒）**：`[InstallDelete]` 之后中断的最坏情形（旧 runtime 已删、新版未装完）下 app 可能起不来，**恢复 dialog 不可达**。因此：① installer 与 `install.log` 固定保留在 `%LOCALAPPDATA%\Clowder AI\updates\`（**禁止**放系统 temp；失败态绝不清理）；② 该路径写进三处用户可见位置——恢复 dialog、README Upgrading 章节、release notes 模板——并明确「**不需要打开 app，直接重新运行该安装包即可修复**」。

#### 3.3 `cat-cafe.iss` 四处改造（本 feature 最需要 review 的部分）

a. **`[InstallDelete]` 清理 tar 解压残留** — 现状：运行时文件（`packages/`、`desktop-dist/`、`node/`）是 `[Run]` 段 tar.exe 解压产物，**不在 Inno 文件注册表内**，覆盖安装不清理 → 旧版本多出的文件（被删的模块、旧 node_modules 结构）永久残留，属极难排查的 bug 温床。加：
   ```ini
   [InstallDelete]
   Type: filesandordirs; Name: "{app}\packages"
   Type: filesandordirs; Name: "{app}\desktop-dist"
   Type: filesandordirs; Name: "{app}\node"
   Type: filesandordirs; Name: "{app}\scripts\node_modules"   ; junction — 见 d
   ```
   Tradeoff：升级耗时增加 + 删除后安装中途失败旧版不可用——由 3.2 journal 恢复路径兜底（重跑 installer 即修复），把"脏状态风险"换成"干净但可恢复的失败"。

b. **静默升级后自动重启 app** — 现有 `[Run]` postinstall 项带 `skipifsilent`（静默装完不启动）。加一条仅静默模式生效：
   ```ini
   Filename: "{app}\desktop-dist\{#MyAppExeName}"; Flags: nowait runasoriginaluser; Check: WizardSilent
   ```
   `runasoriginaluser` 关键：否则 app 及其全部子进程（redis/api）以 elevated admin 运行。

c. **`[Code]` 防御性进程清理** — updater 正常路径已先 quit；兜底手动重跑 Setup.exe / stopAll 超时残留：`PrepareToInstall` 里 PowerShell 精确 kill 安装目录路径下的进程（`Get-Process | Where-Object { $_.Path -like "{app}\*" } | Stop-Process -Force`，路径过滤避免误杀用户自己的 node/redis）。

d. **junction 幂等**（Codex review 指出）— `[Run]` 的 `mklink /J {app}\scripts\node_modules` 在覆盖安装时目标已存在会失败；且 `[InstallDelete]` 清掉 `packages/` 后旧 junction 变 dangling。处理：junction 纳入 `[InstallDelete]`（见 a，`rmdir` junction 只删链接不删目标内容），mklink 必然在干净状态下执行。

#### 3.4 Portable zip 用户（明确开发项——当前代码无此能力）

- **现状**：`generate-desktop-config.ps1` 只写 `version/installedAt`，且 version 硬编码 `"0.10.1"`（存量 bug）。
- **开发项**：脚本加 `-Version` + `-InstallType` 参数；iss `[Run]` 调用传 `-InstallType installer -Version {#MyAppVersion}`（修掉硬编码）；`start-portable.bat` 路径传 `-InstallType portable`。
- **Fail-safe**：`installType` 字段缺失/unknown（含任何旧包场景）→ **一律不自动安装**，仅提示新版本 + 打开 release 页。portable 检测同此路径。

### 4. macOS 升级执行器（半自动——无签名的上限）

```
按 process.arch 下载对应 dmg → 四元组校验
  → dialog:「新版本 vX.Y.Z 已下载。点击"退出并安装"会打开安装盘，
     请把 Clowder AI 拖入 Applications 替换旧版本，然后从 Applications 重新打开。
     你的聊天记录和数据不会受影响。」 [稍后 / 退出并安装]
  → spawn('open', [dmgPath]) → quitApp()
  → Finder 展示 dmg（electron-builder 默认布局含 Applications 拖拽 symlink，与首装心智一致）
  → 用户拖拽替换 → 新版首启右键打开（quarantine，与首装体验相同，dialog + 文档明示）
```

- mac 侧同样写 journal：成功判定同 3.2（下次启动版本比对），失败态提示「安装盘已下载在 …，可随时手动完成安装」。
- 已有 install-location guard（`main.js` 拒绝从 /Volumes 直接运行）继续兜底"没拖就双击"的误操作。

**明确不做：无签名自动替换 `.app`**（下载 zip → 解压 → `xattr -dr com.apple.quarantine` → 原子替换 → relaunch）。技术上可行，但：(a) 程序化清 quarantine 属"绕过 Gatekeeper"模式，macOS 政策收紧风险不可控；(b) 替换中断 = app 损坏且无签名无法校验完整性；(c) 开源项目声誉风险。Rejected alternative。

### 5. CI / 发布侧

- **主校验源 = API digest，CI 无新增必做项**（Codex review P1 修订：不再造 `.sha256` sidecar 弱机制）。可选 P2：为浏览器手动下载用户附 sidecar 供人工核对，不阻塞本 feature。
- release notes 模板（opensource-ops 侧）加 "How to upgrade" 固定章节。
- 运维说明一条：撤回坏版本 = 将该 release 标 prerelease 或删除，max-semver 选择器自动回退。

### 6. 文档

README / README.zh-CN 加 **Upgrading** 章节：数据存放位置 + 覆盖升级不丢数据声明 + 各平台手动升级步骤（in-app 通道的兜底；也服务存量老版本用户——他们没有 updater 代码，永远需要一次手动升级到首个带 updater 的版本）+ Win 升级中断恢复说明（重跑安装包即修复）。

## 明确不做（scope 边界）

| 不做 | 理由 |
|------|------|
| 差分/增量更新（blockmap） | 依赖 electron-updater+NSIS 体系；全量 600–800MB 可接受，体积优化未来独立立项 |
| 分层热更新（只换 packages 产物） | 版本兼容矩阵 + 回滚机制复杂度高，收益不匹配当前阶段 |
| minisign/ed25519 manifest 签名 | API digest 四元组绑定已覆盖损坏+下载链路篡改；更强威胁 = GitHub 沦陷，彼时源码同样可投毒 |
| `.sha256` sidecar 作为主校验 | API digest 更强且零 CI 改动；sidecar 降级为可选人工兜底 P2 |
| Linux 包 | 当前不发布 |
| 不询问的静默自动升级 | 永远先问（尊重用户 + 大流量不偷跑） |
| 国内下载镜像 prefix 设置 | ghproxy 类镜像是新供应链风险；`net` 走系统代理已覆盖主要场景，观察反馈再议 |

## Resolved Questions（r1 review 收敛，双方共识）

1. **国内镜像** → P2 不做，镜像本身是新供应链风险。
2. **`[InstallDelete]` 全清** → 做，配 3.2 journal 恢复 + 3.3d junction 幂等。
3. **断点续传** → 进 MVP，配 ETag/Content-Range 一致性校验，不匹配全量重下（Range 206 已实测）。
4. **checksum** → GitHub API digest 为主校验源（四元组绑定），威胁边界如 §2 声明，不上 minisign。
5. **feed 选择器** → MVP 直接 `/releases` + max semver（放弃 latest，成本差异极小，消除对发布顺序的隐含假设）。
6. **频率/UI** → 启动/重新登录立即检查、持续运行每 24h、tray 手动检查；自动检查仅发现更新时提示；UI 只用 Electron 原生（tray/dialog/taskbar progress），不动 preload/web UI。

## Phase 拆分（source implementation：mindfn）

- **Phase A — update-core**：checker + `/releases` max-semver 选择器 + semver compare + asset 四元组解析 + settings 持久化，`node --test` 单测（沿用 `desktop/*.test.js` 既有模式），mock API fixture
- **Phase B — Win 全链路**：downloader（进度/四元组校验/断点续传一致性）+ pendingUpdate journal 状态机 + iss 四处改造 + spawn→quit 时序 + portable/installType 开发项（含 config 脚本参数化修硬编码）。**实现注意（Codex）**：app 外恢复路径是硬要求——最坏情形下用户必须能在不打开 app 的前提下从 `updates/` 目录重跑 installer 修复（§3.2）
- **Phase C — mac 半自动链路**：arch 选择 + 下载校验 + open dmg + 指引 dialog + quit + journal 成功/失败态
- **Phase D — UX 与文档**：tray「检查更新」菜单 + skip version + 进度展示 + README 双语 Upgrading + release notes 模板 + 撤版运维说明
- **Phase E — 验收（进行中）**：exact-head installer / portable / DMG 已完成构建与包体校验，macOS arm64 isolated old-install 路径已通过；Windows 既有安装验证由 operator 接受为合入前证据。首个 upstream stable release 发布后完成真实旧版升级、数据保留与 incident ownership field validation（沿 F179 Phase B 模式）。

## Acceptance Criteria

- [ ] AC-1: 启动/重新登录时立即检查；旧版持续运行中出现新版本（mock `/releases`）→ ≤24h 自动或手动检查提示；自动检查无更新/失败时静默；`skippedVersion` 不再提示，更新的版本恢复提示；feed 含更高 semver 的 prerelease/draft 或 asset 不全的 release 时被正确跳过
- [ ] AC-2 (Win): 真实旧版安装 → 一键升级端到端：下载(进度可见)→四元组校验→UAC→静默覆盖装→自动以原用户权限重启新版→userData 数据完好→旧 tar 残留已清理→junction 重建正确
- [ ] AC-3 (Win 失败恢复): ① UAC 取消 → 下次启动恢复 dialog，重试安装成功且不重新下载；② 安装中途杀死 installer → 下次可达路径上恢复 dialog 或按文档重跑 installer 修复
- [ ] AC-4: 篡改下载文件（digest 不符）或截断（size 不符）→ 拒绝安装 + 可重试；断点续传中 ETag 变化 → 丢弃 partial 全量重下
- [ ] AC-5 (mac): 下载→校验→打开 dmg→指引 dialog→退出；拖拽替换后新版启动、数据完好、journal 判定成功并清理
- [ ] AC-6: 断网/API 5xx/rate limit → 静默降级，desktop.log 可查，无用户打扰
- [ ] AC-7 (portable/fail-safe): `installType=portable` 或字段缺失 → 仅提示 + 引导 release 页，绝不自动安装
- [ ] AC-8: `generate-desktop-config.ps1` 参数化（-Version/-InstallType），iss 与 portable bat 正确传参，硬编码 0.10.1 修复
- [ ] AC-9: 升级路径复用 post-install hook sync（F180）并生效
- [ ] AC-10: README 双语 Upgrading 章节 + release notes 模板含升级指引与中断恢复说明
- [ ] AC-11: 全程无签名新增告警面（不引入任何清 quarantine / 绕 Gatekeeper 行为）

## Dependencies

- 无强依赖。F179 pipeline（release → 自动构建 attach assets）是本 feature 的 feed 基础，已稳定运行。
- F180（agent hook sync）：升级路径自动复用其 post-install 同步，属收益非依赖。

## Review Log

- **r1 (2026-07-07, Maine Coon/Codex)**: REQUEST CHANGES——P1×2（checksum 应以 API digest 为主源；Win 安装失败恢复缺 journal）+ P2×2（latest 非 semver 选择器；portable installType 不是现状）。外部一手验证：electron-builder mac 签名要求、GitHub latest 语义、asset digest 字段、Range 206 实测。
- **r2 (2026-07-07, Fable)**: 全部采纳修订。digest 字段与 config 脚本现状均独立复核确认；P2-1 升格为 MVP 直接做 `/releases` max-semver；顺手纳入 config version 硬编码存量 bug 修复。
- **r2 确认 (2026-07-07, Maine Coon/Codex)**: **放行**。复核确认四项 findings 均进入验收口径。附非阻塞实现提醒：`[InstallDelete]` 后中断时恢复 dialog 不一定可达，须保证 app 外恢复路径（保留 installer/日志于固定位置 + 文档写明"不打开 app 也能重跑安装包"）→ 已固化进 §3.2 / §6 / Phase B。
- **r3 (2026-07-20, GitHub author mindfn 实现 + Maine Coon Codex review PR #1105)**:
  - 实现 Phase A–D 全部模块，提 PR #1105
  - 修复 P1：公开仓 asset 名对齐开源品牌契约；intake 回家后恢复为 `ClowderAI-*`，由 outbound sanitizer 保证双仓契约（含 regression tests 从 build config 反推）
  - 修复 P1：F204 plugin 迁移后 desktop 三处打包配置仍指向旧 root `plugins/`，改为 `packages/api/src/plugins`（含 4 条 regression tests）
  - 修复：CI Redis 下载限流 → `GITHUB_TOKEN` header + Inno Setup `skipifsourcedoesntexist` 容错
  - 增强：semver 比较支持 pre-release 后缀（`-rc.N`、`-beta.N`），支持 RC 版本发布与升级测试
  - 双平台构建验证通过：Windows installer + portable、macOS DMG arm64 + x64
- **r4 (2026-07-21, Maine Coon Sol review → Ragdoll Opus fix)**:
  - Sol cross-family review: REQUEST CHANGES — 6×P1 blocking + P2s
  - P1-1 fix: Windows UAC 提权 — `spawn()` 改 PowerShell `Start-Process -Verb RunAs` + error listener
  - P1-2 fix: PrepareToInstall PowerShell 注入 — `{app}` 路径单引号转义 (`StringChange`)
  - P1-3 fix: Redis 下载 fail-closed — 3 次重试 + CI 环境强制失败 + redis-server.exe 校验
  - P1-4 fix: ETag/304 不再吃掉 "Later" — fetchReleases 区分 304 vs error，304 时加载缓存 feed 重新评估
  - P1-5 fix: 下载流 I/O — write-stream error handler + backpressure + 30min timeout + settle guard
  - P1-6 fix: README 升级文档 — 中英文 Upgrading 章节（桌面应用 + 源码两条路径 + 失败恢复）
  - P2 fix: portable 用户在下载前检查 installType，避免浪费 600+ MB 带宽
  - 新增 4 条 release cache 单测（round-trip / missing / corrupt / mkdir）
  - 全量 70 tests 通过（58 update-checker + 12 generate-desktop-config）
- **r4b (2026-07-21, Maine Coon Sol re-review → Ragdoll Opus fix)**:
  - Sol focused re-review of r4 fix: REQUEST CHANGES — 4×P1 + 2×P2
  - P1-A fix: settle 作用域 — settle/settled 从 response 回调提升到 Promise 作用域，防止 request-error ReferenceError 崩溃主进程
  - P1-B fix: Windows 安装器路径 — `/LOG=` 含空格路径加双引号；`_spawnInstaller` 改 async 等待 PowerShell exit code 再退出应用
  - P1-C fix: Redis 全面 fail-closed — 移除 `$env:CI` 特判，所有构建缺 Redis 均失败；`.iss` 移除 `skipifsourcedoesntexist`
  - P1-D fix: app 外恢复路径 — recovery dialog 显示安装包固定路径 + README 写明路径 + release-notes 模板
  - P2-A fix: StartsWith 加尾部反斜杠防止误杀兄弟目录进程
  - P2-B fix: verifyFileIntegrity 改 streaming SHA-256（createReadStream），避免 600-800MB readFileSync
  - 新增 request-error regression test；downloader tests 改 async
  - 全量 94 tests 通过（58 checker + 16 downloader + 8 installer + 12 config）
- **r4c (2026-07-21, Maine Coon Sol re-review → Ragdoll Opus fix)**:
  - Sol focused re-review of r4b fix: REQUEST CHANGES — 1×P1 + 2×P2
  - P1 fix: launcher 失败时保留 journal — _executeInstall 和 _retryInstall 的 catch 块不再 clearJournal，保障 AC-3 下次启动恢复 dialog
  - P2 fix: macOS launcher 等待 close — `_spawnInstaller` macOS 路径改为等待 `open` 命令 close 事件，不再 resolve 后异步 error
  - P2 fix: 总超时覆盖建连阶段 — dlTimeout 从 response 回调内移到 request.end() 前，覆盖连接卡死场景
  - spawn 注入: 构造函数新增 deps.spawn 可选注入，使 _spawnInstaller 可测
  - 新增 update-manager.test.js（176 行）: launcher failure-mode sweep（Win/Mac spawn-error/nonzero/success）+ journal 保留 P1 回归
  - 新增 stalled request timeout 测试（update-installer.test.js）
  - 全量 111 tests 通过（58 checker + 16 downloader + 10 installer + 15 manager + 12 config）
- **r4d (2026-07-21, Maine Coon Sol re-review → Ragdoll Opus fix)**:
  - Sol focused re-review of r4c fix: REQUEST CHANGES — 1×P2 transport 竞态
  - P2 fix: 超时后迟到 response 竞态 — response 回调入口增加 `settled` 守卫（迟到 response 直接 destroy，不建 write stream）；timeout handler 增加 `request.abort()` 主动取消底层连接
  - 新增 2 条竞态回归测试：timeout→late response 不写文件；mid-body timeout 验证 response.destroy + request.abort 调用
  - 全量 113 tests 通过（58 checker + 16 downloader + 12 installer + 15 manager + 12 config）
- **r4e (2026-07-21, Maine Coon Sol re-review → Ragdoll Opus fix)**:
  - Sol focused re-review of r4d fix: REQUEST CHANGES — 1×P2 writer 清理缺口
  - P2 fix: 统一 settle+cleanup 路径 — `activeWs` 提升到 Promise 作用域；settle() 内嵌统一 cleanup（destroy response → end writer → abort request）；所有错误/超时/aborted handler 只需调 settle()
  - 新增 response `aborted` 事件监听（Electron abort 官方契约）
  - data handler 增加 `if (settled) return;` 阻止超时后写入
  - 更新 mid-download 测试：mock abort 触发 aborted 事件、验证 progressCount=1（无迟写）、验证文件不含超时后数据
  - 代码净减 3 行（settle+cleanup 整合消除了分散的手动 cleanup）
  - 全量 113 tests 通过（58 checker + 16 downloader + 12 installer + 15 manager + 12 config）

## History

- 原编号 F257 → F258（clowder-ai 内部 collision），后因 cat-cafe F258 (visible-cafe) 冲突重分配为 F273
- 2026-07-26: clowder-ai PR #1105 合入（Phase A–D），merge commit `d908aa265`；Phase E 首次 stable release field validation 移至合入后（operator sequencing override，不改变安全/完整性/恢复/portable/持久化/平台契约）
- 2026-07-26: clowder-ai PR #1219 docs sync 合入（`7207936a38`），status/AC-8/10/11/Timeline 同步更新；家里 intake 同步更新状态
- 2026-07-26: Clowder AI intake PR #3222 合入（`8424af315`）；代码与家里品牌/路径/feature truth 已吸收，Phase E upstream stable release field validation 仍待完成
