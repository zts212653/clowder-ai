<#
.SYNOPSIS
  Clowder AI - Windows Repo-Local Install Helper

.DESCRIPTION
  Installs prerequisites and sets up the current checked-out clowder-ai repo.
  Clone or download the repo first, then run this helper from inside it.
  Steps: env detect -> Node/pnpm install -> Redis -> .env generate -> deps & build
         -> skills mount -> AI CLI tools -> auth config -> verify & optionally start

.EXAMPLE
  # From repo root:
  .\scripts\install.ps1
#>

param(
    [switch]$Start,
    [switch]$SkipBuild,
    [switch]$SkipCli
)

$ErrorActionPreference = "Stop"

function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

function Refresh-Path {
    Sync-ToolPath
}

function Resolve-PnpmCommand { Resolve-ToolCommand -Name "pnpm" }
function Invoke-Pnpm { param([string[]]$CommandArgs) Invoke-ToolCommand -Name "pnpm" -CommandArgs $CommandArgs }
function Test-InstallerCancellation {
    param($ErrorRecord)
    if (-not $ErrorRecord -or -not $ErrorRecord.Exception) {
        return $false
    }
    $exception = $ErrorRecord.Exception
    while ($exception) {
        $exceptionType = $exception.GetType().FullName
        if ($exceptionType -eq 'System.Management.Automation.PipelineStoppedException' -or
            $exceptionType -eq 'System.Management.Automation.OperationStoppedException') {
            return $true
        }
        $exception = $exception.InnerException
    }
    return $false
}
function Exit-InstallerIfCancelled {
    param($ErrorRecord, [string]$Context)
    if (Test-InstallerCancellation -ErrorRecord $ErrorRecord) {
        Write-Err "$Context cancelled by user"
        exit 1
    }
}
function Get-PnpmStatus {
    param([int]$Attempts = 1, [int]$DelayMs = 500)
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        try {
            Refresh-Path
            $pnpmCommand = Resolve-PnpmCommand
            if ($pnpmCommand) {
                $pnpmRaw = & $pnpmCommand --version 2>$null
                if ($pnpmRaw -and $pnpmRaw -match '^(\d+)\.' -and [int]$Matches[1] -ge 8) {
                    return [pscustomobject]@{
                        Command = $pnpmCommand
                        Version = $pnpmRaw
                    }
                }
            }
        } catch {}
        if ($attempt -lt ($Attempts - 1)) {
            Start-Sleep -Milliseconds $DelayMs
        }
    }
    return $null
}

$ScriptPath = if ($PSCommandPath) { $PSCommandPath } elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path } else { $null }
if (-not $ScriptPath) {
    Write-Err "Could not resolve install.ps1 path. Run with: powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1"
    exit 1
}
$ScriptDir = Split-Path -Parent $ScriptPath
. (Join-Path $ScriptDir "install-windows-helpers.ps1")

function Resolve-ProjectRoot {
    $projectRoot = Split-Path -Parent $ScriptDir
    if (-not (Test-Path (Join-Path $projectRoot "package.json")) -or
        -not (Test-Path (Join-Path $projectRoot "packages/api"))) {
        Write-Err "Run this helper from a checked-out clowder-ai repo: .\scripts\install.ps1"
        exit 1
    }
    $gitRepoUnavailable = $false
    try {
        & git -C $projectRoot rev-parse --is-inside-work-tree 1>$null 2>$null
        $gitRepoUnavailable = $LASTEXITCODE -ne 0
    } catch {}
    if ($gitRepoUnavailable) {
        Write-Warn "No .git directory detected - git-dependent features will be unavailable"
    }
    return $projectRoot
}

# -- Step 1: Environment detection ---------------------------
Write-Step "Step 1/9 - Detect environment"

if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Err "PowerShell 5.0+ required (current: $($PSVersionTable.PSVersion))"
    exit 1
}
Write-Ok "PowerShell $($PSVersionTable.PSVersion)"

$hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
if ($hasWinget) { Write-Ok "winget available" } else { Write-Warn "winget not found - manual install may be needed" }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Err "Git not found. Install from https://git-scm.com/ and re-run."
    exit 1
}
Write-Ok "Git: $(git --version)"

$ProjectRoot = Resolve-ProjectRoot
$authState = New-InstallerAuthState -ProjectRoot $ProjectRoot

if ($env:CAT_CAFE_NPM_REGISTRY) {
    $env:NPM_CONFIG_REGISTRY = $env:CAT_CAFE_NPM_REGISTRY.Trim()
    Write-Ok "npm registry override: $($env:NPM_CONFIG_REGISTRY)"
}

Write-Step "Step 2/9 - Node.js and pnpm"

$nodeOk = $false
try {
    $nodeRaw = & node --version 2>$null
    if ($nodeRaw -match 'v(\d+)\.(\d+)') {
        $nodeMajor = [int]$Matches[1]
        if ($nodeMajor -ge 20) {
            Write-Ok "Node.js $nodeRaw"
            $nodeOk = $true
        } else {
            Write-Warn "Node.js $nodeRaw too old (need >= 20), upgrading..."
        }
    }
} catch {}

if (-not $nodeOk) {
    if ($hasWinget) {
        try {
            Write-Host "  Installing Node.js LTS via winget..."
            winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent 2>$null
            Refresh-Path
            $nodeRaw = & node --version 2>$null
            if ($nodeRaw -match 'v(\d+)\.(\d+)') {
                $nodeMajor = [int]$Matches[1]
                if ($nodeMajor -ge 20) {
                    Write-Ok "Node.js $nodeRaw installed"
                    $nodeOk = $true
                } else {
                    Write-Warn "Node.js $nodeRaw still too old after winget install"
                }
            } else {
                Write-Warn "Could not verify Node.js version after winget install"
            }
        } catch {
            Exit-InstallerIfCancelled -ErrorRecord $_ -Context "Node.js installation"
        }
        if (-not $nodeOk) {
            Write-Warn "winget Node.js install failed - falling back to manual prerequisite check"
        }
    }
    if (-not $nodeOk) {
        Write-Err "Node.js >= 20 required. Install from https://nodejs.org/"
        exit 1
    }
}

$pnpmOk = $false
try {
    $pnpmStatus = Get-PnpmStatus
    if ($pnpmStatus) {
        Write-Ok "pnpm $($pnpmStatus.Version)"
        $pnpmOk = $true
    }
} catch {}

if (-not $pnpmOk) {
    Write-Host "  Installing pnpm..."
    $npmCommand = Resolve-ToolCommand -Name "npm"
    if ($npmCommand) {
        try {
            & $npmCommand install -g pnpm 2>$null
            $pnpmStatus = Get-PnpmStatus -Attempts 6
            if ($pnpmStatus) {
                Write-Ok "pnpm $($pnpmStatus.Version) (via npm)"
                $pnpmOk = $true
            } else {
                throw "pnpm shim missing after npm install"
            }
        } catch {
            Exit-InstallerIfCancelled -ErrorRecord $_ -Context "pnpm installation"
        }
    }
    if (-not $pnpmOk) {
        $corepackCommand = Resolve-ToolCommand -Name "corepack"
        if ($corepackCommand) {
            try {
                & $corepackCommand enable 2>$null
                & $corepackCommand install -g pnpm@latest 2>$null
                $pnpmStatus = Get-PnpmStatus -Attempts 6
                if ($pnpmStatus) {
                    Write-Ok "pnpm $($pnpmStatus.Version) (via corepack)"
                    $pnpmOk = $true
                } else {
                    throw "pnpm shim missing after corepack install"
                }
            } catch {
                Exit-InstallerIfCancelled -ErrorRecord $_ -Context "pnpm installation"
            }
        }
    }
    if (-not $pnpmOk) {
        Write-ToolResolutionDiagnostics -Name "pnpm"
        Write-Err "Could not install pnpm. Run: npm install -g pnpm"
        exit 1
    }
}

Write-Step "Step 3/9 - Redis"

$redisPlan = Resolve-InstallerRedisPlan -ProjectRoot $ProjectRoot
$hasRedis = Apply-InstallerRedisPlan -State $authState -ProjectRoot $ProjectRoot -Plan $redisPlan
if (-not $hasRedis) {
    Write-Err "Redis setup failed. Install Redis locally or rerun and choose an external Redis URL."
    exit 1
}

Write-Step "Step 4/9 - Generate .env"

Set-Location $ProjectRoot
Write-Ok "Using project root: $ProjectRoot"

$envFile = Join-Path $ProjectRoot ".env"
$envExample = Join-Path $ProjectRoot ".env.example"

if (Test-Path $envFile) {
    Write-Ok ".env already exists - skipping"
} elseif (Test-Path $envExample) {
    Copy-Item $envExample $envFile
    Write-Ok ".env created from .env.example"
    Write-Warn "Edit .env to add your API keys and customize ports"
} else {
    Write-Warn ".env.example not found - creating minimal .env"
    @"
FRONTEND_PORT=3004
API_SERVER_PORT=3003
NEXT_PUBLIC_API_URL=http://localhost:3003
REDIS_PORT=6379
"@ | Out-File -FilePath $envFile -Encoding utf8
    Write-Ok "Minimal .env created"
}

# Load .env into current session so NEXT_PUBLIC_* vars are available at build time
if (Test-Path $envFile) {
    foreach ($line in (Get-Content $envFile)) {
        $trimmed = $line.Trim()
        if ($trimmed -and -not $trimmed.StartsWith("#") -and $trimmed -match '^([^=]+)=(.*)$') {
            $key = $Matches[1].Trim()
            $val = $Matches[2].Trim().Trim('"').Trim("'")
            [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
        }
    }
    Write-Ok ".env loaded into session"
}

Write-Step "Step 5/9 - Install dependencies and build"

Write-Host "  Running pnpm install..."
$frozenInstallOk = $false
$frozenInstallError = $null
try {
    Invoke-Pnpm -CommandArgs @("install", "--frozen-lockfile") 2>$null
    $frozenInstallOk = $LASTEXITCODE -eq 0
} catch {
    $frozenInstallError = $_
}
if (-not $frozenInstallOk) {
    Exit-InstallerIfCancelled -ErrorRecord $frozenInstallError -Context "pnpm install"
    Write-Warn "Frozen lockfile failed, retrying..."
    Invoke-Pnpm -CommandArgs @("install")
    if ($LASTEXITCODE -ne 0) { Write-Err "pnpm install failed"; exit 1 }
}
Write-Ok "Dependencies installed"

if (-not $SkipBuild) {
    $buildSteps = @(
        @{ Name = "shared"; Path = "packages/shared" },
        @{ Name = "mcp-server"; Path = "packages/mcp-server" },
        @{ Name = "api"; Path = "packages/api" },
        @{ Name = "web"; Path = "packages/web" }
    )
    foreach ($step in $buildSteps) {
        Write-Host "  Building $($step.Name)..."
        Push-Location (Join-Path $ProjectRoot $step.Path)
        Invoke-Pnpm -CommandArgs @("run", "build")
        if ($LASTEXITCODE -ne 0) { Write-Err "Build failed: $($step.Name)"; Pop-Location; exit 1 }
        Pop-Location
        Write-Ok "$($step.Name)"
    }
} else {
    Write-Warn "Build skipped (-SkipBuild)"
}

Write-Step "Step 6/9 - Skills mount"
Mount-InstallerSkills -ProjectRoot $ProjectRoot

Write-Step "Step 7/9 - AI CLI tools"

$cliTools = @(
    @{ Name = "Claude"; Label = "Claude"; Cmd = "claude"; Pkg = "@anthropic-ai/claude-code" },
    @{ Name = "Codex"; Label = "Codex"; Cmd = "codex"; Pkg = "@openai/codex" },
    @{ Name = "Gemini"; Label = "Gemini"; Cmd = "gemini"; Pkg = "@google/gemini-cli" }
)

if (-not $SkipCli) {
    $missingTools = @($cliTools | Where-Object { -not (Resolve-ToolCommand -Name $_.Cmd) })
    $toolsToInstall = if ($missingTools.Count -gt 0 -and [Environment]::UserInteractive -and -not $env:CI) {
        Select-InstallerMultiChoice -Title "Missing agent CLIs" -Prompt "Choose which agent CLIs to install" -Options $missingTools
    } else { $missingTools }
    $npmInstallCommand = Resolve-ToolCommand -Name "npm"
    foreach ($tool in $cliTools) {
        $installed = $null -ne (Resolve-ToolCommand -Name $tool.Cmd)
        if ($installed) {
            Write-Ok "$($tool.Name) CLI already installed"
        } elseif ($toolsToInstall.Cmd -notcontains $tool.Cmd) {
            Write-Warn "$($tool.Name) CLI install skipped"
        } else {
            Write-Host "  Installing $($tool.Name) CLI..."
            try {
                if (-not $npmInstallCommand) { throw "npm command not found" }
                & $npmInstallCommand install -g $tool.Pkg 2>$null
                if (Resolve-ToolCommandWithRetry -Name $tool.Cmd -Attempts 6) {
                    Write-Ok "$($tool.Name) CLI installed"
                } else {
                    Write-ToolResolutionDiagnostics -Name $tool.Cmd
                    Write-Warn "$($tool.Name) CLI install completed but command was not visible yet"
                }
            } catch {
                Exit-InstallerIfCancelled -ErrorRecord $_ -Context "$($tool.Name) CLI install"
                Write-Warn "Could not install $($tool.Name) CLI: npm install -g $($tool.Pkg)"
            }
        }
    }
} else {
    Write-Warn "CLI tools install skipped (-SkipCli)"
}

Write-Step "Step 8/9 - Auth config"
Configure-InstallerAuth -ProjectRoot $ProjectRoot -State $authState

Apply-InstallerAuthEnv -State $authState -EnvFile $envFile

$hasClaude = $null -ne (Resolve-ToolCommandWithRetry -Name "claude" -Attempts 6)
$hasCodex = $null -ne (Resolve-ToolCommandWithRetry -Name "codex" -Attempts 6)
$hasGemini = $null -ne (Resolve-ToolCommandWithRetry -Name "gemini" -Attempts 6)

Write-Step "Step 9/9 - Verify and launch"

$artifacts = @("packages/shared/dist", "packages/mcp-server/dist/index.js", "packages/api/dist/index.js", "packages/web/.next")
$allGood = $true
foreach ($artifact in $artifacts) {
    $fullPath = Join-Path $ProjectRoot $artifact
    if (Test-Path $fullPath) { Write-Ok $artifact } else { Write-Err "$artifact - missing!"; $allGood = $false }
}

if (-not $allGood -and -not $SkipBuild) {
    Write-Err "Build artifacts missing. Check build output above."
    exit 1
}

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "  Clowder AI installed!" -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Project: $ProjectRoot"
Write-Host "  Node:    $(node --version)"
Write-Host "  Redis:   $(if ($hasRedis) { 'available' } else { 'not configured' })"
Write-Host "  Claude:  $(if ($hasClaude) { 'ready' } else { 'not installed' })"
Write-Host "  Codex:   $(if ($hasCodex) { 'ready' } else { 'not installed' })"
Write-Host "  Gemini:  $(if ($hasGemini) { 'ready' } else { 'not installed' })"
Write-Host ""
Write-Host "  Start the app:" -ForegroundColor Cyan
$startCmd = ".\scripts\start-windows.ps1"
Write-Host "    $startCmd" -ForegroundColor White
Write-Host ""
$frontendPort = Get-InstallerEnvValueFromFile -EnvFile $envFile -Key "FRONTEND_PORT"
if (-not $frontendPort) { $frontendPort = "3004" }
Write-Host "  Then open http://localhost:$frontendPort" -ForegroundColor Cyan
Write-Host ""

if ($Start) {
    Write-Host "  Auto-starting..." -ForegroundColor Cyan
    $startArgs = @("-Quick")
    & (Join-Path $ProjectRoot "scripts\start-windows.ps1") @startArgs
}
