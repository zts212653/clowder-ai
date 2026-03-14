#!/usr/bin/env bash
# ============================================================
# Clowder AI — Linux One-Click Install (F113 Phase A)
# 猫猫咖啡 — Linux 一键部署脚本
#
# Usage (run as normal user, not root — script uses sudo internally):
#   curl -fsSL https://raw.githubusercontent.com/zts212653/clowder-ai/main/scripts/install.sh | bash
#   ./scripts/install.sh [--start] [--memory] [--dir=/path/to/install]
#
# Supported: Debian/Ubuntu, CentOS/RHEL/Fedora
# Not yet supported: Alpine, Arch, openSUSE
# ============================================================

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Parse arguments ─────────────────────────────────────────
AUTO_START=false
MEMORY_MODE=false
INSTALL_DIR=""
for arg in "$@"; do
    case $arg in
        --start) AUTO_START=true ;;
        --memory) MEMORY_MODE=true ;;
        --dir=*) INSTALL_DIR="${arg#*=}" ;;
    esac
done

# ── Logging helpers ─────────────────────────────────────────
info()    { echo -e "${CYAN}$*${NC}"; }
ok()      { echo -e "  ${GREEN}✓${NC} $*"; }
warn()    { echo -e "  ${YELLOW}⚠${NC} $*"; }
fail()    { echo -e "  ${RED}✗${NC} $*"; }
step()    { echo ""; echo -e "${BOLD}$*${NC}"; }

# ── [1/7] Environment detection ────────────────────────────
step "[1/7] Detecting environment / 环境检测..."

if [[ "$(uname -s)" != "Linux" ]]; then
    fail "This script is for Linux only. Detected: $(uname -s)"
    fail "此脚本仅支持 Linux。检测到: $(uname -s)"
    exit 1
fi

DISTRO_FAMILY=""
DISTRO_NAME=""
DISTRO_VERSION=""
PKG_INSTALL=""
PKG_UPDATE=""

if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    DISTRO_NAME="${ID:-unknown}"
    DISTRO_VERSION="${VERSION_ID:-}"

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
    fail "Unsupported distribution: ${DISTRO_NAME:-unknown}"
    fail "不支持的发行版: ${DISTRO_NAME:-unknown}"
    echo ""
    echo "  Supported / 支持的发行版:"
    echo "    - Ubuntu 22.04 / 24.04"
    echo "    - Debian 12+"
    echo "    - CentOS Stream 9 / RHEL 9"
    echo "    - Fedora 39+"
    echo ""
    echo "  Alpine, Arch, etc. — not yet supported"
    exit 1
fi

ok "OS: ${PRETTY_NAME:-$DISTRO_NAME $DISTRO_VERSION} ($DISTRO_FAMILY)"

# ── Sudo detection ──────────────────────────────────────────
SUDO=""
if [[ $EUID -ne 0 ]]; then
    if command -v sudo &>/dev/null; then
        SUDO="sudo"
    else
        fail "Not running as root and sudo not found."
        fail "请以 root 运行或安装 sudo"
        exit 1
    fi
fi

# ── [2/7] Install system dependencies ──────────────────────
step "[2/7] Installing system dependencies / 安装系统依赖..."

$SUDO $PKG_UPDATE 2>/dev/null || true

case "$DISTRO_FAMILY" in
    debian)
        $SUDO $PKG_INSTALL git curl ca-certificates gnupg build-essential
        ;;
    rhel)
        $SUDO $PKG_INSTALL git curl ca-certificates gnupg2 gcc gcc-c++ make
        ;;
esac
ok "System dependencies installed / 系统依赖已安装"

# ── [3/7] Install Node.js 20+ ──────────────────────────────
step "[3/7] Installing Node.js / 安装 Node.js..."

install_node_needed() {
    if ! command -v node &>/dev/null; then
        return 0
    fi
    local major
    major=$(node -v | sed 's/v//' | cut -d. -f1)
    if [[ "$major" -lt 20 ]]; then
        warn "Node.js $(node -v) found but v20+ required / 发现 $(node -v) 但需要 v20+"
        return 0
    fi
    return 1
}

if install_node_needed; then
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

# ── [4/7] Install pnpm + Redis ─────────────────────────────
step "[4/7] Installing pnpm & Redis / 安装 pnpm 和 Redis..."

# pnpm: corepack first, npm fallback
if ! command -v pnpm &>/dev/null; then
    info "  Installing pnpm via corepack..."
    if command -v corepack &>/dev/null; then
        $SUDO corepack enable 2>/dev/null || true
        corepack prepare pnpm@latest --activate 2>/dev/null || true
    fi
    # Fallback if corepack didn't work
    if ! command -v pnpm &>/dev/null; then
        warn "corepack unavailable, falling back to npm / corepack 不可用，回退到 npm"
        $SUDO npm install -g pnpm
    fi
    ok "pnpm $(pnpm -v) installed"
else
    ok "pnpm $(pnpm -v) already installed"
fi

# Redis (skip if --memory)
if [[ "$MEMORY_MODE" == true ]]; then
    warn "Memory mode — skipping Redis / 内存模式，跳过 Redis"
elif ! command -v redis-server &>/dev/null; then
    info "  Installing Redis..."
    case "$DISTRO_FAMILY" in
        debian) $SUDO $PKG_INSTALL redis-server ;;
        rhel)   $SUDO $PKG_INSTALL redis ;;
    esac
    $SUDO systemctl enable redis-server 2>/dev/null \
        || $SUDO systemctl enable redis 2>/dev/null \
        || true
    $SUDO systemctl start redis-server 2>/dev/null \
        || $SUDO systemctl start redis 2>/dev/null \
        || true
    ok "Redis $(redis-server --version | grep -oE 'v=[0-9.]+' | cut -d= -f2) installed and started"
else
    ok "Redis already installed ($(redis-server --version | grep -oE 'v=[0-9.]+' | cut -d= -f2))"
    if ! redis-cli ping &>/dev/null 2>&1; then
        warn "Redis installed but not running, starting..."
        $SUDO systemctl start redis-server 2>/dev/null \
            || $SUDO systemctl start redis 2>/dev/null \
            || true
    fi
fi

# ── [5/7] Clone & build project ────────────────────────────
step "[5/7] Setting up project / 设置项目..."

REPO_URL="https://github.com/zts212653/clowder-ai.git"

# Detect if we're already inside the repo
IN_REPO=false
if [[ -f "package.json" ]] && grep -q '"name": "cat-cafe"' package.json 2>/dev/null; then
    IN_REPO=true
    PROJECT_DIR="$(pwd)"
elif [[ -n "$INSTALL_DIR" ]]; then
    PROJECT_DIR="$INSTALL_DIR"
else
    PROJECT_DIR="$HOME/clowder-ai"
fi

if [[ "$IN_REPO" == false ]]; then
    if [[ -d "$PROJECT_DIR/.git" ]]; then
        ok "Repository already cloned at $PROJECT_DIR"
        cd "$PROJECT_DIR"
        info "  Pulling latest changes..."
        git pull --ff-only 2>/dev/null || warn "Could not pull (not on tracking branch?)"
    else
        info "  Cloning repository to $PROJECT_DIR..."
        git clone "$REPO_URL" "$PROJECT_DIR"
        cd "$PROJECT_DIR"
        ok "Repository cloned"
    fi
else
    ok "Already in project directory: $PROJECT_DIR"
fi

info "  Installing npm packages..."
pnpm install --frozen-lockfile 2>&1 | tail -3
ok "Packages installed"

info "  Building project..."
pnpm build 2>&1 | tail -5
ok "Build complete"

# Skills: symlink each skill to user-level directories (ADR-009)
SKILLS_SOURCE="$PROJECT_DIR/cat-cafe-skills"
if [[ -d "$SKILLS_SOURCE" ]]; then
    info "  Setting up skills symlinks (ADR-009)..."
    SKILLS_TARGETS=("$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.gemini/skills")
    for target_dir in "${SKILLS_TARGETS[@]}"; do
        mkdir -p "$target_dir"
        for skill_dir in "$SKILLS_SOURCE"/*/; do
            [[ -d "$skill_dir" ]] || continue
            skill_name=$(basename "$skill_dir")
            [[ "$skill_name" == "refs" ]] && continue
            ln -sfn "$skill_dir" "$target_dir/$skill_name"
        done
    done
    ok "Skills linked to ~/.claude/skills, ~/.codex/skills, ~/.gemini/skills"
else
    fail "cat-cafe-skills/ directory not found in $PROJECT_DIR"
    fail "Skills setup failed — cats will not load workflow rules"
    exit 1
fi

# ── [6/7] Generate .env ────────────────────────────────────
step "[6/7] Configuring environment / 配置环境..."

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

# ── [7/7] Done ──────────────────────────────────────────────
step "[7/7] Installation complete! / 安装完成！"

echo ""
echo "=========================="
echo -e "${GREEN}  Clowder AI is ready!${NC}"
echo -e "${GREEN}  猫猫咖啡已就绪！${NC}"
echo "=========================="
echo ""
echo "  Project directory / 项目目录:"
echo "    $PROJECT_DIR"
echo ""
echo "  Next steps / 下一步:"
echo ""
echo "    1. Edit .env and add at least one model API key:"
echo "       编辑 .env，至少填入一个模型 API key："
echo ""
echo "       cd $PROJECT_DIR"
echo "       nano .env   # or vim / code"
echo ""
echo "    2. Start the service / 启动服务:"
if [[ "$MEMORY_MODE" == true ]]; then
    echo "       pnpm start --memory"
else
    echo "       pnpm start"
fi
echo ""
echo "    3. Open in browser / 打开浏览器:"
echo "       http://localhost:3003"
echo ""

# Warn if no API key is configured
if [[ -f .env ]]; then
    HAS_KEY=false
    grep -qE '^ANTHROPIC_API_KEY=.+' .env 2>/dev/null && HAS_KEY=true
    grep -qE '^OPENAI_API_KEY=.+' .env 2>/dev/null && HAS_KEY=true
    grep -qE '^GOOGLE_API_KEY=.+' .env 2>/dev/null && HAS_KEY=true
    if [[ "$HAS_KEY" == false ]]; then
        echo -e "  ${YELLOW}Note: No API key found in .env${NC}"
        echo -e "  ${YELLOW}注意：.env 中未发现 API key${NC}"
        echo "  Add at least one key to start chatting with your cats."
        echo "  至少添加一个 key 才能和猫猫聊天。"
        echo ""
    fi
fi

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
