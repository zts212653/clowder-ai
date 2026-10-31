#!/usr/bin/env bash
# scripts/services/tts-server.sh
# Start local TTS server for Clowder AI voice output.
#
# Usage:
#   ./scripts/services/tts-server.sh                                  # default: qwen3-clone + Qwen3-TTS Base
#   ./scripts/services/tts-server.sh mlx-community/Kokoro-82M-bf16    # explicit Kokoro model
#   TTS_PROVIDER=edge-tts ./scripts/services/tts-server.sh            # edge-tts fallback
#
# Prerequisites: run scripts/services/tts-install.sh first.

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
echo "[start] wrapper entered: service=mlx-tts script=$0"

# shellcheck source=./proxy-env.sh
source "$SCRIPT_DIR/proxy-env.sh"
normalize_socks_proxy_env

VENV_DIR="${CAT_CAFE_HOME}/tts-venv"
MODEL="${TTS_MODEL:-${1:-}}"
API_SCRIPT="$SCRIPT_DIR/tts-api.py"
if [ -z "$MODEL" ]; then
  echo "ERROR: TTS_MODEL env var (or positional arg) required -- backend specifies model, no fallback default." >&2
  exit 1
fi
PORT="${TTS_PORT:-9879}"

# Infer provider from model name when TTS_PROVIDER not explicitly set
if [ -z "${TTS_PROVIDER:-}" ]; then
  case "$MODEL" in
    edge-tts)                     PROVIDER="edge-tts" ;;
    sapi)                         PROVIDER="sapi" ;;
    piper|zh_CN-*|en_US-*|en_GB-*) PROVIDER="piper" ;;
    mlx-community/Kokoro-*)       PROVIDER="mlx-audio" ;;
    qwen3-clone)                  PROVIDER="qwen3-clone" ;;
    *)                            PROVIDER="qwen3-clone" ;;
  esac
else
  PROVIDER="$TTS_PROVIDER"
fi

# When MODEL equals a provider name (e.g. TTS_MODEL=qwen3-clone), it's not
# a valid HF model path.  Log a diagnostic -- the Python create_adapter()
# handles this by falling back to the adapter's built-in DEFAULT_MODEL.
case "$MODEL" in
  qwen3-clone|mlx-audio|edge-tts|sapi|piper)
    echo "[start] MODEL='$MODEL' is a provider name, not an HF model -- adapter will use built-in default"
    ;;
esac

if [ ! -d "$VENV_DIR" ]; then
  echo "[start] venv not found: $VENV_DIR -- auto-installing..." >&2
  INSTALL_SCRIPT="$SCRIPT_DIR/tts-install.sh"
  if [ ! -f "$INSTALL_SCRIPT" ]; then
    echo "ERROR: install script not found: $INSTALL_SCRIPT" >&2
    exit 1
  fi
  TTS_MODEL="$MODEL" bash "$INSTALL_SCRIPT"
  if [ ! -d "$VENV_DIR" ]; then
    echo "ERROR: auto-install completed but venv still missing: $VENV_DIR" >&2
    exit 1
  fi
fi

# HF_HUB_OFFLINE must be set AFTER auto-install completes -- the installer
# needs network access to download models/voice assets from HuggingFace.
# (cloud codex P1: PR #1924)
case "$PROVIDER" in
  mlx-audio|qwen3-clone)
    export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"
    ;;
esac
echo "[start] resolved runtime: CAT_CAFE_HOME=$CAT_CAFE_HOME; venv=$VENV_DIR; python=python3; api=$API_SCRIPT; port=$PORT"
source "$VENV_DIR/bin/activate"

echo "Starting TTS server: provider=$PROVIDER, model=$MODEL, port=$PORT"
echo "[start] launching python: python3 $API_SCRIPT --model $MODEL --port $PORT"
set +e
TTS_PROVIDER="$PROVIDER" python3 "$API_SCRIPT" --model "$MODEL" --port "$PORT"
EXIT_CODE=$?
set -e
echo "[start] python exited with code $EXIT_CODE"
exit "$EXIT_CODE"
