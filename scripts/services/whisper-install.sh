#!/usr/bin/env bash
# scripts/services/whisper-install.sh
# Install dependencies for Whisper ASR (venv + mlx-whisper / faster-whisper).
# Pure declarative -- install-template.sh handles the actual pipeline (F190 service-install sub-scope).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICE_LABEL="Whisper ASR"
VENV_NAME="whisper-venv"
DISK_REQUIRED_GB=4
MODEL_ENV_VAR="WHISPER_MODEL"
# Darwin arm64 uses mlx-whisper (native, GPU-accelerated). Other
# platforms use faster-whisper (CTranslate2, CPU int8). The loader keeps
# faster-whisper model aliases (for example "base") but downloads through
# huggingface_hub.snapshot_download before validating with WhisperModel().
PIP_DEPS_ARM64="mlx-whisper fastapi uvicorn python-multipart httpx[socks] huggingface_hub[hf_xet]"
PIP_DEPS_OTHER="faster-whisper fastapi uvicorn python-multipart httpx[socks] huggingface_hub[hf_xet]"
MODEL_LOADER_OTHER="faster_whisper"
PRE_CHECK_FFMPEG=1

# shellcheck source=./install-template.sh
source "$SCRIPT_DIR/install-template.sh"
install_service_main
