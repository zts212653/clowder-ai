#!/usr/bin/env bash
# scripts/services/embed-server.sh
# Start local embedding server for Cat Cafe memory system (F102).
#
# Usage:
#   ./scripts/services/embed-server.sh
#   EMBED_MODEL=mlx-community/Qwen3-Embedding-4B-4bit-DWQ ./scripts/services/embed-server.sh
#   EMBED_DIM=512 ./scripts/services/embed-server.sh
#
# Prerequisites: run scripts/services/embed-install.sh first.

set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/embed-venv"
PORT="${EMBED_PORT:-9880}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$VENV_DIR" ]; then
  echo "ERROR: 虚拟环境不存在: $VENV_DIR"
  echo "请先运行安装: scripts/services/embed-install.sh"
  exit 1
fi
source "$VENV_DIR/bin/activate"

echo "Starting Embedding server: port=$PORT"
python3 "$SCRIPT_DIR/embed-api.py" --port "$PORT"
