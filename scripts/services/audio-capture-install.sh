#!/usr/bin/env bash
# scripts/services/audio-capture-install.sh
# Install dependencies for F195 audio-capture service (venv + sounddevice + fastapi).
# Audio-capture has no ML model -- uses MODEL_LOADER=skip to bypass the
# model-download step the template normally runs for whisper/tts/embed/llm.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AUDIO_PY="$REPO_ROOT/scripts/meeting-copilot/audio-service.py"

if [ ! -f "$AUDIO_PY" ]; then
  echo "ERROR: audio-service.py not found at $AUDIO_PY" >&2
  echo "F195 audio-capture runtime is not bundled in this checkout; refusing to install an unusable service." >&2
  exit 1
fi

SERVICE_LABEL="Audio Capture"
VENV_NAME="audio-capture-venv"
DISK_REQUIRED_GB=1
# Dummy MODEL_ENV_VAR -- template requires the variable name be declared
# but it's never read because MODEL_LOADER_* is "skip" below. Audio
# capture has no model concept (recording + uploading raw audio frames).
MODEL_ENV_VAR="_AUDIO_CAPTURE_NO_MODEL"
# Same deps on every platform -- sounddevice wraps PortAudio which has
# prebuilt wheels for darwin/linux/win32 across arm64/x64. fastapi +
# uvicorn provide the HTTP layer the audio-proxy.ts routes proxy into.
PIP_DEPS_ARM64="sounddevice fastapi uvicorn numpy"
PIP_DEPS_OTHER="sounddevice fastapi uvicorn numpy"
MODEL_LOADER_ARM64="skip"
MODEL_LOADER_OTHER="skip"

# shellcheck source=./install-template.sh
source "$SCRIPT_DIR/install-template.sh"
install_service_main
