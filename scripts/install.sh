#!/usr/bin/env bash
# ============================================================
# Clowder AI — Linux One-Click Install (F113 Phase A)
# 猫猫咖啡 — Linux 一键部署脚本
#
# Usage (run as normal user, not root — script uses sudo internally):
#   curl -fsSL https://raw.githubusercontent.com/zts212653/clowder-ai/main/scripts/install.sh | bash
#   ./scripts/install.sh [--start] [--memory] [--dir=/path/to/install] [--auth=oauth|apikey]
#
# Supported: Debian/Ubuntu, CentOS/RHEL/Fedora
# Not yet supported: Alpine, Arch, openSUSE
# ============================================================

set -euo pipefail

# ── Colors & helpers ──────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

AUTO_START=false; MEMORY_MODE=false; INSTALL_DIR=""; AUTH_MODE=""
for arg in "$@"; do
    case $arg in
        --start) AUTO_START=true ;; --memory) MEMORY_MODE=true ;;
        --dir=*) INSTALL_DIR="${arg#*=}" ;; --auth=*) AUTH_MODE="${arg#*=}" ;;
    esac
done

info()    { echo -e "${CYAN}$*${NC}"; }
ok()      { echo -e "  ${GREEN}✓${NC} $*"; }
warn()    { echo -e "  ${YELLOW}⚠${NC} $*"; }
fail()    { echo -e "  ${RED}✗${NC} $*"; }
step()    { echo ""; echo -e "${BOLD}$*${NC}"; }

# ── [1/9] Environment detection ────────────────────────────
step "[1/9] Detecting environment / 环境检测..."

if [[ "$(uname -s)" != "Linux" ]]; then
    fail "This script is for Linux only. Detected: $(uname -s)"
    fail "此脚本仅支持 Linux。检测到: $(uname -s)"
    exit 1
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
            DISTRO_FAMILY="rhel"
            if command -v dnf &>/dev/null; then
                PKG_UPDATE="true"
                PKG_INSTALL="dnf install -y -q"
            else
                PKG_UPDATE="true"
                PKG_INSTALL="yum install -y -q"
            fi
            ;;
    esac
fi

if [[ -z "$DISTRO_FAMILY" ]]; then
    fail "Unsupported: ${DISTRO_NAME:-unknown}. Supported: Ubuntu/Debian, CentOS/RHEL/Fedora"
    fail "不支持的发行版: ${DISTRO_NAME:-unknown}。支持: Ubuntu/Debian, CentOS/RHEL/Fedora"
    exit 1
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

# Redis (skip if --memory)
if [[ "$MEMORY_MODE" == true ]]; then
    warn "Memory mode — skipping Redis / 内存模式，跳过 Redis"
elif ! command -v redis-server &>/dev/null; then
    case "$DISTRO_FAMILY" in
        debian) $SUDO $PKG_INSTALL redis-server ;; rhel) $SUDO $PKG_INSTALL redis ;;
    esac
    $SUDO systemctl enable redis-server 2>/dev/null || $SUDO systemctl enable redis 2>/dev/null || true
    $SUDO systemctl start redis-server 2>/dev/null || $SUDO systemctl start redis 2>/dev/null || true
    ok "Redis installed and started"
else
    ok "Redis already installed"
    redis-cli ping &>/dev/null 2>&1 || {
        $SUDO systemctl start redis-server 2>/dev/null || $SUDO systemctl start redis 2>/dev/null || true
    }
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
            [[ -d "$sd" ]] || continue
            sn=$(basename "$sd"); [[ "$sn" == "refs" ]] && continue
            ln -sfn "$sd" "$tdir/$sn"
        done
    done
    ok "Skills linked to user-level directories"
else
    fail "cat-cafe-skills/ not found — cats cannot load workflow rules"
    exit 1
fi

# ── [6/9] Install AI agent CLI tools ─────────────────────
step "[6/9] Installing AI CLI tools / 安装 AI 命令行工具..."
info "  Clowder spawns CLI subprocesses — these are required"

install_cli() {
    local name="$1" cmd="$2" pkg="$3"
    if command -v "$cmd" &>/dev/null; then
        ok "$name already installed"
    else
        npm install -g "$pkg" 2>&1 | tail -2
        command -v "$cmd" &>/dev/null && ok "$name installed" || warn "$name: try 'hash -r' to refresh PATH"
    fi
}
install_cli "Claude Code" "claude" "@anthropic-ai/claude-code"
install_cli "Codex CLI"   "codex"  "@openai/codex"
install_cli "Gemini CLI"  "gemini" "@google/gemini-cli"

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
        fail ".env.example not found — cannot generate config"
        fail ".env.example 未找到，无法生成配置"
        fail "This may indicate an incomplete clone. Try: git clone $REPO_URL"
        exit 1
    fi
fi

# ── [8/9] Authentication setup / 认证配置 ─────────────────
step "[8/9] Authentication setup / 认证配置..."

if [[ -z "$AUTH_MODE" ]]; then
    if [[ -t 0 ]]; then
        echo "  1) OAuth / Subscription login (recommended / 推荐)"
        echo "  2) API Key mode / API Key 模式"
        read -rp "  Choose [1/2] (default: 1): " auth_choice
        [[ "${auth_choice:-1}" == "2" ]] && AUTH_MODE="apikey" || AUTH_MODE="oauth"
    else
        AUTH_MODE="oauth"
        info "  Non-interactive — defaulting to OAuth"
    fi
fi

if [[ "$AUTH_MODE" == "apikey" ]]; then
    info "  API Key mode — edit .env to add keys:"
    echo "    ANTHROPIC_API_KEY=sk-...   (Claude / 布偶猫)"
    echo "    OPENAI_API_KEY=sk-...      (Codex / 缅因猫)"
    echo "    GOOGLE_API_KEY=AI...       (Gemini / 暹罗猫)"
    if [[ -f .env ]] && ! grep -q 'CAT_CAFE_ANTHROPIC_PROFILE_MODE' .env; then
        { echo ""; echo "# Auth: api_key (set by installer)"; echo "CAT_CAFE_ANTHROPIC_PROFILE_MODE=api_key"; echo "CODEX_AUTH_MODE=api_key"; } >> .env
    fi
    ok "API key mode configured"
else
    info "  OAuth mode — logging in to CLI tools..."
    for cli_info in "claude:Claude Code" "codex:Codex CLI" "gemini:Gemini CLI"; do
        cmd="${cli_info%%:*}"; name="${cli_info#*:}"
        if command -v "$cmd" &>/dev/null; then
            echo -e "  ${CYAN}→ $name login:${NC}"
            "$cmd" auth login 2>&1 || warn "$name login skipped"
        fi
    done
    ok "CLI auth setup complete (retry later: claude/codex/gemini auth login)"
fi

# ── [9/9] Done ──────────────────────────────────────────────
step "[9/9] Installation complete! / 安装完成！"

echo ""
echo "=========================="
echo -e "${GREEN}  Clowder AI is ready!  猫猫咖啡已就绪！${NC}"
echo "=========================="
echo ""
echo "  Project: $PROJECT_DIR"
echo ""
if [[ "$AUTH_MODE" == "apikey" ]]; then
    echo "  Next: edit .env with your API keys, then start"
    echo "  下一步：编辑 .env 填入 API key，然后启动"
    echo "    cd $PROJECT_DIR && nano .env"
else
    echo "  Next: start the service / 下一步：启动服务"
fi
echo ""
if [[ "$MEMORY_MODE" == true ]]; then
    echo "    pnpm start --memory"
else
    echo "    pnpm start"
fi
echo ""
echo "  Open: http://localhost:3003"
echo ""

# Auto-start if requested
if [[ "$AUTO_START" == true ]]; then
    echo -e "${CYAN}Starting service (--start)...${NC}"
    echo ""
    if [[ "$MEMORY_MODE" == true ]]; then
        exec pnpm start --memory
    else
        exec pnpm start
    fi
fi
