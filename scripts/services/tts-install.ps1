<#
.SYNOPSIS
  Install dependencies for TTS service on Windows (edge-tts, cloud-based).
.DESCRIPTION
  Creates ~/.cat-cafe/tts-venv, installs edge-tts (Microsoft cloud TTS).
  No GPU or model download required -- edge-tts streams from Microsoft servers.
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\prereq-check.ps1"

$BootstrapPython = Resolve-BootstrapPython
Assert-Python310 -Bootstrap $BootstrapPython
Assert-DiskSpace -RequiredGB 1
Assert-Network

$VenvDir = Join-Path $env:CAT_CAFE_HOME "tts-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating venv: $VenvDir ..."
    & $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) { throw "Failed to create tts venv" }
}

& $VenvPython -m pip install --progress-bar on -U pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip in tts-venv" }

if (-not $env:TTS_MODEL) {
    throw "ERROR: TTS_MODEL not set. Trigger via the console install button (auto-picks per scripts/services/recommendation-matrix.yaml), or manually set `$env:TTS_MODEL='<model-id>' before re-running."
}
$TtsModel = $env:TTS_MODEL
$IsPiper = $TtsModel -eq "piper" -or $TtsModel -like "zh_CN-*" -or $TtsModel -like "en_US-*" -or $TtsModel -like "en_GB-*"
$IsSapi = $TtsModel -eq "sapi"

# SAPI path is the only one that installs cleanly on native ARM64 Python
# (edge-tts -> aiohttp and piper-tts -> piper_phonemize have no win-arm64 wheels).
# Skip those deps when SAPI is selected so the install actually succeeds.
if ($IsSapi) {
    Write-Host "  Installing SAPI-only dependencies: pyttsx3 pywin32 fastapi uvicorn ..."
    $pipArgs = @('-m', 'pip', 'install', '--progress-bar', 'on',
        'pyttsx3', 'pywin32', 'fastapi', 'uvicorn', 'httpx[socks]')
} else {
    Write-Host "  Installing dependencies: edge-tts pyttsx3 fastapi uvicorn httpx ..."
    $pipArgs = @('-m', 'pip', 'install', '--progress-bar', 'on',
        'edge-tts', 'pyttsx3', 'fastapi', 'uvicorn', 'httpx[socks]', 'huggingface_hub[hf_xet]')
}
if ($env:PIP_INDEX_URL) {
    $pipArgs += @('--extra-index-url', 'https://pypi.org/simple/')
}
& $VenvPython @pipArgs
if ($LASTEXITCODE -ne 0) { throw "Failed to install TTS dependencies" }

if ($IsPiper) {
    $Voice = if ($TtsModel -eq "piper") { "zh_CN-huayan-medium" } else { $TtsModel }
    Write-Host "  Installing piper-tts + downloading voice: $Voice ..."

    $piperArgs = @('-m', 'pip', 'install', '--progress-bar', 'on', 'piper-tts')
    if ($env:PIP_INDEX_URL) { $piperArgs += @('--extra-index-url', 'https://pypi.org/simple/') }
    & $VenvPython @piperArgs
    if ($LASTEXITCODE -ne 0) { throw "Failed to install piper-tts" }

    $PiperDir = Join-Path $env:CAT_CAFE_HOME "piper-models"
    if (-not (Test-Path $PiperDir)) { New-Item -ItemType Directory -Path $PiperDir | Out-Null }

    $hfBase = if ($env:HF_ENDPOINT) { $env:HF_ENDPOINT.TrimEnd('/') } elseif ($env:HF_HUB_ENDPOINT) { $env:HF_HUB_ENDPOINT.TrimEnd('/') } else { "https://huggingface.co" }
    $voicePath = switch ($Voice) {
        "zh_CN-huayan-medium"  { "rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium" }
        "en_US-amy-medium"     { "rhasspy/piper-voices/resolve/main/en/en_US/amy/medium" }
        "en_US-lessac-medium"  { "rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium" }
        "en_GB-alan-medium"    { "rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium" }
        default                { throw "Unknown piper voice: $Voice. Supported: zh_CN-huayan-medium, en_US-amy-medium, en_US-lessac-medium, en_GB-alan-medium" }
    }
    $voiceBase = "$hfBase/$voicePath"

    $onnxPath = Join-Path $PiperDir "$Voice.onnx"
    $jsonPath = Join-Path $PiperDir "$Voice.onnx.json"
    if (-not (Test-Path $onnxPath)) {
        Invoke-WebRequest -Uri "$voiceBase/$Voice.onnx" -OutFile $onnxPath -UseBasicParsing
    }
    if (-not (Test-Path $jsonPath)) {
        Invoke-WebRequest -Uri "$voiceBase/$Voice.onnx.json" -OutFile $jsonPath -UseBasicParsing
    }
    Write-Host "  Piper voice model ready: $onnxPath"
}

Write-Host "Installation complete."
