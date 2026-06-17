#!/usr/bin/env bash
# scripts/services/whisper-server.sh
# Start local Whisper ASR server for Clowder AI voice input (MLX backend).
#
# Usage:
#   ./scripts/services/whisper-server.sh                                            # default: large-v3-turbo
#   ./scripts/services/whisper-server.sh mlx-community/whisper-small                # smaller model
#
# Prerequisites: run scripts/services/whisper-install.sh first.
# First run will download the model from HuggingFace (~3GB for large-v3-turbo).

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
echo "[start] wrapper entered: service=whisper-stt script=$0"

# shellcheck source=./proxy-env.sh
source "$SCRIPT_DIR/proxy-env.sh"
normalize_socks_proxy_env

VENV_DIR="${CAT_CAFE_HOME}/whisper-venv"
MODEL="${WHISPER_MODEL:-${1:-}}"
API_SCRIPT="$SCRIPT_DIR/whisper-api.py"
if [ -z "$MODEL" ]; then
  echo "ERROR: WHISPER_MODEL env var (or positional arg) required -- backend specifies model, no fallback default." >&2
  exit 1
fi
PORT="${WHISPER_PORT:-9876}"
echo "[start] resolved runtime: CAT_CAFE_HOME=$CAT_CAFE_HOME; venv=$VENV_DIR; python=python3; api=$API_SCRIPT; port=$PORT"

if [ ! -d "$VENV_DIR" ]; then
  echo "[start] venv not found: $VENV_DIR -- auto-installing..." >&2
  INSTALL_SCRIPT="$SCRIPT_DIR/whisper-install.sh"
  if [ ! -f "$INSTALL_SCRIPT" ]; then
    echo "ERROR: install script not found: $INSTALL_SCRIPT" >&2
    exit 1
  fi
  WHISPER_MODEL="$MODEL" bash "$INSTALL_SCRIPT"
  if [ ! -d "$VENV_DIR" ]; then
    echo "ERROR: auto-install completed but venv still missing: $VENV_DIR" >&2
    exit 1
  fi
fi
source "$VENV_DIR/bin/activate"

if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg not found. Run:"
  echo "  brew install ffmpeg"
  exit 1
fi

echo "[start] launching python: python3 $API_SCRIPT --model $MODEL --port $PORT"
set +e
python3 "$API_SCRIPT" --model "$MODEL" --port "$PORT"
EXIT_CODE=$?
set -e
echo "[start] python exited with code $EXIT_CODE"
exit "$EXIT_CODE"
