<#
.SYNOPSIS
  Cat Cafe - Windows Repo-Local Install Helper

.DESCRIPTION
  Installs prerequisites and sets up the current checked-out cat-cafe repo.
  Clone or download the repo first, then run this helper from inside it.
  Steps: env detect -> preflight network check -> Node/pnpm install -> Redis -> .env generate
         -> deps & build -> skills mount -> AI CLI tools -> verify & optionally start

.EXAMPLE
  # From repo root:
  .\scripts\install.ps1
#>

param(
    [switch]$Start,
    [switch]$SkipBuild,
    [switch]$SkipCli,
    [switch]$SkipPreflight,
    [switch]$Debug
)

$ErrorActionPreference = "Stop"

function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

function Refresh-Path {
    Sync-ToolPath
}

function Resolve-PnpmCommand { Resolve-ToolCommand -Name "pnpm" }
function Invoke-Pnpm { param([string[]]$CommandArgs) Invoke-ToolCommand -Name "pnpm" -CommandArgs $CommandArgs }
function Get-CommandOutputText {
    param([object[]]$OutputLines)
    return (@($OutputLines) | ForEach-Object { "$_" }) -join "`n"
}
function Test-PuppeteerBrowserDownloadFailure {
    param([string]$OutputText)
    return $OutputText -match "puppeteer" -and
        ($OutputText -match "Failed to set up chrome" -or $OutputText -match "PUPPETEER_SKIP_DOWNLOAD")
}
function Write-PuppeteerSkipWarning {
    Write-Warn "Bundled Chrome download failed - skipped"
    Write-Warn "Thread export / screenshot may be unavailable. To install later: npx puppeteer browsers install chrome"
}
function Test-LockfileMismatchFailure {
    param([string]$OutputText)
    if (-not $OutputText) { return $false }
    # Classify pnpm 9 lockfile drift (the only failure mode that justifies a plain
    # `pnpm install` retry). Anything else (EPERM, network, native build) must
    # surface its original stderr rather than be re-buried under a misleading
    # "Frozen lockfile failed, retrying..." line.
    return ($OutputText -match "ERR_PNPM_OUTDATED_LOCKFILE") -or
           ($OutputText -match "ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE") -or
           ($OutputText -match "ERR_PNPM_LOCKFILE_BREAKING_CHANGE") -or
           ($OutputText -match "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH") -or
           ($OutputText -match "Cannot install with .frozen-lockfile") -or
           ($OutputText -match "lockfile is not up to date") -or
           ($OutputText -match "lockfile.*is incompatible") -or
           ($OutputText -match "Cannot proceed with .* without the lockfile")
}
function Test-WindowsEpermFailure {
    param([string]$OutputText)
    if (-not $OutputText) { return $false }
    return ($OutputText -match "EPERM[:\s]") -or
           ($OutputText -match "EBUSY[:\s]") -or
           ($OutputText -match "EACCES[:\s]") -or
           ($OutputText -match "operation not permitted") -or
           ($OutputText -match "resource busy or locked")
}
function Write-WindowsEpermHint {
    Write-Err "This looks like a Windows file-system error (EPERM/EBUSY/EACCES),"
    Write-Err "not a lockfile mismatch. Common causes and fixes:"
    Write-Err "  1. Antivirus / Windows Defender locking files in the pnpm store"
    Write-Err "     -> Add your project folder and %LOCALAPPDATA%\pnpm to Defender exclusions, then retry"
    Write-Err "  2. A previous Node / pnpm / installer process still holding files open"
    Write-Err "     -> Close other shells, reboot, then retry"
    Write-Err "  3. Long path support disabled"
    Write-Err "     -> Enable Win32 long paths (LongPathsEnabled=1 under HKLM\SYSTEM\CurrentControlSet\Control\FileSystem)"
    Write-Err "  4. Project path requires elevation or sits on a sync'd drive (OneDrive/Dropbox)"
    Write-Err "     -> Move the project under your local user profile, or run PowerShell as Administrator"
}
function Invoke-PnpmInstallWithCapturedOutput {
    param(
        [string[]]$CommandArgs,
        [switch]$SkipPuppeteerDownload
    )

    $capturedOutput = @()
    $hadPreviousSkip = Test-Path Env:PUPPETEER_SKIP_DOWNLOAD
    $previousSkipValue = if ($hadPreviousSkip) { $env:PUPPETEER_SKIP_DOWNLOAD } else { $null }
    $previousErrorActionPreference = $ErrorActionPreference

    # Resolve pnpm BEFORE the captured pipeline. Wrapping pnpm in the
    # Invoke-Pnpm -> Invoke-ToolCommand function chain made the native exit
    # code unreliable in PowerShell 5.1: pnpm could exit 0 yet the captured
    # pipeline observed $LASTEXITCODE = -1 (sentinel never overwritten),
    # which made Step 5 misclassify successful installs as failure on
    # Windows / Node 24 (reproduced on pnpm 9.15.4).
    $pnpmCommand = Resolve-PnpmCommand
    if (-not $pnpmCommand) {
        return [pscustomobject]@{
            Ok = $false
            ErrorRecord = $null
            OutputText = "pnpm command not found"
        }
    }

    try {
        if ($SkipPuppeteerDownload) {
            $env:PUPPETEER_SKIP_DOWNLOAD = "1"
        } elseif (-not $hadPreviousSkip) {
            Remove-Item Env:PUPPETEER_SKIP_DOWNLOAD -ErrorAction SilentlyContinue
        }

        # Sentinel: $LASTEXITCODE is a process-global automatic variable, BUT
        # PowerShell 5.1 will silently shadow it into the function scope the
        # moment we assign without an explicit scope qualifier. After that
        # shadowing, even a successful native command exit only updates
        # $global:LASTEXITCODE; the function-local copy stays at -1 and the
        # success check below sees the stale sentinel, misclassifying a
        # successful pnpm install as failure (verified on the Windows
        # reporter's PowerShell 5.1 / Node 24 / pnpm 9.15.4 box).
        #
        # Fix: assign and read via $global:LASTEXITCODE explicitly so we are
        # always observing the process-global value pnpm.exe actually updates.
        $global:LASTEXITCODE = -1
        try {
            # Scope this down to the captured pnpm pipeline: under script-wide
            # Stop, PowerShell 5.1 can promote benign Node 24 stderr (DEP0169)
            # into a RemoteException before we can read pnpm's exit code.
            $ErrorActionPreference = "SilentlyContinue"
            & $pnpmCommand @CommandArgs 2>&1 | Tee-Object -Variable capturedOutput
            return [pscustomobject]@{
                Ok = $global:LASTEXITCODE -eq 0
                ErrorRecord = $null
                OutputText = Get-CommandOutputText -OutputLines $capturedOutput
            }
        } catch {
            # Two distinct scenarios reach this catch:
            #   (a) pnpm actually ran, exited 0, and only the 2>&1 | Tee-Object
            #       pipeline threw (e.g. Node 24 DEP0169 deprecation on stderr
            #       under $ErrorActionPreference=Stop). $global:LASTEXITCODE is
            #       now 0 and we should treat this as success.
            #   (b) pnpm itself failed before producing an exit code, or the
            #       captured pipeline aborted before pnpm started.
            #       $global:LASTEXITCODE is still -1 and the `-eq 0` check
            #       fails closed.
            if ($global:LASTEXITCODE -eq 0) {
                return [pscustomobject]@{
                    Ok = $true
                    ErrorRecord = $null
                    OutputText = Get-CommandOutputText -OutputLines ($capturedOutput + @($_))
                }
            }
            return [pscustomobject]@{
                Ok = $false
                ErrorRecord = $_
                OutputText = Get-CommandOutputText -OutputLines ($capturedOutput + @($_))
            }
        }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if ($hadPreviousSkip) {
            $env:PUPPETEER_SKIP_DOWNLOAD = $previousSkipValue
        } else {
            Remove-Item Env:PUPPETEER_SKIP_DOWNLOAD -ErrorAction SilentlyContinue
        }
    }
}
function Test-InstallerCancellation {
    param($ErrorRecord)
    if (-not $ErrorRecord -or -not $ErrorRecord.Exception) {
        return $false
    }
    $exception = $ErrorRecord.Exception
    while ($exception) {
        $exceptionType = $exception.GetType().FullName
        if ($exceptionType -eq 'System.Management.Automation.PipelineStoppedException' -or
            $exceptionType -eq 'System.Management.Automation.OperationStoppedException') {
            return $true
        }
        $exception = $exception.InnerException
    }
    return $false
}
function Exit-InstallerIfCancelled {
    param($ErrorRecord, [string]$Context)
    if (Test-InstallerCancellation -ErrorRecord $ErrorRecord) {
        Write-Err "$Context cancelled by user"
        exit 1
    }
}
function Get-PnpmStatus {
    param([int]$Attempts = 1, [int]$DelayMs = 500)
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        try {
            Refresh-Path
            $pnpmCommand = Resolve-PnpmCommand
            if ($pnpmCommand) {
                $pnpmRaw = & $pnpmCommand --version 2>$null
                if ($pnpmRaw -and $pnpmRaw -match '^(\d+)\.' -and [int]$Matches[1] -ge 8) {
                    return [pscustomobject]@{
                        Command = $pnpmCommand
                        Version = $pnpmRaw
                    }
                }
            }
        } catch {}
        if ($attempt -lt ($Attempts - 1)) {
            Start-Sleep -Milliseconds $DelayMs
        }
    }
    return $null
}

$ScriptPath = if ($PSCommandPath) { $PSCommandPath } elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path } else { $null }
if (-not $ScriptPath) {
    Write-Err "Could not resolve install.ps1 path. Run with: powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1"
    exit 1
}
$ScriptDir = Split-Path -Parent $ScriptPath
. (Join-Path $ScriptDir "install-windows-helpers.ps1")

function Resolve-ProjectRoot {
    $projectRoot = Split-Path -Parent $ScriptDir
    if (-not (Test-Path (Join-Path $projectRoot "package.json")) -or
        -not (Test-Path (Join-Path $projectRoot "packages/api"))) {
        Write-Err "Run this helper from a checked-out cat-cafe repo: .\scripts\install.ps1"
        exit 1
    }
    $gitRepoUnavailable = $false
    try {
        & git -C $projectRoot rev-parse --is-inside-work-tree 1>$null 2>$null
        $gitRepoUnavailable = $LASTEXITCODE -ne 0
    } catch {}
    if ($gitRepoUnavailable) {
        Write-Warn "No .git directory detected - git-dependent features will be unavailable"
    }
    return $projectRoot
}

# -- Step 1: Environment detection ---------------------------
Write-Step "Step 1/8 - Detect environment"

if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Err "PowerShell 5.0+ required (current: $($PSVersionTable.PSVersion))"
    exit 1
}
Write-Ok "PowerShell $($PSVersionTable.PSVersion)"

$hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
if ($hasWinget) { Write-Ok "winget available" } else { Write-Warn "winget not found - manual install may be needed" }

$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCommand) {
    Write-Warn "Git not found - git-dependent features will be unavailable"
} else {
    Write-Ok "Git: $(& $gitCommand.Source --version)"
}

$ProjectRoot = Resolve-ProjectRoot
$authState = New-InstallerAuthState -ProjectRoot $ProjectRoot

if ($env:CAT_CAFE_NPM_REGISTRY) {
    $env:NPM_CONFIG_REGISTRY = $env:CAT_CAFE_NPM_REGISTRY.Trim()
    Write-Ok "npm registry override: $($env:NPM_CONFIG_REGISTRY)"
}

# Preflight network check - fail early before installer-managed downloads.
$preflightScript = Join-Path $ProjectRoot "scripts\preflight.ps1"
if (-not $SkipPreflight -and (Test-Path $preflightScript)) {
    $pfArgs = @("-Timeout", "3")
    if ($env:CAT_CAFE_NPM_REGISTRY) { $pfArgs += @("-Registry", $env:CAT_CAFE_NPM_REGISTRY) }
    $pfResult = & powershell -ExecutionPolicy Bypass -File $preflightScript @pfArgs 2>&1
    $pfResult | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "Preflight detected unreachable endpoints (see above)."
        Write-Warn "Install may fail. Fix the issues above or use -SkipPreflight to bypass."
        if ([Environment]::UserInteractive -and -not $env:CI) {
            $continue = Read-Host "  Continue anyway? [y/N]"
            if ($continue -notmatch '^[Yy]') { Write-Err "Aborted by user"; exit 1 }
        } else {
            Write-Err "Non-interactive mode - aborting. Use -SkipPreflight to force."
            exit 1
        }
    }
}

Write-Step "Step 2/8 - Node.js and pnpm"

$nodeOk = $false
try {
    $nodeRaw = & node --version 2>$null
    if ($nodeRaw -match 'v(\d+)\.(\d+)') {
        $nodeMajor = [int]$Matches[1]
        if ($nodeMajor -ge 20) {
            Write-Ok "Node.js $nodeRaw"
            $nodeOk = $true
        } else {
            Write-Warn "Node.js $nodeRaw too old (need >= 20), upgrading..."
        }
    }
} catch {}

if (-not $nodeOk) {
    if ($hasWinget) {
        try {
            Write-Host "  Installing Node.js LTS via winget..."
            winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent 2>$null
            Refresh-Path
            $nodeRaw = & node --version 2>$null
            if ($nodeRaw -match 'v(\d+)\.(\d+)') {
                $nodeMajor = [int]$Matches[1]
                if ($nodeMajor -ge 20) {
                    Write-Ok "Node.js $nodeRaw installed"
                    $nodeOk = $true
                } else {
                    Write-Warn "Node.js $nodeRaw still too old after winget install"
                }
            } else {
                Write-Warn "Could not verify Node.js version after winget install"
            }
        } catch {
            Exit-InstallerIfCancelled -ErrorRecord $_ -Context "Node.js installation"
        }
        if (-not $nodeOk) {
            Write-Warn "winget Node.js install failed - falling back to manual prerequisite check"
        }
    }
    if (-not $nodeOk) {
        Write-Err "Node.js >= 20 required. Install from https://nodejs.org/"
        exit 1
    }
}

$pnpmOk = $false
try {
    $pnpmStatus = Get-PnpmStatus
    if ($pnpmStatus) {
        Write-Ok "pnpm $($pnpmStatus.Version)"
        $pnpmOk = $true
    }
} catch {}

if (-not $pnpmOk) {
    Write-Host "  Installing pnpm..."
    $npmCommand = Resolve-ToolCommand -Name "npm"
    if ($npmCommand) {
        try {
            & $npmCommand install -g pnpm 2>$null
            $pnpmStatus = Get-PnpmStatus -Attempts 6
            if ($pnpmStatus) {
                Write-Ok "pnpm $($pnpmStatus.Version) (via npm)"
                $pnpmOk = $true
            } else {
                throw "pnpm shim missing after npm install"
            }
        } catch {
            Exit-InstallerIfCancelled -ErrorRecord $_ -Context "pnpm installation"
        }
    }
    if (-not $pnpmOk) {
        $corepackCommand = Resolve-ToolCommand -Name "corepack"
        if ($corepackCommand) {
            try {
                & $corepackCommand enable 2>$null
                & $corepackCommand install -g pnpm@latest 2>$null
                $pnpmStatus = Get-PnpmStatus -Attempts 6
                if ($pnpmStatus) {
                    Write-Ok "pnpm $($pnpmStatus.Version) (via corepack)"
                    $pnpmOk = $true
                } else {
                    throw "pnpm shim missing after corepack install"
                }
            } catch {
                Exit-InstallerIfCancelled -ErrorRecord $_ -Context "pnpm installation"
            }
        }
    }
    if (-not $pnpmOk) {
        Write-ToolResolutionDiagnostics -Name "pnpm"
        Write-Err "Could not install pnpm. Run: npm install -g pnpm"
        exit 1
    }
}

Write-Step "Step 3/8 - Redis"

$redisPlan = Resolve-InstallerRedisPlan -ProjectRoot $ProjectRoot
$hasRedis = Apply-InstallerRedisPlan -State $authState -ProjectRoot $ProjectRoot -Plan $redisPlan
if (-not $hasRedis) {
    Write-Err "Redis setup failed. Install Redis locally or rerun and choose an external Redis URL."
    exit 1
}

Write-Step "Step 4/8 - Generate .env"

Set-Location $ProjectRoot
Write-Ok "Using project root: $ProjectRoot"

$envFile = Join-Path $ProjectRoot ".env"
$envExample = Join-Path $ProjectRoot ".env.example"

if (Test-Path $envFile) {
    Write-Ok ".env already exists - skipping"
} elseif (Test-Path $envExample) {
    Copy-Item $envExample $envFile
    Write-Ok ".env created from .env.example"
    Write-Warn "After launch, add API keys in Hub > System Settings > Account Configuration"
} else {
    Write-Warn ".env.example not found - creating minimal .env"
    @"
FRONTEND_PORT=3003
API_SERVER_PORT=3004
NEXT_PUBLIC_API_URL=http://localhost:3004
REDIS_PORT=6399
"@ | Out-File -FilePath $envFile -Encoding utf8
    Write-Ok "Minimal .env created"
}

# Flush installer state (Redis URL, MEMORY_STORE, etc. collected by
# Apply-InstallerRedisPlan in Step 3) into .env BEFORE we load it. We no
# longer write Claude/Codex/Gemini/Kimi auth from the installer, but the
# Redis env state still flows through the same EnvSetMap/EnvDeleteMap and
# this is the only call that persists it to disk.
Apply-InstallerAuthEnv -State $authState -EnvFile $envFile

# #675/#705: Generate TELEMETRY_HMAC_SALT if missing, quoted-empty, or whitespace-only
if (Test-Path $envFile) {
    $needsSalt = $true
    $saltLine = Select-String -Path $envFile -Pattern "^TELEMETRY_HMAC_SALT=" | Select-Object -First 1
    if ($saltLine) {
        $val = ($saltLine.Line -replace '^TELEMETRY_HMAC_SALT=', '').Trim().Trim('"', "'").Trim()
        if ($val.Length -gt 0) { $needsSalt = $false }
    }
    if ($needsSalt) {
        $bytes = [byte[]]::new(32)
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        $salt = -join ($bytes | ForEach-Object { "{0:x2}" -f $_ })
        Add-Content -Path $envFile -Value "TELEMETRY_HMAC_SALT=$salt"
        Write-Ok "Generated TELEMETRY_HMAC_SALT"
    }
}

# Load .env into current session so NEXT_PUBLIC_* vars are available at build time
if (Test-Path $envFile) {
    foreach ($line in (Get-Content $envFile)) {
        $trimmed = $line.Trim()
        if ($trimmed -and -not $trimmed.StartsWith("#") -and $trimmed -match '^([^=]+)=(.*)$') {
            $key = $Matches[1].Trim()
            $val = $Matches[2].Trim().Trim('"').Trim("'")
            [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
        }
    }
    Write-Ok ".env loaded into session"
}

Write-Step "Step 5/8 - Install dependencies and build"

# pnpm 9 + npm-global pnpm.cmd + Node 24 on Windows hits
# "Could not determine Node.js install directory" the moment `pnpm install`
# tries to auto-detect a store location. The Windows reporter verified that
# passing an explicit --store-dir + --package-import-method copy on the same
# machine makes the install succeed. Build the default arg suffix once and
# reuse it for every pnpm install invocation in this step.
$pnpmInstallExtra = @()
if ($env:OS -eq "Windows_NT" -and $env:LOCALAPPDATA) {
    $pnpmInstallExtra = @("--store-dir", (Join-Path $env:LOCALAPPDATA "pnpm\store"), "--package-import-method", "copy")
}

Write-Host "  Running pnpm install..."
$frozenInstallResult = Invoke-PnpmInstallWithCapturedOutput -CommandArgs (@("install", "--frozen-lockfile") + $pnpmInstallExtra)
if (-not $frozenInstallResult.Ok -and (Test-PuppeteerBrowserDownloadFailure -OutputText $frozenInstallResult.OutputText)) {
    Write-PuppeteerSkipWarning
    $frozenInstallResult = Invoke-PnpmInstallWithCapturedOutput -CommandArgs (@("install", "--frozen-lockfile") + $pnpmInstallExtra) -SkipPuppeteerDownload
}
if (-not $frozenInstallResult.Ok) {
    Exit-InstallerIfCancelled -ErrorRecord $frozenInstallResult.ErrorRecord -Context "pnpm install"
    if (Test-LockfileMismatchFailure -OutputText $frozenInstallResult.OutputText) {
        Write-Warn "Frozen lockfile failed, retrying..."
        # pnpm 8+ implicitly enables --frozen-lockfile when CI is set, so a
        # bare `pnpm install` retry would re-fail with the same lockfile
        # error in CI environments. Force --no-frozen-lockfile on the retry
        # so the recovery actually overrides pnpm's CI default.
        $plainInstallResult = Invoke-PnpmInstallWithCapturedOutput -CommandArgs (@("install", "--no-frozen-lockfile") + $pnpmInstallExtra)
        if (-not $plainInstallResult.Ok -and (Test-PuppeteerBrowserDownloadFailure -OutputText $plainInstallResult.OutputText)) {
            Write-PuppeteerSkipWarning
            $plainInstallResult = Invoke-PnpmInstallWithCapturedOutput -CommandArgs (@("install", "--no-frozen-lockfile") + $pnpmInstallExtra) -SkipPuppeteerDownload
        }
        if (-not $plainInstallResult.Ok) {
            Exit-InstallerIfCancelled -ErrorRecord $plainInstallResult.ErrorRecord -Context "pnpm install"
            Write-Err "pnpm install failed"
            exit 1
        }
    } else {
        # Non-lockfile failure (EPERM / EBUSY / network / native build). Falling back
        # to plain `pnpm install` would just repeat the same error and bury the real
        # cause under a misleading "Frozen lockfile failed" message.
        if (Test-WindowsEpermFailure -OutputText $frozenInstallResult.OutputText) {
            Write-WindowsEpermHint
        }
        Write-Err "pnpm install --frozen-lockfile failed"
        Write-Err "The real error is above. This is NOT a lockfile drift issue."
        exit 1
    }
}
Write-Ok "Dependencies installed"

if (-not $SkipBuild) {
    $buildSteps = @(
        @{ Name = "shared"; Path = "packages/shared" },
        @{ Name = "mcp-server"; Path = "packages/mcp-server" },
        @{ Name = "api"; Path = "packages/api" },
        @{ Name = "web"; Path = "packages/web" }
    )
    foreach ($step in $buildSteps) {
        Write-Host "  Building $($step.Name)..."
        Push-Location (Join-Path $ProjectRoot $step.Path)
        Invoke-Pnpm -CommandArgs @("run", "build")
        if ($LASTEXITCODE -ne 0) { Write-Err "Build failed: $($step.Name)"; Pop-Location; exit 1 }
        Pop-Location
        Write-Ok "$($step.Name)"
    }
} else {
    Write-Warn "Build skipped (-SkipBuild)"
}

Write-Step "Step 6/8 - Skills mount"
Mount-InstallerSkills -ProjectRoot $ProjectRoot

Write-Step "Step 7/8 - AI CLI tools"

$cliTools = @(
    @{ Name = "Claude"; Label = "Claude"; Cmd = "claude"; Pkg = "@anthropic-ai/claude-code" },
    @{ Name = "Codex"; Label = "Codex"; Cmd = "codex"; Pkg = "@openai/codex" },
    @{ Name = "Gemini"; Label = "Gemini"; Cmd = "gemini"; Pkg = "@google/gemini-cli" },
    @{ Name = "Kimi"; Label = "Kimi"; Cmd = "kimi"; Pkg = "kimi-cli"; InstallKind = "python" }
)

if (-not $SkipCli) {
    $missingTools = @($cliTools | Where-Object { -not (Resolve-ToolCommand -Name $_.Cmd) })
    $toolsToInstall = if ($missingTools.Count -gt 0 -and [Environment]::UserInteractive -and -not $env:CI) {
        Select-InstallerMultiChoice -Title "Missing agent CLIs" -Prompt "Choose which agent CLIs to install" -Options $missingTools
    } else { $missingTools }
    $selectedCliCommands = @($toolsToInstall | ForEach-Object { $_.Cmd })
    $npmInstallCommand = Resolve-ToolCommand -Name "npm"
    foreach ($tool in $cliTools) {
        $installed = $null -ne (Resolve-ToolCommand -Name $tool.Cmd)
        if ($installed) {
            Write-Ok "$($tool.Name) CLI already installed"
        } elseif ($toolsToInstall.Cmd -notcontains $tool.Cmd) {
            Write-Warn "$($tool.Name) CLI install skipped"
        } else {
            Write-Host "  Installing $($tool.Name) CLI..."
            try {
                if ($tool.InstallKind -eq "python") {
                    $uvCommand = Resolve-ToolCommand -Name "uv"
                    if ($uvCommand) {
                        & $uvCommand tool install --python 3.13 $tool.Pkg 2>$null
                    } else {
                        $pythonCommand = Resolve-ToolCommand -Name "python"
                        if (-not $pythonCommand) { $pythonCommand = Resolve-ToolCommand -Name "py" }
                        if (-not $pythonCommand) { throw "python command not found" }
                        & $pythonCommand -m pip install --user --upgrade $tool.Pkg 2>$null
                    }
                } else {
                    if (-not $npmInstallCommand) { throw "npm command not found" }
                    & $npmInstallCommand install -g $tool.Pkg 2>$null
                }
                if (Resolve-ToolCommandWithRetry -Name $tool.Cmd -Attempts 6) {
                    Write-Ok "$($tool.Name) CLI installed"
                } else {
                    Write-ToolResolutionDiagnostics -Name $tool.Cmd
                    Write-Warn "$($tool.Name) CLI install completed but command was not visible yet"
                }
            } catch {
                Exit-InstallerIfCancelled -ErrorRecord $_ -Context "$($tool.Name) CLI install"
                Write-Warn "Could not install $($tool.Name) CLI: npm install -g $($tool.Pkg)"
            }
        }
    }
} else {
    Write-Warn "CLI tools install skipped (-SkipCli)"
    $selectedCliCommands = @()
}

$hasClaude = $null -ne (Resolve-ToolCommandWithRetry -Name "claude" -Attempts 6)
$hasCodex = $null -ne (Resolve-ToolCommandWithRetry -Name "codex" -Attempts 6)
$hasGemini = $null -ne (Resolve-ToolCommandWithRetry -Name "gemini" -Attempts 6)
$hasKimi = $null -ne (Resolve-ToolCommandWithRetry -Name "kimi" -Attempts 6)

Write-Step "Step 8/8 - Verify and launch"

$artifacts = @("packages/shared/dist", "packages/mcp-server/dist/index.js", "packages/api/dist/index.js", "packages/web/.next")
$allGood = $true
foreach ($artifact in $artifacts) {
    $fullPath = Join-Path $ProjectRoot $artifact
    if (Test-Path $fullPath) { Write-Ok $artifact } else { Write-Err "$artifact - missing!"; $allGood = $false }
}

if (-not $allGood -and -not $SkipBuild) {
    Write-Err "Build artifacts missing. Check build output above."
    exit 1
}

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "  Cat Cafe installed!" -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Project: $ProjectRoot"
Write-Host "  Node:    $(node --version)"
Write-Host "  Redis:   $(if ($hasRedis) { 'available' } else { 'not configured' })"
Write-Host "  Claude:  $(if ($hasClaude) { 'ready' } else { 'not installed' })"
Write-Host "  Codex:   $(if ($hasCodex) { 'ready' } else { 'not installed' })"
Write-Host "  Gemini:  $(if ($hasGemini) { 'ready' } else { 'not installed' })"
Write-Host "  Kimi:    $(if ($hasKimi) { 'ready' } else { 'not installed' })"
Write-Host ""
Write-Host "  Start the app:" -ForegroundColor Cyan
$startCmd = ".\scripts\start-windows.ps1"
Write-Host "    $startCmd" -ForegroundColor White
Write-Host ""
$frontendPort = Get-InstallerEnvValueFromFile -EnvFile $envFile -Key "FRONTEND_PORT"
if (-not $frontendPort) { $frontendPort = "3003" }
Write-Host "  Then open http://localhost:$frontendPort" -ForegroundColor Cyan
Write-Host ""

if ($Start) {
    Write-Host "  Auto-starting..." -ForegroundColor Cyan
    $startArgs = @("-Quick")
    if ($Debug) { $startArgs += "-Debug" }
    & (Join-Path $ProjectRoot "scripts\start-windows.ps1") @startArgs
}
