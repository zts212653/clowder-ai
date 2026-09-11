<#
.SYNOPSIS
  Fail-closed resolution of the build host's Node version for the desktop build.

.DESCRIPTION
  build-desktop.ps1 bundles a portable Node runtime alongside the app. That
  runtime must (a) match the Node that compiled the native modules
  (better-sqlite3 / node-pty / sharp) and (b) satisfy the repo's declared
  engines.node. Getting either wrong ships an installer whose API dies at
  startup with NODE_MODULE_VERSION errors — hard to diagnose in the field.

  This module never guesses. It is dot-sourced by build-desktop.ps1 and is
  unit-tested directly (see resolve-build-node.test.js).

  `GetNodeVersion` is injectable so tests do not have to manipulate PATH.
#>

function Get-RequiredNodeMajor {
    <#
    .SYNOPSIS
      Read the minimum Node major declared in <ProjectRoot>/package.json engines.
    .OUTPUTS
      [int] major version, or $null when engines.node is absent/unparseable.
    #>
    param([Parameter(Mandatory)] [string]$ProjectRoot)

    $pkgPath = Join-Path $ProjectRoot 'package.json'
    if (-not (Test-Path $pkgPath)) { return $null }

    try {
        $engines = (Get-Content $pkgPath -Raw | ConvertFrom-Json).engines.node
    } catch {
        return $null
    }
    if ($engines -match '>=\s*(\d+)') { return [int]$Matches[1] }
    return $null
}

function Resolve-BuildNodeVersion {
    <#
    .SYNOPSIS
      Return the validated build-machine Node version, or throw with a fixable message.
    .PARAMETER ProjectRoot
      Repository root containing package.json with the engines.node requirement.
    .PARAMETER GetNodeVersion
      Scriptblock returning the host Node version string (default: `node --version`).
    #>
    param(
        [Parameter(Mandatory)] [string]$ProjectRoot,
        [scriptblock]$GetNodeVersion = { node --version }
    )

    $nodeVersion = $null
    try {
        $raw = & $GetNodeVersion 2>$null
        if ($raw) { $nodeVersion = "$raw".Trim() }
    } catch {
        $nodeVersion = $null
    }

    if (-not $nodeVersion) {
        throw @'
Cannot detect the build-machine Node version: "node --version" failed or returned nothing.
Why: the bundled portable Node must match the Node that compiled the native modules
     (better-sqlite3 / node-pty / sharp). Guessing a version here ships an installer
     whose API cannot load them.
Fix: install Node >= 24, make sure it is on PATH, then re-run this build.
'@
    }

    $major = 0
    if (-not [int]::TryParse(($nodeVersion -replace '^v', '').Split('.')[0], [ref]$major)) {
        throw "Cannot parse the build-machine Node version ""$nodeVersion"" into a major version. Fix: report this output and re-run with a standard Node release (node --version prints e.g. v24.16.0)."
    }

    $requiredMajor = Get-RequiredNodeMajor -ProjectRoot $ProjectRoot
    if ($requiredMajor -and $major -lt $requiredMajor) {
        throw "Build-machine Node $nodeVersion is older than the >=$requiredMajor required by package.json engines.node. Why: the bundled runtime would ship a Node version this project does not support. Fix: upgrade to Node >= $requiredMajor and re-run this build."
    }

    return $nodeVersion
}
