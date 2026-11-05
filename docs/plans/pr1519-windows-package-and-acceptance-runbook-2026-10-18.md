---
feature_ids: ["pr-1519", "issue-1466"]
topics: [windows, installer, packaging, startup, tray, acceptance]
doc_kind: implementation-plan
created: 2026-10-18
---

# PR #1519 Windows 安装包固定打包与验收方案

## 目标

把 PR #1519 的 Windows 交付收敛为一条可重复的发布路径。每个安装包都必须能回答四个问题：

1. 它是不是当前要交付的 exact HEAD？
2. Web、API、Electron 壳和安装器是不是同一次构建的产物？
3. 它能否在干净目录中安装并首次启动？
4. 窗口关闭、托盘恢复、显式退出和同版升级是否符合预期？

“electron-builder 成功”“Inno Setup 编译成功”只能证明中间阶段完成，不能代替安装、启动、数据回读和托盘验收。

## 本轮现象与已确认的根因

### 1. 安装阶段 `MoveFile 错误 183`

截图中的目标是：

```text
{app}\\cat-cafe-skills\\.cat-cafe-shared-refs
```

当前工作树中的 `cat-cafe-skills/.cat-cafe-shared-refs` 是 Git 在 Windows 检出后的四字节 marker（内容为 `refs`），不是目录。安装器同时存在：

- `Source: ..\\..\\cat-cafe-skills\\*` 的递归写入；
- `Source: ..\\..\\cat-cafe-skills\\refs\\*` 写入同一个 `.cat-cafe-shared-refs` 目标。

如果 Inno 的 `Excludes` 没有把 marker 从第一条递归来源排除，Setup 会先把 marker 当文件写入目标，再把 `refs` 目录写到同一目标，最终触发 `MoveFile` 183。旧安装目录残留会放大这个问题，但不能依赖升级删除逻辑来掩盖源清单重复。

**阻断结论**：下一次打包前必须让源清单对每个目标路径只有一个 owner，并增加真实编译/安装前的重复目标检查。不能只点击“重试”或“跳过此文件”。

### 2. 安装器无法启动或准备安装阶段报错

历史上出现过两类不同根因：

- EXE 继承 Low 完整性标签，Setup 在 `%TEMP%` 创建 `is-*.tmp` 时错误 5；
- EXE 被压成 Medium，提权后的身份 helper 又可能因 Win32 1314 失败。

发布包必须在构建根、交付副本两个位置都执行完整性检查；Low 和显式 Medium 均阻断交付，交付包要求 High 或普通无限制标签，并记录检查结果。

### 3. 安装成功但首次启动失败

历史上有两种“包看起来正常、实际不能启动”的问题：

- `app.asar` 白名单遗漏 `startup-failure-handler.js` 等主进程闭包模块；
- Web/API 的 `.build-commit` 被手工改成当前 SHA，但实际 bundle 仍来自旧构建，运行时的 fail-closed 检查因此拒绝启动。

`.build-commit` 只能是构建结果的证明，不能用改文件内容的方式伪造。Web 与 API 必须在同一 source SHA 重新构建，之后才能写入/验证 stamp。

### 4. 关闭窗口后托盘消失、进程退出

当前源码仍有 Windows 关闭拦截和 `window-all-closed` 保活逻辑；未观测分支是托盘创建失败后返回空对象，导致关闭策略无法隐藏窗口。没有生命周期日志时，无法区分托盘创建失败、显式退出、更新器退出和运行旧包。

因此托盘问题必须用运行日志和真实操作验证，不能只读源码或只看进程名。

## 固定构建流程

所有发布包只允许从一个干净的 PR worktree 生成。禁止从桌面散落 EXE、旧 `dist` 或旧 `bundled/deploy` 拼装。

### 阶段 A：身份与输入冻结

工作目录固定为：

```text
G:\\AIwork\\clowder-ai\\worktrees\\feat-onboarding-first-run
```

构建开始时记录：

```powershell
git rev-parse HEAD
git status --short --untracked-files=all
git diff --check
```

发布构建要求：

- `HEAD`、远端 PR head、PR base 和本次 CI SHA 一致；
- 已处理 merge 冲突，index 无 unmerged entry；
- 被打包的 `desktop/`、`packages/api/`、`packages/web/`、`bundled/` 输入无未声明修改；
- 允许的证据目录必须在 manifest 中显式列出，不能混入安装器；
- `desktop/resources-prebuilt`、旧 EXE、旧安装目录、日志和测试 HOME 不进入发行输入。

脏工作树只允许诊断构建，生成的 manifest 必须标记 `releaseable=false`，不得交给用户。

### 阶段 B：同 SHA 生成 Web/API

使用仓库锁定的 pnpm 和 Node，在同一工作树执行 Web/API 构建。禁止复用旧 `.next`、旧 `api/dist`，禁止只修改 `.build-commit` 冒充重建。

验收不变量：

```text
packages/web/.next/.build-commit == git rev-parse HEAD
packages/web/.next/required-server-files.json.config.env.NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION == 同一 SHA
packages/api/dist/.build-commit == 同一 SHA
```

随后运行 `desktop/scripts/verify-web-build.cjs`，验证生产配置、stamp 和 required-server-files 三者一致。任何不一致直接停止，不进入 Electron 或 Inno 阶段。

### 阶段 C：冻结运行时和归档

运行 `desktop/scripts/frozen-runtime-deploy.mjs` 生成新的 `bundled/deploy-<sha>`，验证后再原子替换 `bundled/deploy`。旧目录移动到具名回退目录，禁止覆盖或直接删除。

归档前检查：

- API、Web、MCP、dependencies、Node、Electron 每个归档都有 sidecar manifest；
- 归档内容没有 unresolved junction/reparse target；
- 归档中的 Web/API stamp 仍为当前 SHA；
- 共享 workspace 包按 canonical source 去重，私有/peer 版本保留；
- `tar -tzf` 可以完整列出每个归档，抽取器能验证 entry count、size 和 sha256。

构建脚本还会运行 `desktop/scripts/verify-runtime-archives.mjs`。它对安装器会消费的六个归档逐一检查：文件存在、字节数大于零；除 Node 归档外必须存在 sidecar，且 sidecar 中的归档名和字节数必须与实际文件一致。任一检查失败会在 Inno 编译前退出，禁止把半成品交付给用户。对应回归测试为 `desktop/verify-runtime-archives.test.mjs`。

### 阶段 D：Electron/ASAR 闭包

Electron 壳必须使用 `desktop/package-lock.json` 锁定的版本。`electron-builder --dir` 完成后，`afterPack` 必须读取真实 `app.asar` 并检查主进程本地 `require` 闭包；缺少 `startup-failure-handler.js`、`shutdown-controller.js`、`runtime-web-config.js` 等文件时立即失败。

同时检查：

- `asarUnpack` 中的外部 Node 入口实际存在于 `app.asar.unpacked`；
- `assets/icon.ico` 存在；
- 关闭策略、生命周期诊断和托盘代码在最终 `app.asar` 中，不只存在于源码。

### 阶段 E：Inno Setup 与安装器来源清单

在调用 `ISCC.exe` 前执行安装器源清单预检：

1. 展开每条 `[Files]` 的 source glob；
2. 计算目标相对路径；
3. 若同一目标由两个 source owner 写入，直接失败；
4. 特别检查 `.cat-cafe-shared-refs` marker 不得出现在 broad wildcard 的输出中；它只能由 `cat-cafe-skills\\refs\\*` 这一条来源生成目录；
5. 预检同时检查 `[InstallDelete]` 只删除程序拥有的路径，不触及 HOME、Redis、SQLite、角色和历史。

编译命令统一由 `desktop/scripts/build-desktop.ps1` 调用，不手工在 `desktop/installer` 目录另编一份。编译结果必须执行：

```powershell
node desktop/scripts/installer-integrity.mjs <setup.exe> --check --json
Get-FileHash <setup.exe> -Algorithm SHA256
```

交付副本复制后再次运行同样的 `--check` 和 hash；复制不是证据，最终交付路径的检查结果才是证据。

### 阶段 F：构建证据清单

`dist/build-manifest.json` 是唯一包身份入口，至少包含：

- source SHA、branch、版本、生成时间；
- Setup 路径、大小、SHA-256、完整性标签；
- Web/API build identity；
- 每个归档及 sidecar 的大小和 SHA-256；
- app.asar/app.asar.unpacked 的关键条目；
- packaged tracked/untracked 状态；
- releaseable 和每个阶段的结果。

没有 manifest、manifest SHA 不一致或 manifest 标记 dirty 的包不得交付。

## 固定验收流程

### 1. 无账号静态/契约门

本地定向检查至少包括：

```powershell
node --test desktop/runtime-web-config.test.js
node --test --test-name-pattern="Windows shell excludes|installer failure" desktop/runtime-archive-progress.test.mjs
auto: node --test desktop/installer-integrity.test.mjs
node --test desktop/after-pack.test.js desktop/startup-failure-handler.test.js desktop/shutdown-controller.test.js
```

实际仓库不存在的测试文件不得写进发布命令；执行前由 CI 脚本检查测试入口存在，否则失败。所有首启/onboarding/A2A 脚本都必须由 `packages/web/package.json` 声明并被 CI 调用，不能接受 `None of the selected packages has a ... script` 后仍判绿。

### 2. 干净首装

每次只创建一套作者验收实例和一套用户交付实例，使用不同程序目录、数据目录、HOME、Redis 和端口。生产端口 `3003/3004/6399` 永不参与。

首装必须满足：

- 全新程序目录和全新 instance root，不以覆盖升级代替；
- 安装器 exit 0，日志包含 extraction/configuration 阶段；
- 无 Inno 帮助窗口、无 `%TEMP%\\is-*.tmp` 错误 5、无 MoveFile 183；
- 安装后程序文件、数据文件和日志路径与 manifest 一致；
- 安装前后的用户 HOME、角色、会话、Redis、SQLite 保护清单哈希不变。

### 3. 首次启动与冷启动阶段

启动记录：安装包 SHA、EXE 路径、PID、命令行、程序目录、instance root、端口、启动日志目录。按阶段测量：

```text
process-start → Redis-ready → API-listen → Web-ready → renderer-visible → tray-created
```

成功条件：

- `startup-state.json` 为 `phase=ready`；
- Web 端口 HTTP 200，API health/ready 成功；
- `desktop.log` 没有 stale revision、缺模块或 code 1；
- 同一实例连续启动不会生成第二套后端；
- 120 秒失败门禁必须报告具体阶段，而不是只显示总超时。

### 4. 托盘与退出生命周期

在同一安装实例人工操作并保存日志：

1. 启动后记录 PID 和 `tray-created`；
2. 点击窗口关闭，5 秒后确认窗口隐藏、PID/API/Redis 仍存活；
3. 从托盘“显示”恢复窗口；
4. 从托盘“退出”，确认 `quit-requested(source=tray)`、服务只清理一次、端口释放；
5. 第二次启动只恢复已有窗口，不创建第二套服务；
6. 更新器/安装器退出路径仍可清理；
7. 托盘创建失败时必须出现可诊断日志和可恢复入口，不能静默变成无入口后台进程。

必须在 `desktop.log` 中看到：

```text
tray-create-requested / tray-created 或 tray-create-failed
window-close-requested / window-close-hidden 或 window-close-kept-visible
window-all-closed
before-quit
quit-requested(source=...)
```

### 5. 引导、角色和真实调用

在无角色、无历史的干净实例中依次验证：

- 首启演示明确是 mock，不调用用户模型；
- “一键检测”和“添加成员”是两个独立入口；
- 0/1/N 选择都能完成；取消 Claude 后其他已选 client 仍可创建；
- Claude、Codex、DSH、Kimi、Pi 的检测状态、头像、短 ID、provider/model 信息正确；
- 至少一个真实调用成功；刷新/重启后角色、线程、消息和配置可回读；
- 引导演示与真实配置不污染用户现有 HOME、原生客户端历史和 Redis。

### 6. 同版升级与恢复

使用带角色、配置、消息和偏好的专用升级基线，运行同版 Setup 覆盖一次，再验证：

- 角色 ID、昵称、账号绑定和消息引用不变；
- Redis/SQLite/上传文件/原生客户端历史可读；
- 安装器只替换程序拥有目录；
- 中断后再次运行同版 Setup 可恢复；
- 不把升级验证当作干净首装证据，两者分别记录。

## CI 固定门禁

PR 必须在同一个 exact HEAD 触发并完成：

- Lint、Build、Public contract surfaces；
- Public test 全部 shard；
- Web first-run/onboarding 真实脚本存在且实际执行；
- Windows smoke：Inno 原生测试、完整性测试、ASAR/归档契约、启动/关闭测试；
- Windows installed smoke：真实安装布局、冷启动日志、API/Web ready、同版恢复；
- macOS preview：DMG 和启动身份测试。

任何 job 出现 `pending`、脚本缺失后判绿、使用旧 SHA 证据、只测 unpacked 目录未测 Setup，都标记 No-Go。

## 交付和清理规则

每次交付只保留：

- 当前验证通过的 Setup；
- 一份明确命名且可回退的上一版 Setup；
- 当前构建目录和 manifest；
- 用户正在验收的环境。

旧 EXE、失效快捷方式、临时安装目录、重复 frozen workspace 和测试日志进入具名清理清单。清理前核对绝对路径、进程归属、端口和 reparse point；只停止已确认属于本轮的进程，不按通用 `node`/`Electron`/`Redis` 名称批量结束。清理程序文件不能删除 HOME、认证、角色、历史、SQLite、Redis/AOF/RDB 或用户指定备份。

## 发布回执模板

每次 PR 更新必须引用同一 exact HEAD，并附：

```text
sourceSha:
installerPath:
installerSha256:
installerIntegrity:
webBuildIdentity:
apiBuildIdentity:
manifestPath:
CI checks:
clean install: PASS/FAIL + log
first startup: PASS/FAIL + startup log
tray lifecycle: PASS/FAIL + lifecycle log
real call/history: PASS/FAIL + evidence
same-version recovery: PASS/FAIL + evidence
remaining No-Go:
```

只有上述字段齐全、当前 HEAD 的 CI 全部完成、干净首装和首次启动通过，才允许把 EXE 交给用户验收。否则只能交付为诊断包，并明确它不可作为发布候选。
