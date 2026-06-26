#!/usr/bin/env bash
# scripts/services/tts-install.sh
# Install dependencies for TTS (venv + mlx-audio on Darwin arm64;
# edge-tts cloud / piper offline on other platforms).
# Declarative -- install-template.sh handles common pipeline (F190 service-install sub-scope).
# Non-arm64 path skips the generic snapshot_download loader because
# piper voice files don't live on HuggingFace as a HF repo -- they're
# raw .onnx / .onnx.json blobs. POST_INSTALL_HOOK_OTHER handles that.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICE_LABEL="TTS"
VENV_NAME="tts-venv"
DISK_REQUIRED_GB=2
MODEL_ENV_VAR="TTS_MODEL"
PIP_DEPS_ARM64="mlx-audio misaki[zh] fastapi uvicorn httpx[socks] num2words spacy phonemizer huggingface_hub[hf_xet]"
PIP_DEPS_OTHER="edge-tts fastapi uvicorn httpx[socks] huggingface_hub[hf_xet]"
MODEL_LOADER_OTHER="skip"
POST_INSTALL_HOOK_ARM64="tts_install_arm64_warmup"
POST_INSTALL_HOOK_OTHER="tts_install_non_arm64_extras"

tts_install_arm64_warmup() {
  case "${TTS_MODEL:-}" in
    edge-tts|sapi|piper|zh_CN-*|en_US-*|en_GB-*|*-piper)
      return 0
      ;;
  esac

  local warmup_voice="${TTS_WARMUP_VOICE:-zm_yunjian}"
  local warmup_dir
  warmup_dir="$(mktemp -d "${TMPDIR:-/tmp}/cat-cafe-tts-warmup.XXXXXX")"
  local hf_proxy_env=()
  if [ -n "${_CATCAFE_HF_PROXY_FOR_DOWNLOAD:-}" ]; then
    hf_proxy_env=(env "HTTP_PROXY=${_CATCAFE_HF_PROXY_FOR_DOWNLOAD}" "HTTPS_PROXY=${_CATCAFE_HF_PROXY_FOR_DOWNLOAD}")
    echo "  Using HF proxy for TTS voice warmup: ${_CATCAFE_HF_PROXY_FOR_DOWNLOAD}"
  fi

  echo "  Pre-warming TTS runtime assets: model=${TTS_MODEL} voice=${warmup_voice} ..."
  local status=0
  "${hf_proxy_env[@]+"${hf_proxy_env[@]}"}" python - "$TTS_MODEL" "$warmup_voice" "$warmup_dir" <<'PY' || status=$?
import os
import sys

os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")

from mlx_audio.tts.generate import generate_audio

model, voice, output_dir = sys.argv[1:4]
generate_audio(
    text="\u4f60\u597d",
    model=model,
    voice=voice,
    lang_code="z",
    output_path=output_dir,
)
print("TTS runtime warmup complete.")
PY
  rm -rf "$warmup_dir"
  if [ "$status" -ne 0 ]; then
    echo "ERROR: TTS runtime warmup failed for model=${TTS_MODEL} voice=${warmup_voice}" >&2
    exit "$status"
  fi
  echo "  TTS runtime assets ready."
}

# Non-arm64 TTS providers: piper (offline TTS via piper-tts + voice
# files), or cloud (edge-tts -- no local model required). Distinguishes
# by TTS_MODEL prefix / value. Called by install-template after the
# generic pip install completes; venv is already activated.
tts_install_non_arm64_extras() {
  case "$TTS_MODEL" in
    piper|zh_CN-*|en_US-*|en_GB-*|*-piper)
      local voice="$TTS_MODEL"
      [ "$voice" = "piper" ] && voice="zh_CN-huayan-medium"
      echo "  Installing piper-tts and downloading offline voice model: $voice ..."
      pip install --quiet piper-tts

      local piper_dir="${CAT_CAFE_HOME}/piper-models"
      mkdir -p "$piper_dir"

      local hf_base="${HF_ENDPOINT:-${HF_HUB_ENDPOINT:-https://huggingface.co}}"
      hf_base="${hf_base%/}"
      local base
      case "$voice" in
        zh_CN-huayan-medium) base="${hf_base}/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium" ;;
        en_US-amy-medium)    base="${hf_base}/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium" ;;
        en_US-lessac-medium) base="${hf_base}/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium" ;;
        en_GB-alan-medium)   base="${hf_base}/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium" ;;
        *)
          echo "ERROR: Unknown piper voice: ${voice}. Supported: zh_CN-huayan-medium, en_US-amy-medium, en_US-lessac-medium, en_GB-alan-medium" >&2
          exit 1
          ;;
      esac

      if [ ! -f "$piper_dir/${voice}.onnx" ]; then
        curl -fL --progress-bar "$base/${voice}.onnx" -o "$piper_dir/${voice}.onnx" \
          || { echo "ERROR: Failed to download $voice.onnx" >&2; exit 1; }
      fi
      if [ ! -f "$piper_dir/${voice}.onnx.json" ]; then
        curl -fL --progress-bar "$base/${voice}.onnx.json" -o "$piper_dir/${voice}.onnx.json" \
          || { echo "ERROR: Failed to download $voice.onnx.json" >&2; exit 1; }
      fi
      echo "  Piper voice model ready: $piper_dir/${voice}.onnx"
      ;;
    *)
      echo "  TTS backend: ${TTS_MODEL} (cloud-based, no local model download required)"
      ;;
  esac
}

# shellcheck source=./install-template.sh
source "$SCRIPT_DIR/install-template.sh"
install_service_main
