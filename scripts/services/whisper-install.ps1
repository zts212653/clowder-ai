<#
.SYNOPSIS
  Install dependencies for Whisper ASR service on Windows.
.DESCRIPTION
  Creates ~/.cat-cafe/whisper-venv, installs faster-whisper (CTranslate2-based).
  Detects NVIDIA GPU for CUDA acceleration.
  Keeps faster-whisper model aliases but downloads through snapshot_download.

  Env vars:
  - WHISPER_MODEL  (default: large-v3-turbo)
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\prereq-check.ps1"

$BootstrapPython = Resolve-BootstrapPython
Assert-Python310 -Bootstrap $BootstrapPython
Assert-DiskSpace -RequiredGB 4
Assert-Network

$VenvDir = Join-Path $env:CAT_CAFE_HOME "whisper-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating venv: $VenvDir ..."
    & $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) { throw "Failed to create whisper venv" }
}

& $VenvPython -m pip install --progress-bar on -U pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip in whisper-venv" }

$ffmpegPath = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpegPath) {
    Write-Host ""
    Write-Host "  WARNING: ffmpeg not found. Whisper ASR needs ffmpeg."
    Write-Host "  Install via:  winget install Gyan.FFmpeg"
    Write-Host "  Or download:  https://ffmpeg.org/download.html"
    Write-Host ""
}

Write-Host "  Installing dependencies: faster-whisper fastapi uvicorn ..."
$pipArgs = @('-m', 'pip', 'install', '--progress-bar', 'on',
    'faster-whisper', 'fastapi', 'uvicorn', 'python-multipart', 'httpx[socks]', 'huggingface_hub[hf_xet]')
if ($env:PIP_INDEX_URL) {
    $pipArgs += @('--extra-index-url', 'https://pypi.org/simple/')
}
& $VenvPython @pipArgs
if ($LASTEXITCODE -ne 0) { throw "Failed to install whisper dependencies" }

$hasCuda = $false
try {
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $null = & nvidia-smi 2>$null
    if ($LASTEXITCODE -eq 0) { $hasCuda = $true }
    $ErrorActionPreference = $prevEAP
} catch {}

if ($hasCuda) {
    Write-Host "  NVIDIA GPU detected, upgrading to GPU-accelerated ctranslate2 ..."
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    & $VenvPython -m pip install --progress-bar on ctranslate2
    $ErrorActionPreference = $prevEAP
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  GPU ctranslate2 install failed, using CPU"
    }
} else {
    Write-Host "  No NVIDIA GPU detected, using CPU inference"
}

if (-not $env:WHISPER_MODEL) {
    throw "ERROR: WHISPER_MODEL not set. Trigger via the console install button (auto-picks per scripts/services/recommendation-matrix.yaml), or manually set `$env:WHISPER_MODEL='<model-id>' before re-running."
}
$WhisperModel = $env:WHISPER_MODEL
Write-Host "  Pre-downloading model: $WhisperModel ..."
Invoke-ModelDownloadWithRetry -VenvPython $VenvPython -ModelId $WhisperModel -Loader "faster_whisper"

Write-Host "Installation complete."
