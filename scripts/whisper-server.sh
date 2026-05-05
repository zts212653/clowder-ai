#!/usr/bin/env bash
# scripts/whisper-server.sh
# Start local Whisper ASR server for Cat Cafe voice input (MLX backend).
#
# Usage:
#   ./scripts/whisper-server.sh                                            # default: large-v3-turbo
#   ./scripts/whisper-server.sh mlx-community/whisper-small                # smaller model
#
# Prerequisites: run scripts/whisper-install.sh first.
# First run will download the model from HuggingFace (~3GB for large-v3-turbo).

set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/whisper-venv"
MODEL="${1:-mlx-community/whisper-large-v3-turbo}"
PORT="${WHISPER_PORT:-9876}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$VENV_DIR" ]; then
  echo "ERROR: 虚拟环境不存在: $VENV_DIR"
  echo "请先运行安装: scripts/whisper-install.sh"
  exit 1
fi
source "$VENV_DIR/bin/activate"

if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg not found. Run:"
  echo "  brew install ffmpeg"
  exit 1
fi

python3 "$SCRIPT_DIR/whisper-api.py" --model "$MODEL" --port "$PORT"
