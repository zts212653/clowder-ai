<#
.SYNOPSIS
  Post-install for the offline Clowder AI installer.

.DESCRIPTION
  Called by Inno Setup after file extraction.
  Steps: generate .env -> mount skills symlinks -> verify artifacts.
#>

param(
    [Parameter(Mandatory)] [string]$AppDir,
    [switch]$AgentHooksOnly,
    [string]$UserProfileRoot
)

$ErrorActionPreference = "Stop"
if ($UserProfileRoot -and -not [System.IO.Path]::IsPathRooted($UserProfileRoot)) {
    throw "UserProfileRoot must be an absolute path"
}

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
    if ($UserProfileRoot) { return [System.IO.Path]::GetFullPath($UserProfileRoot) }
    $instanceMarker = Join-Path $AppDir 'desktop-instance.json'
    if (Test-Path -LiteralPath $instanceMarker) {
        $instance = Get-Content -LiteralPath $instanceMarker -Raw | ConvertFrom-Json
        $root = $instance.CAT_CAFE_DESKTOP_INSTANCE_ROOT
        if (-not ($root -is [string]) -or -not $root -or -not [System.IO.Path]::IsPathRooted($root)) {
            throw 'Invalid desktop instance identity; refusing hooks in the original client profile'
        }
        return Join-Path ([System.IO.Path]::GetFullPath($root)) 'home'
    }
    if ($env:USERPROFILE) {
        return $env:USERPROFILE
    }

    if ($env:HOMEDRIVE -and $env:HOMEPATH) {
        return "$($env:HOMEDRIVE)$($env:HOMEPATH)"
    }

    return $null
}

function Write-AgentHookPhase {
    param([string]$Phase, [string]$State, [double]$DurationMs, [double]$CpuMs)
    $record = [ordered]@{
        version = 1; component = 'powershell'; pid = $PID
        phase = $Phase; state = $State
        durationMs = [Math]::Round($DurationMs, 2); processCpuMs = [Math]::Round($CpuMs, 2)
    }
    $line = '[agent-hook-install] ' + ($record | ConvertTo-Json -Compress)
    Write-Host $line
    $profileRoot = $null
    try { $profileRoot = Resolve-AgentHookTargetRoot } catch { }
    $logDirs = @((Join-Path $ProjectRoot '.installer-logs'))
    if ($profileRoot) { $logDirs += Join-Path $profileRoot '.cat-cafe\installer-logs' }
    foreach ($logDir in $logDirs) {
        try {
            [System.IO.Directory]::CreateDirectory($logDir) | Out-Null
            [System.IO.File]::AppendAllText((Join-Path $logDir 'agent-hooks.log'), $line + "`n", [System.Text.UTF8Encoding]::new($false))
            break
        } catch { } # Diagnostics cannot prevent user-level hook repair.
    }
}

function Invoke-AgentHookPhase {
    param([string]$Phase, [scriptblock]$Action)
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $cpu = [System.Diagnostics.Process]::GetCurrentProcess().TotalProcessorTime.TotalMilliseconds
    Write-AgentHookPhase $Phase 'started' 0 0
    try {
        $result = & $Action
        Write-AgentHookPhase $Phase 'completed' $timer.Elapsed.TotalMilliseconds ([System.Diagnostics.Process]::GetCurrentProcess().TotalProcessorTime.TotalMilliseconds - $cpu)
        return $result
    } catch {
        Write-AgentHookPhase $Phase 'failed' $timer.Elapsed.TotalMilliseconds ([System.Diagnostics.Process]::GetCurrentProcess().TotalProcessorTime.TotalMilliseconds - $cpu)
        throw
    }
}

function Write-SafeNodeHookPhase {
    param([object]$Line)
    $text = [string]$Line
    $prefix = '[agent-hook-install] '
    if (-not $text.StartsWith($prefix, [System.StringComparison]::Ordinal)) { return }
    try {
        $event = $text.Substring($prefix.Length) | ConvertFrom-Json
        $phases = @('module-import', 'hook-sync', 'sync-result', 'hook-files-write', 'claude-settings-merge',
            'capability-owner-check', 'capability-sync', 'health-check', 'hook-files-health',
            'claude-settings-health', 'skills-health', 'mcp-health', 'codex-output-validate')
        if ($event.version -ne 1 -or $event.component -cne 'node' -or
            $phases -cnotcontains $event.phase -or @('started', 'completed', 'failed') -cnotcontains $event.state) { return }
        $safe = [ordered]@{ version = 1; component = 'node'; pid = [int]$event.pid; phase = $event.phase; state = $event.state }
        if ($safe.pid -le 0) { return }
        foreach ($field in @('elapsedMs', 'durationMs', 'userCpuMs', 'systemCpuMs')) {
            $value = $event.$field
            if ($null -eq $value -or $value -is [string] -or $value -is [bool]) { return }
            $number = [double]$value
            if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt 0) { return }
            $safe[$field] = $number
        }
        if ($event.phase -ceq 'sync-result') {
            if (@('configured', 'missing', 'stale', 'unsupported', 'error') -cnotcontains $event.healthStatus) { return }
            $safe.healthStatus = $event.healthStatus
        }
        Write-Host ($prefix + ($safe | ConvertTo-Json -Compress))
    } catch { } # Reject malformed child output without exposing it.
}

function Invoke-AgentHookSync {
    try {
        $syncScript = Invoke-AgentHookPhase 'resolve-helper' {
            $helper = Join-Path $ProjectRoot 'scripts\sync-agent-hooks-offline.mjs'
            if (-not (Test-Path $helper)) { throw 'helper unavailable' }
            return $helper
        }
        $nodeCmd = Invoke-AgentHookPhase 'resolve-node' {
            $command = Resolve-Command 'node'
            if (-not $command) { throw 'node unavailable' }
            return $command
        }
        $targetRoot = Invoke-AgentHookPhase 'resolve-profile' {
            $profileRoot = Resolve-AgentHookTargetRoot
            if (-not $profileRoot) { throw 'profile unavailable' }
            return $profileRoot
        }
        Invoke-AgentHookPhase 'node-sync' {
            # Rebuild only known diagnostic records; arbitrary output is never forwarded.
            & $nodeCmd $syncScript --project-root $ProjectRoot --target-root $targetRoot 2>&1 | ForEach-Object { Write-SafeNodeHookPhase $_ }
            if ($LASTEXITCODE -ne 0) { throw 'hook helper failed' }
        }
        Write-Ok 'Agent CLI hooks synced'
    } catch {
        Write-Warn 'Agent CLI hook sync failed -- inspect installation phases; Hub health check can repair it later'
    }
}

$ScriptDir = Split-Path -Parent $PSCommandPath
$ProjectRoot = if ($AppDir) { $AppDir } else { Split-Path -Parent $ScriptDir }
# Prepend bundled Node to PATH so scripts (e.g. agent hook sync) can find it.
# NOTE: Installer maps bundled\node\* -> {app}\node\ (see cat-cafe.iss).
$BundledNodeDir = Join-Path $ProjectRoot "node"
if (Test-Path (Join-Path $BundledNodeDir "node.exe")) {
    $env:PATH = "$BundledNodeDir;$env:PATH"
    Write-Ok "Bundled Node.js found - prepended to PATH"
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
    $skillProfileRoot = Resolve-AgentHookTargetRoot
    $targets = @(
        @{ Dir = "$skillProfileRoot\.claude"; Link = "skills" },
        @{ Dir = "$skillProfileRoot\.codex"; Link = "skills" },
        @{ Dir = "$skillProfileRoot\.gemini"; Link = "skills" },
        @{ Dir = "$skillProfileRoot\.kimi"; Link = "skills" }
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
    $(if (Test-Path (Join-Path $AppDir 'node_modules/@cat-cafe/shared/dist/index.js')) { 'node_modules/@cat-cafe/shared/dist/index.js' } else { 'packages/api/node_modules/@cat-cafe/shared/dist/index.js' }),
    "packages/web/.next",
    $(if (Test-Path (Join-Path $AppDir 'node_modules/.runtime-lock.json')) { 'node_modules/next/dist/bin/next' } else { 'packages/web/node_modules/next/dist/bin/next' }),
    $(if (Test-Path (Join-Path $AppDir 'node_modules/.runtime-lock.json')) { 'node_modules/zod' } else { 'packages/api/node_modules/zod' })
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
    Write-Host "  Clowder AI configured!" -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green
} else {
    Write-Host "  ========================================" -ForegroundColor Yellow
    Write-Host "  Clowder AI installed with warnings" -ForegroundColor Yellow
    Write-Host "  ========================================" -ForegroundColor Yellow
}

Write-Host ""
