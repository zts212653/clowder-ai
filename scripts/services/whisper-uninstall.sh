#!/usr/bin/env bash
# scripts/whisper-uninstall.sh
# Remove Whisper ASR service virtual environment and dependencies.
set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/whisper-venv"

if [ ! -d "$VENV_DIR" ]; then
  echo "虚拟环境不存在: $VENV_DIR"
  exit 0
fi

echo "删除虚拟环境: $VENV_DIR ..."
rm -rf "$VENV_DIR"
echo "卸载完成。"
