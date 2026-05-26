<#
.SYNOPSIS
  Install dependencies for Embedding service on Windows.

.DESCRIPTION
  Creates ~/.cat-cafe/embed-venv and installs embedding dependencies.
  ARM64: fastembed + ONNX Runtime (no Rust compilation needed).
  x86/x64: sentence-transformers + torch (full pipeline).

  The embed-api.py auto-detects the available backend at startup.

  Env vars:
  - EMBED_MODEL  (model to install; both branches default to jinaai/jina-embeddings-v2-base-zh)
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\prereq-check.ps1"

$BootstrapPython = Resolve-BootstrapPython
Assert-Python310 -Bootstrap $BootstrapPython
Assert-DiskSpace -RequiredGB 2
Assert-Network

$VenvDir = Join-Path $env:CAT_CAFE_HOME "embed-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating venv: $VenvDir ..."
    & $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) { throw "Failed to create embed venv" }
}

& $VenvPython -m pip install --progress-bar on -U pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip in embed-venv" }

$isArm64 = ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") -or
    ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64)

if ($isArm64) {
    Write-Host "  ARM64 detected - using fastembed/ONNX backend (no Rust compilation needed)"

    # Stub py_rust_stemmers before pip install -- fastembed's sparse retrieval
    # imports it, but dense embeddings don't use it. Stub prevents ImportError.
    $sitePackages = Join-Path $VenvDir "Lib\site-packages"
    $stubDir = Join-Path $sitePackages "py_rust_stemmers"
    $distInfo = Join-Path $sitePackages "py_rust_stemmers-0.1.0.dist-info"
    Write-Host "  Writing py-rust-stemmers stub ..."
    New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
    New-Item -ItemType Directory -Path $distInfo -Force | Out-Null
    Set-Content -Path (Join-Path $stubDir "__init__.py") -Value @"
class SnowballStemmer:
    def __init__(self, *a, **kw): pass
    def stem_word(self, w): return w
    def stem_words(self, ws): return list(ws)

Stemmer = SnowballStemmer
"@
    Set-Content -Path (Join-Path $distInfo "METADATA") -Value "Metadata-Version: 2.1`nName: py-rust-stemmers`nVersion: 0.1.0"
    Set-Content -Path (Join-Path $distInfo "INSTALLER") -Value "pip"
    Set-Content -Path (Join-Path $distInfo "RECORD") -Value ""

    Write-Host "  Installing dependencies: fastembed onnxruntime fastapi uvicorn numpy httpx[socks] huggingface_hub ..."
    $pipArgs = @('-m', 'pip', 'install', '--progress-bar', 'on',
        'fastembed', 'onnxruntime', 'fastapi', 'uvicorn', 'numpy', 'httpx[socks]', 'huggingface_hub[hf_xet]')
    if ($env:PIP_INDEX_URL) {
        $pipArgs += @('--extra-index-url', 'https://pypi.org/simple/')
    }
    & $VenvPython @pipArgs
    if ($LASTEXITCODE -ne 0) { throw "Failed to install embedding dependencies" }

    # fastembed has a strict model whitelist verified against
    # TextEmbedding.list_supported_models() in fastembed 0.8:
    #   jinaai/jina-embeddings-v2-base-zh - 768 dim, ~640MB, bilingual [OK]
    #   BAAI/bge-small-zh-v1.5            - 512 dim, ~90MB, Chinese-only [OK]
    #   intfloat/multilingual-e5-large    - 1024 dim, ~2.3GB [OK]
    # multilingual-e5-small/base are NOT in the fastembed catalog despite the
    # HuggingFace repos existing - fastembed only ships pre-converted ONNX.
    if (-not $env:EMBED_MODEL) {
        throw "ERROR: EMBED_MODEL not set. Trigger via the console install button (auto-picks per scripts/services/recommendation-matrix.yaml), or manually set `$env:EMBED_MODEL='<model-id>' before re-running."
    }
    $Model = $env:EMBED_MODEL
    Write-Host "  Pre-downloading ONNX model: $Model ..."
    Invoke-ModelDownloadWithRetry -VenvPython $VenvPython -ModelId $Model -Loader "fastembed"

} else {
    $hasCuda = $false
    try {
        $prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        $null = & nvidia-smi 2>$null
        if ($LASTEXITCODE -eq 0) { $hasCuda = $true }
        $ErrorActionPreference = $prevEAP
    } catch {}

    $torchIndex = if ($hasCuda) { "https://download.pytorch.org/whl/cu126" } else { "https://download.pytorch.org/whl/cpu" }
    $torchLabel = if ($hasCuda) { "CUDA" } else { "CPU" }
    Write-Host "  Installing PyTorch ($torchLabel) from $torchIndex ..."
    & $VenvPython -m pip install --progress-bar on torch --index-url $torchIndex
    if ($LASTEXITCODE -ne 0) { throw "Failed to install PyTorch" }

    Write-Host "  Installing dependencies: sentence-transformers fastapi uvicorn numpy httpx[socks] huggingface_hub ..."
    $pipArgs = @('-m', 'pip', 'install', '--progress-bar', 'on',
        'sentence-transformers', 'fastapi', 'uvicorn', 'numpy', 'httpx[socks]', 'huggingface_hub[hf_xet]')
    if ($env:PIP_INDEX_URL) {
        $pipArgs += @('--extra-index-url', 'https://pypi.org/simple/')
    }
    & $VenvPython @pipArgs
    if ($LASTEXITCODE -ne 0) { throw "Failed to install embedding dependencies" }

    if (-not $env:EMBED_MODEL) {
        throw "ERROR: EMBED_MODEL not set. Trigger via the console install button (auto-picks per scripts/services/recommendation-matrix.yaml), or manually set `$env:EMBED_MODEL='<model-id>' before re-running."
    }
    $Model = $env:EMBED_MODEL
    Write-Host "  Pre-downloading model: $Model ..."
    Invoke-ModelDownloadWithRetry -VenvPython $VenvPython -ModelId $Model -Loader "snapshot"
}

Write-Host "Installation complete."
