#!/usr/bin/env bash
# scripts/services/tts-install.sh
# Install dependencies for TTS service (venv + mlx-audio).
set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/tts-venv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../download-source-overrides.sh"
apply_manual_download_source_overrides

if [ ! -d "$VENV_DIR" ]; then
  echo "  创建 venv: $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

echo "  安装依赖: mlx-audio + misaki[zh] ..."
pip install --quiet mlx-audio 'misaki[zh]' fastapi uvicorn 'httpx[socks]' num2words spacy phonemizer

TTS_MODEL="${TTS_MODEL:-mlx-community/Kokoro-82M-bf16}"
echo "  预下载模型: $TTS_MODEL ..."
python3 -c "
import sys
from huggingface_hub import snapshot_download
snapshot_download(sys.argv[1])
print('模型下载完成。')
" "$TTS_MODEL"
echo "安装完成。"
