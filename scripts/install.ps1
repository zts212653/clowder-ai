<#
.SYNOPSIS
  Clowder AI — Windows One-Click Installer
  猫猫咖啡 Windows 一键安装脚本

.DESCRIPTION
  Installs all prerequisites and sets up Clowder AI on a bare Windows 11 machine.
  Steps: env detect → Node/pnpm install → Redis → clone/build → skills mount
         → AI CLI tools → auth config → .env → verify & start

.EXAMPLE
  # From repo root:
  .\scripts\install.ps1
  # From any directory (auto-clones):
  powershell -ExecutionPolicy Bypass -File install.ps1
#>

param(
    [switch]$SkipRedis,
    [switch]$SkipBuild,
    [switch]$SkipCli,
    [string]$RepoUrl = "https://github.com/zts212653/clowder-ai.git",
    [string]$Branch = "main"
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

# ── Step 1: Environment detection ──────────────────────────
Write-Step "Step 1/9 - Detect environment"

if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Err "PowerShell 5.0+ required (current: $($PSVersionTable.PSVersion))"
    exit 1
}
Write-Ok "PowerShell $($PSVersionTable.PSVersion)"

$hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
if ($hasWinget) { Write-Ok "winget available" } else { Write-Warn "winget not found — manual install may be needed" }

# Git (required prerequisite per F113 spec)
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Err "Git not found. Install from https://git-scm.com/ and re-run."
    exit 1
}
Write-Ok "Git: $(git --version)"

# ── Step 2: Node.js and pnpm ──────────────────────────────
Write-Step "Step 2/9 - Node.js and pnpm"

$nodeOk = $false
try {
    $nodeRaw = & node --version 2>$null
    if ($nodeRaw -match 'v(\d+)\.(\d+)') {
        $nodeMajor = [int]$Matches[1]
        $nodeMinor = [int]$Matches[2]
        # --env-file requires Node >= 20.6
        if ($nodeMajor -gt 20 -or ($nodeMajor -eq 20 -and $nodeMinor -ge 6)) {
            Write-Ok "Node.js $nodeRaw"
            $nodeOk = $true
        } else {
            Write-Warn "Node.js $nodeRaw too old (need >= 20.6 for --env-file), upgrading..."
        }
    }
} catch {}

if (-not $nodeOk) {
    if ($hasWinget) {
        Write-Host "  Installing Node.js LTS via winget..."
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent 2>$null
        Refresh-Path
        $nodeRaw = & node --version 2>$null
        if ($nodeRaw) {
            Write-Ok "Node.js $nodeRaw installed"
            $nodeOk = $true
        }
    }
    if (-not $nodeOk) {
        Write-Err "Node.js >= 20.6 required (for --env-file support). Install from https://nodejs.org/"
        exit 1
    }
}

# pnpm: corepack → npm fallback
$pnpmOk = $false
try {
    $pnpmRaw = & pnpm --version 2>$null
    if ($pnpmRaw -match '^(\d+)\.' -and [int]$Matches[1] -ge 8) {
        Write-Ok "pnpm $pnpmRaw"
        $pnpmOk = $true
    }
} catch {}

if (-not $pnpmOk) {
    Write-Host "  Installing pnpm..."
    try {
        & corepack enable 2>$null
        & corepack prepare pnpm@latest --activate 2>$null
        Refresh-Path
        $pnpmRaw = & pnpm --version 2>$null
        Write-Ok "pnpm $pnpmRaw (via corepack)"
        $pnpmOk = $true
    } catch {
        try {
            & npm install -g pnpm 2>$null
            Refresh-Path
            $pnpmRaw = & pnpm --version 2>$null
            Write-Ok "pnpm $pnpmRaw (via npm)"
            $pnpmOk = $true
        } catch {}
    }
    if (-not $pnpmOk) {
        Write-Err "Could not install pnpm. Run: npm install -g pnpm"
        exit 1
    }
}

# ── Step 3: Redis ──────────────────────────────────────────
Write-Step "Step 3/9 - Redis"

$hasRedis = $false
if (-not $SkipRedis) {
    try {
        $null = & redis-cli --version 2>$null
        Write-Ok "Redis CLI available"
        $hasRedis = $true
    } catch {
        Write-Warn "Redis not found — will use in-memory storage (data lost on restart)"
        Write-Warn "For persistent storage, install Redis for Windows:"
        Write-Warn "  https://github.com/redis-windows/redis-windows"
    }
} else {
    Write-Warn "Redis check skipped (-SkipRedis)"
}

# ── Step 4: Clone and build ───────────────────────────────
Write-Step "Step 4/9 - Clone and build"

$inRepo = $false
if (Test-Path "package.json") {
    $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
    if ($pkg.name -eq "cat-cafe" -or $pkg.name -eq "clowder-ai") {
        Write-Ok "Already in project root: $(Get-Location)"
        $inRepo = $true
    }
}

if (-not $inRepo) {
    $targetDir = Join-Path (Get-Location) "clowder-ai"
    if (Test-Path $targetDir) {
        Write-Ok "Directory exists: $targetDir"
        Set-Location $targetDir
    } else {
        Write-Host "  Cloning $RepoUrl ($Branch)..."
        & git clone --branch $Branch --single-branch $RepoUrl $targetDir
        if ($LASTEXITCODE -ne 0) { Write-Err "git clone failed"; exit 1 }
        Set-Location $targetDir
        Write-Ok "Cloned to $targetDir"
    }
}

$ProjectRoot = (Get-Location).Path

# Install dependencies
Write-Host "  Running pnpm install..."
& pnpm install --frozen-lockfile 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Frozen lockfile failed, retrying..."
    & pnpm install
    if ($LASTEXITCODE -ne 0) { Write-Err "pnpm install failed"; exit 1 }
}
Write-Ok "Dependencies installed"

# Build (shared → mcp-server → api → web)
if (-not $SkipBuild) {
    $buildSteps = @(
        @{ Name = "shared";     Path = "packages/shared" },
        @{ Name = "mcp-server"; Path = "packages/mcp-server" },
        @{ Name = "api";        Path = "packages/api" },
        @{ Name = "web";        Path = "packages/web" }
    )
    foreach ($step in $buildSteps) {
        Write-Host "  Building $($step.Name)..."
        Push-Location (Join-Path $ProjectRoot $step.Path)
        & pnpm run build
        if ($LASTEXITCODE -ne 0) { Write-Err "Build failed: $($step.Name)"; Pop-Location; exit 1 }
        Pop-Location
        Write-Ok "$($step.Name)"
    }
} else {
    Write-Warn "Build skipped (-SkipBuild)"
}

# ── Step 5: Skills mount ──────────────────────────────────
Write-Step "Step 5/9 - Skills mount"

$skillsSource = Join-Path $ProjectRoot "cat-cafe-skills"
$cliDirs = @("$env:USERPROFILE\.claude", "$env:USERPROFILE\.codex", "$env:USERPROFILE\.gemini")

if (Test-Path $skillsSource) {
    foreach ($cliDir in $cliDirs) {
        $skillsTarget = Join-Path $cliDir "skills"
        # Create parent dir if needed
        if (-not (Test-Path $cliDir)) { New-Item -Path $cliDir -ItemType Directory -Force | Out-Null }

        if (Test-Path $skillsTarget) {
            Write-Ok "Skills already mounted: $skillsTarget"
            continue
        }

        try {
            # Prefer directory junction (no admin required)
            cmd /c mklink /J "$skillsTarget" "$skillsSource" 2>$null | Out-Null
            if (Test-Path $skillsTarget) {
                Write-Ok "Skills mounted (junction): $skillsTarget"
            } else {
                throw "junction failed"
            }
        } catch {
            Write-Warn "Could not create junction for $skillsTarget"
            Write-Warn "Run as Administrator, or manually: mklink /J `"$skillsTarget`" `"$skillsSource`""
        }
    }
} else {
    Write-Warn "cat-cafe-skills/ not found — skills mount skipped"
}

# ── Step 6: AI CLI tools ─────────────────────────────────
Write-Step "Step 6/9 - AI CLI tools"

if (-not $SkipCli) {
    $cliTools = @(
        @{ Name = "Claude"; Cmd = "claude"; Pkg = "@anthropic-ai/claude-code" },
        @{ Name = "Codex";  Cmd = "codex";  Pkg = "@openai/codex" },
        @{ Name = "Gemini"; Cmd = "gemini"; Pkg = "@google/gemini-cli" }
    )
    foreach ($tool in $cliTools) {
        $installed = $null -ne (Get-Command $tool.Cmd -ErrorAction SilentlyContinue)
        if ($installed) {
            Write-Ok "$($tool.Name) CLI already installed"
        } else {
            Write-Host "  Installing $($tool.Name) CLI..."
            try {
                & npm install -g $tool.Pkg 2>$null
                Refresh-Path
                if (Get-Command $tool.Cmd -ErrorAction SilentlyContinue) {
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

# ── Step 7: Auth config placeholder ──────────────────────
Write-Step "Step 7/9 - Auth config"
Write-Warn "Authenticate CLI tools after installation:"
Write-Warn "  Claude: run 'claude' and follow OAuth flow"
Write-Warn "  Codex:  set OPENAI_API_KEY in .env"
Write-Warn "  Gemini: run 'gemini' and follow OAuth flow"

# ── Step 8: Generate .env ─────────────────────────────────
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

# ── Step 9: Verify and summarize ──────────────────────────
Write-Step "Step 9/9 - Verify and launch"

$artifacts = @("packages/shared/dist", "packages/mcp-server/dist/index.js",
               "packages/api/dist/index.js", "packages/web/.next")
$allGood = $true
foreach ($artifact in $artifacts) {
    $fullPath = Join-Path $ProjectRoot $artifact
    if (Test-Path $fullPath) { Write-Ok $artifact }
    else { Write-Err "$artifact - missing!"; $allGood = $false }
}

if (-not $allGood -and -not $SkipBuild) {
    Write-Err "Build artifacts missing. Check build output above."
    exit 1
}

$hasClaude = $null -ne (Get-Command claude -ErrorAction SilentlyContinue)
$hasCodex = $null -ne (Get-Command codex -ErrorAction SilentlyContinue)
$hasGemini = $null -ne (Get-Command gemini -ErrorAction SilentlyContinue)

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
if (-not $hasRedis) { $startCmd += " -Memory" }
Write-Host "    $startCmd" -ForegroundColor White
Write-Host ""
Write-Host "  Then open http://localhost:3003" -ForegroundColor Cyan
Write-Host ""
