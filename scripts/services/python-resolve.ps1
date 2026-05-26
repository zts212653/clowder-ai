<#
.SYNOPSIS
  Unified Python 3.12+ interpreter resolver for Windows.
.DESCRIPTION
  Sister of scripts/services/python-resolve.sh -- see that file for design
  notes. Key Windows-specific behavior:
    - Require x64 (AMD64) architecture. Native ARM64 Python is rejected
      because aiohttp / PyAV / piper-tts / sentence-transformers have no
      win-arm64 wheels. On ARM64 hardware the AMD64 build runs under the
      built-in Prism emulator.
    - Fallback installer downloads python-3.12.x-amd64.exe from python.org
      and silent-installs to <ProjectRoot>\.cat-cafe\python\
      (project-rooted; mirrors the portable-Redis convention in
      install-windows-helpers.ps1 -- keeps every install isolated to
      the source tree it was built for).
      with PrependPath=0 so the system PATH stays untouched.
.EXAMPLE
  . "$PSScriptRoot\python-resolve.ps1"
  $py = Resolve-Python312
  & $py.Path @($py.PrefixArgs + @('-m', 'venv', "$env:CAT_CAFE_HOME\whisper-venv"))
#>

# Single source of truth for the cat-cafe data dir. Mirrors the Windows
# Redis convention (install-windows-helpers.ps1 line 104 places its
# portable Redis under <ProjectRoot>/.cat-cafe/redis/windows/) -- Python
# + venvs + Piper voice models all live under the same project-rooted
# .cat-cafe/ so uninstall = delete the project dir, no cross-instance
# pollution in $env:USERPROFILE.
#
# Resolution priority:
#   1. $env:CAT_CAFE_HOME (caller override -- CI, integration tests, etc.)
#   2. <repo-root>/.cat-cafe (derived from $PSScriptRoot:
#      scripts/services/python-resolve.ps1 -> repo-root is two levels up)
$script:ResolverRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:CatCafeHome = if ($env:CAT_CAFE_HOME) { $env:CAT_CAFE_HOME } else { Join-Path $script:ResolverRepoRoot '.cat-cafe' }
$env:CAT_CAFE_HOME = $script:CatCafeHome   # exported so child install scripts can reuse the same path
$script:ProjectPythonDir = Join-Path $script:CatCafeHome "python"

function Get-PythonBinaryArch {
    # Read the PE header machine field directly to determine python.exe's
    # binary arch. We can't rely on platform.machine() inside Python on
    # Windows ARM -- when an AMD64 Python runs under the Prism emulator on
    # ARM64 Windows, platform.machine() reports the host arch (ARM64),
    # not the process arch (AMD64). PE header is the unambiguous source.
    #
    # CVO-verified on Windows ARM64 hardware (2026-05-14):
    #   $bytes[$peOffset+4..+5] = 0x8664  ->  AMD64 PBS-extracted python.exe
    #   but: .\python.exe -c 'platform.machine()' ->  ARM64
    param([string]$ExePath)
    if (-not (Test-Path $ExePath)) { return $null }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($ExePath)
        if ($bytes.Length -lt 0x40) { return $null }
        $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
        if ($peOffset -lt 0 -or $peOffset + 6 -gt $bytes.Length) { return $null }
        $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
        switch ($machine) {
            0x8664 { return 'amd64' }
            0xAA64 { return 'arm64' }
            0x14C  { return 'i386' }
            default { return ("unknown-0x{0:X4}" -f $machine) }
        }
    } catch {
        return $null
    }
}

function Test-Python312Candidate {
    param([string]$Path, [string[]]$PrefixArgs)
    try {
        # Version check: platform.machine() is unreliable on Windows ARM
        # (emulator hides process arch -- see Get-PythonBinaryArch comment),
        # so we only ask Python for the version and read arch from PE header.
        # IMPORTANT: Python string literal uses single quotes (`sep=':'`),
        # not double quotes. PowerShell 5.1 re-quotes args when handing them
        # to native exe -- embedded `"` gets eaten, Python receives broken
        # syntax and produces empty stdout. CVO-verified on Win-ARM64:
        # `print('a:b:c')` -> "a:b:c" but `print(x, y, sep=":")` -> "".
        $out = & $Path @($PrefixArgs + @('-c', "import sys; print(sys.version_info[0], sys.version_info[1], sep=':')")) 2>$null
        if (-not $out) { return $null }
        $parts = "$out".Trim() -split ':'
        if ($parts.Length -lt 2) { return $null }
        $major = [int]$parts[0]; $minor = [int]$parts[1]
        if ($major -lt 3) { return $null }
        if ($major -eq 3 -and $minor -lt 12) { return $null }
        # Confirm venv module works AND ensurepip exists. Some distros (rare
        # on Windows) ship a venv-stub without ensurepip.
        & $Path @($PrefixArgs + @('-c', 'import venv, ensurepip')) 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        # Reject non-AMD64 binaries: on Windows we always need a binary that
        # pip-installs aiohttp / PyAV / piper-tts wheels. Native ARM Python
        # has no wheels and fails. PE header is binary truth -- use it instead
        # of platform.machine() which lies under emulation.
        $binaryArch = Get-PythonBinaryArch $Path
        if ($binaryArch -ne 'amd64') { return $null }
        return [pscustomobject]@{
            Path = $Path
            PrefixArgs = $PrefixArgs
            Version = "$major.$minor"
            Machine = $binaryArch
        }
    } catch {
        return $null
    }
}

function Try-SystemPythons {
    $candidates = @(
        @{ Cmd = 'py';      Args = @('-3.13') },
        @{ Cmd = 'py';      Args = @('-3.12') },
        @{ Cmd = 'py';      Args = @('-3') },
        @{ Cmd = 'python';  Args = @() },
        @{ Cmd = 'python3'; Args = @() }
    )
    foreach ($c in $candidates) {
        $cmd = Get-Command $c.Cmd -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        $info = Test-Python312Candidate -Path $cmd.Source -PrefixArgs $c.Args
        if ($info) {
            $info | Add-Member -NotePropertyName Source -NotePropertyValue 'system'
            return $info
        }
    }
    return $null
}

function Try-UvPython {
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { return $null }
    try {
        $found = (uv python find '>=3.12' 2>$null).Trim()
        if (-not $found -or -not (Test-Path $found)) { return $null }
        $info = Test-Python312Candidate -Path $found -PrefixArgs @()
        if ($info) {
            $info | Add-Member -NotePropertyName Source -NotePropertyValue 'uv'
            return $info
        }
    } catch {}
    return $null
}

function Try-LegacyProjectPython {
    # Pre-a34ab1f2 installs lived at $HOME/.cat-cafe/python. Reuse them
    # if they exist so existing installs survive the path migration
    # without re-downloading the whole python-build-standalone tarball
    # over an unreliable GitHub connection. We don't auto-migrate; the
    # user can clean install to switch to the repo-local path later.
    $legacyDir = Join-Path $HOME '.cat-cafe\python'
    if ($legacyDir -eq $script:ProjectPythonDir) { return $null }
    $py = Join-Path $legacyDir 'python.exe'
    if (-not (Test-Path $py)) { return $null }
    $info = Test-Python312Candidate -Path $py -PrefixArgs @()
    if ($info) {
        $info | Add-Member -NotePropertyName Source -NotePropertyValue 'project-legacy'
        Write-Host "  Reusing legacy project Python: $py (pre-CAT_CAFE_HOME-migration install -- venv still created under $script:CatCafeHome)"
        return $info
    }
    return $null
}

function Try-ProjectPython {
    $py = Join-Path $script:ProjectPythonDir "python.exe"
    if (-not (Test-Path $py)) { return $null }
    $info = Test-Python312Candidate -Path $py -PrefixArgs @()
    if ($info) {
        $info | Add-Member -NotePropertyName Source -NotePropertyValue 'project'
        return $info
    }
    # python.exe exists but Test-Python312Candidate rejected it. Surface
    # both PE header arch (binary truth) AND interpreter-reported arch so
    # the diagnostic captures the Windows-ARM emulation case: PE header
    # says AMD64 but Python's platform.machine() lies and says ARM64.
    [Console]::Error.WriteLine("  Project Python at $py exists but failed validation:")
    $peArch = Get-PythonBinaryArch $py
    [Console]::Error.WriteLine("    PE header machine: $peArch (binary truth)")
    try {
        $pyCode = "import sys, platform; print('version=' + str(sys.version_info[0]) + '.' + str(sys.version_info[1]) + ', platform.machine=' + platform.machine())"
        $diag = & $py -c $pyCode 2>&1
        [Console]::Error.WriteLine("    interpreter reports: $diag")
    } catch {
        [Console]::Error.WriteLine("    interpreter could not be executed: $($_.Exception.Message)")
    }
    try {
        $venvCheck = & $py -c 'import venv, ensurepip' 2>&1
        if ($LASTEXITCODE -ne 0) {
            [Console]::Error.WriteLine("    venv/ensurepip missing/broken: $venvCheck")
        }
    } catch {}
    return $null
}

function Install-PythonToProjectDir {
    # Wrap download + silent-install in a per-user mutex so concurrent
    # service installs don't race. Use an unprefixed name -> equivalent to
    # Local\catCafePythonInstall (session-scoped). Avoid Global\ -- that
    # requires SeCreateGlobalPrivilege which standard users lack; trying
    # to create a Global mutex would throw UnauthorizedAccessException
    # that's not in our try-catch path and would unwind to the caller's
    # throw. Multiple service installs only ever race within the same
    # user session, so Local scope is sufficient.
    $mutex = $null
    try {
        $mutex = New-Object System.Threading.Mutex($false, "catCafePythonInstall")
    } catch {
        [Console]::Error.WriteLine("  Mutex create failed ($($_.Exception.Message)); proceeding without lock")
        return (Install-PythonToProjectDirInner)
    }
    $acquired = $false
    try {
        $deadline = (Get-Date).AddMinutes(10)
        while (-not $acquired) {
            try {
                $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds(5))
            } catch [System.Threading.AbandonedMutexException] {
                # Previous holder crashed without releasing -- we still own it now.
                $acquired = $true
            }
            if ($acquired) { break }

            # A concurrent install may have finished extracting Python even if
            # its process has not released the mutex yet. Do not block another
            # service install behind the mutex once the shared interpreter is
            # already usable.
            $projectPython = Join-Path $script:ProjectPythonDir "python.exe"
            if (Test-Path $projectPython) {
                $existingInfo = Try-ProjectPython
                if ($existingInfo) {
                    [Console]::Error.WriteLine("  Project Python already present and valid (installed by concurrent install)")
                    return $true
                }
            }

            if ((Get-Date) -ge $deadline) {
                [Console]::Error.WriteLine("  Python install lock timed out (>10min)")
                return $false
            }
        }

        # Re-check inside the critical section -- another concurrent install
        # might have already finished while we were waiting on the mutex.
        # Use Try-ProjectPython (full validation), not just Test-Path --
        # otherwise a half-installed / wrong-arch / broken python.exe
        # from a prior failed install attempt would make us claim success
        # without verifying the interpreter actually works, and the outer
        # Resolve-Python312 then loops back to Try-ProjectPython which
        # rejects it -> throws "Python not found" even though Install said
        # "already present".
        $existingInfo = Try-ProjectPython
        if ($existingInfo) {
            [Console]::Error.WriteLine("  Project Python already present and valid (installed by concurrent install)")
            return $true
        }
        # python.exe might still exist but failed validation. Purge before
        # re-running the silent installer so it starts from a clean state.
        # CRITICAL: don't use -ErrorAction SilentlyContinue -- it silently
        # tolerates partial-purge (file lock by antivirus, running process,
        # or explorer preview holding python.exe open) and the new tarball's
        # x86-64 python.exe fails to overwrite the stale ARM one, producing
        # the dead-loop: "purged" -> "extracted" -> "still ARM64".
        if (Test-Path $script:ProjectPythonDir) {
            [Console]::Error.WriteLine("  Purging stale/invalid Python at $script:ProjectPythonDir before reinstall")
            try {
                Remove-Item -Recurse -Force $script:ProjectPythonDir -ErrorAction Stop
            } catch {
                [Console]::Error.WriteLine("  Purge failed: $($_.Exception.Message)")
                # Rename aside so the fresh install gets a clean dir. The
                # stale dir lingers until next reboot / user cleanup but
                # doesn't poison this install.
                $stale = "$($script:ProjectPythonDir).stale-$(Get-Random)"
                try {
                    Rename-Item -Path $script:ProjectPythonDir -NewName (Split-Path -Leaf $stale) -Force -ErrorAction Stop
                    [Console]::Error.WriteLine("  Renamed stale dir aside: $stale (clean up at next reboot)")
                } catch {
                    [Console]::Error.WriteLine("  Cannot rename stale dir either: $($_.Exception.Message)")
                    [Console]::Error.WriteLine("  Manual fix: close any program holding python.exe, then delete $script:ProjectPythonDir and retry")
                    return $false
                }
            }
        }
        return (Install-PythonToProjectDirInner)
    } finally {
        if ($acquired) {
            try { $mutex.ReleaseMutex() | Out-Null } catch {}
        }
        $mutex.Dispose()
    }
}

function Test-ResolverProxyAnonymous {
    # Duplicate of prereq-check.ps1::Test-ProxyAnonymous -- see comment on
    # Sync-ResolverSystemProxy for why the resolver doesn't source
    # prereq-check.ps1. Probes a proxy WITH NO CREDENTIALS so a corp
    # proxy that needs NTLM/Kerberos returns 407 instead of letting .NET
    # auto-fill the logged-in Windows user token (which would make us
    # think pip can use the proxy when it actually cannot).
    param([string]$ProxyUrl, [string]$TargetUrl, [int]$TimeoutSec = 5)
    $handler = $null
    $client = $null
    try {
        $webProxy = New-Object System.Net.WebProxy($ProxyUrl)
        $webProxy.UseDefaultCredentials = $false
        $webProxy.Credentials = $null
        $handler = New-Object System.Net.Http.HttpClientHandler
        $handler.Proxy = $webProxy
        $handler.UseProxy = $true
        $handler.UseDefaultCredentials = $false
        $handler.PreAuthenticate = $false
        $client = New-Object System.Net.Http.HttpClient($handler)
        $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
        $response = $client.GetAsync($TargetUrl).Result
        return $response.IsSuccessStatusCode
    } catch {
        return $false
    } finally {
        if ($client) { $client.Dispose() }
        if ($handler) { $handler.Dispose() }
    }
}

function Get-ResolverSystemProxyCandidate {
    # Mirror of prereq-check.ps1::Get-SystemProxyCandidate -- returns the
    # candidate URL from env > registry, no probing. Per-target decision
    # happens at the call site (resolver downloads GitHub PBS, NOT pypi --
    # so the previous "probe pypi to gate the proxy" was wrong for this
    # path: pypi-via-proxy can fail while github-via-proxy works).
    if ($env:HTTPS_PROXY) { return $env:HTTPS_PROXY }
    if ($env:HTTP_PROXY) { return $env:HTTP_PROXY }
    try {
        $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
        if ($reg.ProxyEnable -and $reg.ProxyServer) {
            return "http://$($reg.ProxyServer)"
        }
    } catch {}
    return $null
}

function Test-ResolverSourceMode {
    # Same two-mode probe as prereq-check.ps1::Test-SourceMode but inlined
    # here so the resolver doesn't have to source prereq-check.ps1.
    # CandidateProxy is explicit so probing GitHub doesn't depend on
    # whatever Sync-* shim already injected env for unrelated hosts.
    param([string]$Url, [int]$TimeoutSec = 5, [string]$CandidateProxy = $null)
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Proxy = $null
        $req.Method = 'HEAD'
        $req.Timeout = $TimeoutSec * 1000
        $resp = $req.GetResponse()
        $resp.Close()
        return 'direct'
    } catch {}
    if ($CandidateProxy) {
        try {
            $webProxy = New-Object System.Net.WebProxy($CandidateProxy)
            $webProxy.UseDefaultCredentials = $false
            $webProxy.Credentials = $null
            $req = [System.Net.HttpWebRequest]::Create($Url)
            $req.Proxy = $webProxy
            $req.Method = 'HEAD'
            $req.Timeout = $TimeoutSec * 1000
            $resp = $req.GetResponse()
            $resp.Close()
            return 'proxy'
        } catch {}
    }
    return 'unreachable'
}

# Back-compat shim: install-python.ps1 source-calls Sync-ResolverSystemProxy.
# It used to probe pypi and inject env if reachable; that was wrong for
# the resolver path (which actually downloads from GitHub) and would gate
# the GitHub proxy decision on an unrelated pypi probe. New behavior:
# clear .NET DefaultWebProxy so the IWR call later doesn't silently use
# SSPI through the system proxy. The actual proxy decision happens
# inline in Install-PythonToProjectDirInner against $tarballUrl.
function Sync-ResolverSystemProxy {
    if ($env:HTTP_PROXY -or $env:HTTPS_PROXY) { return }
    try { [System.Net.WebRequest]::DefaultWebProxy = $null } catch {}
    $candidate = Get-ResolverSystemProxyCandidate
    if ($candidate) {
        [Console]::Error.WriteLine("  System proxy detected: $candidate (will be tested against the download URL)")
    }
}

function Install-PythonToProjectDirInner {
    # Download portable Python from python-build-standalone (astral-sh) --
    # same source as the Unix resolver, hosted on GitHub. We switched away
    # from python.org's silent installer (`python-3.12.x-amd64.exe`) because:
    #   - On restricted networks, python.org TLS frequently breaks under
    #     Windows SChannel ("server closed abruptly (missing close_notify)").
    #     GitHub Releases is more tolerant in the same environments.
    #   - python.org silent installer can pick architecture/redirects we
    #     can't control (observed: ARM64 Python from the AMD64 installer
    #     on Windows ARM64). PBS tarballs are arch-explicit in the URL.
    #   - Same code path on Windows / Linux / macOS -- easier to maintain.
    Sync-ResolverSystemProxy
    $hasTar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if (-not $hasTar) {
        [Console]::Error.WriteLine("  tar.exe required to extract the portable Python tarball (Windows 10+ ships tar.exe; older Windows is not supported)")
        return $false
    }
    $pbsOwner   = 'astral-sh'
    $pbsRelease = '20260510'
    $pbsVersion = '3.12.13'
    # Note Windows naming convention differs from Linux/Mac -- no `-shared-`
    # infix (the Unix variants have shared/static, Windows is single-variant).
    $tarballName = "cpython-$pbsVersion+$pbsRelease-x86_64-pc-windows-msvc-install_only.tar.gz"
    $tarballUrl  = "https://github.com/$pbsOwner/python-build-standalone/releases/download/$pbsRelease/$tarballName"
    $tarballPath = Join-Path $env:TEMP $tarballName
    $extractTmp  = Join-Path $env:TEMP 'cat-cafe-python-extract'

    [Console]::Error.WriteLine("  Downloading portable Python $pbsVersion (AMD64) from python-build-standalone...")
    # Probe the ACTUAL download URL with both direct and via-proxy modes --
    # NOT pypi.org. Internal networks that can reach GitHub releases via
    # a corp proxy were previously broken because Sync-ResolverSystemProxy
    # gated proxy injection on a pypi probe; if pypi-via-proxy failed,
    # the GitHub proxy was never tried.
    $candidate = Get-ResolverSystemProxyCandidate
    $mode = Test-ResolverSourceMode -Url $tarballUrl -TimeoutSec 6 -CandidateProxy $candidate
    if ($mode -eq 'unreachable') {
        [Console]::Error.WriteLine(
            "  Cannot reach $tarballUrl (direct or via candidate proxy '$candidate'). " +
            "Configure HTTP_PROXY in .env or check network -- see prereq-check guidance."
        )
        return $false
    }
    # Use Invoke-WebRequest (.NET HttpClient TLS stack) instead of curl.exe.
    # On Windows curl uses SChannel which intermittently bails on GitHub's
    # objects.githubusercontent.com CDN with "server closed abruptly
    # (missing close_notify)" -- observed: curl spent 30+ min at 80% and
    # died, IWR on the same URL finished in seconds (CVO-verified).
    # ProgressPreference='SilentlyContinue' avoids the IWR perf cliff where
    # the progress bar throttles large transfers.
    $prevProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    # Snapshot the .NET DefaultWebProxy so we can restore after the
    # download. We need this for the direct-mode branch: bare IWR honors
    # DefaultWebProxy, which on Windows defaults to the system proxy.
    # Test-ResolverSourceMode used Proxy=$null on the HEAD probe, so the
    # probe and the actual download must agree -- otherwise direct-mode
    # download silently routes through the registry proxy that the probe
    # explicitly avoided.
    $savedDefaultProxy = $null
    $downloadTimeoutSec = 180
    $downloadModes = @()
    if ($mode -eq 'proxy' -and $candidate) {
        $downloadModes += 'proxy'
        $downloadModes += 'direct'
    } else {
        $downloadModes += 'direct'
        if ($candidate) { $downloadModes += 'proxy' }
    }
    $downloaded = $false
    $lastDownloadError = ''
    $lastDownloadMode = $downloadModes[$downloadModes.Count - 1]
    try { $savedDefaultProxy = [System.Net.WebRequest]::DefaultWebProxy } catch {}
    try {
        foreach ($downloadMode in $downloadModes) {
            Remove-Item -Force $tarballPath -ErrorAction SilentlyContinue
            try {
                if ($downloadMode -eq 'proxy' -and $candidate) {
                    [Console]::Error.WriteLine("  Using proxy for download: $candidate")
                    Invoke-WebRequest -Uri $tarballUrl -OutFile $tarballPath -UseBasicParsing -Proxy $candidate -TimeoutSec $downloadTimeoutSec -ErrorAction Stop
                } else {
                    # direct: force .NET DefaultWebProxy to null for THIS IWR
                    # call so we don't silently route through the system proxy.
                    try { [System.Net.WebRequest]::DefaultWebProxy = $null } catch {}
                    [Console]::Error.WriteLine("  Using direct download (no proxy)")
                    Invoke-WebRequest -Uri $tarballUrl -OutFile $tarballPath -UseBasicParsing -TimeoutSec $downloadTimeoutSec -ErrorAction Stop
                }
                $downloaded = $true
                break
            } catch {
                $lastDownloadError = $_.Exception.Message
                [Console]::Error.WriteLine("  Python download via $downloadMode failed: $lastDownloadError")
                Remove-Item -Force $tarballPath -ErrorAction SilentlyContinue
                if ($downloadMode -ne $lastDownloadMode) {
                    [Console]::Error.WriteLine("  Retrying Python download via alternate network path ...")
                }
            }
        }
    } finally {
        $ProgressPreference = $prevProgress
        try { [System.Net.WebRequest]::DefaultWebProxy = $savedDefaultProxy } catch {}
    }
    if (-not $downloaded) {
        [Console]::Error.WriteLine("  Failed to download Python tarball: $lastDownloadError")
        return $false
    }
    if (-not (Test-Path $tarballPath)) {
        [Console]::Error.WriteLine("  Tarball not at expected path: $tarballPath")
        return $false
    }

    if (Test-Path $extractTmp) {
        Remove-Item -Recurse -Force $extractTmp -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Path $extractTmp -Force | Out-Null

    [Console]::Error.WriteLine("  Extracting Python tarball to $script:ProjectPythonDir ...")
    try {
        & tar.exe -xzf $tarballPath -C $extractTmp
        if ($LASTEXITCODE -ne 0) { throw "tar.exe exit $LASTEXITCODE" }
    } catch {
        [Console]::Error.WriteLine("  Failed to extract Python tarball: $($_.Exception.Message)")
        Remove-Item -Force $tarballPath -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $extractTmp -ErrorAction SilentlyContinue
        return $false
    }
    Remove-Item -Force $tarballPath -ErrorAction SilentlyContinue

    # PBS tarball lays out as `python/{python.exe,Lib,...}` -- strip that one
    # level so python.exe lands directly under TargetDir.
    $pythonInTmp = Join-Path $extractTmp 'python'
    if (-not (Test-Path $pythonInTmp)) {
        [Console]::Error.WriteLine("  Unexpected tarball layout: $pythonInTmp not found")
        Show-PythonInstallerDiagnostic -InstallerLog ''
        Remove-Item -Recurse -Force $extractTmp -ErrorAction SilentlyContinue
        return $false
    }
    if (-not (Test-Path $script:ProjectPythonDir)) {
        New-Item -ItemType Directory -Path $script:ProjectPythonDir -Force | Out-Null
    }
    try {
        Get-ChildItem -Path $pythonInTmp -Force | ForEach-Object {
            Move-Item -Path $_.FullName -Destination $script:ProjectPythonDir -Force
        }
    } catch {
        [Console]::Error.WriteLine("  Failed to relocate extracted Python: $($_.Exception.Message)")
        Remove-Item -Recurse -Force $extractTmp -ErrorAction SilentlyContinue
        return $false
    }
    Remove-Item -Recurse -Force $extractTmp -ErrorAction SilentlyContinue

    $expectedPython = Join-Path $script:ProjectPythonDir 'python.exe'
    if (Test-Path $expectedPython) {
        [Console]::Error.WriteLine("  Python $pbsVersion installed to $script:ProjectPythonDir")
        return $true
    }
    [Console]::Error.WriteLine("  Python tarball extracted but $expectedPython is missing.")
    Show-PythonInstallerDiagnostic -InstallerLog ''
    return $false
}

function Show-PythonInstallerDiagnostic {
    param([string]$InstallerLog)
    # Surface what's actually in the target dir so we can tell whether the
    # silent installer redirected (App Execution Alias hijack on Win-ARM64),
    # placed python.exe in a subdirectory, or installed nothing at all.
    if (Test-Path $script:ProjectPythonDir) {
        [Console]::Error.WriteLine("  TargetDir contents ($script:ProjectPythonDir):")
        try {
            Get-ChildItem -Path $script:ProjectPythonDir -Recurse -Depth 2 -Force -ErrorAction SilentlyContinue |
                ForEach-Object { [Console]::Error.WriteLine("    " + $_.FullName) }
        } catch {}
    } else {
        [Console]::Error.WriteLine("  TargetDir does not exist after installer ran: $script:ProjectPythonDir")
    }
    if ($InstallerLog -and (Test-Path $InstallerLog)) {
        [Console]::Error.WriteLine("  Installer log tail ($InstallerLog):")
        try {
            Get-Content -Path $InstallerLog -Tail 40 -ErrorAction SilentlyContinue |
                ForEach-Object { [Console]::Error.WriteLine("    $_") }
        } catch {}
    }
}

function Resolve-Python312 {
    # 1. System Python (PATH).
    $info = Try-SystemPythons
    if ($info) { return $info }

    # 2. uv (reuse only -- never auto-install uv on the user's system).
    $info = Try-UvPython
    if ($info) { return $info }

    # 3. Project-owned Python (already installed before).
    $info = Try-ProjectPython
    if ($info) { return $info }

    # 4. Legacy project Python ($HOME\.cat-cafe\python) -- reuse pre-
    #    a34ab1f2 install before triggering a fresh download. Saves
    #    users on isolated VMs from re-downloading PBS over an
    #    unreliable GitHub connection just because we moved the default
    #    path.
    $info = Try-LegacyProjectPython
    if ($info) { return $info }

    # 5. Last resort: install a project-owned Python. Print a reason line
    #    first so the user understands why a Python download is starting --
    #    otherwise the log jumps straight to "Downloading portable Python"
    #    and people worry we're touching their system interpreter.
    [Console]::Error.WriteLine("  No Python 3.12+ (AMD64) found on this machine (checked: system PATH, uv, project-local cache).")
    [Console]::Error.WriteLine("  Installing a project-local Python under `$CAT_CAFE_HOME\python\ -- does not modify system PATH or affect any existing Python.")
    if (Install-PythonToProjectDir) {
        $info = Try-ProjectPython
        if ($info) { return $info }
    }

    throw @"
Python 3.12+ (AMD64) not found and could not be auto-installed.

Recommendation:
  1. Download "Windows installer (64-bit)" from https://www.python.org/downloads/
     and check "Add python.exe to PATH" during install. Make sure the
     architecture is AMD64 (the 64-bit installer), not ARM64.
  2. Or install uv (https://astral.sh/uv) and run: uv python install 3.12
  3. On Windows, also check that the App Execution Alias for python.exe is
     disabled: Settings > Apps > Advanced app settings > App execution aliases.
"@
}
