<#
.SYNOPSIS
  Builds the Clowder AI Windows installer package.

.DESCRIPTION
  Full pipeline:
    1. Install & build the web application
    2. pnpm deploy per runtime package (api, web) -> bundled/deploy/{api,web}/
       with flat hoisted node_modules (real files, no junctions)
    3. Bundle Redis portable for offline install
    4. Build the Electron shell (via desktop/ npm install + electron-builder)
    5. Compile Inno Setup installer -> dist/ClowderAI-Setup-x.x.x.exe

  Why pnpm deploy (not tar of root node_modules): pnpm on Windows uses
  junctions, which require absolute paths. A tarball of node_modules bakes in
  the build-machine absolute paths and every junction is broken after install.
  `pnpm deploy --config.node-linker=hoisted` produces a self-contained, flat
  node_modules with real files that is portable across machines.

.PARAMETER SkipWebBuild
  Skip pnpm install/build (use existing build artifacts).

.PARAMETER SkipBundleDeps
  Skip pnpm deploy step (use existing bundled/deploy/).

.PARAMETER SkipElectronBuild
  Skip electron-builder (use existing desktop-dist/). Use desktop/package-lock.json

.PARAMETER SkipInstaller
  Skip Inno Setup compilation.

.EXAMPLE
  .\desktop\scripts\build-desktop.ps1
#>

param(
    [switch]$SkipWebBuild,
    [switch]$SkipBundleDeps,
    [switch]$SkipElectronBuild,
    [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"

function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

$ProjectRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))

# Step 1: Build web app
Write-Step "Step 1/5 - Build web application"
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

# Step 2: pnpm deploy per runtime package (flat, self-contained node_modules)
# Produces bundled/deploy/{api,web}/ with real files — no junctions, no workspace
# references. Replaces the old "tar root node_modules" approach, which baked in
# build-machine absolute paths via Windows junctions and broke on install.
Write-Step "Step 2/5 - pnpm deploy runtime packages"
$bundledDir = Join-Path $ProjectRoot "bundled"
$deployRoot = Join-Path $bundledDir "deploy"
if (-not $SkipBundleDeps) {
    if (-not (Test-Path $bundledDir)) {
        New-Item -ItemType Directory -Path $bundledDir -Force | Out-Null
    }
    if (Test-Path $deployRoot) { Remove-Item $deployRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $deployRoot -Force | Out-Null

    Push-Location $ProjectRoot
    foreach ($pkg in @('api', 'web', 'mcp-server')) {
        Write-Host "  Deploying @cat-cafe/$pkg ..." -ForegroundColor Gray
        $out = Join-Path $deployRoot $pkg
        pnpm --filter "@cat-cafe/$pkg" --prod --config.node-linker=hoisted deploy $out
        if ($LASTEXITCODE -ne 0) { Write-Err "pnpm deploy @cat-cafe/$pkg failed"; Pop-Location; exit 1 }
    }
    Pop-Location

    # Web's pre-built .next artifact is not copied by `pnpm deploy` (it's outside
    # the package `files` field), so inject it explicitly.
    $webNextSrc = Join-Path $ProjectRoot "packages\web\.next"
    $webNextDst = Join-Path $deployRoot "web\.next"
    if (Test-Path $webNextSrc) {
        if (Test-Path $webNextDst) { Remove-Item $webNextDst -Recurse -Force }
        Copy-Item $webNextSrc $webNextDst -Recurse
        Write-Ok "Copied packages/web/.next -> bundled/deploy/web/.next"
    } else {
        Write-Err "packages/web/.next not found — did 'pnpm run build' run?"
        exit 1
    }

    Write-Ok "Deploy artifacts ready under bundled/deploy/"
} else {
    if (-not (Test-Path $deployRoot)) {
        Write-Err "bundled/deploy/ missing. Run without -SkipBundleDeps first."
        exit 1
    }
    Write-Ok "Skipped (-SkipBundleDeps)"
}

# Step 3: Bundle Redis portable + Node.js runtime
Write-Step "Step 3/5 - Bundle Redis portable + Node.js"

# Node.js portable — without this, clean Windows installs with no system Node
# cannot spawn the API/Web processes.
$bundledNode = Join-Path (Join-Path $ProjectRoot "bundled") "node"
if (Test-Path (Join-Path $bundledNode "node.exe")) {
    Write-Ok "Node.js portable already present"
} else {
    New-Item -ItemType Directory -Path $bundledNode -Force | Out-Null
    $nodeVersion = "v20.18.1"
    $nodeArchive = "node-$nodeVersion-win-x64"
    $nodeZipUrl = "https://nodejs.org/dist/$nodeVersion/$nodeArchive.zip"
    Write-Host "  Downloading $nodeArchive ..."
    try {
        $zipPath = Join-Path $bundledNode "node.zip"
        Invoke-WebRequest -Uri $nodeZipUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 180
        $extractDir = Join-Path $bundledNode "_extract"
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
        $innerDir = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
        if ($innerDir) {
            Get-ChildItem -Path $innerDir.FullName | Move-Item -Destination $bundledNode -Force
        }
        Remove-Item $extractDir -Recurse -Force
        Remove-Item $zipPath -Force
        Write-Ok "Node.js portable bundled ($nodeArchive)"
    } catch {
        Write-Warn "Node.js download failed — installer will require system Node.js at runtime"
    }
}

$bundledRedis = Join-Path (Join-Path $ProjectRoot "bundled") "redis"
if (Test-Path (Join-Path $bundledRedis "redis-server.exe")) {
    Write-Ok "Redis portable already present"
} else {
    New-Item -ItemType Directory -Path $bundledRedis -Force | Out-Null
    Write-Host "  Downloading Redis for Windows..."
    $headers = @{ "User-Agent" = "ClowderAI-Build" }
    $releaseApi = "https://api.github.com/repos/redis-windows/redis-windows/releases/latest"
    try {
        $release = Invoke-RestMethod -Uri $releaseApi -Headers $headers -TimeoutSec 30
        $asset = $release.assets | Where-Object { $_.name -match "^Redis-.*-Windows-x64-msys2\.zip$" } | Select-Object -First 1
        if (-not $asset) { Write-Err "No Redis Windows asset found"; exit 1 }
        $zipPath = Join-Path $bundledRedis "redis-windows.zip"
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -Headers $headers -UseBasicParsing -TimeoutSec 120
        $extractDir = Join-Path $bundledRedis "_extract"
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
        $innerDir = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
        if ($innerDir) {
            Get-ChildItem -Path $innerDir.FullName | Move-Item -Destination $bundledRedis -Force
        }
        Remove-Item $extractDir -Recurse -Force
        Remove-Item $zipPath -Force
        Write-Ok "Redis portable bundled ($($asset.name))"
    } catch {
        Write-Warn "Redis download failed — trying local copy from fork..."
        $forkRedis = "D:\code\clowder-ai-my\bundled\redis"
        if (Test-Path $forkRedis) {
            Copy-Item "$forkRedis\*" $bundledRedis -Recurse -Force
            Write-Ok "Redis copied from fork"
        } else {
            Write-Warn "No local Redis copy available"
        }
    }
}

# Step 4: Build Electron app
Write-Step "Step 4/5 - Build Electron shell"
$desktopDir = Join-Path $ProjectRoot "desktop"
$desktopDist = Join-Path $ProjectRoot "desktop-dist"

if (-not $SkipElectronBuild) {
    Push-Location $desktopDir
    if (-not (Test-Path (Join-Path $desktopDir "node_modules"))) {
        Write-Host "  Installing desktop dependencies..."
        npm install
        if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed in desktop/"; exit 1 }
    }
    npx electron-builder --win --dir
    if ($LASTEXITCODE -ne 0) { Write-Err "electron-builder failed"; exit 1 }
    Pop-Location

    $electronOutput = Join-Path (Join-Path $desktopDir "dist") "win-unpacked"
    if (Test-Path $desktopDist) { Remove-Item -Recurse -Force $desktopDist }
    New-Item -ItemType Directory -Path $desktopDist -Force | Out-Null
    Copy-Item -Path $electronOutput -Destination (Join-Path $desktopDist "win-unpacked") -Recurse
    Write-Ok "Electron app built -> desktop-dist/win-unpacked/"
} else {
    if (-not (Test-Path $desktopDist)) {
        Write-Err "desktop-dist/ not found. Run without -SkipElectronBuild first."
        exit 1
    }
    Write-Ok "Electron build skipped (using existing desktop-dist/)"
}

# Step 5: Compile Inno Setup installer
Write-Step "Step 5/5 - Compile installer"
if (-not $SkipInstaller) {
    $issFile = Join-Path (Join-Path (Join-Path $ProjectRoot "desktop") "installer") "clowder-ai.iss"
    $distDir = Join-Path $ProjectRoot "dist"
    if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }

    $iscc = "iscc.exe"
    $candidates = @(
        (Join-Path (Join-Path $env:ProgramFiles "Inno Setup 6") "ISCC.exe"),
        (Join-Path (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6") "ISCC.exe"),
        (Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA "Programs") "Inno Setup 6") "ISCC.exe")
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { $iscc = $c; break }
    }

    & $iscc $issFile
    if ($LASTEXITCODE -ne 0) { Write-Err "Inno Setup compilation failed"; exit 1 }
    Write-Ok "Installer built"

    $outputExe = Get-ChildItem -Path $distDir -Filter "ClowderAI-Setup-*.exe" | Select-Object -First 1
    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  Installer ready!" -ForegroundColor Green
    Write-Host "  $($outputExe.FullName)" -ForegroundColor Green
    Write-Host "  Size: $([math]::Round($outputExe.Length/1MB, 2)) MB" -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green
} else {
    Write-Ok "Installer compilation skipped"
}
