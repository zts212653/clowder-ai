#!/usr/bin/env bash
# scripts/services/tts-server.sh
# Start local TTS server for Cat Cafe voice output.
#
# Usage:
#   ./scripts/services/tts-server.sh                                  # default: qwen3-clone + Qwen3-TTS Base
#   ./scripts/services/tts-server.sh mlx-community/Kokoro-82M-bf16    # explicit Kokoro model
#   TTS_PROVIDER=edge-tts ./scripts/services/tts-server.sh            # edge-tts fallback
#
# Prerequisites: run scripts/services/tts-install.sh first.

set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/tts-venv"
MODEL="${TTS_MODEL:-${1:-mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16}}"
PORT="${TTS_PORT:-9879}"
PROVIDER="${TTS_PROVIDER:-qwen3-clone}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$VENV_DIR" ]; then
  echo "ERROR: 虚拟环境不存在: $VENV_DIR"
  echo "请先运行安装: scripts/services/tts-install.sh"
  exit 1
fi
source "$VENV_DIR/bin/activate"

echo "Starting TTS server: provider=$PROVIDER, model=$MODEL, port=$PORT"
TTS_PROVIDER="$PROVIDER" python3 "$SCRIPT_DIR/tts-api.py" --model "$MODEL" --port "$PORT"
