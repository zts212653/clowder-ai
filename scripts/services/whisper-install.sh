#!/usr/bin/env bash
# scripts/services/whisper-install.sh
# Install dependencies for Whisper ASR service (venv + mlx-whisper).
set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/whisper-venv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../download-source-overrides.sh"
apply_manual_download_source_overrides

if [ ! -d "$VENV_DIR" ]; then
  echo "  创建 venv: $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

if ! command -v ffmpeg &>/dev/null; then
  echo "WARNING: ffmpeg not found. Please run: brew install ffmpeg"
fi

echo "  安装依赖: mlx-whisper fastapi uvicorn python-multipart httpx[socks] ..."
pip install --quiet mlx-whisper fastapi uvicorn python-multipart 'httpx[socks]'

MODEL="${WHISPER_MODEL:-mlx-community/whisper-large-v3-turbo}"
echo "  预下载模型: $MODEL ..."
python3 -c "
import sys
from huggingface_hub import snapshot_download
snapshot_download(sys.argv[1])
print('模型下载完成。')
" "$MODEL"
echo "安装完成。"
