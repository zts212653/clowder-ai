#!/usr/bin/env bash
# scripts/services/qwen3-asr-server.sh
# Start local Qwen3-ASR server for Cat Cafe voice input (MLX backend).
# Drop-in replacement for whisper-server.sh -- same port, same API.
#
# Usage:
#   ./scripts/services/qwen3-asr-server.sh                                    # default: 8bit
#   QWEN3_ASR_MODEL=mlx-community/Qwen3-ASR-1.7B-4bit ./scripts/services/qwen3-asr-server.sh
#
# Prerequisites: run scripts/services/qwen3-asr-install.sh first (auto-installed if missing).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${CAT_CAFE_HOME:=$(cd "$SCRIPT_DIR/../.." && pwd)/.cat-cafe}"
case "$CAT_CAFE_HOME" in
  "~") CAT_CAFE_HOME="$HOME" ;;
  "~/"*) CAT_CAFE_HOME="${HOME}/${CAT_CAFE_HOME#~/}" ;;
esac
export CAT_CAFE_HOME
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
echo "[start] wrapper entered: service=qwen3-asr script=$0"

# shellcheck source=./proxy-env.sh
source "$SCRIPT_DIR/proxy-env.sh"
normalize_socks_proxy_env

VENV_DIR="${CAT_CAFE_HOME}/asr-venv"
MODEL="${QWEN3_ASR_MODEL:-${1:-mlx-community/Qwen3-ASR-1.7B-8bit}}"
API_SCRIPT="$SCRIPT_DIR/qwen3-asr-api.py"
PORT="${WHISPER_PORT:-9876}"
echo "[start] resolved runtime: CAT_CAFE_HOME=$CAT_CAFE_HOME; venv=$VENV_DIR; python=python3; api=$API_SCRIPT; port=$PORT"

if [ ! -d "$VENV_DIR" ]; then
  echo "[start] venv not found: $VENV_DIR -- auto-installing..." >&2
  INSTALL_SCRIPT="$SCRIPT_DIR/qwen3-asr-install.sh"
  if [ ! -f "$INSTALL_SCRIPT" ]; then
    echo "ERROR: install script not found: $INSTALL_SCRIPT" >&2
    exit 1
  fi
  QWEN3_ASR_MODEL="$MODEL" bash "$INSTALL_SCRIPT"
  if [ ! -d "$VENV_DIR" ]; then
    echo "ERROR: auto-install completed but venv still missing: $VENV_DIR" >&2
    exit 1
  fi
fi
source "$VENV_DIR/bin/activate"

if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg not found. Run: brew install ffmpeg" >&2
  exit 1
fi

echo "Starting Qwen3-ASR server: model=$MODEL, port=$PORT"
echo "[start] launching python: python3 $API_SCRIPT --model $MODEL --port $PORT"
set +e
python3 "$API_SCRIPT" --model "$MODEL" --port "$PORT"
EXIT_CODE=$?
set -e
echo "[start] python exited with code $EXIT_CODE"
exit "$EXIT_CODE"
