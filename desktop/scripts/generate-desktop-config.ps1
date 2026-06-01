<#
.SYNOPSIS
  Generates desktop-config.json based on installer component selection.
#>

param(
    [Parameter(Mandatory)] [string]$AppDir
)

$config = @{
    version = "0.10.1"
    installedAt = (Get-Date -Format "o")
}

$configPath = Join-Path $AppDir ".cat-cafe\desktop-config.json"
$configDir = Split-Path -Parent $configPath
if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}

$config | ConvertTo-Json -Depth 3 | Out-File -FilePath $configPath -Encoding utf8
Write-Host "Desktop config written to $configPath"
