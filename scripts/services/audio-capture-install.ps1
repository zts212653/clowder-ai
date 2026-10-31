<#
.SYNOPSIS
  Install dependencies for Audio Capture service on Windows.
.DESCRIPTION
  Creates <CAT_CAFE_HOME>\audio-capture-venv and installs sounddevice,
  FastAPI, Uvicorn, and NumPy. Audio Capture has no model download step.
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\prereq-check.ps1"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$AudioScript = Join-Path $repoRoot "scripts\meeting-copilot\audio-service.py"
if (-not (Test-Path $AudioScript)) {
    throw "audio-service.py not found at $AudioScript. F195 audio-capture runtime is not bundled in this checkout; refusing to install an unusable service."
}

$BootstrapPython = Resolve-BootstrapPython
Assert-Python310 -Bootstrap $BootstrapPython
Assert-DiskSpace -RequiredGB 1
Assert-Network

$VenvDir = Join-Path $env:CAT_CAFE_HOME "audio-capture-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating venv: $VenvDir ..."
    & $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) { throw "Failed to create audio-capture venv" }
}

& $VenvPython -m pip install --progress-bar on -U pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip in audio-capture-venv" }

Write-Host "  Installing dependencies: sounddevice fastapi uvicorn numpy ..."
$pipArgs = @('-m', 'pip', 'install', '--progress-bar', 'on', 'sounddevice', 'fastapi', 'uvicorn', 'numpy')
if ($env:PIP_INDEX_URL) {
    $pipArgs += @('--extra-index-url', 'https://pypi.org/simple/')
}
& $VenvPython @pipArgs
if ($LASTEXITCODE -ne 0) { throw "Failed to install audio-capture dependencies" }

Write-Host "Installation complete."
