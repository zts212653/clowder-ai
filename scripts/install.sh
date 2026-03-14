#!/usr/bin/env bash
# Clowder AI — Linux One-Click Install (F113 Phase A)
# Usage: curl -fsSL https://.../scripts/install.sh | bash
#   or:  ./scripts/install.sh [--start] [--memory] [--dir=/path]
# Supported: Debian/Ubuntu, CentOS/RHEL/Fedora

set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

AUTO_START=false; MEMORY_MODE=false; INSTALL_DIR=""
for arg in "$@"; do
    case $arg in
        --start) AUTO_START=true ;; --memory) MEMORY_MODE=true ;;
        --dir=*) INSTALL_DIR="${arg#*=}" ;;
    esac
done

info()    { echo -e "${CYAN}$*${NC}"; }
ok()      { echo -e "  ${GREEN}✓${NC} $*"; }
warn()    { echo -e "  ${YELLOW}⚠${NC} $*"; }
fail()    { echo -e "  ${RED}✗${NC} $*"; }
step()    { echo ""; echo -e "${BOLD}$*${NC}"; }

# TTY-safe read: works even when stdin is a pipe (curl | bash)
HAS_TTY=false; [[ -r /dev/tty ]] && HAS_TTY=true
tty_read() { local prompt="$1" var="$2"; read -rp "$prompt" "$var" </dev/tty; }

# ── [1/9] Environment detection ────────────────────────────
step "[1/9] Detecting environment / 环境检测..."

if [[ "$(uname -s)" != "Linux" ]]; then
    fail "This script is for Linux only. Detected: $(uname -s)"; exit 1
fi

DISTRO_FAMILY=""; DISTRO_NAME=""; PKG_INSTALL=""; PKG_UPDATE=""
if [[ -f /etc/os-release ]]; then
    . /etc/os-release  # shellcheck source=/dev/null
    DISTRO_NAME="${ID:-unknown}"
    case "$DISTRO_NAME" in
        ubuntu|debian|linuxmint|pop)
            DISTRO_FAMILY="debian"
            PKG_UPDATE="apt-get update -qq"
            PKG_INSTALL="apt-get install -y -qq"
            ;;
        centos|rhel|rocky|almalinux|fedora)
            DISTRO_FAMILY="rhel"; PKG_UPDATE="true"
            if command -v dnf &>/dev/null; then PKG_INSTALL="dnf install -y -q"
            else PKG_INSTALL="yum install -y -q"; fi
            ;;
    esac
fi

if [[ -z "$DISTRO_FAMILY" ]]; then
    fail "Unsupported: ${DISTRO_NAME:-unknown}. Supported: Ubuntu/Debian, CentOS/RHEL/Fedora"; exit 1
fi
ok "OS: ${PRETTY_NAME:-$DISTRO_NAME} ($DISTRO_FAMILY)"

SUDO=""
if [[ $EUID -ne 0 ]]; then
    command -v sudo &>/dev/null || { fail "Not root and sudo not found / 请以 root 运行或安装 sudo"; exit 1; }
    SUDO="sudo"
fi

# ── [2/9] Install system dependencies ──────────────────────
step "[2/9] Installing system dependencies / 安装系统依赖..."

$SUDO $PKG_UPDATE 2>/dev/null || true
case "$DISTRO_FAMILY" in
    debian) $SUDO $PKG_INSTALL git curl ca-certificates gnupg build-essential ;;
    rhel)   $SUDO $PKG_INSTALL git curl ca-certificates gnupg2 gcc gcc-c++ make ;;
esac
ok "System dependencies installed / 系统依赖已安装"

# ── [3/9] Install Node.js 20+ ──────────────────────────────
step "[3/9] Installing Node.js / 安装 Node.js..."

node_needs_install() {
    command -v node &>/dev/null || return 0
    local v; v=$(node -v | sed 's/v//' | cut -d. -f1)
    [[ "$v" -lt 20 ]] && { warn "Node.js $(node -v) < v20 required"; return 0; }
    return 1
}
if node_needs_install; then
    info "  Installing Node.js 20 via NodeSource..."
    case "$DISTRO_FAMILY" in
        debian)
            $SUDO mkdir -p /etc/apt/keyrings
            curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
                | $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
            echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
                | $SUDO tee /etc/apt/sources.list.d/nodesource.list >/dev/null
            $SUDO apt-get update -qq
            $SUDO apt-get install -y -qq nodejs
            ;;
        rhel)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash - 2>/dev/null
            $SUDO $PKG_INSTALL nodejs
            ;;
    esac
    ok "Node.js $(node -v) installed"
else
    ok "Node.js $(node -v) already installed (>= 20)"
fi

# ── [4/9] Install pnpm + Redis ─────────────────────────────
step "[4/9] Installing pnpm & Redis / 安装 pnpm 和 Redis..."

# pnpm: corepack → npm fallback
if ! command -v pnpm &>/dev/null; then
    if command -v corepack &>/dev/null; then
        $SUDO corepack enable 2>/dev/null || true
        corepack prepare pnpm@latest --activate 2>/dev/null || true
    fi
    if ! command -v pnpm &>/dev/null; then
        $SUDO npm install -g pnpm
    fi
    ok "pnpm $(pnpm -v) installed"
else ok "pnpm $(pnpm -v) already installed"
fi

# Redis: --memory → skip; existing → use; else ask user
install_redis_local() {
    case "$DISTRO_FAMILY" in
        debian) $SUDO $PKG_INSTALL redis-server ;; rhel) $SUDO $PKG_INSTALL redis ;;
    esac
    $SUDO systemctl enable redis-server 2>/dev/null || $SUDO systemctl enable redis 2>/dev/null || true
    $SUDO systemctl start redis-server 2>/dev/null || $SUDO systemctl start redis 2>/dev/null || true
    ok "Redis installed and started"
}
REDIS_EXTERNAL=false
if [[ "$MEMORY_MODE" == true ]]; then
    warn "Memory mode — skipping Redis / 内存模式，跳过 Redis"
elif command -v redis-server &>/dev/null; then
    ok "Redis already installed"
    redis-cli ping &>/dev/null 2>&1 || {
        $SUDO systemctl start redis-server 2>/dev/null || $SUDO systemctl start redis 2>/dev/null || true
    }
elif [[ "$HAS_TTY" == true ]]; then
    echo "    1) Install Redis locally (recommended / 推荐)"
    echo "    2) Use external Redis URL / 使用外部 Redis"
    tty_read "    Choose [1/2] (default: 1): " REDIS_CHOICE
    if [[ "${REDIS_CHOICE:-1}" == "2" ]]; then
        tty_read "    Redis URL (e.g. redis://user:pass@host:6379): " REDIS_EXT_URL
        if [[ -n "$REDIS_EXT_URL" ]]; then
            ok "External Redis URL saved — will write to .env after config step"
            REDIS_EXTERNAL=true
        else warn "No URL provided — falling back to local install"; fi
    fi
    [[ "$REDIS_EXTERNAL" == false ]] && install_redis_local
else install_redis_local
fi

# ── [5/9] Clone & build project ────────────────────────────
step "[5/9] Setting up project / 设置项目..."

REPO_URL="https://github.com/zts212653/clowder-ai.git"
IN_REPO=false
if [[ -f "package.json" ]] && grep -q '"name": "cat-cafe"' package.json 2>/dev/null; then
    IN_REPO=true; PROJECT_DIR="$(pwd)"
elif [[ -n "$INSTALL_DIR" ]]; then PROJECT_DIR="$INSTALL_DIR"
else PROJECT_DIR="$HOME/clowder-ai"
fi
if [[ "$IN_REPO" == false ]]; then
    if [[ -d "$PROJECT_DIR/.git" ]]; then
        cd "$PROJECT_DIR"
        git pull --ff-only 2>/dev/null || warn "Could not pull"
    else
        git clone "$REPO_URL" "$PROJECT_DIR" && cd "$PROJECT_DIR"
    fi
else ok "Already in project: $PROJECT_DIR"
fi

pnpm install --frozen-lockfile 2>&1 | tail -3
ok "Packages installed"
pnpm build 2>&1 | tail -5
ok "Build complete"

# Skills: per-skill user-level symlinks (ADR-009)
SKILLS_SOURCE="$PROJECT_DIR/cat-cafe-skills"
if [[ -d "$SKILLS_SOURCE" ]]; then
    for tdir in "$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.gemini/skills"; do
        mkdir -p "$tdir"
        for sd in "$SKILLS_SOURCE"/*/; do
            [[ -d "$sd" ]] || continue; sn=$(basename "$sd"); [[ "$sn" == "refs" ]] && continue
            ln -sfn "$sd" "$tdir/$sn"
        done
    done; ok "Skills linked to user-level directories"
else fail "cat-cafe-skills/ not found"; exit 1
fi

# ── [6/9] Install AI agent CLI tools ─────────────────────
step "[6/9] Installing AI CLI tools / 安装 AI 命令行工具..."
info "  Clowder spawns CLI subprocesses — these are required"

install_npm_cli() {
    local name="$1" cmd="$2" pkg="$3"
    npm install -g "$pkg" 2>&1 | tail -2
    hash -r 2>/dev/null || true
    if ! command -v "$cmd" &>/dev/null; then
        fail "$name ($pkg) install failed — $cmd not found in PATH"
        fail "Try manually: npm install -g $pkg"; exit 1
    fi
    ok "$name installed"
}
install_claude_cli() {
    curl -fsSL https://claude.ai/install.sh | bash 2>&1 | tail -5
    hash -r 2>/dev/null || true
    if ! command -v claude &>/dev/null; then
        fail "Claude Code install failed — claude not found in PATH"
        fail "Try manually: curl -fsSL https://claude.ai/install.sh | bash"; exit 1
    fi
    ok "Claude Code installed"
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
        if [[ "$AGENT_SEL" == "0" ]]; then INSTALL_AGENTS=()
        elif [[ -n "$AGENT_SEL" ]]; then
            INSTALL_AGENTS=()
            IFS=',' read -ra SEL_IDX <<< "$AGENT_SEL"
            for idx in "${SEL_IDX[@]}"; do
                idx=$((idx - 1))
                [[ $idx -ge 0 && $idx -lt ${#MISSING_AGENTS[@]} ]] && INSTALL_AGENTS+=("${MISSING_AGENTS[$idx]}")
            done
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

# ── [7/9] Generate .env ────────────────────────────────────
step "[7/9] Configuring environment / 配置环境..."

if [[ -f .env ]]; then
    warn ".env already exists — not overwriting / .env 已存在，不覆盖"
    warn "To regenerate: cp .env.example .env"
else
    if [[ -f .env.example ]]; then
        cp .env.example .env
        ok ".env generated from .env.example"
    else
        fail ".env.example not found — cannot generate config. Try: git clone $REPO_URL"
        exit 1
    fi
fi

# Write deferred external Redis URL into .env
if [[ "$REDIS_EXTERNAL" == true && -n "${REDIS_EXT_URL:-}" ]]; then
    sed -i "s|^REDIS_URL=.*|REDIS_URL=$REDIS_EXT_URL|" .env 2>/dev/null \
        || echo "REDIS_URL=$REDIS_EXT_URL" >> .env
    ok "External Redis URL written to .env"
fi

# ── [8/9] Authentication setup / 认证配置 ─────────────────
step "[8/9] Authentication setup / 认证配置..."
write_claude_profile() {
    local key="$1" base_url="$2" model="$3" pid="profile-installer-$$"
    local pdir="$PROJECT_DIR/.cat-cafe"; mkdir -p "$pdir"
    local now; now=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    cat > "$pdir/provider-profiles.json" <<EOPROF
{"version":1,"providers":{"anthropic":{"activeProfileId":"$pid","profiles":[{"id":"$pid","provider":"anthropic","name":"Installer API Key","mode":"api_key","baseUrl":"${base_url:-https://api.anthropic.com}","createdAt":"$now","updatedAt":"$now"${model:+,"modelOverride":"$model"}}]}}}
EOPROF
    cat > "$pdir/provider-profiles.secrets.local.json" <<EOSEC
{"version":1,"providers":{"anthropic":{"$pid":{"apiKey":"$key"}}}}
EOSEC
    chmod 600 "$pdir/provider-profiles.secrets.local.json"
}

configure_agent_auth() {
    local name="$1" cmd="$2"
    command -v "$cmd" &>/dev/null || return 0
    echo ""
    echo -e "  ${BOLD}$name ($cmd):${NC}"
    echo "    1) OAuth / Subscription (recommended / 推荐)"
    echo "    2) API Key"
    local choice; tty_read "    Choose [1/2] (default: 1): " choice
    if [[ "${choice:-1}" != "2" ]]; then
        ok "$name: OAuth mode (login on first use: run '$cmd')"
        return 0
    fi
    local key="" base_url="" model=""
    tty_read "    API Key: " key
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
            echo "CODEX_AUTH_MODE=api_key" >> .env
            [[ -n "$key" ]] && echo "OPENAI_API_KEY=$key" >> .env
            [[ -n "$base_url" ]] && echo "OPENAI_BASE_URL=$base_url" >> .env
            [[ -n "$model" ]] && echo "CAT_CODEX_MODEL=$model" >> .env
            ok "$name: API key configured in .env"
            ;;
        gemini)
            tty_read "    Model (Enter = default): " model
            [[ -n "$key" ]] && echo "GEMINI_API_KEY=$key" >> .env
            [[ -n "$model" ]] && echo "CAT_GEMINI_MODEL=$model" >> .env
            ok "$name: API key configured in .env"
            ;;
    esac
}

if [[ "$HAS_TTY" == true ]]; then
    info "  Configure each agent / 逐个配置每只猫的认证方式："
    configure_agent_auth "Claude (布偶猫)" "claude"
    configure_agent_auth "Codex (缅因猫)"  "codex"
    configure_agent_auth "Gemini (暹罗猫)" "gemini"
else
    info "  Non-interactive — skipping auth config"
    info "  Log in by running each CLI: claude / codex / gemini"
    info "  Or re-run this script interactively for API key setup"
fi

# ── [9/9] Done ──────────────────────────────────────────────
step "[9/9] Installation complete! / 安装完成！"
echo ""
echo -e "  ${GREEN}══ Clowder AI is ready! 猫猫咖啡已就绪！══${NC}"
echo "  Project: $PROJECT_DIR"
START_CMD="cd $PROJECT_DIR && pnpm start"
[[ "$MEMORY_MODE" == true ]] && START_CMD+=" --memory"
echo "  Start: $START_CMD"
echo "  Open:  http://localhost:3003"
echo ""
if [[ "$AUTO_START" == true ]]; then
    echo -e "${CYAN}Starting service (--start)...${NC}"; echo ""
    if [[ "$MEMORY_MODE" == true ]]; then exec pnpm start --memory; else exec pnpm start; fi
fi
