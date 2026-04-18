function Test-InstallerConsoleUi {
    if (-not ([Environment]::UserInteractive) -or $env:CI) {
        return $false
    }
    try {
        [void][Console]::CursorVisible
        return $true
    } catch {
        return $false
    }
}

function Get-InstallerOptionText {
    param($Option)
    $text = $Option.Label
    if (-not $text) { $text = $Option.Name }
    if (-not $text) { $text = $Option.Cmd }
    if (-not $text) { $text = $Option.Value }
    return ([string]$text).Replace("&", "")
}

function Write-InstallerChoiceScreen {
    param(
        [string]$Title,
        [string]$Prompt,
        [string]$Instructions,
        [object[]]$Options,
        [int]$ActiveIndex,
        [hashtable]$SelectedMap
    )

    Clear-Host
    Write-Host ""
    Write-Host "$Title :" -ForegroundColor White
    Write-Host $Prompt -ForegroundColor White
    Write-Host $Instructions -ForegroundColor Gray
    Write-Host ""

    for ($i = 0; $i -lt $Options.Count; $i++) {
        $prefix = if ($i -eq $ActiveIndex) { "> " } else { "  " }
        $marker = ""
        if ($SelectedMap) {
            $marker = if ($SelectedMap.ContainsKey($i)) { "[*] " } else { "[ ] " }
        }
        $line = "$prefix$marker$(Get-InstallerOptionText $Options[$i])"
        $color = if ($i -eq $ActiveIndex) { "Cyan" } else { "White" }
        Write-Host $line -ForegroundColor $color
    }
}

function Select-InstallerChoice {
    param([string]$Title, [string]$Prompt, [object[]]$Options, [int]$DefaultIndex = 0)
    if ($Options.Count -eq 0) { return $null }
    if (-not (Test-InstallerConsoleUi)) {
        return $Options[$DefaultIndex].Value
    }

    $index = [Math]::Max(0, [Math]::Min($DefaultIndex, $Options.Count - 1))
    $cursorVisible = $true
    try {
        $cursorVisible = [Console]::CursorVisible
        [Console]::CursorVisible = $false
    } catch {}

    try {
        while ($true) {
            Write-InstallerChoiceScreen -Title $Title -Prompt $Prompt -Instructions "Use Up/Down arrows to move, Enter to select" -Options $Options -ActiveIndex $index
            $key = [Console]::ReadKey($true)
            switch ($key.Key) {
                "UpArrow" { $index = if ($index -le 0) { $Options.Count - 1 } else { $index - 1 } }
                "DownArrow" { $index = if ($index -ge ($Options.Count - 1)) { 0 } else { $index + 1 } }
                "Enter" { return $Options[$index].Value }
            }
        }
    } finally {
        try { [Console]::CursorVisible = $cursorVisible } catch {}
    }
}

function Select-InstallerMultiChoice {
    param([string]$Title, [string]$Prompt, [object[]]$Options)
    if ($Options.Count -eq 0) { return @() }
    if (-not (Test-InstallerConsoleUi)) {
        return @($Options)
    }

    $index = 0
    $selectedMap = @{}
    for ($i = 0; $i -lt $Options.Count; $i++) {
        $selectedMap[$i] = $true
    }

    $cursorVisible = $true
    try {
        $cursorVisible = [Console]::CursorVisible
        [Console]::CursorVisible = $false
    } catch {}

    try {
        while ($true) {
            Write-InstallerChoiceScreen -Title $Title -Prompt $Prompt -Instructions "Use Up/Down to move, Space to toggle, Enter to confirm" -Options $Options -ActiveIndex $index -SelectedMap $selectedMap
            $key = [Console]::ReadKey($true)
            switch ($key.Key) {
                "UpArrow" { $index = if ($index -le 0) { $Options.Count - 1 } else { $index - 1 } }
                "DownArrow" { $index = if ($index -ge ($Options.Count - 1)) { 0 } else { $index + 1 } }
                "Spacebar" {
                    if ($selectedMap.ContainsKey($index)) {
                        $selectedMap.Remove($index) | Out-Null
                    } else {
                        $selectedMap[$index] = $true
                    }
                }
                "Enter" {
                    $selected = @()
                    foreach ($selectedIndex in ($selectedMap.Keys | Sort-Object)) {
                        $selected += $Options[$selectedIndex]
                    }
                    return @($selected)
                }
            }
        }
    } finally {
        try { [Console]::CursorVisible = $cursorVisible } catch {}
    }
}

function Get-InstallerEnvValueFromFile {
    param([string]$EnvFile, [string]$Key)
    if (-not $EnvFile -or -not (Test-Path $EnvFile)) {
        return ""
    }
    foreach ($rawLine in (Get-Content $EnvFile)) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith("#")) {
            continue
        }
        $parts = $line -split "=", 2
        if ($parts.Count -ne 2) {
            continue
        }
        if ($parts[0].Trim() -ne $Key) {
            continue
        }
        return $parts[1].Trim().Trim('"').Trim("'")
    }
    return ""
}

function Get-InstallerExternalRedisUrl {
    param([string]$ProjectRoot)
    $envFile = Join-Path $ProjectRoot ".env"
    $rawUrl = Get-InstallerEnvValueFromFile -EnvFile $envFile -Key "REDIS_URL"
    if (-not $rawUrl -and (Test-Path $envFile) -and $env:REDIS_URL) {
        $rawUrl = $env:REDIS_URL.Trim()
    }
    if (-not $rawUrl) { return "" }
    $redisPort = Get-InstallerEnvValueFromFile -EnvFile $envFile -Key "REDIS_PORT"
    if (-not $redisPort) { $redisPort = "6399" }
    if (Test-LocalRedisUrl -RedisUrl $rawUrl -RedisPort $redisPort) { return "" }
    return $rawUrl
}

function Get-InstallerAnyRedisUrl {
    param([string]$ProjectRoot)
    $envFile = Join-Path $ProjectRoot ".env"
    $rawUrl = Get-InstallerEnvValueFromFile -EnvFile $envFile -Key "REDIS_URL"
    if (-not $rawUrl -and (Test-Path $envFile) -and $env:REDIS_URL) {
        $rawUrl = $env:REDIS_URL.Trim()
    }
    if (-not $rawUrl) { return "" }
    return $rawUrl
}

function Get-InstallerRedactedRedisUrl {
    param([string]$RedisUrl)
    return Get-RedactedRedisUrl -RedisUrl $RedisUrl
}

function Resolve-InstallerRedisPlan {
    param([string]$ProjectRoot)
    $defaultRedisUrl = Get-InstallerExternalRedisUrl -ProjectRoot $ProjectRoot
    $anyRedisUrl = Get-InstallerAnyRedisUrl -ProjectRoot $ProjectRoot
    $mode = if (Test-InstallerConsoleUi) {
        $redisOptions = @()
        if ($defaultRedisUrl) {
            $safeLabel = Get-InstallerRedactedRedisUrl -RedisUrl $defaultRedisUrl
            $redisOptions += @{ Label = "&Keep external ($safeLabel)"; Help = "Keep the current external Redis URL"; Value = "keep_external" }
        } elseif ($anyRedisUrl) {
            $safeLabel = Get-InstallerRedactedRedisUrl -RedisUrl $anyRedisUrl
            $redisOptions += @{ Label = "&Keep current Redis ($safeLabel)"; Help = "Keep the current local Redis configuration"; Value = "keep_local" }
        }
        $redisOptions += @(
            @{ Label = if ($defaultRedisUrl -or $anyRedisUrl) { "&Install Redis locally" } else { "&Install Redis locally (recommended)" }; Help = "Download or reuse the project-local portable Redis bundle"; Value = "portable" },
            @{ Label = "&Use external Redis URL"; Help = "Use an existing external Redis instance"; Value = "external" }
        )
        Select-InstallerChoice -Title "Redis setup" -Prompt "Choose how this workspace should store runtime data" -Options $redisOptions
    } elseif ($defaultRedisUrl) { "keep_external" } elseif ($anyRedisUrl) { "keep_local" } else { "portable" }

    if ($mode -eq "keep_external") {
        return [pscustomobject]@{ Mode = "external"; RedisUrl = $defaultRedisUrl }
    }
    if ($mode -eq "keep_local") {
        return [pscustomobject]@{ Mode = "keep_local"; RedisUrl = $anyRedisUrl }
    }
    $redisUrl = ""
    if ($mode -eq "external") {
        if (Test-InstallerConsoleUi) {
            while (-not $redisUrl) {
                $redisUrl = (Read-Host "  External Redis URL").Trim()
                if (-not $redisUrl) {
                    Write-Warn "External Redis URL is required when you choose external Redis."
                }
            }
        } else {
            $redisUrl = $defaultRedisUrl
        }
    }
    return [pscustomobject]@{ Mode = $mode; RedisUrl = $redisUrl }
}

function Apply-InstallerRedisPlan {
    param($State, [string]$ProjectRoot, $Plan)
    if ($Plan.Mode -eq "external") {
        $redisValidationError = Get-InstallerExternalRedisValidationError -RedisUrl $Plan.RedisUrl
        if ($redisValidationError) {
            Write-Warn $redisValidationError
            return $false
        }
    }
    if ($Plan.Mode -eq "external" -or $Plan.Mode -eq "keep_local") {
        Set-InstallerEnvValue $State "REDIS_URL" $Plan.RedisUrl
        Add-InstallerEnvDelete $State "MEMORY_STORE"
        $safeRedisUrl = Get-InstallerRedactedRedisUrl -RedisUrl $Plan.RedisUrl
        if ($Plan.Mode -eq "keep_local") {
            Write-Ok "Preserving local Redis URL: $safeRedisUrl"
        } else {
            Write-Ok "Using external Redis: $safeRedisUrl"
        }
        return $true
    }

    Add-InstallerEnvDelete $State "REDIS_URL"
    Add-InstallerEnvDelete $State "MEMORY_STORE"
    return (Ensure-WindowsRedis -ProjectRoot $ProjectRoot -Memory:$false)
}
