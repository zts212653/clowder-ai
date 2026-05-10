#!/usr/bin/env bash
# scripts/services/embed-install.sh
# Install dependencies for Embedding service (venv + mlx-embeddings / sentence-transformers).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prereq-check.sh"
check_python3
source "$SCRIPT_DIR/../download-source-overrides.sh"
apply_manual_download_source_overrides

VENV_DIR="${HOME}/.cat-cafe/embed-venv"
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"

if [ ! -d "$VENV_DIR" ]; then
  echo "  创建 venv: $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

if [ "$PLATFORM" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
  echo "  安装依赖: mlx + mlx-embeddings ..."
  pip install --quiet mlx mlx-embeddings fastapi uvicorn numpy huggingface_hub
  echo "  安装 fallback 依赖: sentence-transformers + torch ..."
  pip install --quiet sentence-transformers torch
else
  echo "  安装依赖: sentence-transformers + torch ..."
  pip install --quiet sentence-transformers torch fastapi uvicorn numpy huggingface_hub
fi

MODEL="${EMBED_MODEL:-mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ}"
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
