#!/usr/bin/env bash
# scripts/services/whisper-install.sh
# Install dependencies for Whisper ASR service (venv + mlx-whisper).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prereq-check.sh"
check_python3
source "$SCRIPT_DIR/../download-source-overrides.sh"
apply_manual_download_source_overrides

VENV_DIR="${HOME}/.cat-cafe/whisper-venv"

if [ ! -d "$VENV_DIR" ]; then
  echo "  创建 venv: $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg 未安装，Whisper ASR 需要 ffmpeg。"
  case "$(uname -s)" in
    Darwin) echo "  请运行: brew install ffmpeg" ;;
    Linux)  echo "  请运行: sudo apt install ffmpeg  # 或 dnf install ffmpeg" ;;
  esac
  exit 1
fi

echo "  安装依赖: mlx-whisper fastapi uvicorn python-multipart httpx[socks] huggingface_hub ..."
pip install --quiet mlx-whisper fastapi uvicorn python-multipart 'httpx[socks]' huggingface_hub

MODEL="${WHISPER_MODEL:-mlx-community/whisper-large-v3-turbo}"
echo "  预下载模型: $MODEL ..."
python3 -c "
import sys
from huggingface_hub import snapshot_download
try:
    snapshot_download(sys.argv[1])
    print('模型下载完成。')
except Exception as e:
    print(f'ERROR: 模型下载失败: {e}', file=sys.stderr)
    sys.exit(1)
" "$MODEL"
echo "安装完成。"
