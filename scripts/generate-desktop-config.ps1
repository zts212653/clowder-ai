<#
.SYNOPSIS
  Generates desktop-config.json based on which CLI tools are installed.
  Called by the Inno Setup installer after component selection.

.DESCRIPTION
  Writes a JSON config that tells the Electron app and web frontend
  which cat families to show/hide based on installed CLI tools.
#>

param(
    [Parameter(Mandatory)] [string]$AppDir,
    [bool]$Claude  = $false,
    [bool]$Codex   = $false,
    [bool]$Gemini  = $false,
    [bool]$OpenCode = $false
)

$ErrorActionPreference = "Stop"

# DARE is always enabled in desktop mode (source is bundled)
$config = @{
    version = 1
    desktopMode = $true
    installedClis = @{
        claude   = $Claude
        codex    = $Codex
        gemini   = $Gemini
        opencode = $OpenCode
        dare     = $true
    }
    # Map CLI names to breed families that depend on them
    cliFamilyMap = @{
        claude   = @("ragdoll")
        codex    = @("maine-coon")
        gemini   = @("siamese")
        opencode = @("golden-chinchilla")
        dare     = @("dragon-li")
    }
    # Breeds to always hide (e.g. bengal/antigravity requires special infra)
    alwaysHidden = @("bengal")
}

$configPath = Join-Path $AppDir ".cat-cafe" "desktop-config.json"
$catCafeDir = Join-Path $AppDir ".cat-cafe"
if (-not (Test-Path $catCafeDir)) {
    New-Item -ItemType Directory -Path $catCafeDir -Force | Out-Null
}

$config | ConvertTo-Json -Depth 4 | Out-File -FilePath $configPath -Encoding utf8
Write-Host "[OK] desktop-config.json written to $configPath"
