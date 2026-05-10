#!/usr/bin/env bash
# scripts/services/tts-install.sh
# Install dependencies for TTS service (venv + mlx-audio).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prereq-check.sh"
check_python3
source "$SCRIPT_DIR/../download-source-overrides.sh"
apply_manual_download_source_overrides

VENV_DIR="${HOME}/.cat-cafe/tts-venv"

if [ ! -d "$VENV_DIR" ]; then
  echo "  创建 venv: $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

echo "  安装依赖: mlx-audio + misaki[zh] ..."
pip install --quiet mlx-audio 'misaki[zh]' fastapi uvicorn 'httpx[socks]' num2words spacy phonemizer huggingface_hub

TTS_MODEL="${TTS_MODEL:-mlx-community/Kokoro-82M-bf16}"
echo "  预下载模型: $TTS_MODEL ..."
python3 -c "
import sys
from huggingface_hub import snapshot_download
try:
    snapshot_download(sys.argv[1])
    print('模型下载完成。')
except Exception as e:
    print(f'ERROR: 模型下载失败: {e}', file=sys.stderr)
    sys.exit(1)
" "$TTS_MODEL"
echo "安装完成。"
