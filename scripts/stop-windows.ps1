<#
.SYNOPSIS
  Clowder AI (Cat Cafe) - Windows Stop Script

.DESCRIPTION
  Stops Cat Cafe services (API, Frontend, Redis) by port.

.EXAMPLE
  .\scripts\stop-windows.ps1
#>

$ErrorActionPreference = "Continue"

function Write-Ok   { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }

$ScriptPath = if ($PSCommandPath) { $PSCommandPath } elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path } else { $null }
$ScriptDir = if ($ScriptPath) { Split-Path -Parent $ScriptPath } else { $null }
if ($ScriptDir) {
    . (Join-Path $ScriptDir "install-windows-helpers.ps1")
}
$ProjectRoot = if ($ScriptDir) { Split-Path -Parent $ScriptDir } else { $null }
$RunDir = if ($ProjectRoot) { Join-Path $ProjectRoot ".cat-cafe/run/windows" } else { $null }

Write-Host "Cat Cafe - Stopping services" -ForegroundColor Cyan
Write-Host "============================="

# Load .env for port config
$envFile = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) ".env"
$ApiPort = 3003
$WebPort = 3004
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

$configuredRedisUrl = if ($env:REDIS_URL) { $env:REDIS_URL.Trim() } else { Get-InstallerEnvValueFromFile -EnvFile $envFile -Key "REDIS_URL" }

function Get-ManagedProcessId {
    param([string]$ManagedPidFile)
    if (-not $ManagedPidFile -or -not (Test-Path $ManagedPidFile)) {
        return $null
    }
    try {
        return [int](Get-Content $ManagedPidFile -TotalCount 1).Trim()
    } catch {
        return $null
    }
}

function Get-ProcessCommandLine {
    param([int]$ProcessId)
    try {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        return $processInfo.CommandLine
    } catch {
        return $null
    }
}

function Test-ClowderOwnedProcess {
    param([int]$ProcessId, [string]$ClowderProjectRoot)
    if (-not $ClowderProjectRoot) {
        return $false
    }
    $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId
    if (-not $commandLine) {
        return $false
    }
    $normalizedRoot = $ClowderProjectRoot.TrimEnd('\', '/') + '\'
    return ($commandLine -like "*$normalizedRoot*") -or ($commandLine -like "*$ClowderProjectRoot`"*") -or ($commandLine -like "*$ClowderProjectRoot'*")
}

function Stop-PortProcess {
    param([int]$Port, [string]$Name, [string]$PidFile, [string]$ProjectRoot)
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($connections) {
        $managedPid = Get-ManagedProcessId -ManagedPidFile $PidFile
        $stopped = $false
        foreach ($conn in $connections) {
            $isManagedPid = $managedPid -and ($conn.OwningProcess -eq $managedPid)
            $isClowderOwned = $isManagedPid -or (Test-ClowderOwnedProcess -ProcessId $conn.OwningProcess -ClowderProjectRoot $ProjectRoot)
            if (-not $isClowderOwned) {
                Write-Warn "Skipping non-Clowder $Name listener on port $Port (PID $($conn.OwningProcess))"
                continue
            }
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            $stopped = $true
        }
        if ($stopped) {
            Remove-Item $PidFile -ErrorAction SilentlyContinue
            Write-Ok "Stopped $Name (port $Port)"
        } else {
            Write-Warn "$Name (port $Port) - no Clowder-owned listener found"
        }
    } else {
        Write-Warn "$Name (port $Port) - not running"
    }
}

$ApiPidFile = if ($RunDir) { Join-Path $RunDir "api-$ApiPort.pid" } else { $null }
$WebPidFile = if ($RunDir) { Join-Path $RunDir "web-$WebPort.pid" } else { $null }

Stop-PortProcess -Port $ApiPort -Name "API Server" -PidFile $ApiPidFile -ProjectRoot $ProjectRoot
Stop-PortProcess -Port $WebPort -Name "Frontend" -PidFile $WebPidFile -ProjectRoot $ProjectRoot

# Stop Redis if running on our port
$redisCommands = $null
$redisLayout = if ($ProjectRoot) { Resolve-PortableRedisLayout -ProjectRoot $ProjectRoot } else { $null }
$redisPidFile = if ($redisLayout) { Join-Path $redisLayout.Data "redis-$RedisPort.pid" } else { $null }
if ($ProjectRoot) {
    $redisCommands = Resolve-PortableRedisBinaries -ProjectRoot $ProjectRoot
}
if (-not $redisCommands) {
    $redisCommands = Resolve-GlobalRedisBinaries
}

if ($configuredRedisUrl -and -not (Test-LocalRedisUrl -RedisUrl $configuredRedisUrl -RedisPort $RedisPort)) {
    Write-Warn "Skipping local Redis shutdown because REDIS_URL points to an external host"
} else {
    try {
        if (-not $redisCommands -or -not $redisCommands.CliPath) {
            throw "redis-cli unavailable"
        }
        $redisConnections = Get-NetTCPConnection -LocalPort $RedisPort -State Listen -ErrorAction SilentlyContinue
        if (-not $redisConnections) {
            Write-Warn "Redis (port $RedisPort) - not running"
        } else {
            $managedRedisPid = Get-ManagedProcessId -ManagedPidFile $redisPidFile
            $ownedRedisConnections = @()
            foreach ($conn in $redisConnections) {
                $isManagedPid = $managedRedisPid -and ($conn.OwningProcess -eq $managedRedisPid)
                $isClowderOwned = $isManagedPid -or (Test-ClowderOwnedProcess -ProcessId $conn.OwningProcess -ClowderProjectRoot $ProjectRoot)
                if (-not $isClowderOwned) {
                    Write-Warn "Skipping non-Clowder Redis listener on port $RedisPort (PID $($conn.OwningProcess))"
                    continue
                }
                $ownedRedisConnections += $conn
            }
            if ($ownedRedisConnections.Count -eq 0) {
                Write-Warn "Redis (port $RedisPort) - no Clowder-owned listener found"
            } else {
                $redisCli = $redisCommands.CliPath
                $redisAuthArgs = Get-RedisAuthArgs -RedisUrl $configuredRedisUrl
                $redisPing = & $redisCli -p $RedisPort @redisAuthArgs ping 2>$null
                if ($redisPing -eq "PONG") {
                    & $redisCli -p $RedisPort @redisAuthArgs shutdown save 2>$null
                    Write-Ok "Redis stopped (port $RedisPort)"
                } else {
                    Write-Warn "Redis (port $RedisPort) - not running"
                }
            }
        }
    } catch {
        Write-Warn "Redis (port $RedisPort) - not running"
    }
}

Write-Host "`nAll services stopped." -ForegroundColor Green
