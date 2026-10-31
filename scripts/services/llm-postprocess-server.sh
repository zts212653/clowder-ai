#!/usr/bin/env bash
# scripts/services/llm-postprocess-server.sh
# Start local LLM post-processing server for Clowder AI voice input (MLX backend).
#
# Pipeline position:  Whisper ASR -> **LLM post-edit** -> term dictionary -> filler removal
#
# Usage:
#   ./scripts/services/llm-postprocess-server.sh                                            # default: Qwen3.5-35B-A3B MoE
#   ./scripts/services/llm-postprocess-server.sh mlx-community/Qwen3.5-35B-A3B-4bit        # explicit
#
# Prerequisites: run scripts/services/llm-postprocess-install.sh first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${CAT_CAFE_HOME:=$(cd "$SCRIPT_DIR/../.." && pwd)/.cat-cafe}"
# Expand leading ~ -- bash parameter expansion doesnt tilde-expand
# (codex P2 3264135134; matches python-resolve.sh install-time fix).
case "$CAT_CAFE_HOME" in
  "~") CAT_CAFE_HOME="$HOME" ;;
  "~/"*) CAT_CAFE_HOME="${HOME}/${CAT_CAFE_HOME#~/}" ;;
esac
export CAT_CAFE_HOME
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
echo "[start] wrapper entered: service=llm-postprocess script=$0"

# shellcheck source=./proxy-env.sh
source "$SCRIPT_DIR/proxy-env.sh"
normalize_socks_proxy_env

VENV_DIR="${CAT_CAFE_HOME}/llm-venv"
MODEL="${LLM_POSTPROCESS_MODEL:-${1:-}}"
API_SCRIPT="$SCRIPT_DIR/llm-postprocess-api.py"
if [ -z "$MODEL" ]; then
  echo "ERROR: LLM_POSTPROCESS_MODEL env var (or positional arg) required -- backend specifies model, no fallback default." >&2
  exit 1
fi
PORT="${LLM_POSTPROCESS_PORT:-9878}"
echo "[start] resolved runtime: CAT_CAFE_HOME=$CAT_CAFE_HOME; venv=$VENV_DIR; python=python3; api=$API_SCRIPT; port=$PORT"

if [ ! -d "$VENV_DIR" ]; then
  echo "[start] venv not found: $VENV_DIR -- auto-installing..." >&2
  INSTALL_SCRIPT="$SCRIPT_DIR/llm-postprocess-install.sh"
  if [ ! -f "$INSTALL_SCRIPT" ]; then
    echo "ERROR: install script not found: $INSTALL_SCRIPT" >&2
    exit 1
  fi
  LLM_POSTPROCESS_MODEL="$MODEL" bash "$INSTALL_SCRIPT"
  if [ ! -d "$VENV_DIR" ]; then
    echo "ERROR: auto-install completed but venv still missing: $VENV_DIR" >&2
    exit 1
  fi
fi
source "$VENV_DIR/bin/activate"

echo "[start] launching python: python3 $API_SCRIPT --model $MODEL --port $PORT"
set +e
python3 "$API_SCRIPT" --model "$MODEL" --port "$PORT"
EXIT_CODE=$?
set -e
echo "[start] python exited with code $EXIT_CODE"
exit "$EXIT_CODE"
