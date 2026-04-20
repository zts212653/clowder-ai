<#
.SYNOPSIS
  Start local embedding server for Cat Cafe on Windows.

.DESCRIPTION
  Creates/uses ~/.cat-cafe/embed-venv, installs sentence-transformers + torch
  deps when missing, then launches scripts/embed-api.py on the requested port.

  Supported env vars passed through to embed-api.py:
  - EMBED_PORT  (default 9880; overridden by -Port)
  - EMBED_MODEL (model ID)
  - EMBED_DIM   (MRL-truncated output dimension)

.PARAMETER Port
  Loopback port for the local embedding HTTP sidecar.
#>

param(
    [int]$Port = 9880
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Resolve-BootstrapPython {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        return [pscustomobject]@{
            Path = $py.Source
            PrefixArgs = @('-3')
        }
    }

    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        return [pscustomobject]@{
            Path = $python.Source
            PrefixArgs = @()
        }
    }

    throw "Python 3 not found. Install Python 3 first."
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VenvDir = Join-Path $HOME ".cat-cafe\embed-venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$ApiScript = Join-Path $PSScriptRoot "embed-api.py"
$BootstrapPython = Resolve-BootstrapPython

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating venv: $VenvDir ..."
    & $BootstrapPython.Path @($BootstrapPython.PrefixArgs + @('-m', 'venv', $VenvDir))
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create embedding venv"
    }
}

& $VenvPython -m pip install --quiet -U pip
if ($LASTEXITCODE -ne 0) {
    throw "Failed to upgrade pip in embed-venv"
}

& $VenvPython -c "import fastapi, uvicorn, numpy, sentence_transformers" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  Installing dependencies: sentence-transformers + torch ..."
    & $VenvPython -m pip install --quiet sentence-transformers torch fastapi uvicorn numpy
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install embedding dependencies"
    }
}

Write-Host "Starting Embedding server: port=$Port"
& $VenvPython $ApiScript --port $Port
