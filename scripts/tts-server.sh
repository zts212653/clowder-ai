#!/usr/bin/env bash
# scripts/tts-server.sh
# Start local TTS server for Cat Cafe voice output.
#
# Usage:
#   ./scripts/tts-server.sh                                  # default: qwen3-clone + Qwen3-TTS Base (三猫声线)
#   ./scripts/tts-server.sh mlx-community/Kokoro-82M-bf16    # explicit Kokoro model
#   TTS_PROVIDER=mlx-audio ./scripts/tts-server.sh           # Kokoro-82M (legacy)
#   TTS_PROVIDER=edge-tts ./scripts/tts-server.sh            # edge-tts fallback
#
# Env vars:
#   TTS_PROVIDER  — "qwen3-clone" (default), "mlx-audio", or "edge-tts"
#   TTS_PORT      — server port (default: 9879)
#
# Requires (mlx-audio): pip install mlx-audio "misaki[zh]" fastapi uvicorn
# Requires (edge-tts):  pip install edge-tts fastapi uvicorn
# First run (mlx-audio) downloads the model from HuggingFace (~200MB for Kokoro-82M).

set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/tts-venv"
MODEL="${1:-mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16}"
PORT="${TTS_PORT:-9879}"
PROVIDER="${TTS_PROVIDER:-qwen3-clone}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/download-source-overrides.sh"
apply_manual_download_source_overrides

# Create venv if missing, then activate
if [ ! -d "$VENV_DIR" ]; then
  echo "  创建 venv: $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

# Provider-specific auto-install
if [ "$PROVIDER" = "mlx-audio" ] || [ "$PROVIDER" = "qwen3-clone" ]; then
  if ! python3 -c "import mlx_audio" 2>/dev/null; then
    echo "  安装依赖: mlx-audio + misaki[zh] ..."
    pip install --quiet mlx-audio 'misaki[zh]' fastapi uvicorn 'httpx[socks]' num2words spacy phonemizer
  fi
  if ! python3 -c "import misaki" 2>/dev/null; then
    echo "  安装依赖: misaki[zh] ..."
    pip install --quiet 'misaki[zh]'
  fi
elif [ "$PROVIDER" = "edge-tts" ]; then
  if ! python3 -c "import edge_tts" 2>/dev/null; then
    echo "  安装依赖: edge-tts ..."
    pip install --quiet edge-tts fastapi uvicorn
  fi
fi

echo "Starting TTS server: provider=$PROVIDER, model=$MODEL, port=$PORT"
TTS_PROVIDER="$PROVIDER" python3 "$SCRIPT_DIR/tts-api.py" --model "$MODEL" --port "$PORT"
