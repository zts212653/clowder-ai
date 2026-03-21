#!/usr/bin/env bash
# scripts/llm-postprocess-server.sh
# Start local LLM post-processing server for Cat Cafe voice input (MLX backend).
#
# Pipeline position:  Whisper ASR → **LLM post-edit** → term dictionary → filler removal
#
# Usage:
#   ./scripts/llm-postprocess-server.sh                                            # default: Qwen3.5-35B-A3B MoE
#   ./scripts/llm-postprocess-server.sh mlx-community/Qwen3.5-35B-A3B-4bit        # explicit
#
# Requires: pip install mlx-vlm fastapi uvicorn pydantic
# First run will download the model from HuggingFace (~18GB for Qwen3.5-35B-A3B-4bit).

set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/llm-venv"
MODEL="${1:-mlx-community/Qwen3.5-35B-A3B-4bit}"
PORT="${LLM_POSTPROCESS_PORT:-9878}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/download-source-overrides.sh"
apply_manual_download_source_overrides

# Create venv if missing, then activate
if [ ! -d "$VENV_DIR" ]; then
  echo "  创建 venv: $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

# Ensure all dependencies are installed (pip is idempotent, skips installed packages)
pip install --quiet mlx-vlm "httpx[socks]" torchvision fastapi uvicorn pydantic

python3 "$SCRIPT_DIR/llm-postprocess-api.py" --model "$MODEL" --port "$PORT"
