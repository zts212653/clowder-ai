<#
.SYNOPSIS
  Standalone entry point for the python-bootstrap "meta-service" on Windows.
.DESCRIPTION
  Sister of install-python.sh -- see that file for the contract. Spawned by
  the API's ensurePython() helper before any real service install. The four
  service install ps1s never race to install Python themselves; they pick
  up the result via Resolve-BootstrapPython.

  Output:
    stdout -- '[python-bootstrap] ...' progress lines plus
             PYTHON_PATH=<abs path>
             PYTHON_ARCH=<machine>
             PYTHON_SOURCE=<system|uv|project>
             on success.
    exit 0 -- resolved.
    exit 1 -- failed.

  Concurrency safe: python-resolve.ps1 uses a per-user mutex around the
  install step.
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\python-resolve.ps1"

Write-Output "[python-bootstrap] Resolving Python 3.12+ interpreter..."
try {
    $info = Resolve-Python312
    Write-Output ("[python-bootstrap] [OK] Python {0}: {1} (arch={2})" -f $info.Source, $info.Path, $info.Machine)
    Write-Output ("PYTHON_PATH=" + $info.Path)
    Write-Output ("PYTHON_ARCH=" + $info.Machine)
    Write-Output ("PYTHON_SOURCE=" + $info.Source)
    exit 0
} catch {
    Write-Error ("[python-bootstrap] [FAIL] " + $_.Exception.Message)
    exit 1
}
