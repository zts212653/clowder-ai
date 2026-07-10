#!/usr/bin/env bash
# scripts/services/whisper-server.sh
# Start local ASR server for Clowder AI voice input.
# whisper-api.py handles all backends (Qwen3-ASR / Whisper) based on model name.
#
# Usage:
#   WHISPER_MODEL=mlx-community/Qwen3-ASR-1.7B-8bit ./scripts/services/whisper-server.sh
#   WHISPER_MODEL=mlx-community/whisper-large-v3-turbo ./scripts/services/whisper-server.sh
#
# Prerequisites: run scripts/services/whisper-install.sh first.

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
if [ -z "$MODEL" ]; then
  echo "ERROR: WHISPER_MODEL env var (or positional arg) required -- backend specifies model, no fallback default." >&2
  exit 1
fi

API_SCRIPT="$SCRIPT_DIR/whisper-api.py"
PORT="${WHISPER_PORT:-9876}"
echo "[start] resolved runtime: CAT_CAFE_HOME=$CAT_CAFE_HOME; venv=$VENV_DIR; python=python3; api=$API_SCRIPT; port=$PORT"

# Venv architecture compatibility check (#1061).
# Normal startup (env bridge -> installed:true -> server) skips the
# installer. A stale Rosetta venv (x86_64 Python) with an arm64
# resolver means wrong-arch MLX wheels at runtime. Detect and remove
# so the auto-install block below rebuilds with the correct Python.
if [ -d "$VENV_DIR" ] && [ -x "$VENV_DIR/bin/python3" ]; then
  # shellcheck source=./python-resolve.sh
  source "$SCRIPT_DIR/python-resolve.sh"
  _current_arch="unknown"
  if _try_system_pythons 2>/dev/null \
     || _try_uv 2>/dev/null || _try_pyenv 2>/dev/null || _try_brew 2>/dev/null \
     || _try_project_python 2>/dev/null || _try_legacy_project_python 2>/dev/null; then
    _current_arch="$RESOLVED_PYTHON_ARCH"
  fi
  if [ "$_current_arch" != "unknown" ]; then
    _venv_arch="$("$VENV_DIR/bin/python3" -c \
      'import platform; print(platform.machine().lower())' 2>/dev/null || echo unknown)"
    if [ "$_venv_arch" != "unknown" ] && [ "$_venv_arch" != "$_current_arch" ]; then
      echo "[start] venv arch ($_venv_arch) != resolver arch ($_current_arch) -- reinstalling..." >&2
      rm -rf "$VENV_DIR"
    fi
  fi
fi

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
