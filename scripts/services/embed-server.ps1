<#
.SYNOPSIS
  Start local embedding server for Cat Cafe on Windows.

.DESCRIPTION
  Launches embed-api.py from ~/.cat-cafe/embed-venv.
  Dependencies are managed by embed-install.ps1.
  embed-api.py auto-detects backend: MLX -> fastembed/ONNX -> sentence-transformers.

  Env vars passed through to embed-api.py:
  - EMBED_PORT  (default 9880; overridden by -Port)
  - EMBED_MODEL / EMBED_ONNX_MODEL (model ID)
  - EMBED_DIM   (MRL-truncated output dimension)

.PARAMETER Port
  Loopback port for the local embedding HTTP sidecar.
#>

param(
    [int]$Port = 0
)
# API writes user-chosen / auto-allocated port to services.json and passes it
# through EMBED_PORT when spawning. Honour env first; fall back to hardcoded
# default only when neither -Port nor $env:EMBED_PORT was set.
if ($Port -le 0) {
    if ($env:EMBED_PORT) { $Port = [int]$env:EMBED_PORT } else { $Port = 9880 }
}

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output "[start] wrapper entered: service=embedding-model script=$PSCommandPath"
$env:PYTHONUNBUFFERED = "1"

. (Join-Path $PSScriptRoot "proxy-env.ps1")
Normalize-SocksProxyEnv

# Server scripts are spawned by the API without sourcing
# python-resolve.ps1, so $env:CAT_CAFE_HOME may not be set. Mirror the
# resolver's default (caller env override -> <repoRoot>/.cat-cafe) so
# Join-Path doesn't receive $null.
if (-not $env:CAT_CAFE_HOME) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $env:CAT_CAFE_HOME = Join-Path $repoRoot '.cat-cafe'
}

$VenvDir = Join-Path $env:CAT_CAFE_HOME "embed-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$ApiScript = Join-Path $PSScriptRoot "embed-api.py"
Write-Output "[start] resolved runtime: CAT_CAFE_HOME=$($env:CAT_CAFE_HOME); venv=$VenvDir; python=$VenvPython; api=$ApiScript; port=$Port"

if (-not (Test-Path $VenvPython)) {
    throw "Embedding venv not found. Run embed-install.ps1 first."
}

& $VenvPython -c "import fastapi, uvicorn, numpy" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Core deps missing in embed-venv. Run embed-install.ps1 first."
}

$Model = $env:EMBED_MODEL
if (-not $Model) {
    Write-Error "EMBED_MODEL env var required - backend specifies model, no fallback default."
    exit 1
}
Write-Output "Starting Embedding server: model=$Model, port=$Port"
Write-Output "[start] launching python: $VenvPython $ApiScript --model $Model --port $Port"
& $VenvPython $ApiScript --model $Model --port $Port
$ExitCode = $LASTEXITCODE
Write-Output "[start] python exited with code $ExitCode"
exit $ExitCode
