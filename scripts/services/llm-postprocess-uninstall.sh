#!/usr/bin/env bash
# scripts/llm-postprocess-uninstall.sh
# Remove LLM post-processing service virtual environment and dependencies.
set -euo pipefail

# Uninstall scripts are spawned by the API without sourcing
# python-resolve.sh, so CAT_CAFE_HOME may not be set in env. Mirror
# the resolver's default (caller env override -> <repoRoot>/.cat-cafe)
# so `set -u` doesn't trip on the unbound variable.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${CAT_CAFE_HOME:=$(cd "$SCRIPT_DIR/../.." && pwd)/.cat-cafe}"
# Expand leading ~ -- bash parameter expansion doesnt tilde-expand
# (codex P2 3264135134; matches python-resolve.sh install-time fix).
case "$CAT_CAFE_HOME" in
  "~") CAT_CAFE_HOME="$HOME" ;;
  "~/"*) CAT_CAFE_HOME="${HOME}/${CAT_CAFE_HOME#~/}" ;;
esac
export CAT_CAFE_HOME

VENV_DIR="${CAT_CAFE_HOME}/llm-venv"
# Legacy path cleanup -- see embed-uninstall.sh for rationale.
VENV_DIR_LEGACY="${HOME}/.cat-cafe/llm-venv"

removed=0
if [ -d "$VENV_DIR" ]; then
  echo "Removing venv: $VENV_DIR ..."
  rm -rf "$VENV_DIR"
  removed=1
fi
if [ -d "$VENV_DIR_LEGACY" ] && [ "$VENV_DIR_LEGACY" != "$VENV_DIR" ]; then
  echo "Removing legacy venv (pre-a34ab1f2 path): $VENV_DIR_LEGACY ..."
  rm -rf "$VENV_DIR_LEGACY"
  removed=1
fi
if [ "$removed" = "0" ]; then
  echo "Venv not found: $VENV_DIR (legacy: $VENV_DIR_LEGACY)"
  exit 0
fi
echo "Uninstall complete."
