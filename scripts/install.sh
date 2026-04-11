#!/usr/bin/env bash
# Cat Cafe — Cross-Platform One-Click Install Helper (F113)
# Usage: bash scripts/install.sh [--start] [--memory] [--registry=URL] [--skip-preflight]
# Supported: macOS (Homebrew), Debian/Ubuntu, CentOS/RHEL/Fedora

set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
AUTO_START=false; MEMORY_MODE=false; NPM_REGISTRY=""; SOURCE_ONLY=false; SKIP_PREFLIGHT=false
PROJECT_DIR=""; PROJECT_HAS_GIT_METADATA=false
for arg in "$@"; do
    case $arg in
        --start) AUTO_START=true ;; --memory) MEMORY_MODE=true ;;
        --registry=*) NPM_REGISTRY="${arg#*=}" ;;
        --skip-preflight) SKIP_PREFLIGHT=true ;;
        --source-only) SOURCE_ONLY=true ;;
    esac
done
# Apply registry if specified (helps in China / behind proxy)
use_registry() {
    local reg="$1"
    # Only export env vars — never write to user-level ~/.npmrc.
    # npm/pnpm respect these env vars for all operations in this session.
    export npm_config_registry="$reg" NPM_CONFIG_REGISTRY="$reg" PNPM_CONFIG_REGISTRY="$reg"
}
# Registry env fallback chain: preflight.sh suggests npm_config_registry,
# so we must honour it here too — not just CAT_CAFE_NPM_REGISTRY.
for _reg_var in CAT_CAFE_NPM_REGISTRY npm_config_registry NPM_CONFIG_REGISTRY PNPM_CONFIG_REGISTRY; do
    [[ -z "$NPM_REGISTRY" && -n "${!_reg_var:-}" ]] && NPM_REGISTRY="${!_reg_var}" && break
done
unset _reg_var
[[ -n "$NPM_REGISTRY" ]] && use_registry "$NPM_REGISTRY"
npm_global_install() {
    if [[ -n "$NPM_REGISTRY" ]]; then
        $SUDO env npm_config_registry="$NPM_REGISTRY" NPM_CONFIG_REGISTRY="$NPM_REGISTRY" npm install -g "$@"
    else
        $SUDO npm install -g "$@"
    fi
}

info() { echo -e "${CYAN}$*${NC}"; }; ok() { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $*"; }; fail() { echo -e "  ${RED}✗${NC} $*"; }
step() { echo ""; echo -e "${BOLD}$*${NC}"; }
USED_FNM=false
resolve_realpath() {
    realpath "$1" 2>/dev/null || readlink -f "$1" 2>/dev/null || echo "$1"
}
persist_user_bin() {
    local bin="$1" path=""; path="$(command -v "$bin" 2>/dev/null || true)"
    [[ -n "$path" ]] || return 0
    local real_src; real_src="$(resolve_realpath "$path")"
    local target="$USER_BIN_DIR/$bin"
    # Guard: GNU ln -sfn errors when source and target resolve to the same path.
    [[ "$(resolve_realpath "$target" 2>/dev/null)" == "$real_src" ]] && return 0
    $SUDO mkdir -p "$USER_BIN_DIR"
    $SUDO ln -sfn "$real_src" "$target"
}
# Append a line to the user's shell profile (idempotent).
append_to_profile() {
    local line="$1" profile="$2"
    if [[ -f "$profile" ]] && grep -qF "$line" "$profile" 2>/dev/null; then return 0; fi
    # Ensure a leading newline if the file doesn't end with one, so we don't
    # concatenate onto the previous line and break shell parsing.
    if [[ -f "$profile" && -s "$profile" ]] && [[ $(tail -c 1 "$profile") ]]; then
        echo >> "$profile"
    fi
    echo "$line" >> "$profile"
}
# Return macOS login profile paths for both zsh and bash.
# zsh: ~/.zprofile (respects ZDOTDIR). bash: ~/.bash_profile or ~/.profile.
darwin_login_profiles() {
    echo "${ZDOTDIR:-$HOME}/.zprofile"
    if [[ -f "$HOME/.bash_profile" ]]; then
        echo "$HOME/.bash_profile"
    else
        echo "$HOME/.profile"
    fi
}

# TTY-safe read + pnpm install with registry fallback
# Verify /dev/tty is both readable AND writable (prompts write to it too).
# Use a real fd-based probe so HAS_TTY is never true on a broken terminal.
HAS_TTY=false
if [[ -r /dev/tty && -w /dev/tty ]] && tty -s </dev/tty 2>/dev/null; then
    # Open a test fd to /dev/tty and close it — catches containers where the
    # device node exists but open() fails with ENXIO.
    if (exec 9</dev/tty) 2>/dev/null; then HAS_TTY=true; fi
fi
# tty_read:  Print prompt explicitly to /dev/tty (not via read -p which goes
#            to stderr and was swallowed by 2>/dev/null).  Read from /dev/tty
#            with a 120 s timeout to avoid infinite blocking.
#            Guard the /dev/tty redirect with the fd-open probe we already ran
#            for HAS_TTY — callers should check HAS_TTY before calling, but we
#            also defend internally against "Device not configured" on macOS
#            and ENXIO on Linux containers.
tty_read() {
    local prompt="$1" var="$2"
    if [[ "$HAS_TTY" == true ]]; then
        printf '%s' "$prompt" >/dev/tty 2>/dev/null || true
        read -r -t 120 "$var" </dev/tty 2>/dev/null || printf -v "$var" '%s' ''
    else
        printf -v "$var" '%s' ''
    fi
}
tty_read_secret() {
    local prompt="$1" var="$2"
    if [[ "$HAS_TTY" == true ]]; then
        printf '%s' "$prompt" >/dev/tty 2>/dev/null || true
        local input="" char
        while IFS= read -rs -n1 -t 120 char </dev/tty 2>/dev/null; do
            [[ -z "$char" ]] && break  # Enter pressed
            if [[ "$char" == $'\x7f' || "$char" == $'\b' ]]; then
                # Backspace
                if [[ -n "$input" ]]; then
                    input="${input%?}"
                    printf '\b \b' >/dev/tty 2>/dev/null || true
                fi
            else
                input+="$char"
                printf '*' >/dev/tty 2>/dev/null || true
            fi
        done
        printf '\n' >/dev/tty 2>/dev/null || true
        printf -v "$var" '%s' "$input"
    else
        printf -v "$var" '%s' ''
    fi
}

# ── Interactive arrow-key selectors (single-select & multi-select) ────────
# These provide a TUI-style menu: ↑↓ to move, space to toggle, enter to confirm.
# Falls back to plain tty_read when HAS_TTY is false.

# tty_select: Single-select with arrow keys.
#   Usage: tty_select RESULT_VAR "prompt" "option1" "option2" ...
#   Sets RESULT_VAR to the 0-based index of the chosen option (default 0).
tty_select() {
    local result_var="$1" prompt="$2"; shift 2
    local -a options=("$@")
    local count=${#options[@]} cur=0

    if [[ "$HAS_TTY" != true || $count -eq 0 ]]; then
        printf -v "$result_var" '%s' '0'; return
    fi

    # Save terminal state and switch to raw mode
    local saved_tty; saved_tty="$(stty -g </dev/tty 2>/dev/null)"
    printf '\n%s\n' "$prompt" >/dev/tty
    printf '  Use ↑↓ arrows to move, Enter to select\n\n' >/dev/tty

    local i
    for ((i=0; i<count; i++)); do
        if ((i == cur)); then
            printf '  \033[36m❯ %s\033[0m\n' "${options[$i]}" >/dev/tty
        else
            printf '    %s\n' "${options[$i]}" >/dev/tty
        fi
    done

    stty -echo -icanon </dev/tty 2>/dev/null
    trap "stty '${saved_tty}' </dev/tty 2>/dev/null || true; trap - INT TERM EXIT; exit 130" INT TERM
    trap "stty '${saved_tty}' </dev/tty 2>/dev/null || true; trap - INT TERM EXIT" EXIT
    while true; do
        local key
        IFS= read -rsn1 -t 120 key </dev/tty 2>/dev/null || break
        local need_redraw=false
        if [[ "$key" == $'\x1b' ]]; then
            read -rsn2 -t 0.1 key </dev/tty 2>/dev/null || true
            case "$key" in
                '[A') ((cur > 0)) && ((cur--)) || true; need_redraw=true ;;
                '[B') ((cur < count-1)) && ((cur++)) || true; need_redraw=true ;;
            esac
        elif [[ "$key" == '' ]]; then
            break
        fi
        [[ "$need_redraw" == true ]] || continue
        printf '\033[%dA' "$count" >/dev/tty
        for ((i=0; i<count; i++)); do
            printf '\r\033[K' >/dev/tty
            if ((i == cur)); then
                printf '  \033[36m❯ %s\033[0m\n' "${options[$i]}" >/dev/tty
            else
                printf '    %s\n' "${options[$i]}" >/dev/tty
            fi
        done
    done
    stty "$saved_tty" </dev/tty 2>/dev/null || true
    trap - INT TERM EXIT
    printf -v "$result_var" '%s' "$cur"
}

# tty_multiselect: Multi-select with arrow keys + space to toggle.
#   Usage: tty_multiselect RESULT_VAR "prompt" "option1" "option2" ...
#   Sets RESULT_VAR to comma-separated 0-based indices of selected options.
#   All options are pre-selected by default.
tty_multiselect() {
    local result_var="$1" prompt="$2"; shift 2
    local -a options=("$@")
    local count=${#options[@]} cur=0

    if [[ "$HAS_TTY" != true || $count -eq 0 ]]; then
        local all_indices=""
        local i
        for ((i=0; i<count; i++)); do
            [[ -n "$all_indices" ]] && all_indices+=","
            all_indices+="$i"
        done
        printf -v "$result_var" '%s' "$all_indices"; return
    fi

    local -a selected=()
    local i
    for ((i=0; i<count; i++)); do selected+=("1"); done

    local saved_tty; saved_tty="$(stty -g </dev/tty 2>/dev/null)"
    printf '\n%s\n' "$prompt" >/dev/tty
    printf '  Use ↑↓ to move, Space to toggle, Enter to confirm\n\n' >/dev/tty

    for ((i=0; i<count; i++)); do
        local marker="◉"; [[ "${selected[$i]}" != "1" ]] && marker="○"
        if ((i == cur)); then
            printf '  \033[36m❯ %s %s\033[0m\n' "$marker" "${options[$i]}" >/dev/tty
        else
            printf '    %s %s\n' "$marker" "${options[$i]}" >/dev/tty
        fi
    done

    stty -echo -icanon </dev/tty 2>/dev/null
    trap "stty '${saved_tty}' </dev/tty 2>/dev/null || true; trap - INT TERM EXIT; exit 130" INT TERM
    trap "stty '${saved_tty}' </dev/tty 2>/dev/null || true; trap - INT TERM EXIT" EXIT
    while true; do
        local key
        IFS= read -rsn1 -t 120 key </dev/tty 2>/dev/null || break
        local need_redraw=false
        if [[ "$key" == $'\x1b' ]]; then
            read -rsn2 -t 0.1 key </dev/tty 2>/dev/null || true
            case "$key" in
                '[A') ((cur > 0)) && ((cur--)) || true; need_redraw=true ;;
                '[B') ((cur < count-1)) && ((cur++)) || true; need_redraw=true ;;
            esac
        elif [[ "$key" == ' ' ]]; then
            if [[ "${selected[$cur]}" == "1" ]]; then selected[$cur]="0"; else selected[$cur]="1"; fi
            need_redraw=true
        elif [[ "$key" == '' ]]; then
            break
        fi
        [[ "$need_redraw" == true ]] || continue
        printf '\033[%dA' "$count" >/dev/tty
        for ((i=0; i<count; i++)); do
            local marker="◉"; [[ "${selected[$i]}" != "1" ]] && marker="○"
            printf '\r\033[K' >/dev/tty
            if ((i == cur)); then
                printf '  \033[36m❯ %s %s\033[0m\n' "$marker" "${options[$i]}" >/dev/tty
            else
                printf '    %s %s\n' "$marker" "${options[$i]}" >/dev/tty
            fi
        done
    done
    stty "$saved_tty" </dev/tty 2>/dev/null || true
    trap - INT TERM EXIT

    local result=""
    for ((i=0; i<count; i++)); do
        if [[ "${selected[$i]}" == "1" ]]; then
            [[ -n "$result" ]] && result+=","
            result+="$i"
        fi
    done
    printf -v "$result_var" '%s' "$result"
}
env_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\''/g")"; }
write_env_key() {
    local key="$1" val="$2" tmp; tmp="$(mktemp)"
    grep -v "^${key}=" .env > "$tmp" 2>/dev/null || true
    printf "%s=%s\n" "$key" "$(env_quote "$val")" >> "$tmp"
    mv "$tmp" .env
}
delete_env_key() {
    local key="$1" tmp; tmp="$(mktemp)"
    grep -v "^${key}=" .env > "$tmp" 2>/dev/null || true
    mv "$tmp" .env
}
env_has_key() { grep -q "^${1}=" .env 2>/dev/null; }
read_env_key() {
    local key="$1" line value
    line="$(grep "^${key}=" .env 2>/dev/null | tail -n 1)" || return 1
    value="${line#*=}"
    if [[ "$value" =~ ^\'(.*)\'$ ]]; then
        printf '%s\n' "${BASH_REMATCH[1]}"
        return 0
    fi
    if [[ "$value" =~ ^\"(.*)\"$ ]]; then
        printf '%s\n' "${BASH_REMATCH[1]}"
        return 0
    fi
    printf '%s\n' "$value"
}
pnpm_install_with_fallback() {
    pnpm install --frozen-lockfile && return 0; [[ -n "$NPM_REGISTRY" ]] && return 1
    warn "pnpm install failed — retrying with npmmirror"; use_registry "https://registry.npmmirror.com"
    pnpm install --frozen-lockfile
}
build_step() { local label="$1"; shift; info "  Building $label..."
    "$@" || { fail "$label build failed in $PROJECT_DIR"; exit 1; }; ok "$label done"; }
resolve_project_dir_from() {
    local script_source="$1" script_dir="" project_dir=""
    [[ -n "$script_source" ]] || return 1
    script_dir="$(cd "$(dirname "$script_source")" && pwd)"
    project_dir="$(cd "$script_dir/.." && pwd)"
    [[ -f "$project_dir/package.json" && -d "$project_dir/packages/api" ]] || return 1
    printf '%s\n' "$project_dir"
}
resolve_project_dir() {
    local script_source="${BASH_SOURCE[0]:-}"
    [[ -n "$script_source" ]] || {
        fail "This helper must run from a cat-cafe source tree. Clone or download first, then run: bash scripts/install.sh"
        exit 1
    }
    PROJECT_DIR="$(resolve_project_dir_from "$script_source")" || {
        fail "Could not locate the cat-cafe source tree from $script_source. Clone or download first, then run: bash scripts/install.sh"
        exit 1
    }
    PROJECT_HAS_GIT_METADATA=false
    [[ -e "$PROJECT_DIR/.git" ]] && PROJECT_HAS_GIT_METADATA=true
    if [[ "$PROJECT_HAS_GIT_METADATA" != true ]]; then
        warn "No .git directory — git-dependent features (diff view, worktree management) will be unavailable"
    fi
}
default_project_allowed_roots() {
    printf '%s\n' "$HOME" '/tmp' '/private/tmp' '/workspace'
    [[ "$(uname -s)" == "Darwin" ]] && printf '%s\n' '/Volumes'
}
project_allowed_roots() {
    local custom="${PROJECT_ALLOWED_ROOTS:-}"
    if [[ -n "$custom" ]]; then
        [[ "${PROJECT_ALLOWED_ROOTS_APPEND:-}" == "true" ]] && default_project_allowed_roots
        local IFS=':' root
        local -a roots=()
        read -r -a roots <<< "$custom"
        for root in "${roots[@]}"; do
            [[ -n "$root" ]] && printf '%s\n' "$root"
        done
    else
        default_project_allowed_roots
    fi
}
normalize_path_lexically() {
    local path="$1" segment="" absolute=""
    local -a segments=() normalized=()
    [[ -n "$path" ]] || return 1

    if [[ "$path" == /* ]]; then
        absolute="$path"
    else
        absolute="$PWD/$path"
    fi
    while [[ "$absolute" == *'//'* ]]; do
        absolute="${absolute//\/\//\/}"
    done

    IFS='/' read -r -a segments <<< "$absolute"
    for segment in "${segments[@]}"; do
        case "$segment" in
            ''|'.') ;;
            '..')
                if ((${#normalized[@]} > 0)); then
                    unset "normalized[$((${#normalized[@]} - 1))]"
                fi
                ;;
            *) normalized+=("$segment") ;;
        esac
    done

    if ((${#normalized[@]} == 0)); then
        printf '/\n'
        return 0
    fi

    local output=""
    for segment in "${normalized[@]}"; do
        output+="/$segment"
    done
    printf '%s\n' "$output"
}
normalize_path_for_compare() {
    local path="$1"
    [[ -n "$path" ]] || return 1
    normalize_path_lexically "$path"
}
path_is_under_root() {
    local root="$1" candidate="$2"
    [[ -n "$root" && -n "$candidate" ]] || return 1
    root="$(normalize_path_for_compare "$root")" || return 1
    candidate="$(normalize_path_for_compare "$candidate")" || return 1
    if [[ "$root" == "/" ]]; then
        [[ "$candidate" == /* ]]; return
    fi
    root="${root%/}"
    candidate="${candidate%/}"
    [[ "$candidate" == "$root" || "$candidate" == "$root/"* ]]
}
candidate_root_is_allowed() {
    local candidate="$1" root=""
    while IFS= read -r root; do
        [[ -n "$root" ]] || continue
        path_is_under_root "$root" "$candidate" && return 0
    done < <(project_allowed_roots)
    return 1
}
provider_profiles_candidate_root_is_allowed() {
    local candidate="$1"
    candidate_root_is_allowed "$candidate"
}
resolve_provider_profiles_dir() {
    local git_entry="$PROJECT_DIR/.git"
    if [[ ! -e "$git_entry" ]]; then
        printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return
    fi
    if [[ -d "$git_entry" ]]; then
        printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return
    fi
    if [[ -f "$git_entry" ]] && command -v git &>/dev/null; then
        local gitdir="" worktrees_dir="" common_git_dir="" candidate=""
        gitdir="$(git -C "$PROJECT_DIR" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
        [[ -n "$gitdir" ]] || { printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return; }
        worktrees_dir="$(dirname "$gitdir" 2>/dev/null)"
        [[ "$(basename "$worktrees_dir" 2>/dev/null)" == "worktrees" ]] || { printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return; }
        common_git_dir="$(dirname "$worktrees_dir" 2>/dev/null)"
        [[ "$(basename "$common_git_dir" 2>/dev/null)" == ".git" ]] || { printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return; }

        local backref_file="$gitdir/gitdir" backref_resolved=""
        if [[ ! -f "$backref_file" ]]; then
            printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return
        fi
        backref_resolved="$(cd "$gitdir" 2>/dev/null && realpath "$(head -1 "$backref_file" 2>/dev/null)" 2>/dev/null)" || { printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return; }
        local git_entry_resolved=""
        git_entry_resolved="$(realpath "$git_entry" 2>/dev/null)" || { printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return; }
        [[ "$backref_resolved" == "$git_entry_resolved" ]] || { printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return; }

        local commondir_file="$gitdir/commondir" commondir_value="" commondir_resolved=""
        if [[ ! -f "$commondir_file" ]]; then
            printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return
        fi
        commondir_value="$(head -1 "$commondir_file" 2>/dev/null)" || { printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return; }
        [[ -n "$commondir_value" ]] || { printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return; }
        commondir_resolved="$(cd "$gitdir" 2>/dev/null && realpath "$commondir_value" 2>/dev/null)" || { printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return; }
        local common_git_dir_resolved=""
        common_git_dir_resolved="$(realpath "$common_git_dir" 2>/dev/null)" || { printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return; }
        [[ "$commondir_resolved" == "$common_git_dir_resolved" ]] || { printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return; }

        candidate="$(dirname "$common_git_dir_resolved")"
        candidate="$(normalize_path_for_compare "$candidate" 2>/dev/null)" || { printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return; }
        provider_profiles_candidate_root_is_allowed "$candidate" || { printf '%s/.cat-cafe\n' "$PROJECT_DIR"; return; }
        printf '%s/.cat-cafe\n' "$candidate"; return
    fi
    printf '%s/.cat-cafe\n' "$PROJECT_DIR"
}
docker_detected() {
    [[ -f /.dockerenv ]] || grep -qsw docker /proc/1/cgroup 2>/dev/null
}
ENV_CREATED=false
maybe_write_docker_api_host() {
    docker_detected || return 0
    if [[ "$ENV_CREATED" == true ]]; then
        write_env_key "API_SERVER_HOST" "0.0.0.0"
        ok "Docker detected — API_SERVER_HOST=0.0.0.0"
    elif env_has_key "API_SERVER_HOST"; then
        ok "Docker detected — preserving existing API_SERVER_HOST"
    else
        write_env_key "API_SERVER_HOST" "0.0.0.0"
        ok "Docker detected — added API_SERVER_HOST=0.0.0.0 (was missing from existing .env)"
    fi
}

default_frontend_url() {
    local frontend_port=""
    if [[ -f .env ]]; then
        frontend_port="$(read_env_key FRONTEND_PORT || true)"
    fi
    frontend_port="${frontend_port:-${FRONTEND_PORT:-3003}}"
    printf 'http://localhost:%s\n' "$frontend_port"
}

ENV_KEYS=(); ENV_VALUES=(); ENV_DELETE_KEYS=()
reset_env_changes() { ENV_KEYS=(); ENV_VALUES=(); ENV_DELETE_KEYS=(); }
collect_env() { ENV_KEYS+=("$1"); ENV_VALUES+=("$2"); }
clear_env() { ENV_DELETE_KEYS+=("$1"); }
# #340 P6: Dead .env auth wrappers removed — all auth now uses
# install-auth-config.mjs client-auth set → accounts.json + credentials.json


PLATFORM="$(uname -s)"

if [[ "$SOURCE_ONLY" == true ]]; then
    return 0 2>/dev/null || exit 0
fi

# ── [1/9] Environment detection ────────────────────────────
step "[1/9] Detecting environment / 环境检测..."
# macOS: Homebrew refuses to run as root — fail early with a clear message
# so users don't sudo the whole script after seeing Homebrew's sudo prompt.
if [[ "$PLATFORM" == "Darwin" && $EUID -eq 0 ]]; then
    fail "macOS 下不要用 sudo 运行 install.sh，直接 bash scripts/install.sh 即可"
    fail "Don't run install.sh as root on macOS — just: bash scripts/install.sh"
    exit 1
fi
DISTRO_FAMILY=""; DISTRO_NAME=""; PKG_INSTALL=""; PKG_UPDATE=""
case "$PLATFORM" in
    Darwin)
        DISTRO_FAMILY="darwin"; DISTRO_NAME="macOS"
        # Detect existing Homebrew even when PATH is not initialized (non-login shells).
        # Pick the arch-native prefix first to avoid ARM/x86 conflicts on dual-Homebrew machines.
        if [[ "$(uname -m)" == "arm64" ]]; then
            _brew_candidates=(/opt/homebrew/bin/brew /usr/local/bin/brew)
        else
            _brew_candidates=(/usr/local/bin/brew /opt/homebrew/bin/brew)
        fi
        _brew_recovered=false
        if ! command -v brew &>/dev/null; then
            for _brew in "${_brew_candidates[@]}"; do
                if [[ -x "$_brew" ]]; then
                    eval "$("$_brew" shellenv)"
                    _brew_recovered=true
                    break
                fi
            done
        fi
        if ! command -v brew &>/dev/null; then
            info "  Homebrew not found — installing..."
            info "  (Homebrew may ask for your macOS password — that's normal, don't re-run with sudo)"
            NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL --connect-timeout 15 --max-time 60 https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/null
            for _brew in "${_brew_candidates[@]}"; do
                if [[ -x "$_brew" ]]; then
                    eval "$("$_brew" shellenv)"
                    break
                fi
            done
            command -v brew &>/dev/null || { fail "Homebrew install failed. Install manually: https://brew.sh"; exit 1; }
            _brew_recovered=true
        fi
        # Persist brew shellenv to login profiles so new terminals find brew, node, etc.
        if [[ "$_brew_recovered" == true ]]; then
            _shellenv_line="eval \"\$($(command -v brew) shellenv)\"  # Homebrew (added by Cat Cafe)"
            for _prof in $(darwin_login_profiles); do
                append_to_profile "$_shellenv_line" "$_prof"
            done
            unset _shellenv_line
        fi
        unset _brew_candidates _brew _brew_recovered
        PKG_INSTALL="brew install"; PKG_UPDATE="brew update"
        ;;
    Linux)
        if [[ -f /etc/os-release ]]; then
            . /etc/os-release; DISTRO_NAME="${ID:-unknown}"
            case "$DISTRO_NAME" in
                ubuntu|debian|linuxmint|pop) DISTRO_FAMILY="debian"; PKG_UPDATE="apt-get update -qq"
                    PKG_INSTALL="apt-get install -y"; export DEBIAN_FRONTEND=noninteractive ;;
                centos|rhel|rocky|almalinux|fedora) DISTRO_FAMILY="rhel"; PKG_UPDATE="true"
                    if command -v dnf &>/dev/null; then PKG_INSTALL="dnf install -y"; else PKG_INSTALL="yum install -y"; fi ;;
            esac
        fi
        ;;
    *) fail "Unsupported platform: $PLATFORM. Need: macOS or Linux"; exit 1 ;;
esac

if [[ -z "$DISTRO_FAMILY" ]]; then fail "Unsupported: ${DISTRO_NAME:-unknown}. Need: macOS, Ubuntu/Debian, or CentOS/RHEL/Fedora"; exit 1; fi
ok "OS: ${PRETTY_NAME:-$DISTRO_NAME} ($DISTRO_FAMILY)"

SUDO=""
if [[ "$DISTRO_FAMILY" != "darwin" && $EUID -ne 0 ]]; then
    command -v sudo &>/dev/null || { fail "Not root and sudo not found / 请以 root 运行或安装 sudo"; exit 1; }
    SUDO="sudo"
fi
# On Darwin, /usr/local/bin often requires sudo which we skip.
# Use ~/.local/bin for user-local binaries.
if [[ "$DISTRO_FAMILY" == "darwin" ]]; then
    USER_BIN_DIR="$HOME/.local/bin"
    mkdir -p "$USER_BIN_DIR"
    case ":$PATH:" in
        *":$USER_BIN_DIR:"*) ;;
        *) export PATH="$USER_BIN_DIR:$PATH" ;;
    esac
    # Persist ~/.local/bin to login profiles unconditionally so that any later
    # persist_user_bin symlinks survive in new terminals.
    for _prof in $(darwin_login_profiles); do
        append_to_profile 'export PATH="$HOME/.local/bin:$PATH"  # Cat Cafe user binaries' "$_prof"
    done
    unset _prof
fi

resolve_project_dir
ok "Source tree: $PROJECT_DIR"

# Preflight network check — fail early before installer-managed downloads.
if [[ "$SKIP_PREFLIGHT" != true && -f "$PROJECT_DIR/scripts/preflight.sh" ]]; then
    preflight_args=()
    [[ -n "$NPM_REGISTRY" ]] && preflight_args+=("--registry=$NPM_REGISTRY")
    preflight_args+=("--timeout=3")
    if ! bash "$PROJECT_DIR/scripts/preflight.sh" "${preflight_args[@]}"; then
        warn "Preflight detected unreachable endpoints (see above)."
        warn "Install may fail. Fix the issues above or use --skip-preflight to bypass."
        if [[ "$HAS_TTY" == true ]]; then
            tty_read "  Continue anyway? [y/N] " _pf_continue
            [[ "$_pf_continue" =~ ^[Yy] ]] || { fail "Aborted by user"; exit 1; }
        else
            fail "Non-interactive mode — aborting. Use --skip-preflight to force."
            exit 1
        fi
    fi
fi

# ── [2/9] Install system dependencies ──────────────────────
step "[2/9] Checking system dependencies / 检测系统依赖..."
NEED_PKGS=()
for cmd in git curl; do
    if command -v "$cmd" &>/dev/null; then ok "$cmd found"
    else warn "$cmd not found — will install"
        NEED_PKGS+=("$cmd")
    fi
done
if [[ "$DISTRO_FAMILY" == "darwin" ]]; then
    # Xcode CLT provides git, make, clang — install if missing
    if ! xcode-select -p &>/dev/null; then
        warn "Xcode Command Line Tools not found — installing..."
        xcode-select --install 2>/dev/null || true
        # Wait for the installer to finish (user-interactive on macOS).
        # Use a long, non-fatal timeout: CLT install can legitimately take
        # longer on slow networks or first-time setups.
        _xcode_wait=0
        _xcode_timeout=1800
        until xcode-select -p &>/dev/null; do
            sleep 5; _xcode_wait=$((_xcode_wait + 5))
            if [[ $_xcode_wait -ge $_xcode_timeout ]]; then
                warn "Xcode CLT not ready after 30 min. Continuing setup; run again after CLT finishes if build tools are missing."
                break
            fi
        done
        if xcode-select -p &>/dev/null; then
            ok "Xcode Command Line Tools installed"
        else
            warn "Xcode Command Line Tools still not ready. You may need: xcode-select --install"
        fi
        unset _xcode_wait _xcode_timeout
    else ok "Xcode Command Line Tools present"
    fi
else
    if ! command -v gcc &>/dev/null || ! command -v g++ &>/dev/null || ! command -v make &>/dev/null; then
        warn "C/C++ build toolchain incomplete — will install"
        case "$DISTRO_FAMILY" in debian) NEED_PKGS+=(build-essential) ;; rhel) NEED_PKGS+=(gcc gcc-c++ make) ;; esac
    fi
    # Ensure HTTPS/GPG deps exist (needed for NodeSource)
    case "$DISTRO_FAMILY" in
        debian) for p in ca-certificates gnupg; do dpkg -s "$p" &>/dev/null || NEED_PKGS+=("$p"); done ;;
        rhel) rpm -q ca-certificates &>/dev/null || NEED_PKGS+=(ca-certificates); rpm -q gnupg2 &>/dev/null || NEED_PKGS+=(gnupg2) ;;
    esac
fi
if [[ ${#NEED_PKGS[@]} -gt 0 ]]; then
    info "  Installing: ${NEED_PKGS[*]}..."
    $SUDO $PKG_UPDATE 2>/dev/null || true
    $SUDO $PKG_INSTALL "${NEED_PKGS[@]}"; ok "System dependencies installed"
else ok "All system dependencies present"
fi

# F088 Phase J2: pandoc for document generation (MD → PDF/DOCX)
if command -v pandoc &>/dev/null; then
    ok "pandoc found ($(pandoc --version | head -1))"
else
    info "Installing pandoc (document generation)..."
    case "$DISTRO_FAMILY" in
        darwin) brew install pandoc && ok "pandoc installed" || warn "pandoc install failed — document generation will fall back to .md" ;;
        debian) $SUDO $PKG_INSTALL pandoc && ok "pandoc installed" || warn "pandoc install failed — document generation will fall back to .md" ;;
        rhel) $SUDO $PKG_INSTALL pandoc && ok "pandoc installed" || warn "pandoc install failed — document generation will fall back to .md" ;;
        *) warn "pandoc not installed — document generation will fall back to .md" ;;
    esac
fi

# ── [3/9] Install Node.js 20+ ────────────────────────────
step "[3/9] Checking Node.js / 检测 Node.js..."
node_needs_install() {
    command -v node &>/dev/null || return 0
    local v; v=$(node -v | sed 's/v//' | cut -d. -f1)
    [[ "$v" -lt 20 ]] && { warn "Node.js $(node -v) < v20 — upgrading"; return 0; }
    return 1
}
install_node_fnm() {
    USED_FNM=true; warn "NodeSource unreachable — trying fnm..."
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell 2>/dev/null \
        || curl -fsSL https://ghp.ci/https://raw.githubusercontent.com/Schniz/fnm/master/.ci/install.sh | bash -s -- --skip-shell 2>/dev/null || return 1
    export PATH="$HOME/.local/share/fnm:$HOME/.fnm:$PATH"
    eval "$(fnm env --shell bash 2>/dev/null)" 2>/dev/null || true
    fnm install 20 && fnm use 20 && fnm default 20 || return 1
    for bin in node npm npx corepack; do persist_user_bin "$bin"; done
    command -v node &>/dev/null || return 1
    [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -ge 20 ]] || return 1
}
if node_needs_install; then
    NODE_OK=false
    case "$DISTRO_FAMILY" in
        darwin)
            # Prefer fnm for version management; fall back to Homebrew
            install_node_fnm && NODE_OK=true
            if [[ "$NODE_OK" == false ]]; then
                brew install node@20 2>/dev/null || true
                # node@20 is keg-only — Homebrew does not link it into PATH by default.
                # Add the keg bin to PATH for this session AND persist to shell profile.
                _keg_prefix="$(brew --prefix node@20 2>/dev/null || true)"
                _keg_bin="${_keg_prefix:+$_keg_prefix/bin}"
                if [[ -n "$_keg_bin" && -d "$_keg_bin" ]]; then
                    export PATH="$_keg_bin:$PATH"
                    _keg_line="export PATH=\"$_keg_bin:\$PATH\"  # Homebrew node@20 keg"
                    for _prof in $(darwin_login_profiles); do
                        append_to_profile "$_keg_line" "$_prof"
                    done
                    ok "Node keg PATH persisted to login profiles"
                fi
                unset _keg_prefix _keg_bin _keg_line _prof
                node_needs_install || NODE_OK=true
            fi
            ;;
        debian)
            $SUDO mkdir -p /etc/apt/keyrings
            if timeout 15 curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
                | $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null; then
                echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
                    | $SUDO tee /etc/apt/sources.list.d/nodesource.list >/dev/null
                $SUDO apt-get update -qq && $SUDO apt-get install -y -qq nodejs && NODE_OK=true
            fi
            [[ "$NODE_OK" == false ]] && install_node_fnm && NODE_OK=true
            ;;
        rhel)
            if timeout 15 curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash - 2>/dev/null; then
                $SUDO $PKG_INSTALL nodejs && NODE_OK=true
            fi
            [[ "$NODE_OK" == false ]] && install_node_fnm && NODE_OK=true
            ;;
    esac
    node_needs_install && NODE_OK=false
    [[ "$NODE_OK" == false ]] && { fail "Could not install Node.js 20. Install manually: https://nodejs.org"; exit 1; }
    # Persist PATH additions to login profiles (zsh + bash) for new terminals.
    if [[ "$DISTRO_FAMILY" == "darwin" ]]; then
        for _prof in $(darwin_login_profiles); do
            append_to_profile 'export PATH="$HOME/.local/bin:$PATH"  # Cat Cafe user binaries' "$_prof"
            if [[ "$USED_FNM" == true ]]; then
                _fnm_shell="zsh"
                [[ "$_prof" == *bash* || "$_prof" == *profile ]] && _fnm_shell="bash"
                append_to_profile "eval \"\$(fnm env --shell $_fnm_shell 2>/dev/null)\" 2>/dev/null || true  # fnm" "$_prof"
            fi
        done
        unset _prof _fnm_shell
    fi
    ok "Node.js $(node -v) installed"
else
    ok "Node.js $(node -v) already installed (>= 20)"
fi

# ── [4/9] Install pnpm + Redis ─────────────────────────────
step "[4/9] Checking pnpm & Redis / 检测 pnpm 和 Redis..."
if ! command -v pnpm &>/dev/null; then
    warn "pnpm not found — installing"
    if command -v corepack &>/dev/null; then
        $SUDO corepack enable 2>/dev/null || true
        COREPACK_ENABLE_DOWNLOAD_PROMPT=0 timeout 30 corepack prepare pnpm@latest --activate 2>/dev/null || true
    fi
    if ! command -v pnpm &>/dev/null; then
        npm_global_install pnpm || { warn "npm failed — trying npmmirror"; $SUDO npm install -g pnpm --registry https://registry.npmmirror.com; }
    fi
    persist_user_bin pnpm
    # Ensure ~/.local/bin is on PATH for new terminals (may not have been written
    # if Node was already present and the Node install step was skipped).
    if [[ "$DISTRO_FAMILY" == "darwin" ]]; then
        for _prof in $(darwin_login_profiles); do
            append_to_profile 'export PATH="$HOME/.local/bin:$PATH"  # Cat Cafe user binaries' "$_prof"
        done
        unset _prof
    fi
    ok "pnpm $(pnpm -v) installed"
else ok "pnpm $(pnpm -v) already installed"
fi
# Redis: detect → already running / --memory skip / ask user
install_redis_local() {
    case "$DISTRO_FAMILY" in
        darwin)
            if ! brew install redis 2>/dev/null; then
                fail "brew install redis failed"; return 1
            fi
            # Start is best-effort — install is what matters
            if ! brew services start redis 2>/dev/null; then
                warn "brew services start redis failed — you can start it later with: brew services start redis"
            fi
            ;;
        debian) $SUDO $PKG_INSTALL redis-server ;;
        rhel) $SUDO $PKG_INSTALL redis ;;
    esac
    if [[ "$DISTRO_FAMILY" != "darwin" ]]; then
        $SUDO systemctl enable redis-server 2>/dev/null || $SUDO systemctl enable redis 2>/dev/null || true
        $SUDO systemctl start redis-server 2>/dev/null || $SUDO systemctl start redis 2>/dev/null || true
    fi
    ok "Redis installed"
}
start_redis_if_stopped() {
    if [[ "$DISTRO_FAMILY" == "darwin" ]]; then
        brew services start redis 2>/dev/null || true
    else
        $SUDO systemctl start redis-server 2>/dev/null || $SUDO systemctl start redis 2>/dev/null || true
    fi
}
if [[ "$MEMORY_MODE" == true ]]; then warn "Memory mode (--memory) — skipping Redis"
elif command -v redis-server &>/dev/null; then ok "Redis already installed"
    redis-cli ping &>/dev/null 2>&1 || { warn "Redis not running — starting..."; start_redis_if_stopped; sleep 1; redis-cli ping &>/dev/null 2>&1 || warn "Redis started but not responding to ping"; }
else
    warn "Redis not found — installing locally"
    install_redis_local
fi

# ── [5/9] Build checked-out project ────────────────────────
step "[5/9] Preparing current repo / 准备当前仓库..."
cd "$PROJECT_DIR"
ok "Using project: $PROJECT_DIR"
pnpm_install_with_fallback || { fail "pnpm install failed in $PROJECT_DIR"; exit 1; }
ok "Packages installed"
build_step "shared" pnpm --dir packages/shared run build
build_step "mcp-server" pnpm --dir packages/mcp-server run build
build_step "api" pnpm --dir packages/api run build
build_step "web" env NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=3072}" pnpm --dir packages/web run build
ok "Build complete"
# Skills: per-skill user-level symlinks (ADR-009)
SKILLS_SOURCE="$PROJECT_DIR/cat-cafe-skills"
if [[ -d "$SKILLS_SOURCE" ]]; then
    for tdir in "$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.gemini/skills" "$HOME/.kimi/skills"; do
        mkdir -p "$tdir"
        for sd in "$SKILLS_SOURCE"/*/; do
            [[ -d "$sd" ]] || continue; sn=$(basename "$sd"); [[ "$sn" == "refs" ]] && continue; ln -sfn "$sd" "$tdir/$sn"
        done
    done; ok "Skills linked"
else fail "cat-cafe-skills/ not found"; exit 1; fi

# ── [6/9] Install AI agent CLI tools ─────────────────────
step "[6/9] Installing AI CLI tools / 安装 AI 命令行工具..."
info "  Cat Cafe spawns CLI subprocesses — these are required"
install_npm_cli() {
    local name="$1" cmd="$2" pkg="$3"
    info "  Installing $name ($pkg)..."
    npm_global_install "$pkg" 2>&1
    # npm global bin may not be on PATH (custom prefix, fnm, etc.)
    local _npm_bin; _npm_bin="$(npm config get prefix 2>/dev/null)/bin"
    if [[ -d "$_npm_bin" ]]; then
        case ":$PATH:" in *":$_npm_bin:"*) ;; *) export PATH="$_npm_bin:$PATH" ;; esac
    fi
    hash -r 2>/dev/null || true
    command -v "$cmd" &>/dev/null || { fail "$name install failed. Try: npm install -g $pkg"; exit 1; }
    persist_user_bin "$cmd"
    ok "$name installed"
}
install_brew_cask() {
    local name="$1" cmd="$2" cask="$3"
    info "  Installing $name via Homebrew cask ($cask)..."
    brew install --cask "$cask" 2>&1
    hash -r 2>/dev/null || true
    command -v "$cmd" &>/dev/null || { fail "$name install failed. Try: brew install --cask $cask"; exit 1; }; ok "$name installed"
}
install_kimi_cli() {
    info "  Installing Kimi CLI..."
    if command -v uv &>/dev/null; then
        uv tool install --python 3.13 kimi-cli >/dev/null 2>&1 || uv tool upgrade kimi-cli >/dev/null 2>&1 || true
    elif command -v pipx &>/dev/null; then
        pipx install kimi-cli >/dev/null 2>&1 || pipx upgrade kimi-cli >/dev/null 2>&1 || true
    elif command -v python3 &>/dev/null; then
        python3 -m pip install --user --upgrade kimi-cli >/dev/null 2>&1 || true
    else
        fail "Kimi install failed. Need uv, pipx, or python3 to install kimi-cli"
        exit 1
    fi
    export PATH="$HOME/.local/bin:$PATH"; hash -r 2>/dev/null || true
    command -v kimi &>/dev/null || { fail "Kimi install failed. Try: uv tool install --python 3.13 kimi-cli"; exit 1; }; ok "Kimi CLI installed"
}
install_claude_cli() {
    info "  Installing Claude Code..."
    if [[ "$DISTRO_FAMILY" == "darwin" ]]; then
        # macOS: brew cask — "claude-code" is the CLI, "claude" is the desktop app
        # claude.ai/install.sh is region-blocked in some countries
        install_brew_cask "Claude Code" "claude" "claude-code"
    else
        # Linux: use npm — Homebrew is not available on most Linux servers
        install_npm_cli "Claude Code" "claude" "@anthropic-ai/claude-code"
    fi
}
install_codex_cli() {
    info "  Installing Codex CLI..."
    if [[ "$DISTRO_FAMILY" == "darwin" ]]; then
        install_brew_cask "Codex CLI" "codex" "codex"
    else
        install_npm_cli "Codex CLI" "codex" "@openai/codex"
    fi
}
# Detect missing CLIs
MISSING_AGENTS=()
command -v claude &>/dev/null && ok "Claude Code already installed" || MISSING_AGENTS+=("claude")
command -v codex &>/dev/null && ok "Codex CLI already installed"  || MISSING_AGENTS+=("codex")
command -v gemini &>/dev/null && ok "Gemini CLI already installed" || MISSING_AGENTS+=("gemini")
command -v kimi &>/dev/null && ok "Kimi CLI already installed"   || MISSING_AGENTS+=("kimi")

if [[ ${#MISSING_AGENTS[@]} -gt 0 ]]; then
    INSTALL_AGENTS=("${MISSING_AGENTS[@]}")  # default: install all missing
    if [[ "$HAS_TTY" == true ]]; then
        AGENT_SEL_INDICES=""
        tty_multiselect AGENT_SEL_INDICES \
            "  Select agents to install / 选择要安装的 Agent CLI：" \
            "${MISSING_AGENTS[@]}"
        if [[ -z "$AGENT_SEL_INDICES" ]]; then
            INSTALL_AGENTS=()
            warn "No agents selected — skipping CLI install"
        else
            INSTALL_AGENTS=()
            IFS=',' read -ra SEL_IDX <<< "$AGENT_SEL_INDICES"
            for idx in "${SEL_IDX[@]}"; do
                INSTALL_AGENTS+=("${MISSING_AGENTS[$idx]}")
            done
        fi
    fi
    for agent in "${INSTALL_AGENTS[@]}"; do
        case "$agent" in
            claude) install_claude_cli ;;
            codex)  install_codex_cli ;;
            gemini) install_npm_cli "Gemini CLI" "gemini" "@google/gemini-cli" ;;
            kimi)   install_kimi_cli ;;
        esac
    done
fi

# ── [7/9] Authentication setup / 认证配置 ─────────────────
step "[7/9] Authentication setup / 认证配置..."
configure_agent_auth() {
    local name="$1" cmd="$2"
    command -v "$cmd" &>/dev/null || return 0

    # Gemini CLI doesn't support custom API endpoints — always use OAuth
    if [[ "$cmd" == "gemini" ]]; then
        node scripts/install-auth-config.mjs client-auth set \
            --project-dir "$PROJECT_DIR" \
            --client "$cmd" \
            --mode oauth
        ok "$name: OAuth mode (Gemini CLI only supports Google official API)"
        return 0
    fi

    local auth_sel
    tty_select auth_sel "  $name ($cmd) — auth mode:" \
        "OAuth / Subscription (recommended / 推荐)" \
        "API Key"
    if [[ "$auth_sel" != "1" ]]; then
        # Do not auto-delete installer API-key profiles here: accounts are global
        # and we cannot prove other projects are not still bound to installer refs.
        node scripts/install-auth-config.mjs client-auth set \
            --project-dir "$PROJECT_DIR" \
            --client "$cmd" \
            --mode oauth
        ok "$name: OAuth mode (login on first use: run '$cmd')"
        return 0
    fi
    local key="" base_url="" model=""
    tty_read_secret "    API Key: " key
    tty_read "    Base URL (Enter = default): " base_url
    tty_read "    Model (Enter = default): " model

    if [[ -n "$key" ]]; then
        # All clients use the same install-auth-config.mjs to create provider profiles
        local install_args=(
            node scripts/install-auth-config.mjs client-auth set
            --project-dir "$PROJECT_DIR"
            --client "$cmd"
            --mode api_key
            --base-url "${base_url:-}"
        )
        [[ -n "$model" ]] && install_args+=(--model "$model")
        _INSTALLER_API_KEY="$key" "${install_args[@]}"
        ok "$name: API key profile created in .cat-cafe/"
    else
        # No key provided — set OAuth mode via unified path
        # Do not auto-delete installer API-key profiles here: accounts are global
        # and we cannot prove other projects are not still bound to installer refs.
        node scripts/install-auth-config.mjs client-auth set \
            --project-dir "$PROJECT_DIR" \
            --client "$cmd" \
            --mode oauth
        warn "$name: no key provided, keeping OAuth"
    fi
}

if [[ "$HAS_TTY" == true ]]; then
    info "  Configure each agent / 逐个配置每只猫的认证方式："
    configure_agent_auth "Claude (布偶猫)" "claude"; configure_agent_auth "Codex (缅因猫)" "codex"
    configure_agent_auth "Gemini (暹罗猫)" "gemini"; configure_agent_auth "Kimi (月之暗面)" "kimi"
else
    info "  Non-interactive — skipping auth. Run each CLI to log in: claude / codex / gemini / kimi"
fi

# ── [8/9] Generate .env with all collected config ─────────
step "[8/9] Generating config / 生成配置..."
if [[ -f .env ]]; then
    warn ".env already exists — not overwriting. To regenerate: cp .env.example .env"
elif [[ -f .env.example ]]; then
    cp .env.example .env; ENV_CREATED=true; ok ".env generated from .env.example"
else fail ".env.example not found in $PROJECT_DIR"; exit 1
fi
# Write collected auth config + Docker detection
# Bash <4.4 treats empty arrays as unbound under set -u; guard with ${arr[@]+"${arr[@]}"}.
for key in ${ENV_DELETE_KEYS[@]+"${ENV_DELETE_KEYS[@]}"}; do delete_env_key "$key"; done
for i in ${ENV_KEYS[@]+"${!ENV_KEYS[@]}"}; do write_env_key "${ENV_KEYS[$i]}" "${ENV_VALUES[$i]}"; done
[[ ${#ENV_KEYS[@]} -gt 0 ]] && ok "Auth config written to .env"
# Auto-detect Docker: only set host default on a freshly generated .env.
maybe_write_docker_api_host
chmod 600 .env 2>/dev/null || true

# ── [9/9] Done ──────────────────────────────────────────────
step "[9/9] Installation complete! / 安装完成！"
echo -e "\n  ${GREEN}══ Cat Cafe is ready! 猫猫咖啡已就绪！══${NC}\n  Project: $PROJECT_DIR"
START_CMD="cd $PROJECT_DIR && pnpm start"; [[ "$MEMORY_MODE" == true ]] && START_CMD+=" --memory"
# The script runs as a subprocess — PATH changes don't propagate to the parent
# shell. On macOS, prefix the banner command with `source ~/.zprofile` so the
# user can copy-paste and have the correct PATH (including ~/.local/bin).
if [[ "$DISTRO_FAMILY" == "darwin" ]]; then
    _profile="${ZDOTDIR:-$HOME}/.zprofile"
    START_CMD="source $_profile && $START_CMD"
    unset _profile
fi
echo -e "  Start: $START_CMD\n  Open:  $(default_frontend_url)\n"
if [[ "$AUTO_START" == true ]]; then
    echo -e "${CYAN}Starting service (--start)...${NC}"; echo ""
    if [[ "$MEMORY_MODE" == true ]]; then exec pnpm start --memory; else exec pnpm start; fi
fi
