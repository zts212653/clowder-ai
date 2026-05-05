#!/usr/bin/env bash
# scripts/tts-install.sh
# Install dependencies for TTS service (venv + mlx-audio).
set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/tts-venv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/download-source-overrides.sh"
apply_manual_download_source_overrides

if [ ! -d "$VENV_DIR" ]; then
  echo "  创建 venv: $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

echo "  安装依赖: mlx-audio + misaki[zh] ..."
pip install --quiet mlx-audio 'misaki[zh]' fastapi uvicorn 'httpx[socks]' num2words spacy phonemizer
echo "安装完成。"
