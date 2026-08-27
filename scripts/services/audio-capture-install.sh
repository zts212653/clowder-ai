#!/usr/bin/env bash
# scripts/services/audio-capture-install.sh
# Install F195 audio capture, VAD, and CAM++ speaker-separation runtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AUDIO_PY="$REPO_ROOT/scripts/meeting-copilot/audio-service.py"
AUDIO_REQUIREMENTS="$REPO_ROOT/scripts/meeting-copilot/requirements.txt"

if [ ! -f "$AUDIO_PY" ] || [ ! -f "$AUDIO_REQUIREMENTS" ]; then
  echo "ERROR: audio-service.py not found at $AUDIO_PY" >&2
  echo "F195 audio-capture runtime or requirements are missing; refusing to install an unusable service." >&2
  exit 1
fi

SERVICE_LABEL="Audio Capture"
VENV_NAME="audio-capture-venv"
DISK_REQUIRED_GB=3
MODEL_ENV_VAR="_AUDIO_CAPTURE_NO_MODEL"
PIP_DEPS_ARM64="-r $AUDIO_REQUIREMENTS"
PIP_DEPS_OTHER="-r $AUDIO_REQUIREMENTS"
MODEL_LOADER_ARM64="skip"
MODEL_LOADER_OTHER="skip"

audio_capture_verify_speaker_inference() {
  PYTHONPATH="$REPO_ROOT/scripts/meeting-copilot" python -c \
    'from speaker_embedder import SpeakerEmbedder; print(SpeakerEmbedder().deep_health())'
}

POST_INSTALL_HOOK_ARM64="audio_capture_verify_speaker_inference"
POST_INSTALL_HOOK_OTHER="audio_capture_verify_speaker_inference"

# shellcheck source=./install-template.sh
source "$SCRIPT_DIR/install-template.sh"
install_service_main
