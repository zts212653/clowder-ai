$ErrorActionPreference = "Stop"

. "$PSScriptRoot\prereq-check.ps1"

function Save-EnvVars {
    param([string[]]$Names)
    $saved = @{}
    foreach ($name in $Names) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }
    return $saved
}

function Restore-EnvVars {
    param(
        [hashtable]$Saved,
        [string[]]$Names
    )
    foreach ($name in $Names) {
        [Environment]::SetEnvironmentVariable($name, $Saved[$name], "Process")
    }
}

$names = @(
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "HF_ENDPOINT",
    "HF_HUB_ENDPOINT",
    "HF_HUB_DISABLE_SYMLINKS",
    "HF_HUB_DISABLE_SYMLINKS_WARNING",
    "PIP_EXTRA_INDEX_URL",
    "PIP_INDEX_URL",
    "PIP_TRUSTED_HOST"
)
$saved = Save-EnvVars -Names $names
$savedTransportMode = $script:CatCafeHfDownloadTransportMode

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("cat-cafe-prereq-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$fakePython = Join-Path $tempDir "python.cmd"
$capture = Join-Path $tempDir "env.txt"

try {
    Set-Content -LiteralPath $fakePython -Encoding ASCII -Value @"
@echo off
(
echo HTTP_PROXY=%HTTP_PROXY%
echo HTTPS_PROXY=%HTTPS_PROXY%
echo ALL_PROXY=%ALL_PROXY%
echo HF_HUB_DISABLE_SYMLINKS=%HF_HUB_DISABLE_SYMLINKS%
echo HF_HUB_DISABLE_SYMLINKS_WARNING=%HF_HUB_DISABLE_SYMLINKS_WARNING%
) > "%CAT_CAFE_TEST_ENV_CAPTURE%"
exit /b 0
"@

    $env:CAT_CAFE_TEST_ENV_CAPTURE = $capture
    $env:HTTP_PROXY = "http://127.0.0.1:9"
    $env:HTTPS_PROXY = "http://127.0.0.1:9"
    $env:ALL_PROXY = "http://127.0.0.1:9"
    $script:CatCafeHfDownloadTransportMode = "direct"
    Remove-Item Env:HF_HUB_DISABLE_SYMLINKS,Env:HF_HUB_DISABLE_SYMLINKS_WARNING -ErrorAction SilentlyContinue

    Invoke-ModelDownloadWithRetry -VenvPython $fakePython -ModelId "dummy/model" -Loader "snapshot"

    $captured = Get-Content -LiteralPath $capture
    foreach ($line in @("HTTP_PROXY=", "HTTPS_PROXY=", "ALL_PROXY=")) {
        if ($captured -notcontains $line) {
            throw "Expected child process proxy env to be cleared; missing '$line'. Captured: $($captured -join '; ')"
        }
    }
    foreach ($line in @("HF_HUB_DISABLE_SYMLINKS=1", "HF_HUB_DISABLE_SYMLINKS_WARNING=1")) {
        if ($captured -notcontains $line) {
            throw "Expected Windows HuggingFace symlink guard '$line'. Captured: $($captured -join '; ')"
        }
    }
    if ($env:HTTP_PROXY -ne "http://127.0.0.1:9") {
        throw "Expected parent HTTP_PROXY to be restored after child invocation."
    }

    try {
        $mode = Test-SourceMode `
            -Url "https://127.0.0.1:1/" `
            -TimeoutSec 1 `
            -CandidateProxy "http://http=127.0.0.1:7897;https=127.0.0.1:7897" `
            -Method "GET"
    } catch {
        throw "Expected malformed proxy candidate to be classified as unreachable, not thrown: $($_.Exception.GetType().FullName): $($_.Exception.Message)"
    }
    if ($mode -ne "unreachable") {
        throw "Expected malformed proxy candidate to return unreachable, got '$mode'."
    }

    $script:CapturedProbeUrls = @()
    function Sync-SystemProxy {}
    function Get-SystemProxyCandidate { "http://127.0.0.1:7897" }
    function Test-SourceMode {
        param(
            [string]$Url,
            [int]$TimeoutSec = 5,
            [string]$CandidateProxy = $null,
            [ValidateSet("HEAD", "GET")][string]$Method = "HEAD"
        )
        $script:CapturedProbeUrls += $Url
        if ($Url -eq "https://internal-hf.example/hub/BAAI/bge-small-zh-v1.5/resolve/main/config.json") {
            return "direct"
        }
        return "unreachable"
    }

    $env:HF_ENDPOINT = "https://internal-hf.example/hub"
    Remove-Item Env:HF_HUB_ENDPOINT,Env:PIP_EXTRA_INDEX_URL,Env:PIP_INDEX_URL,Env:PIP_TRUSTED_HOST,Env:NO_PROXY -ErrorAction SilentlyContinue
    Assert-Network

    $expectedProbeUrl = "https://internal-hf.example/hub/BAAI/bge-small-zh-v1.5/resolve/main/config.json"
    if ($script:CapturedProbeUrls -notcontains $expectedProbeUrl) {
        throw "Expected Assert-Network to probe configured HF_ENDPOINT '$expectedProbeUrl'. Captured: $($script:CapturedProbeUrls -join '; ')"
    }
    $defaultProbeUrl = "https://huggingface.co/BAAI/bge-small-zh-v1.5/resolve/main/config.json"
    if ($script:CapturedProbeUrls -contains $defaultProbeUrl) {
        throw "Expected Assert-Network not to probe default HuggingFace endpoint when HF_ENDPOINT is configured."
    }
    if ($script:CatCafeHfDownloadTransportMode -ne "direct") {
        throw "Expected configured HF_ENDPOINT direct probe to set transport mode to direct, got '$script:CatCafeHfDownloadTransportMode'."
    }

    Write-Host "prereq-check.proxy-env.test.ps1: PASS"
} finally {
    Remove-Item Env:CAT_CAFE_TEST_ENV_CAPTURE -ErrorAction SilentlyContinue
    $script:CatCafeHfDownloadTransportMode = $savedTransportMode
    Restore-EnvVars -Saved $saved -Names $names
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
