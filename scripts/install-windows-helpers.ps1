. (Join-Path $PSScriptRoot "windows-command-helpers.ps1")
. (Join-Path $PSScriptRoot "windows-installer-ui.ps1")

function Mount-InstallerSkills {
    param([string]$ProjectRoot)

    $skillsSource = Join-Path $ProjectRoot "cat-cafe-skills"
    $cliDirs = @("$env:USERPROFILE\.claude", "$env:USERPROFILE\.codex", "$env:USERPROFILE\.gemini")
    if (-not (Test-Path $skillsSource)) {
        Write-Warn "cat-cafe-skills/ not found - skills mount skipped"
        return
    }

    $skillItems = Get-ChildItem $skillsSource -Directory | Where-Object { $_.Name -ne "refs" }
    foreach ($cliDir in $cliDirs) {
        $skillsRoot = Join-Path $cliDir "skills"
        if (-not (Test-Path $skillsRoot)) {
            New-Item -Path $skillsRoot -ItemType Directory -Force | Out-Null
        }
        foreach ($skill in $skillItems) {
            $skillTarget = Join-Path $skillsRoot $skill.Name
            $expectedTarget = Get-InstallerNormalizedPath -Path $skill.FullName
            $existingItem = Get-Item -LiteralPath $skillTarget -Force -ErrorAction SilentlyContinue
            if ($existingItem) {
                $existingTarget = Get-InstallerSkillLinkTarget -Path $skillTarget
                if ($existingTarget -eq $expectedTarget) {
                    Write-Ok "Skill already mounted: $skillTarget"
                    continue
                }
                $linkType = "$($existingItem.LinkType)"
                if ($linkType -notin @("Junction", "SymbolicLink")) {
                    Write-Warn "Skill target exists and is not a junction: $skillTarget"
                    continue
                }
                Write-Warn "Refreshing stale skill mount: $skillTarget"
                cmd /c rmdir "$skillTarget" 2>$null | Out-Null
                if (Get-Item -LiteralPath $skillTarget -Force -ErrorAction SilentlyContinue) {
                    throw "stale junction cleanup failed"
                }
            }
            try {
                cmd /c mklink /J "$skillTarget" "$($skill.FullName)" 2>$null | Out-Null
                if (Test-Path $skillTarget) {
                    Write-Ok "Skill mounted: $skillTarget"
                } else {
                    throw "junction failed"
                }
            } catch {
                Write-Warn "Could not create junction for $skillTarget"
                Write-Warn "Run manually: mklink /J `"$skillTarget`" `"$($skill.FullName)`""
            }
        }
    }
}

function Get-InstallerNormalizedPath {
    param([string]$Path)

    if (-not $Path) {
        return ""
    }

    try {
        return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/').ToLowerInvariant()
    } catch {
        return $Path.TrimEnd('\', '/').ToLowerInvariant()
    }
}

function Get-InstallerSkillLinkTarget {
    param([string]$Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $item) {
        return ""
    }

    $linkType = "$($item.LinkType)"
    if ($linkType -notin @("Junction", "SymbolicLink")) {
        return ""
    }

    $target = @($item.Target) | Where-Object { $_ } | Select-Object -First 1
    if (-not $target) {
        return ""
    }

    return Get-InstallerNormalizedPath -Path "$target"
}

function Add-ProcessPathPrefix {
    param([string]$Directory)
    if (-not $Directory -or -not (Test-Path $Directory)) {
        return
    }
    $segments = @($env:Path -split ";" | Where-Object { $_ })
    if ($segments -notcontains $Directory) {
        $env:Path = "$Directory;$env:Path"
    }
}

function Resolve-PortableRedisLayout {
    param([string]$ProjectRoot)
    $root = Join-Path $ProjectRoot ".cat-cafe\redis\windows"
    [pscustomobject]@{
        Root = $root
        ArchiveDir = Join-Path $root "archives"
        Current = Join-Path $root "current"
        Data = Join-Path $root "data"
        Logs = Join-Path $root "logs"
        VersionFile = Join-Path $root "current-release.txt"
    }
}

function Resolve-PortableRedisBinaries {
    param([string]$ProjectRoot)
    if (-not $ProjectRoot) { return $null }
    $layout = Resolve-PortableRedisLayout -ProjectRoot $ProjectRoot
    if (-not (Test-Path $layout.Current)) { return $null }
    $redisServer = Get-ChildItem $layout.Current -Recurse -Filter "redis-server.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    $redisCli = Get-ChildItem $layout.Current -Recurse -Filter "redis-cli.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $redisServer -or -not $redisCli) { return $null }
    Add-ProcessPathPrefix -Directory $redisServer.Directory.FullName
    [pscustomobject]@{
        Source = "project-local"
        ServerPath = $redisServer.FullName
        CliPath = $redisCli.FullName
        BinDir = $redisServer.Directory.FullName
    }
}

function Resolve-GlobalRedisBinaries {
    $redisServer = Get-Command redis-server -ErrorAction SilentlyContinue
    $redisCli = Get-Command redis-cli -ErrorAction SilentlyContinue
    if (-not $redisServer -or -not $redisCli) { return $null }
    [pscustomobject]@{
        Source = "global"
        ServerPath = $redisServer.Source
        CliPath = $redisCli.Source
        BinDir = Split-Path -Parent $redisServer.Source
    }
}

function Test-LocalRedisUrl {
    param([string]$RedisUrl, [string]$RedisPort)

    if (-not $RedisUrl) {
        return $false
    }

    $uri = $null
    if (-not [System.Uri]::TryCreate($RedisUrl, [System.UriKind]::Absolute, [ref]$uri)) {
        return $false
    }

    $isLoopbackHost = $uri.Host -eq "localhost"
    $ipAddress = $null
    if (-not $isLoopbackHost -and [System.Net.IPAddress]::TryParse($uri.Host, [ref]$ipAddress)) {
        $isLoopbackHost = [System.Net.IPAddress]::IsLoopback($ipAddress)
    }

    if (-not $isLoopbackHost) {
        return $false
    }

    if ($uri.Port -gt 0 -and "$($uri.Port)" -ne "$RedisPort") {
        return $false
    }

    return $true
}

function Get-InstallerExternalRedisValidationError {
    param([string]$RedisUrl, [int]$TimeoutMs = 3000)

    if (-not $RedisUrl) {
        return "External Redis URL is empty."
    }

    $uri = $null
    if (-not [System.Uri]::TryCreate($RedisUrl, [System.UriKind]::Absolute, [ref]$uri)) {
        return "External Redis URL must be an absolute redis:// or rediss:// URL."
    }

    if ($uri.Scheme -notin @("redis", "rediss")) {
        return "External Redis URL must use redis:// or rediss://."
    }

    if (-not $uri.Host) {
        return "External Redis URL must include a hostname."
    }

    $port = if ($uri.Port -gt 0) { $uri.Port } elseif ($uri.Scheme -eq "rediss") { 6380 } else { 6379 }
    $safeRedisUrl = Get-RedactedRedisUrl -RedisUrl $RedisUrl
    $tcpClient = [System.Net.Sockets.TcpClient]::new()
    try {
        $connectTask = $tcpClient.ConnectAsync($uri.Host, $port)
        if (-not $connectTask.Wait($TimeoutMs) -or -not $tcpClient.Connected) {
            return "External Redis URL is not reachable: $safeRedisUrl"
        }
    } catch {
        return "External Redis URL is not reachable: $safeRedisUrl"
    } finally {
        $tcpClient.Dispose()
    }

    return ""
}

function Quote-WindowsProcessArgument {
    param([string]$Value)

    if ($null -eq $Value -or $Value -eq "") {
        return '""'
    }

    if ($Value -notmatch '[\s"]') {
        return $Value
    }

    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Get-RedactedRedisUrl {
    param([string]$RedisUrl)
    if (-not $RedisUrl) { return "" }
    try {
        $uri = [System.Uri]::new($RedisUrl)
        if (-not $uri.UserInfo) { return $RedisUrl }
        $authority = if ($uri.Port -gt 0) { "$($uri.Host):$($uri.Port)" } else { $uri.Host }
        return "$($uri.Scheme)://$authority$($uri.AbsolutePath)"
    } catch {
        return $RedisUrl -replace '://[^@]+@', '://'
    }
}

function Get-RedisAuthArgs {
    param([string]$RedisUrl)
    if (-not $RedisUrl) { return @() }
    try {
        $uri = [System.Uri]::new($RedisUrl)
        $userInfo = $uri.UserInfo
        if (-not $userInfo) { return @() }
        $parts = $userInfo -split ":", 2
        $authArgs = @()
        if ($parts.Count -eq 2) {
            if ($parts[0]) { $authArgs += @("--user", [System.Uri]::UnescapeDataString($parts[0])) }
            if ($parts[1]) { $authArgs += @("-a", [System.Uri]::UnescapeDataString($parts[1])) }
        } elseif ($parts[0]) {
            $authArgs += @("-a", [System.Uri]::UnescapeDataString($parts[0]))
        }
        return $authArgs
    } catch {}
    return @()
}

function Get-RedisServerAuthArgs {
    param([string]$RedisUrl, [string]$AclFilePath)
    if (-not $RedisUrl) { return @() }
    try {
        $uri = [System.Uri]::new($RedisUrl)
        $userInfo = $uri.UserInfo
        if (-not $userInfo) { return @() }

        $parts = $userInfo -split ":", 2
        $username = ""
        $password = ""
        if ($parts.Count -eq 2) {
            $username = if ($parts[0]) { [System.Uri]::UnescapeDataString($parts[0]) } else { "" }
            $password = if ($parts[1]) { [System.Uri]::UnescapeDataString($parts[1]) } else { "" }
        } elseif ($parts[0]) {
            $password = [System.Uri]::UnescapeDataString($parts[0])
        }

        if (-not $password) { return @() }

        if ($username) {
            if (-not $AclFilePath) {
                throw "AclFilePath is required for Redis ACL usernames"
            }
            $aclLines = if ($username -eq "default") {
                @("user default on >$password allkeys allcommands")
            } else {
                @(
                    "user default off",
                    "user $username on >$password allkeys allcommands"
                )
            }
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllLines($AclFilePath, $aclLines, $utf8NoBom)
            return @("--aclfile", (Quote-WindowsProcessArgument -Value $AclFilePath))
        }

        return @("--requirepass", (Quote-WindowsProcessArgument -Value $password))
    } catch {}
    return @()
}

function Test-TruthyEnvFlag {
    param([string]$Value, [bool]$Default = $false)

    if ($null -eq $Value -or $Value -eq "") {
        return $Default
    }

    switch ($Value.Trim().ToLowerInvariant()) {
        "1" { return $true }
        "true" { return $true }
        "yes" { return $true }
        "on" { return $true }
        "0" { return $false }
        "false" { return $false }
        "no" { return $false }
        "off" { return $false }
        default { return $Default }
    }
}

function Test-TcpPortAvailable {
    param([int]$Port)

    if ($Port -le 0 -or $Port -gt 65535) {
        return $false
    }

    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Server.ExclusiveAddressUse = $true
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) {
            $listener.Stop()
        }
    }
}

function Find-AvailableTcpPort {
    param([int[]]$ExcludePorts = @(), [int]$Attempts = 64)

    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        $listener = $null
        try {
            $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
            $listener.Server.ExclusiveAddressUse = $true
            $listener.Start()
            $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
            if ($ExcludePorts -notcontains $port) {
                return $port
            }
        } finally {
            if ($listener) {
                $listener.Stop()
            }
        }
    }

    throw "Could not find an available TCP port"
}

function Read-WindowsRuntimeStateFile {
    param([string]$StateFile)

    if (-not $StateFile -or -not (Test-Path $StateFile)) {
        return $null
    }

    try {
        return Get-Content $StateFile -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Write-WindowsRuntimeStateFile {
    param([string]$StateFile, $State)

    if (-not $StateFile -or $null -eq $State) {
        return
    }

    $parentDir = Split-Path -Parent $StateFile
    if ($parentDir) {
        New-Item -Path $parentDir -ItemType Directory -Force | Out-Null
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $json = $State | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($StateFile, $json + "`r`n", $utf8NoBom)
}

function Remove-WindowsRuntimeStateFile {
    param([string]$StateFile)

    if (-not $StateFile) {
        return
    }

    Remove-Item $StateFile -ErrorAction SilentlyContinue
}

function Get-InstallerExceptionDetails {
    param($ErrorRecord)

    if (-not $ErrorRecord) {
        return @()
    }

    $details = @()
    $exception = $ErrorRecord.Exception
    $level = 0
    while ($exception) {
        $message = $exception.Message
        $typeName = $exception.GetType().FullName
        if ($message) {
            $details += "[$level] $($typeName): $message"
        } elseif ($typeName) {
            $details += "[$level] $typeName"
        }
        $exception = $exception.InnerException
        $level++
    }

    if ($details.Count -eq 0 -and $ErrorRecord.ToString()) {
        $details += $ErrorRecord.ToString()
    }

    return $details
}

function Write-InstallerExceptionDetails {
    param([string]$Context, $ErrorRecord)

    foreach ($detail in (Get-InstallerExceptionDetails -ErrorRecord $ErrorRecord)) {
        if ($Context) {
            Write-Warn "$Context detail: $detail"
        } else {
            Write-Warn "Failure detail: $detail"
        }
    }
}

function Ensure-WindowsRedis {
    param([string]$ProjectRoot, [switch]$Memory)
    if ($Memory) {
        Write-Warn "Memory mode (-Memory) - skipping Redis detection"
        return $false
    }

    $portableRedis = Resolve-PortableRedisBinaries -ProjectRoot $ProjectRoot
    if ($portableRedis) {
        Write-Ok "Redis available ($($portableRedis.Source)): $($portableRedis.BinDir)"
        return $true
    }

    $globalRedis = Resolve-GlobalRedisBinaries
    if ($globalRedis) {
        Write-Ok "Redis available ($($globalRedis.Source)): $($globalRedis.BinDir)"
        return $true
    }

    Write-Warn "Redis not found - attempting portable install into .cat-cafe/redis/windows"
    try {
        $layout = Resolve-PortableRedisLayout -ProjectRoot $ProjectRoot
        $headers = @{ "User-Agent" = "ClowderAI-Installer" }
        $redisReleaseApi = if ($env:CAT_CAFE_WINDOWS_REDIS_RELEASE_API) {
            $env:CAT_CAFE_WINDOWS_REDIS_RELEASE_API.Trim()
        } else {
            "https://api.github.com/repos/redis-windows/redis-windows/releases/latest"
        }
        $redisDownloadUrl = if ($env:CAT_CAFE_WINDOWS_REDIS_DOWNLOAD_URL) {
            $env:CAT_CAFE_WINDOWS_REDIS_DOWNLOAD_URL.Trim()
        } else {
            $null
        }

        New-Item -Path $layout.ArchiveDir -ItemType Directory -Force | Out-Null
        New-Item -Path $layout.Root -ItemType Directory -Force | Out-Null
        if (Test-Path $layout.Current) {
            Remove-Item -Path $layout.Current -Recurse -Force
        }

        if ($redisDownloadUrl) {
            $archiveName = [System.IO.Path]::GetFileName(([System.Uri]$redisDownloadUrl).AbsolutePath)
            if (-not $archiveName) {
                $archiveName = "redis-windows.zip"
            }
            $archivePath = Join-Path $layout.ArchiveDir $archiveName
            $releaseTag = "manual-override"
            Write-Host "  Redis archive source: explicit CAT_CAFE_WINDOWS_REDIS_DOWNLOAD_URL"
            Write-Host "  Downloading $archiveName..."
            Invoke-WebRequest -Uri $redisDownloadUrl -OutFile $archivePath -Headers $headers -UseBasicParsing
        } else {
            Write-Host "  Redis release metadata source: $redisReleaseApi"
            $release = Invoke-RestMethod -Uri $redisReleaseApi -Headers $headers
            $asset = $release.assets | Where-Object { $_.name -match "^Redis-.*-Windows-x64-msys2\.zip$" } | Select-Object -First 1
            if (-not $asset) {
                $asset = $release.assets | Where-Object { $_.name -match "^Redis-.*-Windows-x64-cygwin\.zip$" } | Select-Object -First 1
            }
            if (-not $asset) {
                $asset = $release.assets | Where-Object { $_.name -match "^Redis-.*-Windows-x64-msys2-with-Service\.zip$" } | Select-Object -First 1
            }
            if (-not $asset) {
                $asset = $release.assets | Where-Object { $_.name -match "^Redis-.*-Windows-x64-cygwin-with-Service\.zip$" } | Select-Object -First 1
            }
            if (-not $asset) {
                throw "No Windows Redis zip asset found in release metadata"
            }

            $archivePath = Join-Path $layout.ArchiveDir $asset.name
            $releaseTag = $release.tag_name
            Write-Host "  Downloading $($asset.name)..."
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archivePath -Headers $headers -UseBasicParsing
        }

        Expand-Archive -Path $archivePath -DestinationPath $layout.Current -Force

        $portableRedis = Resolve-PortableRedisBinaries -ProjectRoot $ProjectRoot
        if (-not $portableRedis) {
            throw "Redis executables were not found after extraction"
        }

        Set-Content -Path $layout.VersionFile -Value $releaseTag -Encoding ascii
        Write-Ok "Redis installed: $($portableRedis.BinDir)"
        Write-Warn "Portable Redis will be reused from .cat-cafe/redis/windows on later starts."
        return $true
    } catch {
        Write-Warn "Redis auto-install failed - install Redis manually or rerun with an external Redis URL"
        Write-InstallerExceptionDetails -Context "Redis auto-install" -ErrorRecord $_
        Write-Warn "Manual Redis install: https://github.com/redis-windows/redis-windows/releases"
        return $false
    }
}

function Ensure-WindowsJiuwenClawRuntime {
    param([string]$ProjectRoot)

    if (-not $ProjectRoot) {
        return $false
    }

    $appDir = Join-Path $ProjectRoot "vendor\jiuwenclaw"
    $appEntry = Join-Path $appDir "jiuwenclaw\app.py"
    if (-not (Test-Path $appEntry)) {
        return $false
    }

    $venvPython = Join-Path $appDir ".venv\Scripts\python.exe"
    if (Test-Path $venvPython) {
        return $true
    }

    $pythonCommand = Resolve-ToolCommandWithRetry -Name "python" -Attempts 2
    $pythonArgs = @()
    if (-not $pythonCommand) {
        $pythonCommand = Resolve-ToolCommandWithRetry -Name "py" -Attempts 2
        if ($pythonCommand) {
            $pythonArgs = @("-3")
        }
    }
    if (-not $pythonCommand) {
        Write-Warn "jiuwenClaw runtime unavailable - Python 3.11+ not found"
        return $false
    }

    Write-Host "  Preparing jiuwenClaw runtime..."
    try {
        Push-Location $appDir
        & $pythonCommand @pythonArgs -m venv ".venv"
        if ($LASTEXITCODE -ne 0) {
            throw "python -m venv failed"
        }
        & $venvPython -m pip install --upgrade pip setuptools wheel
        if ($LASTEXITCODE -ne 0) {
            throw "pip bootstrap failed"
        }
        & $venvPython -m pip install -e .
        if ($LASTEXITCODE -ne 0) {
            throw "jiuwenClaw dependency install failed"
        }
        Write-Ok "jiuwenClaw runtime prepared"
        return $true
    } catch {
        Write-Warn "jiuwenClaw runtime setup failed - sidecar will stay unavailable"
        Write-InstallerExceptionDetails -Context "jiuwenClaw runtime" -ErrorRecord $_
        return $false
    } finally {
        Pop-Location
    }
}

function New-InstallerAuthState {
    param([string]$ProjectRoot)
    [pscustomobject]@{
        ProjectRoot = $ProjectRoot
        HelperPath = Join-Path $ProjectRoot "scripts\install-auth-config.mjs"
        EnvSetMap = [ordered]@{}
        EnvDeleteMap = @{}
    }
}

function Set-InstallerEnvValue {
    param($State, [string]$Key, [string]$Value)
    $State.EnvSetMap[$Key] = $Value
    if ($State.EnvDeleteMap.ContainsKey($Key)) {
        $State.EnvDeleteMap.Remove($Key) | Out-Null
    }
}

function Add-InstallerEnvDelete {
    param($State, [string]$Key)
    if ($State.EnvSetMap.Contains($Key)) {
        $State.EnvSetMap.Remove($Key)
    }
    $State.EnvDeleteMap[$Key] = $true
}

function Invoke-InstallerAuthHelper {
    param($State, [string[]]$CommandArgs)
    if (-not (Test-Path $State.HelperPath)) {
        throw "Missing install auth helper: $($State.HelperPath)"
    }
    & node $State.HelperPath @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "install auth helper failed"
    }
}

function Set-CodexOAuthMode {
    param($State)
    Set-InstallerEnvValue $State "CODEX_AUTH_MODE" "oauth"
    Add-InstallerEnvDelete $State "OPENAI_API_KEY"
    Add-InstallerEnvDelete $State "OPENAI_BASE_URL"
    Add-InstallerEnvDelete $State "CAT_CODEX_MODEL"
}

function Set-CodexApiKeyMode {
    param($State, [string]$ApiKey, [string]$BaseUrl, [string]$Model)

    Set-InstallerEnvValue $State "CODEX_AUTH_MODE" "api_key"
    Set-InstallerEnvValue $State "OPENAI_API_KEY" $ApiKey
    if ($BaseUrl) { Set-InstallerEnvValue $State "OPENAI_BASE_URL" $BaseUrl } else { Add-InstallerEnvDelete $State "OPENAI_BASE_URL" }
    if ($Model) { Set-InstallerEnvValue $State "CAT_CODEX_MODEL" $Model } else { Add-InstallerEnvDelete $State "CAT_CODEX_MODEL" }
}

function Set-GeminiOAuthMode {
    param($State)
    Add-InstallerEnvDelete $State "GEMINI_API_KEY"
    Add-InstallerEnvDelete $State "CAT_GEMINI_MODEL"
}

function Set-GeminiApiKeyMode {
    param($State, [string]$ApiKey, [string]$Model)

    Set-InstallerEnvValue $State "GEMINI_API_KEY" $ApiKey
    if ($Model) { Set-InstallerEnvValue $State "CAT_GEMINI_MODEL" $Model } else { Add-InstallerEnvDelete $State "CAT_GEMINI_MODEL" }
}

function Set-ClaudeInstallerProfile {
    param($State, [string]$ApiKey, [string]$BaseUrl, [string]$Model)

    $profileArgs = @("claude-profile", "set", "--project-dir", $State.ProjectRoot)
    if ($BaseUrl) { $profileArgs += @("--base-url", $BaseUrl) }
    if ($Model) { $profileArgs += @("--model", $Model) }
    # Pass API key via environment variable to avoid exposure in process listing
    $env:_INSTALLER_API_KEY = $ApiKey
    try {
        Invoke-InstallerAuthHelper $State $profileArgs
    } finally {
        Remove-Item Env:\_INSTALLER_API_KEY -ErrorAction SilentlyContinue
    }
}

function Remove-ClaudeInstallerProfile {
    param($State)
    Invoke-InstallerAuthHelper $State @("claude-profile", "remove", "--project-dir", $State.ProjectRoot)
}

function Read-InstallerSecret {
    param([string]$Prompt)

    $secureValue = Read-Host $Prompt -AsSecureString
    if ($null -eq $secureValue) {
        return ""
    }

    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        if ($bstr -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
}

function Configure-InstallerAuth {
    param([string]$ProjectRoot, $State)

    $hasClaude = $null -ne (Resolve-ToolCommandWithRetry -Name "claude" -Attempts 6)
    $hasCodex = $null -ne (Resolve-ToolCommandWithRetry -Name "codex" -Attempts 6)
    $hasGemini = $null -ne (Resolve-ToolCommandWithRetry -Name "gemini" -Attempts 6)
    $isInteractive = [Environment]::UserInteractive -and -not $env:CI

    if (-not $isInteractive) {
        Write-Warn "Non-interactive mode - skipping auth prompts. Run claude / codex / gemini manually after install."
        return
    }

    if ($hasClaude) {
        Write-Host ""
        Write-Host "  Claude (claude):"
        $hasExistingProfile = Test-Path (Join-Path $ProjectRoot ".cat-cafe/provider-profiles.json")
        $claudeOptions = @()
        if ($hasExistingProfile) {
            $claudeOptions += @{ Label = "&Keep existing"; Help = "Keep the current Claude auth configuration"; Value = "keep" }
        }
        $claudeOptions += @(
            @{ Label = if ($hasExistingProfile) { "&OAuth" } else { "&OAuth (recommended)" }; Help = "Use Claude subscription / OAuth"; Value = "oauth" },
            @{ Label = "&API Key"; Help = "Write an installer-managed Claude API key profile"; Value = "api_key" },
            @{ Label = "&Skip"; Help = "Skip Claude auth setup for now"; Value = "skip" }
        )
        $choice = Select-InstallerChoice -Title "Claude auth" -Prompt "Choose how to configure Claude" -Options $claudeOptions
        if ($choice -eq "keep") {
            Write-Ok "Claude: keeping existing configuration"
        } elseif ($choice -eq "api_key") {
            $apiKey = Read-InstallerSecret "    API Key"
            $baseUrl = Read-Host "    Base URL (Enter = https://api.anthropic.com)"
            $model = Read-Host "    Model (Enter = default)"
            if ($apiKey) {
                Set-ClaudeInstallerProfile $State $apiKey $baseUrl $model
                Write-Ok "Claude API key profile written to .cat-cafe/"
            } else {
                Remove-ClaudeInstallerProfile $State
                Write-Warn "Claude API key empty - keeping OAuth"
            }
        } elseif ($choice -eq "oauth") {
            Remove-ClaudeInstallerProfile $State
            Write-Ok "Claude: OAuth mode"
        } else {
            Write-Warn "Claude auth setup skipped"
        }
    }

    if ($hasCodex) {
        Write-Host ""
        Write-Host "  Codex (codex):"
        $existingCodexKey = Get-InstallerEnvValueFromFile -EnvFile (Join-Path $ProjectRoot ".env") -Key "OPENAI_API_KEY"
        $codexOptions = @()
        if ($existingCodexKey) {
            $codexOptions += @{ Label = "&Keep existing"; Help = "Keep the current Codex auth configuration"; Value = "keep" }
        }
        $codexOptions += @(
            @{ Label = if ($existingCodexKey) { "&OAuth" } else { "&OAuth (recommended)" }; Help = "Use Codex OAuth / subscription"; Value = "oauth" },
            @{ Label = "&API Key"; Help = "Store OpenAI API settings in .env"; Value = "api_key" },
            @{ Label = "&Skip"; Help = "Skip Codex auth setup for now"; Value = "skip" }
        )
        $choice = Select-InstallerChoice -Title "Codex auth" -Prompt "Choose how to configure Codex" -Options $codexOptions
        if ($choice -eq "keep") {
            Write-Ok "Codex: keeping existing configuration"
        } elseif ($choice -eq "api_key") {
            $apiKey = Read-InstallerSecret "    API Key"
            $baseUrl = Read-Host "    Base URL (Enter = default)"
            $model = Read-Host "    Model (Enter = default)"
            if ($apiKey) {
                Set-CodexApiKeyMode $State $apiKey $baseUrl $model
                Write-Ok "Codex API key collected for .env"
            } else {
                Set-CodexOAuthMode $State
                Write-Warn "Codex API key empty - keeping OAuth"
            }
        } elseif ($choice -eq "oauth") {
            Set-CodexOAuthMode $State
            Write-Ok "Codex: OAuth mode"
        } else {
            Write-Warn "Codex auth setup skipped"
        }
    }

    if ($hasGemini) {
        Write-Host ""
        Write-Host "  Gemini (gemini):"
        $existingGeminiKey = Get-InstallerEnvValueFromFile -EnvFile (Join-Path $ProjectRoot ".env") -Key "GEMINI_API_KEY"
        $geminiOptions = @()
        if ($existingGeminiKey) {
            $geminiOptions += @{ Label = "&Keep existing"; Help = "Keep the current Gemini auth configuration"; Value = "keep" }
        }
        $geminiOptions += @(
            @{ Label = if ($existingGeminiKey) { "&OAuth" } else { "&OAuth (recommended)" }; Help = "Use Gemini OAuth / subscription"; Value = "oauth" },
            @{ Label = "&API Key"; Help = "Store Gemini API settings in .env"; Value = "api_key" },
            @{ Label = "&Skip"; Help = "Skip Gemini auth setup for now"; Value = "skip" }
        )
        $choice = Select-InstallerChoice -Title "Gemini auth" -Prompt "Choose how to configure Gemini" -Options $geminiOptions
        if ($choice -eq "keep") {
            Write-Ok "Gemini: keeping existing configuration"
        } elseif ($choice -eq "api_key") {
            $apiKey = Read-InstallerSecret "    API Key"
            $model = Read-Host "    Model (Enter = default)"
            if ($apiKey) {
                Set-GeminiApiKeyMode $State $apiKey $model
                Write-Ok "Gemini API key collected for .env"
            } else {
                Set-GeminiOAuthMode $State
                Write-Warn "Gemini API key empty - keeping OAuth"
            }
        } elseif ($choice -eq "oauth") {
            Set-GeminiOAuthMode $State
            Write-Ok "Gemini: OAuth mode"
        } else {
            Write-Warn "Gemini auth setup skipped"
        }
    }
}

function Apply-InstallerAuthEnv {
    param($State, [string]$EnvFile)
    if ($State.EnvSetMap.Count -eq 0 -and $State.EnvDeleteMap.Count -eq 0) { return }
    $helperArgs = @("env-apply", "--env-file", $EnvFile)
    foreach ($key in $State.EnvSetMap.Keys) {
        $helperArgs += @("--set", "$key=$($State.EnvSetMap[$key])")
    }
    foreach ($key in $State.EnvDeleteMap.Keys) {
        $helperArgs += @("--delete", $key)
    }
    Invoke-InstallerAuthHelper $State $helperArgs
    Write-Ok "Auth config written to .env"
}
