<#
.SYNOPSIS
  Remove Audio Capture service virtual environment on Windows.
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $env:CAT_CAFE_HOME) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $env:CAT_CAFE_HOME = Join-Path $repoRoot '.cat-cafe'
}

$VenvDir = Join-Path $env:CAT_CAFE_HOME "audio-capture-venv"
$VenvDirLegacy = Join-Path $HOME ".cat-cafe\audio-capture-venv"

function Remove-VenvDir {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $false }
    Get-Process python* -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like "$Path*" } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Write-Host "Removing venv: $Path ..."
    Remove-Item -Recurse -Force $Path -ErrorAction SilentlyContinue
    if (Test-Path $Path) {
        Start-Sleep -Seconds 2
        cmd /c "rmdir /s /q `"$Path`""
        if (Test-Path $Path) { throw "Failed to remove $Path -- files locked by another process" }
    }
    return $true
}

$removed = $false
if (Remove-VenvDir -Path $VenvDir) { $removed = $true }
if ($VenvDirLegacy -ne $VenvDir -and (Remove-VenvDir -Path $VenvDirLegacy)) {
    Write-Host "(legacy path cleaned: $VenvDirLegacy)"
    $removed = $true
}
if (-not $removed) {
    Write-Host "Venv not found: $VenvDir (legacy: $VenvDirLegacy)"
    exit 0
}
Write-Host "Uninstall complete."
