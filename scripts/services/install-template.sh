#!/usr/bin/env bash
# scripts/services/install-template.sh
#
# Unified install pipeline for ML sidecar services. Per-service install
# scripts declare their differences as environment variables, then source
# this template and call `install_service_main`. Handles everything
# common: prereq check, venv creation, pip install (with retry policy
# inherited from pip itself), model preload with explicit retry +
# extended HF timeout, output logging.
#
# Why: PR #674 had 4 install scripts (~70-100 lines each) that were
# ~85% duplicate. Each bug fix had to land in 4 places, and one
# inconsistency (e.g. retry policy in 3 of 4) caused real user-visible
# bugs ("embedding installs fine but whisper fails on same machine").
# F190 service-install sub-scope collapses the duplication so one pipeline change = all services
# get it.
#
# CONTRACT (caller exports BEFORE sourcing):
#
#   SERVICE_LABEL          (required) -- human label for log lines.
#   VENV_NAME              (required) -- venv dir name under
#                                       $CAT_CAFE_HOME (e.g.
#                                       "whisper-venv").
#   DISK_REQUIRED_GB       (required) -- int.
#   MODEL_ENV_VAR          (required) -- name of the env var that
#                                       holds the model id (e.g.
#                                       "WHISPER_MODEL"). Template
#                                       reads ${!MODEL_ENV_VAR} --
#                                       fails fast if unset.
#   PIP_DEPS_ARM64         (required) -- pip deps for Darwin arm64,
#                                       space-separated. Pass empty
#                                       string if path unused.
#   PIP_DEPS_OTHER         (required) -- pip deps for non-arm64 path.
#
# OPTIONAL inputs:
#
#   PRE_CHECK_FFMPEG=1            -- require ffmpeg on PATH before
#                                   touching venv (whisper).
#
#   MODEL_LOADER_ARM64="snapshot"    -- model loader strategy for arm64;
#   MODEL_LOADER_OTHER="snapshot"      one of:
#                                       "snapshot"        snapshot_download
#                                       "faster_whisper"  snapshot_download
#                                                         with faster-whisper
#                                                         alias resolution,
#                                                         then WhisperModel
#                                                         runtime load
#                                       "skip"            don't preload --
#                                                         caller hook
#                                                         handles it (tts
#                                                         piper voice).
#                                     Defaults to "snapshot" each.
#
#   POST_INSTALL_HOOK_ARM64=fn    -- bash function (in caller scope) to
#   POST_INSTALL_HOOK_OTHER=fn      call after the chosen model loader
#                                   completes. Used for tts piper voice
#                                   file download on non-arm64.
#
# After sourcing, caller MUST call `install_service_main`.

set -euo pipefail

# shellcheck source=./proxy-env.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/proxy-env.sh"
normalize_socks_proxy_env

install_service_main() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"

  : "${SERVICE_LABEL:?install-template: SERVICE_LABEL is required}"
  : "${VENV_NAME:?install-template: VENV_NAME is required}"
  : "${DISK_REQUIRED_GB:?install-template: DISK_REQUIRED_GB is required}"
  : "${MODEL_ENV_VAR:?install-template: MODEL_ENV_VAR is required}"
  : "${PIP_DEPS_ARM64:?install-template: PIP_DEPS_ARM64 is required (empty string OK if unused)}"
  : "${PIP_DEPS_OTHER:?install-template: PIP_DEPS_OTHER is required (empty string OK if unused)}"

  # 1. Prereqs: python + disk. Network checks run after manual
  # download-source overrides so offline/mirror installs can preflight
  # against the operator-selected endpoint.
  # shellcheck source=./prereq-check.sh
  source "$script_dir/prereq-check.sh"
  check_python3
  check_disk_space "$DISK_REQUIRED_GB"

  # 2. Manual download-source overrides (user-supplied PIP / HF
  # endpoint overrides via .env or env). Best-effort -- file may not
  # exist in all repos.
  if [ -f "$script_dir/../download-source-overrides.sh" ]; then
    # shellcheck source=../download-source-overrides.sh
    source "$script_dir/../download-source-overrides.sh"
    apply_manual_download_source_overrides
  fi
  check_network

  # 3. Platform detection -- picks the deps + model loader.
  local platform arch
  platform="$(uname -s)"
  arch="$(uname -m)"
  local is_darwin_arm64=0
  [ "$platform" = "Darwin" ] && [ "$arch" = "arm64" ] && is_darwin_arm64=1

  # 4. Pre-checks (optional binary requirements).
  if [ "${PRE_CHECK_FFMPEG:-0}" = "1" ]; then
    if ! command -v ffmpeg >/dev/null 2>&1; then
      echo "ERROR: ffmpeg not installed; $SERVICE_LABEL requires ffmpeg." >&2
      case "$platform" in
        Darwin) echo "  Run: brew install ffmpeg" >&2 ;;
        Linux)  echo "  Run: sudo apt install ffmpeg  # or dnf install ffmpeg" >&2 ;;
      esac
      exit 1
    fi
  fi

  # 5. Venv create (idempotent).
  local venv_dir="${CAT_CAFE_HOME}/${VENV_NAME}"
  if [ ! -d "$venv_dir" ]; then
    echo "  Creating venv: $venv_dir ..."
    "$PYTHON3" -m venv "$venv_dir" || { echo "ERROR: venv creation failed" >&2; exit 1; }
  fi
  # shellcheck source=/dev/null
  source "$venv_dir/bin/activate"

  echo "  Upgrading pip ..."
  pip install --quiet -U pip

  # 6. pip install. Empty deps string = caller intentionally has no
  # pip deps on this platform branch (rare but supported).
  local pip_deps loader hook
  if [ "$is_darwin_arm64" = "1" ]; then
    pip_deps="$PIP_DEPS_ARM64"
    loader="${MODEL_LOADER_ARM64:-snapshot}"
    hook="${POST_INSTALL_HOOK_ARM64:-}"
  else
    pip_deps="$PIP_DEPS_OTHER"
    loader="${MODEL_LOADER_OTHER:-snapshot}"
    hook="${POST_INSTALL_HOOK_OTHER:-}"
  fi
  if [ -n "$pip_deps" ]; then
    echo "  Installing dependencies: $pip_deps ..."
    # shellcheck disable=SC2086
    pip install --quiet $pip_deps
  fi

  # 7. Model preload (with explicit retry + extended HF timeout).
  # MODEL_ENV_VAR holds the NAME of the env var; we look up its value.
  # `${!var}` is bash indirection -- safe under `set -u` only when the
  # referenced var is defined, so we do an explicit defined-check first.
  local model_value=""
  if eval "[ -n \"\${${MODEL_ENV_VAR}:-}\" ]"; then
    eval "model_value=\"\$${MODEL_ENV_VAR}\""
  fi
  if [ "$loader" != "skip" ]; then
    if [ -z "$model_value" ]; then
      echo "ERROR: $MODEL_ENV_VAR not set. Trigger via the console install button (auto-picks per scripts/services/recommendation-matrix.yaml), or manually run $MODEL_ENV_VAR=<model-id> bash $0" >&2
      exit 1
    fi
    echo "  Pre-downloading model: $model_value ..."
    _install_template_load_model "$venv_dir" "$loader" "$model_value"
  fi

  # 8. Post-install hook (e.g. piper voice file download).
  if [ -n "$hook" ]; then
    "$hook"
  fi

  echo "Installation complete."
}

_install_template_load_model() {
  # Args: venv_dir, loader, model_id
  # Runs the venv Python with explicit retry + HF_HUB_DOWNLOAD_TIMEOUT=60.
  # Single inline Python script per loader because we want both retry +
  # loader-specific entry point (snapshot_download vs WhisperModel)
  # without spawning multiple processes.
  #
  # Proxy: prereq-check.sh already decided whether HuggingFace needs
  # the system proxy (HF probe via candidate -> exports
  # _CATCAFE_HF_PROXY_FOR_DOWNLOAD). We just consume that decision
  # here, per-call, so pip install (earlier step) goes direct via the
  # NO_PROXY classification and only HF model download gets the
  # proxy. No second detection inside Python -- single source of
  # truth lives in prereq-check.
  local venv_dir="$1"
  local loader="$2"
  local model_id="$3"

  local hf_proxy_env=()
  if [ -n "${_CATCAFE_HF_PROXY_FOR_DOWNLOAD:-}" ]; then
    hf_proxy_env=(env "HTTP_PROXY=${_CATCAFE_HF_PROXY_FOR_DOWNLOAD}" "HTTPS_PROXY=${_CATCAFE_HF_PROXY_FOR_DOWNLOAD}")
    echo "  Using HF proxy: ${_CATCAFE_HF_PROXY_FOR_DOWNLOAD} (only for this model-download subprocess)"
  fi

  case "$loader" in
    snapshot)
      "${hf_proxy_env[@]+"${hf_proxy_env[@]}"}" "$venv_dir/bin/python" -c "
import sys, time, os, traceback
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '60')
# Diagnostic: surface the env vars that affect HF download path so log
# users can see exactly what the child saw. Stop blaming network until
# this evidence rules out script-side env propagation gaps.
print('[hf-download diag] env snapshot:', file=sys.stderr)
for _k in ('HF_ENDPOINT', 'HF_HUB_ENDPOINT', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'HF_HUB_DOWNLOAD_TIMEOUT'):
    print(f'[hf-download diag]   {_k}={os.environ.get(_k, \"<unset>\")}', file=sys.stderr)
try:
    import huggingface_hub as _hh
    print(f'[hf-download diag] huggingface_hub={_hh.__version__}', file=sys.stderr)
except Exception:
    pass
from huggingface_hub import snapshot_download
max_attempts = 3
for attempt in range(1, max_attempts + 1):
    try:
        snapshot_download(sys.argv[1])
        print('Model download complete.')
        sys.exit(0)
    except Exception as e:
        print(f'  Download attempt {attempt}/{max_attempts} failed: {type(e).__name__}: {e}', file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        if attempt < max_attempts:
            wait = 5 * attempt
            print(f'  Retrying in {wait}s...', file=sys.stderr)
            time.sleep(wait)
print(f'ERROR: Model download failed after {max_attempts} attempts', file=sys.stderr)
sys.exit(1)
" "$model_id"
      ;;
    faster_whisper)
      "${hf_proxy_env[@]+"${hf_proxy_env[@]}"}" "$venv_dir/bin/python" -c "
import sys, time, os, traceback
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '60')
print('[hf-download diag] env snapshot:', file=sys.stderr)
for _k in ('HF_ENDPOINT', 'HF_HUB_ENDPOINT', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'HF_HUB_DOWNLOAD_TIMEOUT'):
    print(f'[hf-download diag]   {_k}={os.environ.get(_k, \"<unset>\")}', file=sys.stderr)
try:
    import huggingface_hub as _hh
    print(f'[hf-download diag] huggingface_hub={_hh.__version__}', file=sys.stderr)
except Exception:
    pass
from faster_whisper import WhisperModel
from faster_whisper.utils import _MODELS
from huggingface_hub import snapshot_download

ALLOW_PATTERNS = [
    'config.json',
    'preprocessor_config.json',
    'model.bin',
    'tokenizer.json',
    'vocabulary.*',
]

def run_with_heartbeat(label, fn):
    import queue
    import threading
    done = queue.Queue(maxsize=1)

    def worker():
        try:
            done.put((True, fn()))
        except BaseException as exc:
            done.put((False, exc))

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    elapsed = 0
    while thread.is_alive():
        thread.join(timeout=15)
        if thread.is_alive():
            elapsed += 15
            print(f'  {label} still in progress ({elapsed}s elapsed)...', file=sys.stderr, flush=True)
    ok, value = done.get()
    if ok:
        return value
    raise value

def resolve_faster_whisper_repo_id(model_id):
    if '/' in model_id:
        return model_id
    repo_id = _MODELS.get(model_id)
    if repo_id is None:
        expected = ', '.join(sorted(_MODELS.keys()))
        raise ValueError(f'Invalid faster-whisper model {model_id!r}, expected one of: {expected}, or a HuggingFace repo id')
    return repo_id

max_attempts = 3
for attempt in range(1, max_attempts + 1):
    try:
        model_id = sys.argv[1]
        if os.path.isdir(model_id):
            model_path = model_id
            print(f'  Using local faster-whisper model path: {model_path}', file=sys.stderr)
        else:
            repo_id = resolve_faster_whisper_repo_id(model_id)
            print(f'  Resolved faster-whisper model repo: {repo_id}', file=sys.stderr)
            model_path = run_with_heartbeat(
                'faster-whisper snapshot download',
                lambda: snapshot_download(repo_id, allow_patterns=ALLOW_PATTERNS),
            )
            print(f'  Faster-whisper model artifacts ready: {model_path}', file=sys.stderr)
        run_with_heartbeat(
            'faster-whisper runtime load',
            lambda: WhisperModel(model_path, device='cpu', compute_type='int8'),
        )
        print('Model download complete.')
        sys.exit(0)
    except Exception as e:
        print(f'  Download attempt {attempt}/{max_attempts} failed: {type(e).__name__}: {e}', file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        if attempt < max_attempts:
            wait = 5 * attempt
            print(f'  Retrying in {wait}s...', file=sys.stderr)
            time.sleep(wait)
print(f'ERROR: Model download failed after {max_attempts} attempts', file=sys.stderr)
sys.exit(1)
" "$model_id"
      ;;
    *)
      echo "ERROR: unknown MODEL_LOADER: $loader" >&2
      exit 1
      ;;
  esac
}
