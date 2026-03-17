function Get-ToolCommandCandidates {
    param([string]$Name)
    $candidates = @()
    if ($env:APPDATA) {
        $candidates += @((Join-Path $env:APPDATA "npm\$Name.cmd"), (Join-Path $env:APPDATA "npm\$Name.ps1"), (Join-Path $env:APPDATA "npm\$Name"))
    }
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCommand) {
        $npmPath = if ($npmCommand.Path) { $npmCommand.Path } else { $npmCommand.Source }
        try {
            $npmPrefix = @(& $npmPath prefix -g 2>$null) | Select-Object -Last 1
            if ($npmPrefix) {
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

function Resolve-ToolCommand {
    param([string]$Name)
    $toolCommand = Get-Command $Name -ErrorAction SilentlyContinue
    if ($toolCommand -and $toolCommand.Path) { return $toolCommand.Path }
    if ($toolCommand -and $toolCommand.Source) { return $toolCommand.Source }
    foreach ($candidate in (Get-ToolCommandCandidates -Name $Name)) {
        if (Test-Path $candidate) {
            Add-ProcessPathPrefix -Directory (Split-Path -Parent $candidate)
            return $candidate
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
