#!/usr/bin/env bash
# scripts/embed-server.sh
# Start local embedding server for Cat Cafe memory system (F102).
# Apple Silicon uses MLX by default; other platforms fall back to sentence-transformers.
#
# Usage:
#   ./scripts/embed-server.sh                                                    # default
#   EMBED_MODEL=mlx-community/Qwen3-Embedding-4B-4bit-DWQ ./scripts/embed-server.sh   # larger model
#   EMBED_DIM=512 ./scripts/embed-server.sh                                      # custom dim
#
# Env vars:
#   EMBED_PORT    — server port (default: 9880)
#   EMBED_MODEL   — model ID (default: mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ)
#   EMBED_DIM     — output dimension after MRL truncation (default: 768)
#
# Primary (Apple Silicon): pip install mlx mlx-embeddings fastapi uvicorn numpy 'transformers<5'
# Alternative (other platforms): pip install sentence-transformers torch fastapi uvicorn numpy
# First run downloads the model from HuggingFace (~335MB for 4-bit DWQ).

set -euo pipefail

VENV_DIR="${HOME}/.cat-cafe/embed-venv"
PORT="${EMBED_PORT:-9880}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"

# Create venv if missing, then activate
if [ ! -d "$VENV_DIR" ]; then
  echo "  创建 venv: $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"

install_mlx_deps() {
  pip install --quiet mlx mlx-embeddings fastapi uvicorn numpy 'transformers<5' 'huggingface-hub<1.0'
}

ensure_mlx_tokenizer_stack() {
  if python3 - <<'PY' 2>/dev/null; then
import mlx_embeddings.utils
from transformers import PreTrainedTokenizerBase
raise SystemExit(0 if hasattr(PreTrainedTokenizerBase, "batch_encode_plus") else 1)
PY
    return 0
  fi

  echo "  修复 MLX tokenizer stack: transformers<5 (batch_encode_plus compatibility) ..."
  pip install --quiet 'transformers<5' 'huggingface-hub<1.0'
}

# Auto-install dependencies (platform-aware)
if [ "$PLATFORM" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
  if ! python3 -c "import mlx_embeddings" 2>/dev/null; then
    echo "  安装依赖: mlx + mlx-embeddings ..."
    install_mlx_deps
  fi
  ensure_mlx_tokenizer_stack

  # sentence-transformers fallback is opt-in on Apple Silicon; the MPS path can
  # exhaust unified memory when MLX is broken.
  if [ "${EMBED_ALLOW_ST_FALLBACK:-0}" = "1" ] && ! python3 -c "import sentence_transformers" 2>/dev/null; then
    echo "  安装 opt-in fallback 依赖: sentence-transformers + torch ..."
    pip install --quiet sentence-transformers torch
  fi
else
  if ! python3 -c "import sentence_transformers" 2>/dev/null; then
    echo "  安装依赖: sentence-transformers + torch ..."
    pip install --quiet sentence-transformers torch fastapi uvicorn numpy
  fi
fi

echo "Starting Embedding server: port=$PORT"
python3 "$SCRIPT_DIR/embed-api.py" --port "$PORT"
