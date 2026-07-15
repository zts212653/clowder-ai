<#
.SYNOPSIS
  Generates desktop-config.json based on installer component selection.
.PARAMETER AppDir
  Root directory of the installed/portable application.
.PARAMETER Version
  Application version string. When omitted, the script reads it from
  $AppDir\package.json (the monorepo root package.json shipped by the installer).
.PARAMETER InstallType
  How the app was installed: 'installer' (Inno Setup) or 'portable' (zip extract).
  Defaults to 'unknown' if not provided.
#>

param(
    [Parameter(Mandatory)] [string]$AppDir,
    [string]$Version,
    [string]$InstallType = "unknown"
)

# Resolve version from package.json when caller does not pass -Version.
# Prefer desktop/package.json (the real desktop app version) over the monorepo
# root package.json, which carries a different (workspace-root) version number.
if (-not $Version) {
    $desktopPkgPath = Join-Path $AppDir "desktop\package.json"
    $rootPkgPath = Join-Path $AppDir "package.json"
    $pkgPath = if (Test-Path $desktopPkgPath) { $desktopPkgPath } else { $rootPkgPath }
    if (Test-Path $pkgPath) {
        try {
            $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
            $Version = $pkg.version
        } catch {
            Write-Warning "Could not read version from $pkgPath -- using 'unknown'"
        }
    }
    if (-not $Version) { $Version = "unknown" }
}

$config = @{
    version     = $Version
    installType = $InstallType
    installedAt = (Get-Date -Format "o")
}

$configPath = Join-Path $AppDir ".cat-cafe\desktop-config.json"
$configDir = Split-Path -Parent $configPath
if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}

# Write UTF-8 without BOM. Windows PowerShell 5.1's -Encoding utf8
# emits a BOM (ef bb bf) that breaks JSON.parse in Node.js consumers.
$json = $config | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Desktop config written to $configPath"
