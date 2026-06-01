<#
.SYNOPSIS
  Post-install for the offline Cat Cafe installer.

.DESCRIPTION
  Called by Inno Setup after file extraction.
  Steps: generate .env -> mount skills symlinks -> verify artifacts.
#>

param(
    [Parameter(Mandatory)] [string]$AppDir,
    [switch]$AgentHooksOnly
)

$ErrorActionPreference = "Stop"

function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

function Resolve-Command { param([string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:APPDATA "npm\$Name.cmd"),
        (Join-Path $env:APPDATA "npm\$Name.exe"),
        (Join-Path $env:ProgramFiles "nodejs\$Name.cmd")
    ) | Where-Object { $_ }
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    return $null
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
# Prepend bundled Node to PATH so scripts (e.g. agent hook sync) can find it.
# NOTE: Installer maps bundled\node\* → {app}\node\ (see cat-cafe.iss).
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

Write-Step "Step 1/3 - Generate .env"

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

Write-Step "Step 2/3 - Mount skills"

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
            $linked = $false
            # Try directory symlink first (needs admin or Developer Mode)
            try {
                cmd /c mklink /D "$linkPath" "$skillsSource" 2>$null | Out-Null
                if (Test-Path $linkPath) { $linked = $true }
            } catch {}
            # Fallback to junction (no admin needed, local paths only)
            if (-not $linked) {
                try {
                    cmd /c mklink /J "$linkPath" "$skillsSource" 2>$null | Out-Null
                    if (Test-Path $linkPath) { $linked = $true }
                } catch {}
            }
            if ($linked) {
                Write-Ok "Skills linked: $linkPath"
            } else {
                Write-Warn "Could not create symlink: $linkPath (try running as admin or enable Developer Mode)"
            }
        }
    }
} else {
    Write-Warn "cat-cafe-skills/ not found -- skills not mounted"
}

Write-Step "Step 3/3 - Verify"

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
