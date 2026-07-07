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
    "HF_HUB_DISABLE_SYMLINKS",
    "HF_HUB_DISABLE_SYMLINKS_WARNING"
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

    Write-Host "prereq-check.proxy-env.test.ps1: PASS"
} finally {
    Remove-Item Env:CAT_CAFE_TEST_ENV_CAPTURE -ErrorAction SilentlyContinue
    $script:CatCafeHfDownloadTransportMode = $savedTransportMode
    Restore-EnvVars -Saved $saved -Names $names
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
