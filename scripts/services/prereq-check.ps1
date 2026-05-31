<#
.SYNOPSIS
  Shared prerequisite check for ML service install scripts on Windows.
.DESCRIPTION
  Provides Resolve-BootstrapPython (finds py/python) and Assert-Python310
  (checks version >= 3.10). Source this at the top of each install script.
#>

function Resolve-BootstrapPython {
    # Delegate to the shared resolver (python-resolve.ps1). The resolver
    # walks the same priority list as the *.sh sister script:
    #   1. System Python (PATH, AMD64 only on Windows ARM64)
    #   2. Reuse uv if the user already has it (never auto-installs uv)
    #   3. Project-owned Python at ~/.cat-cafe/python/
    #   4. Last resort: download python.org installer and silent-install
    #      to the project dir (PrependPath=0, no system pollution)
    #
    # Step 4 hits the network -- call Sync-SystemProxy first so HTTP_PROXY /
    # HTTPS_PROXY are populated from the Windows registry before any download.
    # Otherwise users behind a corporate / WSL Proxy proxy would see Step 4
    # fail to reach python.org while the subsequent Assert-Network already
    # ran in another path. Sync-SystemProxy is idempotent.
    Sync-SystemProxy
    . "$PSScriptRoot\python-resolve.ps1"
    $info = Resolve-Python312   # throws on hard failure
    Write-Host ("  Python {0}: {1} [OK] (arch={2})" -f $info.Source, $info.Path, $info.Machine)
    return [pscustomobject]@{
        Path = $info.Path
        PrefixArgs = $info.PrefixArgs
        Machine = $info.Machine
    }
}

function Assert-Python310 {
    param([pscustomobject]$Bootstrap)
    $pyCmd = 'import sys; print(sys.version_info[0], sys.version_info[1], sep=chr(46))'
    $ver = & $Bootstrap.Path @($Bootstrap.PrefixArgs + @('-c', $pyCmd))
    if (-not $ver) {
        Write-Error "ERROR: Could not determine Python version. Ensure Python is correctly installed."
        exit 1
    }
    $parts = "$ver".Trim() -split '\.'
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    if ($major -lt 3 -or ($major -eq 3 -and $minor -lt 10)) {
        Write-Error "ERROR: Python $ver too old, need 3.10+."
        exit 1
    }
    Write-Host "  Python $ver [OK]"
}

function Assert-DiskSpace {
    param([int]$RequiredGB = 2)
    # $env:CAT_CAFE_HOME is exported by python-resolve.ps1 (sourced via
    # Resolve-BootstrapPython before disk space gets checked). Fall back to
    # legacy ~/.cat-cafe if a caller invokes Assert-DiskSpace standalone.
    $targetDir = if ($env:CAT_CAFE_HOME) { $env:CAT_CAFE_HOME } else { Join-Path $HOME ".cat-cafe" }
    if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
    $drive = (Resolve-Path $targetDir).Drive
    $freeGB = [math]::Floor((Get-PSDrive $drive.Name).Free / 1GB)
    if ($freeGB -lt $RequiredGB) {
        Write-Error "ERROR: Disk space insufficient. Need ${RequiredGB}GB, available ${freeGB}GB ($targetDir)"
        exit 1
    }
    Write-Host "  Disk space: ${freeGB}GB available [OK]"
}

function Test-ProxyAnonymous {
    # Probe a proxy WITH NO CREDENTIALS -- this matches what pip /
    # huggingface_hub / curl will do once we set HTTP_PROXY. PowerShell's
    # default Invoke-WebRequest auto-fills the logged-in Windows user's
    # NTLM/Kerberos token when challenged by a corp proxy with 407, so
    # `Invoke-WebRequest -Proxy <url>` looks "successful" even though pip
    # can't authenticate. Using HttpClient + UseDefaultCredentials=false
    # + Credentials=null forces an anonymous request, exposing the 407.
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
        return $response.IsSuccessStatusCode  # 407 -> IsSuccessStatusCode = $false
    } catch {
        return $false
    } finally {
        if ($client) { $client.Dispose() }
        if ($handler) { $handler.Dispose() }
    }
}

function Get-SystemProxyCandidate {
    # Return the candidate proxy URL (env override -> IE registry -> $null)
    # WITHOUT gating on a single pypi.org probe. Per-source decisions live
    # in Test-SourceMode below. Previous gating broke the user-reported
    # case where corp-proxy -> pypi.org fails but corp-proxy -> Tsinghua
    # works: pypi probe failed -> candidate dropped -> mirror probe ran
    # with no proxy candidate -> mirror's via-proxy mode never got tested.
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

# Back-compat shim: legacy callers still source-call Sync-SystemProxy.
# Behavior changed from "auto-inject after pypi probe" to "informational
# only" -- the per-source decisions live in Assert-Network now.
function Sync-SystemProxy {
    if ($env:HTTP_PROXY -or $env:HTTPS_PROXY) {
        Write-Host "  Proxy env already set: $env:HTTP_PROXY"
        return
    }
    $candidate = Get-SystemProxyCandidate
    if ($candidate) {
        Write-Host "  System proxy detected: $candidate (will be tested per-source)"
    }
    # Defensively disable .NET DefaultWebProxy so .NET-default Invoke-
    # WebRequest calls don't silently route through the system proxy with
    # SSPI credentials, which would let auth-required corp proxies
    # masquerade as "reachable" during anonymous Test-SourceMode probes.
    try { [System.Net.WebRequest]::DefaultWebProxy = $null } catch {}
}

function Test-UrlReachable {
    param([string]$Url, [int]$TimeoutSec = 5)
    try {
        $null = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-SourceMode {
    # Probe a URL twice -- first with NO proxy (matches `curl --noproxy '*'`),
    # then with the supplied candidate proxy URL (env override OR the system-
    # proxy URL from Get-SystemProxyCandidate). Returns 'direct' / 'proxy' /
    # 'unreachable' so the caller can decide PIP_INDEX_URL + NO_PROXY in
    # alignment with what pip / huggingface_hub will actually do at install.
    #
    # The CandidateProxy parameter (not env) is what enables the
    # "corp-proxy reaches Tsinghua even though it can't reach pypi" case:
    # Sync-SystemProxy no longer gates the candidate on a single pypi probe,
    # so per-source decisions in Assert-Network always see the candidate.
    param([string]$Url, [int]$TimeoutSec = 5, [string]$CandidateProxy = $null)
    # 1. Try without any proxy at all.
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Proxy = $null
        $req.Method = 'HEAD'
        $req.Timeout = $TimeoutSec * 1000
        $resp = $req.GetResponse()
        $resp.Close()
        return 'direct'
    } catch {}
    # 2. Try via candidate proxy (anonymous -- DON'T let .NET auto-fill the
    #    SSPI token, that would mask auth-required corp proxies as reachable).
    $proxyUrl = $CandidateProxy
    if (-not $proxyUrl) {
        # Back-compat: still pick up env if caller didn't supply explicit.
        $proxyUrl = $env:HTTPS_PROXY
        if (-not $proxyUrl) { $proxyUrl = $env:HTTP_PROXY }
    }
    if ($proxyUrl) {
        try {
            $webProxy = New-Object System.Net.WebProxy($proxyUrl)
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

function Write-ProxyGuidance {
    param([string]$Context)
    Write-Host ""
    Write-Host "  WARNING: $Context"
    Write-Host "  Cannot directly reach pypi.org / huggingface.co under the current network, and the default mirrors (Tsinghua / hf-mirror) are also unreachable."
    Write-Host "  Pick one of the options below in .env (or set env temporarily and retry):"
    Write-Host ""
    Write-Host "  Option A - Configure a working HTTP proxy (RFC-standard URL can include credentials):"
    Write-Host "    HTTP_PROXY=http://<host>:<port>                 # proxy without auth"
    Write-Host "    HTTP_PROXY=http://<user>:<password>@<host>:<port>   # standard proxy with auth"
    Write-Host "    HTTPS_PROXY=<same as above>"
    Write-Host ""
    Write-Host "  Option B - Configure a mirror source reachable on the current network (no proxy):"
    Write-Host "    PIP_INDEX_URL=<a reachable pip mirror, e.g. https://pypi.tuna.tsinghua.edu.cn/simple>"
    Write-Host "    HF_ENDPOINT=<a reachable HuggingFace mirror, e.g. https://hf-mirror.com>"
    Write-Host ""
    Write-Host "  NOTE: After editing .env, restart the main service (API) so the new proxy / mirror env is injected into install subprocesses."
    Write-Host ""
}

function Add-NoProxyHost {
    # NOTE: Do not name the parameter $Host -- that is a PowerShell
    # automatic variable (read-only) and assignment raises
    # "Cannot overwrite variable Host because it is read-only or constant"
    # which aborts the install. Use $HostName instead.
    param([string]$HostName)
    $entries = @()
    if ($env:NO_PROXY) { $entries = @($env:NO_PROXY -split ',') }
    $entries += $HostName
    $env:NO_PROXY = ($entries | Where-Object { $_ } | Select-Object -Unique) -join ','
}

function Invoke-ModelDownloadWithRetry {
    # Shared model-preload helper for all *-install.ps1 scripts.
    # Mirrors the .sh _install_template_load_model retry loop so .ps1
    # services get the same robustness (3 attempts, 5s/10s backoff,
    # HF_HUB_DOWNLOAD_TIMEOUT=60). Previously each *-install.ps1 had
    # its own bare 'snapshot_download(...)' or 'WhisperModel(...)' call
    # with no retry -- one ConnectTimeout = install failed even when
    # the next attempt would've worked. F190 service-install sub-scope fixes this fan-out by
    # collapsing the retry path into one place.
    param(
        [Parameter(Mandatory=$true)][string]$VenvPython,
        [Parameter(Mandatory=$true)][string]$ModelId,
        # "snapshot" (default) = huggingface_hub.snapshot_download
        # "faster_whisper"    = snapshot_download with faster-whisper alias resolution,
        #                       then faster_whisper.WhisperModel
        # "fastembed"         = fastembed.TextEmbedding
        [string]$Loader = "snapshot"
    )

    $script = switch ($Loader) {
        "snapshot" { @"
import sys, time, os
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '60')
from huggingface_hub import snapshot_download
max_attempts = 3
for attempt in range(1, max_attempts + 1):
    try:
        snapshot_download(sys.argv[1])
        print('Model download complete.')
        sys.exit(0)
    except Exception as e:
        print(f'  Download attempt {attempt}/{max_attempts} failed: {e}', file=sys.stderr)
        if attempt < max_attempts:
            wait = 5 * attempt
            print(f'  Retrying in {wait}s...', file=sys.stderr)
            time.sleep(wait)
print(f'ERROR: Model download failed after {max_attempts} attempts', file=sys.stderr)
sys.exit(1)
"@ }
        "faster_whisper" { @"
import sys, time, os
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '60')
from faster_whisper import WhisperModel
from faster_whisper.utils import _MODELS
from huggingface_hub import snapshot_download

ALLOW_PATTERNS = [
    'config.json',
    'preprocessor_config.json',
    'model.bin',
    'tokenizer.json',
    'vocabulary.*',
]

def run_with_heartbeat(label, fn):
    import queue
    import threading
    done = queue.Queue(maxsize=1)

    def worker():
        try:
            done.put((True, fn()))
        except BaseException as exc:
            done.put((False, exc))

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    elapsed = 0
    while thread.is_alive():
        thread.join(timeout=15)
        if thread.is_alive():
            elapsed += 15
            print(f'  {label} still in progress ({elapsed}s elapsed)...', file=sys.stderr, flush=True)
    ok, value = done.get()
    if ok:
        return value
    raise value

def resolve_faster_whisper_repo_id(model_id):
    if '/' in model_id:
        return model_id
    repo_id = _MODELS.get(model_id)
    if repo_id is None:
        expected = ', '.join(sorted(_MODELS.keys()))
        raise ValueError(f'Invalid faster-whisper model {model_id!r}, expected one of: {expected}, or a HuggingFace repo id')
    return repo_id

max_attempts = 3
for attempt in range(1, max_attempts + 1):
    try:
        model_id = sys.argv[1]
        if os.path.isdir(model_id):
            model_path = model_id
            print(f'  Using local faster-whisper model path: {model_path}', file=sys.stderr)
        else:
            repo_id = resolve_faster_whisper_repo_id(model_id)
            print(f'  Resolved faster-whisper model repo: {repo_id}', file=sys.stderr)
            model_path = run_with_heartbeat(
                'faster-whisper snapshot download',
                lambda: snapshot_download(repo_id, allow_patterns=ALLOW_PATTERNS),
            )
            print(f'  Faster-whisper model artifacts ready: {model_path}', file=sys.stderr)
        run_with_heartbeat(
            'faster-whisper runtime load',
            lambda: WhisperModel(model_path, device='cpu', compute_type='int8'),
        )
        print('Model download complete.')
        sys.exit(0)
    except Exception as e:
        print(f'  Download attempt {attempt}/{max_attempts} failed: {e}', file=sys.stderr)
        if attempt < max_attempts:
            wait = 5 * attempt
            print(f'  Retrying in {wait}s...', file=sys.stderr)
            time.sleep(wait)
print(f'ERROR: Model download failed after {max_attempts} attempts', file=sys.stderr)
sys.exit(1)
"@ }
        "fastembed" { @"
import sys, time, os
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '60')
from fastembed import TextEmbedding
max_attempts = 3
for attempt in range(1, max_attempts + 1):
    try:
        TextEmbedding(model_name=sys.argv[1])
        print('Model download complete.')
        sys.exit(0)
    except Exception as e:
        print(f'  Download attempt {attempt}/{max_attempts} failed: {e}', file=sys.stderr)
        if attempt < max_attempts:
            wait = 5 * attempt
            print(f'  Retrying in {wait}s...', file=sys.stderr)
            time.sleep(wait)
print(f'ERROR: Model download failed after {max_attempts} attempts', file=sys.stderr)
sys.exit(1)
"@ }
        default { throw "Invoke-ModelDownloadWithRetry: unknown loader '$Loader'" }
    }

    & $VenvPython -c $script $ModelId
    if ($LASTEXITCODE -ne 0) { throw "Failed to download model: $ModelId" }
}

function Assert-Network {
    Sync-SystemProxy   # back-compat: informational + clears .NET DefaultWebProxy

    # Get the candidate proxy URL (env first, then registry). This is
    # passed explicitly to every Test-SourceMode call so per-source
    # decisions don't depend on whether env was already set.
    $candidate = Get-SystemProxyCandidate
    $needProxyInjection = $false

    # FIRST: classify the user's PIP_INDEX_URL (if set) the same way we
    # classify public mirrors. Internal corporate mirrors typically
    # don't need (and often break behind) the system proxy -- adding
    # HTTP_PROXY because some public source needs it would route the
    # user's primary through the proxy too, breaking direct-only
    # internals. Per-source NO_PROXY classification fixes this: we tell
    # pip exactly which hosts bypass the proxy and which go through it,
    # instead of forcing one global choice.
    if ($env:PIP_INDEX_URL) {
        try {
            $userIdxUri = [System.Uri]::new($env:PIP_INDEX_URL)
            $userIdxHost = $userIdxUri.Host
            if ($userIdxHost) {
                $userIdxMode = Test-SourceMode -Url $env:PIP_INDEX_URL -TimeoutSec 5 -CandidateProxy $candidate
                if ($userIdxMode -eq 'direct') {
                    Write-Host "  User PIP_INDEX_URL reachable [OK] (direct, $userIdxHost) -- adding to NO_PROXY so pip bypasses HTTP_PROXY"
                    Add-NoProxyHost $userIdxHost
                } elseif ($userIdxMode -eq 'proxy') {
                    Write-Host "  User PIP_INDEX_URL reachable [OK] (via proxy: $candidate, $userIdxHost) -- NOT adding to NO_PROXY"
                    $needProxyInjection = $true
                } else {
                    Write-Host "  WARNING: User PIP_INDEX_URL unreachable both direct and via proxy ($userIdxHost)"
                }
            }
        } catch {
            Write-Host "  WARNING: Could not parse PIP_INDEX_URL=$env:PIP_INDEX_URL as URL"
        }
    }

    # Split classification: direct group (NO_PROXY) and proxy group
    # (HTTP_PROXY). Final PIP_EXTRA_INDEX_URL list orders direct first,
    # proxy second -- pip walks the list in order so this means "try
    # no-proxy sources first, then proxy sources". Matches user's
    # expectation: try direct sources first, fall back to proxy sources.
    $directUrls = New-Object System.Collections.ArrayList
    $proxyUrls = New-Object System.Collections.ArrayList

    $pypiMode = Test-SourceMode -Url "https://pypi.org/simple/" -TimeoutSec 5 -CandidateProxy $candidate
    $tsinghuaMode = Test-SourceMode -Url "https://pypi.tuna.tsinghua.edu.cn/simple/" -TimeoutSec 5 -CandidateProxy $candidate

    if ($pypiMode -eq 'direct') {
        Write-Host "  PyPI connectivity [OK] (direct -> no-proxy group)"
        Add-NoProxyHost "pypi.org"
        [void]$directUrls.Add("https://pypi.org/simple")
    } elseif ($pypiMode -eq 'proxy') {
        Write-Host "  PyPI connectivity [OK] (via proxy: $candidate -> proxy group)"
        $needProxyInjection = $true
        [void]$proxyUrls.Add("https://pypi.org/simple")
    } else {
        Write-Host "  WARNING: PyPI unreachable both direct and via proxy"
    }

    if ($tsinghuaMode -eq 'direct') {
        Write-Host "  Tsinghua mirror reachable [OK] (direct -> no-proxy group)"
        Add-NoProxyHost "pypi.tuna.tsinghua.edu.cn"
        Add-NoProxyHost "mirrors.tuna.tsinghua.edu.cn"
        [void]$directUrls.Add("https://pypi.tuna.tsinghua.edu.cn/simple/")
    } elseif ($tsinghuaMode -eq 'proxy') {
        Write-Host "  Tsinghua mirror reachable [OK] (via proxy: $candidate -> proxy group)"
        $needProxyInjection = $true
        [void]$proxyUrls.Add("https://pypi.tuna.tsinghua.edu.cn/simple/")
    } elseif ($pypiMode -eq 'unreachable') {
        Write-ProxyGuidance -Context "pypi.org and the Tsinghua mirror are unreachable in both direct and via-proxy modes; pip install will definitely fail."
    }

    # Concat: direct first, then proxy.
    $publicPipUrls = New-Object System.Collections.ArrayList
    foreach ($u in $directUrls) { [void]$publicPipUrls.Add($u) }
    foreach ($u in $proxyUrls) { [void]$publicPipUrls.Add($u) }

    # Auto-pick primary index when user didn't set one and pypi is
    # unreachable: prefer Tsinghua. Preserves legacy behavior -- users
    # without explicit PIP_INDEX_URL get an accessible mirror picked
    # for them.
    if (-not $env:PIP_INDEX_URL -and $pypiMode -eq 'unreachable' -and ($tsinghuaMode -eq 'direct' -or $tsinghuaMode -eq 'proxy')) {
        $env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple/"
        $env:PIP_TRUSTED_HOST = "pypi.tuna.tsinghua.edu.cn"
        Write-Host "  Auto-set PIP_INDEX_URL = Tsinghua mirror (primary)"
    }

    # Same two-mode probe for HuggingFace.
    $hfMode = Test-SourceMode -Url "https://huggingface.co" -TimeoutSec 5 -CandidateProxy $candidate
    if ($hfMode -eq 'direct') {
        Write-Host "  HuggingFace connectivity [OK] (direct)"
        Add-NoProxyHost "huggingface.co"
    } elseif ($hfMode -eq 'proxy') {
        Write-Host "  HuggingFace connectivity [OK] (via proxy: $candidate)"
        $needProxyInjection = $true
    } else {
        $hfMirrorMode = Test-SourceMode -Url "https://hf-mirror.com" -TimeoutSec 5 -CandidateProxy $candidate
        if ($hfMirrorMode -eq 'direct') {
            Write-Host "  HuggingFace unreachable, switching to hf-mirror.com (direct)"
            $env:HF_ENDPOINT = "https://hf-mirror.com"
            Add-NoProxyHost "hf-mirror.com"
        } elseif ($hfMirrorMode -eq 'proxy') {
            Write-Host "  HuggingFace unreachable, switching to hf-mirror.com (via proxy: $candidate)"
            $env:HF_ENDPOINT = "https://hf-mirror.com"
            $needProxyInjection = $true
        } else {
            Write-ProxyGuidance -Context "huggingface.co and hf-mirror.com are unreachable in both direct and via-proxy modes; model download will definitely fail."
        }
    }

    # Only inject HTTP_PROXY / HTTPS_PROXY if at least one source actually
    # needs the candidate proxy to be reachable. This avoids the old bug
    # where injecting the system proxy made pip route everything through
    # an unauthenticated corp proxy that returned 407.
    if ($needProxyInjection -and $candidate -and -not $env:HTTP_PROXY -and -not $env:HTTPS_PROXY) {
        $env:HTTP_PROXY = $candidate
        $env:HTTPS_PROXY = $candidate
        Write-Host "  Injected HTTP_PROXY / HTTPS_PROXY = $candidate (needed for at least one source)"
    }

    # Always inject PIP_EXTRA_INDEX_URL (unless user already set it
    # explicitly). pip's primary index resolution falls back through
    # multiple sources: command-line --index-url > $PIP_INDEX_URL env
    # > pip.conf/pip.ini > pip default (pypi.org). Previous guard
    # "only inject if $PIP_INDEX_URL is set" missed the pip.conf case
    # -- if the user has an index-url in pip.conf (corporate mirror),
    # pip uses it but we can't see it from env, so we'd skip injecting
    # EXTRA and leave pip with no public fallback when the corp mirror
    # misses a package.
    #
    # Fix: inject our mirror policy as PIP_EXTRA_INDEX_URL regardless
    # of whether $env:PIP_INDEX_URL is set. pip.conf primary stays
    # primary, env EXTRA (us) is the fallback list.
    if (-not $env:PIP_EXTRA_INDEX_URL) {
        # Normalize user URL for dedup comparison (strip trailing slash).
        $userIdx = if ($env:PIP_INDEX_URL) { $env:PIP_INDEX_URL.TrimEnd('/') } else { '' }
        $candidates = New-Object System.Collections.ArrayList
        foreach ($url in $publicPipUrls) {
            if ($url.TrimEnd('/') -ne $userIdx) {
                [void]$candidates.Add($url)
            }
        }

        $fbUrl = $null
        $fbReason = $null
        if ($candidates.Count -gt 0) {
            # Strong signal path: HEAD probe confirmed at least one
            # public mirror reachable. Inject everything we confirmed.
            $fbUrl = ($candidates -join ' ')
            $fbReason = "primary probe (priority pypi -> Tsinghua)"
        } elseif ($env:HTTP_PROXY -or $env:HTTPS_PROXY) {
            # Probe found nothing curl could reach, but user has an HTTP
            # proxy configured (.env / shell). Trust pip to use the same
            # proxy to reach pypi / Tsinghua even though our HEAD probe
            # couldn't (Windows transparent proxies, proxy.pac, SSPI
            # corp gateways, etc.). Inject BOTH so pip has maximum
            # coverage -- mirror policy parity with strong-signal path.
            $lastResort = New-Object System.Collections.ArrayList
            if ($userIdx -ne 'https://pypi.org/simple') {
                [void]$lastResort.Add('https://pypi.org/simple')
            }
            if ($userIdx -ne 'https://pypi.tuna.tsinghua.edu.cn/simple') {
                [void]$lastResort.Add('https://pypi.tuna.tsinghua.edu.cn/simple/')
            }
            if ($lastResort.Count -gt 0) {
                $fbUrl = ($lastResort -join ' ')
                $fbReason = "last-resort (HEAD probe failed but HTTP_PROXY configured; trust pip to reach via proxy)"
            }
        }
        # No further branch: probe failed AND no user proxy -> no
        # fallback. Injecting URLs pip can't reach just inflates error
        # log noise without changing the outcome.

        $userIdxDisplay = if ($env:PIP_INDEX_URL) { $env:PIP_INDEX_URL } else { '<unset / managed by pip.conf>' }
        if ($fbUrl) {
            $env:PIP_EXTRA_INDEX_URL = $fbUrl
            Write-Host "  Injected PIP_EXTRA_INDEX_URL = `"$fbUrl`" ($fbReason; user PIP_INDEX_URL=$userIdxDisplay)"
        } elseif (-not $env:HTTP_PROXY -and -not $env:HTTPS_PROXY) {
            Write-Host "  PIP_EXTRA_INDEX_URL not injected (HEAD probe failed + no HTTP_PROXY -> pip likely can't reach public mirrors either; skipping to avoid noise)"
        } else {
            Write-Host "  PIP_EXTRA_INDEX_URL not injected (user already covers every candidate; PIP_INDEX_URL=$userIdxDisplay)"
        }
    }
}
