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

# Activate venv if it exists
if [ -d "$VENV_DIR" ]; then
  source "$VENV_DIR/bin/activate"
fi

# Check ffmpeg is available (mlx-whisper uses it to decode audio)
if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg not found. Run:"
  echo "  brew install ffmpeg"
  exit 1
fi

# Check mlx-whisper is installed
if ! python3 -c "import mlx_whisper" 2>/dev/null; then
  echo "ERROR: mlx-whisper not installed. Run:"
  echo "  pip install mlx-whisper"
  exit 1
fi

python3 "$SCRIPT_DIR/whisper-api.py" --model "$MODEL" --port "$PORT"
