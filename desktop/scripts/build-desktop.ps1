<#
.SYNOPSIS
  Builds the Clowder AI Windows installer package.

.DESCRIPTION
  Full pipeline:
    1. Install & build the web application
    2. Frozen production install -> bundled/deploy/{api,web,mcp-server}/
       with flat hoisted node_modules (real files, no junctions)
    3. Bundle Redis portable for offline install
    4. Build the Electron shell (via desktop/ npm install + electron-builder)
    5. Compile Inno Setup installer -> dist/ClowderAI-Setup-x.x.x.exe

  Production dependencies use the source lock, including peer bindings.
  Workspace links are materialized as real files for portable installation.

.PARAMETER SkipWebBuild
  Skip pnpm install/build (use existing build artifacts).

.PARAMETER SkipBundleDeps
  Skip frozen runtime export (use existing bundled/deploy/).

.PARAMETER SkipElectronBuild
  Diagnostic-only: skip electron-builder and use unverified existing desktop-dist/.

.PARAMETER SkipInstaller
  Skip Inno Setup compilation.

.PARAMETER SkipPortableZip
  Skip portable zip assembly.

.PARAMETER NoManifest
  Skip writing dist/build-manifest.json for an explicitly diagnostic build.
  Release builds require a complete manifest and fail if it cannot be written.

.PARAMETER AllowDirtyInputs
  Allow a diagnostic build from a dirty checkout. The generated manifest keeps
  the dirty-input evidence, but this mode must not be used for a release EXE.

.EXAMPLE
  .\desktop\scripts\build-desktop.ps1
#>

param(
    [switch]$SkipWebBuild,
    [switch]$SkipBundleDeps,
    [switch]$SkipElectronBuild,
    [switch]$SkipInstaller,
    [switch]$SkipPortableZip,
    [switch]$NoManifest,
    [switch]$AllowDirtyInputs
)

$ErrorActionPreference = "Stop"

function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

$ProjectRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$integrityTool = Join-Path (Join-Path $ProjectRoot 'desktop') 'scripts\installer-integrity.mjs'
$script:SetupIntegrityLevel = $null
$script:BuildRootIntegrity = $null
$generatedSetupPath = $null
$generatedPortablePath = $null
if (-not $AllowDirtyInputs -and $SkipElectronBuild) {
    throw '-SkipElectronBuild has no verified shell source receipt. Rebuild Electron for a release; use -AllowDirtyInputs only for diagnostics.'
}
if (-not $AllowDirtyInputs -and $NoManifest) {
    throw '-NoManifest is diagnostic-only. A release requires its build manifest.'
}

# A restrictive mandatory integrity label on this build root is inherited by
# every produced file. A Low-labelled Setup runs at Low integrity and cannot
# create `%TEMP%\is-*.tmp` (error 5); an explicitly Medium-labelled Setup caps
# the process at Medium and the PrepareToInstall identity helper fails with
# Win32 1314. The release step below raises such labels to High, but warn early
# so the workspace cause is visible instead of looking like a code bug.
if (Test-Path -LiteralPath $integrityTool) {
    $rootIntegrityJson = (& node $integrityTool $ProjectRoot --check --json 2>$null | Out-String).Trim()
    if ($rootIntegrityJson) {
        try { $script:BuildRootIntegrity = ($rootIntegrityJson | ConvertFrom-Json).level } catch {}
    }
    if ($LASTEXITCODE -ne 0 -and $rootIntegrityJson) {
        Write-Warn "Build root carries a restrictive integrity label; produced installers inherit it and will be raised to High before release (fix the workspace label for clean provenance)."
    }
}

# A release package must be reproducible from the exact source revision. The
# installer copies these roots directly or packs them into the runtime archives;
# allowing local edits here makes sourceSha/Setup SHA evidence non-reproducible.
$releaseInputRoots = @(
    'docs', 'cat-cafe-skills', 'scripts', 'assets', 'guides',
    'packages', '.claude/hooks/user-level', '.claude/hooks/f24-compaction.mjs',
    'cat-template.json', 'pnpm-workspace.yaml', 'package.json', 'LICENSE',
    'bundled/archives', 'bundled/node', 'bundled/redis', 'bundled/cli-tools',
    'desktop'
)
$releaseInputStatus = @(git -C $ProjectRoot status --porcelain --untracked-files=all -- $releaseInputRoots 2>$null)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect release input status' }
if ($releaseInputStatus.Count -gt 0 -and -not $AllowDirtyInputs) {
    throw "Release packaging requires a clean checkout. Use -AllowDirtyInputs only for diagnostics.`n$($releaseInputStatus -join "`n")"
}
if ($releaseInputStatus.Count -gt 0) {
    Write-Warn 'Diagnostic build: release inputs are dirty; build-manifest.json will record them and the EXE is not releaseable.'
}
function Assert-WebBuildIdentity {
    param([string]$WebRoot)
    $expectedRevision = (git -C $ProjectRoot rev-parse HEAD).Trim()
    # Frozen Web keeps dependencies under the shared deploy tree; resolve the
    # validator's Next implementation from the already-built source workspace.
    # The artifact itself is still validated for its serialized config, BUILD_ID
    # and exact revision, and the final staged app is exercised at runtime.
    $resolver = Join-Path $ProjectRoot 'packages/web/package.json'
    & node (Join-Path $ProjectRoot 'desktop/scripts/verify-web-build.cjs') $WebRoot $expectedRevision $resolver
    if ($LASTEXITCODE -ne 0) { throw "Web runtime admission failed: $WebRoot. Rebuild; do not rewrite build stamps." }
}
function Assert-ApiDesktopBundle {
    param([string]$ApiRoot)
    $required = @(
        (Join-Path $ApiRoot 'dist/index.desktop.js'),
        (Join-Path $ApiRoot 'dist/agent-hooks/index.desktop.js'),
        (Join-Path $ApiRoot 'dist/.startup-read-ahead.json'),
        (Join-Path $ApiRoot 'dist/desktop-bundle.json')
    )
    foreach ($file in $required) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Desktop API bundle incomplete: missing $file. Run frozen-runtime-deploy without -SkipBundleDeps."
        }
        if ((Get-Item -LiteralPath $file).Length -le 0) {
            throw "Desktop API bundle incomplete: empty $file."
        }
    }
    $receipt = Get-Content -LiteralPath (Join-Path $ApiRoot 'dist/desktop-bundle.json') -Raw | ConvertFrom-Json
    if ($receipt.entry -ne 'dist/index.desktop.js' -or $receipt.agentHooks.entry -ne 'dist/agent-hooks/index.desktop.js') {
        throw "Desktop API bundle receipt does not name both optimized entries."
    }
    Write-Ok "Desktop API bundle complete (optimized entry + startup manifest + installer hooks)"
}

# Step 1: Build web app
Write-Step "Step 1/9 - Build web application"
if (-not $SkipWebBuild) {
    Push-Location $ProjectRoot
    $buildRevision = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $buildRevision -notmatch '^[a-f0-9]{40}$') { throw "Build requires a source revision" }
    $buildInputs = @('packages', 'scripts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json')
    if (git status --porcelain --untracked-files=all -- @buildInputs) { throw "Commit runtime source changes before building a release" }
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "Frozen dependency installation failed" }
    $previousDesktopWebBuild = $env:CAT_CAFE_DESKTOP_WEB_BUILD
    try {
        $env:CAT_CAFE_DESKTOP_WEB_BUILD = '1'
        # API's standalone build re-emits shared output; finish it before Web reads it.
        pnpm -r --workspace-concurrency=1 run build
        if ($LASTEXITCODE -ne 0) { Write-Err "Build failed"; exit 1 }
    } finally {
        if ($null -eq $previousDesktopWebBuild) {
            Remove-Item Env:CAT_CAFE_DESKTOP_WEB_BUILD -ErrorAction SilentlyContinue
        } else {
            $env:CAT_CAFE_DESKTOP_WEB_BUILD = $previousDesktopWebBuild
        }
    }
    $afterBuildInputs = @(git status --porcelain --untracked-files=all -- @buildInputs)
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect source after the build' }
    if ((git rev-parse HEAD).Trim() -ne $buildRevision -or $afterBuildInputs.Count -gt 0) {
        throw "Source changed during the build.`n$($afterBuildInputs -join "`n")"
    }
    $webRevision = (Get-Content -LiteralPath (Join-Path $ProjectRoot 'packages/web/.next/.build-commit') -Raw).Trim()
    if ($webRevision -ne $buildRevision) { throw "Web build identity does not match this source revision" }
    # The API's generic tsc build does not stamp itself. Only record its identity
    # after this complete, unchanged-source API/Web build has succeeded.
    [IO.File]::WriteAllText((Join-Path $ProjectRoot 'packages/api/dist/.build-commit'), "$buildRevision`n", [Text.UTF8Encoding]::new($false))
    Pop-Location
    Write-Ok "Web application built"
} else {
    Write-Ok "Skipped (existing artifacts)"
}
Assert-WebBuildIdentity (Join-Path $ProjectRoot 'packages/web')

# Step 2: ordinary frozen install, then materialize portable runtime trees.
# pnpm 9 hoisted deploy disables lockfile reads; do not use it for releases.
Write-Step "Step 2/9 - Frozen runtime packages"
$bundledDir = Join-Path $ProjectRoot "bundled"
$deployRoot = Join-Path $bundledDir "deploy"
if (-not $SkipBundleDeps) {
    New-Item -ItemType Directory -Path $bundledDir -Force | Out-Null
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
    $nextDeploy = Join-Path $bundledDir "deploy-$stamp"
    node (Join-Path $ProjectRoot "desktop/scripts/frozen-runtime-deploy.mjs") $ProjectRoot $nextDeploy
    if ($LASTEXITCODE -ne 0) { throw "Frozen runtime export failed" }
    if (Test-Path -LiteralPath $deployRoot) {
        Move-Item -LiteralPath $deployRoot -Destination (Join-Path $bundledDir "deploy-before-$stamp")
    }
    Move-Item -LiteralPath $nextDeploy -Destination $deployRoot
    # frozen-runtime-deploy stages .next and generated public/vendor from the same build.
    Write-Ok "Frozen runtime artifacts ready"
} elseif (-not (Test-Path -LiteralPath $deployRoot)) {
    throw "bundled/deploy missing. Run without -SkipBundleDeps first."
} else { Write-Ok "Skipped (-SkipBundleDeps)" }
Assert-WebBuildIdentity (Join-Path $deployRoot 'web')
Assert-ApiDesktopBundle (Join-Path $deployRoot 'api')

# Step 3: Bundle Redis portable + Node.js runtime
Write-Step "Step 3/9 - Bundle Redis portable + Node.js"

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
$redisBin = Join-Path $bundledRedis "redis-server.exe"
if (Test-Path $redisBin) {
    Write-Ok "Redis portable already present"
} else {
    New-Item -ItemType Directory -Path $bundledRedis -Force | Out-Null
    Write-Host "  Downloading Redis for Windows..."
    $headers = @{ "User-Agent" = "ClowderAI-Build" }
    # Use GITHUB_TOKEN when available (CI) to avoid API rate-limit (60 req/hr unauthenticated).
    if ($env:GITHUB_TOKEN) {
        $headers["Authorization"] = "Bearer $($env:GITHUB_TOKEN)"
    }
    $releaseApi = "https://api.github.com/repos/redis-windows/redis-windows/releases/latest"
    # P1-3: Retry up to 3 times, then fail-closed in CI (release builds must include Redis).
    $redisDownloaded = $false
    for ($redisAttempt = 1; $redisAttempt -le 3; $redisAttempt++) {
        if ($redisAttempt -gt 1) {
            Write-Host "  Retry $redisAttempt/3 for Redis download..." -ForegroundColor Yellow
            Start-Sleep -Seconds 5
        }
        try {
            $release = Invoke-RestMethod -Uri $releaseApi -Headers $headers -TimeoutSec 30
            $asset = $release.assets | Where-Object { $_.name -match "^Redis-.*-Windows-x64-msys2\.zip$" } | Select-Object -First 1
            if (-not $asset) { throw "No Redis Windows asset found in release" }
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
            $redisDownloaded = $true
            Write-Ok "Redis portable bundled ($($asset.name))"
            break
        } catch {
            Write-Warn "Redis download attempt $redisAttempt failed: $_"
        }
    }
    if (-not $redisDownloaded) {
        Write-Err "Redis download failed after 3 attempts — any publishable installer must include Redis"
        exit 1
    }
    # Verify redis-server.exe actually landed (guards against corrupt/empty archives)
    if ($redisDownloaded -and -not (Test-Path $redisBin)) {
        Write-Err "Redis extraction succeeded but redis-server.exe not found in $bundledRedis"
        exit 1
    }
}

# Step 4: Write CLI install guidance (CLIs are installed by users separately)
Write-Step "Step 4/9 - Write CLI install guidance"

$cliToolsDir = Join-Path $bundledDir "cli-tools"
if (-not (Test-Path $cliToolsDir)) {
    New-Item -ItemType Directory -Path $cliToolsDir -Force | Out-Null
}

$agyInstructionsPath = Join-Path $cliToolsDir "agy-install-instructions.txt"
@"
Antigravity CLI (agy) is a native binary, not an npm package.
Install it with the official bootstrapper:

  powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri https://antigravity.google/cli/install.cmd -OutFile `$env:TEMP\antigravity-cli-install.cmd; & `$env:TEMP\antigravity-cli-install.cmd"

Offline Clowder AI packages intentionally do not vendor agy until Google
publishes a redistributable native binary contract.
"@ | Set-Content -Path $agyInstructionsPath -Encoding ascii
Write-Ok "agy-install-instructions.txt written"

# CLI tarballs (npm pack @anthropic-ai/claude-code, @openai/codex) were
# removed — the installer/portable zip no longer provisions CLI tools.
# Users install CLIs separately; see README "AI CLI Tools" section.
Write-Ok "CLI tool provisioning removed — users install CLIs separately"

# Step 5: Build Electron app
Write-Step "Step 5/9 - Build Electron shell"
$desktopDir = Join-Path $ProjectRoot "desktop"
$desktopDist = Join-Path $ProjectRoot "desktop-dist"

if (-not $SkipElectronBuild) {
    Push-Location $desktopDir
    # node_modules may already exist but disagree with package-lock.json (for
    # example an Electron manually installed for diagnosis). electron-builder
    # packages whatever is installed, so a version drift would ship a shell that
    # does not match the lockfile and may need an unexpected download. Repair the
    # installed tree from the lock before packaging.
    $lockElectron = $null
    $lockPath = Join-Path $desktopDir "package-lock.json"
    if (Test-Path -LiteralPath $lockPath) {
        # package-lock v3 stores the project entry under the empty-string key,
        # which Windows PowerShell 5.1's ConvertFrom-Json cannot materialize.
        # Node is a build prerequisite, so ask it for the locked version.
        $lockElectron = (& node -e "const lock=require(process.argv[1]);process.stdout.write(((lock.packages||{})['']||{}).devDependencies?.electron||'')" $lockPath 2>$null)
        if ($LASTEXITCODE -ne 0) { $lockElectron = $null }
        if ($lockElectron) { $lockElectron = "$lockElectron".Trim() }
    }
    $installedElectronPath = Join-Path $desktopDir "node_modules/electron/package.json"
    # Matching Electron alone does not verify electron-builder, asar or their peers.
    # Install the complete locked tree on every build.
    npm ci --include=dev
    if ($LASTEXITCODE -ne 0) { Write-Err "npm ci failed in desktop/"; exit 1 }
    $installedElectron = (Get-Content -LiteralPath $installedElectronPath -Raw | ConvertFrom-Json).version
    if ($lockElectron -and $installedElectron -ne $lockElectron) {
        Write-Err "desktop Electron $installedElectron still does not match package-lock $lockElectron"
        exit 1
    }
    npx electron-builder --win --dir --config windows-builder.cjs
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
    if (Test-Path (Join-Path $winResources "packages")) { throw "Windows shell duplicated runtime packages" }
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

# Step 6: Archive bulky directories for fast Inno Setup extraction
# Inno Setup per-file extraction of 30K+ node_modules files triggers per-file
# NTFS metadata creation + Windows Defender real-time scan → 10+ min install.
# Shipping tar.gz archives and extracting post-install with Windows' built-in
# tar.exe reduces Inno Setup [Files] count from ~30K to ~100.
Write-Step "Step 6/9 - Archive for fast installer extraction"
$releaseRevision = (git -C $ProjectRoot rev-parse HEAD).Trim()
foreach ($stamp in @('api/dist/.build-commit', 'web/.next/.build-commit')) {
    $artifactRevision = (Get-Content -LiteralPath (Join-Path $deployRoot $stamp) -Raw).Trim()
    if ($artifactRevision -ne $releaseRevision) { throw "Stale release artifact: $stamp. Rebuild API and Web together." }
}
$archiveDir = Join-Path $bundledDir "archives"
if (Test-Path $archiveDir) { Remove-Item $archiveDir -Recurse -Force }
New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null

$archiveTargets = @(
    @{ Name = "deploy-dependencies"; Src = Join-Path $deployRoot "dependencies" },
    @{ Name = "deploy-api";        Src = Join-Path $deployRoot "api" },
    @{ Name = "deploy-web";        Src = Join-Path $deployRoot "web" },
    @{ Name = "deploy-mcp-server"; Src = Join-Path $deployRoot "mcp-server" },
    @{ Name = "electron";          Src = Join-Path $desktopDist "win-unpacked" },
    @{ Name = "node";              Src = Join-Path $bundledDir "node" }
)

# Only Node itself needs a system tar. Runtime archives use the same bundled npm
# tar implementation as installation and include integrity/progress manifests.
$archiveTar = (Get-Command tar.exe).Source
$archiveTarPrefix = @()
$systemTar = Join-Path $env:WINDIR 'System32/tar.exe'
$gitTar = Join-Path $env:ProgramFiles "Git/usr/bin/tar.exe"
if (Test-Path -LiteralPath $systemTar) {
    # Git's bundled tar can terminate with 0xC0000142 while archiving the
    # portable Node tree on Windows. Prefer the inbox bsdtar for deterministic
    # packaging; fall back to Git tar on older Windows images.
    $archiveTar = $systemTar
} elseif (Test-Path -LiteralPath $gitTar) {
    $archiveTar = $gitTar
    $archiveTarPrefix = @('--force-local')
}
Write-Host "  Archive tool: $archiveTar"

foreach ($t in $archiveTargets) {
    if (-not (Test-Path $t.Src)) {
        Write-Warn "$($t.Src) not found — skipping $($t.Name).tar.gz"
        continue
    }
    $archivePath = Join-Path $archiveDir "$($t.Name).tar.gz"
    if ($t.Name -ne 'node') {
        node (Join-Path $ProjectRoot 'desktop/scripts/create-runtime-archive.mjs') $t.Src $archivePath
        if ($LASTEXITCODE -ne 0) { throw "Runtime archive failed: $($t.Name)" }
        if ($t.Name -eq 'deploy-api') {
            $entries = @(& (Join-Path $env:SystemRoot 'System32/tar.exe') -tzf $archivePath)
            foreach ($requiredEntry in @('./dist/index.desktop.js', './dist/agent-hooks/index.desktop.js', './dist/.startup-read-ahead.json')) {
                if (-not ($entries -contains $requiredEntry) -and -not ($entries -contains $requiredEntry.TrimStart('./'))) {
                    throw "deploy-api archive missing required entry: $requiredEntry"
                }
            }
            Write-Ok "deploy-api archive contains optimized desktop entry and startup manifest"
        }
        continue
    }
    $oldErrorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $previousArchivePath = $env:PATH
        try {
            $env:PATH = "$(Split-Path -Parent $archiveTar);$env:PATH"
            $tarOutput = & $archiveTar @archiveTarPrefix -czf $archivePath -C $t.Src . 2>&1
        } finally { $env:PATH = $previousArchivePath }
        $tarExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $oldErrorPreference }
    $tarOutput | ForEach-Object { Write-Host $_ }
    if ($tarExit -ne 0) { throw "tar failed for $($t.Name), exit=$tarExit, source=$($t.Src)" }
    & (Join-Path $env:SystemRoot 'System32/tar.exe') -tzf $archivePath > $null
    if ($LASTEXITCODE -ne 0) {
        Write-Err "tar failed for $($t.Name)"
        exit 1
    }
    $sizeMB = [math]::Round((Get-Item $archivePath).Length / 1MB, 2)
    Write-Ok "$($t.Name).tar.gz ($sizeMB MB)"
}
& node (Join-Path $ProjectRoot 'desktop/scripts/verify-runtime-archives.mjs') $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw 'Runtime archive gate failed; no installer may be compiled.' }
Write-Ok "Archives ready under bundled/archives/"

# Step 7: Compile Inno Setup installer
Write-Step "Step 7/9 - Compile installer"
if (-not $SkipInstaller) {
    $issFile = Join-Path (Join-Path (Join-Path $ProjectRoot "desktop") "installer") "cat-cafe.iss"
    $distDir = Join-Path $ProjectRoot "dist"
    if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }

    $iscc = "iscc.exe"
    $candidates = @(
        (Join-Path (Join-Path $env:ProgramFiles "Inno Setup 7") "ISCC.exe"),
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
            $url = "https://raw.githubusercontent.com/jrsoftware/issrc/main/Files/Languages/ChineseSimplified.isl"
            Invoke-WebRequest -Uri $url -OutFile $zhIsl -ErrorAction Stop
        }
        Write-Host "  Installed ChineseSimplified.isl" -ForegroundColor Gray
    }

    & $iscc "/DMyAppVersion=$catCafeVersion" $issFile
    if ($LASTEXITCODE -ne 0) { Write-Err "Inno Setup compilation failed"; exit 1 }
    Write-Ok "Installer built"

    $outputExe = Get-Item -LiteralPath (Join-Path $distDir "ClowderAI-Setup-$catCafeVersion.exe") -ErrorAction Stop
    # The installer must be launchable from the delivered folder. A Low label
    # inherited from the build root makes Setup run at Low integrity (TEMP
    # creation fails with error 5); an explicit Medium label caps the elevated
    # process so the identity helper's Add-Type fails with Win32 1314. Raise a
    # restrictive label to High and fail the release build if it stays
    # unlaunchable.
    $integrityResult = (& node $integrityTool $outputExe.FullName --json 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Setup integrity normalization failed: $integrityResult"
        Write-Err "Delivered EXE would be capped below the elevated token (error 5 at %TEMP%\is-*.tmp, or Win32 1314 in the identity helper)."
        exit 1
    }
    $integrity = $integrityResult | ConvertFrom-Json
    $script:SetupIntegrityLevel = $integrity.after
    $generatedSetupPath = $outputExe.FullName
    if ($integrity.changed) {
        Write-Warn "Raised Setup integrity from $($integrity.before) to $($integrity.after) (restrictive label inherited from the build root)"
    } else {
        Write-Ok "Setup integrity: $($integrity.after)"
    }
    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  Installer ready!" -ForegroundColor Green
    Write-Host "  $($outputExe.FullName)" -ForegroundColor Green
    Write-Host "  Size: $([math]::Round($outputExe.Length/1MB, 2)) MB" -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green
} else {
    Write-Ok "Installer compilation skipped"
}

# Step 8: Assemble portable zip (no-install distribution)
Write-Step "Step 8/9 - Portable zip"
if (-not $SkipPortableZip) {
    $distDir = Join-Path $ProjectRoot "dist"
    if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }

    # Version: same source as Inno Setup step
    $desktopPkgPath = Join-Path (Join-Path $ProjectRoot "desktop") "package.json"
    $desktopPkgJson = Get-Content $desktopPkgPath -Raw | ConvertFrom-Json
    $zipVersion = if ($env:CATCAFE_VERSION) { $env:CATCAFE_VERSION } else { $desktopPkgJson.version }

    $stagingName = "ClowderAI-$zipVersion"
    $staging = Join-Path $distDir $stagingName
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    Write-Host "  Assembling portable layout ($zipVersion)..."

    # Helper: copy directory recursively, creating parent as needed
    function Copy-ToStaging {
        param([string]$Src, [string]$RelDst)
        $dst = Join-Path $staging $RelDst
        $dstParent = Split-Path $dst -Parent
        if (-not (Test-Path $dstParent)) { New-Item -ItemType Directory -Path $dstParent -Force | Out-Null }
        if (Test-Path $Src) {
            Copy-Item -Path $Src -Destination $dst -Recurse -Force
        } else {
            Write-Warn "Source not found: $Src"
        }
    }

    # Mirror the Inno Setup [Files] layout (see desktop/installer/cat-cafe.iss)
    # Deploy artifacts
    Copy-ToStaging (Join-Path $deployRoot "api")         "packages\api"
    Copy-ToStaging (Join-Path $deployRoot "web")         "packages\web"
    Copy-ToStaging (Join-Path $deployRoot "mcp-server")  "packages\mcp-server"
    Copy-ToStaging (Join-Path $deployRoot "dependencies") "node_modules"

    # Root config files
    foreach ($f in @("cat-template.json", "pnpm-workspace.yaml", "package.json")) {
        $src = Join-Path $ProjectRoot $f
        if (Test-Path $src) { Copy-Item $src (Join-Path $staging $f) }
    }

    # Skills
    Copy-ToStaging (Join-Path $ProjectRoot "cat-cafe-skills") "cat-cafe-skills"
    # Windows checkouts materialize the Git symlink
    # cat-cafe-skills/.cat-cafe-shared-refs as a four-byte "refs" file.  The
    # portable layout must contain a real alias directory so relative skill
    # references survive extraction and upgrades on Windows.
    $stagedSkills = Join-Path $staging "cat-cafe-skills"
    $stagedSharedRefs = Join-Path $stagedSkills ".cat-cafe-shared-refs"
    $stagedMarker = $stagedSharedRefs
    if (Test-Path -LiteralPath $stagedMarker -PathType Leaf) { Remove-Item -LiteralPath $stagedMarker -Force }
    $stagedRefs = Join-Path $stagedSkills "refs"
    if (Test-Path -LiteralPath $stagedRefs) {
        Copy-Item -Path $stagedRefs -Destination $stagedSharedRefs -Recurse -Force
    }

    # Docs
    Copy-ToStaging (Join-Path $ProjectRoot "docs") "docs"

    # Bundled Node.js
    Copy-ToStaging (Join-Path $ProjectRoot "bundled\node") "node"

    # Runtime scripts — blacklist approach: copy all from root scripts/, then
    # remove platform-irrelevant and dev artifacts. New files are automatically
    # included (prevents the "missing file" class of bugs).
    # IMPORTANT: this must run BEFORE desktop scripts are added, because
    # Copy-ToStaging uses Copy-Item which, when the destination directory
    # already exists, nests the source as a subdirectory (scripts/scripts/).
    Copy-ToStaging (Join-Path $ProjectRoot "scripts") "scripts"
    # Exclude: *.sh (bash — Linux/Mac only), *.test.* (test files), __pycache__
    Get-ChildItem (Join-Path $staging "scripts") -Recurse -File `
        | Where-Object { $_.Name -match '\.(sh)$' -or $_.Name -match '\.test\.' } `
        | Remove-Item -Force
    $pycache = Join-Path (Join-Path $staging "scripts") "__pycache__"
    if (Test-Path $pycache) { Remove-Item $pycache -Recurse -Force }

    # Desktop scripts (post-install, desktop-config, hook sync) — added on top
    # of the root scripts directory that was just copied above.
    $scriptsDir = Join-Path $staging "scripts"
    foreach ($s in @("post-install-offline.ps1", "generate-desktop-config.ps1", "sync-agent-hooks-offline.mjs")) {
        $src = Join-Path (Join-Path (Join-Path $ProjectRoot "desktop") "scripts") $s
        if (Test-Path $src) { Copy-Item $src (Join-Path $scriptsDir $s) }
    }

    # Assets (system prompt templates, etc.)
    Copy-ToStaging (Join-Path $ProjectRoot "assets") "assets"

    # Guide registry + flow definitions — bootcamp/guide features
    Copy-ToStaging (Join-Path $ProjectRoot "guides") "guides"

    # Agent CLI hook templates
    $hooksSource = Join-Path $ProjectRoot ".claude\hooks\user-level"
    if (Test-Path $hooksSource) {
        Copy-ToStaging $hooksSource ".claude\hooks\user-level"
    }

    # #1542: canonical Node compaction carrier (packaged only — spawn-time
    # --settings injection reads it; never installed into project settings).
    $carrierSource = Join-Path $ProjectRoot ".claude\hooks\f24-compaction.mjs"
    if (Test-Path $carrierSource) {
        Copy-ToStaging $carrierSource ".claude\hooks\f24-compaction.mjs"
    }

    # Electron app (win-unpacked contents → desktop-dist/)
    $winUnpacked = Join-Path (Join-Path $ProjectRoot "desktop-dist") "win-unpacked"
    Copy-ToStaging $winUnpacked "desktop-dist"

    # Desktop assets
    Copy-ToStaging (Join-Path (Join-Path $ProjectRoot "desktop") "assets") "desktop\assets"

    # The portable launcher resolves its config version from desktop/package.json.
    # Bake the final release version into the staged copy so CATCAFE_VERSION
    # overrides cannot make the archive name and desktop-config.json disagree.
    $desktopPkg = Join-Path (Join-Path $ProjectRoot "desktop") "package.json"
    if (Test-Path $desktopPkg) {
        $desktopDir = Join-Path $staging "desktop"
        if (-not (Test-Path $desktopDir)) {
            New-Item -ItemType Directory -Path $desktopDir -Force | Out-Null
        }
        $pkgContent = Get-Content $desktopPkg -Raw | ConvertFrom-Json
        $pkgContent.version = $zipVersion
        $json = $pkgContent | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText((Join-Path $desktopDir "package.json"), $json, (New-Object System.Text.UTF8Encoding $false))
    }

    # CLI tool tarballs
    Copy-ToStaging (Join-Path $ProjectRoot "bundled\cli-tools") "bundled\cli-tools"

    # Portable Redis → .cat-cafe/redis/windows/
    $bundledRedisDir = Join-Path $ProjectRoot "bundled\redis"
    if (Test-Path $bundledRedisDir) {
        Copy-ToStaging $bundledRedisDir ".cat-cafe\redis\windows"
    }

    # start.bat — portable entry point
    $startBat = Join-Path (Join-Path (Join-Path $ProjectRoot "desktop") "scripts") "start-portable.bat"
    if (Test-Path $startBat) {
        Copy-Item $startBat (Join-Path $staging "start.bat")
    } else {
        Write-Warn "start-portable.bat not found — portable zip will lack start.bat"
    }

    # Compress
    $zipPath = Join-Path $distDir "$stagingName.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Write-Host "  Compressing to $stagingName.zip ..."
    Compress-Archive -Path "$staging\*" -DestinationPath $zipPath -CompressionLevel Optimal
    if (-not (Test-Path $zipPath)) {
        Write-Err "Compress-Archive did not produce output"
        exit 1
    }

    # Clean staging
    Remove-Item $staging -Recurse -Force

    $zipFile = Get-Item $zipPath
    $generatedPortablePath = $zipFile.FullName
    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  Portable zip ready!" -ForegroundColor Green
    Write-Host "  $($zipFile.FullName)" -ForegroundColor Green
    Write-Host "  Size: $([math]::Round($zipFile.Length/1MB, 2)) MB" -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green
} else {
    Write-Ok "Portable zip skipped"
}

# Step 9: Build identity manifest (P2-6). Release evidence must succeed before
# any output can be delivered. Only files produced by this invocation belong
# to its source revision. The manifest records: source
# SHA, generation time, Setup/portable ZIP path+sha256, every tar.gz archive
# with its serialized manifest, API/Web .build-commit identities, and the
# working-tree state of every input that the installer packages (including
# desktop/ source and untracked files that are bundled along, e.g. docs/).
if (-not $NoManifest) {
    Write-Step "Step 9/9 - Build manifest"
    try {
        $manifestDistDir = Join-Path $ProjectRoot "dist"
        if (-not (Test-Path -LiteralPath $manifestDistDir)) {
            New-Item -ItemType Directory -Path $manifestDistDir -Force | Out-Null
        }

        function Get-ProjectRelativePath {
            param([string]$Path)
            $full = [IO.Path]::GetFullPath($Path)
            if ($full.StartsWith($ProjectRoot, [StringComparison]::OrdinalIgnoreCase)) {
                $relative = $full.Substring($ProjectRoot.Length) -replace '^[\\/]+', ''
                return ($relative -replace '\\', '/')
            }
            return ($full -replace '\\', '/')
        }
        function Get-FileSha256 {
            param([string]$Path)
            return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
        }
        function Get-ArtifactRecord {
            param([string]$Path)
            if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Manifest input is missing: $Path" }
            return [ordered]@{
                path      = Get-ProjectRelativePath $Path
                sizeBytes = (Get-Item -LiteralPath $Path).Length
                sha256    = Get-FileSha256 $Path
            }
        }

        $manifestVersion = if ($env:CATCAFE_VERSION) {
            $env:CATCAFE_VERSION
        } else {
            (Get-Content (Join-Path (Join-Path $ProjectRoot 'desktop') 'package.json') -Raw | ConvertFrom-Json).version
        }

        # Artifact identities stamped by the paired API/Web build.
        $buildIdentity = [ordered]@{}
        foreach ($stamp in @(
            @{ Key = 'api'; RelativePath = 'packages/api/dist/.build-commit' },
            @{ Key = 'web'; RelativePath = 'packages/web/.next/.build-commit' }
        )) {
            $stampPath = Join-Path $ProjectRoot $stamp.RelativePath
            if (Test-Path -LiteralPath $stampPath) {
                $stampValue = Get-Content -LiteralPath $stampPath -Raw
                if ($null -eq $stampValue) { $stampValue = '' } else { $stampValue = $stampValue.Trim() }
                $buildIdentity[$stamp.Key] = [ordered]@{
                    path  = $stamp.RelativePath
                    value = $stampValue
                }
            } else {
                $buildIdentity[$stamp.Key] = $null
            }
        }

        # A skipped output must remain null even when dist contains an older release.
        $setupExe = if ($generatedSetupPath) { Get-Item -LiteralPath $generatedSetupPath -ErrorAction Stop } else { $null }
        $portableZip = if ($generatedPortablePath) { Get-Item -LiteralPath $generatedPortablePath -ErrorAction Stop } else { $null }
        $setupRecord = if ($setupExe) { Get-ArtifactRecord $setupExe.FullName } else { $null }
        if ($setupRecord) {
            # Re-check (and normalize when needed) so the manifest never records
            # an unlaunchable Low-integrity installer as a release artifact.
            $setupIntegrityJson = (& node $integrityTool $setupExe.FullName --json 2>&1 | Out-String).Trim()
            if ($LASTEXITCODE -eq 0 -and $setupIntegrityJson) {
                $setupIntegrity = $setupIntegrityJson | ConvertFrom-Json
                $setupRecord.integrity = $setupIntegrity.after
                $script:SetupIntegrityLevel = $setupIntegrity.after
                if ($setupIntegrity.changed) {
                    Write-Warn "Raised existing Setup integrity from $($setupIntegrity.before) to $($setupIntegrity.after)"
                }
            } else {
                throw "Could not verify Setup integrity: $setupIntegrityJson"
            }
        }
        $portableRecord = if ($portableZip) { Get-ArtifactRecord $portableZip.FullName } else { $null }

        # Each bulk archive and its serialized extraction manifest (sidecar).
        $archives = @()
        $archiveDirManifest = Join-Path (Join-Path $ProjectRoot 'bundled') 'archives'
        if (Test-Path -LiteralPath $archiveDirManifest) {
            foreach ($archive in (Get-ChildItem -LiteralPath $archiveDirManifest -Filter '*.tar.gz' -File | Sort-Object Name)) {
                $archives += [ordered]@{
                    name     = $archive.Name
                    archive  = Get-ArtifactRecord $archive.FullName
                    manifest = if ($archive.Name -eq 'node.tar.gz') { $null } else { Get-ArtifactRecord ($archive.FullName + '.json') }
                }
            }
        }

        # Clean/hygiene check over everything the installer copies. The
        # preflight above rejects dirty release inputs; this duplicate census is
        # retained in the manifest so diagnostic builds remain auditable.
        $packagedRoots = @(
            'docs', 'cat-cafe-skills', 'scripts', 'assets', 'guides',
            '.claude/hooks/user-level',
            '.claude/hooks/f24-compaction.mjs', 'cat-template.json',
            'pnpm-workspace.yaml', 'package.json', 'LICENSE',
            'bundled/archives', 'bundled/node', 'bundled/redis', 'bundled/cli-tools',
            'desktop/scripts', 'desktop/assets'
        )
        $packagedStatus = @(git -C $ProjectRoot status --porcelain --untracked-files=all -- @packagedRoots 2>$null)
        if ($LASTEXITCODE -ne 0) { throw "Could not read packaged-input git status" }
        $desktopStatus = @(git -C $ProjectRoot status --porcelain --untracked-files=normal -- desktop 2>$null)
        if ($LASTEXITCODE -ne 0) { throw "Could not read desktop/ git status" }

        $trackedPackagedChanges = @($packagedStatus | Where-Object { $_ -and $_ -notmatch '^\?\?' })
        $untrackedPackagedFiles = @($packagedStatus | ForEach-Object {
            if ($_ -match '^\?\?\s+(.+)$') { $Matches[1].Trim() }
        } | Where-Object { $_ })
        $desktopSourceChanges = @($desktopStatus | Where-Object { $_ })

        $manifest = [ordered]@{
            schemaVersion = 1
            sourceSha     = (git -C $ProjectRoot rev-parse HEAD).Trim()
            sourceBranch  = (git -C $ProjectRoot rev-parse --abbrev-ref HEAD).Trim()
            generatedAt   = [DateTime]::UtcNow.ToString('o')
            version       = $manifestVersion
            diagnosticOnly = [bool]$AllowDirtyInputs
            skippedElectronBuild = [bool]$SkipElectronBuild
            installer     = $setupRecord
            portableZip   = $portableRecord
            archives      = $archives
            buildIdentity = $buildIdentity
            workingTree   = [ordered]@{
                packagedInputsClean      = ($packagedStatus.Count -eq 0)
                packagedTrackedChanges   = $trackedPackagedChanges
                packagedUntrackedFiles   = $untrackedPackagedFiles
                desktopSourceClean       = ($desktopStatus.Count -eq 0)
                desktopSourceChanges     = $desktopSourceChanges
                buildRootIntegrity       = $script:BuildRootIntegrity
                installerIntegrity       = $script:SetupIntegrityLevel
            }
        }
        $manifestPath = Join-Path $manifestDistDir 'build-manifest.json'
        # BOM-free JSON via .NET so CI parsers and other tools see plain UTF-8.
        [IO.File]::WriteAllText(
            $manifestPath,
            ($manifest | ConvertTo-Json -Depth 8),
            [Text.UTF8Encoding]::new($false)
        )
        Write-Ok "Build manifest -> dist/build-manifest.json"
        if ($desktopSourceChanges.Count -gt 0) {
            Write-Warn "desktop/ source has uncommitted changes; recorded in dist/build-manifest.json (build continues)"
        }
        if ($trackedPackagedChanges.Count -gt 0) {
            Write-Warn "Packaged inputs have uncommitted changes; recorded in dist/build-manifest.json"
        }
    } catch {
        if (-not $AllowDirtyInputs) { throw "Release build manifest generation failed: $_" }
        Write-Warn "Diagnostic build manifest generation failed; output is not releaseable: $_"
    }
} else {
    Write-Ok "Build manifest skipped (-NoManifest)"
}
