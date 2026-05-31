#!/usr/bin/env bash
# scripts/services/prereq-check.sh
# Shared prerequisite check for ML service install scripts.
# Source this file at the top of each install script.

PYTHON3=""
# Delegate to the shared resolver (python-resolve.sh) so all service install
# scripts pick interpreters the same way: prefer system Python 3.12+, then
# reuse uv / pyenv / brew if the user already has them, finally fall back
# to a project-owned interpreter under ~/.cat-cafe/python/. We never
# auto-install uv / pyenv on the user's system; that's their choice.
check_python3() {
  local resolver_dir
  resolver_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=./python-resolve.sh
  . "$resolver_dir/python-resolve.sh"
  if ! resolve_python_312; then
    exit 1
  fi
  PYTHON3="$RESOLVED_PYTHON"
  export PYTHON3 RESOLVED_PYTHON RESOLVED_PYTHON_SOURCE RESOLVED_PYTHON_ARCH
  echo "  Python ${RESOLVED_PYTHON_SOURCE}: $RESOLVED_PYTHON [OK] (arch=$RESOLVED_PYTHON_ARCH)"
}

check_disk_space() {
  local required_gb="${1:-2}"
  # CAT_CAFE_HOME exported by python-resolve.sh -- falls back to legacy
  # ${HOME}/.cat-cafe only if the resolver hasn't been sourced yet (e.g.
  # check_disk_space called from a context without check_python3 above it).
  local target_dir="${CAT_CAFE_HOME:-${HOME}/.cat-cafe}"
  mkdir -p "$target_dir" 2>/dev/null || true
  local avail_kb
  if [ "$(uname -s)" = "Darwin" ]; then
    avail_kb=$(df -k "$target_dir" | tail -1 | awk '{print $4}')
  else
    avail_kb=$(df -k "$target_dir" | tail -1 | awk '{print $4}')
  fi
  local avail_gb=$((avail_kb / 1048576))
  if [ "$avail_gb" -lt "$required_gb" ]; then
    echo "ERROR: Disk space insufficient. Need ${required_gb}GB, available ${avail_gb}GB (${target_dir})"
    exit 1
  fi
  echo "  Disk space: ${avail_gb}GB available [OK]"
}

normalize_proxy_scheme() {
  # User VPN clients (clash / v2ray etc.) commonly emit ALL_PROXY=socks://...
  # but httpx / huggingface_hub / requests reject that scheme -- they want
  # socks5:// (or socks5h://). Auto-rewrite so the user's VPN env "just
  # works" instead of crashing model preload with "Unknown scheme for
  # proxy URL". Also handles http:// proxies that some clients write as
  # plain host:port.
  local var val
  for var in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
    val="${!var:-}"
    [ -z "$val" ] && continue
    case "$val" in
      socks://*)
        export "$var=socks5${val#socks}"
        echo "  Normalized $var: socks:// -> socks5://"
        ;;
    esac
  done
}

_print_proxy_guidance() {
  local context="$1"
  echo ""
  echo "  WARNING: $context"
  echo "  Cannot directly reach pypi.org / huggingface.co under the current network, and the default mirrors (Tsinghua / hf-mirror) are also unreachable."
  echo "  Pick one of the options below in .env (or export temporarily and retry):"
  echo ""
  echo "  Option A - Configure a working HTTP proxy (RFC-standard URL can include credentials):"
  echo "    HTTP_PROXY=http://<host>:<port>                  # proxy without auth"
  echo "    HTTP_PROXY=http://<user>:<password>@<host>:<port>    # standard proxy with auth"
  echo "    HTTPS_PROXY=<same as above>"
  echo ""
  echo "  Option B - Configure a mirror source reachable on the current network (no proxy):"
  echo "    PIP_INDEX_URL=<a reachable pip mirror, e.g. https://pypi.tuna.tsinghua.edu.cn/simple>"
  echo "    HF_ENDPOINT=<a reachable HuggingFace mirror, e.g. https://hf-mirror.com>"
  echo ""
  echo "  NOTE: After editing .env, restart the main service (API) so the new proxy / mirror env is injected into install subprocesses."
  echo ""
}

_get_system_proxy_candidate() {
  # Best-effort: read the OS-level HTTP/HTTPS proxy that the user has
  # configured at the system layer (macOS network settings, GNOME
  # gsettings, Windows is .ps1's territory). Returns a proxy URL like
  # http://127.0.0.1:7890 on stdout, or nothing if no system proxy is
  # configured. Used by _test_source_mode as the proxy candidate when
  # the user hasn't explicitly set HTTP_PROXY env. Mirrors the .ps1
  # Get-SystemProxyCandidate behavior -- without this, curl probes on
  # macOS run anonymous-direct and miss clash verge / GoLand HTTP proxy
  # / Surge / etc. even though pip / huggingface_hub running in the same
  # shell sometimes pick it up via urllib.request.getproxies().
  case "$(uname -s)" in
    Darwin)
      command -v scutil >/dev/null 2>&1 || return 1
      local proxy_info
      proxy_info=$(scutil --proxy 2>/dev/null) || return 1
      # Prefer HTTPS proxy, fall back to HTTP.
      local enabled host port
      enabled=$(echo "$proxy_info" | awk '/HTTPSEnable/{print $NF; exit}')
      if [ "$enabled" = "1" ]; then
        host=$(echo "$proxy_info" | awk '/HTTPSProxy /{print $NF; exit}')
        port=$(echo "$proxy_info" | awk '/HTTPSPort /{print $NF; exit}')
        if [ -n "$host" ] && [ -n "$port" ]; then
          echo "http://${host}:${port}"
          return 0
        fi
      fi
      enabled=$(echo "$proxy_info" | awk '/HTTPEnable/{print $NF; exit}')
      if [ "$enabled" = "1" ]; then
        host=$(echo "$proxy_info" | awk '/HTTPProxy /{print $NF; exit}')
        port=$(echo "$proxy_info" | awk '/HTTPPort /{print $NF; exit}')
        if [ -n "$host" ] && [ -n "$port" ]; then
          echo "http://${host}:${port}"
          return 0
        fi
      fi
      return 1
      ;;
    Linux)
      # GNOME-style proxy detection (best-effort; container hosts often
      # have nothing here and we just fall through).
      command -v gsettings >/dev/null 2>&1 || return 1
      local mode
      mode=$(gsettings get org.gnome.system.proxy mode 2>/dev/null | tr -d \') || return 1
      [ "$mode" = "manual" ] || return 1
      local host port
      host=$(gsettings get org.gnome.system.proxy.https host 2>/dev/null | tr -d \') || return 1
      port=$(gsettings get org.gnome.system.proxy.https port 2>/dev/null) || return 1
      if [ -n "$host" ] && [ "$port" != "0" ]; then
        echo "http://${host}:${port}"
        return 0
      fi
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}

_test_source_mode() {
  # Probe a URL twice -- first without any proxy (matches how pip will
  # hit the host once we add it to NO_PROXY), then through the proxy
  # candidate (env HTTP_PROXY first, then OS-level system proxy as
  # detected by _get_system_proxy_candidate). Echoes 'direct' / 'proxy'
  # / 'unreachable' so the caller can write PIP_INDEX_URL + NO_PROXY
  # in a way that matches pip's runtime path.
  local url="$1"
  local timeout="${2:-5}"
  if curl -sf --max-time "$timeout" --noproxy '*' "$url" >/dev/null 2>&1; then
    echo "direct"
    return
  fi
  # Pick the proxy candidate: explicit env first, then OS-level system
  # proxy. Without the system fallback, .sh probe was blind on macOS to
  # clash verge / Surge etc. (the user's typical "I have a proxy
  # running but never exported HTTP_PROXY" case).
  local candidate=""
  if [ -n "${HTTPS_PROXY:-}" ]; then
    candidate="$HTTPS_PROXY"
  elif [ -n "${HTTP_PROXY:-}" ]; then
    candidate="$HTTP_PROXY"
  elif [ -n "${https_proxy:-}" ]; then
    candidate="$https_proxy"
  elif [ -n "${http_proxy:-}" ]; then
    candidate="$http_proxy"
  else
    candidate=$(_get_system_proxy_candidate 2>/dev/null || echo "")
  fi
  if [ -n "$candidate" ]; then
    if curl -sf --max-time "$timeout" -x "$candidate" "$url" >/dev/null 2>&1; then
      echo "proxy"
      return
    fi
  fi
  echo "unreachable"
}

_add_no_proxy_host() {
  local h="$1"
  if [ -z "${NO_PROXY:-}" ]; then
    export NO_PROXY="$h"
  else
    case ",$NO_PROXY," in
      *",$h,"*) ;;  # already present
      *) export NO_PROXY="${NO_PROXY},$h" ;;
    esac
  fi
}

check_network() {
  normalize_proxy_scheme

  local timeout=5
  if ! command -v curl &>/dev/null; then
    return
  fi

  # Detect OS-level system proxy candidate up front. _test_source_mode
  # uses this as fallback when env HTTP_PROXY/HTTPS_PROXY is unset, so
  # macOS users with clash verge / Surge / GoLand HTTP proxy etc. get
  # auto-discovered. Result is informational and surfaced through the
  # per-source probe -- if no source needs the candidate, we don't
  # inject HTTP_PROXY (avoid breaking user envs that explicitly want
  # direct).
  local sys_proxy_candidate=""
  if [ -z "${HTTPS_PROXY:-}${HTTP_PROXY:-}${https_proxy:-}${http_proxy:-}" ]; then
    sys_proxy_candidate=$(_get_system_proxy_candidate 2>/dev/null || echo "")
    if [ -n "$sys_proxy_candidate" ]; then
      echo "  Detected system proxy candidate: $sys_proxy_candidate (will be tested per-source)"
    fi
  fi

  # FIRST: classify the user's PIP_INDEX_URL (if set) the same way we
  # classify public mirrors. Internal corporate mirrors typically don't
  # need (and often break behind) the system proxy -- adding HTTP_PROXY
  # because some public source needs it would route the user's primary
  # through the proxy too, breaking direct-only internals. Per-source
  # NO_PROXY classification fixes this: we tell pip exactly which hosts
  # bypass the proxy and which go through it, instead of forcing one
  # global choice.
  if [ -n "${PIP_INDEX_URL:-}" ]; then
    # Extract host from URL using bash native string ops (portable
    # across bash/dash, no sed BSD/GNU divergence). Handles
    # credentials and port: https://user:pass@host:port/path -> host.
    local user_idx_host
    user_idx_host="${PIP_INDEX_URL#*://}"   # strip scheme
    user_idx_host="${user_idx_host%%/*}"    # keep up to first /
    user_idx_host="${user_idx_host#*@}"     # strip user:pass@
    user_idx_host="${user_idx_host%:*}"     # strip :port
    if [ -n "$user_idx_host" ] && [ "$user_idx_host" != "$PIP_INDEX_URL" ]; then
      local user_idx_mode
      user_idx_mode=$(_test_source_mode "$PIP_INDEX_URL" "$timeout")
      case "$user_idx_mode" in
        direct)
          echo "  User PIP_INDEX_URL reachable [OK] (direct, $user_idx_host) - adding to NO_PROXY so pip bypasses HTTP_PROXY"
          _add_no_proxy_host "$user_idx_host"
          ;;
        proxy)
          echo "  User PIP_INDEX_URL reachable [OK] (via proxy, $user_idx_host) - NOT adding to NO_PROXY"
          ;;
        unreachable)
          echo "WARNING: User PIP_INDEX_URL unreachable both direct and via proxy ($user_idx_host)"
          ;;
      esac
    fi
  fi

  # Probe BOTH public pip sources (pypi.org and Tsinghua mirror), no
  # short-circuit. Collect every reachable URL into public_pip_urls
  # (space-separated, priority order). pip natively supports multiple
  # PIP_EXTRA_INDEX_URL values separated by space -- when the primary
  # source misses a package pip tries each extra-index in order -- so
  # offering both mirrors maximises fallback coverage instead of
  # forcing a single pypi-OR-Tsinghua choice.
  local pypi_mode
  local tsinghua_mode
  pypi_mode=$(_test_source_mode "https://pypi.org/simple/" "$timeout")
  tsinghua_mode=$(_test_source_mode "https://pypi.tuna.tsinghua.edu.cn/simple" "$timeout")

  # Split classification: direct group (NO_PROXY) and proxy group
  # (HTTP_PROXY). Final PIP_EXTRA_INDEX_URL list orders direct first,
  # proxy second - pip walks the list in order so this means "try
  # no-proxy sources first, then proxy sources". Matches the user's
  # expectation: try direct sources first, fall back to proxy sources.
  local direct_urls=""
  local proxy_urls=""

  case "$pypi_mode" in
    direct)
      echo "  PyPI connectivity [OK] (direct -> no-proxy group)"
      _add_no_proxy_host "pypi.org"
      direct_urls="${direct_urls}${direct_urls:+ }https://pypi.org/simple"
      ;;
    proxy)
      echo "  PyPI connectivity [OK] (via env proxy -> proxy group)"
      proxy_urls="${proxy_urls}${proxy_urls:+ }https://pypi.org/simple"
      ;;
    unreachable)
      echo "WARNING: PyPI unreachable (https://pypi.org); pip install primary source may fail"
      ;;
  esac

  case "$tsinghua_mode" in
    direct)
      echo "  Tsinghua pip mirror reachable [OK] (direct -> no-proxy group)"
      _add_no_proxy_host "pypi.tuna.tsinghua.edu.cn"
      _add_no_proxy_host "mirrors.tuna.tsinghua.edu.cn"
      direct_urls="${direct_urls}${direct_urls:+ }https://pypi.tuna.tsinghua.edu.cn/simple"
      ;;
    proxy)
      echo "  Tsinghua pip mirror reachable [OK] (via env proxy -> proxy group)"
      # Deliberately NOT adding to NO_PROXY so pip honors HTTP_PROXY.
      proxy_urls="${proxy_urls}${proxy_urls:+ }https://pypi.tuna.tsinghua.edu.cn/simple"
      ;;
    unreachable)
      if [ "$pypi_mode" = "unreachable" ]; then
        _print_proxy_guidance "pypi.org and the Tsinghua mirror are unreachable in both direct and via-proxy modes."
      fi
      ;;
  esac

  # Concat: direct first, then proxy.
  local public_pip_urls=""
  if [ -n "$direct_urls" ]; then public_pip_urls="$direct_urls"; fi
  if [ -n "$proxy_urls" ]; then public_pip_urls="${public_pip_urls}${public_pip_urls:+ }$proxy_urls"; fi

  # Auto-pick primary index when user didn't set one and pypi is
  # unreachable: prefer Tsinghua. Preserves legacy behavior -- users
  # without explicit PIP_INDEX_URL get an accessible mirror picked for
  # them.
  if [ -z "${PIP_INDEX_URL:-}" ] && [ "$pypi_mode" = "unreachable" ] && \
     ([ "$tsinghua_mode" = "direct" ] || [ "$tsinghua_mode" = "proxy" ]); then
    export PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
    echo "  Auto-enabled Tsinghua pip mirror as primary source: $PIP_INDEX_URL"
  fi

  local hf_mode
  hf_mode=$(_test_source_mode "https://huggingface.co" "$timeout")
  case "$hf_mode" in
    direct)
      echo "  HuggingFace connectivity [OK] (direct)"
      _add_no_proxy_host "huggingface.co"
      ;;
    proxy)
      echo "  HuggingFace connectivity [OK] (via env proxy)"
      ;;
    unreachable)
      echo "WARNING: HuggingFace unreachable (https://huggingface.co); model downloads may fail"
      local hf_mirror_mode
      hf_mirror_mode=$(_test_source_mode "https://hf-mirror.com" "$timeout")
      case "$hf_mirror_mode" in
        direct)
          if [ -z "${HF_ENDPOINT:-}" ]; then
            export HF_ENDPOINT="https://hf-mirror.com"
            echo "  Auto-enabled HF mirror (direct): $HF_ENDPOINT"
          fi
          _add_no_proxy_host "hf-mirror.com"
          ;;
        proxy)
          if [ -z "${HF_ENDPOINT:-}" ]; then
            export HF_ENDPOINT="https://hf-mirror.com"
            echo "  Auto-enabled HF mirror (via env proxy): $HF_ENDPOINT"
          fi
          ;;
        unreachable)
          _print_proxy_guidance "huggingface.co and hf-mirror.com are unreachable in both direct and via-proxy modes."
          ;;
      esac
      ;;
  esac

  # Deliberately do NOT auto-inject HTTP_PROXY / HTTPS_PROXY here,
  # even when we detected a system proxy candidate AND some source
  # only reached via that candidate. Real-world regression on Mac
  # (user feedback): forcing pip to tunnel through clash verge's
  # mixed port (7897) breaks for hosts the user's clash rules mark
  # as DIRECT (e.g. tsinghua):
  #   1. We set PIP_INDEX_URL=tsinghua + inject HTTPS_PROXY=clash
  #   2. pip sends CONNECT tsinghua:443 to clash
  #   3. clash sees rule "tsinghua -> DIRECT" and tries to forward
  #      transparently, but the CONNECT tunnel handshake breaks on
  #      SSL handshake -> pip retries until 3-attempt cap fails.
  # NO_PROXY also didn't reliably bypass pip's proxy logic across
  # pip / requests / urllib3 versions.
  #
  # Instead: leave HTTP_PROXY unset for pip. Model download is
  # handled separately -- install-template.sh's Python loader uses
  # urllib.request.getproxies() to bridge macOS system proxy into
  # os.environ so requests/huggingface_hub can reach HuggingFace.
  # (requests does NOT auto-detect macOS system proxy -- only stdlib
  # urllib does.) User can still .env-export HTTP_PROXY if they want
  # everything tunneled -- that path is unchanged.
  #
  # .ps1 equivalent (Windows Assert-Network) still injects because
  # Windows tooling has no OS-level fallback -- that asymmetry is
  # intentional and documented there.
  if [ -n "$sys_proxy_candidate" ] && [ -z "${HTTP_PROXY:-}${HTTPS_PROXY:-}" ]; then
    if [ "$pypi_mode" = "proxy" ] || [ "$tsinghua_mode" = "proxy" ] || \
       [ "${hf_mode:-}" = "proxy" ] || [ "${hf_mirror_mode:-}" = "proxy" ] || \
       [ "${user_idx_mode:-}" = "proxy" ]; then
      echo "  Detected system proxy ${sys_proxy_candidate} (reachable for at least one source), but NOT injecting HTTP_PROXY into install subprocess - pip / huggingface_hub will use the OS system proxy stack. To force pip through this proxy too, set explicitly in .env: HTTP_PROXY=${sys_proxy_candidate}"
    fi
  fi

  # Export sentinel for downstream model-download steps. If HF probe
  # only succeeded VIA candidate (and user didn't pre-set HTTP_PROXY),
  # the model preload step (install-template.sh::_install_template_
  # load_model) needs to know to wire that proxy into the Python child
  # process -- `requests`/`huggingface_hub` don't read macOS system
  # proxy on their own. We keep this sentinel separate from
  # HTTP_PROXY/HTTPS_PROXY so pip install (the earlier step in the
  # template) still goes direct to e.g. Tsinghua via NO_PROXY, only
  # the HF model download step gets the proxy.
  #
  # Single source of truth: prereq-check decides, downstream just
  # consumes -- no second urllib.getproxies() call inside Python.
  if [ -z "${HTTP_PROXY:-}${HTTPS_PROXY:-}" ] && [ -n "$sys_proxy_candidate" ]; then
    if [ "${hf_mode:-}" = "proxy" ] || [ "${hf_mirror_mode:-}" = "proxy" ]; then
      export _CATCAFE_HF_PROXY_FOR_DOWNLOAD="$sys_proxy_candidate"
      echo "  HF model download step will use system proxy: ${_CATCAFE_HF_PROXY_FOR_DOWNLOAD} (per-process injection, does not affect pip)"
    fi
  fi

  # Always inject PIP_EXTRA_INDEX_URL (unless user already set it
  # explicitly). pip's primary index resolution falls back through
  # multiple sources: command-line --index-url > $PIP_INDEX_URL env >
  # pip.conf > pip default (pypi.org). The previous guard "only inject
  # if $PIP_INDEX_URL is set" missed the pip.conf case -- if the user
  # has an index-url in ~/.pip/pip.conf (corporate mirror), pip uses it
  # but we can't see it from env, so we'd skip injecting EXTRA and
  # leave pip with no public fallback when the corp mirror misses a
  # package.
  #
  # Fix: inject our mirror policy as PIP_EXTRA_INDEX_URL regardless of
  # whether $PIP_INDEX_URL is set in env. pip.conf primary stays
  # primary, env EXTRA (us) is the fallback list. Direct-first
  # ordering and per-host NO_PROXY classification are preserved.
  if [ -z "${PIP_EXTRA_INDEX_URL:-}" ]; then
    # Normalize user URL for dedup comparison (strip trailing slash).
    local user_idx="${PIP_INDEX_URL:-}"
    user_idx="${user_idx%/}"
    # Build dedup candidate list from probe results.
    local candidates=""
    local url
    for url in $public_pip_urls; do
      if [ "${url%/}" != "$user_idx" ]; then
        if [ -z "$candidates" ]; then candidates="$url"; else candidates="$candidates $url"; fi
      fi
    done

    local fb_url=""
    local fb_reason=""
    if [ -n "$candidates" ]; then
      # Strong signal path: curl confirmed at least one public mirror
      # reachable. Inject everything we confirmed.
      fb_url="$candidates"
      fb_reason="primary probe reachable, priority pypi -> Tsinghua"
    elif [ -n "${HTTP_PROXY:-}${HTTPS_PROXY:-}${http_proxy:-}${https_proxy:-}" ]; then
      # Probe found nothing curl could reach, but the user has an HTTP
      # proxy configured (.env / shell). Trust that pip can use the same
      # proxy to reach pypi / Tsinghua even though our curl-based probe
      # couldn't (Windows transparent proxies, proxy.pac, SSPI corp
      # gateways, etc.). Inject BOTH so pip has maximum coverage --
      # mirror policy parity with the strong-signal path.
      local last_resort=""
      if [ "$user_idx" != "https://pypi.org/simple" ]; then
        last_resort="https://pypi.org/simple"
      fi
      if [ "$user_idx" != "https://pypi.tuna.tsinghua.edu.cn/simple" ]; then
        last_resort="${last_resort}${last_resort:+ }https://pypi.tuna.tsinghua.edu.cn/simple"
      fi
      fb_url="$last_resort"
      fb_reason="last-resort (curl probe failed but user has HTTP_PROXY configured; trust pip to reach via proxy)"
    fi
    # No `else` branch: probe failed AND no user proxy -> no fallback.
    # Injecting URLs pip can't reach just inflates the error log noise
    # without changing the outcome -- let pip surface the precise
    # "internal mirror missing X" error instead.

    if [ -n "$fb_url" ]; then
      export PIP_EXTRA_INDEX_URL="$fb_url"
      echo "  Injected PIP_EXTRA_INDEX_URL=\"${fb_url}\" (${fb_reason}; user PIP_INDEX_URL=${PIP_INDEX_URL:-<unset / managed by pip.conf>})"
    elif [ -z "${HTTP_PROXY:-}${HTTPS_PROXY:-}${http_proxy:-}${https_proxy:-}" ]; then
      echo "  PIP_EXTRA_INDEX_URL not injected (curl probe failed for public sources + no HTTP_PROXY -> pip likely cannot reach them either; skipping to avoid noise)"
    else
      echo "  PIP_EXTRA_INDEX_URL not injected (user already covers every candidate public source; PIP_INDEX_URL=${PIP_INDEX_URL:-<unset>})"
    fi
  fi
}
