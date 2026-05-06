#!/usr/bin/env bash
# scripts/services/llm-postprocess-install.sh
# Install dependencies for LLM post-processing service (venv + mlx-vlm).
set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/llm-venv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../download-source-overrides.sh"
apply_manual_download_source_overrides

if [ ! -d "$VENV_DIR" ]; then
  echo "  创建 venv: $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

echo "  安装依赖: mlx-vlm fastapi uvicorn pydantic ..."
pip install --quiet mlx-vlm "httpx[socks]" torchvision fastapi uvicorn pydantic

MODEL="${LLM_POSTPROCESS_MODEL:-mlx-community/Qwen3.5-35B-A3B-4bit}"
echo "  预下载模型: $MODEL ..."
python3 -c "
import sys
from huggingface_hub import snapshot_download
snapshot_download(sys.argv[1])
print('模型下载完成。')
" "$MODEL"
echo "安装完成。"
