#!/usr/bin/env bash
# scripts/services/whisper-install.sh
# Install dependencies for ASR service (Qwen3-ASR or Whisper backend).
# Detects the selected model and installs the appropriate ML framework:
#   - Qwen3-ASR models -> mlx-audio (Apple Silicon only)
#   - Whisper models   -> mlx-whisper (arm64) / faster-whisper (other)
# Pure declarative -- install-template.sh handles the actual pipeline.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODEL_ENV_VAR="WHISPER_MODEL"
VENV_NAME="whisper-venv"
DISK_REQUIRED_GB=4
PRE_CHECK_FFMPEG=1

# Detect backend from model name (#863: unified ASR service)
_model="${WHISPER_MODEL:-}"
if [[ "$_model" == *"Qwen3-ASR"* ]]; then
  SERVICE_LABEL="Qwen3 ASR"
  PIP_DEPS_ARM64="mlx-audio fastapi uvicorn python-multipart httpx[socks] huggingface_hub[hf_xet]"
else
  SERVICE_LABEL="Whisper ASR"
  PIP_DEPS_ARM64="mlx-whisper fastapi uvicorn python-multipart httpx[socks] huggingface_hub[hf_xet]"
fi

# Non-arm64 platforms always use faster-whisper (Qwen3-ASR is MLX-only,
# the recommendation matrix never offers it on non-arm64).
PIP_DEPS_OTHER="faster-whisper fastapi uvicorn python-multipart httpx[socks] huggingface_hub[hf_xet]"
MODEL_LOADER_OTHER="faster_whisper"

# MLX models require arm64 Python -- declare contract for install-template.
# install-template.sh rejects incompatible interpreters before touching venv.
if [[ "$_model" == *"Qwen3-ASR"* ]] || [[ "$_model" == mlx-community/* ]]; then
  REQUIRED_PYTHON_ARCH="arm64"
fi

# shellcheck source=./install-template.sh
source "$SCRIPT_DIR/install-template.sh"
install_service_main
