function Expand-NpmConfigPrefix {
    param([string]$Prefix)
    $expanded = [Environment]::ExpandEnvironmentVariables($Prefix)
    return [regex]::Replace($expanded, '\$\{([^}]+)\}', {
        param($match)
        $value = [Environment]::GetEnvironmentVariable($match.Groups[1].Value)
        if ($null -eq $value) { return $match.Value }
        return $value
    })
}

function Get-NpmConfigPrefixCandidates {
    $prefixes = @()
    if ($env:NPM_CONFIG_PREFIX) { $prefixes += $env:NPM_CONFIG_PREFIX }
    if ($env:npm_config_prefix) { $prefixes += $env:npm_config_prefix }

    $npmConfigPaths = @()
    if ($env:NPM_CONFIG_USERCONFIG) { $npmConfigPaths += $env:NPM_CONFIG_USERCONFIG }
    if ($env:npm_config_userconfig) { $npmConfigPaths += $env:npm_config_userconfig }
    if ($env:NPM_CONFIG_GLOBALCONFIG) { $npmConfigPaths += $env:NPM_CONFIG_GLOBALCONFIG }
    if ($env:npm_config_globalconfig) { $npmConfigPaths += $env:npm_config_globalconfig }
    if ($env:USERPROFILE) { $npmConfigPaths += (Join-Path $env:USERPROFILE ".npmrc") }
    if ($env:APPDATA) { $npmConfigPaths += (Join-Path $env:APPDATA "npm\etc\npmrc") }
    if ($env:ProgramData) { $npmConfigPaths += (Join-Path $env:ProgramData "npm\npmrc") }
    if ($env:ProgramFiles) {
        $npmConfigPaths += (Join-Path $env:ProgramFiles "nodejs\etc\npmrc")
        $npmConfigPaths += (Join-Path $env:ProgramFiles "nodejs\node_modules\npm\npmrc")
    }
    $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    if ($programFilesX86) {
        $npmConfigPaths += (Join-Path $programFilesX86 "nodejs\etc\npmrc")
        $npmConfigPaths += (Join-Path $programFilesX86 "nodejs\node_modules\npm\npmrc")
    }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $nodePath = if ($nodeCommand.Path) { $nodeCommand.Path } else { $nodeCommand.Source }
        if ($nodePath) {
            $nodeDir = Split-Path -Parent $nodePath
            $npmConfigPaths += (Join-Path $nodeDir "etc\npmrc")
            $npmConfigPaths += (Join-Path $nodeDir "node_modules\npm\npmrc")
        }
    }

    foreach ($npmConfigPath in ($npmConfigPaths | Where-Object { $_ } | Select-Object -Unique)) {
        if (-not (Test-Path $npmConfigPath)) { continue }
        foreach ($line in (Get-Content $npmConfigPath -ErrorAction SilentlyContinue)) {
            $trimmed = $line.Trim()
            if (-not $trimmed -or $trimmed.StartsWith("#") -or $trimmed.StartsWith(";")) { continue }
            if ($trimmed -match '^prefix\s*=\s*(.+)$') {
                $prefix = $Matches[1].Trim().Trim('"').Trim("'")
                if ($prefix) { $prefixes += (Expand-NpmConfigPrefix -Prefix $prefix) }
            }
        }
    }

    return @($prefixes | Where-Object { $_ } | Select-Object -Unique)
}

function Get-ToolCommandCandidates {
    param([string]$Name)
    $candidates = @()
    if ($env:APPDATA) {
        $candidates += @((Join-Path $env:APPDATA "npm\$Name.cmd"), (Join-Path $env:APPDATA "npm\$Name.ps1"), (Join-Path $env:APPDATA "npm\$Name"))
    }
    foreach ($npmPrefix in (Get-NpmConfigPrefixCandidates)) {
        $candidates += @((Join-Path $npmPrefix "$Name.cmd"), (Join-Path $npmPrefix "$Name.ps1"), (Join-Path $npmPrefix $Name))
    }
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCommand) {
        $npmPath = if ($npmCommand.Path) { $npmCommand.Path } else { $npmCommand.Source }
        try {
            $npmPrefix = @(& $npmPath prefix -g 2>$null) | Select-Object -Last 1
            if ($npmPrefix -and (Test-Path $npmPrefix -ErrorAction SilentlyContinue)) {
                $candidates += @((Join-Path $npmPrefix "$Name.cmd"), (Join-Path $npmPrefix "$Name.ps1"), (Join-Path $npmPrefix $Name))
            }
        } catch {}
    }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $nodePath = if ($nodeCommand.Path) { $nodeCommand.Path } else { $nodeCommand.Source }
        if ($nodePath) {
            $nodeDir = Split-Path -Parent $nodePath
            $candidates += @((Join-Path $nodeDir "$Name.cmd"), (Join-Path $nodeDir "$Name.ps1"), (Join-Path $nodeDir $Name))
        }
    }
    return @($candidates | Where-Object { $_ } | Select-Object -Unique)
}

function Test-ToolCommandCandidate {
    param([string]$Candidate)
    try {
        & $Candidate "--version" 1>$null 2>$null
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { return $true }
        return $exitCode -eq 0
    } catch {
        return $false
    }
}

function Resolve-ToolCommand {
    param([string]$Name)
    foreach ($candidate in (Get-ToolCommandCandidates -Name $Name)) {
        if (Test-Path $candidate) {
            if (Test-ToolCommandCandidate -Candidate $candidate) {
                Add-ProcessPathPrefix -Directory (Split-Path -Parent $candidate)
                return $candidate
            }
        }
    }
    $toolCommand = Get-Command $Name -ErrorAction SilentlyContinue
    if ($toolCommand -and $toolCommand.Path) { return $toolCommand.Path }
    if ($toolCommand -and $toolCommand.Source) { return $toolCommand.Source }
    return $null
}

function Merge-ToolPathSegments {
    param([string[]]$PathValues)

    $seen = @{}
    $segments = New-Object System.Collections.Generic.List[string]
    foreach ($pathValue in $PathValues) {
        if (-not $pathValue) {
            continue
        }
        foreach ($segment in ($pathValue -split ";")) {
            $candidate = $segment.Trim()
            if (-not $candidate) {
                continue
            }
            $normalized = $candidate.TrimEnd('\').ToLowerInvariant()
            if ($seen.ContainsKey($normalized)) {
                continue
            }
            $seen[$normalized] = $true
            $segments.Add($candidate)
        }
    }
    return @($segments)
}

function Sync-ToolPath {
    $processPath = $env:Path
    $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $segments = Merge-ToolPathSegments -PathValues @($processPath, $machinePath, $userPath)
    if ($segments.Count -gt 0) {
        $env:Path = ($segments -join ";")
    }
}

function Resolve-ToolCommandWithRetry {
    param([string]$Name, [int]$Attempts = 1, [int]$DelayMs = 500)
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        Sync-ToolPath
        $toolCommand = Resolve-ToolCommand -Name $Name
        if ($toolCommand) { return $toolCommand }
        if ($attempt -lt ($Attempts - 1)) {
            Start-Sleep -Milliseconds $DelayMs
        }
    }
    return $null
}

function Write-ToolResolutionDiagnostics {
    param([string]$Name)
    Write-Warn "$Name resolver candidates:"
    foreach ($candidate in (Get-ToolCommandCandidates -Name $Name)) {
        $status = if (Test-Path $candidate) { "exists" } else { "missing" }
        Write-Warn "  [$status] $candidate"
    }
}

function Invoke-ToolCommand {
    param([string]$Name, [string[]]$CommandArgs)
    $toolCommand = Resolve-ToolCommand -Name $Name
    if (-not $toolCommand) { throw "$Name command not found" }
    & $toolCommand @CommandArgs
}
