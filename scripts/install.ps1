<#
.SYNOPSIS
  Clowder AI (Cat Cafe) — Windows One-Click Installer
  猫猫咖啡 Windows 一键安装脚本

.DESCRIPTION
  9-step installation:
    1. Detect OS & shell (Windows / PowerShell)
    2. Check prerequisites (Node >=20, pnpm >=8, Git)
    3. Check optional dependencies (Redis)
    4. Clone or verify repository
    5. Install npm dependencies (pnpm install)
    6. Generate .env from .env.example
    7. Build all packages (shared → mcp-server → api → web)
    8. Verify build artifacts
    9. Print success summary with next steps

.EXAMPLE
  # Run from repo root:
  .\scripts\install.ps1

  # Or from any directory (auto-clones):
  irm https://raw.githubusercontent.com/clowder-ai/cat-cafe/main/scripts/install.ps1 | iex
#>

param(
    [switch]$SkipRedis,
    [switch]$SkipBuild,
    [string]$RepoUrl = "https://github.com/clowder-ai/cat-cafe.git",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

# ── Colors ──────────────────────────────────────────────────
function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

# ── Step 1: Detect OS & Shell ───────────────────────────────
Write-Step "Step 1/9 — Detect OS & Shell"

$isWindows = $true
if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Err "PowerShell 5.0+ required (current: $($PSVersionTable.PSVersion))"
    exit 1
}
Write-Ok "PowerShell $($PSVersionTable.PSVersion) on Windows"

# ── Step 2: Check prerequisites ─────────────────────────────
Write-Step "Step 2/9 — Check prerequisites"

$missingDeps = @()

# Node.js >= 20
$nodeVersion = $null
try {
    $nodeRaw = & node --version 2>$null
    if ($nodeRaw -match 'v(\d+)\.') {
        $nodeMajor = [int]$Matches[1]
        if ($nodeMajor -ge 20) {
            Write-Ok "Node.js $nodeRaw"
            $nodeVersion = $nodeRaw
        } else {
            Write-Err "Node.js $nodeRaw (need >= 20)"
            $missingDeps += "Node.js >= 20 (https://nodejs.org/)"
        }
    }
} catch {
    Write-Err "Node.js not found"
    $missingDeps += "Node.js >= 20 (https://nodejs.org/)"
}

# pnpm >= 8
try {
    $pnpmRaw = & pnpm --version 2>$null
    if ($pnpmRaw -match '^(\d+)\.') {
        $pnpmMajor = [int]$Matches[1]
        if ($pnpmMajor -ge 8) {
            Write-Ok "pnpm $pnpmRaw"
        } else {
            Write-Err "pnpm $pnpmRaw (need >= 8)"
            $missingDeps += "pnpm >= 8 (npm i -g pnpm)"
        }
    }
} catch {
    Write-Warn "pnpm not found — attempting install via corepack"
    try {
        & corepack enable 2>$null
        & corepack prepare pnpm@latest --activate 2>$null
        $pnpmRaw = & pnpm --version 2>$null
        Write-Ok "pnpm $pnpmRaw (installed via corepack)"
    } catch {
        Write-Err "pnpm not found and corepack failed"
        $missingDeps += "pnpm >= 8 (npm i -g pnpm)"
    }
}

# Git
try {
    $gitRaw = & git --version 2>$null
    Write-Ok "Git: $gitRaw"
} catch {
    Write-Err "Git not found"
    $missingDeps += "Git (https://git-scm.com/)"
}

if ($missingDeps.Count -gt 0) {
    Write-Host ""
    Write-Err "Missing prerequisites:"
    foreach ($dep in $missingDeps) {
        Write-Host "    - $dep" -ForegroundColor Red
    }
    Write-Host "`nInstall the above and re-run this script." -ForegroundColor Yellow
    exit 1
}

# ── Step 3: Check optional dependencies ─────────────────────
Write-Step "Step 3/9 — Check optional dependencies"

$hasRedis = $false
if (-not $SkipRedis) {
    # Check for Redis — Windows users typically use Memurai or WSL Redis
    try {
        $redisRaw = & redis-cli --version 2>$null
        Write-Ok "Redis CLI: $redisRaw"
        $hasRedis = $true
    } catch {
        Write-Warn "Redis not found — will use in-memory storage (data lost on restart)"
        Write-Warn "For persistent storage, install Redis (Memurai or WSL)"
    }
} else {
    Write-Warn "Redis check skipped (-SkipRedis)"
}

# Claude CLI (optional — needed for AI agent features)
$hasClaude = $false
try {
    $claudeRaw = & claude --version 2>$null
    Write-Ok "Claude CLI: $claudeRaw"
    $hasClaude = $true
} catch {
    Write-Warn "Claude CLI not found — AI agent features will be unavailable"
    Write-Warn "Install: npm i -g @anthropic-ai/claude-code"
}

# ── Step 4: Clone or verify repository ──────────────────────
Write-Step "Step 4/9 — Clone or verify repository"

# Detect if we're already in the repo
$inRepo = $false
if (Test-Path "package.json") {
    $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
    if ($pkg.name -eq "cat-cafe" -or $pkg.name -eq "clowder-ai") {
        Write-Ok "Already in project root: $(Get-Location)"
        $inRepo = $true
    }
}

if (-not $inRepo) {
    $targetDir = Join-Path (Get-Location) "cat-cafe"
    if (Test-Path $targetDir) {
        Write-Ok "Directory exists: $targetDir"
        Set-Location $targetDir
    } else {
        Write-Host "  Cloning $RepoUrl ($Branch)..."
        & git clone --branch $Branch --single-branch $RepoUrl $targetDir
        if ($LASTEXITCODE -ne 0) {
            Write-Err "git clone failed"
            exit 1
        }
        Set-Location $targetDir
        Write-Ok "Cloned to $targetDir"
    }
}

$ProjectRoot = Get-Location

# ── Step 5: Install npm dependencies ────────────────────────
Write-Step "Step 5/9 — Install dependencies (pnpm install)"

& pnpm install --frozen-lockfile 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Frozen lockfile failed, retrying with update..."
    & pnpm install
    if ($LASTEXITCODE -ne 0) {
        Write-Err "pnpm install failed"
        exit 1
    }
}
Write-Ok "Dependencies installed"

# ── Step 6: Generate .env ───────────────────────────────────
Write-Step "Step 6/9 — Generate .env"

$envFile = Join-Path $ProjectRoot ".env"
$envExample = Join-Path $ProjectRoot ".env.example"

if (Test-Path $envFile) {
    Write-Ok ".env already exists — skipping (edit manually if needed)"
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

# ── Step 7: Build all packages ──────────────────────────────
Write-Step "Step 7/9 — Build packages"

if ($SkipBuild) {
    Write-Warn "Build skipped (-SkipBuild)"
} else {
    # Build order matters: shared → mcp-server → api (web uses next dev)
    $buildSteps = @(
        @{ Name = "shared";     Path = "packages/shared" },
        @{ Name = "mcp-server"; Path = "packages/mcp-server" },
        @{ Name = "api";        Path = "packages/api" }
    )

    foreach ($step in $buildSteps) {
        $stepPath = Join-Path $ProjectRoot $step.Path
        Write-Host "  Building $($step.Name)..."
        Push-Location $stepPath
        & pnpm run build
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Build failed for $($step.Name)"
            Pop-Location
            exit 1
        }
        Pop-Location
        Write-Ok "$($step.Name) built"
    }
}

# ── Step 8: Verify build artifacts ──────────────────────────
Write-Step "Step 8/9 — Verify build artifacts"

$artifacts = @(
    "packages/shared/dist",
    "packages/mcp-server/dist/index.js",
    "packages/api/dist/index.js"
)

$allGood = $true
foreach ($artifact in $artifacts) {
    $fullPath = Join-Path $ProjectRoot $artifact
    if (Test-Path $fullPath) {
        Write-Ok "$artifact"
    } else {
        Write-Err "$artifact — missing!"
        $allGood = $false
    }
}

if (-not $allGood -and -not $SkipBuild) {
    Write-Err "Some build artifacts are missing. Check the build output above."
    exit 1
}

# ── Step 9: Success summary ─────────────────────────────────
Write-Step "Step 9/9 — Installation complete!"

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "  Clowder AI installed successfully!" -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Project: $ProjectRoot"
Write-Host "  Node:    $nodeVersion"
Write-Host "  Redis:   $(if ($hasRedis) { 'available' } else { 'not found (use --memory)' })"
Write-Host "  Claude:  $(if ($hasClaude) { 'available' } else { 'not installed' })"
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Cyan
Write-Host "    1. Edit .env with your API keys"
Write-Host "    2. Start the app:"
Write-Host ""
if ($hasRedis) {
    Write-Host "       .\scripts\start-windows.ps1" -ForegroundColor White
} else {
    Write-Host "       .\scripts\start-windows.ps1 -Memory" -ForegroundColor White
}
Write-Host ""
Write-Host "    3. Open http://localhost:3003 in your browser"
Write-Host ""
