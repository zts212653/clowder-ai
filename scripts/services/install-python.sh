#!/usr/bin/env bash
# scripts/services/install-python.sh
#
# Standalone entry point for the python-bootstrap "meta-service".
# Spawned by the API's ensurePython() helper before any real service install
# (whisper / tts / embed / llm-postprocess) runs, so the four service install
# scripts never race to install Python themselves -- they always find one
# resolved by this script (system / uv / pyenv / brew / project-owned).
#
# Output contract:
#   stdout -- single line "PYTHON_PATH=<absolute path>\nPYTHON_ARCH=<machine>\nPYTHON_SOURCE=<system|uv|pyenv|brew|project>"
#            on success.
#   exit 0 -- Python >=3.12 is now resolvable; the resolver-picked interpreter
#            is at the printed PYTHON_PATH.
#   exit 1 -- Resolution failed even after the project-owned fallback. stderr
#            carries the diagnostic the resolver wrote.
#
# Safe to call concurrently -- python-resolve.sh has its own flock-based
# critical section around the project-owned download/extract step.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./python-resolve.sh
. "$SCRIPT_DIR/python-resolve.sh"

echo "[python-bootstrap] Resolving Python 3.12+ interpreter..."
if resolve_python_312; then
  echo "[python-bootstrap] [OK] Python ${RESOLVED_PYTHON_SOURCE}: $RESOLVED_PYTHON (arch=$RESOLVED_PYTHON_ARCH)"
  # Machine-parseable lines for the API spawn() reader.
  echo "PYTHON_PATH=$RESOLVED_PYTHON"
  echo "PYTHON_ARCH=$RESOLVED_PYTHON_ARCH"
  echo "PYTHON_SOURCE=$RESOLVED_PYTHON_SOURCE"
  exit 0
fi

echo "[python-bootstrap] [FAIL] Python 3.12+ resolution failed" >&2
exit 1
