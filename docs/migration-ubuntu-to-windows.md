# Ubuntu -> Windows 桌面应用迁移：备份与恢复方案

> 迁移 Clowder AI 数据从 Ubuntu 源端到 Windows 桌面应用的完整方案。
> 本文档 + `scripts/migrate-export.sh` + `scripts/restore.ps1` 构成可复用的迁移工具集（脚本已脱敏，无真实凭据）。

## 核心数据
| 数据 | 作用 | 源端位置 |
|------|------|----------|
| Redis `dump.rdb` | 会话历史 / 成员管理 / 帐号与密钥 / IM对接 | `~/.cat-cafe/redis-opensource/dump.rdb` |
| `.cat-cafe/` | 成员管理 / 帐号与密钥 / IM对接 / 治理注册表 | `<project>/.cat-cafe` |
| `*.sqlite` | 记忆 / 证据 / 事件 / 任务结果 | `<project>/evidence.sqlite` 等 |
| `data/transcripts/` | 会话记录 | `<project>/data/transcripts` |
| `~/.claude/` | Claude Code CLI skills/settings/hooks | `~/.claude` |

## 流程
Ubuntu 打包 + AES-256-CBC(PBKDF2) 加密 -> 推送私有 git 仓库 -> Windows `git pull` -> `restore.ps1` .NET 原生解密 -> 还原到桌面 app userData。

## 脚本
- `scripts/migrate-export.sh` — Ubuntu 侧：打包 + `openssl enc -aes-256-cbc -pbkdf2 -iter 100000` 加密 + 推送。**只读，不改原文件**。
- `scripts/restore.ps1` — Windows 侧：.NET 原生 `Rfc2898DeriveBytes`+`Aes` CBC 解密（**无 openssl 依赖，开箱即用**），还原到桌面 app userData（`%LOCALAPPDATA%\Clowder AI`）或 dev 源码树（`-Layout dev`）。

## Ubuntu 侧备份指令
```bash
# 1. 先改脚本里的 git 远程（GC_REMOTE 已脱敏为占位符，填你的私有仓库地址 + 凭据）
#    GC_REMOTE="https://<user>:<token>@<your-git-host>/<owner>/cc-backup.git"
# 2. 跑备份（密码自己定，用于加密；还原时要用同一个密码）
cd /path/to/clowder-ai
./scripts/migrate-export.sh '你的加密密码'
# 产出：加密包 clowder-backup.tar.gz.enc + restore-manifest.json + restore.ps1，推送到 GC_REMOTE
```

`migrate-export.sh` 打包内容（staging 结构）：
- `project/` — `.cat-cafe` / `.env` / `.mcp.json` / `data/` / `evidence|world|event-memory|task-outcome-episodes.sqlite`(+wal+shm)
- `home/.claude/` — `skills`（**`cp -rL` 解引用**，见已知问题 2）/ `settings.json` / `hooks`
- `redis/dump.rdb`

## Windows 侧恢复指令
```powershell
# 1. clone / pull 备份仓库
cd D:\cc-backup
git pull

# 2. 关掉 app + redis（防占 6399、防 --save 60 1 覆盖 dump.rdb）
Get-Process "*clowder*","redis-server" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2

# 3. 跑还原（密码填备份时用的；desktop 布局自动检测）
.\restore.ps1 -BackupDir D:\cc-backup -Password '你的密码'

# 4. 等屏幕 [1/6]解密 -> [2/6]解包 -> [3/6].cat-cafe -> [4/6]sqlite+transcripts -> [5/6]Redis dump -> [6/6]后处理 全绿

# 5. 确认 service-manager.js 已是 --appendonly no（防 AOF 覆盖 dump.rdb 空库，见 #1169）
Select-String -Path "<desktop-dist>\resources\app\service-manager.js" -Pattern "appendonly"
#    应是 no。若是 yes：
#    (Get-Content "<desktop-dist>\resources\app\service-manager.js") -replace '--appendonly yes','--appendonly no' | Set-Content "<desktop-dist>\resources\app\service-manager.js"

# 6. 启动 app（双击 Clowder AI.exe），等 20 秒
# 7. 验证：成员管理 / 帐号与密钥 / IM对接(飞书) / 历史对话 全在 = 成功
```

`restore.ps1` 还原映射（desktop 布局；路径源码确认自 `service-manager.js` 的 `resolveUserDataDir()` / `_buildApiEnv()` / `_ensureUserDataDir()`）：
- `.cat-cafe` -> `project\.cat-cafe`（`findMonorepoRoot(cwd=project)` + `pnpm-workspace.yaml` marker）
- `evidence.sqlite` 等 -> userData 根（`EVIDENCE_DB` env）
- `transcripts` -> `data\transcripts`（`TRANSCRIPT_DATA_DIR`）
- `dump.rdb` -> `data\redis`（redis `--dir`），**并删除 `appendonlydir` 防 AOF 覆盖**
- `~/.claude` -> `%USERPROFILE%\.claude`
- desktop 布局跳过 `.env`/`.mcp.json`（桌面 app 走 `_buildApiEnv` 程序化构造，不读这两个文件）

## 已知问题
1. **Windows AOF 数据丢失 bug**（[#1169](https://github.com/zts212653/clowder-ai/issues/1169) / PR [#1170](https://github.com/zts212653/clowder-ai/pull/1170)）：桌面 app `service-manager.js` 在 Windows 启动 redis 带 `--appendonly yes`，bundled redis（cygwin/MSYS2 构建）的 AOF background rewrite `fork()` 不可靠会崩溃，空/损坏的 appendonly 文件在下次启动覆盖 `dump.rdb`，导致会话历史全部丢失。**恢复前必须确认 `--appendonly no`**（`restore.ps1` [5/6] 也会删 `appendonlydir` 兜底）。源端 Redis 7.0.15 写的 `dump.rdb` 可被 Windows 8.8.0 加载（实测 3678 keys，14 expired），版本兼容无碍。
2. **skills symlink 解包报错**（已修）：旧版 `migrate-export.sh` 用 `cp -a` 保留 `~/.claude/skills` 的符号链接，Windows `tar.exe` 解不开 symlink 报 `Can't create ... Invalid argument`。已改 `cp -rL` 解引用复制实际文件。该报错无害（桌面 app 不依赖 Claude Code CLI skills），但已修复以消除噪声。

## 安全
- 加密密码由操作者控制，**不落脚本、不落日志**（仅作为 `migrate-export.sh` / `restore.ps1` 的参数传入）。
- `GC_REMOTE` 已脱敏为占位符，使用前填你自己的私有 git 仓库地址 + 凭据；不要把真实 token 提交进仓库。
- 备份包含 `.env` / `.mcp.json`（含密钥），仓库必须私有；不再需要时及时删除仓库并轮换其中暴露过的凭据。
