#!/usr/bin/env bash
# scripts/services/embed-server.sh
# Start local embedding server for Clowder AI memory system (F102).
#
# Usage:
#   EMBED_MODEL=jinaai/jina-embeddings-v2-base-zh ./scripts/services/embed-server.sh
#   EMBED_DIM=512 ./scripts/services/embed-server.sh
#
# EMBED_MODEL is REQUIRED -- no fallback default. The backend
# (routes/services.ts resolveSelectedModel) is the single source of truth
# for which model to load; a script-level default historically silently
# picked the wrong model on non-mac platforms when the env was unset.
# Prerequisites: run scripts/services/embed-install.sh first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${CAT_CAFE_HOME:=$(cd "$SCRIPT_DIR/../.." && pwd)/.cat-cafe}"
# Expand leading ~ -- bash parameter expansion doesnt tilde-expand, so a
# value like CAT_CAFE_HOME=~/.cat-cafe-shared from .env / Node passes
# through literal and resolves to <cwd>/~/.cat-cafe-shared. python-resolve.sh
# already handles this for install; mirror here for runtime start.
# Codex P2 3264135134.
case "$CAT_CAFE_HOME" in
  "~") CAT_CAFE_HOME="$HOME" ;;
  "~/"*) CAT_CAFE_HOME="${HOME}/${CAT_CAFE_HOME#~/}" ;;
esac
export CAT_CAFE_HOME
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
echo "[start] wrapper entered: service=embedding-model script=$0"

# shellcheck source=./proxy-env.sh
source "$SCRIPT_DIR/proxy-env.sh"
normalize_socks_proxy_env

VENV_DIR="${CAT_CAFE_HOME}/embed-venv"
PORT="${EMBED_PORT:-9880}"
MODEL="${EMBED_MODEL:-}"
API_SCRIPT="$SCRIPT_DIR/embed-api.py"
echo "[start] resolved runtime: CAT_CAFE_HOME=$CAT_CAFE_HOME; venv=$VENV_DIR; python=python3; api=$API_SCRIPT; port=$PORT"

if [ -z "$MODEL" ]; then
  echo "ERROR: EMBED_MODEL env var required -- backend must specify which model to load." >&2
  echo "If you're running this script directly, set EMBED_MODEL first (e.g. EMBED_MODEL=jinaai/jina-embeddings-v2-base-zh)." >&2
  exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
  echo "[start] venv not found: $VENV_DIR -- auto-installing..." >&2
  INSTALL_SCRIPT="$SCRIPT_DIR/embed-install.sh"
  if [ ! -f "$INSTALL_SCRIPT" ]; then
    echo "ERROR: install script not found: $INSTALL_SCRIPT" >&2
    exit 1
  fi
  EMBED_MODEL="$MODEL" bash "$INSTALL_SCRIPT"
  if [ ! -d "$VENV_DIR" ]; then
    echo "ERROR: auto-install completed but venv still missing: $VENV_DIR" >&2
    exit 1
  fi
fi
source "$VENV_DIR/bin/activate"

echo "Starting Embedding server: model=$MODEL, port=$PORT"
echo "[start] launching python: python3 $API_SCRIPT --model $MODEL --port $PORT"
set +e
python3 "$API_SCRIPT" --model "$MODEL" --port "$PORT"
EXIT_CODE=$?
set -e
echo "[start] python exited with code $EXIT_CODE"
exit "$EXIT_CODE"
