#!/usr/bin/env bash
# scripts/services/embed-install.sh
# Install dependencies for Embedding service (venv + mlx-embeddings /
# sentence-transformers). Pure declarative -- install-template.sh
# handles the actual pipeline (F190 service-install sub-scope).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Recipe preflight needs the same qualified interpreter as the install pipeline.
# PATH may contain an older python3 (or none) while the resolver has a supported Python.
# shellcheck source=./prereq-check.sh
source "$SCRIPT_DIR/prereq-check.sh"
check_python3

SERVICE_LABEL="Embedding"
VENV_NAME="embed-venv"
DISK_REQUIRED_GB=3
MODEL_ENV_VAR="EMBED_MODEL"
# Darwin arm64: MLX-native primary + sentence-transformers fallback so
# the embed-api.py runtime can pick either backend at startup. Other
# platforms: sentence-transformers + torch (CPU/CUDA).
# Keep transformers below v5 for mlx-embeddings tokenizer compatibility.
PIP_DEPS_ARM64="mlx mlx-embeddings sentence-transformers torch fastapi uvicorn numpy httpx[socks] transformers<5 huggingface-hub[hf_xet]<1.0"
PIP_DEPS_OTHER="sentence-transformers torch fastapi uvicorn numpy httpx[socks] transformers<5 huggingface-hub[hf_xet]<1.0"

# Pinned generations consume the same versioned recipe and verifier as runtime.
GENERATION="${EMBED_GENERATION:-$("$PYTHON3" "$SCRIPT_DIR/embedding_generation.py" --field generation)}"
RECIPE_MODEL="$("$PYTHON3" "$SCRIPT_DIR/embedding_generation.py" --generation "$GENERATION" --field model)"
if [ -n "$RECIPE_MODEL" ]; then
  "$PYTHON3" "$SCRIPT_DIR/embedding_generation_install.py" --generation "$GENERATION" --check-platform
  REQUIRED_PYTHON_ARCH=arm64
  DISK_REQUIRED_GB=12
  PIP_DEPS_ARM64=""
  MODEL_LOADER_ARM64=skip
  install_pinned_embedding() {
    "$CAT_CAFE_HOME/$VENV_NAME/bin/python" "$SCRIPT_DIR/embedding_generation_install.py" --generation "$GENERATION" --execute
  }
  POST_INSTALL_HOOK_ARM64=install_pinned_embedding
fi

# shellcheck source=./install-template.sh
source "$SCRIPT_DIR/install-template.sh"
install_service_main
