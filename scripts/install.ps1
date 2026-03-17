<#
.SYNOPSIS
  Clowder AI — Windows Repo-Local Install Helper
  猫猫咖啡 Windows 仓库内安装助手

.DESCRIPTION
  Installs prerequisites and sets up the current checked-out clowder-ai repo.
  Clone or download the repo first, then run this helper from inside it.
  Steps: env detect → Node/pnpm install → Redis → repo-local build → skills mount
         → AI CLI tools → auth config → .env → verify & optionally start

.EXAMPLE
  # From repo root:
  .\scripts\install.ps1
  # Memory mode + auto-start:
  .\scripts\install.ps1 -Memory -Start
#>

param(
    [switch]$Memory,
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
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
}

function Resolve-PnpmCommand { Resolve-ToolCommand -Name "pnpm" }
function Invoke-Pnpm { param([string[]]$CommandArgs) Invoke-ToolCommand -Name "pnpm" -CommandArgs $CommandArgs }

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
        Write-Warn "No .git directory detected — git-dependent features will be unavailable"
    }
    return $projectRoot
}

# ── Step 1: Environment detection ──────────────────────────
Write-Step "Step 1/9 - Detect environment"

if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Err "PowerShell 5.0+ required (current: $($PSVersionTable.PSVersion))"
    exit 1
}
Write-Ok "PowerShell $($PSVersionTable.PSVersion)"

$hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
if ($hasWinget) { Write-Ok "winget available" } else { Write-Warn "winget not found — manual install may be needed" }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Err "Git not found. Install from https://git-scm.com/ and re-run."
    exit 1
}
Write-Ok "Git: $(git --version)"

$ProjectRoot = Resolve-ProjectRoot
$authState = New-InstallerAuthState -ProjectRoot $ProjectRoot

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
            if ($nodeRaw) {
                Write-Ok "Node.js $nodeRaw installed"
                $nodeOk = $true
            }
        } catch {}
        if (-not $nodeOk) {
            Write-Warn "winget Node.js install failed — falling back to manual prerequisite check"
        }
    }
    if (-not $nodeOk) {
        Write-Err "Node.js >= 20 required. Install from https://nodejs.org/"
        exit 1
    }
}

$pnpmOk = $false
try {
    $pnpmCommand = Resolve-PnpmCommand
    if ($pnpmCommand) { $pnpmRaw = & $pnpmCommand --version 2>$null }
    if ($pnpmRaw -and $pnpmRaw -match '^(\d+)\.' -and [int]$Matches[1] -ge 8) {
        Write-Ok "pnpm $pnpmRaw"
        $pnpmOk = $true
    }
} catch {}

if (-not $pnpmOk) {
    Write-Host "  Installing pnpm..."
    $corepackCommand = Resolve-ToolCommand -Name "corepack"
    if ($corepackCommand) {
        try {
            & $corepackCommand enable 2>$null
            & $corepackCommand install -g pnpm@latest 2>$null
            Refresh-Path
            $pnpmCommand = Resolve-PnpmCommand
            if ($pnpmCommand) {
                $pnpmRaw = & $pnpmCommand --version 2>$null
                Write-Ok "pnpm $pnpmRaw (via corepack)"
                $pnpmOk = $true
            } else {
                throw "pnpm shim missing after corepack install"
            }
        } catch {}
    }
    if (-not $pnpmOk) {
        $npmCommand = Resolve-ToolCommand -Name "npm"
        try {
            if (-not $npmCommand) {
                throw "npm command not found"
            }
            & $npmCommand install -g pnpm 2>$null
            Refresh-Path
            $pnpmCommand = Resolve-PnpmCommand
            if ($pnpmCommand) {
                $pnpmRaw = & $pnpmCommand --version 2>$null
                Write-Ok "pnpm $pnpmRaw (via npm)"
                $pnpmOk = $true
            } else {
                throw "pnpm shim missing after npm install"
            }
        } catch {}
    }
    if (-not $pnpmOk) {
        Write-ToolResolutionDiagnostics -Name "pnpm"
        Write-Err "Could not install pnpm. Run: npm install -g pnpm"
        exit 1
    }
}

Write-Step "Step 3/9 - Redis"

$hasRedis = Ensure-WindowsRedis -ProjectRoot $ProjectRoot -Memory:$Memory

Write-Step "Step 4/9 - Prepare current repo and build"

Set-Location $ProjectRoot
Write-Ok "Using project root: $ProjectRoot"

Write-Host "  Running pnpm install..."
$frozenInstallOk = $false
try {
    Invoke-Pnpm -CommandArgs @("install", "--frozen-lockfile") 2>$null
    $frozenInstallOk = $LASTEXITCODE -eq 0
} catch {}
if (-not $frozenInstallOk) {
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

Write-Step "Step 5/9 - Skills mount"
Mount-InstallerSkills -ProjectRoot $ProjectRoot

Write-Step "Step 6/9 - AI CLI tools"

$cliTools = @(
    @{ Name = "Claude"; Cmd = "claude"; Pkg = "@anthropic-ai/claude-code" },
    @{ Name = "Codex"; Cmd = "codex"; Pkg = "@openai/codex" },
    @{ Name = "Gemini"; Cmd = "gemini"; Pkg = "@google/gemini-cli" }
)

if (-not $SkipCli) {
    $missingTools = @($cliTools | Where-Object { -not (Resolve-ToolCommand -Name $_.Cmd) })
    $toolsToInstall = $missingTools
    if ($missingTools.Count -gt 0 -and [Environment]::UserInteractive -and -not $env:CI) {
        Write-Host "  Missing agent CLIs:"
        for ($i = 0; $i -lt $missingTools.Count; $i++) {
            Write-Host "    $($i + 1)) $($missingTools[$i].Name)"
        }
        $selection = Read-Host "    Install which? (Enter=all, 0=none, e.g. 1,2)"
        if ($selection -eq "0") {
            $toolsToInstall = @()
        } elseif ($selection) {
            $picked = @()
            foreach ($rawIndex in ($selection -split ",")) {
                $index = 0
                if ([int]::TryParse($rawIndex.Trim(), [ref]$index) -and $index -ge 1 -and $index -le $missingTools.Count) {
                    $picked += $missingTools[$index - 1]
                }
            }
            if ($picked.Count -gt 0) { $toolsToInstall = @($picked | Select-Object -Unique) }
        }
    }
    foreach ($tool in $cliTools) {
        $installed = $null -ne (Resolve-ToolCommand -Name $tool.Cmd)
        if ($installed) {
            Write-Ok "$($tool.Name) CLI already installed"
        } elseif ($toolsToInstall.Cmd -notcontains $tool.Cmd) {
            Write-Warn "$($tool.Name) CLI install skipped"
        } else {
            Write-Host "  Installing $($tool.Name) CLI..."
            try {
                Invoke-ToolCommand -Name "npm" -Args @("install", "-g", $tool.Pkg) 2>$null
                Refresh-Path
                if (Resolve-ToolCommand -Name $tool.Cmd) {
                    Write-Ok "$($tool.Name) CLI installed"
                } else {
                    Write-Warn "$($tool.Name) CLI install may need PATH refresh — restart terminal"
                }
            } catch {
                Write-Warn "Could not install $($tool.Name) CLI: npm install -g $($tool.Pkg)"
            }
        }
    }
} else {
    Write-Warn "CLI tools install skipped (-SkipCli)"
}

Write-Step "Step 7/9 - Auth config"
Configure-InstallerAuth -ProjectRoot $ProjectRoot -State $authState

Write-Step "Step 8/9 - Generate .env"

$envFile = Join-Path $ProjectRoot ".env"
$envExample = Join-Path $ProjectRoot ".env.example"

if (Test-Path $envFile) {
    Write-Ok ".env already exists — skipping"
} elseif (Test-Path $envExample) {
    Copy-Item $envExample $envFile
    Write-Ok ".env created from .env.example"
    Write-Warn "Edit .env to add your API keys and customize ports"
} else {
    Write-Warn ".env.example not found — creating minimal .env"
    @"
FRONTEND_PORT=3003
API_SERVER_PORT=3004
NEXT_PUBLIC_API_URL=http://localhost:3004
REDIS_PORT=6379
REDIS_URL=redis://localhost:6379
"@ | Out-File -FilePath $envFile -Encoding utf8
    Write-Ok "Minimal .env created"
}

Apply-InstallerAuthEnv -State $authState -EnvFile $envFile

$hasClaude = $null -ne (Resolve-ToolCommand -Name "claude")
$hasCodex = $null -ne (Resolve-ToolCommand -Name "codex")
$hasGemini = $null -ne (Resolve-ToolCommand -Name "gemini")

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
Write-Host "  Redis:   $(if ($hasRedis) { 'available' } else { 'not found (use -Memory)' })"
Write-Host "  Claude:  $(if ($hasClaude) { 'ready' } else { 'not installed' })"
Write-Host "  Codex:   $(if ($hasCodex) { 'ready' } else { 'not installed' })"
Write-Host "  Gemini:  $(if ($hasGemini) { 'ready' } else { 'not installed' })"
Write-Host ""
Write-Host "  Start the app:" -ForegroundColor Cyan
$startCmd = ".\scripts\start-windows.ps1"
if ($Memory -or -not $hasRedis) { $startCmd += " -Memory" }
Write-Host "    $startCmd" -ForegroundColor White
Write-Host ""
Write-Host "  Then open http://localhost:3003" -ForegroundColor Cyan
Write-Host ""

if ($Start) {
    Write-Host "  Auto-starting..." -ForegroundColor Cyan
    $startArgs = @("-Quick")
    if ($Memory -or -not $hasRedis) { $startArgs += "-Memory" }
    & (Join-Path $ProjectRoot "scripts\start-windows.ps1") @startArgs
}
