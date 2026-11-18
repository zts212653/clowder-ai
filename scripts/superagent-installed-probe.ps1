param([Parameter(Mandatory=$true)][string]$ArchivePath)
$ErrorActionPreference = 'Stop'
$archive = (Resolve-Path -LiteralPath $ArchivePath).Path
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$probeRoot = Join-Path $workspace ('artifacts/superagent-installed-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $probeRoot -Force | Out-Null
if (Get-NetTCPConnection -LocalPort 6417 -State Listen -ErrorAction SilentlyContinue) { throw 'Probe port 6417 is already owned; no existing service will be stopped.' }
$redisBinary = (Get-CimInstance Win32_Process -Filter "Name='redis-server.exe'" | Select-Object -First 1).ExecutablePath
if (-not $redisBinary) { throw 'No local Redis binary was found.' }
$redisCli = Join-Path (Split-Path -Parent $redisBinary) 'redis-cli.exe'
$redisProcess = Start-Process -FilePath $redisBinary -ArgumentList @('--bind','127.0.0.1','--port','6417','--dir',$probeRoot,'--appendonly','yes','--databases','16','--logfile',(Join-Path $probeRoot 'redis.log')) -WorkingDirectory $probeRoot -WindowStyle Hidden -PassThru
try {
  $listener = $null
  foreach ($attempt in 1..30) {
    $listener = Get-NetTCPConnection -LocalPort 6417 -State Listen -ErrorAction SilentlyContinue
    if ($listener) { break }
    Start-Sleep -Milliseconds 100
  }
  if (-not $listener -or $listener.OwningProcess -ne $redisProcess.Id) { throw 'Redis listener ownership was not confirmed.' }
  $ledgerPath = Join-Path $probeRoot 'instance.json'
  $ledger = @{ pid=$redisProcess.Id; port=6417; dataDirectory=$probeRoot; executable=$redisBinary; url='redis://127.0.0.1:6417/15'; owner='codex'; purpose='superagent installed artifact journey'; archive=$archive }
  [System.IO.File]::WriteAllText($ledgerPath, ($ledger | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
  $env:SUPERAGENT_ARCHIVE_PATH = $archive
  $env:SUPERAGENT_TEST_REDIS_URL = $ledger.url
  $env:SUPERAGENT_WINDOWS_PROBE_LEDGER = $ledgerPath
  $env:SUPERAGENT_EVIDENCE_DIR = $probeRoot
  Push-Location (Join-Path $workspace 'packages/api')
  try {
    node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import tsx --test test/superagent-installed.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Installed artifact journey failed; evidence directory retained.' }
  } finally { Pop-Location }
} finally {
  $ownedListener = Get-NetTCPConnection -LocalPort 6417 -State Listen -ErrorAction SilentlyContinue
  if ($ownedListener -and $ownedListener.OwningProcess -eq $redisProcess.Id) {
    & $redisCli -h 127.0.0.1 -p 6417 shutdown
    $redisProcess.WaitForExit(5000) | Out-Null
  }
  Write-Output ('Retained isolated probe: ' + $probeRoot)
}
