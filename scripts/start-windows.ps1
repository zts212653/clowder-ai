<#
.SYNOPSIS
  Clowder AI (Cat Cafe) — Windows Startup Script
  猫猫咖啡 Windows 启动脚本

.DESCRIPTION
  Starts API server and Frontend (Next.js) with .env loading.
  Optionally starts Redis if available.

.EXAMPLE
  .\scripts\start-windows.ps1              # normal start
  .\scripts\start-windows.ps1 -Quick       # skip rebuild
  .\scripts\start-windows.ps1 -Memory      # skip Redis, use in-memory storage
  .\scripts\start-windows.ps1 -ProdWeb     # production frontend build
#>

param(
    [switch]$Quick,
    [switch]$Memory,
    [switch]$ProdWeb
)

$ErrorActionPreference = "Stop"

# ── Helpers ─────────────────────────────────────────────────
function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

# ── Resolve project root ────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

Write-Host "Cat Cafe - Windows Startup" -ForegroundColor Cyan
Write-Host "=========================="

# ── Load .env ───────────────────────────────────────────────
$envFile = Join-Path $ProjectRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line -split "=", 2
            if ($parts.Count -eq 2) {
                $key = $parts[0].Trim()
                $val = $parts[1].Trim().Trim('"').Trim("'")
                [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
            }
        }
    }
    Write-Ok ".env loaded"
} else {
    Write-Warn ".env not found — using defaults"
}

# ── Ports ───────────────────────────────────────────────────
$ApiPort = if ($env:API_SERVER_PORT) { $env:API_SERVER_PORT } else { "3004" }
$WebPort = if ($env:FRONTEND_PORT) { $env:FRONTEND_PORT } else { "3003" }
$RedisPort = if ($env:REDIS_PORT) { $env:REDIS_PORT } else { "6379" }

# ── Kill existing port processes ────────────────────────────
function Stop-PortProcess {
    param([int]$Port, [string]$Name)
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($connections) {
        foreach ($conn in $connections) {
            Write-Warn "Port $Port ($Name) in use by PID $($conn.OwningProcess) — stopping"
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }
}

Write-Step "Check ports"
Stop-PortProcess -Port ([int]$ApiPort) -Name "API"
Stop-PortProcess -Port ([int]$WebPort) -Name "Frontend"

# ── Storage (Redis or Memory) ──────────────────────────────
Write-Step "Storage"

$useRedis = -not $Memory
$startedRedis = $false

if ($useRedis) {
    # Check if Redis is already running
    try {
        $redisPing = & redis-cli -p $RedisPort ping 2>$null
        if ($redisPing -eq "PONG") {
            Write-Ok "Redis already running on port $RedisPort"
            $env:REDIS_URL = "redis://localhost:$RedisPort"
        } else {
            throw "not running"
        }
    } catch {
        Write-Warn "Redis not running on port $RedisPort"
        # Try to start Redis
        try {
            $redisExe = Get-Command redis-server -ErrorAction SilentlyContinue
            if ($redisExe) {
                Write-Host "  Starting Redis on port $RedisPort..."
                Start-Process -FilePath "redis-server" -ArgumentList "--port $RedisPort --bind 127.0.0.1" -WindowStyle Hidden
                Start-Sleep -Seconds 2
                $redisPing = & redis-cli -p $RedisPort ping 2>$null
                if ($redisPing -eq "PONG") {
                    Write-Ok "Redis started on port $RedisPort"
                    $env:REDIS_URL = "redis://localhost:$RedisPort"
                    $startedRedis = $true
                } else {
                    Write-Warn "Redis start failed — falling back to memory storage"
                    $useRedis = $false
                }
            } else {
                Write-Warn "Redis not installed — using memory storage"
                Write-Warn "Install Memurai for persistent storage: https://www.memurai.com/"
                $useRedis = $false
            }
        } catch {
            Write-Warn "Redis start failed — using memory storage"
            $useRedis = $false
        }
    }
}

if (-not $useRedis) {
    Write-Warn "Memory mode — data will be lost on restart"
    Remove-Item Env:REDIS_URL -ErrorAction SilentlyContinue
    $env:MEMORY_STORE = "1"
}

# ── Build (unless -Quick) ──────────────────────────────────
if (-not $Quick) {
    Write-Step "Build packages"

    Write-Host "  Building shared..."
    Push-Location (Join-Path $ProjectRoot "packages/shared")
    & pnpm run build
    Pop-Location
    Write-Ok "shared"

    Write-Host "  Building mcp-server..."
    Push-Location (Join-Path $ProjectRoot "packages/mcp-server")
    & pnpm run build
    Pop-Location
    Write-Ok "mcp-server"

    Write-Host "  Building api..."
    Push-Location (Join-Path $ProjectRoot "packages/api")
    & pnpm run build
    Pop-Location
    Write-Ok "api"

    if ($ProdWeb) {
        Write-Host "  Building web (production)..."
        Push-Location (Join-Path $ProjectRoot "packages/web")
        & pnpm run build
        Pop-Location
        Write-Ok "web (production)"
    }
} else {
    Write-Step "Skip build (-Quick)"
}

# ── Configure MCP server path ──────────────────────────────
$mcpPath = Join-Path $ProjectRoot "packages/mcp-server/dist/index.js"
if (Test-Path $mcpPath) {
    $env:CAT_CAFE_MCP_SERVER_PATH = $mcpPath
    Write-Ok "MCP server path: $mcpPath"
}

# ── Start services ──────────────────────────────────────────
Write-Step "Start services"

# Track background jobs for cleanup
$jobs = @()

# API Server (use --env-file for .env loading on Windows)
Write-Host "  Starting API Server (port $ApiPort)..."
$apiJob = Start-Job -ScriptBlock {
    param($root, $envFile)
    Set-Location (Join-Path $root "packages/api")
    if (Test-Path $envFile) {
        & node --env-file=$envFile dist/index.js 2>&1
    } else {
        & node dist/index.js 2>&1
    }
} -ArgumentList $ProjectRoot, $envFile
$jobs += $apiJob

Start-Sleep -Seconds 2

# Frontend
if ($ProdWeb) {
    # Production mode: next start
    $nextDir = Join-Path $ProjectRoot "packages/web/.next"
    if (-not (Test-Path $nextDir)) {
        Write-Err ".next directory not found — run without -Quick first to build"
        exit 1
    }
    Write-Host "  Starting Frontend (port $WebPort, production)..."
    $webJob = Start-Job -ScriptBlock {
        param($root, $port)
        Set-Location (Join-Path $root "packages/web")
        $env:PORT = $port
        & pnpm exec next start -p $port -H 0.0.0.0 2>&1
    } -ArgumentList $ProjectRoot, $WebPort
} else {
    # Development mode: next dev
    Write-Host "  Starting Frontend (port $WebPort, dev)..."
    $webJob = Start-Job -ScriptBlock {
        param($root, $port)
        Set-Location (Join-Path $root "packages/web")
        $env:PORT = $port
        $env:NEXT_IGNORE_INCORRECT_LOCKFILE = "1"
        & pnpm exec next dev -p $port 2>&1
    } -ArgumentList $ProjectRoot, $WebPort
}
$jobs += $webJob

Start-Sleep -Seconds 3

# ── Status ──────────────────────────────────────────────────
$storageMode = if ($useRedis) { "Redis (redis://localhost:$RedisPort)" } else { "Memory (restart loses data)" }
$frontendMode = if ($ProdWeb) { "production (PWA enabled)" } else { "development (hot reload)" }

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "  Cat Cafe started!" -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Frontend: http://localhost:$WebPort"
Write-Host "  API:      http://localhost:$ApiPort"
Write-Host "  Storage:  $storageMode"
Write-Host "  Frontend: $frontendMode"
Write-Host ""
Write-Host "  Press Ctrl+C to stop all services" -ForegroundColor Yellow
Write-Host ""

# ── Wait and cleanup ────────────────────────────────────────
try {
    while ($true) {
        # Check if jobs are still running
        $running = $jobs | Where-Object { $_.State -eq "Running" }
        if ($running.Count -eq 0) {
            Write-Warn "All services stopped"
            break
        }

        # Print any job output
        foreach ($job in $jobs) {
            $output = Receive-Job -Job $job -ErrorAction SilentlyContinue
            if ($output) {
                foreach ($line in $output) {
                    Write-Host $line
                }
            }
        }

        Start-Sleep -Seconds 2
    }
} finally {
    Write-Host "`nShutting down..." -ForegroundColor Yellow

    foreach ($job in $jobs) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }

    if ($startedRedis) {
        try {
            & redis-cli -p $RedisPort shutdown save 2>$null
            Write-Ok "Redis stopped"
        } catch {
            Write-Warn "Could not stop Redis gracefully"
        }
    }

    Write-Host "Goodbye!" -ForegroundColor Cyan
}
