<#
.SYNOPSIS
  Builds the Cat Cafe Windows installer package.

.DESCRIPTION
  Full pipeline:
    1. Install & build the web application
    2. pnpm deploy per runtime package (api, web) -> bundled/deploy/{api,web}/
       with flat hoisted node_modules (real files, no junctions)
    3. Bundle Redis portable for offline install
    4. Build the Electron shell (via desktop/ npm install + electron-builder)
    5. Compile Inno Setup installer -> dist/CatCafe-Setup-x.x.x.exe

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

    # pnpm deploy creates .bin/ shims on Windows that Defender can lock,
    # causing EPERM.  pnpm deploy also requires an empty target directory.
    # Retry with a delay lets Defender finish scanning before the next attempt.
    $defenderExclusionAdded = $false
    $deployFailed = $false

    try {
        Add-MpPreference -ExclusionPath $deployRoot -ErrorAction Stop
        $defenderExclusionAdded = $true
    } catch {
        Write-Host "  Defender exclusion skipped: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    try {
        Push-Location $ProjectRoot
        try {
            foreach ($pkg in @('api', 'web', 'mcp-server')) {
                $out = Join-Path $deployRoot $pkg
                $deployed = $false
                for ($attempt = 1; $attempt -le 3; $attempt++) {
                    if ($attempt -gt 1) {
                        Write-Host "  Retry $attempt/3 for @cat-cafe/$pkg ..." -ForegroundColor Yellow
                        Start-Sleep -Seconds 10
                    }
                    if (Test-Path $out) { Remove-Item $out -Recurse -Force }
                    Write-Host "  Deploying @cat-cafe/$pkg ..." -ForegroundColor Gray
                    pnpm --filter "@cat-cafe/$pkg" --prod --config.node-linker=hoisted deploy $out 2>&1
                    if ($LASTEXITCODE -eq 0) { $deployed = $true; break }
                }
                if (-not $deployed) { throw "pnpm deploy @cat-cafe/$pkg failed after 3 attempts" }
            }
        } finally {
            Pop-Location
        }
    } catch {
        Write-Err $_.Exception.Message
        $deployFailed = $true
    } finally {
        if ($defenderExclusionAdded) {
            try { Remove-MpPreference -ExclusionPath $deployRoot -ErrorAction SilentlyContinue } catch {}
        }
    }

    if ($deployFailed) { exit 1 }

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
# cannot spawn the API/Web processes. CRITICAL: the bundled Node major version
# must match the build-machine Node major version, otherwise native modules
# (better-sqlite3) compiled during `pnpm install` fail with an ABI mismatch
# (NODE_MODULE_VERSION) at runtime.
$bundledNode = Join-Path (Join-Path $ProjectRoot "bundled") "node"

# Detect build-machine Node version so the bundled runtime matches the ABI
# that native modules were compiled against.
$buildNodeVersion = $null
try {
    $buildNodeVersion = (node --version 2>$null).Trim()
} catch {}
if (-not $buildNodeVersion) {
    Write-Warn "Could not detect build-machine Node version; defaulting to v22.12.0"
    $buildNodeVersion = "v22.12.0"
}
$buildNodeMajor = $buildNodeVersion.TrimStart('v').Split('.')[0]

# Reuse an already-bundled Node only if its major matches the build machine.
$reuseBundled = $false
$existingNode = Join-Path $bundledNode "node.exe"
if (Test-Path $existingNode) {
    try {
        $existingVersion = (& $existingNode --version 2>$null).Trim()
        $existingMajor = $existingVersion.TrimStart('v').Split('.')[0]
        if ($existingMajor -eq $buildNodeMajor) {
            Write-Ok "Node.js portable already present (matches build Node $buildNodeVersion)"
            $reuseBundled = $true
        } else {
            Write-Warn "Bundled Node $existingVersion does not match build $buildNodeVersion; re-downloading"
            Remove-Item $bundledNode -Recurse -Force
        }
    } catch {
        Remove-Item $bundledNode -Recurse -Force
    }
}

if (-not $reuseBundled) {
    New-Item -ItemType Directory -Path $bundledNode -Force | Out-Null
    $nodeVersion = $buildNodeVersion
    $nodeArchive = "node-$nodeVersion-win-x64"
    $nodeZipUrl = "https://nodejs.org/dist/$nodeVersion/$nodeArchive.zip"
    Write-Host "  Downloading $nodeArchive (matches build-machine ABI) ..."
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
        # Verify critical executables actually landed (guards against empty/corrupt archives)
        $nodeExe = Join-Path $bundledNode "node.exe"
        $npmCmd = Join-Path $bundledNode "npm.cmd"
        if (-not (Test-Path $nodeExe) -or -not (Test-Path $npmCmd)) {
            Write-Err "Node extraction succeeded but node.exe or npm.cmd missing in $bundledNode"
            exit 1
        }
        Write-Ok "Node.js portable bundled ($nodeArchive)"
    } catch {
        Write-Err "Node.js download failed: $_"
        Write-Err "Bundled Node is required for clean-machine installs. Build aborted."
        exit 1
    }
}

$bundledRedis = Join-Path (Join-Path $ProjectRoot "bundled") "redis"
if (Test-Path (Join-Path $bundledRedis "redis-server.exe")) {
    Write-Ok "Redis portable already present"
} else {
    New-Item -ItemType Directory -Path $bundledRedis -Force | Out-Null
    Write-Host "  Downloading Redis for Windows..."
    $headers = @{ "User-Agent" = "CatCafe-Build" }
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
        Write-Warn "Redis download failed — installer will use memory store or system Redis"
    }
}

# Step 4: Bundle CLI tool tarballs for offline installation
Write-Step "Step 4/6 - Bundle CLI tool tarballs"

$cliToolsDir = Join-Path $bundledDir "cli-tools"
if (-not (Test-Path $cliToolsDir)) {
    New-Item -ItemType Directory -Path $cliToolsDir -Force | Out-Null
}

# Use bundled npm (guaranteed present after Step 3) to pack CLI tarballs.
$npmCmd = Join-Path $bundledNode "npm.cmd"
if (-not (Test-Path $npmCmd)) {
    Write-Err "Bundled npm.cmd not found at $npmCmd — cannot pack CLI tools"
    exit 1
}

$cliPackages = @(
    @{ Name = "claude"; Pkg = "@anthropic-ai/claude-code" },
    @{ Name = "codex";  Pkg = "@openai/codex" },
    @{ Name = "gemini"; Pkg = "@google/gemini-cli" }
)

$cliAllPacked = $true
foreach ($cli in $cliPackages) {
    # Reuse existing tarball if already present (idempotent rebuilds)
    $existing = Get-ChildItem -Path $cliToolsDir -Filter "*.tgz" -ErrorAction SilentlyContinue `
        | Where-Object { $_.Name -like "*$($cli.Name)*" } | Select-Object -First 1
    if ($existing) {
        Write-Ok "$($cli.Name) tarball already present: $($existing.Name)"
        continue
    }
    Write-Host "  Packing $($cli.Pkg) ..." -ForegroundColor Gray
    try {
        Push-Location $cliToolsDir
        & $npmCmd pack $($cli.Pkg) 2>&1 | Out-Null
        $packExit = $LASTEXITCODE
        Pop-Location
        if ($packExit -eq 0) {
            $packed = Get-ChildItem -Path $cliToolsDir -Filter "*.tgz" -ErrorAction SilentlyContinue `
                | Where-Object { $_.Name -like "*$($cli.Name)*" } | Select-Object -First 1
            if ($packed) {
                Write-Ok "$($cli.Name) tarball packed: $($packed.Name)"
            } else {
                Write-Err "$($cli.Name) npm pack succeeded but tarball not found"
                $cliAllPacked = $false
            }
        } else {
            Write-Err "$($cli.Name) npm pack failed (exit $packExit)"
            $cliAllPacked = $false
        }
    } catch {
        if ((Get-Location).Path -ne $ProjectRoot) { Pop-Location }
        Write-Err "$($cli.Name) tarball failed: $_"
        $cliAllPacked = $false
    }
}

if (-not $cliAllPacked) {
    Write-Err "Some CLI tarballs failed to pack. The installer requires all CLI tools."
    Write-Err "Ensure network access is available during build."
    exit 1
}
Write-Ok "All CLI tarballs ready under bundled/cli-tools/"

# Step 5: Build Electron app
Write-Step "Step 5/6 - Build Electron shell"
$desktopDir = Join-Path $ProjectRoot "desktop"
$desktopDist = Join-Path $ProjectRoot "desktop-dist"

if (-not $SkipElectronBuild) {
    Push-Location $desktopDir
    if (-not (Test-Path (Join-Path $desktopDir "node_modules"))) {
        Write-Host "  Installing desktop dependencies..."
    npm install --include=dev
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

    # Sanity check: Windows build output must not carry darwin-only resources
    # (extraResources is split — mac node/redis live under mac.extraResources).
    # Failing fast here surfaces config drift instead of producing an installer
    # that crashes at first launch on user machines.
    #
    # Regex covers two leak shapes (separator-agnostic, works on Windows paths):
    #   1. source folder names: bundled/node-darwin-x64, bundled/redis-darwin-arm64
    #      → matches via 'node-darwin' / 'redis-darwin'
    #   2. packaged destination paths: resources\.cat-cafe\redis\darwin-x64\...
    #      → matches via 'darwin-[a-z0-9]+' (e.g. darwin-arm64, darwin-x64)
    # Substring match avoids slash-direction issues — Windows FullName uses '\',
    # the patterns above contain no separators so they hit either way.
    $winResources = Join-Path (Join-Path $desktopDist "win-unpacked") "resources"
    if (Test-Path $winResources) {
        $darwinLeak = Get-ChildItem -Path $winResources -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
            $_.FullName -match 'node-darwin|redis-darwin|darwin-[a-z0-9]+'
        }
        if ($darwinLeak) {
            Write-Err "Windows build leaked darwin resources (config drift):"
            $darwinLeak | ForEach-Object { Write-Err "  $($_.FullName)" }
            exit 1
        }
        Write-Ok "Windows build resources clean (no darwin leak)"
    }
} else {
    if (-not (Test-Path $desktopDist)) {
        Write-Err "desktop-dist/ not found. Run without -SkipElectronBuild first."
        exit 1
    }
    Write-Ok "Electron build skipped (using existing desktop-dist/)"
}

# Step 6: Compile Inno Setup installer
Write-Step "Step 6/6 - Compile installer"
if (-not $SkipInstaller) {
    $issFile = Join-Path (Join-Path (Join-Path $ProjectRoot "desktop") "installer") "cat-cafe.iss"
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

    # Read version from desktop/package.json so .iss MyAppVersion stays in sync
    # with electron-builder. Override available via env CATCAFE_VERSION (CI sets
    # this from the release tag, e.g. v0.9.1 -> 0.9.1).
    $desktopPkg = Join-Path (Join-Path $ProjectRoot "desktop") "package.json"
    $pkgJson = Get-Content $desktopPkg -Raw | ConvertFrom-Json
    $catCafeVersion = if ($env:CATCAFE_VERSION) { $env:CATCAFE_VERSION } else { $pkgJson.version }
    Write-Host "  Inno Setup MyAppVersion = $catCafeVersion" -ForegroundColor Cyan

    $isccDir = Split-Path $iscc -Parent
    $zhIsl = Join-Path $isccDir "Languages\ChineseSimplified.isl"
    if (-not (Test-Path $zhIsl)) {
        $unofficial = Join-Path $isccDir "Languages\Unofficial\ChineseSimplified.isl"
        if (Test-Path $unofficial) {
            Copy-Item $unofficial $zhIsl
        } else {
            $url = "https://raw.githubusercontent.com/jrsoftware/issrc/main/Files/Languages/Unofficial/ChineseSimplified.isl"
            Invoke-WebRequest -Uri $url -OutFile $zhIsl -ErrorAction Stop
        }
        Write-Host "  Installed ChineseSimplified.isl" -ForegroundColor Gray
    }

    & $iscc "/DMyAppVersion=$catCafeVersion" $issFile
    if ($LASTEXITCODE -ne 0) { Write-Err "Inno Setup compilation failed"; exit 1 }
    Write-Ok "Installer built"

    $outputExe = Get-ChildItem -Path $distDir -Filter "CatCafe-Setup-*.exe" | Select-Object -First 1
    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  Installer ready!" -ForegroundColor Green
    Write-Host "  $($outputExe.FullName)" -ForegroundColor Green
    Write-Host "  Size: $([math]::Round($outputExe.Length/1MB, 2)) MB" -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green
} else {
    Write-Ok "Installer compilation skipped"
}
