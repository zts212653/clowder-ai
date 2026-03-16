#!/usr/bin/env bash
# Clowder AI — Linux Repo-Local Install Helper (F113)
# Usage: bash scripts/install.sh [--start] [--memory] [--registry=URL]
# Supported: Debian/Ubuntu, CentOS/RHEL/Fedora

set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
AUTO_START=false; MEMORY_MODE=false; NPM_REGISTRY=""; SOURCE_ONLY=false
PROJECT_DIR=""; PROJECT_HAS_GIT_METADATA=false
for arg in "$@"; do
    case $arg in
        --start) AUTO_START=true ;; --memory) MEMORY_MODE=true ;;
        --registry=*) NPM_REGISTRY="${arg#*=}" ;;
        --source-only) SOURCE_ONLY=true ;;
    esac
done
# Apply registry if specified (helps in China / behind proxy)
use_registry() {
    local reg="$1"
    export npm_config_registry="$reg" NPM_CONFIG_REGISTRY="$reg" PNPM_CONFIG_REGISTRY="$reg"
    npm config set registry "$reg" 2>/dev/null || true
    command -v pnpm &>/dev/null && pnpm config set registry "$reg" 2>/dev/null || true
}
[[ -n "$NPM_REGISTRY" ]] && use_registry "$NPM_REGISTRY"
npm_global_install() {
    [[ -n "$NPM_REGISTRY" ]] && $SUDO env npm_config_registry="$NPM_REGISTRY" NPM_CONFIG_REGISTRY="$NPM_REGISTRY" npm install -g "$@"
    [[ -z "$NPM_REGISTRY" ]] && $SUDO npm install -g "$@"
}

info() { echo -e "${CYAN}$*${NC}"; }; ok() { echo -e "  ${GREEN}✓${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $*"; }; fail() { echo -e "  ${RED}✗${NC} $*"; }
step() { echo ""; echo -e "${BOLD}$*${NC}"; }
USED_FNM=false
persist_user_bin() {
    local bin="$1" path=""; path="$(command -v "$bin" 2>/dev/null || true)"
    [[ -n "$path" ]] || return 0; $SUDO mkdir -p /usr/local/bin
    $SUDO ln -sfn "$(readlink -f "$path" 2>/dev/null || echo "$path")" "/usr/local/bin/$bin"
}

# TTY-safe read + pnpm install with registry fallback
HAS_TTY=false; [[ -r /dev/tty ]] && tty -s </dev/tty 2>/dev/null && HAS_TTY=true
tty_read() { local prompt="$1" var="$2"; read -rp "$prompt" "$var" </dev/tty 2>/dev/null || printf -v "$var" ''; }
tty_read_secret() { local prompt="$1" var="$2"; read -rsp "$prompt" "$var" </dev/tty 2>/dev/null || printf -v "$var" ''; echo </dev/tty; }
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
        fail "This helper must run from a clowder-ai source tree. Clone or download first, then run: bash scripts/install.sh"
        exit 1
    }
    PROJECT_DIR="$(resolve_project_dir_from "$script_source")" || {
        fail "Could not locate the clowder-ai source tree from $script_source. Clone or download first, then run: bash scripts/install.sh"
        exit 1
    }
    PROJECT_HAS_GIT_METADATA=false
    [[ -e "$PROJECT_DIR/.git" ]] && PROJECT_HAS_GIT_METADATA=true
    if [[ "$PROJECT_HAS_GIT_METADATA" != true ]]; then
        warn "No .git directory — git-dependent features (diff view, worktree management) will be unavailable"
    fi
}

ENV_KEYS=(); ENV_VALUES=(); ENV_DELETE_KEYS=()
reset_env_changes() { ENV_KEYS=(); ENV_VALUES=(); ENV_DELETE_KEYS=(); }
collect_env() { ENV_KEYS+=("$1"); ENV_VALUES+=("$2"); }
clear_env() { ENV_DELETE_KEYS+=("$1"); }
set_codex_oauth_mode() {
    collect_env "CODEX_AUTH_MODE" "oauth"
    clear_env "OPENAI_API_KEY"; clear_env "OPENAI_BASE_URL"; clear_env "CAT_CODEX_MODEL"
}
set_codex_api_key_mode() {
    local key="$1" base_url="$2" model="$3"
    collect_env "CODEX_AUTH_MODE" "api_key"; collect_env "OPENAI_API_KEY" "$key"
    [[ -n "$base_url" ]] && collect_env "OPENAI_BASE_URL" "$base_url" || clear_env "OPENAI_BASE_URL"
    [[ -n "$model" ]] && collect_env "CAT_CODEX_MODEL" "$model" || clear_env "CAT_CODEX_MODEL"
}
set_gemini_oauth_mode() {
    clear_env "GEMINI_API_KEY"; clear_env "CAT_GEMINI_MODEL"
}
set_gemini_api_key_mode() {
    local key="$1" model="$2"
    collect_env "GEMINI_API_KEY" "$key"
    [[ -n "$model" ]] && collect_env "CAT_GEMINI_MODEL" "$model" || clear_env "CAT_GEMINI_MODEL"
}

if [[ "$SOURCE_ONLY" == true ]]; then
    return 0 2>/dev/null || exit 0
fi

# ── [1/9] Environment detection ────────────────────────────
step "[1/9] Detecting environment / 环境检测..."

if [[ "$(uname -s)" != "Linux" ]]; then
    fail "This script is for Linux only. Detected: $(uname -s)"; exit 1
fi

DISTRO_FAMILY=""; DISTRO_NAME=""; PKG_INSTALL=""; PKG_UPDATE=""
if [[ -f /etc/os-release ]]; then
    . /etc/os-release; DISTRO_NAME="${ID:-unknown}"
    case "$DISTRO_NAME" in
        ubuntu|debian|linuxmint|pop) DISTRO_FAMILY="debian"; PKG_UPDATE="apt-get update -qq"
            PKG_INSTALL="apt-get install -y"; export DEBIAN_FRONTEND=noninteractive ;;
        centos|rhel|rocky|almalinux|fedora) DISTRO_FAMILY="rhel"; PKG_UPDATE="true"
            if command -v dnf &>/dev/null; then PKG_INSTALL="dnf install -y"; else PKG_INSTALL="yum install -y"; fi ;;
    esac
fi

if [[ -z "$DISTRO_FAMILY" ]]; then fail "Unsupported: ${DISTRO_NAME:-unknown}. Need: Ubuntu/Debian or CentOS/RHEL/Fedora"; exit 1; fi
ok "OS: ${PRETTY_NAME:-$DISTRO_NAME} ($DISTRO_FAMILY)"

SUDO=""
if [[ $EUID -ne 0 ]]; then
    command -v sudo &>/dev/null || { fail "Not root and sudo not found / 请以 root 运行或安装 sudo"; exit 1; }
    SUDO="sudo"
fi

resolve_project_dir
ok "Source tree: $PROJECT_DIR"

# ── [2/9] Install system dependencies ──────────────────────
step "[2/9] Checking system dependencies / 检测系统依赖..."
NEED_PKGS=()
for cmd in git curl; do
    if command -v "$cmd" &>/dev/null; then ok "$cmd found"
    else warn "$cmd not found — will install"
        NEED_PKGS+=("$cmd")
    fi
done
if ! command -v gcc &>/dev/null || ! command -v g++ &>/dev/null || ! command -v make &>/dev/null; then
    warn "C/C++ build toolchain incomplete — will install"
    case "$DISTRO_FAMILY" in debian) NEED_PKGS+=(build-essential) ;; rhel) NEED_PKGS+=(gcc gcc-c++ make) ;; esac
fi
# Ensure HTTPS/GPG deps exist (needed for NodeSource)
case "$DISTRO_FAMILY" in
    debian) for p in ca-certificates gnupg; do dpkg -s "$p" &>/dev/null || NEED_PKGS+=("$p"); done ;;
    rhel) rpm -q ca-certificates &>/dev/null || NEED_PKGS+=(ca-certificates); rpm -q gnupg2 &>/dev/null || NEED_PKGS+=(gnupg2) ;;
esac
if [[ ${#NEED_PKGS[@]} -gt 0 ]]; then
    info "  Installing: ${NEED_PKGS[*]}..."
    $SUDO $PKG_UPDATE 2>/dev/null || true
    $SUDO $PKG_INSTALL "${NEED_PKGS[@]}"; ok "System dependencies installed"
else ok "All system dependencies present"
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
    [[ "$USED_FNM" == true ]] && persist_user_bin pnpm
    [[ -n "$NPM_REGISTRY" ]] && pnpm config set registry "$NPM_REGISTRY" 2>/dev/null || true
    ok "pnpm $(pnpm -v) installed"
else ok "pnpm $(pnpm -v) already installed"
fi
# Redis: detect → already running / --memory skip / ask user
install_redis_local() {
    case "$DISTRO_FAMILY" in debian) $SUDO $PKG_INSTALL redis-server ;; rhel) $SUDO $PKG_INSTALL redis ;; esac
    $SUDO systemctl enable redis-server 2>/dev/null || $SUDO systemctl enable redis 2>/dev/null || true
    $SUDO systemctl start redis-server 2>/dev/null || $SUDO systemctl start redis 2>/dev/null || true; ok "Redis installed and started"
}
REDIS_EXTERNAL=false
if [[ "$MEMORY_MODE" == true ]]; then warn "Memory mode (--memory) — skipping Redis"
elif command -v redis-server &>/dev/null; then ok "Redis already installed"
    redis-cli ping &>/dev/null 2>&1 || {
        warn "Redis not running — starting..."
        $SUDO systemctl start redis-server 2>/dev/null || $SUDO systemctl start redis 2>/dev/null || true; }
else
    warn "Redis not found"
    if [[ "$HAS_TTY" == true ]]; then
        echo "    1) Install Redis locally (recommended / 推荐)"; echo "    2) Use external Redis URL / 使用外部 Redis"
        tty_read "    Choose [1/2] (default: 1): " REDIS_CHOICE
        if [[ "${REDIS_CHOICE:-1}" == "2" ]]; then
            tty_read "    Redis URL (e.g. redis://user:pass@host:6379): " REDIS_EXT_URL
            if [[ -n "$REDIS_EXT_URL" ]]; then
                ok "External Redis URL saved — will write to .env in step 8"; REDIS_EXTERNAL=true
            else warn "No URL — falling back to local install"; fi
        fi
        [[ "$REDIS_EXTERNAL" == false ]] && install_redis_local
    else install_redis_local
    fi
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
    for tdir in "$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.gemini/skills"; do
        mkdir -p "$tdir"
        for sd in "$SKILLS_SOURCE"/*/; do
            [[ -d "$sd" ]] || continue; sn=$(basename "$sd"); [[ "$sn" == "refs" ]] && continue; ln -sfn "$sd" "$tdir/$sn"
        done
    done; ok "Skills linked"
else fail "cat-cafe-skills/ not found"; exit 1; fi

# ── [6/9] Install AI agent CLI tools ─────────────────────
step "[6/9] Installing AI CLI tools / 安装 AI 命令行工具..."
info "  Clowder spawns CLI subprocesses — these are required"
install_npm_cli() {
    local name="$1" cmd="$2" pkg="$3"; info "  Installing $name ($pkg)..."; npm_global_install "$pkg" 2>&1; hash -r 2>/dev/null || true
    command -v "$cmd" &>/dev/null || { fail "$name install failed. Try: npm install -g $pkg"; exit 1; }; ok "$name installed"
}
install_claude_cli() {
    info "  Installing Claude Code..."; curl -fsSL https://claude.ai/install.sh | bash 2>&1
    export PATH="$HOME/.local/bin:$HOME/.claude/bin:$PATH"; hash -r 2>/dev/null || true
    command -v claude &>/dev/null || { fail "Claude install failed. Try: curl -fsSL https://claude.ai/install.sh | bash"; exit 1; }; ok "Claude Code installed"
}
# Detect missing CLIs
MISSING_AGENTS=()
command -v claude &>/dev/null && ok "Claude Code already installed" || MISSING_AGENTS+=("claude")
command -v codex &>/dev/null && ok "Codex CLI already installed"  || MISSING_AGENTS+=("codex")
command -v gemini &>/dev/null && ok "Gemini CLI already installed" || MISSING_AGENTS+=("gemini")

if [[ ${#MISSING_AGENTS[@]} -gt 0 ]]; then
    INSTALL_AGENTS=("${MISSING_AGENTS[@]}")  # default: install all missing
    if [[ "$HAS_TTY" == true ]]; then
        info "  Missing agents / 缺少的 Agent CLI:"
        for i in "${!MISSING_AGENTS[@]}"; do echo "    $((i+1))) ${MISSING_AGENTS[$i]}"; done
        tty_read "    Install which? (e.g. 1,2,3 / Enter=all / 0=none): " AGENT_SEL
        AGENT_SEL="${AGENT_SEL:-}"  # protect against nounset
        if [[ "$AGENT_SEL" == "0" ]]; then INSTALL_AGENTS=()
        elif [[ -n "$AGENT_SEL" ]]; then
            INSTALL_AGENTS=()
            IFS=',' read -ra SEL_IDX <<< "$AGENT_SEL"
            for idx in "${SEL_IDX[@]}"; do
                [[ "$idx" =~ ^[0-9]+$ ]] || { warn "Ignored non-numeric input: $idx"; continue; }
                idx=$((idx - 1))
                [[ $idx -ge 0 && $idx -lt ${#MISSING_AGENTS[@]} ]] && INSTALL_AGENTS+=("${MISSING_AGENTS[$idx]}")
            done
            if [[ ${#INSTALL_AGENTS[@]} -eq 0 ]]; then
                warn "No valid selection — installing all missing agents"
                INSTALL_AGENTS=("${MISSING_AGENTS[@]}")
            fi
        fi
    fi
    for agent in "${INSTALL_AGENTS[@]}"; do
        case "$agent" in
            claude) install_claude_cli ;;
            codex)  install_npm_cli "Codex CLI" "codex" "@openai/codex" ;;
            gemini) install_npm_cli "Gemini CLI" "gemini" "@google/gemini-cli" ;;
        esac
    done
fi

# ── [7/9] Authentication setup / 认证配置 ─────────────────
step "[7/9] Authentication setup / 认证配置..."
write_claude_profile() {
    local key="$1" base_url="$2" model="$3" pdir="$PROJECT_DIR/.cat-cafe"; mkdir -p "$pdir"
    node - "$pdir" "$key" "${base_url:-https://api.anthropic.com}" "$model" <<'EONODE'
const fs = require('fs'), path = require('path');
const [dir, key, baseUrl, model] = process.argv.slice(2), id = 'installer-managed', now = new Date().toISOString();
const pf = path.join(dir, 'provider-profiles.json'), sf = path.join(dir, 'provider-profiles.secrets.local.json');
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return { version: 1, providers: {} }; } };
const profiles = read(pf), secrets = read(sf), anth = profiles.providers.anthropic ?? { profiles: [] };
const keep = (anth.profiles ?? []).filter((p) => p.id !== id);
keep.push({ id, provider: 'anthropic', name: 'Installer API Key', mode: 'api_key', baseUrl, createdAt: now, updatedAt: now, ...(model ? { modelOverride: model } : {}) });
profiles.providers.anthropic = { ...anth, activeProfileId: id, profiles: keep };
secrets.providers.anthropic = { ...(secrets.providers.anthropic ?? {}), [id]: { apiKey: key } };
fs.writeFileSync(pf, JSON.stringify(profiles)); fs.writeFileSync(sf, JSON.stringify(secrets)); fs.chmodSync(sf, 0o600);
EONODE
}
remove_claude_installer_profile() {
    local pdir="$PROJECT_DIR/.cat-cafe"; [[ -d "$pdir" ]] || return 0
    node - "$pdir" <<'EONODE'
const fs = require('fs'), path = require('path');
const [dir] = process.argv.slice(2), id = 'installer-managed';
const pf = path.join(dir, 'provider-profiles.json'), sf = path.join(dir, 'provider-profiles.secrets.local.json');
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const profiles = read(pf), secrets = read(sf); if (!profiles?.providers?.anthropic) process.exit(0);
const anth = profiles.providers.anthropic, nextProfiles = (anth.profiles ?? []).filter((p) => p.id !== id);
profiles.providers.anthropic = { ...anth, profiles: nextProfiles, ...(anth.activeProfileId === id ? { activeProfileId: nextProfiles[0]?.id ?? '' } : {}) };
if (secrets?.providers?.anthropic?.[id]) delete secrets.providers.anthropic[id];
fs.writeFileSync(pf, JSON.stringify(profiles)); if (secrets) fs.writeFileSync(sf, JSON.stringify(secrets));
EONODE
}
configure_agent_auth() {
    local name="$1" cmd="$2"
    command -v "$cmd" &>/dev/null || return 0
    echo ""; echo -e "  ${BOLD}$name ($cmd):${NC}"
    echo "    1) OAuth / Subscription (recommended / 推荐)"; echo "    2) API Key"
    local choice; tty_read "    Choose [1/2] (default: 1): " choice
    if [[ "${choice:-1}" != "2" ]]; then
        [[ "$cmd" == "claude" ]] && remove_claude_installer_profile
        [[ "$cmd" == "codex" ]] && set_codex_oauth_mode
        [[ "$cmd" == "gemini" ]] && set_gemini_oauth_mode
        ok "$name: OAuth mode (login on first use: run '$cmd')"
        return 0
    fi
    local key="" base_url="" model=""
    tty_read_secret "    API Key: " key
    case "$cmd" in
        claude)
            tty_read "    Base URL (Enter = https://api.anthropic.com): " base_url
            tty_read "    Model (Enter = default): " model
            if [[ -n "$key" ]]; then
                write_claude_profile "$key" "$base_url" "$model"
                ok "$name: API key profile created in .cat-cafe/"
            else warn "$name: no key provided, skipping"; fi
            ;;
        codex)
            tty_read "    Base URL (Enter = default): " base_url
            tty_read "    Model (Enter = default): " model
            if [[ -n "$key" ]]; then
                set_codex_api_key_mode "$key" "$base_url" "$model"
                ok "$name: API key collected (will write to .env)"
            else warn "$name: no key provided, keeping OAuth"; set_codex_oauth_mode; fi
            ;;
        gemini)
            tty_read "    Model (Enter = default): " model
            if [[ -n "$key" ]]; then
                set_gemini_api_key_mode "$key" "$model"
                ok "$name: API key collected (will write to .env)"
            else warn "$name: no key provided, keeping OAuth"; set_gemini_oauth_mode; fi
            ;;
    esac
}

if [[ "$HAS_TTY" == true ]]; then
    info "  Configure each agent / 逐个配置每只猫的认证方式："
    configure_agent_auth "Claude (布偶猫)" "claude"; configure_agent_auth "Codex (缅因猫)" "codex"
    configure_agent_auth "Gemini (暹罗猫)" "gemini"
else
    info "  Non-interactive — skipping auth. Run each CLI to log in: claude / codex / gemini"
fi

# ── [8/9] Generate .env with all collected config ─────────
step "[8/9] Generating config / 生成配置..."
if [[ -f .env ]]; then
    warn ".env already exists — not overwriting. To regenerate: cp .env.example .env"
elif [[ -f .env.example ]]; then
    cp .env.example .env; ok ".env generated from .env.example"
else fail ".env.example not found in $PROJECT_DIR"; exit 1
fi
# Write deferred Redis URL + collected auth config + Docker detection
if [[ "$REDIS_EXTERNAL" == true && -n "${REDIS_EXT_URL:-}" ]]; then
    write_env_key "REDIS_URL" "$REDIS_EXT_URL"
    ok "External Redis URL written to .env"
fi
for key in "${ENV_DELETE_KEYS[@]}"; do delete_env_key "$key"; done
for i in "${!ENV_KEYS[@]}"; do write_env_key "${ENV_KEYS[$i]}" "${ENV_VALUES[$i]}"; done
[[ ${#ENV_KEYS[@]} -gt 0 ]] && ok "Auth config written to .env"
# Auto-detect Docker: bind API to 0.0.0.0 so port mapping works from host
if [[ -f /.dockerenv ]] || grep -qsw docker /proc/1/cgroup 2>/dev/null; then
    write_env_key "API_SERVER_HOST" "0.0.0.0"
    ok "Docker detected — API_SERVER_HOST=0.0.0.0"
fi
chmod 600 .env 2>/dev/null || true

# ── [9/9] Done ──────────────────────────────────────────────
step "[9/9] Installation complete! / 安装完成！"
echo -e "\n  ${GREEN}══ Clowder AI is ready! 猫猫咖啡已就绪！══${NC}\n  Project: $PROJECT_DIR"
START_CMD="cd $PROJECT_DIR && pnpm start"; [[ "$MEMORY_MODE" == true ]] && START_CMD+=" --memory"
echo -e "  Start: $START_CMD\n  Open:  http://localhost:3003\n"
if [[ "$AUTO_START" == true ]]; then
    echo -e "${CYAN}Starting service (--start)...${NC}"; echo ""
    if [[ "$MEMORY_MODE" == true ]]; then exec pnpm start --memory; else exec pnpm start; fi
fi
