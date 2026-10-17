---
feature_ids: [pr-1519]
topics: [installer, windows, integrity, delivery]
doc_kind: diagnosis
created: 2026-10-17
---

# PR #1519 安装包安装失败：完整性标签诊断与修复

## 现象（两层，先后出现）

1. **第一层**：双击交付 EXE，在进入向导前弹出
   `安装程序无法创建目录 …\Temp\is-XXXX.tmp。错误 5: 拒绝访问。`
2. **第二层**：把 EXE 标签改为 Medium 后，向导能走到“正在准备安装”，但 PrepareToInstall 弹出
   `Unable to preserve the target installation identity. See setup log.`
   对应 Setup 日志（`%TEMP%\Setup Log 2026-10-17 #007.txt`）显示：
   `Add-Type : 客户端没有所需的特权`（Win32 **1314**，`System.ComponentModel.Win32Exception`），随后 `Identity helper started=1, exit=1`。

## 根因

构建根 `G:\AIwork\clowder-ai\worktrees\feat-onboarding-first-run`（及其 `dist/`、`artifacts/`）带有
`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，构建产物继承 Low 标签。

Windows 会按可执行文件的强制完整性标签启动进程（实测：把 `cmd.exe` 标为 Low，启动后 `whoami /all` 显示 Low；标为 Medium 则显示 Medium；标为 High 则显示 High）。这导致：

- **Low 标签** → Setup 进程以 Low 运行 → 不能写 Medium 的 `%TEMP%` → Inno 在提权/向导之前创建 `is-*.tmp` 失败 → **错误 5**。
- **显式 Medium 标签** → Setup 进程被限制在 Medium（即使已请求管理员安装），提权后的身份 helper 仍无法获得 High 令牌 → PowerShell `Add-Type` 编译 `csc.exe` 时报 **Win32 1314**（缺少所需特权）→ 身份 helper 失败。
- **无标签（普通构建）或 High 标签** → Setup 以调用方令牌运行；管理员安装可获得 High → TEMP 创建和身份 helper 均正常。

对照实验（同一台机器、同一 Inno 7.1.0 探针，唯一变量是 EXE 标签/所在目录）：

| EXE 状态 | 子进程 token | Add-Type |
|---|---|---|
| Medium 目录、无标签 | High | OK |
| Low 目录、显式 Medium | Medium | FAIL 1314 |
| Low 目录、显式 High | High | OK |
| 真实 identity helper + High | High | exit 0 |

已排除：`%TEMP%` ACL（Administrator 有 F）、UAC/GPO/杀软拦截；失败发生在任何安装逻辑之前。

## 修复

### 1. 交付物完整性工具

`desktop/scripts/installer-integrity.mjs`

- `readMandatoryLabel(file)`：用 `icacls` 读取强制完整性标签（无标签行 = 默认/无标签，正常）。
- `isReleaseBlocking(label)`：**无标签** 或 **显式 High** 视为可发布；Low、显式 Medium 或其它标签视为阻塞。
- `ensureReleaseIntegrity(file)`：阻塞时执行 `icacls <file> /setintegritylevel High` 并复核；仍阻塞则抛错，**不允许发布不可启动的安装包**。
- CLI：
  - `--check --json`：只检查；阻塞时 exit 1。
  - 默认：纠正为 High。
  - `--copy-to <dir>`：复制到交付目录后确保副本可发布（推荐复制到用户 Downloads/Desktop 等默认目录，副本无标签，最自然）。

> 关键修正：不是“设为 Medium”。显式 Medium 会把提权后的 Setup 压在 Medium，触发身份 helper 1314；当前修复统一升为 **High**（或使用无标签副本）。

### 2. 构建脚本接入（fail-closed）

`desktop/scripts/build-desktop.ps1`

- 构建开始：若构建根标签受限，打印 warning（产物会继承，交付前会被纠正）。
- Step 7 Inno 编译成功后：对最终 Setup 运行 `installer-integrity.mjs`；纠正失败则构建失败，不输出 “Installer ready!”。
- Step 9 `dist/build-manifest.json` 记录 `installer.integrity`、`workingTree.buildRootIntegrity`、`workingTree.installerIntegrity`。
- 若 `-SkipInstaller` 且已有 Setup，Step 9 也会复查/纠正并记录。

### 3. 回归测试

`desktop/installer-integrity.test.mjs`（已加入 `.github/workflows/windows-smoke.yml`）：

1. 缺失文件抛错。
2. 无标签可发布；Low 与显式 Medium 阻塞。
3. Low → High 纠正且幂等。
4. 显式 Medium → High 纠正。
5. `--check` 对 Low / 显式 Medium 均 exit 1，纠正后 exit 0。
6. `--copy-to` 交付副本可发布。

本机 7/7 pass；非 Windows 自动 skip。

### 4. 当前交付包立即修复

已对以下文件执行 `icacls … /setintegritylevel High`（**字节不变，SHA-256 不变**），`--check` 均为 `ok:true`：

- `dist/ClowderAI-Setup-1.14.0.exe`
- `artifacts/pr1519-exe-98a7bbfc53-20261017/ClowderAI-Setup-1.14.0-pr1519-98a7bbfc53.exe`（截图对应文件，SHA-256 `5D788589…`）
- `artifacts/pr1519-clean-install-98a7bbfc5-20261017/ClowderAI-Setup-validated*.exe`
- `artifacts/pr1519-exe-prior-d125bd8b-20261017/ClowderAI-Setup-1.14.0-prior-d125.exe`

`build-manifest.json` / `delivery-manifest.json` 已补 `integrity: High` 与说明。

## 你的验收步骤

1. 确认交付 EXE 标签（应显示 High；或无 Mandatory Label 行，表示普通无标签）：
   ```powershell
   icacls .\ClowderAI-Setup-1.14.0-pr1519-98a7bbfc53.exe
   node desktop\scripts\installer-integrity.mjs <exe> --check --json
   # 期望 ok:true；level 为 High（或 Medium 且 raw 为空 = 无标签）
   ```
2. 双击 EXE：应先出现安装向导 → “正在准备安装”不再报身份错误 → 继续完成干净首装。
3. 若仍失败，请保留最新的 `%TEMP%\Setup Log *.txt`。重点看：
   - 是否又出现 `Add-Type ... 1314`（说明 EXE 又被复制/重建为 Medium/Low 标签）；
   - 是否出现 `is-*.tmp` 错误 5（说明标签仍是 Low）；
   - `Identity helper command:` 行以确认实际运行路径与参数。
4. 重新构建时确认日志：Step 7 出现 `Setup integrity: High`（纠正时先 warning）；`dist/build-manifest.json` 的 `installer.integrity` 为 `High`。

## 交付注意事项

- 交付前运行 `installer-integrity.mjs <exe> --check`，或使用 `--copy-to` 直接生成可安装副本。
- 从 Low 工作树目录直接分发会导致失败；复制到用户 Downloads/Desktop（默认目录）或先升为 High 再分发。
- 不要把构建根或 EXE 设为 **Medium**：它会复现身份 helper 1314。可选清理构建根标签时，应设为 **High** 或移除标签（需确认沙箱不依赖低标签），而不是 Medium。
- 本修复不改安装包内容/安装目录/端口/Redis/SQLite/HOME/已有角色和历史；标签不属于文件字节，SHA-256 保持与 manifest 一致。
