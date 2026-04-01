#!/usr/bin/env bash
# Clowder AI — Pre-install network connectivity check
# Derives required endpoints from pnpm-lock.yaml, tests reachability,
# and suggests env-var fixes for corporate/intranet environments.
#
# Usage:
#   bash scripts/preflight.sh [--registry=URL] [--timeout=N] [--skip-fix]
#
# Exit codes: 0 = all pass, 1 = failures found, 2 = script error

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ── Args ──────────────────────────────────────────────────────
NPM_REGISTRY=""; TIMEOUT=5; SHOW_FIX=true; SOURCE_ONLY=false
for arg in "$@"; do
    case $arg in
        --registry=*) NPM_REGISTRY="${arg#*=}" ;;
        --timeout=*)  TIMEOUT="${arg#*=}" ;;
        --skip-fix)   SHOW_FIX=false ;;
        --source-only) SOURCE_ONLY=true ;;
    esac
done

# ── Resolve paths ─────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOCKFILE="$PROJECT_ROOT/pnpm-lock.yaml"

# ── Output helpers ────────────────────────────────────────────
pf_ok()   { printf "  ${GREEN}✓${NC} %s\n" "$*"; }
pf_fail() { printf "  ${RED}✗${NC} %s\n" "$*"; }
pf_warn() { printf "  ${YELLOW}⚠${NC} %s\n" "$*"; }
pf_info() { printf "${CYAN}%s${NC}\n" "$*"; }

# ── test_endpoint: returns 0 if URL is reachable ──────────────
test_endpoint() {
    local url="$1"
    if command -v curl &>/dev/null; then
        # No -f flag: we test *network reachability*, not content.
        # A 403 (e.g. Puppeteer CDN root) proves the host is reachable.
        curl -sSL --connect-timeout "$TIMEOUT" --max-time "$((TIMEOUT * 2))" \
             -o /dev/null -w '%{http_code}' "$url" >/dev/null 2>&1
    elif command -v wget &>/dev/null; then
        # --spider exits non-zero on 4xx/5xx; use --server-response to
        # capture headers and grep for any HTTP reply (proves reachable).
        wget --server-response --spider --timeout="$TIMEOUT" -q "$url" 2>&1 | grep -qi 'HTTP/'
    else
        # Fallback: bash TCP probe — extract host, port, and scheme from URL
        local host port scheme
        host="$(printf '%s' "$url" | sed -E 's|https?://||;s|/.*||')"
        scheme="$(printf '%s' "$url" | sed -E 's|^(https?)://.*|\1|')"
        if [[ "$host" == *:* ]]; then
            port="${host##*:}"
            host="${host%%:*}"
        else
            [[ "$scheme" == "https" ]] && port=443 || port=80
        fi
        (echo > /dev/tcp/"$host"/"$port") 2>/dev/null
    fi
}

# ── resolve_registry: env > .npmrc > default ──────────────────
resolve_registry() {
    [[ -n "$NPM_REGISTRY" ]] && { printf '%s' "$NPM_REGISTRY"; return; }
    # Env vars (npm/pnpm convention + cross-platform CAT_CAFE_NPM_REGISTRY)
    for var in CAT_CAFE_NPM_REGISTRY npm_config_registry NPM_CONFIG_REGISTRY PNPM_CONFIG_REGISTRY; do
        local val="${!var:-}"
        [[ -n "$val" ]] && { printf '%s' "$val"; return; }
    done
    # Project .npmrc
    if [[ -f "$PROJECT_ROOT/.npmrc" ]]; then
        local r; r="$(grep -E '^registry=' "$PROJECT_ROOT/.npmrc" 2>/dev/null | head -1 | cut -d= -f2-)"
        [[ -n "$r" ]] && { printf '%s' "$r"; return; }
    fi
    # User .npmrc (NPM_CONFIG_USERCONFIG overrides default path)
    local user_npmrc="${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"
    if [[ -f "$user_npmrc" ]]; then
        local r; r="$(grep -E '^registry=' "$user_npmrc" 2>/dev/null | head -1 | cut -d= -f2-)"
        [[ -n "$r" ]] && { printf '%s' "$r"; return; }
    fi
    printf '%s' "https://registry.npmjs.org"
}

# ── normalize_pkg_env: @scope/my-pkg → scope_my_pkg ──────────
normalize_pkg_env() {
    printf '%s' "$1" | sed 's/^@//' | tr '/-' '__'
}

# ── scan_prebuild_packages: find packages using prebuild-install ──
# Reads pnpm-lock.yaml and outputs package names (one per line)
scan_prebuild_packages() {
    [[ -f "$LOCKFILE" ]] || return 0
    # In pnpm-lock.yaml (v9 format), resolved packages look like:
    #   better-sqlite3@12.6.2:
    #     dependencies:
    #       prebuild-install: 7.1.3
    # We parse header-to-header: if prebuild-install appears between two
    # package headers, we output the package name.
    awk '
        /^  '\''?[a-zA-Z0-9@][^ ]*@[0-9]/ {
            if (found) print pkg
            pkg = $0; sub(/^  '\''?/, "", pkg); sub(/'\''?:$/, "", pkg)
            match(pkg, /@[0-9]/)
            pkg = substr(pkg, 1, RSTART - 1)
            found = 0
            next
        }
        /prebuild-install/ { found = 1 }
        END { if (found) print pkg }
    ' "$LOCKFILE" | sort -u
}

# ── has_puppeteer: check if puppeteer is a direct/transitive dep ──
has_puppeteer() {
    [[ -f "$LOCKFILE" ]] && grep -qE '^\s+puppeteer@[0-9]' "$LOCKFILE" 2>/dev/null
}

# ── resolve_puppeteer_download_url ────────────────────────────
# Priority: env var > .puppeteerrc config > known upstream default
resolve_puppeteer_url() {
    [[ -n "${PUPPETEER_DOWNLOAD_BASE_URL:-}" ]] && {
        printf '%s' "$PUPPETEER_DOWNLOAD_BASE_URL"; return
    }
    # Check project-level puppeteer config
    for cfg in "$PROJECT_ROOT/.puppeteerrc.cjs" "$PROJECT_ROOT/.puppeteerrc.mjs" \
               "$PROJECT_ROOT/.puppeteerrc" "$PROJECT_ROOT/puppeteer.config.cjs"; do
        if [[ -f "$cfg" ]]; then
            local url; url="$(grep -oE 'downloadBaseUrl.*https?://[^"'"'"' ]+' "$cfg" 2>/dev/null | grep -oE 'https?://[^"'"'"' ]+' | head -1)"
            [[ -n "$url" ]] && { printf '%s' "$url"; return; }
        fi
    done
    # Upstream default (Chrome for Testing)
    printf '%s' "https://storage.googleapis.com/chrome-for-testing-public"
}

# ── detect_proxy_ghosts: check for stale proxy in npmrc files ──
detect_proxy_ghosts() {
    local found=false
    # Check Node.js installation npmrc (common on Windows, also possible on Linux)
    local node_bin; node_bin="$(command -v node 2>/dev/null || true)"
    if [[ -n "$node_bin" ]]; then
        local node_dir; node_dir="$(dirname "$(dirname "$node_bin")")"
        local node_npmrc="$node_dir/etc/npmrc"
        [[ -f "$node_npmrc" ]] && grep -qiE '^\s*(https?-)?proxy\s*=' "$node_npmrc" 2>/dev/null && {
            pf_warn "Stale proxy config in: $node_npmrc"
            found=true
        }
    fi
    # Check user npmrc
    [[ -f "$HOME/.npmrc" ]] && grep -qiE '^\s*(https?-)?proxy\s*=' "$HOME/.npmrc" 2>/dev/null && {
        pf_warn "Proxy config in: $HOME/.npmrc (verify it is current)"
        found=true
    }
    $found
}

# ── Main ──────────────────────────────────────────────────────
$SOURCE_ONLY && return 0 2>/dev/null || true
[[ "$SOURCE_ONLY" == true ]] && exit 0

[[ -f "$LOCKFILE" ]] || { pf_fail "pnpm-lock.yaml not found at $PROJECT_ROOT"; exit 2; }

pf_info "Clowder AI — Preflight Network Check"
echo ""

FAILURES=()
TOTAL=0; PASSED=0

# ── Check 1: Proxy ghosts ────────────────────────────────────
pf_info "[1/3] Checking for stale proxy configs..."
if detect_proxy_ghosts; then
    pf_warn "Stale proxy settings detected (see above). This may cause ECONNREFUSED errors."
else
    pf_ok "No stale proxy configs detected"
fi
echo ""

# ── Check 2: npm registry ────────────────────────────────────
pf_info "[2/3] Testing npm registry..."
REGISTRY=$(resolve_registry)
TOTAL=$((TOTAL + 1))
if test_endpoint "$REGISTRY"; then
    pf_ok "Registry: $REGISTRY"
    PASSED=$((PASSED + 1))
else
    pf_fail "Registry: $REGISTRY — UNREACHABLE"
    FAILURES+=("registry|$REGISTRY|--registry=URL or npm_config_registry")
fi
echo ""

# ── Check 3: Binary download hosts ───────────────────────────
pf_info "[3/3] Scanning lockfile for binary download dependencies..."

# prebuild-install packages → check effective binary host per package
# P1 fix: if npm_config_{pkg}_binary_host is set, test that instead of GitHub
PREBUILD_PKGS=()
while IFS= read -r pkg; do
    [[ -n "$pkg" ]] && PREBUILD_PKGS+=("$pkg")
done < <(scan_prebuild_packages)

GITHUB_NEEDED=()  # "pkg|env_name" entries needing GitHub (no mirror configured)

for pkg in "${PREBUILD_PKGS[@]:-}"; do
    [[ -z "$pkg" ]] && continue
    norm=$(normalize_pkg_env "$pkg")
    env_name="npm_config_${norm}_binary_host"
    env_name_mirror="npm_config_${norm}_binary_host_mirror"
    configured="${!env_name:-}"
    [[ -z "$configured" ]] && configured="${!env_name_mirror:-}"
    if [[ -n "$configured" ]]; then
        # User has a mirror configured — test that instead of GitHub
        TOTAL=$((TOTAL + 1))
        host_display=$(printf '%s' "$configured" | sed -E 's|https?://||;s|/.*||')
        if test_endpoint "$configured"; then
            pf_ok "$pkg → $host_display (mirror via $env_name)"
            PASSED=$((PASSED + 1))
        else
            pf_fail "$pkg → $host_display (mirror via $env_name) — UNREACHABLE"
            FAILURES+=("prebuild-mirror|$pkg|Configured $env_name=$configured is unreachable. Check the URL.")
        fi
    else
        GITHUB_NEEDED+=("$pkg|$env_name")
    fi
done

# Test GitHub once for all packages without configured mirrors
if [[ ${#GITHUB_NEEDED[@]} -gt 0 ]]; then
    TOTAL=$((TOTAL + 1))
    pkg_names=""
    for entry in "${GITHUB_NEEDED[@]}"; do
        p="${entry%%|*}"
        [[ -n "$pkg_names" ]] && pkg_names="$pkg_names, "
        pkg_names="$pkg_names$p"
    done
    if test_endpoint "https://github.com"; then
        pf_ok "GitHub (prebuild: $pkg_names) — reachable"
        PASSED=$((PASSED + 1))
    else
        pf_fail "GitHub (prebuild: $pkg_names) — UNREACHABLE"
        local_fix=""
        for entry in "${GITHUB_NEEDED[@]}"; do
            IFS='|' read -r p env_name <<< "$entry"
            [[ -n "$local_fix" ]] && local_fix="${local_fix}\n"
            local_fix="${local_fix}export ${env_name}=<YOUR_MIRROR_URL>"
        done
        FAILURES+=("prebuild|$pkg_names|$local_fix")
    fi
fi

# puppeteer → browser CDN
# Skip if PUPPETEER_SKIP_DOWNLOAD or PUPPETEER_SKIP_CHROMIUM_DOWNLOAD is set
# (pnpm install won't download Chrome, so CDN check is unnecessary)
if has_puppeteer && [[ -z "${PUPPETEER_SKIP_DOWNLOAD:-}" ]] && [[ -z "${PUPPETEER_SKIP_CHROMIUM_DOWNLOAD:-}" ]]; then
    PUPPETEER_URL=$(resolve_puppeteer_url)
    TOTAL=$((TOTAL + 1))
    # Extract host for display
    PUPPETEER_HOST=$(printf '%s' "$PUPPETEER_URL" | sed -E 's|https?://||;s|/.*||')
    if test_endpoint "$PUPPETEER_URL"; then
        pf_ok "Browser CDN: $PUPPETEER_HOST (puppeteer) — reachable"
        PASSED=$((PASSED + 1))
    else
        pf_fail "Browser CDN: $PUPPETEER_HOST (puppeteer) — UNREACHABLE"
        FAILURES+=("browser|puppeteer|export PUPPETEER_DOWNLOAD_BASE_URL=<YOUR_MIRROR_URL>")
    fi
elif has_puppeteer; then
    pf_ok "Browser CDN: skipped (PUPPETEER_SKIP_DOWNLOAD or PUPPETEER_SKIP_CHROMIUM_DOWNLOAD is set)"
fi

echo ""

# ── Report ────────────────────────────────────────────────────
if [[ ${#FAILURES[@]} -eq 0 ]]; then
    printf "${GREEN}${BOLD}✓ Preflight passed (%d/%d checks OK)${NC}\n" "$PASSED" "$TOTAL"
    exit 0
fi

printf "${RED}${BOLD}✗ Preflight failed — %d of %d checks unreachable${NC}\n" "${#FAILURES[@]}" "$TOTAL"

if $SHOW_FIX; then
    echo ""
    pf_info "How to fix:"
    echo ""
    for entry in "${FAILURES[@]}"; do
        IFS='|' read -r ftype fpkg ffix <<< "$entry"
        case "$ftype" in
            registry)
                echo "  npm registry ($fpkg) is unreachable."
                echo "  Pass a reachable mirror to the installer:"
                echo ""
                echo "    bash scripts/install.sh --registry=https://YOUR_NPM_MIRROR/"
                echo ""
                echo "  Or set the environment variable before running:"
                echo ""
                echo "    export npm_config_registry=https://YOUR_NPM_MIRROR/"
                echo ""
                ;;
            prebuild-mirror)
                echo "  $ffix"
                echo ""
                ;;
            prebuild)
                echo "  Packages [$fpkg] download prebuilt binaries from GitHub."
                echo "  GitHub is unreachable. Set binary host mirrors:"
                echo ""
                printf '%b\n' "$ffix" | while IFS= read -r line; do
                    echo "    $line"
                done
                echo ""
                ;;
            browser)
                echo "  $fpkg downloads a browser binary from a CDN."
                echo "  The CDN is unreachable. Redirect to your mirror:"
                echo ""
                echo "    $ffix"
                echo ""
                ;;
        esac
    done
    echo "  Then re-run the installer."
fi

exit 1
