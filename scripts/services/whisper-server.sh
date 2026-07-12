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
# Model-aware: MLX models (Qwen3-ASR) require arm64 Python/venv.
# A working arm64 MLX venv must NOT be deleted just because the
# resolver found x86_64 Python on PATH -- the venv's own python3
# symlink is arm64 and works independently (maintainer P1 review).
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
      _delete_venv=1
      case "$MODEL" in
        *Qwen3-ASR*|mlx-community/*)
          # MLX model + arm64 venv: verify deps still work before keeping
          if { [ "$_venv_arch" = "arm64" ] || [ "$_venv_arch" = "aarch64" ]; } \
             && { "$VENV_DIR/bin/python3" -c "import mlx_audio" 2>/dev/null \
                  || "$VENV_DIR/bin/python3" -c "import mlx_whisper" 2>/dev/null; }; then
            _delete_venv=0
            echo "[start] keeping arm64 venv for MLX model $MODEL (PATH Python is $_current_arch)." >&2
          fi
          ;;
      esac
      if [ "$_delete_venv" = "1" ]; then
        echo "[start] venv arch ($_venv_arch) != resolver arch ($_current_arch) -- reinstalling..." >&2
        rm -rf "$VENV_DIR"
      fi
    fi
  fi
fi

# Backend dependency check (#863): same-arch venv may still lack deps
# for the current model after a model switch (e.g. existing mlx-whisper
# venv reused after env bridge migrates to Qwen which needs mlx-audio).
# Probe the model's primary import; mirrors whisper-api.py startup chain.
if [ -d "$VENV_DIR" ] && [ -x "$VENV_DIR/bin/python3" ]; then
  _dep_ok=1
  case "$MODEL" in
    *Qwen3-ASR*)
      # Qwen requires mlx-audio, no fallback in whisper-api.py
      "$VENV_DIR/bin/python3" -c "import mlx_audio" 2>/dev/null || _dep_ok=0 ;;
    *)
      # Non-Qwen: mlx_whisper or faster_whisper (fallback chain)
      "$VENV_DIR/bin/python3" -c "import mlx_whisper" 2>/dev/null \
        || "$VENV_DIR/bin/python3" -c "import faster_whisper" 2>/dev/null \
        || _dep_ok=0 ;;
  esac
  if [ "$_dep_ok" = "0" ]; then
    echo "[start] venv missing backend deps for $MODEL -- reinstalling..." >&2
    rm -rf "$VENV_DIR"
  fi
fi

if [ ! -d "$VENV_DIR" ]; then
  # Model-arch gate: MLX models require arm64 Python. Fail fast before
  # creating a venv with incompatible deps (#1061 maintainer P1).
  case "$MODEL" in
    *Qwen3-ASR*|mlx-community/*)
      if [ -z "${RESOLVED_PYTHON_ARCH:-}" ]; then
        # No venv existed -> resolver wasn't called yet; resolve now.
        # shellcheck source=./python-resolve.sh
        source "$SCRIPT_DIR/python-resolve.sh"
        _try_system_pythons 2>/dev/null \
          || _try_uv 2>/dev/null || _try_pyenv 2>/dev/null || _try_brew 2>/dev/null \
          || _try_project_python 2>/dev/null || _try_legacy_project_python 2>/dev/null \
          || true
      fi
      _pa="${RESOLVED_PYTHON_ARCH:-unknown}"
      if [ "$_pa" != "unknown" ] && [ "$_pa" != "arm64" ] && [ "$_pa" != "aarch64" ]; then
        echo "ERROR: $MODEL requires arm64 Python (MLX), but resolved Python is $_pa." >&2
        echo "  To fix: install arm64 Python ('brew install python@3.12' in a native terminal)" >&2
        echo "  Or switch model: WHISPER_MODEL=large-v3-turbo" >&2
        exit 1
      fi
      ;;
  esac
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
