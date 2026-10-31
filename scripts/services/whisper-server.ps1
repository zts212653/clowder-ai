<#
.SYNOPSIS
  Start local Whisper ASR server on Windows (faster-whisper backend).
.PARAMETER Port
  Loopback port (default 9876).
#>

param([int]$Port = 0)
# API writes user-chosen / auto-allocated port to services.json and passes it
# through WHISPER_PORT when spawning. Honour env first; fall back to hardcoded
# default only when neither -Port nor $env:WHISPER_PORT was set.
if ($Port -le 0) {
    if ($env:WHISPER_PORT) { $Port = [int]$env:WHISPER_PORT } else { $Port = 9876 }
}

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output "[start] wrapper entered: service=whisper-stt script=$PSCommandPath"
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

$VenvDir = Join-Path $env:CAT_CAFE_HOME "whisper-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$ApiScript = Join-Path $PSScriptRoot "whisper-api.py"
Write-Output "[start] resolved runtime: CAT_CAFE_HOME=$($env:CAT_CAFE_HOME); venv=$VenvDir; python=$VenvPython; api=$ApiScript; port=$Port"

if (-not (Test-Path $VenvPython)) {
    throw "Venv not found: $VenvDir. Run whisper-install.ps1 first."
}

$ffmpegPath = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpegPath) {
    Write-Host "WARNING: ffmpeg not found. Install via: winget install Gyan.FFmpeg"
}

$Model = $env:WHISPER_MODEL
if (-not $Model) {
    Write-Error "WHISPER_MODEL env var required - backend specifies model, no fallback default."
    exit 1
}
Write-Output "Starting Whisper server: model=$Model, port=$Port"
Write-Output "[start] launching python: $VenvPython $ApiScript --model $Model --port $Port"
& $VenvPython $ApiScript --model $Model --port $Port
$ExitCode = $LASTEXITCODE
Write-Output "[start] python exited with code $ExitCode"
exit $ExitCode
