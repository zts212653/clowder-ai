<#
.SYNOPSIS
  Install dependencies for LLM post-processing service on Windows.
.DESCRIPTION
  Creates ~/.cat-cafe/llm-venv, installs transformers + torch.
  Detects NVIDIA GPU for CUDA acceleration.

  Env vars:
  - LLM_POSTPROCESS_MODEL  (default: Qwen/Qwen2.5-3B-Instruct)
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\prereq-check.ps1"

$BootstrapPython = Resolve-BootstrapPython
Assert-Python310 -Bootstrap $BootstrapPython
Assert-DiskSpace -RequiredGB 8
Assert-Network

$VenvDir = Join-Path $env:CAT_CAFE_HOME "llm-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating venv: $VenvDir ..."
    & $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) { throw "Failed to create llm venv" }
}

& $VenvPython -m pip install --progress-bar on -U pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip in llm-venv" }

# Arch check: gate on the *interpreter's* architecture (resolved by
# python-resolve.ps1), not the host OS. On ARM64 Windows the resolver
# downloads an AMD64 Python to ~/.cat-cafe/python/, so $BootstrapPython
# can be AMD64 even when the host OS is ARM64 -- in that case transformers
# / tokenizers install fine. Reject only when the interpreter itself is
# native ARM64 (where no upstream wheels exist).
$interpreterMachine = (& $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-c', 'import platform; print(platform.machine())'))).Trim().ToLower()
if ($interpreterMachine -eq 'arm64' -or $interpreterMachine -eq 'aarch64') {
    Write-Error @"
ERROR: LLM post-processing service does not yet support ARM64 Python interpreters.

Reason: the transformers library depends on tokenizers/safetensors (compiled from Rust), and no win-arm64 prebuilt wheels exist yet.
        Unlike Embedding, LLM text generation has no lightweight pure-ONNX alternative.

Solutions:
  1. Let cat-cafe's python-resolve auto-install AMD64 Python to ~/.cat-cafe/python/, then retry
     (this is the standard path on ARM64 Windows, relying on Prism emulation to run AMD64 wheels).
  2. Or manually download "Windows installer (64-bit)" from https://www.python.org/downloads/.
  3. Skip this service - LLM post-processing is used only for secondary ASR correction; it does not affect speech recognition itself.
"@
    exit 1
}

$hasCuda = $false
try {
    $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $null = & nvidia-smi 2>$null
    if ($LASTEXITCODE -eq 0) { $hasCuda = $true }
    $ErrorActionPreference = $prevEAP
} catch {}

if ($hasCuda) {
    Write-Host "  NVIDIA GPU detected, installing CUDA-accelerated torch ..."
    & $VenvPython -m pip install --progress-bar on torch --index-url https://download.pytorch.org/whl/cu121
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  CUDA torch failed, falling back to CPU torch"
        & $VenvPython -m pip install --progress-bar on torch --index-url https://download.pytorch.org/whl/cpu
    }
} else {
    Write-Host "  No NVIDIA GPU detected, installing CPU torch ..."
    & $VenvPython -m pip install --progress-bar on torch --index-url https://download.pytorch.org/whl/cpu
}
if ($LASTEXITCODE -ne 0) { throw "Failed to install torch" }

Write-Host "  Installing dependencies: transformers fastapi uvicorn pydantic ..."
$pipArgs = @('-m', 'pip', 'install', '--progress-bar', 'on',
    'transformers', 'fastapi', 'uvicorn', 'pydantic', 'huggingface_hub[hf_xet]')
if ($env:PIP_INDEX_URL) {
    $pipArgs += @('--extra-index-url', 'https://pypi.org/simple/')
}
& $VenvPython @pipArgs
if ($LASTEXITCODE -ne 0) { throw "Failed to install LLM dependencies" }

if (-not $env:LLM_POSTPROCESS_MODEL) {
    throw "ERROR: LLM_POSTPROCESS_MODEL not set. Trigger via the console install button (auto-picks per scripts/services/recommendation-matrix.yaml), or manually set `$env:LLM_POSTPROCESS_MODEL='<model-id>' before re-running."
}
$LlmModel = $env:LLM_POSTPROCESS_MODEL
Write-Host "  Pre-downloading model: $LlmModel ..."
Invoke-ModelDownloadWithRetry -VenvPython $VenvPython -ModelId $LlmModel -Loader "snapshot"

Write-Host "Installation complete."
