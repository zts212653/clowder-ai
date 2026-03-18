<#
.SYNOPSIS
  Clowder AI (Cat Cafe) - Windows Startup Script

.DESCRIPTION
  Starts API server and Frontend (Next.js) with .env loading.
  Optionally starts Redis if available.
  Default: production mode (next build + next start). Use -Dev for hot reload.

.EXAMPLE
  .\scripts\start-windows.ps1              # production mode (default)
  .\scripts\start-windows.ps1 -Quick       # skip rebuild
  .\scripts\start-windows.ps1 -Memory      # skip Redis, use in-memory storage
  .\scripts\start-windows.ps1 -Dev         # development mode (next dev, hot reload)
#>

param(
    [switch]$Quick,
    [switch]$Memory,
    [switch]$Dev
)

$ErrorActionPreference = "Stop"

# -- Helpers -------------------------------------------------
function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

# -- Resolve project root ------------------------------------
$ScriptPath = if ($PSCommandPath) { $PSCommandPath } elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path } else { $null }
if (-not $ScriptPath) {
    Write-Err "Could not resolve start-windows.ps1 path. Run with: powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1"
    exit 1
}
$ScriptDir = Split-Path -Parent $ScriptPath
. (Join-Path $ScriptDir "install-windows-helpers.ps1")
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

Write-Host "Cat Cafe - Windows Startup" -ForegroundColor Cyan
Write-Host "=========================="

# -- Load .env -----------------------------------------------
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
    Write-Warn ".env not found - using defaults"
}

$pnpmCommand = Resolve-ToolCommand -Name "pnpm"
if (-not $pnpmCommand) {
    Write-Err "pnpm not found. Run .\scripts\install.ps1 first."
    exit 1
}
Write-Ok "pnpm: $pnpmCommand"

# -- Ports ---------------------------------------------------
$ApiPort = if ($env:API_SERVER_PORT) { $env:API_SERVER_PORT } else { "3004" }
$WebPort = if ($env:FRONTEND_PORT) { $env:FRONTEND_PORT } else { "3003" }
$RedisPort = if ($env:REDIS_PORT) { $env:REDIS_PORT } else { "6379" }
$LocalRedisUrls = @("redis://localhost:$RedisPort", "redis://127.0.0.1:$RedisPort")

# -- Kill existing port processes ----------------------------
function Stop-PortProcess {
    param([int]$Port, [string]$Name)
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($connections) {
        foreach ($conn in $connections) {
            Write-Warn "Port $Port ($Name) in use by PID $($conn.OwningProcess) - stopping"
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }
}

Write-Step "Check ports"
Stop-PortProcess -Port ([int]$ApiPort) -Name "API"
Stop-PortProcess -Port ([int]$WebPort) -Name "Frontend"

# -- Storage (Redis or Memory) -------------------------------
Write-Step "Storage"

$useRedis = -not $Memory
$startedRedis = $false
$redisLayout = Resolve-PortableRedisLayout -ProjectRoot $ProjectRoot
$redisCliPath = $null
$redisServerPath = $null
$redisSource = $null
$redisLogFile = Join-Path $redisLayout.Logs "redis-$RedisPort.log"
$redisPidFile = Join-Path $redisLayout.Data "redis-$RedisPort.pid"
$configuredRedisUrl = if ($env:REDIS_URL) { $env:REDIS_URL.Trim() } else { "" }
$useExternalRedis = $useRedis -and $configuredRedisUrl -and ($LocalRedisUrls -notcontains $configuredRedisUrl)

if ($useExternalRedis) {
    Write-Ok "Using external Redis: $configuredRedisUrl"
} elseif ($useRedis) {
    $redisCommands = Resolve-PortableRedisBinaries -ProjectRoot $ProjectRoot
    if (-not $redisCommands) {
        $redisCommands = Resolve-GlobalRedisBinaries
    }
    if ($redisCommands) {
        $redisCliPath = $redisCommands.CliPath
        $redisServerPath = $redisCommands.ServerPath
        $redisSource = $redisCommands.Source
        Write-Ok "Redis binaries resolved ($redisSource): $($redisCommands.BinDir)"
    }
    # Check if Redis is already running
    try {
        if (-not $redisCliPath) {
            throw "redis-cli unavailable"
        }
        $redisPing = & $redisCliPath -p $RedisPort ping 2>$null
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
            if ($redisServerPath) {
                New-Item -Path $redisLayout.Data -ItemType Directory -Force | Out-Null
                New-Item -Path $redisLayout.Logs -ItemType Directory -Force | Out-Null
                $redisArgs = @("--port", $RedisPort, "--bind", "127.0.0.1", "--dir", $redisLayout.Data, "--logfile", $redisLogFile, "--pidfile", $redisPidFile)
                Write-Host "  Starting Redis on port $RedisPort ($redisSource)..."
                Start-Process -FilePath $redisServerPath -ArgumentList $redisArgs -WindowStyle Hidden
                Start-Sleep -Seconds 2
                $redisPing = & $redisCliPath -p $RedisPort ping 2>$null
                if ($redisPing -eq "PONG") {
                    Write-Ok "Redis started on port $RedisPort"
                    $env:REDIS_URL = "redis://localhost:$RedisPort"
                    $startedRedis = $true
                } else {
                    Write-Warn "Redis start failed - falling back to memory storage"
                    $useRedis = $false
                }
            } else {
                Write-Warn "Redis not installed - using memory storage"
                Write-Warn "Run .\\scripts\\install.ps1 again to fetch the project-local Redis bundle into .cat-cafe/redis/windows."
                $useRedis = $false
            }
        } catch {
            Write-Warn "Redis start failed - using memory storage"
            Write-InstallerExceptionDetails -Context "Redis start" -ErrorRecord $_
            $useRedis = $false
        }
    }
}

if (-not $useRedis) {
    Write-Warn "Memory mode - data will be lost on restart"
    Remove-Item Env:REDIS_URL -ErrorAction SilentlyContinue
    $env:MEMORY_STORE = "1"
}

# -- Build (unless -Quick) ----------------------------------
if (-not $Quick) {
    Write-Step "Build packages"

    Write-Host "  Building shared..."
    Push-Location (Join-Path $ProjectRoot "packages/shared")
    & $pnpmCommand run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Err "Build failed: shared"; exit 1 }
    Pop-Location
    Write-Ok "shared"

    Write-Host "  Building mcp-server..."
    Push-Location (Join-Path $ProjectRoot "packages/mcp-server")
    & $pnpmCommand run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Err "Build failed: mcp-server"; exit 1 }
    Pop-Location
    Write-Ok "mcp-server"

    Write-Host "  Building api..."
    Push-Location (Join-Path $ProjectRoot "packages/api")
    & $pnpmCommand run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Err "Build failed: api"; exit 1 }
    Pop-Location
    Write-Ok "api"

    if (-not $Dev) {
        Write-Host "  Building web (production)..."
        Push-Location (Join-Path $ProjectRoot "packages/web")
        & $pnpmCommand run build
        if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Err "Build failed: web"; exit 1 }
        Pop-Location
        Write-Ok "web (production)"
    }
} else {
    Write-Step "Skip build (-Quick)"
}

# -- Configure MCP server path -------------------------------
$mcpPath = Join-Path $ProjectRoot "packages/mcp-server/dist/index.js"
if (Test-Path $mcpPath) {
    $env:CAT_CAFE_MCP_SERVER_PATH = $mcpPath
    Write-Ok "MCP server path: $mcpPath"
}

$apiEntry = Join-Path $ProjectRoot "packages/api/dist/index.js"
if (-not (Test-Path $apiEntry)) {
    Write-Err "API build artifact not found - run without -Quick first to build"
    exit 1
}

$nextDir = Join-Path $ProjectRoot "packages/web/.next"
if (-not $Dev -and -not (Test-Path $nextDir)) {
    Write-Err ".next directory not found - run without -Quick first to build"
    exit 1
}

# -- Start services ------------------------------------------
Write-Step "Start services"

# Track background jobs for cleanup
$jobs = @()
$runtimeEnvOverrides = @{
    REDIS_URL = $env:REDIS_URL
    MEMORY_STORE = $env:MEMORY_STORE
    CAT_CAFE_MCP_SERVER_PATH = $env:CAT_CAFE_MCP_SERVER_PATH
}

# API Server
# Env vars are loaded into this process (line 42-53) and inherited by Start-Job.
# No --env-file needed - avoids depending on Node's --env-file support here.
Write-Host "  Starting API Server (port $ApiPort)..."
$apiJob = Start-Job -Name "api" -ScriptBlock {
    param($root, $envFile, $runtimeEnvOverrides)
    Set-Location (Join-Path $root "packages/api")
    # Load .env into job process (Start-Job inherits parent env,
    # but re-load to be safe if process env was not fully propagated)
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith("#")) {
                $parts = $line -split "=", 2
                if ($parts.Count -eq 2) {
                    $k = $parts[0].Trim()
                    $v = $parts[1].Trim().Trim('"').Trim("'")
                    [System.Environment]::SetEnvironmentVariable($k, $v, "Process")
                }
            }
        }
    }
    foreach ($entry in $runtimeEnvOverrides.GetEnumerator()) {
        if ($null -eq $entry.Value -or $entry.Value -eq "") {
            [System.Environment]::SetEnvironmentVariable($entry.Key, $null, "Process")
        } else {
            [System.Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, "Process")
        }
    }
    & node dist/index.js 2>&1
} -ArgumentList $ProjectRoot, $envFile, $runtimeEnvOverrides
$jobs += $apiJob

Start-Sleep -Seconds 2

# Frontend
if ($Dev) {
    # Development mode: next dev (hot reload)
    Write-Host "  Starting Frontend (port $WebPort, dev)..."
    $webJob = Start-Job -Name "web" -ScriptBlock {
        param($root, $port, $pnpmPath)
        Set-Location (Join-Path $root "packages/web")
        $env:PORT = $port
        $env:NEXT_IGNORE_INCORRECT_LOCKFILE = "1"
        & $pnpmPath exec next dev -p $port 2>&1
    } -ArgumentList $ProjectRoot, $WebPort, $pnpmCommand
} else {
    # Production mode: next start (default - avoids #105 issues)
    Write-Host "  Starting Frontend (port $WebPort, production)..."
    $webJob = Start-Job -Name "web" -ScriptBlock {
        param($root, $port, $pnpmPath)
        Set-Location (Join-Path $root "packages/web")
        $env:PORT = $port
        & $pnpmPath exec next start -p $port -H 0.0.0.0 2>&1
    } -ArgumentList $ProjectRoot, $WebPort, $pnpmCommand
}
$jobs += $webJob

Start-Sleep -Seconds 3

# -- Status --------------------------------------------------
$effectiveRedisUrl = if ($env:REDIS_URL) { $env:REDIS_URL } else { "" }
$storageMode = if ($useRedis -and $effectiveRedisUrl) { "Redis ($effectiveRedisUrl)" } elseif ($useRedis) { "Redis (redis://localhost:$RedisPort)" } else { "Memory (restart loses data)" }
$frontendMode = if ($Dev) { "development (hot reload)" } else { "production (PWA enabled)" }

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

# -- Wait and cleanup ----------------------------------------
try {
    while ($true) {
        # Print any job output
        foreach ($job in $jobs) {
            $output = Receive-Job -Job $job -ErrorAction SilentlyContinue
            if ($output) {
                foreach ($line in $output) {
                    Write-Host $line
                }
            }
        }

        $stoppedJobs = $jobs | Where-Object { $_.State -ne "Running" }
        if ($stoppedJobs.Count -gt 0) {
            foreach ($job in $stoppedJobs) {
                Write-Warn "Service job '$($job.Name)' stopped ($($job.State))"
            }
            break
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
            & $redisCliPath -p $RedisPort shutdown save 2>$null
            Write-Ok "Redis stopped"
        } catch {
            Write-Warn "Could not stop Redis gracefully"
        }
    }

    Write-Host "Goodbye!" -ForegroundColor Cyan
}
