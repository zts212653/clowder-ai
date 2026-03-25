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
  .\scripts\start-windows.ps1 -Debug       # enable debug-level logging (writes to data/logs/api/)
#>

param(
    [switch]$Quick,
    [switch]$Memory,
    [switch]$Dev,
    [switch]$Debug
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

$bundledRelease = Test-ClowderBundledRelease -ProjectRoot $ProjectRoot
$nodeCommand = Resolve-BundledNodeCommand -ProjectRoot $ProjectRoot
if (-not $nodeCommand) {
    $nodeCommand = Resolve-ToolCommand -Name "node"
}
if (-not $nodeCommand) {
    Write-Err "Node.js not found. Run .\scripts\install.ps1 first or reinstall the packaged bundle."
    exit 1
}
Write-Ok "Node: $nodeCommand"

$jiuwenClawRuntimeReady = Ensure-WindowsJiuwenClawRuntime -ProjectRoot $ProjectRoot

$pnpmCommand = $null
if ($bundledRelease) {
    Write-Ok "Bundled release detected - prebuilt runtime enabled"
    if ($Dev) {
        Write-Warn "Bundled release does not support -Dev - using production mode"
        $Dev = $false
    }
    if (-not $Quick) {
        Write-Warn "Bundled release uses prebuilt artifacts - enabling -Quick"
        $Quick = $true
    }
} else {
    $pnpmCommand = Resolve-ToolCommand -Name "pnpm"
    if (-not $pnpmCommand) {
        Write-Err "pnpm not found. Run .\scripts\install.ps1 first."
        exit 1
    }
    Write-Ok "pnpm: $pnpmCommand"
}

# -- Ports ---------------------------------------------------
$ConfiguredApiPort = if ($env:API_SERVER_PORT) { [int]$env:API_SERVER_PORT } else { 3004 }
$ConfiguredWebPort = if ($env:FRONTEND_PORT) { [int]$env:FRONTEND_PORT } else { 3003 }
$ConfiguredRedisPort = if ($env:REDIS_PORT) { [int]$env:REDIS_PORT } else { 6399 }
$ConfiguredRedisUrl = if ($env:REDIS_URL) { $env:REDIS_URL.Trim() } else { "" }
$ApiPort = $ConfiguredApiPort
$WebPort = $ConfiguredWebPort
$RedisPort = $ConfiguredRedisPort
$RunDir = Join-Path $ProjectRoot ".cat-cafe/run/windows"
$ApiPidFile = Join-Path $RunDir "api-$ApiPort.pid"
$WebPidFile = Join-Path $RunDir "web-$WebPort.pid"
$RuntimeStateFile = Join-Path $RunDir "runtime-state.json"
$StopScript = Join-Path $ScriptDir "stop-windows.ps1"
New-Item -Path $RunDir -ItemType Directory -Force | Out-Null

# -- Kill existing port processes ----------------------------
function Get-ManagedProcessId {
    param([string]$PidFile)
    if (-not (Test-Path $PidFile)) {
        return $null
    }
    try {
        return [int](Get-Content $PidFile -TotalCount 1).Trim()
    } catch {
        return $null
    }
}

function Clear-ManagedProcessId {
    param([string]$PidFile)
    Remove-Item $PidFile -ErrorAction SilentlyContinue
}

function Set-ManagedProcessId {
    param([int]$Port, [string]$PidFile)
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        Set-Content -Path $PidFile -Value "$($listener.OwningProcess)" -Encoding ASCII
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
    param([int]$ProcessId, [string]$ProjectRoot)
    $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId
    if (-not $commandLine) {
        return $false
    }
    # Normalize ProjectRoot with trailing separator to avoid substring false positives
    # e.g. C:\projects\clowder must not match C:\projects\clowder-test
    $normalizedRoot = $ProjectRoot.TrimEnd('\', '/') + '\'
    return ($commandLine -like "*$normalizedRoot*") -or ($commandLine -like "*$ProjectRoot`"*") -or ($commandLine -like "*$ProjectRoot'*")
}

function Stop-PortProcess {
    param([int]$Port, [string]$Name, [string]$PidFile, [string]$ProjectRoot)
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($connections) {
        $managedPid = Get-ManagedProcessId -PidFile $PidFile
        foreach ($conn in $connections) {
            $isManagedPid = $managedPid -and ($conn.OwningProcess -eq $managedPid)
            $isClowderOwned = $isManagedPid -or (Test-ClowderOwnedProcess -ProcessId $conn.OwningProcess -ProjectRoot $ProjectRoot)
            if (-not $isClowderOwned) {
                Write-Err "Port $Port ($Name) is in use by non-Clowder PID $($conn.OwningProcess). Stop it manually or change the configured port."
                throw "Port $Port ($Name) is in use by a non-Clowder process"
            }
            Write-Warn "Port $Port ($Name) in use by PID $($conn.OwningProcess) - stopping"
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        Clear-ManagedProcessId -PidFile $PidFile
        Start-Sleep -Seconds 1
    }
}

function Get-ServicePidFile {
    param([string]$ServiceKey, [int]$Port)
    return Join-Path $RunDir "$ServiceKey-$Port.pid"
}

function Find-AvailableFrontendApiPorts {
    param([int[]]$ExcludePorts = @(), [int]$Attempts = 64)

    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        $webPort = Find-AvailableTcpPort -ExcludePorts $ExcludePorts
        if ($webPort -ge 65535) {
            continue
        }

        $apiPort = $webPort + 1
        if ($ExcludePorts -contains $apiPort) {
            continue
        }

        if (-not (Test-TcpPortAvailable -Port $apiPort)) {
            continue
        }

        return [pscustomobject]@{
            WebPort = $webPort
            ApiPort = $apiPort
        }
    }

    throw "Could not find an available frontend/API port pair"
}

function Resolve-ServiceRuntimePort {
    param(
        [string]$ServiceKey,
        [string]$Name,
        [int]$ConfiguredPort,
        [string]$ProjectRoot,
        [bool]$PreferRandom,
        [int[]]$ReservedPorts = @()
    )

    if (-not $PreferRandom) {
        $configuredPidFile = Get-ServicePidFile -ServiceKey $ServiceKey -Port $ConfiguredPort
        try {
            Stop-PortProcess -Port $ConfiguredPort -Name $Name -PidFile $configuredPidFile -ProjectRoot $ProjectRoot
            return $ConfiguredPort
        } catch {
            Write-Warn "Configured port $ConfiguredPort ($Name) is unavailable - selecting a random port instead"
        }
    }

    $randomPort = Find-AvailableTcpPort -ExcludePorts ($ReservedPorts + @($ConfiguredPort))
    Write-Ok "$Name port selected: $randomPort (random)"
    return $randomPort
}

$PreferRandomPorts = Test-TruthyEnvFlag -Value $env:CAT_CAFE_WINDOWS_RANDOM_PORTS -Default ($bundledRelease -and -not $Dev)
$BundledDefaultRedisUrl = "redis://localhost:$ConfiguredRedisPort"
if ($PreferRandomPorts -and $ConfiguredRedisUrl -and ($ConfiguredRedisUrl.ToLowerInvariant() -eq $BundledDefaultRedisUrl.ToLowerInvariant())) {
    Remove-Item Env:REDIS_URL -ErrorAction SilentlyContinue
    $ConfiguredRedisUrl = ""
}
$UseRandomFrontendApiPorts = $PreferRandomPorts -and $ConfiguredApiPort -eq 3004 -and $ConfiguredWebPort -eq 3003
$UseRandomRedisPort = $PreferRandomPorts -and -not $ConfiguredRedisUrl -and $ConfiguredRedisPort -eq 6399

if ((Test-Path $RuntimeStateFile) -and (Test-Path $StopScript)) {
    Write-Step "Clear stale runtime state"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $StopScript
}

if ($UseRandomFrontendApiPorts) {
    $portPair = Find-AvailableFrontendApiPorts
    $WebPort = [int]$portPair.WebPort
    $ApiPort = [int]$portPair.ApiPort
    Write-Ok "Frontend port selected: $WebPort (random)"
    Write-Ok "API port selected: $ApiPort (random)"
} else {
    $ApiPort = Resolve-ServiceRuntimePort -ServiceKey "api" -Name "API" -ConfiguredPort $ConfiguredApiPort -ProjectRoot $ProjectRoot -PreferRandom $false
    $WebPort = Resolve-ServiceRuntimePort -ServiceKey "web" -Name "Frontend" -ConfiguredPort $ConfiguredWebPort -ProjectRoot $ProjectRoot -PreferRandom $false -ReservedPorts @([int]$ApiPort)
}

$ApiPidFile = Join-Path $RunDir "api-$ApiPort.pid"
$WebPidFile = Join-Path $RunDir "web-$WebPort.pid"
$env:API_SERVER_PORT = "$ApiPort"
$env:FRONTEND_PORT = "$WebPort"

Write-Step "Check ports"
Stop-PortProcess -Port ([int]$ApiPort) -Name "API" -PidFile $ApiPidFile -ProjectRoot $ProjectRoot
Stop-PortProcess -Port ([int]$WebPort) -Name "Frontend" -PidFile $WebPidFile -ProjectRoot $ProjectRoot

# -- Storage (Redis or Memory) -------------------------------
Write-Step "Storage"

$useRedis = -not $Memory
$startedRedis = $false
$redisLayout = Resolve-PortableRedisLayout -ProjectRoot $ProjectRoot
$redisCliPath = $null
$redisServerPath = $null
$redisSource = $null
$redisAuthArgs = @()
$redisLogFile = Join-Path $redisLayout.Logs "redis-$RedisPort.log"
$redisPidFile = Join-Path $redisLayout.Data "redis-$RedisPort.pid"
$configuredRedisUrl = $ConfiguredRedisUrl
$useExternalRedis = $useRedis -and $configuredRedisUrl -and -not (Test-LocalRedisUrl -RedisUrl $configuredRedisUrl -RedisPort $RedisPort)
$safeConfiguredRedisUrl = Get-RedactedRedisUrl -RedisUrl $configuredRedisUrl

if ($useExternalRedis) {
    Write-Ok "Using external Redis: $safeConfiguredRedisUrl"
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
    $redisAuthArgs = Get-RedisAuthArgs -RedisUrl $configuredRedisUrl
    if ($UseRandomRedisPort) {
        $RedisPort = Find-AvailableTcpPort -ExcludePorts @([int]$ApiPort, [int]$WebPort, $ConfiguredRedisPort)
        $redisLogFile = Join-Path $redisLayout.Logs "redis-$RedisPort.log"
        $redisPidFile = Join-Path $redisLayout.Data "redis-$RedisPort.pid"
        Write-Ok "Redis port selected: $RedisPort (random)"
    }
    # Check if Redis is already running
    try {
        if (-not $redisCliPath) {
            throw "redis-cli unavailable"
        }
        $redisPing = & $redisCliPath -p $RedisPort @redisAuthArgs ping 2>$null
        if ($redisPing -eq "PONG") {
            $redisConnections = Get-NetTCPConnection -LocalPort $RedisPort -State Listen -ErrorAction SilentlyContinue
            if (-not $redisConnections) {
                throw "not running"
            }
            $managedRedisPid = Get-ManagedProcessId -PidFile $redisPidFile
            foreach ($conn in $redisConnections) {
                $isManagedPid = $managedRedisPid -and ($conn.OwningProcess -eq $managedRedisPid)
                $isClowderOwned = $isManagedPid -or (Test-ClowderOwnedProcess -ProcessId $conn.OwningProcess -ProjectRoot $ProjectRoot)
                if (-not $isClowderOwned) {
                    Write-Warn "Redis port $RedisPort is in use by non-Clowder PID $($conn.OwningProcess) - reusing existing local Redis"
                }
            }
            Write-Ok "Redis already running on port $RedisPort"
            if ($configuredRedisUrl) {
                $env:REDIS_URL = $configuredRedisUrl
            } else {
                $env:REDIS_URL = "redis://localhost:$RedisPort"
            }
            $env:REDIS_PORT = "$RedisPort"
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
                $redisAclFile = Join-Path $redisLayout.Data "redis-$RedisPort.acl"
                $redisServerAuthArgs = Get-RedisServerAuthArgs -RedisUrl $configuredRedisUrl -AclFilePath $redisAclFile
                $redisArgs = @(
                    "--port", $RedisPort,
                    "--bind", "127.0.0.1",
                    "--dir", (Quote-WindowsProcessArgument -Value $redisLayout.Data),
                    "--logfile", (Quote-WindowsProcessArgument -Value $redisLogFile),
                    "--pidfile", (Quote-WindowsProcessArgument -Value $redisPidFile)
                ) + $redisServerAuthArgs
                Write-Host "  Starting Redis on port $RedisPort ($redisSource)..."
                Start-Process -FilePath $redisServerPath -ArgumentList $redisArgs -WindowStyle Hidden
                Start-Sleep -Seconds 2
                $redisPing = & $redisCliPath -p $RedisPort @redisAuthArgs ping 2>$null
                if ($redisPing -eq "PONG") {
                    Write-Ok "Redis started on port $RedisPort"
                    if ($configuredRedisUrl) {
                        $env:REDIS_URL = $configuredRedisUrl
                    } else {
                        $env:REDIS_URL = "redis://localhost:$RedisPort"
                    }
                    $env:REDIS_PORT = "$RedisPort"
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
    Remove-Item Env:REDIS_PORT -ErrorAction SilentlyContinue
    $env:MEMORY_STORE = "1"
}

try {
    # -- Build (unless -Quick) ----------------------------------
    if (-not $Quick) {
        Write-Step "Build packages"

        Write-Host "  Building shared..."
        Push-Location (Join-Path $ProjectRoot "packages/shared")
        & $pnpmCommand run build
        if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Err "Build failed: shared"; throw "Build failed: shared" }
        Pop-Location
        Write-Ok "shared"

        Write-Host "  Building mcp-server..."
        Push-Location (Join-Path $ProjectRoot "packages/mcp-server")
        & $pnpmCommand run build
        if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Err "Build failed: mcp-server"; throw "Build failed: mcp-server" }
        Pop-Location
        Write-Ok "mcp-server"

        Write-Host "  Building api..."
        Push-Location (Join-Path $ProjectRoot "packages/api")
        & $pnpmCommand run build
        if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Err "Build failed: api"; throw "Build failed: api" }
        Pop-Location
        Write-Ok "api"

        if (-not $Dev) {
            Write-Host "  Building web (production)..."
            Push-Location (Join-Path $ProjectRoot "packages/web")
            & $pnpmCommand run build
            if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Err "Build failed: web"; throw "Build failed: web" }
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
        throw "API build artifact not found"
    }

    $nextDir = Join-Path $ProjectRoot "packages/web/.next"
    if (-not $Dev -and -not (Test-Path $nextDir)) {
        Write-Err ".next directory not found - run without -Quick first to build"
        throw ".next directory not found"
    }
    $nextCli = @(
        (Join-Path $ProjectRoot "packages/web/node_modules/next/dist/bin/next"),
        (Join-Path $ProjectRoot "node_modules/next/dist/bin/next")
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not (Test-Path $nextCli)) {
        Write-Err "Next CLI not found - run pnpm install first or rebuild the packaged bundle"
        throw "Next CLI not found"
    }

    # -- Start services ------------------------------------------
    Write-Step "Start services"

    # Track background jobs for cleanup
    $jobs = @()
    $runtimeEnvOverrides = @{
        REDIS_URL = $env:REDIS_URL
        REDIS_PORT = $env:REDIS_PORT
        MEMORY_STORE = $env:MEMORY_STORE
        CAT_CAFE_MCP_SERVER_PATH = $env:CAT_CAFE_MCP_SERVER_PATH
        API_SERVER_PORT = $ApiPort
        FRONTEND_PORT = $WebPort
        NEXT_PUBLIC_API_URL = "http://127.0.0.1:$ApiPort"
    }
    Write-WindowsRuntimeStateFile -StateFile $RuntimeStateFile -State ([ordered]@{
        GeneratedAt = (Get-Date).ToString("o")
        ProjectRoot = $ProjectRoot
        FrontendUrl = "http://127.0.0.1:$WebPort/"
        ApiUrl = "http://127.0.0.1:$ApiPort"
        ApiPort = [int]$ApiPort
        WebPort = [int]$WebPort
        RedisPort = if ($useRedis -and -not $useExternalRedis) { [int]$RedisPort } else { $null }
        RedisUrl = if ($env:REDIS_URL) { $env:REDIS_URL } else { "" }
        UseExternalRedis = [bool]$useExternalRedis
        PreferRandomPorts = [bool]$PreferRandomPorts
        ApiPidFile = $ApiPidFile
        WebPidFile = $WebPidFile
        RedisPidFile = $redisPidFile
    })

    # API Server
    # Env vars are loaded into this process (line 42-53) and inherited by Start-Job.
    # No --env-file needed - avoids depending on Node's --env-file support here.
    Write-Host "  Starting API Server (port $ApiPort)..."
    $apiJob = Start-Job -Name "api" -ScriptBlock {
        param($root, $envFile, $runtimeEnvOverrides, $apiEntry, $nodeCommand, $debugFlag)
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
        if ($debugFlag) {
            $env:LOG_LEVEL = "debug"
            & $nodeCommand $apiEntry --debug 2>&1
        } else {
            & $nodeCommand $apiEntry 2>&1
        }
    } -ArgumentList $ProjectRoot, $envFile, $runtimeEnvOverrides, $apiEntry, $nodeCommand, $Debug.IsPresent
    $jobs += $apiJob

    Start-Sleep -Seconds 2

    # Frontend
    if ($Dev) {
        # Development mode: next dev (hot reload)
        Write-Host "  Starting Frontend (port $WebPort, dev)..."
        $webJob = Start-Job -Name "web" -ScriptBlock {
            param($root, $port, $nextCli, $nodeCommand)
            $env:PORT = $port
            $env:NEXT_IGNORE_INCORRECT_LOCKFILE = "1"
            & $nodeCommand $nextCli dev (Join-Path $root "packages/web") -p $port 2>&1
        } -ArgumentList $ProjectRoot, $WebPort, $nextCli, $nodeCommand
    } else {
        # Production mode: next start (default - avoids #105 issues)
        Write-Host "  Starting Frontend (port $WebPort, production)..."
        $webJob = Start-Job -Name "web" -ScriptBlock {
            param($root, $port, $nextCli, $nodeCommand)
            $env:PORT = $port
            & $nodeCommand $nextCli start (Join-Path $root "packages/web") -p $port -H 0.0.0.0 2>&1
        } -ArgumentList $ProjectRoot, $WebPort, $nextCli, $nodeCommand
    }
    $jobs += $webJob

    Start-Sleep -Seconds 3
    Set-ManagedProcessId -Port ([int]$ApiPort) -PidFile $ApiPidFile
    Set-ManagedProcessId -Port ([int]$WebPort) -PidFile $WebPidFile

    # -- Status --------------------------------------------------
    $effectiveRedisUrl = if ($env:REDIS_URL) { $env:REDIS_URL } else { "" }
    $safeEffectiveRedisUrl = Get-RedactedRedisUrl -RedisUrl $effectiveRedisUrl
    $storageMode = if ($useRedis -and $safeEffectiveRedisUrl) { "Redis ($safeEffectiveRedisUrl)" } elseif ($useRedis) { "Redis (redis://localhost:$RedisPort)" } else { "Memory (restart loses data)" }
    $frontendMode = if ($Dev) { "development (hot reload)" } else { "production (PWA enabled)" }
    $logDir = Join-Path $ProjectRoot "data/logs/api"

    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  Cat Cafe started!" -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Frontend: http://localhost:$WebPort"
    Write-Host "  API:      http://localhost:$ApiPort"
    Write-Host "  Storage:  $storageMode"
    Write-Host "  Frontend: $frontendMode"
    if ($Debug) {
        Write-Host "  Debug:    ON (logs: $logDir)" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  Press Ctrl+C to stop all services" -ForegroundColor Yellow
    Write-Host ""

    # -- Wait ----------------------------------------------------
    $serviceFailure = $false
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
            $serviceFailure = $true
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
    Clear-ManagedProcessId -PidFile $ApiPidFile
    Clear-ManagedProcessId -PidFile $WebPidFile
    Remove-WindowsRuntimeStateFile -StateFile $RuntimeStateFile

    if ($startedRedis) {
        try {
            & $redisCliPath -p $RedisPort @redisAuthArgs shutdown save 2>$null
            Write-Ok "Redis stopped"
        } catch {
            Write-Warn "Could not stop Redis gracefully"
        }
    }

    Write-Host "Goodbye!" -ForegroundColor Cyan
}

if ($serviceFailure) {
    exit 1
}
