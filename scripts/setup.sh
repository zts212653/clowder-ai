#!/bin/bash

# ============================================================
# Cat Cafe / Clowder AI — Interactive Setup
# 猫猫咖啡交互式安装向导
#
# Usage: ./scripts/setup.sh [--install-missing] [--npm-registry=URL] [--pip-index-url=URL] [--pip-extra-index-url=URL] [--hf-endpoint=URL]
# ============================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/download-source-overrides.sh"
cd "$PROJECT_DIR"

# Parse args
INSTALL_MISSING=false
for arg in "$@"; do
    case $arg in
        --install-missing) INSTALL_MISSING=true ;;
        *)
            parse_manual_download_source_arg "$arg" || true
            ;;
    esac
done
apply_manual_download_source_overrides

echo ""
echo -e "${BOLD}🐱 Cat Cafe — Interactive Setup${NC}"
echo -e "${BOLD}猫猫咖啡 — 交互式安装向导${NC}"
echo "=================================="
echo ""
print_manual_download_source_summary
[ -n "${CAT_CAFE_NPM_REGISTRY:-}${CAT_CAFE_PIP_INDEX_URL:-}${CAT_CAFE_PIP_EXTRA_INDEX_URL:-}${CAT_CAFE_HF_ENDPOINT:-}" ] && echo ""

# ── Step 1: Check prerequisites ─────────────────────────────

echo -e "${CYAN}[1/6] Checking prerequisites / 检查前置依赖...${NC}"
echo ""

MISSING=()

if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    echo -e "  ${GREEN}✓${NC} Node.js $NODE_VER"
    # Check minimum version (v20+)
    MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
    if [ "$MAJOR" -lt 20 ]; then
        echo -e "  ${YELLOW}⚠ Node.js v20+ recommended (you have $NODE_VER)${NC}"
    fi
else
    echo -e "  ${RED}✗${NC} Node.js not found"
    MISSING+=("Node.js (v20+) — https://nodejs.org/")
fi

if command -v pnpm &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} pnpm $(pnpm -v)"
else
    echo -e "  ${RED}✗${NC} pnpm not found"
    MISSING+=("pnpm — npm install -g pnpm")
fi

if command -v git &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} git $(git --version | awk '{print $3}')"
else
    echo -e "  ${RED}✗${NC} git not found"
    MISSING+=("git — https://git-scm.com/")
fi

HAS_PYTHON=false
if command -v python3 &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Python3 $(python3 --version 2>&1 | awk '{print $2}')"
    HAS_PYTHON=true
else
    echo -e "  ${YELLOW}○${NC} Python3 not found (optional — needed for voice features)"
fi

HAS_REDIS=false
if command -v redis-server &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Redis $(redis-server --version | grep -oE 'v=[0-9.]+' | cut -d= -f2)"
    HAS_REDIS=true
else
    echo -e "  ${YELLOW}○${NC} Redis not found (optional — can use --memory mode)"
fi

if [ ${#MISSING[@]} -gt 0 ]; then
    echo ""
    echo -e "${RED}Missing required dependencies:${NC}"
    for dep in "${MISSING[@]}"; do
        echo -e "  - $dep"
    done
    echo ""
    echo "Please install the above and re-run this script."
    exit 1
fi

# ── Step 2: Install packages ────────────────────────────────

echo ""
echo -e "${CYAN}[2/6] Installing packages / 安装依赖包...${NC}"
echo ""

if [ -d "node_modules" ]; then
    echo -e "  ${YELLOW}○${NC} node_modules exists, running install anyway..."
fi
pnpm install --frozen-lockfile 2>&1 | tail -3
echo -e "  ${GREEN}✓${NC} Packages installed"

# ── Step 3: Choose optional features ────────────────────────

echo ""
echo -e "${CYAN}[3/6] Optional features / 可选功能${NC}"
echo ""
echo "Cat Cafe works out of the box. Add model API keys via UI after launch."
echo "猫猫咖啡开箱即用。启动后在前端 UI 添加模型 API Key。"
echo ""
echo "The following features are optional. Choose what you want:"
echo "以下功能均为可选，选择你需要的："
echo ""

# --- Voice Input (ASR) ---
ENABLE_ASR=false
echo -e "${BOLD}  [A] Voice Input / 语音输入 (ASR)${NC}"
echo "      Talk to cats with your voice instead of typing."
echo "      用语音和猫猫对话，免打字。"
echo ""
if [ "$HAS_PYTHON" = true ]; then
    echo "      Engine: Qwen3-ASR (primary) / Whisper (fallback)"
    echo "      Requirements / 要求:"
    echo "        - ~2GB disk for model download / 需要约 2GB 磁盘下载模型"
    echo "        - 4GB+ RAM recommended / 建议 4GB+ 内存"
    echo "        - GPU optional but faster / GPU 可选但更快"
    echo ""
    if [ "$INSTALL_MISSING" = true ]; then
        ENABLE_ASR=true
        echo -e "      ${GREEN}✓${NC} Voice input enabled (--install-missing)"
    else
        read -p "      Enable voice input? (y/N): " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            ENABLE_ASR=true
            echo -e "      ${GREEN}✓${NC} Voice input enabled"
        fi
    fi
else
    echo -e "      ${YELLOW}⚠ Requires Python3 (not installed). Skipping.${NC}"
fi
echo ""

# --- Voice Output (TTS) ---
ENABLE_TTS=false
echo -e "${BOLD}  [B] Voice Output / 语音输出 (TTS)${NC}"
echo "      Hear cats speak! Multiple engines available."
echo "      听猫猫说话！支持多种引擎。"
echo ""
if [ "$HAS_PYTHON" = true ]; then
    echo "      Engines: Kokoro (best quality) / edge-tts (no download) / Qwen3-TTS"
    echo "      Requirements / 要求:"
    echo "        - Kokoro: ~500MB model download / Kokoro 需约 500MB 下载"
    echo "        - edge-tts: no download, uses Microsoft online API / 无需下载"
    echo "        - 2GB+ RAM for Kokoro, minimal for edge-tts"
    echo ""
    if [ "$INSTALL_MISSING" = true ]; then
        ENABLE_TTS=true
        echo -e "      ${GREEN}✓${NC} Voice output enabled (--install-missing)"
    else
        read -p "      Enable voice output? (y/N): " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            ENABLE_TTS=true
            echo -e "      ${GREEN}✓${NC} Voice output enabled"
        fi
    fi
else
    echo -e "      ${YELLOW}⚠ Requires Python3 (not installed). Skipping.${NC}"
fi
echo ""

# --- LLM Post-processing ---
ENABLE_LLM_PP=false
echo -e "${BOLD}  [C] Speech Correction / 语音纠正 (LLM Post-processing)${NC}"
echo "      Improves ASR accuracy using a small language model."
echo "      用小语言模型提升语音识别准确率。"
echo ""
if [ "$HAS_PYTHON" = true ] && [ "$ENABLE_ASR" = true ]; then
    echo "      Engine: Qwen3-4B"
    echo "      Requirements / 要求:"
    echo "        - ~4GB disk for model / 约 4GB 磁盘"
    echo "        - 8GB+ RAM / 8GB+ 内存"
    echo "        - GPU strongly recommended / 强烈建议 GPU"
    echo ""
    if [ "$INSTALL_MISSING" = true ]; then
        ENABLE_LLM_PP=true
        echo -e "      ${GREEN}✓${NC} Speech correction enabled (--install-missing)"
    else
        read -p "      Enable speech correction? (y/N): " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            ENABLE_LLM_PP=true
            echo -e "      ${GREEN}✓${NC} Speech correction enabled"
        fi
    fi
elif [ "$ENABLE_ASR" = false ]; then
    echo -e "      ${YELLOW}○ Skipped (requires Voice Input above)${NC}"
else
    echo -e "      ${YELLOW}⚠ Requires Python3 (not installed). Skipping.${NC}"
fi
echo ""

# --- API Gateway Proxy ---
ENABLE_PROXY=false
echo -e "${BOLD}  [D] API Gateway Proxy / API 网关代理${NC}"
echo "      Route Claude API calls through a custom gateway."
echo "      通过自定义网关路由 Claude API 调用。"
echo ""
echo "      Use this if you need to go through a load balancer or"
echo "      third-party API provider instead of direct Anthropic access."
echo "      如需通过负载均衡或第三方 API 提供商访问，而非直连 Anthropic。"
echo ""
if [ "$INSTALL_MISSING" = true ]; then
    ENABLE_PROXY=true
    echo -e "      ${GREEN}✓${NC} API proxy enabled (--install-missing)"
else
    read -p "      Enable API proxy? (y/N): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        ENABLE_PROXY=true
        echo -e "      ${GREEN}✓${NC} API proxy enabled"
    fi
fi
echo ""

# ── Step 4: Generate .env ───────────────────────────────────

echo -e "${CYAN}[4/6] Generating .env / 生成配置文件...${NC}"
echo ""

if [ -f .env ]; then
    echo -e "  ${YELLOW}⚠${NC} .env already exists. Creating .env.new instead."
    echo "     Review and merge manually: diff .env .env.new"
    ENV_FILE=".env.new"
else
    ENV_FILE=".env"
fi

cat > "$ENV_FILE" <<ENVEOF
# Generated by Cat Cafe setup.sh — $(date +%Y-%m-%d)
# 由 setup.sh 自动生成

# ── Core 核心 ────────────────────────────────────────────────
FRONTEND_PORT=3003
API_SERVER_PORT=3004
NEXT_PUBLIC_API_URL=http://localhost:3004
REDIS_PORT=6399
REDIS_URL=redis://localhost:6399

# ── Model API Keys 模型密钥 ──────────────────────────────────
# Optional if your CLI subscription already handles auth.
# 如果 CLI 订阅已管理认证，这里可以留空。
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# GOOGLE_API_KEY=

# ── API Gateway Proxy 反向代理 ───────────────────────────────
ANTHROPIC_PROXY_ENABLED=$([ "$ENABLE_PROXY" = true ] && echo "1" || echo "0")
# ANTHROPIC_PROXY_PORT=9877
ENVEOF

if [ "$ENABLE_ASR" = true ]; then
    cat >> "$ENV_FILE" <<ENVEOF

# ── Voice Input (ASR) 语音输入 ───────────────────────────────
ASR_ENABLED=1
WHISPER_URL=http://localhost:9876
NEXT_PUBLIC_WHISPER_URL=http://localhost:9876
ENVEOF
else
    cat >> "$ENV_FILE" <<ENVEOF

# ── Voice Input (ASR) 语音输入 ───────────────────────────────
ASR_ENABLED=0
ENVEOF
fi

if [ "$ENABLE_TTS" = true ]; then
    cat >> "$ENV_FILE" <<ENVEOF

# ── Voice Output (TTS) 语音输出 ──────────────────────────────
TTS_ENABLED=1
TTS_URL=http://localhost:9879
TTS_CACHE_DIR=./data/tts-cache
ENVEOF
else
    cat >> "$ENV_FILE" <<ENVEOF

# ── Voice Output (TTS) 语音输出 ──────────────────────────────
TTS_ENABLED=0
ENVEOF
fi

if [ "$ENABLE_LLM_PP" = true ]; then
    cat >> "$ENV_FILE" <<ENVEOF

# ── Speech Correction 语音纠正 ───────────────────────────────
LLM_POSTPROCESS_ENABLED=1
NEXT_PUBLIC_LLM_POSTPROCESS_URL=http://localhost:9878
ENVEOF
else
    cat >> "$ENV_FILE" <<ENVEOF

# ── Speech Correction 语音纠正 ───────────────────────────────
LLM_POSTPROCESS_ENABLED=0
ENVEOF
fi

echo -e "  ${GREEN}✓${NC} $ENV_FILE generated"

# ── Step 4b: Install sidecar venvs (--install-missing) ──────

# Creates venvs + installs pip deps for each enabled sidecar.
# Extracted as a function so tests can verify behavior independently.
install_sidecar_venvs() {
    local venv_base="${HOME}/.cat-cafe"

    # ASR venv
    local asr_venv="$venv_base/asr-venv"
    if [ ! -d "$asr_venv" ]; then
        echo "  Creating ASR venv: $asr_venv ..."
        python3 -m venv "$asr_venv"
    else
        echo "  Updating ASR venv: $asr_venv ..."
    fi
    "$asr_venv/bin/pip" install --quiet -U pip
    "$asr_venv/bin/pip" install --quiet mlx-audio fastapi uvicorn python-multipart

    # TTS venv
    local tts_venv="$venv_base/tts-venv"
    if [ ! -d "$tts_venv" ]; then
        echo "  Creating TTS venv: $tts_venv ..."
        python3 -m venv "$tts_venv"
    else
        echo "  Updating TTS venv: $tts_venv ..."
    fi
    "$tts_venv/bin/pip" install --quiet -U pip
    "$tts_venv/bin/pip" install --quiet mlx-audio 'misaki[zh]' fastapi uvicorn 'httpx[socks]' num2words spacy phonemizer

    # LLM post-processing venv
    local llm_venv="$venv_base/llm-venv"
    if [ ! -d "$llm_venv" ]; then
        echo "  Creating LLM venv: $llm_venv ..."
        python3 -m venv "$llm_venv"
    else
        echo "  Updating LLM venv: $llm_venv ..."
    fi
    "$llm_venv/bin/pip" install --quiet -U pip
    "$llm_venv/bin/pip" install --quiet mlx-vlm "httpx[socks]" torchvision fastapi uvicorn pydantic
}

if [ "$INSTALL_MISSING" = true ] && [ "$HAS_PYTHON" = true ]; then
    echo ""
    echo -e "${CYAN}[4b/6] Installing sidecar venvs / 安装语音服务依赖...${NC}"
    echo ""
    install_sidecar_venvs
    echo -e "  ${GREEN}✓${NC} Sidecar venvs installed"
fi

# ── Step 5: Link skills (ADR-009) ───────────────────────────

echo ""
echo -e "${CYAN}[5/6] Linking skills / 链接技能包...${NC}"
echo ""

SKILLS_SOURCE="$PROJECT_DIR/cat-cafe-skills"
if [[ -d "$SKILLS_SOURCE" ]]; then
    for tdir in "$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.gemini/skills" "$HOME/.kimi/skills"; do
        mkdir -p "$tdir"
        for sd in "$SKILLS_SOURCE"/*/; do
            [[ -d "$sd" ]] || continue
            sn=$(basename "$sd")
            [[ "$sn" == "refs" ]] && continue
            ln -sfn "$sd" "$tdir/$sn"
        done
    done
    echo -e "  ${GREEN}✓${NC} Skills linked to ~/.claude/skills, ~/.codex/skills, ~/.gemini/skills, ~/.kimi/skills"
else
    echo -e "  ${YELLOW}⚠${NC} cat-cafe-skills/ not found — skills will not be available"
    echo "     You can link them later by re-running this script after cloning cat-cafe-skills."
fi

# ── Step 6: Summary ─────────────────────────────────────────

echo ""
echo -e "${CYAN}[6/6] Setup complete! / 安装完成！${NC}"
echo ""
echo "=================================="
echo -e "${GREEN}🎉 Cat Cafe is ready!${NC}"
echo ""
echo "  Enabled features / 已启用功能:"
echo "    ✓ Core (API + Frontend + Redis)"
[ "$ENABLE_ASR" = true ] && echo "    ✓ Voice Input (ASR)"
[ "$ENABLE_TTS" = true ] && echo "    ✓ Voice Output (TTS)"
[ "$ENABLE_LLM_PP" = true ] && echo "    ✓ Speech Correction (LLM)"
[ "$ENABLE_PROXY" = true ] && echo "    ✓ API Gateway Proxy"
echo ""
echo "  Next steps / 下一步:"
echo "    1. Open http://localhost:3003 → Hub → System Settings → Account Configuration"
echo "       打开 http://localhost:3003 → Hub → 系统配置 → 账号配置，添加模型 API Key"
echo ""
if [ "$HAS_REDIS" = true ]; then
    echo "    2. Start: pnpm start"
    echo "       启动: pnpm start"
else
    echo "    2. Start (no Redis): pnpm start --memory"
    echo "       启动（无 Redis）: pnpm start --memory"
fi
echo ""
echo "    3. Open http://localhost:3003"
echo "       打开 http://localhost:3003"
echo ""

if [ "$ENABLE_ASR" = true ] || [ "$ENABLE_TTS" = true ] || [ "$ENABLE_LLM_PP" = true ]; then
    if [ "$INSTALL_MISSING" = true ]; then
        echo -e "  ${GREEN}✓${NC} Sidecar venvs pre-installed. Models download on first use."
        echo "  语音服务 venv 已预装。模型将在首次使用时下载。"
    else
        echo -e "  ${YELLOW}Note:${NC} Voice models will be downloaded on first use."
        echo "  语音模型将在首次使用时自动下载。"
    fi
    echo ""
fi

echo "  Documentation / 文档: SETUP.md"
echo "  Issues: https://github.com/your-org/clowder-ai/issues"
echo ""
