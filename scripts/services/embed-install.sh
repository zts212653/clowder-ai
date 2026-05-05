#!/usr/bin/env bash
# scripts/services/embed-install.sh
# Install dependencies for Embedding service (venv + mlx-embeddings / sentence-transformers).
set -euo pipefail

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
  pip install --quiet mlx mlx-embeddings fastapi uvicorn numpy
  echo "  安装 fallback 依赖: sentence-transformers + torch ..."
  pip install --quiet sentence-transformers torch
else
  echo "  安装依赖: sentence-transformers + torch ..."
  pip install --quiet sentence-transformers torch fastapi uvicorn numpy
fi
echo "安装完成。"
