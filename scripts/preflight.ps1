<#
.SYNOPSIS
  Clowder AI — Pre-install network connectivity check (Windows)

.DESCRIPTION
  Derives required endpoints from pnpm-lock.yaml, tests reachability,
  and suggests env-var fixes for corporate/intranet environments.

.EXAMPLE
  .\scripts\preflight.ps1
  .\scripts\preflight.ps1 -Registry "https://your-mirror/npm/"
  .\scripts\preflight.ps1 -Timeout 10
#>

param(
    [string]$Registry = "",
    [int]$Timeout = 5,
    [switch]$SkipFix
)

$ErrorActionPreference = "Stop"

# ── Output helpers ────────────────────────────────────────────
function Write-PfOk   { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-PfFail { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Red }
function Write-PfWarn { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-PfInfo { param([string]$msg) Write-Host $msg -ForegroundColor Cyan }

# ── Resolve paths ─────────────────────────────────────────────
$ScriptDir = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } `
             elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } `
             else { $PWD.Path }
$ProjectRoot = Split-Path -Parent $ScriptDir
$Lockfile = Join-Path $ProjectRoot "pnpm-lock.yaml"

# ── test_endpoint: returns $true if URL is reachable ──────────
function Test-Endpoint {
    param([string]$Url)
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Method = "HEAD"
        $req.Timeout = $Timeout * 1000
        $req.AllowAutoRedirect = $true
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch [System.Net.WebException] {
        # We test *network reachability*, not content availability.
        # A 403 (e.g. Puppeteer CDN root) proves the host is reachable.
        if ($_.Exception.Response) { return $true }
        return $false
    } catch {
        return $false
    }
}

# ── resolve_registry: param > env > .npmrc > default ──────────
function Resolve-Registry {
    if ($Registry) { return $Registry }
    # Env vars
    foreach ($var in @("npm_config_registry", "NPM_CONFIG_REGISTRY",
                       "PNPM_CONFIG_REGISTRY", "CAT_CAFE_NPM_REGISTRY")) {
        $val = [System.Environment]::GetEnvironmentVariable($var)
        if ($val) { return $val.Trim() }
    }
    # Project .npmrc
    $npmrc = Join-Path $ProjectRoot ".npmrc"
    if (Test-Path $npmrc) {
        $line = Get-Content $npmrc | Where-Object { $_ -match '^registry=' } | Select-Object -First 1
        if ($line) { return ($line -replace '^registry=', '').Trim() }
    }
    # User .npmrc (NPM_CONFIG_USERCONFIG overrides default path)
    $userNpmrc = if ($env:NPM_CONFIG_USERCONFIG) { $env:NPM_CONFIG_USERCONFIG } else { Join-Path $env:USERPROFILE ".npmrc" }
    if (Test-Path $userNpmrc) {
        $line = Get-Content $userNpmrc | Where-Object { $_ -match '^registry=' } | Select-Object -First 1
        if ($line) { return ($line -replace '^registry=', '').Trim() }
    }
    return "https://registry.npmjs.org"
}

# ── normalize package name for env var: @scope/my-pkg → scope_my_pkg ──
function ConvertTo-PkgEnvName {
    param([string]$Pkg)
    return ("npm_config_" + ($Pkg -replace '^@', '' -replace '[/-]', '_') + "_binary_host")
}

# ── scan_prebuild_packages: find packages using prebuild-install ──
function Get-PrebuildPackages {
    if (-not (Test-Path $Lockfile)) { return @() }
    $packages = @()
    $currentPkg = ""
    $found = $false
    foreach ($line in (Get-Content $Lockfile)) {
        if ($line -match "^\s{2}'?([a-zA-Z0-9@][^\s'(]+)@(\d[^:'(]*)'?") {
            # New package header — emit previous if it had prebuild-install
            if ($found -and $currentPkg -and $currentPkg -ne "prebuild-install") {
                $packages += $currentPkg
            }
            $currentPkg = $Matches[1]
            $found = $false
            continue
        }
        if ($line -match 'prebuild-install') {
            $found = $true
        }
    }
    # Final block
    if ($found -and $currentPkg -and $currentPkg -ne "prebuild-install") {
        $packages += $currentPkg
    }
    return ($packages | Sort-Object -Unique)
}

# ── has_puppeteer ─────────────────────────────────────────────
function Test-HasPuppeteer {
    if (-not (Test-Path $Lockfile)) { return $false }
    return (Select-String -Path $Lockfile -Pattern '^\s+puppeteer@\d' -Quiet)
}

# ── resolve_puppeteer_url ────────────────────────────────────
function Resolve-PuppeteerUrl {
    $envUrl = [System.Environment]::GetEnvironmentVariable("PUPPETEER_DOWNLOAD_BASE_URL")
    if ($envUrl) { return $envUrl }
    # Check project-level config files
    foreach ($cfgName in @(".puppeteerrc.cjs", ".puppeteerrc.mjs", ".puppeteerrc",
                           "puppeteer.config.cjs")) {
        $cfgPath = Join-Path $ProjectRoot $cfgName
        if (Test-Path $cfgPath) {
            $content = Get-Content $cfgPath -Raw
            if ($content -match 'downloadBaseUrl.*?(https?://[^\s"'']+)') {
                return $Matches[1]
            }
        }
    }
    return "https://storage.googleapis.com/chrome-for-testing-public"
}

# ── detect_proxy_ghosts ──────────────────────────────────────
function Test-ProxyGhosts {
    $found = $false
    # Check Node.js installation npmrc
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $nodeDir = Split-Path -Parent (Split-Path -Parent $nodeCmd.Source)
        $nodeNpmrc = Join-Path $nodeDir "etc\npmrc"
        if (Test-Path $nodeNpmrc) {
            $proxyLine = Get-Content $nodeNpmrc | Where-Object { $_ -match '^\s*(https?-)?proxy\s*=' }
            if ($proxyLine) {
                Write-PfWarn "Stale proxy config in: $nodeNpmrc"
                $found = $true
            }
        }
    }
    # Check user npmrc
    $userNpmrc = Join-Path $env:USERPROFILE ".npmrc"
    if (Test-Path $userNpmrc) {
        $proxyLine = Get-Content $userNpmrc | Where-Object { $_ -match '^\s*(https?-)?proxy\s*=' }
        if ($proxyLine) {
            Write-PfWarn "Proxy config in: $userNpmrc (verify it is current)"
            $found = $true
        }
    }
    return $found
}

# ── Main ──────────────────────────────────────────────────────
if (-not (Test-Path $Lockfile)) {
    Write-PfFail "pnpm-lock.yaml not found at $ProjectRoot"
    exit 2
}

Write-PfInfo "Clowder AI — Preflight Network Check"
Write-Host ""

$failures = @()
$total = 0; $passed = 0

# ── Check 1: Proxy ghosts ────────────────────────────────────
Write-PfInfo "[1/3] Checking for stale proxy configs..."
if (Test-ProxyGhosts) {
    Write-PfWarn "Stale proxy settings detected (see above). This may cause ECONNREFUSED errors."
} else {
    Write-PfOk "No stale proxy configs detected"
}
Write-Host ""

# ── Check 2: npm registry ────────────────────────────────────
Write-PfInfo "[2/3] Testing npm registry..."
$reg = Resolve-Registry
$total++
if (Test-Endpoint $reg) {
    Write-PfOk "Registry: $reg"
    $passed++
} else {
    Write-PfFail "Registry: $reg — UNREACHABLE"
    $failures += [pscustomobject]@{ Type = "registry"; Pkg = $reg; Fix = "" }
}
Write-Host ""

# ── Check 3: Binary download hosts ───────────────────────────
Write-PfInfo "[3/3] Scanning lockfile for binary download dependencies..."

# prebuild-install packages — check effective binary host per package
$prebuildPkgs = Get-PrebuildPackages
$githubNeeded = @()  # packages without configured mirror

foreach ($pkg in $prebuildPkgs) {
    $envName = ConvertTo-PkgEnvName $pkg
    $envNameMirror = $envName + "_mirror"
    $configured = [System.Environment]::GetEnvironmentVariable($envName)
    if (-not $configured) {
        $configured = [System.Environment]::GetEnvironmentVariable($envNameMirror)
    }
    if ($configured) {
        # User has a mirror configured — test that instead of GitHub
        $total++
        $hostDisplay = ([System.Uri]$configured).Host
        if (Test-Endpoint $configured) {
            Write-PfOk "$pkg -> $hostDisplay (mirror via $envName)"
            $passed++
        } else {
            Write-PfFail "$pkg -> $hostDisplay (mirror via $envName) — UNREACHABLE"
            $failures += [pscustomobject]@{
                Type = "prebuild-mirror"; Pkg = $pkg
                Fix = "Configured $envName=$configured is unreachable. Check the URL."
            }
        }
    } else {
        $githubNeeded += [pscustomobject]@{ Pkg = $pkg; EnvName = $envName }
    }
}

# Test GitHub once for all packages without configured mirrors
if ($githubNeeded.Count -gt 0) {
    $total++
    $pkgList = ($githubNeeded | ForEach-Object { $_.Pkg }) -join ", "
    if (Test-Endpoint "https://github.com") {
        Write-PfOk "GitHub (prebuild: $pkgList) — reachable"
        $passed++
    } else {
        Write-PfFail "GitHub (prebuild: $pkgList) — UNREACHABLE"
        $envVars = @()
        foreach ($entry in $githubNeeded) {
            $envVars += "`$env:$($entry.EnvName) = `"<YOUR_MIRROR_URL>`""
        }
        $failures += [pscustomobject]@{
            Type = "prebuild"; Pkg = $pkgList; Fix = ($envVars -join "`n")
        }
    }
}

# puppeteer → browser CDN
# Skip if PUPPETEER_SKIP_DOWNLOAD or PUPPETEER_SKIP_CHROMIUM_DOWNLOAD is set
# (pnpm install won't download Chrome, so CDN check is unnecessary)
$skipPuppeteerDl = [System.Environment]::GetEnvironmentVariable("PUPPETEER_SKIP_DOWNLOAD")
$skipPuppeteerChrome = [System.Environment]::GetEnvironmentVariable("PUPPETEER_SKIP_CHROMIUM_DOWNLOAD")
if ((Test-HasPuppeteer) -and (-not $skipPuppeteerDl) -and (-not $skipPuppeteerChrome)) {
    $puppeteerUrl = Resolve-PuppeteerUrl
    $total++
    $puppeteerHost = ([System.Uri]$puppeteerUrl).Host
    if (Test-Endpoint $puppeteerUrl) {
        Write-PfOk "Browser CDN: $puppeteerHost (puppeteer) — reachable"
        $passed++
    } else {
        Write-PfFail "Browser CDN: $puppeteerHost (puppeteer) — UNREACHABLE"
        $failures += [pscustomobject]@{
            Type = "browser"; Pkg = "puppeteer"
            Fix = "`$env:PUPPETEER_DOWNLOAD_BASE_URL = `"<YOUR_MIRROR_URL>`""
        }
    }
} elseif (Test-HasPuppeteer) {
    Write-PfOk "Browser CDN: skipped (PUPPETEER_SKIP_DOWNLOAD or PUPPETEER_SKIP_CHROMIUM_DOWNLOAD is set)"
}

Write-Host ""

# ── Report ────────────────────────────────────────────────────
if ($failures.Count -eq 0) {
    Write-Host "  Preflight passed ($passed/$total checks OK)" -ForegroundColor Green
    exit 0
}

Write-Host "  Preflight failed — $($failures.Count) of $total checks unreachable" -ForegroundColor Red

if (-not $SkipFix) {
    Write-Host ""
    Write-PfInfo "How to fix:"
    Write-Host ""
    foreach ($f in $failures) {
        switch ($f.Type) {
            "registry" {
                Write-Host "  npm registry ($($f.Pkg)) is unreachable."
                Write-Host "  Pass a reachable mirror to the installer:"
                Write-Host ""
                Write-Host '    $env:CAT_CAFE_NPM_REGISTRY = "https://YOUR_NPM_MIRROR/"'
                Write-Host "    .\scripts\install.ps1"
                Write-Host ""
            }
            "prebuild-mirror" {
                Write-Host "  $($f.Fix)"
                Write-Host ""
            }
            "prebuild" {
                Write-Host "  Packages [$($f.Pkg)] download prebuilt binaries from GitHub."
                Write-Host "  GitHub is unreachable. Set binary host mirrors:"
                Write-Host ""
                foreach ($line in ($f.Fix -split "`n")) {
                    Write-Host "    $line"
                }
                Write-Host ""
            }
            "browser" {
                Write-Host "  $($f.Pkg) downloads a browser binary from a CDN."
                Write-Host "  The CDN is unreachable. Redirect to your mirror:"
                Write-Host ""
                Write-Host "    $($f.Fix)"
                Write-Host ""
            }
        }
    }
    Write-Host "  Then re-run the installer."
}

exit 1
