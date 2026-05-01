<#
.SYNOPSIS
  Post-install for the offline Cat Cafe installer.

.DESCRIPTION
  Called by Inno Setup after file extraction.
  Steps: generate .env -> mount skills symlinks -> install CLI tools (if selected) -> verify artifacts.
#>

param(
    [Parameter(Mandatory)] [string]$AppDir,
    [switch]$Claude,
    [switch]$Codex,
    [switch]$Gemini,
    [switch]$Kimi,
    [switch]$AgentHooksOnly
)

$ErrorActionPreference = "Stop"

function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

function Test-NetworkAvailable {
    try {
        $req = [System.Net.WebRequest]::Create("https://registry.npmjs.org")
        $req.Timeout = 3000
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch {
        return $false
    }
}

function Resolve-Command { param([string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # Check common npm global locations
    $candidates = @(
        (Join-Path $env:APPDATA "npm\$Name.cmd"),
        (Join-Path $env:APPDATA "npm\$Name.exe"),
        (Join-Path $env:LOCALAPPDATA "npm\$Name.cmd"),
        (Join-Path $env:ProgramFiles "nodejs\$Name.cmd"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\$Name.cmd")
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

function Install-CliToolFromBundle {
    param([string]$Name, [string]$PkgName, [string]$BundleDir)
    $tarball = Get-ChildItem -Path $BundleDir -Filter "$Name-*.tgz" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $tarball) {
        $tarball = Get-ChildItem -Path $BundleDir -Filter "*.tgz" -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*$Name*" } | Select-Object -First 1
    }
    if (-not $tarball) { return $false }

    $npmCmd = Resolve-Command "npm"
    if (-not $npmCmd) { return $false }

    try {
        & $npmCmd install -g $tarball.FullName 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Install-CliToolFromNetwork {
    param([string]$PkgName, [string]$InstallKind)
    if ($InstallKind -eq "python") {
        $pipCmd = Resolve-Command "pip"
        if (-not $pipCmd) { $pipCmd = Resolve-Command "pip3" }
        if (-not $pipCmd) { return $false }
        try {
            & $pipCmd install --user --upgrade $PkgName 2>$null
            return ($LASTEXITCODE -eq 0)
        } catch { return $false }
    } else {
        $npmCmd = Resolve-Command "npm"
        if (-not $npmCmd) { return $false }
        try {
            & $npmCmd install -g $PkgName 2>$null
            return ($LASTEXITCODE -eq 0)
        } catch { return $false }
    }
}

function Resolve-AgentHookTargetRoot {
    if ($env:USERPROFILE) {
        return $env:USERPROFILE
    }

    if ($env:HOMEDRIVE -and $env:HOMEPATH) {
        return "$($env:HOMEDRIVE)$($env:HOMEPATH)"
    }

    return $null
}

function Invoke-AgentHookSync {
    $syncScript = Join-Path $ProjectRoot "scripts\sync-agent-hooks-offline.mjs"
    if (-not (Test-Path $syncScript)) {
        Write-Warn "Agent CLI hook sync skipped -- helper not found"
        return
    }

    $nodeCmd = Resolve-Command "node"
    if (-not $nodeCmd) {
        Write-Warn "Agent CLI hook sync skipped -- node not found"
        return
    }

    $targetRoot = Resolve-AgentHookTargetRoot
    if (-not $targetRoot) {
        Write-Warn "Agent CLI hook sync skipped -- user profile not found"
        return
    }

    try {
        & $nodeCmd $syncScript --project-root $ProjectRoot --target-root $targetRoot 2>&1 | ForEach-Object {
            Write-Host "    $_"
        }
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Agent CLI hooks synced"
        } else {
            Write-Warn "Agent CLI hook sync failed -- Hub health check can repair it later"
        }
    } catch {
        Write-Warn "Agent CLI hook sync failed -- Hub health check can repair it later: $_"
    }
}

$ScriptDir = Split-Path -Parent $PSCommandPath
$ProjectRoot = if ($AppDir) { $AppDir } else { Split-Path -Parent $ScriptDir }
$BundleDir = Join-Path $ProjectRoot "bundled\cli-tools"
$StatusFile = Join-Path $ProjectRoot ".cat-cafe\cli-tools-status.json"

# Prepend bundled Node to PATH so CLI provisioning uses it instead of system npm.
# Without this, clean Windows machines lacking pre-installed Node/npm fail silently.
# NOTE: Installer maps bundled\node\* → {app}\node\ (see cat-cafe.iss:89).
$BundledNodeDir = Join-Path $ProjectRoot "node"
if (Test-Path (Join-Path $BundledNodeDir "node.exe")) {
    $env:PATH = "$BundledNodeDir;$env:PATH"
    Write-Ok "Bundled Node.js found — prepended to PATH"
}

if ($AgentHooksOnly) {
    Write-Step "Agent CLI hooks"
    Invoke-AgentHookSync
    exit 0
}

Write-Step "Step 1/4 - Generate .env"

$envFile = Join-Path $ProjectRoot ".env"
$envExample = Join-Path $ProjectRoot ".env.example"

if (Test-Path $envFile) {
    Write-Ok ".env already exists"
} elseif (Test-Path $envExample) {
    Copy-Item $envExample $envFile
    Write-Ok ".env created from .env.example"
} else {
    @"
FRONTEND_PORT=3003
API_SERVER_PORT=3004
NEXT_PUBLIC_API_URL=http://localhost:3004
REDIS_PORT=6399
"@ | Out-File -FilePath $envFile -Encoding utf8
    Write-Ok "Minimal .env created"
}

$envContent = Get-Content $envFile -Raw -ErrorAction SilentlyContinue
if ($envContent -and $envContent -notmatch 'REDIS_URL') {
    Add-Content -Path $envFile -Value "`nREDIS_URL=redis://localhost:6399"
    Write-Ok "REDIS_URL added to .env"
}

Write-Step "Step 2/4 - Mount skills"

$skillsSource = Join-Path $ProjectRoot "cat-cafe-skills"
if (Test-Path $skillsSource) {
    $targets = @(
        @{ Dir = "$env:USERPROFILE\.claude"; Link = "skills" },
        @{ Dir = "$env:USERPROFILE\.codex"; Link = "skills" },
        @{ Dir = "$env:USERPROFILE\.gemini"; Link = "skills" },
        @{ Dir = "$env:USERPROFILE\.kimi"; Link = "skills" }
    )
    foreach ($t in $targets) {
        $linkPath = Join-Path $t.Dir $t.Link
        if (-not (Test-Path $t.Dir)) {
            New-Item -ItemType Directory -Path $t.Dir -Force | Out-Null
        }
        if (-not (Test-Path $linkPath)) {
            try {
                cmd /c mklink /D "$linkPath" "$skillsSource" 2>$null | Out-Null
                Write-Ok "Skills linked: $linkPath"
            } catch {
                Write-Warn "Could not create symlink: $linkPath"
            }
        }
    }
} else {
    Write-Warn "cat-cafe-skills/ not found -- skills not mounted"
}

Write-Step "Step 3/4 - AI CLI tools"

$cliTools = @(
    @{ Name = "claude"; Label = "Claude"; Pkg = "@anthropic-ai/claude-code"; Selected = $Claude.IsPresent },
    @{ Name = "codex"; Label = "Codex"; Pkg = "@openai/codex"; Selected = $Codex.IsPresent },
    @{ Name = "gemini"; Label = "Gemini"; Pkg = "@google/gemini-cli"; Selected = $Gemini.IsPresent },
    @{ Name = "kimi"; Label = "Kimi"; Pkg = "kimi-cli"; Kind = "python"; Selected = $Kimi.IsPresent }
)

# Only attempt installation for tools the user selected in the installer
$selectedTools = $cliTools | Where-Object { $_.Selected }
if (-not $selectedTools) {
    Write-Ok "No CLI tools selected — skipping"
    $hasNetwork = $false
} else {
    $hasNetwork = Test-NetworkAvailable
    if ($hasNetwork) {
        Write-Ok "Network available"
    } else {
        Write-Warn "Network unavailable -- CLI tools can only be installed from bundle"
    }
}

$status = @{}
foreach ($tool in $selectedTools) {
    $existing = Resolve-Command $tool.Name
    if ($existing) {
        Write-Ok "$($tool.Label) CLI already installed"
        $status[$tool.Name] = @{ installed = $true; source = "existing"; path = $existing }
        continue
    }

    $installed = $false
    $source = $null

    # Try bundled tarball first
    if (Test-Path $BundleDir) {
        $installed = Install-CliToolFromBundle -Name $tool.Name -PkgName $tool.Pkg -BundleDir $BundleDir
        if ($installed) { $source = "bundle" }
    }

    # Fall back to network
    if (-not $installed -and $hasNetwork) {
        $installed = Install-CliToolFromNetwork -PkgName $tool.Pkg -InstallKind $tool.Kind
        if ($installed) { $source = "network" }
    }

    if ($installed) {
        $newPath = Resolve-Command $tool.Name
        Write-Ok "$($tool.Label) CLI installed ($source)"
        $status[$tool.Name] = @{ installed = $true; source = $source; path = $newPath }
    } else {
        Write-Warn "$($tool.Label) CLI not installed (bundle: $(Test-Path $BundleDir), network: $hasNetwork)"
        $status[$tool.Name] = @{ installed = $false; source = $null }
    }
}

# Persist status for the Electron app to read
$statusDir = Split-Path -Parent $StatusFile
if (-not (Test-Path $statusDir)) {
    New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
}
$status | ConvertTo-Json -Depth 3 | Out-File -FilePath $StatusFile -Encoding utf8

Write-Step "Step 4/4 - Verify"

$artifacts = @(
    "packages/api/dist/index.js",
    "packages/api/node_modules/zod",
    "packages/api/node_modules/@cat-cafe/shared/dist/index.js",
    "packages/web/.next",
    "packages/web/node_modules/next/dist/bin/next"
)
$allGood = $true
foreach ($artifact in $artifacts) {
    $fullPath = Join-Path $ProjectRoot $artifact
    if (Test-Path $fullPath) {
        Write-Ok $artifact
    } else {
        Write-Warn "$artifact - missing"
        $allGood = $false
    }
}

$redisExe = Join-Path $ProjectRoot ".cat-cafe\redis\windows\redis-server.exe"
if (Test-Path $redisExe) {
    Write-Ok "Redis portable: ready"
} else {
    Write-Warn "Redis portable not found -- will use memory store or system Redis"
}

Write-Host ""
if ($allGood) {
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  Cat Cafe configured!" -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green
} else {
    Write-Host "  ========================================" -ForegroundColor Yellow
    Write-Host "  Cat Cafe installed with warnings" -ForegroundColor Yellow
    Write-Host "  ========================================" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  CLI Tools:" -ForegroundColor Cyan
foreach ($tool in $cliTools) {
    $s = $status[$tool.Name]
    if (-not $tool.Selected) {
        Write-Host "  [--] $($tool.Label) (not selected)" -ForegroundColor DarkGray
    } elseif ($s -and $s.installed) {
        Write-Host "  [OK] $($tool.Label)" -ForegroundColor Green
    } else {
        Write-Host "  [!!] $($tool.Label) (failed)" -ForegroundColor Yellow
    }
}
Write-Host ""
