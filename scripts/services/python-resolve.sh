#!/usr/bin/env bash
# scripts/services/python-resolve.sh
#
# Unified Python 3.12+ interpreter resolver, shared by all service install
# scripts (whisper / tts / embed / llm) and the agent CLI installer (kimi).
#
# Goals:
#   - Don't fight the user's environment: reuse any system Python or
#     multi-version manager (uv / pyenv / brew) the user already has.
#   - Don't push uv / pyenv on users who haven't opted in. We *reuse* them,
#     but never auto-install them as a precondition.
#   - When nothing on the system satisfies our requirements, fall back to a
#     project-owned interpreter under ~/.cat-cafe/python-x64/ so we don't
#     touch the user's system Python at all.
#
# Resolution order (first match wins, falls through on failure):
#   1. System Python candidates (python3.13, python3.12, py -3.12, python).
#      Accept anything with major.minor >= 3.12 AND a working venv module.
#      On Windows ARM64 we additionally require AMD64 architecture (Prism
#      emulation) -- native ARM Python can't pip-install several deps.
#   2. uv (if user already has it) -- uv python find 3.12 reuses uv-managed
#      builds or the user's pyenv toolchain.
#   3. pyenv (Linux/macOS, if installed) -- query installed 3.12.x version
#      or install one if not present.
#   4. Homebrew (macOS, if installed) -- brew --prefix python@3.12.
#   5. Project-owned Python in ~/.cat-cafe/python-x64/ (or platform-equivalent)
#      -- only when nothing above worked.
#
# Usage from an install script:
#   source "$(dirname "$0")/python-resolve.sh"
#   resolve_python_312     # sets RESOLVED_PYTHON to the absolute path
#   "$RESOLVED_PYTHON" -m venv ~/.cat-cafe/whisper-venv
#
# Exit codes:
#   0 -- RESOLVED_PYTHON set, ready to use
#   1 -- no interpreter could be resolved (user must intervene)

RESOLVED_PYTHON=""
RESOLVED_PYTHON_ARCH=""   # native | x86_64 (== amd64) | unknown
RESOLVED_PYTHON_SOURCE="" # system | uv | pyenv | brew | project

# Single source of truth for the cat-cafe data dir. Mirrors the Windows
# Redis convention (install-windows-helpers.ps1 line 104 places its
# portable Redis under <ProjectRoot>/.cat-cafe/redis/windows/) -- Python
# + venvs + Piper voice models all live under the same project-rooted
# .cat-cafe/ so uninstall = delete the project dir, no cross-instance
# pollution in $HOME.
#
# Resolution priority:
#   1. CAT_CAFE_HOME env (caller override -- e.g. a CI environment that
#      wants its own scratch path)
#   2. <repo-root>/.cat-cafe (derived from this script's location:
#      scripts/services/python-resolve.sh -> repo-root is two levels up)
_RESOLVER_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
_CAT_CAFE_HOME="${CAT_CAFE_HOME:-${_RESOLVER_REPO_ROOT}/.cat-cafe}"
# Expand leading ~ -- bash parameter expansion does NOT tilde-expand, so a
# value like CAT_CAFE_HOME=~/.cat-cafe-shared coming from a .env file or
# config (where the shell didnt get to expand at assignment time) would
# stay literal and resolve to <cwd>/~/.cat-cafe-shared. Codex P2 3251761227.
case "$_CAT_CAFE_HOME" in
  "~") _CAT_CAFE_HOME="$HOME" ;;
  "~/"*) _CAT_CAFE_HOME="${HOME}/${_CAT_CAFE_HOME#~/}" ;;
esac
export CAT_CAFE_HOME="$_CAT_CAFE_HOME"   # exported so child install scripts can reuse the same path
_PROJECT_PYTHON_DIR="${_CAT_CAFE_HOME}/python"

# Pinned python-build-standalone release. Same kind of portable Python
# tarball that uv / pyenv / rye fetch. The project moved from
# github.com/indygreg to github.com/astral-sh in 2025, both org+release+version
# need to match a real existing asset (verified via curl -I 200 OK before pinning).
_PBS_OWNER="astral-sh"
_PBS_RELEASE="20260510"
_PBS_VERSION="3.12.13"

_python_version_ok() {
  # Args: python_command [arg...]
  # Echoes "<major>.<minor> <machine>" on success and returns 0; returns 1 on failure.
  local cmd_out
  cmd_out=$("$@" -c 'import sys, platform; print(f"{sys.version_info.major}.{sys.version_info.minor} {platform.machine().lower()}")' 2>/dev/null) || return 1
  local ver machine major minor
  ver="${cmd_out% *}"; machine="${cmd_out##* }"
  major="${ver%.*}"; minor="${ver#*.}"
  # major>=3 AND minor>=12 (in practice major is always 3, but be explicit)
  if [ "$major" -lt 3 ]; then return 1; fi
  if [ "$major" -eq 3 ] && [ "$minor" -lt 12 ]; then return 1; fi
  # Confirm venv module works AND can actually create venvs. On Debian/Ubuntu
  # the system Python ships *without* ensurepip unless the user separately
  # installs python3.X-venv; `import venv` succeeds in that broken state but
  # `python -m venv <dir>` fails at venv.create() because it depends on
  # ensurepip. Test ensurepip directly so we reject those incomplete
  # interpreters and fall through to project-owned Python (which always
  # bundles ensurepip via the python-build-standalone tarball).
  "$@" -c 'import venv, ensurepip' >/dev/null 2>&1 || return 1
  printf '%s %s\n' "$ver" "$machine"
  return 0
}

_arch_acceptable_for_platform() {
  # Args: machine_string
  # On Windows we'd be checking AMD64, but this resolver runs on POSIX only;
  # the PowerShell version (python-resolve.ps1) enforces AMD64. Here we
  # accept any architecture -- Linux/macOS native interpreters work.
  return 0
}

_try_system_pythons() {
  local cmd ver_out
  for cmd in python3.13 python3.12 python3 python; do
    if ! command -v "$cmd" >/dev/null 2>&1; then continue; fi
    ver_out=$(_python_version_ok "$cmd") || continue
    local machine="${ver_out##* }"
    _arch_acceptable_for_platform "$machine" || continue
    RESOLVED_PYTHON="$(command -v "$cmd")"
    RESOLVED_PYTHON_ARCH="$machine"
    RESOLVED_PYTHON_SOURCE="system"
    return 0
  done
  return 1
}

_try_uv() {
  command -v uv >/dev/null 2>&1 || return 1
  # uv python find prints absolute path of a matching interpreter -- or fails.
  # We don't ask uv to install (that would silently grow user state); we only
  # reuse what uv already has.
  local found
  found=$(uv python find '>=3.12' 2>/dev/null) || return 1
  [ -n "$found" ] && [ -x "$found" ] || return 1
  # CRITICAL: uv on Linux happily points at /usr/bin/python3 (Debian/Ubuntu
  # system Python) which lacks ensurepip -- `python -m venv` then fails. We
  # were missing this check on _try_uv / _try_pyenv / _try_brew, so the
  # resolver returned a broken interpreter that survived all the way to
  # the venv-create step in install scripts. Same _python_version_ok used
  # by _try_system_pythons (covers version + venv + ensurepip).
  _python_version_ok "$found" >/dev/null || return 1
  RESOLVED_PYTHON="$found"
  RESOLVED_PYTHON_ARCH="$($found -c 'import platform; print(platform.machine().lower())' 2>/dev/null || echo unknown)"
  RESOLVED_PYTHON_SOURCE="uv"
  return 0
}

_try_pyenv() {
  command -v pyenv >/dev/null 2>&1 || return 1
  local installed
  installed=$(pyenv versions --bare 2>/dev/null | grep -E '^3\.(1[2-9]|[2-9][0-9])' | head -1)
  if [ -z "$installed" ]; then return 1; fi
  local py
  py=$(pyenv root)/versions/${installed}/bin/python
  [ -x "$py" ] || return 1
  _python_version_ok "$py" >/dev/null || return 1
  RESOLVED_PYTHON="$py"
  RESOLVED_PYTHON_ARCH="$($py -c 'import platform; print(platform.machine().lower())' 2>/dev/null || echo unknown)"
  RESOLVED_PYTHON_SOURCE="pyenv"
  return 0
}

_try_brew() {
  [ "$(uname -s)" = "Darwin" ] || return 1
  command -v brew >/dev/null 2>&1 || return 1
  local brew_prefix
  brew_prefix=$(brew --prefix python@3.12 2>/dev/null) || return 1
  local py="${brew_prefix}/bin/python3.12"
  [ -x "$py" ] || return 1
  _python_version_ok "$py" >/dev/null || return 1
  RESOLVED_PYTHON="$py"
  RESOLVED_PYTHON_ARCH="$($py -c 'import platform; print(platform.machine().lower())' 2>/dev/null || echo unknown)"
  RESOLVED_PYTHON_SOURCE="brew"
  return 0
}

_try_project_python() {
  local py="${_PROJECT_PYTHON_DIR}/bin/python3"
  [ -x "$py" ] || return 1
  _python_version_ok "$py" >/dev/null || return 1
  RESOLVED_PYTHON="$py"
  RESOLVED_PYTHON_ARCH="$($py -c 'import platform; print(platform.machine().lower())' 2>/dev/null || echo unknown)"
  RESOLVED_PYTHON_SOURCE="project"
  return 0
}

_try_legacy_project_python() {
  # Pre-a34ab1f2 (the "move Python + venvs from $HOME/.cat-cafe to
  # <ProjectRoot>/.cat-cafe" commit) installs lived at
  # $HOME/.cat-cafe/python. Reuse them if they exist so existing
  # installs survive the path migration without re-downloading the
  # whole python-build-standalone tarball -- which on isolated VMs
  # (Linux/macOS without good GitHub reach) is the difference between
  # "one-click install works" and "fails at first network blip".
  # We don't auto-migrate the directory -- the user can clean install
  # later to switch to the repo-local path on their own schedule.
  local legacy_dir="${HOME}/.cat-cafe/python"
  # Skip if legacy path IS the active path (caller explicitly set
  # CAT_CAFE_HOME=$HOME/.cat-cafe, or HOME == repoRoot).
  [ "$legacy_dir" = "$_PROJECT_PYTHON_DIR" ] && return 1
  local py="${legacy_dir}/bin/python3"
  [ -x "$py" ] || return 1
  _python_version_ok "$py" >/dev/null || return 1
  RESOLVED_PYTHON="$py"
  RESOLVED_PYTHON_ARCH="$($py -c 'import platform; print(platform.machine().lower())' 2>/dev/null || echo unknown)"
  RESOLVED_PYTHON_SOURCE="project-legacy"
  echo "  Reusing legacy project Python: $py (pre-CAT_CAFE_HOME-migration install - venv still created under $_CAT_CAFE_HOME)" >&2
  return 0
}

_pbs_target_triple() {
  # Determine which python-build-standalone target tarball matches this host.
  case "$(uname -s)" in
    Darwin)
      case "$(uname -m)" in
        arm64|aarch64) echo "aarch64-apple-darwin" ;;
        x86_64) echo "x86_64-apple-darwin" ;;
        *) return 1 ;;
      esac
      ;;
    Linux)
      case "$(uname -m)" in
        aarch64|arm64) echo "aarch64-unknown-linux-gnu" ;;
        x86_64) echo "x86_64-unknown-linux-gnu" ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
  return 0
}

_install_project_python_locked() {
  # Actual download + extract -- runs holding the inter-process lock.
  # Re-check inside the critical section: another concurrent install (e.g.
  # whisper / tts / embed clicked at the same time in the UI) might have
  # finished while we waited. Skip download if so.
  if [ -x "${_PROJECT_PYTHON_DIR}/bin/python3" ]; then
    echo "  Project Python already present (installed by a concurrent install)"
    return 0
  fi
  local triple
  triple=$(_pbs_target_triple) || return 1
  command -v curl >/dev/null 2>&1 || { echo "  curl required to bootstrap project Python -- please install curl" >&2; return 1; }
  command -v tar >/dev/null 2>&1 || { echo "  tar required to bootstrap project Python" >&2; return 1; }

  local tar_url="https://github.com/${_PBS_OWNER}/python-build-standalone/releases/download/${_PBS_RELEASE}/cpython-${_PBS_VERSION}+${_PBS_RELEASE}-${triple}-install_only.tar.gz"
  local tmpdir
  tmpdir=$(mktemp -d) || return 1
  echo "  Downloading portable Python ${_PBS_VERSION} (${triple}) from python-build-standalone..."
  echo "  URL: $tar_url"

  # Pick the proxy candidate to use: explicit env first, then OS-level
  # system proxy (macOS scutil / GNOME gsettings). Without the system
  # fallback, mac users running clash verge / Surge with HTTP_PROXY
  # only set in macOS network prefs (not exported in shell env) would
  # see the PBS download attempt direct connect to github.com -- which
  # often fails in CN networks even though the proxy itself works.
  # This mirrors prereq-check.sh's _get_system_proxy_candidate logic,
  # but inlined here because python-resolve.sh runs BEFORE prereq-check
  # in the install pipeline (ensurePython is invoked by the API).
  local pbs_proxy=""
  if [ -n "${HTTPS_PROXY:-}" ]; then pbs_proxy="$HTTPS_PROXY"
  elif [ -n "${HTTP_PROXY:-}" ]; then pbs_proxy="$HTTP_PROXY"
  elif [ -n "${https_proxy:-}" ]; then pbs_proxy="$https_proxy"
  elif [ -n "${http_proxy:-}" ]; then pbs_proxy="$http_proxy"
  elif [ "$(uname -s)" = "Darwin" ] && command -v scutil >/dev/null 2>&1; then
    local _proxy_info _enabled _host _port
    _proxy_info=$(scutil --proxy 2>/dev/null)
    _enabled=$(echo "$_proxy_info" | awk '/HTTPSEnable/{print $NF; exit}')
    if [ "$_enabled" = "1" ]; then
      _host=$(echo "$_proxy_info" | awk '/HTTPSProxy /{print $NF; exit}')
      _port=$(echo "$_proxy_info" | awk '/HTTPSPort /{print $NF; exit}')
      [ -n "$_host" ] && [ -n "$_port" ] && pbs_proxy="http://${_host}:${_port}"
    fi
    if [ -z "$pbs_proxy" ]; then
      _enabled=$(echo "$_proxy_info" | awk '/HTTPEnable/{print $NF; exit}')
      if [ "$_enabled" = "1" ]; then
        _host=$(echo "$_proxy_info" | awk '/HTTPProxy /{print $NF; exit}')
        _port=$(echo "$_proxy_info" | awk '/HTTPPort /{print $NF; exit}')
        [ -n "$_host" ] && [ -n "$_port" ] && pbs_proxy="http://${_host}:${_port}"
      fi
    fi
  fi

  # IMPORTANT: drop `-s` (silent) -- it swallows the actual curl error
  # text ("Could not resolve host" / "Connection timed out" / 403 / ...).
  # Keep --silent for the progress bar but use --show-error so failures
  # surface to stderr (and via install-endpoint to the service log).
  # Also print HTTP status / proxy env so users can self-diagnose what
  # path the request actually took.
  echo "  HTTP_PROXY=${HTTP_PROXY:-<unset>}  HTTPS_PROXY=${HTTPS_PROXY:-<unset>}  NO_PROXY=${NO_PROXY:-<unset>}"
  if [ -n "$pbs_proxy" ] && [ -z "${HTTP_PROXY:-}${HTTPS_PROXY:-}" ]; then
    echo "  Using detected system proxy for this download: $pbs_proxy"
  fi
  local curl_log
  curl_log=$(mktemp) || curl_log=""
  local curl_proxy_args=()
  [ -n "$pbs_proxy" ] && [ -z "${HTTP_PROXY:-}${HTTPS_PROXY:-}" ] && curl_proxy_args=(-x "$pbs_proxy")
  if ! curl -fL --silent --show-error "${curl_proxy_args[@]}" -o "${tmpdir}/python.tar.gz" -w "  HTTP status: %{http_code}  time: %{time_total}s  size: %{size_download} bytes\n" "$tar_url" 2>"${curl_log:-/dev/null}"; then
    echo "  Failed to download $tar_url" >&2
    if [ -n "$curl_log" ] && [ -s "$curl_log" ]; then
      echo "  curl error detail:" >&2
      sed 's/^/    /' "$curl_log" >&2
      rm -f "$curl_log"
    fi
    # Quick connectivity probes so the user can tell apart "GitHub
    # unreachable" from "this specific release missing".
    echo "  Connectivity probes:" >&2
    if curl -sIL --max-time 5 "https://github.com" -o /dev/null -w "    github.com -> HTTP %{http_code}\n" 2>&1 >&2; then :; fi
    if curl -sIL --max-time 5 "https://api.github.com" -o /dev/null -w "    api.github.com -> HTTP %{http_code}\n" 2>&1 >&2; then :; fi
    rm -rf "$tmpdir"
    return 1
  fi
  [ -n "$curl_log" ] && rm -f "$curl_log"
  mkdir -p "$_PROJECT_PYTHON_DIR"
  # Tarball extracts into a top-level "python/" directory -- strip that one
  # component so files land directly in $_PROJECT_PYTHON_DIR.
  if ! tar -xzf "${tmpdir}/python.tar.gz" -C "$_PROJECT_PYTHON_DIR" --strip-components=1; then
    echo "  Failed to extract Python tarball" >&2
    rm -rf "$tmpdir"
    return 1
  fi
  rm -rf "$tmpdir"
  echo "  Python ${_PBS_VERSION} installed to $_PROJECT_PYTHON_DIR (project-owned, no system changes)"
  return 0
}

_install_project_python() {
  # Wrap the actual install in an inter-process lock so concurrent service
  # installs (e.g. the user clicks install on whisper + tts + embed at the
  # same time, each spawning its own install.sh, each running this resolver)
  # don't all race to download and extract into the same target dir. Only
  # one process performs the download; the others wait and reuse the result
  # via _try_project_python in resolve_python_312.
  mkdir -p "$_CAT_CAFE_HOME"
  local lockfile="${_CAT_CAFE_HOME}/python-install.lock"
  if command -v flock >/dev/null 2>&1; then
    # Open fd 200 to the lockfile, then flock it for the duration of the
    # subshell. The lock is released automatically when fd 200 closes.
    (
      flock -w 600 200 || { echo "  Python install lock timed out (>600s)" >&2; exit 1; }
      _install_project_python_locked
    ) 200>"$lockfile"
    return $?
  fi
  # macOS / minimal containers lack flock(1). Fall back to a directory-based
  # lock that's race-safe for the rare contention window (mkdir is atomic).
  local lockdir="${_CAT_CAFE_HOME}/python-install.lock.d"
  local waited=0
  while ! mkdir "$lockdir" 2>/dev/null; do
    if [ "$waited" -ge 600 ]; then
      echo "  Python install lock timed out (>600s) -- assuming staler holder, breaking" >&2
      rmdir "$lockdir" 2>/dev/null || true
      mkdir "$lockdir" 2>/dev/null || return 1
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  trap 'rmdir "$lockdir" 2>/dev/null || true; trap - RETURN' RETURN
  _install_project_python_locked
}

resolve_python_312() {
  RESOLVED_PYTHON=""; RESOLVED_PYTHON_ARCH=""; RESOLVED_PYTHON_SOURCE=""
  _try_system_pythons && return 0
  _try_uv && return 0
  _try_pyenv && return 0
  _try_brew && return 0
  _try_project_python && return 0
  # Legacy path: reuse pre-a34ab1f2 install at $HOME/.cat-cafe/python
  # before triggering a fresh download (saves users on isolated VMs
  # from re-downloading python-build-standalone over an unreliable
  # GitHub connection just because we moved the default path).
  _try_legacy_project_python && return 0
  # Last resort: explain why we're falling back to a project-local Python
  # download so the user understands what just happened. Without this line
  # the install log jumps straight to "Downloading portable Python..." and
  # users worry we're touching their system interpreter.
  echo "  No Python 3.12+ found on this machine (checked: system PATH, uv, pyenv, brew, project-local cache)." >&2
  echo "  Installing a project-local Python under \${CAT_CAFE_HOME}/python/ -- does not modify system PATH or affect any existing Python." >&2
  if _install_project_python && _try_project_python; then return 0; fi
  echo "ERROR: no Python 3.12+ interpreter found and the portable Python fallback also failed." >&2
  echo "  You can install one manually:" >&2
  case "$(uname -s)" in
    Darwin) echo "    brew install python@3.12   # or download from https://www.python.org/downloads/" >&2 ;;
    Linux)  echo "    sudo apt install python3.12 python3.12-venv  # (Debian/Ubuntu with deadsnakes)" >&2
            echo "    # or:  curl -LsSf https://astral.sh/uv/install.sh | sh && uv python install 3.12" >&2 ;;
    *)      echo "    See https://www.python.org/downloads/" >&2 ;;
  esac
  return 1
}
