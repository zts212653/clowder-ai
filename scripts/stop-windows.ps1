<#
.SYNOPSIS
  Clowder AI (Cat Cafe) — Windows Stop Script
  猫猫咖啡 Windows 停止脚本

.DESCRIPTION
  Stops Cat Cafe services (API, Frontend, Redis) by port.

.EXAMPLE
  .\scripts\stop-windows.ps1
#>

$ErrorActionPreference = "Continue"

function Write-Ok   { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }

Write-Host "Cat Cafe — Stopping services" -ForegroundColor Cyan
Write-Host "============================="

# Load .env for port config
$envFile = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) ".env"
$ApiPort = 3004
$WebPort = 3003
$RedisPort = 6379

if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line -split "=", 2
            if ($parts.Count -eq 2) {
                $key = $parts[0].Trim()
                $val = $parts[1].Trim().Trim('"').Trim("'")
                switch ($key) {
                    "API_SERVER_PORT" { $ApiPort = [int]$val }
                    "FRONTEND_PORT"   { $WebPort = [int]$val }
                    "REDIS_PORT"      { $RedisPort = [int]$val }
                }
            }
        }
    }
}

function Stop-PortProcess {
    param([int]$Port, [string]$Name)
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($connections) {
        foreach ($conn in $connections) {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        Write-Ok "Stopped $Name (port $Port)"
    } else {
        Write-Warn "$Name (port $Port) — not running"
    }
}

Stop-PortProcess -Port $ApiPort -Name "API Server"
Stop-PortProcess -Port $WebPort -Name "Frontend"

# Stop Redis if running on our port
try {
    $redisPing = & redis-cli -p $RedisPort ping 2>$null
    if ($redisPing -eq "PONG") {
        & redis-cli -p $RedisPort shutdown save 2>$null
        Write-Ok "Redis stopped (port $RedisPort)"
    } else {
        Write-Warn "Redis (port $RedisPort) — not running"
    }
} catch {
    Write-Warn "Redis (port $RedisPort) — not running"
}

Write-Host "`nAll services stopped." -ForegroundColor Green
