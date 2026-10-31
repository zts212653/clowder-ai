<#
.SYNOPSIS
  Remove LLM post-processing service virtual environment on Windows.
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Uninstall scripts are spawned by the API without sourcing
# python-resolve.ps1, so $env:CAT_CAFE_HOME may not be set. Mirror the
# resolver's default (caller env override -> <repoRoot>/.cat-cafe) so
# Join-Path doesn't receive $null.
if (-not $env:CAT_CAFE_HOME) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $env:CAT_CAFE_HOME = Join-Path $repoRoot '.cat-cafe'
}

$VenvDir = Join-Path $env:CAT_CAFE_HOME "llm-venv"
# Legacy path cleanup -- see embed-uninstall.ps1 for rationale.
$VenvDirLegacy = Join-Path $HOME ".cat-cafe\llm-venv"

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
