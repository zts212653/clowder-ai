#!/usr/bin/env bash
# scripts/embed-server.sh
# Start local embedding server for Cat Cafe memory system (F102).
#
# Usage:
#   ./scripts/embed-server.sh
#   EMBED_MODEL=mlx-community/Qwen3-Embedding-4B-4bit-DWQ ./scripts/embed-server.sh
#   EMBED_DIM=512 ./scripts/embed-server.sh
#
# Prerequisites: run scripts/embed-install.sh first.

set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/embed-venv"
PORT="${EMBED_PORT:-9880}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$VENV_DIR" ]; then
  echo "ERROR: 虚拟环境不存在: $VENV_DIR"
  echo "请先运行安装: scripts/embed-install.sh"
  exit 1
fi
source "$VENV_DIR/bin/activate"

echo "Starting Embedding server: port=$PORT"
python3 "$SCRIPT_DIR/embed-api.py" --port "$PORT"
