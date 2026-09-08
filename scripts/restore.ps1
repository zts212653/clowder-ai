# Clowder AI 迁移还原脚本 (Windows / PowerShell)
# 用法:
#   桌面 app (推荐, 一键到位):
#     .\restore.ps1 -BackupDir "C:\Users\你\cc-backup" -Password "你的密码"
#   dev 源码树 (pnpm start):
#     .\restore.ps1 -ProjectRoot "C:\Users\你\clowder-ai" -BackupDir "C:\Users\你\cc-backup" -Password "你的密码" -Layout dev
#
# 布局说明:
#   desktop - 数据还原到桌面 app 的 userData (%LOCALAPPDATA%\Clowder AI\),
#             对应 service-manager.js 的 resolveUserDataDir() + _buildApiEnv() 路径.
#             .cat-cafe -> project\.cat-cafe (findMonorepoRoot(cwd=project) + pnpm-workspace.yaml marker)
#             evidence.sqlite -> userData\ (EVIDENCE_DB env)
#             transcripts -> userData\data\transcripts\ (TRANSCRIPT_DATA_DIR env)
#             dump.rdb -> userData\data\redis\ (--dir redisDataDir)
#   dev     - 数据还原到源码树 $ProjectRoot, 给 pnpm start 用 (原行为).
param(
  [string]$ProjectRoot,        # clowder-ai 源码树路径 (dev 布局必需; desktop 布局可省略)
  [Parameter(Mandatory=$true)]
  [string]$BackupDir,          # cc-backup 仓库 clone 到的路径
  [Parameter(Mandatory=$true)]
  [string]$Password,           # 加密密码
  [ValidateSet('auto','dev','desktop')]
  [string]$Layout = 'auto'     # auto: 自动检测; dev: pnpm start 源码树; desktop: 桌面 app userData
)

$ErrorActionPreference = "Stop"

# --- 布局检测 ---
if ($Layout -eq 'auto') {
  if ($ProjectRoot -and (Test-Path (Join-Path $ProjectRoot "packages\api\dist"))) {
    $Layout = 'dev'
  } else {
    $Layout = 'desktop'
  }
}
Write-Host "布局: $Layout" -ForegroundColor Cyan

# --- 目标根目录 + 子路径 (源码确认: service-manager.js resolveUserDataDir/_buildApiEnv/_ensureUserDataDir) ---
if ($Layout -eq 'desktop') {
  $TargetRoot = Join-Path $env:LOCALAPPDATA "Clowder AI"   # = resolveUserDataDir() on Windows
  $CatCafeRel = "project\.cat-cafe"                        # findMonorepoRoot(cwd=project) + workspace marker
  $TranscriptRel = "data\transcripts"                       # TRANSCRIPT_DATA_DIR
  $RedisDataRel = "data\redis"                              # _startRedis --dir
  $IsDesktop = $true
} else {
  if (-not $ProjectRoot) { Write-Error "dev 布局需要 -ProjectRoot"; exit 1 }
  $TargetRoot = $ProjectRoot
  $CatCafeRel = ".cat-cafe"
  $TranscriptRel = "data\transcripts"
  $RedisDataRel = ".cat-cafe\run\windows\data"             # start-windows.ps1 用这个
  $IsDesktop = $false
}
Write-Host "  目标根: $TargetRoot"

$EncFile = Join-Path $BackupDir "clowder-backup.tar.gz.enc"
$TarFile = Join-Path $env:TEMP "clowder-backup.tar.gz"
$StageDir = Join-Path $env:TEMP "clowder-restore-staging"

if (-not (Test-Path $EncFile)) { Write-Error "找不到加密包: $EncFile"; exit 1 }

# 解密: 内置 .NET AES-256-CBC + PBKDF2-SHA256 (匹配 migrate-export.sh 的 openssl enc -pbkdf2 -iter 100000)
# 不依赖外部 openssl, 任何 Windows 开箱即用 (无需装 Git for Windows).
Write-Host "=== [1/6] 解密 (内置 .NET, 无需 openssl) ===" -ForegroundColor Green
try {
  $bytes = [System.IO.File]::ReadAllBytes($EncFile)
  if ($bytes.Length -lt 16 -or [System.Text.Encoding]::ASCII.GetString($bytes, 0, 8) -ne "Salted__") {
    throw "加密包格式不符 (缺 Salted__ 头, 非 openssl enc 产物)"
  }
  $salt = New-Object byte[] 8
  [Array]::Copy($bytes, 8, $salt, 0, 8)
  $ct = New-Object byte[] ($bytes.Length - 16)
  [Array]::Copy($bytes, 16, $ct, 0, $ct.Length)
  # PBKDF2-HMAC-SHA256, iter=100000, 连续派生 48 字节 = key(32) + iv(16)
  $pbkdf2 = [System.Security.Cryptography.Rfc2898DeriveBytes]::new(
    [System.Text.Encoding]::UTF8.GetBytes($Password), $salt, 100000, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
  $key = $pbkdf2.GetBytes(32)
  $iv  = $pbkdf2.GetBytes(16)
  $aes = [System.Security.Cryptography.Aes]::Create()
  $aes.KeySize = 256
  $aes.Mode    = [System.Security.Cryptography.CipherMode]::CBC
  $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
  $aes.Key = $key; $aes.IV = $iv
  $ms = New-Object System.IO.MemoryStream
  $cs = New-Object System.Security.Cryptography.CryptoStream($ms, $aes.CreateDecryptor(), [System.Security.Cryptography.CryptoStreamMode]::Write)
  $cs.Write($ct, 0, $ct.Length)
  $cs.FlushFinalBlock()
  [System.IO.File]::WriteAllBytes($TarFile, $ms.ToArray())
  $cs.Dispose(); $ms.Dispose(); $aes.Dispose()
} catch {
  Write-Error "解密失败: $($_.Exception.Message) (密码错或包损坏?)"; exit 1
}
Write-Host "  解密 OK: $TarFile"

Write-Host "=== [2/6] 解包到暂存区 ===" -ForegroundColor Green
if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
New-Item -ItemType Directory -Path $StageDir | Out-Null
tar xzf $TarFile -C $StageDir
Write-Host "  解包 OK"

$ProjStage = Join-Path $StageDir "project"

Write-Host "=== [3/6] 还原 .cat-cafe (成员管理/帐号与密钥/IM对接) ===" -ForegroundColor Green
$dstCat = Join-Path $TargetRoot $CatCafeRel
$srcCat = Join-Path $ProjStage ".cat-cafe"
if (Test-Path $srcCat) {
  New-Item -ItemType Directory -Path $dstCat -Force | Out-Null
  Get-ChildItem $srcCat | Copy-Item -Destination $dstCat -Recurse -Force
  # 修内嵌 Ubuntu 路径 (capabilities/governance 的 projectPath metadata, 非功能路径)
  $projFwd = ($dstCat -replace '\\','/')
  Get-ChildItem $dstCat -Recurse -Filter "*.json" | ForEach-Object {
    $t = Get-Content $_.FullName -Raw
    $t2 = $t -replace '/home/developer/clowder-ai', $projFwd
    if ($t -ne $t2) { [System.IO.File]::WriteAllText($_.FullName, $t2, (New-Object System.Text.UTF8Encoding $false)) }
  }
  Write-Host "  ✅ .cat-cafe -> $dstCat"
} else { Write-Host "  ⚠️ 暂存区无 .cat-cafe" -ForegroundColor Yellow }

Write-Host "=== [4/6] 还原 sqlite (记忆/证据) + transcripts (会话记录) ===" -ForegroundColor Green
# evidence/world/event-memory/task-outcome sqlite (+wal+shm) -> TargetRoot 根
# (EVIDENCE_DB env 钉在 userData 根; world/task-outcome 走 repoRoot, 桌面下也落在 project 父级,
#  放根目录是 evidence 的确定位置; 其余若空库 app 会自建, 无害)
foreach ($db in @("evidence","world","event-memory","task-outcome-episodes")) {
  foreach ($ext in @("","-wal","-shm")) {
    $s = Join-Path $ProjStage "$db.sqlite$ext"
    if (Test-Path $s) { Copy-Item $s (Join-Path $TargetRoot "$db.sqlite$ext") -Force }
  }
}
Write-Host "  ✅ sqlite 已还原到 $TargetRoot"
# transcripts -> TargetRoot\data\transcripts
$srcTr = Join-Path $ProjStage "data\transcripts"
$dstTr = Join-Path $TargetRoot $TranscriptRel
if (Test-Path $srcTr) {
  New-Item -ItemType Directory -Path $dstTr -Force | Out-Null
  Copy-Item -Path "$srcTr\*" -Destination $dstTr -Recurse -Force
  Write-Host "  ✅ transcripts -> $dstTr ($((Get-ChildItem $dstTr -Recurse -File).Count) 文件)"
} else { Write-Host "  ⚠️ 暂存区无 transcripts" -ForegroundColor Yellow }

Write-Host "=== [5/6] 还原 Redis dump ===" -ForegroundColor Green
$redisDataDir = Join-Path $TargetRoot $RedisDataRel
New-Item -ItemType Directory -Path $redisDataDir -Force | Out-Null
$srcRdb = Join-Path $StageDir "redis\dump.rdb"
if (Test-Path $srcRdb) {
  # 关键: 删 appendonlydir, 防 AOF 优先覆盖 dump.rdb 导致空库启动.
  # (service-manager.js 默认 --appendonly yes; AOF 开启时 Redis 启动只认 AOF 不认 dump.rdb)
  $aofDir = Join-Path $redisDataDir "appendonlydir"
  if (Test-Path $aofDir) { Remove-Item $aofDir -Recurse -Force; Write-Host "  删除 appendonlydir (防 AOF 覆盖 dump.rdb)" }
  Copy-Item $srcRdb (Join-Path $redisDataDir "dump.rdb") -Force
  Write-Host "  ✅ dump.rdb -> $redisDataDir"
} else { Write-Host "  ⚠️ 暂存区无 redis\dump.rdb" -ForegroundColor Yellow }

Write-Host "=== [6/6] 后处理 ===" -ForegroundColor Green
if ($IsDesktop) {
  # 桌面 app 用 _buildApiEnv() 程序化构造环境, 不读 .env / .mcp.json -> 跳过
  Write-Host "  desktop 布局: .env/.mcp.json 跳过 (桌面 app 不读, 走 _buildApiEnv)"
} else {
  # dev 布局: 还原 .env + 改 .mcp.json 绝对路径
  $srcEnv = Join-Path $ProjStage ".env"
  if (Test-Path $srcEnv) { Copy-Item $srcEnv (Join-Path $TargetRoot ".env") -Force; Write-Host "  .env 已还原" }
  $McpFile = Join-Path $TargetRoot ".mcp.json"
  if (Test-Path $McpFile) {
    $oldPath = "/home/developer/clowder-ai"
    $newPath = ($TargetRoot -replace "\\","/")
    ((Get-Content $McpFile -Raw) -replace [regex]::Escape($oldPath), $newPath) | Set-Content $McpFile -NoNewline
    Write-Host "  .mcp.json 路径已替换: $oldPath -> $newPath"
    $probePattern = "Downloads/clowder-ai-0.10.1"
    if ((Get-Content $McpFile -Raw) -match $probePattern) {
      Write-Host "  ⚠️ .mcp.json 含旧 Downloads probe 条目, 请手动删" -ForegroundColor Yellow
    }
  }
}

# ~/.claude (skills/settings/hooks) - Claude Code CLI 配置, 两种布局都还原
$HomeStage = Join-Path $StageDir "home\.claude"
$UserClaude = Join-Path $env:USERPROFILE ".claude"
if (Test-Path $HomeStage) {
  if (-not (Test-Path $UserClaude)) { New-Item -ItemType Directory -Path $UserClaude | Out-Null }
  Copy-Item -Path (Join-Path $HomeStage "*") -Destination $UserClaude -Recurse -Force
  Write-Host "  ~/.claude (skills/settings/hooks) 已还原"
}

# 清理
Remove-Item $StageDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $TarFile -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "✅ 还原完成 ($Layout 布局)！" -ForegroundColor Green
if ($IsDesktop) {
  Write-Host "下一步:" -ForegroundColor Cyan
  Write-Host "  1. 启动桌面 app (双击 Clowder AI.exe), 等 20 秒"
  Write-Host "  2. 验证: 成员管理(7猫) / 帐号与密钥 / IM对接(飞书) / 历史对话"
  Write-Host "  3. 历史对话在 = Redis dump.rdb 加载成功 (无需手动查 DBSIZE)"
  Write-Host "  ⚠️ 若启动后历史对话消失: service-manager.js 的 --appendonly yes 在 cygwin redis 上"
  Write-Host "     会因 AOF rewrite fork 崩溃覆盖 dump.rdb. 临时修复: 改为 --appendonly no (见 issue)."
} else {
  Write-Host "下一步:" -ForegroundColor Cyan
  Write-Host "  1. 若拉新版源码，按 patch-list.txt 重新应用本地 patch"
  Write-Host "  2. 启动: pnpm start --daemon --quick"
  Write-Host "  3. 验证: Web UI 3003 / IM对接有飞书 / 历史对话在"
}
