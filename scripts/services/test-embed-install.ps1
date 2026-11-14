<# CPU-only gate: real PowerShell parsing and the actual Windows install admission path. #>
param(
    [string]$InstallerPath = (Join-Path $PSScriptRoot 'embed-install.ps1'),
    [string]$PythonPath = (Get-Command python -ErrorAction Stop).Source
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

foreach ($path in @($InstallerPath, (Join-Path $PSScriptRoot 'prereq-check.ps1'))) {
    $tokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) {
        throw "PowerShell parse failed: $($parseErrors | ForEach-Object { $_.Message })"
    }
}

$fixture = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
$variables = @('PYTHONPATH', 'EMBED_GENERATION', 'CAT_CAFE_HOME', 'FIXTURE_PYTHON_PATH', 'FIXTURE_DISK_MARKER')
$saved = @{}
foreach ($name in $variables) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }

try {
    $services = Join-Path $fixture 'scripts/services'
    $runtime = Join-Path $fixture 'packages/api/runtime/services'
    $modules = Join-Path $fixture 'modules'
    New-Item -ItemType Directory -Force -Path $services, $runtime, $modules | Out-Null
    Copy-Item -LiteralPath $InstallerPath -Destination (Join-Path $services 'embed-install.ps1')
    foreach ($name in @('embedding_generation.py', 'embedding_generation_install.py')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $services
    }
    $repository = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    Copy-Item -LiteralPath (Join-Path $repository 'packages/api/runtime/services/embedding-generations.json') -Destination $runtime
    # Use the real Python platform checker; no pip/downloader/model doubles are needed here.
    Set-Content -LiteralPath (Join-Path $modules 'sitecustomize.py') -Value @'
import platform
platform.system = lambda: 'Windows'
platform.machine = lambda: 'ARM64'
'@
    Set-Content -LiteralPath (Join-Path $services 'prereq-check.ps1') -Value @'
function Resolve-BootstrapPython { return @{ Path = $env:FIXTURE_PYTHON_PATH; PrefixArgs = @() } }
function Assert-Python310 { param($Bootstrap) }
function Assert-DiskSpace {
    param($RequiredGB)
    [System.IO.File]::WriteAllText($env:FIXTURE_DISK_MARKER, 'reached')
    throw 'FIXTURE_DISK_STOP'
}
function Assert-Network { throw 'FORBIDDEN_NETWORK' }
'@
    $env:PYTHONPATH = $modules
    $env:FIXTURE_PYTHON_PATH = $PythonPath
    $env:CAT_CAFE_HOME = Join-Path $fixture 'home'
    $env:FIXTURE_DISK_MARKER = Join-Path $fixture 'disk-marker'
    $outcomes = @()
    foreach ($generation in @('g0', '', 'g1')) {
        [Environment]::SetEnvironmentVariable('EMBED_GENERATION', $generation)
        if (Test-Path -LiteralPath $env:FIXTURE_DISK_MARKER) {
            Remove-Item -LiteralPath $env:FIXTURE_DISK_MARKER
        }
        $failure = $null
        try { & (Join-Path $services 'embed-install.ps1') } catch { $failure = $_.Exception.Message }
        $diskReached = Test-Path -LiteralPath $env:FIXTURE_DISK_MARKER
        if ($generation -eq 'g1') {
            if ($diskReached -or $failure -ne 'Pinned embedding generation unsupported on this platform; nothing installed') {
                throw "Pinned Windows admission did not reject before disk/network: $failure"
            }
        } elseif (-not $diskReached -or $failure -ne 'FIXTURE_DISK_STOP') {
            throw "Legacy Windows install did not reach its existing disk gate: $failure"
        }
        if (Test-Path -LiteralPath $env:CAT_CAFE_HOME) { throw 'Admission fixture installed unexpected state' }
        $outcomes += @{ generation = $(if ($generation) { $generation } else { 'default' }); diskReached = $diskReached }
    }
    @{ pass = 4; parser = 'System.Management.Automation.Language.Parser.ParseFile'; branches = $outcomes; modelsLoaded = 0; networkRequests = 0 } |
        ConvertTo-Json -Depth 4
} finally {
    foreach ($name in $variables) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
