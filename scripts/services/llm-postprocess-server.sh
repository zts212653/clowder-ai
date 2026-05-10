#!/usr/bin/env bash
# scripts/services/llm-postprocess-server.sh
# Start local LLM post-processing server for Cat Cafe voice input (MLX backend).
#
# Pipeline position:  Whisper ASR → **LLM post-edit** → term dictionary → filler removal
#
# Usage:
#   ./scripts/services/llm-postprocess-server.sh                                            # default: Qwen3.5-35B-A3B MoE
#   ./scripts/services/llm-postprocess-server.sh mlx-community/Qwen3.5-35B-A3B-4bit        # explicit
#
# Prerequisites: run scripts/services/llm-postprocess-install.sh first.

set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/llm-venv"
MODEL="${LLM_POSTPROCESS_MODEL:-${1:-mlx-community/Qwen3.5-35B-A3B-4bit}}"
PORT="${LLM_POSTPROCESS_PORT:-9878}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$VENV_DIR" ]; then
  echo "ERROR: 虚拟环境不存在: $VENV_DIR"
  echo "请先运行安装: scripts/services/llm-postprocess-install.sh"
  exit 1
fi
source "$VENV_DIR/bin/activate"

python3 "$SCRIPT_DIR/llm-postprocess-api.py" --model "$MODEL" --port "$PORT"
