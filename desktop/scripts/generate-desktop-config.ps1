<#
.SYNOPSIS
  Generates desktop-config.json based on installer component selection.
.PARAMETER AppDir
  Root directory of the installed or portable application.
.PARAMETER Version
  Application version. When omitted, resolve it from desktop/package.json,
  then the repository-root package.json.
.PARAMETER InstallType
  Installation channel: installer, portable, or unknown.
#>

param(
    [Parameter(Mandatory)] [string]$AppDir,
    [string]$Version,
    [string]$InstallType = "unknown"
)

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
    version = $Version
    installType = $InstallType
    installedAt = (Get-Date -Format "o")
}

# Only write installType if explicitly provided (fail-safe: missing = no auto-install)
if ($InstallType -ne "") {
    $config.installType = $InstallType
}

$configPath = Join-Path $AppDir ".cat-cafe\desktop-config.json"
$configDir = Split-Path -Parent $configPath
if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}

$json = $config | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Desktop config written to $configPath"
