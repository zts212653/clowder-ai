#!/usr/bin/env bash
# scripts/services/llm-postprocess-install.sh
# Install dependencies for LLM post-processing (venv + mlx-vlm on
# Darwin arm64; transformers + torch on other platforms).
# Declarative -- install-template.sh handles common pipeline (F190 service-install sub-scope).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICE_LABEL="LLM post-process"
VENV_NAME="llm-venv"
DISK_REQUIRED_GB=25
MODEL_ENV_VAR="LLM_POSTPROCESS_MODEL"
PIP_DEPS_ARM64="mlx-vlm httpx[socks] torchvision fastapi uvicorn pydantic huggingface_hub[hf_xet]"
PIP_DEPS_OTHER="transformers torch fastapi uvicorn pydantic httpx[socks] huggingface_hub[hf_xet]"

# shellcheck source=./install-template.sh
source "$SCRIPT_DIR/install-template.sh"
install_service_main
