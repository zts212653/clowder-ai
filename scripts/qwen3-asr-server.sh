#!/usr/bin/env bash
# scripts/qwen3-asr-server.sh
# Start local Qwen3-ASR server for Cat Cafe voice input (MLX backend).
# Drop-in replacement for whisper-server.sh — same port, same API.
#
# Usage:
#   ./scripts/qwen3-asr-server.sh                                              # default: 8bit
#   ./scripts/qwen3-asr-server.sh mlx-community/Qwen3-ASR-1.7B-4bit          # smaller model
#
# Requires: pip install mlx-audio fastapi uvicorn python-multipart
# First run will download the model from HuggingFace (~2.5GB for 8bit).

set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/asr-venv"
MODEL="${1:-mlx-community/Qwen3-ASR-1.7B-8bit}"
PORT="${WHISPER_PORT:-9876}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/download-source-overrides.sh"
apply_manual_download_source_overrides

# Create venv if it doesn't exist
if [ ! -d "$VENV_DIR" ]; then
  echo "Creating ASR venv at $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
  source "$VENV_DIR/bin/activate"
  pip install -U pip
  pip install mlx-audio fastapi uvicorn python-multipart
else
  source "$VENV_DIR/bin/activate"
fi

# Check ffmpeg is available (mlx-audio uses it to decode audio)
if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg not found. Run:"
  echo "  brew install ffmpeg"
  exit 1
fi

# Check mlx-audio is installed
if ! python3 -c "import mlx_audio" 2>/dev/null; then
  echo "ERROR: mlx-audio not installed. Run:"
  echo "  source ${VENV_DIR}/bin/activate"
  echo "  pip install mlx-audio"
  exit 1
fi

echo "=== Starting Qwen3-ASR (replaces Whisper) ==="
echo "Model: $MODEL"
echo "Port: $PORT"
echo ""

python3 "$SCRIPT_DIR/qwen3-asr-api.py" --model "$MODEL" --port "$PORT"
