<#
.SYNOPSIS
  Builds the Clowder AI Windows installer package.

.DESCRIPTION
  Full pipeline:
    1. Copy DARE source to vendor/dare-cli/
    2. Install & build the web application
    3. Build the Electron shell via electron-builder
    4. Compile Inno Setup installer → dist/ClowderAI-Setup-x.x.x.exe

.PARAMETER DarePath
  Path to the DARE source directory to bundle.

.PARAMETER SkipWebBuild
  Skip pnpm install/build (use existing build artifacts).

.EXAMPLE
  .\scripts\build-desktop.ps1 -DarePath C:\src\dare-cli
#>

param(
    [Parameter(Mandatory)] [string]$DarePath,
    [switch]$SkipWebBuild
)

$ErrorActionPreference = "Stop"

function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Err   { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

# Step 1: Copy DARE source
Write-Step "Step 1/4 - Copy DARE source to vendor/dare-cli/"
$vendorDir = Join-Path $ProjectRoot "vendor" "dare-cli"
if (Test-Path $vendorDir) { Remove-Item -Recurse -Force $vendorDir }
New-Item -ItemType Directory -Path $vendorDir -Force | Out-Null

if (-not (Test-Path $DarePath)) {
    Write-Err "DARE source not found at: $DarePath"
    exit 1
}

# Copy excluding .git, __pycache__, .venv
$exclude = @('.git', '__pycache__', '.venv', 'node_modules')
Get-ChildItem -Path $DarePath -Exclude $exclude | Copy-Item -Destination $vendorDir -Recurse -Force
Write-Ok "DARE source copied"

# Step 2: Build web app
Write-Step "Step 2/4 - Build web application"
if (-not $SkipWebBuild) {
    Push-Location $ProjectRoot
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { pnpm install }
    pnpm run build
    if ($LASTEXITCODE -ne 0) { Write-Err "Build failed"; exit 1 }
    Pop-Location
    Write-Ok "Web application built"
} else {
    Write-Ok "Skipped (existing artifacts)"
}

# Step 3: Build Electron app
Write-Step "Step 3/4 - Build Electron shell"
$desktopDir = Join-Path $ProjectRoot "desktop"
Push-Location $desktopDir
npm install
if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed in desktop/"; exit 1 }
npx electron-builder --win --dir
if ($LASTEXITCODE -ne 0) { Write-Err "electron-builder failed"; exit 1 }
Pop-Location

$electronOutput = Join-Path $desktopDir "dist" "win-unpacked"
$desktopDist = Join-Path $ProjectRoot "desktop-dist"
if (Test-Path $desktopDist) { Remove-Item -Recurse -Force $desktopDist }
Copy-Item -Path $electronOutput -Destination $desktopDist -Recurse
Write-Ok "Electron app built -> desktop-dist/"

# Step 4: Compile Inno Setup installer
Write-Step "Step 4/4 - Compile installer"
$issFile = Join-Path $ProjectRoot "installer" "clowder-ai.iss"
$distDir = Join-Path $ProjectRoot "dist"
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }

$iscc = "iscc.exe"
$programFilesIscc = Join-Path $env:ProgramFiles "Inno Setup 6" "ISCC.exe"
if (Test-Path $programFilesIscc) { $iscc = $programFilesIscc }

& $iscc $issFile
if ($LASTEXITCODE -ne 0) { Write-Err "Inno Setup compilation failed"; exit 1 }
Write-Ok "Installer built"

$outputExe = Get-ChildItem -Path $distDir -Filter "ClowderAI-Setup-*.exe" | Select-Object -First 1
Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "  Installer ready!" -ForegroundColor Green
Write-Host "  $($outputExe.FullName)" -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
