#!/usr/bin/env bash
# scripts/whisper-server.sh
# Start local Whisper ASR server for Cat Cafe voice input (MLX backend).
#
# Usage:
#   ./scripts/whisper-server.sh                                            # default: large-v3-turbo
#   ./scripts/whisper-server.sh mlx-community/whisper-small                # smaller model
#
# Requires: pip install mlx-whisper fastapi uvicorn
# First run will download the model from HuggingFace (~3GB for large-v3-turbo).

set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/whisper-venv"
MODEL="${1:-mlx-community/whisper-large-v3-turbo}"
PORT="${WHISPER_PORT:-9876}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/download-source-overrides.sh"
apply_manual_download_source_overrides

# Create venv if missing, then activate
if [ ! -d "$VENV_DIR" ]; then
  echo "  创建 venv: $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

# Check ffmpeg is available (mlx-whisper uses it to decode audio)
if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg not found. Run:"
  echo "  brew install ffmpeg"
  exit 1
fi

# Auto-install mlx-whisper if missing
if ! python3 -c "import mlx_whisper" 2>/dev/null; then
  echo "  安装依赖: mlx-whisper fastapi uvicorn ..."
  pip install --quiet mlx-whisper fastapi uvicorn
fi

python3 "$SCRIPT_DIR/whisper-api.py" --model "$MODEL" --port "$PORT"
