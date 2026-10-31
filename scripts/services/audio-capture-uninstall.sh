#!/usr/bin/env bash
# scripts/services/audio-capture-uninstall.sh
# Remove F195 audio-capture virtual environment.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${CAT_CAFE_HOME:=$(cd "$SCRIPT_DIR/../.." && pwd)/.cat-cafe}"
# Expand leading ~ (codex P2 3264135134).
case "$CAT_CAFE_HOME" in
  "~") CAT_CAFE_HOME="$HOME" ;;
  "~/"*) CAT_CAFE_HOME="${HOME}/${CAT_CAFE_HOME#~/}" ;;
esac
export CAT_CAFE_HOME

VENV_DIR="${CAT_CAFE_HOME}/audio-capture-venv"
VENV_DIR_LEGACY="${HOME}/.cat-cafe/audio-capture-venv"

removed=0
if [ -d "$VENV_DIR" ]; then
  echo "Removing venv: $VENV_DIR ..."
  rm -rf "$VENV_DIR"
  removed=1
fi
if [ -d "$VENV_DIR_LEGACY" ] && [ "$VENV_DIR_LEGACY" != "$VENV_DIR" ]; then
  echo "Removing legacy venv: $VENV_DIR_LEGACY ..."
  rm -rf "$VENV_DIR_LEGACY"
  removed=1
fi
if [ "$removed" = "0" ]; then
  echo "Venv not found: $VENV_DIR (legacy: $VENV_DIR_LEGACY)"
  exit 0
fi
echo "Uninstall complete."
